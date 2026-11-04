import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDatesBookable, lastBookableDate } from '../src/lib/bookingHorizon.js';
import { ApiError } from '../src/lib/errors.js';

/**
 * The horizon's arithmetic, pure (ruling (d)): today in Chicago + N calendar months,
 * clamped to the month's end, inclusive. The route-level proof is
 * `test/contracts/booking-day-refusals.test.ts`.
 */

const noonChicago = (date: string): Date => new Date(`${date}T18:00:00Z`);

test('the same day of the month, N months on', () => {
  assert.equal(lastBookableDate(noonChicago('2026-05-19'), 3), '2026-08-19');
  assert.equal(lastBookableDate(noonChicago('2026-05-19'), 1), '2026-06-19');
  assert.equal(lastBookableDate(noonChicago('2026-05-19'), 12), '2027-05-19');
});

test('30 Nov + 3 months is 28 Feb, where setUTCMonth overflows to 2 Mar', () => {
  assert.equal(lastBookableDate(noonChicago('2026-11-30'), 3), '2027-02-28');
});

test('a leap year clamps to 29 Feb', () => {
  assert.equal(lastBookableDate(noonChicago('2027-11-30'), 3), '2028-02-29');
});

test('every month-end clamps to the target month, across a year boundary', () => {
  assert.equal(lastBookableDate(noonChicago('2026-01-31'), 1), '2026-02-28');
  assert.equal(lastBookableDate(noonChicago('2026-03-31'), 1), '2026-04-30');
  assert.equal(lastBookableDate(noonChicago('2026-10-31'), 3), '2027-01-31');
  assert.equal(lastBookableDate(noonChicago('2026-12-31'), 2), '2027-02-28');
});

test('today is the Chicago day, not the UTC one', () => {
  // 02:00Z on 1 Jun is 21:00 on 31 May in Chicago: 31 May + 3 is 31 Aug, not 1 Sep.
  assert.equal(lastBookableDate(new Date('2026-06-01T02:00:00Z'), 3), '2026-08-31');
});

test('assertDatesBookable: today and the last date pass', () => {
  const now = noonChicago('2026-05-19');
  assert.doesNotThrow(() => assertDatesBookable(['2026-05-19', '2026-08-19'], now, 3));
});

test('assertDatesBookable: yesterday is invalid_payload, on the Chicago day', () => {
  const now = new Date('2026-06-01T02:00:00Z'); // still 31 May in Chicago
  assert.doesNotThrow(() => assertDatesBookable(['2026-05-31'], now, 3));
  assert.throws(
    () => assertDatesBookable(['2026-05-30'], now, 3),
    (e) => e instanceof ApiError && e.code === 'invalid_payload',
  );
});

test('assertDatesBookable: the day after the last is beyond_booking_horizon', () => {
  assert.throws(
    () => assertDatesBookable(['2026-08-20'], noonChicago('2026-05-19'), 3),
    (e) => e instanceof ApiError && e.code === 'beyond_booking_horizon' && e.status === 422,
  );
});
