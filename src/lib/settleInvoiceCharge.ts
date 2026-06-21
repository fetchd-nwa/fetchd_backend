import { chargesRepository } from '../db/repositories/chargesRepository.js';
import type { ChargePurpose } from '../db/repositories/chargesRepository.js';
import type { InvoiceRow } from '../db/repositories/invoicesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import type { Tx } from '../db/tx.js';

/**
 * The post-Stripe handle the caller fires after commit (mirrors
 * `cancelBookingService.PendingStripeRefund`): on a lost settle race the
 * duplicate charge's refund row is written 'pending' inside the tx, and the
 * caller fires the actual Stripe `createRefund` against `paymentIntentId`
 * post-commit, then persists the `re_*` id via `refundsRepository.markStripeId`.
 */
export interface PendingDuplicateRefund {
  refundId: string;
  paymentIntentId: string;
  amountCents: number;
}

/**
 * Discriminated result so each caller can shape its own honest response:
 *   - 'settled'  -> THIS path won the race; the invoice flipped to paid here.
 *   - 'refunded' -> THIS path LOST the race (another path already settled the
 *     invoice); this charge is a duplicate. The invoice is paid (by the
 *     winner), but THIS request's charge is being reversed. `pendingStripeRefund`
 *     is set when there's money to send back (the common lost-race case) and
 *     undefined only in the defensive zero-refund case (a charge that somehow
 *     already carries a non-failed refund for its full amount).
 */
export type SettleInvoiceChargeResult =
  | { outcome: 'settled'; chargeId: string }
  | {
      outcome: 'refunded';
      chargeId: string;
      pendingStripeRefund: PendingDuplicateRefund | undefined;
    };

export interface SettleInvoiceChargeArgs {
  invoice: InvoiceRow;
  /** A PaymentIntent that ALREADY succeeded at Stripe (this path's own PI). */
  paymentIntentId: string;
  /** Cents actually charged -- Stripe's confirmed amount, not the invoice face. */
  amountCents: number;
  purpose: ChargePurpose;
  /**
   * Whether to emit the `payment-succeeded` receipt when THIS path settles.
   * The worker passes true (it initiates silently -- the owner only learns via
   * the feed). The manual `/invoices/:id/pay` route passes false: the owner
   * initiated and gets the HTTP response, so a push receipt would be redundant.
   * The refund (lost-race) branch never notifies under either caller.
   */
  notifyOwner: boolean;
}

/**
 * The ONE post-Stripe invoice-settlement primitive both settle paths call --
 * the worker auto-charge and the manual `POST /invoices/:id/pay`. It runs
 * AFTER a path's own Stripe PaymentIntent has already SUCCEEDED, inside one
 * short tx, and resolves the double-charge race between the two paths:
 *
 *   1. INSERT the succeeded `charges` row for this PI.
 *   2. CONDITIONAL `markPaid` -- `invoicesRepository.markPaid` filters
 *      `WHERE id = ? AND status = 'open'`, so the UPDATE row count IS the
 *      atomic claim: whoever flips open->paid first wins (Postgres serializes
 *      the two UPDATEs on the row lock; the loser sees `flipped === 0`).
 *   3a. flipped > 0  -> THIS path settled. Optionally emit the
 *       `payment-succeeded` receipt (only when `notifyOwner`).
 *   3b. flipped === 0 -> THIS path LOST: the other path already settled the
 *       invoice, so this charge double-bills the same money. Write a 'pending'
 *       refund row for the full charge (idempotency-guarded via
 *       `sumNonFailedForCharge`, mirroring cancelBookingService) and emit NO
 *       notification -- the customer is net-charged exactly once, so a
 *       "payment failed" would be a lie.
 *
 * The actual Stripe `createRefund` is NOT fired here (no Stripe call inside a
 * tx -- the project-wide invariant). On the 'refunded' outcome the caller fires
 * it post-commit and persists the `re_*` id, exactly as cancelBookingService's
 * money-back branch does. A refund-API failure leaves the 'pending' row for the
 * webhook's race-recovery / admin retry -- never silently swallowed past the
 * caller's logged post-commit seam.
 */
export async function settleInvoiceCharge(
  tx: Tx,
  args: SettleInvoiceChargeArgs,
): Promise<SettleInvoiceChargeResult> {
  const { invoice, paymentIntentId, amountCents, purpose, notifyOwner } = args;

  const charge = await chargesRepository.create(tx, {
    ownerId: invoice.ownerId,
    amountCents,
    status: 'succeeded',
    purpose,
    stripePaymentIntentId: paymentIntentId,
    bookingId: invoice.bookingId,
    // Carry the enrollment identity so a later group-class withdraw can find +
    // refund this dog's payment (mirrors both prior settle paths).
    cohortId: invoice.cohortId,
    dogId: invoice.dogId,
  });

  const flipped = await invoicesRepository.markPaid(tx, {
    id: invoice.id,
    paidChargeId: charge.id,
  });

  if (flipped > 0) {
    if (notifyOwner) {
      await notificationsRepository.enqueue(tx, {
        ownerId: invoice.ownerId,
        type: 'payment-succeeded',
        title: 'Payment received',
        body: `We charged your card ${formatDollars(amountCents)} for your ${purposeLabel(
          purpose,
        )}.`,
        deepLinkPath: '/account/billing',
        dogIds: invoice.dogId ? [invoice.dogId] : [],
      });
    }
    return { outcome: 'settled', chargeId: charge.id };
  }

  // Lost the race: the invoice was already settled by the other path. This
  // charge double-bills the same money -> refund it. Idempotency-guarded
  // (`sumNonFailedForCharge`) exactly as cancelBookingService's money-back
  // branch: a re-run that finds the full amount already pending-refunded
  // computes `maxRefund <= 0` and creates no second refund row.
  const alreadyRefunded = await refundsRepository.sumNonFailedForCharge(tx, charge.id);
  const maxRefund = amountCents - alreadyRefunded;
  if (maxRefund <= 0) {
    return { outcome: 'refunded', chargeId: charge.id, pendingStripeRefund: undefined };
  }

  const refund = await refundsRepository.createPending(tx, {
    ownerId: invoice.ownerId,
    chargeId: charge.id,
    bookingId: invoice.bookingId,
    amountCents: maxRefund,
    reason: 'duplicate-invoice-settle',
  });

  return {
    outcome: 'refunded',
    chargeId: charge.id,
    pendingStripeRefund: { refundId: refund.id, paymentIntentId, amountCents: maxRefund },
  };
}

/** Whole-dollar-aware USD formatter for receipt copy. Stripe amounts are cents;
 *  `$120` reads better than `$120.00` for round amounts, but cents show when
 *  present. */
function formatDollars(amountCents: number): string {
  const dollars = amountCents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toString() : dollars.toFixed(2)}`;
}

/**
 * Human label for the thing being charged, varied by `charge_purpose`, for the
 * receipt copy. Day-program (`payg`), `board-train`, and `group-class` are the
 * auto-charged invoice purposes today; `package` / `membership` are covered
 * for totality (an invoice can carry any purpose).
 */
function purposeLabel(purpose: ChargePurpose): string {
  switch (purpose) {
    case 'payg':
      return 'day program session';
    case 'board-train':
      return 'Board & Train program';
    case 'group-class':
      return 'group class enrollment';
    case 'package':
      return 'credit package';
    case 'membership':
      return 'membership';
  }
}
