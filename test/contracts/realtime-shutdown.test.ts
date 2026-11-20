import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  childEnv,
  connect,
  devAuthFrame,
  sleep,
  startRealtimeApp,
  testVerify,
  waitUntil,
  type RtClient,
} from './_realtime.js';
import { realBoot } from './_realBoot.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import { registerRealtimeRoute } from '../../src/realtime/server.js';
import { drainInFlight, inFlightCount, trackInFlight } from '../../src/realtime/settle.js';
import { SHUTDOWN_BOUND_MS, runShutdown } from '../../src/realtime/shutdown.js';

/**
 * Shutdown (brief LR9, FM2-c, LR9-b; the Opus seat's M3; design A2 FM2). One upgraded client
 * that never answers the close must not hold `app.close()`; a stalled push must settle before
 * `closeDb`; peers see 1012; the whole sequence ends within 12 s. The drain runs beside
 * `app.close()`, never behind it: shown with `app.close()` held by an in-flight request (not
 * rejecting) as well as rejecting; a push that request starts during `app.close()` is waited for
 * too; the bound ends the wait in both phases.
 */

registerFixtureHooks();

const A = FIXTURE_IDS.ownerId;
const CLOSE_1012 = Buffer.from([0x88, 0x02, 0x03, 0xf4]);

interface SilentClient {
  received(): Buffer;
  ended(): boolean;
  destroy(): void;
}

/** A real WebSocket handshake over raw TCP that authenticates, then reads and never answers:
 *  above all, never the close handshake (a locked phone mid-deploy). */
async function silentClient(port: number, frame: Record<string, unknown>): Promise<SilentClient> {
  const socket = net.connect(port, '127.0.0.1');
  let received = Buffer.alloc(0);
  let ended = false;
  socket.on('data', (d: Buffer) => {
    received = Buffer.concat([received, d]);
  });
  socket.on('close', () => {
    ended = true;
  });
  socket.on('error', () => {
    ended = true;
  });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(
    'GET /realtime HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  await waitUntil(
    () => (received.includes('101 Switching Protocols') ? true : undefined),
    3000,
    'the 101',
  );
  const payload = Buffer.from(JSON.stringify(frame));
  assert.ok(payload.length < 126);
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
  await waitUntil(
    () => (received.includes('"ready"') ? true : undefined),
    3000,
    'ready on the raw socket',
  );
  return { received: () => received, ended: () => ended, destroy: () => socket.destroy() };
}

function capturedLog(): {
  lines: Array<{ level: 'warn' | 'error'; msg: string }>;
  log: {
    warn(o: Record<string, unknown>, m: string): void;
    error(o: Record<string, unknown>, m: string): void;
  };
} {
  const lines: Array<{ level: 'warn' | 'error'; msg: string }> = [];
  return {
    lines,
    log: {
      warn: (_o, msg) => lines.push({ level: 'warn', msg }),
      error: (_o, msg) => lines.push({ level: 'error', msg }),
    },
  };
}

async function politeClient(url: string): Promise<RtClient> {
  const client = await connect(url, (c) => c.send(devAuthFrame(`owner:${A}`)));
  await client.waitForType('ready');
  return client;
}

test('FM2-c: a client that never answers the close plus a stalled push: the push settles before closeDb, peers see 1012, shutdown ends within 12 s', async () => {
  const rt = await startRealtimeApp({ bypassEnabled: true });
  const address = rt.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const polite = await politeClient(rt.url);
  const silent = await silentClient(port, devAuthFrame(`owner:${A}`));
  const { log, lines } = capturedLog();
  let pushSettledAt: number | undefined;
  let closeDbAt: number | undefined;
  trackInFlight(
    () =>
      sleep(2_500).then(() => {
        pushSettledAt = Date.now();
      }),
    { log, what: 'stalled push (test)' },
  );
  const t0 = Date.now();
  const exitCode = await runShutdown({
    closeApp: () => rt.app.close(),
    drain: drainInFlight,
    closeDb: async () => {
      closeDbAt = Date.now();
    },
    closeRedis: () => undefined,
    log,
  });
  const elapsed = Date.now() - t0;
  try {
    assert.equal(exitCode, 0);
    assert.ok(
      pushSettledAt !== undefined && closeDbAt !== undefined && pushSettledAt <= closeDbAt,
      'the push settled before closeDb',
    );
    assert.ok(elapsed < SHUTDOWN_BOUND_MS, `shutdown took ${elapsed} ms`);
    assert.equal(await polite.waitClosed(), 1012, 'a peer that answers sees 1012');
    assert.ok(silent.received().includes(CLOSE_1012), 'the silent one was sent 1012 too');
    await waitUntil(
      () => (silent.ended() ? true : undefined),
      1000,
      'the silent socket to be terminated',
    );
    assert.deepEqual(lines, []);
  } finally {
    silent.destroy();
  }
});

test('FM2-c: when app.close() itself rejects, the stalled push is still waited for before closeDb (the drain is concurrent, not after it)', async () => {
  const app = Fastify({ logger: false });
  registerRealtimeRoute(app, { verify: testVerify, bypassEnabled: true, onAck: () => undefined });
  app.addHook('onClose', async () => {
    throw new Error('a plugin failed to close (test)');
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const silent = await silentClient(port, devAuthFrame(`owner:${A}`));
  const { log, lines } = capturedLog();
  let pushSettledAt: number | undefined;
  let closeDbAt: number | undefined;
  trackInFlight(
    () =>
      sleep(2_000).then(() => {
        pushSettledAt = Date.now();
      }),
    { log, what: 'stalled push (test)' },
  );
  const exitCode = await runShutdown({
    closeApp: () => app.close(),
    drain: drainInFlight,
    closeDb: async () => {
      closeDbAt = Date.now();
    },
    closeRedis: () => undefined,
    log,
  });
  try {
    assert.ok(pushSettledAt !== undefined && closeDbAt !== undefined && pushSettledAt <= closeDbAt);
    assert.equal(exitCode, 1, 'a failed close is still an error exit');
    assert.deepEqual(
      lines.map((l) => l.level),
      ['error'],
    );
  } finally {
    silent.destroy();
  }
});

/** The held request: an in-flight HTTP request that `app.close()` waits for (Fastify finishes
 *  in-flight requests before its `onClose` hooks run), released by the test. Not rejecting: a
 *  slow reply mid-deploy, the realistic way `app.close()` is held. */
interface HeldRequest {
  app: FastifyInstance;
  /** The held request's status once its response has been read (-1 on a socket error). */
  response: Promise<number>;
  release(): void;
}

async function appWithHeldRequest(beforeReply: () => void = () => undefined): Promise<HeldRequest> {
  const app = Fastify({ logger: false });
  registerRealtimeRoute(app, { verify: testVerify, bypassEnabled: true, onAck: () => undefined });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  app.get('/held', async () => {
    entered = true;
    await gate;
    beforeReply();
    return { ok: true };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const response = new Promise<number>((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/held', agent: false, headers: { connection: 'close' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', () => resolve(-1));
  });
  await waitUntil(() => (entered ? true : undefined), 3000, 'the held request to reach its route');
  return { app, response, release };
}

test('FM2-c, the order itself: with app.close() held by an in-flight request (not rejecting), the drain completes while app.close() is still held', async () => {
  // The drain runs beside `app.close()`, never behind it (brief LR9 "concurrently"; red with the
  // await after `app.close()`). A stalled push settles at ~1 s; the request holds `app.close()`
  // to ~3 s. Concurrent: the drain is done at ~1 s, before `app.close()` resolves. Sequential:
  // the drain is not even called until `app.close()` has resolved.
  const held = await appWithHeldRequest();
  const { log, lines } = capturedLog();
  let pushSettledAt: number | undefined;
  let closeAppDoneAt: number | undefined;
  let closeDbAt: number | undefined;
  const drainCalls: Array<{ calledAt: number; doneAt?: number }> = [];
  trackInFlight(
    () =>
      sleep(1_000).then(() => {
        pushSettledAt = Date.now();
      }),
    { log, what: 'stalled push (test)' },
  );
  const releaseTimer = setTimeout(() => held.release(), 3_000);
  const t0 = Date.now();
  try {
    const exitCode = await runShutdown({
      closeApp: () =>
        held.app.close().then(() => {
          closeAppDoneAt = Date.now();
        }),
      drain: () => {
        const call: { calledAt: number; doneAt?: number } = { calledAt: Date.now() };
        drainCalls.push(call);
        return drainInFlight().then(() => {
          call.doneAt = Date.now();
        });
      },
      closeDb: async () => {
        closeDbAt = Date.now();
      },
      closeRedis: () => undefined,
      log,
    });
    assert.equal(exitCode, 0);
    assert.equal(await held.response, 200, 'app.close() let the in-flight request finish');
    assert.ok(pushSettledAt !== undefined, 'the push settled');
    assert.ok(closeAppDoneAt !== undefined && closeDbAt !== undefined);
    const first = drainCalls[0];
    assert.ok(first?.doneAt !== undefined, 'the drain ran and completed');
    const at = (t: number): number => t - t0;
    assert.ok(
      first.doneAt < closeAppDoneAt,
      `the drain completed (${at(first.doneAt)} ms) while app.close() was still held (it resolved at ${at(closeAppDoneAt)} ms)`,
    );
    assert.ok(pushSettledAt <= first.doneAt, 'the drain waited for the push');
    assert.ok(closeAppDoneAt <= closeDbAt, 'closeDb after app.close()');
    assert.ok(pushSettledAt <= closeDbAt, 'the push settled before closeDb');
    assert.ok(at(closeDbAt) < SHUTDOWN_BOUND_MS);
    assert.deepEqual(lines, []);
  } finally {
    clearTimeout(releaseTimer);
    held.release();
  }
});

test('FM2-c: a push that an in-flight request starts during app.close(), after the drain found the set empty, still settles before closeDb', async () => {
  // A staff reply mid-transaction at SIGTERM: Fastify lets it finish, it commits and starts its
  // push while `app.close()` waits for it. Nothing else was in flight, so the concurrent drain
  // was already done; the pool must still not close under the late push (`settle.ts`: "a reply
  // that commits during `app.close()` and starts its push").
  const { log, lines } = capturedLog();
  let latePushSettledAt: number | undefined;
  const held = await appWithHeldRequest(() => {
    trackInFlight(
      () =>
        sleep(1_500).then(() => {
          latePushSettledAt = Date.now();
        }),
      { log, what: 'staff message push (test)' },
    );
  });
  assert.equal(inFlightCount(), 0, 'nothing is in flight when the signal lands');
  let closeDbAt: number | undefined;
  const releaseTimer = setTimeout(() => held.release(), 1_500);
  try {
    const exitCode = await runShutdown({
      closeApp: () => held.app.close(),
      drain: drainInFlight,
      closeDb: async () => {
        closeDbAt = Date.now();
      },
      closeRedis: () => undefined,
      log,
    });
    assert.equal(exitCode, 0);
    assert.equal(await held.response, 200);
    assert.ok(closeDbAt !== undefined);
    assert.ok(
      latePushSettledAt !== undefined && latePushSettledAt <= closeDbAt,
      'the late push settled before closeDb',
    );
    assert.deepEqual(lines, []);
  } finally {
    clearTimeout(releaseTimer);
    held.release();
    await drainInFlight();
  }
});

test('FM2-c: app.close() held past the bound (a shortened, injected bound): shutdown ends at the bound with one warn, closeDb still runs, exit 0', async () => {
  const held = await appWithHeldRequest();
  const { log, lines } = capturedLog();
  let pushSettledAt: number | undefined;
  let closeDbAt: number | undefined;
  let closing: Promise<unknown> | undefined;
  trackInFlight(
    () =>
      sleep(300).then(() => {
        pushSettledAt = Date.now();
      }),
    { log, what: 'stalled push (test)' },
  );
  // The request holds `app.close()` for 4 s: past the 1.5 s bound (so the bound must end the
  // shutdown), and released in any case so a shutdown that ignores the bound still ends.
  const releaseTimer = setTimeout(() => held.release(), 4_000);
  const t0 = Date.now();
  try {
    const exitCode = await runShutdown({
      closeApp: () => {
        closing = held.app.close();
        return closing;
      },
      drain: drainInFlight,
      closeDb: async () => {
        closeDbAt = Date.now();
      },
      closeRedis: () => undefined,
      log,
      boundMs: 1_500,
    });
    const elapsed = Date.now() - t0;
    assert.equal(exitCode, 0);
    assert.ok(
      elapsed >= 1_400 && elapsed < 2_500,
      `shutdown took ${elapsed} ms against a 1500 ms bound`,
    );
    assert.ok(closeDbAt !== undefined, 'closeDb still ran');
    assert.ok(pushSettledAt !== undefined && pushSettledAt <= closeDbAt);
    assert.deepEqual(
      lines.map((l) => l.level),
      ['warn'],
      'one warn line (the bound), no error',
    );
  } finally {
    clearTimeout(releaseTimer);
    held.release();
    await closing?.catch(() => undefined);
  }
});

test('FM2-c: a late push that outlives the bound does not hold the shutdown: it ends at the (shortened) bound with one warn, exit 0', async () => {
  const { log, lines } = capturedLog();
  const held = await appWithHeldRequest(() => {
    trackInFlight(() => sleep(3_000), { log, what: 'staff message push (test)' });
  });
  let closeDbAt: number | undefined;
  const releaseTimer = setTimeout(() => held.release(), 300);
  const t0 = Date.now();
  try {
    const exitCode = await runShutdown({
      closeApp: () => held.app.close(),
      drain: drainInFlight,
      closeDb: async () => {
        closeDbAt = Date.now();
      },
      closeRedis: () => undefined,
      log,
      boundMs: 1_500,
    });
    const elapsed = Date.now() - t0;
    assert.equal(exitCode, 0);
    assert.ok(
      elapsed >= 1_400 && elapsed < 2_500,
      `shutdown took ${elapsed} ms against a 1500 ms bound`,
    );
    assert.ok(closeDbAt !== undefined, 'closeDb still ran');
    assert.equal(inFlightCount(), 1, 'the bound, not the push, ended the wait');
    assert.deepEqual(
      lines.map((l) => l.level),
      ['warn'],
      'one warn line (the bound), no error',
    );
  } finally {
    clearTimeout(releaseTimer);
    held.release();
    await drainInFlight();
  }
});

test('LR9-b: a rejecting in-flight send: exit code 0 and no error line', async () => {
  const rt = await startRealtimeApp();
  const { log, lines } = capturedLog();
  trackInFlight(() => sleep(300).then(() => Promise.reject(new Error('Expo: socket hang up'))), {
    log,
    what: 'staff message push',
  });
  const exitCode = await runShutdown({
    closeApp: () => rt.app.close(),
    drain: drainInFlight,
    closeDb: async () => undefined,
    closeRedis: () => undefined,
    log,
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(
    lines.filter((l) => l.level === 'error'),
    [],
  );
  assert.equal(lines.filter((l) => l.level === 'warn').length, 1, "the send's own warn line");
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('LR9 through the real entry point: `src/index.ts` under SIGTERM, with a silent client and a polite one, exits 0 within 12 s, peers see 1012, nothing pages', async () => {
  // An empty working directory of its own, whatever this tree holds (`_realBoot.ts`).
  const boot = realBoot();
  const port = await freePort();
  const proc = spawn(process.execPath, boot.args, {
    cwd: boot.cwd,
    // An explicit, complete environment (`childEnv`: NODE_ENV=staging, no `.env*` load), the
    // dev arm on by name (staging honours it), an explicit ephemeral port.
    env: {
      ...childEnv({ BYPASS_HEADER_ENABLED: 'true', PORT: String(port), LOG_LEVEL: 'info' }),
      ...boot.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on('close', (code) => resolve(code)));
  let silent: SilentClient | undefined;
  try {
    await waitUntil(
      () => (out.includes('Server listening') ? true : undefined),
      20_000,
      `the API to listen (stderr: ${err})`,
    );
    await waitUntil(
      () => (out.includes('realtime bus live') ? true : undefined),
      10_000,
      'the bus to go live',
    );
    const polite = await politeClient(`ws://127.0.0.1:${port}/realtime`);
    silent = await silentClient(port, devAuthFrame(`owner:${A}`));
    const t0 = Date.now();
    proc.kill('SIGTERM');
    const code = await exited;
    const elapsed = Date.now() - t0;
    assert.equal(code, 0, err);
    assert.ok(elapsed < SHUTDOWN_BOUND_MS, `exit took ${elapsed} ms`);
    assert.equal(await polite.waitClosed(), 1012);
    assert.ok(silent.received().includes(CLOSE_1012));
    const paged = out
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { level: number; msg: string })
      .filter((l) => l.level >= 50);
    assert.deepEqual(paged, []);
  } finally {
    silent?.destroy();
    if (proc.exitCode === null) proc.kill('SIGKILL');
    boot.dispose();
  }
});
