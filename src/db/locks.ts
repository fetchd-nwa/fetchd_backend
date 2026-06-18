import { and, eq, sql } from 'drizzle-orm';
import { bookingMode, cohorts, dayCapacity, events, type LocationKey } from './schema/schema.js';
import type { Tx } from './tx.js';

type BookingMode = (typeof bookingMode.enumValues)[number];

/**
 * Per-(dog, mode) transaction-scoped advisory lock — the booking
 * serializability primitive (`schema.sql` Transaction contract notes,
 * `bookSession` ~line 1310). Two concurrent retries of `bookSession` for the
 * same `(dog_id, mode)` must serialize so the `credit_ledger` debit can't
 * race the balance check (no double-spend). The lock is held until the
 * outer transaction commits OR rolls back — that's what `_xact_` means,
 * and it's why Day-0 lock #3 mandates the direct/session connection (5432).
 *
 * The key is `hashtext('<dogId>:<mode>')` — a single int4 hash that Postgres
 * widens to the int8 advisory-lock space. The colon separator is defensive:
 * dog IDs are UUIDs (fixed 36 chars) so concatenation alone would be
 * unambiguous, but the separator makes "no two different (dog, mode) pairs
 * collide" structurally obvious to a reader. Hash collisions across distinct
 * keys are birthday-paradox-bounded by int4 space; a spurious collide only
 * causes extra serialization, never incorrect behavior.
 *
 * `fn` runs AFTER the lock is acquired; subsequent statements inside `fn`
 * see the dog-mode pair as "owned" by this transaction. The lock auto-
 * releases on commit/rollback — there's no explicit `pg_advisory_unlock`
 * needed (and using one would be a footgun, since rolled-back transactions
 * still need their locks released).
 */
export async function withDogModeLock<T>(
  tx: Tx,
  dogId: string,
  mode: BookingMode,
  location: LocationKey,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${dogId}:${mode}:${location}`}))`);
  return fn();
}

/**
 * Row-lock a cohort for the duration of the transaction — the
 * `enrollInGroupClass` capacity-ceiling primitive (`schema.sql` Transaction
 * contract notes, `enrollInGroupClass` ~line 1276). Concurrent enrollment
 * attempts on the same cohort serialize on this row so the
 * `filled + len(non-staff dogs) <= capacity` assertion is race-free.
 *
 * Returns the locked row to the caller (who does the capacity arithmetic
 * and the `UPDATE cohorts SET filled = filled + ...`). `undefined` if the
 * cohort id doesn't exist — the caller decides the error semantic.
 *
 * Soft-expire is INTENTIONALLY not filtered here. The row lock acquires on
 * existence-by-id; capacity policy that an expired cohort can't be enrolled
 * into is the caller's call (the enrollment txn itself filters by
 * `live(cohorts)` before this — by the time we lock, the live check has
 * passed, and we lock the same id we just read).
 */
export async function lockCohort(
  tx: Tx,
  cohortId: string,
): Promise<typeof cohorts.$inferSelect | undefined> {
  const [row] = await tx.select().from(cohorts).where(eq(cohorts.id, cohortId)).for('update');
  return row;
}

/**
 * Row-lock an event for the duration of the transaction — the
 * `POST /events/:id/rsvp` soft-cap primitive (Day-19e). Concurrent RSVPs to
 * the same event serialize on this row so the
 * `live_dogs - owner_current + |dog_ids| <= capacity` assertion is race-free.
 * Returns the locked row (the caller reads `capacity` + does the arithmetic),
 * or `undefined` when the id doesn't exist. Soft-expire is intentionally NOT
 * filtered — same rationale as `lockCohort`: the route's `live` check runs
 * before the lock, and we lock the same id we just read.
 */
export async function lockEvent(
  tx: Tx,
  eventId: string,
): Promise<typeof events.$inferSelect | undefined> {
  const [row] = await tx.select().from(events).where(eq(events.id, eventId)).for('update');
  return row;
}

/**
 * Row-lock the `(location, date)` day-capacity row for the duration of the
 * transaction — the `bookSession` Day-School/Care openings primitive
 * (`schema.sql` Transaction contract notes, `bookSession` ~line 1306).
 * Returns the locked row so the caller can read `school_openings` /
 * `daycare_openings` against the booking mode and assert remaining capacity
 * before INSERTing the booking + decrementing the column.
 *
 * `undefined` if no override row exists for `(location, date)` — the
 * schema's design is that day_capacity is SPARSE (rows are overrides),
 * with a per-location default rule the API applies when no row is present.
 *
 * Day 10 superseded primitive: the day-program booking path uses
 * `withCapacityLock` + `dayCapacityRepository.assertCapacityWithinLock`
 * instead (advisory lock + count-against-default), which serializes
 * cleanly without materializing default-rule rows in the sparse table.
 * `lockDayCapacity` stays available for callers that genuinely want the
 * row-lock semantic (e.g., Day-19 staff-portal override edits where the
 * row's *existence* IS the lock target).
 */
export async function lockDayCapacity(
  tx: Tx,
  location: LocationKey,
  date: string,
): Promise<typeof dayCapacity.$inferSelect | undefined> {
  const [row] = await tx
    .select()
    .from(dayCapacity)
    .where(and(eq(dayCapacity.location, location), eq(dayCapacity.date, date)))
    .for('update');
  return row;
}

/**
 * Day 10 capacity serializer — advisory lock on `(location, date)` for the
 * day-program booking path. Held for the lifetime of the transaction;
 * concurrent `bookSession` calls touching the same calendar bucket serialize
 * cleanly without forcing the sparse `day_capacity` table to materialize
 * default-rule rows.
 *
 * Why advisory over row-lock for THIS path:
 * - `day_capacity` is SPARSE (only overrides). Locking via FOR UPDATE
 *   requires the row to exist; materializing a default-value row on every
 *   booked date breaks the "rows = overrides" invariant the read side
 *   relies on (a `day_capacity` row stops being an unambiguous override
 *   signal once we start writing default-value rows alongside).
 * - The advisory lock doesn't care whether a row exists. The capacity
 *   computation reads the override row OR falls back to the default rule
 *   under the same lock — symmetric with the read-side
 *   `defaultDayCapacity` fallback.
 * - The Day-19 staff portal will write `day_capacity` overrides; it
 *   should ALSO acquire this advisory lock so a concurrent booking
 *   assertion sees the staff write atomically. Documented at the call
 *   site when Day-19 lands.
 *
 * Lock key: `hashtext('capacity:<location>:<date>')`. The colon separator
 * makes "no two different (location, date) pairs collide" structurally
 * obvious; the prefix keeps this key namespace disjoint from the
 * `<dogId>:<mode>` advisory locks elsewhere in the file. int4 hash
 * collisions are birthday-paradox-bounded and only cause spurious
 * serialization (never incorrect behavior).
 *
 * Day-10 lock ordering protocol (deadlock avoidance): when a single
 * transaction acquires multiple capacity locks (multi-date booking),
 * caller MUST acquire them in ASC date order. Combined with
 * `withDogModeLocks`'s ASC dogId-ascending ordering, two concurrent
 * multi-key bookings can never deadlock — both observe the same
 * total acquisition order.
 */
export async function withCapacityLock<T>(
  tx: Tx,
  location: LocationKey,
  date: string,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`capacity:${location}:${date}`}))`);
  return fn();
}

/**
 * Day 10 batch helper for the multi-date `bookSession` path. Acquires
 * `withCapacityLock` for every `(location, date)` pair in canonical ASC
 * date order so two concurrent N-date bookings on overlapping date sets
 * can never deadlock against each other — both observe the same total
 * acquisition order. Single-date is a no-overhead degenerate of this
 * helper (one lock acquired).
 */
export async function withCapacityLocks<T>(
  tx: Tx,
  location: LocationKey,
  dates: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const sortedDates = [...dates].sort();
  for (const date of sortedDates) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`capacity:${location}:${date}`}))`,
    );
  }
  return fn();
}

/**
 * Day 10 batch helper for the multi-dog `bookSession` path. Acquires
 * `withDogModeLock` for every `(dogId, mode)` pair in canonical ASC dogId
 * order so two concurrent N-dog bookings on overlapping dog sets can
 * never deadlock — both observe the same total acquisition order.
 *
 * Single-mode (every booking_dog shares the same mode in a given booking
 * — day-school is 'school' for all dogs, day-care is 'daycare' for all):
 * the per-pair locks all share `mode`, but the key still uses
 * `<dogId>:<mode>` so a future mixed-mode booking shape (none planned)
 * wouldn't deadlock against a current single-mode one.
 *
 * Acquisition is sequential — postgres holds advisory locks until the
 * transaction commits, and the lock-acquire round-trips are cheap
 * (one statement each). Parallelizing would risk deadlock against a
 * concurrent transaction acquiring the same dogs in a different order.
 */
export async function withDogModeLocks<T>(
  tx: Tx,
  dogIds: readonly string[],
  mode: BookingMode,
  location: LocationKey,
  fn: () => Promise<T>,
): Promise<T> {
  const sortedIds = [...dogIds].sort();
  for (const dogId of sortedIds) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${dogId}:${mode}:${location}`}))`,
    );
  }
  return fn();
}
