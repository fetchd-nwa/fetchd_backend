import Stripe from 'stripe';
import { env } from '../env.js';

/**
 * Stripe seam (Day 14). All Stripe API calls flow through `StripeClient`;
 * routes consume it via DI (`registerXxxRoute(app, { stripe })`) so contract
 * tests substitute an in-memory stub and the suite stays offline.
 *
 * Design choices:
 *   - **Test mode in dev/staging, live in prod** — the secret in env decides;
 *     `payments_enabled` (Day-20 launch gate) is the operator kill switch, not
 *     a code branch here.
 *   - **Idempotency keys flow through** the same way Stripe wants them:
 *     `idempotencyKey` is passed on every write call so a client retry with
 *     the same `Idempotency-Key` header dedupes on Stripe's side AND the DB
 *     side (`withMutation` + `withIdempotency`).
 *   - **API version is left at the SDK default** so it aligns with the
 *     Stripe Dashboard account-level pin — flipping the dashboard upgrades
 *     both at once without a redeploy.
 *   - **No PCI** crosses this boundary: PAN/CVC are collected client-side by
 *     Stripe Elements; we only see the resulting `payment_method` token +
 *     the displayable bits (brand/last4/exp).
 *
 * The interface is narrow — only the 5 verbs Day-14 actually calls. Adding a
 * method here when Day-15 wires webhooks is the rule-of-two trigger; new
 * verbs land alongside their first caller.
 */

const stripeSingleton = new Stripe(env.STRIPE_SECRET_KEY);

export type StripeCustomerId = string;
export type StripePaymentMethodId = string;
export type StripePaymentIntentId = string;
export type StripeRefundId = string;

export interface StripePaymentMethodSnapshot {
  id: StripePaymentMethodId;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  cardholderName: string;
}

export type StripePaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

export interface StripePaymentIntentResult {
  id: StripePaymentIntentId;
  status: StripePaymentIntentStatus;
  clientSecret: string | null;
  amountCents: number;
}

export type StripeRefundStatus =
  | 'pending'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface StripeRefundResult {
  id: StripeRefundId;
  status: StripeRefundStatus;
  amountCents: number;
}

export interface StripeClient {
  /**
   * Create a Stripe customer for an owner — once per owner. Idempotency key
   * is required so a retried POST /payment-methods/setup-intent doesn't
   * create duplicate customers in Stripe. Returns the new customer id; the
   * caller is responsible for persisting it in `stripe_customers`.
   */
  createCustomer(
    args: { email: string; name: string; ownerId: string },
    idempotencyKey: string,
  ): Promise<{ id: StripeCustomerId }>;

  /**
   * Create a SetupIntent for adding a future-use payment method. Returns
   * the `client_secret` the FE confirms via Stripe Elements; on success
   * Stripe fires `setup_intent.succeeded` → Day-15 webhook writes the
   * `payment_methods` row with the attached `payment_method` id.
   */
  createSetupIntent(
    args: { customerId: StripeCustomerId },
    idempotencyKey: string,
  ): Promise<{ id: string; clientSecret: string }>;

  /**
   * Create + confirm a PaymentIntent in one round-trip — the "synchronous
   * confirmation" path the credit-purchase route uses (DATA-CONTRACT §G,
   * HANDOFF Day-14). With a stored card + test mode, this returns
   * `status='succeeded'` immediately; in production a 3DS card returns
   * `'requires_action'` and the FE finishes via the returned client_secret.
   */
  createAndConfirmPaymentIntent(
    args: {
      customerId: StripeCustomerId;
      paymentMethodId: StripePaymentMethodId;
      amountCents: number;
      currency: string;
      metadata: Record<string, string>;
    },
    idempotencyKey: string,
  ): Promise<StripePaymentIntentResult>;

  /**
   * Detach a payment method from a Stripe customer. Used by DELETE
   * /payment-methods/:id post-commit — the DB-side soft-expire is the
   * source of truth; this is best-effort cleanup so the card no longer
   * appears on Stripe's saved-card list. Failures are logged + swallowed
   * by the caller; the Day-15 webhook reconciliation can catch drift.
   */
  detachPaymentMethod(paymentMethodId: StripePaymentMethodId): Promise<void>;

  /**
   * Refund a portion (or all) of a prior PaymentIntent. Used by POST
   * /bookings/:id/cancel money-back branch post-commit (Day-13 stubbed
   * this; Day-14 wires it). Stripe is asynchronous for refunds — the
   * initial status is usually 'pending'; Day-15 webhook flips the
   * `refunds` row's `status` on `charge.refund.updated`.
   */
  createRefund(
    args: { paymentIntentId: StripePaymentIntentId; amountCents: number; reason?: string },
    idempotencyKey: string,
  ): Promise<StripeRefundResult>;

  /**
   * Fetch a payment method's displayable bits (brand/last4/exp/cardholder).
   * Used by the Day-14 SetupIntent → `payment_methods` write path when the
   * FE confirms the SetupIntent client-side and POSTs back the resulting
   * payment_method id. The Day-15 webhook will be the long-term canonical
   * source; the Day-14 synchronous variant exists so the test-mode flow
   * can complete without spinning up the webhook handler.
   */
  retrievePaymentMethod(
    paymentMethodId: StripePaymentMethodId,
  ): Promise<StripePaymentMethodSnapshot>;
}

/**
 * The default `StripeClient` implementation — direct SDK calls. Routes
 * substitute this for an in-memory stub via DI in contract tests. Errors
 * from Stripe are surfaced as-is (Stripe.errors.* subclasses); routes that
 * call this in a `withMutation` block let the error bubble to the error
 * mapper, which is rough today — Day-15 (webhooks) will likely formalize
 * the Stripe-error → API-error mapping. Pre-Day-15 callers either swallow
 * + log (post-commit detach/refund) or re-throw (sync purchase confirm).
 */
export const defaultStripeClient: StripeClient = {
  async createCustomer(args, idempotencyKey) {
    const customer = await stripeSingleton.customers.create(
      {
        email: args.email,
        name: args.name,
        metadata: { owner_id: args.ownerId },
      },
      { idempotencyKey },
    );
    return { id: customer.id };
  },

  async createSetupIntent(args, idempotencyKey) {
    const intent = await stripeSingleton.setupIntents.create(
      {
        customer: args.customerId,
        usage: 'off_session',
        payment_method_types: ['card'],
      },
      { idempotencyKey },
    );
    if (intent.client_secret === null) {
      throw new Error(`Stripe SetupIntent ${intent.id} returned null client_secret — unexpected`);
    }
    return { id: intent.id, clientSecret: intent.client_secret };
  },

  async createAndConfirmPaymentIntent(args, idempotencyKey) {
    const intent = await stripeSingleton.paymentIntents.create(
      {
        amount: args.amountCents,
        currency: args.currency,
        customer: args.customerId,
        payment_method: args.paymentMethodId,
        confirm: true,
        off_session: true,
        metadata: args.metadata,
      },
      { idempotencyKey },
    );
    return {
      id: intent.id,
      status: intent.status as StripePaymentIntentStatus,
      clientSecret: intent.client_secret,
      amountCents: intent.amount,
    };
  },

  async detachPaymentMethod(paymentMethodId) {
    await stripeSingleton.paymentMethods.detach(paymentMethodId);
  },

  async createRefund(args, idempotencyKey) {
    const refund = await stripeSingleton.refunds.create(
      {
        payment_intent: args.paymentIntentId,
        amount: args.amountCents,
        ...(args.reason !== undefined
          ? { reason: args.reason as Stripe.RefundCreateParams.Reason }
          : {}),
      },
      { idempotencyKey },
    );
    return {
      id: refund.id,
      status: refund.status as StripeRefundStatus,
      amountCents: refund.amount,
    };
  },

  async retrievePaymentMethod(paymentMethodId) {
    const pm = await stripeSingleton.paymentMethods.retrieve(paymentMethodId);
    if (pm.card === null || pm.card === undefined) {
      throw new Error(
        `Stripe payment_method ${pm.id} has no card details — non-card payment methods are not supported`,
      );
    }
    const card = pm.card;
    return {
      id: pm.id,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      cardholderName: pm.billing_details.name ?? '',
    };
  },
};
