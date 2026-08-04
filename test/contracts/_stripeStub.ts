import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { ApiError } from '../../src/lib/errors.js';
import { normalizeThrownConfirmError } from '../../src/lib/stripe.js';
import type {
  StripeClient,
  StripePaymentIntentResult,
  StripePaymentIntentStatus,
  StripePaymentMethodSnapshot,
  StripeRefundResult,
  StripeSetupIntentSnapshot,
  StripeWebhookEvent,
} from '../../src/lib/stripe.js';

/**
 * In-memory `StripeClient` for contract tests. Lets the suite assert
 * Stripe-side side-effects (which API was called, with what args, how
 * many times) without hitting the network. Each test that touches a
 * Stripe-aware route constructs its own stub and passes it to the
 * route registration's `stripe` opt — no global mutable state.
 *
 * Default behavior mirrors test-mode happy paths:
 *   - `createCustomer` → returns `cus_test_<random>`
 *   - `createSetupIntent` → returns `seti_test_*` + a stable client_secret
 *   - `createAndConfirmPaymentIntent` → returns `pi_test_*` at
 *     status='succeeded' UNLESS overridden via `setNextIntentStatus`
 *   - `createRefund` → returns `re_test_*` at status='pending'
 *
 * Override knobs:
 *   - `setNextIntentStatus(status)` — next `createAndConfirmPaymentIntent`
 *     returns that status (and clientSecret = `pi_test_*_secret_xyz`)
 *   - `setNextIntentThrowsCardError(status)` — next confirm simulates Stripe's
 *     OTHER failure fork (a thrown card error carrying the failed intent). It
 *     runs the simulated throw through the PRODUCTION normalizer, so a route
 *     test driving this lever exercises the real 1.9.0 seam rather than a
 *     lookalike — which is the whole point: the two forks must be
 *     indistinguishable downstream.
 *   - `setNextIntentThrowsTransport(err)` — next confirm throws a NON-card
 *     Stripe error (connection/API/rate-limit). The seam rethrows those
 *     untouched, so this is how a test pins "an outage is not a decline".
 *   - `throwOnDetach()` — next `detachPaymentMethod` rejects
 *   - `throwOnRefund()` — next `createRefund` rejects
 *   - `throwOnCancel()` — next `cancelPaymentIntent` rejects
 *
 * All Stripe-facing calls are recorded as discriminated-union entries in
 * `calls`; tests can `.filter(c => c.method === 'createRefund')` to assert
 * that a route fired the expected post-commit call AND get type-safe
 * access to `.args` (the args type narrows on the discriminant).
 */

/** Discriminated-union over StripeClient method args. The `method` tag
 *  narrows `args` so tests can read typed fields without an `as` cast. */
export type StripeStubCall =
  | {
      method: 'createCustomer';
      args: Parameters<StripeClient['createCustomer']>[0];
      idempotencyKey: string;
    }
  | {
      method: 'createSetupIntent';
      args: Parameters<StripeClient['createSetupIntent']>[0];
      idempotencyKey: string;
    }
  | {
      method: 'retrieveSetupIntent';
      args: { setupIntentId: string };
      idempotencyKey: null;
    }
  | {
      method: 'createAndConfirmPaymentIntent';
      args: Parameters<StripeClient['createAndConfirmPaymentIntent']>[0];
      idempotencyKey: string;
    }
  | {
      method: 'detachPaymentMethod';
      args: { paymentMethodId: string };
      idempotencyKey: null;
    }
  | {
      method: 'cancelPaymentIntent';
      args: { paymentIntentId: string };
      idempotencyKey: null;
    }
  | {
      method: 'createRefund';
      args: Parameters<StripeClient['createRefund']>[0];
      idempotencyKey: string;
    }
  | {
      method: 'retrievePaymentMethod';
      args: { paymentMethodId: string };
      idempotencyKey: null;
    }
  | {
      method: 'constructWebhookEvent';
      args: { rawBody: string; signature: string | undefined };
      idempotencyKey: null;
    };

export interface StripeStub extends StripeClient {
  /** Every Stripe call this stub received, in order. */
  readonly calls: StripeStubCall[];
  /** Force the next PaymentIntent confirm to return this status. */
  setNextIntentStatus(status: StripePaymentIntentStatus): void;
  /**
   * Force the next PaymentIntent confirm to take Stripe's THROWN fork: a
   * `StripeCardError` carrying a failed PaymentIntent at `status`, run through
   * the production normalizer. Per the `StripeClient` contract the call still
   * RESOLVES — a card-level failure is a result, not an exception — so a route
   * driving this lever must produce byte-identical behavior to the same status
   * set via `setNextIntentStatus`. Any difference is the bug.
   */
  setNextIntentThrowsCardError(status: StripePaymentIntentStatus): void;
  /**
   * Force the next PaymentIntent confirm to throw a NON-card Stripe error.
   * Defaults to a `StripeConnectionError` — "we could not reach Stripe", which
   * must never render as a decline.
   */
  setNextIntentThrowsTransport(err?: Error): void;
  /** Make the next `detachPaymentMethod` throw. */
  throwOnDetach(): void;
  /** Make the next `createRefund` throw. */
  throwOnRefund(): void;
  /**
   * Make the next `cancelPaymentIntent` throw — the "Stripe won't let us cancel
   * this one" case every caller of it swallows. The call is still recorded, so a
   * test can assert both that the cancel was attempted and that the route
   * carried on.
   */
  throwOnCancel(): void;
  /** Replace what `retrievePaymentMethod` returns next. */
  setPaymentMethodSnapshot(snapshot: Partial<StripePaymentMethodSnapshot>): void;
  /**
   * Override what `retrieveSetupIntent` returns next. Defaults to a succeeded
   * SetupIntent with a `pm_test_*` payment method; tests exercising the
   * confirm route's tenancy gate set `customerId` to the fixture's Stripe
   * customer id (or a mismatch to assert the 404 path).
   */
  setSetupIntentSnapshot(snapshot: Partial<StripeSetupIntentSnapshot>): void;
  /**
   * Queue the next webhook event the dispatch loop should receive.
   * `constructWebhookEvent` returns this event regardless of signature
   * (test stubs verify nothing). Pass `null` to make the next call throw
   * a `bad_request` ApiError (simulating a bogus signature).
   */
  setNextEvent(event: StripeWebhookEvent | null): void;
}

export function makeStripeStub(): StripeStub {
  const calls: StripeStubCall[] = [];
  let nextIntentStatus: StripePaymentIntentStatus = 'succeeded';
  let nextIntentThrowsCard = false;
  let nextIntentTransportError: Error | undefined;
  let detachShouldThrow = false;
  let refundShouldThrow = false;
  let cancelShouldThrow = false;
  let pmSnapshotOverride: Partial<StripePaymentMethodSnapshot> = {};
  let setupIntentOverride: Partial<StripeSetupIntentSnapshot> = {};
  // `undefined` = no event queued; `null` = next call throws (bad signature);
  // an event = next call returns it. Distinguishing null from undefined lets
  // tests assert "no signature verification ran" vs "explicit bad signature".
  let nextEvent: StripeWebhookEvent | null | undefined;

  const testIdPrefix = (kind: string): string => `${kind}_test_${randomUUID().slice(0, 8)}`;

  const stub: StripeStub = {
    calls,
    setNextIntentStatus(status) {
      nextIntentStatus = status;
    },
    setNextIntentThrowsCardError(status) {
      nextIntentStatus = status;
      nextIntentThrowsCard = true;
    },
    setNextIntentThrowsTransport(err) {
      nextIntentTransportError =
        err ?? new Stripe.errors.StripeConnectionError({ message: 'stub: cannot reach Stripe' });
    },
    throwOnDetach() {
      detachShouldThrow = true;
    },
    throwOnRefund() {
      refundShouldThrow = true;
    },
    throwOnCancel() {
      cancelShouldThrow = true;
    },
    setPaymentMethodSnapshot(snapshot) {
      pmSnapshotOverride = snapshot;
    },
    setSetupIntentSnapshot(snapshot) {
      setupIntentOverride = snapshot;
    },
    setNextEvent(event) {
      nextEvent = event;
    },

    async createCustomer(args, idempotencyKey) {
      const id = testIdPrefix('cus');
      calls.push({ method: 'createCustomer', args, idempotencyKey });
      return { id };
    },

    async createSetupIntent(args, idempotencyKey) {
      const id = testIdPrefix('seti');
      calls.push({ method: 'createSetupIntent', args, idempotencyKey });
      return { id, clientSecret: `${id}_secret_${randomUUID().slice(0, 8)}` };
    },

    async retrieveSetupIntent(setupIntentId): Promise<StripeSetupIntentSnapshot> {
      calls.push({ method: 'retrieveSetupIntent', args: { setupIntentId }, idempotencyKey: null });
      return {
        id: setupIntentId,
        status: 'succeeded',
        customerId: `cus_test_${randomUUID().slice(0, 8)}`,
        paymentMethodId: `pm_test_${randomUUID().slice(0, 8)}`,
        ...setupIntentOverride,
      };
    },

    async createAndConfirmPaymentIntent(args, idempotencyKey): Promise<StripePaymentIntentResult> {
      const id = testIdPrefix('pi');
      const status = nextIntentStatus;
      const throwsCard = nextIntentThrowsCard;
      const transportError = nextIntentTransportError;
      // Reset every lever for the next call — a stale one bleeding into a
      // route's SECOND confirm (multi-dog enroll, replay) would be a lie.
      nextIntentStatus = 'succeeded';
      nextIntentThrowsCard = false;
      nextIntentTransportError = undefined;
      calls.push({ method: 'createAndConfirmPaymentIntent', args, idempotencyKey });

      if (transportError !== undefined) {
        // Non-card errors are rethrown by the seam untouched; the stub models
        // that by simply throwing.
        throw transportError;
      }
      const clientSecret = status === 'succeeded' ? null : `${id}_secret_${randomUUID().slice(0, 8)}`;
      if (throwsCard) {
        // Build the raw error the way Stripe does on a declined off-session
        // confirm and hand it to the REAL normalizer — the stub must not carry
        // its own copy of the mapping it exists to prove.
        return normalizeThrownConfirmError(
          new Stripe.errors.StripeCardError({
            type: 'card_error',
            code: 'card_declined',
            decline_code: 'generic_decline',
            message: 'Your card was declined.',
            statusCode: 402,
            payment_intent: {
              id,
              status,
              client_secret: clientSecret,
              amount: args.amountCents,
            },
          } as never),
        );
      }
      return {
        id,
        status,
        clientSecret,
        amountCents: args.amountCents,
      };
    },

    async detachPaymentMethod(paymentMethodId) {
      calls.push({
        method: 'detachPaymentMethod',
        args: { paymentMethodId },
        idempotencyKey: null,
      });
      if (detachShouldThrow) {
        detachShouldThrow = false;
        throw new Error('stub: detach failed');
      }
    },

    async cancelPaymentIntent(paymentIntentId) {
      calls.push({
        method: 'cancelPaymentIntent',
        args: { paymentIntentId },
        idempotencyKey: null,
      });
      if (cancelShouldThrow) {
        cancelShouldThrow = false;
        throw new Error('stub: cancel failed');
      }
    },

    async createRefund(args, idempotencyKey): Promise<StripeRefundResult> {
      calls.push({ method: 'createRefund', args, idempotencyKey });
      if (refundShouldThrow) {
        refundShouldThrow = false;
        throw new Error('stub: refund failed');
      }
      const id = testIdPrefix('re');
      return { id, status: 'pending', amountCents: args.amountCents };
    },

    async retrievePaymentMethod(paymentMethodId): Promise<StripePaymentMethodSnapshot> {
      calls.push({
        method: 'retrievePaymentMethod',
        args: { paymentMethodId },
        idempotencyKey: null,
      });
      return {
        id: paymentMethodId,
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2030,
        cardholderName: 'Test Cardholder',
        ...pmSnapshotOverride,
      };
    },

    constructWebhookEvent(rawBody, signature) {
      calls.push({
        method: 'constructWebhookEvent',
        args: { rawBody, signature },
        idempotencyKey: null,
      });
      if (nextEvent === undefined) {
        throw new Error(
          'stub: constructWebhookEvent called with no event queued — call setNextEvent first',
        );
      }
      const queued = nextEvent;
      nextEvent = undefined; // reset so a stale event can't bleed across requests
      if (queued === null) {
        // Mirror the real impl's failure shape — ApiError(bad_request)
        // bubbles through the route's existing ApiError→HTTP mapper as 400.
        throw new ApiError('bad_request', 'stub: simulated Stripe-Signature failure');
      }
      return queued;
    },
  };

  return stub;
}
