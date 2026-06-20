import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { withCapacityLocks, withDogModeLocks } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { serviceRatesRepository } from '../db/repositories/serviceRatesRepository.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';
import { isInView } from '../lib/bookingBucket.js';
import {
  alreadyBookedError,
  insufficientCreditsError,
  type AlreadyBookedConflict,
  type CreditGap,
} from '../lib/bookingErrors.js';
import { checkBookingGates } from '../lib/bookingGatePreCheck.js';
import { enqueueBookingReminders } from '../lib/enqueueBookingReminders.js';
import { insertBookingWithGateMapping } from '../lib/insertBookingWithGateMapping.js';
import { bucketChicagoToday, bucketToChicagoDate } from '../lib/chicagoDate.js';
import { dayProgramCategoryToMode } from '../lib/bookingMode.js';
import {
  DEFAULT_DROPOFF_TIME,
  DROPOFF_TIME_REGEX,
  assertDropoffWithinWindow,
  computeDayProgramScheduledAt,
  parseDropoffTime,
  type DayProgramCategory,
} from '../lib/bookingSchedule.js';
import { toBookingWire, type BookingWire } from '../lib/bookingWire.js';
import { cancelBookingInTx } from '../lib/cancelBookingService.js';
import { sortBookingsByScheduledAt, wireManyBookings } from '../lib/wireManyBookings.js';
import { computeCancelDeadlineFromHours } from '../lib/cancelWindow.js';
import { ApiError } from '../lib/errors.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
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
  id: z.string().uuid(),
});

/**
 * Day-10 POST /bookings limits — both bound the cost of one request AND
 * shape the user-facing booking flow:
 *
 *   `MAX_DATES_PER_REQUEST` — a semester at a time. 30 days × 3 dogs ×
 *     1 INSERT booking + 1 INSERT booking_dog row + 3 INSERT credit_ledger
 *     debits = 30 × (1 + 3 + 3) = 210 INSERTs in one tx upper bound, well
 *     within a single tx's budget. Larger windows are split into multiple
 *     requests, each with its own Idempotency-Key.
 *
 *   `MAX_DOGS_PER_REQUEST` — five is the customer cohort ceiling (NWA's
 *     three-dog households are the realistic top end). A blanket cap
 *     stops a hostile body from materializing a thousand booking_dog rows
 *     per date.
 *
 *   `MAX_LOOKAHEAD_DAYS` — three months mirrors the booking flow's
 *     advance-window decision (locked Day 5b, 2026-05-20) — same number
 *     that `AVAILABILITY_MAX_DATES = 92` enforces on the read side.
 *
 * Updating these is a deliberate scope change — the numbers travel with
 * the body validator, the test suite, and the FE's UX expectations.
 */
const MAX_DATES_PER_REQUEST = 30;
const MAX_DOGS_PER_REQUEST = 5;
const MAX_LOOKAHEAD_DAYS = 92;
const ONE_DAY_MS = 86_400_000;

/**
 * PAYG auto-charge timing — the open `'payg'` invoice is due one hour before
 * the booking's scheduled drop-off, so the worker bills the card just ahead of
 * the session (matching the DATA-CONTRACT 2026-06-19 amendment's "~1h before
 * scheduled_at"). The free-cancel window for day programs is wider than this,
 * so a within-window cancel always voids the invoice before it charges.
 */
const PAYG_DUE_BEFORE_DROPOFF_MS = 60 * 60 * 1000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCATION_KEYS = LOCATION_SLUGS;

/**
 * Validate that a YYYY-MM-DD string maps to a real calendar day —
 * `2026-13-40` would pass the regex but isn't a date. Same shape as the
 * Day-5b helper in `routes/availability.ts:isValidCalendarDate`; the
 * two consumers (validate-on-read range expansion, validate-on-write
 * booking creation) share the same correctness floor.
 */
function isValidCalendarDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/**
 * POST /bookings body — day-program creation (day-school / day-care).
 * Other categories (group-class, B&T, boarding, private-lesson,
 * evaluation) hit different endpoints (POST /enrollments, request
 * flows, staff-picked slots); narrowing `category` here keeps the
 * route's static type honest about what it accepts. The route's
 * `parseAndValidatePostBody` adds the cross-field invariants Zod
 * doesn't express cleanly (dates distinct, lead not in additionals,
 * dropoff within window).
 *
 * `payment` (Δ 2026-06-19): a day-program group pays from the credit balance
 * (default, omitted) or pay-as-you-go (`'payg'` — skip the credit debit, charge
 * the card ~1h before drop-off via an open `'payg'` invoice). `payment_method_id`
 * is required when `payment: 'payg'` (the cross-field rule lives in
 * `validateBookingBody`; Zod only enforces shape here).
 */
const postBookingBodySchema = z
  .object({
    category: z.enum(['day-school', 'day-care']),
    lead_dog_id: z.string().uuid(),
    additional_dog_ids: z
      .array(z.string().uuid())
      .max(MAX_DOGS_PER_REQUEST - 1)
      .optional(),
    dates: z
      .array(
        z
          .string()
          .regex(ISO_DATE, 'must be YYYY-MM-DD')
          .refine(isValidCalendarDate, 'not a real calendar date'),
      )
      .min(1)
      .max(MAX_DATES_PER_REQUEST),
    dropoff_time: z.string().regex(DROPOFF_TIME_REGEX, 'must be HH:MM').optional(),
    location: z.enum(LOCATION_KEYS),
    notes: z.string().max(2000).optional(),
    payment: z.enum(['credits', 'payg']).optional(),
    payment_method_id: z.string().uuid().optional(),
  })
  .strict();

type PostBookingBody = z.infer<typeof postBookingBodySchema>;

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

    const rows = await bookingsRepository.findLiveActiveByOwner(principal.ownerId);
    const bucketed = rows.filter((row) => isInView(row, view, nowFactory()));
    const sorted = sortBookingsByScheduledAt(bucketed, view === 'past' ? 'desc' : 'asc');
    return wireManyBookings(sorted);
  });

  // --- GET /bookings/up-next ---------------------------------------------
  // Most-imminent upcoming booking (ascending scheduledAt, first row).
  // `null` when none. "Upcoming" here is the runtime bucket — an in-
  // progress day-school session at 11am still counts (end = 17:30).
  app.get(
    '/bookings/up-next',
    { preHandler: [authHook] },
    async (request): Promise<BookingWire | null> => {
      const principal = requirePrincipal(request);
      if (principal.kind !== 'owner') return null;

      const rows = await bookingsRepository.findLiveActiveByOwner(principal.ownerId);
      const upcoming = rows.filter((row) => isInView(row, 'upcoming', nowFactory()));
      const sorted = sortBookingsByScheduledAt(upcoming, 'asc');
      const first = sorted[0];
      if (first === undefined) return null;
      const [wire] = await wireManyBookings([first]);
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
    const [wire] = await wireManyBookings([row]);
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

      const rows = await bookingsRepository.findLiveActiveForDog(dogId, principal.ownerId);
      const bucketed = rows.filter((row) => isInView(row, view, nowFactory()));
      const sorted = sortBookingsByScheduledAt(bucketed, view === 'past' ? 'desc' : 'asc');
      return wireManyBookings(sorted);
    },
  );

  // --- POST /bookings -----------------------------------------------------
  //
  // Day 10 day-program creation (DATA-CONTRACT §C, schema.sql ~line 1328
  // bookSession transaction-contract notes).
  //
  // One request → N bookings, one per requested date, atomic. Body:
  //   { category, lead_dog_id, additional_dog_ids?, dates[],
  //     dropoff_time?, location, notes? }
  // → 201 BookingWire[] (length = dates.length, ordered ASC by scheduled_at).
  //
  // Owner-only (staff portal lives at Day 19). Idempotency-Key required;
  // the same key + body returns the stored response. The same key + a
  // different body produces 422 `idempotency_mismatch`.
  //
  // The transaction protocol — DEADLOCK ORDER MATTERS, do not reorder:
  //
  //   1. Ownership gate per dog (`dogsRepository.findOwnedExists`). Any
  //      miss → 404 (same response as "dog doesn't exist"; ids don't
  //      enumerate across owners).
  //   2. Advisory locks in canonical order:
  //        (a) `withDogModeLocks(tx, dogs ASC, mode, ...)`  serializes
  //            credit_ledger contention per (dog, mode).
  //        (b) `withCapacityLocks(tx, location, dates ASC, ...)`
  //            serializes `day_capacity` contention per (location, date).
  //      Both batch helpers acquire in sorted order so two concurrent
  //      N-key requests on overlapping sets observe the same total
  //      acquisition order — no deadlock.
  //   3. Gate pre-check in priority order (payment → vaccine →
  //      agreement). Each gate produces a complete error for the failing
  //      category (every missing vaccine across every dog, every
  //      unsigned agreement). The first failing gate aborts; the user
  //      fixes that category, retries, and the next gate (if any)
  //      surfaces. Multi-gate consolidation is a future refinement
  //      (`lib/bookingErrors.ts` design note).
  //   4. Credit pre-check across all (dog, mode) pairs — every dog must
  //      have >= `dates.length` credits in `mode`. Insufficient → 422
  //      `insufficient_credits` with the per-dog gap list.
  //   5. Per-date (sorted ASC) loop:
  //        - assert capacity inside the held lock
  //        - INSERT bookings + booking_dogs (gate triggers fire here;
  //          the catch maps trigger violations to typed `ApiError` via
  //          `gateTriggerErrorToApiError` for the rare race window)
  //        - INSERT credit_ledger debits per dog (delta=-1, reason='booking-debit')
  //   6. Post-commit (handled by withMutation):
  //        - `patternsToInvalidate` wipes `avail:{location}:*` — every
  //          range cache spanning this location's dates is stale now.
  //
  // The DB-side BEFORE-INSERT gate triggers (schema.sql lines 1184/1231/1272)
  // remain the unbypassable floor — the route pre-check produces friendly
  // structured details for the typical case; the trigger fallback maps
  // any race-induced violation back to a typed `ApiError` so the wire
  // shape stays consistent.
  app.post(
    '/bookings',
    { preHandler: [authHook] },
    async (request, reply): Promise<BookingWire[]> => {
      const principal = requirePrincipal(request);
      requireOwner(principal, 'create a booking');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const body = parseOrThrow(postBookingBodySchema, request.body, 'body');
      const parsed = validateBookingBody(body, nowFactory());

      const outcome = await withMutation<BookingWire[]>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /bookings',
          requestHash: hashRequestBody(body),
          patternsToInvalidate: () => [`avail:${parsed.location}:*`],
        },
        async (tx) => {
          // 1. Ownership gate — every dog must belong to the principal.
          for (const dogId of parsed.allDogIds) {
            const exists = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
            if (!exists) {
              throw new ApiError('not_found', `dog ${dogId} not found`);
            }
          }

          // 2-6. Locks → gates → capacity/insert/debit.
          const bookingsWire = await withDogModeLocks(
            tx,
            parsed.allDogIds,
            parsed.mode,
            parsed.location,
            () =>
              withCapacityLocks(tx, parsed.location, parsed.sortedDates, async () => {
                // Gates (payment → vaccine → agreement) above the DB
                // trigger floor. See `lib/bookingGatePreCheck.ts` for the
                // sequence rationale; first failure aborts with full
                // structured details for that category.
                await checkBookingGates(tx, {
                  ownerId: principal.ownerId,
                  dogIds: parsed.allDogIds,
                  category: parsed.category,
                });

                // Payment branch (Δ 2026-06-19). PAYG validates the card + the
                // active per-day rate up front and SKIPS the credit pre-check;
                // 'credits' runs the per-dog balance check. `paygPlan` (set only
                // for PAYG) decides the per-booking money write in the loop:
                // schedule a card auto-charge vs. debit the credit ledger.
                const paygPlan = await resolvePaygPlan(tx, parsed, principal.ownerId, nowFactory());
                if (paygPlan === null) {
                  // Credit pre-check — every dog needs >= dates.length credits in `mode`.
                  const creditGaps: CreditGap[] = [];
                  for (const dogId of parsed.allDogIds) {
                    const balance =
                      (await creditLedgerRepository.balanceForDogInTx(
                        tx,
                        dogId,
                        parsed.mode,
                        parsed.location,
                      )) ?? 0;
                    if (balance < parsed.sortedDates.length) {
                      creditGaps.push({
                        dog_id: dogId,
                        mode: parsed.mode,
                        balance,
                        required: parsed.sortedDates.length,
                      });
                    }
                  }
                  if (creditGaps.length > 0) throw insufficientCreditsError(creditGaps);
                }

                // Duplicate guard (Day-19d) — block re-booking a day the dog
                // already attends in this category. Cancelled bookings are
                // excluded, so a cancelled day can be re-booked. Checked under
                // the day-mode lock, so a concurrent insert can't slip a
                // duplicate past this.
                const dupConflicts: AlreadyBookedConflict[] = [];
                for (const dogId of parsed.allDogIds) {
                  const existing = await bookingsRepository.findLiveScheduledAtForDogCategory(
                    tx,
                    dogId,
                    parsed.category,
                  );
                  const bookedDays = new Set(existing.map(bucketToChicagoDate));
                  for (const date of parsed.sortedDates) {
                    if (bookedDays.has(date)) {
                      dupConflicts.push({ dog_id: dogId, category: parsed.category, date });
                    }
                  }
                }
                if (dupConflicts.length > 0) throw alreadyBookedError(dupConflicts);

                // Per-date: capacity → INSERT booking + booking_dogs → money
                // write (PAYG invoice schedule, or credit-ledger debits).
                const wires: BookingWire[] = [];
                for (const date of parsed.sortedDates) {
                  await dayCapacityRepository.assertCapacityWithinLock(tx, {
                    location: parsed.location,
                    date,
                    mode: parsed.mode,
                    requestedCount: parsed.allDogIds.length,
                  });

                  const scheduledAt = computeDayProgramScheduledAt(
                    parsed.category,
                    date,
                    parsed.dropoff,
                  );
                  // Resolve the active free-cancel hours from `cancel_window_
                  // settings` (Day 13 — staff-tunable from the portal). The
                  // resolved deadline is stamped on the row at creation; a
                  // later policy change does NOT retroactively re-stamp
                  // existing bookings.
                  const hours = await cancelWindowSettingsRepository.resolveHoursFor(
                    parsed.category,
                    tx,
                  );
                  const cancelDeadlineAt = computeCancelDeadlineFromHours(scheduledAt, hours);

                  const inserted = await insertBookingWithGateMapping(tx, {
                    ownerId: principal.ownerId,
                    leadDogId: parsed.leadDogId,
                    category: parsed.category,
                    scheduledAt,
                    location: parsed.location,
                    notes: parsed.notes,
                    cancelDeadlineAt,
                    additionalDogIds: parsed.additionalDogIds,
                  });

                  if (paygPlan !== null) {
                    // PAYG: no credit debit. Schedule a card auto-charge 1h
                    // before drop-off; the invoiceAutoCharge worker (Day-15)
                    // bills the open invoice at due_at. A within-window cancel
                    // voids it (see cancelBookingService).
                    //
                    // Amount is the per-day rate × the booking's roster size —
                    // one combined charge for all dogs on the booking (one
                    // statement line, one Stripe fee), mirroring the credits
                    // path's one-debit-per-dog total. dog count is bounded by
                    // MAX_DOGS_PER_REQUEST.
                    //
                    // Cancel-void safety: `cancelDeadlineAt = scheduledAt −
                    // hours_before`, and the `cancel_window_settings_hours_
                    // before_check` CHECK (hours_before > 0, integer ⇒ ≥ 1h)
                    // guarantees `cancelDeadlineAt ≤ dueAt = scheduledAt − 1h`.
                    // So a within-window cancel always lands before the auto-
                    // charge and can void the invoice — enforced at the schema
                    // floor, no app-level guard needed.
                    const dueAt = new Date(scheduledAt.getTime() - PAYG_DUE_BEFORE_DROPOFF_MS);
                    await invoicesRepository.createOpen(tx, {
                      ownerId: principal.ownerId,
                      amountCents: paygPlan.amountCents * parsed.allDogIds.length,
                      purpose: 'payg',
                      paymentMethodId: paygPlan.paymentMethodId,
                      dueAt: dueAt.toISOString(),
                      bookingId: inserted.id,
                    });
                  } else {
                    for (const dogId of parsed.allDogIds) {
                      await creditLedgerRepository.debitForBooking(tx, {
                        dogId,
                        mode: parsed.mode,
                        location: parsed.location,
                        bookingId: inserted.id,
                      });
                    }
                  }

                  // Day-16: enqueue the scheduled reminder rows for this
                  // booking. UNIQUE on dedupe_key makes an idempotent replay
                  // safe; the schedule rows roll back with the booking on
                  // any later in-tx failure.
                  await enqueueBookingReminders(tx, {
                    bookingId: inserted.id,
                    ownerId: principal.ownerId,
                    leadDogId: parsed.leadDogId,
                    category: parsed.category,
                    scheduledAt,
                  });

                  // `inserted` IS the BookingRow projection (`bookingsRepository.create`
                  // RETURNING ...BOOKING_PROJECTION). No re-fetch needed — the route
                  // assembles the wire shape directly off the inserted row.
                  wires.push(
                    toBookingWire(
                      inserted,
                      {
                        lead: parsed.leadDogId,
                        additional: [...parsed.additionalDogIds].sort(),
                      },
                      null /* day programs carry no trainer */,
                    ),
                  );
                }
                return wires;
              }),
          );

          return { status: 201, body: bookingsWire };
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
  //      'cancel-refund' row inserted per debit; balance recomputes.
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
      let pendingStripeRefund:
        | { refundId: string; paymentIntentId: string; amountCents: number }
        | undefined;

      const outcome = await withMutation<BookingWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /bookings/:id/cancel',
          requestHash: hashRequestBody({ id }),
          // Day-13 cache invalidation: drop the per-location availability
          // range cache so the freed seat surfaces in the next /availability
          // read. Booking reads themselves aren't cached today.
          patternsToInvalidate: (body) =>
            body.location !== undefined && body.location !== null
              ? [`avail:${body.location}:*`]
              : [],
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
            if (pendingStripeRefund === undefined) return;
            const result = await stripe.createRefund(
              {
                paymentIntentId: pendingStripeRefund.paymentIntentId,
                amountCents: pendingStripeRefund.amountCents,
                reason: 'requested_by_customer',
              },
              `${idempotencyKey}:refund`,
            );
            await refundsRepository.markStripeId({
              id: pendingStripeRefund.refundId,
              stripeRefundId: result.id,
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
          });
          pendingStripeRefund = result.pendingStripeRefund;
          return { status: 200, body: result.wire };
        },
      );

      reply.code(outcome.status);
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

// =========================================================================
// Day 10 POST /bookings helpers
// =========================================================================

/**
 * Validated, derived form of the request body. `parseOrThrow` handles
 * the Zod-shape errors; this helper layers on cross-field invariants
 * Zod doesn't express cleanly (dates distinct, lead not in additionals,
 * dropoff within window, no past dates, lookahead cap).
 *
 * Returns the route-internal `ValidatedBookingBody` — every downstream
 * call (gate pre-check, capacity assertion, INSERT) takes this typed
 * shape. The route handler doesn't touch the raw Zod-parsed body after
 * this point.
 */
/**
 * How the group is paid (Δ 2026-06-19). A tagged union so `paymentMethodId`
 * exists *only* on the PAYG arm — `'credits'` carries no card, `'payg'` always
 * carries one (the cross-field requirement is enforced in `validateBookingBody`,
 * not modeled as an optional that downstream code has to re-check).
 */
type PaymentPlan = { kind: 'credits' } | { kind: 'payg'; paymentMethodId: string };

interface ValidatedBookingBody {
  category: DayProgramCategory;
  leadDogId: string;
  additionalDogIds: string[];
  allDogIds: string[];
  sortedDates: string[];
  dropoff: { hour: number; minute: number };
  location: (typeof LOCATION_KEYS)[number];
  notes: string | null;
  mode: ReturnType<typeof dayProgramCategoryToMode>;
  payment: PaymentPlan;
}

function validateBookingBody(body: PostBookingBody, now: Date): ValidatedBookingBody {
  // Combined dog list — lead first, then additionals. Distinctness +
  // count cap enforced before we touch the DB.
  const additionalDogIds = body.additional_dog_ids ?? [];
  const allDogIds = [body.lead_dog_id, ...additionalDogIds];
  if (allDogIds.length > MAX_DOGS_PER_REQUEST) {
    throw new ApiError(
      'invalid_payload',
      `at most ${MAX_DOGS_PER_REQUEST} dogs per booking (got ${allDogIds.length})`,
    );
  }
  const dogIdSet = new Set(allDogIds);
  if (dogIdSet.size !== allDogIds.length) {
    // lead_dog_id appearing in additional_dog_ids OR an additional id
    // listed twice — both are the same defect from the user's POV.
    throw new ApiError('invalid_payload', 'lead_dog_id and additional_dog_ids must be distinct');
  }

  // Dates: distinct, real, today-or-future, within MAX_LOOKAHEAD_DAYS.
  // Today is "today in America/Chicago" so a 11pm Mar 7 (Chicago)
  // request to book "Mar 8" doesn't fail as "in the past" because UTC
  // rolled over already — Chicago is the booking-day truth axis.
  const today = bucketChicagoToday(now);
  const todayMs = parseDateUtcMs(today);
  const lookAheadCapMs = todayMs + MAX_LOOKAHEAD_DAYS * ONE_DAY_MS;
  const dateSet = new Set<string>();
  for (const date of body.dates) {
    if (dateSet.has(date)) {
      throw new ApiError('invalid_payload', `dates contains duplicate ${date}`);
    }
    dateSet.add(date);
    const dateMs = parseDateUtcMs(date);
    if (dateMs < todayMs) {
      throw new ApiError(
        'invalid_payload',
        `date ${date} is in the past (today in America/Chicago is ${today})`,
      );
    }
    if (dateMs > lookAheadCapMs) {
      throw new ApiError(
        'invalid_payload',
        `date ${date} exceeds the ${MAX_LOOKAHEAD_DAYS}-day lookahead window`,
      );
    }
  }
  const sortedDates = [...body.dates].sort();

  // Drop-off time: parse + window check. Default opens of the window
  // when the body omits `dropoff_time`.
  const dropoff =
    body.dropoff_time !== undefined ? parseDropoffTime(body.dropoff_time) : DEFAULT_DROPOFF_TIME;
  assertDropoffWithinWindow(dropoff);

  return {
    category: body.category,
    leadDogId: body.lead_dog_id,
    additionalDogIds,
    allDogIds,
    sortedDates,
    dropoff,
    location: body.location,
    notes: body.notes ?? null,
    mode: dayProgramCategoryToMode(body.category),
    payment: resolvePaymentPlan(body),
  };
}

/**
 * Resolve the body's payment fields into the tagged `PaymentPlan`. Default is
 * `'credits'` (omitted `payment`). PAYG requires `payment_method_id` — the
 * card's ownership + liveness is validated in-tx (here we only enforce
 * presence). A `payment_method_id` sent on a `'credits'` group is ignored
 * (additive, backward-compatible).
 */
function resolvePaymentPlan(body: PostBookingBody): PaymentPlan {
  if ((body.payment ?? 'credits') === 'credits') return { kind: 'credits' };
  if (body.payment_method_id === undefined) {
    throw new ApiError('invalid_payload', 'payment_method_id is required when payment is payg');
  }
  return { kind: 'payg', paymentMethodId: body.payment_method_id };
}

/** The PAYG money plan resolved in-tx: the validated card + the per-session amount. */
interface PaygPlan {
  paymentMethodId: string;
  amountCents: number;
}

/**
 * In-tx PAYG validation. Returns `null` for a `'credits'` group (the route runs
 * the credit pre-check instead). For a `'payg'` group, verifies the card is
 * owned + live and resolves the active per-day rate — both 404 on miss
 * (card 404 mirrors `loadStripePaymentContext`'s collapse of not-found /
 * not-yours / soft-expired; rate 404 mirrors `GET /rates`). The returned
 * `amountCents` is the charge per booking date.
 */
async function resolvePaygPlan(
  tx: Tx,
  parsed: ValidatedBookingBody,
  ownerId: string,
  now: Date,
): Promise<PaygPlan | null> {
  if (parsed.payment.kind !== 'payg') return null;

  const card = await paymentMethodsRepository.findLiveByIdForOwner(tx, {
    id: parsed.payment.paymentMethodId,
    ownerId,
  });
  if (card === undefined) {
    throw new ApiError('not_found', `payment method ${parsed.payment.paymentMethodId} not found`);
  }

  const today = bucketChicagoToday(now);
  const rate = await serviceRatesRepository.findActiveRate(
    parsed.category,
    parsed.location,
    today,
    tx,
  );
  if (rate === undefined) {
    throw new ApiError(
      'not_found',
      `no active rate for category=${parsed.category} location=${parsed.location} on ${today}`,
    );
  }

  return { paymentMethodId: parsed.payment.paymentMethodId, amountCents: rate.amount_cents };
}

/**
 * Parse YYYY-MM-DD to a UTC-midnight ms count. Pure timezone-independent
 * arithmetic — same shape `lib/availability.ts` uses. No DST drift; same
 * value across both Chicago and UTC for the SAME calendar label.
 */
function parseDateUtcMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}
