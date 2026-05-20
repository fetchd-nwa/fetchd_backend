import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { cohorts } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { GroupClassKey } from './groupClassesRepository.js';
import type { LocationKey } from '../../lib/bookingWire.js';

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

function asCohortRows(rows: unknown[]): CohortRow[] {
  return rows as CohortRow[];
}

export const cohortsRepository = {
  /** Live cohorts for one class, ordered by start_date ASC (next first). */
  async findByClassKey(classKey: GroupClassKey): Promise<CohortRow[]> {
    const rows = await db
      .select(COHORT_PROJECTION)
      .from(cohorts)
      .where(and(eq(cohorts.classKey, classKey), live(cohorts)))
      .orderBy(asc(cohorts.startDate));
    return asCohortRows(rows);
  },

  /** Single live cohort by id, or undefined. */
  async findById(id: string): Promise<CohortRow | undefined> {
    const rows = await db
      .select(COHORT_PROJECTION)
      .from(cohorts)
      .where(and(eq(cohorts.id, id), live(cohorts)))
      .limit(1);
    return asCohortRows(rows)[0];
  },
};
