import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../client.js';
import {
  bookings,
  charges,
  cohorts,
  creditLedger,
  groupClasses,
  invoices,
  paymentMethods,
} from '../schema/schema.js';
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
  /**
   * Group-class entries only: the class this money was for, via the row's own
   * `cohort_id` → `cohorts.class_key` → `group_classes.name` (Q16, 2026-08-24,
   * `designs/enrollment-followup-copy-flow.md` §3.3). NULL for every other
   * kind, and for a legacy group-class row carrying no cohort — which is what
   * keeps those rendering the generic label they render today.
   *
   * The backend supplies the FACT; the client composes the line
   * ("Manners 1 — Waffles"). No display string is minted here — none ever has
   * been on this surface.
   */
  groupClassName: string | null;
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
        // The group-class row's OWN per-dog column, and the class its cohort
        // belongs to (Q16). Both NULL on every other purpose.
        chargeDogId: charges.dogId,
        groupClassName: groupClasses.name,
        packDogId: creditLedger.dogId,
        packMode: creditLedger.mode,
        settledInvoiceId: invoices.id,
        invoicePaidAt: invoices.paidAt,
        cardBrand: paymentMethods.brand,
        cardLast4: paymentMethods.last4,
      })
      .from(charges)
      // **Booking-lane rows only, and the exclusion is deliberate** (ADDENDUM 3
      // §A3.17, 2026-08-22). A group-class charge now carries an ANCHOR in
      // `booking_id` — the enrollment's first session — so that the money reads
      // can tell one enrollment's charge from a previous one's. That column is
      // NOT a booking-lane link for these rows: an enrollment is `weeks` rows
      // and the anchor is one arbitrary member of them, so joining it here
      // would attach a ledger line to a single week and start emitting a
      // `dog_id` this surface has never carried for group-class money. Keeping
      // them unjoined preserves today's output byte for byte — §A3.17 rules the
      // old-client blast ZERO — and the purpose-derived `category` fallback
      // below, which the comment above already describes as existing for
      // "a group-class charge spanning multiple bookings", stays the one that
      // answers for them.
      //
      // **What Q16 added, and why it is not that join returning.** A
      // group-class row's DOG rides its own `charges.dog_id` (Δ 2026-06-09:
      // "group-class enrollment is paid per-(cohort, dog)"), and its CLASS
      // rides its own `charges.cohort_id`. Both are facts about the money row
      // itself, so neither needs — or is allowed to borrow from — one
      // arbitrary week's booking.
      .leftJoin(
        bookings,
        and(eq(bookings.id, charges.bookingId), ne(charges.purpose, 'group-class')),
      )
      .leftJoin(cohorts, eq(cohorts.id, charges.cohortId))
      .leftJoin(groupClasses, eq(groupClasses.key, cohorts.classKey))
      .leftJoin(creditLedger, eq(creditLedger.chargeId, charges.id))
      .leftJoin(invoices, eq(invoices.paidChargeId, charges.id))
      .leftJoin(paymentMethods, eq(paymentMethods.id, invoices.paymentMethodId))
      .where(and(eq(charges.ownerId, ownerId), inArray(charges.status, LEDGER_CHARGE_STATUSES)));

    const chargeEntries: LedgerEntryRow[] = chargeRows.map((row) => {
      const kind = kindForPurpose(row.purpose);
      const isPackage = kind === 'credit-pack';
      const isGroupClass = row.purpose === 'group-class';
      const status: LedgerStatus = row.status === 'refunded' ? 'refunded' : 'paid';
      const isPaid = status === 'paid';
      return {
        id: row.id,
        kind,
        status,
        amountCents: row.amountCents,
        date: row.date,
        // Three sources, one per money shape: the credit grant funds a package,
        // the money row itself names the dog for a group class (Q16), and every
        // other kind reads the booking it is linked to.
        dogId: isPackage ? row.packDogId : isGroupClass ? row.chargeDogId : row.bookingLeadDog,
        category: isPackage ? null : (row.bookingCategory ?? categoryForPurpose(row.purpose)),
        mode: isPackage ? row.packMode : null,
        groupClassName: isGroupClass ? row.groupClassName : null,
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
        // The invoice twin of the charge branch's Q16 columns.
        invoiceDogId: invoices.dogId,
        groupClassName: groupClasses.name,
        paymentExpected: invoices.paymentExpected,
      })
      .from(invoices)
      // The MIRROR of the charge branch's exclusion above (§A3.18 D1.3). Since
      // §A3.18 a group-class invoice carries its enrollment's ANCHOR in
      // `booking_id` so a late settle can file its charge under the enrollment
      // it was actually for. That column is not a booking-lane link for these
      // rows — an enrollment is `weeks` rows and the anchor is one member —
      // so joining it here would attach a ledger line to a single week and
      // start emitting a `dog_id` this surface has never carried for
      // group-class money. Excluded, so the output stays byte-identical and the
      // purpose-derived `category` fallback keeps answering for them.
      //
      // Q16 reads the dog and the class off the INVOICE's own `dog_id` /
      // `cohort_id` — the pay-later twins of the charge columns, same
      // Δ 2026-06-09 per-(cohort, dog) model — so the anchor stays out of the
      // display path here too.
      .leftJoin(
        bookings,
        and(eq(bookings.id, invoices.bookingId), ne(invoices.purpose, 'group-class')),
      )
      .leftJoin(cohorts, eq(cohorts.id, invoices.cohortId))
      .leftJoin(groupClasses, eq(groupClasses.key, cohorts.classKey))
      .where(and(eq(invoices.ownerId, ownerId), eq(invoices.status, 'open')));

    const invoiceEntries: LedgerEntryRow[] = invoiceRows.map((row) => {
      const kind = kindForPurpose(row.purpose);
      const isPackage = kind === 'credit-pack';
      const isGroupClass = row.purpose === 'group-class';
      return {
        id: row.id,
        kind,
        status: 'open',
        amountCents: row.amountCents,
        date: row.date,
        dogId: isPackage ? null : isGroupClass ? row.invoiceDogId : row.bookingLeadDog,
        category: isPackage ? null : (row.bookingCategory ?? categoryForPurpose(row.purpose)),
        mode: null,
        groupClassName: isGroupClass ? row.groupClassName : null,
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
