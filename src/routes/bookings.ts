import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { withCapacityLocks, withDogModeLocks } from '../db/locks.js';
import { agreementSignaturesRepository } from '../db/repositories/agreementSignaturesRepository.js';
import { bookingsRepository, type BookingRow } from '../db/repositories/bookingsRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { dogVaccinesRepository } from '../db/repositories/dogVaccinesRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import { locationKey } from '../db/schema/schema.js';
import { isInView } from '../lib/bookingBucket.js';
import {
  agreementUnsignedError,
  gateTriggerErrorToApiError,
  insufficientCreditsError,
  paymentRequiredError,
  vaccineMissingError,
  type CreditGap,
  type VaccineGap,
} from '../lib/bookingErrors.js';
import { bucketChicagoToday } from '../lib/chicagoDate.js';
import { dayProgramCategoryToMode } from '../lib/bookingMode.js';
import {
  DEFAULT_DROPOFF_TIME,
  DROPOFF_TIME_REGEX,
  assertDropoffWithinWindow,
  computeDayProgramScheduledAt,
  parseDropoffTime,
  type DayProgramCategory,
} from '../lib/bookingSchedule.js';
import { groupBookingDogs, toBookingWire, type BookingWire } from '../lib/bookingWire.js';
import { computeCancelDeadline } from '../lib/cancelWindow.js';
import { ApiError } from '../lib/errors.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCATION_KEYS = pgEnumTuple(locationKey);

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
  })
  .strict();

type PostBookingBody = z.infer<typeof postBookingBodySchema>;

export interface BookingsRouteOptions extends AuthRouteOptions {
  now?: () => Date;
}

export function registerBookingsRoute(app: FastifyInstance, opts: BookingsRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  // --- GET /bookings?view=upcoming|past ---------------------------------
  app.get('/bookings', { preHandler: [authHook] }, async (request): Promise<BookingWire[]> => {
    const principal = requirePrincipal(request);
    const view = parseView(request.query);
    if (principal.kind !== 'owner') return [];

    const rows = await bookingsRepository.findLiveActiveByOwner(principal.ownerId);
    const bucketed = rows.filter((row) => isInView(row, view, nowFactory()));
    const sorted = sortByScheduledAt(bucketed, view === 'past' ? 'desc' : 'asc');
    return wireBookings(sorted);
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
      const sorted = sortByScheduledAt(upcoming, 'asc');
      const first = sorted[0];
      if (first === undefined) return null;
      const [wire] = await wireBookings([first]);
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
    const [wire] = await wireBookings([row]);
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
      const sorted = sortByScheduledAt(bucketed, view === 'past' ? 'desc' : 'asc');
      return wireBookings(sorted);
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
      requireOwner(principal, 'create');
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
          const bookingsWire = await withDogModeLocks(tx, parsed.allDogIds, parsed.mode, () =>
            withCapacityLocks(tx, parsed.location, parsed.sortedDates, async () => {
              // Payment gate
              const hasPayment = await paymentMethodsRepository.hasLiveForOwner(
                tx,
                principal.ownerId,
              );
              if (!hasPayment) throw paymentRequiredError();

              // Vaccine gate (per-dog, accumulate across all booking_dogs)
              const vaccineGaps: VaccineGap[] = [];
              for (const dogId of parsed.allDogIds) {
                const missing = await dogVaccinesRepository.findMissingForCategory(
                  tx,
                  dogId,
                  parsed.category,
                );
                for (const m of missing) {
                  vaccineGaps.push({
                    dog_id: dogId,
                    requirement_key: m.requirement_key,
                    label: m.label,
                  });
                }
              }
              if (vaccineGaps.length > 0) throw vaccineMissingError(vaccineGaps);

              // Agreement gate (owner-scoped)
              const missingAgreements =
                await agreementSignaturesRepository.findMissingForOwnerCategory(
                  tx,
                  principal.ownerId,
                  parsed.category,
                );
              if (missingAgreements.length > 0) {
                throw agreementUnsignedError(missingAgreements);
              }

              // Credit pre-check — every dog needs >= dates.length credits in `mode`.
              const creditGaps: CreditGap[] = [];
              for (const dogId of parsed.allDogIds) {
                const balance =
                  (await creditLedgerRepository.balanceForDogInTx(tx, dogId, parsed.mode)) ?? 0;
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

              // Per-date: capacity → INSERT booking + booking_dogs → INSERT debits.
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
                const cancelDeadlineAt = computeCancelDeadline(parsed.category, scheduledAt);

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

                for (const dogId of parsed.allDogIds) {
                  await creditLedgerRepository.debitForBooking(tx, {
                    dogId,
                    mode: parsed.mode,
                    bookingId: inserted.id,
                  });
                }

                const row = await bookingsRepository.findByIdInTx(tx, inserted.id);
                if (row === undefined) {
                  throw new Error(`bookings.create: row ${inserted.id} missing after insert`);
                }
                wires.push(
                  toBookingWire(
                    row,
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

// ---- sort + denormalize ----------------------------------------------

/**
 * Pure sort by scheduled_at. Used by every booking list endpoint —
 * upcoming = ASC (soonest first), past = DESC (most recent first).
 */
function sortByScheduledAt(rows: BookingRow[], direction: 'asc' | 'desc'): BookingRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      pgTimestampToDate(a.scheduledAt).getTime() - pgTimestampToDate(b.scheduledAt).getTime(),
  );
  return direction === 'desc' ? sorted.reverse() : sorted;
}

/**
 * Denormalize a set of booking rows into wire shapes. Two batched
 * lookups (booking_dogs + staff names) regardless of row count — cost
 * is constant in the input size. Pure side of the route: takes already-
 * sorted, already-bucketed rows; returns the JSON the FE consumes.
 *
 * Throws if a booking has no `booking_dogs` rows at all (schema-level
 * invariant violation — better to fail loud than emit a malformed
 * wire shape the FE doesn't know how to handle).
 */
async function wireBookings(rows: BookingRow[]): Promise<BookingWire[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [bookingDogRows, trainerName] = await Promise.all([
    bookingsRepository.findDogsByBookingIds(ids),
    staffRepository.resolveTrainerNames(rows),
  ]);
  const dogsByBooking = groupBookingDogs(bookingDogRows);
  return rows.map((row) => {
    const dogIds = dogsByBooking.get(row.id);
    if (dogIds === undefined) {
      throw new Error(`booking ${row.id}: no booking_dogs rows found`);
    }
    return toBookingWire(row, dogIds, trainerName(row.trainerStaffId));
  });
}

// =========================================================================
// Day 10 POST /bookings helpers
// =========================================================================

/**
 * Narrow the principal to owner. POST /bookings is owner-only — staff
 * portal bookings are a Day-19 verb at `/staff/bookings`. The `asserts`
 * predicate narrows the static type at the call site so subsequent
 * `principal.ownerId` reads compile without a cast.
 */
function requireOwner(
  principal: ReturnType<typeof requirePrincipal>,
  action: 'create',
): asserts principal is { kind: 'owner'; ownerId: string; supabaseUid: string } {
  if (principal.kind !== 'owner') {
    throw new ApiError('forbidden', `only owners may ${action} a booking`);
  }
}

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
  };
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

/**
 * INSERT one booking row + its booking_dogs with the route-layer typed-
 * error mapping for the three gate triggers (defense-in-depth fallback
 * if the route-level pre-check missed a race). Trigger violations are
 * mapped back to typed `ApiError` via `gateTriggerErrorToApiError`; any
 * other error re-throws.
 *
 * The trigger fallback handles three concurrency edge cases the
 * pre-check can't fully eliminate:
 *
 *   - A concurrent vaccine soft-expire (DELETE /dogs/:id/vaccines/:vid)
 *     between the pre-check and the INSERT fires the
 *     `bookings_vaccine_guard` trigger.
 *   - A concurrent payment-method removal (Day-9+ when that endpoint
 *     lands) fires `bookings_payment_guarantee`.
 *   - A concurrent agreement-document version bump (Day-19 portal) fires
 *     `bookings_agreement_guard`.
 *
 * In all three cases the booking row never gets created, and the route
 * surfaces the same typed code the pre-check would have — with the
 * caveat that trigger errors carry less structured detail than
 * pre-check errors (the trigger has only the missing labels in a
 * comma-joined message, not the per-key structured array).
 */
async function insertBookingWithGateMapping(
  tx: Parameters<typeof bookingsRepository.create>[0],
  values: Parameters<typeof bookingsRepository.create>[1],
): Promise<{ id: string }> {
  try {
    return await bookingsRepository.create(tx, values);
  } catch (err) {
    const mapped = gateTriggerErrorToApiError(err);
    if (mapped !== undefined) throw mapped;
    throw err;
  }
}
