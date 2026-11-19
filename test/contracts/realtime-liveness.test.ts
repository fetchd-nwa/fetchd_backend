import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  FakeClock,
  authFrame,
  connect,
  devAuthFrame,
  pagerLines,
  removeOwnerB,
  seedOwnerB,
  setOwnerExpired,
  setStaffExpired,
  setStaffRole,
  signToken,
  sleep,
  startRealtimeApp,
  type RtClient,
} from './_realtime.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import { resolvePrincipalById } from '../../src/auth/mirror.js';

/**
 * The principal is re-checked, not just the token (design §3 rule 5, H1; A2 OM2, OM5; brief B5,
 * LR7, LR13, LR16; A2 FH1-b, FH1-c). The heartbeat runs on an injected clock, so "within one
 * heartbeat" and "heartbeat frozen" are exact.
 */

registerFixtureHooks();
before(seedOwnerB);
after(removeOwnerB);

const A = FIXTURE_IDS.ownerId;
const A_UID = FIXTURE_IDS.ownerSupabaseUid;
const THREAD_A = FIXTURE_IDS.thread1Id;
const DONAVAN = FIXTURE_IDS.staffDonavanId;
const DONAVAN_UID = FIXTURE_IDS.staffDonavanSupabaseUid;
const RACHEL = FIXTURE_IDS.staffRachelId;
const RACHEL_UID = FIXTURE_IDS.staffRachelSupabaseUid;
const AMBER_UID = FIXTURE_IDS.staffAmberSupabaseUid;

async function authed(url: string, frame: Record<string, unknown>): Promise<RtClient> {
  const client = await connect(url, (c) => c.send(frame));
  await client.waitForType('ready');
  return client;
}

/** Watch the process for anything that would reach `observability.ts`'s exit handlers. */
function watchEscapes(): { seen: unknown[]; stop(): void } {
  const seen: unknown[] = [];
  const record = (e: unknown): void => {
    seen.push(e);
  };
  process.on('unhandledRejection', record);
  process.on('uncaughtException', record);
  return {
    seen,
    stop() {
      process.off('unhandledRejection', record);
      process.off('uncaughtException', record);
    },
  };
}

/** Fire the heartbeat and give its async re-resolve time to land. */
async function heartbeat(clock: FakeClock): Promise<void> {
  clock.advance(25_000);
  await sleep(250);
}

test('B5: a staff row expired mid-connection closes 4403 within one heartbeat, and nothing is delivered after', async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock, startBus: true });
  const rachel = await authed(rt.url, authFrame(await signToken(RACHEL_UID)));
  try {
    await setStaffExpired(RACHEL, true);
    await heartbeat(clock);
    assert.equal(await rachel.waitClosed(), 4403);
    const before = rachel.frames.length;
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'bell.changed' });
    await sleep(300);
    assert.equal(rachel.frames.length, before);
  } finally {
    await setStaffExpired(RACHEL, false);
    rachel.end();
    await rt.close();
  }
});

test('B5: an owner row expired mid-connection closes 4403 within one heartbeat', async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock });
  const owner = await authed(rt.url, authFrame(await signToken(A_UID)));
  try {
    await setOwnerExpired(A, true);
    await heartbeat(clock);
    assert.equal(await owner.waitClosed(), 4403);
  } finally {
    await setOwnerExpired(A, false);
    owner.end();
    await rt.close();
  }
});

test("B5: a staffer's role change closes 4403 at the next heartbeat", async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock });
  const donavan = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
  try {
    await setStaffRole(DONAVAN, 'manager');
    await heartbeat(clock);
    assert.equal(await donavan.waitClosed(), 4403);
  } finally {
    await setStaffRole(DONAVAN, 'trainer');
    donavan.end();
    await rt.close();
  }
});

test("B5: a re-auth with another principal's token closes 4403", async () => {
  const rt = await startRealtimeApp();
  try {
    const donavan = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
    donavan.send(authFrame(await signToken(AMBER_UID)));
    assert.equal(await donavan.waitClosed(), 4403);
    const owner = await authed(rt.url, authFrame(await signToken(A_UID)));
    owner.send(authFrame(await signToken(DONAVAN_UID)));
    assert.equal(await owner.waitClosed(), 4403);
  } finally {
    await rt.close();
  }
});

test('B5 / OM2: with the heartbeat frozen, a staffer expired 1 ms before an event does not receive it, and that socket closes 4403', async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock, startBus: true });
  const rachel = await authed(rt.url, authFrame(await signToken(RACHEL_UID)));
  const donavan = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
  try {
    await setStaffExpired(RACHEL, true);
    await sleep(1);
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' }, [
      'staff',
    ]);
    await donavan.waitForType('thread.changed');
    assert.equal(await rachel.waitClosed(), 4403);
    assert.equal(rachel.ofType('thread.changed').length, 0);
  } finally {
    await setStaffExpired(RACHEL, false);
    rachel.end();
    donavan.end();
    await rt.close();
  }
});

test('LR16: with the heartbeat frozen, a staffer whose role changed 1 ms before an event does not receive it, and closes 4403', async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock, startBus: true });
  const donavan = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
  const amber = await authed(rt.url, authFrame(await signToken(AMBER_UID)));
  try {
    await setStaffRole(DONAVAN, 'manager');
    await sleep(1);
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'bell.changed' });
    await amber.waitForType('bell.changed');
    assert.equal(await donavan.waitClosed(), 4403);
    assert.equal(donavan.ofType('bell.changed').length, 0);
  } finally {
    await setStaffRole(DONAVAN, 'trainer');
    donavan.end();
    amber.end();
    await rt.close();
  }
});

test('OM5 control: a live staffer stays open across three heartbeats, on the token arm and on the dev arm (re-resolved by row id)', async () => {
  const clock = new FakeClock();
  let reads = 0;
  const rt = await startRealtimeApp({
    clock,
    bypassEnabled: true,
    resolveById: async (ref) => {
      reads += 1;
      return resolvePrincipalById(ref);
    },
  });
  const viaToken = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
  const viaDev = await authed(rt.url, devAuthFrame(`staff:${DONAVAN}:trainer`));
  try {
    const afterAuth = reads;
    for (let beat = 1; beat <= 3; beat += 1) {
      for (const c of [viaToken, viaDev]) c.send({ type: 'ping' });
      await sleep(150);
      await heartbeat(clock);
      assert.equal(viaToken.closeCode(), undefined, `token arm after heartbeat ${beat}`);
      assert.equal(viaDev.closeCode(), undefined, `dev arm after heartbeat ${beat}`);
    }
    assert.equal(
      reads - afterAuth,
      6,
      'each socket was re-resolved at each of the three heartbeats',
    );
  } finally {
    viaToken.end();
    viaDev.end();
    await rt.close();
  }
});

test('LR7-a: the liveness query forced to throw delivers nothing, closes nothing, and tells every socket `resync`; the process lives', async () => {
  let failing = false;
  const rt = await startRealtimeApp({
    startBus: true,
    delivery: {
      livePrincipals: async (principals) => {
        if (failing) throw new Error('connection terminated unexpectedly (test)');
        const { livePrincipalsAmong } = await import('../../src/realtime/frames.js');
        return livePrincipalsAmong(principals);
      },
    },
  });
  const owner = await authed(rt.url, authFrame(await signToken(A_UID)));
  const donavan = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
  try {
    failing = true;
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' });
    await owner.waitForType('resync');
    await donavan.waitForType('resync');
    await sleep(300);
    for (const c of [owner, donavan]) {
      assert.equal(c.ofType('thread.changed').length, 0, 'nothing delivered on an unknown answer');
      assert.equal(c.closeCode(), undefined, 'no 4403: a failure is never "missing"');
    }
    assert.equal((await rt.app.inject({ method: 'GET', url: '/test-http' })).statusCode, 200);
    failing = false;
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' });
    await owner.waitForType('thread.changed');
  } finally {
    owner.end();
    donavan.end();
    await rt.close();
  }
});

test('FH1-b: the principal read throwing on the heartbeat closes that socket 1011; another socket and an HTTP request still work', async () => {
  const clock = new FakeClock();
  let throwFor: string | undefined;
  const rt = await startRealtimeApp({
    clock,
    resolveById: async (ref) => {
      if (ref.id === throwFor) throw new Error('ambiguous_principal (test)');
      return resolvePrincipalById(ref);
    },
  });
  const donavan = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
  const amber = await authed(rt.url, authFrame(await signToken(AMBER_UID)));
  try {
    const escapes = watchEscapes();
    throwFor = DONAVAN;
    await heartbeat(clock);
    assert.equal(await donavan.waitClosed(), 1011);
    amber.send({ type: 'ping' });
    await amber.waitForType('pong');
    assert.equal(amber.closeCode(), undefined);
    assert.equal((await rt.app.inject({ method: 'GET', url: '/test-http' })).statusCode, 200);
    assert.deepEqual(pagerLines(rt.logs), [], 'warn, never a page');
    await sleep(100);
    escapes.stop();
    assert.deepEqual(escapes.seen, [], 'no unhandledRejection or uncaughtException');
  } finally {
    donavan.end();
    amber.end();
    await rt.close();
  }
});

test('FH1-c: the principal read throwing inside an `ack` handler closes that socket 1011; the rest live', async () => {
  let throwFor: string | undefined;
  const acks: unknown[] = [];
  const rt = await startRealtimeApp({
    resolveById: async (ref) => {
      if (ref.id === throwFor) throw new Error('ambiguous_principal (test)');
      return resolvePrincipalById(ref);
    },
    onAck: (principal, threadId, upToSeq) => {
      acks.push({ principal, threadId, upToSeq });
    },
  });
  const owner = await authed(rt.url, authFrame(await signToken(A_UID)));
  const donavan = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
  try {
    const escapes = watchEscapes();
    throwFor = A;
    owner.send({ type: 'ack', thread_id: THREAD_A, up_to_seq: 3 });
    assert.equal(await owner.waitClosed(), 1011);
    assert.deepEqual(acks, []);
    donavan.send({ type: 'ping' });
    await donavan.waitForType('pong');
    assert.equal((await rt.app.inject({ method: 'GET', url: '/test-http' })).statusCode, 200);
    assert.deepEqual(pagerLines(rt.logs), []);
    await sleep(100);
    escapes.stop();
    assert.deepEqual(escapes.seen, [], 'no unhandledRejection or uncaughtException');
  } finally {
    owner.end();
    donavan.end();
    await rt.close();
  }
});

test('LR13-a: a silent upgraded client is terminated by 65 s (injected clock); the client sees 1006', async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock });
  const silent = await authed(rt.url, authFrame(await signToken(A_UID)));
  const chatty = await authed(rt.url, authFrame(await signToken(DONAVAN_UID)));
  try {
    await heartbeat(clock); // 25 s
    chatty.send({ type: 'ping' });
    await chatty.waitForType('pong');
    await heartbeat(clock); // 50 s
    clock.advance(9_000); // 59 s
    await sleep(150);
    assert.equal(silent.closeCode(), undefined, 'not before 60 s');
    clock.advance(6_000); // 65 s
    assert.equal(await silent.waitClosed(), 1006);
    assert.equal(chatty.closeCode(), undefined, 'a socket that spoke within the minute stays');
  } finally {
    silent.end();
    chatty.end();
    await rt.close();
  }
});
