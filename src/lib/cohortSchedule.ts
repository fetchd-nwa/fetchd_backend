import { addCalendarDays, chicagoWallPartsAt, chicagoWallTimeToUtc } from './chicagoDate.js';

/**
 * Group-class weekly cadence — the Day-11 enrollment counterpart to
 * `lib/bookingSchedule.ts:computeDayProgramScheduledAt`.
 *
 * The cohort's `start_date` is the absolute UTC instant of the first
 * weekly session. Subsequent sessions happen at the SAME Chicago wall
 * clock one calendar week later — a "Tuesday at 6 PM" cohort stays at
 * Tuesday 6 PM Chicago across DST boundaries, even when 7×24h UTC
 * would put it at 5 PM or 7 PM Chicago after a spring-forward /
 * fall-back. This matches a real customer expectation ("class meets
 * Tuesdays at 6 PM") that pure UTC offset math silently breaks twice
 * a year.
 *
 * Mechanism: extract Chicago wall parts of the start instant, add
 * `k × 7` calendar days to the date, recompose via the DST-aware
 * `chicagoWallTimeToUtc` (Day-10's fixed-point iteration). Week 0 is
 * the start instant exactly; week k (k ≥ 1) is the recomputed UTC.
 *
 * Distinct from `computeDayProgramScheduledAt` (day-school/day-care), which
 * starts a date at the campus's `day.dropoff_open_time` — cohort scheduling
 * has no such setting, the cohort row owns its time.
 *
 * Throws if `weeks < 1` (the schema guarantees `weeks > 0`; this is a
 * defense-in-depth assertion against a corrupted cohort row).
 */
export function computeCohortSessionDates(startInstant: Date, weeks: number): Date[] {
  if (weeks < 1) {
    throw new Error(`computeCohortSessionDates: weeks must be >= 1, got ${weeks}`);
  }
  const { date, hour, minute } = chicagoWallPartsAt(startInstant);
  const sessions: Date[] = [];
  for (let k = 0; k < weeks; k += 1) {
    if (k === 0) {
      // Week 0 IS the start instant — no recomputation needed. Avoids a
      // round-trip through wall-time conversion that should be a no-op
      // but isn't guaranteed to round-trip identically for edge wall
      // times (e.g., the spring-forward gap, where the start instant's
      // wall extraction may not invert back to the same UTC).
      sessions.push(new Date(startInstant.getTime()));
      continue;
    }
    sessions.push(chicagoWallTimeToUtc(addCalendarDays(date, k * 7), hour, minute));
  }
  return sessions;
}
