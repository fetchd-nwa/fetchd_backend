import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  OWNER_B,
  authFrame,
  baseRedis,
  connect,
  linesMatching,
  pagerLines,
  plantMessage,
  plantThread,
  recordingElement,
  removeOwnerB,
  removeThreads,
  seedOwnerB,
  signToken,
  sleep,
  startRealtimeApp,
  type ElementCall,
  type Frame,
  type RtClient,
} from './_realtime.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import { env } from '../../src/env.js';
import { MAX_MESSAGE_SEQ } from '../../src/contracts/wire.js';
import { ownerChannel, staffChannel } from '../../src/realtime/bus.js';

/**
 * Pass 3 phase R, item 1: the bus kinds that carry a message or a receipt, and their frames
 * (design §3 rule 7, H4; A2 OM3, OL9; brief B6, B7, LR14). Every case is a real server, a real
 * bus on the suite's Redis (its own prefix) and real sockets. Events are published straight onto
 * the bus (`publishForThread`, or a raw PUBLISH for a forged payload), because the routes'
 * call sites are phase F's; so the frame layer must refuse a forged event on its own. The
 * `message` element comes from an injected recording builder (`recordingElement`): the real
 * one, the GET's own, is wired in phase F.
 */

registerFixtureHooks();
before(seedOwnerB);
after(removeOwnerB);

const A = FIXTURE_IDS.ownerId;
const A_UID = FIXTURE_IDS.ownerSupabaseUid;
const DONAVAN = FIXTURE_IDS.staffDonavanId;
const DONAVAN_UID = FIXTURE_IDS.staffDonavanSupabaseUid;
const HER = { kind: 'owner', id: A } as const;
const SCHOOL = { kind: 'staff', id: DONAVAN } as const;

async function authed(url: string, uid: string): Promise<RtClient> {
  const token = await signToken(uid);
  const client = await connect(url, (c) => c.send(authFrame(token)));
  await client.waitForType('ready');
  return client;
}

function created(threadId: string, messageId: string, seq: number) {
  return [
    { id: threadId, owner_id: A },
    { kind: 'message.created', message_id: messageId, seq },
  ] as const;
}

function ofKindIn(client: RtClient, type: string, threadId: string): Frame[] {
  return client.frames.filter((f) => f.type === type && f.thread_id === threadId);
}

test('B7: with 4 live, 5 expired and 6 new, the frame for 6 carries prev_seq 4; a first live message carries prev_seq null, present', async () => {
  const calls: ElementCall[] = [];
  const rt = await startRealtimeApp({ startBus: true, messageElement: recordingElement(calls) });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  const tFirst = await plantThread(A);
  const tAfterExpired = await plantThread(A);
  try {
    const seqs: number[] = [];
    for (const sender of [HER, SCHOOL, HER, SCHOOL]) seqs.push((await plantMessage(t, sender)).seq);
    const five = await plantMessage(t, SCHOOL, { expired: true });
    const six = await plantMessage(t, SCHOOL);
    assert.deepEqual([...seqs, five.seq, six.seq], [1, 2, 3, 4, 5, 6], 'the trigger numbered them');

    rt.hub.bus.publishForThread(...created(t, six.id, six.seq));
    const mine = await a.waitFor((f) => f.type === 'message.created' && f.thread_id === t);
    const theirs = await donavan.waitFor((f) => f.type === 'message.created' && f.thread_id === t);
    for (const frame of [mine, theirs]) {
      assert.deepEqual(Object.keys(frame).sort(), ['message', 'prev_seq', 'thread_id', 'type']);
      assert.equal(frame.prev_seq, 4, 'the last LIVE seq below 6, never the expired 5');
      assert.equal((frame.message as Frame).id, six.id);
      assert.equal((frame.message as Frame).seq, 6);
    }
    assert.equal((mine.message as Frame).text, 'element for owner', 'her element, built for her');
    assert.equal((theirs.message as Frame).text, 'element for staff');

    const first = await plantMessage(tFirst, HER);
    rt.hub.bus.publishForThread(...created(tFirst, first.id, first.seq));
    const firstFrame = await a.waitFor(
      (f) => f.type === 'message.created' && f.thread_id === tFirst,
    );
    assert.ok('prev_seq' in firstFrame, 'prev_seq is sent, never omitted');
    assert.equal(firstFrame.prev_seq, null);

    await plantMessage(tAfterExpired, SCHOOL, { expired: true });
    const second = await plantMessage(tAfterExpired, HER);
    rt.hub.bus.publishForThread(...created(tAfterExpired, second.id, second.seq));
    const afterExpired = await a.waitFor(
      (f) => f.type === 'message.created' && f.thread_id === tAfterExpired,
    );
    assert.equal(afterExpired.prev_seq, null, 'an expired first message is no previous message');
    assert.deepEqual(pagerLines(rt.logs), []);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t, tFirst, tAfterExpired]);
  }
});

test('OL9: a message expired before its frame is built gives no frame and one debug line for each audience; the builder is never asked', async () => {
  const calls: ElementCall[] = [];
  const rt = await startRealtimeApp({ startBus: true, messageElement: recordingElement(calls) });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  try {
    const gone = await plantMessage(t, SCHOOL, { expired: true });
    const [row, event] = created(t, gone.id, gone.seq);
    rt.hub.bus.publishForThread(row, event, ['owner']);
    await sleep(700);
    assert.equal(linesMatching(rt.logs, /message no longer reads/, 20).length, 1, 'her audience');
    rt.hub.bus.publishForThread(row, event, ['staff']);
    await sleep(700);
    assert.equal(linesMatching(rt.logs, /message no longer reads/, 20).length, 2, 'and staff');
    assert.equal(ofKindIn(a, 'message.created', t).length, 0);
    assert.equal(ofKindIn(donavan, 'message.created', t).length, 0);
    assert.deepEqual(calls, [], 'nothing was built for a message that no longer reads');
    assert.deepEqual(pagerLines(rt.logs), []);

    const live = await plantMessage(t, SCHOOL);
    rt.hub.bus.publishForThread(...created(t, live.id, live.seq));
    await a.waitFor((f) => f.type === 'message.created' && f.thread_id === t);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test("OM3 / LR14 forged on message.created: A's owner_id with B's thread, and A's thread with B's message, each reach A (and staff) as nothing, with one error line each", async () => {
  const calls: ElementCall[] = [];
  const rt = await startRealtimeApp({ startBus: true, messageElement: recordingElement(calls) });
  const a = await authed(rt.url, A_UID);
  const b = await authed(rt.url, OWNER_B.supabaseUid);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const tA = await plantThread(A);
  const tB = await plantThread(OWNER_B.id);
  try {
    const mB = await plantMessage(tB, SCHOOL);
    const event = { kind: 'message.created', message_id: mB.id, seq: mB.seq } as const;

    // (1) A's owner_id with B's thread (and B's message): OM3, the thread row decides.
    rt.hub.bus.publishForThread({ id: tB, owner_id: A }, event, ['owner']);
    await sleep(800);
    assert.equal(a.ofType('message.created').length, 0);
    assert.equal(
      linesMatching(rt.logs, /the thread's owner is not this channel's owner/, 50).length,
      1,
    );

    // (2) A's thread with B's message, on A's channel and on the staff channel: LR14's bind.
    rt.hub.bus.publishForThread({ id: tA, owner_id: A }, event, ['owner']);
    rt.hub.bus.publishForThread({ id: tA, owner_id: A }, event, ['staff']);
    await sleep(800);
    assert.equal(a.ofType('message.created').length, 0);
    assert.equal(donavan.ofType('message.created').length, 0);
    assert.equal(
      linesMatching(rt.logs, /names a message of another thread/, 50).length,
      2,
      'one error line per audience',
    );
    assert.equal(b.frames.filter((f) => f.type !== 'ready').length, 0, 'B heard nothing either');
    assert.deepEqual(calls, [], "no element of B's message was ever built");

    // The real event still flows.
    const mA = await plantMessage(tA, SCHOOL);
    rt.hub.bus.publishForThread(...created(tA, mA.id, mA.seq));
    await a.waitFor((f) => f.type === 'message.created' && f.thread_id === tA);
  } finally {
    for (const c of [a, b, donavan]) c.end();
    await rt.close();
    await removeThreads([tA, tB]);
  }
});

test("OM3 forged on receipt: A's owner_id with B's thread reaches A as nothing, with one error line; her own receipt reaches her exactly", async () => {
  const rt = await startRealtimeApp({ startBus: true, messageElement: recordingElement() });
  const a = await authed(rt.url, A_UID);
  const tA = await plantThread(A);
  const tB = await plantThread(OWNER_B.id);
  try {
    const at = new Date().toISOString();
    const receipt = { kind: 'receipt', side: 'owner', state: 'read', up_to_seq: 3, at } as const;
    rt.hub.bus.publishForThread({ id: tB, owner_id: A }, receipt);
    await sleep(800);
    assert.equal(a.ofType('receipt').length, 0);
    assert.equal(
      linesMatching(rt.logs, /the thread's owner is not this channel's owner/, 50).length,
      1,
    );
    rt.hub.bus.publishForThread({ id: tA, owner_id: A }, receipt);
    assert.deepEqual(await a.waitForType('receipt'), {
      type: 'receipt',
      thread_id: tA,
      state: 'read',
      up_to_seq: 3,
      at,
    });
  } finally {
    a.end();
    await rt.close();
    await removeThreads([tA, tB]);
  }
});

test("LR14 (its audience half, on message.created and staff.read): an owner socket planted in the staff channel's set gets only her own element, never the staff one nor staff.read, with one error line per staff-channel event", async () => {
  const rt = await startRealtimeApp({ startBus: true, messageElement: recordingElement() });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  try {
    const m = await plantMessage(t, SCHOOL);
    const { channels } = rt.hub.inspect();
    const aConn = [...(channels.get(ownerChannel(rt.hub.prefix, A)) ?? [])][0];
    assert.ok(aConn !== undefined);
    channels.get(staffChannel(rt.hub.prefix))!.add(aConn);

    rt.hub.bus.publishForThread(...created(t, m.id, m.seq));
    const staffFrame = await donavan.waitFor((f) => f.type === 'message.created');
    assert.equal((staffFrame.message as Frame).text, 'element for staff');
    rt.hub.bus.publishForThread(
      { id: t, owner_id: A },
      { kind: 'staff.read', staff_id: DONAVAN, message_ids: [m.id] },
    );
    await donavan.waitForType('staff.read');
    await sleep(500);
    const hers = a.ofType('message.created');
    assert.equal(hers.length, 1, 'her own channel only');
    assert.equal((hers[0]!.message as Frame).text, 'element for owner');
    assert.equal(a.ofType('staff.read').length, 0);
    assert.equal(linesMatching(rt.logs, /outside this channel's audience/, 50).length, 2);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('B6 (channel and frame half): staff.read and a staff-side receipt reach staff only, with no routing fault; forged onto her channel she gets nothing and one error line each; her own receipt never reaches staff', async () => {
  const rt = await startRealtimeApp({ startBus: true, messageElement: recordingElement() });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  const raw = baseRedis(env.REDIS_URL);
  try {
    const m = await plantMessage(t, HER);
    const at = new Date().toISOString();
    const row = { id: t, owner_id: A };
    rt.hub.bus.publishForThread(row, {
      kind: 'staff.read',
      staff_id: DONAVAN,
      message_ids: [m.id],
    });
    rt.hub.bus.publishForThread(row, {
      kind: 'receipt',
      side: 'staff',
      state: 'delivered',
      up_to_seq: 2,
      at,
    });
    assert.deepEqual(await donavan.waitForType('staff.read'), {
      type: 'staff.read',
      thread_id: t,
      staff_id: DONAVAN,
      message_ids: [m.id],
    });
    assert.deepEqual(await donavan.waitForType('receipt'), {
      type: 'receipt',
      thread_id: t,
      state: 'delivered',
      up_to_seq: 2,
      at,
    });
    await sleep(600);
    assert.equal(a.ofType('staff.read').length, 0);
    assert.equal(a.ofType('receipt').length, 0);
    assert.deepEqual(pagerLines(rt.logs), [], 'the channels alone kept them from her');

    // Forged onto her channel: the frame layer refuses each.
    const base = { v: 1, thread_id: t, owner_id: A };
    await raw.call(
      'PUBLISH',
      ownerChannel(rt.hub.prefix, A),
      JSON.stringify({ ...base, kind: 'staff.read', staff_id: DONAVAN, message_ids: [m.id] }),
    );
    await raw.call(
      'PUBLISH',
      ownerChannel(rt.hub.prefix, A),
      JSON.stringify({ ...base, kind: 'receipt', side: 'staff', state: 'read', up_to_seq: 2, at }),
    );
    await sleep(800);
    assert.equal(a.ofType('staff.read').length, 0);
    assert.equal(a.ofType('receipt').length, 0);
    assert.equal(
      linesMatching(rt.logs, /a staff-audience event arrived on an owner channel/, 50).length,
      2,
    );

    // Her own receipt: hers, never staff's (published, then forged onto the staff channel).
    rt.hub.bus.publishForThread(row, {
      kind: 'receipt',
      side: 'owner',
      state: 'delivered',
      up_to_seq: 1,
      at,
    });
    await a.waitForType('receipt');
    await raw.call(
      'PUBLISH',
      staffChannel(rt.hub.prefix),
      JSON.stringify({ ...base, kind: 'receipt', side: 'owner', state: 'read', up_to_seq: 1, at }),
    );
    await sleep(800);
    assert.equal(donavan.ofType('receipt').length, 1, 'only the staff-side one');
    assert.equal(
      linesMatching(rt.logs, /an owner-audience event arrived on the staff channel/, 50).length,
      1,
    );
  } finally {
    raw.disconnect();
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test("B6: a trainer's socket hears message.created in every family's thread, built for staff; each family hears only her own, built for her", async () => {
  const calls: ElementCall[] = [];
  const rt = await startRealtimeApp({ startBus: true, messageElement: recordingElement(calls) });
  const a = await authed(rt.url, A_UID);
  const b = await authed(rt.url, OWNER_B.supabaseUid);
  const donavan = await authed(rt.url, DONAVAN_UID); // a trainer
  const tA = await plantThread(A);
  const tB = await plantThread(OWNER_B.id);
  try {
    const mA = await plantMessage(tA, HER);
    const mB = await plantMessage(tB, { kind: 'owner', id: OWNER_B.id });
    rt.hub.bus.publishForThread(...created(tA, mA.id, mA.seq));
    rt.hub.bus.publishForThread(
      { id: tB, owner_id: OWNER_B.id },
      { kind: 'message.created', message_id: mB.id, seq: mB.seq },
    );
    for (const t of [tA, tB]) {
      const f = await donavan.waitFor((x) => x.type === 'message.created' && x.thread_id === t);
      assert.equal((f.message as Frame).text, 'element for staff');
    }
    const hers = await a.waitFor((x) => x.type === 'message.created');
    const theirs = await b.waitFor((x) => x.type === 'message.created');
    await sleep(500);
    assert.equal(hers.thread_id, tA);
    assert.equal(theirs.thread_id, tB);
    assert.equal(a.ofType('message.created').length, 1);
    assert.equal(b.ofType('message.created').length, 1);
    assert.equal((hers.message as Frame).text, 'element for owner');
    assert.deepEqual(
      calls.map((c) => `${c.messageId === mA.id ? 'A' : 'B'}:${c.audience}`).sort(),
      ['A:owner', 'A:staff', 'B:owner', 'B:staff'],
    );
    assert.deepEqual(pagerLines(rt.logs), []);
  } finally {
    for (const c of [a, b, donavan]) c.end();
    await rt.close();
    await removeThreads([tA, tB]);
  }
});

test('H4: the new bus kinds are .strict() and bounded (ids, integers and one instant only): text, a name, 0 or 501 ids, a seq past MAX_MESSAGE_SEQ, a non-instant or a non-uuid are each dropped at warn and reach no socket', async () => {
  const calls: ElementCall[] = [];
  const rt = await startRealtimeApp({ startBus: true, messageElement: recordingElement(calls) });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  const raw = baseRedis(env.REDIS_URL);
  try {
    const m = await plantMessage(t, SCHOOL);
    const at = new Date().toISOString();
    const base = { v: 1, thread_id: t, owner_id: A };
    const created1 = { ...base, kind: 'message.created', message_id: m.id, seq: m.seq };
    const bad: Array<[string, Record<string, unknown>]> = [
      [ownerChannel(rt.hub.prefix, A), { ...created1, text: 'Friday at 9am works.' }],
      [staffChannel(rt.hub.prefix), { ...created1, text: 'Friday at 9am works.' }],
      [ownerChannel(rt.hub.prefix, A), { ...created1, seq: MAX_MESSAGE_SEQ + 1 }],
      [staffChannel(rt.hub.prefix), { ...created1, message_id: 'x' }],
      [
        staffChannel(rt.hub.prefix),
        { ...base, kind: 'receipt', side: 'staff', state: 'read', up_to_seq: 1, at, name: 'Amber' },
      ],
      [
        ownerChannel(rt.hub.prefix, A),
        { ...base, kind: 'receipt', side: 'owner', state: 'read', up_to_seq: 1, at: 'yesterday' },
      ],
      [
        ownerChannel(rt.hub.prefix, A),
        { ...base, kind: 'receipt', side: 'owner', state: 'sent', up_to_seq: 1, at },
      ],
      [
        staffChannel(rt.hub.prefix),
        { ...base, kind: 'staff.read', staff_id: DONAVAN, message_ids: [] },
      ],
      [
        staffChannel(rt.hub.prefix),
        {
          ...base,
          kind: 'staff.read',
          staff_id: DONAVAN,
          message_ids: Array.from({ length: 501 }, () => randomUUID()),
        },
      ],
    ];
    for (const [channel, payload] of bad) {
      await raw.call('PUBLISH', channel, JSON.stringify(payload));
    }
    await sleep(900);
    for (const client of [a, donavan]) {
      for (const type of ['message.created', 'receipt', 'staff.read']) {
        assert.equal(client.ofType(type).length, 0, `${type} reached a socket`);
      }
    }
    assert.equal(linesMatching(rt.logs, /no known shape was dropped/, 40).length, bad.length);
    assert.deepEqual(calls, []);

    // A well-formed one of each flows (500 ids is the bound, not past it).
    await raw.call('PUBLISH', ownerChannel(rt.hub.prefix, A), JSON.stringify(created1));
    await a.waitForType('message.created');
    await raw.call(
      'PUBLISH',
      staffChannel(rt.hub.prefix),
      JSON.stringify({
        ...base,
        kind: 'staff.read',
        staff_id: DONAVAN,
        message_ids: Array.from({ length: 500 }, () => randomUUID()),
      }),
    );
    const read = await donavan.waitForType('staff.read');
    assert.equal((read.message_ids as string[]).length, 500);
  } finally {
    raw.disconnect();
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('no default element builder (MB27 Q6): a hub without one builds no message.created, logs one error line per audience, and tells those sockets to resync', async () => {
  const rt = await startRealtimeApp({ startBus: true });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  try {
    const m = await plantMessage(t, SCHOOL);
    rt.hub.bus.publishForThread(...created(t, m.id, m.seq));
    await a.waitForType('resync');
    await donavan.waitForType('resync');
    await sleep(400);
    assert.equal(a.ofType('message.created').length, 0);
    assert.equal(donavan.ofType('message.created').length, 0);
    assert.equal(linesMatching(rt.logs, /no message element builder is wired/, 50).length, 2);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});
