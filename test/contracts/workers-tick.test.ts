import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/plugin.js';
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

const FAKE_RESULT: SchedulerTickResult = {
  scheduledNotifications: {
    scanned: 0,
    sent: 0,
    pushTicketsOk: 0,
    pushTicketsError: 0,
  },
  invoiceAutoCharge: { scanned: 0, results: [] },
  mediaDerivatives: { scanned: 0, results: [] },
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
