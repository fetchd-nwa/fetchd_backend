import type { ChargePurpose } from '../db/repositories/chargesRepository.js';

/**
 * Shared copy helpers for money notifications — the `payment-succeeded` receipt
 * (`settleInvoiceCharge`), the `payment-due` cash/check reminder (`POST
 * /invoices/:id/pay-in-person`), the parked-invoice `payment-failed` push, and
 * (wire 1.9.0) the credit-purchase late-settle pushes in
 * `webhooks/stripeEventHandlers.ts`. Pure, dependency-free formatters kept in
 * one place so no producer drifts on how a dollar amount or a charge purpose
 * reads to the owner.
 */

/**
 * Whole-dollar-aware USD formatter. Stripe/invoice amounts are cents; `$120`
 * reads better than `$120.00` for round amounts, but cents show when present.
 */
export function formatDollars(amountCents: number): string {
  const dollars = amountCents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toString() : dollars.toFixed(2)}`;
}

/**
 * Human label for the thing being charged, varied by `charge_purpose`. Day-
 * program (`payg`), `board-train`, and `group-class` are the auto-charged
 * invoice purposes today; `package` / `membership` are covered for totality
 * (an invoice can carry any purpose).
 */
export function purposeLabel(purpose: ChargePurpose): string {
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
