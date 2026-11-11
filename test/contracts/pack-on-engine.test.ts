import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import {
  bookings,
  charges,
  cohorts,
  creditLedger,
  creditPackages,
  idempotencyKeys,
  invoices,
  orders,
  refunds,
  scheduledNotifications,
  stripeEvents,
} from '../../src/db/schema/schema.js';
import { hashRequestBody } from '../../src/db/mutation.js';
import { creditLedgerRepository } from '../../src/db/repositories/creditLedgerRepository.js';
import { creditsInvalidationPattern } from '../../src/db/repositories/creditsRepository.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
import { FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { createAlumniDog, removeDogs } from './_dayFixture.js';
import { QUIET_LOG, clearOrderRows, receiptsFor } from './_orderFixture.js';
import { waitForBlockedBackends } from './_poolFixture.js';
import { signedIntentEvent, verifyingSignatures } from './_signedEvents.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * A pack rides the order engine: one order, one charge written before Stripe, metadata
 * `{order_id, charge_id}` only, and one settle statement for the route and the webhook
 * (design §2.4:2978-3050, DECISIONS 171, 174).
 */

registerFixtureHooks();

const KEY = 'school-2x-weekly-fayetteville';

afterEach(async () => {
  await db.delete(creditLedger).where(isNotNull(creditLedger.chargeId));
  await clearOrderRows();
  await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(stripeEvents);
});

function buildApp(capture?: ReturnType<typeof makeLogCapture>) {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  const stripe = verifyingSignatures(makeStripeStub());
  registerCreditPackagesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

type App = ReturnType<typeof buildApp>['app'];

function buy(app: App, key = KEY) {
  return app.inject({
    method: 'POST',
    url: `/credit-packages/${key}/purchase`,
    headers: { 'idempotency-key': `pack-${randomUUID()}` },
    payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id },
  });
}

function deliver(
  app: App,
  stripe: StripeStub,
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed',
  intentId: string,
) {
  const event = signedIntentEvent({ type, intentId, ...stripe.intentSnapshot(intentId) });
  return app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
    payload: event.payload,
  });
}

async function packRow(key = KEY) {
  const [row] = await db.select().from(creditPackages).where(eq(creditPackages.key, key));
  assert.ok(row);
  return row;
}

async function purchaseLots() {
  return db
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.ownerId, FIXTURE_IDS.ownerId), eq(creditLedger.reason, 'purchase')))
    .then((rows) => rows.filter((r) => r.chargeId !== null));
}

async function paidInvoices() {
  return db
    .select()
    .from(invoices)
    .where(and(eq(invoices.ownerId, FIXTURE_IDS.ownerId), eq(invoices.status, 'paid')));
}

async function failurePushes() {
  return db
    .select({ title: scheduledNotifications.title, body: scheduledNotifications.body })
    .from(scheduledNotifications)
    .where(
      and(
        eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
        eq(scheduledNotifications.type, 'payment-failed'),
      ),
    );
}

test(
  "L1: a signed payment_intent.succeeded between Stripe's answer and the settle: one lot, one invoice, one 201, no 23505",
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.afterNextConfirmAnswer(async (answer) => {
      const delivered = await deliver(app, stripe, 'payment_intent.succeeded', answer.id);
      assert.equal(delivered.statusCode, 200, delivered.body);
    });

    const res = await buy(app);

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_status: string; credits_granted: number };
    assert.equal(body.charge_status, 'succeeded', 'she reads the purchase as done');
    assert.equal(body.credits_granted, 8);
    assert.equal((await purchaseLots()).length, 1, 'one lot');
    assert.equal((await paidInvoices()).length, 1, 'one invoice');
  },
);

test(
  'attempt 1 declines and its event is delivered, attempt 2 succeeds: one lot, one paid invoice carrying package_id, charge succeeded, no failure push',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.queueIntentOutcomes([
      { kind: 'returnedDecline', code: 'processing_error' },
      { kind: 'status', status: 'succeeded' },
    ]);
    stripe.afterNextConfirmAnswer(async (answer) => {
      const delivered = await deliver(app, stripe, 'payment_intent.payment_failed', answer.id);
      assert.equal(delivered.statusCode, 200, delivered.body);
    });

    const res = await buy(app);

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_id: string; charge_status: string };
    assert.equal(body.charge_status, 'succeeded');
    const [charge] = await db.select().from(charges).where(eq(charges.id, body.charge_id));
    assert.equal(charge?.status, 'succeeded');
    assert.equal((await purchaseLots()).length, 1, 'one lot');
    const paid = await paidInvoices();
    assert.equal(paid.length, 1, 'one paid invoice');
    assert.equal(paid[0]?.packageId, (await packRow()).id, 'carrying package_id');
    assert.deepEqual(await failurePushes(), [], 'no failure push');
  },
);

test(
  'a card pack answers 201, not 42P10 or 23514, with package_id and location written in the same INSERT',
  SKIP_WHEN_NO_DB,
  async () => {
    // M6.03's CHECK, here and now: a settle that wrote the invoice and stamped it after
    // would break it on the INSERT, which is what "the same INSERT" means.
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(`
      ALTER TABLE invoices ADD CONSTRAINT p18_package_stamped
        CHECK (purpose <> 'package' OR (package_id IS NOT NULL AND location IS NOT NULL))`);
    try {
      const { app } = buildApp();
      const res = await buy(app);
      assert.equal(res.statusCode, 201, res.body);
      const body = res.json() as { charge_id: string };

      const pack = await packRow();
      const [invoice] = await paidInvoices();
      assert.ok(invoice, 'the order is one paid invoice');
      assert.equal(invoice.purpose, 'package');
      assert.equal(invoice.packageId, pack.id);
      assert.equal(invoice.location, 'fayetteville');
      assert.equal(invoice.paidChargeId, body.charge_id);
      assert.equal(invoice.amountCents, pack.priceCents);
      assert.ok(invoice.paidAt !== null);
      assert.equal(invoice.dueAt, invoice.paidAt, 'due_at and paid_at are both the settle time');
      assert.equal(invoice.paymentMethodId, FIXTURE_IDS.paymentMethod1Id, 'the card charged');
    } finally {
      await client.query(`ALTER TABLE invoices DROP CONSTRAINT IF EXISTS p18_package_stamped`);
      await client.end();
    }
  },
);

test(
  'the charge is written before Stripe with the purchase frozen on it, and the metadata is {order_id, charge_id} only',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const res = await buy(app);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_id: string };

    const [charge] = await db.select().from(charges).where(eq(charges.id, body.charge_id));
    assert.equal(charge?.packageId, (await packRow()).id);
    assert.equal(charge?.creditsCount, 8);
    assert.ok(charge?.orderId, 'the charge is the order engine`s');

    const creates = stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent');
    assert.equal(creates.length, 1, 'one intent, split create and confirm');
    assert.deepEqual(creates[0]?.args.metadata, {
      order_id: charge?.orderId,
      charge_id: body.charge_id,
    });
  },
);

test(
  'a processing pack leaves its intent live: nothing cancels it, nothing is granted, and the webhook settles it',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('processing');
    const res = await buy(app);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      charge_id: string;
      charge_status: string;
      credits_granted: number;
      charge_blocker?: string;
      stripe_payment_intent_id: string;
    };
    assert.equal(body.charge_status, 'requires_payment');
    assert.equal(body.credits_granted, 0);
    assert.equal(body.charge_blocker, 'processing');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length,
      0,
      "today's cancel-before-return does not survive",
    );
    assert.deepEqual(await purchaseLots(), []);

    stripe.setIntentState(body.stripe_payment_intent_id, 'succeeded');
    const settled = await deliver(
      app,
      stripe,
      'payment_intent.succeeded',
      body.stripe_payment_intent_id,
    );
    assert.equal(settled.statusCode, 200, settled.body);
    assert.equal((await purchaseLots()).length, 1, 'the credits are added when it clears');
    assert.equal((await receiptsFor(body.charge_id)).length, 1);
  },
);

test(
  'a decline is a 402 that grants nothing, and a replay returns the same 402',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setNextIntentThrowsCardError('requires_payment_method', 'card_declined');
    const key = `pack-decline-${randomUUID()}`;
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/credit-packages/${KEY}/purchase`,
        headers: { 'idempotency-key': key },
        payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id },
      });
    const first = await send();
    assert.equal(first.statusCode, 402, first.body);
    assert.equal(first.json().error.code, 'payment_failed');
    const replay = await send();
    assert.equal(replay.statusCode, 402);
    assert.deepEqual(replay.json(), first.json());
    assert.deepEqual(await purchaseLots(), []);
    assert.deepEqual(await paidInvoices(), []);
  },
);

test(
  'a payment_failed for a purchase writes no ledger row, and delivered after the settle changes nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const res = await buy(app);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_id: string; stripe_payment_intent_id: string };
    const before = await db.select().from(creditLedger);

    const late = await deliver(
      app,
      stripe,
      'payment_intent.payment_failed',
      body.stripe_payment_intent_id,
    );
    assert.equal(late.statusCode, 200, late.body);

    assert.deepEqual(await db.select().from(creditLedger), before, 'no ledger row moved');
    const [charge] = await db.select().from(charges).where(eq(charges.id, body.charge_id));
    assert.equal(charge?.status, 'succeeded');
    assert.deepEqual(await failurePushes(), []);
  },
);

test(
  'a payment_failed on a charge the engine does not own writes no reversal: nothing was granted before the money',
  SKIP_WHEN_NO_DB,
  async () => {
    // The arm §2.4:2925-2927 deletes. A provisional grant on an unsettled charge is what
    // it reversed, so this plants one to see the row it no longer writes.
    const chargeId = randomUUID();
    const intentId = `pi_test_${randomUUID().slice(0, 8)}`;
    await db.insert(charges).values({
      id: chargeId,
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 45_600,
      status: 'requires_payment',
      purpose: 'package',
      stripePaymentIntentId: intentId,
    });
    await db.insert(creditLedger).values({
      ownerId: FIXTURE_IDS.ownerId,
      location: 'fayetteville',
      mode: 'school',
      delta: 8,
      reason: 'purchase',
      chargeId,
      expiresAt: '2036-01-01T00:00:00.000Z',
    });
    const { app, stripe } = buildApp();
    stripe.adoptIntent({
      id: intentId,
      status: 'requires_payment_method',
      amountCents: 45_600,
      metadata: {},
    });

    const res = await deliver(app, stripe, 'payment_intent.payment_failed', intentId);
    assert.equal(res.statusCode, 200, res.body);

    const rows = await db
      .select({ delta: creditLedger.delta, reason: creditLedger.reason })
      .from(creditLedger)
      .where(eq(creditLedger.chargeId, chargeId));
    assert.deepEqual(rows, [{ delta: 8, reason: 'purchase' }], 'no reversing row');
  },
);

test(
  'a staff cancel of a processing pack Stripe refuses, then a succeeded event: 0 lots, 0 paid invoices, one full refunds row, the honest push',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const { app: staffApp, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffOrdersRoute(staffApp, { authenticate, stripe, now: FIXTURE_NOW });

    stripe.setNextIntentStatus('processing');
    const res = await buy(app);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_id: string; stripe_payment_intent_id: string };
    const [charge] = await db.select().from(charges).where(eq(charges.id, body.charge_id));
    assert.ok(charge?.orderId, 'the purchase is an order staff can cancel');

    const cancelled = await staffApp.inject({
      method: 'POST',
      url: `/staff/orders/${charge.orderId}/cancel`,
      headers: { 'idempotency-key': `pack-cancel-${randomUUID()}` },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().outcome, 'cancelled');
    assert.deepEqual(await failurePushes(), [
      {
        title: 'Purchase cancelled',
        body: "We couldn't stop this payment. If it goes through, it will be refunded to your card in full, and no credits will be added.",
      },
    ]);

    stripe.setIntentState(body.stripe_payment_intent_id, 'succeeded');
    const late = await deliver(
      app,
      stripe,
      'payment_intent.succeeded',
      body.stripe_payment_intent_id,
    );
    assert.equal(late.statusCode, 200, late.body);

    assert.deepEqual(await purchaseLots(), [], '0 lots');
    assert.deepEqual(await paidInvoices(), [], '0 paid invoices');
    const refundRows = await db.select().from(refunds).where(eq(refunds.chargeId, body.charge_id));
    assert.equal(refundRows.length, 1, 'one refunds row');
    assert.equal(refundRows[0]?.amountCents, 45_600, 'of the full amount');
  },
);

test(
  'a staff cancel Stripe confirms says she was not charged and no credits were added',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const { app: staffApp, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffOrdersRoute(staffApp, { authenticate, stripe, now: FIXTURE_NOW });

    stripe.setNextIntentStatus('processing');
    const res = await buy(app);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_id: string; stripe_payment_intent_id: string };
    const [charge] = await db.select().from(charges).where(eq(charges.id, body.charge_id));
    assert.ok(charge?.orderId);
    stripe.setIntentState(body.stripe_payment_intent_id, 'requires_payment_method');

    const cancelled = await staffApp.inject({
      method: 'POST',
      url: `/staff/orders/${charge.orderId}/cancel`,
      headers: { 'idempotency-key': `pack-cancel-${randomUUID()}` },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.deepEqual(await failurePushes(), [
      { title: 'Purchase cancelled', body: "You weren't charged and no credits were added." },
    ]);
  },
);

test(
  'a pack the bank declines late took no rows down: it still reads as a purchase, and says no credits were added',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('processing');
    const res = await buy(app);
    assert.equal(res.statusCode, 201, res.body);
    const { stripe_payment_intent_id: intentId } = res.json() as {
      stripe_payment_intent_id: string;
    };
    stripe.setIntentState(intentId, 'requires_payment_method', { failureCode: 'card_declined' });

    await runOrderSweeperOnce({
      stripe,
      now: new Date(FIXTURE_TODAY.getTime() + 60 * 60 * 1000),
      log: QUIET_LOG,
    });

    assert.deepEqual(await failurePushes(), [
      {
        title: 'Purchase failed',
        body: "Your $456.00 purchase didn't go through, so you weren't charged and no credits were added.",
      },
    ]);
  },
);

test(
  'the receipt names what she bought: amount, credits, campus, program and the date they expire',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setIntentsCreatedAt(new Date('2026-10-11T01:28:00Z')); // Sat 10 Oct 20:28 CDT
    const res = await buy(app, 'school-2x-weekly-bentonville');
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_id: string };
    assert.deepEqual(await receiptsFor(body.charge_id), [
      {
        title: 'Payment received',
        body: '$456.00 — 8 Bentonville day-school credits, expire 10 Nov.',
      },
    ]);
  },
);

test(
  'a count lands one lot of that many credits, charged count × price',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/credit-packages/single-day-school-fayetteville/purchase',
      headers: { 'idempotency-key': `pack-count-${randomUUID()}` },
      payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id, count: 3 },
    });
    assert.equal(res.statusCode, 201, res.body);
    const [lot] = await purchaseLots();
    assert.equal(lot?.delta, 3);
    assert.equal(lot?.tier, 'regular');
    const creates = stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent');
    assert.equal(creates[0]?.args.amountCents, 18_000);
  },
);

test('the alumni row lands in the alumni pool', SKIP_WHEN_NO_DB, async (t) => {
  // An alumni dog on the account is what lets the household buy it (ALUM-U11).
  const alumniDogs: string[] = [];
  await createAlumniDog(alumniDogs);
  t.after(() => removeDogs(alumniDogs));
  const { app } = buildApp();
  const res = await buy(app, 'school-alumni-10-fayetteville');
  assert.equal(res.statusCode, 201, res.body);
  const [lot] = await purchaseLots();
  assert.equal(lot?.tier, 'alumni');
  assert.equal(lot?.dogId, null, 'a lot names no dog');
  assert.equal(
    (
      await db.execute(sql`SELECT count(*)::int AS n FROM owner_credit_balance
         WHERE owner_id = ${FIXTURE_IDS.ownerId} AND tier = 'alumni'`)
    ).rows[0]?.n,
    1,
  );
});

test(
  'a second grant on one charge writes no second lot and raises nothing, and reads the first back',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const res = await buy(app);
    assert.equal(res.statusCode, 201, res.body);
    const { charge_id: chargeId } = res.json() as { charge_id: string };
    const [first] = await purchaseLots();

    const again = await db.transaction((tx) =>
      creditLedgerRepository.grantChargeLot(tx, {
        chargeId,
        expiresAt: new Date('2036-01-01T00:00:00Z'),
      }),
    );

    assert.equal(again?.id, first?.id, 'the lot that stands');
    assert.equal(again?.credits, 8);
    const lots = await purchaseLots();
    assert.equal(lots.length, 1, 'one lot');
    assert.equal(lots[0]?.expiresAt, first?.expiresAt, 'its date is not moved');
  },
);

test(
  'a settle that meets the charge`s lot already written ends paid, with that lot: no 23505',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('processing');
    const res = await buy(app);
    const body = res.json() as { charge_id: string; stripe_payment_intent_id: string };
    const pack = await packRow();
    // No road writes this today: the charge lock and its status guard stop a second settle.
    // A lot already on the charge is what the conflict target exists for.
    await db.insert(creditLedger).values({
      ownerId: FIXTURE_IDS.ownerId,
      location: pack.location,
      mode: pack.mode,
      tier: pack.tier,
      delta: 8,
      reason: 'purchase',
      chargeId: body.charge_id,
      packageId: pack.id,
      expiresAt: '2036-01-01T00:00:00.000Z',
    });

    stripe.setIntentState(body.stripe_payment_intent_id, 'succeeded');
    const hook = await deliver(
      app,
      stripe,
      'payment_intent.succeeded',
      body.stripe_payment_intent_id,
    );

    assert.equal(hook.statusCode, 200, hook.body);
    assert.equal((await purchaseLots()).length, 1, 'one lot');
    assert.equal((await paidInvoices()).length, 1, 'one paid invoice');
    const [charge] = await db.select().from(charges).where(eq(charges.id, body.charge_id));
    assert.equal(charge?.status, 'succeeded');
    const [receipt] = await receiptsFor(body.charge_id);
    assert.match(receipt?.body ?? '', /31 Dec/, 'the receipt names the date the lot holds');
  },
);

test('buying a pack reserves no day and no seat (CRED-U26)', SKIP_WHEN_NO_DB, async () => {
  const seats = async () => {
    const rows = await db
      .select({ id: cohorts.id, filled: cohorts.filled })
      .from(cohorts)
      .orderBy(cohorts.id);
    return rows;
  };
  const before = await seats();
  const { app } = buildApp();
  const res = await buy(app);
  assert.equal(res.statusCode, 201, res.body);
  const { charge_id: chargeId } = res.json() as { charge_id: string };
  const [charge] = await db.select().from(charges).where(eq(charges.id, chargeId));

  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.orderId, charge?.orderId as string));
  assert.deepEqual(rows, [], 'no day');
  assert.deepEqual(await seats(), before, 'no seat');
});

test(
  'a same-key re-send of a processing pack is 409, then replays the settled answer',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('processing');
    const key = `pack-resend-${randomUUID()}`;
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/credit-packages/${KEY}/purchase`,
        headers: { 'idempotency-key': key },
        payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id },
      });
    const first = await send();
    assert.equal(first.statusCode, 201, first.body);
    const { stripe_payment_intent_id: intentId } = first.json() as {
      stripe_payment_intent_id: string;
    };

    const open = await send();
    assert.equal(open.statusCode, 409, open.body);
    assert.equal(open.json().error.code, 'idempotency_inflight');

    stripe.setIntentState(intentId, 'succeeded');
    await deliver(app, stripe, 'payment_intent.succeeded', intentId);

    const settled = await send();
    assert.equal(settled.statusCode, 201, settled.body);
    assert.equal(settled.json().charge_status, 'succeeded');
    assert.equal(settled.json().credits_granted, 8);
  },
);

test(
  'a same-key request that passed the peek before the claim committed is 409, never a blank replay',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const key = `pack-race-${randomUUID()}`;
    const payload = { payment_method_id: FIXTURE_IDS.paymentMethod1Id };
    // Stands in for the first request's tx1: its claim is written and not yet committed, so
    // the second request's peek sees nothing and its INSERT waits on the unique index.
    const gate = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await gate.connect();
    try {
      await gate.query('BEGIN');
      await gate.query(
        'INSERT INTO idempotency_keys (key, owner_id, endpoint, request_hash) VALUES ($1, $2, $3, $4)',
        [
          key,
          FIXTURE_IDS.ownerId,
          'POST /credit-packages/:key/purchase',
          hashRequestBody({ key: KEY, ...payload }),
        ],
      );
      const answer = app.inject({
        method: 'POST',
        url: `/credit-packages/${KEY}/purchase`,
        headers: { 'idempotency-key': key },
        payload,
      });
      await waitForBlockedBackends(1);
      await gate.query('COMMIT');

      const res = await answer;
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(res.json().error.code, 'idempotency_inflight');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      await gate.end();
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    }
  },
);

for (const [name, createdAt, expected] of [
  ['the fall-back keeps its wall clock', '2026-10-19T14:10:00.000Z', '2026-11-19T15:10:00.000Z'],
  ['a month-end clamps to the last day', '2027-01-31T15:00:00.000Z', '2027-02-28T15:00:00.000Z'],
] as const) {
  test(`a lot's month is a Chicago month: ${name}`, SKIP_WHEN_NO_DB, async () => {
    const { app, stripe } = buildApp();
    stripe.setIntentsCreatedAt(new Date(createdAt));
    const res = await buy(app);
    assert.equal(res.statusCode, 201, res.body);
    const [lot] = await purchaseLots();
    assert.equal(new Date(lot?.expiresAt as string).toISOString(), expected);
  });
}

test(
  'a lot is dated from the intent, so a late settle stamps what the route would have',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setIntentsCreatedAt(new Date('2026-05-19T17:00:00.000Z'));
    stripe.setNextIntentStatus('processing');
    const res = await buy(app);
    const { stripe_payment_intent_id: intentId } = res.json() as {
      stripe_payment_intent_id: string;
    };

    stripe.setIntentState(intentId, 'succeeded');
    await deliver(app, stripe, 'payment_intent.succeeded', intentId);

    const [lot] = await purchaseLots();
    assert.equal(new Date(lot?.expiresAt as string).toISOString(), '2026-06-19T17:00:00.000Z');
  },
);

test(
  'a charge that reads failed gets no invoice and no lot, whoever asks',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    stripe.setNextIntentThrowsCardError('requires_payment_method', 'card_declined');
    const res = await buy(app);
    assert.equal(res.statusCode, 402, res.body);
    const [charge] = await db
      .select()
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(charge?.status, 'failed');
    assert.ok(charge?.packageId, 'the purchase is frozen on it');

    await db.transaction(async (tx) => {
      await invoicesRepository.writePaidForCharge(tx, {
        chargeId: charge.id,
        settledAt: new Date(),
      });
      const lot = await creditLedgerRepository.grantChargeLot(tx, {
        chargeId: charge.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      assert.equal(lot, undefined);
    });

    assert.deepEqual(await purchaseLots(), []);
    assert.deepEqual(await paidInvoices(), []);
  },
);

test('the settle waits for the pool lock before it grants', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const gate = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await gate.connect();
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `pool:${FIXTURE_IDS.ownerId}:fayetteville:school:regular`,
    ]);
    const answer = buy(app);
    await waitForBlockedBackends(1);
    assert.deepEqual(await purchaseLots(), [], 'nothing is granted under her lock');
    await gate.query('COMMIT');

    const res = await answer;
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((await purchaseLots()).length, 1);
  } finally {
    await gate.query('ROLLBACK').catch(() => undefined);
    await gate.end();
  }
});

test(
  'an amount_received that differs still settles, and one alarm reaches the log through the webhook',
  SKIP_WHEN_NO_DB,
  async () => {
    const capture = makeLogCapture();
    const { app, stripe } = buildApp(capture);
    stripe.setNextIntentStatus('processing');
    const res = await buy(app);
    const body = res.json() as { charge_id: string; stripe_payment_intent_id: string };
    stripe.setIntentState(body.stripe_payment_intent_id, 'succeeded');
    stripe.setAmountReceived(body.stripe_payment_intent_id, 1);

    const hook = await deliver(
      app,
      stripe,
      'payment_intent.succeeded',
      body.stripe_payment_intent_id,
    );

    assert.equal(hook.statusCode, 200, hook.body);
    const alarms = capture.lines.filter((l) => l.level === 50 && l.chargeId === body.charge_id);
    assert.equal(alarms.length, 1, 'one named alarm');
    assert.equal((await purchaseLots()).length, 1, 'the money moved, so the credits are hers');
  },
);

function creditsReader() {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerCreditsRoute(app, { authenticate });
  return async (): Promise<number | undefined> => {
    const res = await app.inject({ method: 'GET', url: '/credits?location=fayetteville' });
    assert.equal(res.statusCode, 200, res.body);
    const { pools } = res.json() as { pools: { mode: string; balance: number }[] };
    return pools.find((pool) => pool.mode === 'school')?.balance;
  };
}

test('a settle by the webhook wipes her cached balance', SKIP_WHEN_NO_DB, async () => {
  await invalidatePattern(creditsInvalidationPattern(FIXTURE_IDS.ownerId));
  const { app, stripe } = buildApp();
  const read = creditsReader();
  stripe.setNextIntentStatus('processing');
  const res = await buy(app);
  const { stripe_payment_intent_id: intentId } = res.json() as { stripe_payment_intent_id: string };
  const before = (await read()) ?? 0;

  stripe.setIntentState(intentId, 'succeeded');
  await deliver(app, stripe, 'payment_intent.succeeded', intentId);

  assert.equal(await read(), before + 8);
});

test('a settle by the sweeper wipes her cached balance', SKIP_WHEN_NO_DB, async () => {
  await invalidatePattern(creditsInvalidationPattern(FIXTURE_IDS.ownerId));
  const { app, stripe } = buildApp();
  const read = creditsReader();
  stripe.setNextIntentStatus('processing');
  const res = await buy(app);
  const { stripe_payment_intent_id: intentId } = res.json() as { stripe_payment_intent_id: string };
  const before = (await read()) ?? 0;

  stripe.setIntentState(intentId, 'succeeded');
  await runOrderSweeperOnce({
    stripe,
    now: new Date(Date.now() + 60 * 60 * 1000),
    log: QUIET_LOG,
  });

  assert.equal(await read(), before + 8);
});
