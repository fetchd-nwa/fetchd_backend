import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { requestsRepository } from '../db/repositories/requestsRepository.js';
import { bookings } from '../db/schema/schema.js';
import { boardTrainPriceCentsForLengthWeeks } from '../lib/boardTrainPricing.js';
import { computeCancelDeadlineFromHours } from '../lib/cancelWindow.js';
import { enqueueBookingReminders } from '../lib/enqueueBookingReminders.js';
import { insertBookingWithGateMapping } from '../lib/insertBookingWithGateMapping.js';
import { ApiError } from '../lib/errors.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { requireOwner } from '../lib/principalNarrows.js';
import {
  defaultStripeClient,
  stripeIntentStatusToChargeStatus,
  type StripeClient,
} from '../lib/stripe.js';
import { groupRequestDogs } from '../lib/requestWire.js';
import { wireOneRequest } from '../lib/wireOneRequest.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import type { PendingRequestWire } from '../lib/requestWire.js';

/**
 * `POST /requests/:id/confirm-payment` `[auth, $]` — Day 15. Owner-only.
 *
 * The B&T conversion verb: takes a `pending_requests` row at status
 * `'approved-awaiting-payment'` and resolves it via either pay-now (a
 * `charges` row) or pay-later (an `invoices` row), then INSERTs the
 * `bookings` row with `category='board-and-train'` + `dropoff_at` /
 * `pickup_at` set, and flips the request to `'converted'` with
 * `converted_booking_id` linked.
 *
 * Body:
 *   `{ payment_method_id, scheduled_at, dropoff_at, pickup_at,
 *      location, notes?, pay_later?: boolean, due_at? }`
 *
 *   - `scheduled_at` = `dropoff_at` for B&T (same instant, two columns
 *     for the schema CHECK that gates `dropoff_at IS NULL OR category IN
 *     ('boarding','board-and-train')`).
 *   - `pickup_at` is the staffer-confirmed end-of-program datetime.
 *   - `pay_later: true` writes an open invoice instead of charging now;
 *     `due_at` (ISO) is required when pay_later is true.
 *
 * Server authority for amount: `boardTrainPriceCentsForLengthWeeks(
 * request.length_weeks)`. The FE never passes the price — anti-scam
 * against a manipulated client.
 */

export interface RequestConfirmPaymentRouteOptions extends AuthRouteOptions {
  /** Stripe seam (Day 14). Contract tests inject a stub. */
  stripe?: StripeClient;
}

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const isoDateTime = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO datetime');

const confirmBodySchema = z
  .object({
    payment_method_id: z.string().uuid('payment_method_id must be a UUID'),
    scheduled_at: isoDateTime,
    dropoff_at: isoDateTime,
    pickup_at: isoDateTime,
    location: z.enum(['fayetteville', 'bentonville']),
    notes: z.string().max(2000).optional(),
    pay_later: z.boolean().optional().default(false),
    due_at: isoDateTime.optional(),
  })
  .strict()
  .refine((b) => !b.pay_later || b.due_at !== undefined, {
    message: 'due_at is required when pay_later is true',
    path: ['due_at'],
  })
  .refine((b) => new Date(b.pickup_at).getTime() > new Date(b.dropoff_at).getTime(), {
    message: 'pickup_at must be strictly after dropoff_at',
    path: ['pickup_at'],
  });

export function registerRequestConfirmPaymentRoute(
  app: FastifyInstance,
  opts: RequestConfirmPaymentRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const stripe = opts.stripe ?? defaultStripeClient;

  app.post(
    '/requests/:id/confirm-payment',
    { preHandler: [authHook] },
    async (request, reply): Promise<PendingRequestWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'confirm B&T payment');
      const { id } = parseIdParam(request.params);
      const body = parseBody(request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      // ── Stripe call (only for pay-now); needs price from request row. ──
      // Pre-Stripe validation runs inside withMutation so a state change
      // between request issuance and confirm (request cancelled, etc) is
      // caught under the row lock — but the Stripe call itself must
      // happen outside the tx (long-running). Pattern: read the request
      // pre-tx for price + length, then mutate inside the tx after the
      // Stripe call returns.
      const pre = await requestsRepository.findByIdForOwner(id, principal.ownerId);
      if (pre === undefined) {
        throw new ApiError('not_found', `pending request ${id} not found`);
      }
      if (pre.status !== 'approved-awaiting-payment') {
        throw new ApiError(
          'conflict',
          `pending request ${id} is ${pre.status}, not approved-awaiting-payment`,
        );
      }
      if (pre.category !== 'board-and-train') {
        // Only B&T uses confirm-payment today (per DATA-CONTRACT §C.1
        // Model 3); group-class pay-later flows arrive in Day-19.
        throw new ApiError(
          'invalid_payload',
          `request ${id} is category ${pre.category}; confirm-payment only supports board-and-train`,
        );
      }
      const lengthWeeks = pre.lengthWeeks;
      if (lengthWeeks === null || lengthWeeks === undefined) {
        throw new ApiError(
          'invalid_payload',
          `request ${id} has no length_weeks; cannot compute B&T price`,
        );
      }
      const amountCents = boardTrainPriceCentsForLengthWeeks(lengthWeeks);

      const stripeCtx = await loadStripePaymentContext({
        ownerId: principal.ownerId,
        paymentMethodId: body.payment_method_id,
      });

      // Pay-now: call Stripe pre-tx. Pay-later: skip the Stripe call.
      let intent:
        | {
            id: string;
            status: ReturnType<typeof stripeIntentStatusToChargeStatus>;
            stripePaymentIntentId: string;
            clientSecret: string | null;
            amountCents: number;
          }
        | undefined;
      if (!body.pay_later) {
        const stripeResult = await stripe.createAndConfirmPaymentIntent(
          {
            customerId: stripeCtx.stripeCustomerId,
            paymentMethodId: stripeCtx.stripePaymentMethodId,
            amountCents,
            currency: 'usd',
            metadata: {
              owner_id: principal.ownerId,
              request_id: id,
              purpose: 'board-train',
              length_weeks: String(lengthWeeks),
            },
          },
          `${idempotencyKey}:payment-intent`,
        );
        intent = {
          id: stripeResult.id,
          status: stripeIntentStatusToChargeStatus(stripeResult.status),
          stripePaymentIntentId: stripeResult.id,
          clientSecret: stripeResult.clientSecret,
          amountCents: stripeResult.amountCents,
        };
      }

      // ── DB writes inside withMutation; state-machine guarded by lockById. ──
      // cache-noop: pending_request / booking / invoice / charge reads
      // aren't in the §3 cache map today. Day-19 staff-portal "requests
      // queue" caching would add an explicit invalidation here.
      const outcome = await withMutation<PendingRequestWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /requests/:id/confirm-payment',
          requestHash: hashRequestBody({ id, ...body }),
        },
        async (tx) => {
          const row = await requestsRepository.lockById(tx, id);
          if (row === undefined || row.expiredAt !== null) {
            throw new ApiError('not_found', `pending request ${id} not found`);
          }
          if (row.ownerId !== principal.ownerId) {
            throw new ApiError('not_found', `pending request ${id} not found`);
          }
          if (row.status !== 'approved-awaiting-payment') {
            throw new ApiError(
              'conflict',
              `pending request ${id} is ${row.status}, not approved-awaiting-payment`,
            );
          }

          // Resolve dogs + cancel-window deadline + build the booking row.
          const dogRows = await requestsRepository.findDogsByRequestIds([id], tx);
          const grouped = groupRequestDogs(dogRows).get(id);
          if (grouped === undefined) {
            throw new Error(`pending_request ${id}: no live pending_request_dogs rows`);
          }
          const hours = await cancelWindowSettingsRepository.resolveHoursFor('board-and-train', tx);
          const scheduledAtDate = new Date(body.scheduled_at);
          const dropoffAtDate = new Date(body.dropoff_at);
          const pickupAtDate = new Date(body.pickup_at);
          const cancelDeadlineAt = computeCancelDeadlineFromHours(scheduledAtDate, hours);

          const inserted = await insertBookingWithGateMapping(tx, {
            ownerId: row.ownerId,
            leadDogId: grouped.lead,
            category: 'board-and-train',
            scheduledAt: scheduledAtDate,
            location: body.location,
            notes: body.notes ?? null,
            cancelDeadlineAt,
            additionalDogIds: grouped.additional,
          });

          // Stamp dropoff_at + pickup_at — bookingsRepository.create
          // doesn't accept these (schema CHECK gates them to stay
          // categories; the repo's primitive stays narrow). Same
          // pattern Day-12 uses for boarding.
          await tx
            .update(bookings)
            .set({
              dropoffAt: dropoffAtDate.toISOString(),
              pickupAt: pickupAtDate.toISOString(),
            })
            .where(eq(bookings.id, inserted.id));

          // Day-16: enqueue reminder + boarding-profile-check. B&T
          // explicitly carries dropoff_at distinct from scheduled_at
          // (multi-week stay) — pass it so the 24h-pre-drop-off prompt
          // anchors on the actual stay start.
          await enqueueBookingReminders(tx, {
            bookingId: inserted.id,
            ownerId: row.ownerId,
            leadDogId: grouped.lead,
            category: 'board-and-train',
            scheduledAt: scheduledAtDate,
            dropoffAt: dropoffAtDate,
          });

          // Pay-now: INSERT the charges row mirroring Stripe status.
          // Pay-later: INSERT an open invoice — the worker auto-charges
          // at due_at; the charges row + invoice settlement land via
          // either the worker or `POST /invoices/:id/pay`.
          if (intent !== undefined) {
            await chargesRepository.create(tx, {
              ownerId: row.ownerId,
              amountCents: intent.amountCents,
              status: intent.status,
              purpose: 'board-train',
              stripePaymentIntentId: intent.stripePaymentIntentId,
              bookingId: inserted.id,
            });
          } else if (body.pay_later && body.due_at) {
            await invoicesRepository.createOpen(tx, {
              ownerId: row.ownerId,
              amountCents,
              purpose: 'board-train',
              paymentMethodId: body.payment_method_id,
              dueAt: body.due_at,
              bookingId: inserted.id,
              requestId: id,
            });
          }

          await requestsRepository.markConverted(tx, id, {
            approvedByStaffId: row.approvedByStaffId ?? '',
            convertedBookingId: inserted.id,
          });

          await notificationsRepository.enqueue(tx, {
            ownerId: row.ownerId,
            type: 'booking-confirmed',
            title: 'Board & Train confirmed',
            body: `Drop-off ${scheduledAtDate.toLocaleDateString('en-US', {
              timeZone: 'America/Chicago',
              month: 'short',
              day: 'numeric',
            })}`,
            deepLinkPath: `/bookings/${inserted.id}`,
            dogIds: [grouped.lead, ...grouped.additional],
          });

          const updated = await requestsRepository.findFullByIdInTx(tx, id);
          if (updated === undefined) {
            throw new Error(`confirm-payment ${id}: row vanished before re-fetch`);
          }
          const wire = await wireOneRequest(tx, updated);
          return { status: 200, body: wire };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );
}

function parseIdParam(params: unknown): { id: string } {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseBody(body: unknown): z.infer<typeof confirmBodySchema> {
  const parsed = confirmBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid body: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
