import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AVAILABILITY_MAX_DATES,
  defaultDayCapacity,
  enumerateRangeWithCap,
} from '../src/lib/availability.js';

/**
 * Unit tests for `lib/availability.ts`. The contract tests in
 * `test/contracts/availability.test.ts` exercise these end-to-end via the
 * 7-day May 2026 window, but locality is poor — a flipped weekday/weekend
 * classification or an off-by-one date iteration would only surface as a
 * snapshot mismatch. These pin the math directly.
 */

test('defaultDayCapacity: weekday → 3/3, weekend → 0/0 across a full week', () => {
  // Use 2026-05-18 (Mon) through 2026-05-24 (Sun) — all in a single week,
  // no DST transition, no month boundary.
  const cases: Array<{ date: string; expected: { school: number; daycare: number } }> = [
    { date: '2026-05-18', expected: { school: 3, daycare: 3 } }, // Mon
    { date: '2026-05-19', expected: { school: 3, daycare: 3 } }, // Tue
    { date: '2026-05-20', expected: { school: 3, daycare: 3 } }, // Wed
    { date: '2026-05-21', expected: { school: 3, daycare: 3 } }, // Thu
    { date: '2026-05-22', expected: { school: 3, daycare: 3 } }, // Fri
    { date: '2026-05-23', expected: { school: 0, daycare: 0 } }, // Sat
    { date: '2026-05-24', expected: { school: 0, daycare: 0 } }, // Sun
  ];
  for (const { date, expected } of cases) {
    const result = defaultDayCapacity(date);
    assert.deepStrictEqual(
      result,
      { school_openings: expected.school, daycare_openings: expected.daycare },
      `${date}: got ${JSON.stringify(result)}`,
    );
  }
});

test('defaultDayCapacity is timezone-invariant — a date label is the same day everywhere', () => {
  // The classification is determined by the literal date string, not by
  // any interpretation of "what does this date mean in Chicago." Sunday is
  // Sunday everywhere; the timezone of execution does not affect output.
  assert.deepStrictEqual(defaultDayCapacity('2026-05-24'), {
    school_openings: 0,
    daycare_openings: 0,
  });
});

test('defaultDayCapacity: malformed date throws', () => {
  assert.throws(() => defaultDayCapacity('not-a-date'), /invalid YYYY-MM-DD/);
  assert.throws(() => defaultDayCapacity('2026-05'), /invalid YYYY-MM-DD/);
  assert.throws(() => defaultDayCapacity(''), /invalid YYYY-MM-DD/);
});

test('enumerateRangeWithCap: single-day range returns the same date', () => {
  const result = enumerateRangeWithCap('2026-05-19', '2026-05-19');
  assert.deepStrictEqual(result, { ok: true, dates: ['2026-05-19'] });
});

test('enumerateRangeWithCap: 7-day inclusive range', () => {
  const result = enumerateRangeWithCap('2026-05-15', '2026-05-21');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.dates, [
      '2026-05-15',
      '2026-05-16',
      '2026-05-17',
      '2026-05-18',
      '2026-05-19',
      '2026-05-20',
      '2026-05-21',
    ]);
  }
});

test('enumerateRangeWithCap: leap-year spans Feb 28 → Feb 29 → Mar 1 (2028)', () => {
  // 2028 IS a leap year (divisible by 4 and not by 100). Without UTC-
  // safe arithmetic this would silently misclassify Feb 29.
  const result = enumerateRangeWithCap('2028-02-27', '2028-03-02');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.dates, [
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
      '2028-03-02',
    ]);
  }
});

test('enumerateRangeWithCap: year-boundary Dec 31 → Jan 1', () => {
  const result = enumerateRangeWithCap('2026-12-30', '2027-01-02');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.dates, ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  }
});

test('enumerateRangeWithCap: 92-cap exact boundary (92 dates ok, 93 over)', () => {
  // The cap is AVAILABILITY_MAX_DATES = 92. Range from..to inclusive,
  // so `(to - from) days + 1` dates emit. 91 days difference = 92 dates.
  assert.equal(AVAILABILITY_MAX_DATES, 92);

  // Exactly at the cap: 2026-05-01 to 2026-07-31 = 92 dates inclusive.
  // (May has 31, June has 30, July has 31; from May 1 to July 31 = 31+30+31 = 92.)
  const atCap = enumerateRangeWithCap('2026-05-01', '2026-07-31');
  assert.equal(atCap.ok, true);
  if (atCap.ok) {
    assert.equal(atCap.dates.length, 92);
    assert.equal(atCap.dates[0], '2026-05-01');
    assert.equal(atCap.dates[91], '2026-07-31');
  }

  // One over: add one day → 93 dates → over_cap.
  const overCap = enumerateRangeWithCap('2026-05-01', '2026-08-01');
  assert.deepStrictEqual(overCap, {
    ok: false,
    reason: 'over_cap',
    count: 93,
    limit: 92,
  });
});

test('enumerateRangeWithCap: reversed range (to < from) returns reversed result', () => {
  const result = enumerateRangeWithCap('2026-05-21', '2026-05-15');
  assert.deepStrictEqual(result, {
    ok: false,
    reason: 'reversed',
    from: '2026-05-21',
    to: '2026-05-15',
  });
});

test('enumerateRangeWithCap: malformed date in either bound throws', () => {
  assert.throws(() => enumerateRangeWithCap('not-a-date', '2026-05-21'), /invalid YYYY-MM-DD/);
  assert.throws(() => enumerateRangeWithCap('2026-05-15', '99/99/9999'), /invalid YYYY-MM-DD/);
});

test('enumerateRangeWithCap: pathological large range short-circuits', () => {
  // 100-year window — without the early-exit cap check, this would
  // materialize 36_525 strings before checking length. With the early
  // exit, it bails as soon as cap+1 is reached.
  const result = enumerateRangeWithCap('2000-01-01', '2100-01-01');
  assert.equal(result.ok, false);
  if (!result.ok && result.reason === 'over_cap') {
    assert.equal(result.limit, 92);
    assert.equal(result.count, 93); // bailed at exactly cap+1
  }
});
