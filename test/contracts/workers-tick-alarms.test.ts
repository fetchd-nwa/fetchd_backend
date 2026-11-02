import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import Stripe from 'stripe';
import { registerAuth } from '../../src/auth/plugin.js';
import { db } from '../../src/db/client.js';
import { notificationsRepository } from '../../src/db/repositories/notificationsRepository.js';
import {
  charges as chargesTable,
  cohorts as cohortsTable,
  invoices as invoicesTable,
  refunds as refundsTable,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { env } from '../../src/env.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { initObservability } from '../../src/lib/observability.js';
import { SCHEDULER_PARKED_TOTAL_KEY } from '../../src/lib/schedulerHeartbeat.js';
import { redis } from '../../src/redis.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import { buildApp } from '../../src/server.js';
import { scheduledNotificationsRepository } from '../../src/db/repositories/scheduledNotificationsRepository.js';
import { MAX_DELIVERY_ATTEMPTS, type SchedulerTickResult } from '../../src/workers/scheduler.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * **The alarm channel of the PRODUCTION worker entrypoint.**
 *
 * `scheduler-worker.test.ts` proves the tick raises its alarms when a logger is
 * handed to `runSchedulerTickOnce` directly — and that is exactly the shape
 * production does NOT use. Production is `pg_cron` → `POST /workers/tick` →
 * the route's own `runTick` closure, and every alarm the reconciler raises
 * (LOST HOLD, ABANDONED ENROLLMENT HOLDS, POST-WITHDRAW REFUND, SURPLUS
 * REFUND) resolves through `scheduler.ts` `opts.log ?? NOOP_LOG`. A route that
 * never passes `log` therefore moves an owner's money unattended and prints
 * nothing — which is what the 2026-08-24 adversary demonstrated with a 12000c
 * surplus refund.
 *
 * So the contract this file pins is not "the worker can log" but **"the
 * production call shape produces alarm output"**: the real route, registered
 * the way `server.ts:100` registers it (no `runTick` fake, no injected
 * clients), driven over HTTP with the scheduler bearer, with the app's own
 * logger writing to a capture stream. The money assertion sits BEFORE the
 * alarm assertion on purpose — if the fixture ever stops reaching the surplus
 * arm, this test must fail as "the money did not move", never as a silent
 * false green on "no alarm expected".
 *
 * Stripe is reached at the SDK seam rather than through an injected client,
 * because the route deliberately has no `stripe` opt — the same technique, and
 * the same shared-prototype reasoning, as `test/stripeSeam.test.ts`.
 */

registerFixtureHooks();

/** The enrollment price the fixture cohort charges, in cents. */
const PRICE = 12_000;

interface SurplusState {
  cohortId: string;
  holdId: string;
  paymentIntentId: string;
}

/**
 * Stage the one state the reconciler answers with a SURPLUS REFUND: a live
 * enrollment whose uncaptured hold succeeded ANYWAY, on a class whose money was
 * already collected by a different charge. Past the capture grace window so the
 * tick's claim scoops it.
 *
 * Built through the real `POST /enrollments` (with a stub Stripe, the seam that
 * route does expose) so the charge row is minted by production code rather than
 * hand-assembled.
 */
async function buildSurplusState(): Promise<SurplusState> {
  const cohortId = randomUUID();
  await db.insert(cohortsTable).values({
    id: cohortId,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate: '2026-07-06T23:00:00Z',
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks: 4,
    capacity: 6,
    filled: 0,
  });

  const stripe = makeStripeStub();
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });

  // The capture fails, so the enrollment lands with an uncaptured hold.
  stripe.throwOnCapture(2);
  const enrolled = await app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `wt-alarm-${randomUUID()}` },
    payload: {
      cohort_id: cohortId,
      dog_ids: [FIXTURE_IDS.dog1Id],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: false,
      allow_partial: true,
    },
  });
  assert.equal(enrolled.statusCode, 201, enrolled.body);

  const [hold] = await db
    .select({
      id: chargesTable.id,
      paymentIntentId: chargesTable.stripePaymentIntentId,
      bookingId: chargesTable.bookingId,
    })
    .from(chargesTable)
    .where(
      sql`${chargesTable.cohortId} = ${cohortId} AND ${chargesTable.status} = 'requires_payment'`,
    );
  assert.ok(hold !== undefined, 'the enrollment must leave one uncaptured hold behind');
  assert.ok(hold.paymentIntentId !== null, 'the hold must carry a PaymentIntent');

  // Money collected elsewhere on the same enrollment ⇒ this hold is a true
  // duplicate, which is the branch that refunds rather than settles.
  await db.insert(chargesTable).values({
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentIntentId: `pi_other_${randomUUID().slice(0, 8)}`,
    amountCents: PRICE,
    status: 'succeeded',
    purpose: 'group-class',
    cohortId,
    dogId: FIXTURE_IDS.dog1Id,
    bookingId: hold.bookingId,
  });

  // Past the grace window, so `claimPendingGroupClassCaptures` picks it up.
  await db
    .update(chargesTable)
    .set({
      createdAt: sql`now() - interval '30 minutes'`,
      updatedAt: sql`now() - interval '30 minutes'`,
    })
    .where(eq(chargesTable.id, hold.id));

  return { cohortId, holdId: hold.id, paymentIntentId: hold.paymentIntentId };
}

/**
 * Drop what THIS test minted on its ad-hoc cohort. Owner-scoped rows
 * (notifications, scheduled_notifications, bookings) are deliberately left to
 * `teardownFixture`, which already drops them in the one FK order that works —
 * `scheduled_notifications` before `notifications`, per its Day-16 note.
 */
async function cleanup(cohortId: string): Promise<void> {
  const rows = await db
    .select({ id: chargesTable.id })
    .from(chargesTable)
    .where(eq(chargesTable.cohortId, cohortId));
  for (const row of rows) {
    await db.delete(refundsTable).where(eq(refundsTable.chargeId, row.id));
  }
  await db
    .update(invoicesTable)
    .set({ paidChargeId: null })
    .where(eq(invoicesTable.cohortId, cohortId));
  await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohortId));
  await db.delete(chargesTable).where(eq(chargesTable.cohortId, cohortId));
}

/**
 * Answer the tick's Stripe calls at the SDK, since `/workers/tick` exposes no
 * `stripe` seam — that absence is the point of this file, not an oversight to
 * route around. stripe-node builds every client's resources from one shared
 * per-resource prototype (asserted below), so mocking there reaches the
 * module-private singleton `defaultStripeClient` uses.
 *
 * Only the surplus row's PaymentIntent answers `succeeded`; every other verb
 * rejects, so this tick cannot reach the network no matter what else the
 * fixture leaves lying around, and each phase's log-and-swallow boundary
 * absorbs it.
 */
function mockStripeSdk(t: TestContext, succeededIntentId: string): void {
  const probe = new Stripe('sk_test_workers_tick_alarms');
  const paymentIntents = Object.getPrototypeOf(probe.paymentIntents) as Record<
    string,
    (...args: never[]) => unknown
  >;
  const refunds = Object.getPrototypeOf(probe.refunds) as Record<
    string,
    (...args: never[]) => unknown
  >;
  assert.equal(
    Object.getPrototypeOf(new Stripe('sk_test_other').paymentIntents),
    paymentIntents,
    'the shared-prototype assumption this mock rests on',
  );

  const offline = (): Promise<never> =>
    Promise.reject(new Stripe.errors.StripeConnectionError({ message: 'no network in tests' }));

  t.mock.method(paymentIntents, 'retrieve', (id: string) => {
    if (id !== succeededIntentId) return offline();
    return Promise.resolve({
      id,
      status: 'succeeded',
      client_secret: `${id}_secret_test`,
      amount: PRICE,
      created: Math.floor(Date.now() / 1000),
      metadata: {},
    });
  });
  t.mock.method(refunds, 'create', (params: { amount: number }) =>
    Promise.resolve({
      id: `re_test_${randomUUID().slice(0, 8)}`,
      status: 'succeeded',
      amount: params.amount,
    }),
  );
  t.mock.method(paymentIntents, 'create', offline);
  t.mock.method(paymentIntents, 'capture', offline);
  t.mock.method(paymentIntents, 'cancel', offline);
}

test(
  'POST /workers/tick — the SURPLUS REFUND alarm reaches the operator log on the production path',
  SKIP_WHEN_NO_DB,
  async (t) => {
    const state = await buildSurplusState();
    // `t.after` rather than try/finally: a cleanup throw is reported as its own
    // hook failure instead of replacing the assertion that actually fired.
    t.after(() => cleanup(state.cohortId));
    const capture = makeLogCapture();
    mockStripeSdk(t, state.paymentIntentId);

    // Exactly `server.ts:100` — no `runTick`, no clients, nothing this test
    // gets to choose. The logger runs at 'info', production's default
    // LOG_LEVEL (env.ts, .env), so an alarm demoted below what production
    // actually prints goes red HERE; only the destination deviates.
    const app = Fastify({ logger: { level: 'info', stream: capture.stream } });
    registerAuth(app);
    registerWorkersTickRoute(app);

    const response = await app.inject({
      method: 'POST',
      url: '/workers/tick',
      headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
    });
    assert.equal(response.statusCode, 200, response.body);

    // FIRST: the money actually moved on this path. If this ever goes red the
    // fixture stopped reaching the surplus arm and the alarm assertion below
    // would be meaningless rather than passing.
    const result = JSON.parse(response.body) as SchedulerTickResult;
    assert.equal(
      result.captureReconciler.refundedSurplus,
      1,
      `the tick must take the surplus arm; got ${JSON.stringify(result.captureReconciler)}`,
    );
    const minted = await db
      .select({ amountCents: refundsTable.amountCents })
      .from(refundsTable)
      .where(eq(refundsTable.chargeId, state.holdId));
    assert.equal(minted.length, 1, 'one refund minted for the duplicated hold');
    assert.equal(minted[0]?.amountCents, PRICE);

    // THEN: and a human was told. This is the assertion the NOOP_LOG defect
    // fails — 12000c returned to an owner with zero operator-facing output.
    const alarms = capture.lines.filter(
      (line) => typeof line['msg'] === 'string' && line['msg'].includes('SURPLUS REFUND'),
    );
    assert.equal(
      alarms.length,
      1,
      `the production tick moved ${PRICE}c with no 'SURPLUS REFUND' line — either the alarm ` +
        `channel is dead (the NOOP_LOG regression) or the alarm text drifted from the substring ` +
        `this filter pins; captured lines: ${JSON.stringify(
          capture.lines.map((line) => line['msg']),
        )}`,
    );
    assert.equal(alarms[0]?.['chargeId'], state.holdId, 'the alarm must name the charge');
    assert.equal(alarms[0]?.['amountCents'], PRICE, 'the alarm must name the money');
    assert.ok(
      typeof alarms[0]?.['refundId'] === 'string',
      'the alarm must name the refund it fired',
    );
    // Pino error = 50. The design's "loud-once ERROR" sentences and any
    // log-based paging key off the level, so a demotion is a regression even
    // while the message text still prints.
    assert.ok(
      typeof alarms[0]?.['level'] === 'number' && alarms[0]['level'] >= 50,
      `the alarm must stay an ERROR (pino >= 50); got level ${String(alarms[0]?.['level'])}`,
    );
    // request.log, not app.log: the reqId binding is what ties the alarm to
    // its "scheduler tick complete" line when a human reads the log back.
    assert.equal(
      typeof alarms[0]?.['reqId'],
      'string',
      'the alarm must ride the request logger and carry its reqId',
    );
  },
);


// ── phase-1 boundary on the production path (2026-09-03) ────────────────────
// `scheduler-worker.test.ts` proves the boundary exists when a logger is handed
// to `runSchedulerTickOnce` directly. This proves the alarm it raises reaches
// the OPERATOR LOG at error level through the real route — the shape production
// uses — and that the route still answers 200, which is what keeps pg_cron from
// stacking retries. Proven RED first: before the boundary, the route answered
// 500 with the injected error and no line carried `phase: 'scheduled-notifications'`.
test(
  'POST /workers/tick — a throwing phase 1 is a 200 and one error-level alarm naming the phase, not a 500',
  SKIP_WHEN_NO_DB,
  async (t) => {
    const capture = makeLogCapture();
    const original = scheduledNotificationsRepository.lockDueForSend;
    scheduledNotificationsRepository.lockDueForSend = async () => {
      throw new Error('column "deep_link_kind" does not exist');
    };
    t.after(() => {
      scheduledNotificationsRepository.lockDueForSend = original;
    });

    // Exactly `server.ts` — no `runTick`, no clients; logger at production's
    // default level so a demoted alarm goes red here.
    const app = Fastify({ logger: { level: 'info', stream: capture.stream } });
    registerAuth(app);
    registerWorkersTickRoute(app);

    const response = await app.inject({
      method: 'POST',
      url: '/workers/tick',
      headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = JSON.parse(response.body) as SchedulerTickResult;
    assert.deepStrictEqual(result.scheduledNotifications, {
      scanned: 0,
      sent: 0,
      failed: 0,
      parked: 0,
      // `null`, not 0: the phase threw before it could COUNT the parked rows,
      // and the route must not publish a zero it never measured (A1.6).
      parkedTotal: null,
      // `false` (A2.1): a phase that threw did not deliver. The 200 above is
      // what step 1 bought — and it is also what took the uptime monitor's red
      // away, because the 500 it replaced is what used to make the heartbeat
      // go stale. This leaf is how the red comes back without the 500.
      queueOk: false,
      pushTicketsOk: 0,
      pushTicketsError: 0,
    });

    const alarms = capture.lines.filter(
      (line) => line['workerTick'] === 'scheduler' && line['phase'] === 'scheduled-notifications' &&
        typeof line['msg'] === 'string' && line['msg'].includes('worker boundary'),
    );
    assert.equal(
      alarms.length,
      1,
      `expected exactly one phase-1 boundary alarm on the production path; captured: ${JSON.stringify(
        capture.lines.map((line) => [line['level'], line['phase'], line['msg']]),
      )}`,
    );
    // Pino error = 50: the Day-20 tap pages at >= 50, so a demotion is a
    // silent regression even while the text still prints.
    assert.equal(alarms[0]?.['level'], 50, 'the boundary alarm must be error-level');
    assert.match(String(alarms[0]?.['err']), /deep_link_kind/);
    // And the completion line still landed — the tick RAN.
    assert.ok(
      capture.lines.some((line) => line['msg'] === 'scheduler tick complete'),
      'the completion line must still be logged when phase 1 fails',
    );
  },
);


// ── phase-1 per-row poison alarm on the production path (2026-09-03) ────────
// `scheduler-worker.test.ts` proves per-row isolation when a logger is handed
// to `runSchedulerTickOnce` directly. This proves the PER-ROW alarm survives
// the shape production actually uses — pg_cron → POST /workers/tick →
// `request.log` — at error level, and that the completion line (the nominated
// authority on what a tick did) carries the two new leaves. Proven RED first by
// demoting the per-row `log.error` to `log.warn`: the route still answered 200
// and the row still failed alone, and nothing above pino 40 named it.
test(
  'POST /workers/tick — a poison row raises an error-level per-row alarm and lands in the completion line',
  SKIP_WHEN_NO_DB,
  async (t) => {
    const poisonTitle = 'POISON — deliverOne must throw for this row';
    const POISON_ERROR = 'fetchd_poison_no_such_column';
    const dedupeKey = `wt-alarm-poison-${randomUUID()}`;
    const seeded = await db.transaction(async (tx) =>
      scheduledNotificationsRepository.enqueueIdempotent(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        type: 'booking-reminder',
        trigger: 'booking-reminder',
        dedupeKey,
        // Due in the PAST relative to the route's real `now()` — the route
        // takes no `now` opt, which is exactly the shape under test.
        scheduledFor: new Date('2026-01-01T00:00:00Z'),
        title: poisonTitle,
        body: 'this row cannot be delivered',
      }),
    );
    assert.ok(seeded, 'the poison schedule row must be enqueued');

    // Only THIS row breaks; every other row the tick touches (the enrollment
    // reminders the surplus test leaves behind, for instance) delivers normally.
    // The failure is a SERVER error, not a bare JS throw — the 2026-09-02 class
    // (`column "deep_link_kind" does not exist`) — because only a server error
    // aborts the transaction, and surviving an aborted transaction is the whole
    // claim under test. See `scheduler-worker.test.ts`'s `poisonDelivery`.
    const originalEnqueue = notificationsRepository.enqueue;
    notificationsRepository.enqueue = async (tx, values) => {
      if (values.title !== poisonTitle) {
        return originalEnqueue(tx, values);
      }
      const inserted = await originalEnqueue(tx, values);
      await tx.execute(sql`SELECT ${sql.raw(POISON_ERROR)} FROM notifications LIMIT 1`);
      return inserted; // unreachable
    };
    t.after(() => {
      notificationsRepository.enqueue = originalEnqueue;
    });

    const capture = makeLogCapture();
    // Exactly `server.ts` — no `runTick`, no injected clients; the logger at
    // production's default level so a demoted alarm goes red here.
    const app = Fastify({ logger: { level: 'info', stream: capture.stream } });
    registerAuth(app);
    registerWorkersTickRoute(app);

    const response = await app.inject({
      method: 'POST',
      url: '/workers/tick',
      headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = JSON.parse(response.body) as SchedulerTickResult;

    // FIRST: the row actually failed on this path. If this goes red the poison
    // never reached delivery and the alarm assertion below would be vacuous.
    assert.equal(
      result.scheduledNotifications.failed,
      1,
      `the tick must record one failed row; got ${JSON.stringify(result.scheduledNotifications)}`,
    );
    assert.equal(result.scheduledNotifications.parked, 0, 'one failure is not three');
    const [row] = await db
      .select({
        status: scheduledNotifications.status,
        attempts: scheduledNotifications.attempts,
        lastError: scheduledNotifications.lastError,
        failedAt: scheduledNotifications.failedAt,
      })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.id, seeded.id));
    assert.equal(row?.status, 'pending');
    assert.equal(row?.attempts, 1);
    assert.match(String(row?.lastError), new RegExp(POISON_ERROR));
    assert.equal(row?.failedAt, null);

    // THEN: a human was told, at a level the Day-20 tap pages on.
    const alarms = capture.lines.filter(
      (line) =>
        line['workerTick'] === 'scheduler' &&
        line['phase'] === 'scheduled-notifications' &&
        line['scheduledId'] === seeded.id,
    );
    assert.equal(
      alarms.length,
      1,
      `expected exactly one per-row alarm naming the poison row; captured: ${JSON.stringify(
        capture.lines.map((line) => [line['level'], line['phase'], line['msg']]),
      )}`,
    );
    assert.equal(alarms[0]?.['level'], 50, 'the per-row alarm must be error-level');
    assert.equal(alarms[0]?.['dedupeKey'], dedupeKey, 'the alarm must name the row a human greps');
    // The count is in the SENTENCE, not the merge object (A1.4) — every scalar
    // there is an identifying, un-normalised part of the pager fingerprint.
    assert.equal(alarms[0]?.['attempts'], undefined);
    assert.equal(alarms[0]?.['parked'], undefined);
    assert.match(String(alarms[0]?.['msg']), /attempt 1 of 3/);
    assert.match(String(alarms[0]?.['msg']), /left pending for the next tick/);
    assert.equal(typeof alarms[0]?.['reqId'], 'string', 'the alarm must ride the request logger');

    // …and the completion line — "EVERY leaf" (D20-A7.2) — carries both new
    // counters, so a human reading the log back can see a row failed at all.
    const complete = capture.lines.find((line) => line['msg'] === 'scheduler tick complete');
    assert.ok(complete !== undefined, 'the completion line must still be logged');
    assert.equal(complete['scheduledFailed'], 1);
    assert.equal(complete['scheduledParked'], 0);
  },
);


// ── the standing parked-row signal, end to end (2026-09-03, A1.6) ───────────
// The PARKED page is one fire-and-forget event, and this module's own pager
// documents that a send can be shed at the in-flight ceiling or lost to the
// transport; `scheduledParked` on the completion line is per-tick, so it reads
// 0 on every tick after the one that parked. Miss that page and a notification
// that will NEVER be delivered is invisible until someone runs SQL. So the tick
// publishes the standing count and the endpoint an external monitor already
// watches turns it into a 503. Proven RED first by removing the
// `recordParkedTotal` call from `routes/workersTick.ts`: the row was parked,
// the tick ran, and `GET /health/watchdog` answered 200 `ok`.
test(
  'a PARKED row makes GET /health/watchdog go 503 after the next tick, and un-parking it clears the reason',
  SKIP_WHEN_NO_DB,
  async (t) => {
    initObservability({ installProcessHandlers: false });
    const dedupeKey = `wt-parked-total-${randomUUID()}`;
    const seeded = await db.transaction(async (tx) =>
      scheduledNotificationsRepository.enqueueIdempotent(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        type: 'booking-reminder',
        trigger: 'booking-reminder',
        dedupeKey,
        scheduledFor: new Date('2026-01-01T00:00:00Z'),
        title: 'a row that will be parked',
        body: 'nobody will ever receive this until a human acts',
      }),
    );
    assert.ok(seeded, 'the schedule row must be enqueued');
    t.after(async () => {
      await db
        .update(scheduledNotifications)
        .set({ emittedNotificationId: null })
        .where(eq(scheduledNotifications.id, seeded.id));
      await db.delete(scheduledNotifications).where(eq(scheduledNotifications.id, seeded.id));
      // Shared Redis: leave no standing 503 behind for another file.
      await redis.del(SCHEDULER_PARKED_TOTAL_KEY);
    });

    // Park it at the repository seam — how the worker gets there is pinned in
    // `scheduler-worker.test.ts`; what is under test here is what a parked row
    // does to the instrument an external monitor reads.
    await db.transaction(async (tx) => {
      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
        await scheduledNotificationsRepository.recordAttemptFailure(tx, {
          id: seeded.id,
          error: 'parked on purpose',
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        });
      }
    });

    async function tick(): Promise<Record<string, unknown>> {
      const app = Fastify({ logger: false });
      registerAuth(app);
      registerWorkersTickRoute(app);
      const response = await app.inject({
        method: 'POST',
        url: '/workers/tick',
        headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
      });
      await app.close();
      assert.equal(response.statusCode, 200, response.body);
      return (JSON.parse(response.body) as SchedulerTickResult)
        .scheduledNotifications as unknown as Record<string, unknown>;
    }

    async function watchdog(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
      const app = buildApp();
      const response = await app.inject({ method: 'GET', url: '/health/watchdog' });
      await app.close();
      return {
        statusCode: response.statusCode,
        body: JSON.parse(response.body) as Record<string, unknown>,
      };
    }

    const parkedTick = await tick();
    assert.ok(
      Number(parkedTick['parkedTotal']) >= 1,
      `the tick must COUNT the parked row; got ${JSON.stringify(parkedTick)}`,
    );

    const down = await watchdog();
    assert.equal(down.statusCode, 503, JSON.stringify(down.body));
    assert.ok(
      (down.body['reasons'] as string[]).some((r) => r.includes('parked scheduled notifications')),
      `the 503 must name the parked rows; got ${JSON.stringify(down.body['reasons'])}`,
    );
    assert.ok(Number(down.body['parked_total']) >= 1);

    // The human un-parks it. The next tick delivers it, the count goes to zero,
    // and the standing reason clears — a signal that cannot clear is a signal
    // nobody will keep watching.
    const unparked = await db.transaction(async (tx) =>
      scheduledNotificationsRepository.unparkByDedupeKey(tx, dedupeKey),
    );
    assert.equal(unparked, 1);
    const clearedTick = await tick();
    assert.equal(clearedTick['parkedTotal'], 0, 'nothing is parked any more');

    const up = await watchdog();
    assert.equal(up.body['parked_total'], 0);
    assert.ok(
      !(up.body['reasons'] as string[]).some((r) => r.includes('parked scheduled notifications')),
      `the reason must clear; got ${JSON.stringify(up.body['reasons'])}`,
    );
    assert.equal(up.statusCode, 200, JSON.stringify(up.body));
  },
);


// ── the queue-not-delivering signal, end to end (2026-09-03, A2.1) ──────────
// Allison, ~14:45 CDT, given the timeline (Wednesday 6:50 drift → 7:00
// reminders all fail → Sentry pages three times then goes quiet → UptimeRobot
// green all day → fixed at 5 p.m., everything delivers): **YES, the monitor
// goes red after about ten minutes.**
//
// Both ways phase 1 can stop delivering are pinned here, on the PRODUCTION
// path — the real route, the real watchdog, the real Redis — because both were
// created by the two fixes this cycle already shipped and neither is visible
// anywhere else: step 1's boundary turned a phase-1 throw from a 500 (which
// starved the heartbeat and went red by accident) into a 200, and step 2's
// systemic branch stopped an all-fail batch from parking anything.
//
// `scheduler:queue_ok_at` is spelled out rather than imported for the same
// reason the route paths above are: it is the key an operator greps and a
// future reader renames, and an imported constant would follow a rename that
// silently broke nothing but production.
const QUEUE_OK_KEY = 'scheduler:queue_ok_at';

/** Eleven minutes ago: past `SCHEDULER_STALE_AFTER_MS`, so the read is STALE. */
function staleInstant(): string {
  return new Date(Date.now() - 11 * 60 * 1000).toISOString();
}

async function readWatchdogBody(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/health/watchdog' });
  await app.close();
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as Record<string, unknown>,
  };
}

async function runTickRoute(): Promise<SchedulerTickResult> {
  const app = Fastify({ logger: false });
  registerAuth(app);
  registerWorkersTickRoute(app);
  const response = await app.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  await app.close();
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as SchedulerTickResult;
}

test(
  'a SYSTEMIC all-fail phase 1 does not refresh scheduler:queue_ok_at → the watchdog goes 503; the cause fixed, the next tick clears it',
  SKIP_WHEN_NO_DB,
  async (t) => {
    initObservability({ installProcessHandlers: false });
    // Two rows of our own, so the claimed batch is >= 2 whatever else is due —
    // `batch.length >= 2` is the systemic branch's own precondition, and a
    // batch of one takes the poison path by design (A1.1).
    const seeded: string[] = [];
    for (const n of [1, 2]) {
      const row = await db.transaction(async (tx) =>
        scheduledNotificationsRepository.enqueueIdempotent(tx, {
          ownerId: FIXTURE_IDS.ownerId,
          type: 'booking-reminder',
          trigger: 'booking-reminder',
          dedupeKey: `wt-queue-ok-systemic-${n}-${randomUUID()}`,
          scheduledFor: new Date('2026-01-01T00:00:00Z'),
          title: `queue-ok systemic row ${n}`,
          body: 'the whole queue is failing, not this row',
        }),
      );
      assert.ok(row, 'the schedule row must be enqueued');
      seeded.push(row.id);
    }
    t.after(async () => {
      for (const id of seeded) {
        await db
          .update(scheduledNotifications)
          .set({ emittedNotificationId: null })
          .where(eq(scheduledNotifications.id, id));
        await db.delete(scheduledNotifications).where(eq(scheduledNotifications.id, id));
      }
      // Shared Redis: leave no stale key behind for another file.
      await redis.del(QUEUE_OK_KEY);
      await redis.del(SCHEDULER_PARKED_TOTAL_KEY);
    });

    // The queue last delivered eleven minutes ago. This is exactly the state
    // the HEARTBEAT cannot see: the tick is running and stamping itself every
    // minute, and it is the queue that stopped.
    await redis.setex(QUEUE_OK_KEY, 24 * 60 * 60, staleInstant());
    await redis.del(SCHEDULER_PARKED_TOTAL_KEY);

    // EVERY row fails, at the SERVER — a bad column reference, the exact class
    // of the 2026-09-02 incident (`column "deep_link_kind" does not exist`) and
    // the shape a schema drift one table over actually takes. Not a bare JS
    // throw: that leaves the Postgres transaction healthy, so the batch would
    // survive it without a savepoint and this would pass against the defect.
    const originalEnqueue = notificationsRepository.enqueue;
    notificationsRepository.enqueue = async (tx, values) => {
      const inserted = await originalEnqueue(tx, values);
      await tx.execute(sql`SELECT ${sql.raw('fetchd_queue_ok_systemic_drift')} FROM notifications LIMIT 1`);
      return inserted; // unreachable
    };
    let restored = false;
    t.after(() => {
      if (!restored) notificationsRepository.enqueue = originalEnqueue;
    });

    const outage = await runTickRoute();
    assert.ok(
      outage.scheduledNotifications.scanned >= 2,
      `the batch must be >= 2 for the systemic branch; got ${JSON.stringify(
        outage.scheduledNotifications,
      )}`,
    );
    assert.equal(outage.scheduledNotifications.sent, 0, 'nothing delivered');
    assert.equal(
      outage.scheduledNotifications.failed,
      outage.scheduledNotifications.scanned,
      'every claimed row failed — this is the systemic branch',
    );
    assert.equal(outage.scheduledNotifications.parked, 0, 'a systemic failure parks nothing');
    assert.equal(outage.scheduledNotifications.parkedTotal, 0, 'and nothing is parked at all');
    assert.equal(outage.scheduledNotifications.queueOk, false, 'the queue is NOT delivering');

    // The key was NOT refreshed, so it is still eleven minutes old…
    const afterOutage = await redis.get(QUEUE_OK_KEY);
    assert.ok(
      afterOutage !== null && Date.now() - new Date(afterOutage).getTime() > 10 * 60 * 1000,
      `a not-delivering tick must not refresh the key; it reads ${String(afterOutage)}`,
    );

    // …and the instrument an external monitor watches is RED, with the reason
    // an operator can act on. Nothing is parked and the tick is fresh, so this
    // is the ONLY reason — before A2.1 this state answered 200 `ok`.
    const down = await readWatchdogBody();
    const downReasons = down.body['reasons'] as string[];
    assert.ok(
      downReasons.some((r) => r.includes('scheduled-notification queue has not delivered')),
      `the 503 must name the queue; got ${JSON.stringify(downReasons)}`,
    );
    assert.ok(
      downReasons.some((r) => r.includes('every claimed row is failing, or phase 1 is throwing')),
      'and must say where to look',
    );
    assert.ok(
      !downReasons.some((r) => r.includes('last scheduler tick')),
      `the tick itself is healthy; got ${JSON.stringify(downReasons)}`,
    );
    assert.equal(down.statusCode, 503, JSON.stringify(down.body));

    // The cause is fixed. Nothing parked — that is A1.1 — so the very next tick
    // delivers, refreshes the key, and the monitor goes green on its own. A red
    // that needs a human to clear it is a red nobody keeps watching.
    notificationsRepository.enqueue = originalEnqueue;
    restored = true;
    const recovered = await runTickRoute();
    assert.equal(recovered.scheduledNotifications.queueOk, true, 'the queue delivers again');
    assert.ok(recovered.scheduledNotifications.sent >= 2, 'and the held rows go out');

    const up = await readWatchdogBody();
    const upReasons = up.body['reasons'] as string[];
    assert.ok(
      !upReasons.some((r) => r.includes('scheduled-notification queue has not delivered')),
      `the reason must clear; got ${JSON.stringify(upReasons)}`,
    );
    assert.equal(typeof up.body['queue_ok_at'], 'string', 'the body publishes what it read');
    assert.equal(up.statusCode, 200, JSON.stringify(up.body));
  },
);

test(
  'a phase-1 BOUNDARY THROW does not refresh scheduler:queue_ok_at → the watchdog goes 503 even though the tick answered 200',
  SKIP_WHEN_NO_DB,
  async (t) => {
    // The half the finding did not name, and the reason this key beats a
    // systemic-only counter. At HEAD a phase-1 throw escaped to the route, the
    // route answered 500, `recordSchedulerTick` was never reached and the
    // heartbeat went stale within ten minutes — so this outage went red by
    // ACCIDENT. Step 1's boundary made it a 200 on purpose. Without this leaf
    // the same schema drift is now invisible to the uptime monitor.
    initObservability({ installProcessHandlers: false });
    const original = scheduledNotificationsRepository.lockDueForSend;
    scheduledNotificationsRepository.lockDueForSend = async () => {
      throw new Error('column "deep_link_kind" does not exist');
    };
    t.after(async () => {
      scheduledNotificationsRepository.lockDueForSend = original;
      await redis.del(QUEUE_OK_KEY);
      await redis.del(SCHEDULER_PARKED_TOTAL_KEY);
    });

    await redis.setex(QUEUE_OK_KEY, 24 * 60 * 60, staleInstant());
    await redis.del(SCHEDULER_PARKED_TOTAL_KEY);

    const result = await runTickRoute();
    assert.equal(result.scheduledNotifications.queueOk, false, 'a phase that THREW did not deliver');
    assert.equal(result.scheduledNotifications.parkedTotal, null, 'and it never counted');

    const afterThrow = await redis.get(QUEUE_OK_KEY);
    assert.ok(
      afterThrow !== null && Date.now() - new Date(afterThrow).getTime() > 10 * 60 * 1000,
      `a throwing phase must not refresh the key; it reads ${String(afterThrow)}`,
    );

    const down = await readWatchdogBody();
    const downReasons = down.body['reasons'] as string[];
    assert.ok(
      downReasons.some((r) => r.includes('scheduled-notification queue has not delivered')),
      `the 503 must name the queue; got ${JSON.stringify(downReasons)}`,
    );
    assert.equal(down.statusCode, 503, JSON.stringify(down.body));
  },
);
