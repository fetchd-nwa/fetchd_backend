import { randomUUID } from 'node:crypto';
import { ApiError } from '../../src/lib/errors.js';
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
 *   - `throwOnDetach()` — next `detachPaymentMethod` rejects
 *   - `throwOnRefund()` — next `createRefund` rejects
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
  /** Make the next `detachPaymentMethod` throw. */
  throwOnDetach(): void;
  /** Make the next `createRefund` throw. */
  throwOnRefund(): void;
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
  let detachShouldThrow = false;
  let refundShouldThrow = false;
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
    throwOnDetach() {
      detachShouldThrow = true;
    },
    throwOnRefund() {
      refundShouldThrow = true;
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
      nextIntentStatus = 'succeeded'; // reset for the next call
      calls.push({ method: 'createAndConfirmPaymentIntent', args, idempotencyKey });
      return {
        id,
        status,
        clientSecret: status === 'succeeded' ? null : `${id}_secret_${randomUUID().slice(0, 8)}`,
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
