import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { env } from '../src/env.js';
import {
  alarmForwardingHooks,
  captureAlarm,
  createSentryTransport,
  flushObservability,
  initObservability,
  isPagerInstalled,
  pagerHealth,
  CATASTROPHIC_HOURLY_CEILING,
  DEDUPE_WINDOW_MS,
  DROP_WINDOW_MS,
  IDENTICAL_ALLOWANCE,
  MAX_IN_FLIGHT,
  type AlarmEvent,
  type AlarmTransport,
} from '../src/lib/observability.js';
import {
  MAX_CONSECUTIVE_TRANSPORT_FAILURES,
  MAX_RECENT_CEILING_DROPS,
} from '../src/routes/healthWatchdog.js';

/**
 * Unit coverage for the Day-20 pager (`src/lib/observability.ts`). Pure — no
 * DB, no Redis, and (load-bearingly) **no network**: every test that could
 * reach out stubs `globalThis.fetch` and asserts on what it was handed.
 *
 * Two things live here that live nowhere else in the repo:
 *
 *   1. **The Sentry wire format.** `createSentryTransport` is the only code
 *      that knows what a DSN decomposes into, what the auth header says, or
 *      that an envelope is three newline-delimited JSON documents rather than
 *      one. Nothing else can catch a mistake in it — a malformed envelope is
 *      accepted by `fetch`, returns some 4xx from an ingest host we never call
 *      in tests, and gets swallowed by design. So it is pinned here, byte for
 *      byte.
 *   2. **The no-op guarantee.** With `SENTRY_DSN` unset — dev, test, and every
 *      contract-test subprocess — this module must emit ZERO network traffic.
 *      That is asserted against a fetch spy rather than asserted in a comment.
 *
 * The tap's behavior on the REAL request path (Fastify's logger → child
 * `request.log` → `POST /workers/tick`) is pinned in
 * `test/contracts/observability-tap.test.ts`; what is pinned here is the hook
 * function in isolation.
 */

const FAKE_DSN = 'https://examplepublickey@o0.ingest.example-sentry.invalid/424242';

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
 * Capture `process.stderr.write` for the duration of `fn`. The swallow paths
 * in this module write exactly one line each, and "exactly one" is part of the
 * contract — a pager that spams stderr on every failed send during a Sentry
 * outage is its own incident.
 */
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

/**
 * Let every started send settle. `MAX_IN_FLIGHT` is a TRUE concurrency bound,
 * so a test that dispatches hundreds of alarms inside one event-loop turn hits
 * the ceiling rather than the thing it meant to exercise — `inFlight` only
 * empties on the microtask turn after each send resolves.
 */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Parse the three NDJSON lines of a Sentry envelope body. */
function parseEnvelope(body: string): {
  header: Record<string, unknown>;
  itemHeader: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const lines = body.split('\n');
  assert.equal(lines.length, 4, `envelope must be 3 lines + a trailing newline; got ${body}`);
  assert.equal(lines[3], '', 'envelope must end with a newline');
  return {
    header: JSON.parse(lines[0] ?? '') as Record<string, unknown>,
    itemHeader: JSON.parse(lines[1] ?? '') as Record<string, unknown>,
    payload: JSON.parse(lines[2] ?? '') as Record<string, unknown>,
  };
}

/** Stub `globalThis.fetch`, recording every call. Auto-restored by node:test. */
function stubFetch(
  t: TestContext,
  respond: () => Response = () => new Response('', { status: 200 }),
): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', (input: string, init: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond());
  });
  return calls;
}

// ---- the Sentry wire format ------------------------------------------------

test('createSentryTransport: DSN parse, auth header, and envelope framing', async (t) => {
  const calls = stubFetch(t);
  const transport = createSentryTransport(FAKE_DSN);

  const err = new Error('stripe refund exploded');
  await transport.send({
    message: 'SURPLUS REFUND — refunded a duplicate group-class hold',
    level: 'error',
    logger: 'pino',
    extra: { chargeId: 'ch_1', amountCents: 12_000, err },
  });

  assert.equal(calls.length, 1, 'exactly one POST per event — no batching, no retry');
  const call = calls[0];
  assert.ok(call !== undefined);

  // The DSN's project id becomes the ingest path; the key NEVER appears in it.
  assert.equal(call.url, 'https://o0.ingest.example-sentry.invalid/api/424242/envelope/');
  assert.equal(call.init.method, 'POST');

  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/x-sentry-envelope');
  assert.equal(
    headers['X-Sentry-Auth'],
    'Sentry sentry_key=examplepublickey, sentry_version=7, sentry_client=fetchd-backend/1.0',
  );

  const { header, itemHeader, payload } = parseEnvelope(String(call.init.body));
  // The envelope header's event_id must be THE event's id — Sentry rejects an
  // envelope whose header and item disagree.
  assert.match(String(header['event_id']), /^[0-9a-f]{32}$/, 'uuid with the dashes stripped');
  assert.equal(payload['event_id'], header['event_id']);
  assert.deepStrictEqual(itemHeader, { type: 'event' });

  assert.equal(payload['platform'], 'node');
  assert.equal(payload['level'], 'error');
  assert.equal(payload['logger'], 'pino');
  assert.deepStrictEqual(payload['message'], {
    formatted: 'SURPLUS REFUND — refunded a duplicate group-class hold',
  });
  assert.equal(payload['environment'], env.NODE_ENV);
  assert.ok(
    !Number.isNaN(Date.parse(String(payload['timestamp']))),
    'timestamp must be a parseable ISO-8601 instant',
  );

  // The money must survive serialization. `JSON.stringify(new Error(...))` is
  // `{}` — an alarm that reaches Sentry with an empty `err` is an alarm
  // nobody can act on, which is most of the reason to page at all.
  const extra = payload['extra'] as Record<string, unknown>;
  assert.equal(extra['chargeId'], 'ch_1');
  assert.equal(extra['amountCents'], 12_000);
  const serializedErr = extra['err'] as Record<string, unknown>;
  assert.equal(serializedErr['name'], 'Error');
  assert.equal(serializedErr['message'], 'stripe refund exploded');
  assert.ok(String(serializedErr['stack']).includes('stripe refund exploded'));
});

test('createSentryTransport: a non-2xx ingest response rejects (so captureAlarm can report it)', async (t) => {
  stubFetch(t, () => new Response('rate limited', { status: 429 }));
  const transport = createSentryTransport(FAKE_DSN);
  await assert.rejects(
    () => transport.send({ message: 'anything', level: 'error', logger: 'pino' }),
    /HTTP 429/,
  );
});

test('createSentryTransport: a URL that is not a DSN is refused at construction', () => {
  // `env.ts` only proves SENTRY_DSN is a URL. The difference between a URL and
  // a DSN is a production process that believes it has a pager.
  assert.throws(() => createSentryTransport('https://sentry.example.com/424242'), /no key/);
  assert.throws(() => createSentryTransport('https://key@sentry.example.com'), /no project id/);
  // D20-A2 §A2.4.1, executed by the attack lane: a DSN copied with a trailing
  // slash used to build `POST /api/42//envelope/` — a 404 at Sentry, silently,
  // forever, on a process that reports a healthy pager. A non-emptiness check
  // is not a shape check.
  assert.throws(
    () => createSentryTransport('https://key@sentry.example.com/not-a-project'),
    /non-numeric project id/,
    'a project id that is not digits must fail CLOSED at boot, not at the first dropped alarm',
  );
  // D20-A4 §A4.5 N1: `^\d+$` accepted `0042`, which is not a project id any
  // more than `not-a-project` is — it 404s at Sentry silently, forever, on a
  // process that reports a healthy pager. Same failure as the trailing slash,
  // one character further in.
  assert.throws(
    () => createSentryTransport('https://key@sentry.example.com/0042'),
    /leading zero/,
    'a leading-zero project id must fail CLOSED, not 404 in silence forever',
  );
  // D20-A5.4: and `0` itself, which round 2 left accepted because the runbook's
  // boot smoke would catch it. `0` is the project id in SENTRY'S OWN EXAMPLE
  // DSN and was the literal placeholder in this repo's `.env.example` — the
  // realistic failure is that she pastes the example instead of hers, the
  // process boots clean, reports a healthy pager, and 404s forever. A procedure
  // is not an instrument.
  assert.throws(
    () => createSentryTransport('https://examplepublickey@o0.ingest.sentry.io/0'),
    /starts with a zero/,
    "Sentry's own example DSN must fail CLOSED at boot",
  );
  // …and a low but real project id is still a project id.
  assert.doesNotThrow(() => createSentryTransport('https://key@sentry.example.com/10'));
});

test('createSentryTransport: a path-prefixed (self-hosted) DSN is refused, deliberately (§A4.5 N2)', () => {
  // Documented rather than changed. A sentry.io DSN never carries a path
  // prefix; a self-hosted install behind one does, and accepting it would mean
  // guessing where the project id ends. Refusing is the fail-closed direction
  // and the message says what shape is expected — if Fetch'd ever self-hosts,
  // THIS is the line to change, with a test beside it.
  assert.throws(
    () => createSentryTransport('https://key@sentry.example.com/prefix/424242'),
    /is not a Sentry DSN/,
  );
});

test('createSentryTransport: a trailing slash on the DSN does not corrupt the ingest path', async (t) => {
  const calls = stubFetch(t);
  await createSentryTransport(
    'https://examplepublickey@o0.ingest.example-sentry.invalid/424242/',
  ).send({ message: 'LOST HOLD', level: 'error', logger: 'pino' });
  assert.equal(
    calls[0]?.url,
    'https://o0.ingest.example-sentry.invalid/api/424242/envelope/',
    'one slash, not two — the double-slash form 404s and the drop is swallowed by design',
  );
});

test('createSentryTransport: a CIRCULAR extra still pages, marked, instead of losing the alarm', async (t) => {
  const calls = stubFetch(t);
  const cyclic: Record<string, unknown> = { chargeId: 'ch_1', amountCents: 12_000 };
  cyclic['self'] = cyclic;
  // The same object under two keys is NOT a cycle and must survive intact —
  // a naive seen-set would mislabel it and quietly hollow out real alarms.
  const shared = { refundId: 're_1' };
  cyclic['a'] = shared;
  cyclic['b'] = shared;

  await createSentryTransport(FAKE_DSN).send({
    message: 'SURPLUS REFUND — with a cyclic context',
    level: 'error',
    logger: 'pino',
    extra: cyclic,
  });

  // D20-A2 §A2.4.2: before the guard, `JSON.stringify` threw out of `send` and
  // ZERO requests reached ingest — while this module's own doc listed a
  // circular `extra` as handled. The doc is now true.
  assert.equal(calls.length, 1, 'a cyclic extra must not cost the page');
  const { payload } = parseEnvelope(String(calls[0]?.init.body));
  const extra = payload['extra'] as Record<string, unknown>;
  assert.equal(extra['chargeId'], 'ch_1', 'the money must still be attached');
  assert.equal(extra['self'], '[Circular]');
  assert.deepStrictEqual(extra['a'], { refundId: 're_1' });
  assert.deepStrictEqual(extra['b'], { refundId: 're_1' }, 'a repeated sibling is not a cycle');
});

// ---- the no-op guarantee ---------------------------------------------------

test('no DSN and no injected transport: captureAlarm makes ZERO network calls', async (t) => {
  assert.equal(
    env.SENTRY_DSN,
    undefined,
    'this test only means something while the test environment has no DSN',
  );
  const calls = stubFetch(t);

  initObservability();
  captureAlarm({ message: 'LOST HOLD — a hold went missing', level: 'error', logger: 'pino' });
  captureAlarm({ message: 'boom', level: 'fatal', logger: 'process' });
  // Also drive it through the hook, which is how every real alarm arrives.
  const hooks = alarmForwardingHooks();
  hooks.logMethod.call(null, [{ chargeId: 'ch_1' }, 'SURPLUS REFUND'], () => undefined, 50);
  await flushObservability(50);

  assert.equal(calls.length, 0, 'the seam must be inert without a DSN');
});

// ---- the tap ---------------------------------------------------------------

test('alarmForwardingHooks: forwards level >= 50 with the merge object as extra', () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  const logged: unknown[][] = [];
  const method = (...args: unknown[]): void => {
    logged.push(args);
  };
  const hooks = alarmForwardingHooks();

  hooks.logMethod.call(
    null,
    [{ chargeId: 'ch_1', amountCents: 12_000 }, 'SURPLUS REFUND'],
    method,
    50,
  );
  hooks.logMethod.call(null, [{ signal: 'SIGTERM' }, 'shutting down'], method, 30);
  hooks.logMethod.call(null, ['the process is going down'], method, 60);

  assert.equal(transport.events.length, 2, 'only levels >= 50 page; info must not');
  assert.deepStrictEqual(transport.events[0], {
    message: 'SURPLUS REFUND',
    level: 'error',
    logger: 'pino',
    extra: { chargeId: 'ch_1', amountCents: 12_000 },
  });
  assert.deepStrictEqual(transport.events[1], {
    message: 'the process is going down',
    level: 'fatal',
    logger: 'pino',
  });

  // Additive, never a reroute: EVERY call still reaches pino, unchanged.
  assert.equal(logged.length, 3);
  assert.deepStrictEqual(logged[1], [{ signal: 'SIGTERM' }, 'shutting down']);
});

test('alarmForwardingHooks: an Error logged bare still pages with a readable message', () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  const hooks = alarmForwardingHooks();
  const err = new Error('connect ECONNREFUSED');
  hooks.logMethod.call(null, [err], () => undefined, 50);

  const event = transport.events[0];
  assert.ok(event !== undefined);
  assert.equal(event.message, 'connect ECONNREFUSED', 'never an empty Sentry issue title');
  assert.equal((event.extra as Record<string, unknown>)['err'], err);
});

test('alarmForwardingHooks: a THROWING transport still logs, and writes exactly one stderr line', async () => {
  const exploding: AlarmTransport = {
    send(): Promise<void> {
      throw new Error('synthetic transport explosion');
    },
  };
  initObservability({ transport: exploding, installProcessHandlers: false });

  const logged: unknown[][] = [];
  const hooks = alarmForwardingHooks();
  const captured = await withCapturedStderr(() => {
    hooks.logMethod.call(
      null,
      [{ chargeId: 'ch_1' }, 'SURPLUS REFUND'],
      (...args: unknown[]) => {
        logged.push(args);
      },
      50,
    );
  });

  // The one way this seam could hurt the app is by breaking logging for every
  // request. It must not, even when the pager is on fire.
  assert.deepStrictEqual(logged, [[{ chargeId: 'ch_1' }, 'SURPLUS REFUND']]);
  assert.equal(captured.length, 1, `exactly one stderr line; got ${JSON.stringify(captured)}`);
  assert.ok(captured[0]?.includes('alarm NOT delivered'));
  assert.ok(captured[0]?.includes('synthetic transport explosion'));
});

test('captureAlarm: a REJECTING transport is swallowed onto stderr and never propagates', async () => {
  const rejecting: AlarmTransport = {
    send(): Promise<void> {
      return Promise.reject(new Error('sentry envelope: HTTP 500 Internal Server Error'));
    },
  };
  initObservability({ transport: rejecting, installProcessHandlers: false });

  const captured = await withCapturedStderr(async () => {
    captureAlarm({ message: 'LOST HOLD', level: 'error', logger: 'pino' });
    await flushObservability(500);
  });

  assert.equal(captured.length, 1, `exactly one stderr line; got ${JSON.stringify(captured)}`);
  assert.ok(captured[0]?.includes('HTTP 500'));
});

test('alarmForwardingHooks: log.error() with NO arguments pages a sentence, not "undefined"', () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  const hooks = alarmForwardingHooks();
  hooks.logMethod.call(null, [] as unknown as [unknown, ...unknown[]], () => undefined, 50);

  // D20-A2 §A2.4.4: it used to page the literal string "undefined", which
  // titles a Sentry issue `undefined` and groups every such event into one
  // meaningless bucket.
  assert.equal(transport.events[0]?.message, 'log event with no message');
});

// ---- suppression is DEDUPE ONLY (D20-A4 §A4.1) -----------------------------

/**
 * `captureReconciler.ts:649`, VERBATIM. The sentence is a CONSTANT — identity
 * (`chargeId`, `dogId`, `ownerId`, `amountCents`) lives in the merge object at
 * `:641-648`, never in the text. That is the fact D20-A3 §A3.4.2 got backwards
 * when it ruled per-`(logger + message)` buckets in: N distinct lost holds are
 * ONE `logger + message`, so they shared one 5-token bucket and 7 of 12 were
 * permanently unpaged (`captureReconciler.ts:636-637` adds the charge to
 * `ALARMED_CHARGE_IDS` BEFORE the log call and regardless of delivery — there
 * is no second chance).
 */
const LOST_HOLD_MESSAGE =
  'LOST HOLD: a dog is enrolled in a group class and its authorization is CANCELLED — this enrollment will never be charged unless a human collects it (charge the owner in Stripe, or withdraw the dog)';

test('dedupe: 12 DISTINCT lost holds all page — the sentence is shared, the money is not', () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  for (let i = 1; i <= 12; i += 1) {
    captureAlarm({
      message: LOST_HOLD_MESSAGE,
      level: 'error',
      logger: 'pino',
      extra: {
        workerTick: 'scheduler',
        phase: 'capture-reconciler',
        chargeId: `ch_${i}`,
        dogId: `dog_${i}`,
        ownerId: `owner_${i}`,
        amountCents: 12_000,
      },
    });
  }

  // The invariant, stated: the pager never withholds an event unless it has
  // already sent an IDENTICAL one recently. These twelve are not identical —
  // twelve different dogs, twelve different owners' money.
  assert.equal(
    transport.events.length,
    12,
    `every distinct lost hold must page; sent ${transport.events.length} of 12 ` +
      `(${JSON.stringify(transport.events.map((e) => (e.extra as Record<string, unknown>)['chargeId']))})`,
  );
  const chargeIds = transport.events.map((e) => (e.extra as Record<string, unknown>)['chargeId']);
  assert.deepStrictEqual(
    [...new Set(chargeIds)].sort(),
    [
      'ch_1',
      'ch_10',
      'ch_11',
      'ch_12',
      'ch_2',
      'ch_3',
      'ch_4',
      'ch_5',
      'ch_6',
      'ch_7',
      'ch_8',
      'ch_9',
    ],
    'all twelve charges, none collapsed',
  );
});

test('dedupe: a flood of FRESH fingerprints cannot starve a first-ever money alarm', (t) => {
  // The A4.0 starvation loop, executed. `duplicateRefundRetry.ts:583` templates
  // counts INTO its sentence, so the noisy source mints a fresh fingerprint
  // every tick; under a global scarcity gate refilling 1/minute, two fresh
  // fingerprints per minutely tick drain it permanently, and the money alarm at
  // tick 30 is dropped. No scarcity gate may starve a first-ever alarm.
  t.mock.timers.enable({ apis: ['Date'] });
  t.after(() => t.mock.timers.reset());

  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  for (let tick = 1; tick <= 40; tick += 1) {
    captureAlarm({
      message: `duplicate refund retry: ${tick} MORE abandoned partial refund(s) since this process last said so (${tick * 3} total) — the report page cannot show them, so list them with: SELECT …`,
      level: 'error',
      logger: 'pino',
      extra: { workerTick: 'duplicate-refund-retry', refundClass: 'partial' },
    });
    captureAlarm({
      message: `phase boundary: worker phase ${tick} threw`,
      level: 'error',
      logger: 'pino',
      extra: { phase: `phase-${tick}` },
    });
    if (tick === 30) {
      captureAlarm({
        message: LOST_HOLD_MESSAGE,
        level: 'error',
        logger: 'pino',
        extra: { chargeId: 'ch_starved', ownerId: 'owner_starved', amountCents: 45_000 },
      });
    }
    t.mock.timers.tick(60_000);
  }

  const paged = transport.events.filter((e) => e.message === LOST_HOLD_MESSAGE);
  assert.equal(
    paged.length,
    1,
    `a first-ever money alarm must page THROUGH 30 minutes of unrelated noise; ` +
      `the pager sent ${transport.events.length} events and none of them was it`,
  );
  assert.equal((paged[0]?.extra as Record<string, unknown>)['chargeId'], 'ch_starved');
});

test('dedupe: a fatal page arrives after every other alarm has been suppressed', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  // Drain the pager the way A4.0 proved it actually drains. (The first version
  // of this test used 500 identical alarms against a global bucket and passed on
  // the very code it was written to indict; a test that cannot fail is not
  // evidence.) These sixty differ only in a DIGIT, so they normalise to one
  // fingerprint — which is the point: sixty repeats, three pages, the rest
  // withheld. `drain()` between them because the allowance is spent on DELIVERY
  // now (§A5.3), and an unsettled send has not delivered anything.
  for (let i = 0; i < 60; i += 1) {
    captureAlarm({
      message: `phase boundary: worker phase ${i} threw`,
      level: 'error',
      logger: 'pino',
    });
    await drain();
  }
  const beforeCrash = transport.events.length;
  assert.ok(beforeCrash < 60, 'this test only means something once the pager is actually drained');

  // "The single most important alarm the process will ever raise" — this
  // module's own words. `level: 'fatal'` bypasses every gate: the process is
  // dying and there is no quota argument for rationing its last word.
  captureAlarm({
    message: 'uncaughtException: Cannot read properties of undefined',
    level: 'fatal',
    logger: 'process',
    extra: { kind: 'uncaughtException' },
  });

  const fatal = transport.events.filter((e) => e.level === 'fatal');
  assert.equal(
    fatal.length,
    1,
    `the crash page must survive a drained pager; ${beforeCrash} events had already gone out`,
  );
  assert.equal(fatal[0]?.logger, 'process');
});

// ---- the mechanics of de-duplication (D20-A4 §A4.1) -----------------------

test('dedupe: a repeated sentence pages IDENTICAL_ALLOWANCE times, then is withheld', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  // `drain()` between events because the allowance is spent when a send SUCCEEDS
  // (§A5.3), not when the event is admitted — see the test below for why that
  // distinction had to change, and `DedupeWindow.delivered` for the burst
  // behaviour it deliberately accepts in exchange.
  for (let i = 0; i < 200; i += 1) {
    captureAlarm({ message: 'unhandled error', level: 'error', logger: 'pino' });
    await drain();
  }

  assert.equal(
    transport.events.length,
    IDENTICAL_ALLOWANCE,
    'the same sentence, over and over, is one thing worth knowing — not 200',
  );
  assert.equal(pagerHealth().dropped_alarms, 200 - IDENTICAL_ALLOWANCE);
});

test('dedupe: three FAILED deliveries do not burn the allowance (§A5.3)', async () => {
  // Round 3's finding E, stated against the invariant's own words: "the pager
  // never withholds an event unless it has already SENT an identical one
  // recently." Counting at ADMISSION made three rejected sends — three alarms
  // that reached no human at all — spend the whole allowance, so the fourth copy
  // was withheld on the strength of deliveries that never happened. On a
  // permanently broken transport that is silence, indefinitely, about a
  // condition nobody has ever been told about.
  let rejecting = true;
  const attempts: AlarmEvent[] = [];
  const flapping: AlarmTransport = {
    send(event: AlarmEvent): Promise<void> {
      attempts.push(event);
      return rejecting ? Promise.reject(new Error('ingest 503')) : Promise.resolve();
    },
  };
  initObservability({ transport: flapping, installProcessHandlers: false });

  await withCapturedStderr(async () => {
    for (let i = 0; i < 3 * IDENTICAL_ALLOWANCE; i += 1) {
      captureAlarm({
        message: 'LOST HOLD',
        level: 'error',
        logger: 'pino',
        extra: { chargeId: 'ch_1' },
      });
      await drain();
    }
  });
  assert.equal(
    attempts.length,
    3 * IDENTICAL_ALLOWANCE,
    `every copy must be ATTEMPTED while none has been delivered; attempted ${attempts.length}`,
  );

  // …and once deliveries actually start landing, the allowance behaves exactly
  // as before: three through, the rest withheld. Without this half the "fix"
  // would be "de-duplication deleted", which is not what was asked for.
  rejecting = false;
  attempts.length = 0;
  for (let i = 0; i < 20; i += 1) {
    captureAlarm({
      message: 'LOST HOLD',
      level: 'error',
      logger: 'pino',
      extra: { chargeId: 'ch_1' },
    });
    await drain();
  }
  assert.equal(
    attempts.length,
    IDENTICAL_ALLOWANCE,
    `three DELIVERED copies still close the window; attempted ${attempts.length}`,
  );
});

test('dedupe: digits in the MESSAGE normalise, so a count-templated sentence is one alarm', async (t) => {
  // `duplicateRefundRetry.ts:583` templates counts into its sentence. Un-
  // normalised, every tick was a FRESH fingerprint — which is what starved the
  // old global ceiling and, through it, the money alarms (§A4.0).
  t.mock.timers.enable({ apis: ['Date'] });
  t.after(() => t.mock.timers.reset());

  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  for (let tick = 1; tick <= 30; tick += 1) {
    captureAlarm({
      message: `duplicate refund retry: ${tick} MORE abandoned partial refund(s) since this process last said so (${tick * 3} total)`,
      level: 'error',
      logger: 'pino',
      extra: { workerTick: 'duplicate-refund-retry', refundClass: 'partial' },
    });
    await drain();
    t.mock.timers.tick(60_000);
  }

  // 30 minutes = three dedupe windows, each allowing IDENTICAL_ALLOWANCE.
  const paged = transport.events.filter((e) => e.logger === 'pino');
  assert.equal(
    paged.length,
    3 * IDENTICAL_ALLOWANCE,
    `a count-templated sentence must collapse to ONE fingerprint; paged ${paged.length}`,
  );
});

test('dedupe: digits in EXTRA do NOT normalise — ch_1 and ch_2 are different money', () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  // Same sentence, same everything, one field apart. If `extra` were normalised
  // the way the message is, these would collapse and one owner's refund would
  // go unpaged — which is the exact defect §A4.1 exists to prevent.
  for (const chargeId of ['ch_1', 'ch_2', 'ch_3', 'ch_4', 'ch_5']) {
    captureAlarm({
      message: 'SURPLUS REFUND — refunded a duplicate group-class hold',
      level: 'error',
      logger: 'pino',
      extra: { chargeId, amountCents: 12_000 },
    });
  }
  assert.equal(transport.events.length, 5, 'five charges, five pages');
});

test('dedupe: DIFFERENT nested errors under one sentence are different alarms (§A5.1)', async () => {
  // Round 3's finding A, and it was the whole 5xx surface: `auth/plugin.ts:212`
  // logs the CONSTANT sentence 'unhandled error' with the fault itself nested
  // under `err`, and nested objects were ignored by the fingerprint. Executed
  // through the real error handler: six genuinely distinct first-ever 500s →
  // THREE paged. A Stripe outage and a null-pointer bug were "identical alarms".
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  const faults: Error[] = [
    new Error('Stripe: connection error on POST /v1/refunds'),
    new Error('pool exhausted: timeout acquiring client'),
    new TypeError("Cannot read properties of undefined (reading 'ownerId')"),
    new Error('READONLY You cannot write against a read only replica'),
    new Error('R2 putObject failed: 403 SignatureDoesNotMatch'),
    new Error('invoice settle: refund exceeded charge amount'),
  ];
  for (const err of faults) {
    captureAlarm({
      message: 'unhandled error',
      level: 'error',
      logger: 'pino',
      extra: { reqId: 'req-1', err },
    });
    await drain();
  }
  assert.equal(
    transport.events.length,
    faults.length,
    `six different faults are six alarms; paged ${transport.events.length}`,
  );

  // The other direction, which is why this is strictly better rather than a
  // trade: ONE bug storming still collapses. The digits normalise for the same
  // reason the alarm sentence's do — an id or a port inside the error text would
  // otherwise mint a fresh fingerprint per occurrence and defeat dedupe.
  transport.events.length = 0;
  for (let i = 0; i < 20; i += 1) {
    captureAlarm({
      message: 'unhandled error',
      level: 'error',
      logger: 'pino',
      extra: { reqId: `req-${i}`, err: new Error(`connect ETIMEDOUT 10.0.0.${i}:5432`) },
    });
    await drain();
  }
  assert.equal(
    transport.events.length,
    IDENTICAL_ALLOWANCE,
    `one bug storming is still one alarm; paged ${transport.events.length}`,
  );

  // …and a TypeError is not an Error, even word for word.
  transport.events.length = 0;
  captureAlarm({
    message: 'boom',
    level: 'error',
    logger: 'pino',
    extra: { err: new Error('same words') },
  });
  await drain();
  captureAlarm({
    message: 'boom',
    level: 'error',
    logger: 'pino',
    extra: { err: new TypeError('same words') },
  });
  await drain();
  assert.equal(transport.events.length, 2, 'the error CLASS is part of the identity');
});

test('dedupe: a key/value delimiter inside extra cannot forge a fingerprint (§A5.5 H)', async () => {
  // The `key=value` join these entries used had the NUL byte's shape one level
  // up: `{ a: 'b=c' }` and `{ 'a=b': 'c' }` both rendered `a=b=c`, so two
  // different events could collapse because of where a delimiter happened to
  // fall inside the DATA. Every entry is its own JSON array now.
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  // The allowance has to be SPENT first, or this proves nothing: two colliding
  // fingerprints both page anyway while the window is open, so a two-event
  // version of this test passes on the very code it was written to indict.
  // (It did — caught by its own mutant, which is why the loop is here.)
  for (let i = 0; i < IDENTICAL_ALLOWANCE; i += 1) {
    captureAlarm({ message: 'LOST HOLD', level: 'error', logger: 'pino', extra: { a: 'b=c' } });
    await drain();
  }
  const before = transport.events.length;
  assert.equal(before, IDENTICAL_ALLOWANCE, 'precondition: that fingerprint is now at its limit');

  captureAlarm({ message: 'LOST HOLD', level: 'error', logger: 'pino', extra: { 'a=b': 'c' } });
  await drain();
  assert.equal(
    transport.events.length,
    before + 1,
    'a different extra is a different alarm — it must not inherit a full window from where a delimiter fell',
  );
});

test('dedupe: reqId is excluded from the fingerprint, or nothing would ever dedupe', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  // D20-A1 puts the child logger's `reqId` into `extra` so a page can be
  // correlated to its Railway line. It is ambient context, never identity: a
  // fingerprint carrying it is unique by construction, and an attacker-driven
  // 500 storm would then page once per request forever.
  for (let i = 0; i < 50; i += 1) {
    captureAlarm({
      message: 'unhandled error',
      level: 'error',
      logger: 'pino',
      extra: { reqId: `req-${i}`, err: 'boom' },
    });
    await drain();
  }
  assert.equal(
    transport.events.length,
    IDENTICAL_ALLOWANCE,
    'a per-request key must not split the fingerprint',
  );
});

test('dedupe: the suppression notice arrives when the window ROLLS, with the count', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.after(() => t.mock.timers.reset());

  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  for (let i = 0; i < 50; i += 1) {
    captureAlarm({ message: 'unhandled error', level: 'error', logger: 'pino' });
    await drain();
  }
  const suppressed = 50 - IDENTICAL_ALLOWANCE;
  assert.equal(
    transport.events.find((e) => e.logger === 'observability'),
    undefined,
    'nothing to report yet — the window is still open',
  );

  t.mock.timers.tick(DEDUPE_WINDOW_MS);
  captureAlarm({ message: 'unhandled error', level: 'error', logger: 'pino' });

  // Being blind must be VISIBLE. A silent cap would re-create this cycle's
  // defect one level up.
  const notice = transport.events.find((e) => e.logger === 'observability');
  assert.ok(notice !== undefined, `no suppression notice; got ${JSON.stringify(transport.events)}`);
  assert.match(notice.message, /pager suppressed \d+ identical alarms/);
  assert.match(notice.message, /the log remains the record/);
  assert.equal(notice.level, 'error', 'the notice must itself be page-worthy');
  const noticeExtra = notice.extra as Record<string, unknown>;
  assert.equal(noticeExtra['suppressed'], suppressed);
  assert.equal(
    noticeExtra['suppressed_message'],
    'unhandled error',
    'the notice must name WHAT it hid, or it is an unactionable number',
  );

  // Reported to the watchdog too, not only to Sentry.
  assert.equal(pagerHealth().dropped_alarms, suppressed);
  assert.equal(pagerHealth().dropped_alarms_recent, suppressed);
  assert.equal(typeof pagerHealth().last_drop_at, 'string');
});

test('dedupe: exactly one stderr line per drop window, not per suppressed event', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  const captured = await withCapturedStderr(async () => {
    for (let i = 0; i < 100; i += 1) {
      captureAlarm({ message: 'unhandled error', level: 'error', logger: 'pino' });
      await drain();
    }
  });
  assert.equal(
    captured.length,
    1,
    `a pager that spams stderr during a storm is its own incident; got ${captured.length} lines`,
  );
  assert.ok(captured[0]?.includes('pager suppressing alarms'));
});

test('dedupe: a FULL fingerprint table still admits a first-ever alarm (§A4.1)', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  // Fill the table past MAX_TRACKED_FINGERPRINTS with LIVE windows, so admitting
  // anything new must evict something live. Distinctness lives in `extra`, never
  // in the digits of the message — those normalise, which is the point of
  // §A4.1.1(2). `drain()` between batches because MAX_IN_FLIGHT is a real bound:
  // 300 dispatches inside ONE event-loop turn would hit the ceiling before
  // eviction was ever exercised.
  for (let i = 0; i < 300; i += 1) {
    captureAlarm({
      message: 'a worker phase threw',
      level: 'error',
      logger: 'worker',
      extra: { conditionId: `c-${String.fromCharCode(97 + (i % 26))}${i}` },
    });
    if (i % 100 === 0) await drain();
  }
  await drain();
  const before = transport.events.length;

  // THE assertion. A brand-new alarm arriving while the table is full must page.
  // The old scheme's equivalent path is what this pins against: `bucketFor`
  // returned `null` when its map was full and the event fell through to a global
  // bucket that could refuse it. Here there is no state of the table that can
  // withhold a first-ever alarm — eviction is total, so admission always
  // succeeds.
  captureAlarm({
    message: 'SURPLUS REFUND — refunded a duplicate group-class hold',
    level: 'error',
    logger: 'pino',
    extra: { chargeId: 'ch_after_the_table_filled', amountCents: 12_000 },
  });
  assert.equal(
    transport.events.length,
    before + 1,
    'a full fingerprint table must never be a reason to withhold a first-ever money alarm',
  );

  // …and an EVICTED fingerprint is treated as first-ever too, which is the
  // other half of "eviction may only ever cause MORE sending".
  captureAlarm({
    message: 'a worker phase threw',
    level: 'error',
    logger: 'worker',
    extra: { conditionId: 'c-a0' },
  });
  assert.equal(transport.events.length, before + 2, 'an evicted fingerprint pages again');
});

test('CATASTROPHIC_HOURLY_CEILING: a breaker, not a budget — one notice, then it sheds', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  for (let i = 0; i < CATASTROPHIC_HOURLY_CEILING; i += 1) {
    captureAlarm({
      message: 'a distinct condition',
      level: 'error',
      logger: 'pino',
      extra: { conditionId: `c-${String.fromCharCode(97 + (i % 26))}${i}` },
    });
    if (i % 100 === 0) await drain();
  }
  await drain();
  assert.equal(
    transport.events.length,
    CATASTROPHIC_HOURLY_CEILING,
    'every one of them was a first-ever alarm and every one had to go out',
  );
  assert.equal(pagerHealth().catastrophic_ceiling_tripped_at, null, 'not tripped AT the ceiling');

  captureAlarm({
    message: 'one over the line',
    level: 'error',
    logger: 'pino',
    extra: { conditionId: 'over' },
  });
  const notice = transport.events.filter((e) => e.message.includes('CIRCUIT BREAKER'));
  assert.equal(notice.length, 1, 'exactly one notice on the transition');
  assert.equal(typeof pagerHealth().catastrophic_ceiling_tripped_at, 'string');

  // …and it stays quiet after that, rather than emitting a notice per event.
  for (let i = 0; i < 20; i += 1) {
    captureAlarm({
      message: 'still storming',
      level: 'error',
      logger: 'pino',
      extra: { conditionId: `storm-${String.fromCharCode(97 + i)}` },
    });
  }
  assert.equal(
    transport.events.filter((e) => e.message.includes('CIRCUIT BREAKER')).length,
    1,
    'one notice on trip, not one per shed event',
  );

  // The crash page still gets out. That is the whole point of §A4.1.3.
  captureAlarm({ message: 'uncaughtException: boom', level: 'fatal', logger: 'process' });
  assert.equal(
    transport.events.filter((e) => e.level === 'fatal').length,
    1,
    'a tripped breaker must not eat the process crash page',
  );
});

test('MAX_IN_FLIGHT: unsettled sends stop accumulating, exactly at the bound, counted (§A4.5 L2)', async () => {
  // The executed shape behind the bound: 50,000 unsettled sends, +21 MB of
  // heap, nothing to stop it. With the scarcity gate gone this bound can
  // actually bind, so it must bind EXACTLY — the old code checked the ceiling
  // once and then dispatched twice, letting `inFlight` reach MAX_IN_FLIGHT + 1.
  let started = 0;
  const hanging: AlarmTransport = {
    send(): Promise<void> {
      started += 1;
      return new Promise<void>(() => undefined);
    },
  };
  initObservability({ transport: hanging, installProcessHandlers: false });

  await withCapturedStderr(() => {
    for (let i = 0; i < MAX_IN_FLIGHT + 100; i += 1) {
      captureAlarm({
        message: 'a distinct alarm',
        level: 'error',
        logger: 'pino',
        extra: { conditionId: `c-${String.fromCharCode(97 + (i % 26))}${i}` },
      });
    }
  });

  assert.equal(
    started,
    MAX_IN_FLIGHT,
    `at most MAX_IN_FLIGHT concurrent sends; started ${started}`,
  );
  const health = pagerHealth();
  assert.equal(health.in_flight, MAX_IN_FLIGHT, 'never MAX_IN_FLIGHT + 1');
  assert.equal(
    health.dropped_alarms,
    100,
    'a drop at the ceiling is accounted, never silent — the watchdog reads this',
  );
});

test('MAX_IN_FLIGHT: a fatal page goes out even at the ceiling (§A4.1.3)', async () => {
  let started = 0;
  let fatalStarted = false;
  const hanging: AlarmTransport = {
    send(event: AlarmEvent): Promise<void> {
      started += 1;
      if (event.level === 'fatal') fatalStarted = true;
      return new Promise<void>(() => undefined);
    },
  };
  initObservability({ transport: hanging, installProcessHandlers: false });

  await withCapturedStderr(() => {
    for (let i = 0; i < MAX_IN_FLIGHT + 10; i += 1) {
      captureAlarm({
        message: 'a distinct alarm',
        level: 'error',
        logger: 'pino',
        extra: { conditionId: `c-${String.fromCharCode(97 + (i % 26))}${i}` },
      });
    }
    captureAlarm({ message: 'uncaughtException: boom', level: 'fatal', logger: 'process' });
  });

  assert.equal(fatalStarted, true, 'the single most important alarm the process will ever raise');
  assert.equal(started, MAX_IN_FLIGHT + 1, 'exactly one over, and only for the crash page');
});

test('dispatch: a SYNCHRONOUS throw from the transport cannot lose the next event (§A4.5 L1)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.after(() => t.mock.timers.reset());

  const delivered: AlarmEvent[] = [];
  // Throws on the suppression notice ONLY — the exact latent shape §A4.5 L1
  // describes: the notice's throw used to escape `dispatch`, zeroing the
  // suppression count AND losing the real event on the line after it.
  const partlyExploding: AlarmTransport = {
    send(event: AlarmEvent): Promise<void> {
      if (event.logger === 'observability') throw new Error('synthetic notice explosion');
      delivered.push(event);
      return Promise.resolve();
    },
  };
  initObservability({ transport: partlyExploding, installProcessHandlers: false });

  const captured = await withCapturedStderr(async () => {
    for (let i = 0; i < 10; i += 1) {
      captureAlarm({ message: 'unhandled error', level: 'error', logger: 'pino' });
      await drain();
    }
    t.mock.timers.tick(DEDUPE_WINDOW_MS);
    // This call rolls the window (notice throws) and must still page itself.
    captureAlarm({ message: 'unhandled error', level: 'error', logger: 'pino' });
    await flushObservability(50);
  });

  assert.equal(
    delivered.length,
    IDENTICAL_ALLOWANCE + 1,
    `the real event must survive a throwing suppression notice; delivered ${delivered.length}`,
  );
  // …and the notice's own failure is REPORTED rather than escaping as an
  // exception. (Not asserted through `consecutive_transport_failures`: the real
  // event that follows succeeds and clears the streak, which is correct.)
  assert.ok(
    captured.some((line) => line.includes('synthetic notice explosion')),
    `the failed notice must reach stderr; got ${JSON.stringify(captured)}`,
  );
});

// ---- pager health, as the watchdog reads it (D20-A3 §A3.2, §A3.4.3) --------

test('pagerHealth: installed reflects the transport, and a failure streak clears on a success', async () => {
  initObservability({ installProcessHandlers: false });
  assert.equal(isPagerInstalled(), false, 'no DSN, no injected transport ⇒ no pager');
  assert.equal(pagerHealth().installed, false);

  let failing = true;
  const flaky: AlarmTransport = {
    send(): Promise<void> {
      return failing ? Promise.reject(new Error('ingest 503')) : Promise.resolve();
    },
  };
  initObservability({ transport: flaky, installProcessHandlers: false });
  assert.equal(isPagerInstalled(), true);
  assert.equal(pagerHealth().consecutive_transport_failures, 0, 'init starts from a clean slate');

  await withCapturedStderr(async () => {
    for (const message of ['a', 'b', 'c'])
      captureAlarm({ message, level: 'error', logger: 'pino' });
    await flushObservability(500);
  });
  assert.equal(
    pagerHealth().consecutive_transport_failures,
    3,
    'three sends in a row failed — this is what the watchdog 503s on',
  );
  assert.equal(typeof pagerHealth().last_failure_at, 'string');

  failing = false;
  captureAlarm({ message: 'd', level: 'error', logger: 'pino' });
  await flushObservability(500);
  assert.equal(
    pagerHealth().consecutive_transport_failures,
    0,
    'a delivered page clears the streak — otherwise one blip latches the alarm forever',
  );
  // …and the streak clearing is exactly why a second counter had to exist: four
  // sends were attempted, three of them were LOST, and the counter the watchdog
  // used to read is back at zero.
  assert.equal(
    pagerHealth().transport_failures_recent,
    3,
    'a windowed loss count has no reset — that is the property that makes flapping visible',
  );
});

test('pagerHealth: a FLAPPING transport is counted, though the failure streak keeps clearing (§A5.3)', async () => {
  // Round 3's finding C, executed: a transport rejecting every OTHER send
  // destroyed 30 of 60 pages, and `GET /health/watchdog` answered 200 with
  // `reasons: []`, because the only failure counter it had was reset by every
  // success. Half the money pages were gone and every instrument said healthy.
  let n = 0;
  const flapping: AlarmTransport = {
    send(): Promise<void> {
      n += 1;
      return n % 2 === 0 ? Promise.reject(new Error('ingest 503')) : Promise.resolve();
    },
  };
  initObservability({ transport: flapping, installProcessHandlers: false });

  await withCapturedStderr(async () => {
    for (let i = 0; i < 60; i += 1) {
      // Distinct money, so nothing here is de-duplication: sixty alarms, sixty
      // sends, thirty of them lost.
      captureAlarm({
        message: 'LOST HOLD',
        level: 'error',
        logger: 'pino',
        extra: { chargeId: `ch_${i}` },
      });
      await drain();
    }
  });

  const health = pagerHealth();
  assert.equal(health.transport_failures_recent, 30, 'every lost page is counted');
  assert.ok(
    health.consecutive_transport_failures < MAX_CONSECUTIVE_TRANSPORT_FAILURES,
    `the streak counter must be UNABLE to see this — that is the finding; it read ` +
      `${health.consecutive_transport_failures}`,
  );
  assert.equal(health.dropped_alarms, 0, 'nothing was suppressed; these were attempted and lost');
});

test('flushObservability: awaits in-flight sends, and gives up at the timeout', async () => {
  let release: (() => void) | undefined;
  let settled = false;
  const slow: AlarmTransport = {
    send(): Promise<void> {
      return new Promise<void>((resolve) => {
        release = () => {
          settled = true;
          resolve();
        };
      });
    },
  };
  initObservability({ transport: slow, installProcessHandlers: false });

  captureAlarm({ message: 'LOST HOLD', level: 'error', logger: 'pino' });

  // A hung ingest host must not hold shutdown open forever.
  await flushObservability(25);
  assert.equal(settled, false, 'the timeout wins over a hung send');

  // …but a send that DOES finish is waited for, which is what keeps the last
  // alarm before a SIGTERM from being discarded.
  release?.();
  await flushObservability(500);
  assert.equal(settled, true);
});

// ---- D20-A7: the two scarcity gates, and the counters that can see them ----

test('MAX_IN_FLIGHT: ONE drop at the ceiling is visible to the watchdog (§A7.1)', async () => {
  // Round 4's finding. `dropped_alarms_recent` counts this drop, but its
  // threshold is 200 because the drops it mostly sees are de-duplications —
  // the mechanism WORKING, an identical page already delivered. A drop here is
  // the opposite: a first-ever event the pager never sent. Folded together, one
  // shed money alarm moved a number nothing was watching and `GET
  // /health/watchdog` answered 200 `ok`, `reasons: []`.
  const hanging: AlarmTransport = {
    send(): Promise<void> {
      return new Promise<void>(() => undefined);
    },
  };
  initObservability({ transport: hanging, installProcessHandlers: false });

  await withCapturedStderr(() => {
    for (let i = 0; i < MAX_IN_FLIGHT; i += 1) {
      captureAlarm({
        message: 'a distinct alarm',
        level: 'error',
        logger: 'pino',
        extra: { conditionId: `c-${String.fromCharCode(97 + (i % 26))}${i}` },
      });
    }
    // A FIRST-EVER money alarm, arriving at a saturated transport.
    captureAlarm({
      message: 'LOST HOLD: a dog is enrolled and its authorization is CANCELLED',
      level: 'error',
      logger: 'pino',
      extra: { chargeId: 'ch_never_seen_before', amountCents: 12000 },
    });
  });

  const health = pagerHealth();
  assert.equal(health.dropped_at_ceiling_recent, 1, 'the ceiling drop has its own counter');
  assert.equal(health.dropped_alarms_recent, 1, 'and is still part of the aggregate');
  assert.ok(
    health.dropped_at_ceiling_recent >= MAX_RECENT_CEILING_DROPS,
    `ONE such drop must reach the watchdog's threshold — that is the whole finding. ` +
      `Counter read ${health.dropped_at_ceiling_recent}, threshold ${MAX_RECENT_CEILING_DROPS}`,
  );
});

test('MAX_IN_FLIGHT: a fatal page bypasses the ceiling WITHOUT counting a ceiling drop', async () => {
  // The bypass must not be accounted as a shed page, or the crash handler would
  // 503 the watchdog on its way out and libel a transport that took the event.
  const hanging: AlarmTransport = {
    send(): Promise<void> {
      return new Promise<void>(() => undefined);
    },
  };
  initObservability({ transport: hanging, installProcessHandlers: false });

  await withCapturedStderr(() => {
    for (let i = 0; i < MAX_IN_FLIGHT; i += 1) {
      captureAlarm({
        message: 'a distinct alarm',
        level: 'error',
        logger: 'pino',
        extra: { conditionId: `c-${String.fromCharCode(97 + (i % 26))}${i}` },
      });
    }
    captureAlarm({ message: 'uncaughtException: boom', level: 'fatal', logger: 'process' });
  });

  assert.equal(pagerHealth().dropped_at_ceiling_recent, 0, 'a bypass is not a drop');
});

test('dedupe drops are NOT counted as ceiling drops — the two are judged apart (§A7.1)', async () => {
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  await withCapturedStderr(async () => {
    for (let i = 0; i < IDENTICAL_ALLOWANCE + 5; i += 1) {
      captureAlarm({ message: 'unhandled error', level: 'error', logger: 'pino' });
      await drain();
    }
  });

  const health = pagerHealth();
  assert.equal(health.dropped_alarms_recent, 5, 'five suppressed by de-duplication');
  assert.equal(
    health.dropped_at_ceiling_recent,
    0,
    'a suppression is the mechanism working; conflating it with saturation would ' +
      '503 the watchdog on ordinary de-duplication',
  );
});

test('pagerHealth: the ceiling counter ages out with its window (§A7.1)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.after(() => t.mock.timers.reset());

  const hanging: AlarmTransport = {
    send(): Promise<void> {
      return new Promise<void>(() => undefined);
    },
  };
  initObservability({ transport: hanging, installProcessHandlers: false });
  await withCapturedStderr(() => {
    for (let i = 0; i < MAX_IN_FLIGHT + 3; i += 1) {
      captureAlarm({
        message: 'a distinct alarm',
        level: 'error',
        logger: 'pino',
        extra: { conditionId: `c-${String.fromCharCode(97 + (i % 26))}${i}` },
      });
    }
  });
  assert.equal(pagerHealth().dropped_at_ceiling_recent, 3);

  // A cumulative counter that only ever climbs would latch the 503 forever
  // after one degraded hour — the same trap `dropped_alarms_recent` avoids.
  t.mock.timers.tick(DROP_WINDOW_MS);
  assert.equal(pagerHealth().dropped_at_ceiling_recent, 0, 'the window rolled');
});

test('pagerHealth: a failure streak is STICKY — silence must NOT clear it (§A8, reversing §A7.2)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.after(() => t.mock.timers.reset());

  const rejecting: AlarmTransport = {
    send(): Promise<void> {
      return Promise.reject(new Error('transient blip'));
    },
  };
  initObservability({ transport: rejecting, installProcessHandlers: false });

  await withCapturedStderr(async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_TRANSPORT_FAILURES; i += 1) {
      captureAlarm({ message: `blip ${i}`, level: 'error', logger: 'pino' });
      await flushObservability(500);
    }
  });
  assert.equal(
    pagerHealth().consecutive_transport_failures,
    MAX_CONSECUTIVE_TRANSPORT_FAILURES,
    'three failed sends, watchdog red',
  );

  // §A7.2 ruled that an hour of silence should clear this, to stop one blip
  // latching the watchdog red. Building it revealed the cost: with BOTH
  // counters windowed, a transport failing EVERY send while alarms arrive
  // sparser than once an hour reaches neither threshold — a permanently dead
  // pager reading healthy in exactly the low-traffic regime this system is
  // designed for. That is this cycle's own defect, one gate over, so §A7.2 was
  // REVERSED (§A8).
  //
  // A latched 503 is not a false positive: it says "the pager failed and
  // nothing has proven it works since", which is TRUE. Its clearing condition
  // is a send that actually succeeds — which is the assertion below, and the
  // only honest one.
  t.mock.timers.tick(DROP_WINDOW_MS * 2);
  assert.equal(
    pagerHealth().consecutive_transport_failures,
    MAX_CONSECUTIVE_TRANSPORT_FAILURES,
    'silence must NOT clear the streak — a dead pager reading healthy is the defect this cycle exists to abolish',
  );
  assert.equal(
    pagerHealth().transport_failures_recent,
    0,
    'the WINDOWED sibling still ages — the two counters answer different questions',
  );

  // Only a delivered page clears it.
  initObservability({
    transport: {
      send(): Promise<void> {
        return Promise.resolve();
      },
    },
    installProcessHandlers: false,
  });
  captureAlarm({ message: 'a page that lands', level: 'error', logger: 'pino' });
  await flushObservability(500);
  assert.equal(
    pagerHealth().consecutive_transport_failures,
    0,
    'a send that actually succeeded is the one honest clearing condition',
  );
});

test('pagerHealth: the first failure after an idle window COUNTS as 1, not 0 (§A7.2)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.after(() => t.mock.timers.reset());

  const rejecting: AlarmTransport = {
    send(): Promise<void> {
      return Promise.reject(new Error('blip'));
    },
  };
  initObservability({ transport: rejecting, installProcessHandlers: false });

  // Putting the streak counter inside the drop window means the failure path
  // now both ROLLS and COUNTS. Get that order wrong — count, then roll — and a
  // failure arriving after an idle hour is zeroed by its own roll and reads 0.
  // That is the same "recorded into a counter that immediately forgot it" shape
  // as §A7.1 itself, one line over, so it is pinned rather than reasoned about.
  //
  // §A8 then reversed A7.2 and took the streak back OUT of the window, so the
  // two counters now answer different questions and this pins BOTH: the
  // windowed sibling restarts each hour, the sticky streak accumulates across
  // hours until a send actually succeeds.
  await withCapturedStderr(async () => {
    captureAlarm({ message: 'first blip of the hour', level: 'error', logger: 'pino' });
    await flushObservability(500);
  });
  assert.equal(pagerHealth().consecutive_transport_failures, 1);
  assert.equal(pagerHealth().transport_failures_recent, 1);

  t.mock.timers.tick(DROP_WINDOW_MS);
  await withCapturedStderr(async () => {
    captureAlarm({ message: 'first blip of the NEXT hour', level: 'error', logger: 'pino' });
    await flushObservability(500);
  });
  const health = pagerHealth();
  assert.equal(
    health.consecutive_transport_failures,
    2,
    'the streak is STICKY: it crosses the hour boundary, because nothing has succeeded yet',
  );
  assert.equal(
    health.transport_failures_recent,
    1,
    'the WINDOWED sibling restarts at 1 — and never at 0, which is the roll-then-count ordering this pins',
  );
});

// ---- D20-A7.2: a weird payload degrades the fingerprint, never loses the page ----

/** An `Error` whose `message` is not a string — what a library can hand us. */
function errorWithMessage(message: unknown): Error {
  const err = new Error('placeholder');
  Object.defineProperty(err, 'message', { value: message, enumerable: false, configurable: true });
  return err;
}

test('fingerprint: a non-string Error.message cannot lose the alarm (§A7.2)', async () => {
  // The throw escaped `identifyingExtra` to `captureAlarm`'s catch, which treats
  // every exception as a TRANSPORT failure. Three consequences, all wrong: the
  // event was never handed over, it was ABSENT from drop accounting, and it
  // incremented the delivery counters — so three of them produced a 503 reading
  // "pager LOST 3 alarms to failed delivery" about events the transport never
  // saw.
  const shapes: Array<[string, Record<string, unknown>]> = [
    ['message: number', { err: errorWithMessage(42) }],
    ['message: undefined', { err: errorWithMessage(undefined) }],
    ['message: Symbol', { err: errorWithMessage(Symbol('boom')) }],
    [
      'a throwing getter in extra',
      Object.defineProperty({}, 'chargeId', {
        get(): never {
          throw new Error('getter exploded');
        },
        enumerable: true,
      }) as Record<string, unknown>,
    ],
  ];

  for (const [label, extra] of shapes) {
    const transport = makeRecordingTransport();
    initObservability({ transport, installProcessHandlers: false });
    await withCapturedStderr(async () => {
      captureAlarm({ message: 'LOST HOLD: money is stuck', level: 'error', logger: 'pino', extra });
      await flushObservability(500);
    });

    assert.equal(transport.events.length, 1, `${label}: the page must still go out`);
    const health = pagerHealth();
    assert.equal(health.transport_failures_recent, 0, `${label}: the transport never failed`);
    assert.equal(health.consecutive_transport_failures, 0, `${label}: nor did it fail in a row`);
    assert.equal(health.dropped_alarms, 0, `${label}: nothing was withheld either`);
  }
});

test('fingerprint: an unreadable key still de-duplicates against its own repeats (§A7.2)', async () => {
  // Degrading must not mean "every weird payload is one alarm forever, or a new
  // alarm every time". An unreadable key contributes a stable part, so repeats
  // collapse and a DIFFERENT readable key still splits.
  const transport = makeRecordingTransport();
  initObservability({ transport, installProcessHandlers: false });

  const unreadable = (): Record<string, unknown> =>
    Object.defineProperty({}, 'err', {
      get(): never {
        throw new Error('nope');
      },
      enumerable: true,
    }) as Record<string, unknown>;

  await withCapturedStderr(async () => {
    for (let i = 0; i < IDENTICAL_ALLOWANCE + 2; i += 1) {
      captureAlarm({
        message: 'unhandled error',
        level: 'error',
        logger: 'pino',
        extra: unreadable(),
      });
      await drain();
    }
  });
  assert.equal(
    transport.events.length,
    IDENTICAL_ALLOWANCE,
    'identical unreadable payloads de-duplicate like anything else',
  );

  // …and the money still splits: a readable identifying scalar beside the
  // unreadable key keeps ch_1 and ch_2 apart.
  for (const chargeId of ['ch_1', 'ch_2']) {
    const extra = unreadable();
    Object.defineProperty(extra, 'chargeId', { value: chargeId, enumerable: true });
    captureAlarm({ message: 'unhandled error', level: 'error', logger: 'pino', extra });
    await drain();
  }
  assert.equal(
    transport.events.length,
    IDENTICAL_ALLOWANCE + 2,
    'ch_1 and ch_2 are different money, unreadable neighbour or not',
  );
});
