import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDayProgramScheduledAt } from '../src/lib/bookingSchedule.js';

// scheduled_at composition for day-school / day-care must agree with the runtime
// bucket helper's time math (lib/bookingBucket) on every day of the year, including
// DST boundaries. Same chicagoWallTimeToUtc backbone — these tests pin the
// create-side contract. The start is the campus's `day.dropoff_open_time`, so the
// time is an argument and the route has no window to check (DAY-U11).

test('computeDayProgramScheduledAt: 07:30 Chicago on a CDT (summer) date', () => {
  const at = computeDayProgramScheduledAt('2026-06-15', '07:30');
  // CDT = UTC-5; 07:30 Chicago = 12:30 UTC.
  assert.equal(at.toISOString(), '2026-06-15T12:30:00.000Z');
});

test('computeDayProgramScheduledAt: 07:30 Chicago on a CST (winter) date', () => {
  const at = computeDayProgramScheduledAt('2026-01-15', '07:30');
  // CST = UTC-6; 07:30 Chicago = 13:30 UTC.
  assert.equal(at.toISOString(), '2026-01-15T13:30:00.000Z');
});

test('computeDayProgramScheduledAt: 07:30 Chicago on spring-forward day (already past 2am jump)', () => {
  // 2026-03-08 02:00 CST → 03:00 CDT. 07:30 wall is post-jump; CDT (UTC-5)
  // applies → 12:30 UTC.
  const at = computeDayProgramScheduledAt('2026-03-08', '07:30');
  assert.equal(at.toISOString(), '2026-03-08T12:30:00.000Z');
});

test('computeDayProgramScheduledAt: 07:30 Chicago on fall-back day (already past 2am roll)', () => {
  // 2026-11-01 02:00 CDT → 01:00 CST. 07:30 wall is post-roll; CST (UTC-6)
  // applies → 13:30 UTC.
  const at = computeDayProgramScheduledAt('2026-11-01', '07:30');
  assert.equal(at.toISOString(), '2026-11-01T13:30:00.000Z');
});

test('computeDayProgramScheduledAt: whatever the setting says, a campus opening at 07:45', () => {
  const at = computeDayProgramScheduledAt('2026-06-15', '07:45');
  assert.equal(at.toISOString(), '2026-06-15T12:45:00.000Z');
});
