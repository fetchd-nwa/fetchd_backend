import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FakeClock,
  OWNER_B,
  authFrame,
  childEnv,
  connect,
  devAuthFrame,
  linesMatching,
  pagerLines,
  removeOwnerB,
  seedOwnerB,
  signToken,
  sleep,
  startRealtimeApp,
  systemRowId,
  type RtClient,
} from './_realtime.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import { resolvePrincipal } from '../../src/auth/mirror.js';
import { REALTIME_CLOSE_CODES } from '../../src/contracts/wire.js';

/**
 * `GET /realtime`'s door (brief B3, B4, B4b, B4c, LR5-b, LR6-a, OL4, B13, B17; MB13 H2, H3). Every
 * case runs a real listening server (port 0) and a real `ws` client; the token arm verifies
 * through the HTTP verifier on a local key set and resolves through the real mirror reads.
 */

registerFixtureHooks();
before(seedOwnerB);
after(removeOwnerB);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const A = FIXTURE_IDS.ownerId;
const A_UID = FIXTURE_IDS.ownerSupabaseUid;
const DONAVAN = FIXTURE_IDS.staffDonavanId;
const DONAVAN_UID = FIXTURE_IDS.staffDonavanSupabaseUid;

async function authed(url: string, frame: Record<string, unknown>): Promise<RtClient> {
  const client = await connect(url, (c) => c.send(frame));
  await client.waitForType('ready');
  return client;
}

async function closeCodeFor(url: string, frame: Record<string, unknown>): Promise<number> {
  const client = await connect(url, (c) => c.send(frame));
  return client.waitClosed();
}

test('B4 control: a valid owner token and a valid staff token each get `ready`, protocol 1', async () => {
  const rt = await startRealtimeApp();
  try {
    const owner = await authed(rt.url, authFrame(await signToken(A_UID)));
    const staff = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
    assert.deepEqual(owner.frames[0], { type: 'ready', protocol: 1 });
    assert.deepEqual(staff.frames[0], { type: 'ready', protocol: 1 });
    owner.end();
    staff.end();
  } finally {
    await rt.close();
  }
});

test('B4: a bad token and an expired token close 4401', async () => {
  const rt = await startRealtimeApp();
  try {
    assert.equal(await closeCodeFor(rt.url, authFrame('not.a.jwt')), 4401);
    const past = Math.floor(Date.now() / 1000) - 60;
    assert.equal(
      await closeCodeFor(rt.url, authFrame(await signToken(A_UID, { expSeconds: past }))),
      4401,
    );
  } finally {
    await rt.close();
  }
});

test('B4: an unprovisioned uid closes 4403, and so does the system row (by its id as a subject)', async () => {
  const rt = await startRealtimeApp();
  try {
    const stranger = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    assert.equal(await closeCodeFor(rt.url, authFrame(await signToken(stranger))), 4403);
    // The system row has no uid (CHECK is_system_account = (supabase_uid IS NULL)), so no token
    // can name it; a token whose subject is its id is an unprovisioned uid.
    assert.equal(await closeCodeFor(rt.url, authFrame(await signToken(await systemRowId()))), 4403);
  } finally {
    await rt.close();
  }
});

test('B4: if the uid read ever yielded the system row, the by-id read refuses it: 4403 (OM5; MB13 H3)', async () => {
  const systemId = await systemRowId();
  const rt = await startRealtimeApp({
    // Stands in for an HTTP resolver that failed to exclude the system row.
    resolve: async (uid) =>
      uid === 'system-row-sub'
        ? { kind: 'staff', staffId: systemId, role: 'trainer', supabaseUid: uid }
        : resolvePrincipal(uid),
  });
  try {
    assert.equal(await closeCodeFor(rt.url, authFrame(await signToken('system-row-sub'))), 4403);
  } finally {
    await rt.close();
  }
});

test('B4: an unknown protocol closes 4426', async () => {
  const rt = await startRealtimeApp();
  try {
    const token = await signToken(A_UID);
    assert.equal(await closeCodeFor(rt.url, { type: 'auth', protocol: 2, token }), 4426);
  } finally {
    await rt.close();
  }
});

test('B4: a malformed auth frame closes 4401; any other frame before auth is dropped unanswered', async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock });
  try {
    assert.equal(await closeCodeFor(rt.url, { type: 'auth', protocol: 1, token: 7 }), 4401);
    const early = await connect(rt.url, (c) => {
      c.send({ type: 'ping' });
      c.send({ type: 'typing', thread_id: FIXTURE_IDS.thread1Id });
    });
    await sleep(300);
    assert.deepEqual(early.frames, [], 'nothing is sent before auth, not even a pong');
    assert.equal(early.closeCode(), undefined);
    early.end();
  } finally {
    await rt.close();
  }
});

test('B4: the dev arm with the bypass ON: a live owner and a live staffer get `ready`; the system row, an unknown id, a claimed role the row does not hold, and bad grammar are refused', async () => {
  const rt = await startRealtimeApp({ bypassEnabled: true });
  try {
    const owner = await authed(rt.url, devAuthFrame(`owner:${A}`));
    const staff = await authed(rt.url, devAuthFrame(`staff:${DONAVAN}:trainer`));
    owner.end();
    staff.end();
    const systemId = await systemRowId();
    assert.equal(
      await closeCodeFor(rt.url, devAuthFrame(`staff:${systemId}:trainer`)),
      4403,
      'the system row',
    );
    assert.equal(
      await closeCodeFor(rt.url, devAuthFrame('owner:dddddddd-dddd-4ddd-8ddd-dddddddddddd')),
      4403,
      'no such owner',
    );
    assert.equal(
      await closeCodeFor(rt.url, devAuthFrame(`staff:${DONAVAN}:owner`)),
      4403,
      "a role the row doesn't hold",
    );
    assert.equal(await closeCodeFor(rt.url, devAuthFrame('owner:not-a-uuid')), 4401, 'bad grammar');
  } finally {
    await rt.close();
  }
});

test('B4: the dev arm with the bypass OFF closes 4401, whatever NODE_ENV says (MB13 H2)', async () => {
  // This process runs with NODE_ENV unset/development/test, where a NODE_ENV-only gate would
  // open the arm. The gate is `bypassHeaderEnabled`, injected off here.
  const rt = await startRealtimeApp({ bypassEnabled: false });
  try {
    assert.notEqual(process.env.NODE_ENV, 'production');
    assert.equal(await closeCodeFor(rt.url, devAuthFrame(`owner:${A}`)), 4401);
    assert.equal(await closeCodeFor(rt.url, devAuthFrame(`staff:${DONAVAN}:trainer`)), 4401);
  } finally {
    await rt.close();
  }
});

test('B4: under NODE_ENV=production with BYPASS_HEADER_ENABLED=true, the default server refuses the dev arm 4401 (a real child process)', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/contracts/_realtimeChild.ts', 'prod-dev-arm', A],
    {
      cwd: REPO_ROOT,
      // An explicit, complete environment (`childEnv`), never the parent's. NODE_ENV=production
      // is this case's subject; like staging, production loads no `.env*` file.
      env: childEnv({
        NODE_ENV: 'production',
        BYPASS_HEADER_ENABLED: 'true',
        SENTRY_DSN: 'https://not-a-real-key@example.sentry.invalid/424242',
        PORTAL_ORIGIN: 'https://portal.fetchd.invalid',
        LOG_LEVEL: 'warn',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(status, 0, err);
  assert.match(out, /BYPASS false/, 'the child really runs with the bypass resolved off');
  assert.match(out, /CLOSE 4401/);
});

test('B4b: a valid re-auth gets no frame and the socket stays open (CR15)', async () => {
  const rt = await startRealtimeApp();
  try {
    const client = await authed(rt.url, authFrame(await signToken(A_UID)));
    client.send(authFrame(await signToken(A_UID)));
    await sleep(400);
    // The bus is not started here, so `ready` is followed by `degraded`; the re-auth adds nothing.
    assert.deepEqual(
      client.frames.map((f) => f.type),
      ['ready', 'degraded'],
    );
    client.send({ type: 'ping' });
    await client.waitForType('pong');
    assert.equal(client.closeCode(), undefined);
    client.end();
  } finally {
    await rt.close();
  }
});

test("B4c: at the token's exp with no new token, 4401 (injected clock); a re-auth with a later exp moves it", async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock });
  try {
    const nowS = Math.floor(clock.now() / 1000);
    const expiring = await authed(
      rt.url,
      authFrame(await signToken(A_UID, { expSeconds: nowS + 30 })),
    );
    const renewed = await authed(
      rt.url,
      authFrame(await signToken(A_UID, { expSeconds: nowS + 30 })),
    );
    renewed.send(authFrame(await signToken(A_UID, { expSeconds: nowS + 50 })));
    await sleep(300);
    clock.advance(31_000);
    assert.equal(await expiring.waitClosed(), REALTIME_CLOSE_CODES.token_invalid);
    await sleep(300);
    assert.equal(renewed.closeCode(), undefined, 'the renewed socket outlives the first exp');
    clock.advance(20_000);
    assert.equal(await renewed.waitClosed(), 4401);
  } finally {
    await rt.close();
  }
});

test('B3: no auth within 5 s closes 4408, and an event published meanwhile is not received', async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock, startBus: true });
  try {
    const silent = await connect(rt.url);
    rt.hub.bus.publishForThread(
      { id: FIXTURE_IDS.thread1Id, owner_id: A },
      { kind: 'thread.changed' },
    );
    rt.hub.bus.publishForThread(
      { id: FIXTURE_IDS.thread1Id, owner_id: A },
      { kind: 'bell.changed' },
    );
    await sleep(300);
    clock.advance(4_999);
    await sleep(100);
    assert.equal(silent.closeCode(), undefined, 'not before 5 s');
    clock.advance(1);
    assert.equal(await silent.waitClosed(), 4408);
    assert.deepEqual(silent.frames, []);
  } finally {
    await rt.close();
  }
});

test('LR6-a: a client that sends `auth` in the same tick as `open` gets `ready`, 50 times out of 50', async () => {
  const rt = await startRealtimeApp();
  try {
    const token = await signToken(A_UID);
    let ready = 0;
    for (let i = 0; i < 50; i += 1) {
      const client = await connect(rt.url, (c) => c.send(authFrame(token)));
      await client.waitForType('ready', 2000);
      ready += 1;
      client.end();
    }
    assert.equal(ready, 50);
  } finally {
    await rt.close();
  }
});

test('OL4 (server): an event published the moment `ready` arrives reaches the socket (registered before `ready`)', async () => {
  const rt = await startRealtimeApp({
    startBus: true,
    // A slow principal read widens the window a `ready`-before-registration bug would open.
    resolve: async (uid) => {
      await sleep(300);
      return resolvePrincipal(uid);
    },
  });
  try {
    const token = await signToken(A_UID);
    const client = await connect(rt.url, (c) => c.send(authFrame(token)));
    await client.waitForType('ready');
    rt.hub.bus.publishForThread(
      { id: FIXTURE_IDS.thread1Id, owner_id: A },
      { kind: 'thread.changed' },
    );
    const frame = await client.waitForType('thread.changed', 3000);
    assert.deepEqual(frame, { type: 'thread.changed', thread_id: FIXTURE_IDS.thread1Id });
    client.end();
  } finally {
    await rt.close();
  }
});

test('B13: a 17 KB frame closes 1009; a 6 KB auth frame passes', async () => {
  const rt = await startRealtimeApp();
  try {
    const bigToken = await signToken(A_UID, { extraClaims: { pad: 'x'.repeat(4300) } });
    const bigAuth = JSON.stringify(authFrame(bigToken));
    assert.ok(
      bigAuth.length > 6000 && bigAuth.length < 7000,
      `auth frame is ${bigAuth.length} bytes`,
    );
    const client = await connect(rt.url, (c) => c.sendRaw(bigAuth));
    await client.waitForType('ready');
    client.sendRaw(JSON.stringify({ type: 'ping', pad: 'y'.repeat(17 * 1024) }));
    assert.equal(await client.waitClosed(), 1009);
  } finally {
    await rt.close();
  }
});

test('LR5-b: a 17 KB frame from an unauthenticated stranger closes 1009, logs nothing at level >= 50, and throws nothing', async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown): void => {
    uncaught.push(e);
  };
  process.on('uncaughtException', onUncaught);
  const rt = await startRealtimeApp();
  try {
    const stranger = await connect(rt.url, (c) => c.sendRaw('z'.repeat(17 * 1024)));
    assert.equal(await stranger.waitClosed(), 1009);
    await sleep(200);
    assert.deepEqual(pagerLines(rt.logs), []);
    assert.equal(linesMatching(rt.logs, /realtime socket error/, 40).length, 1, 'one warn line');
    assert.deepEqual(uncaught, []);
    const res = await rt.app.inject({ method: 'GET', url: '/test-http' });
    assert.equal(res.statusCode, 200);
  } finally {
    process.off('uncaughtException', onUncaught);
    await rt.close();
  }
});

test('B13: a sixth socket for one family evicts the oldest with 4429; the other five stay open', async () => {
  const rt = await startRealtimeApp();
  try {
    const token = await signToken(A_UID);
    const sockets: RtClient[] = [];
    for (let i = 0; i < 6; i += 1) {
      sockets.push(await authed(rt.url, authFrame(token)));
    }
    assert.equal(await sockets[0]!.waitClosed(), 4429);
    await sleep(200);
    for (const s of sockets.slice(1)) assert.equal(s.closeCode(), undefined);
    // Another family's sockets are counted apart.
    const b = await authed(rt.url, authFrame(await signToken(OWNER_B.supabaseUid)));
    await sleep(100);
    for (const s of sockets.slice(1)) assert.equal(s.closeCode(), undefined);
    for (const s of [...sockets, b]) s.end();
  } finally {
    await rt.close();
  }
});

test('B17: with the unauthenticated cap at 10, the overflow gets 1013 and succeeds on retry', async () => {
  const rt = await startRealtimeApp({ limits: { unauthenticatedSockets: 10 } });
  try {
    const waiting: RtClient[] = [];
    for (let i = 0; i < 10; i += 1) waiting.push(await connect(rt.url));
    const overflow = [await connect(rt.url), await connect(rt.url)];
    for (const s of overflow) assert.equal(await s.waitClosed(), 1013);
    for (const s of waiting) assert.equal(s.closeCode(), undefined);
    const token = await signToken(DONAVAN_UID);
    for (const s of waiting) {
      s.send(authFrame(token));
      await s.waitForType('ready');
    }
    for (let i = 0; i < 2; i += 1) {
      const retry = await authed(rt.url, authFrame(token));
      retry.end();
    }
    for (const s of waiting) s.end();
  } finally {
    await rt.close();
  }
});

test('B17: a reconnect storm of 100 clients against a cap of 10: some are told 1013, every one of them reaches `ready` on retry', async () => {
  const rt = await startRealtimeApp({ limits: { unauthenticatedSockets: 10, staffSockets: 200 } });
  try {
    const token = await signToken(DONAVAN_UID);
    let refused = 0;
    const one = async (): Promise<void> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const client = await connect(rt.url, (c) => c.send(authFrame(token)));
        const outcome = await Promise.race([
          client.waitForType('ready', 5000).then(() => 'ready' as const),
          client.waitClosed(5000).then((code) => code),
        ]);
        if (outcome === 'ready') {
          client.end();
          return;
        }
        assert.equal(outcome, 1013);
        refused += 1;
        await sleep(Math.random() * 200); // the client's full jitter
      }
      assert.fail('never reached ready');
    };
    await Promise.all(Array.from({ length: 100 }, () => one()));
    assert.ok(refused > 0, 'the cap was actually hit');
  } finally {
    await rt.close();
  }
});
