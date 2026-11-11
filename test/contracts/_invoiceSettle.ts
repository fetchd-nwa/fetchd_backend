import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import type { Tx } from '../../src/db/tx.js';
import {
  resolveInvoiceAnchorBookingId,
  settleChargeAgainstInvoice,
  type SettleInvoiceChargeArgs,
  type SettleInvoiceChargeResult,
} from '../../src/lib/settleInvoiceCharge.js';

/**
 * A succeeded charge for this invoice, written as the test's given, then the production
 * entry: `settleChargeAgainstInvoice`, the half `confirmCharge.ts` settles every invoice
 * through. `settleInvoiceCharge()` did both and had no production caller from P17; it left
 * at P19 (build DECISIONS 168(a), 179(b), 183(e)), and this is what its tests still need:
 * a second tender to race, or a late success on an invoice no live path can pay.
 *
 * The charge's `booking_id` comes from the live anchor rule, `resolveInvoiceAnchorBookingId`,
 * the one `/pay`'s tx1 writes with (`routes/invoices.ts`), so a test of the anchor reads that
 * rule, and the copy here is only how the given is written.
 */
export async function settleWithNewCharge(
  tx: Tx,
  args: SettleInvoiceChargeArgs,
): Promise<SettleInvoiceChargeResult> {
  const { invoice } = args;
  const charge = await chargesRepository.create(tx, {
    ownerId: invoice.ownerId,
    amountCents: args.amountCents,
    status: 'succeeded',
    purpose: args.purpose,
    stripePaymentIntentId: args.paymentIntentId,
    bookingId: await resolveInvoiceAnchorBookingId(tx, invoice, args.log),
    cohortId: invoice.cohortId,
    dogId: invoice.dogId,
  });
  return settleChargeAgainstInvoice(tx, { ...args, chargeId: charge.id });
}
