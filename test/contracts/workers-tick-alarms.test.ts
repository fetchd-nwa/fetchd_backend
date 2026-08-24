import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import Stripe from 'stripe';
import { registerAuth } from '../../src/auth/plugin.js';
import { db } from '../../src/db/client.js';
import {
  charges as chargesTable,
  cohorts as cohortsTable,
  invoices as invoicesTable,
  refunds as refundsTable,
} from '../../src/db/schema/schema.js';
import { env } from '../../src/env.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import type { SchedulerTickResult } from '../../src/workers/scheduler.js';
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
