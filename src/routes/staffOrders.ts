import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type {
  GetStaffPaymentsPendingResponse,
  PendingPaymentWire,
  PostStaffOrdersCancelResponse,
} from '../contracts/wire.js';
import { db } from '../db/client.js';
import { peekCompletedIdempotency } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import {
  orderCreatedAtIso,
  ordersRepository,
  type PendingOrderRow,
} from '../db/repositories/ordersRepository.js';
import { askWhatWon, cancelOrderInTx, type CancelOrderResult } from '../lib/cancelOrder.js';
import { readEngineBudget } from '../lib/confirmCharge.js';
import { ApiError } from '../lib/errors.js';
import { firePendingRefundPostCommit } from '../lib/pendingRefund.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { uuidId } from '../lib/uuidId.js';
import { wireManyBookings } from '../lib/wireManyBookings.js';
import { formatZodIssues } from '../lib/zodIssues.js';

export interface StaffOrdersRouteOptions extends AuthRouteOptions {
  /** Stripe seam: *Cancel order* asks it first, with no transaction open. */
  stripe?: StripeClient;
  now?: () => Date;
}

const idParamSchema = z.object({ id: uuidId('id must be a UUID') });

function parseIdParam(params: unknown): { id: string } {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * `kind` from what the order holds: rows make it a Confirm with a top-up, and a
 * purchase holds none. `'class'` has no producer before P29.
 */
function kindOf(row: PendingOrderRow, sessionCount: number): PendingPaymentWire['kind'] {
  if (sessionCount > 0) return 'booking';
  return row.purpose === 'group-class' ? 'class' : 'package';
}

/**
 * PAY-U07's two staff routes (design §2.7:3999-4030; wire § the order engine). Any
 * role: `requireStaff` and nothing more, since a staffer's `home_locations` refuses
 * nothing (STAFF-71).
 */
export function registerStaffOrdersRoute(
  app: FastifyInstance,
  opts: StaffOrdersRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;
  const nowFactory = opts.now ?? ((): Date => new Date());

  // PAY-82: past `pay.processing_hold_max_minutes` an order keeps its seats and is
  // flagged here. Inside the hold it is a charge still in its first tries, and
  // offering *Cancel order* on one of those would race the card.
  app.get(
    '/staff/payments/pending',
    { preHandler: [authHook] },
    async (request): Promise<GetStaffPaymentsPendingResponse> => {
      requireStaff(requirePrincipal(request), 'read pending payments');
      const now = nowFactory();
      const { processingHoldMinutes } = await readEngineBudget();
      const rows = await ordersRepository.findPendingOlderThan(db, {
        olderThan: new Date(now.getTime() - processingHoldMinutes * 60_000),
      });
      const listed: PendingPaymentWire[] = [];
      for (const row of rows) {
        const sessionRows = await bookingsRepository.findByOrderId(db, row.orderId);
        const sessions = await wireManyBookings(sessionRows, { now, viewer: 'staff' });
        const minutes = (now.getTime() - pgTimestampToDate(row.createdAt).getTime()) / 60_000;
        const kind = kindOf(row, sessions.length);
        listed.push({
          order_id: row.orderId,
          owner: { id: row.ownerId, name: row.ownerName ?? row.ownerEmail ?? '' },
          kind,
          ...(kind === 'package' && row.packageLabel !== null
            ? { package_label: row.packageLabel }
            : {}),
          amount_cents: row.amountCents,
          created_at: orderCreatedAtIso(row),
          minutes_pending: Math.floor(minutes),
          ...(sessions.length > 0 ? { sessions } : {}),
        });
      }
      return listed;
    },
  );

  // *Cancel order*. Asks Stripe first, with no transaction open, and only then opens
  // one (`lib/cancelOrder.ts`). The peek runs before anything reads the order: a
  // replay of a cancel that worked must answer its 200, not the 409 its own work left.
  app.post(
    '/staff/orders/:id/cancel',
    { preHandler: [authHook] },
    async (request): Promise<PostStaffOrdersCancelResponse> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'cancel an order');
      const { id } = parseIdParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const endpoint = 'POST /staff/orders/:id/cancel';
      const requestHash = hashRequestBody({ id });

      // A staff claim names no owner (`withMutation`), so a staff key answers staff.
      const replay = await peekCompletedIdempotency<PostStaffOrdersCancelResponse>(
        idempotencyKey,
        endpoint,
        requestHash,
        null,
      );
      if (replay !== undefined) return replay.body;

      const order = await ordersRepository.findById(db, id);
      if (order === undefined) throw new ApiError('not_found', `order ${id} not found`);
      const charge = await chargesRepository.findEngineByOrderId(db, id);
      if (charge === undefined || charge.status === 'failed' || charge.status === 'refunded') {
        throw new ApiError('conflict', `order ${id} has nothing pending to cancel`);
      }

      const budget = await readEngineBudget();
      const whatWon =
        charge.status === 'requires_payment'
          ? await askWhatWon({ charge, stripe, budget })
          : undefined;

      let result: CancelOrderResult | undefined;
      const outcome = await withMutation<PostStaffOrdersCancelResponse>(
        {
          principal,
          idempotencyKey,
          endpoint,
          requestHash,
          patternsToInvalidate: () => {
            const creditsOwner =
              result?.cancelled?.creditRefundedOwnerId ?? result?.act.creditsOwnerId;
            return [
              ...(result?.cancelled?.location != null
                ? [`avail:${result.cancelled.location}:*`]
                : []),
              ...(creditsOwner !== undefined ? [creditsInvalidationPattern(creditsOwner)] : []),
            ];
          },
          postCommit: async () => {
            await firePendingRefundPostCommit({
              pending: result?.act.pendingStripeRefund,
              stripe,
              log: request.log,
              context: { orderId: id, cancelPath: 'staff-cancel-order' },
            });
          },
        },
        async (tx) => {
          result = await cancelOrderInTx(tx, {
            orderId: id,
            whatWon,
            cancelledBy: 'staff',
            log: request.log,
            now: nowFactory(),
          });
          return { status: 200, body: { order_id: id, outcome: result.outcome } };
        },
      );
      return outcome.body;
    },
  );
}
