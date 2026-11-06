import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  charges,
  idempotencyKeys,
  invoices,
  notifications,
  paymentMethods,
  refunds,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import type { StripeWebhookEvent } from '../../src/lib/stripe.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import {
  QUIET_LOG,
  clearOrderRows,
  receiptsFor,
  seedInvoiceOrder,
  seedOpenInvoice,
} from './_orderFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * The settle (design §2.7:3870-3889): under the charge lock, state-guarded, one
 * settler wins and the rest are no-ops, whichever of the request, the webhook, the
 * sweeper or a *Cancel order* gets there first.
 */

after(clearOrderRows);
registerFixtureHooks();
afterEach(async () => {
  await clearOrderRows();
  await db.delete(paymentMethods).where(eq(paymentMethods.id, CARD2_ID));
});

const T0 = new Date('2026-05-19T17:50:00Z');
const PAST_LEASE = new Date(T0.getTime() + 151_000);
const CARD2_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

async function seedSecondCard(): Promise<void> {
  await db.insert(paymentMethods).values({
    id: CARD2_ID,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentMethodId: 'pm_fixture_test_mastercard',
    brand: 'mastercard',
    last4: '8203',
    expMonth: 11,
    expYear: 2031,
    cardholderName: 'Allison Fixture',
    isDefault: false,
  });
}

function buildApp(clock: { now: Date } = { now: T0 }): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: StripeStub;
} {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerInvoicesRoute(app, { authenticate, stripe, now: () => clock.now });
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

function succeededEvent(paymentIntentId: string): StripeWebhookEvent {
  return {
    id: `evt_test_${randomUUID().slice(0, 8)}`,
    type: 'payment_intent.succeeded',
    paymentIntentId,
    amountCents: 8_500,
    metadata: {},
  };
}

async function postWebhook(
  app: ReturnType<typeof buildApp>['app'],
  stripe: StripeStub,
  event: StripeWebhookEvent,
): Promise<{ statusCode: number; body: string }> {
  stripe.setNextEvent(event);
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    payload: '{}',
  });
  return { statusCode: res.statusCode, body: res.body };
}

async function invoiceRow(id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  assert.ok(row);
  return row;
}

async function chargeRow(id: string) {
  const [row] = await db.select().from(charges).where(eq(charges.id, id));
  assert.ok(row);
  return row;
}

test(
  'two connections, one settle, one receipt; a second settler is a no-op',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'processing',
      attemptingUntil: new Date(T0.getTime() + 150_000),
    });
    assert.ok(seeded.intentId);
    stripe.setIntentState(seeded.intentId, 'succeeded');

    const [a, b] = await Promise.all([
      postWebhook(app, stripe, succeededEvent(seeded.intentId)),
      postWebhook(app, stripe, succeededEvent(seeded.intentId)),
    ]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);

    assert.equal((await invoiceRow(invoiceId)).status, 'paid');
    assert.equal((await chargeRow(seeded.chargeId)).status, 'succeeded');
    assert.equal((await receiptsFor(seeded.chargeId)).length, 1, 'one receipt');
    const refundRows = await db.select().from(refunds).where(eq(refunds.chargeId, seeded.chargeId));
    assert.equal(refundRows.length, 0, 'and no refund: the second settler did nothing');

    const third = await postWebhook(app, stripe, succeededEvent(seeded.intentId));
    assert.equal(third.statusCode, 200, third.body);
    assert.equal((await receiptsFor(seeded.chargeId)).length, 1, 'still one');

    const [claim] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, seeded.claimKey));
    assert.equal(claim?.responseStatus, 201, 'the settler completed the claim');
    assert.equal((claim?.responseBody as { invoice_status: string }).invoice_status, 'paid');
  },
);

test(
  'a stubbed long retrieve while a second connection settles the same charge: no lock wait over 1 s, one settle',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'processing',
      attemptingUntil: new Date(T0.getTime() + 150_000),
    });
    assert.ok(seeded.intentId);
    stripe.setIntentState(seeded.intentId, 'succeeded');

    const hold = stripe.holdNext('retrieve');
    const slow = postWebhook(app, stripe, succeededEvent(seeded.intentId));
    await hold.reached;

    try {
      // The retrieve is in flight. A lock on the charge from another connection must
      // come at once: NOWAIT throws 55P03 if the webhook held the row across the call.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM charges WHERE id = ${seeded.chargeId} FOR UPDATE NOWAIT`,
        );
      });

      const started = Date.now();
      const second = await postWebhook(app, stripe, succeededEvent(seeded.intentId));
      const waited = Date.now() - started;
      assert.equal(second.statusCode, 200, second.body);
      assert.ok(waited < 1_000, `the second settler waited ${waited} ms`);
      assert.equal((await invoiceRow(invoiceId)).status, 'paid');
    } finally {
      hold.release();
    }

    const first = await slow;
    assert.equal(first.statusCode, 200, first.body);
    assert.equal((await receiptsFor(seeded.chargeId)).length, 1, 'one settle');
  },
);

test(
  'a stub that holds the confirm: the sweeper retrieves by id and settles forward, one settle, no refund',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const clock = { now: T0 };
    const { app, stripe } = buildApp(clock);
    const hold = stripe.holdNext('confirm');

    const key = `settle-held-${randomUUID()}`;
    const pending = app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': key },
      payload: {},
    });
    await hold.reached;

    const confirm = stripe.calls.find((c) => c.method === 'confirmPaymentIntent');
    assert.ok(confirm?.method === 'confirmPaymentIntent');
    const intentId = confirm.args.paymentIntentId;
    stripe.setIntentState(intentId, 'succeeded');

    clock.now = PAST_LEASE;
    const tick = await runOrderSweeperOnce({ stripe, now: clock.now, log: QUIET_LOG });
    assert.equal(tick.settled, 1, 'settled forward');
    assert.equal((await invoiceRow(invoiceId)).status, 'paid');

    // The held confirm comes back and finds it done.
    hold.release();
    const res = await pending;
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((res.json() as { invoice_status: string }).invoice_status, 'paid');
    const charged = await db
      .select()
      .from(charges)
      .where(eq(charges.stripePaymentIntentId, intentId));
    assert.equal(charged.length, 1);
    assert.equal((await receiptsFor(charged[0]!.id)).length, 1, 'one settle');
    assert.equal(stripe.executedRefunds().length, 0, 'no refund');
  },
);

test(
  'kill after the create, lease past, intent succeeded: the sweeper settles, one receipt',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const stripe = makeStripeStub();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'succeeded',
      attemptingUntil: new Date(T0.getTime() + 150_000),
    });

    const tick = await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });
    assert.equal(tick.settled, 1);
    assert.equal((await invoiceRow(invoiceId)).status, 'paid');
    assert.equal((await chargeRow(seeded.chargeId)).status, 'succeeded');
    assert.equal((await receiptsFor(seeded.chargeId)).length, 1, 'one receipt');

    const again = await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });
    assert.equal(again.scanned, 0, 'nothing left to sweep');
  },
);

test(
  'the receipt push is queued for the next tick, in the transaction that moves the charge',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `settle-receipt-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 201, res.body);
    const { charge_id: chargeId } = res.json() as { charge_id: string };
    const [row] = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, `receipt:${chargeId}`));
    assert.equal(row?.type, 'payment-succeeded');
    assert.equal(row?.trigger, 'order-confirm');
    assert.match(row?.body ?? '', /\$85\.00/, 'a notice prints cents (design.md:3924)');
    assert.equal(row?.status, 'pending');
    assert.equal(row?.deepLinkId, invoiceId);
    assert.ok(
      new Date(row?.scheduledFor ?? 0).getTime() <= T0.getTime(),
      'due now: the next tick carries it',
    );

    // s01's part at this step: the next tick after the money delivers it, once.
    await runSchedulerTickOnce({
      expoPush: makeExpoPushStub(),
      stripe: makeStripeStub(),
      now: new Date(T0.getTime() + 60_000),
    });
    const [sent] = await db
      .select({ status: scheduledNotifications.status })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, `receipt:${chargeId}`));
    assert.equal(sent?.status, 'sent');
    const feed = await db
      .select({ title: notifications.title })
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, FIXTURE_IDS.ownerId),
          eq(notifications.type, 'payment-succeeded'),
        ),
      );
    assert.deepEqual(feed, [{ title: 'Payment received' }], 'one receipt in the feed');
  },
);

test(
  'a failing notice rolls back alone: the money commits and one alarm names the charge and the key',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const capture = makeLogCapture();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
    const stripe = makeStripeStub();
    registerInvoicesRoute(app, { authenticate, stripe, now: () => T0 });

    await db.execute(sql`
      CREATE OR REPLACE FUNCTION p15_refuse_receipt() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'p15 test: the queue refused this row'; END
      $$ LANGUAGE plpgsql`);
    await db.execute(sql`
      CREATE TRIGGER p15_refuse_receipt BEFORE INSERT ON scheduled_notifications
      FOR EACH ROW WHEN (NEW.type = 'payment-succeeded')
      EXECUTE FUNCTION p15_refuse_receipt()`);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/invoices/${invoiceId}/pay`,
        headers: { 'idempotency-key': `settle-notice-${randomUUID()}` },
        payload: {},
      });
      assert.equal(res.statusCode, 201, res.body);
      const { charge_id: chargeId } = res.json() as { charge_id: string };
      assert.equal((await invoiceRow(invoiceId)).status, 'paid', 'the money committed');
      assert.equal((await chargeRow(chargeId)).status, 'succeeded');
      const alarms = capture.lines.filter(
        (l) => l.level === 50 && l.chargeId === chargeId && l.dedupeKey === `receipt:${chargeId}`,
      );
      assert.equal(alarms.length, 1, 'one alarm naming the charge and the key');
    } finally {
      await db.execute(sql`DROP TRIGGER p15_refuse_receipt ON scheduled_notifications`);
      await db.execute(sql`DROP FUNCTION p15_refuse_receipt()`);
    }
  },
);

test(
  'amount_received is asserted: a mismatch is one ERROR naming the charge, and the settle still commits',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const capture = makeLogCapture();
    const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
    const stripe = makeStripeStub();
    registerStripeWebhookRoute(app, { stripe });
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'succeeded',
      attemptingUntil: new Date(T0.getTime() + 150_000),
    });
    assert.ok(seeded.intentId);
    stripe.setAmountReceived(seeded.intentId, 8_000);

    const res = await postWebhook(app, stripe, succeededEvent(seeded.intentId));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await invoiceRow(invoiceId)).status, 'paid');
    const alarms = capture.lines.filter((l) => l.level === 50 && l.chargeId === seeded.chargeId);
    assert.equal(alarms.length, 1);
  },
);

// ── The card rebind (PAY-12, adjudication 2026-07-31) ────────────────────────

async function boundCard(invoiceId: string): Promise<string | null> {
  return (await invoiceRow(invoiceId)).paymentMethodId;
}

test('the card rebind fires only on a clean win, on every settler', SKIP_WHEN_NO_DB, async () => {
  await seedSecondCard();

  // The request settles it.
  {
    const invoiceId = await seedOpenInvoice();
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `rebind-request-${randomUUID()}` },
      payload: { payment_method_id: CARD2_ID },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await boundCard(invoiceId), CARD2_ID, 'the request');
  }

  // A decline rebinds nothing.
  {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'card_declined' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `rebind-decline-${randomUUID()}` },
      payload: { payment_method_id: CARD2_ID },
    });
    assert.equal(res.statusCode, 402, res.body);
    assert.equal(await boundCard(invoiceId), FIXTURE_IDS.paymentMethod1Id, 'a decline');
  }

  // Processing rebinds nothing, and the webhook does.
  {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('processing');
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `rebind-webhook-${randomUUID()}` },
      payload: { payment_method_id: CARD2_ID },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await boundCard(invoiceId), FIXTURE_IDS.paymentMethod1Id, 'still processing');
    const { stripe_payment_intent_id: intentId } = res.json() as {
      stripe_payment_intent_id: string;
    };
    stripe.setIntentState(intentId, 'succeeded');
    const hook = await postWebhook(app, stripe, succeededEvent(intentId));
    assert.equal(hook.statusCode, 200, hook.body);
    assert.equal(await boundCard(invoiceId), CARD2_ID, 'the webhook');
  }

  // The sweeper.
  {
    const invoiceId = await seedOpenInvoice();
    const stripe = makeStripeStub();
    await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'succeeded',
      attemptingUntil: new Date(T0.getTime() + 150_000),
      paymentMethodId: CARD2_ID,
    });
    await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });
    assert.equal(await boundCard(invoiceId), CARD2_ID, 'the sweeper');
  }

  // *Cancel order* finding the payment won.
  {
    const invoiceId = await seedOpenInvoice();
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    const stripe = makeStripeStub();
    registerStaffOrdersRoute(app, { authenticate, stripe, now: () => T0 });
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'succeeded',
      attemptingUntil: new Date(T0.getTime() + 150_000),
      paymentMethodId: CARD2_ID,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/staff/orders/${seeded.orderId}/cancel`,
      headers: { 'idempotency-key': `rebind-cancel-${randomUUID()}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await boundCard(invoiceId), CARD2_ID, 'cancel order');
  }

  // The loser of a race rebinds nothing: the winner's card names what paid.
  {
    const invoiceId = await seedOpenInvoice();
    const stripe = makeStripeStub();
    await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'succeeded',
      attemptingUntil: new Date(T0.getTime() + 150_000),
      paymentMethodId: CARD2_ID,
    });
    await db
      .update(invoices)
      .set({ status: 'paid', paidAt: T0.toISOString() })
      .where(eq(invoices.id, invoiceId));
    await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });
    assert.equal(await boundCard(invoiceId), FIXTURE_IDS.paymentMethod1Id, 'a lost race');
    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(refund?.amountCents, 8_500, 'PAY-35 refunds it');
  }
});
