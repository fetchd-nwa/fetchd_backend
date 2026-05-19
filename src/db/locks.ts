import { and, eq, sql } from 'drizzle-orm';
import { bookingMode, cohorts, dayCapacity, locationKey } from './schema/schema.js';
import type { Tx } from './tx.js';

type BookingMode = (typeof bookingMode.enumValues)[number];
type LocationKey = (typeof locationKey.enumValues)[number];

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
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${dogId}:${mode}`}))`);
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
 * Materializing the default-rule row before locking is the caller's job
 * (Day-10 bookSession concern), not this primitive's.
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
