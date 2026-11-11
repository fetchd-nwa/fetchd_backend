import type { AttendanceWire, CheckinEventWire } from '../contracts/wire.js';
import { lockPools } from '../db/locks.js';
import { bookingsRepository, type BookingFullRow } from '../db/repositories/bookingsRepository.js';
import {
  checkinEventsRepository,
  type CheckinEventRow,
} from '../db/repositories/checkinEventsRepository.js';
import {
  creditLedgerRepository,
  findPayableLots,
  findReturnsByEvent,
  findWrittenByEvent,
  type CreditPool,
} from '../db/repositories/creditLedgerRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import { sessionEndTime } from './bookingBucket.js';
import { foldCheckinLog, SETTLING_KINDS, type FoldedShare } from './checkinFold.js';
import { bucketChicagoToday } from './chicagoDate.js';
import { isDayProgram, sessionDate } from './dayCancel.js';
import { ApiError } from './errors.js';
import type { NoticeLog } from './noticeInSavepoint.js';
import { noLiveDebit, noticeCreditReturned } from './orderRows.js';
import { pgTimestampToIso } from './pgTimestamp.js';
import { settleDayShare } from './settleDayShare.js';

/**
 * The board's six verbs, each one transaction inside the route's `withMutation`, after
 * the claim, so every refusal with a clock in it is replay-safe (DECISIONS 128(a)):
 * S29's `check-in`, `check-out` and `undo`, and S30's settling `turn-away`, `send-home` and
 * `no-show` (*Didn't come*). Design §2.3:2354-2405, :2477-2557; P20 notes D4, D11-D17.
 *
 * Every verb takes the booking row first (`lockById`, FOR UPDATE), which is what makes
 * `seq` append order and serialises every write on one share; then the dog row for her
 * clock (`no key update`); then the pool for a ledger write (`db/locks.ts`). Refusals, in
 * this order (D12): 404, 422 for a session that is not a day program, 409
 * `session_cancelled`, `payment_pending`, `session_not_today`, `no_show_too_early`,
 * `attendance_state_conflict`, then the re-check-in's 422. A refused verb appends nothing
 * and moves no credit. Each answers the dog's folded state and her whole log on the
 * booking (`AttendanceWire`, D11). A share holds at most one settling event (M5.02's
 * partial unique index), and the state check refuses a second one before the index does.
 *
 * A verb that moves a credit writes at most one ledger row, after its event, and that row
 * names the event in `checkin_event_id` (M5.10, P20 fix 1). What an event wrote is read by
 * that link alone, never by equal `created_at` stamps (designs/p20-event-ledger-link.md).
 */

export interface VerbArgs {
  bookingId: string;
  dogId: string;
  staffId: string;
  /** The route's clock: the event's `at`, the date predicate, a fresh lot's date. */
  now: Date;
  log: NoticeLog;
}

/** What a verb did beyond the log, for the route's post-commit cache wipe. */
export interface VerbResult {
  body: AttendanceWire;
  /** The owner whose credits moved, if any did. */
  creditsOwnerId?: string;
  /** The campus whose seat a turn-away freed: its `avail:{location}:*` goes. */
  seatFreedAt?: string;
}

interface OpenShare {
  booking: BookingFullRow;
  events: CheckinEventRow[];
  folded: FoldedShare<CheckinEventRow>;
  date: string;
  today: string;
}

/** The lock, the share and every refusal before the state's. */
async function openShare(
  tx: Tx,
  args: VerbArgs,
  dates: 'today' | 'today-or-earlier',
): Promise<OpenShare> {
  const booking = await bookingsRepository.lockById(tx, args.bookingId);
  if (booking === undefined || booking.expiredAt !== null) {
    throw new ApiError('not_found', `booking ${args.bookingId} not found`);
  }
  const share = await bookingsRepository.findShareInTx(tx, args.bookingId, args.dogId);
  if (share === undefined) {
    throw new ApiError('not_found', `dog ${args.dogId} is not on booking ${args.bookingId}`);
  }
  if (!isDayProgram(booking.category)) {
    throw new ApiError(
      'invalid_payload',
      `booking ${args.bookingId} is not a day-school or day-care session`,
    );
  }
  if (booking.status === 'cancelled' || share.expiredAt !== null) {
    throw new ApiError(
      'session_cancelled',
      `dog ${args.dogId}'s session ${args.bookingId} is cancelled`,
    );
  }
  if (booking.status === 'payment-pending') {
    throw new ApiError('payment_pending', `booking ${args.bookingId} waits on its top-up's charge`);
  }
  const date = sessionDate(booking.scheduledAt);
  const today = bucketChicagoToday(args.now);
  if (dates === 'today' ? date !== today : date > today) {
    throw new ApiError('session_not_today', `booking ${args.bookingId} is dated ${date}`, {
      kind: 'session_not_today',
      date,
    });
  }
  const events = await checkinEventsRepository.findForShare(tx, args.bookingId, args.dogId);
  return { booking, events, folded: foldCheckinLog(events), date, today };
}

function stateConflict(state: FoldedShare<CheckinEventRow>['state']): ApiError {
  return new ApiError('attendance_state_conflict', `the dog's state is ${state}`, {
    kind: 'attendance_state_conflict',
    state,
  });
}

/**
 * `check-in`: from `expected`, any time on the session's date, a lapsed gate included; or
 * from `out` on that date while the share holds no settling event (the vet, s10). A
 * re-check-in debits nothing, unless the check-out it reopens re-issued the credit: then
 * one `booking-debit` goes back ({@link redebitLot}), naming this check-in, and with no
 * lot to take it 422 `insufficient_credits` with no `details` (D16). The lot is chosen and
 * the 422 raised before anything is written; the event is appended first and its debit
 * after, since the debit names it. The check-in moves `dogs.last_seen_on` to the later of
 * its value and the session's date (always, until S14 dates EVAL-U12) and records what it
 * did.
 */
export async function checkInInTx(tx: Tx, args: VerbArgs): Promise<VerbResult> {
  const share = await openShare(tx, args, 'today');
  const { state, settled, undoTarget } = share.folded;
  const reopening = state === 'out' && !settled;
  if (state !== 'expected' && !reopening) throw stateConflict(state);

  const clock = await checkinEventsRepository.lockDogClock(tx, args.dogId);
  if (clock === undefined) throw new Error(`dog ${args.dogId} has no row to stamp`);

  const redebit =
    reopening && undoTarget !== undefined
      ? await redebitLot(tx, undoTarget, share.date)
      : undefined;

  const moved = clock.lastSeenOn === null || share.date > clock.lastSeenOn;
  if (moved) await checkinEventsRepository.setDogClock(tx, args.dogId, share.date);
  const event = await checkinEventsRepository.append(tx, {
    bookingId: args.bookingId,
    dogId: args.dogId,
    kind: 'check-in',
    at: args.now,
    byStaffId: args.staffId,
    lastSeenMoved: moved,
    lastSeenPrior: moved ? clock.lastSeenOn : null,
  });
  if (redebit !== undefined) {
    await creditLedgerRepository.debitLot(tx, {
      ...redebit.pool,
      lotId: redebit.lotId,
      dogId: args.dogId,
      bookingId: args.bookingId,
      checkinEventId: event.id,
    });
  }
  return {
    body: await attendanceOf(tx, args),
    ...(redebit !== undefined ? { creditsOwnerId: redebit.pool.ownerId } : {}),
  };
}

/**
 * The lot a re-check-in's re-debit takes, or nothing when the check-out it reopens
 * returned nothing (no return names that event). Takes the pool lock, after the dog row's.
 *
 * §10 (designs/p20-event-ledger-link.md; DECISIONS 256(b), 258): the re-debit is the
 * reversal of the return that check-out wrote, not a new payment. So it goes to the lot the
 * return went to (the debit's own, or the fresh lot the return is) whenever that lot still
 * holds the credit ({@link returnLotHolds}), whatever its date or the expiry switches say
 * now: the lot already paid this share's date once, and the pair leaves it exactly where
 * it stood before the check-out, so the day costs its one credit (design.md:2384), at
 * `cred.returned_credit_expiry_months` 0 too. That makes this the one writer that may debit
 * a dead lot; every other writer reads live lots (§10 (a)). Only when the credit has gone
 * from that lot (spent on another day, or removed by hand) does it fall back, to the
 * soonest-expiring lot that is live now and pays the date: a new payment must be a credit
 * she could still spend. With none, 422 `insufficient_credits` (D16).
 */
async function redebitLot(
  tx: Tx,
  reopened: CheckinEventRow,
  date: string,
): Promise<{ pool: CreditPool; lotId: string } | undefined> {
  const [returned] = (await findWrittenByEvent(tx, reopened.id)).filter(
    (row) => row.reason === 'settlement-return',
  );
  if (returned === undefined) return undefined;
  const pool: CreditPool = {
    ownerId: returned.ownerId,
    location: returned.location,
    mode: returned.mode,
    tier: returned.tier,
  };
  await lockPools(tx, [pool]);
  const wentTo = returned.lotId ?? returned.id;
  if (await returnLotHolds(tx, wentTo)) return { pool, lotId: wentTo };
  const [lot] = (await findPayableLots(tx, pool, [date])).filter((l) => l.paysDates.includes(date));
  if (lot === undefined) {
    throw new ApiError(
      'insufficient_credits',
      'her credit went back at the check-out and no credit is live today: sell a single day first',
    );
  }
  return { pool, lotId: lot.id };
}

/**
 * Does the lot a return went to still hold that credit? Its unspent count under the pool
 * lock (the grant plus every allocation, live or not): a later booking that spent it, or a
 * hand removal, takes it to 0. Nothing here reads the lot's date (§10).
 */
async function returnLotHolds(tx: Tx, lotId: string): Promise<boolean> {
  return (await creditLedgerRepository.lotUnspentInTx(tx, lotId)) > 0;
}

/**
 * `check-out {note?, reissue_credit?}`: from `in` or `sent-home` (D4), on the session's
 * date or later. The *Re-issue the credit* box is staff's call at the door (s09, s10;
 * answer 12: unticked by default, the credit stays used), and only from `in`: a sent-home
 * dog's credit was decided at the send-home. Ticked, the share's live debit comes back
 * through the one return writer and the owner's "was picked up early" notice is queued;
 * unticked, nothing is written but the event and nothing is sent. A check-out is never
 * settling: a later re-check-in takes a re-issued credit back.
 */
export async function checkOutInTx(
  tx: Tx,
  args: VerbArgs & { note?: string; reissueCredit: boolean },
): Promise<VerbResult> {
  const share = await openShare(tx, args, 'today-or-earlier');
  const { state } = share.folded;
  if (state !== 'in' && state !== 'sent-home') throw stateConflict(state);
  if (args.reissueCredit && state !== 'in') throw stateConflict(state);

  const event = await checkinEventsRepository.append(tx, {
    bookingId: args.bookingId,
    dogId: args.dogId,
    kind: 'check-out',
    at: args.now,
    byStaffId: args.staffId,
    reissueCredit: args.reissueCredit,
    ...(args.note !== undefined ? { note: args.note } : {}),
  });
  if (!args.reissueCredit) return { body: await attendanceOf(tx, args) };

  const [debit] = await creditLedgerRepository.findLiveDebits(tx, {
    bookingId: args.bookingId,
    dogId: args.dogId,
  });
  if (debit === undefined) throw noLiveDebit(args.log, args);
  await lockPools(tx, [debit]);
  const returned = await creditLedgerRepository.refundForBooking(tx, {
    ...debit,
    now: args.now,
    checkinEventId: event.id,
  });
  await noticeCreditReturned(tx, {
    bookingId: args.bookingId,
    ownerId: share.booking.ownerId,
    dogId: args.dogId,
    returnId: returned.id,
    who: { kind: 'staff-return', event: 'picked-up-early', eventId: event.id },
    log: args.log,
  });
  return { body: await attendanceOf(tx, args), creditsOwnerId: debit.ownerId };
}

/**
 * `undo`: names the newest live event (not an undo, not already undone) and removes it
 * from the fold. Refused 409 `attendance_state_conflict {state}` when there is none, when
 * it is settling, and when it moved a credit, a check-out that re-issued it or a
 * re-check-in that took it back: that reversal is a hand edit on the role list
 * (CRED-U14). The undo of a check-in that moved `last_seen_on` recomputes it under the dog
 * row's lock from the log alone (`checkinEventsRepository.recomputeDogClock`), so check
 * in, check out, undo, undo ends at `expected` with the clock where it was.
 */
export async function undoInTx(tx: Tx, args: VerbArgs): Promise<VerbResult> {
  const share = await openShare(tx, args, 'today-or-earlier');
  const { state, undoTarget } = share.folded;
  if (undoTarget === undefined || SETTLING_KINDS.has(undoTarget.kind)) throw stateConflict(state);
  if ((await findWrittenByEvent(tx, undoTarget.id)).length > 0) throw stateConflict(state);

  const recomputesClock = undoTarget.kind === 'check-in' && undoTarget.lastSeenMoved;
  if (recomputesClock) await checkinEventsRepository.lockDogClock(tx, args.dogId);
  await checkinEventsRepository.append(tx, {
    bookingId: args.bookingId,
    dogId: args.dogId,
    kind: 'undo',
    at: args.now,
    byStaffId: args.staffId,
    undoesEventId: undoTarget.id,
  });
  if (recomputesClock) {
    await checkinEventsRepository.setDogClock(
      tx,
      args.dogId,
      await checkinEventsRepository.recomputeDogClock(tx, args.dogId),
    );
  }
  return { body: await attendanceOf(tx, args) };
}

/**
 * `turn-away` (no body): the session's date is today and the dog is `expected`. Not a
 * check-in: it never moves `last_seen_on`. Her seat is free for the rest of the day
 * (`dayCapacityRepository` counts no turned-away share), and her credit comes back
 * (`settleDayShare`). The door decides (DAY-05, DAY-74): a lapsed gate is the usual
 * reason. It cannot be undone; in M1 a mistaken one is a hand edit and a call (Q1).
 */
export async function turnAwayInTx(tx: Tx, args: VerbArgs): Promise<VerbResult> {
  const share = await openShare(tx, args, 'today');
  if (share.folded.state !== 'expected') throw stateConflict(share.folded.state);
  const event = await checkinEventsRepository.append(tx, {
    bookingId: args.bookingId,
    dogId: args.dogId,
    kind: 'turn-away',
    at: args.now,
    byStaffId: args.staffId,
  });
  const settled = await settleDayShare(tx, {
    ...args,
    ownerId: share.booking.ownerId,
    event: { id: event.id, kind: 'turn-away', trainingCompleted: false },
  });
  return {
    body: await attendanceOf(tx, args),
    ...settled,
    ...(share.booking.location !== null ? { seatFreedAt: share.booking.location } : {}),
  };
}

/**
 * `send-home {training_completed?}`: the session's date is today and the dog is `in`.
 * *Finished training day* is staff's call (s09: "a dog left at 3 pm is much different than
 * a dog leaving at 11 am"), unticked by default, and unticked the credit comes back. Either
 * way she folds `sent-home`, which is on site: she stays on the board, is flagged at
 * `day.late_pickup_call_time` if still there, and leaves by `check-out`, which can no
 * longer re-issue anything (D4).
 */
export async function sendHomeInTx(
  tx: Tx,
  args: VerbArgs & { trainingCompleted: boolean },
): Promise<VerbResult> {
  const share = await openShare(tx, args, 'today');
  if (share.folded.state !== 'in') throw stateConflict(share.folded.state);
  const event = await checkinEventsRepository.append(tx, {
    bookingId: args.bookingId,
    dogId: args.dogId,
    kind: 'sent-home',
    at: args.now,
    byStaffId: args.staffId,
    trainingCompleted: args.trainingCompleted,
  });
  const settled = await settleDayShare(tx, {
    ...args,
    ownerId: share.booking.ownerId,
    event: { id: event.id, kind: 'sent-home', trainingCompleted: args.trainingCompleted },
  });
  return { body: await attendanceOf(tx, args), ...settled };
}

/**
 * `no-show`, the board's *Didn't come* (no body): the session's date is today or earlier,
 * and Chicago now is at or past the campus's `day.pickup_close_time` on that date (409
 * `no_show_too_early {recordable_from}` before it; question 48), and the dog is
 * `expected`. A day nobody recorded is settled on its own date's board this way. Her credit
 * comes back: no true penalty for a no-show (Shanthi, 12- #10).
 */
export async function noShowInTx(tx: Tx, args: VerbArgs): Promise<VerbResult> {
  const share = await openShare(tx, args, 'today-or-earlier');
  const campuses = await settingsRepository.dayCampuses(tx);
  const recordableFrom = sessionEndTime(
    share.booking,
    new Map(campuses.map((c) => [c.location, c.pickup_close_time])),
  );
  if (recordableFrom !== null && args.now.getTime() < recordableFrom.getTime()) {
    throw new ApiError(
      'no_show_too_early',
      `Didn't come opens at ${recordableFrom.toISOString()}`,
      { kind: 'no_show_too_early', recordable_from: recordableFrom.toISOString() },
    );
  }
  if (share.folded.state !== 'expected') throw stateConflict(share.folded.state);
  const event = await checkinEventsRepository.append(tx, {
    bookingId: args.bookingId,
    dogId: args.dogId,
    kind: 'no-show',
    at: args.now,
    byStaffId: args.staffId,
  });
  const settled = await settleDayShare(tx, {
    ...args,
    ownerId: share.booking.ownerId,
    event: { id: event.id, kind: 'no-show', trainingCompleted: false },
  });
  return { body: await attendanceOf(tx, args), ...settled };
}

/** The dog's state and her whole log on the booking, read in the verb's transaction. */
async function attendanceOf(
  tx: Tx,
  args: { bookingId: string; dogId: string },
): Promise<AttendanceWire> {
  const events = await checkinEventsRepository.findForShare(tx, args.bookingId, args.dogId);
  const returned = await returnedCreditsByEvent(tx, [args.bookingId]);
  return {
    status: foldCheckinLog(events).state,
    events: events.map((e) => toCheckinEventWire(e, returned)),
  };
}

/** Each event's returned credits, keyed by the event the returns name (M5.10's link). */
export async function returnedCreditsByEvent(
  runner: Parameters<typeof findReturnsByEvent>[0],
  bookingIds: readonly string[],
): Promise<Map<string, number>> {
  const returns = await findReturnsByEvent(runner, bookingIds);
  return new Map(returns.map((r) => [r.eventId, r.credits]));
}

/**
 * One event on the wire. `settlement` rides each settling event and a check-out that
 * ticked *Re-issue the credit*, and reports what that event's own transaction returned
 * (D15), never today's fractions.
 */
export function toCheckinEventWire(
  event: CheckinEventRow,
  returnedByEvent: ReadonlyMap<string, number>,
): CheckinEventWire {
  const wire: CheckinEventWire = {
    id: event.id,
    booking_id: event.bookingId,
    dog_id: event.dogId,
    kind: event.kind,
    at: pgTimestampToIso(event.at),
    by_staff_id: event.byStaffId,
  };
  if (event.undoesEventId !== null) wire.undoes_event_id = event.undoesEventId;
  if (event.trainingCompleted !== null) wire.training_completed = event.trainingCompleted;
  if (event.reissueCredit !== null) wire.reissue_credit = event.reissueCredit;
  if (event.note !== null) wire.note = event.note;
  if (
    SETTLING_KINDS.has(event.kind) ||
    (event.kind === 'check-out' && event.reissueCredit === true)
  ) {
    wire.settlement = { returned_credits: returnedByEvent.get(event.id) ?? 0 };
  }
  return wire;
}
