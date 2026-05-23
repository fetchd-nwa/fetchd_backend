/**
 * America/Chicago calendar-date bucketing — the canonical business-day
 * primitive (`schema.sql` BUSINESS TIMEZONE block, ~lines 55-59). All
 * business-day math in the API routes through this: `day_capacity` row keys,
 * today/tomorrow bucketing, the 24h-before-dropoff reminder. NEVER derive a
 * calendar day straight from a UTC timestamp — that was the mock layer's
 * off-by-one bug class.
 *
 * Mirrors the DB-side `(now() AT TIME ZONE 'America/Chicago')::date` that
 * `assert_vaccines_current` (schema.sql ~line 1181) and the day-program
 * window logic use server-side. Same time zone, same calendar-day semantics
 * — kept in sync by both being literal "America/Chicago" identifiers
 * resolved against the system TZ database (IANA tzdata, which Node ships
 * via ICU).
 *
 * Implementation: Node's `Intl.DateTimeFormat` with a fixed `en-CA` locale
 * (always YYYY-MM-DD) + `timeZone: 'America/Chicago'`. Zero dependencies;
 * DST is handled by Intl. The mock's "subtract 6 hours" pattern would
 * silently break on every spring-forward (March) and fall-back (November)
 * — Intl asks tzdata what offset applies at this instant and gets it right.
 *
 * Day 5a extends with the inverse: a Chicago wall clock → UTC instant
 * (`chicagoWallTimeToUtc`). The day-program bucketing needs "17:30 in
 * Chicago on calendar date X" as an absolute instant to compare against
 * `now()`. Same Intl-tzdata backbone — no library dep, no DST land mines.
 */
const CHICAGO_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Convert a UTC instant to the calendar date (YYYY-MM-DD) it falls on in
 * America/Chicago. Accepts a `Date`, an ISO-8601 string, or a Unix epoch
 * milliseconds number — anything `new Date(...)` accepts unambiguously.
 *
 * Examples (UTC-6 in winter / UTC-5 during CDT):
 *   bucketToChicagoDate(new Date('2025-06-15T04:00:00Z')) → '2025-06-14'
 *     (4am UTC = 11pm previous day in Chicago CDT)
 *   bucketToChicagoDate(new Date('2025-03-09T08:30:00Z')) → '2025-03-09'
 *     (after spring-forward; the missing 2am→3am hour doesn't change the date)
 *   bucketToChicagoDate(new Date('2025-11-02T07:30:00Z')) → '2025-11-02'
 *     (after fall-back; the duplicated 1am hour doesn't change the date)
 */
export function bucketToChicagoDate(instant: Date | string | number): string {
  const ts = instant instanceof Date ? instant : new Date(instant);
  return CHICAGO_DATE_FORMATTER.format(ts);
}

/**
 * Today's Chicago calendar date (YYYY-MM-DD). Convenience wrapper over
 * `bucketToChicagoDate(now)` — the route can pass its `nowFactory()`
 * directly and stay timezone-correct without spelling out the bucket
 * step. Day-5b consumers: `/rates` (effective-window lookup); future
 * consumers: `/availability` default-date hints, scheduler boundaries.
 *
 *   const today = bucketChicagoToday(nowFactory());  // route DI pattern
 *   const today = bucketChicagoToday();              // production default
 */
export function bucketChicagoToday(now: Date = new Date()): string {
  return CHICAGO_DATE_FORMATTER.format(now);
}

/**
 * The wall-clock formatter we use to read back an instant in Chicago time.
 * `hourCycle: 'h23'` pins the hour to 0..23 (midnight = 00, not 24) so the
 * round-trip arithmetic in `chicagoOffsetMinutesAt` is unambiguous.
 */
const CHICAGO_WALL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Read back a UTC instant as Chicago wall parts (calendar date + hour +
 * minute). The companion to `chicagoWallTimeToUtc` — round-trippable for
 * the wall times the API constructs:
 *
 *   const start = chicagoWallTimeToUtc('2026-06-02', 18, 0);
 *   chicagoWallPartsAt(start)
 *     → { date: '2026-06-02', hour: 18, minute: 0 }
 *
 * Day-11 cohort cadence: read the cohort's `start_date` (timestamptz) as
 * Chicago wall parts, advance the calendar date by N×7 days, then convert
 * back via `chicagoWallTimeToUtc` so each weekly session lands at the
 * same wall clock even across DST boundaries. A class that meets "every
 * Tuesday at 6 PM" stays at 6 PM after spring-forward / fall-back.
 *
 * Seconds are intentionally not exposed — every wall clock the API
 * stamps is to the minute. If a future caller needs second resolution
 * we extend the return type then.
 */
export function chicagoWallPartsAt(instant: Date): {
  date: string;
  hour: number;
  minute: number;
} {
  const parts = CHICAGO_WALL_FORMATTER.formatToParts(instant);
  const get = (t: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === t);
    if (part === undefined) {
      throw new Error(`chicagoWallPartsAt: missing ${t} part`);
    }
    return Number(part.value);
  };
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { date, hour: get('hour'), minute: get('minute') };
}

/**
 * Offset between Chicago wall clock and UTC at a given instant, in minutes.
 * Negative for Chicago (Chicago is behind UTC): -360 in CST (winter),
 * -300 in CDT (summer). Returned as a signed integer.
 *
 * Trick: format the instant in Chicago to get its wall clock, then
 * reinterpret that wall clock AS IF it were UTC. The difference between
 * the reinterpreted value and the original UTC instant IS the offset.
 */
function chicagoOffsetMinutesAt(instant: Date): number {
  const parts = CHICAGO_WALL_FORMATTER.formatToParts(instant);
  const get = (t: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === t);
    if (part === undefined) {
      throw new Error(`chicagoOffsetMinutesAt: missing ${t} part`);
    }
    return Number(part.value);
  };
  const wallAsUtcMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((wallAsUtcMs - instant.getTime()) / 60_000);
}

/**
 * Convert a Chicago wall clock (date + hour + minute) to the UTC instant
 * it represents. The inverse of `bucketToChicagoDate` for the small set of
 * named "wall clock moments" the API cares about (day-program window
 * open/close, the 8am/5pm legacy boundary).
 *
 *   chicagoWallTimeToUtc('2026-06-15', 17, 30)
 *     → 2026-06-15T22:30:00.000Z  (CDT, UTC-5)
 *   chicagoWallTimeToUtc('2026-01-15', 17, 30)
 *     → 2026-01-15T23:30:00.000Z  (CST, UTC-6)
 *
 * Implementation: fixed-point iteration over the offset Chicago has at
 * the candidate UTC instant. Initial guess = offset at the naive
 * (treat-wall-as-UTC) instant; iterate offset_n+1 = chicagoOffset(wall −
 * offset_n) until offset converges. Most days converge in one iteration;
 * spring-forward "well past the gap" wall times (e.g., 07:30 on
 * 2026-03-08, which sits in the bad window where the naive UTC
 * interpretation falls pre-jump but the wall clock interpretation falls
 * post-jump) converge in two iterations.
 *
 * Two DST edge cases:
 *
 *   - **Spring-forward gap** (e.g., 2026-03-08, 02:00 CST → 03:00 CDT,
 *     the 02:00-03:00 wall hour does not exist). The iteration oscillates
 *     between the pre-transition and post-transition probes; we break out
 *     after a bounded number of iterations and return the LATER UTC,
 *     interpreting the missing wall time as the post-transition wall
 *     (02:30 → 03:30 CDT = 08:30 UTC). Matches IANA / Java / Python
 *     `fold=0` "skip the gap forward."
 *
 *   - **Fall-back overlap** (e.g., 2026-11-01, 02:00 CDT → 01:00 CST, the
 *     01:00-02:00 wall hour happens twice). The initial probe seeds with
 *     the offset at the naive UTC, which falls in CDT (pre-jump in UTC
 *     terms); iteration converges to the FIRST occurrence (CDT, the
 *     earlier UTC instant), matching the IANA / Java / Python
 *     first-occurrence convention. A future caller that needs the second
 *     occurrence would need an explicit fold parameter — out of scope.
 *
 * Day-10 sensitivity (locked Day 10, 2026-05-22): the day-program
 * drop-off window (07:30-09:00) is HOURS clear of the 02:00 wall
 * transition but NOT clear of the 07:00-08:00 UTC transition window —
 * a fixed two-probe heuristic returns the wrong UTC for the 07:30-07:59
 * slice of the window on spring-forward day. The iterative form
 * converges to the correct UTC for every wall time the API constructs;
 * unit tests exercise every drop-off window endpoint on spring-forward,
 * fall-back, and stable days.
 */
const CHICAGO_MAX_OFFSET_ITERS = 3;

export function chicagoWallTimeToUtc(dateStr: string, hour: number, minute: number): Date {
  const parts = dateStr.split('-');
  if (parts.length !== 3) {
    throw new Error(`chicagoWallTimeToUtc: invalid date string ${dateStr}`);
  }
  const [y, m, d] = parts.map(Number);
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d)
  ) {
    throw new Error(`chicagoWallTimeToUtc: invalid date string ${dateStr}`);
  }
  const wallUtcMs = Date.UTC(y, m - 1, d, hour, minute);
  // Seed offset = Chicago's offset at the naive UTC instant (treating wall
  // as UTC). For non-DST days, the first iteration converges. For
  // post-transition spring-forward wall times in the bad window
  // (~03:00-07:59 wall), seed offset is the PRE-jump value; one iteration
  // crosses the transition and converges.
  let offset = chicagoOffsetMinutesAt(new Date(wallUtcMs));
  let guessUtcMs = wallUtcMs - offset * 60_000;
  let lastGuessUtcMs = wallUtcMs; // sentinel — not yet a valid candidate
  for (let i = 0; i < CHICAGO_MAX_OFFSET_ITERS; i += 1) {
    const actualOffset = chicagoOffsetMinutesAt(new Date(guessUtcMs));
    if (actualOffset === offset) return new Date(guessUtcMs);
    offset = actualOffset;
    lastGuessUtcMs = guessUtcMs;
    guessUtcMs = wallUtcMs - offset * 60_000;
  }
  // Oscillating — this is the spring-forward gap case where the wall
  // time doesn't exist. The two attempted guesses straddle the
  // transition; pick the LATER UTC per IANA fold=0 (skip the gap
  // forward into the post-transition wall).
  return new Date(Math.max(guessUtcMs, lastGuessUtcMs));
}
