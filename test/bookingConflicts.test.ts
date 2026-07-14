import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chicagoWallTimeToUtc } from '../src/lib/chicagoDate.js';
import { dayProgramConflictsWith, type ConflictCandidate } from '../src/lib/bookingConflicts.js';

/**
 * Pure unit tests for the server-side day-program conflict rules. No DB — these
 * pin the exact rules the route enforces (and that must match the FE engine in
 * `mobile/src/lib/bookingConflicts.ts`). The contract tests exercise the
 * reachable route paths; these cover the boundary + carve-out cases (the exact
 * 17:00 edge, the group-class exemption, residential day coverage) directly.
 */

const D = '2026-07-15'; // a Wednesday well clear of any DST edge

/** A candidate at a Chicago wall-clock start on day `date`. */
function sessional(
  category: ConflictCandidate['category'],
  date: string,
  hour: number,
  minute: number,
  durationMinutes: number | null,
): ConflictCandidate {
  return {
    category,
    scheduledAt: chicagoWallTimeToUtc(date, hour, minute).toISOString(),
    durationMinutes,
    pickupAt: null,
  };
}

test('day program conflicts with another day program the same day (school ↔ care)', () => {
  const existingCare = sessional('day-care', D, 8, 0, null);
  assert.equal(dayProgramConflictsWith(D, existingCare), true);
});

test('day program does NOT conflict with a day program on a different day', () => {
  const otherDay = sessional('day-school', '2026-07-16', 8, 0, null);
  assert.equal(dayProgramConflictsWith(D, otherDay), false);
});

test('a 3:30pm private lesson (inside 07:00–17:00) conflicts', () => {
  const private330 = sessional('private-lesson', D, 15, 30, 60);
  assert.equal(dayProgramConflictsWith(D, private330), true);
});

test('a 6pm private lesson (outside the window) does NOT conflict', () => {
  const private6pm = sessional('private-lesson', D, 18, 0, 60);
  assert.equal(dayProgramConflictsWith(D, private6pm), false);
});

test('a private lesson ending exactly at 07:00 does NOT conflict (half-open edge)', () => {
  const earlyPrivate = sessional('private-lesson', D, 6, 0, 60); // 06:00–07:00
  assert.equal(dayProgramConflictsWith(D, earlyPrivate), false);
});

test('an evaluation inside the window conflicts (treated like a private slot)', () => {
  const evalNoon = sessional('evaluation', D, 12, 0, 30);
  assert.equal(dayProgramConflictsWith(D, evalNoon), true);
});

test('a group class the same day NEVER conflicts (carve-out)', () => {
  const groupNoon = sessional('group-class', D, 12, 0, 50);
  assert.equal(dayProgramConflictsWith(D, groupNoon), false);
});

test('a residential stay covering the day conflicts', () => {
  const stay: ConflictCandidate = {
    category: 'boarding',
    scheduledAt: chicagoWallTimeToUtc('2026-07-13', 15, 0).toISOString(), // drop-off Mon
    durationMinutes: null,
    pickupAt: chicagoWallTimeToUtc('2026-07-17', 12, 0).toISOString(), // pick-up Fri
  };
  assert.equal(dayProgramConflictsWith(D, stay), true); // Wed is inside [Mon, Fri]
});

test('a residential stay ending before the day does NOT conflict', () => {
  const stay: ConflictCandidate = {
    category: 'board-and-train',
    scheduledAt: chicagoWallTimeToUtc('2026-07-06', 15, 0).toISOString(),
    durationMinutes: null,
    pickupAt: chicagoWallTimeToUtc('2026-07-10', 12, 0).toISOString(), // ends the prior Fri
  };
  assert.equal(dayProgramConflictsWith(D, stay), false);
});

test('an unbounded residential stay (no pick-up) covers only its drop-off day', () => {
  const openStay: ConflictCandidate = {
    category: 'boarding',
    scheduledAt: chicagoWallTimeToUtc(D, 15, 0).toISOString(), // drops off ON D
    durationMinutes: null,
    pickupAt: null,
  };
  assert.equal(dayProgramConflictsWith(D, openStay), true);
  assert.equal(dayProgramConflictsWith('2026-07-16', openStay), false); // next day not covered
});
