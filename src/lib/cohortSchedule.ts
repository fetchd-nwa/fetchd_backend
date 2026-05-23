import { chicagoWallPartsAt, chicagoWallTimeToUtc } from './chicagoDate.js';

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
 * Distinct from `computeDayProgramScheduledAt` (day-school/day-care)
 * which takes a `dropoff_time` and bucketed date — cohort scheduling
 * doesn't ask for a drop-off time, the cohort row owns it.
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
    sessions.push(chicagoWallTimeToUtc(addDays(date, k * 7), hour, minute));
  }
  return sessions;
}

/**
 * Add `days` calendar days to a YYYY-MM-DD string. UTC arithmetic is
 * timezone-safe because we're treating the input as a calendar label,
 * not an instant — Date.UTC's overflow handling rolls month boundaries
 * correctly (2026-02-28 + 2 → 2026-03-02).
 */
function addDays(yyyymmdd: string, days: number): string {
  const parts = yyyymmdd.split('-').map(Number);
  const [y, m, d] = parts;
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`addDays: invalid date string ${yyyymmdd}`);
  }
  const ms = Date.UTC(y, m - 1, d + days);
  const out = new Date(ms);
  return `${out.getUTCFullYear()}-${String(out.getUTCMonth() + 1).padStart(2, '0')}-${String(out.getUTCDate()).padStart(2, '0')}`;
}
