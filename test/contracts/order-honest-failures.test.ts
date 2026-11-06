import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, mock, test } from 'node:test';
import { and, eq, like, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { refundsRepository } from '../../src/db/repositories/refundsRepository.js';
import { settingsRepository } from '../../src/db/repositories/settingsRepository.js';
import {
  charges,
  idempotencyKeys,
  invoices,
  orders,
  scheduledNotifications,
  stripeEvents,
} from '../../src/db/schema/schema.js';
import type { ApiErrorEnvelope, PaymentFailedDetails } from '../../src/contracts/wire.js';
import type { Principal } from '../../src/auth/principal.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { PAY_HOLD_SEED_MS } from '../../src/lib/confirmCharge.js';
import type { StripeWebhookEvent } from '../../src/lib/stripe.js';
import { parkArmForBlocker } from '../../src/workers/invoiceAutoCharge.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
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
  receiptsFor,
  seedInvoiceOrder,
  seedOpenInvoice,
} from './_orderFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * P16's first job (`plan.json` P16 `plan_added`): the engine saying true things about
 * money before anything rides it. Each test is a finding from P15's second review,
 * named. Stripe is the stub throughout, so none of this says anything about real Stripe.
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
/** `pay.seat_hold_max_minutes` at its seed, the two minutes a phone waits. */
const HOLD_SECONDS = 120;

function appFor(principal: Principal, stripe: StripeStub, clock: { now: Date }) {
  const { app, authenticate } = makeContractApp(principal);
  registerInvoicesRoute(app, { authenticate, stripe, now: () => clock.now });
  registerStaffOrdersRoute(app, { authenticate, stripe, now: () => clock.now });
  registerStripeWebhookRoute(app, { stripe });
  return app;
}

function build() {
  const stripe = makeStripeStub();
  const clock = { now: T0 };
  return {
    stripe,
    clock,
    owner: appFor(FIXTURE_OWNER_PRINCIPAL, stripe, clock),
    staff: appFor(FIXTURE_STAFF_PRINCIPAL, stripe, clock),
  };
}

type App = ReturnType<typeof appFor>;

function pay(app: App, invoiceId: string, key = `honest-${randomUUID()}`) {
  return app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay`,
    headers: { 'idempotency-key': key },
    payload: {},
  });
}

function cancelOrder(app: App, orderId: string) {
  return app.inject({
    method: 'POST',
    url: `/staff/orders/${orderId}/cancel`,
    headers: { 'idempotency-key': `honest-cancel-${randomUUID()}` },
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
  type: 'payment_intent.canceled' | 'payment_intent.payment_failed',
  paymentIntentId: string,
): StripeWebhookEvent {
  return {
    id: `evt_test_${randomUUID().slice(0, 8)}`,
    type,
    paymentIntentId,
    amountCents: 8_500,
    metadata: {},
  };
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
    .where(and(eq(orders.invoiceId, invoiceId), eq(charges.status, 'failed')));
  assert.ok(row, 'a failed charge sits on this invoice');
  return row.charge;
}

async function storedDetails(claimKey: string): Promise<PaymentFailedDetails> {
  const [claim] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, claimKey));
  assert.equal(claim?.responseStatus, 402, 'the claim holds the 402');
  return (claim?.responseBody as ApiErrorEnvelope).error.details as PaymentFailedDetails;
}

async function paymentFailedNotices() {
  return db
    .select()
    .from(scheduledNotifications)
    .where(
      and(
        eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
        eq(scheduledNotifications.type, 'payment-failed'),
      ),
    );
}

async function invoiceStatus(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, id));
  return row?.status;
}

function recordingLog() {
  const errors: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    errors,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (obj: Record<string, unknown>, msg?: string): void => {
      errors.push({ obj, msg: msg ?? '' });
    },
  };
}

// ── Opus L1: "you weren't charged" after "We charged your card" ─────────────

/** p36's journey: a stranded tender, then a second tender in the gap before the tick. */
async function strandedThenPaidBySecondTender(intentStatus: 'requires_confirmation' | null) {
  const world = build();
  const invoiceId = await seedOpenInvoice();
  const first = await seedInvoiceOrder(world.stripe, {
    invoiceId,
    now: T0,
    intentStatus,
    attemptingUntil: LEASE_END,
    attemptCount: intentStatus === null ? 0 : 1,
  });
  world.clock.now = PAST_LEASE;
  const second = await pay(world.owner, invoiceId);
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(await invoiceStatus(invoiceId), 'paid', 'the second tender paid it');
  return { ...world, invoiceId, first, secondChargeId: second.json().charge_id as string };
}

test(
  'Opus L1: the sweeper abandons a stranded tender on an invoice a second tender paid, and says nothing of it; the 402 stays on the claim',
  SKIP_WHEN_NO_DB,
  async () => {
    const { stripe, first, secondChargeId } = await strandedThenPaidBySecondTender(null);

    await runOrderSweeperOnce({ stripe, now: seconds(152), log: QUIET_LOG });

    assert.equal((await chargeRow(first.chargeId)).status, 'failed');
    assert.equal((await storedDetails(first.claimKey)).outcome, 'abandoned');
    assert.equal((await receiptsFor(secondChargeId)).length, 1, 'she was told the truth once');
    assert.deepEqual(await paymentFailedNotices(), [], 'and never "you weren\'t charged"');
  },
);

test(
  'Opus L1: the sweeper cancels a stranded intent on an invoice a second tender paid, and says nothing of it; the 402 stays on the claim',
  SKIP_WHEN_NO_DB,
  async () => {
    const { stripe, first } = await strandedThenPaidBySecondTender('requires_confirmation');

    await runOrderSweeperOnce({ stripe, now: seconds(152), log: QUIET_LOG });

    assert.equal((await chargeRow(first.chargeId)).status, 'failed');
    assert.equal((await storedDetails(first.claimKey)).outcome, 'failed');
    assert.deepEqual(await paymentFailedNotices(), []);
  },
);

test(
  "Opus L1: Cancel order on a stranded tender of a paid invoice sends no 'Payment cancelled'; the 402 stays on the claim",
  SKIP_WHEN_NO_DB,
  async () => {
    const { staff, first } = await strandedThenPaidBySecondTender('requires_confirmation');

    const res = await cancelOrder(staff, first.orderId);

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().outcome, 'cancelled');
    await storedDetails(first.claimKey);
    assert.deepEqual(await paymentFailedNotices(), []);
  },
);

test(
  'Opus L1: the canceled webhook on a stranded tender of a paid invoice says nothing either',
  SKIP_WHEN_NO_DB,
  async () => {
    const { owner, stripe, first } = await strandedThenPaidBySecondTender('requires_confirmation');
    assert.ok(first.intentId);
    stripe.setIntentState(first.intentId, 'canceled');

    const res = await deliver(
      owner,
      stripe,
      intentEvent('payment_intent.canceled', first.intentId),
    );

    assert.equal(res.statusCode, 200, res.body);
    await storedDetails(first.claimKey);
    assert.deepEqual(await paymentFailedNotices(), []);
  },
);

test(
  'Opus L1, control: an invoice still open gets the notice on both sweeper arms and on Cancel order',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    const clock = { now: T0 };
    const staff = appFor(FIXTURE_STAFF_PRINCIPAL, stripe, clock);
    for (const [intentStatus, trigger] of [
      [null, 'charge-failed'],
      ['requires_confirmation', 'charge-failed'],
    ] as const) {
      const invoiceId = await seedOpenInvoice();
      const seeded = await seedInvoiceOrder(stripe, {
        invoiceId,
        now: T0,
        intentStatus,
        attemptingUntil: LEASE_END,
        attemptCount: intentStatus === null ? 0 : 1,
      });
      await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });
      const notices = (await paymentFailedNotices()).filter(
        (n) => n.dedupeKey === `${trigger}:${seeded.chargeId}`,
      );
      assert.equal(notices.length, 1, `${trigger} on intent ${String(intentStatus)}`);
    }
    const invoiceId = await seedOpenInvoice();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'requires_confirmation',
      attemptingUntil: LEASE_END,
    });
    const res = await cancelOrder(staff, seeded.orderId);
    assert.equal(res.statusCode, 200, res.body);
    const notices = (await paymentFailedNotices()).filter(
      (n) => n.dedupeKey === `order-cancelled:${seeded.chargeId}`,
    );
    assert.equal(notices.length, 1, 'Payment cancelled');
  },
);

// ── Opus L2: a decline after the phone stopped waiting ──────────────────────

async function declineLandingAt(secondsAfterTapping: number) {
  const world = build();
  const invoiceId = await seedOpenInvoice();
  const confirm = world.stripe.holdNext('confirm');
  world.stripe.queueIntentOutcomes([
    { kind: 'cardError', status: 'requires_payment_method', code: 'card_declined' },
  ]);
  const pending = pay(world.owner, invoiceId);
  await confirm.reached;
  world.clock.now = seconds(secondsAfterTapping);
  confirm.release();
  const res = await pending;
  assert.equal(res.statusCode, 402, res.body);
  return { ...world, invoiceId };
}

test(
  'Opus L2: a decline landing after the phone stopped waiting queues one Payment failed notice',
  SKIP_WHEN_NO_DB,
  async () => {
    const { invoiceId } = await declineLandingAt(HOLD_SECONDS + 1);

    const charge = await chargeOnInvoice(invoiceId);
    const notices = await paymentFailedNotices();
    assert.equal(notices.length, 1, 'she is told, once');
    assert.equal(notices[0]?.trigger, 'charge-failed');
    assert.equal(notices[0]?.dedupeKey, `charge-failed:${charge.id}`);
    assert.equal(notices[0]?.title, 'Payment failed');
    assert.equal(
      notices[0]?.body,
      "Your $85.00 payment didn't go through, so you weren't charged.",
    );
  },
);

test(
  'Opus L2, control: a decline inside the hold is on a screen still open, so it writes no notice',
  SKIP_WHEN_NO_DB,
  async () => {
    await declineLandingAt(HOLD_SECONDS - 1);

    assert.deepEqual(await paymentFailedNotices(), [], 'the 402 is the answer she reads');
  },
);

test(
  'Opus L2, control: well inside the two minutes, at 108 s, it writes none either',
  SKIP_WHEN_NO_DB,
  async () => {
    await declineLandingAt(108);

    assert.deepEqual(await paymentFailedNotices(), []);
  },
);

/** Staff can move this from 1 to 5, and the phone never hears (`OwnerPaymentSettingsWire`). */
async function withSeatHoldMinutes(minutes: number, run: () => Promise<void>): Promise<void> {
  const write = (value: number) =>
    db.execute(
      sql`UPDATE payment_settings SET value = ${String(value)}::jsonb WHERE key = 'seat_hold_max_minutes' AND scope = 'global'`,
    );
  await write(minutes);
  try {
    await run();
  } finally {
    await write(HOLD_SECONDS / 60);
  }
}

test(
  'Opus L2: the setting at 5, a decline at 124 s: the phone stopped at 120 s, so she is told, once',
  SKIP_WHEN_NO_DB,
  async () => {
    await withSeatHoldMinutes(5, async () => {
      await declineLandingAt(124);

      assert.equal((await paymentFailedNotices()).length, 1, 'never told is the bug');
    });
  },
);

test(
  'Opus L2: the setting at 1, a decline at 61 s: the phone is still waiting and reads the 402, so no notice',
  SKIP_WHEN_NO_DB,
  async () => {
    await withSeatHoldMinutes(1, async () => {
      await declineLandingAt(61);

      assert.deepEqual(await paymentFailedNotices(), [], 'told twice is the bug');
    });
  },
);

test(
  "Opus L2: the server's constant is the seed the phone runs on, which the setting starts at",
  SKIP_WHEN_NO_DB,
  async () => {
    const { seat_hold_max_minutes: seed } = await settingsRepository.orderEngine();

    assert.equal(PAY_HOLD_SEED_MS, HOLD_SECONDS * 1000);
    assert.equal(PAY_HOLD_SEED_MS, seed * 60_000);
  },
);

test(
  'Opus L1 on L2: a decline past the hold on an invoice a second tender paid says nothing either',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = build();
    const invoiceId = await seedOpenInvoice();
    const confirm = world.stripe.holdNext('confirm');
    const pending = pay(world.owner, invoiceId);
    await confirm.reached;
    world.clock.now = seconds(HOLD_SECONDS + 40);
    const [charge] = await db
      .select()
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.ok(charge);
    // Bound to this tender's confirm, so the second one below is the card that works.
    world.stripe.setIntentOutcomeForKey(`order:${charge.orderId}:confirm:1`, {
      kind: 'cardError',
      status: 'requires_payment_method',
      code: 'card_declined',
    });
    // The first tender is stranded past its lease, and the desk's second one paid it.
    await db
      .update(charges)
      .set({ attemptingUntil: seconds(1).toISOString() })
      .where(eq(charges.id, charge.id));
    const second = await pay(world.owner, invoiceId);
    assert.equal(second.statusCode, 201, second.body);

    confirm.release();
    const first = await pending;

    assert.equal(first.statusCode, 402, first.body);
    assert.deepEqual(await paymentFailedNotices(), []);
  },
);

// ── Opus L4, Fable N5: a card nobody asked ──────────────────────────────────

test(
  'Opus L4: case (b) on an intent resting requires_payment_method with no code stores no blocker',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    const invoiceId = await seedOpenInvoice();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'requires_payment_method',
      attemptingUntil: LEASE_END,
    });

    await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });

    const row = await chargeRow(seeded.chargeId);
    assert.equal(row.status, 'failed');
    assert.equal(row.blocker, null, 'nothing says a card answered');
    const details = await storedDetails(seeded.claimKey);
    assert.equal(details.charge_blocker, undefined, 'and the stored 402 says none');
  },
);

test(
  'Opus L4, control: the same intent with a code on it keeps the blocker the code names',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    const invoiceId = await seedOpenInvoice();
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

    await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });

    assert.equal((await chargeRow(seeded.chargeId)).blocker, 'declined');
    assert.equal((await storedDetails(seeded.claimKey)).charge_blocker, 'declined');
  },
);

// ── Opus L5, Fable N3: the desk's only record ───────────────────────────────

test(
  'Opus L5: a card that really declined keeps its reason when the canceled webhook wins',
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
    // What the advisory `payment_failed` wrote, before Stripe's cancel took the code away.
    await db
      .update(charges)
      .set({ lastStripeError: 'card_declined' })
      .where(eq(charges.id, seeded.chargeId));

    const res = await deliver(
      owner,
      stripe,
      intentEvent('payment_intent.canceled', seeded.intentId),
    );

    assert.equal(res.statusCode, 200, res.body);
    const row = await chargeRow(seeded.chargeId);
    assert.equal(row.status, 'failed');
    assert.equal(row.lastStripeError, 'card_declined', 'the desk keeps what Stripe said');
  },
);

test(
  'Opus L5, the whole path: payment_failed writes the code, a cancel takes it from Stripe, and the canceled webhook keeps it',
  SKIP_WHEN_NO_DB,
  async () => {
    const { owner, stripe } = build();
    const invoiceId = await seedOpenInvoice();
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
    const advisory = await deliver(
      owner,
      stripe,
      intentEvent('payment_intent.payment_failed', seeded.intentId),
    );
    assert.equal(advisory.statusCode, 200, advisory.body);
    assert.equal((await chargeRow(seeded.chargeId)).lastStripeError, 'card_declined');

    await stripe.cancelPaymentIntent(seeded.intentId);
    const res = await deliver(
      owner,
      stripe,
      intentEvent('payment_intent.canceled', seeded.intentId),
    );

    assert.equal(res.statusCode, 200, res.body);
    const row = await chargeRow(seeded.chargeId);
    assert.equal(row.status, 'failed');
    assert.equal(row.blocker, null, 'Stripe kept no reason, so the 402 names none');
    assert.equal(row.lastStripeError, 'card_declined', 'and the desk still reads why');
  },
);

// ── Fable N2, N6: the stub and the watch ────────────────────────────────────

test('Fable N2: a cancel takes last_payment_error away, as live Stripe does', async () => {
  const stripe = makeStripeStub();
  const created = await stripe.createUnconfirmedPaymentIntent(
    {
      customerId: 'cus_test',
      paymentMethodId: 'pm_test',
      amountCents: 8_500,
      currency: 'usd',
      metadata: {},
    },
    `honest-${randomUUID()}`,
    { timeoutMs: 30_000 },
  );
  stripe.setIntentState(created.id, 'requires_payment_method', { failureCode: 'card_declined' });
  assert.equal(
    (await stripe.retrievePaymentIntent(created.id)).failureCode,
    'card_declined',
    'a declined intent carries its code on a retrieve',
  );

  await stripe.cancelPaymentIntent(created.id);

  const live = await stripe.retrievePaymentIntent(created.id);
  assert.equal(live.status, 'canceled');
  assert.equal(live.failureCode, undefined, 'DECISIONS 147(b), the live probe');
});

test(
  'Fable N6: a late success that cannot name its intent raises one alarm naming the money, and the watch stays open',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    const invoiceId = await seedOpenInvoice();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'succeeded',
      attemptingUntil: LEASE_END,
    });
    await db
      .update(charges)
      .set({ status: 'failed', nextSweepAt: T0.toISOString() })
      .where(eq(charges.id, seeded.chargeId));
    const mint = mock.method(refundsRepository, 'mintCappedPendingRefund', async () => ({
      kind: 'no-payment-intent' as const,
      amountCents: 8_500,
    }));
    const log = recordingLog();

    try {
      await runOrderSweeperOnce({ stripe, now: seconds(60), log });
    } finally {
      mint.mock.restore();
    }

    assert.equal(mint.mock.callCount(), 1, 'the arm was reached');
    assert.equal(log.errors.length, 1, 'one alarm');
    assert.equal(log.errors[0]?.obj.chargeId, seeded.chargeId);
    assert.equal(log.errors[0]?.obj.amountCents, 8_500);
    assert.notEqual(
      (await chargeRow(seeded.chargeId)).nextSweepAt,
      null,
      'money is owed, so nothing closes the watch',
    );
  },
);

// ── PAY-U06: the reason reaches the 402, the charge and a replay ────────────

const HONEST_REASONS = [
  ['insufficient_funds', 'card_declined', 'insufficient_funds'],
  ['expired_card', 'expired_card', undefined],
] as const;

for (const [blocker, code, declineCode] of HONEST_REASONS) {
  const decline = { code, ...(declineCode !== undefined ? { declineCode } : {}) };

  for (const [fork, outcome] of [
    ['thrown', { kind: 'cardError', status: 'requires_payment_method', ...decline }],
    ['returned', { kind: 'returnedDecline', ...decline }],
  ] as const) {
    test(
      `PAY-U06: /pay on a ${fork} ${blocker} commits that blocker, on the 402, the charge and a replay`,
      SKIP_WHEN_NO_DB,
      async () => {
        const { owner, stripe } = build();
        const invoiceId = await seedOpenInvoice();
        stripe.queueIntentOutcomes([outcome]);
        const key = `honest-${randomUUID()}`;

        const res = await pay(owner, invoiceId, key);

        assert.equal(res.statusCode, 402, res.body);
        const details = (res.json() as ApiErrorEnvelope).error.details as PaymentFailedDetails;
        assert.equal(details.charge_blocker, blocker);
        assert.equal(details.outcome, 'failed');
        const charge = await chargeOnInvoice(invoiceId);
        assert.equal(charge.blocker, blocker);
        assert.equal(charge.lastStripeError, code, 'the desk reads what Stripe said');
        assert.equal(await invoiceStatus(invoiceId), 'open');

        const replay = await pay(owner, invoiceId, key);
        assert.equal(replay.statusCode, 402, replay.body);
        assert.equal(replay.body, res.body, 'a replay is the same bytes');
      },
    );
  }

  test(
    `PAY-U06: a confirm that lost its answer reads ${blocker} back off the retrieve`,
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner, stripe } = build();
      const invoiceId = await seedOpenInvoice();
      stripe.confirmLandsThenThrows('requires_payment_method', {
        failureCode: code,
        ...(declineCode !== undefined ? { declineCode } : {}),
      });

      const res = await pay(owner, invoiceId);

      assert.equal(res.statusCode, 402, res.body);
      const details = (res.json() as ApiErrorEnvelope).error.details as PaymentFailedDetails;
      assert.equal(details.charge_blocker, blocker);
    },
  );

  test(`PAY-U06: the sweeper's case (b) stores ${blocker}`, SKIP_WHEN_NO_DB, async () => {
    const stripe = makeStripeStub();
    const invoiceId = await seedOpenInvoice();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'requires_payment_method',
      attemptingUntil: LEASE_END,
    });
    assert.ok(seeded.intentId);
    stripe.setIntentState(seeded.intentId, 'requires_payment_method', {
      failureCode: code,
      ...(declineCode !== undefined ? { declineCode } : {}),
    });

    await runOrderSweeperOnce({ stripe, now: PAST_LEASE, log: QUIET_LOG });

    assert.equal((await chargeRow(seeded.chargeId)).blocker, blocker);
    assert.equal((await storedDetails(seeded.claimKey)).charge_blocker, blocker);
  });

  test(`PAY-U06: the auto-charge park reads ${blocker} as a decline, not an unknown`, () => {
    assert.equal(parkArmForBlocker(blocker), 'declined');
  });
}
