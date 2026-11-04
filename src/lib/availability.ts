import type { DayCapacityWire, LocationKey } from '../contracts/wire.js';

/**
 * The day-program capacity rule and the range iteration behind
 * `GET /availability`. One cap per (location, date), shared by day school and
 * daycare (DAY-U05, DAY-10): the campus's settings give an open weekday its seats,
 * any other date gets none, and a live `day_capacity` row overrides either
 * (DAY-11).
 *
 * The rule lives here and nowhere else. `dayCapacityFor` is called by the read
 * (`routes/availability.ts`), by the write's authority
 * (`dayCapacityRepository.assertCapacityWithinLock`) and by the cap-lowering check
 * (`lib/capLowering.ts`), so the three cannot disagree about a date.
 */

const ONE_DAY_MS = 86_400_000;
const ISO_SUNDAY = 7;

/**
 * The most dates `/availability` returns in one response. It follows
 * `day.booking_horizon_months`: a window from today through the horizon's last
 * date must always fit, and three calendar months hold up to 93 inclusive dates,
 * so a month is reckoned at 31 days, plus one for the inclusive end. Larger windows
 * fail with 422 `invalid_payload`, which bounds the query and the response.
 */
export function availabilityMaxDates(horizonMonths: number): number {
  return horizonMonths * 31 + 1;
}

/** The two campus settings the rule reads (`DayProgramCampusSettingsWire`). */
export interface DayCapacityRule {
  daily_capacity_dogs: number;
  /** ISO weekdays: 1 = Monday, 7 = Sunday. */
  open_weekdays_list: readonly number[];
}

/**
 * The ISO weekday of a YYYY-MM-DD label, 1 = Monday to 7 = Sunday.
 * `open_weekdays_list` is ISO and `getUTCDay()` is not: its Sunday is 0. A label
 * is timezone-independent for this (Tuesday is Tuesday everywhere), so
 * `Date.UTC(...)` reads it with no DST math.
 */
export function isoWeekday(dateStr: string): number {
  const day = new Date(parseDateUtcMs(dateStr)).getUTCDay();
  return day === 0 ? ISO_SUNDAY : day;
}

/**
 * The seats on a date: a live override wins, else an open weekday gets the daily
 * cap, else 0. Pass `undefined` for the rule alone, which is what the cap-lowering
 * check compares. Pure.
 */
export function dayCapacityFor(
  dateStr: string,
  rule: DayCapacityRule,
  override: { capacity_dogs: number } | undefined,
): number {
  if (override !== undefined) return override.capacity_dogs;
  return rule.open_weekdays_list.includes(isoWeekday(dateStr)) ? rule.daily_capacity_dogs : 0;
}

/**
 * One date on the wire. `remaining_dogs` is floored at 0: a date can still be
 * over-full, when an imported booking arrives over its cap or a cap falls past the
 * horizon, and the booking transaction never rejects an existing booking to make
 * the numbers line up. The 422's `openings_remaining` floors the same way.
 */
export function dayCapacityWire(
  location: LocationKey,
  date: string,
  capacity: number,
  booked: number,
): DayCapacityWire {
  return {
    location,
    date,
    capacity_dogs: capacity,
    remaining_dogs: Math.max(0, capacity - booked),
  };
}

/** Every YYYY-MM-DD from `from` through `to`, ascending. UTC-only, as below. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let t = parseDateUtcMs(from); t <= parseDateUtcMs(to); t += ONE_DAY_MS) {
    dates.push(formatUtcMsAsDate(t));
  }
  return dates;
}

/**
 * Result type for the validated range expansion. Pushes both error cases
 * (`from > to`, range exceeds the cap) up to the route as data, never as
 * exceptions — the route maps each `ok: false` branch to the right
 * ApiError code without try/catch.
 */
export type EnumerateRangeResult =
  | { ok: true; dates: string[] }
  | { ok: false; reason: 'reversed'; from: string; to: string }
  | { ok: false; reason: 'over_cap'; count: number; limit: number };

/**
 * Validated calendar-date expansion: every YYYY-MM-DD between `from` and
 * `to` inclusive, capped at `limit`. Pure — no I/O, no throwing for expected
 * error cases (Result-typed instead). The route pattern matches on the Result
 * and emits the right HTTP error.
 *
 * UTC-only arithmetic: 86_400_000 ms increments are safe (UTC has no
 * DST), so iterating from `Date.UTC(y, m-1, d)` cannot drift across a
 * spring-forward / fall-back boundary. YYYY-MM-DD is a timezone-
 * independent date label.
 */
export function enumerateRangeWithCap(
  from: string,
  to: string,
  limit: number,
): EnumerateRangeResult {
  const start = parseDateUtcMs(from);
  const end = parseDateUtcMs(to);
  if (end < start) {
    return { ok: false, reason: 'reversed', from, to };
  }
  const dates: string[] = [];
  for (let t = start; t <= end; t += ONE_DAY_MS) {
    dates.push(formatUtcMsAsDate(t));
    if (dates.length > limit) {
      // Bail as soon as the cap is exceeded — a malicious 100-year window
      // shouldn't materialize 36_525 strings to find out it's too big.
      // Continue the loop one more iter to report the actual size? No —
      // the count we return is "at least cap+1", which is enough for the
      // error message; the route doesn't need the exact count.
      return { ok: false, reason: 'over_cap', count: dates.length, limit };
    }
  }
  return { ok: true, dates };
}

function parseDateUtcMs(dateStr: string): number {
  const parts = dateStr.split('-');
  if (parts.length !== 3) {
    throw new Error(`invalid YYYY-MM-DD date: ${dateStr}`);
  }
  const [y, m, d] = parts.map(Number);
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d)
  ) {
    throw new Error(`invalid YYYY-MM-DD date: ${dateStr}`);
  }
  return Date.UTC(y, m - 1, d);
}

function formatUtcMsAsDate(t: number): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
