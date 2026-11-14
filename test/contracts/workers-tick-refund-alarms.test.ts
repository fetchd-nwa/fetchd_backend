import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import Stripe from 'stripe';
import { registerAuth } from '../../src/auth/plugin.js';
import { env } from '../../src/env.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, makeLogCapture, registerFixtureHooks } from './_harness.js';
import { clearRefundWorld, plantCharge, plantRefundRow, refundRows, rowOf } from './_refundWorld.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * P22 B-7's alarms through the PRODUCTION entry (the brief's Rules: "an alarm is proven
 * through the production entry, `POST /workers/tick` for tick phases"): the real route, no
 * `runTick` fake, the app's own logger captured, the real `defaultStripeClient`, with
 * Stripe answered at the SDK's shared prototypes (`workers-tick-alarms.test.ts`'s
 * technique). That also proves the seam reads Stripe's replay header off a THROWN error
 * (`stripeErrorReplayed`, `err.headers`), which the stub cannot. Every other verb rejects,
 * so the tick reaches no network.
 */

registerFixtureHooks();
afterEach(async () => {
  await clearRefundWorld();
});

const HOUR = 60 * 60 * 1000;

function answerStripe(
  t: TestContext,
  byKey: Map<string, () => Promise<unknown>>,
  /** What `refunds.list` answers per PaymentIntent (none listed when absent). */
  listed: Map<string, unknown[]> = new Map(),
): void {
  const probe = new Stripe('sk_test_p22_tick_alarms');
  const offline = (): Promise<never> =>
    Promise.reject(new Stripe.errors.StripeConnectionError({ message: 'no network in tests' }));
  for (const resource of [probe.paymentIntents, probe.customers, probe.paymentMethods, probe.setupIntents]) {
    const proto = Object.getPrototypeOf(resource) as Record<string, (...args: never[]) => unknown>;
    for (const verb of ['create', 'retrieve', 'list', 'cancel', 'capture', 'confirm', 'update', 'detach']) {
      if (typeof proto[verb] === 'function') t.mock.method(proto, verb, offline);
    }
  }
  const refunds = Object.getPrototypeOf(probe.refunds) as Record<string, (...args: never[]) => unknown>;
  t.mock.method(refunds, 'create', ((_params: unknown, options: { idempotencyKey: string }) => {
    const answer = byKey.get(options.idempotencyKey) ?? [...byKey.entries()].find(([k]) => options.idempotencyKey.startsWith(k))?.[1];
    return answer !== undefined ? answer() : offline();
  }) as never);
  t.mock.method(refunds, 'list', ((params: { payment_intent: string }) =>
    Promise.resolve({ object: 'list', data: listed.get(params.payment_intent) ?? [], has_more: false })) as never);
  t.mock.method(refunds, 'retrieve', offline);
}

const storedServerError = () =>
  Promise.reject(
    new Stripe.errors.StripeAPIError({
      type: 'api_error',
      message: 'An unknown error occurred',
      statusCode: 500,
      headers: { 'idempotent-replayed': 'true' },
    } as never),
  );
const refusedOverRefund = () =>
  Promise.reject(
    new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      message: 'Refund amount ($60.00) is greater than unrefunded amount on charge ($20.00)',
      statusCode: 400,
      headers: {},
    } as never),
  );

test(
  "POST /workers/tick: a stored 5xx, a refusal and a row past the key window each reach the route's logger once",
  SKIP_WHEN_NO_DB,
  async (t) => {
    const stub = makeStripeStub();
    const ago = (ms: number) => new Date(Date.now() - ms);
    const c1 = await plantCharge(stub, { amountCents: 6000 });
    const c2 = await plantCharge(stub, { amountCents: 6000 });
    const c3 = await plantCharge(stub, { amountCents: 6000 });
    const k1 = `p22-tick-a-${randomUUID()}:refund`;
    const k2 = `p22-tick-b-${randomUUID()}:refund`;
    // Planted by SQL: three of Shanthi's refunds, each past the retry lane's 5-minute rest.
    const stored = await plantRefundRow({ chargeId: c1.chargeId, amountCents: 6000, status: 'pending', issuedByStaffId: FIXTURE_IDS.staffShanthiId, stripeIdempotencyKey: k1, createdAt: ago(10 * 60 * 1000) });
    const refused = await plantRefundRow({ chargeId: c2.chargeId, amountCents: 6000, status: 'pending', issuedByStaffId: FIXTURE_IDS.staffShanthiId, stripeIdempotencyKey: k2, createdAt: ago(10 * 60 * 1000) });
    const rekeyed = randomUUID();
    const oldKey = `refund-rekey:${rekeyed}:${Math.floor((Date.now() - 25 * HOUR) / 1000)}`;
    await plantRefundRow({ chargeId: c3.chargeId, amountCents: 6000, status: 'pending', issuedByStaffId: FIXTURE_IDS.staffShanthiId, stripeIdempotencyKey: oldKey, createdAt: ago(25 * HOUR) }).then(async (id) => {
      // The planted id is the database's; the key must name the row, so plant again by id.
      const { db } = await import('../../src/db/client.js');
      const { refunds } = await import('../../src/db/schema/schema.js');
      const { eq } = await import('drizzle-orm');
      await db.delete(refunds).where(eq(refunds.id, id));
      await db.insert(refunds).values({
        id: rekeyed,
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: c3.chargeId,
        amountCents: 6000,
        status: 'pending',
        reason: 'planted',
        issuedByStaffId: FIXTURE_IDS.staffShanthiId,
        stripeIdempotencyKey: oldKey,
        createdAt: ago(25 * HOUR).toISOString(),
        updatedAt: ago(2 * HOUR).toISOString(),
      });
    });
    answerStripe(
      t,
      new Map<string, () => Promise<unknown>>([
        [k1, storedServerError],
        [`refund-rekey:${stored}:`, storedServerError],
        [k2, refusedOverRefund],
      ]),
    );

    const capture = makeLogCapture();
    const app = Fastify({ logger: { level: 'info', stream: capture.stream } });
    registerAuth(app);
    registerWorkersTickRoute(app);
    const res = await app.inject({
      method: 'POST',
      url: '/workers/tick',
      headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
    });
    assert.equal(res.statusCode, 200, res.body);

    const errors = capture.lines.filter((l) => l.level === 50);
    const one = (moneyEvent: string, refundId: string) =>
      errors.filter((l) => l.moneyEvent === moneyEvent && l.refundId === refundId);
    assert.equal(one('refund-key-stored-error', stored).length, 1, JSON.stringify(errors.map((l) => [l.moneyEvent, l.refundId])));
    assert.equal(one('refund-refused-at-create', refused).length, 1);
    assert.equal(one('refund-unsent-past-key-window', rekeyed).length, 1);
    assert.equal((await rowOf(refused)).status, 'failed');
    assert.equal((await rowOf(rekeyed)).status, 'failed');
    const storedRow = await rowOf(stored);
    assert.equal(storedRow.status, 'pending');
    assert.ok(storedRow.stripeIdempotencyKey?.startsWith(`refund-rekey:${stored}:`), 'sent once under a fresh key');
    const complete = capture.lines.find((l) => l.msg === 'scheduler tick complete')!;
    assert.equal(complete.duplicateRefundRetryRefused, 1);
    assert.ok(Number(complete.duplicateRefundRetryEndedFailed) >= 1);
  },
);

test(
  "POST /workers/tick: Shanthi's $30.00 refund, never reached, past the key window, whose PaymentIntent holds a $10.00 refund carrying its id → the amount line and the row's end-state line each reach the route's logger once; the $10.00 is its own row and the row ends failed (Opus r2 L2)",
  SKIP_WHEN_NO_DB,
  async (t) => {
    const stub = makeStripeStub();
    const ago = (ms: number) => new Date(Date.now() - ms);
    const c = await plantCharge(stub, { amountCents: 6000 });
    // Planted by SQL: every send lost, the last one a key window and a minute ago.
    const id = await plantRefundRow({ chargeId: c.chargeId, amountCents: 3000, status: 'pending', issuedByStaffId: FIXTURE_IDS.staffShanthiId, stripeIdempotencyKey: `p22fix2-tick-${randomUUID()}:refund`, createdAt: ago(25 * HOUR), updatedAt: ago(24 * HOUR + 60 * 1000) });
    const forged = `re_p22fix2${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    answerStripe(
      t,
      new Map(),
      new Map([[c.paymentIntentId, [{ id: forged, object: 'refund', amount: 1000, status: 'succeeded', payment_intent: c.paymentIntentId, metadata: { refund_id: id } }]]]),
    );

    const capture = makeLogCapture();
    const app = Fastify({ logger: { level: 'info', stream: capture.stream } });
    registerAuth(app);
    registerWorkersTickRoute(app);
    const res = await app.inject({
      method: 'POST',
      url: '/workers/tick',
      headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
    });
    assert.equal(res.statusCode, 200, res.body);

    const errors = capture.lines.filter((l) => l.level === 50);
    const one = (moneyEvent: string) => errors.filter((l) => l.moneyEvent === moneyEvent && l.refundId === id);
    assert.equal(one('refund-metadata-names-row-other-amount').length, 1, JSON.stringify(errors.map((l) => [l.moneyEvent, l.refundId])));
    assert.equal(one('refund-metadata-names-row-other-amount')[0]!.stripeRefundId, forged);
    assert.equal(one('refund-unsent-past-key-window').length, 1);
    const row = await rowOf(id);
    assert.deepEqual([row.status, row.stripeRefundId], ['failed', null], 'Stripe holds nothing for the $30.00 row');
    const own = (await refundRows(c.chargeId)).find((x) => x.stripeRefundId === forged);
    assert.deepEqual([own?.amountCents, own?.status, own?.reason], [1000, 'succeeded', 'out-of-band']);
  },
);
