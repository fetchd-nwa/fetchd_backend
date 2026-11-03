import type {
  StaffInvoiceWire,
  StaffPaymentRefundWire,
  StaffPaymentWire,
  StaffRole,
} from '../contracts/wire.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import {
  isMovedChargeStatus,
  staffBillingRepository,
  type PaymentCapRow,
  type PaymentRefundRow,
  type StaffInvoiceRow,
} from '../db/repositories/staffBillingRepository.js';
import { pgTimestampToIso } from './pgTimestamp.js';
import { staffCapabilities } from './staffCapabilities.js';

/**
 * STAFF-U13's wires (P03, wire 2.0.0): what each staff role reads of a
 * family's billing. One rule decides `payments`: the caller's
 * `capabilities.refund_money`, computed on each call from the same reads
 * `GET /me` makes, so a list edit or a limit change shows at the next read.
 */

/** `capabilities.refund_money` for this role, now (wire contract notes J3). */
export async function callerMayRefund(role: StaffRole): Promise<boolean> {
  const [lists, limit] = await Promise.all([
    settingsRepository.staff(),
    settingsRepository.refundAnyRoleLimitCents(),
  ]);
  return staffCapabilities(role, lists, limit).refund_money;
}

/**
 * The invoices as staff read them. With `refundMoney` every invoice carries
 * `payments` — the one charge that settled it, or `[]` — read in one query for
 * the whole list; without it no invoice carries the key at all (a missing key
 * means "not yours to see", never "no payments").
 */
export async function toStaffInvoiceWires(
  rows: readonly StaffInvoiceRow[],
  refundMoney: boolean,
): Promise<StaffInvoiceWire[]> {
  if (!refundMoney) return rows.map((row) => invoiceWire(row));
  const caps = await staffBillingRepository.capsForCharges(
    rows.flatMap((row) => (row.paidChargeId === null ? [] : [row.paidChargeId])),
  );
  return rows.map((row) => {
    const cap = row.paidChargeId === null ? undefined : caps.get(row.paidChargeId);
    return { ...invoiceWire(row), payments: cap === undefined ? [] : [paymentWire(cap)] };
  });
}

function invoiceWire(row: StaffInvoiceRow): StaffInvoiceWire {
  const wire: StaffInvoiceWire = {
    id: row.id,
    owner_id: row.ownerId,
    status: row.status,
    purpose: row.purpose,
    amount_cents: row.amountCents,
    // Settled whole by one charge today; never reduced by a refund (J2).
    paid_cents: row.status === 'paid' ? row.amountCents : 0,
    issued_at: pgTimestampToIso(row.issuedAt),
    due_at: pgTimestampToIso(row.dueAt),
  };
  if (row.dogId !== null) wire.dog_id = row.dogId;
  if (row.paidAt !== null) wire.paid_at = pgTimestampToIso(row.paidAt);
  return wire;
}

function paymentWire(cap: PaymentCapRow) {
  return {
    payment_id: cap.chargeId,
    paid_cents: cap.paidCents,
    refundable_cents: cap.refundableCents,
  };
}

/** The owner's payment history: every charge that took money, with its cap,
 *  its invoice and its refunds (two queries for the whole list). */
export async function staffPaymentHistory(ownerId: string): Promise<StaffPaymentWire[]> {
  const rows = await staffBillingRepository.paymentHistory(ownerId);
  const refunds = await staffBillingRepository.refundsForCharges(rows.map((r) => r.chargeId));
  const byCharge = new Map<string, StaffPaymentRefundWire[]>();
  for (const refund of refunds) {
    byCharge.set(refund.chargeId, [...(byCharge.get(refund.chargeId) ?? []), refundWire(refund)]);
  }
  return rows.map((row) => {
    if (!isMovedChargeStatus(row.status)) {
      throw new Error(`charge ${row.chargeId} is '${row.status}', not a payment`);
    }
    const wire: StaffPaymentWire = {
      ...paymentWire(row),
      status: row.status,
      purpose: row.purpose,
      created_at: pgTimestampToIso(row.createdAt),
      refunds: byCharge.get(row.chargeId) ?? [],
    };
    if (row.dogId !== null) wire.dog_id = row.dogId;
    if (row.invoiceId !== null) wire.invoice_id = row.invoiceId;
    return wire;
  });
}

function refundWire(row: PaymentRefundRow): StaffPaymentRefundWire {
  const wire: StaffPaymentRefundWire = {
    id: row.id,
    amount_cents: row.amountCents,
    status: row.status,
    created_at: pgTimestampToIso(row.createdAt),
  };
  if (row.reason !== null) wire.reason = row.reason;
  return wire;
}
