import { and, eq, sql } from 'drizzle-orm';
import { charges } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `charges` (schema.sql ~line 700). Append-only
 * retained financial record — Stripe PaymentIntent rows for package
 * purchases, pay-as-you-go bookings, B&T deposits, group-class
 * enrollment, etc. NO `expired_at` — charges are never soft-deleted;
 * refunds against a charge are tracked separately in the `refunds`
 * table.
 *
 * Day 13 introduced the first read here. Day 14 adds the write path:
 *   - `create` — INSERT after Stripe `paymentIntents.create + confirm`
 *     returns; status mirrors what Stripe returned (`succeeded` for the
 *     test-mode happy path; `requires_action` / `processing` for 3DS
 *     and async-settled methods, with Day-15 webhook reconciling).
 *   - `markSucceeded` / `markFailed` — Day-15 webhook callees; left
 *     stubbed here so the cancel + tests can reference the contract.
 */

export type ChargePurpose = 'payg' | 'package' | 'board-train' | 'membership' | 'group-class';
export type ChargeStatus = 'requires_payment' | 'succeeded' | 'failed' | 'refunded';

export interface ChargeRow {
  id: string;
  ownerId: string;
  amountCents: number;
  status: ChargeStatus;
  bookingId: string | null;
  stripePaymentIntentId: string | null;
  purpose: ChargePurpose;
}

const CHARGE_PROJECTION = {
  id: charges.id,
  ownerId: charges.ownerId,
  amountCents: charges.amountCents,
  status: charges.status,
  bookingId: charges.bookingId,
  stripePaymentIntentId: charges.stripePaymentIntentId,
  purpose: charges.purpose,
} as const;

export const chargesRepository = {
  /**
   * The most-recent succeeded charge attached to this booking, if any.
   * Day-13 cancel-money-back uses this to discover that a booking was
   * money-paid (vs credit-paid, vs free-service). Returns undefined when:
   *   - the booking was credit-paid (`credit_ledger` carries it)
   *   - the booking was a free service (eval; no charge, no debit)
   *   - the charge exists but isn't 'succeeded' (the cancel route
   *     treats this as "no settled money to refund" — refund branch
   *     skipped, capacity still released, status flipped)
   *
   * Single-charge-per-booking is the design today (one PaymentIntent
   * for a B&T deposit, one for a PL session). If a future flow attaches
   * multiple charges to one booking (split-payment), this method needs
   * to return all + the cancel route needs to sum/iterate. YAGNI today.
   */
  async findSucceededForBooking(tx: Tx, bookingId: string): Promise<ChargeRow | undefined> {
    const [row] = await tx
      .select(CHARGE_PROJECTION)
      .from(charges)
      .where(and(eq(charges.bookingId, bookingId), eq(charges.status, 'succeeded')))
      .limit(1);
    return row;
  },

  /**
   * INSERT a charges row after Stripe's `paymentIntents.create + confirm`
   * returns. The Stripe status maps 1:1 to our `charge_status` enum for
   * 'succeeded' and 'requires_payment' / 'failed'; processing / 3DS
   * intermediate states map to 'requires_payment' (the Day-15 webhook
   * flips on the terminal event). Caller is responsible for catching
   * `unique_violation` on the unique stripePaymentIntentId — a retry
   * with the same Idempotency-Key returns the same PI id, and the
   * `withIdempotency` outer wrap should prevent re-entry; this is the
   * belt-and-suspenders constraint.
   */
  async create(
    tx: Tx,
    args: {
      ownerId: string;
      amountCents: number;
      currency?: string;
      status: ChargeStatus;
      purpose: ChargePurpose;
      stripePaymentIntentId: string;
      bookingId?: string | null;
      // Δ 2026-06-09: set together for a group-class enrollment charge so the
      // withdraw verb can find + refund a single dog's payment.
      cohortId?: string | null;
      dogId?: string | null;
    },
  ): Promise<ChargeRow> {
    const [row] = await tx
      .insert(charges)
      .values({
        ownerId: args.ownerId,
        amountCents: args.amountCents,
        currency: args.currency ?? 'usd',
        status: args.status,
        purpose: args.purpose,
        stripePaymentIntentId: args.stripePaymentIntentId,
        bookingId: args.bookingId ?? null,
        cohortId: args.cohortId ?? null,
        dogId: args.dogId ?? null,
      })
      .returning(CHARGE_PROJECTION);
    if (!row) {
      throw new Error('chargesRepository.create: INSERT returned no row');
    }
    return row;
  },

  /**
   * The succeeded group-class charge for one (cohort, dog) enrollment, if
   * any — the withdraw verb's "was this dog's enrollment paid-now?" probe.
   * A 'refunded' charge is excluded (already reversed), so a double-withdraw
   * finds nothing to refund. Pay-later enrollments have no charge here (the
   * money lives on an open `invoices` row instead).
   */
  async findSucceededForCohortDog(
    tx: Tx,
    args: { cohortId: string; dogId: string },
  ): Promise<ChargeRow | undefined> {
    const [row] = await tx
      .select(CHARGE_PROJECTION)
      .from(charges)
      .where(
        and(
          eq(charges.cohortId, args.cohortId),
          eq(charges.dogId, args.dogId),
          eq(charges.status, 'succeeded'),
        ),
      )
      .limit(1);
    return row;
  },

  /**
   * Look up a charge by its Stripe PaymentIntent id. Day-15 webhook will
   * use this to find the row to flip on terminal events; Day-14 uses it
   * inside the contract tests to assert the post-purchase write landed.
   */
  async findByStripePaymentIntentId(
    tx: Tx,
    stripePaymentIntentId: string,
  ): Promise<ChargeRow | undefined> {
    const [row] = await tx
      .select(CHARGE_PROJECTION)
      .from(charges)
      .where(eq(charges.stripePaymentIntentId, stripePaymentIntentId))
      .limit(1);
    return row;
  },

  /**
   * Flip a charge's status (`requires_payment` → `succeeded` / `failed`).
   * Stamps `updated_at = now()`. Idempotent — calling with the same target
   * status is a no-op write. Used by Day-15 webhook on terminal Stripe
   * events; surfaced here so the test-mode synchronous confirm path can
   * write a definitive status without round-tripping through the webhook.
   */
  async markStatus(tx: Tx, args: { id: string; status: ChargeStatus }): Promise<void> {
    await tx
      .update(charges)
      .set({ status: args.status, updatedAt: sql`now()` })
      .where(eq(charges.id, args.id));
  },

  /**
   * Read a charge by primary key. Day-15 webhook uses this after looking
   * up by PaymentIntent id to fetch the row a refund webhook matched
   * against. Returns undefined if no such row.
   */
  async findById(tx: Tx, id: string): Promise<ChargeRow | undefined> {
    const [row] = await tx
      .select(CHARGE_PROJECTION)
      .from(charges)
      .where(eq(charges.id, id))
      .limit(1);
    return row;
  },
};
