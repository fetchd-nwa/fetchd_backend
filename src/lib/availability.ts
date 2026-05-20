/**
 * Per-location day-program capacity rule + range iteration for
 * `GET /availability`. The "default rule" fires when no `day_capacity`
 * override row exists for a given (location, date): weekend (Sat/Sun) =
 * closed, weekday = 3/3 school + daycare. Locked schema.sql:589-594 ("the
 * Node API applies the business rule (weekend = closed; otherwise
 * DEFAULT_OPENINGS = 3) per location over the top of any override here").
 *
 * Wire shape (DATA-CONTRACT §B DayCapacity, Δ 2026-05-20): `mode` query
 * param doesn't filter — both `school_openings` and `daycare_openings`
 * always emit. The schema stores them as two columns; whether NWA treats
 * them as one shared physical pool is a Day-10 booking-txn writer
 * concern, not a read-side concern.
 */

const DEFAULT_WEEKDAY_OPENINGS = 3;
const SATURDAY = 6;
const SUNDAY = 0;
const ONE_DAY_MS = 86_400_000;

/**
 * Maximum number of dates `/availability` will return in one response.
 * Caps the query and the response size at ~3 months of lookahead — the
 * FE supports booking up to 3 months in advance (Allison's Day-5b lock,
 * 2026-05-20). Larger windows fail with 400 `invalid_payload`.
 */
export const AVAILABILITY_MAX_DATES = 92;

export interface DayCapacityDefaults {
  school_openings: number;
  daycare_openings: number;
}

/**
 * Default capacity for a calendar date in the absence of an override.
 * A YYYY-MM-DD label is timezone-independent for day-of-week purposes
 * (Tuesday is Tuesday everywhere), so `Date.UTC(...)` constructs the
 * instant unambiguously — no DST math, no local-time risk.
 */
export function defaultDayCapacity(dateStr: string): DayCapacityDefaults {
  const dow = dayOfWeek(dateStr);
  if (dow === SATURDAY || dow === SUNDAY) {
    return { school_openings: 0, daycare_openings: 0 };
  }
  return {
    school_openings: DEFAULT_WEEKDAY_OPENINGS,
    daycare_openings: DEFAULT_WEEKDAY_OPENINGS,
  };
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
 * `to` inclusive, capped at `AVAILABILITY_MAX_DATES`. Pure — no I/O, no
 * throwing for expected error cases (Result-typed instead). The route
 * pattern matches on the Result and emits the right HTTP error.
 *
 * UTC-only arithmetic: 86_400_000 ms increments are safe (UTC has no
 * DST), so iterating from `Date.UTC(y, m-1, d)` cannot drift across a
 * spring-forward / fall-back boundary. YYYY-MM-DD is a timezone-
 * independent date label; `getUTCDay()` reads the weekday invariantly.
 */
export function enumerateRangeWithCap(from: string, to: string): EnumerateRangeResult {
  const start = parseDateUtcMs(from);
  const end = parseDateUtcMs(to);
  if (end < start) {
    return { ok: false, reason: 'reversed', from, to };
  }
  const dates: string[] = [];
  for (let t = start; t <= end; t += ONE_DAY_MS) {
    dates.push(formatUtcMsAsDate(t));
    if (dates.length > AVAILABILITY_MAX_DATES) {
      // Bail as soon as the cap is exceeded — a malicious 100-year window
      // shouldn't materialize 36_525 strings to find out it's too big.
      // Continue the loop one more iter to report the actual size? No —
      // the count we return is "at least cap+1", which is enough for the
      // error message; the route doesn't need the exact count.
      return { ok: false, reason: 'over_cap', count: dates.length, limit: AVAILABILITY_MAX_DATES };
    }
  }
  return { ok: true, dates };
}

function dayOfWeek(dateStr: string): number {
  return new Date(parseDateUtcMs(dateStr)).getUTCDay();
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
