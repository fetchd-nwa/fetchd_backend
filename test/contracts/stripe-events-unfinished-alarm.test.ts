import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test, type TestContext } from 'node:test';
import { eq, like, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import Stripe from 'stripe';
import { registerAuth } from '../../src/auth/plugin.js';
import { db } from '../../src/db/client.js';
import { stripeEvents } from '../../src/db/schema/schema.js';
import { env } from '../../src/env.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import { SKIP_WHEN_NO_DB, makeLogCapture, registerFixtureHooks, type LogCapture } from './_harness.js';
import { appOf, clearRefundWorld, deliver, plantCharge, plantRefundRow, world } from './_refundWorld.js';
import { FIXTURE_OWNER_ROLE_PRINCIPAL } from './_harness.js';
import { signedIntentEvent, signedRefundEvent } from './_signedEvents.js';

/**
 * P22 B-8: the unfinished-claim alarm (`brief_must_say` 3; DECISIONS 174(b); Pace 8.1
 * finding 2). A first delivery that dies between its `stripe_events` claim and its handler
 * answers `duplicate` on every redelivery wherever `redispatchUnfinishedEvent` does not
 * re-run it (`requestConfirmPayment.ts:168`, `enrollmentPartial.ts:418` and `:546` until
 * `POST /enrollments` joins the engine), so the charge never flips and nobody is told.
 * Proven through the production entry, `POST /workers/tick` with the route's own logger,
 * never an injected logger; the bound is on Postgres's clock, so the tests move
 * `received_at` (planted by SQL) rather than a process clock. Stripe is offline at the SDK.
 */

registerFixtureHooks();

afterEach(async () => {
  await db.delete(stripeEvents).where(like(stripeEvents.eventId, 'evt_test_%'));
  await clearRefundWorld();
});

const KILL_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '_packKillChild.ts');
const TICK_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '_tickChild.ts');

function blockStripeSdk(t: TestContext): void {
  const probe = new Stripe('sk_test_b8_offline');
  const offline = (): Promise<never> =>
    Promise.reject(new Stripe.errors.StripeConnectionError({ message: 'no network in tests' }));
  for (const resource of [probe.paymentIntents, probe.refunds, probe.customers, probe.paymentMethods, probe.setupIntents]) {
    const proto = Object.getPrototypeOf(resource) as Record<string, (...args: never[]) => unknown>;
    for (const verb of ['create', 'retrieve', 'list', 'cancel', 'capture', 'confirm', 'update', 'detach']) {
      if (typeof proto[verb] === 'function') t.mock.method(proto, verb, offline);
    }
  }
}

function tickApp(capture: LogCapture) {
  const app = Fastify({ logger: { level: 'info', stream: capture.stream } });
  registerAuth(app);
  registerWorkersTickRoute(app);
  return app;
}

async function tick(app: ReturnType<typeof tickApp>): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  assert.equal(res.statusCode, 200, res.body);
}

/** Planted by SQL: the claim was received `seconds` ago, on Postgres's clock. */
async function receivedAgo(eventId: string, seconds: number): Promise<void> {
  await db
    .update(stripeEvents)
    .set({ receivedAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(stripeEvents.eventId, eventId));
}

const naming = (capture: LogCapture, eventId: string, level?: number) =>
  capture.lines.filter(
    (l) =>
      l.workerTick === 'stripe-events-unfinished' &&
      (level === undefined || l.level === level) &&
      ((l.eventId === eventId) || (Array.isArray(l.events) && (l.events as { eventId: string }[]).some((e) => e.eventId === eventId))),
  );

test(
  'a real kill between claim and handler on a payment_intent.succeeded: one line at fifteen minutes and none at fourteen, then the count; a second process names it once more, then counts',
  SKIP_WHEN_NO_DB,
  async (t) => {
    blockStripeSdk(t);
    const event = signedIntentEvent({
      type: 'payment_intent.succeeded',
      intentId: `pi_test_p22b8_${randomUUID().replace(/-/g, '')}`,
      amountCents: 12000,
      metadata: {},
    });
    const killed = spawnSync(process.execPath, ['--import', 'tsx', KILL_CHILD, 'claim', event.payload, event.signature], {
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(killed.signal, 'SIGKILL', `the child must die, not exit: ${killed.stdout} ${killed.stderr}`);
    const [claim] = await db.select().from(stripeEvents).where(eq(stripeEvents.eventId, event.id));
    assert.ok(claim, 'the claim committed before the death');
    assert.equal(claim.processedAt, null, 'and nothing finished it');

    const capture = makeLogCapture();
    const app = tickApp(capture);
    await receivedAgo(event.id, 14 * 60);
    await tick(app);
    assert.equal(naming(capture, event.id).length, 0, 'fourteen minutes: no line');

    await receivedAgo(event.id, 15 * 60 + 1);
    await tick(app);
    const lines = naming(capture, event.id, 50);
    assert.equal(lines.length, 1, JSON.stringify(capture.lines.filter((l) => l.workerTick === 'stripe-events-unfinished')));
    assert.equal(lines[0]!.eventId, event.id);
    assert.equal(lines[0]!.eventType, 'payment_intent.succeeded');
    assert.ok(lines[0]!.receivedAt, 'names when it was received');
    assert.match(String(lines[0]!.msg), /received and never finished/);
    assert.match(String(lines[0]!.msg), /repeats once after each restart/);
    const complete = capture.lines.filter((l) => l.msg === 'scheduler tick complete');
    assert.ok(Number(complete.at(-1)!.stripeEventsUnfinished) >= 1, 'the tick line carries the count');

    await tick(app);
    assert.equal(naming(capture, event.id, 50).length, 1, 'never a line per tick');
    assert.ok(
      capture.lines.some((l) => l.workerTick === 'stripe-events-unfinished' && l.level === 30 && Number(l.unfinishedCount) >= 1),
      'a count at info after',
    );

    const second = spawnSync(process.execPath, ['--import', 'tsx', TICK_CHILD, '2'], { encoding: 'utf8', env: process.env });
    assert.equal(second.status, 0, second.stderr);
    const out = JSON.parse(second.stdout.trim().split('\n').at(-1)!) as { statuses: number[]; lines: Record<string, unknown>[] };
    assert.deepEqual(out.statuses, [200, 200]);
    const again = out.lines.filter((l) => l.level === 50 && l.eventId === event.id);
    assert.equal(again.length, 1, 'a new process names it once more');
    assert.ok(out.lines.some((l) => l.workerTick === 'stripe-events-unfinished' && l.level === 30), 'then counts');
  },
);

test(
  'it must not fire on a delivery still running: a handler held open by the stub, the tick beside it at received_at + 1 minute',
  SKIP_WHEN_NO_DB,
  async (t) => {
    blockStripeSdk(t);
    const w = world();
    const c = await plantCharge(w.stripe, { amountCents: 6000 });
    const re = w.stripe.plantRefund({ paymentIntentId: c.paymentIntentId, amountCents: 6000, status: 'succeeded' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const held = new Promise<void>((resolve) => (reached = resolve));
    w.stripe.afterNextRefundRetrieve(async () => {
      reached();
      await gate;
    });
    const event = signedRefundEvent({ type: 'refund.updated', refundId: re, paymentIntentId: c.paymentIntentId, amountCents: 6000, status: 'succeeded' });
    const running = deliver(appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w), event);
    await held;
    await receivedAgo(event.id, 60);
    const capture = makeLogCapture();
    await tick(tickApp(capture));
    assert.equal(naming(capture, event.id).length, 0, 'a delivery still running is never named');
    release();
    assert.equal((await running).statusCode, 200);
  },
);

test('nor on a released claim, nor on a processed row', SKIP_WHEN_NO_DB, async (t) => {
  blockStripeSdk(t);
  const w = world();
  const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
  // Released: a refund naming one of our rows, on a PaymentIntent no charge names, throws,
  // and the claim is deleted. (Before P22 fix 1 any refund on such a PaymentIntent threw;
  // since Opus r1 L3 one naming none of ours is answered 200 and its claim finished.)
  const c = await plantCharge(w.stripe, { amountCents: 6000 });
  const ours = await plantRefundRow({ chargeId: c.chargeId, amountCents: 100, status: 'pending', stripeIdempotencyKey: `p22fix1-${randomUUID()}` });
  const re = w.stripe.plantRefund({ paymentIntentId: `pi_test_nobody_${randomUUID().slice(0, 8)}`, amountCents: 100, status: 'succeeded', metadata: { refund_id: ours } });
  const released = signedRefundEvent({ type: 'refund.updated', refundId: re, paymentIntentId: null, amountCents: 100, status: 'succeeded', refundRowId: ours });
  assert.equal((await deliver(app, released)).statusCode, 500);
  assert.equal((await db.select().from(stripeEvents).where(eq(stripeEvents.eventId, released.id))).length, 0);
  // Processed: a type with no handler is marked processed; then it is made old.
  const processed = signedIntentEvent({ type: 'payment_intent.canceled', intentId: `pi_test_p22b8_${randomUUID().slice(0, 8)}`, amountCents: 100, metadata: {} });
  assert.equal((await deliver(app, processed)).statusCode, 200);
  await receivedAgo(processed.id, 20 * 60);
  const capture = makeLogCapture();
  await tick(tickApp(capture));
  assert.equal(naming(capture, released.id).length, 0);
  assert.equal(naming(capture, processed.id).length, 0);
});
