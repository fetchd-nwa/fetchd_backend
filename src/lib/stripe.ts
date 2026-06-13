import Stripe from 'stripe';
import { env } from '../env.js';
import type { ChargeStatus } from '../db/repositories/chargesRepository.js';
import { ApiError } from './errors.js';

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

export type StripeSetupIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'canceled'
  | 'succeeded';

export interface StripeSetupIntentSnapshot {
  id: string;
  status: StripeSetupIntentStatus;
  /** Attached customer — null until the SetupIntent is associated with one. */
  customerId: StripeCustomerId | null;
  /** Attached payment method — populated once the FE confirms the SetupIntent. */
  paymentMethodId: StripePaymentMethodId | null;
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

/**
 * Map a Stripe `payment_intent.status` to our `charge_status` enum. Used at
 * both ends of the PI lifecycle:
 *   - **Day-14 sync confirm path** (`POST /credit-packages/:key/purchase`):
 *     a fresh PI returned by `paymentIntents.create + confirm` maps to the
 *     `charges` row status we INSERT.
 *   - **Day-15 webhook path** (`POST /webhooks/stripe`): a terminal
 *     `payment_intent.succeeded`/`.payment_failed` event maps to the
 *     `markStatus` update we apply to the existing `charges` row.
 *
 * The schema enum (`charge_status`) doesn't have a 1:1 match for Stripe's
 * `requires_payment_method` / `requires_confirmation` / `processing` /
 * `requires_action` / `requires_capture` — they all collapse to
 * `'requires_payment'` (a slight rename mismatch with the leading Stripe
 * status; the wire status stays honest: not-yet-succeeded, not-yet-failed).
 * Exhaustive `switch` so a future Stripe status surfaces as a TS error
 * rather than silently mapping to a fallback.
 */
export function stripeIntentStatusToChargeStatus(status: StripePaymentIntentStatus): ChargeStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'failed';
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
    case 'requires_capture':
      return 'requires_payment';
  }
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

/**
 * Day-15 narrow webhook event type — the discriminated union the dispatch
 * loop in `routes/stripeWebhook.ts` switches on. Built by the seam's
 * `constructWebhookEvent` so the rest of the codebase never imports the
 * wide `Stripe.Event` type (which carries dozens of optional shapes per
 * event type and would leak Stripe SDK details across the dependency
 * rule's "domain knows nothing about Stripe" boundary).
 *
 * Each arm carries only the fields the matching handler uses; new event
 * types arrive as new arms — the `'unhandled'` catch-all keeps the
 * receiver from 5xx-ing on a Stripe-side product release we haven't
 * wired yet.
 *
 * The mapping from Stripe's wire shapes lives in `defaultStripeClient.
 * constructWebhookEvent` (real impl) and in the test stub's
 * `setNextEvent` (test impl) — both produce this same narrow union.
 */
export type StripeWebhookEvent =
  | {
      id: string;
      type: 'payment_intent.succeeded';
      paymentIntentId: StripePaymentIntentId;
      amountCents: number;
      metadata: Record<string, string>;
    }
  | {
      id: string;
      type: 'payment_intent.payment_failed';
      paymentIntentId: StripePaymentIntentId;
      amountCents: number;
      metadata: Record<string, string>;
    }
  | {
      id: string;
      type: 'setup_intent.succeeded';
      setupIntentId: string;
      paymentMethodId: StripePaymentMethodId;
      customerId: StripeCustomerId;
    }
  | {
      id: string;
      type: 'charge.refund.updated';
      refundId: StripeRefundId;
      paymentIntentId: StripePaymentIntentId | null;
      amountCents: number;
      status: StripeRefundStatus;
    }
  | {
      id: string;
      type: 'unhandled';
      rawType: string;
    };

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
   * Retrieve a SetupIntent's terminal state — the synchronous counterpart to
   * the `setup_intent.succeeded` webhook. After the FE confirms the SetupIntent
   * client-side, `POST /payment-methods/confirm` retrieves it to (a) verify
   * `status === 'succeeded'` and (b) read back the attached `customer` +
   * `payment_method` so the `payment_methods` row is written from Stripe's
   * source of truth, never a client-supplied id. The webhook remains the async
   * backstop for the identical write (idempotent by stripe_payment_method_id).
   * A GET in Stripe's API — no idempotency key needed.
   */
  retrieveSetupIntent(setupIntentId: string): Promise<StripeSetupIntentSnapshot>;

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
   * Used by the Day-15 `setup_intent.succeeded` webhook to materialize the
   * `payment_methods` row when the FE confirms a SetupIntent client-side.
   */
  retrievePaymentMethod(
    paymentMethodId: StripePaymentMethodId,
  ): Promise<StripePaymentMethodSnapshot>;

  /**
   * Verify the `Stripe-Signature` header against the raw request body and
   * the configured webhook secret, and return the narrow {@link StripeWebhookEvent}
   * for the dispatch loop. The default impl wraps
   * `stripe.webhooks.constructEvent` and projects Stripe's wide event
   * type onto our narrow union; an invalid signature throws (the route
   * maps to 400). Test stubs verify nothing and return whichever event
   * was queued via the stub's `setNextEvent` knob.
   *
   * `signature` may be undefined when the header is absent — the seam
   * normalizes to "throw with signature_verification" so the route's
   * happy path doesn't need a separate guard.
   */
  constructWebhookEvent(rawBody: string, signature: string | undefined): StripeWebhookEvent;
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

  async retrieveSetupIntent(setupIntentId) {
    const intent = await stripeSingleton.setupIntents.retrieve(setupIntentId);
    // `customer` / `payment_method` come back as either an id string or an
    // expanded object depending on the SetupIntent — normalize both to the id.
    const customerId =
      typeof intent.customer === 'string' ? intent.customer : (intent.customer?.id ?? null);
    const paymentMethodId =
      typeof intent.payment_method === 'string'
        ? intent.payment_method
        : (intent.payment_method?.id ?? null);
    return {
      id: intent.id,
      status: intent.status,
      customerId,
      paymentMethodId,
    };
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

  constructWebhookEvent(rawBody, signature) {
    if (signature === undefined) {
      throw new ApiError('bad_request', 'missing Stripe-Signature header');
    }
    let event: Stripe.Event;
    try {
      event = stripeSingleton.webhooks.constructEvent(
        rawBody,
        signature,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiError('bad_request', `Stripe-Signature verification failed: ${reason}`);
    }
    return projectStripeEvent(event);
  },
};

/**
 * Pure projection from Stripe's wide `Stripe.Event` (per their SDK type)
 * onto our narrow {@link StripeWebhookEvent} discriminated union. Exported
 * so contract tests can drive the dispatch loop with hand-built
 * `Stripe.Event`-shaped payloads when the in-memory stub isn't used.
 *
 * Each `case` reads only the fields the matching handler needs; the
 * `'unhandled'` arm carries the raw type for log breadcrumbs. Casts are
 * pinned to the SDK's per-event object types — narrowed by the literal
 * `event.type` discriminant.
 */
export function projectStripeEvent(event: Stripe.Event): StripeWebhookEvent {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      return {
        id: event.id,
        type: 'payment_intent.succeeded',
        paymentIntentId: pi.id,
        amountCents: pi.amount,
        metadata: pi.metadata ?? {},
      };
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      return {
        id: event.id,
        type: 'payment_intent.payment_failed',
        paymentIntentId: pi.id,
        amountCents: pi.amount,
        metadata: pi.metadata ?? {},
      };
    }
    case 'setup_intent.succeeded': {
      const si = event.data.object as Stripe.SetupIntent;
      const paymentMethodId =
        typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method?.id ?? null);
      const customerId = typeof si.customer === 'string' ? si.customer : (si.customer?.id ?? null);
      if (paymentMethodId === null || customerId === null) {
        // Defensive: a setup_intent.succeeded without an attached card or
        // customer would be malformed in test mode and uncommon in prod.
        // Surface as 'unhandled' so the dispatch loop logs + 200s rather
        // than 5xx-ing and triggering retry storms.
        return { id: event.id, type: 'unhandled', rawType: event.type };
      }
      return {
        id: event.id,
        type: 'setup_intent.succeeded',
        setupIntentId: si.id,
        paymentMethodId,
        customerId,
      };
    }
    case 'charge.refund.updated': {
      const refund = event.data.object as Stripe.Refund;
      const piId =
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : (refund.payment_intent?.id ?? null);
      return {
        id: event.id,
        type: 'charge.refund.updated',
        refundId: refund.id,
        paymentIntentId: piId,
        amountCents: refund.amount,
        status: (refund.status ?? 'pending') as StripeRefundStatus,
      };
    }
    default:
      return { id: event.id, type: 'unhandled', rawType: event.type };
  }
}
