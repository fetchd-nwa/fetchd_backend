import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * **A watchdog that can WEDGE the thing it watches** (D20-A4 §A4.3).
 *
 * `routes/workersTick.ts` awaits `recordSchedulerTick` in the request path, and
 * `schedulerHeartbeat.ts`'s try/catch handles a REJECTION, not a HANG. Executed
 * by the round-2 attack lane against a TCP blackhole — a socket that accepts and
 * never answers, i.e. a Redis that is reachable but wedged — **the tick route
 * never returned; it was still running after 45 seconds.** Connection-REFUSED is
 * fine (200 in 58 ms) because the socket dies; it is the silent-socket case that
 * wedges, and `maxRetriesPerRequest: 1` never trips because the connection is
 * not down. pg_cron then starts a fresh tick on top of it every minute.
 *
 * This is a Redis await that THIS CYCLE added to the money tick's request path,
 * and `schedulerHeartbeat.ts:16` claims "a watchdog that can fail the thing it
 * watches is worse than no watchdog" — one that can wedge it fails the same
 * claim.
 *
 * Why a subprocess: `src/redis.ts` builds its client from `env.REDIS_URL` at
 * module load, so the only way to point the REAL client at a blackhole is a
 * fresh process with a different environment. Same reasoning as
 * `envProductionGuards.test.ts` — the claim is about the production wiring, not
 * about a stand-in that can be pointed anywhere.
 *
 * The first test is the control: without a run that proves this harness returns
 * 200 promptly against a WORKING Redis, "the blackhole returns promptly" could
 * just as easily mean the harness never reached the heartbeat at all.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A tick result with every phase zeroed. Required in full: the completion log
 * line reads all twelve phases (D20-A3 §A3.4.1), so a partial object would
 * throw before the heartbeat is ever reached and the test would "pass" on the
 * wrong failure.
 */
const TICK_RESULT_JSON = JSON.stringify({
  scheduledNotifications: { scanned: 0, sent: 0, pushTicketsOk: 0, pushTicketsError: 0 },
  membershipRoll: { scanned: 0, rolled: 0, completed: 0 },
  invoiceAttemptVerify: { scanned: 0 },
  captureReconciler: {
    scanned: 0,
    captured: 0,
    lostHolds: 0,
    withdrawnReleased: 0,
    refundedPostWithdraw: 0,
    refundedSurplus: 0,
    settledInvoices: 0,
    abandoned: 0,
    abandonedUncollected: 0,
    abandonedTruncated: false,
  },
  // Every LEAF, not just every phase (D20-A7.2). This object is a JSON string
  // spliced into a subprocess, so no typecheck guards it — when the completion
  // line grew the two `abandonedTruncated` flags and the five `abandonedByClass`
  // members, the omission surfaced as the tick answering 500 and BOTH tests
  // here failing on "a heartbeat is not allowed to fail a tick that moved
  // money", which is the wrong failure exactly as the note above predicts.
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
  },
  invoiceAutoCharge: { scanned: 0 },
  mediaDerivatives: { scanned: 0 },
  creditExpiryWarnings: { scanned: 0, enqueued: 0 },
  alumniAttendance: { ran: false, scanned: 0, enqueued: 0, flagged: 0 },
  invoiceOverdue: { scanned: 0, enqueued: 0 },
  cardExpiry: { scanned: 0, enqueued: 0 },
  idempotencyKeysSwept: 0,
});

/** Drive one real `POST /workers/tick` and report its status and wall time. */
const TICK_PROGRAM = `
  const { default: Fastify } = await import('fastify');
  const { env } = await import('./src/env.js');
  const { redis } = await import('./src/redis.js');
  const { registerWorkersTickRoute } = await import('./src/routes/workersTick.js');
  const app = Fastify({ logger: false });
  registerWorkersTickRoute(app, { runTick: async () => (${TICK_RESULT_JSON}) });
  await app.ready();
  const startedAt = Date.now();
  const response = await app.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: 'Bearer ' + env.SCHEDULER_WEBHOOK_SECRET },
  });
  process.stdout.write(JSON.stringify({ status: response.statusCode, ms: Date.now() - startedAt }));
  await app.close();
  redis.disconnect();
  process.exit(0);
`;

interface TickOutcome {
  status: number;
  ms: number;
}

/**
 * Run one tick in a fresh process against `redisUrl`. `timeout` is the point of
 * the whole exercise: a wedged heartbeat does not fail, it never finishes, so
 * the failure mode has to be turned into an observable one.
 */
function runTickAgainst(redisUrl: string): TickOutcome | { killed: true; signal: string | null } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', TICK_PROGRAM], {
    cwd: REPO_ROOT,
    env: { ...process.env, REDIS_URL: redisUrl },
    encoding: 'utf-8',
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  if (result.stdout.trim().length === 0) {
    return { killed: true, signal: result.signal };
  }
  return JSON.parse(result.stdout.trim()) as TickOutcome;
}

/** A listener that ACCEPTS and never answers. Reachable, wedged: the bad case. */
async function withBlackhole(fn: (url: string) => void): Promise<void> {
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      /* swallow every command; answer nothing, ever */
    });
    socket.on('error', () => {
      /* the client giving up is expected */
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the blackhole must have a port');
  try {
    fn(`redis://127.0.0.1:${address.port}/0`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('control: against the real Redis the tick returns 200 promptly', () => {
  const redisUrl = process.env.REDIS_URL;
  assert.ok(redisUrl !== undefined, 'this suite runs with REDIS_URL set');
  const outcome = runTickAgainst(redisUrl);
  assert.ok(!('killed' in outcome), 'the control must not hang');
  assert.equal(outcome.status, 200, 'the tick answers 200 on a valid secret');
  assert.ok(outcome.ms < 5_000, `control took ${outcome.ms}ms`);
});

test('a WEDGED Redis cannot wedge the tick: 200 within 5s, heartbeat abandoned', async () => {
  await withBlackhole((url) => {
    const outcome = runTickAgainst(url);
    assert.ok(
      !('killed' in outcome),
      'the tick never returned against a blackhole — cron then stacks a fresh tick on it every minute',
    );
    assert.equal(outcome.status, 200, 'a heartbeat is not allowed to fail a tick that moved money');
    assert.ok(
      outcome.ms < 5_000,
      `the heartbeat write must be abandoned, not awaited forever; the tick took ${outcome.ms}ms`,
    );
  });
});

/**
 * The same blackhole, one hop out: the READER (D20-A5.2).
 *
 * §A4.3 raced the write and left the read sixty lines below it untouched, so
 * against a reachable-but-silent Redis `GET /health/watchdog` **never answered —
 * still nothing after 45 seconds — and `app.close()` never returned either**.
 * The endpoint whose entire job is to notice silence was the thing that went
 * silent, and a monitor watching a status code cannot tell that from a slow
 * network: no alert, ever.
 *
 * Subprocess for the same reason as above — `src/redis.ts` builds its client
 * from `env.REDIS_URL` at module load — and the route is the REAL one.
 */
const WATCHDOG_PROGRAM = `
  const { default: Fastify } = await import('fastify');
  const { redis } = await import('./src/redis.js');
  const { initObservability } = await import('./src/lib/observability.js');
  const { registerHealthWatchdogRoute } = await import('./src/routes/healthWatchdog.js');
  initObservability({ transport: { send: async () => {} }, installProcessHandlers: false });
  const app = Fastify({ logger: false });
  registerHealthWatchdogRoute(app);
  await app.ready();
  const startedAt = Date.now();
  const response = await app.inject({ method: 'GET', url: '/health/watchdog' });
  const answeredMs = Date.now() - startedAt;
  const closedAt = Date.now();
  await app.close();
  process.stdout.write(JSON.stringify({
    status: response.statusCode,
    ms: answeredMs,
    closeMs: Date.now() - closedAt,
    reasons: JSON.parse(response.body).reasons,
  }));
  redis.disconnect();
  process.exit(0);
`;

interface WatchdogOutcome {
  status: number;
  ms: number;
  closeMs: number;
  reasons: string[];
}

function runWatchdogAgainst(redisUrl: string): WatchdogOutcome | { killed: true } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', WATCHDOG_PROGRAM],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, REDIS_URL: redisUrl },
      encoding: 'utf-8',
      timeout: 20_000,
      killSignal: 'SIGKILL',
    },
  );
  if (result.stdout.trim().length === 0) return { killed: true };
  return JSON.parse(result.stdout.trim()) as WatchdogOutcome;
}

test('control: against the real Redis the watchdog answers promptly', () => {
  const redisUrl = process.env.REDIS_URL;
  assert.ok(redisUrl !== undefined, 'this suite runs with REDIS_URL set');
  const outcome = runWatchdogAgainst(redisUrl);
  assert.ok(!('killed' in outcome), 'the control must not hang');
  assert.ok(outcome.ms < 5_000, `control took ${outcome.ms}ms`);
  assert.ok(
    !outcome.reasons.some((r) => r.includes('UNREADABLE')),
    `a readable Redis must never report unreadable; got ${JSON.stringify(outcome.reasons)}`,
  );
});

test('a WEDGED Redis makes the watchdog say "I cannot see", not go silent (§A5.2)', async () => {
  await withBlackhole((url) => {
    const outcome = runWatchdogAgainst(url);
    assert.ok(
      !('killed' in outcome),
      'the watchdog never answered against a blackhole — the monitor cannot tell that from a slow network, so nothing ever alerts',
    );
    assert.ok(outcome.ms < 5_000, `the read must be abandoned, not awaited forever; took ${outcome.ms}ms`);
    assert.equal(outcome.status, 503, 'a watchdog that cannot see must fail CLOSED');
    assert.ok(
      outcome.reasons.some((r) => r.includes('UNREADABLE')),
      `"I cannot see" must not masquerade as "the scheduler is dead"; got ${JSON.stringify(outcome.reasons)}`,
    );
    assert.ok(
      outcome.closeMs < 5_000,
      `app.close() must return — a wedged read held shutdown open too; took ${outcome.closeMs}ms`,
    );
  });
});
