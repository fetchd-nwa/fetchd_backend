import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Stripe from 'stripe';
import {
  defaultStripeClient,
  normalizeThrownConfirmError,
  type StripePaymentIntentResult,
  type StripePaymentIntentStatus,
} from '../src/lib/stripe.js';

/**
 * Unit coverage for the wire-1.9.0 THROWN-FORK NORMALIZER — the seam that makes
 * "Stripe returned a non-succeeded intent" and "Stripe threw a card error"
 * indistinguishable to every confirm site (`designs/payment-failure-channel.md`
 * Part 1). One test per row of that design's error table, because the rows are
 * not stylistic: getting the non-card rows wrong turns a Stripe outage into
 * "your card was declined" for every owner at once.
 *
 * Pure — no DB, no network. The errors are REAL `Stripe.errors.*` instances
 * built from raw bodies shaped like Stripe's, so the discrimination under test
 * is the actual class check the seam performs, not a lookalike.
 */

/** A raw Stripe error body for a declined off-session confirm, with the failed
 *  PaymentIntent attached the way Stripe attaches it on a confirm. */
function cardErrorWithIntent(intent: Record<string, unknown>): Stripe.errors.StripeCardError {
  return new Stripe.errors.StripeCardError({
    type: 'card_error',
    code: 'card_declined',
    decline_code: 'generic_decline',
    message: 'Your card was declined.',
    statusCode: 402,
    payment_intent: intent,
  } as never);
}

function attachedIntent(
  status: StripePaymentIntentStatus,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'pi_thrown_1',
    status,
    client_secret: 'pi_thrown_1_secret_abc',
    amount: 12_500,
    ...over,
  };
}

/** What the RETURNING fork produces for the same intent — the shape the thrown
 *  fork must become, field for field. */
function returnedForkResult(status: StripePaymentIntentStatus): StripePaymentIntentResult {
  return {
    id: 'pi_thrown_1',
    status,
    clientSecret: 'pi_thrown_1_secret_abc',
    amountCents: 12_500,
  };
}

// ── Row 1: card error + attached non-succeeded intent → normalized result ──
//
// The only row that CHANGES behavior. All three blocker-bearing statuses are
// walked because each one renders a different owner-facing sentence.

for (const status of ['requires_payment_method', 'requires_action', 'processing'] as const) {
  test(`normalizeThrownConfirmError: card error carrying a ${status} intent → the returning fork's result`, () => {
    const result = normalizeThrownConfirmError(cardErrorWithIntent(attachedIntent(status)));
    assert.deepEqual(result, returnedForkResult(status));
  });
}

test('normalizeThrownConfirmError: canceled and requires_confirmation also normalize', () => {
  // Not statuses a confirm is documented to attach, but the blocker table maps
  // them, so the seam must not be the thing that drops them.
  assert.equal(
    normalizeThrownConfirmError(cardErrorWithIntent(attachedIntent('canceled'))).status,
    'canceled',
  );
  assert.equal(
    normalizeThrownConfirmError(cardErrorWithIntent(attachedIntent('requires_confirmation')))
      .status,
    'requires_confirmation',
  );
});

test('normalizeThrownConfirmError: a null client_secret normalizes to null, not a crash', () => {
  const result = normalizeThrownConfirmError(
    cardErrorWithIntent(attachedIntent('requires_payment_method', { client_secret: null })),
  );
  assert.equal(result.clientSecret, null);
});

// ── Row 2: attached intent SUCCEEDED → throw (an error path may never settle) ──

test('normalizeThrownConfirmError: card error carrying a SUCCEEDED intent → throws', () => {
  assert.throws(
    () => normalizeThrownConfirmError(cardErrorWithIntent(attachedIntent('succeeded'))),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        /SUCCEEDED PaymentIntent/.test(err.message),
        `anomaly must be named in the message, got: ${err.message}`,
      );
      // A plain Error → an honest 500. Rethrowing the Stripe error would carry
      // its statusCode 402 into the envelope under code 'internal'.
      assert.ok(!(err instanceof Stripe.errors.StripeError));
      return true;
    },
  );
});

// ── Row 3: card error with no / unreadable attached intent → throw ──

test('normalizeThrownConfirmError: card error with NO attached intent → throws', () => {
  const err = new Stripe.errors.StripeCardError({
    type: 'card_error',
    code: 'card_declined',
    message: 'Your card was declined.',
    statusCode: 402,
  } as never);
  assert.throws(() => normalizeThrownConfirmError(err), /no readable PaymentIntent/);
});

test('normalizeThrownConfirmError: attached intent with an UNKNOWN status → throws', () => {
  // A future Stripe status must not be smuggled through as a domain outcome —
  // the blocker switch downstream is exhaustive over the statuses we model.
  assert.throws(
    () =>
      normalizeThrownConfirmError(
        cardErrorWithIntent(attachedIntent('requires_payment_method', { status: 'requires_alien' })),
      ),
    /no readable PaymentIntent/,
  );
});

test('normalizeThrownConfirmError: attached intent with no id → throws', () => {
  assert.throws(
    () =>
      normalizeThrownConfirmError(
        cardErrorWithIntent(attachedIntent('requires_payment_method', { id: '' })),
      ),
    /no readable PaymentIntent/,
  );
});

// ── Rows 4/5: every NON-card error rethrows the ORIGINAL object, untouched ──
//
// This is the row that protects an outage from being narrated as a decline.
// Identity (`thrown === err`) is asserted, not just the class: a wrapper would
// lose `statusCode` / `requestId` and change what the error mapper does.

const NON_CARD_ERRORS: ReadonlyArray<[string, Error]> = [
  ['StripeConnectionError', new Stripe.errors.StripeConnectionError({ message: 'network' })],
  ['StripeAPIError', new Stripe.errors.StripeAPIError({ message: 'api' })],
  ['StripeRateLimitError', new Stripe.errors.StripeRateLimitError({ message: 'slow down' })],
  [
    'StripeAuthenticationError',
    new Stripe.errors.StripeAuthenticationError({ message: 'bad key' }),
  ],
  [
    'StripeInvalidRequestError (same-key-changed-params)',
    new Stripe.errors.StripeInvalidRequestError({
      message: 'Keys for idempotent requests can only be used with the same parameters',
      statusCode: 400,
    }),
  ],
  ['StripeIdempotencyError', new Stripe.errors.StripeIdempotencyError({ message: 'idem' })],
  ['a plain Error', new Error('something else entirely')],
];

for (const [label, err] of NON_CARD_ERRORS) {
  test(`normalizeThrownConfirmError: ${label} rethrows the SAME object, untouched`, () => {
    let thrown: unknown;
    try {
      normalizeThrownConfirmError(err);
      assert.fail('expected a rethrow');
    } catch (caught) {
      thrown = caught;
    }
    assert.equal(thrown, err, 'a non-card error must never be relabelled a decline');
  });
}

test('normalizeThrownConfirmError: a non-card error carrying a payment_intent STILL rethrows', () => {
  // Discrimination is by error CLASS. An API error that happens to echo an
  // intent is still "we do not know whether money moved".
  const err = new Stripe.errors.StripeAPIError({
    message: 'api',
    payment_intent: attachedIntent('requires_payment_method'),
  } as never);
  assert.throws(
    () => normalizeThrownConfirmError(err),
    (caught: unknown) => caught === err,
  );
});

// ── The SDK client actually CALLS the normalizer ──────────────────────────
//
// Everything above tests the normalizer as a function, and every route test
// reaches it through the contract-test stub. Neither touches
// `defaultStripeClient.createAndConfirmPaymentIntent` — the ONE implementation
// production runs — so deleting its try/catch would leave the whole suite green
// while every real decline went back to 500ing. These three pin it.
//
// `stripeSingleton` is module-private by design, but stripe-node builds every
// client's resources from one shared prototype (verified by the third test
// below, which reaches the real mapping through the same seam), so mocking
// `create` there reaches the singleton without exporting it.

function mockPaymentIntentsCreate(
  t: TestContext,
  impl: () => Promise<unknown>,
): void {
  const paymentIntentsPrototype = Object.getPrototypeOf(
    new Stripe('sk_test_seam').paymentIntents,
  ) as { create: (...a: unknown[]) => Promise<unknown> };
  t.mock.method(paymentIntentsPrototype, 'create', impl);
}

const CONFIRM_ARGS = {
  amountCents: 12_500,
  currency: 'usd',
  customerId: 'cus_seam',
  paymentMethodId: 'pm_seam',
  metadata: {},
} as const;

test('defaultStripeClient.createAndConfirmPaymentIntent: a THROWN card error RESOLVES to the normalized result', async (t) => {
  mockPaymentIntentsCreate(t, () =>
    Promise.reject(cardErrorWithIntent(attachedIntent('requires_payment_method'))),
  );

  // Resolves — per the `StripeClient` contract, a card-level failure is a
  // result, not an exception. This is the assertion that goes red if the
  // try/catch at the seam is ever removed.
  assert.deepEqual(
    await defaultStripeClient.createAndConfirmPaymentIntent(CONFIRM_ARGS, 'idem-seam-card'),
    returnedForkResult('requires_payment_method'),
  );
});

test('defaultStripeClient.createAndConfirmPaymentIntent: a transport error REJECTS with the same object', async (t) => {
  const transport = new Stripe.errors.StripeConnectionError({ message: 'cannot reach Stripe' });
  mockPaymentIntentsCreate(t, () => Promise.reject(transport));

  await assert.rejects(
    defaultStripeClient.createAndConfirmPaymentIntent(CONFIRM_ARGS, 'idem-seam-net'),
    (err: unknown) => err === transport,
  );
});

test('defaultStripeClient.createAndConfirmPaymentIntent: the RETURNING fork maps unchanged', async (t) => {
  // Also proves the mock is wired to the singleton at all — without this, the
  // two tests above could pass against a seam that never ran.
  mockPaymentIntentsCreate(t, () =>
    Promise.resolve({
      id: 'pi_thrown_1',
      status: 'requires_payment_method',
      client_secret: 'pi_thrown_1_secret_abc',
      amount: 12_500,
    }),
  );

  assert.deepEqual(
    await defaultStripeClient.createAndConfirmPaymentIntent(CONFIRM_ARGS, 'idem-seam-ok'),
    returnedForkResult('requires_payment_method'),
  );
});
