import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { lockCharge } from '../../src/db/locks.js';
import { pool } from '../../src/db/pool.js';
import { withActor, type Tx } from '../../src/db/tx.js';
import {
  bookings,
  charges,
  cohorts,
  idempotencyKeys,
  invoices,
  paymentMethods,
  refunds,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import type { EnrollmentWithdrawResultWire } from '../../src/contracts/wire.js';
import { failChargeInTx, settleChargeInTx } from '../../src/lib/confirmCharge.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
import { clearInvoiceReferrers, FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
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
 * The one lock order on real connections (`db/locks.ts`, design §2.7:3975): charge, then
 * invoice, then bookings. Each transaction here is its own connection running the repo's
 * own code. A test pauses one in only two ways: it takes the charge lock itself and then
 * calls the real function, which re-takes that lock; or a third connection holds a row
 * the real withdraw needs next. Stripe is the stub, so none of this says anything about
 * real Stripe, and it proves orderings, not how often they happen.
 */

after(async () => {
  await clearOrderRows();
});
registerFixtureHooks();
afterEach(async () => {
  await clearOrderRows();
});

const T0 = new Date('2026-05-19T17:50:00Z');
const seconds = (n: number): Date => new Date(T0.getTime() + n * 1000);
const LEASE_END = seconds(150);
const SIX_WEEKS_OUT_UTC = '2026-07-06T23:00:00Z';
const PUPPY_PRICE_CENTS = 12_000;
const SECOND_CARD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

// ── seeing a lock ───────────────────────────────────────────────────────────

/** The backend waiting on `pid`, or nothing while nobody is. */
async function backendBlockedBy(pid: number): Promise<{ pid: number; query: string } | undefined> {
  const { rows } = await pool.query<{ pid: number; query: string }>(
    `SELECT pid, query FROM pg_stat_activity
      WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
    [pid],
  );
  return rows[0];
}

async function untilBlockedBy(pid: number): Promise<{ pid: number; query: string }> {
  const giveUpAt = Date.now() + 5_000;
  for (;;) {
    const blocked = await backendBlockedBy(pid);
    if (blocked !== undefined) return blocked;
    assert.ok(Date.now() < giveUpAt, `nobody queued behind backend ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function backendOf(tx: Tx): Promise<number> {
  const { rows } = await tx.execute(sql`select pg_backend_pid() as pid`);
  return Number((rows[0] as { pid: number }).pid);
}

/** Which of these rows another transaction holds right now. Never waits. */
async function rowsHeldNow(targets: readonly { table: string; id: string }[]): Promise<string[]> {
  const held: string[] = [];
  for (const { table, id } of targets) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [id]);
    } catch (err) {
      if ((err as { code?: string }).code !== '55P03') throw err;
      held.push(table);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  return held;
}

/** Take the charge on a connection of its own, wait for the word, then run the real thing. */
function holdCharge<T>(chargeId: string, then: (tx: Tx) => Promise<T>) {
  let release!: () => void;
  const word = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding!: (pid: number) => void;
  const held = new Promise<number>((resolve) => {
    holding = resolve;
  });
  const done = withActor('worker:lock-order-test', async (tx) => {
    await lockCharge(tx, chargeId);
    holding(await backendOf(tx));
    await word;
    return then(tx);
  });
  return { held, release, done };
}

/** A third connection sitting on one row, so whoever needs it next parks there. */
async function holdRow(table: string, id: string, strength: string) {
  const client = await pool.connect();
  await client.query('BEGIN');
  const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  await client.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR ${strength}`, [id]);
  return {
    pid: rows[0]!.pid,
    async release(): Promise<void> {
      await client.query('ROLLBACK');
      client.release();
    },
  };
}

/** A deadlock victim on either side is the failure, whichever Postgres picks. */
function assertNoDeadlock(t1: PromiseSettledResult<unknown>, withdrawStatus: number): void {
  if (t1.status === 'rejected') {
    const err = t1.reason as { code?: string; cause?: { code?: string }; message?: string };
    assert.fail(`the first side died: ${err.cause?.code ?? err.code} ${err.message}`);
  }
  assert.equal(withdrawStatus, 200, 'the withdraw answered: a 500 here is 40P01');
}

// ── reading the outcome ─────────────────────────────────────────────────────

async function invoiceStatus(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, id));
  return row?.status;
}

async function chargeStatus(id: string): Promise<string | undefined> {
  const [row] = await db.select().from(charges).where(eq(charges.id, id));
  return row?.status;
}

async function refundsOn(chargeId: string) {
  return db.select().from(refunds).where(eq(refunds.chargeId, chargeId));
}

async function paymentFailedNotices() {
  return db
    .select({ trigger: scheduledNotifications.trigger })
    .from(scheduledNotifications)
    .where(
      and(
        eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
        eq(scheduledNotifications.type, 'payment-failed'),
      ),
    );
}

async function invoiceCard(id: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ paymentMethodId: invoices.paymentMethodId })
    .from(invoices)
    .where(eq(invoices.id, id));
  return row?.paymentMethodId;
}

async function seatsTaken(cohortId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ filled: cohorts.filled })
    .from(cohorts)
    .where(eq(cohorts.id, cohortId));
  return row?.filled;
}

async function claimStatus(key: string): Promise<number | null | undefined> {
  const [claim] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
  return claim?.responseStatus;
}

// ── a failure inside a held settle ──────────────────────────────────────────

async function insideAHeldSettle(args: {
  intentStatus: 'requires_confirmation' | null;
  act: (world: { stripe: StripeStub; orderId: string }) => Promise<unknown>;
}): Promise<void> {
  const stripe = makeStripeStub();
  const invoiceId = await seedOpenInvoice();
  const first = await seedInvoiceOrder(stripe, {
    invoiceId,
    now: T0,
    intentStatus: args.intentStatus,
    attemptingUntil: LEASE_END,
    attemptCount: args.intentStatus === null ? 0 : 1,
  });
  const second = await seedInvoiceOrder(stripe, {
    invoiceId,
    now: T0,
    intentStatus: 'succeeded',
    attemptingUntil: seconds(400),
  });
  assert.ok(second.intentId);
  const intentId = second.intentId;

  let commit!: () => void;
  const word = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let settled!: (pid: number) => void;
  const holding = new Promise<number>((resolve) => {
    settled = resolve;
  });
  const settle = withActor('worker:lock-order-test', async (tx) => {
    const act = await settleChargeInTx(tx, {
      chargeId: second.chargeId,
      live: await stripe.retrievePaymentIntent(intentId),
      receiptTrigger: 'settle',
      log: QUIET_LOG,
      now: seconds(152),
    });
    settled(await backendOf(tx));
    await word;
    return act;
  });

  try {
    const settlePid = await holding;
    assert.equal(await invoiceStatus(invoiceId), 'open', 'a plain read still says open');

    const acting = args.act({ stripe, orderId: first.orderId });
    const first_to_land = await Promise.race([
      acting.then(() => 'it finished inside the settle'),
      untilBlockedBy(settlePid).then(() => 'it waited for the row'),
    ]);
    assert.deepEqual(await paymentFailedNotices(), [], 'nothing is said while the settle runs');
    assert.equal(first_to_land, 'it waited for the row');

    commit();
    await settle;
    await acting;
  } finally {
    commit();
    await settle;
  }

  // The settle won the invoice, so the money is one charge and nothing is owed back.
  assert.equal(await invoiceStatus(invoiceId), 'paid');
  assert.equal(await chargeStatus(second.chargeId), 'succeeded');
  assert.equal((await receiptsFor(second.chargeId)).length, 1, 'she heard the truth, once');
  assert.equal(await chargeStatus(first.chargeId), 'failed');
  assert.equal(await claimStatus(first.claimKey), 402, 'the 402 stays on the claim');
  assert.deepEqual(await paymentFailedNotices(), [], "and never 'you weren't charged'");
  assert.deepEqual(await refundsOn(first.chargeId), []);
  assert.deepEqual(await refundsOn(second.chargeId), []);
}

test(
  'the settle won: a tick on the no-intent arm waits for the row and says nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    await insideAHeldSettle({
      intentStatus: null,
      act: ({ stripe }) => runOrderSweeperOnce({ stripe, now: seconds(152), log: QUIET_LOG }),
    });
  },
);

test(
  'the settle won: a tick on the dead-intent arm waits for the row and says nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    await insideAHeldSettle({
      intentStatus: 'requires_confirmation',
      act: ({ stripe }) => runOrderSweeperOnce({ stripe, now: seconds(152), log: QUIET_LOG }),
    });
  },
);

test(
  'the settle won: Cancel order waits for the row and says nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    await insideAHeldSettle({
      intentStatus: 'requires_confirmation',
      act: async ({ stripe, orderId }) => {
        const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
        registerStaffOrdersRoute(app, { authenticate, stripe, now: () => seconds(152) });
        const res = await app.inject({
          method: 'POST',
          url: `/staff/orders/${orderId}/cancel`,
          headers: { 'idempotency-key': `lock-order-cancel-${randomUUID()}` },
        });
        assert.equal(res.statusCode, 200, res.body);
      },
    });
  },
);

test(
  'the lock is FOR NO KEY UPDATE: the KEY SHARE a tender holds on the invoice does not stop it',
  SKIP_WHEN_NO_DB,
  async () => {
    // tx1's insert of `orders.invoice_id` takes KEY SHARE here, so `FOR UPDATE` would queue
    // behind every tender, and two tenders asking for it deadlock (`db/locks.ts`).
    const stripe = makeStripeStub();
    const invoiceId = await seedOpenInvoice();
    await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: null,
      attemptingUntil: LEASE_END,
      attemptCount: 0,
    });
    const tender = await holdRow('invoices', invoiceId, 'KEY SHARE');
    try {
      const ticking = runOrderSweeperOnce({ stripe, now: seconds(152), log: QUIET_LOG });
      const landed = await Promise.race([
        ticking.then(() => 'it finished'),
        untilBlockedBy(tender.pid).then(() => 'it queued behind the tender'),
      ]);
      assert.equal(landed, 'it finished');
    } finally {
      await tender.release();
    }
    assert.equal((await paymentFailedNotices()).length, 1, 'the invoice is open, so she is told');
  },
);

// ── against a withdraw, on an invoice carrying an enrollment ────────────────

interface ClassWorld {
  app: ReturnType<typeof classApp>;
  stripe: StripeStub;
  cohortId: string;
  invoiceId: string;
  bookingIds: string[];
}

function classApp(stripe: StripeStub) {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  registerInvoicesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return app;
}

async function enrolledOnAnOpenInvoice(): Promise<ClassWorld> {
  const cohortId = randomUUID();
  await db.insert(cohorts).values({
    id: cohortId,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate: SIX_WEEKS_OUT_UTC,
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks: 4,
    capacity: 6,
    filled: 0,
  });
  const stripe = makeStripeStub();
  const app = classApp(stripe);
  const enrolled = await app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `lock-order-enroll-${randomUUID()}` },
    payload: {
      cohort_id: cohortId,
      dog_ids: [FIXTURE_IDS.dog1Id],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: true,
      allow_partial: true,
    },
  });
  assert.equal(enrolled.statusCode, 201, enrolled.body);
  const [invoice] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.cohortId, cohortId));
  assert.ok(invoice, 'the pay-later enrollment minted its open invoice');
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.cohortId, cohortId));
  assert.ok(rows.length > 0, 'the invoice carries the enrollment');
  return { app, stripe, cohortId, invoiceId: invoice.id, bookingIds: rows.map((r) => r.id) };
}

/** No card named: the invoice's bound card pays, so the settle writes the invoice once. */
function pay(world: ClassWorld, card?: string) {
  return world.app.inject({
    method: 'POST',
    url: `/invoices/${world.invoiceId}/pay`,
    headers: { 'idempotency-key': `lock-order-pay-${randomUUID()}` },
    payload: card === undefined ? {} : { payment_method_id: card },
  });
}

/** A real tender: `processing` through `/pay`, past any earlier tender's lease. */
async function tender(
  world: ClassWorld,
  card?: string,
): Promise<{ chargeId: string; intentId: string }> {
  await db
    .update(charges)
    .set({ attemptingUntil: '2000-01-01T00:00:00Z' })
    .where(eq(charges.cohortId, world.cohortId));
  world.stripe.setNextIntentStatus('processing');
  const res = await pay(world, card);
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { charge_id: string; stripe_payment_intent_id: string };
  const [row] = await db.select().from(charges).where(eq(charges.id, body.charge_id));
  assert.ok(row?.orderId, 'an engine row, on a class invoice');
  return { chargeId: body.charge_id, intentId: body.stripe_payment_intent_id };
}

function withdraw(world: ClassWorld) {
  return world.app.inject({
    method: 'POST',
    url: `/enrollments/${world.cohortId}/withdraw`,
    headers: { 'idempotency-key': `lock-order-withdraw-${randomUUID()}` },
    payload: { dog_id: FIXTURE_IDS.dog1Id },
  });
}

async function cleanUp(world: ClassWorld): Promise<void> {
  const rows = await db
    .select({ id: charges.id })
    .from(charges)
    .where(eq(charges.cohortId, world.cohortId));
  for (const row of rows) await db.delete(refunds).where(eq(refunds.chargeId, row.id));
  await db
    .update(invoices)
    .set({ paidChargeId: null })
    .where(eq(invoices.cohortId, world.cohortId));
  await clearInvoiceReferrers();
  await db.delete(charges).where(eq(charges.cohortId, world.cohortId));
  await db.delete(invoices).where(eq(invoices.cohortId, world.cohortId));
}

function enrollmentRows(world: ClassWorld): { table: string; id: string }[] {
  return [
    { table: 'cohorts', id: world.cohortId },
    ...world.bookingIds.map((id) => ({ table: 'bookings', id })),
    { table: 'invoices', id: world.invoiceId },
  ];
}

/**
 * The charge's other holder got there first. The withdraw must queue on that charge with
 * its cohort held and its bookings and invoice untouched. The cohort comes first because
 * every withdraw takes it first, and that is what stops two withdraws of one dog crossing.
 */
async function otherSideFirst<T>(
  world: ClassWorld,
  chargeId: string,
  then: (tx: Tx) => Promise<T>,
) {
  const first = holdCharge(chargeId, then);
  try {
    const pid = await first.held;
    const withdrawing = withdraw(world);
    const queued = await untilBlockedBy(pid);
    const heldAhead = await rowsHeldNow(enrollmentRows(world));
    first.release();
    const [t1, res] = await Promise.allSettled([first.done, withdrawing]);
    assert.equal(res.status, 'fulfilled');
    return { t1, res: res.value, queuedOn: queued.query, heldAhead };
  } finally {
    first.release();
    await first.done.catch(() => undefined);
  }
}

/**
 * The withdraw got there first. A third connection sits on a booking row, so the real
 * withdraw parks while it cancels bookings, holding its cohort and every charge it knew
 * of, and `act` runs against that. The gate is `NO KEY UPDATE` so that it stops the
 * withdraw and nothing else: a charge's insert takes `KEY SHARE` on its anchor booking.
 */
async function withdrawParked<T>(world: ClassWorld, act: () => Promise<T>) {
  const gate = await holdRow('bookings', world.bookingIds[0]!, 'NO KEY UPDATE');
  let released = false;
  const openGate = async (): Promise<void> => {
    if (released) return;
    released = true;
    await gate.release();
  };
  const withdrawing = withdraw(world);
  try {
    const parked = await untilBlockedBy(gate.pid);
    const acting = act();
    const landed = await Promise.race([
      acting.then(
        () => 'it ran straight through',
        () => 'it ran straight through',
      ),
      untilBlockedBy(parked.pid).then(() => 'it queued behind the withdraw'),
    ]);
    await openGate();
    const [t1, res] = await Promise.allSettled([acting, withdrawing]);
    assert.equal(res.status, 'fulfilled');
    return { t1, res: res.value, landed };
  } finally {
    await openGate();
    await withdrawing.catch(() => undefined);
  }
}

/** The other side holds a charge the withdraw already wanted, so that side queues. */
function withdrawFirst<T>(world: ClassWorld, then: (tx: Tx) => Promise<T>) {
  return withdrawParked(world, () => withActor('worker:lock-order-test', then));
}

function failTheDeadTender(chargeId: string, notice: 'charge-failed' | 'order-cancelled') {
  return (tx: Tx) =>
    failChargeInTx(tx, {
      chargeId,
      blocker: undefined,
      lastError: null,
      notice,
      intentDead: true,
      ...(notice === 'order-cancelled' ? { cancelledBy: 'staff' as const } : {}),
      log: QUIET_LOG,
      now: new Date(),
    });
}

interface Tenders {
  dead: { chargeId: string; intentId: string };
  /** Only on `refunded`: the tender that took the money the withdraw gives back. */
  paid?: { chargeId: string; intentId: string };
}

async function tendersFor(world: ClassWorld, outcome: 'voided' | 'refunded'): Promise<Tenders> {
  const dead = await tender(world);
  world.stripe.setIntentState(dead.intentId, 'canceled');
  if (outcome === 'voided') return { dead };
  const paid = await tender(world);
  world.stripe.setIntentState(paid.intentId, 'succeeded');
  return { dead, paid };
}

/** The money, whoever won: what the withdraw says, and one refund only where one is owed. */
async function assertWithdrawMoney(
  world: ClassWorld,
  tenders: Tenders,
  outcome: 'voided' | 'refunded',
  body: EnrollmentWithdrawResultWire,
): Promise<void> {
  assert.equal(body.money_outcome, outcome);
  assert.equal(await invoiceStatus(world.invoiceId), 'void');
  assert.equal(await chargeStatus(tenders.dead.chargeId), 'failed');
  assert.deepEqual(await refundsOn(tenders.dead.chargeId), [], 'a dead tender owes nothing');
  const sent = world.stripe.calls.filter((c) => c.method === 'createRefund');
  if (tenders.paid === undefined) {
    assert.equal(body.refunded_cents, 0);
    assert.equal(sent.length, 0, 'nothing is owed, so nothing is sent');
    return;
  }
  assert.equal(body.refunded_cents, PUPPY_PRICE_CENTS);
  assert.equal(await chargeStatus(tenders.paid.chargeId), 'succeeded');
  const owed = await refundsOn(tenders.paid.chargeId);
  assert.equal(owed.length, 1, 'exactly one refund row');
  assert.equal(owed[0]?.amountCents, PUPPY_PRICE_CENTS);
  assert.equal(sent.length, 1, 'and exactly one refund sent');
}

for (const notice of ['charge-failed', 'order-cancelled'] as const) {
  for (const outcome of ['voided', 'refunded'] as const) {
    test(
      `the ${notice} failure won, and the withdraw answers ${outcome}: it queued on the charge holding only its cohort, no 40P01`,
      SKIP_WHEN_NO_DB,
      async () => {
        const world = await enrolledOnAnOpenInvoice();
        try {
          const tenders = await tendersFor(world, outcome);

          const { t1, res, queuedOn, heldAhead } = await otherSideFirst(
            world,
            tenders.dead.chargeId,
            failTheDeadTender(tenders.dead.chargeId, notice),
          );

          assertNoDeadlock(t1, res.statusCode);
          assert.match(queuedOn, /"charges"/, 'it waits on the charge row');
          assert.deepEqual(heldAhead, ['cohorts'], 'and holds nothing later in the order');
          assert.equal(t1.status === 'fulfilled' && t1.value.outcome, 'failed', 'the failure won');
          await assertWithdrawMoney(world, tenders, outcome, res.json());
          assert.deepEqual(
            await paymentFailedNotices(),
            [{ trigger: notice }],
            'the invoice was open when it spoke, so the notice was true',
          );
        } finally {
          await cleanUp(world);
        }
      },
    );

    test(
      `the withdraw won against the ${notice} failure, answering ${outcome}: the failure queued behind it and did nothing, no 40P01`,
      SKIP_WHEN_NO_DB,
      async () => {
        const world = await enrolledOnAnOpenInvoice();
        try {
          const tenders = await tendersFor(world, outcome);

          const { t1, res, landed } = await withdrawFirst(
            world,
            failTheDeadTender(tenders.dead.chargeId, notice),
          );

          assert.equal(landed, 'it queued behind the withdraw');
          assertNoDeadlock(t1, res.statusCode);
          assert.equal(t1.status === 'fulfilled' && t1.value.outcome, 'no-op', 'the withdraw won');
          await assertWithdrawMoney(world, tenders, outcome, res.json());
          assert.deepEqual(
            await paymentFailedNotices(),
            [],
            'nobody said anything of a voided debt',
          );
        } finally {
          await cleanUp(world);
        }
      },
    );
  }
}

function settleTheTender(world: ClassWorld, paid: { chargeId: string; intentId: string }) {
  return async (tx: Tx) =>
    settleChargeInTx(tx, {
      chargeId: paid.chargeId,
      live: await world.stripe.retrievePaymentIntent(paid.intentId),
      receiptTrigger: 'settle',
      log: QUIET_LOG,
      now: new Date(),
    });
}

async function assertBookingsCancelled(world: ClassWorld): Promise<void> {
  const rows = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(eq(bookings.cohortId, world.cohortId));
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((row) => row.status === 'cancelled'),
    'the enrollment is gone, whichever side won',
  );
}

test(
  'the settle won against a withdraw on an invoice carrying an enrollment: paid, then refunded once, no 40P01',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = await enrolledOnAnOpenInvoice();
    try {
      const paid = await tender(world);
      world.stripe.setIntentState(paid.intentId, 'succeeded');

      const { t1, res, heldAhead } = await otherSideFirst(
        world,
        paid.chargeId,
        settleTheTender(world, paid),
      );

      assertNoDeadlock(t1, res.statusCode);
      assert.deepEqual(heldAhead, ['cohorts'], 'it held nothing later while it queued');
      assert.equal(t1.status === 'fulfilled' && t1.value.outcome, 'settled', 'the settle won');
      assert.equal(await invoiceStatus(world.invoiceId), 'paid');
      assert.equal(await chargeStatus(paid.chargeId), 'succeeded');
      assert.equal((await receiptsFor(paid.chargeId)).length, 1);
      const body = res.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded');
      assert.equal(body.refunded_cents, PUPPY_PRICE_CENTS);
      const owed = await refundsOn(paid.chargeId);
      assert.equal(owed.length, 1, 'exactly one refund row');
      assert.equal(owed[0]?.amountCents, PUPPY_PRICE_CENTS);
      await assertBookingsCancelled(world);
    } finally {
      await cleanUp(world);
    }
  },
);

test(
  'the withdraw won against a settle on an invoice carrying an enrollment: void, refunded once, no receipt, no 40P01',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = await enrolledOnAnOpenInvoice();
    try {
      const paid = await tender(world);
      world.stripe.setIntentState(paid.intentId, 'succeeded');

      const { t1, res, landed } = await withdrawFirst(world, settleTheTender(world, paid));

      assert.equal(landed, 'it queued behind the withdraw');
      assertNoDeadlock(t1, res.statusCode);
      assert.equal(t1.status === 'fulfilled' && t1.value.outcome, 'no-op', 'the withdraw won');
      assert.equal(await invoiceStatus(world.invoiceId), 'void');
      assert.equal(await chargeStatus(paid.chargeId), 'succeeded', 'the money did move');
      assert.deepEqual(await receiptsFor(paid.chargeId), [], 'and it was never a settled receipt');
      const body = res.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded');
      assert.equal(body.refunded_cents, PUPPY_PRICE_CENTS);
      const owed = await refundsOn(paid.chargeId);
      assert.equal(owed.length, 1, 'exactly one refund row');
      assert.equal(owed[0]?.amountCents, PUPPY_PRICE_CENTS);
      await assertBookingsCancelled(world);
    } finally {
      await cleanUp(world);
    }
  },
);

test(
  'the money-back arm takes its charge ahead of the bookings too: a settled charge the pre-tx phase never saw',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = await enrolledOnAnOpenInvoice();
    try {
      const paid = await tender(world);
      world.stripe.setIntentState(paid.intentId, 'succeeded');
      await withActor('worker:lock-order-test', settleTheTender(world, paid));
      assert.equal(await invoiceStatus(world.invoiceId), 'paid', 'nothing is left to void');

      const { t1, res, landed } = await withdrawFirst(world, (tx) => lockCharge(tx, paid.chargeId));

      assert.equal(landed, 'it queued behind the withdraw');
      assertNoDeadlock(t1, res.statusCode);
      const body = res.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded');
      assert.equal(body.refunded_cents, PUPPY_PRICE_CENTS);
      const owed = await refundsOn(paid.chargeId);
      assert.equal(owed.length, 1, 'exactly one refund row');
      assert.equal(owed[0]?.amountCents, PUPPY_PRICE_CENTS);
      await assertBookingsCancelled(world);
    } finally {
      await cleanUp(world);
    }
  },
);

// ── the lock no statement asks for ──────────────────────────────────────────

async function seedSecondCard(): Promise<string> {
  await db
    .insert(paymentMethods)
    .values({
      id: SECOND_CARD_ID,
      ownerId: FIXTURE_IDS.ownerId,
      stripePaymentMethodId: 'pm_fixture_test_mastercard',
      brand: 'mastercard',
      last4: '8203',
      expMonth: 11,
      expYear: 2031,
      cardholderName: 'Allison Fixture',
      isDefault: false,
    })
    .onConflictDoNothing();
  return SECOND_CARD_ID;
}

/** The money, once the withdraw lost the invoice to a settle: paid, then all of it back. */
async function assertPaidThenRefundedOnce(
  world: ClassWorld,
  chargeId: string,
  body: EnrollmentWithdrawResultWire,
): Promise<void> {
  assert.equal(await invoiceStatus(world.invoiceId), 'paid');
  assert.equal(await chargeStatus(chargeId), 'succeeded');
  assert.equal((await receiptsFor(chargeId)).length, 1, 'she heard the charge, once');
  assert.equal(body.money_outcome, 'refunded');
  assert.equal(body.refunded_cents, PUPPY_PRICE_CENTS);
  const owed = await refundsOn(chargeId);
  assert.equal(owed.length, 1, 'exactly one refund row');
  assert.equal(owed[0]?.amountCents, PUPPY_PRICE_CENTS);
  const sent = world.stripe.calls.filter((c) => c.method === 'createRefund');
  assert.equal(sent.length, 1, 'and exactly one refund sent');
  await assertBookingsCancelled(world);
  assert.equal(await seatsTaken(world.cohortId), 0, 'the seat came back, once');
}

test(
  'a settle on another card won against a withdraw: its second write of the invoice re-checks the cohort FK, no 40P01, paid, then refunded once',
  SKIP_WHEN_NO_DB,
  async () => {
    // The FK re-check is not a statement, so nothing here can see it asked. A row this
    // transaction already wrote re-checks every FK on its next UPDATE, which takes
    // `KEY SHARE` on the cohort while the withdraw holds the cohort and waits on this charge.
    const world = await enrolledOnAnOpenInvoice();
    try {
      const card = await seedSecondCard();
      const paid = await tender(world, card);
      world.stripe.setIntentState(paid.intentId, 'succeeded');

      const { t1, res, heldAhead } = await otherSideFirst(
        world,
        paid.chargeId,
        settleTheTender(world, paid),
      );

      assertNoDeadlock(t1, res.statusCode);
      assert.deepEqual(heldAhead, ['cohorts'], 'the cohort is the row the settle will ask about');
      assert.equal(t1.status === 'fulfilled' && t1.value.outcome, 'settled', 'the settle won');
      assert.equal(await invoiceCard(world.invoiceId), card, 'repointed to the card that paid');
      await assertPaidThenRefundedOnce(world, paid.chargeId, res.json());
    } finally {
      await cleanUp(world);
    }
  },
);

test(
  "a new tender's /pay against a withdraw holding its cohort: tx1's insert of cohort_id passes it, no 40P01, paid, then refunded once",
  SKIP_WHEN_NO_DB,
  async () => {
    // tx1 holds the invoice when its charge insert asks for `KEY SHARE` on the cohort, and
    // the withdraw holds the cohort on its way to the invoice.
    const world = await enrolledOnAnOpenInvoice();
    try {
      const { t1, res, landed } = await withdrawParked(world, () => pay(world));

      assert.ok(t1.status === 'fulfilled');
      assert.equal(t1.value.statusCode, 201, `/pay answered: a 500 is 40P01. ${t1.value.body}`);
      assert.equal(res.statusCode, 200, `the withdraw answered: a 500 is 40P01. ${res.body}`);
      assert.equal(landed, 'it ran straight through', 'neither one waits for the other');
      const { charge_id: chargeId } = t1.value.json() as { charge_id: string };
      await assertPaidThenRefundedOnce(world, chargeId, res.json());
    } finally {
      await cleanUp(world);
    }
  },
);

test(
  'two withdraws of one dog still serialise on the cohort: the second waits there, then 409, the seat released once',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = await enrolledOnAnOpenInvoice();
    try {
      const gate = await holdRow('bookings', world.bookingIds[0]!, 'NO KEY UPDATE');
      const first = withdraw(world);
      let second: ReturnType<typeof withdraw>;
      let queuedOn: string;
      try {
        const parked = await untilBlockedBy(gate.pid);
        second = withdraw(world);
        queuedOn = (await untilBlockedBy(parked.pid)).query;
      } finally {
        await gate.release();
      }
      const answers = await Promise.all([first, second]);
      assert.match(queuedOn, /from "cohorts"/, 'the cohort lock conflicts with itself');
      assert.deepEqual(answers.map((res) => res.statusCode).sort(), [200, 409]);
      assert.equal(await invoiceStatus(world.invoiceId), 'void');
      assert.equal(await seatsTaken(world.cohortId), 0, 'one seat, released once');
    } finally {
      await cleanUp(world);
    }
  },
);
