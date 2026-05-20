import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DAY_PROGRAM_PICKUP_WINDOW,
  isInView,
  sessionEndTime,
  type BookingForBucket,
  type ServiceCategory,
} from '../src/lib/bookingBucket.js';

// Helper: a minimal booking shape for unit tests. Defaults exercise the
// "happy path" for each category; tests override only the field they're
// stressing.
function makeBooking(
  overrides: Partial<BookingForBucket> & Pick<BookingForBucket, 'category'>,
): BookingForBucket {
  return {
    scheduledAt: '2026-06-15 08:00:00+00',
    durationMinutes: null,
    pickupAt: null,
    ...overrides,
  };
}

// sessionEndTime: day-school + day-care — fixed Chicago window close, ignore duration.

test('sessionEndTime: day-school in CDT — end is 17:30 Chicago = 22:30 UTC on the scheduled day', () => {
  const end = sessionEndTime(
    makeBooking({ category: 'day-school', scheduledAt: '2026-06-15 13:00:00+00' }),
  );
  assert.equal(end?.toISOString(), '2026-06-15T22:30:00.000Z');
});

test('sessionEndTime: day-care in CST — end is 17:30 Chicago = 23:30 UTC on the scheduled day', () => {
  const end = sessionEndTime(
    makeBooking({ category: 'day-care', scheduledAt: '2026-01-15 14:00:00+00' }),
  );
  assert.equal(end?.toISOString(), '2026-01-15T23:30:00.000Z');
});

test('sessionEndTime: day-school ignores `duration_minutes` (window is fixed)', () => {
  // A bug-data row with duration_minutes=10000 still buckets to the window close.
  const end = sessionEndTime(
    makeBooking({
      category: 'day-school',
      scheduledAt: '2026-06-15 13:00:00+00',
      durationMinutes: 10_000,
    }),
  );
  assert.equal(end?.toISOString(), '2026-06-15T22:30:00.000Z');
});

test('sessionEndTime: day-program uses Chicago calendar day, not UTC day', () => {
  // 03:00 UTC = 22:00 PRIOR day in Chicago (CDT, UTC-5). The bucket must use
  // the Chicago calendar day (2026-06-14), not the UTC date (2026-06-15).
  const end = sessionEndTime(
    makeBooking({ category: 'day-school', scheduledAt: '2026-06-15 03:00:00+00' }),
  );
  assert.equal(end?.toISOString(), '2026-06-14T22:30:00.000Z');
});

test('sessionEndTime: day-program window-close constants match the named window', () => {
  // The window-close constant is `17:30` — guard against a future edit that
  // changes the helper without updating the bucket.
  assert.equal(DAY_PROGRAM_PICKUP_WINDOW.close.hour, 17);
  assert.equal(DAY_PROGRAM_PICKUP_WINDOW.close.minute, 30);
});

// sessionEndTime: boarding + board-and-train — pickup_at when set, null when not.

test('sessionEndTime: boarding with pickup_at set returns that instant', () => {
  const end = sessionEndTime(
    makeBooking({
      category: 'boarding',
      scheduledAt: '2026-06-15 15:00:00+00',
      pickupAt: '2026-06-20 17:00:00+00',
    }),
  );
  assert.equal(end?.toISOString(), '2026-06-20T17:00:00.000Z');
});

test('sessionEndTime: boarding without pickup_at returns null (indefinite-upcoming)', () => {
  const end = sessionEndTime(
    makeBooking({ category: 'boarding', scheduledAt: '2026-06-15 15:00:00+00', pickupAt: null }),
  );
  assert.equal(end, null);
});

test('sessionEndTime: board-and-train with pickup_at returns that instant (week-2 wrap)', () => {
  const end = sessionEndTime(
    makeBooking({
      category: 'board-and-train',
      scheduledAt: '2026-06-01 13:00:00+00',
      pickupAt: '2026-06-15 22:00:00+00',
    }),
  );
  assert.equal(end?.toISOString(), '2026-06-15T22:00:00.000Z');
});

test('sessionEndTime: board-and-train without pickup_at returns null', () => {
  const end = sessionEndTime(
    makeBooking({ category: 'board-and-train', scheduledAt: '2026-06-01 13:00:00+00' }),
  );
  assert.equal(end, null);
});

// sessionEndTime: sessional categories — scheduled + duration, per-category fallback.

test('sessionEndTime: private-lesson with explicit duration uses scheduled + duration', () => {
  const end = sessionEndTime(
    makeBooking({
      category: 'private-lesson',
      scheduledAt: '2026-06-15 15:00:00+00',
      durationMinutes: 60,
    }),
  );
  assert.equal(end?.toISOString(), '2026-06-15T16:00:00.000Z');
});

test('sessionEndTime: private-lesson with NULL duration falls back to 60min', () => {
  const end = sessionEndTime(
    makeBooking({
      category: 'private-lesson',
      scheduledAt: '2026-06-15 15:00:00+00',
      durationMinutes: null,
    }),
  );
  assert.equal(end?.toISOString(), '2026-06-15T16:00:00.000Z');
});

test('sessionEndTime: group-class with NULL duration falls back to 50min', () => {
  const end = sessionEndTime(
    makeBooking({
      category: 'group-class',
      scheduledAt: '2026-06-15 18:00:00+00',
      durationMinutes: null,
    }),
  );
  assert.equal(end?.toISOString(), '2026-06-15T18:50:00.000Z');
});

test('sessionEndTime: evaluation with NULL duration falls back to 30min', () => {
  const end = sessionEndTime(
    makeBooking({
      category: 'evaluation',
      scheduledAt: '2026-06-15 14:00:00+00',
      durationMinutes: null,
    }),
  );
  assert.equal(end?.toISOString(), '2026-06-15T14:30:00.000Z');
});

test('sessionEndTime: group-class with explicit duration overrides the fallback', () => {
  const end = sessionEndTime(
    makeBooking({
      category: 'group-class',
      scheduledAt: '2026-06-15 18:00:00+00',
      durationMinutes: 75,
    }),
  );
  assert.equal(end?.toISOString(), '2026-06-15T19:15:00.000Z');
});

test('sessionEndTime: handles PG timestamp format with no-colon offset', () => {
  // Drizzle pg `mode:'string'` returns 'YYYY-MM-DD HH:MM:SS+TZ' with no colon.
  // pgTimestampToDate normalizes it; bucketing must work end-to-end.
  const end = sessionEndTime(
    makeBooking({
      category: 'private-lesson',
      scheduledAt: '2026-06-15 15:00:00+00',
      durationMinutes: 60,
    }),
  );
  assert.equal(end?.toISOString(), '2026-06-15T16:00:00.000Z');
});

// isInView: bucketing predicate covers status-lag, indefinite-upcoming, and now-boundary.

const NOW = new Date('2026-06-15T18:00:00Z'); // 13:00 Chicago

test('isInView upcoming: a not-yet-started day-school booking is upcoming', () => {
  const b = makeBooking({ category: 'day-school', scheduledAt: '2026-06-16 13:00:00+00' });
  assert.equal(isInView(b, 'upcoming', NOW), true);
  assert.equal(isInView(b, 'past', NOW), false);
});

test('isInView upcoming: a day-school booking still mid-pickup-window is upcoming (sticky)', () => {
  // Booking scheduled for TODAY (2026-06-15); NOW is 18:00 UTC = 13:00 Chicago.
  // Pickup window closes at 22:30 UTC (17:30 Chicago). So the booking is
  // active at 13:00 Chicago — still upcoming until 17:30 elapses.
  const b = makeBooking({ category: 'day-school', scheduledAt: '2026-06-15 13:00:00+00' });
  assert.equal(isInView(b, 'upcoming', NOW), true);
  assert.equal(isInView(b, 'past', NOW), false);
});

test('isInView past: a yesterday day-school booking is past', () => {
  const b = makeBooking({ category: 'day-school', scheduledAt: '2026-06-14 13:00:00+00' });
  assert.equal(isInView(b, 'past', NOW), true);
  assert.equal(isInView(b, 'upcoming', NOW), false);
});

test('isInView past: a sessional booking 90 minutes ago is past', () => {
  // NOW − 90min = 2026-06-15T16:30:00Z. scheduled_at + 60min = 2026-06-15T17:30:00Z (< NOW).
  const b = makeBooking({
    category: 'private-lesson',
    scheduledAt: '2026-06-15 16:30:00+00',
    durationMinutes: 60,
  });
  assert.equal(isInView(b, 'past', NOW), true);
});

test('isInView upcoming: a sessional booking still mid-session is upcoming', () => {
  // NOW = 18:00 UTC; scheduled 17:30 UTC + 60min = ends 18:30 UTC > NOW → upcoming.
  const b = makeBooking({
    category: 'private-lesson',
    scheduledAt: '2026-06-15 17:30:00+00',
    durationMinutes: 60,
  });
  assert.equal(isInView(b, 'upcoming', NOW), true);
});

test('isInView upcoming: a boarding row WITHOUT pickup_at is upcoming (indefinite)', () => {
  // Even if scheduled_at was a year ago — a stay with no resolved end stays
  // upcoming until Day-12 approval sets pickup_at. The honest semantics:
  // the system can't infer a stay's end without the operator setting it.
  const b = makeBooking({
    category: 'boarding',
    scheduledAt: '2025-01-01 13:00:00+00',
    pickupAt: null,
  });
  assert.equal(isInView(b, 'upcoming', NOW), true);
  assert.equal(isInView(b, 'past', NOW), false);
});

test('isInView past: a boarding row WITH pickup_at in the past is past', () => {
  const b = makeBooking({
    category: 'boarding',
    scheduledAt: '2026-06-10 15:00:00+00',
    pickupAt: '2026-06-14 17:00:00+00',
  });
  assert.equal(isInView(b, 'past', NOW), true);
});

test('isInView upcoming: a boarding row WITH future pickup_at is upcoming', () => {
  const b = makeBooking({
    category: 'boarding',
    scheduledAt: '2026-06-20 15:00:00+00',
    pickupAt: '2026-06-25 17:00:00+00',
  });
  assert.equal(isInView(b, 'upcoming', NOW), true);
});

// Boundary check: exactly-at-now is past (end <= now). Matches the contract.

test('isInView: booking ending at exactly NOW is past (inclusive of the moment)', () => {
  const b = makeBooking({
    category: 'private-lesson',
    scheduledAt: '2026-06-15 17:00:00+00',
    durationMinutes: 60, // ends exactly at 18:00 UTC = NOW
  });
  assert.equal(isInView(b, 'past', NOW), true);
  assert.equal(isInView(b, 'upcoming', NOW), false);
});

// DST robustness: day-school bucketing across CST↔CDT must be consistent
// (the offset changes by an hour). Off-by-an-hour would flip a borderline
// booking into the wrong bucket.

test('isInView: day-school on a CST day buckets correctly across DST boundary', () => {
  // A Wednesday in January (CST). Window close = 23:30 UTC.
  const b = makeBooking({ category: 'day-school', scheduledAt: '2026-01-14 14:00:00+00' });
  const dayBefore = new Date('2026-01-14T23:25:00Z'); // 5 min before window close
  const dayAfter = new Date('2026-01-15T00:00:00Z'); // 30 min after window close
  assert.equal(isInView(b, 'upcoming', dayBefore), true);
  assert.equal(isInView(b, 'past', dayAfter), true);
});

test('isInView: day-school on a CDT day buckets correctly across DST boundary', () => {
  // Same logical test, but in CDT — window close = 22:30 UTC.
  const b = makeBooking({ category: 'day-school', scheduledAt: '2026-06-15 13:00:00+00' });
  const dayBefore = new Date('2026-06-15T22:25:00Z');
  const dayAfter = new Date('2026-06-15T23:00:00Z');
  assert.equal(isInView(b, 'upcoming', dayBefore), true);
  assert.equal(isInView(b, 'past', dayAfter), true);
});

// Type guard: a non-stay non-day-program category falls through to sessional.

test('sessionEndTime: every ServiceCategory produces a determinate end (or explicit null)', () => {
  // Guard: if a future category is added without bucket-helper coverage,
  // this test surfaces it. The branch coverage is in earlier tests; this
  // one just asserts no thrown exception per category.
  const categories: ServiceCategory[] = [
    'day-school',
    'day-care',
    'group-class',
    'private-lesson',
    'board-and-train',
    'boarding',
    'evaluation',
  ];
  for (const category of categories) {
    const b = makeBooking({ category, scheduledAt: '2026-06-15 15:00:00+00' });
    const end = sessionEndTime(b);
    // boarding/board-and-train return null when pickupAt is null; all others
    // must return a Date.
    if (category === 'boarding' || category === 'board-and-train') {
      assert.equal(end, null, `${category} should return null without pickup_at`);
    } else {
      assert.ok(end instanceof Date, `${category} should return a Date`);
    }
  }
});
