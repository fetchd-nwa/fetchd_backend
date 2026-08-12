import type { InvoiceDeepLinkReason } from '../contracts/wire.js';
import type { ChargePurpose } from '../db/repositories/chargesRepository.js';
import { chicagoShortDate } from './chicagoDate.js';
import { formatDollars, purposeLabel } from './invoiceReceiptCopy.js';

/**
 * THE auto-charge owner-notification copy — every sentence the parked-invoice
 * lane can say, in one file (`designs/auto-charge-unknown-outcome.md`
 * Decision 4).
 *
 * **What Allison actually approved, precisely** (the earlier version of this
 * line said "all eight arms", which claimed her sign-off on strings she was
 * never shown): she approved the eight **bodies**, with the note *"if its too
 * wordy we can change later on"*. The two NEW titles — `'Payment still
 * processing'` (in-flight) and `"We're checking your payment"` (unconfirmed) —
 * are builder-invented and still pending her veto; every other arm reuses the
 * already-shipped `'Payment failed'` title. The approval is dated 2026-08-12
 * here and 2026-08-11 in the mobile repo's mirror of the same event; that
 * disagreement is unreconciled and one of the two is wrong.
 *
 * **Nothing here may be inlined at a call site.** Shortening this copy later
 * has to be a one-file edit, which is only true while this file is the only
 * place the strings exist. The worker and the verify lane both call
 * {@link autoChargeParkNotification} and render whatever it returns.
 *
 * Arm 1 of the taxonomy — the SETTLED receipt ("We charged your card $X for
 * your …") — deliberately does NOT live here: it is emitted inside
 * `settleInvoiceCharge` (the settle tx), is shared with the manual pay route,
 * and did not change in this design. It is named here only so the taxonomy
 * reads complete.
 *
 * Two rules the copy carries, not the caller:
 *
 *   - **The two unknown arms must never invite a retry.** `in-flight` and
 *     `unconfirmed` are the arms where money may already have moved; "try
 *     another card" there is precisely how one payment becomes two. They say
 *     "please don't pay it again" and they open the settle sheet under the
 *     1.10.0 `payment-unconfirmed` reason, which the client must render as a
 *     no-retry surface.
 *   - **Never claim we tried when we didn't.** `no-card-on-file` and
 *     `stripe-customer-missing` make ZERO Stripe calls, so they say "nothing
 *     has been charged" rather than the old "We tried your $X payment…", which
 *     was simply false on those two paths.
 */

/**
 * Which terminal sentence an auto-charge park is telling the owner. One arm per
 * distinguishable truth — the taxonomy exists because the single old sentence
 * ("we tried … and it didn't go through") was a lie on three of these.
 */
export type AutoChargeParkArm =
  /** Blocker `declined` — the card said no. */
  | 'declined'
  /** Blocker `authentication_required` — the card needs 3DS we can't do off-session. */
  | 'authentication-required'
  /** Known-failed, but no blocker survived (unmapped code / cancelled in-flight). */
  | 'failed-unknown-reason'
  /** No chargeable card on file. ZERO Stripe calls were made. */
  | 'no-card-on-file'
  /** Our `stripe_customers` linkage is broken. ZERO Stripe calls were made. */
  | 'stripe-customer-missing'
  /** The intent is still `processing` at the verify cap — money may be moving. */
  | 'in-flight'
  /** Past the idempotency-key window with no answer — we genuinely do not know. */
  | 'unconfirmed';

export interface AutoChargeParkNotification {
  /** `scheduled_notifications.dedupe_key` — one push per invoice per class. */
  dedupeKey: string;
  title: string;
  body: string;
  /** The `&reason=` the settle sheet opens under (wire 1.10.0). */
  reason: InvoiceDeepLinkReason;
}

export interface AutoChargeParkCopyArgs {
  invoiceId: string;
  amountCents: number;
  purpose: ChargePurpose;
  /**
   * The instant the sentence is about — when the charge was ATTEMPTED, or (on
   * the two arms that make zero Stripe calls) when the invoice fell due.
   * Rendered as a Chicago short date, the "name WHEN it was tried" half of
   * Allison's 2026-08-01 ruling.
   *
   * **Not "now".** Every caller passes the instant its own arm is about: the
   * attempt row's `created_at` on the verify lane and the late webhook, the
   * invoice's `due_at` on the no-card arm, and `now` only in the charge lane,
   * where the charge did just happen. Defaulting this to the push time is how
   * the arm that fires 24h after an attempt came to say "started on" today's
   * date (2026-08-12 adversarial review).
   */
  at: Date;
}

/**
 * The `payment-failed` dedupe key — also read by `findOverdueForWarning`'s
 * suppression, which is why it is exported rather than spelled out twice.
 */
export function paymentFailedDedupeKey(invoiceId: string): string {
  return `payment-failed:${invoiceId}`;
}

/**
 * The `payment-unconfirmed` dedupe key. Deliberately DISTINCT from the failed
 * one: an invoice can honestly say "we don't know yet" and later say "it
 * failed", and each must be able to land exactly once. Also suppresses the
 * `invoice-overdue` nag — nagging an owner to pay an invoice whose outcome is
 * unknown is how the unknown becomes a double charge.
 */
export function paymentUnconfirmedDedupeKey(invoiceId: string): string {
  return `payment-unconfirmed:${invoiceId}`;
}

/**
 * Render the owner-facing park notification for one arm. Pure — no DB, no
 * clock of its own — so the copy pins in the test suite assert against exactly
 * what ships.
 */
export function autoChargeParkNotification(
  arm: AutoChargeParkArm,
  args: AutoChargeParkCopyArgs,
): AutoChargeParkNotification {
  const amount = formatDollars(args.amountCents);
  const what = purposeLabel(args.purpose);
  const when = chicagoShortDate(args.at);
  const failed = {
    dedupeKey: paymentFailedDedupeKey(args.invoiceId),
    reason: 'payment-failed' as const,
  };
  const unconfirmed = {
    dedupeKey: paymentUnconfirmedDedupeKey(args.invoiceId),
    reason: 'payment-unconfirmed' as const,
  };

  switch (arm) {
    case 'declined':
      return {
        ...failed,
        title: 'Payment failed',
        body:
          `We tried your ${amount} payment for ${what} on ${when} and your card was ` +
          `declined. Want to try a different form of payment? You can use another ` +
          `card, or pay in person with cash or check.`,
      };
    case 'authentication-required':
      return {
        ...failed,
        title: 'Payment failed',
        body:
          `We tried your ${amount} payment for ${what} on ${when}, and your card needs ` +
          `verification we can't complete automatically. You can pay with another card, ` +
          `or pay in person with cash or check.`,
      };
    case 'failed-unknown-reason':
      // The copy Allison wrote on 2026-08-01 and shipped, kept VERBATIM for
      // exactly this arm: "we don't know why it failed" is what this sentence
      // already honestly is, so it stays where that is the true thing to say.
      return {
        ...failed,
        title: 'Payment failed',
        body:
          `We tried your ${amount} payment for ${what} on ${when} and it didn't go ` +
          `through. Want to try a different form of payment? You can use another card, ` +
          `or pay in person with cash or check.`,
      };
    case 'no-card-on-file':
      return {
        ...failed,
        title: 'Payment failed',
        body:
          `Your ${amount} payment for ${what} was due ${when}, but there's no card on ` +
          `file we can charge — nothing has been charged. You can add a card in the app, ` +
          `or pay in person with cash or check.`,
      };
    case 'stripe-customer-missing':
      // Our linkage broke, not their card. Blaming the card here would be a
      // confident wrong reason, which is worse than an honest vague one.
      return {
        ...failed,
        title: 'Payment failed',
        body:
          `We couldn't process your ${amount} payment for ${what} — nothing has been ` +
          `charged. We're looking into it on our end. You can also pay in person with ` +
          `cash or check.`,
      };
    case 'in-flight':
      // NOT titled "Payment failed" — the body says the opposite, and a push
      // whose title contradicts its body is read title-first.
      return {
        ...unconfirmed,
        title: 'Payment still processing',
        body:
          `Your ${amount} payment for ${what} started on ${when} and is still processing ` +
          `with your bank. Please don't pay it again — we'll let you know the moment it ` +
          `goes through or fails.`,
      };
    case 'unconfirmed':
      return {
        ...unconfirmed,
        title: "We're checking your payment",
        body:
          `We started your ${amount} payment for ${what} on ${when}, but we can't yet ` +
          `confirm whether it went through. Please don't pay it again — we're checking, ` +
          `and we'll follow up. If it went through you'll get a receipt; if not, we'll ` +
          `let you know.`,
      };
  }
}
