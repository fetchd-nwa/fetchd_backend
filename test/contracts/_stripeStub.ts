import { randomUUID } from 'node:crypto';
import type {
  StripeClient,
  StripePaymentIntentResult,
  StripePaymentIntentStatus,
  StripePaymentMethodSnapshot,
  StripeRefundResult,
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
 * All Stripe-facing calls are recorded as `{ method, args, idempotencyKey }`
 * tuples in `calls`; tests can `.filter(c => c.method === 'createRefund')`
 * to assert that a route fired the expected post-commit call.
 */
export interface StripeStubCall {
  method:
    | 'createCustomer'
    | 'createSetupIntent'
    | 'createAndConfirmPaymentIntent'
    | 'detachPaymentMethod'
    | 'createRefund'
    | 'retrievePaymentMethod';
  args: unknown;
  idempotencyKey: string | null;
}

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
}

export function makeStripeStub(): StripeStub {
  const calls: StripeStubCall[] = [];
  let nextIntentStatus: StripePaymentIntentStatus = 'succeeded';
  let detachShouldThrow = false;
  let refundShouldThrow = false;
  let pmSnapshotOverride: Partial<StripePaymentMethodSnapshot> = {};

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
  };

  return stub;
}
