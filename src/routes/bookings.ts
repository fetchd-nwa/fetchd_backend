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

/** A Chicago calendar day, `YYYY-MM-DD`, that exists. */
const calendarDate = z
  .string()
  .regex(ISO_DATE, 'must be YYYY-MM-DD')
  .refine(isValidCalendarDate, 'not a real calendar date');

const postBookingBodySchema = z
  .object({
    category: z.enum(['day-school', 'day-care']),
    lead_dog_id: dogIdField,
    additional_dog_ids: z.array(dogIdField).max(ADDITIONAL_DOGS_PARSE_CEILING).optional(),
    dates: z.array(calendarDate).min(1).max(MAX_DATES_PER_REQUEST),
    location: z.enum(LOCATION_KEYS),
    notes: z.string().max(2000).optional(),
    payment: bookingPaymentSchema,
    // The after-school opt-in (6.0.0-lg5.2; DAY-U43): dog → dates. Each key lowercased
    // here, like every dog id at this boundary, so a capitalised key is that dog; a key
    // that is not a UUID or a value that is not a date is this parse's 400. Its fit with
    // the request is `validateBookingBody`'s (D11).
    after_school: z
      .record(dogIdField, z.array(calendarDate).max(MAX_DATES_PER_REQUEST))
      .optional(),
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
   * Stripe seam (Day 14). `POST /bookings` charges a top-up through it; the
   * cancel route asks Stripe about a pending row's order through it and fires
   * that order's F4 refund (a top-up that won no seat) post-commit. A booking
   * cancel itself moves no money: its money-back branch was deleted in P21
   * (wire 6.0.0-lg5.2). Contract tests inject an in-memory stub; production
   * wires `defaultStripeClient`.
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
      const parsed = validateBookingBody(body, request.body);

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
          afterSchool: parsed.afterSchool,
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
  // Day 13 owner-self cancel (schema.sql `cancelBooking` txn-contract), through the
  // shared `cancelBookingInTx`. No cancel has a window, forfeits, or moves money
  // (P21, wire 6.0.0-lg5.2; CXL-U04): the Day-13 FORFEIT and MONEY-BACK branches were
  // deleted, every cancel writes `cancel_forfeited` false, and none mints a `refunds`
  // row. What comes back is credit:
  //
  //   - An `upcoming` day-school or day-care row returns one credit per dog still on
  //     it (`returnDayShares`): one +1 'settlement-return' per live debit, naming it,
  //     to that debit's lot or a fresh lot; balance recomputes. A day row whose live
  //     share holds no live debit is a 500 and an alarm.
  //   - Any other row returns what it debited (`returnDebitsToLots`): nothing, for a
  //     row that spent no credit (e.g. an evaluation), so its status just flips.
  //   - A `payment-pending` row cancels its whole order instead (`cancelOrderInTx`),
  //     where the engine refunds a top-up that won no seat (F4), fired post-commit
  //     below. Its notices are the order engine's.
  //
  // A day-school or day-care row is refused first (6.0.0-lg5.1, CXL-U09): 409
  // `session_ended` once its day has ended, then 409 `session_checked_in` while any
  // dog still on it has folded past `expected`. A cancel of a non-pending row queues
  // one booking-cancelled notice: who cancelled, and a credit line per credit back.
  //
  // Capacity release: day-school / day-care use dynamic counting
  // (`assertCapacityWithinLock` excludes `status='cancelled'` rows),
  // so flipping the status IS the release — no decrement call. Other
  // categories carry no day_capacity counter.
  //
  // Group-class is NOT supported by this endpoint — those bookings
  // are tied to a cohort row's `filled` counter that increments per
  // dog (not per per-week booking), so the right verb is "withdraw
  // dog from cohort" (`POST /enrollments/:cohortId/withdraw`). Group-class
  // cancel attempts surface 422 with a typed message.
  app.post(
    '/bookings/:id/cancel',
    { preHandler: [authHook] },
    async (request, reply): Promise<BookingWire> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'cancel a booking');
      const { id } = parseUuidParam(request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      // Closure-captured handle for the post-commit Stripe refund: set only when a
      // pending row's cancel of its order refunds a top-up that won no seat (F4).
      // An upcoming row's cancel moves no money (P21), so it stays undefined.
      let pendingStripeRefund: PendingStripeRefund | undefined;
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
          // Day-14: post-commit Stripe refund. Fires only on a new (non-
          // replayed) pending-order cancel's F4 refund via the closure-captured handle
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
          // bookings — a cross-owner id 404s. A pending row's F4 refund
          // returns a Stripe-refund handle the postCommit above fires.
          const result = await cancelBookingInTx(tx, {
            id,
            requireOwnerId: principal.ownerId,
            // Owner self-cancel → "You cancelled this on …" (R5). No reason line.
            cancelledBy: 'owner',
            now: nowFactory(),
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
            who: { by: 'owner' },
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
  /** Dog → the dates she stays for after school; only dogs with a tick. */
  afterSchool: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * D11: the after-school map against its own request, each a 422 `invalid_payload`. A key
 * that is not a dog of this request, a date not in `dates`, a date listed twice for one
 * dog, any tick on a day-care request ("refused on a daycare date", design §2.3:2560), or
 * two keys that name one dog in two spellings. Pure checks of the body, true or false
 * whenever it is sent, so they run before the claim; the count, which a replay must not
 * re-read, is the core's, after it.
 */
function validateAfterSchool(
  body: PostBookingBody,
  rawBody: unknown,
  dogIds: ReadonlySet<string>,
  dates: ReadonlySet<string>,
): Map<string, Set<string>> {
  const ticks = new Map<string, Set<string>>();
  const map = body.after_school;
  if (map === undefined) return ticks;
  const rawKeys = Object.keys(
    ((rawBody as { after_school?: Record<string, unknown> }).after_school ?? {}) as object,
  );
  if (rawKeys.length !== Object.keys(map).length) {
    throw new ApiError('invalid_payload', 'after_school names one dog twice');
  }
  for (const [dogId, listed] of Object.entries(map)) {
    if (!dogIds.has(dogId)) {
      throw new ApiError('invalid_payload', `after_school names ${dogId}, not a dog of this booking`);
    }
    if (listed.length > 0 && body.category === 'day-care') {
      throw new ApiError('invalid_payload', 'after-school is offered on day-school dates only');
    }
    const own = new Set<string>();
    for (const date of listed) {
      if (!dates.has(date)) {
        throw new ApiError('invalid_payload', `after_school's ${date} is not one of this booking's dates`);
      }
      if (own.has(date)) {
        throw new ApiError('invalid_payload', `after_school lists ${date} twice for one dog`);
      }
      own.add(date);
    }
    if (own.size > 0) ticks.set(dogId, own);
  }
  return ticks;
}

function validateBookingBody(body: PostBookingBody, rawBody: unknown): ValidatedBookingBody {
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
  const afterSchool = validateAfterSchool(body, rawBody, dogIdSet, dateSet);

  return {
    category: body.category,
    leadDogId: body.lead_dog_id,
    additionalDogIds,
    allDogIds,
    sortedDates,
    location: body.location,
    notes: body.notes ?? null,
    payment: body.payment,
    afterSchool,
  };
}
