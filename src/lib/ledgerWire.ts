import { pgTimestampToIso } from './pgTimestamp.js';
import type { LedgerEntryRow } from '../db/repositories/ledgerRepository.js';
import type { ServiceCategory } from './bookingBucket.js';

/**
 * `GET /invoices` wire shape — the owner's billing ledger (DATA-CONTRACT §A
 * Amendment 2026-05-30). One entry per completed/refunded charge + per open
 * invoice, mapped to the FE `InvoiceEntry` kinds. Optional fields are omitted
 * (not null) when absent: membership rows carry no dog; only sessions/payg
 * carry a category; only credit-packs carry a mode. No `payment` field — the
 * schema doesn't link a charge to its card (see ledgerRepository).
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
  return wire;
}
