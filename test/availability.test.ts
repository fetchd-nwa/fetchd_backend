import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  availabilityMaxDates,
  datesBetween,
  dayCapacityFor,
  dayCapacityWire,
  enumerateRangeWithCap,
  isoWeekday,
} from '../src/lib/availability.js';
import { lastBookableDate } from '../src/lib/bookingHorizon.js';

/**
 * Unit tests for `lib/availability.ts`. The contract tests in
 * `test/contracts/availability.test.ts` exercise these end-to-end via the
 * 7-day May 2026 window, but locality is poor — a flipped weekday classification
 * or an off-by-one date iteration would only surface as a snapshot mismatch.
 * These pin the math directly.
 */

const SEEDED = { daily_capacity_dogs: 15, open_weekdays_list: [1, 2, 3, 4, 5] };
const LIMIT = availabilityMaxDates(3);

test('dayCapacityFor: an open weekday gets the daily cap, any other date 0, across a full week', () => {
  // Use 2026-05-18 (Mon) through 2026-05-24 (Sun) — all in a single week,
  // no DST transition, no month boundary.
  const cases: Array<{ date: string; expected: number }> = [
    { date: '2026-05-18', expected: 15 }, // Mon
    { date: '2026-05-19', expected: 15 }, // Tue
    { date: '2026-05-20', expected: 15 }, // Wed
    { date: '2026-05-21', expected: 15 }, // Thu
    { date: '2026-05-22', expected: 15 }, // Fri
    { date: '2026-05-23', expected: 0 }, // Sat
    { date: '2026-05-24', expected: 0 }, // Sun
  ];
  for (const { date, expected } of cases) {
    assert.equal(dayCapacityFor(date, SEEDED, undefined), expected, date);
  }
});

test('dayCapacityFor: Sunday is ISO 7, never the 0 of getUTCDay', () => {
  assert.equal(isoWeekday('2026-05-24'), 7);
  assert.equal(isoWeekday('2026-05-18'), 1);
  const sundayOnly = { daily_capacity_dogs: 4, open_weekdays_list: [7] };
  assert.equal(dayCapacityFor('2026-05-24', sundayOnly, undefined), 4);
  assert.equal(dayCapacityFor('2026-05-18', sundayOnly, undefined), 0);
  // A 0 in the list opens nothing: the PATCH's bound is 1..7, and a stray one must
  // not read as Sunday.
  assert.equal(
    dayCapacityFor('2026-05-24', { daily_capacity_dogs: 4, open_weekdays_list: [0] }, undefined),
    0,
  );
});

test('dayCapacityFor: a live override wins over the rule, open or closed, and 0 closes', () => {
  assert.equal(dayCapacityFor('2026-05-23', SEEDED, { capacity_dogs: 4 }), 4, 'opens a Saturday');
  assert.equal(dayCapacityFor('2026-05-18', SEEDED, { capacity_dogs: 0 }), 0, 'closes a Monday');
  assert.equal(dayCapacityFor('2026-05-18', SEEDED, { capacity_dogs: 40 }), 40);
});

test('dayCapacityFor is timezone-invariant — a date label is the same day everywhere', () => {
  // The classification is determined by the literal date string, not by
  // any interpretation of "what does this date mean in Chicago." Sunday is
  // Sunday everywhere; the timezone of execution does not affect output.
  assert.equal(dayCapacityFor('2026-05-24', SEEDED, undefined), 0);
});

test('dayCapacityFor: a malformed date throws', () => {
  assert.throws(() => dayCapacityFor('not-a-date', SEEDED, undefined), /invalid YYYY-MM-DD/);
  assert.throws(() => dayCapacityFor('2026-05', SEEDED, undefined), /invalid YYYY-MM-DD/);
  assert.throws(() => dayCapacityFor('', SEEDED, undefined), /invalid YYYY-MM-DD/);
});

test('dayCapacityWire: remaining is the cap minus the booked, floored at 0', () => {
  assert.deepEqual(dayCapacityWire('bentonville', '2026-05-18', 15, 14), {
    location: 'bentonville',
    date: '2026-05-18',
    capacity_dogs: 15,
    remaining_dogs: 1,
  });
  assert.equal(dayCapacityWire('bentonville', '2026-05-18', 2, 3).remaining_dogs, 0);
});

test('availabilityMaxDates: months * 31 + 1', () => {
  assert.equal(availabilityMaxDates(3), 94);
  assert.equal(availabilityMaxDates(1), 32);
  assert.equal(availabilityMaxDates(12), 373);
});

test('availabilityMaxDates: today through the last bookable date always fits', () => {
  for (const months of [1, 2, 3, 6, 12, 24]) {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2034, 0, 1); t += 86_400_000) {
      const now = new Date(t + 18 * 3_600_000); // midday in Chicago
      const today = now.toISOString().slice(0, 10);
      const span = datesBetween(today, lastBookableDate(now, months)).length;
      assert.ok(
        span <= availabilityMaxDates(months),
        `${today} + ${months} months is ${span} dates`,
      );
    }
  }
});

test('datesBetween: inclusive, ascending, empty when reversed', () => {
  assert.deepEqual(datesBetween('2026-05-30', '2026-06-01'), [
    '2026-05-30',
    '2026-05-31',
    '2026-06-01',
  ]);
  assert.deepEqual(datesBetween('2026-05-30', '2026-05-30'), ['2026-05-30']);
  assert.deepEqual(datesBetween('2026-05-30', '2026-05-29'), []);
});

test('enumerateRangeWithCap: single-day range returns the same date', () => {
  const result = enumerateRangeWithCap('2026-05-19', '2026-05-19', LIMIT);
  assert.deepStrictEqual(result, { ok: true, dates: ['2026-05-19'] });
});

test('enumerateRangeWithCap: 7-day inclusive range', () => {
  const result = enumerateRangeWithCap('2026-05-15', '2026-05-21', LIMIT);
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
  const result = enumerateRangeWithCap('2028-02-27', '2028-03-02', LIMIT);
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
  const result = enumerateRangeWithCap('2026-12-30', '2027-01-02', LIMIT);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.dates, ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  }
});

test('enumerateRangeWithCap: exact boundary at a 3-month horizon (94 dates ok, 95 over)', () => {
  // Range from..to inclusive, so `(to - from) days + 1` dates emit.
  assert.equal(LIMIT, 94);

  // Exactly at the cap: 2026-05-01 to 2026-08-02 = 31+30+31+2 = 94 dates inclusive.
  const atCap = enumerateRangeWithCap('2026-05-01', '2026-08-02', LIMIT);
  assert.equal(atCap.ok, true);
  if (atCap.ok) {
    assert.equal(atCap.dates.length, 94);
    assert.equal(atCap.dates[0], '2026-05-01');
    assert.equal(atCap.dates[93], '2026-08-02');
  }

  // One over: add one day → 95 dates → over_cap.
  const overCap = enumerateRangeWithCap('2026-05-01', '2026-08-03', LIMIT);
  assert.deepStrictEqual(overCap, {
    ok: false,
    reason: 'over_cap',
    count: 95,
    limit: 94,
  });
});

test('enumerateRangeWithCap: a legal 93-date window fits, which the old fixed 92 refused', () => {
  const legal = enumerateRangeWithCap('2026-11-04', '2027-02-04', LIMIT);
  assert.equal(legal.ok, true);
  if (legal.ok) assert.equal(legal.dates.length, 93);
});

test('enumerateRangeWithCap: reversed range (to < from) returns reversed result', () => {
  const result = enumerateRangeWithCap('2026-05-21', '2026-05-15', LIMIT);
  assert.deepStrictEqual(result, {
    ok: false,
    reason: 'reversed',
    from: '2026-05-21',
    to: '2026-05-15',
  });
});

test('enumerateRangeWithCap: malformed date in either bound throws', () => {
  assert.throws(
    () => enumerateRangeWithCap('not-a-date', '2026-05-21', LIMIT),
    /invalid YYYY-MM-DD/,
  );
  assert.throws(
    () => enumerateRangeWithCap('2026-05-15', '99/99/9999', LIMIT),
    /invalid YYYY-MM-DD/,
  );
});

test('enumerateRangeWithCap: pathological large range short-circuits', () => {
  // 100-year window — without the early-exit cap check, this would
  // materialize 36_525 strings before checking length. With the early
  // exit, it bails as soon as cap+1 is reached.
  const result = enumerateRangeWithCap('2000-01-01', '2100-01-01', LIMIT);
  assert.equal(result.ok, false);
  if (!result.ok && result.reason === 'over_cap') {
    assert.equal(result.limit, 94);
    assert.equal(result.count, 95); // bailed at exactly cap+1
  }
});
