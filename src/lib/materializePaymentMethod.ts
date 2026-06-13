import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import type { Tx } from '../db/tx.js';
import type { StripePaymentMethodSnapshot } from './stripe.js';

/**
 * The single writer for `payment_methods` rows minted from a confirmed
 * SetupIntent. Two call sites converge here:
 *   - the synchronous `POST /payment-methods/confirm` route (immediate UX), and
 *   - the `setup_intent.succeeded` webhook (async backstop).
 *
 * Both reduce to the same fact — "ensure this owner has a card row for this
 * stripe_payment_method_id" — so the logic (dedupe + first-card-default rule
 * + insert) lives in one place. Dedupe is by `stripe_payment_method_id`, so a
 * route and a webhook racing on the same card collapse to a single row.
 *
 * First-card rule: if the owner has no other live card, this one becomes the
 * default — preserving the partial-unique `payment_methods_one_default`.
 *
 * Must run inside a transaction: the dedupe read, the first-card check, and the
 * insert have to see a consistent snapshot so two concurrent writers can't both
 * decide "first card".
 */
export type MaterializePaymentMethodResult =
  | { outcome: 'created'; isDefault: boolean }
  | { outcome: 'already-present' };

export async function materializePaymentMethod(
  tx: Tx,
  args: { ownerId: string; snapshot: StripePaymentMethodSnapshot },
): Promise<MaterializePaymentMethodResult> {
  const alreadyPresent = await paymentMethodsRepository.existsByStripePaymentMethodId(
    tx,
    args.snapshot.id,
  );
  if (alreadyPresent) return { outcome: 'already-present' };

  const isFirstCard = !(await paymentMethodsRepository.hasLiveForOwner(tx, args.ownerId));
  await paymentMethodsRepository.create(tx, {
    ownerId: args.ownerId,
    stripePaymentMethodId: args.snapshot.id,
    brand: args.snapshot.brand,
    last4: args.snapshot.last4,
    expMonth: args.snapshot.expMonth,
    expYear: args.snapshot.expYear,
    cardholderName: args.snapshot.cardholderName,
    isDefault: isFirstCard,
  });
  return { outcome: 'created', isDefault: isFirstCard };
}
