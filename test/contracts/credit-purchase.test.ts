import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import { charges, creditLedger, stripeCustomers } from '../../src/db/schema/schema.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
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

/**
 * Day-14 contract tests for the credit-purchase write surface (HANDOFF §4.2):
 *
 *   POST /credit-packages/:key/purchase
 *
 * The synchronous-confirm path: the route creates + confirms a
 * PaymentIntent against the owner's stored card, writes a `charges` row
 * mirroring the returned status, and (only on `succeeded`) writes the
 * matching `credit_ledger` purchase grant. Day-15 webhook handles the
 * async settlement / 3DS reconciliation.
 *
 * Stripe is stubbed via `_stripeStub.ts`. The fixture seeds the
 * stripe_customers row + a default payment_methods row — both pre-
 * requisites for `loadPurchaseContext`.
 */

registerFixtureHooks();

function buildApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerCreditPackagesRoute(app, { authenticate, stripe });
  return { app, stripe };
}

async function cleanupChargesAndLedger(): Promise<void> {
  // Keep the fixture state stable across tests in this file — drop any
  // charges + credit_ledger rows this test inserted. The ON DELETE FK
  // from credit_ledger→charges is no-action; drop ledger first.
  await db.delete(creditLedger).where(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /credit-packages/:key/purchase — succeeded PI → charges row + credit_ledger row + Stripe-confirmed',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': `cp-${randomUUID()}` },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      charge_id: string;
      charge_status: string;
      stripe_payment_intent_id: string;
      credits_granted: number;
    };
    assert.equal(body.charge_status, 'succeeded');
    assert.ok(body.credits_granted > 0);
    assert.match(body.stripe_payment_intent_id, /^pi_test_[0-9a-f]{8}$/);

    // Stripe was called exactly once.
    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 1);

    // DB writes landed.
    const [charge] = await db.select().from(charges).where(eq(charges.id, body.charge_id));
    assert.ok(charge);
    assert.equal(charge.status, 'succeeded');
    assert.equal(charge.purpose, 'package');
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.chargeId, charge.id), eq(creditLedger.reason, 'purchase')));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.delta, body.credits_granted);

    await cleanupChargesAndLedger();
  },
);

test(
  'POST /credit-packages/:key/purchase — PI requires_action → charges at requires_payment, NO ledger row',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');
    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': `cp-3ds-${randomUUID()}` },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      charge_id: string;
      charge_status: string;
      client_secret: string | null;
      credits_granted: number;
    };
    assert.equal(body.charge_status, 'requires_payment');
    assert.equal(body.credits_granted, 0);
    assert.ok(body.client_secret !== null, '3DS path returns client_secret for FE to finish');
    // Charges row landed; ledger row did NOT.
    const [charge] = await db
      .select({ status: charges.status })
      .from(charges)
      .where(eq(charges.id, body.charge_id));
    assert.ok(charge);
    assert.equal(charge.status, 'requires_payment');
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'purchase')));
    assert.equal(ledger.length, 0, 'no ledger row until Day-15 webhook confirms succeeded');
    await cleanupChargesAndLedger();
  },
);

test(
  'POST /credit-packages/:key/purchase — replay with same key returns identical body, no extra DB rows',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const key = `cp-replay-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': key },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json();
    const replay = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': key },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), firstBody);
    // Only ONE charges + ledger row should exist for the fixture dog.
    const chargesRows = await db
      .select()
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargesRows.length, 1, 'replay did not write a second charges row');
    await cleanupChargesAndLedger();
  },
);

test(
  'POST /credit-packages/:key/purchase — unknown package key → 404',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/credit-packages/not-a-real-package/purchase',
      headers: { 'idempotency-key': `cp-404-${randomUUID()}` },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 404);
  },
);

test(
  'POST /credit-packages/:key/purchase — dog not owned by principal → 404',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': `cp-dog-404-${randomUUID()}` },
      payload: {
        dog_id: '00000000-0000-4000-8000-000000000000',
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 404);
  },
);

test(
  'POST /credit-packages/:key/purchase — payment_method not owned → 404',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': `cp-pm-404-${randomUUID()}` },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        payment_method_id: '00000000-0000-4000-8000-000000000000',
      },
    });
    assert.equal(res.statusCode, 404);
  },
);

test(
  'POST /credit-packages/:key/purchase — owner with no stripe_customers row → 422',
  SKIP_WHEN_NO_DB,
  async () => {
    // Drop the fixture's stripe_customers row temporarily.
    await db.delete(stripeCustomers).where(eq(stripeCustomers.ownerId, FIXTURE_IDS.ownerId));
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': `cp-422-${randomUUID()}` },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 422);
    // Restore.
    await db.insert(stripeCustomers).values({
      ownerId: FIXTURE_IDS.ownerId,
      stripeCustomerId: FIXTURE_IDS.stripeCustomerId,
    });
  },
);

test('POST /credit-packages/:key/purchase — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await app.inject({
    method: 'POST',
    url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
    headers: { 'idempotency-key': `cp-staff-${randomUUID()}` },
    payload: {
      dog_id: FIXTURE_IDS.dog1Id,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
    },
  });
  assert.equal(res.statusCode, 403);
});

// ──────────────────────────────────────────────────────────────────────────
// chargesRepository.markStatus — pre-positioned for Day-15 webhook
// (`payment_intent.succeeded` / `.payment_failed` event handlers).
// Day-14 exercises only `succeeded` synchronously via the purchase route;
// this test pins the contract for the webhook's first caller so a future
// schema rename or status-mapping drift surfaces here, not at Day-15
// integration time.
// ──────────────────────────────────────────────────────────────────────────

test(
  'chargesRepository.markStatus flips requires_payment → succeeded and stamps updated_at',
  SKIP_WHEN_NO_DB,
  async () => {
    // Use db.transaction to scope the test in a tx the repo can accept
    // (the same shape the Day-15 webhook handler will pass in).
    const result = await db.transaction(async (tx) => {
      const charge = await chargesRepository.create(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 4500,
        status: 'requires_payment',
        purpose: 'package',
        stripePaymentIntentId: `pi_test_markstatus_${randomUUID().slice(0, 8)}`,
      });
      const beforeUpdatedAt = (
        await tx
          .select({ updatedAt: charges.updatedAt })
          .from(charges)
          .where(eq(charges.id, charge.id))
      )[0]!.updatedAt;

      // Sleep a beat so `updated_at = now()` advances visibly.
      await new Promise((r) => setTimeout(r, 5));
      await chargesRepository.markStatus(tx, { id: charge.id, status: 'succeeded' });

      const after = (
        await tx
          .select({ status: charges.status, updatedAt: charges.updatedAt })
          .from(charges)
          .where(eq(charges.id, charge.id))
      )[0]!;
      return { chargeId: charge.id, beforeUpdatedAt, after };
    });

    assert.equal(result.after.status, 'succeeded');
    assert.ok(
      new Date(result.after.updatedAt).getTime() >= new Date(result.beforeUpdatedAt).getTime(),
      'updated_at advanced after markStatus',
    );

    // Cleanup — the transaction committed inside db.transaction, so the
    // charges row persists; drop it so downstream tests see a clean owner.
    await db.delete(charges).where(eq(charges.id, result.chargeId));
  },
);
