import { and, eq } from 'drizzle-orm';
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
 * Day 13 introduces the FIRST read here — `findSucceededForBooking`
 * gives the cancel txn the charge to refund (money-back branch).
 * Future days (14 = Stripe core, 15 = webhooks) add the write path.
 */

export interface ChargeRow {
  id: string;
  ownerId: string;
  amountCents: number;
  status: 'requires_payment' | 'succeeded' | 'failed' | 'refunded';
  bookingId: string | null;
}

const CHARGE_PROJECTION = {
  id: charges.id,
  ownerId: charges.ownerId,
  amountCents: charges.amountCents,
  status: charges.status,
  bookingId: charges.bookingId,
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
};
