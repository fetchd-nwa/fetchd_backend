import type { FastifyInstance } from 'fastify';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { actorOf } from '../auth/principal.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { orderCreatedAtIso } from '../db/repositories/ordersRepository.js';
import { withActor } from '../db/tx.js';
import type {
  ApiErrorEnvelope,
  DogCreditPlanWire,
  PostBookingOrdersCheckResponse,
  PostBookingOrdersResponse,
} from '../contracts/wire.js';
import { createDayProgramOrder } from '../lib/createDayProgramOrder.js';
import {
  postBookingOrdersBodySchema,
  validateBookingOrderBody,
  type ValidatedBookingOrder,
} from '../lib/dayBookingBody.js';
import {
  assertCheckUnderThrottle,
  redisCheckThrottleStore,
  type CheckThrottleStore,
} from '../lib/orderCheckThrottle.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `POST /booking-orders` and `POST /booking-orders/check` `[owner]` (wire 9.1.0, plan one-off
 * O-CREDITS; designs/credits-joint-booking.md §3.1-§3.2, Amendment A1;
 * `PostBookingOrdersRequest`). One Confirm of day school and day care, every dog, campus and
 * date of it, booked in ONE transaction or not at all, each dog's credit picked by the
 * server. The order charges nothing: she buys credits first, then sends the order.
 *
 *   - The POST runs under `withMutation`: the claim on `Idempotency-Key`, then the core
 *     (`lib/createDayProgramOrder.ts`), so every clock and setting is read after the claim
 *     and a 201 replays as stored, past any cutoff (DECISIONS 128(a)). A refusal is a throw,
 *     so it rolls the claim back with everything else and the same key can book later.
 *   - The check runs the same core under `withActor`, then throws a private sentinel so
 *     Postgres rolls everything back, and answers with the `plan` it read first. It reads no
 *     key, so it cannot drift from the POST. It is throttled per owner and clock minute
 *     (`lib/orderCheckThrottle.ts`), after auth and before the body is validated.
 *   - Post-commit, the POST drops `avail:<campus>:*` for each campus of the order and the
 *     owner's balance cache.
 *
 * The refusal order is `PostBookingOrdersRequest`'s: auth (403 for staff), the key and the
 * parse (400), the body's bounds (422), then inside the transaction the dog ceiling (422),
 * ownership (404), and the core's protocol.
 */

export interface BookingOrdersRouteOptions extends AuthRouteOptions {
  /** Injectable clock (contract tests); production is `() => new Date()`. */
  now?: () => Date;
  /** The check's limiter; production counts on Redis (`redisCheckThrottleStore`). */
  throttle?: CheckThrottleStore;
}

/** The check's rollback: thrown after the core has answered, caught by the check alone. */
class CheckRollback extends Error {
  constructor(readonly plan: DogCreditPlanWire[]) {
    super('booking-order check: rolled back on purpose');
  }
}

/** Every campus the order names, each once. */
function campusesOf(order: ValidatedBookingOrder): string[] {
  return [...new Set(order.parts.map((part) => part.location))];
}

export function registerBookingOrdersRoute(
  app: FastifyInstance,
  opts: BookingOrdersRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());
  const throttle = opts.throttle ?? redisCheckThrottleStore;

  // --- POST /booking-orders ------------------------------------------------
  app.post(
    '/booking-orders',
    { preHandler: [authHook] },
    async (request, reply): Promise<PostBookingOrdersResponse | ApiErrorEnvelope> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'book an order');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(postBookingOrdersBodySchema, request.body, 'body');
      const order = validateBookingOrderBody(body, request.body);

      const outcome = await withMutation<PostBookingOrdersResponse>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /booking-orders',
          requestHash: hashRequestBody(body),
          patternsToInvalidate: () => [
            ...campusesOf(order).map((location) => `avail:${location}:*`),
            creditsInvalidationPattern(principal.ownerId),
          ],
        },
        async (tx) => {
          const result = await createDayProgramOrder(tx, {
            ownerId: principal.ownerId,
            order,
            now: nowFactory(),
          });
          return {
            status: 201,
            body: {
              order: {
                id: result.order.id,
                owner_id: result.order.ownerId,
                created_at: orderCreatedAtIso(result.order),
                charge_status: 'none',
              },
              sessions: result.sessions,
              plan: result.plan,
            },
          };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- POST /booking-orders/check -------------------------------------------
  app.post(
    '/booking-orders/check',
    { preHandler: [authHook] },
    async (request): Promise<PostBookingOrdersCheckResponse> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'check an order');
      await assertCheckUnderThrottle({
        store: throttle,
        ownerId: principal.ownerId,
        now: nowFactory(),
        log: request.log,
      });
      const body = parseOrThrow(postBookingOrdersBodySchema, request.body, 'body');
      const order = validateBookingOrderBody(body, request.body);

      try {
        await withActor(actorOf(principal), async (tx) => {
          const result = await createDayProgramOrder(tx, {
            ownerId: principal.ownerId,
            order,
            now: nowFactory(),
          });
          throw new CheckRollback(result.plan);
        });
      } catch (err) {
        if (err instanceof CheckRollback) return { bookable: true, plan: err.plan };
        throw err;
      }
      throw new Error('booking-order check: the core returned without its rollback');
    },
  );
}
