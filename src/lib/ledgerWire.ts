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
 * ledgerRepository); direct package/membership charges carry none.
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
  return wire;
}
