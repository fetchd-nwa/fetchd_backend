import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { actorOf } from '../auth/principal.js';
import { peekEngineClaim } from '../db/idempotency.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import {
  orderCreatedAtIso,
  ordersRepository,
  type OrderRow,
} from '../db/repositories/ordersRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';
import type {
  ApiErrorEnvelope,
  PostBookingsRequest,
  PostBookingsResponse,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { isInView, type PickupCloseByCampus } from '../lib/bookingBucket.js';
import { isValidCalendarDate } from '../lib/chicagoDate.js';
import type { DayProgramCategory } from '../lib/bookingSchedule.js';
import type { BookingWire } from '../lib/bookingWire.js';
import {
  askWhatWonForPendingRow,
  cancelBookingInTx,
  cancelOneDogInTx,
} from '../lib/cancelBookingService.js';
import { firePendingRefundPostCommit, type PendingStripeRefund } from '../lib/pendingRefund.js';
import { invalidateAll } from '../lib/cache.js';
import { confirmCharge } from '../lib/confirmCharge.js';
import { createDayProgramBookings } from '../lib/createDayProgramBookings.js';
import { loadStripePaymentContext } from '../lib/loadStripePaymentContext.js';
import { sortBookingsByScheduledAt, wireManyBookings } from '../lib/wireManyBookings.js';
import { ApiError } from '../lib/errors.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { uuidId } from '../lib/uuidId.js';
import { formatZodIssues, parseOrThrow } from '../lib/zodIssues.js';

/**
 * `GET /bookings?view=upcoming|past` `[auth]` and three companions —
 * the booking-data read surface (DATA-CONTRACT §C bookings).
 *
 * The four endpoints share a query skeleton + the same wire helper, so
 * they live in one file. Each runs against the **owner**'s data only;
 * staff principals get an empty list (or 404 on the single-resource
 * lookups). Day-19 staff portal uses `/staff/bookings/*` for cross-owner
 * access — out of scope here.
 *
 * Runtime bucketing is server-side (DATA-CONTRACT §B Δ 2026-05-20):
 * `view=upcoming` / `view=past` use `isInView`, not the stored
 * `bookings.status` column directly. Status is allowed to lag (the
 * Day-16 worker transitions it on a schedule) — the read never has to
 * wait for the worker to be correct. `status='cancelled'` rows are
 * excluded from both views and surface only via `GET /bookings/:id`.
 *
 * Layer responsibilities (Day-5a Clean-Architecture seam):
 *   route   → parse query/params, call repo, bucket+sort, wire, respond
 *   repo    → SQL queries + projection (bookings + booking_dogs + staff)
 *   wire    → DB row + dog ids + trainer name → §B JSON shape (pure)
 *   bucket  → category-aware end-time + view filter (pure)
 *
 * Injectable clock: a `now?: () => Date` factory keeps contract tests
 * deterministic; production uses `() => new Date()`.
 */

const VIEW_VALUES = ['upcoming', 'past'] as const;
type BookingView = (typeof VIEW_VALUES)[number];

const viewQuerySchema = z.object({
  view: z.enum(VIEW_VALUES),
});

const uuidParamSchema = z.object({
  id: uuidId(),
});

/** Both path ids lowercased at the parse, before any key, lock or comparison. */
const shareParamSchema = z.object({ id: uuidId(), dogId: uuidId() });

/**
 * `MAX_DATES_PER_REQUEST` — a request-size guard, a semester at a time. 30 days ×
 * 3 dogs × 1 INSERT booking + 1 INSERT booking_dog row + 3 INSERT credit_ledger
 * debits = 30 × (1 + 3 + 3) = 210 INSERTs in one tx upper bound, well within a
 * single tx's budget. Larger windows are split into multiple requests, each with
 * its own Idempotency-Key.
 *
 * `ADDITIONAL_DOGS_PARSE_CEILING` — this is a hostile-body ceiling and nothing
 * else. How many dogs a booking takes is `day.max_dogs_per_booking_count`, read at
 * runtime and answered 422 `invalid_payload`, so raising that setting past 5 needs
 * no release. This bound sits far above any setting a campus would hold, only so a
 * thousand-entry array is refused before anything is read.
 *
 * The horizon is `day.booking_horizon_months` (`lib/bookingHorizon.ts`).
 */
const MAX_DATES_PER_REQUEST = 30;
const ADDITIONAL_DOGS_PARSE_CEILING = 99;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCATION_KEYS = LOCATION_SLUGS;

/**
 * A dog id as the booking core may hold it: lowercased here, at the parse
 * boundary. `withDogLocks` keys a string, and Postgres reads a uuid in either
 * case, so a capitalised spelling would otherwise be a second lock for one dog,
 * a second entry past the distinct check, and a second seat at the other campus.
 */
const dogIdField = uuidId();

/**
 * POST /bookings body — day-program creation (day-school / day-care).
 * Other categories (group-class, B&T, boarding, private-lesson,
 * evaluation) hit different endpoints (POST /enrollments, request
 * flows, staff-picked slots); narrowing `category` here keeps the
 * route's static type honest about what it accepts. The route's
 * `validateBookingBody` adds the cross-field invariants Zod doesn't
 * express cleanly (dates distinct, lead not in additionals). No arrival
 * time is taken (DAY-U11): `dropoff_time` is an unknown key to `.strict()`.
 *
 * `payment` says credits, the only tender (R1): required, so every booking says so
 * and one body has one spelling, which is what the request key hashes. `.strict()`
 * here too, so `kind: 'payg'`, `kind: 'card'` and a top-level `payment_method_id` are
 * 400. `tier` names the pool. `top_up` buys what the dates are short, on the engine.
 */
const bookingPaymentSchema = z
  .object({
    kind: z.literal('credits'),
    tier: z.enum(['regular', 'alumni']).optional(),
    top_up: z
      .object({
        count: z.number().int().positive(),
        payment_method_id: uuidId(),
        package_key: z
          .string()
          .regex(/^[a-z0-9-]{1,64}$/)
          .optional(),
        expected_total_cents: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const postBookingBodySchema = z
  .object({
    category: z.enum(['day-school', 'day-care']),
    lead_dog_id: dogIdField,
    additional_dog_ids: z.array(dogIdField).max(ADDITIONAL_DOGS_PARSE_CEILING).optional(),
    dates: z
      .array(
        z
          .string()
          .regex(ISO_DATE, 'must be YYYY-MM-DD')
          .refine(isValidCalendarDate, 'not a real calendar date'),
      )
      .min(1)
      .max(MAX_DATES_PER_REQUEST),
    location: z.enum(LOCATION_KEYS),
    notes: z.string().max(2000).optional(),
    payment: bookingPaymentSchema,
  })
  .strict();

type PostBookingBody = z.infer<typeof postBookingBodySchema>;

/** §5.1.3 pin (designs/wire-contract-completion.md) — the wire's
 *  `PostBookingsRequest` IS this schema's INPUT type. `z.input`, never
 *  `z.infer`: the wire documents what a client may SEND (pre-default,
 *  pre-transform). Exported so no unused-locals rule can eat it (the
 *  `ContractEnumConformance` precedent). If this stops compiling, the WIRE
 *  TYPE is wrong — fix the type to the schema's truth, never the schema. */
export type PostBookingsBodyConformance = Expect<
  Equal<z.input<typeof postBookingBodySchema>, PostBookingsRequest>
>;

export interface BookingsRouteOptions extends AuthRouteOptions {
  now?: () => Date;
  /**
   * Stripe seam (Day 14). The cancel route's money-back branch fires a
   * post-commit `stripe.createRefund` against the prior PaymentIntent.
   * Contract tests inject an in-memory stub; production wires
   * `defaultStripeClient`.
   */
  stripe?: StripeClient;
}

export function registerBookingsRoute(app: FastifyInstance, opts: BookingsRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());
  const stripe = opts.stripe ?? defaultStripeClient;

  // --- GET /bookings?view=upcoming|past ---------------------------------
  app.get('/bookings', { preHandler: [authHook] }, async (request): Promise<BookingWire[]> => {
    const principal = requirePrincipal(request);
    const view = parseView(request.query);
    if (principal.kind !== 'owner') return [];

    const [rows, pickupClose] = await Promise.all([
      bookingsRepository.findLiveActiveByOwner(principal.ownerId),
      pickupCloseByCampus(),
    ]);
    const now = nowFactory();
    const bucketed = rows.filter((row) => isInView(row, view, now, pickupClose));
    const sorted = sortBookingsByScheduledAt(bucketed, view === 'past' ? 'desc' : 'asc');
    return wireManyBookings(sorted, { now, viewer: 'owner' });
  });

  // --- GET /bookings/up-next ---------------------------------------------
  // Most-imminent upcoming booking (ascending scheduledAt, first row).
  // `null` when none. "Upcoming" here is the runtime bucket — an in-
  // progress day-school session at 11am still counts (end = the campus's
  // `day.pickup_close_time`).
  app.get(
    '/bookings/up-next',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire | null> => {
      const principal = requirePrincipal(request);
      if (principal.kind !== 'owner') return null;

      const [rows, pickupClose] = await Promise.all([
        bookingsRepository.findLiveActiveByOwner(principal.ownerId),
        pickupCloseByCampus(),
      ]);
      const now = nowFactory();
      const upcoming = rows.filter((row) => isInView(row, 'upcoming', now, pickupClose));
      const sorted = sortBookingsByScheduledAt(upcoming, 'asc');
      const first = sorted[0];
      if (first === undefined) return null;
      const [wire] = await wireManyBookings([first], { now, viewer: 'owner' });
      return wire ?? null;
    },
  );

  // --- GET /bookings/:id -------------------------------------------------
  // Single booking lookup by id, owner-scoped. Returns 404 if the booking
  // doesn't exist OR doesn't belong to the authenticated owner — same
  // response for both branches so an attacker can't enumerate ids.
  app.get('/bookings/:id', { preHandler: [authHook] }, async (request): Promise<BookingWire> => {
    const principal = requirePrincipal(request);
    const { id } = parseUuidParam(request.params);
    if (principal.kind !== 'owner') {
      throw new ApiError('not_found', `booking ${id} not found`);
    }
    const row = await bookingsRepository.findByIdForOwner(id, principal.ownerId);
    if (row === undefined) {
      throw new ApiError('not_found', `booking ${id} not found`);
    }
    const [wire] = await wireManyBookings([row], { now: nowFactory(), viewer: 'owner' });
    if (wire === undefined) {
      // booking_dogs is empty for this booking — structural bug.
      throw new Error(`booking ${id}: failed to resolve lead dog from booking_dogs`);
    }
    return wire;
  });

  // --- GET /dogs/:id/bookings?view= -------------------------------------
  // Per-dog filter. The dog appears as lead OR additional on the
  // booking_dogs roster (see repo doc). A dog the principal doesn't own
  // → empty list (same response as "dog has no bookings", no id leak).
  app.get(
    '/dogs/:id/bookings',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire[]> => {
      const principal = requirePrincipal(request);
      const { id: dogId } = parseUuidParam(request.params);
      const view = parseView(request.query);
      if (principal.kind !== 'owner') return [];

      const [rows, pickupClose] = await Promise.all([
        bookingsRepository.findLiveActiveForDog(dogId, principal.ownerId),
        pickupCloseByCampus(),
      ]);
      const now = nowFactory();
      const bucketed = rows.filter((row) => isInView(row, view, now, pickupClose));
      const sorted = sortBookingsByScheduledAt(bucketed, view === 'past' ? 'desc' : 'asc');
      return wireManyBookings(sorted, { now, viewer: 'owner' });
    },
  );

  // --- POST /bookings -----------------------------------------------------
  //
  // Day 10 day-program creation (DATA-CONTRACT §C, schema.sql ~line 1328
  // bookSession transaction-contract notes).
  //
  // One request → N bookings, one per requested date, atomic. Body:
  //   { category, lead_dog_id, additional_dog_ids?, dates[], location, notes?, payment }
  // → 201 PostBookingsResponse {order, sessions} (one order per Confirm;
  //   `sessions.length` = dates.length, ordered ASC by scheduled_at).
  //
  // Owner-only (staff portal lives at Day 19). Idempotency-Key required;
  // the same key + body returns the stored response. The same key + a
  // different body produces 422 `idempotency_mismatch`.
  //
  // Everything that reads a clock or a setting runs INSIDE `withMutation`, after
  // the idempotency claim, so a booking made at 07:29 and replayed at 07:31 gets
  // its stored 201 rather than `same_day_cutoff_passed` (DECISIONS 128(a)).
  // `validateBookingBody` keeps only what needs neither.
  //
  // The transaction protocol — DEADLOCK ORDER MATTERS, do not reorder:
  //
  //   1. The roster ceiling (`day.max_dogs_per_booking_count`): over it is 422
  //      `invalid_payload`. It comes before ownership so a hostile body costs one
  //      read, not a thousand.
  //   2. Ownership gate per dog (`dogsRepository.findOwnedExists`). Any
  //      miss → 404 (same response as "dog doesn't exist"; ids don't
  //      enumerate across owners).
  //   3. The core (`lib/createDayProgramBookings`), whose header holds the rest:
  //      advisory locks in canonical order, dogs then `(location, date)` capacity,
  //      both sorted so two concurrent N-key requests on overlapping sets observe
  //      the same total acquisition order; the settings read once under the locks;
  //      `program_not_offered` → the past-date check and `beyond_booking_horizon` →
  //      `same_day_cutoff_passed`; the gates; credits; the overlap guard; then, per
  //      session, capacity → INSERT → the credit debits → reminders.
  //   4. Post-commit (handled by withMutation): `patternsToInvalidate` wipes
  //      `avail:{location}:*` and the owner's balance cache.
  //
  // The DB-side BEFORE-INSERT gate triggers (schema.sql lines 1184/1231/1272)
  // remain the unbypassable floor — the route pre-check produces friendly
  // structured details for the typical case; the trigger fallback maps
  // any race-induced violation back to a typed `ApiError` so the wire
  // shape stays consistent.
  app.post(
    '/bookings',
    { preHandler: [authHook] },
    async (request, reply): Promise<PostBookingsResponse | ApiErrorEnvelope> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'create a booking');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(postBookingBodySchema, request.body, 'body');
      const parsed = validateBookingBody(body);

      // The ceiling, the ownership gate and the core, in whichever path's transaction.
      const book = async (tx: Tx, orderId: string) => {
        // 1. The roster ceiling, read at runtime (the protocol above).
        const { max_dogs_per_booking_count: maxDogs } = await settingsRepository.dayGlobal(tx);
        if (parsed.allDogIds.length > maxDogs) {
          throw new ApiError(
            'invalid_payload',
            `at most ${maxDogs} dogs per booking (got ${parsed.allDogIds.length})`,
          );
        }

        // 2. Ownership gate — every dog must belong to the principal.
        for (const dogId of parsed.allDogIds) {
          const exists = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
          if (!exists) {
            throw new ApiError('not_found', `dog ${dogId} not found`);
          }
        }

        // 4. The shared core. It books every dog or refuses; nothing is parked
        //    (wire 3.0.0).
        return createDayProgramBookings(tx, {
          orderId,
          ownerId: principal.ownerId,
          category: parsed.category,
          leadDogId: parsed.leadDogId,
          additionalDogIds: parsed.additionalDogIds,
          dates: parsed.sortedDates,
          location: parsed.location,
          notes: parsed.notes,
          payment: parsed.payment,
          now: nowFactory(),
        });
      };
      const endpoint = 'POST /bookings';
      const requestHash = hashRequestBody(body);
      const cachePatterns = [
        `avail:${parsed.location}:*`,
        creditsInvalidationPattern(principal.ownerId),
      ];

      // A `top_up` is one engine order: one charge, under `cancel-order`, so a decline
      // books nothing and returns every debit (design §2.3:2664-2677, §2.7:4083-4098).
      const topUp = parsed.payment.top_up;
      if (topUp !== undefined) {
        const replay = await peekEngineClaim<PostBookingsResponse | ApiErrorEnvelope>(
          idempotencyKey,
          endpoint,
          requestHash,
          principal.ownerId,
        );
        if (replay !== undefined) {
          reply.code(replay.status);
          return replay.body;
        }
        let held: { order: OrderRow; wires: BookingWire[] } | undefined;
        const result = await confirmCharge<PostBookingsResponse>(
          {
            actor: actorOf(principal),
            ownerId: principal.ownerId,
            claim: { key: idempotencyKey, ownerId: principal.ownerId, endpoint, requestHash },
            inTx1: async (tx, order) => {
              const booked = await book(tx, order.id);
              if (booked.topUp === undefined) {
                throw new Error('the core returned no terms for a body that carries a top_up');
              }
              // After every refusal: a `top_up` that does not fit never reads its card. A
              // card that is not a live card of hers is the generic 404.
              const card = await loadStripePaymentContext(
                { ownerId: principal.ownerId, paymentMethodId: topUp.payment_method_id },
                tx,
              );
              held = { order, wires: booked.wires };
              return {
                ...booked.topUp,
                purpose: 'package',
                bookingId: null,
                cohortId: null,
                dogId: null,
                card: { ...card, paymentMethodId: topUp.payment_method_id },
              };
            },
            stripe,
            log: request.log,
            now: opts.now,
          },
          'cancel-order',
        );

        // Best effort, whichever way it ended: the rows held seats and spent credits in
        // tx1, and a decline gave them back.
        await invalidateAll(cachePatterns, request.log);
        switch (result.kind) {
          case 'answered':
            reply.code(result.status);
            return result.body;
          case 'processing': {
            // Not stored: the claim stays open, and the settle stores the final answer.
            if (held === undefined) throw new Error('the engine ran no tx1 for this order');
            reply.code(201);
            return {
              order: {
                id: held.order.id,
                owner_id: held.order.ownerId,
                created_at: orderCreatedAtIso(held.order),
                charge_status: 'requires_payment',
                client_action: 'processing',
              },
              sessions: held.wires,
            };
          }
          case 'open':
            throw new ApiError(
              'idempotency_inflight',
              'this booking has no answer yet: re-send it under the same Idempotency-Key',
            );
        }
      }

      const outcome = await withMutation<PostBookingsResponse>(
        {
          principal,
          idempotencyKey,
          endpoint,
          requestHash,
          patternsToInvalidate: () => cachePatterns,
        },
        async (tx) => {
          // 3. One Confirm, one order, credits-only included (PAY-U04). A refusal
          //    below rolls it back with everything else.
          const order = await ordersRepository.create(tx, { ownerId: principal.ownerId });
          const result = await book(tx, order.id);

          // A credits-only Confirm never enters the engine (design §2.7:3829-3831).
          return {
            status: 201,
            body: {
              order: {
                id: order.id,
                owner_id: order.ownerId,
                created_at: orderCreatedAtIso(order),
                charge_status: 'none',
              },
              sessions: result.wires,
            },
          };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- POST /bookings/:id/cancel -----------------------------------------
  //
  // Day 13 owner-self cancel (schema.sql `cancelBooking` txn-contract).
  // Three outcome branches:
  //
  //   1. FORFEIT — `now > cancel_deadline_at`. `cancel_forfeited=true`;
  //      no credit refund, no money refund, capacity still released via
  //      the status flip.
  //   2. CREDIT-BACK — within window, booking was credit-paid (one or
  //      more `credit_ledger` 'booking-debit' rows exist). One +1
  //      'settlement-return' row per live debit, naming it; balance recomputes.
  //      A day row whose live share holds no live debit is a 500 and an alarm.
  //
  // A day-school or day-care row is refused first (6.0.0-lg5.1, CXL-U09): 409
  // `session_ended` once its day has ended, then 409 `session_checked_in` while any
  // dog still on it has folded past `expected`.
  //   3. MONEY-BACK — within window, booking was money-paid (succeeded
  //      `charges` row exists). A `refunds` row inserted at 'pending';
  //      the Stripe refund API call is queued post-commit (Day 14
  //      wires the real seam; Day 13 is the DB-side substrate).
  //
  // A booking that's neither credit-paid nor money-paid (free service,
  // e.g. evaluation) within-window cancel just flips status — no
  // ledger or refund row. Forfeited cancels of free services do the
  // same. Either way, the booking-cancelled notification fires.
  //
  // Capacity release: day-school / day-care use dynamic counting
  // (`assertCapacityWithinLock` excludes `status='cancelled'` rows),
  // so flipping the status IS the release — no decrement call. Other
  // categories carry no day_capacity counter.
  //
  // Group-class is NOT supported by this endpoint — those bookings
  // are tied to a cohort row's `filled` counter that increments per
  // dog (not per per-week booking), so the right verb is "withdraw
  // dog from cohort" (deferred Day-11 sibling). Group-class cancel
  // attempts surface 422 with a typed message.
  app.post(
    '/bookings/:id/cancel',
    { preHandler: [authHook] },
    async (request, reply): Promise<BookingWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'cancel a booking');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      // Day-14: closure-captured handle for the post-commit Stripe refund.
      // Set inside the money-back branch below; read by the postCommit
      // callback below. Stays undefined for forfeit / credit-back /
      // free-service / no-prior-refunds paths (postCommit no-ops).
      let pendingStripeRefund: PendingStripeRefund | undefined;
      // Computed ONCE, here, so the row stores the same string the fire sends.
      const refundIdempotencyKey = `${idempotencyKey}:refund`;
      // The owner credited back on this cancel (unset on every non-credit-back
      // path); post-commit we wipe her `credits:{ownerId}:*` display cache.
      let creditRefundedOwnerId: string | undefined;
      // A pending row cancels its whole order, and that cancel asks Stripe first,
      // with no transaction open (R5). `undefined` on every other row.
      const whatWon = await askWhatWonForPendingRow({
        id,
        requireOwnerId: principal.ownerId,
        stripe,
      });

      const outcome = await withMutation<BookingWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /bookings/:id/cancel',
          requestHash: hashRequestBody({ id }),
          // Day-13 cache invalidation: drop the per-location availability
          // range cache so the freed seat surfaces in the next /availability
          // read, plus each credited-back dog's balance cache. Booking reads
          // themselves aren't cached today.
          patternsToInvalidate: (body) => {
            const patterns: string[] = [];
            if (body.location !== undefined && body.location !== null) {
              patterns.push(`avail:${body.location}:*`);
            }
            if (creditRefundedOwnerId !== undefined) {
              patterns.push(creditsInvalidationPattern(creditRefundedOwnerId));
            }
            return patterns;
          },
          // Day-14: post-commit Stripe refund. Fires only on new (non-
          // replayed) money-back branches via the closure-captured handle
          // (the response body — a BookingWire — doesn't carry refund
          // metadata). MutationParams.postCommit owns the swallow/log/
          // skip-on-replay boilerplate; the DB `refunds` row at 'pending'
          // is the commitment, Day-15 webhook reconciles terminal status.
          //
          // Day-15: also persist the returned `re_*` id back onto the
          // refunds row so the `charge.refund.updated` webhook matches
          // deterministically by `stripe_refund_id`. The id-write uses
          // the pool runner (the main tx already committed) and a
          // `stripe_refund_id IS NULL` guard so a duplicate post-commit
          // can't clobber a webhook-set value (extremely rare; this is
          // belt-and-suspenders). Failure to persist the id here drops
          // back to the webhook's race-recovery path
          // (`findUnmatchedPendingForCharge`) — same swallow/log policy.
          postCommit: async () => {
            await firePendingRefundPostCommit({
              pending: pendingStripeRefund,
              stripe,
              log: request.log,
              context: { bookingId: id, cancelPath: 'owner-cancel' },
            });
          },
        },
        async (tx) => {
          // Owner self-cancel runs the shared cancel txn (schema.sql
          // `cancelBooking` contract) scoped to the principal's own
          // bookings — a cross-owner id 404s. The money-back branch
          // returns a Stripe-refund handle the postCommit above fires.
          const result = await cancelBookingInTx(tx, {
            id,
            requireOwnerId: principal.ownerId,
            // Owner self-cancel → "You cancelled this on …" (R5). No reason line.
            cancelledBy: 'owner',
            now: nowFactory(),
            stripeIdempotencyKey: refundIdempotencyKey,
            // The unroutable mint announces itself in-tx through this logger.
            log: request.log,
            whatWon,
          });
          pendingStripeRefund = result.pendingStripeRefund;
          creditRefundedOwnerId = result.creditRefundedOwnerId;
          return { status: 200, body: result.wire };
        },
      );

      reply.code(outcome.status);
      return outcome.body;
    },
  );

  // --- POST /bookings/:id/dogs/:dogId/cancel ------------------------------
  //
  // One dog of several (s11; CXL-U09; 6.0.0-lg5.1). No body. Her credit goes back to the
  // family's pool, always (no window, no forfeit: D21), her seat is free, and the session
  // goes with its last dog. Refused 409 `per_dog_cancel_off` while
  // `cxl.per_dog_cancel_enabled` is off. Every refusal with a clock in it runs after the
  // claim: an answer at 17:29 replays at 17:31 (DECISIONS 128(a)).
  app.post(
    '/bookings/:id/dogs/:dogId/cancel',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, "cancel one dog's day");
      const params = shareParamSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApiError('bad_request', `invalid path: ${formatZodIssues(params.error)}`);
      }
      const { id, dogId } = params.data;
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      let freed: { ownerId: string; location: string | null } | undefined;

      const outcome = await withMutation<BookingWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /bookings/:id/dogs/:dogId/cancel',
          requestHash: hashRequestBody({ id, dogId }),
          patternsToInvalidate: () =>
            freed === undefined
              ? []
              : [
                  ...(freed.location !== null ? [`avail:${freed.location}:*`] : []),
                  creditsInvalidationPattern(freed.ownerId),
                ],
        },
        async (tx) => {
          const result = await cancelOneDogInTx(tx, {
            id,
            dogId,
            requireOwnerId: principal.ownerId,
            cancelledBy: 'owner',
            now: nowFactory(),
            log: request.log,
          });
          freed = { ownerId: result.creditRefundedOwnerId, location: result.location };
          return { status: 200, body: result.wire };
        },
      );
      return outcome.body;
    },
  );
}

// ---- query/param parsing --------------------------------------------

function parseView(query: unknown): BookingView {
  const parsed = viewQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data.view;
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Each campus's `day.pickup_close_time`, once per list request (DAY-60): a day goes
 * Past at its campus's close, and fifty rows cost one read.
 */
async function pickupCloseByCampus(): Promise<PickupCloseByCampus> {
  const campuses = await settingsRepository.dayCampuses();
  return new Map(campuses.map((campus) => [campus.location, campus.pickup_close_time]));
}

// =========================================================================
// Day 10 POST /bookings helpers
// =========================================================================

/**
 * Validated, derived form of the request body. `parseOrThrow` handles
 * the Zod-shape errors; this helper layers on the cross-field invariants
 * Zod doesn't express cleanly and that need NO CLOCK AND NO SETTING: dates
 * distinct, lead not in additionals. A rule that reads either belongs inside
 * `withMutation`, or a replay meets it.
 *
 * Returns the route-internal `ValidatedBookingBody` — every downstream
 * call (gate pre-check, capacity assertion, INSERT) takes this typed
 * shape. The route handler doesn't touch the raw Zod-parsed body after
 * this point.
 */
interface ValidatedBookingBody {
  category: DayProgramCategory;
  leadDogId: string;
  additionalDogIds: string[];
  allDogIds: string[];
  sortedDates: string[];
  location: (typeof LOCATION_KEYS)[number];
  notes: string | null;
  payment: PostBookingBody['payment'];
}

function validateBookingBody(body: PostBookingBody): ValidatedBookingBody {
  // Combined dog list — lead first, then additionals.
  const additionalDogIds = body.additional_dog_ids ?? [];
  const allDogIds = [body.lead_dog_id, ...additionalDogIds];
  const dogIdSet = new Set(allDogIds);
  if (dogIdSet.size !== allDogIds.length) {
    // lead_dog_id appearing in additional_dog_ids OR an additional id
    // listed twice — both are the same defect from the user's POV.
    throw new ApiError('invalid_payload', 'lead_dog_id and additional_dog_ids must be distinct');
  }

  const dateSet = new Set<string>();
  for (const date of body.dates) {
    if (dateSet.has(date)) {
      throw new ApiError('invalid_payload', `dates contains duplicate ${date}`);
    }
    dateSet.add(date);
  }
  const sortedDates = [...body.dates].sort();

  return {
    category: body.category,
    leadDogId: body.lead_dog_id,
    additionalDogIds,
    allDogIds,
    sortedDates,
    location: body.location,
    notes: body.notes ?? null,
    payment: body.payment,
  };
}
