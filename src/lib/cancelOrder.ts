import type { PostStaffOrdersCancelResponse } from '../contracts/wire.js';
import { lockCharge } from '../db/locks.js';
import { chargesRepository, type EngineChargeRow } from '../db/repositories/chargesRepository.js';
import type { Tx } from '../db/tx.js';
import {
  failChargeInTx,
  settleChargeInTx,
  type EngineAct,
  type EngineBudget,
  type EngineLog,
} from './confirmCharge.js';
import { ApiError } from './errors.js';
import { cancelOrderRowsInTx, type CancelledOrderRows } from './orderRows.js';
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
 * Act on {@link WhatWon} under the charge lock, then the rows, then the pool. The
 * arms, in the order the charge can answer them:
 *
 *   - already `succeeded`: nothing is cancelled that a purchase bought (`settled`),
 *     and a top-up's rows go back as credits (`settled_then_cancelled`). Stripe was
 *     not asked, so `whatWon` is `undefined`.
 *   - `failed` or `refunded`: nothing is pending, 409.
 *   - `requires_payment`, Stripe `succeeded`: the settle runs, then any rows go back as
 *     credits (`settled_then_cancelled`). An invoice or a pack has no rows, so what it
 *     bought stands (`settled`).
 *   - `requires_payment`, Stripe `canceled` or no intent id: the order is cancelled,
 *     the claim completes with the 402, and the failed-payment notice goes.
 *   - `requires_payment`, `no-intent` read before an id landed: 409, nothing written,
 *     because "you weren't charged" is not yet known. A retry cancels the intent.
 *   - `requires_payment`, Stripe `processing`: cancelled anyway, and **nothing tells
 *     the owner it failed, which it may not have**. Its true word is `payment-refunded`'s
 *     `cancel-while-processing` trigger, born with M7.09, so until LG7 no notice goes.
 *     A late success is refunded in full by `settleChargeInTx`.
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
    ...(processing ? {} : { notice: 'order-cancelled' as const }),
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
