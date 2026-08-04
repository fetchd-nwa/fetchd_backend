import { deepLinkToPath, type InvoiceDeepLinkReason } from '../contracts/wire.js';
import {
  invoicesRepository,
  type OverdueInvoiceForWarning,
} from '../db/repositories/invoicesRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';

/**
 * Overdue-invoice safety net (Allison 2026-07-29). A scheduled scan in the same
 * shape as `enqueueCreditExpiryWarnings`: no single triggering event, so a
 * worker phase sweeps for card-backed invoices still open past their grace
 * window and enqueues ONE `invoice-overdue` notification each.
 *
 * This is deliberately the LAST line of defence, not a dunning ladder. Every
 * other payment path should have resolved the invoice long before it gets here
 * — the auto-charge worker settles it, a terminal failure already emits
 * `payment-failed`, and pay-in-person invoices settle at the desk. Allison's
 * framing: "this should rarely get fired but as a precaution." If it fires
 * often, something upstream is broken and THAT is the bug to fix.
 *
 * The suppression predicates live in `invoicesRepository.findOverdueForWarning`
 * (card-only, past grace, no prior `payment-failed` for the same invoice); the
 * per-invoice dedupe key makes it fire at most once, ever.
 */

/** How long past `due_at` an open invoice may sit before the owner is warned. */
export const INVOICE_OVERDUE_GRACE_DAYS = 3;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface EnqueueInvoiceOverdueWarningsResult {
  /** Invoices past grace that nothing else had already flagged. */
  scanned: number;
  /** New `invoice-overdue` rows enqueued this tick (dedupe skips excluded). */
  enqueued: number;
}

/**
 * Body copy. Terse and non-accusatory — the overwhelmingly likely cause is a
 * card that quietly stopped working, not someone dodging a bill, so the copy
 * points at the fix rather than at the owner.
 */
function overdueBody(invoice: OverdueInvoiceForWarning): string {
  const dollars = (invoice.amountCents / 100).toFixed(2);
  return `Your $${dollars} invoice hasn't gone through yet. Check the card on file so it doesn't hold up your next booking.`;
}

export async function enqueueInvoiceOverdueWarnings(
  tx: Tx,
  now: Date,
): Promise<EnqueueInvoiceOverdueWarningsResult> {
  const cutoff = new Date(now.getTime() - INVOICE_OVERDUE_GRACE_DAYS * ONE_DAY_MS);
  const overdue = await invoicesRepository.findOverdueForWarning({ cutoff }, tx);

  let enqueued = 0;
  for (const invoice of overdue) {
    const row = await scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: invoice.ownerId,
      type: 'invoice-overdue',
      trigger: 'invoice-overdue',
      // One warning per invoice, ever — the UNIQUE dedupe key is the
      // no-re-notify floor across ticks.
      dedupeKey: `invoice-overdue:${invoice.invoiceId}`,
      scheduledFor: now,
      title: 'Payment still outstanding',
      body: overdueBody(invoice),
      // Wire 1.9.0: the overdue safety net is a payment-DUE framing — money is
      // still owed and the sheet should open saying so. (Not `payment-failed`:
      // this scan's own suppression predicate excludes invoices that already
      // emitted a `payment-failed`, so the two never describe the same invoice.)
      deepLinkPath: deepLinkToPath({
        kind: 'invoice',
        id: invoice.invoiceId,
        params: { reason: 'payment-due' satisfies InvoiceDeepLinkReason },
      }),
      deepLinkKind: 'invoice',
      deepLinkId: invoice.invoiceId,
      ...(invoice.dogId !== null ? { dogId: invoice.dogId } : {}),
    });
    // `undefined` = ON CONFLICT fired (warned on a prior tick) — not a new enqueue.
    if (row !== undefined) enqueued += 1;
  }
  return { scanned: overdue.length, enqueued };
}
