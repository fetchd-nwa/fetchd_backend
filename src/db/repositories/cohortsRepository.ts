import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { cohorts } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { GroupClassKey } from './groupClassesRepository.js';
import type { LocationKey } from '../../lib/bookingWire.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `cohorts`. One row per scheduled cohort of a
 * group class — used by the FE's cohort picker on the enrollment flow.
 * Cohorts have their own per-cohort `capacity` snapshot + `filled`
 * counter (the latter bumps in the Day-11 enrollment txn).
 */

export interface CohortRow {
  id: string;
  classKey: GroupClassKey;
  location: LocationKey;
  startDate: string;
  endDate: string | null;
  weeklyTime: string;
  weeks: number;
  capacity: number;
  filled: number;
}

const COHORT_PROJECTION = {
  id: cohorts.id,
  classKey: cohorts.classKey,
  location: cohorts.location,
  startDate: cohorts.startDate,
  endDate: cohorts.endDate,
  weeklyTime: cohorts.weeklyTime,
  weeks: cohorts.weeks,
  capacity: cohorts.capacity,
  filled: cohorts.filled,
} as const;

export const cohortsRepository = {
  /** Live cohorts for one class, ordered by start_date ASC (next first). */
  async findByClassKey(classKey: GroupClassKey): Promise<CohortRow[]> {
    return db
      .select(COHORT_PROJECTION)
      .from(cohorts)
      .where(and(eq(cohorts.classKey, classKey), live(cohorts)))
      .orderBy(asc(cohorts.startDate));
  },

  /** Single live cohort by id, or undefined. */
  async findById(id: string): Promise<CohortRow | undefined> {
    const rows = await db
      .select(COHORT_PROJECTION)
      .from(cohorts)
      .where(and(eq(cohorts.id, id), live(cohorts)))
      .limit(1);
    return rows[0];
  },

  // -------------------------------------------------------------------
  // Day 11 — write path. Tx-only. `lockCohort` (db/locks.ts) is the lock
  // primitive; this method composes after the lock and applies the
  // `filled` counter bump under the same row lock. Caller is responsible
  // for having `SELECT ... FOR UPDATE`-ed the row first — without that
  // lock, concurrent enrollments could each pass a capacity assertion
  // against a snapshot that hadn't yet seen the other's bump.
  // -------------------------------------------------------------------

  /**
   * Increment `cohorts.filled` by `delta` for one cohort. Schema CHECK
   * `filled <= capacity` enforces the hard ceiling — a race that slips
   * past the route-level pre-check would 23514 at the DB level (caller
   * pre-checks against the locked row, so this is defense-in-depth).
   *
   * Soft-expire isn't filtered here — the lock acquired by `lockCohort`
   * is what made the row mutable in this tx. If the route allowed an
   * expired cohort to reach this point, it's a route-layer bug; the
   * repo just executes the UPDATE.
   */
  async bumpFilled(tx: Tx, cohortId: string, delta: number): Promise<void> {
    await tx
      .update(cohorts)
      .set({ filled: sql`${cohorts.filled} + ${delta}` })
      .where(eq(cohorts.id, cohortId));
  },
};
