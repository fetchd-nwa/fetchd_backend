import { and, between, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { dayCapacity, type locationKey } from '../schema/schema.js';
import { live } from '../softExpire.js';

type LocationKey = (typeof locationKey.enumValues)[number];

/**
 * Sparse override rows for day-program capacity (schema.sql:589-594). Only
 * rows that DIFFER from the default rule are stored — most calls return
 * 0-few rows for a multi-week window. The default ({3,3} weekday / {0,0}
 * weekend) is applied in the route via `lib/availability.defaultDayCapacity`
 * over the top of whatever this repo returns.
 *
 * Date column comes back as a `YYYY-MM-DD` string (Drizzle `date()` default
 * mode); the route uses it as a Map key against `datesInRange` output.
 */
export interface DayCapacityOverrideRow {
  date: string;
  school_openings: number;
  daycare_openings: number;
}

export const dayCapacityRepository = {
  /**
   * Live overrides for one location between `from` and `to` inclusive.
   * Both bounds are YYYY-MM-DD; Postgres `BETWEEN` on a `date` column is
   * inclusive on both ends. Caller is responsible for the 60-day-ish range
   * cap (see `lib/availability.AVAILABILITY_MAX_DATES`).
   */
  async findOverridesInRange(
    location: LocationKey,
    from: string,
    to: string,
  ): Promise<DayCapacityOverrideRow[]> {
    return db
      .select({
        date: dayCapacity.date,
        school_openings: dayCapacity.schoolOpenings,
        daycare_openings: dayCapacity.daycareOpenings,
      })
      .from(dayCapacity)
      .where(
        and(
          eq(dayCapacity.location, location),
          between(dayCapacity.date, from, to),
          live(dayCapacity),
        ),
      );
  },
};
