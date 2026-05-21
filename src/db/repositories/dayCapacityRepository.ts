import { and, between, eq } from 'drizzle-orm';
import { z } from 'zod';
import { readThrough } from '../../lib/cache.js';
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

/**
 * Day-8 cache: availability is the hottest read in the system — every
 * booking screen renders it, multiple ranges (week / month) per session.
 * The whole rendered range is the cache unit (`avail:{location}:{from}:
 * {to}`) because the route fetches a contiguous range. A single
 * `day_capacity` write touches every range cache that spans the affected
 * date, so invalidation is via pattern (`avail:{location}:*`) from the
 * Day-9+ override-write mutation.
 *
 * 5 minutes TTL: staff edits are sparse but not rare; combined with the
 * pattern wipe on write, the user-visible staleness window is bounded.
 */
const DAY_CAPACITY_TTL_SEC = 300;

const DAY_CAPACITY_ROW_SCHEMA: z.ZodType<DayCapacityOverrideRow> = z.object({
  date: z.string(),
  school_openings: z.number(),
  daycare_openings: z.number(),
});
const DAY_CAPACITY_ROWS_SCHEMA = DAY_CAPACITY_ROW_SCHEMA.array();

/**
 * Cache key for one location-anchored range read. The shape matches
 * `findOverridesInRange`'s args — `from`/`to` are already YYYY-MM-DD
 * strings, no formatting drift. Day-9+ `day_capacity` writes drop
 * everything under `avail:{location}:*` via `invalidatePattern`.
 */
export function dayCapacityCacheKey(location: LocationKey, from: string, to: string): string {
  return `avail:${location}:${from}:${to}`;
}

export const dayCapacityRepository = {
  /**
   * Live overrides for one location between `from` and `to` inclusive.
   * Both bounds are YYYY-MM-DD; Postgres `BETWEEN` on a `date` column is
   * inclusive on both ends. Caller is responsible for the 60-day-ish range
   * cap (see `lib/availability.AVAILABILITY_MAX_DATES`).
   *
   * Day-8 read-through cached under `avail:{location}:{from}:{to}` for
   * 5 min. Invalidated by `day_capacity` writes via
   * `invalidatePattern('avail:{location}:*')`.
   */
  async findOverridesInRange(
    location: LocationKey,
    from: string,
    to: string,
  ): Promise<DayCapacityOverrideRow[]> {
    return readThrough(
      dayCapacityCacheKey(location, from, to),
      DAY_CAPACITY_TTL_SEC,
      DAY_CAPACITY_ROWS_SCHEMA,
      () =>
        db
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
          ),
    );
  },
};
