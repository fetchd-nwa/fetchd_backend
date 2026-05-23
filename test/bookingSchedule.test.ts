import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DROPOFF_TIME,
  DROPOFF_TIME_REGEX,
  assertDropoffWithinWindow,
  computeDayProgramScheduledAt,
  parseDropoffTime,
} from '../src/lib/bookingSchedule.js';
import { ApiError } from '../src/lib/errors.js';

// Day 10: scheduled_at composition for day-school / day-care must agree
// with the runtime bucket helper's time math (lib/bookingBucket) on every
// day of the year, including DST boundaries. Same chicagoWallTimeToUtc
// backbone — these tests pin the create-side contract.

test('DROPOFF_TIME_REGEX accepts valid HH:MM (24h)', () => {
  for (const ok of ['07:30', '00:00', '23:59', '12:00', '09:00']) {
    assert.match(ok, DROPOFF_TIME_REGEX, `expected ${ok} to match`);
  }
});

test('DROPOFF_TIME_REGEX rejects malformed inputs', () => {
  for (const bad of ['7:30', '07:3', '24:00', '12:60', '7am', '07-30', '', '07:30:00']) {
    assert.doesNotMatch(bad, DROPOFF_TIME_REGEX, `expected ${JSON.stringify(bad)} to fail`);
  }
});

test('parseDropoffTime: valid', () => {
  assert.deepEqual(parseDropoffTime('07:30'), { hour: 7, minute: 30 });
  assert.deepEqual(parseDropoffTime('09:00'), { hour: 9, minute: 0 });
});

test('parseDropoffTime: malformed throws ApiError bad_request', () => {
  assert.throws(
    () => parseDropoffTime('7:30'),
    (e) => e instanceof ApiError && e.code === 'bad_request',
  );
});

test('DEFAULT_DROPOFF_TIME = open of drop-off window (07:30)', () => {
  assert.deepEqual(DEFAULT_DROPOFF_TIME, { hour: 7, minute: 30 });
});

test('assertDropoffWithinWindow: inclusive on both ends', () => {
  // Open (07:30) accepted
  assert.doesNotThrow(() => assertDropoffWithinWindow({ hour: 7, minute: 30 }));
  // Close (09:00) accepted
  assert.doesNotThrow(() => assertDropoffWithinWindow({ hour: 9, minute: 0 }));
  // Mid-window accepted
  assert.doesNotThrow(() => assertDropoffWithinWindow({ hour: 8, minute: 15 }));
});

test('assertDropoffWithinWindow: rejects 1 minute before open', () => {
  assert.throws(
    () => assertDropoffWithinWindow({ hour: 7, minute: 29 }),
    (e) => e instanceof ApiError && e.code === 'bad_request',
  );
});

test('assertDropoffWithinWindow: rejects 1 minute after close', () => {
  assert.throws(
    () => assertDropoffWithinWindow({ hour: 9, minute: 1 }),
    (e) => e instanceof ApiError && e.code === 'bad_request',
  );
});

test('assertDropoffWithinWindow: rejects wildly out-of-window times', () => {
  for (const bad of [
    { hour: 0, minute: 0 },
    { hour: 17, minute: 30 },
    { hour: 23, minute: 59 },
  ]) {
    assert.throws(
      () => assertDropoffWithinWindow(bad),
      (e) => e instanceof ApiError && e.code === 'bad_request',
      `expected ${JSON.stringify(bad)} to reject`,
    );
  }
});

test('computeDayProgramScheduledAt: 07:30 Chicago on a CDT (summer) date', () => {
  const at = computeDayProgramScheduledAt('day-school', '2026-06-15', { hour: 7, minute: 30 });
  // CDT = UTC-5; 07:30 Chicago = 12:30 UTC.
  assert.equal(at.toISOString(), '2026-06-15T12:30:00.000Z');
});

test('computeDayProgramScheduledAt: 07:30 Chicago on a CST (winter) date', () => {
  const at = computeDayProgramScheduledAt('day-care', '2026-01-15', { hour: 7, minute: 30 });
  // CST = UTC-6; 07:30 Chicago = 13:30 UTC.
  assert.equal(at.toISOString(), '2026-01-15T13:30:00.000Z');
});

test('computeDayProgramScheduledAt: 07:30 Chicago on spring-forward day (already past 2am jump)', () => {
  // 2026-03-08 02:00 CST → 03:00 CDT. 07:30 wall is post-jump; CDT (UTC-5)
  // applies → 12:30 UTC.
  const at = computeDayProgramScheduledAt('day-school', '2026-03-08', { hour: 7, minute: 30 });
  assert.equal(at.toISOString(), '2026-03-08T12:30:00.000Z');
});

test('computeDayProgramScheduledAt: 07:30 Chicago on fall-back day (already past 2am roll)', () => {
  // 2026-11-01 02:00 CDT → 01:00 CST. 07:30 wall is post-roll; CST (UTC-6)
  // applies → 13:30 UTC.
  const at = computeDayProgramScheduledAt('day-school', '2026-11-01', { hour: 7, minute: 30 });
  assert.equal(at.toISOString(), '2026-11-01T13:30:00.000Z');
});

test('computeDayProgramScheduledAt: 09:00 close-of-window resolves cleanly', () => {
  const at = computeDayProgramScheduledAt('day-care', '2026-06-15', { hour: 9, minute: 0 });
  assert.equal(at.toISOString(), '2026-06-15T14:00:00.000Z');
});
