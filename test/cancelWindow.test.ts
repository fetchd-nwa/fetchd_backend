import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeCancelDeadline, freeCancelHoursBefore } from '../src/lib/cancelWindow.js';

// Day 10: per-category cancel windows are LOCKED API logic (DATA-CONTRACT
// §I lines 682-696). The math is pure UTC offset so DST never silently
// shifts a "24 hour" promise to 23h or 25h. These tests pin both the
// per-category numbers and the timezone-invariant arithmetic.

const HOUR_MS = 3_600_000;

test('day-school free cancel = 24h before scheduled_at', () => {
  const scheduled = new Date('2026-06-15T13:00:00.000Z');
  const deadline = computeCancelDeadline('day-school', scheduled);
  assert.equal(scheduled.getTime() - deadline.getTime(), 24 * HOUR_MS);
});

test('day-care free cancel = 24h (same as day-school)', () => {
  const scheduled = new Date('2026-06-15T13:00:00.000Z');
  const deadline = computeCancelDeadline('day-care', scheduled);
  assert.equal(scheduled.getTime() - deadline.getTime(), 24 * HOUR_MS);
});

test('private-lesson free cancel = 24h', () => {
  assert.equal(freeCancelHoursBefore('private-lesson'), 24);
});

test('group-class free cancel = 48h (cohort capacity reserved)', () => {
  const scheduled = new Date('2026-06-15T13:00:00.000Z');
  const deadline = computeCancelDeadline('group-class', scheduled);
  assert.equal(scheduled.getTime() - deadline.getTime(), 48 * HOUR_MS);
});

test('boarding free cancel = 72h (multi-night stay)', () => {
  const scheduled = new Date('2026-06-15T13:00:00.000Z');
  const deadline = computeCancelDeadline('boarding', scheduled);
  assert.equal(scheduled.getTime() - deadline.getTime(), 72 * HOUR_MS);
});

test('board-and-train free cancel = 168h / 7 days (multi-week commit)', () => {
  const scheduled = new Date('2026-06-15T13:00:00.000Z');
  const deadline = computeCancelDeadline('board-and-train', scheduled);
  assert.equal(scheduled.getTime() - deadline.getTime(), 168 * HOUR_MS);
});

test('evaluation free cancel = 24h', () => {
  assert.equal(freeCancelHoursBefore('evaluation'), 24);
});

test('cancel deadline crosses spring-forward: 24 REAL hours, not 23 wall hours', () => {
  // Spring forward 2026-03-08 02:00 CST → 03:00 CDT. A booking at 10am
  // Chicago on March 9 minus "24 real hours" should land at 10am Chicago
  // on March 8 (i.e. before the wall clock jumped) — same UTC delta on
  // both sides of the boundary because we use pure ms subtraction.
  const scheduled = new Date('2026-03-09T15:00:00.000Z'); // 10am CDT
  const deadline = computeCancelDeadline('day-school', scheduled);
  assert.equal(scheduled.getTime() - deadline.getTime(), 24 * HOUR_MS);
  // The deadline lands at 15:00 UTC on March 8 — which is 09:00 CST (pre-
  // jump wall clock). NOT 10:00 wall, NOT 11:00 wall — pure ms math is
  // wall-clock-agnostic, which is the point. The FE renders "X hours
  // left" relatively; the small absolute-wall-time shift on DST days
  // is user-invisible.
  assert.equal(deadline.toISOString(), '2026-03-08T15:00:00.000Z');
});

test('cancel deadline crosses fall-back: still exactly 24 real hours', () => {
  // Fall back 2026-11-01 02:00 CDT → 01:00 CST. A booking at 10am Chicago
  // on November 2 minus "24 real hours" → 24 * 3.6e6 ms earlier, ISO
  // shows 14:00 UTC on November 1 (= 09:00 CDT same wall).
  const scheduled = new Date('2026-11-02T16:00:00.000Z'); // 10am CST
  const deadline = computeCancelDeadline('day-care', scheduled);
  assert.equal(scheduled.getTime() - deadline.getTime(), 24 * HOUR_MS);
});

test('cancel deadline can be in the past for same-day booking', () => {
  // A booking scheduled less than 24h from "now" stamps a cancel_deadline_at
  // before now — meaning any cancel will be `cancel_forfeited`. This is
  // expected: same-day day-school books past the free-cancel window. The
  // stamping math is identical; the route can surface a UX hint but the
  // contract is "deadline = scheduledAt - hours, always."
  const scheduled = new Date('2026-06-15T08:00:00.000Z');
  const deadline = computeCancelDeadline('day-school', scheduled);
  // No need to know the wall clock — just confirm the delta.
  assert.equal(scheduled.getTime() - deadline.getTime(), 24 * HOUR_MS);
  assert.ok(deadline.getTime() < scheduled.getTime());
});
