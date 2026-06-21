import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { charges, invoices, refunds } from '../../src/db/schema/schema.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';

registerFixtureHooks();

function buildApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerInvoicesRoute(app, { authenticate, stripe });
  return { app, stripe };
}

async function seedOpenInvoice(amountCents = 200_000): Promise<string> {
  const row = await db.transaction(async (tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: '2026-06-15T00:00:00Z',
    }),
  );
  return row.id;
}

async function cleanupInvoicesAndCharges(): Promise<void> {
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

test(
  'POST /invoices/:id/pay — succeeded PI → charges row + invoice flipped to paid',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `inv-pay-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      charge_id: string;
      charge_status: string;
      invoice_status: string;
      stripe_payment_intent_id: string;
    };
    assert.equal(body.charge_status, 'succeeded');
    assert.equal(body.invoice_status, 'paid');
    assert.match(body.stripe_payment_intent_id, /^pi_test_/);

    const [inv] = await db
      .select({ status: invoices.status, paidChargeId: invoices.paidChargeId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'paid');
    assert.equal(inv?.paidChargeId, body.charge_id);

    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 1);
    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — requires_action returns client_secret, invoice stays open, charge at requires_payment',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `inv-3ds-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as {
      charge_id: string;
      charge_status: string;
      invoice_status: string;
      client_secret: string | null;
    };
    assert.equal(body.charge_status, 'requires_payment');
    assert.equal(body.invoice_status, 'open');
    assert.ok(body.client_secret !== null);
    const [inv] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open');
    await cleanupInvoicesAndCharges();
  },
);

test('POST /invoices/:id/pay — unknown invoice → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/invoices/00000000-0000-4000-8000-000000000000/pay',
    headers: { 'idempotency-key': `inv-404-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 404);
});

test('POST /invoices/:id/pay — already-paid invoice → 409', SKIP_WHEN_NO_DB, async () => {
  await cleanupInvoicesAndCharges();
  const invoiceId = await seedOpenInvoice();
  // Mark paid out-of-band so the route sees an invalid state. The schema
  // CHECK `(status <> 'paid' OR paid_at IS NOT NULL)` requires paid_at
  // when status='paid', so stamp now() in the same UPDATE.
  await db
    .update(invoices)
    .set({ status: 'paid', paidAt: sql`now()` })
    .where(eq(invoices.id, invoiceId));
  const { app } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay`,
    headers: { 'idempotency-key': `inv-409-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 409);
  await cleanupInvoicesAndCharges();
});

test('POST /invoices/:id/pay — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await app.inject({
    method: 'POST',
    url: '/invoices/00000000-0000-4000-8000-000000000000/pay',
    headers: { 'idempotency-key': `inv-staff-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
});

test(
  'POST /invoices/:id/pay — replay returns identical body, no extra rows',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const invoiceId = await seedOpenInvoice();
    const { app } = buildApp();
    const key = `inv-replay-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': key },
      payload: {},
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json();
    const replay = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': key },
      payload: {},
    });
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), firstBody);

    const chargesRows = await db
      .select()
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargesRows.length, 1);
    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — lost settle race: invoice already paid, charge refunded, response is honest',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    // Drive the real in-tx race: fire TWO /pay calls concurrently against the
    // same open invoice. Each mints its own succeeded PI at Stripe; the
    // conditional markPaid claim lets exactly one flip open->paid (settled),
    // and the other sees flipped=0 (refunded duplicate). A pre-check
    // short-circuit (one call 409s before charging) is also a valid race
    // resolution — the test asserts the money invariant under both.
    const keyA = `inv-race-a-${randomUUID()}`;
    const keyB = `inv-race-b-${randomUUID()}`;
    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/invoices/${invoiceId}/pay`,
        headers: { 'idempotency-key': keyA },
        payload: {},
      }),
      app.inject({
        method: 'POST',
        url: `/invoices/${invoiceId}/pay`,
        headers: { 'idempotency-key': keyB },
        payload: {},
      }),
    ]);

    // One of the two may 409 (pre-check caught the already-paid state) OR both
    // pass pre-check and the in-tx claim splits them into one settled + one
    // refunded. Both outcomes are correct; assert the INVARIANT either way:
    // the invoice is paid exactly once and the customer nets one charge.
    const bodies = [resA, resB]
      .filter((r) => r.statusCode === 201)
      .map(
        (r) =>
          r.json() as {
            charge_id: string;
            invoice_status: string;
            charge_refunded: boolean;
          },
      );

    const [inv] = await db
      .select({ status: invoices.status, paidChargeId: invoices.paidChargeId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'paid', 'invoice settled exactly once');

    const refundRows = await db
      .select({ chargeId: refunds.chargeId, amountCents: refunds.amountCents })
      .from(refunds)
      .where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));

    // If BOTH calls passed pre-check, the loser took the refund branch.
    if (bodies.length === 2) {
      const refunded = bodies.filter((b) => b.charge_refunded);
      const clean = bodies.filter((b) => !b.charge_refunded);
      assert.equal(refunded.length, 1, 'exactly one charge was refunded');
      assert.equal(clean.length, 1, 'exactly one clean settle');
      assert.equal(clean[0]?.invoice_status, 'paid');
      // The refunded response is HONEST: invoice paid, but charge_refunded=true.
      assert.equal(refunded[0]?.invoice_status, 'paid');
      assert.equal(refunded[0]?.charge_refunded, true);
      assert.equal(refundRows.length, 1, 'one pending refund row for the duplicate');
      assert.equal(
        refundRows[0]?.chargeId,
        refunded[0]?.charge_id,
        'refund targets the loser charge',
      );
      assert.equal(refundRows[0]?.amountCents, 200_000, 'full duplicate amount refunded');

      // A Stripe createRefund fired post-commit for exactly the duplicate.
      const refundCalls = stripe.calls.filter((c) => c.method === 'createRefund');
      assert.equal(refundCalls.length, 1, 'exactly one Stripe refund fired for the duplicate');
    } else {
      // The pre-check caught the race: one 409, one clean 201, no refund.
      assert.equal(refundRows.length, 0, 'pre-check short-circuit needs no refund');
    }

    await cleanupInvoicesAndCharges();
  },
);
