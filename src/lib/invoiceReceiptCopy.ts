import type { ChargePurpose } from '../db/repositories/chargesRepository.js';

/**
 * Shared copy helpers for money notifications — the `payment-succeeded` receipt
 * (`settleInvoiceCharge`), the `payment-due` cash/check reminder (`POST
 * /invoices/:id/pay-in-person`), and (wire 1.9.0) the credit-purchase late-settle
 * pushes in
 * `webhooks/stripeEventHandlers.ts`. Pure, dependency-free formatters kept in
 * one place so no producer drifts on how a dollar amount or a charge purpose
 * reads to the owner.
 */

/** USD from cents, always with the cents: `$85.00` (design §2.7:3924). */
export function formatDollars(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

/**
 * The receipt of credits bought, which says what she got and how long she has (design
 * §2.9:4539): "$456.00 — 8 Bentonville day-school credits, expire 10 Nov." The date is
 * Chicago's, the campus's.
 */
export function creditReceiptBody(args: {
  amountCents: number;
  credits: number;
  location: string;
  mode: 'school' | 'daycare';
  expiresAt: Date;
}): string {
  const campus = `${args.location.charAt(0).toUpperCase()}${args.location.slice(1)}`;
  const program = args.mode === 'school' ? 'day-school' : 'daycare';
  const noun = args.credits === 1 ? 'credit, expires' : 'credits, expire';
  const when = args.expiresAt.toLocaleDateString('en-GB', {
    timeZone: 'America/Chicago',
    day: 'numeric',
    month: 'short',
  });
  return `${formatDollars(args.amountCents)} — ${args.credits} ${campus} ${program} ${noun} ${when}.`;
}

/**
 * Human label for the thing being charged, varied by `charge_purpose`.
 * `board-train` and `group-class` are the invoice purposes today; `package` is
 * covered for totality (an invoice can carry any purpose).
 */
export function purposeLabel(purpose: ChargePurpose): string {
  switch (purpose) {
    case 'board-train':
      return 'Board & Train program';
    case 'group-class':
      return 'group class enrollment';
    case 'package':
      return 'credit package';
  }
}
