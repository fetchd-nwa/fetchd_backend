import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, eq, like, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import {
  charges,
  idempotencyKeys,
  invoices,
  orders,
  refunds,
  scheduledNotifications,
  stripeEvents,
} from '../../src/db/schema/schema.js';
import type { ApiErrorEnvelope } from '../../src/contracts/wire.js';
import type { Principal } from '../../src/auth/principal.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import type { StripeWebhookEvent } from '../../src/lib/stripe.js';
import { runDuplicateRefundRetryOnce } from '../../src/workers/duplicateRefundRetry.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import {
  QUIET_LOG,
  clearOrderRows,
  seedInvoiceOrder,
  seedOpenInvoice,
  type SeededOrder,
} from './_orderFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * `designs/p15-engine-recovery.md`, by decision. Every test name is the note's own
 * red-first sentence, so the note can be read down this file.
 *
 * The clock is injected where a test says "past the lease" and absent where the test
 * is about the clock itself. Nothing here says anything about real Stripe: the
 * stub's object lock is `evidence/reviews/opus-r1/lib/fake-stripe.mjs:9-10`'s reading.
 */

after(async () => {
  await clearOrderRows();
});
registerFixtureHooks();
afterEach(async () => {
  await db.delete(stripeEvents).where(like(stripeEvents.eventId, 'evt_test_%'));
  await clearOrderRows();
});

const T0 = new Date('2026-05-19T17:50:00Z');
const seconds = (n: number): Date => new Date(T0.getTime() + n * 1000);
const LEASE_END = seconds(150);
const PAST_LEASE = seconds(151);

function appFor(principal: Principal, stripe: StripeStub, clock: { now: Date }) {
  const { app, authenticate } = makeContractApp(principal);
  registerInvoicesRoute(app, { authenticate, stripe, now: () => clock.now });
  registerStaffOrdersRoute(app, { authenticate, stripe, now: () => clock.now });
  registerStripeWebhookRoute(app, { stripe });
  return app;
}

function build(clock: { now: Date } = { now: T0 }) {
  const stripe = makeStripeStub();
  return {
    stripe,
    clock,
    owner: appFor(FIXTURE_OWNER_PRINCIPAL, stripe, clock),
    staff: appFor(FIXTURE_STAFF_PRINCIPAL, stripe, clock),
  };
}

type App = ReturnType<typeof appFor>;

function pay(app: App, invoiceId: string, key = `recovery-${randomUUID()}`) {
  return app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay`,
    headers: { 'idempotency-key': key },
    payload: {},
  });
}

function cancelOrder(app: App, orderId: string, key = `recovery-cancel-${randomUUID()}`) {
  return app.inject({
    method: 'POST',
    url: `/staff/orders/${orderId}/cancel`,
    headers: { 'idempotency-key': key },
  });
}

function deliver(app: App, stripe: StripeStub, event: StripeWebhookEvent) {
  stripe.setNextEvent(event);
  return app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    payload: '{}',
  });
}

function intentEvent(
  type: 'payment_intent.succeeded' | 'payment_intent.canceled' | 'payment_intent.payment_failed',
  paymentIntentId: string,
  id = `evt_test_${randomUUID().slice(0, 8)}`,
): StripeWebhookEvent {
  return { id, type, paymentIntentId, amountCents: 8_500, metadata: {} };
}

async function chargeRow(id: string) {
  const [row] = await db.select().from(charges).where(eq(charges.id, id));
  assert.ok(row, `charge ${id} exists`);
  return row;
}

async function chargeOnInvoice(invoiceId: string) {
  const [row] = await db
    .select({ charge: charges })
    .from(charges)
    .innerJoin(orders, eq(charges.orderId, orders.id))
    .where(eq(orders.invoiceId, invoiceId));
  assert.ok(row, 'an order holds a charge on this invoice');
  return row.charge;
}

async function refundRowsOf(chargeId: string) {
  return db.select().from(refunds).where(eq(refunds.chargeId, chargeId));
}

async function invoiceStatus(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, id));
  return row?.status;
}

function countCalls(stripe: StripeStub, method: string): number {
  return stripe.calls.filter((c) => c.method === method).length;
}

/** What a cancel while Stripe says `processing` leaves: a `failed` charge, watched. */
async function cancelledWhileProcessing(): Promise<
  ReturnType<typeof build> & { seeded: SeededOrder; intentId: string; invoiceId: string }
> {
  const world = build();
  const invoiceId = await seedOpenInvoice();
  const seeded = await seedInvoiceOrder(world.stripe, {
    invoiceId,
    now: T0,
    intentStatus: 'processing',
    attemptingUntil: LEASE_END,
  });
  assert.ok(seeded.intentId);
  const res = await cancelOrder(world.staff, seeded.orderId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await chargeRow(seeded.chargeId)).status, 'failed');
  return { ...world, seeded, intentId: seeded.intentId, invoiceId };
}

/** A worker logger that keeps what it was told, by level. */
function recordingLog() {
  const lines: { level: 'info' | 'warn' | 'error'; obj: Record<string, unknown>; msg: string }[] =
    [];
  const at =
    (level: 'info' | 'warn' | 'error') =>
    (obj: Record<string, unknown>, msg?: string): void => {
      lines.push({ level, obj, msg: msg ?? '' });
    };
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

/** Wait until a statement of this process is blocked on a row lock. */
async function untilSomethingBlocks(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const rows = await db.execute(
      sql`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%charges%'`,
    );
    if (rows.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('nothing blocked on the charge row');
}

// ── Decision 1. H1: the late success gets a second path ─────────────────────

test(
  'A process killed after stripe_events records a late success ends with one full refund on the sweeper next tick, with no redelivery at all',
  SKIP_WHEN_NO_DB,
  async () => {
    const { stripe, seeded, intentId } = await cancelledWhileProcessing();
    stripe.setIntentState(intentId, 'succeeded');
    // The event is on the books and nothing ran: the API died, and Stripe never retries.
    await db.insert(stripeEvents).values({
      eventId: `evt_test_${randomUUID().slice(0, 8)}`,
      eventType: 'payment_intent.succeeded',
    });

    const tick = await runOrderSweeperOnce({ stripe, now: seconds(60), log: QUIET_LOG });

    const rows = await refundRowsOf(seeded.chargeId);
    assert.equal(rows.length, 1, 'one refunds row');
    assert.equal(rows[0]?.amountCents, 8_500, 'of the full amount');
    assert.equal(stripe.executedRefunds().length, 1, 'and it went to Stripe');
    assert.equal(tick.lateRefunded, 1);
    assert.equal((await chargeRow(seeded.chargeId)).nextSweepAt, null, 'the watch closed');
  },
);

test(
  'A redelivery of an engine event whose processed_at is NULL re-runs the arm, refunds once and sets processed_at',
  SKIP_WHEN_NO_DB,
  async () => {
    const { staff, stripe, seeded, intentId } = await cancelledWhileProcessing();
    stripe.setIntentState(intentId, 'succeeded');
    const event = intentEvent('payment_intent.succeeded', intentId);
    await db
      .insert(stripeEvents)
      .values({ eventId: event.id, eventType: 'payment_intent.succeeded' });

    const res = await deliver(staff, stripe, event);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { outcome: string }).outcome, 'order-late-refund');
    assert.equal((await refundRowsOf(seeded.chargeId)).length, 1);
    assert.equal(stripe.executedRefunds().length, 1, 'the post-commit fire ran');
    const [row] = await db.select().from(stripeEvents).where(eq(stripeEvents.eventId, event.id));
    assert.ok(row?.processedAt, 'processed_at is set');

    const again = await deliver(staff, stripe, event);
    assert.equal((again.json() as { outcome: string }).outcome, 'duplicate');
    assert.equal((await refundRowsOf(seeded.chargeId)).length, 1);
  },
);

test(
  'A re-dispatch that throws answers 500, leaves the row unfinished, and the next redelivery runs the arm',
  SKIP_WHEN_NO_DB,
  async () => {
    const { staff, stripe, seeded, intentId } = await cancelledWhileProcessing();
    stripe.setIntentState(intentId, 'succeeded');
    const event = intentEvent('payment_intent.succeeded', intentId);
    await db
      .insert(stripeEvents)
      .values({ eventId: event.id, eventType: 'payment_intent.succeeded' });

    stripe.nextRetrieveThrowsTransport();
    const first = await deliver(staff, stripe, event);
    assert.equal(first.statusCode, 500, first.body);
    const rows = await db.select().from(stripeEvents).where(eq(stripeEvents.eventId, event.id));
    assert.equal(rows.length, 1, 'the row stands: its first delivery may have committed');
    assert.equal(rows[0]?.processedAt, null);
    assert.equal((await refundRowsOf(seeded.chargeId)).length, 0);

    const second = await deliver(staff, stripe, event);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((await refundRowsOf(seeded.chargeId)).length, 1);
  },
);

test(
  'A webhook and a tick on one failed charge, two connections, mint one refund',
  SKIP_WHEN_NO_DB,
  async () => {
    const { staff, stripe, seeded, intentId } = await cancelledWhileProcessing();
    assert.ok((await chargeRow(seeded.chargeId)).nextSweepAt, 'the cancel opened the watch');
    stripe.setIntentState(intentId, 'succeeded');

    const [hook] = await Promise.all([
      deliver(staff, stripe, intentEvent('payment_intent.succeeded', intentId)),
      runOrderSweeperOnce({ stripe, now: seconds(60), log: QUIET_LOG }),
    ]);
    assert.equal(hook.statusCode, 200, hook.body);
    const rows = await refundRowsOf(seeded.chargeId);
    assert.equal(rows.length, 1, 'one mint');
    assert.equal(stripe.executedRefunds().length, 1, 'one refund at Stripe');
    assert.equal((await chargeRow(seeded.chargeId)).nextSweepAt, null);
  },
);

test(
  'A failed charge whose intent stays processing for three looks stays watched, and canceled ends the watch',
  SKIP_WHEN_NO_DB,
  async () => {
    const { stripe, seeded, intentId } = await cancelledWhileProcessing();
    assert.ok((await chargeRow(seeded.chargeId)).nextSweepAt, 'the cancel opened the watch');

    const before = countCalls(stripe, 'retrievePaymentIntent');
    for (const look of [1, 2, 3]) {
      await runOrderSweeperOnce({ stripe, now: seconds(look * 130), log: QUIET_LOG });
      assert.equal(countCalls(stripe, 'retrievePaymentIntent'), before + look, `look ${look}`);
      assert.ok((await chargeRow(seeded.chargeId)).nextSweepAt, `still watched at look ${look}`);
    }

    stripe.setIntentState(intentId, 'canceled');
    await runOrderSweeperOnce({ stripe, now: seconds(4 * 130), log: QUIET_LOG });
    assert.equal((await chargeRow(seeded.chargeId)).nextSweepAt, null, 'canceled ends it');
    const after = countCalls(stripe, 'retrievePaymentIntent');
    await runOrderSweeperOnce({ stripe, now: seconds(5 * 130), log: QUIET_LOG });
    assert.equal(countCalls(stripe, 'retrievePaymentIntent'), after, 'nothing looks again');
  },
);

test(
  'A declined charge intent is cancelled by the next tick, and a success that beat the cancel is refunded in full',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const invoiceId = await seedOpenInvoice();
    world.stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'card_declined' },
    ]);
    const declined = await pay(world.owner, invoiceId);
    assert.equal(declined.statusCode, 402, declined.body);
    const charge = await chargeOnInvoice(invoiceId);
    assert.equal(charge.status, 'failed');
    assert.ok(charge.stripePaymentIntentId);

    await runOrderSweeperOnce({ stripe: world.stripe, now: seconds(60), log: QUIET_LOG });
    const live = await world.stripe.retrievePaymentIntent(charge.stripePaymentIntentId);
    assert.equal(live.status, 'canceled', 'the sweeper cancelled the dead intent');
    assert.equal((await chargeRow(charge.id)).nextSweepAt, null);

    // The same, with a success that beat the cancel.
    const world2 = build();
    const second = await seedOpenInvoice();
    world2.stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'card_declined' },
    ]);
    assert.equal((await pay(world2.owner, second)).statusCode, 402);
    const beaten = await chargeOnInvoice(second);
    world2.stripe.captureBeforeCancel();

    await runOrderSweeperOnce({ stripe: world2.stripe, now: seconds(60), log: QUIET_LOG });
    const rows = await refundRowsOf(beaten.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.amountCents, 8_500, 'in full');
    assert.equal(await invoiceStatus(second), 'open', 'nothing granted');
  },
);

async function watchedFailedCharge(stripe: StripeStub, intentId: string | null) {
  const invoiceId = await seedOpenInvoice();
  const seeded = await seedInvoiceOrder(stripe, {
    invoiceId,
    now: T0,
    intentStatus: 'requires_confirmation',
    attemptingUntil: LEASE_END,
  });
  await db
    .update(charges)
    .set({ status: 'failed', stripePaymentIntentId: intentId, nextSweepAt: T0.toISOString() })
    .where(eq(charges.id, seeded.chargeId));
  return seeded;
}

test(
  'A watched retrieve answering resource_missing raises one alarm and closes the watch',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    const seeded = await watchedFailedCharge(stripe, 'pi_test_gone_from_stripe');
    const log = recordingLog();

    await runOrderSweeperOnce({ stripe, now: seconds(60), log });

    const alarms = log.lines.filter(
      (l) => l.level === 'error' && l.obj.chargeId === seeded.chargeId,
    );
    assert.equal(alarms.length, 1, 'one alarm naming the charge');
    assert.equal((await chargeRow(seeded.chargeId)).nextSweepAt, null, 'the watch closed');
  },
);

test(
  'A watched row with no intent id raises one alarm, closes, and is never retrieved',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    const seeded = await watchedFailedCharge(stripe, null);
    const log = recordingLog();

    await runOrderSweeperOnce({ stripe, now: seconds(60), log });

    assert.equal(countCalls(stripe, 'retrievePaymentIntent'), 0, 'never retrieved');
    const alarms = log.lines.filter(
      (l) => l.level === 'error' && l.obj.chargeId === seeded.chargeId,
    );
    assert.equal(alarms.length, 1);
    assert.equal((await chargeRow(seeded.chargeId)).nextSweepAt, null);
  },
);

test(
  'A charge watched past seven days raises one alarm per process and keeps looking',
  SKIP_WHEN_NO_DB,
  async () => {
    const { stripe, seeded } = await cancelledWhileProcessing();
    await db
      .update(charges)
      .set({ createdAt: new Date(T0.getTime() - 8 * 86_400_000).toISOString() })
      .where(eq(charges.id, seeded.chargeId));
    const before = countCalls(stripe, 'retrievePaymentIntent');

    const log = recordingLog();
    await runOrderSweeperOnce({ stripe, now: seconds(300), log });
    await runOrderSweeperOnce({ stripe, now: seconds(600), log });
    await runOrderSweeperOnce({ stripe, now: seconds(900), log });

    const alarms = log.lines.filter(
      (l) => l.level === 'error' && l.obj.chargeId === seeded.chargeId,
    );
    assert.equal(alarms.length, 1, 'one alarm for this charge in this process');
    assert.equal(
      countCalls(stripe, 'retrievePaymentIntent') - before,
      3,
      'it kept looking on every tick',
    );
    assert.notEqual((await chargeRow(seeded.chargeId)).nextSweepAt, null, 'the watch stays open');
  },
);

test(
  'A charge.refund.updated killed mid-handler flips the charge to refunded on redelivery',
  SKIP_WHEN_NO_DB,
  async () => {
    const { staff, stripe, seeded, intentId } = await cancelledWhileProcessing();
    stripe.setIntentState(intentId, 'succeeded');
    const hook = await deliver(staff, stripe, intentEvent('payment_intent.succeeded', intentId));
    assert.equal(hook.statusCode, 200, hook.body);
    const [executed] = stripe.executedRefunds();
    assert.ok(executed);

    const event: StripeWebhookEvent = {
      id: `evt_test_${randomUUID().slice(0, 8)}`,
      type: 'charge.refund.updated',
      refundId: executed.id,
      paymentIntentId: intentId,
      amountCents: 8_500,
      status: 'succeeded',
    };
    await db.insert(stripeEvents).values({ eventId: event.id, eventType: event.type });

    const res = await deliver(staff, stripe, event);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await chargeRow(seeded.chargeId)).status, 'refunded');
    const [row] = await db.select().from(stripeEvents).where(eq(stripeEvents.eventId, event.id));
    assert.ok(row?.processedAt);
  },
);

test(
  'A late refund Stripe then fails is reported stripe-failed and the watch mints no second one',
  SKIP_WHEN_NO_DB,
  async () => {
    const { staff, stripe, seeded, intentId } = await cancelledWhileProcessing();
    assert.ok((await chargeRow(seeded.chargeId)).nextSweepAt, 'the cancel opened the watch');
    stripe.setIntentState(intentId, 'succeeded');
    await deliver(staff, stripe, intentEvent('payment_intent.succeeded', intentId));
    const [executed] = stripe.executedRefunds();
    assert.ok(executed);

    const res = await deliver(staff, stripe, {
      id: `evt_test_${randomUUID().slice(0, 8)}`,
      type: 'charge.refund.updated',
      refundId: executed.id,
      paymentIntentId: intentId,
      amountCents: 8_500,
      status: 'failed',
    });
    assert.equal(res.statusCode, 200, res.body);

    await runOrderSweeperOnce({ stripe, now: seconds(600), log: QUIET_LOG });
    const rows = await refundRowsOf(seeded.chargeId);
    assert.equal(rows.length, 1, 'the watch is closed, so no second mint');
    assert.equal(rows[0]?.status, 'failed');
    const report = await runDuplicateRefundRetryOnce({ stripe, log: QUIET_LOG });
    assert.ok(report.abandonedByClass['stripe-failed'] >= 1, 'a person is told');
  },
);

test(
  'Pin: a redelivered unfinished older payment_intent.succeeded answers 200 duplicate and writes nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const { owner, stripe } = build();
    const paymentIntentId = `pi_test_older_${randomUUID().slice(0, 8)}`;
    const chargeId = randomUUID();
    await db.insert(charges).values({
      id: chargeId,
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 5_000,
      status: 'requires_payment',
      purpose: 'board-train',
      stripePaymentIntentId: paymentIntentId,
    });
    const event = intentEvent('payment_intent.succeeded', paymentIntentId);
    await db
      .insert(stripeEvents)
      .values({ eventId: event.id, eventType: 'payment_intent.succeeded' });

    const res = await deliver(owner, stripe, event);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { outcome: string }).outcome, 'duplicate');
    assert.equal((await chargeRow(chargeId)).status, 'requires_payment', 'nothing written');
    assert.equal(countCalls(stripe, 'retrievePaymentIntent'), 0);
  },
);

// ── Decision 2. M2: the claim stops being a lease ───────────────────────────

test(
  'A request that lost its lease to the sweeper claim cannot renew, and no second confirm reaches Stripe',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const { stripe, clock } = world;
    const invoiceId = await seedOpenInvoice();
    stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
    ]);
    const confirm = stripe.holdNext('confirm');
    const pending = pay(world.owner, invoiceId);
    await confirm.reached;

    // The sweeper has claimed the charge and is waiting on its retrieve.
    clock.now = PAST_LEASE;
    const retrieve = stripe.holdNext('retrieve');
    const tick = runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });
    await retrieve.reached;

    // The request wakes, and its answer would spend another try.
    confirm.release();
    await pending;
    assert.equal(
      stripe.calls.filter((c) => c.method === 'confirmPaymentIntent').length,
      1,
      'no second confirm',
    );

    retrieve.release();
    await tick;
  },
);

test(
  'A renewal blocked on the row while the sweeper claim commits finds no row',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const { stripe } = world;
    const invoiceId = await seedOpenInvoice();
    stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
    ]);
    const confirm = stripe.holdNext('confirm');
    const pending = pay(world.owner, invoiceId);
    await confirm.reached;
    const charge = await chargeOnInvoice(invoiceId);

    await db.transaction(async (tx) => {
      // The sweeper's claim, uncommitted, with the lease still live on this clock.
      await tx.execute(
        sql`UPDATE charges SET next_sweep_at = ${seconds(120).toISOString()}::timestamptz WHERE id = ${charge.id}`,
      );
      confirm.release();
      await untilSomethingBlocks();
    });

    await pending;
    assert.equal(
      stripe.calls.filter((c) => c.method === 'confirmPaymentIntent').length,
      1,
      'the re-check after the wait found no row',
    );
  },
);

test(
  'A claimed charge with no intent id refuses a late storeIntentId',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const { stripe } = world;
    const invoiceId = await seedOpenInvoice();
    const create = stripe.holdNext('create');
    const pending = pay(world.owner, invoiceId);
    await create.reached;
    const charge = await chargeOnInvoice(invoiceId);

    // The claim alone, with the lease still live: this is the fence, not the clock.
    await db
      .update(charges)
      .set({ nextSweepAt: seconds(120).toISOString() })
      .where(eq(charges.id, charge.id));
    create.release();

    const res = await pending;
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((await chargeRow(charge.id)).stripePaymentIntentId, null, 'the id was refused');
    assert.equal(stripe.executedConfirms().length, 0, 'and no card was tried');
  },
);

test(
  'Case (a) reads the intent id off its claim: an id stored after the worklist read is not abandoned',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    const invoiceId = await seedOpenInvoice();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: null,
      attemptingUntil: LEASE_END,
      attemptCount: 0,
    });
    const landed = await stripe.createUnconfirmedPaymentIntent(
      {
        customerId: FIXTURE_IDS.stripeCustomerId,
        paymentMethodId: 'pm_fixture_test_visa',
        amountCents: 8_500,
        currency: 'usd',
        metadata: { order_id: seeded.orderId, charge_id: seeded.chargeId },
      },
      `order:${seeded.orderId}`,
      { timeoutMs: 30_000 },
    );

    // The request's id lands in the instant between the worklist read and the claim.
    const claim = chargesRepository.claimPastLease;
    chargesRepository.claimPastLease = (async (...args: Parameters<typeof claim>) => {
      await db
        .update(charges)
        .set({ stripePaymentIntentId: landed.id })
        .where(eq(charges.id, seeded.chargeId));
      return claim.apply(chargesRepository, args);
    }) as typeof claim;
    const tick = await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG }).finally(
      () => {
        chargesRepository.claimPastLease = claim;
      },
    );

    // Case (a) is the arm that asks Stripe nothing. The tick's count is what tells the
    // arms apart: a stale read abandons, opens the watch, and the same tick's second loop
    // then cancels the intent, so the row alone ends up looking right. With no confirm
    // sent, the stored 402 still says `attempts: 0`, which is true of either arm.
    assert.equal(countCalls(stripe, 'retrievePaymentIntent') >= 1, true, 'it asked Stripe');
    assert.equal(tick.abandoned, 0, 'an id is stored, so this is not case (a)');
    assert.equal(tick.failed, 1);
    const live = await stripe.retrievePaymentIntent(landed.id);
    assert.equal(live.status, 'canceled', 'the intent the row names is stopped, not left');
  },
);

test(
  'Cancel order that read no-intent before the id landed refuses, writes nothing, and a retry cancels the intent',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const { stripe } = world;
    const invoiceId = await seedOpenInvoice();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: null,
      attemptingUntil: LEASE_END,
      attemptCount: 0,
    });
    const landed = await stripe.createUnconfirmedPaymentIntent(
      {
        customerId: FIXTURE_IDS.stripeCustomerId,
        paymentMethodId: 'pm_fixture_test_visa',
        amountCents: 8_500,
        currency: 'usd',
        metadata: { order_id: seeded.orderId, charge_id: seeded.chargeId },
      },
      `order:${seeded.orderId}`,
      { timeoutMs: 30_000 },
    );

    // The route's pool read sees no id; the request's write lands right behind it.
    const read = chargesRepository.findEngineByOrderId;
    let reads = 0;
    chargesRepository.findEngineByOrderId = (async (...args: Parameters<typeof read>) => {
      const row = await read.apply(chargesRepository, args);
      reads += 1;
      if (reads === 1) {
        await db
          .update(charges)
          .set({ stripePaymentIntentId: landed.id })
          .where(eq(charges.id, seeded.chargeId));
      }
      return row;
    }) as typeof read;
    let res;
    try {
      res = await cancelOrder(world.staff, seeded.orderId);
    } finally {
      chargesRepository.findEngineByOrderId = read;
    }

    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as ApiErrorEnvelope).error.code, 'conflict');
    assert.equal((await chargeRow(seeded.chargeId)).status, 'requires_payment', 'nothing written');

    const retry = await cancelOrder(world.staff, seeded.orderId);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((await stripe.retrievePaymentIntent(landed.id)).status, 'canceled');
    const after = await chargeRow(seeded.chargeId);
    assert.equal(after.status, 'failed');
    assert.equal(after.nextSweepAt, null, 'Stripe said canceled: nothing is left to watch');
  },
);

// ── Decision 3. M1: "failed" waits until nothing can still be running ───────

test(
  'A last confirm that goes unanswered and reads back requires_confirmation answers 409, writes no failed, and the settle takes $85.00 once',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const { stripe } = world;
    const invoiceId = await seedOpenInvoice();
    stripe.queueIntentOutcomes([
      { kind: 'transport' },
      { kind: 'transport' },
      { kind: 'transport' },
    ]);

    const key = `recovery-last-${randomUUID()}`;
    const res = await pay(world.owner, invoiceId, key);

    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as ApiErrorEnvelope).error.code, 'idempotency_inflight');
    const charge = await chargeOnInvoice(invoiceId);
    assert.equal(charge.status, 'requires_payment', 'no failed is written');
    assert.ok(charge.stripePaymentIntentId);

    // Stripe finishes confirm 3 after all.
    stripe.setIntentState(charge.stripePaymentIntentId, 'succeeded');
    const hook = await deliver(
      world.owner,
      stripe,
      intentEvent('payment_intent.succeeded', charge.stripePaymentIntentId),
    );
    assert.equal(hook.statusCode, 200, hook.body);

    const resend = await pay(world.owner, invoiceId, key);
    assert.equal(resend.statusCode, 201, resend.body);
    assert.equal((resend.json() as { invoice_status: string }).invoice_status, 'paid');
    assert.equal((await refundRowsOf(charge.id)).length, 0, 'taken once, kept once');
  },
);

test('The same with processing_error on the read-back stops too', SKIP_WHEN_NO_DB, async () => {
  const world = build();
  const { stripe } = world;
  const invoiceId = await seedOpenInvoice();
  stripe.queueIntentOutcomes([
    { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
    { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
    { kind: 'transport' },
  ]);

  const res = await pay(world.owner, invoiceId);

  assert.equal(res.statusCode, 409, res.body);
  assert.equal((await chargeOnInvoice(invoiceId)).status, 'requires_payment');
});

test(
  'The sweeper cancels before it says failed: a cancel that loses to succeeded settles, and no failed-payment notice exists',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    const invoiceId = await seedOpenInvoice();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'requires_confirmation',
      attemptingUntil: LEASE_END,
    });
    stripe.captureBeforeCancel();

    await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });

    assert.equal(await invoiceStatus(invoiceId), 'paid', 'it settled');
    assert.equal((await chargeRow(seeded.chargeId)).status, 'succeeded');
    const failed = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.type, 'payment-failed'));
    assert.equal(failed.length, 0, 'nothing said it failed');
  },
);

test(
  'A cancel refused with 429 lock_timeout while a confirm holds the intent writes nothing, logs at warn, and the next look settles what the confirm did',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const { stripe, clock } = world;
    const invoiceId = await seedOpenInvoice();
    const confirm = stripe.holdNext('confirm');
    const pending = pay(world.owner, invoiceId);
    await confirm.reached;
    const charge = await chargeOnInvoice(invoiceId);
    assert.ok(charge.stripePaymentIntentId);

    clock.now = PAST_LEASE;
    const log = recordingLog();
    await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log });

    assert.equal((await chargeRow(charge.id)).status, 'requires_payment', 'nothing written');
    assert.equal(
      log.lines.filter((l) => l.level === 'warn' && l.obj.code === 'lock_timeout').length,
      1,
      'one warn, with the code',
    );
    assert.equal(log.lines.filter((l) => l.level === 'error').length, 0, 'no page');

    // The confirm finishes at Stripe, and the next look reads what it did.
    stripe.setIntentState(charge.stripePaymentIntentId, 'succeeded');
    await runOrderSweeperOnce({ stripe, now: seconds(151 + 121), log: QUIET_LOG });
    assert.equal(await invoiceStatus(invoiceId), 'paid');
    assert.equal(stripe.executedRefunds().length, 0);

    confirm.release();
    await pending;
  },
);

test(
  'A confirm sent after the sweeper cancel is refused, the charge stays failed, and no money moved',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const { stripe, clock } = world;
    const invoiceId = await seedOpenInvoice();

    // A process frozen after its renewal and before the send: nothing is at Stripe,
    // so no object lock stands between the sweeper's cancel and this confirm.
    let thaw: () => void = () => undefined;
    const frozen = new Promise<void>((resolve) => {
      thaw = resolve;
    });
    let reached: () => void = () => undefined;
    const atTheEdge = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const send = stripe.confirmPaymentIntent.bind(stripe);
    stripe.confirmPaymentIntent = async (...args) => {
      reached();
      await frozen;
      return send(...args);
    };

    const pending = pay(world.owner, invoiceId);
    await atTheEdge;
    const charge = await chargeOnInvoice(invoiceId);

    clock.now = PAST_LEASE;
    const tick = await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });
    const swept = await chargeRow(charge.id);
    assert.equal(swept.status, 'failed');
    // `scanned` is the instrument: a watch opened here would be closed by this same tick's
    // second loop, so the column alone cannot see it.
    assert.equal(tick.scanned, 1, 'its own cancel landed: nothing is left to watch');
    assert.equal(swept.nextSweepAt, null);

    thaw();
    await pending;
    assert.equal(stripe.executedConfirms().length, 0, 'Stripe refused it');
    assert.equal((await chargeRow(charge.id)).status, 'failed');
    assert.equal((await refundRowsOf(charge.id)).length, 0, 'no money moved, so none returns');
  },
);

test(
  'The payment_intent.canceled webhook beating the sweeper fail on an unconfirmed intent stores no blocker',
  SKIP_WHEN_NO_DB,
  async () => {
    const { owner, stripe } = build();
    const invoiceId = await seedOpenInvoice();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'canceled',
      attemptingUntil: LEASE_END,
    });
    assert.ok(seeded.intentId);

    const res = await deliver(
      owner,
      stripe,
      intentEvent('payment_intent.canceled', seeded.intentId),
    );
    assert.equal(res.statusCode, 200, res.body);
    const row = await chargeRow(seeded.chargeId);
    assert.equal(row.status, 'failed');
    assert.equal(row.blocker, null, 'no card answered, so no reason is invented');
    assert.equal(row.nextSweepAt, null, 'Stripe said canceled: nothing is left to watch');
    const [claim] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, seeded.claimKey));
    const stored = claim?.responseBody as ApiErrorEnvelope;
    assert.equal(
      (stored.error.details as { charge_blocker?: string }).charge_blocker,
      undefined,
      'and the stored 402 says none',
    );
  },
);

test(
  'Pin: a last confirm that answered requires_confirmation still commits the 402',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const { stripe } = world;
    const invoiceId = await seedOpenInvoice();
    stripe.queueIntentOutcomes([{ kind: 'status', status: 'requires_confirmation' }]);

    const res = await pay(world.owner, invoiceId);

    assert.equal(res.statusCode, 402, res.body);
    assert.equal((await chargeOnInvoice(invoiceId)).status, 'failed');
  },
);

// ── Decision 4. Fable L5: leases on Postgres's clock ────────────────────────

test(
  'A tick on a process clock an hour ahead of Postgres (mocked Date, no clock injected) claims nothing while the lease is live',
  SKIP_WHEN_NO_DB,
  async (t) => {
    const stripe = makeStripeStub();
    const invoiceId = await seedOpenInvoice();
    const realNow = Date.now();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: new Date(realNow),
      intentStatus: 'requires_confirmation',
      attemptingUntil: new Date(realNow + 150_000),
    });

    t.mock.timers.enable({ apis: ['Date'], now: realNow + 3_600_000 });
    const tick = await runSchedulerTickOnce({ expoPush: makeExpoPushStub(), stripe });
    t.mock.timers.reset();

    assert.equal(tick.orderSweeper.scanned, 0, 'the lease is live on the only clock that counts');
    assert.equal((await chargeRow(seeded.chargeId)).status, 'requires_payment');
    assert.equal(countCalls(stripe, 'retrievePaymentIntent'), 0);
  },
);

test(
  'A renewal on a process clock an hour behind Postgres is refused past the lease',
  SKIP_WHEN_NO_DB,
  async (t) => {
    const stripe = makeStripeStub();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerInvoicesRoute(app, { authenticate, stripe });
    const invoiceId = await seedOpenInvoice();
    stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
    ]);
    const confirm = stripe.holdNext('confirm');
    const pending = pay(app, invoiceId);
    await confirm.reached;
    const charge = await chargeOnInvoice(invoiceId);

    await db.execute(
      sql`UPDATE charges SET attempting_until = now() - interval '1 second' WHERE id = ${charge.id}`,
    );
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() - 3_600_000 });
    confirm.release();
    await pending;
    t.mock.timers.reset();

    assert.equal(
      stripe.calls.filter((c) => c.method === 'confirmPaymentIntent').length,
      1,
      'the transient error spent no second try',
    );
  },
);

// ── Decision 6. Opus L6: an abandoned order tells her ───────────────────────

test(
  'An order abandoned at lease end queues one Payment failed notice, and a second tick queues no other',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    const invoiceId = await seedOpenInvoice();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: null,
      attemptingUntil: LEASE_END,
      attemptCount: 0,
    });

    await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });
    await runOrderSweeperOnce({ stripe, now: seconds(400), log: QUIET_LOG });

    const rows = await db
      .select()
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
          eq(scheduledNotifications.type, 'payment-failed'),
        ),
      );
    assert.equal(rows.length, 1, 'one notice');
    assert.equal(rows[0]?.title, 'Payment failed');
    assert.equal(rows[0]?.trigger, 'charge-failed');
    assert.equal(rows[0]?.dedupeKey, `charge-failed:${seeded.chargeId}`);
    assert.equal(rows[0]?.body, "Your $85.00 payment didn't go through, so you weren't charged.");
  },
);
