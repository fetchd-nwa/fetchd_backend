import { pgTimestampToIso } from './pgTimestamp.js';
import type { LedgerEntryRow } from '../db/repositories/ledgerRepository.js';
import type { ServiceCategory } from './bookingBucket.js';

/**
 * `GET /invoices` wire shape — the owner's billing ledger (DATA-CONTRACT §A
 * Amendment 2026-05-30). One entry per completed/refunded charge + per open
 * invoice, mapped to the FE `InvoiceEntry` kinds. Optional fields are omitted
 * (not null) when absent: membership rows carry no dog; only sessions/payg
 * carry a category; only credit-packs carry a mode. A paid entry that settled
 * an invoice also carries settle detail (method/card/time — see
 * ledgerRepository); direct package/membership charges carry none. Since
 * 2026-08-24 (Q16) a group-class entry also carries its own `dog_id` and its
 * `group_class_name` — the two facts the client's line is composed from.
 */
export interface LedgerEntryWire {
  id: string;
  kind: 'session' | 'credit-pack' | 'membership' | 'payg';
  status: 'paid' | 'open' | 'refunded';
  amount_cents: number;
  date: string;
  dog_id?: string;
  category?: ServiceCategory;
  mode?: 'school' | 'daycare';
  /**
   * The invoice a paid entry settled (charge-sourced entries only). Payment
   * notifications deep-link by invoice id — the client matches a ledger row
   * on `id` OR this.
   */
  invoice_id?: string;
  /**
   * Open invoices only: how the owner said they'll settle it. 'in-person'
   * rows render non-payable in the app (card-paying a flagged invoice would
   * double-bill the drop-off).
   */
  payment_expected?: 'card' | 'in-person';
  /**
   * Paid entries only: how the entry settled. 'card' for every settled charge
   * today; 'cash'/'check' reserved for a future staff mark-paid flow (never
   * emitted yet). Omitted on open/refunded entries.
   */
  settled_method?: 'card' | 'cash' | 'check';
  /**
   * Paid entries only: the settling card — present ONLY when the paid charge
   * settled an invoice with a live payment_method. Omitted for direct
   * package/membership charges and non-paid entries.
   */
  settled_card?: { brand: string; last4: string };
  /**
   * Paid entries only: the precise settle timestamp (full ISO, with time).
   * Omitted on open/refunded entries.
   */
  settled_at?: string;
  /**
   * Group-class entries only: the class name off the row's own cohort
   * ("Manners 1"). Added 2026-08-24 (Q16,
   * `designs/enrollment-followup-copy-flow.md` §3.3) together with `dog_id`
   * finally being emitted for these rows — the two facts the client composes
   * "Manners 1 — Waffles · $120" from. Omitted for every other kind, and for a
   * legacy group-class row carrying no cohort, which therefore keeps rendering
   * the generic label a pre-Q16 client renders.
   *
   * Deliberately a FACT, not a display string: every ledger line in this
   * system is composed client-side, and keeping it that way is what lets the
   * copy change without a backend deploy.
   */
  group_class_name?: string;
}

export function toLedgerEntryWire(row: LedgerEntryRow): LedgerEntryWire {
  const wire: LedgerEntryWire = {
    id: row.id,
    kind: row.kind,
    status: row.status,
    amount_cents: row.amountCents,
    date: pgTimestampToIso(row.date),
  };
  if (row.dogId !== null) wire.dog_id = row.dogId;
  if (row.category !== null) wire.category = row.category;
  if (row.mode !== null) wire.mode = row.mode;
  if (row.settledInvoiceId !== null) wire.invoice_id = row.settledInvoiceId;
  if (row.paymentExpected !== null) wire.payment_expected = row.paymentExpected;
  if (row.settledMethod !== null) wire.settled_method = row.settledMethod;
  if (row.settledCard !== null) wire.settled_card = row.settledCard;
  if (row.settledAt !== null) wire.settled_at = pgTimestampToIso(row.settledAt);
  if (row.groupClassName !== null) wire.group_class_name = row.groupClassName;
  return wire;
}
