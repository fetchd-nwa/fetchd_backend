import { withCapacityLocks, withDogLocks } from '../db/locks.js';
import { bookingsRepository, type BookingFullRow } from '../db/repositories/bookingsRepository.js';
import { checkinEventsRepository } from '../db/repositories/checkinEventsRepository.js';
import type { Tx } from '../db/tx.js';
import type { BookingWire, LocationKey } from './bookingWire.js';
import {
  dayHasEnded,
  pickupCloseByCampus,
  sessionCheckedInError,
  sessionDate,
  sessionEndedError,
  statesByDog,
} from './dayCancel.js';
import { ApiError } from './errors.js';
import { wireManyBookings } from './wireManyBookings.js';

export interface RemoveAfterSchoolResult {
  /** The session after the change, as the owner reads it. */
  wire: BookingWire;
  /**
   * The session's campus: her place is free, so the route wipes `avail:{location}:*`.
   * `null` on a day row with no campus (schema-legal, written by no route), whose place
   * counts toward no campus.
   */
  location: LocationKey | null;
}

/**
 * One dog's after-school, taken off (6.2.0, plan unit P48; build DECISIONS 407, 408(c);
 * her words: "i should be able to go into each booking and unselect the after school
 * training if i want"): `POST /bookings/:id/dogs/:dogId/after-school/remove`, one
 * transaction inside the route's `withMutation`.
 *
 * Refuses in the wire's order (`wire.ts`, the route's doc): 404 `not_found` (no live
 * booking, not hers, or the dog was never on it), then 422 `invalid_payload` (not day
 * school: after-school rides day school only), on a plain read; then, under the locks, the
 * one-dog cancel's refusals in its order (`cancelOneDogInTx`, D12) without its switch,
 * which does not govern this: 409 `session_cancelled` (the session, or her share), 409
 * `payment_pending`, 409 `session_ended` (the campus's `day.pickup_close_time` on the
 * session's date has passed), 409 `session_checked_in` while HER folded state is not
 * `expected`. 408(c)'s "allowed until the day has started, the same line as the owner's
 * cancel" is read as exactly that line: these refusals, no other clock. Every refusal with a
 * clock in it runs after the claim, so an answer replays unchanged (DECISIONS 128(a)).
 * `lib/dayCancel.afterSchoolRemovable` says the same thing on every read.
 *
 * Then her share's `after_school` goes false: her place in that date's after-school session
 * is free at once, and her share, her seat and her day stay. A share already off writes
 * nothing and answers the session as it stands. It moves no credit and no money: no
 * ledger, lot, order, invoice, charge, refund or Stripe call (after-school is priced
 * `day.after_school_price_cents`, seeded 0 and never charged in v1).
 *
 * The locks, in the global order (`db/locks.ts`): her dog (`withDogLocks`, the lock every
 * booking write for a dog takes, DECISIONS 123(c)), then the session's `(location, date)`
 * lock, the one the booking's after-school count is taken under, then the booking row,
 * which orders her removal against a check-in or a cancel of the same session. The date
 * lock is not what keeps the cap: a removal only frees a place, and a booking's count reads
 * committed rows, so no order of the two can put a date over it. What the date lock does is
 * order the removal with the bookings queued on that date, so one queued behind her sees
 * the place she freed. A day row with no campus counts toward no campus's places, so it
 * takes no date lock. The lock key is read before the locks, which is sound because
 * nothing moves a booking's campus or date once it exists.
 */
export async function removeAfterSchoolInTx(
  tx: Tx,
  args: { id: string; dogId: string; ownerId: string; now: Date },
): Promise<RemoveAfterSchoolResult> {
  const { id, dogId, ownerId, now } = args;

  // 1. On a plain read, in the wire's order: the 404s, then the day-school refusal.
  const seen = await bookingsRepository.findFullByIdInTx(tx, id);
  assertHers(seen, id, ownerId);
  if ((await bookingsRepository.findShareInTx(tx, id, dogId)) === undefined) {
    throw notOnIt(id, dogId);
  }
  if (seen.category !== 'day-school') {
    throw new ApiError(
      'invalid_payload',
      `booking ${id} is not a day-school session: after-school rides day school only`,
    );
  }
  const location = seen.location;
  // A day row with no campus counts toward no campus's places: no date lock to take.
  const underDateLock = <T>(fn: () => Promise<T>): Promise<T> =>
    location === null ? fn() : withCapacityLocks(tx, location, [sessionDate(seen.scheduledAt)], fn);

  // 2. The locks: her dog, the session's date at its campus, then the row.
  return withDogLocks(tx, [dogId], () =>
    underDateLock(async () => {
      const row = await bookingsRepository.lockById(tx, id);
      assertHers(row, id, ownerId);
      const share = await bookingsRepository.findShareInTx(tx, id, dogId);
      if (share === undefined) throw notOnIt(id, dogId);

      // 3. Under the lock, the one-dog cancel's refusals in its order.
      if (row.status === 'cancelled' || share.expiredAt !== null) {
        throw new ApiError('session_cancelled', `dog ${dogId}'s session ${id} is cancelled`);
      }
      if (row.status === 'payment-pending') {
        throw new ApiError(
          'payment_pending',
          `booking ${id} waits on its top-up's charge: its after-school cannot change yet`,
        );
      }
      if (dayHasEnded(row, await pickupCloseByCampus(tx), now)) {
        throw sessionEndedError(id, sessionDate(row.scheduledAt));
      }
      const states = statesByDog(await checkinEventsRepository.findForBookings(tx, [id]));
      if ((states.get(dogId) ?? 'expected') !== 'expected') throw sessionCheckedInError(id, dogId);

      // 4. Her place, freed. Already off: nothing to write.
      if (share.afterSchool) {
        await bookingsRepository.clearAfterSchool(tx, { bookingId: id, dogId });
      }
      return { wire: await wireOne(tx, id, now), location };
    }),
  );
}

/** The 404 collapse: not found, expired, or not hers are one answer (no enumeration). */
function assertHers(
  row: BookingFullRow | undefined,
  id: string,
  ownerId: string,
): asserts row is BookingFullRow {
  if (row === undefined || row.expiredAt !== null || row.ownerId !== ownerId) {
    throw new ApiError('not_found', `booking ${id} not found`);
  }
}

function notOnIt(id: string, dogId: string): ApiError {
  return new ApiError('not_found', `dog ${dogId} is not on booking ${id}`);
}

/** The session as the owner reads it now, in this transaction (it sees its own write). */
async function wireOne(tx: Tx, id: string, now: Date): Promise<BookingWire> {
  const row = await bookingsRepository.findFullByIdInTx(tx, id);
  if (row === undefined) throw new Error(`after-school removal ${id}: row vanished under its lock`);
  const [wire] = await wireManyBookings([row], { now, viewer: 'owner', runner: tx });
  if (wire === undefined)
    throw new Error(`after-school removal ${id}: wire assembly returned no row`);
  return wire;
}
