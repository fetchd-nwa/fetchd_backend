import { db } from '../db/client.js';
import { lockCharge, lockPools } from '../db/locks.js';
import { bookingsRepository, type BookingFullRow } from '../db/repositories/bookingsRepository.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { checkinEventsRepository } from '../db/repositories/checkinEventsRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import { groupBookingDogs, type BookingWire } from './bookingWire.js';
import { askWhatWon, cancelOrderInTx, type WhatWon } from './cancelOrder.js';
import { readEngineBudget, type EngineLog } from './confirmCharge.js';
import {
  dayHasEnded,
  isDayProgram,
  pickupCloseByCampus,
  refuseDayCancel,
  sessionCheckedInError,
  sessionDate,
  sessionEndedError,
  statesByDog,
} from './dayCancel.js';
import { ApiError } from './errors.js';
import {
  noLiveDebit,
  noticeBookingCancelled,
  noticeCreditReturned,
  returnDebitsToLots,
  tearDownBookingReminders,
} from './orderRows.js';
import {
  logUnroutableRefundMint,
  type PendingStripeRefund,
  type UnroutableRefundMint,
} from './pendingRefund.js';
import { pgTimestampToIso } from './pgTimestamp.js';
import type { StripeClient } from './stripe.js';
import { wireManyBookings } from './wireManyBookings.js';

export type { PendingStripeRefund };

export interface CancelBookingResult {
  wire: BookingWire;
  /**
   * Set on the money-back branch; the caller fires the actual Stripe
   * refund post-commit (the route owns the `withMutation.postCommit`
   * seam). Undefined for forfeit / credit-back / free-service paths.
   */
  pendingStripeRefund?: PendingStripeRefund;
  /**
   * Set INSTEAD of `pendingStripeRefund` when the money-back branch found a
   * charge with no `stripe_payment_intent_id` — pre-Stripe-wire money the
   * school owes back through a channel no code here can reach (design §4). The
   * row is written TERMINAL at `'unroutable'`.
   *
   * Returned for the CALLER'S information only. The announcement is NOT the
   * caller's job: it is emitted in-transaction at the mint below, and this
   * field must never become the thing an alarm depends on again — see the
   * comment there.
   */
  unroutableRefund?: UnroutableRefundMint;
  /**
   * The owner credited back on this cancel. The route wipes her `credits:{ownerId}:*`
   * display cache post-commit. Absent on every non-credit-back path (forfeit / money-back
   * / free).
   */
  creditRefundedOwnerId?: string;
}

/**
 * The shared cancel transaction (schema.sql `cancelBooking` contract,
 * line ~1491). Both the owner self-cancel (`POST /bookings/:id/cancel`)
 * and the Day-19 staff-portal cancel (`POST /staff/bookings/:id/cancel`)
 * run this identical body — same forfeit rule (`now > cancel_deadline_at`,
 * resolved in SQL against the caller's `now`), same credit-back /
 * money-back / forfeit branching, same booking-cancelled notification to
 * the booking's owner. The schema pins the cancel as owner-OR-staff
 * authorized with no separate staff refund policy, so there is exactly
 * one transaction.
 *
 * The only caller difference is ownership scope:
 *   - owner route passes `requireOwnerId = principal.ownerId` → a
 *     cross-owner id collapses to 404 (no enumeration).
 *   - staff route passes `requireOwnerId = null` → cross-owner by design
 *     (`requireStaff` already gated the route).
 *
 * `now` is required and threads through BOTH time-sensitive decisions in
 * this transaction — the forfeit check and the credit-lot re-mint. One
 * instant per cancel: a cancel that is in-window for the refund must not
 * be able to be out-of-window for the lot expiry it writes.
 *
 * The Stripe refund API call is NOT made here; the money-back branch
 * returns a `pendingStripeRefund` handle the route fires after commit.
 */
export async function cancelBookingInTx(
  tx: Tx,
  args: {
    id: string;
    requireOwnerId: string | null;
    /** WHO cancelled — 'owner' (self-cancel) or 'staff' (the school). R5. */
    cancelledBy: 'owner' | 'staff';
    /** Optional staff-supplied reason line; owner self-cancels omit it. */
    cancelReason?: string;
    /** The cancel instant — the route's `nowFactory()`, never a fresh wall clock. */
    now: Date;
    /**
     * The EXACT Stripe idempotency key the route's post-commit `createRefund`
     * will send (`` `${request Idempotency-Key}:refund` ``), stored on the
     * refunds row in THIS transaction (design §2.1).
     *
     * Required, and required of both routes: the key lives only in the request
     * closure, so if the row does not carry it, a `createRefund` that fails
     * post-commit can never be retried by anything and the owner's money simply
     * does not come back. Passing it down is what makes the sweep possible.
     */
    stripeIdempotencyKey: string;
    /**
     * Where the `'unroutable'` mint announces itself. Required, because that
     * announcement is the ONLY surface a terminal unroutable refund ever gets
     * (see the mint below) and a default no-op logger would make losing it a
     * silent, one-argument mistake.
     */
    log: EngineLog;
    /**
     * What Stripe said about this row's pending order, asked by the route with no
     * transaction open ({@link askWhatWonForPendingRow}). `undefined` on any other row.
     */
    whatWon?: WhatWon | undefined;
  },
): Promise<CancelBookingResult> {
  const { id, requireOwnerId, cancelledBy, cancelReason, now, stripeIdempotencyKey, log } = args;

  // 1. Refusals that write nothing, on a plain read: the 404 collapses not-found,
  //    expired and (owner route only) not-yours into one response, and the class
  //    refusal runs first for every booking-level cancel, owner or staff, pending or
  //    not (design §2.7:4007-4009).
  const seen = await bookingsRepository.findFullByIdInTx(tx, id);
  assertCancellable(seen, id, requireOwnerId);

  // 2. The lock order: charge, then the row, then the pool (`db/locks.ts`). A row whose
  //    order has a charge takes the charge first, so two cancels of one order, and a
  //    cancel against a settle, serialise there. Today's plain rows have no order and
  //    lock only themselves.
  if (seen.orderId !== null) {
    const charge = await chargesRepository.findEngineByOrderId(tx, seen.orderId);
    if (charge !== undefined) await lockCharge(tx, charge.id);
  }
  const row = await bookingsRepository.lockById(tx, id);
  assertCancellable(row, id, requireOwnerId);
  if (row.status === 'cancelled') {
    throw new ApiError('conflict', `booking ${id} is already cancelled`);
  }

  // 3. A pending row cancels the whole order, and a per-session cancel exists only
  //    once the rows are `upcoming`. A row that was pending when the route asked and
  //    has since settled falls through to the ordinary cancel below.
  if (row.status === 'payment-pending') {
    if (row.orderId === null || args.whatWon === undefined) {
      throw new Error(`booking ${id} is payment-pending and nothing asked Stripe about it`);
    }
    const cancelled = await cancelOrderInTx(tx, {
      orderId: row.orderId,
      whatWon: args.whatWon,
      cancelledBy,
      ...(cancelReason !== undefined ? { cancelReason } : {}),
      log,
      now,
    });
    return {
      wire: await wireOne(tx, id, { now, viewer: viewerOf(requireOwnerId) }),
      pendingStripeRefund: cancelled.act.pendingStripeRefund,
      ...(cancelled.cancelled?.creditRefundedOwnerId !== undefined
        ? { creditRefundedOwnerId: cancelled.cancelled.creditRefundedOwnerId }
        : {}),
    };
  }

  // 3b. A day session (CXL-U09, D12): once its day has ended it is settled only by
  //     *Didn't come* or a hand credit, and while any dog still on it has folded past
  //     `expected` it is the board's (an undone check-in does not count).
  const liveDogIds = isDayProgram(row.category) ? await refuseDayCancel(tx, row, now) : [];

  // 4. Soft-cancel. `cancelForfeited` is computed in SQL against the
  //    stamped `cancel_deadline_at` and the caller's `now`; the resolved
  //    value lands on commit.
  //    `cancelledBy` + `cancelReason` (R5) record WHO/WHY for the banner.
  await bookingsRepository.markCancelled(tx, { id, cancelledBy, cancelReason, now });

  // 5. Re-read so the refund branch reads the resolved `cancelForfeited`
  //    (not the pre-update snapshot).
  const updated = await bookingsRepository.findFullByIdInTx(tx, id);
  if (updated === undefined) {
    throw new Error(`cancelBooking ${id}: row vanished after mark-cancelled`);
  }

  // 6. Refund branching — within the cancel window only.
  let pendingStripeRefund: PendingStripeRefund | undefined;
  let unroutableRefund: UnroutableRefundMint | undefined;
  let creditRefundedOwnerId: string | undefined;
  if (!updated.cancelForfeited) {
    // CREDIT-BACK: one +1 `settlement-return` per live debit, routed back to the lot it
    // drew from. `now` is the caller's cancel instant, so the lot the refund lands in
    // is dated by the same clock the forfeit check used. A day session's every live
    // share must hold one (design §2.3:2502-2505), or the cancel is a 500 and an alarm.
    creditRefundedOwnerId = isDayProgram(row.category)
      ? await returnDayShares(tx, { bookingId: id, liveDogIds, now, log })
      : await returnDebitsToLots(tx, { bookingIds: [id], now });
    if (creditRefundedOwnerId === undefined) {
      const charge = await chargesRepository.findSucceededForBooking(tx, id);
      if (charge !== undefined) {
        // MONEY-BACK: refunds row at 'pending'; cumulative-refund rule
        // (refunds ≤ charge) enforced API-side. Stripe call fires
        // post-commit via the returned handle.
        // Capped under the charge row's LOCK, through the one shared helper
        // (§A3.18 D2) — R9's cap is a read-modify-write, and an unlocked one
        // was measured double-refunding a charge across two overlapping
        // transactions. The helper REFUSES a charge with no PaymentIntent
        // rather than minting a 'pending' row nothing could ever send, and
        // hands back the cap so the unroutable branch below can record the
        // obligation under that same lock.
        const minted = await refundsRepository.mintCappedPendingRefund(tx, {
          chargeId: charge.id,
          ownerId: row.ownerId,
          bookingId: id,
          reason: 'cancel',
          // Stored in the SAME tx as the row, so the retry sweep can send
          // exactly what the post-commit fire sends — a replay, never a
          // second refund. The client's key, so the row id is ignored.
          stripeIdempotencyKey: () => stripeIdempotencyKey,
        });
        if (minted.kind !== 'nothing-to-refund') {
          const maxRefund = minted.amountCents;
          if (minted.kind === 'minted') {
            pendingStripeRefund = {
              refundId: minted.refundId,
              paymentIntentId: minted.paymentIntentId,
              amountCents: minted.amountCents,
              stripeIdempotencyKey: minted.stripeIdempotencyKey,
            };
          } else {
            // Charges with NULL stripe_payment_intent_id are pre-Stripe-wire
            // seeds. The refunds row still records the obligation, but there is
            // no PaymentIntent to reverse and there never will be, so it is
            // written TERMINAL rather than 'pending' (design §4): a 'pending'
            // row here meant a worklist entry no sweep could send and no
            // webhook could close, re-shouted on every process restart forever.
            const refund = await refundsRepository.createUnroutable(tx, {
              ownerId: row.ownerId,
              chargeId: charge.id,
              bookingId: id,
              amountCents: maxRefund,
              reason: 'cancel',
            });
            unroutableRefund = {
              refundId: refund.id,
              ownerId: row.ownerId,
              chargeId: charge.id,
              amountCents: maxRefund,
            };
            // ANNOUNCED HERE, IN-TRANSACTION, and never from the route's
            // post-commit seam (adversary panel, 2026-08-20 — proven on :5433).
            //
            // An `'unroutable'` row is TERMINAL at birth, so it appears in no
            // worklist by design: `markUnroutable` requires `status='pending'`
            // and `findAbandonedPending` excludes it. This log line is its
            // ONLY surface, ever. Announcing it post-commit lost it outright on
            // the crash-then-replay arc — a request whose response the client
            // never saw commits the row, then the client retries the same
            // Idempotency-Key, `withMutation` replays the stored response and
            // SKIPS `postCommit` entirely (`db/mutation.ts` — the whole
            // post-commit block is gated on `!outcome.replayed`), which also
            // swallows anything thrown. Result: money owed, recorded, and
            // announced nowhere. Permanently.
            //
            // The cost of moving it here is a false alarm if this transaction
            // later rolls back — an ERROR about a row that does not exist. That
            // failure is loud and recoverable by looking; the one it replaces
            // is silent and permanent. Wrong direction traded for right one.
            logUnroutableRefundMint(log, unroutableRefund, {
              bookingId: id,
              cancelledBy,
            });
          }
        }
      }
    }
  }
  // Forfeited branch: no refund of any kind.

  // 7. booking-cancelled notification to the booking's owner (dog chips
  //    resolved from booking_dogs), in its own savepoint: a notice never un-records
  //    the credit or the refund above.
  await noticeBookingCancelled(tx, {
    bookingId: id,
    ownerId: row.ownerId,
    category: row.category,
    scheduledAt: row.scheduledAt,
    forfeited: updated.cancelForfeited,
    log,
  });

  await tearDownBookingReminders(tx, id);

  // 8. Wire the updated row for the response.
  return {
    wire: await wireOne(tx, id, { now, viewer: viewerOf(requireOwnerId) }),
    pendingStripeRefund,
    unroutableRefund,
    ...(creditRefundedOwnerId !== undefined ? { creditRefundedOwnerId } : {}),
  };
}

/** The 404 collapse and the class refusal, before the lock and again under it. */
function assertCancellable<
  Row extends { expiredAt: string | null; ownerId: string; category: string },
>(row: Row | undefined, id: string, requireOwnerId: string | null): asserts row is Row {
  if (
    row === undefined ||
    row.expiredAt !== null ||
    (requireOwnerId !== null && row.ownerId !== requireOwnerId)
  ) {
    throw new ApiError('not_found', `booking ${id} not found`);
  }
  if (row.category === 'group-class') {
    throw new ApiError(
      'invalid_payload',
      'group-class bookings cancel via cohort withdraw — not yet implemented',
    );
  }
}

function viewerOf(requireOwnerId: string | null): 'owner' | 'staff' {
  return requireOwnerId === null ? 'staff' : 'owner';
}

/**
 * A day session's credits back, one per dog still on it, each through the one return
 * writer to the lot its live debit drew from. A live share with no live debit is the
 * alarm (design §2.3:2502-2505), never "moves nothing". Answers the owner credited.
 */
async function returnDayShares(
  tx: Tx,
  args: { bookingId: string; liveDogIds: readonly string[]; now: Date; log: EngineLog },
): Promise<string | undefined> {
  const debits = await creditLedgerRepository.findLiveDebits(tx, { bookingId: args.bookingId });
  const owed = args.liveDogIds.map((dogId) => {
    const debit = debits.find((d) => d.dogId === dogId);
    if (debit === undefined) throw noLiveDebit(args.log, { bookingId: args.bookingId, dogId });
    return debit;
  });
  await lockPools(tx, owed);
  for (const debit of owed) {
    // A cancel's return names no check-in event (M5.10's link is the board verbs').
    await creditLedgerRepository.refundForBooking(tx, {
      ...debit,
      now: args.now,
      checkinEventId: null,
    });
  }
  return owed[0]?.ownerId;
}

async function wireOne(
  tx: Tx,
  id: string,
  context: { now: Date; viewer: 'owner' | 'staff' },
): Promise<BookingWire> {
  const updated = await bookingsRepository.findFullByIdInTx(tx, id);
  if (updated === undefined) {
    throw new Error(`cancelBooking ${id}: row vanished after mark-cancelled`);
  }
  const [wire] = await wireManyBookings([updated], { ...context, runner: tx });
  if (wire === undefined) {
    throw new Error(`cancelBooking ${id}: wire assembly returned no row`);
  }
  return wire;
}

/**
 * The half of a pending row's cancel that runs BEFORE the transaction: ask Stripe what
 * won, with none open (R5). `undefined` for every row that is not pending, so an ordinary
 * cancel asks Stripe nothing. A row this request may not touch is left to the
 * transaction's own 404, unasked.
 */
export async function askWhatWonForPendingRow(args: {
  id: string;
  requireOwnerId: string | null;
  stripe: Pick<StripeClient, 'retrievePaymentIntent' | 'cancelPaymentIntent'>;
}): Promise<WhatWon | undefined> {
  const row = await bookingsRepository.findFullByIdInTx(db, args.id);
  if (row === undefined || row.status !== 'payment-pending' || row.orderId === null) {
    return undefined;
  }
  if (args.requireOwnerId !== null && row.ownerId !== args.requireOwnerId) return undefined;
  const charge = await chargesRepository.findEngineByOrderId(db, row.orderId);
  if (charge === undefined) return undefined;
  return askWhatWon({ charge, stripe: args.stripe, budget: await readEngineBudget() });
}

export interface CancelOneDogResult {
  wire: BookingWire;
  /** The owner credited back: the route wipes her balance cache post-commit. */
  creditRefundedOwnerId: string;
  /** The session's campus: her seat is free, so the route wipes `avail:{location}:*`. */
  location: string | null;
}

/**
 * One dog of several (s11; CXL-U09; design §1.1:1068-1075, §2.3:2429-2447; P20 notes D3,
 * D12-D14, D21): the owner's `POST /bookings/:id/dogs/:dogId/cancel` and the staff's
 * `POST /staff/bookings/:id/dogs/:dogId/cancel`, one transaction. It takes the same locks
 * in the same order as {@link cancelBookingInTx} (the order's charge on a top-up day,
 * then the row, then the pool), refuses in D12's order, then stamps her share cancelled
 * (her seat is free), returns her one live debit through the one return writer to the lot
 * it drew from (into the owner's pool, the family's, never the dog's), and queues the
 * owner's notice naming her alone. When she is the last dog still on it the session goes
 * with her, `cancelled` in this transaction with its reminders torn down, and she keeps
 * her share, so a cancelled session always has a dog (D3); while another dog stays, a
 * queued reminder that named her names the dog who leads now. It always returns the
 * credit: no window and no forfeit (D21).
 */
export async function cancelOneDogInTx(
  tx: Tx,
  args: {
    id: string;
    dogId: string;
    requireOwnerId: string | null;
    cancelledBy: 'owner' | 'staff';
    now: Date;
    log: EngineLog;
  },
): Promise<CancelOneDogResult> {
  const { id, dogId, requireOwnerId, now, log } = args;

  // 1. On a plain read: the 404s (not found, expired, not hers, a dog never on it), the
  //    day-program refusal, and the owner's switch.
  const seen = await bookingsRepository.findFullByIdInTx(tx, id);
  assertOneDogCancellable(seen, id, requireOwnerId);
  if ((await bookingsRepository.findShareInTx(tx, id, dogId)) === undefined) {
    throw new ApiError('not_found', `dog ${dogId} is not on booking ${id}`);
  }
  if (requireOwnerId !== null && !(await settingsRepository.perDogCancelEnabled(tx))) {
    throw new ApiError('per_dog_cancel_off', 'cancelling one dog of a day is switched off');
  }

  // 2. The lock order: charge, then the row, then the pool (`db/locks.ts`).
  if (seen.orderId !== null) {
    const charge = await chargesRepository.findEngineByOrderId(tx, seen.orderId);
    if (charge !== undefined) await lockCharge(tx, charge.id);
  }
  const row = await bookingsRepository.lockById(tx, id);
  assertOneDogCancellable(row, id, requireOwnerId);
  const share = await bookingsRepository.findShareInTx(tx, id, dogId);
  if (share === undefined) throw new ApiError('not_found', `dog ${dogId} is not on booking ${id}`);

  // 3. Under the lock, in D12's order.
  if (row.status === 'cancelled' || share.expiredAt !== null) {
    throw new ApiError('session_cancelled', `dog ${dogId}'s session ${id} is already cancelled`);
  }
  if (row.status === 'payment-pending') {
    throw new ApiError(
      'payment_pending',
      `booking ${id} waits on its top-up's charge: cancel the whole order instead`,
    );
  }
  if (dayHasEnded(row, await pickupCloseByCampus(tx), now)) {
    throw sessionEndedError(id, sessionDate(row.scheduledAt));
  }
  const states = statesByDog(await checkinEventsRepository.findForBookings(tx, [id]));
  if ((states.get(dogId) ?? 'expected') !== 'expected') throw sessionCheckedInError(id, dogId);

  // 4. Her share leaves, or the session goes with its last dog.
  const shares = await bookingsRepository.findSharesByBookingIds(tx, [id]);
  const othersStaying = shares.some((s) => s.dogId !== dogId && s.expiredAt === null);
  if (othersStaying) {
    await bookingsRepository.stampShareCancelled(tx, { bookingId: id, dogId, now });
    await repointDayReminder(tx, id, dogId);
  } else {
    await bookingsRepository.markCancelledWithLastDog(tx, {
      id,
      cancelledBy: args.cancelledBy,
      now,
    });
    await tearDownBookingReminders(tx, id);
  }

  // 5. Her credit back: her live debit, never another dog's.
  const [debit] = await creditLedgerRepository.findLiveDebits(tx, { bookingId: id, dogId });
  if (debit === undefined) throw noLiveDebit(log, { bookingId: id, dogId });
  await lockPools(tx, [debit]);
  const returned = await creditLedgerRepository.refundForBooking(tx, {
    ...debit,
    now,
    checkinEventId: null,
  });

  // 6. The owner's notice, naming her alone, in its own savepoint.
  await noticeCreditReturned(tx, {
    bookingId: id,
    ownerId: row.ownerId,
    dogId,
    returnId: returned.id,
    who: {
      kind: 'one-dog',
      by: args.cancelledBy,
      category: row.category as 'day-school' | 'day-care',
      scheduledAtIso: pgTimestampToIso(row.scheduledAt),
    },
    log,
  });

  return {
    wire: await wireOne(tx, id, { now, viewer: viewerOf(requireOwnerId) }),
    creditRefundedOwnerId: debit.ownerId,
    location: row.location,
  };
}

/**
 * D3 for the queue (P20 fix 1, Opus L1): when the dog cancelled alone is the one the day's
 * queued reminder names (booking creation queues it with the lead,
 * `enqueueBookingReminders`), it names the dog who leads now, D3's first remaining dog,
 * so the feed row it becomes never shows a dog who is not coming. A reminder naming
 * another dog, or already sent, is left alone. In the cancel's transaction, after her
 * share is stamped.
 */
async function repointDayReminder(
  tx: Tx,
  bookingId: string,
  cancelledDogId: string,
): Promise<void> {
  const shares = await bookingsRepository.findSharesByBookingIds(tx, [bookingId]);
  const lead = groupBookingDogs(shares).get(bookingId)?.lead;
  if (lead === undefined) throw new Error(`booking ${bookingId} has no dog left to lead`);
  await scheduledNotificationsRepository.repointPendingDog(tx, {
    dedupeKey: `booking-reminder:${bookingId}`,
    fromDogId: cancelledDogId,
    toDogId: lead,
  });
}

/** The one-dog cancel's 404 collapse, then its day-program refusal (D12). */
function assertOneDogCancellable(
  row: BookingFullRow | undefined,
  id: string,
  requireOwnerId: string | null,
): asserts row is BookingFullRow {
  if (
    row === undefined ||
    row.expiredAt !== null ||
    (requireOwnerId !== null && row.ownerId !== requireOwnerId)
  ) {
    throw new ApiError('not_found', `booking ${id} not found`);
  }
  if (!isDayProgram(row.category)) {
    throw new ApiError('invalid_payload', `booking ${id} is not a day-school or day-care session`);
  }
}
