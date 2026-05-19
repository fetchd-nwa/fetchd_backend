import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketToChicagoDate } from '../src/lib/chicagoDate.js';

// Day 3b Exit check #4: `bucketToChicagoDate` returns the right calendar
// day across America/Chicago's two DST boundaries. Spring-forward removes
// an hour at 2am → 3am; fall-back duplicates 1am → 2am. Both edges matter
// independently — silently doing "subtract 6 hours" math would break on
// the days CDT (UTC-5) applies, and "subtract 5 hours" would break on the
// days CST (UTC-6) applies. Intl's tzdata-backed conversion handles both.

test('bucketToChicagoDate handles spring-forward (2025-03-09, CST→CDT at 2am Chicago)', () => {
  // 07:30 UTC = 01:30 CST (still in the missing-hour pre-jump window).
  assert.equal(bucketToChicagoDate(new Date('2025-03-09T07:30:00Z')), '2025-03-09');
  // 08:30 UTC = 03:30 CDT (post-jump). Calendar date unchanged.
  assert.equal(bucketToChicagoDate(new Date('2025-03-09T08:30:00Z')), '2025-03-09');
  // 04:00 UTC = 22:00 CST on March 8 — calendar day in Chicago is the PRIOR day.
  // A naive UTC-day reader would say "March 9"; Chicago bucketing says "March 8".
  // This is the off-by-one bug class the schema's BUSINESS TIMEZONE rule prevents.
  assert.equal(bucketToChicagoDate(new Date('2025-03-09T04:00:00Z')), '2025-03-08');
  // 06:00 UTC = 00:00 CST on March 9 — midnight has just struck in Chicago.
  assert.equal(bucketToChicagoDate(new Date('2025-03-09T06:00:00Z')), '2025-03-09');
});

test('bucketToChicagoDate handles fall-back (2025-11-02, CDT→CST at 2am Chicago)', () => {
  // 06:30 UTC = 01:30 CDT (first occurrence of 1:30am, before the fall-back).
  assert.equal(bucketToChicagoDate(new Date('2025-11-02T06:30:00Z')), '2025-11-02');
  // 07:30 UTC = 01:30 CST (second occurrence, after fall-back). Same calendar day.
  assert.equal(bucketToChicagoDate(new Date('2025-11-02T07:30:00Z')), '2025-11-02');
  // 04:00 UTC = 23:00 CDT on November 1 — still on Nov 1 in Chicago.
  assert.equal(bucketToChicagoDate(new Date('2025-11-02T04:00:00Z')), '2025-11-01');
  // 05:00 UTC = 00:00 CDT on November 2 — just struck midnight in Chicago.
  assert.equal(bucketToChicagoDate(new Date('2025-11-02T05:00:00Z')), '2025-11-02');
});

test('bucketToChicagoDate: a UTC instant that crosses midnight in UTC but not in Chicago', () => {
  // 04:00 UTC on June 15 (CDT, UTC-5) = 23:00 on June 14 in Chicago.
  // A read off raw UTC would call this "June 15" — the off-by-one the mock had.
  assert.equal(bucketToChicagoDate(new Date('2025-06-15T04:00:00Z')), '2025-06-14');
  // 05:00 UTC on June 15 = 00:00 on June 15 in Chicago. Boundary just crossed.
  assert.equal(bucketToChicagoDate(new Date('2025-06-15T05:00:00Z')), '2025-06-15');
});

test('bucketToChicagoDate accepts Date, ISO string, and epoch-ms inputs', () => {
  const expected = '2025-06-14';
  const isoString = '2025-06-15T04:00:00Z';
  const epochMs = new Date(isoString).getTime();
  const dateObj = new Date(isoString);

  assert.equal(bucketToChicagoDate(isoString), expected);
  assert.equal(bucketToChicagoDate(epochMs), expected);
  assert.equal(bucketToChicagoDate(dateObj), expected);
});

test('bucketToChicagoDate output is strictly YYYY-MM-DD (matches Postgres `date` column shape)', () => {
  const result = bucketToChicagoDate(new Date('2025-01-05T15:00:00Z'));
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result, '2025-01-05');
});
