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
