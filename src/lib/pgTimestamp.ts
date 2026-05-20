/**
 * Drizzle pg with `mode: 'string'` returns timestamptz in PG's default ISO
 * DateStyle: `'YYYY-MM-DD HH:MM:SS[.uuu]+TZ'` — space-separated date/time
 * and a single-pair `+TZ` (no colon, e.g. `+00`). V8's `Date` parser rejects
 * both. Rewrite the space → 'T' and pad the offset to `+HH:MM` so we can
 * round-trip through `Date` for both the on-wire ISO-8601 emit (`pgTimestampToIso`)
 * and arithmetic (`pgTimestampToDate` — Day 5 bucketing math).
 *
 * Day 4b extracted the inline helper at rule-of-two (dog.evaluation_date +
 * agreement.signed_at). Day 5a split it again: the booking bucket needs a
 * `Date` for arithmetic, not an ISO string — re-parsing the result of
 * `.toISOString()` is wasted work on a per-row hot path with 6+ timestamp
 * columns per booking. One parse, two consumers.
 *
 * Already-`Z` or `+HH:MM` strings pass untouched.
 */
function pgTimestampToParsed(pgString: string): Date {
  const withT = pgString.replace(' ', 'T');
  const withTz = withT.replace(/([+-]\d{2})$/, '$1:00');
  return new Date(withTz);
}

export function pgTimestampToDate(pgString: string): Date {
  return pgTimestampToParsed(pgString);
}

export function pgTimestampToIso(pgString: string): string {
  return pgTimestampToParsed(pgString).toISOString();
}
