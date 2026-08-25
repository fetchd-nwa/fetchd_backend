import { pgTimestampToIso } from './pgTimestamp.js';
import type { LedgerEntryWire } from '../contracts/wire.js';
import type { LedgerEntryRow } from '../db/repositories/ledgerRepository.js';

/**
 * `LedgerEntryWire` moved INTO the versioned contract in wire 1.13.0
 * (designs/wire-contract-completion.md §6; digest payments-invoices/M). It is
 * re-exported here rather than redeclared, so every existing importer keeps its
 * import path and the shape cannot drift into two definitions — the
 * `ChargeStatus` / `chargesRepository.ts:107-111` precedent. The mapper below
 * stays: serializers are not shapes (§6).
 *
 * The doc comment that lived here now lives on the wire declaration, where the
 * clients can read it.
 */
export type { LedgerEntryWire } from '../contracts/wire.js';

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
