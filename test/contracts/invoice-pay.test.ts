import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { charges, invoices } from '../../src/db/schema/schema.js';
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
