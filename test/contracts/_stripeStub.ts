import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { ApiError } from '../../src/lib/errors.js';
import { normalizeThrownConfirmError } from '../../src/lib/stripe.js';
import {
  rebuildRecordedCardError,
  type RecordedScenarioKey,
} from '../fixtures/recordedStripeErrors.js';
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
 *   - `setNextIntentThrowsCardError(status, code?)` — next confirm simulates
 *     Stripe's OTHER failure fork (a thrown card error carrying the failed
 *     intent), HAND-BUILT. It runs the simulated throw through the PRODUCTION
 *     normalizer, so a route test driving this lever exercises the real seam
 *     rather than a lookalike. Use it for status/code combinations Stripe has
 *     never been observed to send (a `processing` intent under a card error);
 *     for the shapes Stripe DOES send, prefer the recorded lever below.
 *   - `setNextIntentThrowsRecorded(scenario)` — next confirm throws the error
 *     Stripe ACTUALLY threw, rebuilt from `test/fixtures/stripe-thrown-confirm.json`
 *     (recorded live by `npm run probe:stripe -- --record`). This is the lever
 *     that would have caught the 2026-08-11 defect: hand-built errors could
 *     only ever contain shapes someone imagined, and nobody imagined
 *     `code=authentication_required` on an intent resting at
 *     `requires_payment_method`.
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

/**
 * One confirm's outcome, for {@link StripeStub.queueIntentOutcomes} — the
 * multi-dog case the single-shot levers cannot express, since each of those
 * resets itself after one call.
 */
export type QueuedIntentOutcome =
  | { kind: 'status'; status: StripePaymentIntentStatus }
  | { kind: 'cardError'; status: StripePaymentIntentStatus; code?: string }
  | { kind: 'recorded'; scenario: RecordedScenarioKey };

export interface StripeStub extends StripeClient {
  /** Every Stripe call this stub received, in order. */
  readonly calls: StripeStubCall[];
  /**
   * Queue an outcome per confirm, in call order — the only way to give the N
   * confirms of a multi-dog enroll DIFFERENT outcomes. A queued outcome wins
   * over the single-shot levers for that call; once the queue drains, the
   * single-shot levers (and the `succeeded` default) apply again.
   *
   * Exists because "one dog declined, one dog still processing" is a real
   * multi-dog shape and the response can carry only one blocker — see
   * `mostHazardousUnsettledIntent` in `src/routes/enrollments.ts`.
   */
  queueIntentOutcomes(outcomes: readonly QueuedIntentOutcome[]): void;
  /** Force the next PaymentIntent confirm to return this status. */
  setNextIntentStatus(status: StripePaymentIntentStatus): void;
  /**
   * Force the next PaymentIntent confirm to take Stripe's THROWN fork: a
   * HAND-BUILT `StripeCardError` carrying a failed PaymentIntent at `status`
   * with the given `code`, run through the production normalizer. Per the
   * `StripeClient` contract the call still RESOLVES — a card-level failure is a
   * result, not an exception.
   *
   * **The equivalence doctrine, amended 2026-08-11.** This used to say a route
   * driving this lever "must produce byte-identical behavior to the same status
   * set via `setNextIntentStatus`", and that instruction was wrong: it demanded
   * the forks agree on a field the thrown fork knows more about. Stripe's
   * thrown error carries `err.code`, which names WHICH failure happened; the
   * attached intent's status reads `requires_payment_method` for a decline and
   * for an authentication failure alike. The amended invariant:
   *
   *   > The forks agree on everything that MOVES or RECORDS money — the status
   *   > body, the charges row, the cancel rule, the obligation outcome — and on
   *   > the blocker WHENEVER `code` maps to what `status` implies. The thrown
   *   > fork may make `charge_blocker` more specific; it may never contradict a
   *   > `processing` status.
   *
   * So a test comparing the two forks must pass a `code` consistent with
   * `status`, or expect (and assert) the more specific blocker.
   */
  setNextIntentThrowsCardError(status: StripePaymentIntentStatus, code?: string): void;
  /**
   * Force the next PaymentIntent confirm to throw the error live Stripe
   * ACTUALLY threw for this scenario, rebuilt from the committed recording and
   * run through the production normalizer. The recorded intent's `id`,
   * `amount` and `client_secret` are adjusted to this call; its `status`,
   * `code` and `decline_code` — the evidence — are replayed verbatim.
   */
  setNextIntentThrowsRecorded(scenario: RecordedScenarioKey): void;
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
  let nextIntentThrowsCardCode = 'card_declined';
  let nextIntentThrowsRecorded: RecordedScenarioKey | undefined;
  let nextIntentTransportError: Error | undefined;
  const outcomeQueue: QueuedIntentOutcome[] = [];
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
    setNextIntentThrowsCardError(status, code = 'card_declined') {
      nextIntentStatus = status;
      nextIntentThrowsCardCode = code;
      nextIntentThrowsCard = true;
    },
    setNextIntentThrowsRecorded(scenario) {
      nextIntentThrowsRecorded = scenario;
    },
    queueIntentOutcomes(outcomes) {
      outcomeQueue.push(...outcomes);
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
      // A queued outcome (multi-dog enroll) overrides the single-shot levers
      // for THIS call by setting them, so everything below stays one code path.
      const queuedOutcome = outcomeQueue.shift();
      if (queuedOutcome !== undefined) {
        switch (queuedOutcome.kind) {
          case 'status':
            nextIntentStatus = queuedOutcome.status;
            break;
          case 'cardError':
            nextIntentStatus = queuedOutcome.status;
            nextIntentThrowsCardCode = queuedOutcome.code ?? 'card_declined';
            nextIntentThrowsCard = true;
            break;
          case 'recorded':
            nextIntentThrowsRecorded = queuedOutcome.scenario;
            break;
        }
      }
      const status = nextIntentStatus;
      const throwsCard = nextIntentThrowsCard;
      const throwsCardCode = nextIntentThrowsCardCode;
      const throwsRecorded = nextIntentThrowsRecorded;
      const transportError = nextIntentTransportError;
      // Reset every lever for the next call — a stale one bleeding into a
      // route's SECOND confirm (multi-dog enroll, replay) would be a lie.
      nextIntentStatus = 'succeeded';
      nextIntentThrowsCard = false;
      nextIntentThrowsCardCode = 'card_declined';
      nextIntentThrowsRecorded = undefined;
      nextIntentTransportError = undefined;
      calls.push({ method: 'createAndConfirmPaymentIntent', args, idempotencyKey });

      if (transportError !== undefined) {
        // Non-card errors are rethrown by the seam untouched; the stub models
        // that by simply throwing.
        throw transportError;
      }
      const clientSecret = status === 'succeeded' ? null : `${id}_secret_${randomUUID().slice(0, 8)}`;
      if (throwsRecorded !== undefined) {
        // The error Stripe REALLY threw, replayed through the REAL normalizer.
        // Only the call-scoped identifiers are re-pointed; the recorded status
        // and code are the evidence and are never edited here.
        return normalizeThrownConfirmError(
          rebuildRecordedCardError(throwsRecorded, {
            id,
            amount: args.amountCents,
            client_secret: `${id}_secret_${randomUUID().slice(0, 8)}`,
          }),
        );
      }
      if (throwsCard) {
        // Build the raw error the way Stripe does on a declined off-session
        // confirm and hand it to the REAL normalizer — the stub must not carry
        // its own copy of the mapping it exists to prove.
        return normalizeThrownConfirmError(
          new Stripe.errors.StripeCardError({
            type: 'card_error',
            code: throwsCardCode,
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
