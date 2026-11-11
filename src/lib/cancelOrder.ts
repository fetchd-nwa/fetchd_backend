import type { PostStaffOrdersCancelResponse } from '../contracts/wire.js';
import { lockCharge } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository, type EngineChargeRow } from '../db/repositories/chargesRepository.js';
import type { Tx } from '../db/tx.js';
import {
  failChargeInTx,
  settleChargeInTx,
  type EngineAct,
  type EngineBudget,
  type EngineLog,
} from './confirmCharge.js';
import { isDayProgram, refuseDayCancel } from './dayCancel.js';
import { ApiError } from './errors.js';
import { cancelOrderRowsInTx, type CancelledOrderRows } from './orderRows.js';
import { pgTimestampToDate } from './pgTimestamp.js';
import type { StripeClient, StripePaymentIntentResult } from './stripe.js';
import { cancelAndConfirm } from './withdrawSettlement.js';

/**
 * The cancel of a pending order (design §2.7:4006-4027; PAY-U07), staff's *Cancel
 * order* or a cancel of any one pending row, owner or staff. Two halves, because the
 * lock is Stripe's: first ask what won, with no transaction open (R5, the read-what-
 * won pattern of `withdrawSettlement.ts`), then act on the answer under the charge
 * lock. The arms re-read the charge there, so a settler that got in between wins.
 */

/** What Stripe said to a cancel, read outside any transaction. */
export type WhatWon =
  /** No intent id stored: no card was tried, and the create cannot charge. */
  | { kind: 'no-intent' }
  | { kind: 'canceled' }
  /** Stripe will not cancel it, and it may yet succeed. */
  | { kind: 'processing' }
  /** The payment won the race. */
  | { kind: 'succeeded'; live: StripePaymentIntentResult };

/**
 * Ask Stripe to cancel this charge's intent, and read what happened. A cancel that
 * fails for a reason a re-retrieve cannot explain throws: nothing has changed here,
 * and a person's retry, or the sweeper's next look, heals it.
 */
export async function askWhatWon(args: {
  charge: Pick<EngineChargeRow, 'stripePaymentIntentId'>;
  stripe: Pick<StripeClient, 'retrievePaymentIntent' | 'cancelPaymentIntent'>;
  budget: Pick<EngineBudget, 'call'>;
}): Promise<WhatWon> {
  const { stripe, budget } = args;
  const paymentIntentId = args.charge.stripePaymentIntentId;
  if (paymentIntentId === null) return { kind: 'no-intent' };
  const resolved = await cancelAndConfirm({
    stripe: {
      cancelPaymentIntent: (id) => stripe.cancelPaymentIntent(id, budget.call),
      retrievePaymentIntent: (id) => stripe.retrievePaymentIntent(id, budget.call),
    },
    paymentIntentId,
  });
  switch (resolved.kind) {
    case 'canceled':
      return { kind: 'canceled' };
    case 'processing':
      return { kind: 'processing' };
    case 'captured':
      return {
        kind: 'succeeded',
        live: await stripe.retrievePaymentIntent(paymentIntentId, budget.call),
      };
  }
}

export interface CancelOrderResult {
  outcome: PostStaffOrdersCancelResponse['outcome'];
  act: EngineAct;
  /** The rows this cancel took down, when it took any. */
  cancelled?: CancelledOrderRows;
}

function nothingPending(orderId: string): ApiError {
  return new ApiError('conflict', `order ${orderId} has nothing pending to cancel`);
}

/**
 * The settled arm's refusal (§M2, designs/p20-event-ledger-link.md; DECISIONS 251(b),
 * 252(b)): the rows it would cancel, locked first (id order, under the charge lock), then
 * each day row in date order through the day cancels' own rule, `refuseDayCancel`: the
 * first day that has ended (409 `session_ended`) or that the desk recorded (checked in,
 * turned away, or marked as not coming: 409 `session_checked_in`) refuses the whole order,
 * and nothing is written; so the earliest refusing day is the one that answers. A board
 * verb on one of these rows waits on the row lock, so the check and a tap cannot
 * interleave: the lock comes before the read (pinned by `settled-share-cancels.test.ts`'s
 * race, F9).
 *
 * Here and not in `cancelOrderRowsInTx`: the decline shares that, and a declined top-up
 * cancels its rows whatever the clock says. Not in the `requires_payment`-then-succeeded
 * arm either: its rows were `payment-pending` until that transaction, so no check-in can
 * exist, and refusing an ended day there would roll back a settle whose money Stripe holds
 * (§9 (c)).
 */
async function refuseStartedDays(tx: Tx, orderId: string, now: Date): Promise<void> {
  const rows = await bookingsRepository.lockCancellableByOrderId(tx, orderId);
  const byDate = rows
    .filter((row) => isDayProgram(row.category))
    .sort(
      (a, b) =>
        pgTimestampToDate(a.scheduledAt).getTime() - pgTimestampToDate(b.scheduledAt).getTime(),
    );
  for (const row of byDate) await refuseDayCancel(tx, row, now);
}

/**
 * Act on {@link WhatWon} under the charge lock, then the rows, then the pool. The
 * arms, in the order the charge can answer them:
 *
 *   - already `succeeded`: nothing is cancelled that a purchase bought (`settled`),
 *     and a top-up's rows go back as credits (`settled_then_cancelled`), unless one of
 *     its days has ended or has been recorded at the desk: then 409, the whole order
 *     refused (§M2, {@link refuseStartedDays}). Stripe was not asked, so `whatWon` is
 *     `undefined`.
 *   - `failed` or `refunded`: nothing is pending, 409.
 *   - `requires_payment`, Stripe `succeeded`: the settle runs, then any rows go back as
 *     credits (`settled_then_cancelled`). An invoice or a pack has no rows, so what it
 *     bought stands (`settled`).
 *   - `requires_payment`, Stripe `canceled` or no intent id: the order is cancelled,
 *     the claim completes with the 402, and the failed-payment notice goes.
 *   - `requires_payment`, `no-intent` read before an id landed: 409, nothing written,
 *     because "you weren't charged" is not yet known. A retry cancels the intent.
 *   - `requires_payment`, Stripe `processing`: cancelled anyway, and **nothing tells
 *     the owner it failed, which it may not have**: a pack or a top-up hears the true word,
 *     `cancel-while-processing`, and an invoice has no copy for it. A late success is
 *     refunded in full by `settleChargeInTx`.
 */
export async function cancelOrderInTx(
  tx: Tx,
  args: {
    orderId: string;
    whatWon: WhatWon | undefined;
    cancelledBy: 'owner' | 'staff';
    cancelReason?: string;
    log: EngineLog;
    now: Date;
  },
): Promise<CancelOrderResult> {
  const { orderId, whatWon, cancelledBy, log, now } = args;
  const found = await chargesRepository.findEngineByOrderId(tx, orderId);
  if (found === undefined) throw nothingPending(orderId);
  const charge = await lockCharge(tx, found.id);
  if (charge === undefined) throw nothingPending(orderId);

  switch (charge.status) {
    case 'failed':
    case 'refunded':
      throw nothingPending(orderId);
    case 'succeeded': {
      await refuseStartedDays(tx, orderId, now);
      const cancelled = await cancelOrderRowsInTx(tx, {
        orderId,
        cancelledBy,
        ...(args.cancelReason !== undefined ? { cancelReason: args.cancelReason } : {}),
        now,
        notifyEachRow: true,
        log,
      });
      return {
        outcome: cancelled.bookingIds.length > 0 ? 'settled_then_cancelled' : 'settled',
        act: { outcome: 'no-op' },
        cancelled,
      };
    }
    case 'requires_payment':
      break;
  }

  // Stripe was not asked because the charge read as settled, and now it reads as open.
  // It cannot go back, so this is a charge that changed under the read: ask again.
  if (whatWon === undefined) throw nothingPending(orderId);

  // `no-intent` was read off an unlocked row, and the row names an intent now.
  if (whatWon.kind === 'no-intent' && charge.stripePaymentIntentId !== null) {
    throw new ApiError('conflict', 'this order changed while it was being cancelled: try again');
  }

  if (whatWon.kind === 'succeeded') {
    const act = await settleChargeInTx(tx, {
      chargeId: charge.id,
      live: whatWon.live,
      receiptTrigger: 'settle',
      log,
      now,
    });
    const cancelled = await cancelOrderRowsInTx(tx, {
      orderId,
      cancelledBy,
      ...(args.cancelReason !== undefined ? { cancelReason: args.cancelReason } : {}),
      now,
      notifyEachRow: true,
      log,
    });
    return {
      outcome: cancelled.bookingIds.length > 0 ? 'settled_then_cancelled' : 'settled',
      act,
      cancelled,
    };
  }

  const processing = whatWon.kind === 'processing';
  const act = await failChargeInTx(tx, {
    chargeId: charge.id,
    blocker: processing ? 'processing' : undefined,
    lastError: null,
    ...(!processing
      ? { notice: 'order-cancelled' as const }
      : charge.packageId !== null
        ? { notice: 'cancel-while-processing' as const }
        : {}),
    ...(whatWon.kind === 'canceled' ? { intentDead: true as const } : {}),
    cancelledBy,
    ...(args.cancelReason !== undefined ? { cancelReason: args.cancelReason } : {}),
    log,
    now,
  });
  return {
    outcome: 'cancelled',
    act,
    ...(act.cancelled !== undefined ? { cancelled: act.cancelled } : {}),
  };
}
