import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import Stripe from 'stripe';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import {
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows, seedInvoiceOrder, seedOpenInvoice } from './_orderFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * A Stripe 401 or 403 is Stripe refusing OUR key, and the SDK's error carries that status.
 * Passed through, a bad or rotated key on *Cancel order* answers our own 401, and the
 * portal's `sessionEndFor` signs the staff member out for a fault that is not hers
 * (`evidence/portal/fix1/probe-401-internal-signs-out.log`). Every test goes through the
 * real `setErrorHandler`, on a route that reaches the Stripe seam, with the SDK's own
 * classes, built the way the SDK builds them from a status.
 */

after(async () => {
  await clearOrderRows();
});
registerFixtureHooks();
afterEach(async () => {
  await clearOrderRows();
});

const T0 = new Date('2026-05-19T17:50:00Z');
const ENVELOPE = { error: { code: 'internal', message: 'Internal Server Error' } };

function stripeSays(statusCode: number): Error {
  return Stripe.errors.StripeError.generate({
    statusCode,
    message: `stub: Stripe answered ${statusCode}`,
    type: 'invalid_request_error',
  } as never);
}

/** The route's Stripe calls all answer `err`, as a key that does not work would. */
async function cancelOrderWhileStripeThrows(err: Error) {
  const stub = makeStripeStub();
  const refuse = async (): Promise<never> => {
    throw err;
  };
  const stripe = { ...stub, retrievePaymentIntent: refuse, cancelPaymentIntent: refuse };
  const capture = makeLogCapture();
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL, capture);
  registerStaffOrdersRoute(app, { authenticate, stripe, now: () => T0 });
  const seeded = await seedInvoiceOrder(stub, {
    invoiceId: await seedOpenInvoice(),
    now: T0,
    intentStatus: 'requires_confirmation',
    attemptingUntil: new Date(T0.getTime() + 150_000),
  });
  const res = await app.inject({
    method: 'POST',
    url: `/staff/orders/${seeded.orderId}/cancel`,
    headers: { 'idempotency-key': `key-refused-${randomUUID()}` },
  });
  return { res, lines: capture.lines };
}

function linesAt(lines: Record<string, unknown>[], level: number): unknown[] {
  return lines.filter((line) => line.level === level).map((line) => line.msg);
}

for (const [status, kind] of [
  [401, Stripe.errors.StripeAuthenticationError],
  [403, Stripe.errors.StripePermissionError],
] as const) {
  test(
    `a Stripe ${status} on Cancel order answers 500 internal and pages: it is our key, not her session`,
    SKIP_WHEN_NO_DB,
    async () => {
      const err = stripeSays(status);
      assert.ok(err instanceof kind, `the SDK builds a ${kind.name} from a ${status}`);

      const { res, lines } = await cancelOrderWhileStripeThrows(err);

      assert.equal(res.statusCode, 500, res.body);
      assert.deepEqual(res.json(), ENVELOPE);
      assert.deepEqual(linesAt(lines, 50), ['unhandled error'], 'a human hears about the key');
      assert.deepEqual(linesAt(lines, 40), []);
    },
  );
}

for (const status of [400, 404, 429]) {
  test(
    `a Stripe ${status} on Cancel order keeps its status and warns: nothing pages`,
    SKIP_WHEN_NO_DB,
    async () => {
      const { res, lines } = await cancelOrderWhileStripeThrows(stripeSays(status));

      assert.equal(res.statusCode, status, res.body);
      assert.deepEqual(res.json(), ENVELOPE);
      assert.deepEqual(linesAt(lines, 50), [], 'a page here would be noise');
      assert.deepEqual(linesAt(lines, 40), ['client error']);
    },
  );
}

test(
  "a Fastify 400 on the same route keeps its status and warns: the exception is Stripe's alone",
  SKIP_WHEN_NO_DB,
  async () => {
    const capture = makeLogCapture();
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL, capture);
    registerStaffOrdersRoute(app, { authenticate, stripe: makeStripeStub(), now: () => T0 });

    const res = await app.inject({
      method: 'POST',
      url: `/staff/orders/${randomUUID()}/cancel`,
      headers: {
        'idempotency-key': `key-refused-${randomUUID()}`,
        'content-type': 'application/json',
      },
      payload: '{',
    });

    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json(), ENVELOPE);
    assert.deepEqual(linesAt(capture.lines, 50), []);
    assert.deepEqual(linesAt(capture.lines, 40), ['client error']);
  },
);

test(
  'an error that only looks like Stripe keeps its 401: the class decides, not the number',
  SKIP_WHEN_NO_DB,
  async () => {
    const lookalike = Object.assign(new Error('not from the SDK'), {
      statusCode: 401,
      type: 'StripeAuthenticationError',
    });

    const { res, lines } = await cancelOrderWhileStripeThrows(lookalike);

    assert.equal(res.statusCode, 401, res.body);
    assert.deepEqual(linesAt(lines, 50), []);
    assert.deepEqual(linesAt(lines, 40), ['client error']);
  },
);
