import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import { sql } from 'drizzle-orm';
import type { MirrorPrincipal } from '../../src/auth/mirror.js';
import { REALTIME_SERVER_FRAME_TYPES } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';
import { deliveredAckSink } from '../../src/realtime/delivered.js';
import { livePrincipalsAmong } from '../../src/realtime/frames.js';
import {
  OWNER_B,
  deliveredAtOf,
  pagerLines,
  plantMessage,
  plantThread,
  removeOwnerB,
  removeThreads,
  seedOwnerB,
  sleep,
  type Frame,
  type PublishedEvent,
  type RtClient,
} from './_realtime.js';
import { call, socketFor, startRouteApp, type RouteTestApp } from './_realtimeRoutes.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import {
  plantOwnerMedia,
  plantStaffMedia,
  removePlantedMedia,
  removePlantedStaffTraces,
  removeSchoolThreads,
} from './_messaging.js';
import { waitForBlockedBackends } from './_poolFixture.js';

/**
 * Pass 3 phase F: every publish call site on its real route (item 2; brief `:444`, `:454`;
 * design OL5; MB27 Q2–Q5), and what each socket hears from it. One listening app per test
 * (`startRouteApp`: the routes, the real bus, the real element builder on an R2 stub, the real
 * *Delivered* sink); `buildApp()` itself for the shape pin. Every publish of every app in this
 * file is collected for B15's bus spy (the last test).
 */

registerFixtureHooks();
before(seedOwnerB);
// A staff send writes a feed row naming the staffer; another family's must go before teardown.
afterEach(removePlantedStaffTraces);
after(removeOwnerB);

const A = FIXTURE_IDS.ownerId;
const HER: MirrorPrincipal = { kind: 'owner', id: A };
const B: MirrorPrincipal = { kind: 'owner', id: OWNER_B.id };
const DONAVAN: MirrorPrincipal = { kind: 'staff', id: FIXTURE_IDS.staffDonavanId, role: 'trainer' };
const AMBER: MirrorPrincipal = { kind: 'staff', id: FIXTURE_IDS.staffAmberId, role: 'manager' };
const SCHOOL = { kind: 'staff', id: FIXTURE_IDS.staffDonavanId } as const;
const HERS = { kind: 'owner', id: A } as const;

/** Every publish of every app in this file, for B15's spy. */
const everyPublish: PublishedEvent[] = [];
/** Every text this file sends, for the same spy. */
const sentTexts: string[] = [];

async function routeApp(...args: Parameters<typeof startRouteApp>): Promise<RouteTestApp> {
  const rt = await startRouteApp(...args);
  const original = rt.hub.bus.publishForThread.bind(rt.hub.bus);
  rt.hub.bus.publishForThread = (row, event, only) => {
    everyPublish.push({ row, event, only });
    original(row, event, only);
  };
  return rt;
}

function text(label: string): string {
  const t = `${label} ${randomUUID().slice(0, 8)}`;
  sentTexts.push(t);
  return t;
}

function ofThread(client: RtClient, type: string, threadId: string): Frame[] {
  return client.frames.filter((f) => f.type === type && f.thread_id === threadId);
}

async function isoOf(query: ReturnType<typeof sql>): Promise<string | null> {
  const result = await db.execute(query);
  return ((result.rows as Array<{ at: string | null }>)[0] ?? { at: null }).at;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

test('B1 (table-driven over REALTIME_SERVER_FRAME_TYPES, real routes and frames): every thread-scoped kind triggered in A’s thread reaches what its audience allows; B hears none in 2 s; B’s instance-wide frames are exactly their contract shapes and carry nothing of A’s', async () => {
  const failLiveness = { on: false };
  const rt = await routeApp({
    delivery: {
      livePrincipals: (ps) =>
        failLiveness.on ? Promise.reject(new Error('forced (B1 resync)')) : livePrincipalsAmong(ps),
    },
  });
  const a = await socketFor(rt.url, HER);
  const b = await socketFor(rt.url, B);
  const staff = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  try {
    // typing: her frame.
    a.send({ type: 'typing', thread_id: t });
    await staff.waitFor((f) => f.type === 'typing' && f.thread_id === t);
    // message.created: her send, then a staff reply (real routes).
    const mine = await call(rt.app, HER, 'POST', `/threads/${t}/messages`, { text: text('her') });
    assert.equal(mine.statusCode, 201);
    const reply = await call(rt.app, DONAVAN, 'POST', `/staff/threads/${t}/messages`, {
      text: text('reply'),
    });
    assert.equal(reply.statusCode, 201);
    await a.waitFor(() => ofThread(a, 'message.created', t).length === 2);
    await staff.waitFor(() => ofThread(staff, 'message.created', t).length === 2);
    // staff.read + bell.changed + her receipt: a staffer reads her message.
    const read = await call(rt.app, AMBER, 'POST', `/staff/threads/${t}/read`, {
      message_ids: [mine.json<{ id: string }>().id],
    });
    assert.equal(read.statusCode, 204);
    await staff.waitFor((f) => f.type === 'staff.read' && f.thread_id === t);
    await staff.waitForType('bell.changed');
    await a.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    // thread.changed (hers only) + the school's receipt: her read.
    const hersRead = await call(rt.app, HER, 'POST', `/threads/${t}/read`, {});
    assert.equal(hersRead.statusCode, 204);
    await a.waitFor((f) => f.type === 'thread.changed' && f.thread_id === t);
    await staff.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    await sleep(2_000); // "B hears nothing in 2 s"

    // The instance-wide kinds, last: pong, then degraded → live, then resync.
    b.send({ type: 'ping' });
    await b.waitForType('pong');
    rt.failPublishes.on = true;
    a.send({ type: 'typing', thread_id: t });
    await sleep(1_100);
    a.send({ type: 'typing', thread_id: t });
    await b.waitForType('degraded');
    rt.failPublishes.on = false;
    await b.waitForType('live', 5_000);
    failLiveness.on = true;
    await sleep(1_100);
    a.send({ type: 'typing', thread_id: t });
    await b.waitForType('resync');
    failLiveness.on = false;

    // The table: one row per member, each decided by audience (Q1 for the instance-wide).
    const threadScoped: Record<string, { her: boolean; staff: boolean }> = {
      'message.created': { her: true, staff: true },
      receipt: { her: true, staff: true },
      typing: { her: false, staff: true },
      'staff.read': { her: false, staff: true },
      'thread.changed': { her: true, staff: false },
      'bell.changed': { her: false, staff: true },
    };
    const shapes: Record<string, string[]> = {
      ready: ['protocol', 'type'],
      degraded: ['type'],
      live: ['type'],
      resync: ['type'],
      pong: ['type'],
    };
    for (const type of REALTIME_SERVER_FRAME_TYPES) {
      const row = threadScoped[type];
      if (row !== undefined) {
        const hers = type === 'bell.changed' ? a.ofType(type) : ofThread(a, type, t);
        const theirs = type === 'bell.changed' ? staff.ofType(type) : ofThread(staff, type, t);
        assert.equal(hers.length > 0, row.her, `${type}: her socket`);
        assert.equal(theirs.length > 0, row.staff, `${type}: staff`);
        assert.equal(b.ofType(type).length, 0, `${type}: B heard it`);
        continue;
      }
      const shape = shapes[type];
      assert.ok(shape !== undefined, `no B1 row for ${type}`);
      const received = b.ofType(type);
      assert.ok(received.length > 0, `${type}: B never got the instance-wide frame`);
      for (const f of received) assert.deepEqual(Object.keys(f).sort(), shape, `${type} shape`);
    }
    for (const f of b.frames) {
      assert.ok(shapes[f.type as string] !== undefined, `B got a ${String(f.type)}`);
      assert.ok(!JSON.stringify(f).includes(t), 'nothing of A’s thread');
    }
    assert.equal(
      ofThread(staff, 'message.created', t).length + staff.ofType('bell.changed').length,
      3,
      'no bell.changed on an owner’s message, one on the staff read (CR16)',
    );
    assert.deepEqual(
      pagerLines(rt.logs).filter((l) => /routing fault/.test(String(l.msg))),
      [],
    );
  } finally {
    for (const c of [a, b, staff]) c.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('B10 (and Q2, Q3): her read sends thread.changed to her other socket and the school’s receipt `read` to staff (up_to_seq the highest read, at its instant); a key replay and a read that moves nothing publish nothing', async () => {
  const rt = await routeApp();
  const phone = await socketFor(rt.url, HER);
  const ipad = await socketFor(rt.url, HER);
  const staff = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  try {
    const m1 = await plantMessage(t, SCHOOL);
    const m2 = await plantMessage(t, SCHOOL);
    const m3 = await plantMessage(t, SCHOOL);
    const key = `b10-${randomUUID()}`;
    const res = await call(rt.app, HER, 'POST', `/threads/${t}/read`, { up_to_seq: m2.seq }, key);
    assert.equal(res.statusCode, 204);
    await ipad.waitFor((f) => f.type === 'thread.changed' && f.thread_id === t);
    const receipt = await staff.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    const at = await isoOf(
      sql`SELECT to_char(read_at AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS at FROM messages WHERE id = ${m2.id}`,
    );
    assert.deepEqual(receipt, {
      type: 'receipt',
      thread_id: t,
      state: 'read',
      up_to_seq: m2.seq,
      at,
    });
    assert.deepEqual(
      rt.published.map((p) => [p.event.kind, p.only]),
      [
        ['thread.changed', ['owner']],
        ['receipt', undefined],
      ],
    );
    assert.equal(
      ofThread(staff, 'thread.changed', t).length,
      0,
      'her read is her devices’ thread.changed',
    );
    assert.ok(m1.seq < m2.seq && m2.seq < m3.seq);

    const replay = await call(
      rt.app,
      HER,
      'POST',
      `/threads/${t}/read`,
      { up_to_seq: m2.seq },
      key,
    );
    assert.equal(replay.statusCode, 204);
    const again = await call(rt.app, HER, 'POST', `/threads/${t}/read`, { up_to_seq: m2.seq });
    assert.equal(again.statusCode, 204);
    await sleep(800);
    assert.equal(rt.published.length, 2, 'a replay and a read that moved nothing publish nothing');
    assert.equal(ofThread(staff, 'receipt', t).length, 1);
  } finally {
    for (const c of [phone, ipad, staff]) c.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('B10b (CR14) and Q5: Donavan reads her message, then Amber the same: her socket gets ONE receipt, at the first read; each read sends staff.read with only its newly marked ids and bell.changed; a repeat sends nothing', async () => {
  const rt = await routeApp();
  const a = await socketFor(rt.url, HER);
  const staff = await socketFor(rt.url, AMBER);
  const t = await plantThread(A);
  try {
    const m = await plantMessage(t, HERS);
    const first = await call(rt.app, DONAVAN, 'POST', `/staff/threads/${t}/read`, {
      message_ids: [m.id],
    });
    assert.equal(first.statusCode, 204);
    const receipt = await a.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    await sleep(300);
    const second = await call(rt.app, AMBER, 'POST', `/staff/threads/${t}/read`, {
      message_ids: [m.id],
    });
    assert.equal(second.statusCode, 204);
    await staff.waitFor(() => ofThread(staff, 'staff.read', t).length === 2);
    const repeat = await call(rt.app, AMBER, 'POST', `/staff/threads/${t}/read`, {
      message_ids: [m.id],
    });
    assert.equal(repeat.statusCode, 204);
    await sleep(900);
    const at = await isoOf(
      sql`SELECT to_char(min(read_at) AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS at FROM message_staff_reads WHERE message_id = ${m.id}`,
    );
    assert.deepEqual(receipt, {
      type: 'receipt',
      thread_id: t,
      state: 'read',
      up_to_seq: m.seq,
      at,
    });
    assert.equal(ofThread(a, 'receipt', t).length, 1, 'one family receipt per first read');
    assert.deepEqual(
      ofThread(staff, 'staff.read', t).map((f) => [f.staff_id, f.message_ids]),
      [
        [DONAVAN.id, [m.id]],
        [AMBER.id, [m.id]],
      ],
    );
    assert.equal(staff.ofType('bell.changed').length, 2, 'none for the repeat');
    assert.equal(a.ofType('staff.read').length + a.ofType('bell.changed').length, 0);
  } finally {
    a.end();
    staff.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('Q3 and the create verbs: her start and send, a staff start and reply each publish one message.created heard by her and staff; a client_message_id repeat (200) and a key replay publish nothing', async () => {
  const rt = await routeApp();
  const a = await socketFor(rt.url, HER);
  const staff = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  const started: string[] = [];
  try {
    // A client_message_id repeat is the lookup's 200 (same key or not); a key replay needs a
    // send without one (withMutation's stored 201).
    const body = { text: text('her'), client_message_id: randomUUID() };
    const key = `q3-${randomUUID()}`;
    assert.equal(
      (await call(rt.app, HER, 'POST', `/threads/${t}/messages`, body, key)).statusCode,
      201,
    );
    assert.equal(
      (await call(rt.app, HER, 'POST', `/threads/${t}/messages`, body, key)).statusCode,
      200,
    );
    assert.equal((await call(rt.app, HER, 'POST', `/threads/${t}/messages`, body)).statusCode, 200);
    const plain = { text: text('her plain') };
    const pkey = `q3p-${randomUUID()}`;
    assert.equal(
      (await call(rt.app, HER, 'POST', `/threads/${t}/messages`, plain, pkey)).statusCode,
      201,
    );
    assert.equal(
      (await call(rt.app, HER, 'POST', `/threads/${t}/messages`, plain, pkey)).statusCode,
      201,
    );

    const rbody = { text: text('reply'), client_message_id: randomUUID() };
    const reply = (b: unknown, k?: string) =>
      call(rt.app, DONAVAN, 'POST', `/staff/threads/${t}/messages`, b, k);
    assert.equal((await reply(rbody)).statusCode, 201);
    assert.equal((await reply(rbody)).statusCode, 200);
    const rplain = { text: text('reply plain') };
    const rkey = `q3rp-${randomUUID()}`;
    assert.equal((await reply(rplain, rkey)).statusCode, 201);
    assert.equal((await reply(rplain, rkey)).statusCode, 201);

    const herStart = await call(rt.app, HER, 'POST', '/threads', {
      category: 'billing',
      text: text('her start'),
    });
    assert.equal(herStart.statusCode, 201);
    const staffStart = await call(rt.app, DONAVAN, 'POST', '/staff/threads', {
      owner_id: A,
      category: 'other',
      text: text('staff start'),
    });
    assert.equal(staffStart.statusCode, 201);
    const herThread = herStart.json<{ thread: { id: string } }>().thread.id;
    const staffThread = staffStart.json<{ thread: { id: string } }>().thread.id;
    started.push(staffThread);
    for (const [threadId, n] of [
      [t, 4],
      [herThread, 1],
      [staffThread, 1],
    ] as const) {
      await a.waitFor(() => ofThread(a, 'message.created', threadId).length === n);
      await staff.waitFor(() => ofThread(staff, 'message.created', threadId).length === n);
    }
    await sleep(800);
    assert.deepEqual(
      rt.published.map((p) => [p.event.kind, p.row.id, p.row.owner_id]),
      [
        ['message.created', t, A],
        ['message.created', t, A],
        ['message.created', t, A],
        ['message.created', t, A],
        ['message.created', herThread, A],
        ['message.created', staffThread, A],
      ],
    );
    assert.equal(staff.ofType('bell.changed').length, 0, 'no bell.changed on a message');
  } finally {
    a.end();
    staff.end();
    await rt.close();
    await removeThreads([t, ...started]);
    await removeSchoolThreads(A);
  }
});

test('OL5: her own attachment deleted (204) and a staff attachment deleted by staff (204) each send thread.changed to her socket and to staff; an unattached upload deleted sends nothing', async () => {
  const rt = await routeApp();
  const a = await socketFor(rt.url, HER);
  const staff = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  const media = [await plantOwnerMedia(A), await plantStaffMedia(A), await plantOwnerMedia(A)];
  const [hersAttached, staffAttached, loose] = media as [string, string, string];
  try {
    const sent = await call(rt.app, HER, 'POST', `/threads/${t}/messages`, {
      attachment_media_ids: [hersAttached],
    });
    assert.equal(sent.statusCode, 201);
    const replied = await call(rt.app, DONAVAN, 'POST', `/staff/threads/${t}/messages`, {
      attachment_media_ids: [staffAttached],
    });
    assert.equal(replied.statusCode, 201);
    const before = rt.published.length;

    assert.equal((await call(rt.app, HER, 'DELETE', `/media/${hersAttached}`)).statusCode, 204);
    await a.waitFor(() => ofThread(a, 'thread.changed', t).length === 1);
    await staff.waitFor(() => ofThread(staff, 'thread.changed', t).length === 1);
    assert.equal(
      (await call(rt.app, DONAVAN, 'DELETE', `/media/${staffAttached}`)).statusCode,
      204,
    );
    await a.waitFor(() => ofThread(a, 'thread.changed', t).length === 2);
    await staff.waitFor(() => ofThread(staff, 'thread.changed', t).length === 2);
    assert.equal((await call(rt.app, HER, 'DELETE', `/media/${loose}`)).statusCode, 204);
    await sleep(700);
    assert.deepEqual(
      rt.published.slice(before).map((p) => [p.event.kind, p.row.id, p.row.owner_id, p.only]),
      [
        ['thread.changed', t, A, undefined],
        ['thread.changed', t, A, undefined],
      ],
    );
  } finally {
    a.end();
    staff.end();
    await rt.close();
    await removeThreads([t]);
    await removePlantedMedia(media);
  }
});

test('B9: with the publisher forced to throw, her send still answers 201, the sockets are told `degraded`, `GET …?after_seq=` returns the message, and nothing escapes the process', async () => {
  const escaped: unknown[] = [];
  const onEscape = (err: unknown): void => void escaped.push(err);
  process.on('unhandledRejection', onEscape);
  process.on('uncaughtException', onEscape);
  const rt = await routeApp();
  const a = await socketFor(rt.url, HER);
  const staff = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  try {
    const last = await plantMessage(t, SCHOOL);
    rt.failPublishes.on = true;
    const res = await call(rt.app, HER, 'POST', `/threads/${t}/messages`, { text: text('b9') });
    assert.equal(res.statusCode, 201);
    await a.waitForType('degraded');
    await staff.waitForType('degraded');
    const got = await call(rt.app, HER, 'GET', `/threads/${t}/messages?after_seq=${last.seq}`);
    assert.equal(got.statusCode, 200);
    assert.deepEqual(
      got.json<Array<{ id: string }>>().map((m) => m.id),
      [res.json<{ id: string }>().id],
    );
    rt.failPublishes.on = false;
    await a.waitForType('live', 5_000);
    assert.deepEqual(escaped, []);
  } finally {
    process.off('unhandledRejection', onEscape);
    process.off('uncaughtException', onEscape);
    a.end();
    staff.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('B9 (the order): every message.created is published only after its transaction committed, so the row is already visible on another connection when the bus is called', async () => {
  const rt = await routeApp();
  const t = await plantThread(A);
  const probes: Array<Promise<number>> = [];
  const through = rt.hub.bus.publishForThread.bind(rt.hub.bus);
  rt.hub.bus.publishForThread = (row, event, only) => {
    if (event.kind === 'message.created') {
      probes.push(
        db
          .execute(sql`SELECT 1 FROM messages WHERE id = ${event.message_id}`)
          .then((r) => r.rows.length),
      );
    }
    through(row, event, only);
  };
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await call(rt.app, HER, 'POST', `/threads/${t}/messages`, { text: text('o') });
      assert.equal(res.statusCode, 201);
      const r = await call(rt.app, DONAVAN, 'POST', `/staff/threads/${t}/messages`, {
        text: text('r'),
      });
      assert.equal(r.statusCode, 201);
    }
    assert.deepEqual(
      await Promise.all(probes),
      Array.from({ length: 10 }, () => 1),
    );
  } finally {
    await rt.close();
    await removeThreads([t]);
  }
});

test('D2 (L4): her ack and her read on one thread, both waiting on a held thread-row lock on two real connections, both finish once it is released, with no deadlock', async () => {
  const rt = await routeApp({ startBus: false });
  const t = await plantThread(A);
  const holder = await pool.connect();
  let released = false;
  try {
    const ms = [await plantMessage(t, SCHOOL), await plantMessage(t, SCHOOL)];
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM threads WHERE id = $1 FOR UPDATE', [t]);
    const publisher = { publishForThread: () => undefined };
    const ack = deliveredAckSink(HER, t, 2, publisher);
    const read = call(rt.app, HER, 'POST', `/threads/${t}/read`, { up_to_seq: 2 });
    await waitForBlockedBackends(2);
    await holder.query('ROLLBACK');
    released = true;
    const [, res] = await Promise.all([ack, read]);
    assert.equal(res.statusCode, 204, res.body);
    const at = await deliveredAtOf(ms.map((m) => m.id));
    for (const m of ms) assert.ok(at.get(m.id) !== null);
  } finally {
    if (!released) await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await rt.close();
    await removeThreads([t]);
  }
});

test('MB46 ruling 3: an ack that stamps only messages already read sends no `delivered` receipt (a pre-9.2.0 read school message; a family message a staffer read); one that stamps an unread one sends it, up to that one', async () => {
  const rt = await routeApp();
  const a = await socketFor(rt.url, HER);
  const staff = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  try {
    const legacy = await plantMessage(t, SCHOOL, { readAt: '2026-05-01T10:00:00Z' });
    const hersRead = await plantMessage(t, HERS);
    await db.execute(
      sql`INSERT INTO message_staff_reads (message_id, staff_id) VALUES (${hersRead.id}, ${DONAVAN.id})`,
    );
    a.send({ type: 'ack', thread_id: t, up_to_seq: legacy.seq });
    staff.send({ type: 'ack', thread_id: t, up_to_seq: hersRead.seq });
    await sleep(1_300);
    const at = await deliveredAtOf([legacy.id, hersRead.id]);
    assert.ok(at.get(legacy.id) !== null, 'a read message was delivered: it is stamped');
    assert.ok(at.get(hersRead.id) !== null);
    assert.equal(ofThread(staff, 'receipt', t).length, 0, 'no delivered for a read message');
    assert.equal(ofThread(a, 'receipt', t).length, 0);

    const unread = await plantMessage(t, SCHOOL);
    await sleep(1_100); // past the coalescing second
    a.send({ type: 'ack', thread_id: t, up_to_seq: unread.seq });
    const receipt = await staff.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    assert.equal(receipt.state, 'delivered');
    assert.equal(receipt.up_to_seq, unread.seq);
  } finally {
    a.end();
    staff.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('MB53 (a): every call site publishes the committed row’s ids (the database’s lower-case uuid), never the request’s spelling: upper-case ids in the URL, in a body and in a principal still reach her and staff, and every publish row is lower-case', async () => {
  const rt = await routeApp();
  const a = await socketFor(rt.url, HER);
  const b = await socketFor(rt.url, B);
  const staff = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  const tB = await plantThread(OWNER_B.id);
  const T = t.toUpperCase();
  // A's id is all digits, so B (`b0b0…`) carries the principal case: the dev arm keeps its
  // spelling (the token arm's comes from the database).
  const B_UPPER: MirrorPrincipal = { kind: 'owner', id: OWNER_B.id.toUpperCase() };
  assert.notEqual(B_UPPER.id, OWNER_B.id);
  const started: string[] = [];
  try {
    const m = await plantMessage(t, HERS);
    const results = [
      await call(rt.app, HER, 'POST', `/threads/${T}/messages`, { text: text('upper send') }),
      await call(rt.app, B_UPPER, 'POST', `/threads/${tB}/messages`, { text: text('upper b') }),
      await call(rt.app, DONAVAN, 'POST', `/staff/threads/${T}/messages`, {
        text: text('upper reply'),
      }),
      await call(rt.app, DONAVAN, 'POST', `/staff/threads/${T}/read`, { message_ids: [m.id] }),
      await call(rt.app, HER, 'POST', `/threads/${T}/read`, {}),
      await call(rt.app, DONAVAN, 'POST', '/staff/threads', {
        owner_id: A.toUpperCase(),
        category: 'other',
        text: text('upper start'),
      }),
      await call(rt.app, B_UPPER, 'POST', '/threads', {
        category: 'enrollment',
        text: text('upper her start'),
      }),
    ];
    assert.deepEqual(
      results.map((r) => r.statusCode),
      [201, 201, 201, 204, 204, 201, 201],
    );
    const staffThread = results[5]!.json<{ thread: { id: string } }>().thread.id;
    const bThread = results[6]!.json<{ thread: { id: string } }>().thread.id;
    started.push(staffThread);
    await a.waitFor(() => ofThread(a, 'message.created', t).length === 2);
    await b.waitFor((f) => f.type === 'message.created' && f.thread_id === tB);
    await b.waitFor((f) => f.type === 'message.created' && f.thread_id === bThread);
    await a.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    await a.waitFor((f) => f.type === 'thread.changed' && f.thread_id === t);
    await a.waitFor((f) => f.type === 'message.created' && f.thread_id === staffThread);
    await staff.waitFor((f) => f.type === 'staff.read' && f.thread_id === t);
    await staff.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    assert.ok(rt.published.length >= 9);
    for (const { row } of rt.published) {
      assert.equal(row.id, row.id.toLowerCase(), `thread id as spelled: ${row.id}`);
      assert.ok(
        ([A, OWNER_B.id] as string[]).includes(row.owner_id),
        `owner id as spelled: ${row.owner_id}`,
      );
    }
    for (const f of [...a.frames, ...b.frames, ...staff.frames]) {
      if (typeof f.thread_id === 'string') assert.equal(f.thread_id, f.thread_id.toLowerCase());
    }
  } finally {
    for (const c of [a, b, staff]) c.end();
    await rt.close();
    await removeThreads([t, tB, ...started]);
    await removeSchoolThreads(OWNER_B.id);
  }
});

test('MB53 (b): ruling 3’s `up_to_seq` is the highest seq stamped among the messages NOT already read, never the highest stamped overall', async () => {
  const rt = await routeApp();
  const a = await socketFor(rt.url, HER);
  const staff = await socketFor(rt.url, DONAVAN);
  const t = await plantThread(A);
  try {
    const unread = await plantMessage(t, SCHOOL);
    const legacy = await plantMessage(t, SCHOOL, { readAt: '2026-05-01T10:00:00Z' });
    a.send({ type: 'ack', thread_id: t, up_to_seq: legacy.seq });
    const receipt = await staff.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    const at = await deliveredAtOf([unread.id, legacy.id]);
    assert.ok(at.get(unread.id) !== null && at.get(legacy.id) !== null, 'both stamped');
    assert.equal(receipt.up_to_seq, unread.seq, 'the read message bounds nothing');
  } finally {
    a.end();
    staff.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('B15: her message.created.message deep-equals her own GET element for a staff reply with an attachment (R2 stub), and the staff frame the staff GET element; neither carries `reach`', async () => {
  const rt = await routeApp();
  const a = await socketFor(rt.url, HER);
  const staff = await socketFor(rt.url, AMBER);
  const t = await plantThread(A);
  const media = [await plantStaffMedia(A)];
  try {
    const replied = await call(rt.app, DONAVAN, 'POST', `/staff/threads/${t}/messages`, {
      text: text('with a photo'),
      attachment_media_ids: media,
      client_message_id: randomUUID(),
    });
    assert.equal(replied.statusCode, 201);
    const id = replied.json<{ id: string; reach?: unknown }>().id;
    assert.ok(replied.json<{ reach?: unknown }>().reach !== undefined, 'the 201 carries reach');
    const hers = await a.waitFor((f) => f.type === 'message.created' && f.thread_id === t);
    const theirs = await staff.waitFor((f) => f.type === 'message.created' && f.thread_id === t);
    const herGet = (await call(rt.app, HER, 'GET', `/threads/${t}/messages`)).json<Frame[]>();
    const staffGet = (await call(rt.app, AMBER, 'GET', `/staff/threads/${t}/messages`)).json<
      Frame[]
    >();
    assert.deepEqual(
      hers.message,
      herGet.find((m) => m.id === id),
    );
    assert.deepEqual(
      theirs.message,
      staffGet.find((m) => m.id === id),
    );
    for (const m of [hers.message as Frame, theirs.message as Frame]) {
      assert.equal('reach' in m, false);
      assert.equal((m.attachments as unknown[]).length, 1);
    }
    assert.notDeepEqual(hers.message, theirs.message, 'each built for its own audience');
  } finally {
    a.end();
    staff.end();
    await rt.close();
    await removeThreads([t]);
    await removePlantedMedia(media);
  }
});

test('shape pin (item 5): on buildApp(), one owner send gives exactly one bus publish, a message.created on her thread’s row (a spy on the real bus)', async () => {
  const { buildApp } = await import('../../src/server.js');
  const app = buildApp();
  const t = await plantThread(A);
  try {
    const published: PublishedEvent[] = [];
    const through = app.realtime.bus.publishForThread.bind(app.realtime.bus);
    app.realtime.bus.publishForThread = (row, event, only) => {
      published.push({ row, event, only });
      through(row, event, only);
    };
    const res = await call(app, HER, 'POST', `/threads/${t}/messages`, { text: text('pin') });
    assert.equal(res.statusCode, 201, res.body);
    const sent = res.json<{ id: string; seq: number }>();
    assert.deepEqual(published, [
      {
        row: { id: t, owner_id: A },
        event: { kind: 'message.created', message_id: sent.id, seq: sent.seq },
        only: undefined,
      },
    ]);
    assert.equal(app.realtime.buildsMessageFrames, true, 'the element builder is wired');
  } finally {
    await app.close();
    await removeThreads([t]);
  }
});

test('B15 (the bus spy, over every publish in this file): no payload carries a message text, a name or a URL: ids, integers and one instant only', () => {
  assert.ok(everyPublish.length >= 20, `only ${everyPublish.length} publishes were seen`);
  for (const { row, event } of everyPublish) {
    const payload = JSON.stringify({ row, event });
    for (const t of sentTexts) assert.ok(!payload.includes(t), `text on the bus: ${payload}`);
    for (const name of ['Donavan', 'Amber', 'NWA School', 'Hendersons']) {
      assert.ok(!payload.includes(name), `a name on the bus: ${payload}`);
    }
    assert.ok(!/https?:|stub\.r2|object_key|message-attachment\//.test(payload), payload);
    for (const [key, value] of Object.entries(event)) {
      if (key === 'kind' || key === 'state' || key === 'side' || key === 'from') continue;
      const ok =
        typeof value === 'number' ||
        (typeof value === 'string' &&
          (/^[0-9a-f-]{36}$/.test(value) || !Number.isNaN(Date.parse(value)))) ||
        (Array.isArray(value) && value.every((v) => /^[0-9a-f-]{36}$/.test(String(v))));
      assert.ok(ok, `${key} is not an id, an integer or an instant: ${payload}`);
    }
  }
});
