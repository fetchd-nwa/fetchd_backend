import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { stripeCustomers } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `stripe_customers` (schema.sql ~line 712). One row per
 * owner (PK is `owner_id`), mapping to Stripe's `customer.id`. Day 14 lazy-
 * provisions: an owner who has never added a card has no row; the first
 * POST /payment-methods/setup-intent creates the Stripe customer and inserts
 * the row in the same txn.
 *
 * The row is retained on `owners` delete via `ON DELETE RESTRICT` (real
 * money downstream — the Stripe customer is the link to charge/refund
 * history). No `expired_at`; cancelling a customer in Stripe is rare and
 * out of scope for v1.
 */

export interface StripeCustomerRow {
  ownerId: string;
  stripeCustomerId: string;
}

const STRIPE_CUSTOMER_PROJECTION = {
  ownerId: stripeCustomers.ownerId,
  stripeCustomerId: stripeCustomers.stripeCustomerId,
} as const;

export const stripeCustomersRepository = {
  /**
   * The Stripe customer id for this owner, or undefined if never provisioned.
   * Returning undefined drives the lazy-create branch in the setup-intent
   * route.
   */
  async findByOwner(runner: Runner, ownerId: string): Promise<StripeCustomerRow | undefined> {
    const [row] = await runner
      .select(STRIPE_CUSTOMER_PROJECTION)
      .from(stripeCustomers)
      .where(eq(stripeCustomers.ownerId, ownerId))
      .limit(1);
    return row;
  },

  /**
   * INSERT the mapping row after Stripe has minted the customer. Caller's
   * responsibility to make the Stripe call idempotent (we pass the
   * Idempotency-Key through to Stripe.customers.create); the DB INSERT is
   * a simple write — a retry that hits the `withIdempotency` replay path
   * never re-enters this method.
   */
  async create(
    tx: Tx,
    args: { ownerId: string; stripeCustomerId: string },
  ): Promise<StripeCustomerRow> {
    const [row] = await tx
      .insert(stripeCustomers)
      .values({ ownerId: args.ownerId, stripeCustomerId: args.stripeCustomerId })
      .returning(STRIPE_CUSTOMER_PROJECTION);
    if (!row) {
      throw new Error('stripeCustomersRepository.create: INSERT returned no row');
    }
    return row;
  },
};
