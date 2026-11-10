import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addChicagoMonths } from '../src/lib/creditExpiry.js';

/**
 * CRED-U06: the one month helper (design §2.4:2885-2889). The two fixed-clock cases
 * are the design's; each other case is what `setUTCMonth` got wrong.
 */

const add = (iso: string, months = 1): string =>
  addChicagoMonths(new Date(iso), months).toISOString();

test('design: 02:30 Sun 14 Feb 2027 → 03:30 Sun 14 Mar 2027 (a missing time moves forward by the gap)', () => {
  // 02:30 CST is 08:30Z. 14 Mar 2027 skips 02:00 to 03:00, and 03:30 CDT is 08:30Z.
  assert.equal(add('2027-02-14T08:30:00.000Z'), '2027-03-14T08:30:00.000Z');
});

test('design: 01:30 CDT Thu 7 Oct 2027 → the first 01:30 on Sun 7 Nov 2027 (a repeated time takes the earlier offset)', () => {
  // 01:30 CDT is 06:30Z. The second 01:30 on 7 Nov, CST, would be 07:30Z.
  assert.equal(add('2027-10-07T06:30:00.000Z'), '2027-11-07T06:30:00.000Z');
});

test('09:10 stays 09:10 across a DST change: a CDT buy does not become 08:10 CST', () => {
  // 09:10 CDT Sat 10 Oct 2026 is 14:10Z. 09:10 CST Tue 10 Nov 2026 is 15:10Z.
  assert.equal(add('2026-10-10T14:10:00.000Z'), '2026-11-10T15:10:00.000Z');
});

test('09:10 stays 09:10 the other way: a CST buy does not become 10:10 CDT', () => {
  // 09:10 CST Sun 14 Feb 2027 is 15:10Z. 09:10 CDT Sun 14 Mar 2027 is 14:10Z.
  assert.equal(add('2027-02-14T15:10:00.000Z'), '2027-03-14T14:10:00.000Z');
});

test('a month-end clamps to the last day of the target month, and never rolls over', () => {
  // 31 Jan 2027 12:00 CST → 28 Feb 2027 12:00 CST, not 3 Mar.
  assert.equal(add('2027-01-31T18:00:00.000Z'), '2027-02-28T18:00:00.000Z');
  // 31 Jan 2028 12:00 CST → 29 Feb 2028, a leap year.
  assert.equal(add('2028-01-31T18:00:00.000Z'), '2028-02-29T18:00:00.000Z');
  // 31 Mar 2027 12:00 CDT → 30 Apr 2027 12:00 CDT.
  assert.equal(add('2027-03-31T17:00:00.000Z'), '2027-04-30T17:00:00.000Z');
});

test('the months are Chicago calendar months, not UTC ones: an evening buy keeps its Chicago day', () => {
  // 23:00 CDT Sat 31 Oct 2026 is 04:00Z on 1 Nov, so a UTC month would land on 1 Dec.
  assert.equal(add('2026-11-01T04:00:00.000Z'), '2026-12-01T05:00:00.000Z');
});

test('a year rolls over, and a long window counts whole months', () => {
  // 12:00 CST Tue 15 Dec 2026 → 12:00 CST Fri 15 Jan 2027.
  assert.equal(add('2026-12-15T18:00:00.000Z'), '2027-01-15T18:00:00.000Z');
  // 12:00 CDT Mon 15 Jun 2026 + 14 months → 12:00 CDT Sun 15 Aug 2027.
  assert.equal(add('2026-06-15T17:00:00.000Z', 14), '2027-08-15T17:00:00.000Z');
});

test('the seconds and milliseconds of the anchor carry over', () => {
  assert.equal(add('2026-10-10T14:10:37.123Z'), '2026-11-10T15:10:37.123Z');
  // In the skipped hour too: 02:30:15.5 CST → 03:30:15.5 CDT.
  assert.equal(add('2027-02-14T08:30:15.500Z'), '2027-03-14T08:30:15.500Z');
});

test('the anchor is not mutated', () => {
  const anchor = new Date('2026-10-10T14:10:00.000Z');
  addChicagoMonths(anchor, 1);
  assert.equal(anchor.toISOString(), '2026-10-10T14:10:00.000Z');
});
