import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../client.js';
import { bookings, charges, creditLedger, invoices, paymentMethods } from '../schema/schema.js';
import type { ChargePurpose, ChargeStatus } from './chargesRepository.js';
import type { ServiceCategory } from '../../lib/bookingBucket.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

export type LedgerKind = 'session' | 'credit-pack' | 'membership' | 'payg';
export type LedgerStatus = 'paid' | 'open' | 'refunded';
export type LedgerMode = 'school' | 'daycare';

export interface LedgerEntryRow {
  id: string;
  kind: LedgerKind;
  status: LedgerStatus;
  amountCents: number;
  date: string; // ISO timestamptz
  dogId: string | null;
  category: ServiceCategory | null;
  mode: LedgerMode | null;
  /**
   * For charge-sourced entries: the invoice this charge settled
   * (`invoices.paid_charge_id` back-reference), when one exists. Payment
   * notifications deep-link by INVOICE id, so the ledger must carry it for
   * the client to match a paid entry. NULL for open-invoice entries (their
   * `id` already IS the invoice id) and for non-invoice charges.
   */
  settledInvoiceId: string | null;
  /**
   * Open-invoice entries only: how the owner said they'll settle it. An
   * 'in-person' invoice must render non-payable in the app (paying it by
   * card after flagging cash/check would double-bill the drop-off). NULL
   * for charge-sourced (already-settled) entries.
   */
  paymentExpected: 'card' | 'in-person' | null;
  /**
   * Paid entries only: how the entry settled. Every settled charge today is a
   * Stripe card charge, so this is 'card' for a charge-sourced PAID entry.
   * 'cash'/'check' are reserved for a future staff mark-paid flow (none exists
   * yet — never emitted today). NULL for open and refunded entries.
   */
  settledMethod: 'card' | 'cash' | 'check' | null;
  /**
   * Paid entries only: the card that settled the entry, recoverable ONLY when
   * the paid charge back-references an invoice carrying a live payment_method
   * (`invoices.paid_charge_id` + `invoices.payment_method_id`). NULL for direct
   * package/membership charges (no invoice link, no card) and for non-paid
   * entries.
   */
  settledCard: { brand: string; last4: string } | null;
  /**
   * Paid entries only: the precise settle timestamp (full timestamptz, with
   * time). Prefers `invoices.paid_at` when invoice-linked, else the charge's
   * own `created_at`. NULL for open and refunded entries.
   */
  settledAt: string | null;
}

// A charge is a ledger line only when it represents a completed money event.
// `requires_payment` (pending/3DS) and `failed` charges are not shown.
const LEDGER_CHARGE_STATUSES: ChargeStatus[] = ['succeeded', 'refunded'];

function kindForPurpose(purpose: ChargePurpose): LedgerKind {
  switch (purpose) {
    case 'package':
      return 'credit-pack';
    case 'payg':
      return 'payg';
    case 'membership':
      return 'membership';
    case 'board-train':
    case 'group-class':
      return 'session';
  }
}

// Category fallback for session/payg rows whose charge/invoice isn't linked to
// a booking (e.g. a B&T invoice still keyed to the request, or a group-class
// charge spanning multiple bookings). The booking's category wins when present.
function categoryForPurpose(purpose: ChargePurpose): ServiceCategory | null {
  switch (purpose) {
    case 'board-train':
      return 'board-and-train';
    case 'group-class':
      return 'group-class';
    default:
      return null;
  }
}

export const ledgerRepository = {
  /**
   * The owner's billing ledger, newest first: every completed/refunded
   * `charge` plus every `open` invoice, reconstructed into the FE's
   * `InvoiceEntry` shape from the real money tables.
   *
   * Notes on fidelity:
   *   - Credit-funded day-school/day-care sessions are NOT ledger lines — the
   *     `package` purchase that funded them is the money event. This is the
   *     real billing model, not the prototype's per-session fabrication.
   *   - dog/mode come from `credit_ledger` for package purchases; dog/category
   *     come from the linked `booking` for payg/board-train/group-class.
   *   - Card brand/last4 is recovered for a paid charge that SETTLED an invoice
   *     (`invoices.paid_charge_id` back-reference → `invoices.payment_method_id`
   *     → `payment_methods`). `charges` itself carries no payment_method link
   *     (only `stripe_payment_intent_id`), so a DIRECT package/membership charge
   *     — with no invoice link — still renders no card chip rather than a
   *     fabricated one.
   */
  async listForOwner(runner: Runner, ownerId: string): Promise<LedgerEntryRow[]> {
    const chargeRows = await runner
      .select({
        id: charges.id,
        amountCents: charges.amountCents,
        status: charges.status,
        purpose: charges.purpose,
        date: charges.createdAt,
        bookingCategory: bookings.category,
        bookingLeadDog: bookings.leadDogId,
        packDogId: creditLedger.dogId,
        packMode: creditLedger.mode,
        settledInvoiceId: invoices.id,
        invoicePaidAt: invoices.paidAt,
        cardBrand: paymentMethods.brand,
        cardLast4: paymentMethods.last4,
      })
      .from(charges)
      .leftJoin(bookings, eq(bookings.id, charges.bookingId))
      .leftJoin(creditLedger, eq(creditLedger.chargeId, charges.id))
      .leftJoin(invoices, eq(invoices.paidChargeId, charges.id))
      .leftJoin(paymentMethods, eq(paymentMethods.id, invoices.paymentMethodId))
      .where(and(eq(charges.ownerId, ownerId), inArray(charges.status, LEDGER_CHARGE_STATUSES)));

    const chargeEntries: LedgerEntryRow[] = chargeRows.map((row) => {
      const kind = kindForPurpose(row.purpose);
      const isPackage = kind === 'credit-pack';
      const status: LedgerStatus = row.status === 'refunded' ? 'refunded' : 'paid';
      const isPaid = status === 'paid';
      return {
        id: row.id,
        kind,
        status,
        amountCents: row.amountCents,
        date: row.date,
        dogId: isPackage ? row.packDogId : row.bookingLeadDog,
        category: isPackage ? null : (row.bookingCategory ?? categoryForPurpose(row.purpose)),
        mode: isPackage ? row.packMode : null,
        settledInvoiceId: row.settledInvoiceId,
        paymentExpected: null,
        // Every settled charge today is a Stripe card charge; refunds carry no
        // settle detail.
        settledMethod: isPaid ? 'card' : null,
        // Card only when the paid charge settled an invoice with a live method.
        settledCard:
          isPaid && row.cardBrand !== null && row.cardLast4 !== null
            ? { brand: row.cardBrand, last4: row.cardLast4 }
            : null,
        // Precise settle time: the invoice's paid_at when linked, else the
        // charge's own created_at.
        settledAt: isPaid ? (row.invoicePaidAt ?? row.date) : null,
      };
    });

    const invoiceRows = await runner
      .select({
        id: invoices.id,
        amountCents: invoices.amountCents,
        purpose: invoices.purpose,
        date: invoices.issuedAt,
        bookingCategory: bookings.category,
        bookingLeadDog: bookings.leadDogId,
        paymentExpected: invoices.paymentExpected,
      })
      .from(invoices)
      .leftJoin(bookings, eq(bookings.id, invoices.bookingId))
      .where(and(eq(invoices.ownerId, ownerId), eq(invoices.status, 'open')));

    const invoiceEntries: LedgerEntryRow[] = invoiceRows.map((row) => {
      const kind = kindForPurpose(row.purpose);
      const isPackage = kind === 'credit-pack';
      return {
        id: row.id,
        kind,
        status: 'open',
        amountCents: row.amountCents,
        date: row.date,
        dogId: isPackage ? null : row.bookingLeadDog,
        category: isPackage ? null : (row.bookingCategory ?? categoryForPurpose(row.purpose)),
        mode: null,
        settledInvoiceId: null,
        paymentExpected: row.paymentExpected,
        settledMethod: null,
        settledCard: null,
        settledAt: null,
      };
    });

    return [...chargeEntries, ...invoiceEntries].sort((a, b) => b.date.localeCompare(a.date));
  },
};
