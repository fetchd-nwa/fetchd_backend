import { db } from '../db/client.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { stripeCustomersRepository } from '../db/repositories/stripeCustomersRepository.js';
import type { Tx } from '../db/tx.js';
import { ApiError } from './errors.js';

/**
 * Validate the (owner, payment_method, stripe_customer) tuple required
 * for any pre-tx Stripe `paymentIntents.create + confirm` call. Extracted
 * Day-15 at the rule-of-two trigger (`creditPackages.ts` had been the
 * one site; `invoices.ts` and `requestConfirmPayment.ts` make it three).
 *
 * Read-only: pool reads as a pre-validation before a route opens its transaction, or
 * inside tx1 when the card must be read after the refusals. It only surfaces the right
 * 404 / 422 shape when state changed between request issuance and Stripe call.
 *
 * 404 collapses for "missing payment method" + "not yours" + "expired"
 * — payment_method ids don't enumerate across owners; one shape covers
 * all three. 422 for "owner has a payment method but no stripe_customers
 * row" surfaces the broken API-contract case (the SetupIntent route is
 * supposed to provision the customer alongside the method; if we're
 * here, something wrote payment_methods out of band — typically a test
 * fixture without the seed).
 */
export async function loadStripePaymentContext(
  args: { ownerId: string; paymentMethodId: string },
  runner: Tx | typeof db = db,
): Promise<{ stripeCustomerId: string; stripePaymentMethodId: string }> {
  const pm = await paymentMethodsRepository.findLiveByIdForOwner(runner, {
    id: args.paymentMethodId,
    ownerId: args.ownerId,
  });
  if (pm === undefined) {
    throw new ApiError('not_found', `payment method ${args.paymentMethodId} not found`);
  }
  const customer = await stripeCustomersRepository.findByOwner(runner, args.ownerId);
  if (customer === undefined) {
    throw new ApiError(
      'invalid_payload',
      `owner ${args.ownerId} has a payment method but no stripe_customers row`,
    );
  }
  return {
    stripeCustomerId: customer.stripeCustomerId,
    stripePaymentMethodId: pm.stripePaymentMethodId,
  };
}
