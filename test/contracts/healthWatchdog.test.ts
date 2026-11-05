import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/plugin.js';
import { env } from '../../src/env.js';
import {
  captureAlarm,
  flushObservability,
  initObservability,
  IDENTICAL_ALLOWANCE,
  MAX_IN_FLIGHT,
  type AlarmTransport,
} from '../../src/lib/observability.js';
import {
  SCHEDULER_HEARTBEAT_KEY,
  SCHEDULER_HEARTBEAT_TTL_S,
  SCHEDULER_PARKED_TOTAL_KEY,
  SCHEDULER_PARKED_TOTAL_TTL_S,
  SCHEDULER_QUEUE_OK_KEY,
  SCHEDULER_QUEUE_OK_TTL_S,
} from '../../src/lib/schedulerHeartbeat.js';
import { closeRedis, redis } from '../../src/redis.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  MAX_RECENT_CEILING_DROPS,
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

/**
 * The scheduler keys are the only fixture this file needs.
 *
 * `scheduler:queue_ok_at` is spelled OUT rather than imported (A2.1), and the
 * assertion below is what makes that safe. The key name is a production
 * interface — it is what an operator greps and what an `ops` SQL snippet or a
 * future dashboard reads — so a rename must fail a test rather than follow the
 * import silently. Writing it out was also what made the red-first run
 * informative: with the constant imported, a missing export fails the whole
 * file at load and proves only that a symbol is absent.
 */
const QUEUE_OK_KEY = 'scheduler:queue_ok_at';

test('the queue-freshness key this file writes IS the key production reads', () => {
  assert.equal(SCHEDULER_QUEUE_OK_KEY, QUEUE_OK_KEY);
});

after(async () => {
  await redis.del(SCHEDULER_HEARTBEAT_KEY);
  await redis.del(SCHEDULER_PARKED_TOTAL_KEY);
  await redis.del(QUEUE_OK_KEY);
  await closeRedis();
});

/**
 * Both keys live in the SHARED test Redis, and every real `POST /workers/tick`
 * in the suite publishes the parked-row count — so a value left behind by
 * another file would add a 503 reason to a case that is asserting on something
 * else entirely. Cleared before each case; the cases that need one set it.
 */
beforeEach(async () => {
  await redis.del(SCHEDULER_PARKED_TOTAL_KEY);
  // Same reasoning for the queue-freshness key (A2.1): every real
  // `POST /workers/tick` in the suite refreshes it, and a STALE value left by
  // another file would add a 503 reason to a case asserting on something else.
  await redis.del(QUEUE_OK_KEY);
});

async function setHeartbeat(at: Date): Promise<void> {
  await redis.setex(SCHEDULER_HEARTBEAT_KEY, SCHEDULER_HEARTBEAT_TTL_S, at.toISOString());
}

async function setParkedTotal(raw: string): Promise<void> {
  await redis.setex(SCHEDULER_PARKED_TOTAL_KEY, SCHEDULER_PARKED_TOTAL_TTL_S, raw);
}

/** The last instant phase 1 is known to have delivered (A2.1). */
async function setQueueOk(raw: string): Promise<void> {
  await redis.setex(QUEUE_OK_KEY, SCHEDULER_HEARTBEAT_TTL_S, raw);
}

/**
 * The WHOLE healthy scheduler arrangement — a tick that just ran AND a queue
 * that delivered on it.
 *
 * Both halves are load-bearing since A3.1. `scheduler:queue_ok_at` is written
 * only by a DELIVERING tick, so letting it expire was the one way a signal
 * could delete itself: under a continuing outage nothing refreshes it, the 24h
 * TTL runs to zero, and the endpoint went GREEN — emailing "UP / resolved"
 * over an outage that was still running. An absent key beside a TICKING
 * scheduler is therefore a reason of its own now, which means a case about
 * something ELSE (the pager, the parked count) has to arrange both halves or
 * it collects a queue reason it never meant to assert on.
 */
async function setSchedulerHealthy(): Promise<void> {
  await setHeartbeat(new Date());
  await setQueueOk(new Date().toISOString());
}

/**
 * Let every started send settle. The de-duplication allowance is spent when a
 * send SUCCEEDS (D20-A5.3), so a loop that fires hundreds of alarms inside one
 * event-loop turn de-duplicates nothing and measures `MAX_IN_FLIGHT` instead of
 * the thing it meant to.
 */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface WatchdogBody {
  status: string;
  last_tick_at: string | null;
  parked_total: number | null;
  queue_ok_at: string | null;
  staleness_s: number | null;
  stale_after_s: number;
  pager: {
    installed: boolean;
    consecutive_transport_failures: number;
    transport_failures_recent: number;
    dropped_alarms: number;
    dropped_alarms_recent: number;
    dropped_at_ceiling_recent: number;
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
  await setQueueOk(at.toISOString());

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
  await setSchedulerHealthy();

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
  await setSchedulerHealthy();

  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    // One sentence, repeated far past the allowance: every copy after the third
    // DELIVERED one is a drop, which is why each send is settled before the next
    // is raised (§A5.3).
    for (let i = 0; i < MAX_RECENT_DROPPED_ALARMS + IDENTICAL_ALLOWANCE + 5; i += 1) {
      captureAlarm({ message: 'a repeated condition', level: 'error', logger: 'pino' });
      await drain();
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

test('ONE alarm shed at the in-flight ceiling → 503, not a silent 200 (§A7.1)', async () => {
  // Round 4's finding, and the second exception to §A4.1's invariant. A slow
  // ingest fills MAX_IN_FLIGHT with unsettled sends; the very next event — a
  // FIRST-EVER lost hold, nothing identical ever delivered — is shed. It landed
  // only in `dropped_alarms_recent`, whose threshold is 200 for de-duplication's
  // sake, so this endpoint answered `200 ok`, `reasons: []` with the breaker
  // nowhere near its ceiling. That falsified §A4.1.5's own words: a drop at the
  // ceiling "counts and trips the watchdog like any other drop". It counted. It
  // did not trip.
  const hanging: AlarmTransport = {
    send(): Promise<void> {
      return new Promise<void>(() => undefined);
    },
  };
  initObservability({ transport: hanging, installProcessHandlers: false });
  await setSchedulerHealthy();

  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    for (let i = 0; i < MAX_IN_FLIGHT; i += 1) {
      captureAlarm({
        message: 'a distinct alarm',
        level: 'error',
        logger: 'pino',
        extra: { conditionId: `c-${String.fromCharCode(97 + (i % 26))}${i}` },
      });
    }
    captureAlarm({
      message: 'LOST HOLD: a dog is enrolled and its authorization is CANCELLED',
      level: 'error',
      logger: 'pino',
      extra: { chargeId: 'ch_never_seen_before', amountCents: 12000 },
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  const { statusCode, body } = await readWatchdog();
  assert.equal(
    body.pager.dropped_at_ceiling_recent,
    1,
    `precondition: exactly one shed money alarm; got ${JSON.stringify(body.pager)}`,
  );
  assert.ok(
    body.pager.dropped_alarms_recent < MAX_RECENT_DROPPED_ALARMS,
    'and the aggregate counter is FAR below its own threshold — that is the finding',
  );
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.ok(
    body.reasons.some((r) => r.includes('in-flight ceiling')),
    `the 503 must name the ceiling, not de-duplication; got ${JSON.stringify(body.reasons)}`,
  );
  assert.ok(
    MAX_RECENT_CEILING_DROPS <= 1,
    'a threshold above 1 cannot see this case, which is the whole finding',
  );
  // The breaker is a DIFFERENT scarcity gate and must not be implicated.
  assert.equal(body.pager.catastrophic_ceiling_tripped_at, null);
});

test('a FLAPPING pager → 503, though every OTHER send succeeded (§A5.3)', async () => {
  // Round 3's finding C. `consecutive_transport_failures` is reset by any
  // success, so a transport that rejects every other send destroyed 30 of 60
  // pages and this endpoint answered 200 with `reasons: []`. D20-A3 §A3.4.3
  // ruled transport failures countable and only the consecutive half was built.
  let n = 0;
  const flapping: AlarmTransport = {
    send(): Promise<void> {
      n += 1;
      return n % 2 === 0 ? Promise.reject(new Error('ingest 503')) : Promise.resolve();
    },
  };
  initObservability({ transport: flapping, installProcessHandlers: false });
  await setSchedulerHealthy();

  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    // Distinct money on every one: nothing here is de-duplication.
    for (let i = 0; i < 60; i += 1) {
      captureAlarm({
        message: 'LOST HOLD',
        level: 'error',
        logger: 'pino',
        extra: { chargeId: `ch_${i}` },
      });
      await drain();
    }
    await flushObservability(500);
  } finally {
    process.stderr.write = originalWrite;
  }

  const { statusCode, body } = await readWatchdog();
  assert.ok(
    body.pager.consecutive_transport_failures < 3,
    `precondition: the streak counter cannot see this (it read ` +
      `${body.pager.consecutive_transport_failures})`,
  );
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.ok(
    body.reasons.some((r) => r.includes('LOST') && r.includes('failed delivery')),
    `half the pages were destroyed; the monitor must be told. Got ${JSON.stringify(body.reasons)}`,
  );
  // The scheduler half is untouched — the endpoint separates its conditions.
  assert.ok(!body.reasons.some((r) => r.includes('scheduler tick')));
});

test('a heartbeat JS Date merely TOLERATES is corruption, not a 23-year-old tick (§A5.5 G)', async () => {
  // `new Date('2026')` is a valid date, so a corrupted key came back as a
  // `recorded` reading and the watchdog stated, as fact, *"last scheduler tick
  // was 20544230s ago"* — sending whoever read it to pg_cron for a fault that
  // lives in this key. The writer writes `toISOString()` and nothing else, so
  // the reader accepts exactly that and calls everything else corrupt.
  for (const raw of ['2026', '0', '1', 'December 17, 1995']) {
    initObservability({ installProcessHandlers: false });
    await redis.setex(SCHEDULER_HEARTBEAT_KEY, SCHEDULER_HEARTBEAT_TTL_S, raw);

    const { statusCode, body } = await readWatchdog();
    assert.equal(statusCode, 503, JSON.stringify(body));
    assert.equal(body.last_tick_at, null, `${raw} is not a tick this system ever recorded`);
    assert.ok(
      body.reasons.some((r) => r.includes('unparseable')),
      `${raw} must read as a corrupt key; got ${JSON.stringify(body.reasons)}`,
    );
    assert.ok(
      !body.reasons.some((r) => r.includes('last scheduler tick was')),
      `and must NOT report an age — that is the sentence that misdirects to pg_cron`,
    );
  }
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

// ── parked scheduled notifications: the standing signal (2026-09-03, A1.6) ──
// A parked row is a notification that will NEVER be delivered until a human
// acts, and its only other notice was ONE fire-and-forget page — which this
// module's own pager documents can be shed at the in-flight ceiling or lost to
// the transport. Allison's decision 4, ruled YES: it makes the monitor red.

test('parked scheduled notifications → 503 naming them, even with a fresh tick', async () => {
  initObservability({ installProcessHandlers: false });
  await setSchedulerHealthy();
  await setParkedTotal('4');

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.equal(body.parked_total, 4);
  assert.ok(
    body.reasons.some((r) => r.includes('parked scheduled notifications: 4')),
    `the 503 must name the count; got ${JSON.stringify(body.reasons)}`,
  );
  assert.ok(
    body.reasons.some((r) => r.includes('un-park or cancel')),
    'and must say what a human is supposed to do about it',
  );
  // The scheduler half is fine — the endpoint separates its conditions.
  assert.ok(!body.reasons.some((r) => r.includes('scheduler tick')));
});

test('zero parked scheduled notifications → 200, no reason', async () => {
  initObservability({ installProcessHandlers: false });
  await setSchedulerHealthy();
  await setParkedTotal('0');

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 200, JSON.stringify(body));
  assert.equal(body.parked_total, 0);
  assert.deepStrictEqual(body.reasons, []);
});

test('a CORRUPT parked-total key adds no reason and does not throw', async () => {
  // The reading has the heartbeat's four states for the heartbeat's reasons: a
  // Redis fault is already reported by the read one branch up, and inventing
  // "there are parked rows" about rows this endpoint cannot see would be the
  // same false sentence §A4.5 L3 exists to prevent. `Number('')` is 0 and
  // `Number('1e3')` is 1000, so the parse is exact rather than coerced.
  initObservability({ installProcessHandlers: false });
  await setSchedulerHealthy();
  for (const raw of ['garbage', '', '-1', '1e3', ' 7 ', '3.5']) {
    await setParkedTotal(raw);
    const { statusCode, body } = await readWatchdog();
    assert.equal(statusCode, 200, `${JSON.stringify(raw)} → ${JSON.stringify(body)}`);
    assert.equal(body.parked_total, null, `${JSON.stringify(raw)} is not a count`);
    assert.deepStrictEqual(body.reasons, [], `${JSON.stringify(raw)} must add no reason`);
  }
});

test('no parked-total key at all → 200, no reason (the state before the first tick)', async () => {
  initObservability({ installProcessHandlers: false });
  await setSchedulerHealthy();
  await redis.del(SCHEDULER_PARKED_TOTAL_KEY);

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 200, JSON.stringify(body));
  assert.equal(body.parked_total, null);
  assert.deepStrictEqual(body.reasons, []);
});

test('a tick that could not COUNT parked rows leaves the standing count alone', async () => {
  // The count is `null` when phase 1 threw at its boundary or the count query
  // itself failed. Publishing 0 for that would clear a true standing alarm on
  // exactly the tick that proved something is wrong — "I did not look" is not
  // "there are none". The previous value stands under its own 24h TTL.
  initObservability({ installProcessHandlers: false });
  await setParkedTotal('4');

  const tickApp = Fastify({ logger: false });
  registerAuth(tickApp);
  registerWorkersTickRoute(tickApp, {
    runTick: async () => ({
      ...TICK_RESULT,
      scheduledNotifications: { ...TICK_RESULT.scheduledNotifications, parkedTotal: null },
    }),
  });
  const tick = await tickApp.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  await tickApp.close();
  assert.equal(tick.statusCode, 200, tick.body);

  const { statusCode, body } = await readWatchdog();
  assert.equal(body.parked_total, 4, 'the last real count must survive a tick that could not count');
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.ok(body.reasons.some((r) => r.includes('parked scheduled notifications: 4')));
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
  // …and the standing parked-row count beside it (A1.6). The stub result says
  // zero rows are parked, and "zero" is a reading the watchdog must be able to
  // publish — it is what clears the reason above.
  assert.equal(body.parked_total, 0, 'the tick must publish the parked-row count too');
});

// ── the queue-not-delivering signal (2026-09-03, A2.1) ──────────────────────
// Ruled by Allison ~14:45 CDT: *a queue that is not delivering must turn the
// uptime monitor red after about ten minutes.*
//
// Step 1's phase-1 boundary is what took that red AWAY. Before it, a phase-1
// throw escaped to the route, the route answered 500, `recordSchedulerTick`
// was never reached, and the heartbeat went stale inside ten minutes — so a
// whole-queue notification outage went red on this endpoint by accident. The
// boundary removed the 500 deliberately (it also stopped phases 2-12, the four
// money phases included — the 2026-09-02 incident), and step 2's systemic
// branch removed the other path to it. Net, before this key: a schema drift on
// `notifications`, a statement-timeout episode or a bad deploy was PAGER-ONLY
// for as long as it lasted, on the one instrument whose whole purpose is to
// survive Sentry dying.
//
// The shape is a freshness key, not a streak counter: a consecutive-tick
// counter needs a read-modify-write in the tick's hot path and races two
// overlapping ticks. The heartbeat already solves exactly this problem with a
// written instant and a staleness comparison, and that shape is proven in
// production (real DOWN 02:26:38, real UP 02:31:44 UTC).

test('a STALE queue_ok_at → 503 naming the queue, even with a perfectly fresh tick', async () => {
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date());
  // Eleven minutes: the tick is RUNNING and stamping its heartbeat every
  // minute — this is precisely the state the heartbeat cannot see, because the
  // tick is fine and the QUEUE is not.
  const stale = new Date(Date.now() - 11 * 60 * 1000);
  await setQueueOk(stale.toISOString());

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.equal(body.status, 'down');
  assert.equal(body.queue_ok_at, stale.toISOString(), 'the body must publish what it read');
  assert.ok(
    body.reasons.some((r) => r.includes('scheduled-notification queue has not delivered')),
    `the 503 must name the queue; got ${JSON.stringify(body.reasons)}`,
  );
  assert.ok(
    body.reasons.some((r) => r.includes('every claimed row is failing, or phase 1 is throwing')),
    'and must name both ways phase 1 stops delivering, so the reader knows where to look',
  );
  // The scheduler half is fine — the endpoint separates its conditions, and
  // saying "the scheduler stopped" here would send whoever reads it to pg_cron.
  assert.ok(
    !body.reasons.some((r) => r.includes('last scheduler tick')),
    `the tick is fresh; got ${JSON.stringify(body.reasons)}`,
  );
});

test('a FRESH queue_ok_at → 200, no reason', async () => {
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date());
  // Nine minutes — inside the SAME threshold the heartbeat uses. One "too
  // long" for the system, not two.
  const fresh = new Date(Date.now() - 9 * 60 * 1000);
  await setQueueOk(fresh.toISOString());

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 200, JSON.stringify(body));
  assert.equal(body.queue_ok_at, fresh.toISOString());
  assert.deepStrictEqual(body.reasons, []);
  assert.equal(body.stale_after_s, SCHEDULER_STALE_AFTER_MS / 1000);
});

test('an ABSENT queue_ok_at while the scheduler is TICKING → 503: the key must not fail OPEN (A3.1)', async () => {
  // **The blocker round 3 found, and the reason this file's previous test —
  // named "the state before the first tick" — could never have caught it.**
  //
  // `scheduler:queue_ok_at` is written by ONE caller and only when phase 1
  // DELIVERED. Give that key a 24h TTL and raise its reason only when the
  // reading is `recorded`, and the signal deletes itself: under a continuing
  // outage nothing refreshes it, the TTL runs monotonically to zero, and this
  // endpoint goes GREEN — so the uptime monitor emails "UP / resolved" about
  // an outage that is still running. Any Redis restart mid-outage does it
  // immediately, because this is the one key of the three a broken queue never
  // rewrites (the heartbeat and `parked_total` are re-published every tick).
  //
  // The analogy to the parked key that justified the old branch is FALSE.
  // `parked_total` is rewritten by every tick that can count, so its absence
  // really does mean "nothing has published one". This key is written only on
  // HEALTH, so its absence means "nothing healthy has happened since it last
  // expired". Opposite meanings.
  //
  // The fresh-deploy carve-out survives, and the case below pins it: before a
  // deployment's first tick the HEARTBEAT is absent too, and its own branch
  // already carries the 503 — so the gate is "the scheduler is ticking".
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date());
  await redis.del(QUEUE_OK_KEY);

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.equal(body.status, 'down');
  assert.equal(body.queue_ok_at, null, 'there is nothing to publish — that IS the condition');
  assert.ok(
    body.reasons.some((r) => r.includes('scheduled-notification queue has not delivered')),
    `an expired freshness key must not read as health; got ${JSON.stringify(body.reasons)}`,
  );
  assert.ok(
    body.reasons.some((r) => r.includes(`${SCHEDULER_QUEUE_OK_KEY} is ABSENT`)),
    'and must name the key, so an operator knows which one to look at',
  );
  // The tick itself is fine; saying otherwise sends the reader to pg_cron.
  assert.ok(
    !body.reasons.some((r) => r.includes('last scheduler tick')),
    `the heartbeat is fresh; got ${JSON.stringify(body.reasons)}`,
  );
});

test('an absent queue_ok_at on a deployment that has NEVER ticked → 503 naming the scheduler, and only that (A3.1 carve-out)', async () => {
  // The carve-out A3.1 rests on, pinned rather than assumed. `absent` used to
  // add no reason so that a fresh deploy would not fail its own monitor — but
  // a deploy before its first tick has no HEARTBEAT either, and that branch
  // already answers 503 with the right sentence. So nothing is lost by making
  // the queue key fail CLOSED, and this case is what says so.
  //
  // It is proven by MUTATION rather than red-first: it holds before the fix as
  // well. Raise the queue reason unconditionally (drop the `schedulerIsTicking`
  // gate) and it goes RED with two reasons, one of which points at a queue that
  // has never had a chance to run.
  initObservability({ installProcessHandlers: false });
  await redis.del(SCHEDULER_HEARTBEAT_KEY);
  await redis.del(QUEUE_OK_KEY);

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.deepStrictEqual(
    body.reasons,
    ['no scheduler tick has been recorded'],
    'ONE fault, ONE sentence: nothing has run, so nothing can be said about the queue',
  );
});

test('a FUTURE-dated queue_ok_at → 503 with its own reason, not 70 minutes of green (A3.2)', async () => {
  // The heartbeat has had a clock-skew branch since §A4.4.4 and this key did
  // not, justified by a comment that pointed at the heartbeat's — which cannot
  // cover it, because the heartbeat is REWRITTEN on the failing path and this
  // key is not.
  //
  // Worked: a host clock steps an hour forward at 06:59, the 07:00 tick stamps
  // both keys 08:00, NTP corrects at 07:01. A drift at 07:02 stops the queue.
  // The 07:02 tick rewrites the heartbeat with 07:02 — fresh, no reason — and
  // leaves this key at 08:00, which `staleness > threshold` reads as healthy
  // for every negative number. Green until 08:10 over a dead queue, before
  // A3.1's 24-hour clock has even started.
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date());
  const future = new Date(Date.now() + 60 * 60 * 1000);
  await setQueueOk(future.toISOString());

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.equal(body.queue_ok_at, future.toISOString(), 'the body publishes what it read');
  assert.ok(
    body.reasons.some((r) => r.includes('scheduled-notification queue freshness')),
    `a future-dated key must get its own sentence; got ${JSON.stringify(body.reasons)}`,
  );
  assert.ok(
    body.reasons.some((r) => r.includes('FUTURE')),
    'and must say the reading is in the future',
  );
  // The heartbeat is honest here — this fault lives in the OTHER key, and
  // blaming the heartbeat would send the reader to the wrong instrument.
  assert.ok(
    !body.reasons.some((r) => r.includes('scheduler heartbeat is dated')),
    `got ${JSON.stringify(body.reasons)}`,
  );
});

test('a queue_ok_at inside the clock-skew tolerance is NOT a fault (A3.2)', async () => {
  // The heartbeat's own tolerance, for the heartbeat's own reason: the writer
  // and the reader are one process family on one clock, so a real negative
  // reading means the clock moved — but an NTP step of a second or two must
  // not flap the alarm an uptime monitor watches.
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date());
  await setQueueOk(new Date(Date.now() + Math.round(CLOCK_SKEW_TOLERANCE_MS / 2)).toISOString());

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 200, JSON.stringify(body));
  assert.deepStrictEqual(body.reasons, []);
});

test('a STOPPED scheduler gets exactly ONE reason — the queue sentence would be false (A3.3)', async () => {
  // The 2026-08-24 fault: a rotated `SCHEDULER_WEBHOOK_SECRET`, every
  // `net.http_post` 401s, no tick runs at all. Both keys age out together, so
  // the queue reason fired too — saying "every claimed row is failing, or
  // phase 1 is throwing (see the phase alarm)" when there is NO phase alarm,
  // because nothing is running. Whoever is paged greps for a line that cannot
  // exist and holds two contradictory sentences about one incident, on the
  // endpoint whose entire purpose is to say what broke.
  //
  // The status code never changes: the heartbeat's own reason already carries
  // the 503. Only the second, false sentence goes.
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date(Date.now() - SCHEDULER_STALE_AFTER_MS - 60_000));
  await setQueueOk(new Date(Date.now() - SCHEDULER_STALE_AFTER_MS - 60_000).toISOString());

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.equal(body.reasons.length, 1, `exactly one fault, one sentence; got ${JSON.stringify(body.reasons)}`);
  assert.ok(body.reasons[0]?.includes('last scheduler tick was'), body.reasons[0]);
  assert.ok(
    !body.reasons.some((r) => r.includes('see the phase alarm')),
    'there is no phase alarm — nothing ran',
  );
});

test('a STOPPED scheduler whose queue key has EXPIRED still gets exactly one reason (A3.1 × A3.3)', async () => {
  // Where the two fixes compose. A3.1 makes an absent key a reason; A3.3 gates
  // every queue reason on a ticking scheduler. A scheduler stopped for a day
  // has both an old heartbeat and no queue key at all, and it must still read
  // as ONE fault.
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date(Date.now() - SCHEDULER_STALE_AFTER_MS - 60_000));
  await redis.del(QUEUE_OK_KEY);

  const { statusCode, body } = await readWatchdog();
  assert.equal(statusCode, 503, JSON.stringify(body));
  assert.equal(body.reasons.length, 1, `got ${JSON.stringify(body.reasons)}`);
  assert.ok(body.reasons[0]?.includes('last scheduler tick was'), body.reasons[0]);
});

test('the queue key TTL is pinned, and is far longer than the staleness threshold (A3.4)', () => {
  // Nothing asserted this constant, and it is what decides whether an outage
  // reads as "stale" (a duration this endpoint can state) or as "absent" (one
  // it cannot). Collapse it toward the staleness threshold and the gate stays
  // green while production loses the informative sentence within one threshold
  // of every outage — and, before A3.1, went outright GREEN at that moment.
  assert.equal(SCHEDULER_QUEUE_OK_TTL_S, 24 * 60 * 60, 'the freshness key lives for 24h');
  assert.ok(
    SCHEDULER_QUEUE_OK_TTL_S * 1000 >= 24 * SCHEDULER_STALE_AFTER_MS,
    `the TTL (${SCHEDULER_QUEUE_OK_TTL_S}s) must be COMFORTABLY longer than the staleness ` +
      `threshold (${SCHEDULER_STALE_AFTER_MS / 1000}s), or "stale" collapses into "absent"`,
  );
});

test('a CORRUPT queue_ok_at while the scheduler is TICKING → 503 with its own sentence naming the corruption, not a silent 200 (A4 (iii))', async () => {
  // **A4 (iii), and it REVERSES this file's own previous pin** — which read
  // *'a CORRUPT queue_ok_at adds no reason and does not throw'* and asserted
  // 200 with `reasons: []` for exactly these six values.
  //
  // The parsing discipline is unchanged and still the heartbeat's:
  // `new Date('2026')` parses, and the endpoint once reported a 23-year-old
  // tick as fact, so only an exact `toISOString()` round trip is `recorded`.
  // What changed is what an `unparseable` reading MEANS while the scheduler is
  // ticking. The same fact is true of a corrupt key as of a missing one: there
  // is no valid delivery instant, so nothing says phase 1 delivered — and the
  // fail-OPEN arm let a single corrupt key silently delete a standing queue
  // alarm, the same shape A3.1 closed for `absent`.
  //
  // It gets its OWN sentence rather than the absent one: "ABSENT" is false of a
  // key that is present, and no duration is stated because there is no instant
  // to subtract — the §A4.5 L3 rule, and the same reason the heartbeat's own
  // corruption case has a sentence of its own.
  //
  // The cost is bounded and the case below this one pins it: `recordQueueOk`
  // is an unconditional `SETEX` on every DELIVERING tick, so over a healthy
  // queue a corrupt key is overwritten within one tick.
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date());
  for (const raw of ['garbage', '', '2026', '0', 'December 17, 1995', '2026-09-03T00:00:00.000']) {
    await setQueueOk(raw);
    const { statusCode, body } = await readWatchdog();
    assert.equal(statusCode, 503, `${JSON.stringify(raw)} → ${JSON.stringify(body)}`);
    assert.equal(body.status, 'down', `${JSON.stringify(raw)} → ${JSON.stringify(body)}`);
    assert.equal(body.queue_ok_at, null, `${JSON.stringify(raw)} is not an instant`);
    assert.equal(
      body.reasons.length,
      1,
      `${JSON.stringify(raw)} → one fault, one sentence; got ${JSON.stringify(body.reasons)}`,
    );
    const reason = body.reasons[0] ?? '';
    assert.ok(reason.includes('UNPARSEABLE'), `${JSON.stringify(raw)} → ${reason}`);
    assert.ok(
      reason.includes(SCHEDULER_QUEUE_OK_KEY),
      `it must name the key an operator has to look at; got ${reason}`,
    );
    assert.ok(
      !reason.includes('ABSENT'),
      `the key is PRESENT and corrupt — "ABSENT" would be false; got ${reason}`,
    );
    assert.ok(
      !reason.includes('has not delivered for'),
      `there is no instant to subtract, so no duration may be stated; got ${reason}`,
    );
    // The tick itself is fine; blaming the heartbeat sends the reader to pg_cron.
    assert.ok(
      !reason.includes('scheduler heartbeat'),
      `the heartbeat is fresh; got ${reason}`,
    );
  }
});

test('a corrupt queue_ok_at over a HEALTHY queue clears on the very next DELIVERING tick (A4 (iii): the bounded cost, through the real route)', async () => {
  // What makes (iii) a fail-CLOSED arm worth having rather than a monitor that
  // stays red on a Redis blip. `recordQueueOk` is an unconditional `SETEX`
  // fired by `POST /workers/tick` on every tick whose phase 1 delivered
  // (`workersTick.ts`, `if (result.scheduledNotifications.queueOk)`), so a
  // corrupt value over a HEALTHY queue survives at most one tick — the false
  // 503 costs one tick plus one monitor interval. Over a BROKEN queue nothing
  // rewrites it and the red stands, which is the point.
  //
  // Run through the REAL tick route (its `runTick` stubbed only so this file
  // does not run the twelve-phase tick against the shared fixture DB), because
  // the self-heal is a production-shape claim about a WRITE this test file
  // otherwise never exercises on this key.
  initObservability({ installProcessHandlers: false });
  await setHeartbeat(new Date());
  await setQueueOk('not-a-timestamp');

  const before = await readWatchdog();
  assert.equal(before.statusCode, 503, JSON.stringify(before.body));
  assert.equal(before.body.queue_ok_at, null, 'nothing true can be published from a corrupt key');
  assert.ok(
    before.body.reasons.some((r) => r.includes('UNPARSEABLE')),
    `precondition: the corrupt key is what is red; got ${JSON.stringify(before.body.reasons)}`,
  );

  const tickApp = Fastify({ logger: false });
  registerAuth(tickApp);
  registerWorkersTickRoute(tickApp, {
    // `queueOk: true` — phase 1 delivered, which is the ONLY condition under
    // which the route writes this key.
    runTick: async () => TICK_RESULT,
  });
  const tick = await tickApp.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  await tickApp.close();
  assert.equal(tick.statusCode, 200, tick.body);

  const after = await readWatchdog();
  assert.equal(after.statusCode, 200, JSON.stringify(after.body));
  assert.deepStrictEqual(after.body.reasons, [], 'one delivering tick clears it');
  assert.ok(
    typeof after.body.queue_ok_at === 'string',
    `the tick must have overwritten the corrupt value; got ${JSON.stringify(after.body.queue_ok_at)}`,
  );
  const freshnessMs = Date.now() - new Date(after.body.queue_ok_at as string).getTime();
  assert.ok(
    freshnessMs >= -CLOCK_SKEW_TOLERANCE_MS && freshnessMs < SCHEDULER_STALE_AFTER_MS,
    `and it must be a FRESH instant, not a surviving stale one; got ${after.body.queue_ok_at}`,
  );
});

// ── the full truth table over the two scheduler keys (A3.1 + A3.3) ─────────
// A3.1 and A3.3 both condition the queue check on the HEARTBEAT reading, so
// they can only be trusted together. This is every reachable cell, and the
// same table is written out in `healthWatchdog.ts` above the queue block.
//
// `unreadable` is deliberately not a row or a column: both keys are read by
// the same client inside one `Promise.all` against one 1s deadline, so a Redis
// that cannot be read produces `unreadable` for BOTH at once — the mixed cells
// do not exist in production. That single cell is pinned against a real TCP
// blackhole in `test/schedulerHeartbeatTimeout.test.ts`, and it lands in the
// `heartbeat is not fresh` row below: one sentence, "I cannot see".

type HeartbeatState = 'fresh' | 'stale' | 'future' | 'absent' | 'unparseable';
type QueueState = 'fresh' | 'stale' | 'future' | 'absent' | 'unparseable';

const HEARTBEAT_STATES: HeartbeatState[] = ['fresh', 'stale', 'future', 'absent', 'unparseable'];
const QUEUE_STATES: QueueState[] = ['fresh', 'stale', 'future', 'absent', 'unparseable'];

async function arrangeHeartbeat(state: HeartbeatState): Promise<void> {
  const ago = SCHEDULER_STALE_AFTER_MS + 60_000;
  if (state === 'absent') return redis.del(SCHEDULER_HEARTBEAT_KEY).then(() => undefined);
  if (state === 'unparseable') {
    return redis
      .setex(SCHEDULER_HEARTBEAT_KEY, SCHEDULER_HEARTBEAT_TTL_S, 'not-a-timestamp')
      .then(() => undefined);
  }
  const at =
    state === 'fresh'
      ? new Date()
      : state === 'stale'
        ? new Date(Date.now() - ago)
        : new Date(Date.now() + 60 * 60 * 1000);
  return setHeartbeat(at);
}

async function arrangeQueue(state: QueueState): Promise<void> {
  const ago = SCHEDULER_STALE_AFTER_MS + 60_000;
  if (state === 'absent') return redis.del(QUEUE_OK_KEY).then(() => undefined);
  if (state === 'unparseable') return setQueueOk('not-a-timestamp');
  const at =
    state === 'fresh'
      ? new Date()
      : state === 'stale'
        ? new Date(Date.now() - ago)
        : new Date(Date.now() + 60 * 60 * 1000);
  return setQueueOk(at.toISOString());
}

/** One label per sentence this endpoint can say about the two scheduler keys. */
function classify(reason: string): string {
  if (reason.startsWith('scheduler heartbeat is UNREADABLE')) return 'hb-unreadable';
  if (reason.startsWith('scheduler heartbeat value is unparseable')) return 'hb-unparseable';
  if (reason.startsWith('scheduler heartbeat is dated')) return 'hb-future';
  if (reason.startsWith('no scheduler tick has been recorded')) return 'hb-absent';
  if (reason.startsWith('last scheduler tick was')) return 'hb-stale';
  if (reason.startsWith('scheduled-notification queue key is UNPARSEABLE')) {
    return 'q-unparseable';
  }
  if (reason.startsWith('scheduled-notification queue freshness')) return 'q-future';
  if (reason.startsWith('scheduled-notification queue has not delivered at all')) return 'q-absent';
  if (reason.startsWith('scheduled-notification queue has not delivered for')) return 'q-stale';
  if (reason.startsWith('parked scheduled notifications')) return 'parked';
  return `UNCLASSIFIED: ${reason}`;
}

test('every cell of the heartbeat × queue_ok_at table says something TRUE', async () => {
  initObservability({ installProcessHandlers: false });

  for (const h of HEARTBEAT_STATES) {
    for (const q of QUEUE_STATES) {
      await redis.del(SCHEDULER_PARKED_TOTAL_KEY);
      await arrangeHeartbeat(h);
      await arrangeQueue(q);

      // The heartbeat speaks for itself in every state but `fresh`.
      const heartbeatLabel =
        h === 'fresh'
          ? null
          : h === 'stale'
            ? 'hb-stale'
            : h === 'future'
              ? 'hb-future'
              : h === 'absent'
                ? 'hb-absent'
                : 'hb-unparseable';
      // The queue speaks ONLY when the scheduler is ticking (A3.3): with no
      // tick running, "every claimed row is failing, or phase 1 is throwing
      // (see the phase alarm)" names an alarm that cannot exist. And when it
      // does speak, an ABSENT key is a reason (A3.1) — it is written only on
      // health, so its expiry means "nothing healthy has happened", the
      // opposite of the parked key whose absence means "nobody has published".
      // A CORRUPT key is a reason too since A4 (iii), in its own sentence: the
      // same fact is true of it as of a missing one — no valid delivery
      // instant — and this cell read `null` (fail OPEN) until that ruling.
      const queueLabel =
        h !== 'fresh'
          ? null
          : q === 'fresh'
            ? null
            : q === 'stale'
              ? 'q-stale'
              : q === 'future'
                ? 'q-future'
                : q === 'absent'
                  ? 'q-absent'
                  : 'q-unparseable'; // A4 (iii): fails CLOSED, with its own sentence

      const expected = [heartbeatLabel, queueLabel].filter((x): x is string => x !== null);
      const { statusCode, body } = await readWatchdog();
      const got = body.reasons.map(classify);
      assert.deepStrictEqual(
        got,
        expected,
        `heartbeat=${h} queue=${q} → ${JSON.stringify(body.reasons)}`,
      );
      assert.equal(
        statusCode,
        expected.length === 0 ? 200 : 503,
        `heartbeat=${h} queue=${q} → ${JSON.stringify(body)}`,
      );
    }
  }
});

/** A complete, all-zero `SchedulerTickResult`. */
const TICK_RESULT: SchedulerTickResult = {
  scheduledNotifications: {
    scanned: 0,
    sent: 0,
    failed: 0,
    parked: 0,
    parkedTotal: 0,
    queueOk: true,
    pushTicketsOk: 0,
    pushTicketsError: 0,
  },
  membershipRoll: { scanned: 0, rolled: 0, completed: 0 },
  invoiceOverdue: { scanned: 0, enqueued: 0 },
  cardExpiry: { scanned: 0, enqueued: 0 },
  invoiceAttemptVerify: { scanned: 0, results: [] },
  orderSweeper: { scanned: 0, abandoned: 0, settled: 0, failed: 0, lateRefunded: 0, left: 0 },
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
