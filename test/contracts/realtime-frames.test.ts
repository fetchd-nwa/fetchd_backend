import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  FakeClock,
  OWNER_B,
  authFrame,
  baseRedis,
  connect,
  linesMatching,
  pagerLines,
  removeOwnerB,
  seedOwnerB,
  setStaffExpired,
  signToken,
  sleep,
  startRealtimeApp,
  type RtClient,
} from './_realtime.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import { env } from '../../src/env.js';
import type { MirrorPrincipal } from '../../src/auth/mirror.js';
import { ownerChannel, staffChannel } from '../../src/realtime/bus.js';

/**
 * Who hears what (design §3 rules 2, 4, 7; A2 OL1, OM3; brief B2, B2b, B6, B13, CR4/M1-b, LR14's
 * audience half; MB13 M2's rows). Every case is a real server, a real bus on the suite's Redis
 * (its own prefix), and real sockets.
 */

registerFixtureHooks();
before(seedOwnerB);
after(removeOwnerB);

const A = FIXTURE_IDS.ownerId;
const A_UID = FIXTURE_IDS.ownerSupabaseUid;
const THREAD_A = FIXTURE_IDS.thread1Id;
const DONAVAN = FIXTURE_IDS.staffDonavanId;
const DONAVAN_UID = FIXTURE_IDS.staffDonavanSupabaseUid;
const AMBER = FIXTURE_IDS.staffAmberId;
const AMBER_UID = FIXTURE_IDS.staffAmberSupabaseUid;

async function authed(url: string, uid: string): Promise<RtClient> {
  const token = await signToken(uid);
  const client = await connect(url, (c) => c.send(authFrame(token)));
  await client.waitForType('ready');
  return client;
}

test("B6 / OL1: staff typing in A's thread reaches A exactly as {type, thread_id, from: 'school'}; colleagues hear the name; the typist and B hear nothing", async () => {
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const b = await authed(rt.url, OWNER_B.supabaseUid);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const amber = await authed(rt.url, AMBER_UID);
  try {
    amber.send({ type: 'typing', thread_id: THREAD_A });
    const toFamily = await a.waitForType('typing');
    assert.deepEqual(toFamily, { type: 'typing', thread_id: THREAD_A, from: 'school' });
    const toColleague = await donavan.waitForType('typing');
    assert.deepEqual(toColleague, {
      type: 'typing',
      thread_id: THREAD_A,
      from: 'staff',
      staff_id: AMBER,
      first_name: 'Amber',
    });
    await sleep(500);
    assert.equal(amber.ofType('typing').length, 0, 'never echoed to the typist');
    assert.equal(b.ofType('typing').length, 0, 'another family hears nothing');
    assert.deepEqual(pagerLines(rt.logs), [], 'no routing fault on the way');
  } finally {
    for (const c of [a, b, donavan, amber]) c.end();
    await rt.close();
  }
});

test("B6: a family's typing reaches staff as {from: 'owner'} and never another family, nor her own other socket", async () => {
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const aOther = await authed(rt.url, A_UID);
  const b = await authed(rt.url, OWNER_B.supabaseUid);
  const donavan = await authed(rt.url, DONAVAN_UID);
  try {
    a.send({ type: 'typing', thread_id: THREAD_A });
    assert.deepEqual(await donavan.waitForType('typing'), {
      type: 'typing',
      thread_id: THREAD_A,
      from: 'owner',
    });
    await sleep(500);
    assert.equal(b.ofType('typing').length, 0);
    assert.equal(aOther.ofType('typing').length, 0);
  } finally {
    for (const c of [a, aOther, b, donavan]) c.end();
    await rt.close();
  }
});

test("B6 (its remainder, MB13 M2): a trainer's socket hears an event in every family's thread; an owner socket never receives a staff-audience event", async () => {
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const b = await authed(rt.url, OWNER_B.supabaseUid);
  const donavan = await authed(rt.url, DONAVAN_UID); // a trainer
  try {
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' });
    rt.hub.bus.publishForThread(
      { id: OWNER_B.threadId, owner_id: OWNER_B.id },
      { kind: 'thread.changed' },
    );
    await donavan.waitFor((f) => f.type === 'thread.changed' && f.thread_id === OWNER_B.threadId);
    await donavan.waitFor((f) => f.type === 'thread.changed' && f.thread_id === THREAD_A);
    await a.waitFor((f) => f.type === 'thread.changed' && f.thread_id === THREAD_A);
    await b.waitFor((f) => f.type === 'thread.changed' && f.thread_id === OWNER_B.threadId);
    // Staff-audience events: bell.changed, and a thread.changed narrowed to staff.
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'bell.changed' });
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' }, [
      'staff',
    ]);
    await donavan.waitForType('bell.changed');
    await sleep(800);
    for (const owner of [a, b]) {
      assert.equal(owner.ofType('bell.changed').length, 0, 'an owner never hears bell.changed');
    }
    assert.equal(
      a.ofType('thread.changed').length,
      1,
      'the staff-only thread.changed did not reach A',
    );
    assert.deepEqual(
      b.frames.filter((f) => f.thread_id === THREAD_A),
      [],
      "B never hears anything about A's thread",
    );
    assert.deepEqual(pagerLines(rt.logs), [], 'no routing fault on the way');
  } finally {
    for (const c of [a, b, donavan]) c.end();
    await rt.close();
  }
});

test("B2 (its relay half): B's `typing` and `ack` naming A's thread relay nothing, reach no ack sink, and count as failed checks", async () => {
  const acks: unknown[] = [];
  const rt = await startRealtimeApp({
    startBus: true,
    onAck: (p, t, s) => void acks.push({ p, t, s }),
  });
  const a = await authed(rt.url, A_UID);
  const b = await authed(rt.url, OWNER_B.supabaseUid);
  const donavan = await authed(rt.url, DONAVAN_UID);
  try {
    b.send({ type: 'typing', thread_id: THREAD_A });
    b.send({ type: 'ack', thread_id: THREAD_A, up_to_seq: 2 });
    await sleep(800);
    assert.equal(donavan.ofType('typing').length, 0);
    assert.equal(a.ofType('typing').length, 0);
    assert.deepEqual(acks, []);
    assert.equal(
      linesMatching(rt.logs, /failed its check/, 40).length,
      2,
      'two failed checks, at warn',
    );
    assert.equal(b.closeCode(), undefined, 'two are not three');
    assert.deepEqual(pagerLines(rt.logs), []);
  } finally {
    for (const c of [a, b, donavan]) c.end();
    await rt.close();
  }
});

test('B2b: three failed thread checks within a minute close 4403; spread over more than a minute they do not', async () => {
  const clock = new FakeClock();
  const rt = await startRealtimeApp({ clock, startBus: true });
  const b = await authed(rt.url, OWNER_B.supabaseUid);
  const patient = await authed(rt.url, OWNER_B.supabaseUid);
  try {
    b.send({ type: 'typing', thread_id: THREAD_A });
    b.send({ type: 'ack', thread_id: THREAD_A, up_to_seq: 1 });
    await sleep(300);
    clock.advance(1_100);
    b.send({ type: 'typing', thread_id: THREAD_A });
    assert.equal(await b.waitClosed(), 4403);

    patient.send({ type: 'typing', thread_id: THREAD_A });
    patient.send({ type: 'ack', thread_id: THREAD_A, up_to_seq: 1 });
    await sleep(300);
    clock.advance(30_000);
    patient.send({ type: 'ping' });
    await patient.waitForType('pong');
    clock.advance(31_000);
    patient.send({ type: 'typing', thread_id: THREAD_A });
    await sleep(400);
    assert.equal(patient.closeCode(), undefined, 'the first two fell out of the minute');
  } finally {
    b.end();
    patient.end();
    await rt.close();
  }
});

test("OM3: a bus payload naming A's owner_id with B's thread reaches A as nothing, with one error line", async () => {
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const raw = baseRedis(env.REDIS_URL);
  try {
    const forged = JSON.stringify({
      v: 1,
      kind: 'thread.changed',
      thread_id: OWNER_B.threadId,
      owner_id: A,
    });
    // A raw PUBLISH, as a routing bug elsewhere would send it (`call`, so the publish lint rule
    // keeps meaning "only bus.ts publishes" for product code).
    await raw.call('PUBLISH', ownerChannel(rt.hub.prefix, A), forged);
    await sleep(800);
    assert.equal(a.ofType('thread.changed').length, 0);
    assert.equal(
      linesMatching(rt.logs, /the thread's owner is not this channel's owner/, 50).length,
      1,
    );
    // The real event still flows.
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'thread.changed' });
    await a.waitForType('thread.changed');
  } finally {
    raw.disconnect();
    a.end();
    await rt.close();
  }
});

test("LR14 (its audience half): an owner socket planted in the staff channel's set gets nothing, with one error line; staff still hear", async () => {
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  try {
    const { channels } = rt.hub.inspect();
    const aConn = [...(channels.get(ownerChannel(rt.hub.prefix, A)) ?? [])][0];
    assert.ok(aConn !== undefined);
    channels.get(staffChannel(rt.hub.prefix))!.add(aConn);
    rt.hub.bus.publishForThread({ id: THREAD_A, owner_id: A }, { kind: 'bell.changed' });
    await donavan.waitForType('bell.changed');
    await sleep(300);
    assert.equal(a.ofType('bell.changed').length, 0);
    assert.equal(linesMatching(rt.logs, /outside this channel's audience/, 50).length, 1);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
  }
});

test('B13: twenty typing frames in one second relay one; the next second relays again', async () => {
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  try {
    const first = Date.now();
    for (let i = 0; i < 20; i += 1) {
      a.send({ type: 'typing', thread_id: THREAD_A });
      await sleep(45);
    }
    await sleep(Math.max(0, 1_000 - (Date.now() - first)));
    await sleep(400);
    assert.equal(donavan.ofType('typing').length, 1);
    await sleep(Math.max(0, 1_150 - (Date.now() - first)));
    a.send({ type: 'typing', thread_id: THREAD_A });
    await donavan.waitFor(() => donavan.ofType('typing').length === 2);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
  }
});

test("M1-b (CR4): an ack with up_to_seq 3000000000 and a typing with thread_id 'x' relay nothing, keep the socket open, log nothing at level >= 50", async () => {
  const acks: unknown[] = [];
  const rt = await startRealtimeApp({
    startBus: true,
    onAck: (p, t, s) => void acks.push({ p, t, s }),
  });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  try {
    a.send({ type: 'ack', thread_id: THREAD_A, up_to_seq: 3_000_000_000 });
    a.send({ type: 'typing', thread_id: 'x' });
    await sleep(600);
    assert.deepEqual(acks, []);
    assert.equal(donavan.ofType('typing').length, 0);
    a.send({ type: 'ping' });
    await a.waitForType('pong');
    assert.equal(a.closeCode(), undefined);
    assert.deepEqual(pagerLines(rt.logs), []);
    assert.equal(
      linesMatching(rt.logs, /failed its check/, 40).length,
      2,
      'both dropped as failed checks',
    );
  } finally {
    a.end();
    donavan.end();
    await rt.close();
  }
});

test('ack (MB13 M2): coalesced to the highest up_to_seq per thread, at most one a second, handed to the injected onAck', async () => {
  const clock = new FakeClock();
  const acks: Array<{ principal: MirrorPrincipal; threadId: string; upToSeq: number }> = [];
  const rt = await startRealtimeApp({
    clock,
    onAck: (principal, threadId, upToSeq) => {
      acks.push({ principal, threadId, upToSeq });
    },
  });
  const a = await authed(rt.url, A_UID);
  try {
    a.send({ type: 'ack', thread_id: THREAD_A, up_to_seq: 3 });
    await sleep(300);
    a.send({ type: 'ack', thread_id: THREAD_A, up_to_seq: 5 });
    a.send({ type: 'ack', thread_id: THREAD_A, up_to_seq: 4 });
    await sleep(300);
    assert.deepEqual(
      acks.map((x) => x.upToSeq),
      [3],
      'the first goes at once, the next two wait',
    );
    clock.advance(999);
    await sleep(200);
    assert.equal(acks.length, 1);
    clock.advance(1);
    await sleep(300);
    assert.deepEqual(
      acks.map((x) => x.upToSeq),
      [3, 5],
      'one more, with the highest',
    );
    assert.deepEqual(acks[1]!.principal, { kind: 'owner', id: A });
    assert.equal(acks[1]!.threadId, THREAD_A);
  } finally {
    a.end();
    await rt.close();
  }
});

test('typing and ack each re-resolve the principal before the thread check (MB13 M2): an expired staffer, heartbeat frozen, is closed 4403 and relays nothing', async () => {
  const clock = new FakeClock();
  const acks: unknown[] = [];
  const rt = await startRealtimeApp({
    clock,
    startBus: true,
    onAck: (p, t, s) => void acks.push({ p, t, s }),
  });
  const a = await authed(rt.url, A_UID);
  const typist = await authed(rt.url, DONAVAN_UID);
  const acker = await authed(rt.url, DONAVAN_UID);
  try {
    await setStaffExpired(DONAVAN, true);
    typist.send({ type: 'typing', thread_id: THREAD_A });
    assert.equal(await typist.waitClosed(), 4403);
    acker.send({ type: 'ack', thread_id: THREAD_A, up_to_seq: 1 });
    assert.equal(await acker.waitClosed(), 4403);
    await sleep(400);
    assert.equal(a.ofType('typing').length, 0);
    assert.deepEqual(acks, []);
  } finally {
    await setStaffExpired(DONAVAN, false);
    for (const c of [a, typist, acker]) c.end();
    await rt.close();
  }
});
