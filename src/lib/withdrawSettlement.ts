import { CANCELLABLE_STATUSES } from './enrollmentPartial.js';
import type { StripeClient, StripePaymentIntentStatus } from './stripe.js';

/**
 * The pre-transaction money settlement for a withdraw that lands while a hold
 * is still waiting to be captured — `designs/partial-success-enrollment.md`
 * ADDENDUM 3 §A3.2.
 *
 * **Why this exists.** Manual capture changed what a `'requires_payment'`
 * group-class charge row MEANS: it used to be a dead attempt, and since wire
 * 1.11.0 it is a LIVE AUTHORIZATION. The withdraw arm was never respecified for
 * that, so withdrawing during the capture-pending window released nothing and
 * stopped nothing — and the capture reconciler then captured money for a class
 * with zero live bookings (round-3 blocker, proven end-to-end).
 *
 * **The lock is Stripe's, not ours.** Cancel and capture are mutually exclusive
 * terminal transitions on one PaymentIntent and Stripe serializes them, so
 * exactly one of the two wins and the loser is TOLD it lost. That is the whole
 * race protocol; no DB lock is added and none would help, because the fact
 * being raced over lives at Stripe. The verdict below is post-race truth.
 *
 * Every call here runs OUTSIDE the withdraw transaction (R5 — no Stripe call
 * inside a DB transaction, `BUSINESS-LOGIC/payments-invoices.md:52`). The
 * placement is also what closes the request-side amplification: by the time any
 * capture — the enrolling request's own `captureHeldDogs`, or a reconciler tick
 * — reaches Stripe, the intent is already terminal and Stripe refuses it.
 */

/**
 * What this request will TELL THE OWNER about their money, decided from
 * Stripe's live answer. One per withdraw, and never "we'll see" — Allison,
 * 2026-08-21: *"as a user it should be very clear what is happening with my
 * money. no uncertains"*.
 *
 *   - `'released'`        — the hold is dead. Nothing was ever captured and
 *                           nothing can be.
 *   - `'refunded'`        — a capture won the race. The money moved and this
 *                           request mints the refund that returns it.
 *   - `'release_pending'` — the payment is mid-flight (`processing`), which
 *                           Stripe refuses to cancel. The OUTCOME is still
 *                           definite (the owner pays nothing); the mechanism
 *                           finishes asynchronously, and the reconciler is the
 *                           executor that finishes it (§A3.3).
 */
export type WithdrawSettleVerdict = 'released' | 'refunded' | 'release_pending';

/** What a cancel attempt turned out to mean, after live truth was consulted. */
type CancelResolution =
  | { kind: 'canceled' }
  | { kind: 'captured' }
  | { kind: 'processing' };

/**
 * Settle one capture-pending authorization for a withdraw, and return the
 * verdict the response will state.
 *
 * The arms, in the order Stripe can answer them:
 *
 *   - **cancellable** (`requires_capture`, `requires_action`,
 *     `requires_confirmation`, `requires_payment_method`) → cancel NOW. The
 *     cancel returning IS the release.
 *   - **cancel throws** → re-retrieve once and read what won:
 *     `succeeded` ⇒ a capture beat us ⇒ **refunded**; `canceled` ⇒ someone
 *     else released it first (a sibling, or the reconciler's new arm) ⇒
 *     **released**; `processing` ⇒ **release_pending**.
 *   - **`succeeded` at first retrieve** — the capture finished and only the row
 *     flip was lost ⇒ **refunded**.
 *   - **`canceled` at first retrieve** — a prior crashed withdraw's cancel, or
 *     an expired hold ⇒ **released**. Nothing was captured and nothing can be,
 *     so saying "released" is true rather than merely convenient.
 *   - **`processing`** ⇒ **release_pending**.
 *
 * **Anything unreadable ABORTS the whole withdraw** (this function throws, the
 * transaction has not run, and nothing changed): a transport failure on the
 * retrieve, or a cancel that failed for a reason the re-retrieve cannot
 * explain. This is the "no uncertains" rule applied to ourselves — a withdraw
 * either completes with a definite money statement or does not complete, and
 * the owner's retry heals it. The named residual is a cancel that LANDED
 * before its response was lost: the hold is released while the dog is still
 * enrolled, which the reconciler's `canceled`+owed arm pages as LOST HOLD —
 * loud, never silent — and the owner's retry then reads `canceled` and
 * completes.
 */
export async function settleCapturePendingHold(args: {
  stripe: Pick<StripeClient, 'retrievePaymentIntent' | 'cancelPaymentIntent'>;
  paymentIntentId: string;
}): Promise<WithdrawSettleVerdict> {
  const live = await args.stripe.retrievePaymentIntent(args.paymentIntentId);
  if (CANCELLABLE_STATUSES.has(live.status)) {
    const resolved = await cancelAndConfirm(args);
    switch (resolved.kind) {
      case 'canceled':
        return 'released';
      case 'captured':
        return 'refunded';
      case 'processing':
        return 'release_pending';
    }
  }
  return verdictForRestingStatus(live.status);
}

/**
 * Cancel an intent and resolve what actually happened, by asking Stripe again
 * when the cancel refuses.
 *
 * **Deliberately NOT `enrollmentPartial.cancelOne`**, whose posture is
 * best-effort-and-log: it swallows the throw, which is exactly the value this
 * caller needs. A swallowed cancel error cannot decide a verdict, and its ERROR
 * line ("could not release an authorization hold") would be a false alarm on
 * the ordinary capture-wins race — the path where the money is fine and a
 * refund is already on its way. What IS shared is the thing worth sharing:
 * {@link CANCELLABLE_STATUSES}, the one list of statuses a cancel is worth
 * attempting from, imported rather than re-spelled on a money path.
 *
 * Shared by the withdraw arm and the reconciler's release arm (§A3.3), so the
 * two cannot drift into two different readings of the same race.
 */
export async function cancelAndConfirm(args: {
  stripe: Pick<StripeClient, 'retrievePaymentIntent' | 'cancelPaymentIntent'>;
  paymentIntentId: string;
}): Promise<CancelResolution> {
  try {
    await args.stripe.cancelPaymentIntent(args.paymentIntentId);
    return { kind: 'canceled' };
  } catch (cancelError) {
    // The cancel refused. Stripe refuses for exactly the reasons that decide
    // this: someone captured it, someone cancelled it, or it is still
    // settling. A re-retrieve is the only honest way to tell which, and a
    // retrieve that ALSO fails leaves us with no answer to give — which is
    // what the rethrow below is for.
    const after = await args.stripe.retrievePaymentIntent(args.paymentIntentId);
    switch (after.status) {
      case 'succeeded':
        return { kind: 'captured' };
      case 'canceled':
        return { kind: 'canceled' };
      case 'processing':
        return { kind: 'processing' };
      case 'requires_capture':
      case 'requires_action':
      case 'requires_confirmation':
      case 'requires_payment_method':
        // Still cancellable, and the cancel failed anyway. We do not know why,
        // so we do not get to say what happened to the money. The original
        // cancel error is the evidence and is what propagates.
        throw cancelError;
    }
  }
}

/**
 * The verdict for an intent that was already resting somewhere terminal (or
 * un-cancellable) when we first looked. Exhaustive over the status union so a
 * new Stripe status is a TYPE ERROR here rather than a silent default on a
 * money path — the same discipline as `stripeIntentStatusToChargeStatus`.
 */
function verdictForRestingStatus(status: StripePaymentIntentStatus): WithdrawSettleVerdict {
  switch (status) {
    case 'succeeded':
      return 'refunded';
    case 'canceled':
      return 'released';
    case 'processing':
      return 'release_pending';
    case 'requires_capture':
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
      // Unreachable: the caller checked CANCELLABLE_STATUSES first. Kept as a
      // real arm rather than a `default` so the exhaustiveness above is real.
      return 'released';
  }
}
