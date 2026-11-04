import type { LocationKey } from '../contracts/wire.js';
import { withCapacityLocks } from '../db/locks.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import { datesBetween, dayCapacityFor, type DayCapacityRule } from './availability.js';
import { capacityBelowBookedError } from './bookingErrors.js';
import { lastBookableDate } from './bookingHorizon.js';
import { bucketChicagoToday } from './chicagoDate.js';

/**
 * The one cap-lowering check (DAY-U07, DAY-67; design §2.3:2334-2340; DECISIONS
 * 128(i)). A cap edit may not leave a booked date within the horizon below its
 * count, so `PUT` and `DELETE /staff/day-capacity/:location/:date` and a `PATCH
 * /staff/settings/day/:location` that names `daily_capacity_dogs` or
 * `open_weekdays_list` all call this one function, inside their `withMutation`,
 * before their write.
 *
 * **How it serialises with a booking.** Every date's `(location, date)` lock is
 * taken in ONE transaction, ascending (`locks.ts`, the order a booking uses), each
 * date is counted, and only then is the override or the setting written and
 * committed. A transaction advisory lock cannot be released before COMMIT, so "one
 * date at a time" would either hold every lock anyway or let a booking land on a
 * Friday already counted. A booking reads the settings only after taking its own
 * capacity locks, so the two meet on the same keys: whichever gets a shared date's
 * lock first finishes, and the other then sees what it wrote. If the booking is
 * first, this check counts its dogs and refuses; if the edit is first, the booking
 * reads the new rule and meets `insufficient_capacity`.
 *
 * **The lock order.** A `PATCH` takes its campus row `FOR UPDATE` (the route), the
 * global row `FOR SHARE`, then the capacity locks. `PUT` and `DELETE` take the global
 * row `FOR SHARE`, then the date's lock. The global row comes first because it fixes
 * the window: `booking_horizon_months` picks which dates are candidates at all, and a
 * horizon raised after that read would make a date bookable that the check never
 * looked at. A global `PATCH` holds that row until it commits, so an edit and a raise
 * queue, whichever came first, and each sees the other's result. Nothing else takes
 * this row with a lock: a booking reads it plain, after its capacity locks, so a
 * booking is not blocked, and the two orders cannot meet in a cycle.
 *
 * Reads here go through the `tx` and never the `avail:*` cache: the count and the
 * overrides have to be the ones the held locks protect.
 */

export type CapEdit =
  /** A `PATCH`: the campus's rule moves, so the candidates are every date it lowers. */
  | { kind: 'rule'; before: DayCapacityRule; after: DayCapacityRule }
  /**
   * A `PUT` or `DELETE`: the candidate is the one date. `'rule'` is a withdrawal:
   * the date falls back to whatever the campus's rule gives it.
   */
  | { kind: 'date'; date: string; capacityAfter: number | 'rule' };

export async function assertCapEditKeepsBooked(
  tx: Tx,
  args: { location: LocationKey; now: Date; edit: CapEdit },
): Promise<void> {
  const { location, now, edit } = args;
  const { booking_horizon_months: months } = await settingsRepository.shareDayGlobal(tx);
  const window = { first: bucketChicagoToday(now), last: lastBookableDate(now, months) };
  if (edit.kind === 'rule') {
    await checkRuleEdit(tx, location, window, edit);
  } else {
    await checkDateEdit(tx, location, window, edit);
  }
}

interface HorizonWindow {
  first: string;
  last: string;
}

async function checkRuleEdit(
  tx: Tx,
  location: LocationKey,
  window: HorizonWindow,
  edit: Extract<CapEdit, { kind: 'rule' }>,
): Promise<void> {
  const seats = (date: string, rule: DayCapacityRule): number =>
    dayCapacityFor(date, rule, undefined);
  const candidates = datesBetween(window.first, window.last).filter(
    (date) => seats(date, edit.after) < seats(date, edit.before),
  );
  // A raise takes no locks and checks nothing.
  const first = candidates[0];
  const last = candidates.at(-1);
  if (first === undefined || last === undefined) return;

  await withCapacityLocks(tx, location, candidates, async () => {
    // An override wins, so the rule does not touch a date it covers. Read under the
    // locks: a `DELETE` that withdrew one a moment ago holds the same key.
    const overrides = await dayCapacityRepository.findLiveOverridesInTx(tx, location, first, last);
    const covered = new Set(overrides.map((row) => row.date));
    const capacityAfter = new Map(
      candidates
        .filter((date) => !covered.has(date))
        .map((date) => [date, seats(date, edit.after)] as const),
    );
    await refuseBelowCount(tx, location, capacityAfter);
  });
}

async function checkDateEdit(
  tx: Tx,
  location: LocationKey,
  window: HorizonWindow,
  edit: Extract<CapEdit, { kind: 'date' }>,
): Promise<void> {
  const { date } = edit;
  await withCapacityLocks(tx, location, [date], async () => {
    const rule = await settingsRepository.dayCampus(location, tx);
    const [override] = await dayCapacityRepository.findLiveOverridesInTx(tx, location, date, date);
    const before = dayCapacityFor(date, rule, override);
    const after =
      edit.capacityAfter === 'rule' ? dayCapacityFor(date, rule, undefined) : edit.capacityAfter;
    // A raise checks nothing, and neither does a withdrawal with nothing to withdraw:
    // an over-full date must not refuse an edit that leaves it no worse.
    if (after >= before) return;
    // "Within the horizon", the design's words on all three edits: a date past it
    // can hold an imported booking, and lowering that date succeeds under its count.
    if (date < window.first || date > window.last) return;
    await refuseBelowCount(tx, location, new Map([[date, after]]));
  });
}

/** 422 `capacity_below_booked` with every undercut date, ascending, or nothing. */
async function refuseBelowCount(
  tx: Tx,
  location: LocationKey,
  capacityAfter: ReadonlyMap<string, number>,
): Promise<void> {
  const dates = [...capacityAfter.keys()].sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (first === undefined || last === undefined) return;
  const counts = await dayCapacityRepository.findBookedCountsInRange(location, first, last, tx);
  const undercut = counts
    .filter((row) => {
      const seats = capacityAfter.get(row.date);
      return seats !== undefined && row.booked > seats;
    })
    .map((row) => row.date)
    .sort();
  if (undercut.length > 0) throw capacityBelowBookedError(undercut);
}
