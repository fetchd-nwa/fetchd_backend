/**
 * Drizzle pg with `mode: 'string'` returns timestamptz in PG's default ISO
 * DateStyle: `'YYYY-MM-DD HH:MM:SS[.uuu]+TZ'` — space-separated date/time
 * and a single-pair `+TZ` (no colon, e.g. `+00`). Normalize it to real ISO
 * 8601 — space → 'T', offset padded to `+HH:MM` — so it round-trips through
 * `Date` for both the on-wire emit (`pgTimestampToIso`) and arithmetic
 * (`pgTimestampToDate` — Day 5 bucketing math).
 *
 * **Corrected 2026-08-12.** This used to claim "V8's `Date` parser rejects
 * both", which is false and was probably never true in this project's Node
 * range: `new Date('2026-03-02 12:00:00+00')` parses fine on Node 22 (V8
 * accepts a space separator and a two-digit offset as a legacy/implementation-
 * defined format). What is true is that the parse is NOT the ISO-8601 path the
 * spec pins — it is the implementation-defined fallback every engine is free to
 * define differently, and which has changed across engines before. So this
 * helper is a spec-conformance guarantee rather than a bug fix, and every
 * timestamptz read still routes through it: a bare `new Date(pgString)`
 * scattered through the workers is a portability bet nobody chose to make, and
 * a doc comment that mis-states WHY a helper exists is the same class of
 * instrument failure as a broken check.
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
