import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { paymentMethods, stripeCustomers } from '../../src/db/schema/schema.js';
import { registerPaymentMethodsRoute } from '../../src/routes/paymentMethods.js';
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
 * Day-14 contract tests for the payment-methods mutation surface:
 *   - POST /payment-methods/setup-intent — lazy-provisions Stripe customer,
 *     creates SetupIntent, returns client_secret. Replay returns the stored
 *     body without re-hitting Stripe.
 *   - PATCH /payment-methods/:id — toggle default-card (clear-then-set
 *     preserves the partial-unique invariant).
 *   - DELETE /payment-methods/:id — soft-expires + zeroes is_default,
 *     fires post-commit Stripe detach (best-effort; logged + swallowed
 *     on failure).
 *
 * Stripe is stubbed via `_stripeStub.ts` so the suite stays offline; each
 * test that asserts Stripe-side effects constructs its own stub and
 * inspects `stripe.calls` after the inject.
 */

registerFixtureHooks();

function buildApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerPaymentMethodsRoute(app, { authenticate, stripe });
  return { app, stripe };
}

// ──────────────────────────────────────────────────────────────────────────
// POST /payment-methods/setup-intent
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /payment-methods/setup-intent — returns client_secret + provisions Stripe customer on first call',
  SKIP_WHEN_NO_DB,
  async () => {
    // The fixture seeds a stripe_customers row, so this exercises the
    // "row already exists" branch — Stripe customer create is NOT called.
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payment-methods/setup-intent',
      headers: { 'idempotency-key': `si-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { setup_intent_id: string; client_secret: string };
    assert.match(body.setup_intent_id, /^seti_test_[0-9a-f]{8}$/);
    assert.match(body.client_secret, /^seti_test_[0-9a-f]{8}_secret_/);
    // Customer existed → no createCustomer call.
    const stripeCalls = stripe.calls.map((c) => c.method);
    assert.deepEqual(stripeCalls, ['createSetupIntent']);
  },
);

test(
  'POST /payment-methods/setup-intent — first-time customer: creates Stripe customer + inserts stripe_customers row',
  SKIP_WHEN_NO_DB,
  async () => {
    // Clear the fixture's seeded row so the route hits the lazy-provision
    // branch. payment_methods FK is owner→customer-row free (no FK between
    // pm and stripe_customers), so dropping the customer row is safe.
    await db.delete(stripeCustomers).where(eq(stripeCustomers.ownerId, FIXTURE_IDS.ownerId));
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payment-methods/setup-intent',
      headers: { 'idempotency-key': `si-first-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 201, res.body);
    // Both Stripe calls fired, in order.
    const stripeCalls = stripe.calls.map((c) => c.method);
    assert.deepEqual(stripeCalls, ['createCustomer', 'createSetupIntent']);
    // DB row landed.
    const [row] = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.ownerId, FIXTURE_IDS.ownerId));
    assert.ok(row);
    assert.match(row.stripeCustomerId, /^cus_test_[0-9a-f]{8}$/);
    // Restore the fixture row for downstream tests via re-seeding the
    // canonical id (idempotent if seedFixture's UPDATE catches it next run).
    await db.delete(stripeCustomers).where(eq(stripeCustomers.ownerId, FIXTURE_IDS.ownerId));
    await db.insert(stripeCustomers).values({
      ownerId: FIXTURE_IDS.ownerId,
      stripeCustomerId: FIXTURE_IDS.stripeCustomerId,
    });
  },
);

test(
  'POST /payment-methods/setup-intent — replay with same key returns identical body, no extra Stripe call',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const key = `si-replay-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/payment-methods/setup-intent',
      headers: { 'idempotency-key': key },
      payload: {},
    });
    assert.equal(first.statusCode, 201);
    const calledOnce = stripe.calls.length;
    const replay = await app.inject({
      method: 'POST',
      url: '/payment-methods/setup-intent',
      headers: { 'idempotency-key': key },
      payload: {},
    });
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), first.json());
    assert.equal(stripe.calls.length, calledOnce, 'replay path skipped the Stripe round-trip');
  },
);

test('POST /payment-methods/setup-intent — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await app.inject({
    method: 'POST',
    url: '/payment-methods/setup-intent',
    headers: { 'idempotency-key': `si-staff-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
});

test(
  'POST /payment-methods/setup-intent — missing Idempotency-Key → 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payment-methods/setup-intent',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// PATCH /payment-methods/:id
// ──────────────────────────────────────────────────────────────────────────

async function seedSecondCard(): Promise<string> {
  const newId = randomUUID();
  await db.insert(paymentMethods).values({
    id: newId,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentMethodId: `pm_test_second_${randomUUID().slice(0, 8)}`,
    brand: 'mastercard',
    last4: '5555',
    expMonth: 6,
    expYear: 2031,
    cardholderName: 'Allison Second',
    isDefault: false,
  });
  return newId;
}

test(
  'PATCH /payment-methods/:id — set non-default → clears prior default + new card is_default=true',
  SKIP_WHEN_NO_DB,
  async () => {
    const newId = await seedSecondCard();
    const { app } = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/payment-methods/${newId}`,
      headers: { 'idempotency-key': `pm-patch-${randomUUID()}` },
      payload: { is_default: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Array<{ id: string; is_default: boolean }>;
    const defaults = body.filter((r) => r.is_default);
    assert.equal(defaults.length, 1, 'exactly one default at a time');
    assert.equal(defaults[0]!.id, newId, 'new card is the default');
    // Cleanup so the row count stays stable for downstream tests.
    await db.delete(paymentMethods).where(eq(paymentMethods.id, newId));
    // Restore the fixture default (the PATCH cleared it).
    await db
      .update(paymentMethods)
      .set({ isDefault: true })
      .where(
        and(
          eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id),
          eq(paymentMethods.ownerId, FIXTURE_IDS.ownerId),
        ),
      );
  },
);

test(
  'PATCH /payment-methods/:id — already-default is a no-op (idempotent fast-path)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/payment-methods/${FIXTURE_IDS.paymentMethod1Id}`,
      headers: { 'idempotency-key': `pm-already-${randomUUID()}` },
      payload: { is_default: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Array<{ id: string; is_default: boolean }>;
    assert.equal(body.filter((r) => r.is_default).length, 1);
  },
);

test('PATCH /payment-methods/:id — unknown id → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/payment-methods/00000000-0000-4000-8000-000000000000',
    headers: { 'idempotency-key': `pm-404-${randomUUID()}` },
    payload: { is_default: true },
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH /payment-methods/:id — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await app.inject({
    method: 'PATCH',
    url: `/payment-methods/${FIXTURE_IDS.paymentMethod1Id}`,
    headers: { 'idempotency-key': `pm-403-${randomUUID()}` },
    payload: { is_default: true },
  });
  assert.equal(res.statusCode, 403);
});

test('PATCH /payment-methods/:id — empty body → 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/payment-methods/${FIXTURE_IDS.paymentMethod1Id}`,
    headers: { 'idempotency-key': `pm-empty-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

// ──────────────────────────────────────────────────────────────────────────
// DELETE /payment-methods/:id
// ──────────────────────────────────────────────────────────────────────────

test(
  'DELETE /payment-methods/:id — soft-expires + zeroes is_default + fires post-commit Stripe detach',
  SKIP_WHEN_NO_DB,
  async () => {
    const newId = await seedSecondCard();
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/payment-methods/${newId}`,
      headers: { 'idempotency-key': `pm-del-${randomUUID()}` },
    });
    assert.equal(res.statusCode, 204);
    // DB row soft-expired.
    const [row] = await db
      .select({
        id: paymentMethods.id,
        expiredAt: paymentMethods.expiredAt,
        isDefault: paymentMethods.isDefault,
      })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, newId));
    assert.ok(row);
    assert.ok(row.expiredAt !== null, 'expired_at stamped');
    assert.equal(row.isDefault, false);
    // Stripe detach fired.
    const detaches = stripe.calls.filter((c) => c.method === 'detachPaymentMethod');
    assert.equal(detaches.length, 1);
    // Cleanup.
    await db.delete(paymentMethods).where(eq(paymentMethods.id, newId));
  },
);

test(
  'DELETE /payment-methods/:id — Stripe detach failure is swallowed (DB still soft-expired)',
  SKIP_WHEN_NO_DB,
  async () => {
    const newId = await seedSecondCard();
    const { app, stripe } = buildApp();
    stripe.throwOnDetach();
    const res = await app.inject({
      method: 'DELETE',
      url: `/payment-methods/${newId}`,
      headers: { 'idempotency-key': `pm-del-fail-${randomUUID()}` },
    });
    assert.equal(res.statusCode, 204, 'route still returns success — DB is the source of truth');
    const [row] = await db
      .select({ expiredAt: paymentMethods.expiredAt })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, newId));
    assert.ok(row?.expiredAt !== null, 'soft-expire committed despite Stripe failure');
    await db.delete(paymentMethods).where(eq(paymentMethods.id, newId));
  },
);

test('DELETE /payment-methods/:id — unknown id → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: '/payment-methods/00000000-0000-4000-8000-000000000000',
    headers: { 'idempotency-key': `pm-del-404-${randomUUID()}` },
  });
  assert.equal(res.statusCode, 404);
});

test('DELETE /payment-methods/:id — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await app.inject({
    method: 'DELETE',
    url: `/payment-methods/${FIXTURE_IDS.paymentMethod1Id}`,
    headers: { 'idempotency-key': `pm-del-403-${randomUUID()}` },
  });
  assert.equal(res.statusCode, 403);
});

test(
  'DELETE /payment-methods/:id — replay does NOT re-fire Stripe detach',
  SKIP_WHEN_NO_DB,
  async () => {
    const newId = await seedSecondCard();
    const { app, stripe } = buildApp();
    const key = `pm-del-replay-${randomUUID()}`;
    const first = await app.inject({
      method: 'DELETE',
      url: `/payment-methods/${newId}`,
      headers: { 'idempotency-key': key },
    });
    assert.equal(first.statusCode, 204);
    assert.equal(stripe.calls.filter((c) => c.method === 'detachPaymentMethod').length, 1);

    const replay = await app.inject({
      method: 'DELETE',
      url: `/payment-methods/${newId}`,
      headers: { 'idempotency-key': key },
    });
    assert.equal(replay.statusCode, 204);
    assert.equal(
      stripe.calls.filter((c) => c.method === 'detachPaymentMethod').length,
      1,
      'replay path skipped the post-commit detach',
    );
    await db.delete(paymentMethods).where(eq(paymentMethods.id, newId));
  },
);
