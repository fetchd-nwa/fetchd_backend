import { refundsRepository } from '../db/repositories/refundsRepository.js';
import type { StripeClient, StripePaymentIntentId } from './stripe.js';

/**
 * The handle a pending-refund writer hands its caller to fire after commit —
 * ONE type for all five money-back sites (`designs/client-keyed-refund-recovery.md`
 * §2.2). It used to be two structurally identical interfaces declared in two
 * files (`cancelBookingService.PendingStripeRefund`,
 * `settleInvoiceCharge.PendingDuplicateRefund`), which is how the fourth field
 * below could have been added to one and forgotten on the other.
 *
 * `stripeIdempotencyKey` is the load-bearing addition: the EXACT key this
 * refund's Stripe call will use, computed once, stored on the `refunds` row in
 * the same transaction that minted it, and read from that row by the retry
 * sweep. Before it existed, three of the four writers derived their key from
 * the CLIENT's request `Idempotency-Key`, which lives only in that request's
 * closure — so a `createRefund` that failed post-commit could never be retried
 * by anything, and the money silently never returned.
 */
export interface PendingStripeRefund {
  refundId: string;
  paymentIntentId: string;
  amountCents: number;
  /** The key BOTH the post-commit fire and the sweep's retry send. */
  stripeIdempotencyKey: string;
}

/**
 * THE Stripe `createRefund` params, built in exactly one place.
 *
 * A same-key retry only REPLAYS the original refund when the parameters match
 * byte-for-byte; same key + drifted params is Stripe's `idempotency_error`
 * (400, no money moved — loud and safe, but the refund then never lands).
 * Every site used to hand-build this object literal, so "the sweep rebuilds the
 * params differently from the fire" was a live regression away at all times.
 * One constructor makes that unreachable except by editing this function, and
 * the byte-equality pin in the suite is what watches this function.
 */
export function refundCreateParams(pending: { paymentIntentId: string; amountCents: number }): {
  paymentIntentId: StripePaymentIntentId;
  amountCents: number;
  reason: string;
} {
  return {
    paymentIntentId: pending.paymentIntentId,
    amountCents: pending.amountCents,
    reason: 'requested_by_customer',
  };
}

/**
 * The post-commit half of every pending refund's contract, for all five sites:
 * fire `createRefund` under the row's STORED key, persist the returned `re_*`
 * so `charge.refund.updated` matches deterministically, and on failure LOG and
 * LEAVE THE ROW PENDING (R35 — the pending row is the commitment).
 *
 * Leaving it pending is now a real instruction rather than a hopeful sentence:
 * `workers/duplicateRefundRetry.ts` claims exactly these rows and re-fires them
 * under the same stored key, so a transient rate limit or dropped connection
 * costs a few minutes instead of an owner's money.
 *
 * `stripe` is narrowed to the one verb so a caller cannot be handed more Stripe
 * surface than this needs. A no-op on `undefined` — the defensive zero-refund
 * cases (a charge already fully pending-refunded, a forfeited cancel) have
 * nothing to send back.
 */
export async function firePendingRefundPostCommit(args: {
  pending: PendingStripeRefund | undefined;
  stripe: Pick<StripeClient, 'createRefund'>;
  log: { error(obj: Record<string, unknown>, msg?: string): void };
  /** Context for the failure log line — whatever names the money for an operator. */
  context: Record<string, unknown>;
}): Promise<void> {
  const { pending, stripe, log } = args;
  if (pending === undefined) return;
  try {
    const refund = await stripe.createRefund(
      refundCreateParams(pending),
      pending.stripeIdempotencyKey,
    );
    await refundsRepository.markStripeId({ id: pending.refundId, stripeRefundId: refund.id });
  } catch (err) {
    log.error(
      {
        ...args.context,
        refundId: pending.refundId,
        paymentIntentId: pending.paymentIntentId,
        amountCents: pending.amountCents,
        stripeIdempotencyKey: pending.stripeIdempotencyKey,
        err: err instanceof Error ? err.message : String(err),
      },
      'pending refund failed to fire; the row stays pending and the retry sweep re-fires it under the SAME stored key',
    );
  }
}

/**
 * A refund that was born with nowhere to go (`schema.sql` `refund_status`,
 * design §4): the charge behind it carries no `stripe_payment_intent_id`, so
 * `status='unroutable'` was written INSTEAD of `'pending'` and no automatic
 * path will ever send it. Money owed with no route is a page-once event, at the
 * moment it becomes true — not a line that repeats on every worker tick forever.
 *
 * Called IN-TRANSACTION at the mint (`cancelBookingService`), never from a
 * post-commit seam — ruled by the 2026-08-20 adversary panel, which proved the
 * post-commit placement loses the announcement PERMANENTLY on the
 * crash-then-replay arc (`withMutation` replays skip postCommit, and no report
 * class can ever name an unroutable row again). The cost of this placement is
 * a rare false alarm if the transaction then rolls back — loud and
 * recoverable, the right failure direction for money owed back. Do not move
 * this back to postCommit.
 */
export interface UnroutableRefundMint {
  refundId: string;
  ownerId: string;
  chargeId: string;
  amountCents: number;
}

export function logUnroutableRefundMint(
  log: { error(obj: Record<string, unknown>, msg?: string): void },
  mint: UnroutableRefundMint | undefined,
  context: Record<string, unknown> = {},
): void {
  if (mint === undefined) return;
  log.error(
    { ...context, ...mint },
    'refund owed with no Stripe route: the charge behind it has no PaymentIntent (pre-Stripe-wire money), so the row is terminal at "unroutable" and a human must return this money out of band',
  );
}
