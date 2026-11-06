import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  charges,
  idempotencyKeys,
  invoices,
  orders,
  owners,
  paymentMethods,
  refunds,
} from '../../src/db/schema/schema.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { engineRequestOptions, type StripeWebhookEvent } from '../../src/lib/stripe.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import {
  QUIET_LOG,
  clearOrderRows,
  receiptsFor,
  seedInvoiceOrder,
  seedOpenInvoice,
  seedPendingBookingOrder,
} from './_orderFixture.js';
import { createFundedDog, removeDogs } from './_dayFixture.js';
import { futureWeekday } from './_fixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * `POST /invoices/:id/pay` on the order engine (P15, design §2.7:3824-3898). Every
 * Stripe verb here is the stub's, which models Stripe's idempotency and its refusals,
 * and nothing here says anything about real Stripe.
 *
 * The clock is the route's `now`, so "past the lease" is a value, not a wait.
 */

const createdDogs: string[] = [];
after(async () => {
  await clearOrderRows();
  await removeDogs(createdDogs);
});
registerFixtureHooks();
afterEach(clearOrderRows);

const T0 = new Date('2026-05-19T17:50:00Z');
const seconds = (n: number): Date => new Date(T0.getTime() + n * 1000);

function buildApp(clock: { now: Date } = { now: T0 }): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerInvoicesRoute(app, { authenticate, stripe, now: () => clock.now });
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

type App = ReturnType<typeof buildApp>['app'];

function pay(app: App, invoiceId: string, key: string, body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay`,
    headers: { 'idempotency-key': key },
    payload: body,
  });
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: {
      kind: string;
      charge_blocker?: string;
      order_id?: string;
      attempts?: number;
      outcome?: string;
    };
  };
}

async function chargesOnInvoice(invoiceId: string) {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.invoiceId, invoiceId));
  if (rows.length === 0) return [];
  return db
    .select()
    .from(charges)
    .where(
      inArray(
        charges.orderId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(charges.createdAt));
}

async function invoiceRow(id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  assert.ok(row);
  return row;
}

function creates(stripe: ReturnType<typeof makeStripeStub>) {
  return stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent');
}

function confirms(stripe: ReturnType<typeof makeStripeStub>) {
  return stripe.calls.filter((c) => c.method === 'confirmPaymentIntent');
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

test(
  '/pay: a transient error then a decline commits a 402, the invoice stays open, and a replay asks Stripe nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
      { kind: 'cardError', status: 'requires_payment_method', code: 'card_declined' },
    ]);

    const key = `pay-decline-${randomUUID()}`;
    const res = await pay(app, invoiceId, key);

    assert.equal(res.statusCode, 402, res.body);
    const body = res.json() as ErrorBody;
    assert.equal(body.error.code, 'payment_failed');
    assert.equal(body.error.details?.kind, 'payment_failed');
    assert.equal(body.error.details?.charge_blocker, 'declined');
    assert.equal(body.error.details?.attempts, 2, 'the transient try is counted');
    assert.equal(body.error.details?.outcome, 'failed');
    assert.ok(body.error.details?.order_id);

    const invoice = await invoiceRow(invoiceId);
    assert.equal(invoice.status, 'open', 'the invoice stays open');
    const [charge, ...others] = await chargesOnInvoice(invoiceId);
    assert.equal(others.length, 0, 'one charge');
    assert.equal(charge?.status, 'failed', 'with the failed charge recorded');
    assert.equal(charge?.attemptCount, 2);
    assert.equal(charge?.blocker, 'declined');
    assert.equal(charge?.lastStripeError, 'card_declined');
    assert.equal(charge?.orderId, body.error.details?.order_id);

    assert.equal(creates(stripe).length, 1, 'one PaymentIntent');
    const sent = confirms(stripe);
    assert.equal(sent.length, 2, 'two confirms');
    assert.equal(
      sent[0]?.args.paymentIntentId,
      sent[1]?.args.paymentIntentId,
      'of the same intent',
    );
    assert.notEqual(sent[0]?.idempotencyKey, sent[1]?.idempotencyKey, 'one key per attempt');

    // The replay is the same 402, and Stripe is not asked anything.
    const before = stripe.calls.length;
    const replay = await pay(app, invoiceId, key);
    assert.equal(replay.statusCode, 402);
    assert.deepEqual(replay.json(), body);
    assert.equal(stripe.calls.length, before, 'a replay asks Stripe nothing');

    // Card-payable again, on a fresh key: a second order on one invoice.
    const again = await pay(app, invoiceId, `pay-decline-fresh-${randomUUID()}`);
    assert.equal(again.statusCode, 201, again.body);
    assert.equal((await invoiceRow(invoiceId)).status, 'paid');
    assert.equal((await chargesOnInvoice(invoiceId)).length, 2, 'each with its charge kept');
  },
);

test('/pay: any other decline stops at the first attempt', SKIP_WHEN_NO_DB, async () => {
  const invoiceId = await seedOpenInvoice();
  const { app, stripe } = buildApp();
  stripe.queueIntentOutcomes([
    { kind: 'cardError', status: 'requires_payment_method', code: 'card_declined' },
  ]);
  const res = await pay(app, invoiceId, `pay-first-${randomUUID()}`);
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(confirms(stripe).length, 1);
  assert.equal((res.json() as ErrorBody).error.details?.attempts, 1);
});

test(
  '/pay: a card that needs authentication cannot pay off-session: 402 with that blocker, and no second try',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');
    const res = await pay(app, invoiceId, `pay-3ds-${randomUUID()}`);
    assert.equal(res.statusCode, 402, res.body);
    assert.equal(
      (res.json() as ErrorBody).error.details?.charge_blocker,
      'authentication_required',
    );
    assert.equal(confirms(stripe).length, 1);
  },
);

test(
  '/pay: transient errors stop at pay.card_attempts_max_count, on the same intent',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
      { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
      { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
    ]);
    const res = await pay(app, invoiceId, `pay-max-${randomUUID()}`);
    assert.equal(res.statusCode, 402, res.body);
    assert.equal(confirms(stripe).length, 3, 'the seed is 3');
    assert.equal((res.json() as ErrorBody).error.details?.attempts, 3);
  },
);

test(
  '/pay: every call carries the budget, and the SDK retry loop is off',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    const res = await pay(app, invoiceId, `pay-budget-${randomUUID()}`);
    assert.equal(res.statusCode, 201, res.body);
    const [create] = creates(stripe);
    const [confirm] = confirms(stripe);
    assert.deepEqual(create?.budget, { timeoutMs: 30_000 }, '2 min ÷ (3 + 1)');
    assert.deepEqual(confirm?.budget, { timeoutMs: 30_000 });
    assert.deepEqual(engineRequestOptions({ timeoutMs: 30_000 }), {
      timeout: 30_000,
      maxNetworkRetries: 0,
    });
    assert.deepEqual(Object.keys(create?.args.metadata ?? {}).sort(), ['charge_id', 'order_id']);
  },
);

test(
  'a stub that holds the create past its timeout and then succeeds: zero money moved, the order cancelled',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const clock = { now: T0 };
    const { app, stripe } = buildApp(clock);
    const late = stripe.createOutlivesTimeout();

    const key = `pay-slow-create-${randomUUID()}`;
    const res = await pay(app, invoiceId, key);
    // The answer is still open: nothing is known and nothing has been charged.
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as ErrorBody).error.code, 'idempotency_inflight');

    // Stripe finishes the create 35 s in, long after the SDK gave up on it.
    late.land();
    clock.now = seconds(151);
    await runOrderSweeperOnce({ stripe, now: clock.now, log: QUIET_LOG });

    assert.equal(confirms(stripe).length, 0, 'no confirm was sent');
    assert.equal(stripe.executedConfirms().length, 0, 'zero money moved');
    const [charge] = await chargesOnInvoice(invoiceId);
    assert.equal(charge?.status, 'failed', 'the order is cancelled');
    assert.equal(charge?.stripePaymentIntentId, null, 'no intent id was ever stored');
    assert.equal((await invoiceRow(invoiceId)).status, 'open');
  },
);

test(
  'a fake clock: a healthy request still attempting at 2 min 10 s is never touched',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const clock = { now: T0 };
    const { app, stripe } = buildApp(clock);
    const hold = stripe.holdNext('confirm');

    const pending = pay(app, invoiceId, `pay-healthy-${randomUUID()}`);
    await hold.reached;
    const [before] = await chargesOnInvoice(invoiceId);
    assert.ok(before?.attemptingUntil, 'the lease is on the row');

    clock.now = seconds(130);
    const tick = await runOrderSweeperOnce({ stripe, now: clock.now, log: QUIET_LOG });
    assert.equal(tick.scanned, 0, 'the sweeper does not see it');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'retrievePaymentIntent').length,
      0,
      'and asks Stripe nothing about it',
    );
    const [during] = await chargesOnInvoice(invoiceId);
    assert.equal(during?.status, 'requires_payment');
    assert.equal(during?.attemptingUntil, before?.attemptingUntil, 'the lease is untouched');

    hold.release();
    const res = await pending;
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((await invoiceRow(invoiceId)).status, 'paid');
  },
);

test(
  'kill after tx1 with no intent, lease past: seats free, no Stripe call, the re-send gets the 402 abandoned',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const clock = { now: T0 };
    const { app, stripe } = buildApp(clock);
    const hold = stripe.holdNext('create');

    const key = `pay-kill-${randomUUID()}`;
    const killed = pay(app, invoiceId, key);
    await hold.reached;

    // The seats half: `/pay` holds none, so the same state on a seeded booking order.
    const dogId = await createFundedDog(createdDogs, 3);
    const seededStripe = makeStripeStub();
    const seeded = await seedPendingBookingOrder(seededStripe, {
      dogId,
      dates: [futureWeekday(1), futureWeekday(2)],
      now: T0,
      intentStatus: null,
      attemptingUntil: seconds(150),
      attemptCount: 0,
    });

    clock.now = seconds(151);
    const before = stripe.calls.length;
    await runOrderSweeperOnce({ stripe, now: clock.now, log: QUIET_LOG });
    assert.equal(stripe.calls.length, before, 'the sweeper called no Stripe verb');

    const { bookings } = await import('../../src/db/schema/schema.js');
    const rows = await db
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.orderId, seeded.orderId));
    assert.deepEqual(
      rows.map((r) => r.status),
      ['cancelled', 'cancelled'],
      'the seats are free',
    );

    const resend = await pay(app, invoiceId, key);
    assert.equal(resend.statusCode, 402, resend.body);
    const details = (resend.json() as ErrorBody).error.details;
    assert.equal(details?.outcome, 'abandoned');
    assert.equal(details?.attempts, 0);
    assert.equal((await invoiceRow(invoiceId)).status, 'open');

    // The process that was never really dead comes back: its write is refused, and
    // it answers what is true rather than confirming anything.
    hold.release();
    const late = await killed;
    assert.equal(late.statusCode, 402, late.body);
    assert.equal(confirms(stripe).length, 0, 'no card was tried, then or later');
  },
);

test(
  'a request that outlives its lease stops: its intent id is refused, and no confirm is sent',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const clock = { now: T0 };
    const { app, stripe } = buildApp(clock);
    const hold = stripe.holdNext('create');

    const pending = pay(app, invoiceId, `pay-outlived-${randomUUID()}`);
    await hold.reached;
    clock.now = seconds(151); // No sweeper has run: only the clock moved.
    hold.release();

    const res = await pending;
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(confirms(stripe).length, 0);
    const [charge] = await chargesOnInvoice(invoiceId);
    assert.equal(charge?.stripePaymentIntentId, null, 'the id was not stored');
    assert.equal(charge?.status, 'requires_payment', 'the sweeper owns it now');
  },
);

test(
  'the conditional renewal before every call: a lease lost between tries stops the next confirm',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const clock = { now: T0 };
    const { app, stripe } = buildApp(clock);
    stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'processing_error' },
    ]);
    const hold = stripe.holdNext('confirm');

    const pending = pay(app, invoiceId, `pay-lost-lease-${randomUUID()}`);
    await hold.reached;
    clock.now = seconds(151);
    hold.release();

    const res = await pending;
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(confirms(stripe).length, 1, 'the transient error spent no second try');
    const [charge] = await chargesOnInvoice(invoiceId);
    assert.equal(charge?.attemptCount, 1);
  },
);

test(
  'a stub that confirms and then throws a connection error ends with one PaymentIntent and one settle',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.confirmLandsThenThrows('succeeded');

    const res = await pay(app, invoiceId, `pay-lost-confirm-${randomUUID()}`);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_id: string; charge_status: string; invoice_status: string };
    assert.equal(body.charge_status, 'succeeded');
    assert.equal(body.invoice_status, 'paid');

    assert.equal(creates(stripe).length, 1, 'one PaymentIntent');
    assert.equal(stripe.executedConfirms().length, 1, 'one confirm reached Stripe');
    assert.equal((await chargesOnInvoice(invoiceId)).length, 1, 'one charge');
    assert.equal((await receiptsFor(body.charge_id)).length, 1, 'one settle, one receipt');
  },
);

test(
  'a timed-out confirm that never landed spends another try on the same intent',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentThrowsTransport();

    const res = await pay(app, invoiceId, `pay-lost-net-${randomUUID()}`);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(creates(stripe).length, 1, 'never a second intent');
    assert.equal(confirms(stripe).length, 2);
    assert.equal(
      stripe.calls.filter((c) => c.method === 'retrievePaymentIntent').length,
      1,
      'the timeout was answered by a retrieve',
    );
  },
);

test(
  'a lost create is re-sent under K0 with the frozen parameters, and K0 does not derive from the client key',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.nextCreateThrowsTransport();

    const key = `pay-lost-create-${randomUUID()}`;
    const res = await pay(app, invoiceId, key);
    assert.equal(res.statusCode, 201, res.body);
    const [first, second] = creates(stripe);
    assert.equal(first?.idempotencyKey, second?.idempotencyKey, 'K0, twice');
    assert.deepEqual(first?.args, second?.args, 'byte for byte');
    assert.ok(!first?.idempotencyKey.includes(key), 'order-scoped, not the client key');
    const [charge] = await chargesOnInvoice(invoiceId);
    assert.equal(charge?.stripeIdempotencyKey, first?.idempotencyKey, 'stored on the charge');
  },
);

test(
  'processing: 201 with the intent live, no cancel, the claim stays open, a same-key retry is 409',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('processing');

    const key = `pay-processing-${randomUUID()}`;
    const res = await pay(app, invoiceId, key);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      charge_status: string;
      charge_blocker: string;
      invoice_status: string;
      stripe_payment_intent_id: string;
    };
    assert.equal(body.charge_status, 'requires_payment');
    assert.equal(body.charge_blocker, 'processing');
    assert.equal(body.invoice_status, 'open');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length,
      0,
      'a processing intent stays live: the request cancels nothing',
    );

    const [claim] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    assert.equal(claim?.completedAt, null, 'the claim stays open');
    assert.ok(claim?.orderId, 'and names its order');

    const retry = await pay(app, invoiceId, key);
    assert.equal(retry.statusCode, 409, retry.body);
    assert.equal((retry.json() as ErrorBody).error.code, 'idempotency_inflight');
    assert.equal(creates(stripe).length, 1, 'a same-key retry never creates a second intent');
    const orderRows = await db.select().from(orders).where(eq(orders.invoiceId, invoiceId));
    assert.equal(orderRows.length, 1, 'or a second order');

    // The webhook settles it, and the retry now replays the final 201.
    stripe.setIntentState(body.stripe_payment_intent_id, 'succeeded');
    stripe.setNextEvent(succeededEvent(body.stripe_payment_intent_id));
    const hook = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
      payload: '{}',
    });
    assert.equal(hook.statusCode, 200, hook.body);
    const settled = await pay(app, invoiceId, key);
    assert.equal(settled.statusCode, 201, settled.body);
    assert.equal((settled.json() as { invoice_status: string }).invoice_status, 'paid');
  },
);

test(
  '409 invoice_payment_in_flight inside the lease; through past it, and PAY-35 refunds the loser',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const clock = { now: T0 };
    const { app, stripe } = buildApp(clock);
    stripe.setNextIntentStatus('processing');
    const first = await pay(app, invoiceId, `pay-first-${randomUUID()}`);
    assert.equal(first.statusCode, 201, first.body);
    const firstIntent = (first.json() as { stripe_payment_intent_id: string })
      .stripe_payment_intent_id;

    clock.now = seconds(60);
    const blocked = await pay(app, invoiceId, `pay-second-${randomUUID()}`);
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal((blocked.json() as ErrorBody).error.code, 'invoice_payment_in_flight');
    assert.equal((blocked.json() as ErrorBody).error.details, undefined, 'no details');
    assert.equal(creates(stripe).length, 1, 'nothing is charged');

    // Past the lease a second tender goes through (A2).
    clock.now = seconds(300);
    const through = await pay(app, invoiceId, `pay-third-${randomUUID()}`);
    assert.equal(through.statusCode, 201, through.body);
    assert.equal((await invoiceRow(invoiceId)).status, 'paid');

    // The first then succeeds: the duplicate comes back by itself.
    stripe.setIntentState(firstIntent, 'succeeded');
    stripe.setNextEvent(succeededEvent(firstIntent));
    const hook = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
      payload: '{}',
    });
    assert.equal(hook.statusCode, 200, hook.body);

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(refundRows.length, 1, 'one refund');
    assert.equal(refundRows[0]?.amountCents, 8_500);
    assert.equal(stripe.executedRefunds().length, 1, 'and it was sent');
    const firstCharge = (await chargesOnInvoice(invoiceId)).find(
      (c) => c.stripePaymentIntentId === firstIntent,
    );
    assert.equal(refundRows[0]?.chargeId, firstCharge?.id, 'of the loser');
  },
);

test(
  'a sweeper tick on a processing charge past its lease does not look in flight to a second tender',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const clock = { now: T0 };
    const { app, stripe } = buildApp(clock);
    stripe.setNextIntentStatus('processing');
    const first = await pay(app, invoiceId, `pay-swept-${randomUUID()}`);
    assert.equal(first.statusCode, 201, first.body);

    clock.now = seconds(300);
    await runOrderSweeperOnce({ stripe, now: clock.now, log: QUIET_LOG });

    clock.now = seconds(301);
    const through = await pay(app, invoiceId, `pay-swept-2-${randomUUID()}`);
    assert.equal(through.statusCode, 201, through.body);
  },
);

// F1 (Opus H2). The FK on `orders.invoice_id` takes FOR KEY SHARE, and a tx1 that then
// asks for FOR UPDATE on the same row deadlocks against the other tender.
test(
  'two tenders at one moment, different keys and cards: 201 and 409, no 40P01, no 500',
  SKIP_WHEN_NO_DB,
  async () => {
    const secondCard = randomUUID();
    await db.insert(paymentMethods).values({
      id: secondCard,
      ownerId: FIXTURE_IDS.ownerId,
      stripePaymentMethodId: 'pm_fixture_test_two_tenders',
      brand: 'mastercard',
      last4: '8203',
      expMonth: 11,
      expYear: 2031,
      cardholderName: 'Two Tenders',
      isDefault: false,
    });
    try {
      for (let round = 0; round < 6; round += 1) {
        const invoiceId = await seedOpenInvoice();
        const { app } = buildApp();
        const answers = await Promise.all([
          pay(app, invoiceId, `tender-a-${randomUUID()}`),
          pay(app, invoiceId, `tender-b-${randomUUID()}`, { payment_method_id: secondCard }),
        ]);
        assert.deepEqual(
          answers.map((a) => a.statusCode).sort(),
          [201, 409],
          `round ${round}: ${answers.map((a) => a.body).join(' | ')}`,
        );
        await clearOrderRows();
      }
    } finally {
      // Rows first: a failed round leaves a charge on this card, and the FK error would
      // replace the assertion that named the round.
      await clearOrderRows();
      await db.delete(paymentMethods).where(eq(paymentMethods.id, secondCard));
    }
  },
);

// F3 (Opus L7). `idempotency_keys.owner_id` is right there: a stored answer is the
// owner's who made it.
test('owner B with A key, invoice and card gets a 404, not A bytes', SKIP_WHEN_NO_DB, async () => {
  const invoiceId = await seedOpenInvoice();
  const { app } = buildApp();
  const key = `cross-owner-${randomUUID()}`;
  const first = await pay(app, invoiceId, key);
  assert.equal(first.statusCode, 201, first.body);

  const otherOwner = randomUUID();
  await db.insert(owners).values({
    id: otherOwner,
    supabaseUid: randomUUID(),
    name: 'Someone Else',
    email: `someone-else-${otherOwner}@example.test`,
    phone: '555-0100',
    location: 'fayetteville',
  });
  try {
    const { app: bApp, authenticate } = makeContractApp({
      kind: 'owner',
      ownerId: otherOwner,
      supabaseUid: randomUUID(),
    });
    registerInvoicesRoute(bApp, { authenticate, stripe: makeStripeStub(), now: () => T0 });
    const stolen = await pay(bApp, invoiceId, key);
    assert.equal(stolen.statusCode, 404, stolen.body);
    assert.doesNotMatch(stolen.body, /client_secret|stripe_payment_intent_id/);
  } finally {
    await db.delete(owners).where(eq(owners.id, otherOwner));
  }
});

// F5 (Fable L3). Mutant M14 passed every test above: nothing pinned this arm.
test(
  'a confirm that lands a decline and loses its response is read back as final: one confirm, 402 declined',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.confirmLandsThenThrows('requires_payment_method', { failureCode: 'card_declined' });

    const res = await pay(app, invoiceId, `readback-${randomUUID()}`);

    assert.equal(res.statusCode, 402, res.body);
    const details = (res.json() as ErrorBody).error.details;
    assert.equal(details?.charge_blocker, 'declined');
    assert.equal(details?.attempts, 1);
    assert.equal(confirms(stripe).length, 1, 'a landed decline is not retried');
  },
);

// Fable L2. Mutant Mx3 passed every test here: the transient arm of `judgeReadBack` was
// unpinned, and under it a lost `processing_error` was declined without its try.
test(
  'a confirm that lands a processing_error and loses its response spends the try the design grants: two confirms, one intent, 201',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.confirmLandsThenThrows('requires_payment_method', { failureCode: 'processing_error' });

    const res = await pay(app, invoiceId, `readback-transient-${randomUUID()}`);

    assert.equal(res.statusCode, 201, res.body);
    assert.equal(stripe.executedConfirms().length, 2, 'the lost try landed, and one more ran');
    const [charge] = await db
      .select()
      .from(charges)
      .where(eq(charges.id, (res.json() as { charge_id: string }).charge_id));
    assert.equal(charge?.status, 'succeeded');
    assert.equal(charge?.attemptCount, 2, 'it spent exactly one more try');
    assert.equal(new Set(stripe.executedConfirms()).size, 1, 'both on one intent');
  },
);

test(
  'seedInvoiceOrder lays down what tx1 commits (the kill tests rest on it)',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const stripe = makeStripeStub();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'processing',
      attemptingUntil: seconds(150),
    });
    const [row] = await db.select().from(charges).where(eq(charges.id, seeded.chargeId));
    assert.equal(row?.orderId, seeded.orderId);
    assert.equal(row?.status, 'requires_payment');
  },
);
