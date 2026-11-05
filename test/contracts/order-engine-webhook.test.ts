import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings,
  charges,
  creditLedger,
  idempotencyKeys,
  invoices,
  notifications,
  refunds,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import type { StripeWebhookEvent } from '../../src/lib/stripe.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
import { createFundedDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, futureWeekday } from './_fixture.js';
import {
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import {
  QUIET_LOG,
  clearOrderRows,
  seedInvoiceOrder,
  seedOpenInvoice,
  seedPendingBookingOrder,
  type SeededOrder,
} from './_orderFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * The webhook on an engine-owned charge (design §2.7:3905-3938): retrieve with no
 * transaction open, lock, act under the guard. Ownership is `charges.order_id`
 * (DECISIONS 142(f)); every other charge keeps today's arm, and the existing webhook
 * files are what hold that.
 */

const createdDogs: string[] = [];
after(async () => {
  await clearOrderRows();
  await removeDogs(createdDogs);
});
registerFixtureHooks();
afterEach(clearOrderRows);

const T0 = new Date('2026-05-19T17:50:00Z');
const LEASE_END = new Date(T0.getTime() + 150_000);
const PAST_LEASE = new Date(T0.getTime() + 151_000);

function buildApp(capture?: ReturnType<typeof makeLogCapture>): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: StripeStub;
} {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL, capture);
  const stripe = makeStripeStub();
  registerStripeWebhookRoute(app, { stripe });
  registerStaffOrdersRoute(app, { authenticate, stripe, now: () => T0 });
  return { app, stripe };
}

function event(
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed' | 'payment_intent.canceled',
  paymentIntentId: string,
  metadata: Record<string, string> = {},
): StripeWebhookEvent {
  return {
    id: `evt_test_${randomUUID().slice(0, 8)}`,
    type,
    paymentIntentId,
    amountCents: 6_000,
    metadata,
  };
}

async function postWebhook(
  app: ReturnType<typeof buildApp>['app'],
  stripe: StripeStub,
  ev: StripeWebhookEvent,
): Promise<{ statusCode: number; body: string }> {
  stripe.setNextEvent(ev);
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    payload: '{}',
  });
  return { statusCode: res.statusCode, body: res.body };
}

async function cancelOrder(app: ReturnType<typeof buildApp>['app'], orderId: string) {
  return app.inject({
    method: 'POST',
    url: `/staff/orders/${orderId}/cancel`,
    headers: { 'idempotency-key': `cancel-${randomUUID()}` },
  });
}

async function chargeRow(id: string) {
  const [row] = await db.select().from(charges).where(eq(charges.id, id));
  assert.ok(row);
  return row;
}

async function rowStatuses(seeded: SeededOrder): Promise<string[]> {
  const rows = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(inArray(bookings.id, seeded.bookingIds));
  return rows.map((r) => r.status);
}

async function noticesFor(): Promise<{ title: string; body: string; type: string }[]> {
  const queued = await db
    .select({
      title: scheduledNotifications.title,
      body: scheduledNotifications.body,
      type: scheduledNotifications.type,
    })
    .from(scheduledNotifications)
    .where(
      and(
        eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
        like(scheduledNotifications.dedupeKey, '%:%'),
      ),
    );
  const feed = await db
    .select({ title: notifications.title, body: notifications.body, type: notifications.type })
    .from(notifications)
    .where(eq(notifications.ownerId, FIXTURE_IDS.ownerId));
  return [...queued, ...feed].filter(
    (n) => !['booking-reminder', 'boarding-profile-check'].includes(n.type),
  );
}

test(
  'the succeeded webhook after a staff Cancel order: one refund of the full amount, nothing booked, nothing granted, no failed wording',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1), futureWeekday(2)],
      now: T0,
    });
    assert.ok(seeded.intentId);

    const res = await cancelOrder(app, seeded.orderId);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { outcome: string }).outcome, 'cancelled');
    assert.deepEqual(await rowStatuses(seeded), ['cancelled', 'cancelled']);
    const grantsBefore = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.dogId, dogId));

    // Stripe would not cancel it, and the bank takes the money after all.
    stripe.setIntentState(seeded.intentId, 'succeeded');
    const hook = await postWebhook(app, stripe, event('payment_intent.succeeded', seeded.intentId));
    assert.equal(hook.statusCode, 200, hook.body);

    const refundRows = await db.select().from(refunds).where(eq(refunds.chargeId, seeded.chargeId));
    assert.equal(refundRows.length, 1, 'one refunds row');
    assert.equal(refundRows[0]?.amountCents, 6_000, 'of the full amount');
    assert.equal(stripe.executedRefunds().length, 1, 'and it went to Stripe');
    assert.deepEqual(await rowStatuses(seeded), ['cancelled', 'cancelled'], 'nothing booked');
    const grantsAfter = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.dogId, dogId));
    assert.equal(grantsAfter.length, grantsBefore.length, 'nothing granted');
    for (const notice of await noticesFor()) {
      assert.doesNotMatch(`${notice.title} ${notice.body}`, /fail/i, notice.title);
      assert.notEqual(notice.type, 'payment-failed');
    }

    // A redelivery under a new event id refunds nothing more.
    const again = await postWebhook(
      app,
      stripe,
      event('payment_intent.succeeded', seeded.intentId),
    );
    assert.equal(again.statusCode, 200, again.body);
    const after = await db.select().from(refunds).where(eq(refunds.chargeId, seeded.chargeId));
    assert.equal(after.length, 1, 'once');

    // The refund lands, and the ledger's last word on this money is the true one.
    const [executed] = stripe.executedRefunds();
    assert.ok(executed);
    stripe.setNextEvent({
      id: `evt_test_${randomUUID().slice(0, 8)}`,
      type: 'charge.refund.updated',
      refundId: executed.id,
      paymentIntentId: seeded.intentId,
      amountCents: 6_000,
      status: 'succeeded',
    });
    const landed = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
      payload: '{}',
    });
    assert.equal(landed.statusCode, 200, landed.body);
    assert.equal((await chargeRow(seeded.chargeId)).status, 'refunded');
  },
);

test(
  'a late success on an order the sweeper abandoned takes the intent id from the event and refunds it once',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1)],
      now: T0,
      intentStatus: null,
      attemptingUntil: LEASE_END,
      attemptCount: 0,
    });
    await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });
    assert.equal((await chargeRow(seeded.chargeId)).status, 'failed');

    const intent = await stripe.createUnconfirmedPaymentIntent(
      {
        customerId: FIXTURE_IDS.stripeCustomerId,
        paymentMethodId: 'pm_fixture_test_visa',
        amountCents: 6_000,
        currency: 'usd',
        metadata: { order_id: seeded.orderId, charge_id: seeded.chargeId },
      },
      `a-create-the-sweeper-never-saw-${randomUUID()}`,
      { timeoutMs: 30_000 },
    );
    stripe.setIntentState(intent.id, 'succeeded');

    const hook = await postWebhook(
      app,
      stripe,
      event('payment_intent.succeeded', intent.id, {
        order_id: seeded.orderId,
        charge_id: seeded.chargeId,
      }),
    );
    assert.equal(hook.statusCode, 200, hook.body);
    assert.equal((await chargeRow(seeded.chargeId)).stripePaymentIntentId, intent.id);
    const refundRows = await db.select().from(refunds).where(eq(refunds.chargeId, seeded.chargeId));
    assert.equal(refundRows.length, 1);
    assert.equal(refundRows[0]?.amountCents, 6_000);
  },
);

test('payment_failed is advisory: it writes last_stripe_error only', SKIP_WHEN_NO_DB, async () => {
  const invoiceId = await seedOpenInvoice();
  const { app, stripe } = buildApp();
  const seeded = await seedInvoiceOrder(stripe, {
    invoiceId,
    now: T0,
    intentStatus: 'requires_payment_method',
    attemptingUntil: LEASE_END,
  });
  assert.ok(seeded.intentId);
  stripe.setIntentState(seeded.intentId, 'requires_payment_method', {
    failureCode: 'card_declined',
  });

  const hook = await postWebhook(
    app,
    stripe,
    event('payment_intent.payment_failed', seeded.intentId),
  );
  assert.equal(hook.statusCode, 200, hook.body);
  const row = await chargeRow(seeded.chargeId);
  assert.equal(row.status, 'requires_payment', 'Stripe sends one per failed attempt');
  assert.equal(row.lastStripeError, 'card_declined');
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  assert.equal(invoice?.status, 'open');
  const [claim] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, seeded.claimKey));
  assert.equal(claim?.completedAt, null, 'the claim stays open');
});

test(
  'canceled is the failure policy, with the failed-payment notice',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1), futureWeekday(2)],
      now: T0,
    });
    assert.ok(seeded.intentId);
    stripe.setIntentState(seeded.intentId, 'canceled');

    const hook = await postWebhook(app, stripe, event('payment_intent.canceled', seeded.intentId));
    assert.equal(hook.statusCode, 200, hook.body);
    assert.equal((await chargeRow(seeded.chargeId)).status, 'failed');
    assert.deepEqual(await rowStatuses(seeded), ['cancelled', 'cancelled']);

    const [claim] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, seeded.claimKey));
    assert.equal(claim?.responseStatus, 402);
    const [notice] = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, `charge-failed:${seeded.chargeId}`));
    assert.equal(notice?.type, 'payment-failed');
    assert.equal(notice?.trigger, 'charge-failed');
  },
);

test(
  'a webhook naming an order whose charge has no intent id yet throws WebhookRetryError and is redelivered',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: null,
      attemptingUntil: LEASE_END,
      attemptCount: 0,
    });
    const hook = await postWebhook(
      app,
      stripe,
      event('payment_intent.succeeded', `pi_test_${randomUUID().slice(0, 8)}`, {
        order_id: seeded.orderId,
        charge_id: seeded.chargeId,
      }),
    );
    assert.equal(hook.statusCode, 500, hook.body);
    assert.equal((await chargeRow(seeded.chargeId)).status, 'requires_payment');
  },
);

test(
  'an engine charge whose order has no invoice reaching succeeded fails loud with one named alarm',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const capture = makeLogCapture();
    const { app, stripe } = buildApp(capture);
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1)],
      now: T0,
    });
    assert.ok(seeded.intentId);
    stripe.setIntentState(seeded.intentId, 'succeeded');

    const hook = await postWebhook(app, stripe, event('payment_intent.succeeded', seeded.intentId));
    assert.equal(hook.statusCode, 500, hook.body);
    const alarms = capture.lines.filter(
      (l) => l.level === 50 && l.orderId === seeded.orderId && l.chargeId === seeded.chargeId,
    );
    assert.equal(alarms.length, 1, 'one named alarm');
    assert.equal((await chargeRow(seeded.chargeId)).status, 'requires_payment', 'nothing moved');
    assert.deepEqual(await rowStatuses(seeded), ['payment-pending']);
  },
);
