import { and, eq, sql } from 'drizzle-orm';
import { ne } from 'drizzle-orm';
import { refunds } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `refunds` (schema.sql ~line 778). Append-only
 * retained financial record — one row per refund attempt against a
 * prior Stripe charge. Status transitions only (no `expired_at`):
 *   'pending' → Stripe API call queued post-commit (Day 14 wires the
 *     real Stripe seam; Day 13 stubs it)
 *   'succeeded' → webhook (Day 15) flips this on confirmed refund
 *   'failed' → webhook flips this if Stripe rejects
 *
 * The cumulative-refund→`charges.refunded` rule (DATA-CONTRACT §I) is
 * API logic, not a schema invariant: the webhook handler sums all
 * succeeded refunds for a charge_id and flips `charges.status` to
 * 'refunded' only when the sum equals the charge amount. Partial
 * refunds are allowed.
 *
 * Day 13 introduces the FIRST write — `createPending` from the
 * cancel-money-back branch. Reads come later (Day 19 staff portal
 * "refunds history" — out of scope).
 */

export interface RefundRow {
  id: string;
  ownerId: string;
  chargeId: string;
  bookingId: string | null;
  amountCents: number;
  status: 'pending' | 'succeeded' | 'failed';
  stripeRefundId: string | null;
}

const REFUND_PROJECTION = {
  id: refunds.id,
  ownerId: refunds.ownerId,
  chargeId: refunds.chargeId,
  bookingId: refunds.bookingId,
  amountCents: refunds.amountCents,
  status: refunds.status,
  stripeRefundId: refunds.stripeRefundId,
} as const;

export const refundsRepository = {
  /**
   * Sum of non-failed refund amounts for one charge. Used by the cancel
   * txn to compute the maximum refund allowed (charge.amount_cents
   * minus already-refunded). Pending counts: a pending refund is "in
   * flight" and the API treats it as committed-pending-webhook for
   * the purpose of capacity (we don't double-refund). If the Stripe
   * call fails the webhook flips status to 'failed' and the amount
   * drops out of the sum on retry.
   *
   * Returns 0 if no prior refunds exist (the common case — first
   * cancel of a money-paid booking).
   */
  async sumNonFailedForCharge(tx: Tx, chargeId: string): Promise<number> {
    const [row] = await tx
      .select({
        total: sql<number | null>`COALESCE(SUM(${refunds.amountCents})::int, 0)`.as('total'),
      })
      .from(refunds)
      .where(and(eq(refunds.chargeId, chargeId), ne(refunds.status, 'failed')));
    return row?.total ?? 0;
  },

  /**
   * INSERT one refund row at `status='pending'`. Stripe API call
   * happens POST-commit (same shape Day-10 used for payment_intents
   * create). Day-15 webhook flips status to 'succeeded' or 'failed'.
   *
   * Caller is responsible for asserting `amountCents <= charge.amount
   * - sumNonFailedForCharge(chargeId)` before calling — the DATA-
   * CONTRACT §I "cumulative refunds ≤ charge" rule is API logic.
   * Schema CHECK only enforces `amount_cents > 0`.
   */
  async createPending(
    tx: Tx,
    args: {
      ownerId: string;
      chargeId: string;
      bookingId: string;
      amountCents: number;
      reason?: string | null;
    },
  ): Promise<RefundRow> {
    const [row] = await tx
      .insert(refunds)
      .values({
        ownerId: args.ownerId,
        chargeId: args.chargeId,
        bookingId: args.bookingId,
        amountCents: args.amountCents,
        reason: args.reason ?? null,
        // status defaults to 'pending'; stripeRefundId NULL until the
        // post-commit Stripe call resolves (Day 14).
      })
      .returning(REFUND_PROJECTION);
    if (!row) {
      throw new Error('refundsRepository.createPending: refunds INSERT returned no row');
    }
    return row;
  },
};
