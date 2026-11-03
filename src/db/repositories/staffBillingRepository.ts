import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  ChargePurpose,
  ChargeStatus,
  InvoiceStatus,
  RefundStatus,
} from '../../contracts/wire.js';
import { db } from '../client.js';
import { charges, invoices, refunds } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * The staff billing reads (STAFF-U13; P03, wire 2.0.0; design §1.1:710-717,
 * §2.10:4682-4697) — read-only, on today's invoice shape. The route layer
 * decides who sees what (`payments` only for a caller with `refund_money`;
 * the history and the cards owner and manager only); this module only reads.
 */

export interface StaffInvoiceRow {
  id: string;
  ownerId: string;
  status: InvoiceStatus;
  purpose: ChargePurpose;
  amountCents: number;
  dogId: string | null;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  paidChargeId: string | null;
}

/** A charge that took money — the only charges a payment surface lists. */
export type MovedChargeStatus = Extract<ChargeStatus, 'succeeded' | 'refunded'>;
const MONEY_MOVED: readonly MovedChargeStatus[] = ['succeeded', 'refunded'];

export interface PaymentCapRow {
  chargeId: string;
  paidCents: number;
  refundableCents: number;
}

export interface PaymentHistoryRow extends PaymentCapRow {
  status: ChargeStatus;
  purpose: ChargePurpose;
  createdAt: string;
  dogId: string | null;
  invoiceId: string | null;
}

export interface PaymentRefundRow {
  id: string;
  chargeId: string;
  amountCents: number;
  status: RefundStatus;
  reason: string | null;
  createdAt: string;
}

const INVOICE_PROJECTION = {
  id: invoices.id,
  ownerId: invoices.ownerId,
  status: invoices.status,
  purpose: invoices.purpose,
  amountCents: invoices.amountCents,
  dogId: invoices.dogId,
  issuedAt: invoices.issuedAt,
  dueAt: invoices.dueAt,
  paidAt: invoices.paidAt,
  paidChargeId: invoices.paidChargeId,
};

/**
 * The refund cap, correlated per charge row so a list is one query (wire
 * contract notes J5; the arithmetic of `refundsRepository.sumNonFailedForCharge`
 * and of its report's `remainingCents`): the charge's `amount_cents` minus
 * every refund on it whose status is not `failed`, floored at 0. Until M5.10
 * adds `refunds.resolved_outcome`, every `resolved-external` row means the
 * money was returned, so it counts; a `withdrawn` hand-back will not.
 *
 * The outer row is spelled `charges.…`, never `${charges.id}`: in a one-table
 * select drizzle renders a column bare (`"id"`), which inside the subquery
 * binds to the subquery's own row (`r.id`) and silently matches nothing.
 */
const REFUNDABLE_CENTS = sql<number>`GREATEST(charges.amount_cents - COALESCE((
    SELECT SUM(r.amount_cents) FROM refunds r
     WHERE r.charge_id = charges.id AND r.status <> 'failed'
  ), 0), 0)::int`;

export const staffBillingRepository = {
  /** Every invoice of the owner, any status, newest first (`issued_at` DESC, then id). */
  async invoicesByOwner(ownerId: string, runner: Runner = db): Promise<StaffInvoiceRow[]> {
    return runner
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(eq(invoices.ownerId, ownerId))
      .orderBy(desc(invoices.issuedAt), asc(invoices.id));
  },

  async invoiceById(id: string, runner: Runner = db): Promise<StaffInvoiceRow | undefined> {
    const [row] = await runner
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1);
    return row;
  },

  /** The cap of each of these charges that took money, by charge id. A charge
   *  that moved no money is not a payment and is not returned. */
  async capsForCharges(
    chargeIds: readonly string[],
    runner: Runner = db,
  ): Promise<Map<string, PaymentCapRow>> {
    if (chargeIds.length === 0) return new Map();
    const rows = await runner
      .select({
        chargeId: charges.id,
        paidCents: charges.amountCents,
        refundableCents: REFUNDABLE_CENTS,
      })
      .from(charges)
      .where(and(inArray(charges.id, [...chargeIds]), inArray(charges.status, [...MONEY_MOVED])));
    return new Map(rows.map((r) => [r.chargeId, r]));
  },

  /**
   * The owner's payment history: every charge that took money, newest first
   * (`created_at` DESC, then id), each with its cap and the invoice it settled
   * (the invoice whose `paid_charge_id` is this charge; `charges` has no
   * invoice column). One query.
   */
  async paymentHistory(ownerId: string, runner: Runner = db): Promise<PaymentHistoryRow[]> {
    return runner
      .select({
        chargeId: charges.id,
        paidCents: charges.amountCents,
        refundableCents: REFUNDABLE_CENTS,
        status: charges.status,
        purpose: charges.purpose,
        createdAt: charges.createdAt,
        dogId: charges.dogId,
        invoiceId: sql<string | null>`(
          SELECT i.id FROM invoices i WHERE i.paid_charge_id = charges.id ORDER BY i.id LIMIT 1
        )`,
      })
      .from(charges)
      .where(and(eq(charges.ownerId, ownerId), inArray(charges.status, [...MONEY_MOVED])))
      .orderBy(desc(charges.createdAt), asc(charges.id));
  },

  /** Every refund on these charges, any status, oldest first (`created_at`, then id). */
  async refundsForCharges(
    chargeIds: readonly string[],
    runner: Runner = db,
  ): Promise<PaymentRefundRow[]> {
    if (chargeIds.length === 0) return [];
    return runner
      .select({
        id: refunds.id,
        chargeId: refunds.chargeId,
        amountCents: refunds.amountCents,
        status: refunds.status,
        reason: refunds.reason,
        createdAt: refunds.createdAt,
      })
      .from(refunds)
      .where(inArray(refunds.chargeId, [...chargeIds]))
      .orderBy(asc(refunds.createdAt), asc(refunds.id));
  },
};

export function isMovedChargeStatus(status: ChargeStatus): status is MovedChargeStatus {
  return (MONEY_MOVED as readonly ChargeStatus[]).includes(status);
}
