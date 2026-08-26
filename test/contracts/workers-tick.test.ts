import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/plugin.js';
import { closeRedis } from '../../src/redis.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import { env } from '../../src/env.js';
import type { SchedulerTickResult } from '../../src/workers/scheduler.js';

/**
 * Day-16 HTTP contract for the signed `/workers/tick` route. The
 * worker function itself is exercised in `scheduler-worker.test.ts`;
 * this file proves the auth gate + route plumbing only. `runTick` is
 * stubbed so the test stays independent of the DB-touching worker
 * surface (no `registerFixtureHooks` here — the route is DB-agnostic
 * once the worker is injected).
 */

function makeApp(runTick: () => Promise<SchedulerTickResult>) {
  const app = Fastify({ logger: false });
  registerAuth(app);
  registerWorkersTickRoute(app, { runTick });
  return app;
}

/**
 * Day-20 (D20-A2 §A2.3): the route now writes a Redis heartbeat after the
 * completion log line, so this file opens the ioredis socket that would
 * otherwise pin the subprocess event loop open after the last test — the same
 * hazard `_harness.ts` documents for the fixture files.
 */
after(async () => {
  await closeRedis();
});

/**
 * A COMPLETE `SchedulerTickResult`. It was a five-phase partial under the same
 * type annotation until D20-A3 §A3.4.1 made the completion log line read every
 * phase; the annotation was already a lie (nothing typechecks `test/`), and the
 * missing phases would have surfaced as a `TypeError` rather than as the type
 * error they actually were.
 */
const FAKE_RESULT: SchedulerTickResult = {
  scheduledNotifications: {
    scanned: 0,
    sent: 0,
    pushTicketsOk: 0,
    pushTicketsError: 0,
  },
  membershipRoll: { scanned: 0, rolled: 0, completed: 0 },
  invoiceOverdue: { scanned: 0, enqueued: 0 },
  cardExpiry: { scanned: 0, enqueued: 0 },
  invoiceAttemptVerify: { scanned: 0, results: [] },
  captureReconciler: {
    scanned: 0,
    captured: 0,
    lostHolds: 0,
    withdrawnReleased: 0,
    refundedPostWithdraw: 0,
    refundedSurplus: 0,
    settledInvoices: 0,
    abandoned: 0,
    abandonedTruncated: false,
    abandonedUncollected: 0,
    results: [],
  },
  duplicateRefundRetry: {
    scanned: 0,
    sent: 0,
    abandoned: 0,
    abandonedTruncated: false,
    abandonedByClass: {
      'row-keyed': 0,
      'client-keyed': 0,
      'never-sent': 0,
      'stripe-failed': 0,
      covered: 0,
    },
    results: [],
  },
  invoiceAutoCharge: { scanned: 0, results: [] },
  mediaDerivatives: { scanned: 0, results: [] },
  creditExpiryWarnings: { scanned: 0, enqueued: 0 },
  alumniAttendance: { ran: false, scanned: 0, enqueued: 0, flagged: 0 },
  idempotencyKeysSwept: 0,
};

test('POST /workers/tick — valid bearer returns 200 + tick result', async () => {
  let tickCalls = 0;
  const app = makeApp(async () => {
    tickCalls += 1;
    return FAKE_RESULT;
  });
  const response = await app.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(tickCalls, 1);
  assert.deepStrictEqual(JSON.parse(response.body), FAKE_RESULT);
});

test('POST /workers/tick — missing Authorization → 401', async () => {
  let tickCalls = 0;
  const app = makeApp(async () => {
    tickCalls += 1;
    return FAKE_RESULT;
  });
  const response = await app.inject({ method: 'POST', url: '/workers/tick' });
  assert.equal(response.statusCode, 401);
  assert.equal(tickCalls, 0);
});

test('POST /workers/tick — non-Bearer scheme → 401', async () => {
  const app = makeApp(async () => FAKE_RESULT);
  const response = await app.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Basic ${Buffer.from('user:pass').toString('base64')}` },
  });
  assert.equal(response.statusCode, 401);
});

test('POST /workers/tick — wrong bearer secret → 401', async () => {
  let tickCalls = 0;
  const app = makeApp(async () => {
    tickCalls += 1;
    return FAKE_RESULT;
  });
  const response = await app.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: 'Bearer not-the-real-secret' },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(tickCalls, 0);
});
