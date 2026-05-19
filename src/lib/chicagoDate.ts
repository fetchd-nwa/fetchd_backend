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
 * Library choice tradeoff: `date-fns-tz` (or `@date-fns/tz`) would also
 * work. Intl wins for this one use case (UTC instant → YYYY-MM-DD in zone
 * X) because the surface is small and the conversion is exactly what
 * Intl.DateTimeFormat is designed for. When a future day needs Chicago-
 * wall-clock → UTC math (the 8am/5pm day-program window construction, or
 * "what UTC instant is the 24h-before-dropoff boundary"), promote to a
 * library then, driven by that real use case rather than pre-emptively.
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
