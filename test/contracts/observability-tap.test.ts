import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/plugin.js';
import { hashRequestBody, withMutation } from '../../src/db/mutation.js';
import { env } from '../../src/env.js';
import {
  alarmForwardingHooks,
  initObservability,
  type AlarmEvent,
  type AlarmTransport,
} from '../../src/lib/observability.js';
import { registerWorkersTickRoute } from '../../src/routes/workersTick.js';
import { buildApp } from '../../src/server.js';
import type { SchedulerTickResult } from '../../src/workers/scheduler.js';
import { FIXTURE_OWNER_PRINCIPAL, SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * **Does an alarm reach the PAGER on the production path?**
 *
 * `workers-tick-alarms.test.ts` (round 6) pinned the previous question — does
 * the production call shape produce alarm OUTPUT — after a tick refunded
 * 12000c to an owner and printed nothing. It is untouched by Day-20 and stays
 * green; the tap is additive to the channel it guards.
 *
 * This file pins the half that was still missing on 2026-08-24: the output
 * reaches a human. Same discipline, one hop further out. Every test here
 * drives a REAL app — `buildApp()` from `server.ts`, or the real
 * `/workers/tick` route over HTTP — never a hand-assembled logger, because a
 * hand-assembled logger is exactly what "proven in tests, dead in production"
 * looks like.
 *
 * `test/observability.test.ts` covers the module in isolation (Sentry wire
 * format, level filtering, flush). What is here is the WIRING: that
 * `server.ts` installs the tap, that a worker alarm carried by `request.log`
 * arrives at the transport, that a broken pager cannot break a request, that
 * `mutation.ts`'s three post-commit swallows page, and that with no DSN the
 * whole thing is inert.
 */

registerFixtureHooks();

/** A transport that records what it was asked to send. */
interface RecordingTransport extends AlarmTransport {
  readonly events: AlarmEvent[];
}

function makeRecordingTransport(): RecordingTransport {
  const events: AlarmEvent[] = [];
  return {
    events,
    send(event: AlarmEvent): Promise<void> {
      events.push(event);
      return Promise.resolve();
    },
  };
}

/**
 * A COMPLETE `SchedulerTickResult` — every phase, all zeroes. The tick itself
 * is exercised by `scheduler-worker.test.ts` and `workers-tick-alarms.test.ts`;
 * what this file needs from `runTick` is only that it RAISES AN ALARM on the
 * logger the route hands it — the required `log` field that round 6 made a
 * compile error to omit.
 *
 * It used to be a five-phase partial behind an `as unknown as` cast, which is a
 * lie the compiler was talked out of checking (`test/` is in no tsconfig, so
 * nothing would have caught it either way). D20-A3 §A3.4.1 made the completion
 * log line read EVERY phase's counters, and a partial fixture would have failed
 * as a `TypeError` on an undefined phase rather than as a missing counter.
 */
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

/** Capture `process.stderr.write` for the duration of `fn`. */
async function withCapturedStderr(fn: () => Promise<void> | void): Promise<string[]> {
  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

// ---- 1. server.ts installs the tap ----------------------------------------

test('buildApp(): the production app factory forwards request-level alarms to the pager', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  // The app the production entrypoint builds — `env.LOG_LEVEL`, the real
  // route table, and whatever `server.ts` says the logger is. If the `hooks:`
  // wiring is ever dropped from that one line, this goes red and nothing else
  // in the suite does.
  const app = buildApp();
  app.get('/__d20-alarm-probe', async (request, reply) => {
    request.log.error(
      { chargeId: 'ch_probe', amountCents: 12_000 },
      'SURPLUS REFUND — probe alarm on the production app factory',
    );
    return reply.code(204).send();
  });

  const response = await app.inject({ method: 'GET', url: '/__d20-alarm-probe' });
  assert.equal(response.statusCode, 204);
  await app.close();

  assert.equal(
    transport.events.length,
    1,
    `an error-level line on a buildApp() request must page; captured ${JSON.stringify(
      transport.events,
    )}`,
  );
  const event = transport.events[0];
  assert.ok(event !== undefined);
  assert.equal(event.level, 'error');
  assert.equal(event.logger, 'pino');
  assert.equal(event.message, 'SURPLUS REFUND — probe alarm on the production app factory');
  const extra = event.extra as Record<string, unknown>;
  assert.equal(extra['chargeId'], 'ch_probe');
  assert.equal(extra['amountCents'], 12_000);
  // D20-A1: the page must be correlatable to its Railway log line. logMethod
  // sees only the CALL's arguments — `reqId` is a child-logger BINDING, added
  // at serialization — so the hook reads `this.bindings()`. This is the pin.
  assert.ok(
    typeof extra['reqId'] === 'string' && extra['reqId'].length > 0,
    `the paged event must carry reqId — the join key back to its log line; extra=${JSON.stringify(extra)}`,
  );
});

// ---- 2. a worker alarm on POST /workers/tick reaches the pager -------------

test('POST /workers/tick: a worker alarm on request.log reaches the pager, and the tick still 200s', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  // The production logger shape from `server.ts` — level + the tap. The
  // alarm is raised on the `log` the ROUTE passes into the worker seam
  // (`workersTick.ts:85-92`), which is the path every real money alarm takes.
  const app = Fastify({ logger: { level: env.LOG_LEVEL, hooks: alarmForwardingHooks() } });
  registerAuth(app);
  registerWorkersTickRoute(app, {
    runTick: async (opts) => {
      opts.log.error(
        { chargeId: 'ch_tick', amountCents: 4_500, refundId: 're_tick' },
        'LOST HOLD — a group-class hold vanished before capture',
      );
      return TICK_RESULT;
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  await app.close();

  const alarms = transport.events.filter((e) => e.message.includes('LOST HOLD'));
  assert.equal(
    alarms.length,
    1,
    `the worker alarm must page; got ${JSON.stringify(transport.events)}`,
  );
  assert.equal(alarms[0]?.level, 'error');
  const tickExtra = alarms[0]?.extra as Record<string, unknown>;
  assert.equal(tickExtra['chargeId'], 'ch_tick');
  assert.equal(tickExtra['amountCents'], 4_500);
  assert.equal(tickExtra['refundId'], 're_tick');
  // D20-A1: same correlation pin as the buildApp() probe — a money alarm's
  // page without its reqId is a siren with no address.
  assert.ok(
    typeof tickExtra['reqId'] === 'string' && tickExtra['reqId'].length > 0,
    `the tick alarm must carry reqId; extra=${JSON.stringify(tickExtra)}`,
  );
});

// ---- 3. a broken pager cannot break a request ------------------------------

test('POST /workers/tick: a THROWING transport still logs, still returns 200, and writes one stderr line', async () => {
  const exploding: AlarmTransport = {
    send(): Promise<void> {
      throw new Error('synthetic pager outage');
    },
  };
  initObservability({ transport: exploding, installProcessHandlers: false });

  // The log destination is captured so the assertion is "the line was still
  // written", not "nothing crashed" — a hook that swallowed the alarm instead
  // of forwarding it would pass the weaker claim.
  const lines: Array<Record<string, unknown>> = [];
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      hooks: alarmForwardingHooks(),
      stream: {
        write(msg: string): void {
          lines.push(JSON.parse(msg) as Record<string, unknown>);
        },
      },
    },
  });
  registerAuth(app);
  registerWorkersTickRoute(app, {
    runTick: async (opts) => {
      opts.log.error({ chargeId: 'ch_outage' }, 'SURPLUS REFUND — during a pager outage');
      return TICK_RESULT;
    },
  });

  let response: Awaited<ReturnType<typeof app.inject>> | undefined;
  const captured = await withCapturedStderr(async () => {
    response = await app.inject({
      method: 'POST',
      url: '/workers/tick',
      headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
    });
  });
  await app.close();

  assert.equal(response?.statusCode, 200, `a dead pager must not fail the tick: ${response?.body}`);
  const alarms = lines.filter(
    (line) => typeof line['msg'] === 'string' && line['msg'].includes('SURPLUS REFUND'),
  );
  assert.equal(alarms.length, 1, 'the log is the record — it must survive the pager being down');
  assert.equal(alarms[0]?.['chargeId'], 'ch_outage');
  assert.ok(
    typeof alarms[0]?.['level'] === 'number' && alarms[0]['level'] >= 50,
    'and it must still be an ERROR',
  );

  const stderr = captured.join('');
  assert.ok(
    stderr.includes('alarm NOT delivered') && stderr.includes('synthetic pager outage'),
    `the dropped alarm must leave an operator-visible trace; got: ${stderr}`,
  );
});

// ---- 4. mutation.ts's three post-commit swallows ---------------------------

test(
  'withMutation: each post-commit swallow pages with the endpoint and idempotency key',
  SKIP_WHEN_NO_DB,
  async () => {
    const transport = makeRecordingTransport();
    initObservability({ transport, installProcessHandlers: false });

    // One case per swallow site (`mutation.ts` :245 / :262 / :273). All three
    // are post-COMMIT: the write is already durable, so the failure can only
    // ever be told to a person. The third is money-adjacent (Stripe detach /
    // refund), which is why "told to a person" has to mean paged.
    const sites = [
      {
        label: 'keysToInvalidate',
        params: {
          keysToInvalidate: (): string[] => {
            throw new Error('synthetic redis blip');
          },
        },
        expect: 'post-commit invalidate failed',
      },
      {
        label: 'patternsToInvalidate',
        params: {
          patternsToInvalidate: (): string[] => {
            throw new Error('synthetic scan blip');
          },
        },
        expect: 'post-commit pattern-invalidate failed',
      },
      {
        label: 'postCommit',
        params: {
          postCommit: (): Promise<void> => {
            throw new Error('synthetic stripe detach failure');
          },
        },
        expect: 'post-commit side-effect failed',
      },
    ] as const;

    for (const site of sites) {
      transport.events.length = 0;
      const idempotencyKey = randomUUID();
      const endpoint = `POST /test/day-20-${site.label}`;

      const captured = await withCapturedStderr(async () => {
        const outcome = await withMutation(
          {
            principal: FIXTURE_OWNER_PRINCIPAL,
            idempotencyKey,
            endpoint,
            requestHash: hashRequestBody({ probe: site.label }),
            ...site.params,
          },
          async () => ({ status: 201, body: { committed: true } as const }),
        );
        // The mutation committed honestly and said so. Nothing about being
        // observed may change that.
        assert.equal(outcome.replayed, false, site.label);
        assert.equal(outcome.status, 201, site.label);
        assert.deepStrictEqual(outcome.body, { committed: true }, site.label);
      });

      // The stderr line is the record and stays exactly as it was…
      assert.ok(
        captured.join('').includes(site.expect),
        `${site.label}: the stderr line must survive; got ${captured.join('')}`,
      );
      // …and the page is what is new.
      assert.equal(
        transport.events.length,
        1,
        `${site.label}: exactly one alarm; got ${JSON.stringify(transport.events)}`,
      );
      const event = transport.events[0];
      assert.ok(event !== undefined);
      assert.equal(event.level, 'error');
      assert.equal(event.logger, 'withMutation');
      assert.ok(
        event.message.includes(site.expect),
        `${site.label}: the alarm must carry the same sentence; got ${event.message}`,
      );
      // Without these two an on-call page says "something failed somewhere".
      const extra = event.extra as Record<string, unknown>;
      assert.equal(extra['endpoint'], endpoint, site.label);
      assert.equal(extra['idempotencyKey'], idempotencyKey, site.label);
      assert.ok(extra['err'] instanceof Error, `${site.label}: the cause must ride along`);
    }
  },
);

// ---- 5. no DSN: the whole seam is inert ------------------------------------

test('no DSN: a full app boot and a tick produce ZERO transport calls', async (t: TestContext) => {
  assert.equal(
    env.SENTRY_DSN,
    undefined,
    'this test only means something while the test environment has no DSN',
  );

  const fetchCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', (input: string) => {
    fetchCalls.push(String(input));
    return Promise.resolve(new Response('', { status: 200 }));
  });

  // No injected transport, no DSN — production's dev/test posture.
  initObservability();

  const app = buildApp();
  app.get('/__d20-noop-probe', async (request, reply) => {
    request.log.error({ chargeId: 'ch_noop' }, 'SURPLUS REFUND — must page nobody here');
    return reply.code(204).send();
  });
  assert.equal((await app.inject({ method: 'GET', url: '/__d20-noop-probe' })).statusCode, 204);
  await app.close();

  const tickApp = Fastify({ logger: { level: env.LOG_LEVEL, hooks: alarmForwardingHooks() } });
  registerAuth(tickApp);
  registerWorkersTickRoute(tickApp, {
    runTick: async (opts) => {
      opts.log.error({ chargeId: 'ch_noop_tick' }, 'LOST HOLD — must page nobody here');
      return TICK_RESULT;
    },
  });
  const tick = await tickApp.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  assert.equal(tick.statusCode, 200, tick.body);
  await tickApp.close();

  assert.deepStrictEqual(
    fetchCalls,
    [],
    'with SENTRY_DSN unset the seam must emit no network traffic at all',
  );
});

// ---- 6. a CLIENT's error is not OUR error: 4xx must not page (D20-A2 §A2.1a)

/**
 * The blocker attack round 1 found. `authenticate` is a preHandler, so body
 * parsing and schema validation run BEFORE auth — an anonymous, unauthenticated
 * `curl` with a broken JSON body reaches the error handler, which logged EVERY
 * non-`ApiError` at level 50. Once this cycle taps level 50, that is a page.
 * The lane queued 200 pages in 18 ms from an unauthenticated client; Sentry's
 * free tier is 5,000 events/month consumed AT INGEST, after which the SURPLUS
 * REFUND page is dropped to one stderr line.
 *
 * The fix mirrors the `ApiError` branch directly above it (`plugin.ts:193`):
 * 5xx is ours and pages, 4xx is the client's and warns. Bodies and status codes
 * are untouched — this is a logging-LEVEL change only, which is why the status
 * assertions below sit beside the paging ones.
 */
test('an anonymous 4xx does NOT page, and a genuine 500 still pages exactly once', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  const app = buildApp();
  app.get('/__d20-500-probe', async () => {
    // A non-`ApiError` with no `statusCode` — the 500 arm of the same handler.
    throw new Error('synthetic unhandled fault');
  });

  // (a) malformed JSON from an anonymous client. `/dogs` is [auth], and it
  // never gets there: the body parser fails first, which is the whole point.
  const malformed = await app.inject({
    method: 'POST',
    url: '/dogs',
    headers: { 'content-type': 'application/json' },
    payload: '{"name":',
  });
  assert.equal(malformed.statusCode, 400, `bodies and codes must not change: ${malformed.body}`);

  // (b) an unparseable content type — same handler, same anonymous reach.
  const badContentType = await app.inject({
    method: 'POST',
    url: '/dogs',
    headers: { 'content-type': 'application/x-not-a-thing' },
    payload: 'whatever',
  });
  assert.equal(badContentType.statusCode, 415, badContentType.body);

  assert.deepStrictEqual(
    transport.events.map((e) => e.message),
    [],
    'an unauthenticated client must not be able to spend a single page of the quota ' +
      'that the money alarms share',
  );

  // …and the branch still pages for what IS ours.
  const fault = await app.inject({ method: 'GET', url: '/__d20-500-probe' });
  assert.equal(fault.statusCode, 500, fault.body);
  await app.close();

  assert.equal(
    transport.events.length,
    1,
    `a real 500 must still wake someone; got ${JSON.stringify(transport.events.map((e) => e.message))}`,
  );
  assert.equal(transport.events[0]?.level, 'error');
  assert.equal(transport.events[0]?.message, 'unhandled error');
});

// ---- 6b. the two signed webhook routes (D20-A4 §A4.2) ---------------------

/**
 * `stripeWebhook.ts:65` and `authWebhook.ts:36` hand `done()` a BARE `Error`
 * with no `statusCode`, so `auth/plugin.ts` computes 500 and pages — for a
 * body an anonymous client chose. Found by an 854-injection sweep across all
 * 178 route entries with the budget reset per probe: exactly four hits, these
 * two routes, malformed-JSON and empty-body. Sustained cost measured at
 * **43,200 events/month against a 5,000/month tier — the quota gone in ~3.5
 * days, from `curl`, unauthenticated.** Both files carried a comment asserting
 * these bodies "fall through to 400 cleanly"; both comments were false, and
 * both are corrected in the same diff as the code.
 *
 * A2.1(a)'s reasoning applies verbatim and simply had not been carried here: a
 * client's malformed JSON is not our error. Genuine Stripe traffic is
 * unaffected — Stripe does not send malformed JSON, and the signature check
 * runs after parsing either way.
 */
test('the signed webhook routes: a malformed or empty body is a 400 and pages NOBODY', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  const app = buildApp();
  const probes: Array<{ url: string; payload: string; what: string }> = [
    { url: '/webhooks/stripe', payload: '{', what: 'stripe / malformed JSON' },
    { url: '/webhooks/stripe', payload: '', what: 'stripe / empty body' },
    { url: '/auth/webhook', payload: '{', what: 'auth / malformed JSON' },
    { url: '/auth/webhook', payload: '', what: 'auth / empty body' },
  ];

  for (const probe of probes) {
    const response = await app.inject({
      method: 'POST',
      url: probe.url,
      headers: { 'content-type': 'application/json' },
      payload: probe.payload,
    });
    assert.equal(
      response.statusCode,
      400,
      `${probe.what}: the client's broken body is a client error, not ours (${response.body})`,
    );
  }
  await app.close();

  assert.deepStrictEqual(
    transport.events.map((e) => e.message),
    [],
    'an unauthenticated client must not be able to spend a page of the quota the money ' +
      'alarms share — 43,200 events/month was the measured drain',
  );
});

// ---- 7. the completion log line reports EVERY phase (D20-A3 §A3.4.1) -------

/**
 * Three deliverables (the ops SQL, design §4d, the runbook) call the Railway
 * "scheduler tick complete" line "the same counters" as the tick's JSON body,
 * and nominate it as THE authority on whether a tick ran. It carried five of
 * twelve phases — omitting `captureReconciler` and `duplicateRefundRetry`, the
 * two money phases whose alarms this entire cycle exists to page on. Pre-existing
 * as `DISCREPANCIES.md` NOTE-39; nominating the line as the authority made it
 * this cycle's. The ruling was to make the claim true, not to weaken it.
 */
test('POST /workers/tick: the completion log line carries every phase counter', async () => {
  initObservability({ installProcessHandlers: false });

  const lines: Array<Record<string, unknown>> = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: {
        write(msg: string): void {
          lines.push(JSON.parse(msg) as Record<string, unknown>);
        },
      },
    },
  });
  registerAuth(app);
  // Distinct non-zero values per counter so a copy-paste that reports one
  // phase's number under another phase's key fails instead of passing.
  registerWorkersTickRoute(app, {
    runTick: async () => ({
      ...TICK_RESULT,
      membershipRoll: { scanned: 11, rolled: 12, completed: 13 },
      invoiceOverdue: { scanned: 21, enqueued: 22 },
      cardExpiry: { scanned: 31, enqueued: 32 },
      invoiceAttemptVerify: { scanned: 41, results: [] },
      captureReconciler: {
        ...TICK_RESULT.captureReconciler,
        scanned: 51,
        captured: 52,
        lostHolds: 53,
        withdrawnReleased: 54,
        refundedPostWithdraw: 55,
        refundedSurplus: 56,
        settledInvoices: 57,
        abandoned: 58,
        abandonedUncollected: 59,
      },
      duplicateRefundRetry: {
        ...TICK_RESULT.duplicateRefundRetry,
        scanned: 61,
        sent: 62,
        abandoned: 63,
      },
      alumniAttendance: { ran: true, scanned: 71, enqueued: 72, flagged: 73 },
    }),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/workers/tick',
    headers: { authorization: `Bearer ${env.SCHEDULER_WEBHOOK_SECRET}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  await app.close();

  const complete = lines.find((line) => line['msg'] === 'scheduler tick complete');
  assert.ok(complete !== undefined, `no completion line; got ${JSON.stringify(lines)}`);

  // The six phases that were missing — including both money phases.
  assert.equal(complete['membershipRollScanned'], 11);
  assert.equal(complete['membershipRolled'], 12);
  assert.equal(complete['membershipCompleted'], 13);
  assert.equal(complete['invoiceOverdueScanned'], 21);
  assert.equal(complete['invoiceOverdueEnqueued'], 22);
  assert.equal(complete['cardExpiryScanned'], 31);
  assert.equal(complete['cardExpiryEnqueued'], 32);
  assert.equal(complete['invoiceAttemptVerifyScanned'], 41);
  assert.equal(complete['captureReconcilerScanned'], 51);
  assert.equal(complete['captureReconcilerCaptured'], 52);
  assert.equal(complete['captureReconcilerLostHolds'], 53);
  assert.equal(complete['captureReconcilerWithdrawnReleased'], 54);
  assert.equal(complete['captureReconcilerRefundedPostWithdraw'], 55);
  assert.equal(complete['captureReconcilerRefundedSurplus'], 56);
  assert.equal(complete['captureReconcilerSettledInvoices'], 57);
  assert.equal(complete['captureReconcilerAbandoned'], 58);
  assert.equal(complete['captureReconcilerAbandonedUncollected'], 59);
  assert.equal(complete['duplicateRefundRetryScanned'], 61);
  assert.equal(complete['duplicateRefundRetrySent'], 62);
  assert.equal(complete['duplicateRefundRetryAbandoned'], 63);
  assert.equal(complete['alumniAttendanceRan'], true);
  assert.equal(complete['alumniAttendanceScanned'], 71);
  assert.equal(complete['alumniAttendanceEnqueued'], 72);
  assert.equal(complete['alumniAttendanceFlagged'], 73);

  // …and the five it already had are ADDITIVE-preserved, not renamed. Anything
  // reading these today (an eye on a Railway log, a future alert) keeps working.
  for (const key of [
    'scheduledScanned',
    'scheduledSent',
    'pushTicketsOk',
    'pushTicketsError',
    'invoicesScanned',
    'mediaDerivativesScanned',
    'creditExpiryWarningsScanned',
    'creditExpiryWarningsEnqueued',
    'idempotencyKeysSwept',
  ]) {
    assert.equal(complete[key], 0, `${key} must survive the extension`);
  }
});
