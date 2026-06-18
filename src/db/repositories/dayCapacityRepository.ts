import { and, between, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { readThrough } from '../../lib/cache.js';
import { defaultDayCapacity } from '../../lib/availability.js';
import { insufficientCapacityError } from '../../lib/bookingErrors.js';
import type { BookingMode } from '../../lib/bookingMode.js';
import { db } from '../client.js';
import { bookingDogs, bookings, dayCapacity, dogs, type LocationKey } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';

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

  /**
   * Day 10 — Tx-only capacity assertion for the day-program booking path.
   * MUST be called inside a `withCapacityLock(tx, location, date, ...)`
   * scope; the advisory lock serializes concurrent bookings on the same
   * calendar bucket so the count below is a consistent snapshot.
   *
   * The capacity rule:
   *   openings = (live day_capacity row at (location, date)) ?? defaultDayCapacity(date)
   *   used     = count of live, non-cancelled booking_dogs for non-staff
   *              dogs on bookings whose category matches `mode` and
   *              scheduled_at bucket-to-Chicago-date equals `date` at
   *              the same location
   *   remaining = openings[mode] − used
   *   if remaining < requestedCount → insufficient_capacity 422
   *
   * Staff-owned dogs (`dogs.staff_owner_id IS NOT NULL`) are excluded
   * from the count — `dogs.capacity_exempt` is the generated boolean
   * equivalent and is what we filter on for clarity. Same exemption the
   * three gate triggers apply (locked 2026-05-19; staff aren't billed
   * and don't take a seat from owner customers).
   *
   * The `bucketToChicagoDate` semantic is encoded in SQL via
   * `(scheduled_at AT TIME ZONE 'America/Chicago')::date = $date::date`.
   * This MUST match the route-side `computeDayProgramScheduledAt`
   * encoding so the calendar bucket the route stamps equals the calendar
   * bucket the capacity check counts against — both are
   * `bucketToChicagoDate(bookings.scheduled_at)`.
   *
   * Throws `insufficient_capacity` 422 with structured details on the
   * failing path; returns normally on success. Idempotent within a tx —
   * call twice and you get the same answer (the lock isn't reacquired
   * but pg_advisory_xact_lock is reentrant per-session per-key).
   */
  async assertCapacityWithinLock(
    tx: Tx,
    args: {
      location: LocationKey;
      date: string;
      mode: BookingMode;
      requestedCount: number;
    },
  ): Promise<void> {
    if (args.requestedCount <= 0) return;
    const [override] = await tx
      .select({
        schoolOpenings: dayCapacity.schoolOpenings,
        daycareOpenings: dayCapacity.daycareOpenings,
      })
      .from(dayCapacity)
      .where(
        and(
          eq(dayCapacity.location, args.location),
          eq(dayCapacity.date, args.date),
          live(dayCapacity),
        ),
      )
      .limit(1);
    const openings = openingsForMode(args.mode, args.date, override);

    const category = args.mode === 'school' ? 'day-school' : 'day-care';
    const [usage] = await tx
      .select({ used: sql<number>`count(*)::int`.as('used') })
      .from(bookingDogs)
      .innerJoin(bookings, eq(bookings.id, bookingDogs.bookingId))
      .innerJoin(dogs, eq(dogs.id, bookingDogs.dogId))
      .where(
        and(
          eq(bookings.location, args.location),
          eq(bookings.category, category),
          sql`(${bookings.scheduledAt} AT TIME ZONE 'America/Chicago')::date = ${args.date}::date`,
          ne(bookings.status, 'cancelled'),
          live(bookings),
          live(bookingDogs),
          // Staff dogs are capacity-exempt — see `dogs.capacity_exempt`
          // generated column + the three booking-gate triggers' parallel
          // exemption (schema.sql lines 1192-1198).
          sql`${dogs.staffOwnerId} IS NULL`,
        ),
      );
    const used = usage?.used ?? 0;
    const remaining = openings - used;
    if (remaining < args.requestedCount) {
      throw insufficientCapacityError({
        location: args.location,
        date: args.date,
        mode: args.mode,
        openings_remaining: Math.max(0, remaining),
        requested: args.requestedCount,
      });
    }
  },
};

function openingsForMode(
  mode: BookingMode,
  date: string,
  override: { schoolOpenings: number; daycareOpenings: number } | undefined,
): number {
  if (override !== undefined) {
    return mode === 'school' ? override.schoolOpenings : override.daycareOpenings;
  }
  // No override — read the API-side default rule. Mirrors the read-side
  // fallback in `routes/availability.ts:83`. Weekend = closed (0/0);
  // weekday = 3/3.
  const d = defaultDayCapacity(date);
  return mode === 'school' ? d.school_openings : d.daycare_openings;
}
