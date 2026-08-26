import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/plugin.js';
import { env } from '../../src/env.js';
import {
  captureAlarm,
  flushObservability,
  initObservability,
  IDENTICAL_ALLOWANCE,
  type AlarmTransport,
} from '../../src/lib/observability.js';
import {
  SCHEDULER_HEARTBEAT_KEY,
  SCHEDULER_HEARTBEAT_TTL_S,
} from '../../src/lib/schedulerHeartbeat.js';
import { closeRedis, redis } from '../../src/redis.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import {
  MAX_RECENT_DROPPED_ALARMS,
  SCHEDULER_STALE_AFTER_MS,
} from '../../src/routes/healthWatchdog.js';
import { buildApp } from '../../src/server.js';
import type { SchedulerTickResult } from '../../src/workers/scheduler.js';

/**
 * **`GET /health/watchdog` — the instrument that survives everything else.**
 *
 * Allison's 2026-08-24 finding was *"production ticks have NEVER fired and
 * nobody knew"*. A cron that can stop silently fixes the instance and leaves
 * the class, so D20-A2 §A2.3 ruled one endpoint that answers both halves — did
 * the scheduler tick, and is the pager alive — watched by one free external
 * monitor that is outside both this process and Sentry.
 *
 * The load-bearing negative is pinned here too: this must NOT ride `GET
 * /health`, because `railway.json` points its DEPLOY healthcheck there. A fresh
 * deploy has, by definition, no recent tick; folding staleness into `/health`
 * would make every deploy fail its own healthcheck and roll itself back. That
 * is the trap that makes the obvious version of this fix worse than nothing.
 */

/** The Redis heartbeat is the only fixture this file needs. */
after(async () => {
  await redis.del(SCHEDULER_HEARTBEAT_KEY);
  await closeRedis();
});

async function setHeartbeat(at: Date): Promise<void> {
  await redis.setex(SCHEDULER_HEARTBEAT_KEY, SCHEDULER_HEARTBEAT_TTL_S, at.toISOString());
}

interface WatchdogBody {
  status: string;
  last_tick_at: string | null;
  staleness_s: number | null;
  stale_after_s: number;
  pager: {
    installed: boolean;
    consecutive_transport_failures: number;
    dropped_alarms: number;
    dropped_alarms_recent: number;
    catastrophic_ceiling_tripped_at: string | null;
  };
  reasons: string[];
}

async function readWatchdog(): Promise<{ statusCode: number; body: WatchdogBody }> {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/health/watchdog' });
  await app.close();
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as WatchdogBody };
}

test('no tick has ever been recorded → 503, and says so', async () => {
  initObservability({ installProcessHandlers: false });
  await redis.del(SCHEDULER_HEARTBEAT_KEY);

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.equal(body.status, 'down');
  assert.equal(body.last_tick_at, null);
  assert.equal(body.staleness_s, null);
  // This exact state IS Allison's finding: production had never ticked once.
  assert.ok(
    body.reasons.some((r) => r.includes('no scheduler tick')),
    `the 503 must name its reason; got ${JSON.stringify(body.reasons)}`,
  );
});

test('a fresh tick → 200 with the timestamp and a small staleness', async () => {
  initObservability({ installProcessHandlers: false });
  const at = new Date();
  await setHeartbeat(at);

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 200, JSON.stringify(body));
  assert.equal(body.status, 'ok');
  assert.equal(body.last_tick_at, at.toISOString());
  assert.ok((body.staleness_s ?? 999) < 5, `staleness ${String(body.staleness_s)}s`);
  assert.deepStrictEqual(body.reasons, []);
  assert.equal(body.stale_after_s, SCHEDULER_STALE_AFTER_MS / 1000);
});

test('a tick older than the threshold → 503 naming the staleness', async () => {
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date(Date.now() - SCHEDULER_STALE_AFTER_MS - 60_000));

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.ok((body.staleness_s ?? 0) > SCHEDULER_STALE_AFTER_MS / 1000);
  assert.ok(body.reasons.some((r) => r.includes('last scheduler tick was')));
});

test('the watchdog goes 503 WITHOUT touching /health — the railway healthcheck trap', async () => {
  initObservability({ installProcessHandlers: false });
  await redis.del(SCHEDULER_HEARTBEAT_KEY);

  const app = buildApp();
  const watchdog = await app.inject({ method: 'GET', url: '/health/watchdog' });
  const health = await app.inject({ method: 'GET', url: '/health' });
  await app.close();

  assert.equal(watchdog.statusCode, 503, 'the scheduler is silent, so the watchdog is down');
  assert.equal(
    health.statusCode,
    200,
    'and `/health` — which railway.json uses as the DEPLOY healthcheck — is unaffected. ' +
      'If these two ever move together, every fresh deploy rolls itself back.',
  );
  const healthBody = JSON.parse(health.body) as Record<string, unknown>;
  assert.equal(healthBody['status'], 'ok');
  assert.ok(!('last_tick_at' in healthBody), '/health must not grow scheduler fields');
});

test('a pager failing three sends in a row → 503, even with a fresh tick', async () => {
  const rejecting: AlarmTransport = {
    send(): Promise<void> {
      return Promise.reject(new Error('ingest unreachable'));
    },
  };
  initObservability({ transport: rejecting, installProcessHandlers: false });
  await setHeartbeat(new Date());

  // Distinct messages: the point is three FAILURES, not three of one alarm.
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    for (const m of ['alarm one', 'alarm two', 'alarm three']) {
      captureAlarm({ message: m, level: 'error', logger: 'pino' });
    }
    await flushObservability(500);
  } finally {
    process.stderr.write = originalWrite;
  }

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.equal(body.pager.consecutive_transport_failures, 3);
  assert.ok(body.reasons.some((r) => r.includes('consecutive sends')));
  // The scheduler half is fine — the endpoint separates the two conditions.
  assert.ok(!body.reasons.some((r) => r.includes('scheduler tick')));
});

test('sustained dropped alarms → 503, because the only consumer reads a status code (§A4.4.1)', async () => {
  // 75 dropped alarms used to return `200 status=ok`. The only consumer of this
  // endpoint is a free uptime monitor watching a STATUS CODE — reporting a
  // number to an instrument that cannot read numbers is not reporting it. Under
  // de-duplication a drop is rare and meaningful, so sustained drops are an
  // incident with a named threshold.
  const transport: AlarmTransport = {
    send(): Promise<void> {
      return Promise.resolve();
    },
  };
  initObservability({ transport, installProcessHandlers: false });
  await setHeartbeat(new Date());

  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    // One sentence, repeated far past the allowance: every copy after the
    // third is a drop.
    for (let i = 0; i < MAX_RECENT_DROPPED_ALARMS + IDENTICAL_ALLOWANCE + 5; i += 1) {
      captureAlarm({ message: 'a repeated condition', level: 'error', logger: 'pino' });
    }
    await flushObservability(500);
  } finally {
    process.stderr.write = originalWrite;
  }

  const { statusCode, body } = await readWatchdog();
  assert.ok(
    body.pager.dropped_alarms_recent >= MAX_RECENT_DROPPED_ALARMS,
    `precondition: ${body.pager.dropped_alarms_recent} recent drops`,
  );
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.ok(
    body.reasons.some((r) => r.includes('dropped')),
    `the 503 must name the drops; got ${JSON.stringify(body.reasons)}`,
  );
  // The scheduler half is untouched — the endpoint separates its conditions.
  assert.ok(!body.reasons.some((r) => r.includes('scheduler tick')));
});

test('a FUTURE-dated heartbeat → 503 with its own reason, not a silent 200 (§A4.4.4)', async () => {
  // A forward clock jump buys a DEAD scheduler exactly that much silence, and
  // reports a negative age while doing it. `staleness > threshold` is false for
  // every negative number, so the obvious check reads healthy.
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date(Date.now() + 6 * 60 * 60 * 1000));

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.ok((body.staleness_s ?? 0) < 0, 'the reading itself is negative and must be reported');
  assert.ok(
    body.reasons.some((r) => r.toLowerCase().includes('future')),
    `clock skew needs its own reason, not silence; got ${JSON.stringify(body.reasons)}`,
  );
});

test('a CORRUPTED heartbeat value gets its own reason, not "never recorded" (§A4.5 L3)', async () => {
  // Mapping an unparseable value to `null` is a safe DIRECTION and a false
  // SENTENCE: "no scheduler tick has been recorded" sends whoever reads it to
  // pg_cron, when the actual fault is the key.
  initObservability({ installProcessHandlers: false });
  await redis.setex(SCHEDULER_HEARTBEAT_KEY, SCHEDULER_HEARTBEAT_TTL_S, 'not-a-timestamp');

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.ok(
    body.reasons.some((r) => r.includes('unparseable') || r.includes('corrupt')),
    `a corrupted key must say so; got ${JSON.stringify(body.reasons)}`,
  );
  assert.ok(
    !body.reasons.some((r) => r.includes('no scheduler tick has been recorded')),
    'and must NOT claim the scheduler never ran — that sends the reader to the wrong system',
  );
});

test('POST /workers/tick writes the heartbeat the watchdog reads', async () => {
  initObservability({ installProcessHandlers: false });
  await redis.del(SCHEDULER_HEARTBEAT_KEY);
  assert.equal((await readWatchdog()).statusCode, 503, 'precondition: nothing has ticked');

  // The REAL route (its own `runTick` is stubbed only so this file does not
  // run the twelve-phase tick against the shared fixture DB).
  const tickApp = Fastify({ logger: false });
  registerAuth(tickApp);
  registerWorkersTickRoute(tickApp, {
    runTick: async () => TICK_RESULT,
  });
  const tick = await tickApp.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  await tickApp.close();
  assert.equal(tick.statusCode, 200, tick.body);

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 200, JSON.stringify(body));
  assert.ok(typeof body.last_tick_at === 'string', 'the tick must have stamped the heartbeat');
});

/** A complete, all-zero `SchedulerTickResult`. */
const TICK_RESULT: SchedulerTickResult = {
  scheduledNotifications: { scanned: 0, sent: 0, pushTicketsOk: 0, pushTicketsError: 0 },
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
