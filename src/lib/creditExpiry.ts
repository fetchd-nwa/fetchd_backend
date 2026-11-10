import { chicagoWallPartsAt, chicagoWallTimeToUtc } from './chicagoDate.js';

/**
 * The one month helper every lot's expiry goes through (CRED-U06; design §2.4:2885-2889):
 * `anchor` plus `months` whole America/Chicago calendar months, the wall clock kept.
 * 09:10 stays 09:10 across a DST change, where `setUTCMonth` turned a 09:10 CDT buy into
 * 08:10 CST and rolled 31 Jan + 1 month to 3 Mar.
 *
 *   - A day the target month lacks clamps to its last day: 31 Jan → 28 Feb. Our mechanic
 *     for "whole calendar months", not a ruling.
 *   - A wall time the target day skips moves forward by the gap: 02:30 Sun 14 Feb 2027 →
 *     03:30 Sun 14 Mar 2027.
 *   - A wall time the target day repeats takes the earlier offset: 01:30 CDT Thu 7 Oct
 *     2027 → the first 01:30 on Sun 7 Nov 2027.
 *
 * Those last two are `chicagoWallTimeToUtc`'s "compatible" reading. It works to the
 * minute, and Chicago's offset is a whole number of minutes, so the anchor's seconds and
 * milliseconds are the wall clock's and carry over unchanged.
 */
export function addChicagoMonths(anchor: Date, months: number): Date {
  const { date, hour, minute } = chicagoWallPartsAt(anchor);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDate = [
    String(targetYear),
    String(targetMonth + 1).padStart(2, '0'),
    String(Math.min(day, lastDay)).padStart(2, '0'),
  ].join('-');
  const subMinuteMs = ((anchor.getTime() % 60_000) + 60_000) % 60_000;
  return new Date(chicagoWallTimeToUtc(targetDate, hour, minute).getTime() + subMinuteMs);
}
