/**
 * Drizzle pg with `mode: 'string'` returns timestamptz in PG's default ISO
 * DateStyle: `'YYYY-MM-DD HH:MM:SS[.uuu]+TZ'` — space-separated date/time
 * and a single-pair `+TZ` (no colon, e.g. `+00`). V8's `Date` parser rejects
 * both. Rewrite the space → 'T' and pad the offset to `+HH:MM` so we can
 * round-trip through `Date.toISOString()` for the on-wire ISO-8601 emit
 * (per DATA-CONTRACT R5). Already-`Z` or `+HH:MM` strings pass untouched.
 *
 * Extracted Day-4b at the rule-of-two (dogs.evaluation_date +
 * agreements.signed_at); was previously inline in `routes/dogs.ts`.
 */
export function pgTimestampToIso(pgString: string): string {
  const withT = pgString.replace(' ', 'T');
  const withTz = withT.replace(/([+-]\d{2})$/, '$1:00');
  return new Date(withTz).toISOString();
}
