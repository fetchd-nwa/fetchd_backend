import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketToChicagoDate, chicagoWallTimeToUtc } from '../src/lib/chicagoDate.js';

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

// Day 5a: `chicagoWallTimeToUtc` is the day-program bucketing primitive —
// `17:30 in Chicago on date X` becomes the absolute UTC instant the bucket
// helper compares to `now()`. DST must work both ways: CDT (UTC-5) in
// summer, CST (UTC-6) in winter. Off by an hour and a day-school session
// flips from Upcoming to Past at the wrong moment.

test('chicagoWallTimeToUtc: CDT (summer) — 17:30 Chicago on 2026-06-15 is 22:30 UTC', () => {
  const utc = chicagoWallTimeToUtc('2026-06-15', 17, 30);
  assert.equal(utc.toISOString(), '2026-06-15T22:30:00.000Z');
});

test('chicagoWallTimeToUtc: CST (winter) — 17:30 Chicago on 2026-01-15 is 23:30 UTC', () => {
  const utc = chicagoWallTimeToUtc('2026-01-15', 17, 30);
  assert.equal(utc.toISOString(), '2026-01-15T23:30:00.000Z');
});

test('chicagoWallTimeToUtc: spring-forward day (2026-03-08), wall time AFTER the jump uses CDT', () => {
  // 17:30 Chicago on March 8 is well past the 2am→3am skip → CDT (UTC-5).
  const utc = chicagoWallTimeToUtc('2026-03-08', 17, 30);
  assert.equal(utc.toISOString(), '2026-03-08T22:30:00.000Z');
});

test('chicagoWallTimeToUtc: spring-forward day, 07:30 wall (day-program drop-off window) → CDT', () => {
  // Day 10 regression lock: a Day-10-era version of this fn returned 13:30
  // UTC for 07:30 on spring-forward day — the naive UTC interpretation
  // (07:30Z = 01:30 CST, pre-jump) seeded a pre-transition probe that the
  // old Math.max heuristic preferred over the correct post-transition
  // probe. The day-program drop-off window (07:30-09:00) sits in the
  // narrow "post-jump wall but pre-jump naive UTC" window from 03:00 to
  // 07:59 wall — bookings on spring-forward morning would land an hour
  // late under the old code. Fixed-point iteration converges correctly.
  const utc = chicagoWallTimeToUtc('2026-03-08', 7, 30);
  assert.equal(utc.toISOString(), '2026-03-08T12:30:00.000Z');
  // Same wall time on the day BEFORE spring-forward → CST applies.
  const utcDayBefore = chicagoWallTimeToUtc('2026-03-07', 7, 30);
  assert.equal(utcDayBefore.toISOString(), '2026-03-07T13:30:00.000Z');
  // Same wall time on the day AFTER spring-forward → CDT applies.
  const utcDayAfter = chicagoWallTimeToUtc('2026-03-09', 7, 30);
  assert.equal(utcDayAfter.toISOString(), '2026-03-09T12:30:00.000Z');
});

test('chicagoWallTimeToUtc: spring-forward day, every wall time in 03:00-08:00 resolves to CDT', () => {
  // Sweep the "bad window" hour by hour to confirm fixed-point iteration
  // never silently shifts a post-jump wall into pre-jump UTC.
  for (let h = 3; h <= 8; h += 1) {
    const utc = chicagoWallTimeToUtc('2026-03-08', h, 0);
    // CDT (UTC-5): wall + 5 hours = UTC. (Equivalent: ISO hour should be wall + 5.)
    const isoHour = utc.toISOString().slice(11, 13);
    assert.equal(isoHour, String(h + 5).padStart(2, '0'), `wall=${h}:00 should land in CDT`);
  }
});

test('chicagoWallTimeToUtc: fall-back day (2026-11-01), wall time AFTER the unfold uses CST', () => {
  // 17:30 Chicago on November 1 is well past the 1am→1am repeat → CST (UTC-6).
  const utc = chicagoWallTimeToUtc('2026-11-01', 17, 30);
  assert.equal(utc.toISOString(), '2026-11-01T23:30:00.000Z');
});

test('chicagoWallTimeToUtc: day-program window endpoints (07:30, 09:00, 16:30, 17:30) in CDT', () => {
  // Sanity-check all four window endpoints in summer (CDT, UTC-5).
  assert.equal(chicagoWallTimeToUtc('2026-06-15', 7, 30).toISOString(), '2026-06-15T12:30:00.000Z');
  assert.equal(chicagoWallTimeToUtc('2026-06-15', 9, 0).toISOString(), '2026-06-15T14:00:00.000Z');
  assert.equal(
    chicagoWallTimeToUtc('2026-06-15', 16, 30).toISOString(),
    '2026-06-15T21:30:00.000Z',
  );
  assert.equal(
    chicagoWallTimeToUtc('2026-06-15', 17, 30).toISOString(),
    '2026-06-15T22:30:00.000Z',
  );
});

test('chicagoWallTimeToUtc: round-trip — wall → UTC → wall lands on same date', () => {
  const utc = chicagoWallTimeToUtc('2026-06-15', 17, 30);
  assert.equal(bucketToChicagoDate(utc), '2026-06-15');
});

test('chicagoWallTimeToUtc: invalid date string throws', () => {
  assert.throws(() => chicagoWallTimeToUtc('not-a-date', 17, 30), /invalid date string/);
});

// DST edge cases: wall times that don't exist (spring-forward gap) or
// exist twice (fall-back overlap). Day-program windows never reach these
// hours, but the helper is general-purpose and its behavior must be
// deterministic + documented per the IANA / Java / Python convention.

test('chicagoWallTimeToUtc: spring-forward GAP (2026-03-08, 02:30) skips to 03:30 CDT', () => {
  // March 8, 2026 in Chicago: 02:00 CST jumps to 03:00 CDT. The 02:00-
  // 03:00 hour does not exist. Asking for 02:30 returns the
  // post-transition wall time (03:30 CDT = 08:30 UTC), matching IANA
  // `fold=0`. Roundtripping through bucketToChicagoDate keeps the day.
  const utc = chicagoWallTimeToUtc('2026-03-08', 2, 30);
  assert.equal(utc.toISOString(), '2026-03-08T08:30:00.000Z');
  assert.equal(bucketToChicagoDate(utc), '2026-03-08');
});

test('chicagoWallTimeToUtc: fall-back OVERLAP (2026-11-01, 01:30) picks first occurrence (CDT)', () => {
  // November 1, 2026 in Chicago: 02:00 CDT falls back to 01:00 CST. The
  // 01:00-02:00 wall hour happens twice — once in CDT (06:00-07:00 UTC),
  // once in CST (07:00-08:00 UTC). 01:30 returns the FIRST occurrence
  // (CDT, 06:30 UTC) per the IANA first-occurrence convention. A future
  // caller that needs the second occurrence (CST, 07:30 UTC) would need
  // an explicit "fold" / "afterTransition" param — out of scope today.
  const utc = chicagoWallTimeToUtc('2026-11-01', 1, 30);
  assert.equal(utc.toISOString(), '2026-11-01T06:30:00.000Z');
  assert.equal(bucketToChicagoDate(utc), '2026-11-01');
});

test('chicagoWallTimeToUtc: spring-forward boundary (02:00 itself) resolves to 03:00 CDT', () => {
  // The exact transition moment: 02:00 CST → 03:00 CDT. Asking for 02:00
  // returns 03:00 CDT (08:00 UTC) — gap-skip behavior at the boundary.
  const utc = chicagoWallTimeToUtc('2026-03-08', 2, 0);
  assert.equal(utc.toISOString(), '2026-03-08T08:00:00.000Z');
});
