import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import {
  charges,
  creditLedger,
  creditSettings,
  orders,
  stripeCustomers,
} from '../../src/db/schema/schema.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { makeStripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';
import type { StripePaymentIntentStatus } from '../../src/lib/stripe.js';

/**
 * The credit-purchase write surface, `POST /credit-packages/:key/purchase`: the route's own
 * refusals, `count`, and what each way a card can stop answers. It rides the order engine,
 * and what the engine owes a pack is `pack-on-engine.test.ts`.
 *
 * Stripe is stubbed via `_stripeStub.ts`. The fixture seeds the stripe_customers row and a
 * default payment_methods row, both needed before a card can be tried.
 */

registerFixtureHooks();

function buildApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerCreditPackagesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

afterEach(async () => {
  await db.delete(creditLedger).where(isNotNull(creditLedger.chargeId));
  await clearOrderRows();
  await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
});

/** Every lot a charge bought: the fixture's own lots carry no charge. */
async function boughtLots() {
  return db.select().from(creditLedger).where(isNotNull(creditLedger.chargeId));
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

    // One intent, created and then confirmed.
    const creates = stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent');
    assert.equal(creates.length, 1);

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
  },
);

test(
  'POST /credit-packages/:key/purchase — PI requires_action → a 402, the charge failed, NO ledger row',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');
    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': `cp-3ds-${randomUUID()}` },
      payload: {
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 402, res.body);
    assert.equal(res.json().error.code, 'payment_failed');
    const rows = await db
      .select({ status: charges.status })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.deepEqual(rows, [{ status: 'failed' }]);
    assert.deepEqual(await boughtLots(), [], 'nothing is granted before the money');
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

// ── count: single days in one charge / one lot (CRED-U04; `quantity` left with
// CRED-U30) ───────────────────────────────────────────────────────────────

const SINGLE_DAY_KEY = 'single-day-school-fayetteville';

test(
  'POST /credit-packages/:key/purchase — count 3 on a single-day row → 3× charge amount, 3 credits, one ledger lot WITH expiry',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${SINGLE_DAY_KEY}/purchase`,
      headers: { 'idempotency-key': `cp-count-${randomUUID()}` },
      payload: {
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        count: 3,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_status: string; credits_granted: number };
    assert.equal(body.charge_status, 'succeeded');
    assert.equal(body.credits_granted, 3);

    const creates = stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent');
    assert.equal(creates.length, 1);
    assert.equal(creates[0]?.args.amountCents, 18_000, 'charged count × price_cents');

    // ONE ledger lot for the whole count.
    const ledger = await boughtLots();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.delta, 3);
    assert.equal(ledger[0]!.location, 'fayetteville');
    assert.ok(ledger[0]!.expiresAt !== null, 'the lot carries an expiry');
  },
);

test(
  'POST /credit-packages/:key/purchase — count 0 / non-integer → 400, no Stripe call',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    for (const count of [0, 1.5]) {
      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${SINGLE_DAY_KEY}/purchase`,
        headers: { 'idempotency-key': `cp-count-bad-${randomUUID()}` },
        payload: {
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
          count,
        },
      });
      assert.equal(res.statusCode, 400, `count ${count} must 400`);
    }
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent').length,
      0,
      'validation rejects before Stripe',
    );
  },
);

test(
  'POST /credit-packages/:key/purchase — count past cred.single_day_purchase_max_count → 422 count_not_allowed, the limit read at runtime',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const buy = (count: number) =>
      app.inject({
        method: 'POST',
        url: `/credit-packages/${SINGLE_DAY_KEY}/purchase`,
        headers: { 'idempotency-key': `cp-count-max-${randomUUID()}` },
        payload: {
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
          count,
        },
      });

    const atSeed = await buy(31);
    assert.equal(atSeed.statusCode, 422, atSeed.body);
    assert.equal(atSeed.json().error.code, 'count_not_allowed');

    await db.update(creditSettings).set({ singleDayPurchaseMaxCount: 2 });
    try {
      const refused = await buy(3);
      assert.equal(refused.statusCode, 422, refused.body);
      assert.equal(refused.json().error.code, 'count_not_allowed');
      assert.equal(
        stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent').length,
        0,
        'refused before Stripe',
      );
      const atLimit = await buy(2);
      assert.equal(atLimit.statusCode, 201, atLimit.body);
    } finally {
      await db.update(creditSettings).set({ singleDayPurchaseMaxCount: 30 });
    }
  },
);

test(
  'POST /credit-packages/:key/purchase — any count on a pack → 422 count_not_allowed, count 1 included, no Stripe call',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    for (const count of [1, 3]) {
      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
        headers: { 'idempotency-key': `cp-count-pack-${randomUUID()}` },
        payload: {
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
          count,
        },
      });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(res.json().error.code, 'count_not_allowed');
    }
    assert.equal(stripe.calls.length, 0, 'a pack is bought one at a time');
  },
);

for (const [field, value] of [
  ['dog_id', FIXTURE_IDS.dog1Id],
  ['quantity', 3],
  ['location', 'fayetteville'],
] as const) {
  test(
    `POST /credit-packages/:key/purchase — a body still sending ${field} → 400, no Stripe call`,
    SKIP_WHEN_NO_DB,
    async () => {
      const { app, stripe } = buildApp();
      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
        headers: { 'idempotency-key': `cp-strict-${randomUUID()}` },
        payload: {
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
          [field]: value,
        },
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(stripe.calls.length, 0);
    },
  );
}

test(
  'POST /credit-packages/:key/purchase — count 3 + unactioned card → 402, ZERO credits, no ledger lot',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');
    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${SINGLE_DAY_KEY}/purchase`,
      headers: { 'idempotency-key': `cp-count-declined-${randomUUID()}` },
      payload: {
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        count: 3,
      },
    });
    assert.equal(res.statusCode, 402, res.body);
    assert.deepEqual(await boughtLots(), [], 'no ledger lot until the charge settles');
  },
);

test(
  'POST /credit-packages/:key/purchase — count replay with same key → identical body, ONE charge, ONE 3-credit lot',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const key = `cp-count-replay-${randomUUID()}`;
    const payload = {
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      count: 3,
    };
    const first = await app.inject({
      method: 'POST',
      url: `/credit-packages/${SINGLE_DAY_KEY}/purchase`,
      headers: { 'idempotency-key': key },
      payload,
    });
    assert.equal(first.statusCode, 201, first.body);
    const replay = await app.inject({
      method: 'POST',
      url: `/credit-packages/${SINGLE_DAY_KEY}/purchase`,
      headers: { 'idempotency-key': key },
      payload,
    });
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), first.json());
    // The claim answered, so the second send never reached Stripe.
    const creates = stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent');
    assert.equal(creates.length, 1);
    const chargesRows = await db
      .select()
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargesRows.length, 1);
    const ledger = await boughtLots();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.delta, 3);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// `charge_blocker` — WHY the confirm stopped (wire 1.8.0)
//
// Same field, same union, same reason as `POST /invoices/:id/pay`. An intent that can
// still move answers a 201 and stays live; one that stopped is the committed 402.
// ──────────────────────────────────────────────────────────────────────────

for (const rawStatus of ['processing', 'requires_capture'] as const) {
  test(
    `POST /credit-packages/:key/purchase — ${rawStatus} answers 201 with charge_blocker 'processing'`,
    SKIP_WHEN_NO_DB,
    async () => {
      const { app, stripe } = buildApp();
      stripe.setNextIntentStatus(rawStatus);
      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
        headers: { 'idempotency-key': `cp-blocker-${randomUUID()}` },
        payload: {
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        },
      });
      assert.equal(res.statusCode, 201, res.body);
      const body = res.json() as {
        charge_status: string;
        credits_granted: number;
        charge_blocker?: string;
      };
      // Beside the collapsed status, and beside the un-granted credits.
      assert.equal(body.charge_status, 'requires_payment');
      assert.equal(body.credits_granted, 0);
      assert.equal(body.charge_blocker, 'processing');
    },
  );
}

const STOPPED: ReadonlyArray<readonly [StripePaymentIntentStatus, string | undefined]> = [
  ['requires_action', 'authentication_required'],
  ['requires_payment_method', undefined],
  ['requires_confirmation', undefined],
  ['canceled', undefined],
];

for (const [rawStatus, blocker] of STOPPED) {
  test(
    `POST /credit-packages/:key/purchase — ${rawStatus} is a 402 naming ${blocker ?? 'no blocker'}`,
    SKIP_WHEN_NO_DB,
    async () => {
      const { app, stripe } = buildApp();
      stripe.setNextIntentStatus(rawStatus);
      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
        headers: { 'idempotency-key': `cp-blocker-${randomUUID()}` },
        payload: {
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        },
      });
      assert.equal(res.statusCode, 402, res.body);
      const details = res.json().error.details as { charge_blocker?: string };
      assert.equal(details.charge_blocker, blocker);
      assert.deepEqual(await boughtLots(), []);
    },
  );
}

test(
  'POST /credit-packages/:key/purchase — a settled purchase omits charge_blocker entirely',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': `cp-noblocker-${randomUUID()}` },
      payload: {
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.charge_status, 'succeeded');
    // Omitted, not null — presence alone means "this did not settle".
    assert.equal(
      'charge_blocker' in body,
      false,
      'a settled purchase must not carry a reason it stopped',
    );
  },
);
