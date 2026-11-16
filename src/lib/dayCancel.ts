import type { AttendanceStatus } from '../contracts/wire.js';
import { bookingsRepository, type BookingFullRow } from '../db/repositories/bookingsRepository.js';
import {
  checkinEventsRepository,
  type CheckinEventRow,
} from '../db/repositories/checkinEventsRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import {
  sessionEndTime,
  type BookingForBucket,
  type PickupCloseByCampus,
} from './bookingBucket.js';
import type { BookingStatus, CancelFacts } from './bookingWire.js';
import { foldCheckinLog } from './checkinFold.js';
import { bucketToChicagoDate } from './chicagoDate.js';
import { ApiError } from './errors.js';
import { pgTimestampToDate } from './pgTimestamp.js';

/**
 * The cancel rules of a day session (CXL-U09; design §1.1:1064-1075, §2.3:2418-2447), in
 * one place, so the cancels that refuse and the reads that say `can_cancel` cannot
 * disagree: they read the same fold and the same clock.
 */

export type DayCategory = 'day-school' | 'day-care';

export function isDayProgram(category: string): category is DayCategory {
  return category === 'day-school' || category === 'day-care';
}

/**
 * The day has ended: Chicago now is at or past the campus's `day.pickup_close_time` on the
 * session's date, the minute the owner's list moves it to Past and *Didn't come* opens.
 */
export function dayHasEnded(
  row: BookingForBucket,
  pickupClose: PickupCloseByCampus,
  now: Date,
): boolean {
  const end = sessionEndTime(row, pickupClose);
  return end !== null && now.getTime() >= end.getTime();
}

/** The session's Chicago date, `YYYY-MM-DD`. */
export function sessionDate(scheduledAt: string): string {
  return bucketToChicagoDate(pgTimestampToDate(scheduledAt));
}

/** Each dog's folded state on one booking, from the booking's events. */
export function statesByDog(events: readonly CheckinEventRow[]): Map<string, AttendanceStatus> {
  const byDog = new Map<string, CheckinEventRow[]>();
  for (const event of events) byDog.set(event.dogId, [...(byDog.get(event.dogId) ?? []), event]);
  return new Map([...byDog].map(([dogId, log]) => [dogId, foldCheckinLog(log).state]));
}

export function sessionEndedError(bookingId: string, date: string): ApiError {
  return new ApiError('session_ended', `booking ${bookingId}'s day (${date}) has ended`, {
    kind: 'session_ended',
    date,
  });
}

export function sessionCheckedInError(bookingId: string, dogId?: string): ApiError {
  return new ApiError(
    'session_checked_in',
    dogId === undefined
      ? `a dog on booking ${bookingId} is past expected`
      : `dog ${dogId} on booking ${bookingId} is past expected`,
  );
}

/** Each campus's `day.pickup_close_time`, read in the cancel's transaction. */
export async function pickupCloseByCampus(tx: Tx): Promise<PickupCloseByCampus> {
  const campuses = await settingsRepository.dayCampuses(tx);
  return new Map(campuses.map((campus) => [campus.location, campus.pickup_close_time]));
}

/**
 * A whole day row's cancel refusals, under its lock (CXL-U09; D12): 409 `session_ended`
 * once the day has ended, then 409 `session_checked_in` while any dog still on it has
 * folded past `expected` (an undone check-in does not count). Answers the dogs still on it.
 * The whole-session cancel's and *Cancel order*'s settled arm's (§M2), so the two cannot
 * disagree.
 */
export async function refuseDayCancel(tx: Tx, row: BookingFullRow, now: Date): Promise<string[]> {
  if (dayHasEnded(row, await pickupCloseByCampus(tx), now)) {
    throw sessionEndedError(row.id, sessionDate(row.scheduledAt));
  }
  const shares = await bookingsRepository.findSharesByBookingIds(tx, [row.id]);
  const liveDogIds = shares.filter((s) => s.expiredAt === null).map((s) => s.dogId);
  const states = statesByDog(await checkinEventsRepository.findForBookings(tx, [row.id]));
  if (liveDogIds.some((dogId) => (states.get(dogId) ?? 'expected') !== 'expected')) {
    throw sessionCheckedInError(row.id);
  }
  return liveDogIds;
}

/**
 * `can_cancel` for a day row (6.0.0-lg5.1 `BookingWire`): the whole session while it is
 * not cancelled and, unless it is a pending top-up row (which cancels its whole order),
 * its day has not ended and every dog still on it is `expected`; one dog while her share
 * and the session stand, the row is not pending, the day has not ended and SHE is
 * `expected`. On an owner's read a dog's is also false while `cxl.per_dog_cancel_enabled`
 * is off (D14); a staff cancel ignores the switch.
 */
export function cancelFacts(args: {
  status: BookingStatus;
  ended: boolean;
  liveDogIds: readonly string[];
  states: ReadonlyMap<string, AttendanceStatus>;
  viewer: 'owner' | 'staff';
  perDogCancelEnabled: boolean;
}): CancelFacts {
  const expected = expectedIn(args.states);
  const standing = args.status !== 'cancelled';
  const canCancel =
    standing &&
    (args.status === 'payment-pending' || (!args.ended && args.liveDogIds.every(expected)));
  const oneDogOpen =
    oneDogWindowOpen(args.status, args.ended) &&
    (args.viewer === 'staff' || args.perDogCancelEnabled);
  return {
    canCancel,
    shareCanCancel: new Map(args.liveDogIds.map((dogId) => [dogId, oneDogOpen && expected(dogId)])),
  };
}

/**
 * `dog_shares[].can_remove_after_school` for a day-school row (6.2.0, P48; DECISIONS
 * 408(c)): whether `POST /bookings/:id/dogs/:dogId/after-school/remove` would take each dog
 * still on it off that day's after-school now. The one-dog cancel's predicate without its
 * switch (`cxl.per_dog_cancel_enabled` does not govern it): the session not cancelled, not a
 * pending top-up row, its day not ended, and SHE `expected`; and she is opted in. The route
 * is the owner's, so a staff read is `false` throughout. The route refuses on these same
 * facts, in the wire's order (`lib/afterSchoolRemoval.ts`).
 */
export function afterSchoolRemovable(args: {
  status: BookingStatus;
  ended: boolean;
  liveDogIds: readonly string[];
  states: ReadonlyMap<string, AttendanceStatus>;
  viewer: 'owner' | 'staff';
  /** The dogs of this row opted in to its after-school session. */
  staying: ReadonlySet<string>;
}): ReadonlyMap<string, boolean> {
  const expected = expectedIn(args.states);
  const open = args.viewer === 'owner' && oneDogWindowOpen(args.status, args.ended);
  return new Map(
    args.liveDogIds.map((dogId) => [dogId, open && args.staying.has(dogId) && expected(dogId)]),
  );
}

/**
 * A one-dog write's window on a day row, before her own state: the session stands, it is
 * not a pending top-up row (which cancels its whole order), and its day has not ended.
 */
function oneDogWindowOpen(status: BookingStatus, ended: boolean): boolean {
  return status !== 'cancelled' && status !== 'payment-pending' && !ended;
}

/** Whether a dog's folded state is `expected` (no event, or every event undone). */
function expectedIn(states: ReadonlyMap<string, AttendanceStatus>): (dogId: string) => boolean {
  return (dogId) => (states.get(dogId) ?? 'expected') === 'expected';
}
