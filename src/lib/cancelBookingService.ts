import { db } from '../db/client.js';
import { lockCharge } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import type { BookingWire } from './bookingWire.js';
import { askWhatWon, cancelOrderInTx, type WhatWon } from './cancelOrder.js';
import { readEngineBudget, type EngineLog } from './confirmCharge.js';
import { ApiError } from './errors.js';
import {
  noticeBookingCancelled,
  returnDebitsToLots,
  tearDownBookingReminders,
} from './orderRows.js';
import {
  logUnroutableRefundMint,
  type PendingStripeRefund,
  type UnroutableRefundMint,
} from './pendingRefund.js';
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
   * Distinct dog ids that received a credit-back on this cancel. The route
   * wipes each dog's `credits:{dogId}:*` display cache post-commit. Empty on
   * every non-credit-back path (forfeit / money-back / PAYG-void / free).
   */
  creditRefundedDogIds: string[];
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
      wire: await wireOne(tx, id),
      pendingStripeRefund: cancelled.act.pendingStripeRefund,
      creditRefundedDogIds: cancelled.cancelled?.creditRefundedDogIds ?? [],
    };
  }

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

  // The booking's open PAYG invoice, if any — its pending auto-charge is voided
  // on a within-window cancel (below), and its pay-in-person reminder is torn
  // down in step 7 (R3). Read once now: the void flips it to 'void', so the id
  // must be captured before then to survive the teardown lookup.
  const linkedOpenInvoice = await invoicesRepository.findOpenForBooking(tx, { bookingId: id });

  // 6. Refund branching — within the cancel window only.
  let pendingStripeRefund: PendingStripeRefund | undefined;
  let unroutableRefund: UnroutableRefundMint | undefined;
  let creditRefundedDogIds: string[] = [];
  if (!updated.cancelForfeited) {
    // CREDIT-BACK: one +1 refund row per original debit, routed back to the lot it
    // drew from. `now` is the caller's cancel instant, so the lot the refund lands in
    // is dated by the same clock the forfeit check used.
    creditRefundedDogIds = await returnDebitsToLots(tx, { bookingId: id, now });
    if (creditRefundedDogIds.length === 0) {
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
      } else {
        // PAYG within-window: void the pending auto-charge so the worker
        // never bills a cancelled session. There's no prior credit debit
        // (PAYG skips it) and no settled charge yet (due_at is ~1h before
        // drop-off, inside the cancel window), so the open invoice is the
        // only money artifact. A genuinely free service (no invoice) is a
        // no-op — the status flip is the full effect.
        if (linkedOpenInvoice !== undefined) {
          await invoicesRepository.markVoid(tx, { id: linkedOpenInvoice.id });
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
  // R3: same rule for a pay-in-person invoice linked to this booking — with no
  // drop-off left, its "bring $… at drop-off" reminder is stale. Keyed by
  // invoice id (`payment-due:<invoiceId>`), so cancel by the captured invoice.
  if (linkedOpenInvoice !== undefined) {
    await scheduledNotificationsRepository.cancelPendingByDedupePrefix(
      tx,
      `payment-due:${linkedOpenInvoice.id}`,
    );
  }

  // 8. Wire the updated row for the response.
  return {
    wire: await wireOne(tx, id),
    pendingStripeRefund,
    unroutableRefund,
    creditRefundedDogIds,
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

async function wireOne(tx: Tx, id: string): Promise<BookingWire> {
  const updated = await bookingsRepository.findFullByIdInTx(tx, id);
  if (updated === undefined) {
    throw new Error(`cancelBooking ${id}: row vanished after mark-cancelled`);
  }
  const [wire] = await wireManyBookings([updated]);
  if (wire === undefined) {
    throw new Error(`cancelBooking ${id}: wire assembly returned no row`);
  }
  return wire;
}

/**
 * The half of a pending row's cancel that runs BEFORE the transaction: ask Stripe what
 * won, with none open (R5). `undefined` for every row that is not pending, which is
 * every row until P18, so an ordinary cancel asks Stripe nothing. A row this request
 * may not touch is left to the transaction's own 404, unasked.
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
