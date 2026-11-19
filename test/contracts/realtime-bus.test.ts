import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  authFrame,
  baseRedis,
  childEnv,
  closedPortUrl,
  connect,
  linesMatching,
  removeOwnerB,
  seedOwnerB,
  signToken,
  sleep,
  startRealtimeApp,
  startRedisProxy,
  waitUntil,
  type RtClient,
} from './_realtime.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import { env } from '../../src/env.js';
import { ownerChannel, resolveChannelPrefix, type PublisherLike } from '../../src/realtime/bus.js';

/**
 * The bus (design §4 "No silent staleness", A2 FL5, FL6, OL9, OL10; brief B16, CR1, CR24, LR5-a,
 * LR17; MB13 M5). Redis is never stopped: "down and back" is a test-local TCP proxy closed and
 * reopened, and "down at boot" is a URL at a closed port.
 */

registerFixtureHooks();
before(seedOwnerB);
after(removeOwnerB);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const A = FIXTURE_IDS.ownerId;
const A_UID = FIXTURE_IDS.ownerSupabaseUid;
const THREAD_A = FIXTURE_IDS.thread1Id;
const DONAVAN_UID = FIXTURE_IDS.staffDonavanSupabaseUid;

async function authed(url: string, uid: string): Promise<RtClient> {
  const token = await signToken(uid);
  const client = await connect(url, (c) => c.send(authFrame(token)));
  await client.waitForType('ready');
  return client;
}

/** The parent's environment without the prefix (the gate of record's `npm test` shape). */
function envWithoutPrefix(): Record<string, string> {
  return childEnv({}, { withPrefix: false });
}

function child(
  args: string[],
  environment: Record<string, string>,
): {
  proc: ChildProcessWithoutNullStreams;
  out: () => string;
  done: Promise<number | null>;
} {
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/contracts/_realtimeChild.ts', ...args],
    {
      cwd: REPO_ROOT,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let out = '';
  let err = '';
  proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const done = new Promise<number | null>((resolve) =>
    proc.on('close', (code) => {
      if (code !== 0) process.stderr.write(`child ${args[0]} exited ${String(code)}: ${err}\n`);
      resolve(code);
    }),
  );
  return { proc, out: () => out, done };
}

test("CR1 / MB13 M5: with REALTIME_CHANNEL_PREFIX unset, the harness gives the bus a 'test-<random>' prefix, different per run; a named one is kept", async () => {
  const one = child(['prefix'], envWithoutPrefix());
  const two = child(['prefix'], envWithoutPrefix());
  const named = child(['prefix'], childEnv({ REALTIME_CHANNEL_PREFIX: 'named-by-the-run' }));
  assert.equal(await one.done, 0);
  assert.equal(await two.done, 0);
  assert.equal(await named.done, 0);
  const p1 = /PREFIX (\S+)/.exec(one.out())?.[1];
  const p2 = /PREFIX (\S+)/.exec(two.out())?.[1];
  assert.match(p1 ?? '', /^test-[0-9a-f]{8}$/);
  assert.match(p2 ?? '', /^test-[0-9a-f]{8}$/);
  assert.notEqual(p1, p2);
  assert.match(named.out(), /PREFIX named-by-the-run\n/);
});

test("FL6's order: REALTIME_CHANNEL_PREFIX, then RAILWAY_ENVIRONMENT_NAME, then 'local'", () => {
  assert.equal(
    resolveChannelPrefix({ REALTIME_CHANNEL_PREFIX: 'a', RAILWAY_ENVIRONMENT_NAME: 'b' }),
    'a',
  );
  assert.equal(resolveChannelPrefix({ RAILWAY_ENVIRONMENT_NAME: 'production' }), 'production');
  assert.equal(resolveChannelPrefix({}), 'local');
});

test('B16: two prefixes on one Redis never cross (two children, the variable unset in both); the same prefix does', async () => {
  const listener = child(['listen'], envWithoutPrefix());
  try {
    const prefix = await waitUntil(
      () => /LIVE (\S+)/.exec(listener.out())?.[1],
      10_000,
      'the listener to go live',
    );
    assert.match(prefix, /^test-[0-9a-f]{8}$/);
    const stranger = child(['publish', A, THREAD_A], envWithoutPrefix());
    assert.equal(await stranger.done, 0);
    assert.match(stranger.out(), /PUBLISHED test-[0-9a-f]{8}/);
    assert.ok(!stranger.out().includes(`PUBLISHED ${prefix}\n`), 'a different prefix');
    await sleep(800);
    assert.ok(!listener.out().includes('EVENT'), 'no cross-talk');
    const sibling = child(['publish', A, THREAD_A], childEnv({ REALTIME_CHANNEL_PREFIX: prefix }));
    assert.equal(await sibling.done, 0);
    await waitUntil(
      () => (listener.out().includes(THREAD_A) ? true : undefined),
      3_000,
      'the same-prefix event',
    );
  } finally {
    listener.proc.stdin.end();
    await listener.done;
  }
});

test('B16: two instances on one Redis: an event published on instance 1 reaches a socket on instance 2, and typing on 2 reaches staff on 1', async () => {
  const one = await startRealtimeApp({ startBus: true });
  const two = await startRealtimeApp({ startBus: true });
  const a = await authed(two.url, A_UID);
  const donavan = await authed(one.url, DONAVAN_UID);
  try {
    one.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' });
    await a.waitForType('thread.changed');
    a.send({ type: 'typing', thread_id: THREAD_A });
    assert.deepEqual(await donavan.waitForType('typing'), {
      type: 'typing',
      thread_id: THREAD_A,
      from: 'owner',
    });
  } finally {
    a.end();
    donavan.end();
    await one.close();
    await two.close();
  }
});

test('B16: Redis down at boot: the API boots, answers HTTP, and its sockets get `ready` then `degraded`; nothing throws', async () => {
  const uncaught: unknown[] = [];
  const onAny = (e: unknown): void => {
    uncaught.push(e);
  };
  process.on('uncaughtException', onAny);
  process.on('unhandledRejection', onAny);
  const base = baseRedis(await closedPortUrl());
  const rt = await startRealtimeApp({
    startBus: true,
    waitLive: false,
    bus: { base, probeRetryMs: 200 },
  });
  try {
    assert.equal((await rt.app.inject({ method: 'GET', url: '/test-http' })).statusCode, 200);
    const a = await authed(rt.url, A_UID);
    assert.deepEqual(a.frames.slice(0, 2), [{ type: 'ready', protocol: 1 }, { type: 'degraded' }]);
    await sleep(1_200);
    assert.equal(rt.hub.busState(), 'degraded');
    assert.equal(a.ofType('live').length, 0);
    assert.deepEqual(uncaught, []);
    a.end();
  } finally {
    process.off('uncaughtException', onAny);
    process.off('unhandledRejection', onAny);
    await rt.close();
    base.disconnect();
  }
});

test('B16: Redis down and back: sockets get `degraded`, then `resync`, then `live`', async () => {
  const proxy = await startRedisProxy();
  const base = baseRedis(proxy.url);
  const rt = await startRealtimeApp({
    startBus: true,
    bus: { base, probeRetryMs: 200, retryStrategy: () => 100 },
  });
  const a = await authed(rt.url, A_UID);
  try {
    await proxy.down();
    await a.waitForType('degraded');
    await sleep(500);
    await proxy.up();
    await a.waitForType('live', 8_000);
    const types = a.frames.map((f) => f.type);
    const degradedAt = types.indexOf('degraded');
    const resyncAt = types.indexOf('resync');
    const liveAt = types.lastIndexOf('live');
    assert.ok(degradedAt >= 0 && degradedAt < resyncAt && resyncAt < liveAt, types.join(','));
    // And live again means live: an event flows.
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' });
    await a.waitForType('thread.changed');
  } finally {
    a.end();
    await rt.close();
    base.disconnect();
    await proxy.close();
  }
});

test('FL5: a subscriber that is connected while publishes are silently dropped never reads `live`', async () => {
  const rt = await startRealtimeApp({
    startBus: true,
    waitLive: false,
    bus: {
      probeRetryMs: 200,
      createPublisher: (base): PublisherLike => {
        const real = base.duplicate({ maxRetriesPerRequest: 1 });
        return {
          publish: async () => 0, // accepted, never delivered
          on: (event, listener) => real.on(event, listener),
          disconnect: () => real.disconnect(),
        };
      },
    },
  });
  try {
    const a = await authed(rt.url, A_UID);
    await sleep(2_000);
    assert.equal(rt.hub.busState(), 'degraded');
    assert.deepEqual(
      a.frames.map((f) => f.type),
      ['ready', 'degraded'],
    );
    a.end();
  } finally {
    await rt.close();
  }
});

test('FL6: with Redis down the subscriber retries without throwing, and goes live when Redis is back', async () => {
  const uncaught: unknown[] = [];
  const onAny = (e: unknown): void => {
    uncaught.push(e);
  };
  process.on('uncaughtException', onAny);
  process.on('unhandledRejection', onAny);
  const proxy = await startRedisProxy();
  await proxy.down();
  const base = baseRedis(proxy.url);
  const rt = await startRealtimeApp({
    startBus: true,
    waitLive: false,
    bus: { base, probeRetryMs: 200, retryStrategy: () => 100 },
  });
  try {
    await sleep(1_000);
    assert.equal(rt.hub.busState(), 'degraded');
    await proxy.up();
    await waitUntil(
      () => (rt.hub.busState() === 'live' ? true : undefined),
      8_000,
      'live after Redis is back',
    );
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', onAny);
    process.off('unhandledRejection', onAny);
    await rt.close();
    base.disconnect();
    await proxy.close();
  }
});

test('LR17: Redis down with the publisher retrying: no "Unhandled error event" on stderr, one warn line per state change', async () => {
  const proxy = await startRedisProxy();
  const base = baseRedis(proxy.url);
  const rt = await startRealtimeApp({
    startBus: true,
    bus: { base, probeRetryMs: 200, retryStrategy: () => 100 },
  });
  let stderr = '';
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    for (let outage = 1; outage <= 2; outage += 1) {
      await proxy.down();
      for (let i = 0; i < 5; i += 1) {
        rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' });
        await sleep(200);
      }
      await sleep(500);
      assert.equal(
        linesMatching(rt.logs, /realtime publisher: Redis connection error/, 40).length,
        outage,
        `one publisher warn per outage (outage ${outage})`,
      );
      await proxy.up();
      await waitUntil(() => (rt.hub.busState() === 'live' ? true : undefined), 8_000, 'live again');
    }
    assert.ok(!stderr.includes('Unhandled error event'), stderr.slice(0, 500));
  } finally {
    process.stderr.write = realWrite;
    await rt.close();
    base.disconnect();
    await proxy.close();
  }
});

test('OL10: 100 failed publishes while degraded give one warn line', async () => {
  let failing = false;
  const rt = await startRealtimeApp({
    startBus: true,
    bus: {
      probeRetryMs: 200,
      createPublisher: (base): PublisherLike => {
        const real = base.duplicate({ maxRetriesPerRequest: 1 });
        return {
          publish: (channel, message) =>
            failing
              ? Promise.reject(new Error('publish refused (test)'))
              : real.call('PUBLISH', channel, message),
          on: (event, listener) => real.on(event, listener),
          disconnect: () => real.disconnect(),
        };
      },
    },
  });
  const a = await authed(rt.url, A_UID);
  try {
    failing = true;
    for (let i = 0; i < 100; i += 1) {
      rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' });
    }
    await a.waitForType('degraded');
    await sleep(800);
    assert.equal(linesMatching(rt.logs, /realtime bus degraded/, 40).length, 1);
    failing = false;
    await a.waitForType('live', 5_000);
  } finally {
    a.end();
    await rt.close();
  }
});

test("LR5-a: a non-JSON publish on the instance's pattern throws nothing, and the next real event is delivered", async () => {
  const uncaught: unknown[] = [];
  const onAny = (e: unknown): void => {
    uncaught.push(e);
  };
  process.on('uncaughtException', onAny);
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const raw = baseRedis(env.REDIS_URL);
  try {
    await raw.call('PUBLISH', ownerChannel(rt.hub.prefix, A), 'not json {');
    await raw.call(
      'PUBLISH',
      ownerChannel(rt.hub.prefix, A),
      JSON.stringify({ v: 1, kind: 'nope' }),
    );
    await sleep(300);
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' });
    await a.waitForType('thread.changed');
    assert.deepEqual(uncaught, []);
    assert.equal(linesMatching(rt.logs, /not JSON was dropped/, 40).length, 1);
    assert.equal(linesMatching(rt.logs, /no known shape was dropped/, 40).length, 1);
  } finally {
    process.off('uncaughtException', onAny);
    raw.disconnect();
    a.end();
    await rt.close();
  }
});
