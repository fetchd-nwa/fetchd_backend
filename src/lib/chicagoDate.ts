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
 * Implementation: ask "what would this wall clock be in UTC under the
 * pre-transition offset?" and "...under the post-transition offset?".
 * Most days both answers agree (one stable offset all day) and either
 * works. On the two DST-transition days the answers DIFFER:
 *
 *   - **Spring-forward** (e.g., 2026-03-08, 02:00 CST → 03:00 CDT). A
 *     wall time inside the 02:00-03:00 gap doesn't exist. The two
 *     guesses straddle the gap and we pick the LATER UTC, which
 *     interprets as the post-transition wall time (e.g., 02:30 → 03:30
 *     CDT). This matches the IANA / Java / Python `fold=0` convention:
 *     skip the gap forward rather than throw.
 *
 *   - **Fall-back** (e.g., 2026-11-01, 02:00 CDT → 01:00 CST). The
 *     01:00-02:00 wall hour happens TWICE. Both guesses converge on the
 *     first occurrence (CDT, the earlier UTC instant), again matching
 *     the IANA / Java / Python first-occurrence convention.
 *
 * Day-program windows (07:30, 09:00, 16:30, 17:30) are hours clear of
 * the 2am transition and never hit either edge in practice — but the
 * math is correct regardless, and the edge-case behavior is tested.
 */
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
  // Two probes: apply the offset Chicago has at the naive UTC guess (the
  // "pre-transition" probe), then apply the offset at the result (the
  // "post-transition" probe). On a normal day both probes land on the
  // same instant. On a DST day they straddle the transition; `Math.max`
  // resolves both the spring-forward gap (return post-transition) and
  // the fall-back overlap (both probes equal the first occurrence) per
  // the IANA convention documented above.
  const probe1Offset = chicagoOffsetMinutesAt(new Date(wallUtcMs));
  const probe1Utc = wallUtcMs - probe1Offset * 60_000;
  const probe2Offset = chicagoOffsetMinutesAt(new Date(probe1Utc));
  const probe2Utc = wallUtcMs - probe2Offset * 60_000;
  return new Date(Math.max(probe1Utc, probe2Utc));
}
