import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { sql } from 'drizzle-orm';
import {
  OWNER_B,
  authFrame,
  connect,
  dbNowMs,
  deliveredAtOf,
  devAuthFrame,
  pagerLines,
  plantMessage,
  plantThread,
  removeOwnerB,
  removeThreads,
  seedOwnerB,
  signToken,
  sleep,
  startRealtimeApp,
  waitUntil,
  type RtClient,
} from './_realtime.js';
import { FIXTURE_IDS } from './_fixture.js';
import { registerFixtureHooks } from './_harness.js';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';

/**
 * Pass 3 phase R, item 3: *Delivered* behind `onAck` (design "Receipts" `:238-245`;
 * `MessageReceiptState`; the `ack` doc; brief B2, D1, L4). The sink is the real one
 * (`src/realtime/delivered.ts`), imported where each test needs it. The last test runs on
 * `buildApp()`, the serving shape, never a bare registration (memory "prove the alarm channel").
 */

registerFixtureHooks();
before(seedOwnerB);
after(removeOwnerB);

const A = FIXTURE_IDS.ownerId;
const A_UID = FIXTURE_IDS.ownerSupabaseUid;
const DONAVAN = FIXTURE_IDS.staffDonavanId;
const DONAVAN_UID = FIXTURE_IDS.staffDonavanSupabaseUid;
const AMBER_UID = FIXTURE_IDS.staffAmberSupabaseUid;
const HER = { kind: 'owner', id: A } as const;
const SCHOOL = { kind: 'staff', id: DONAVAN } as const;
const EARLIER = '2026-01-02T03:04:05.678Z';

async function authed(url: string, uid: string): Promise<RtClient> {
  const token = await signToken(uid);
  const client = await connect(url, (c) => c.send(authFrame(token)));
  await client.waitForType('ready');
  return client;
}

async function sinkModule() {
  return import('../../src/realtime/delivered.js');
}

interface Published {
  row: { id: string; owner_id: string };
  event: Record<string, unknown>;
}

function recordingPublisher(): { published: Published[]; publishForThread: never } {
  const published: Published[] = [];
  return {
    published,
    publishForThread: ((row: Published['row'], event: Published['event']) => {
      published.push({ row, event });
    }) as never,
  };
}

test("D1: her ack up to 6 stamps the school's live messages <= 6 that are still NULL with the database clock (an earlier stamp keeps its instant), never hers; staff get one receipt `delivered`, she gets none", async () => {
  const { deliveredAckSink } = await sinkModule();
  const rt = await startRealtimeApp({ startBus: true, onAck: deliveredAckSink });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  try {
    const m1 = await plantMessage(t, HER);
    const m2 = await plantMessage(t, SCHOOL);
    const m3 = await plantMessage(t, SCHOOL, { deliveredAt: EARLIER });
    const m4 = await plantMessage(t, HER);
    const m5 = await plantMessage(t, SCHOOL, { expired: true });
    const m6 = await plantMessage(t, SCHOOL);
    const m7 = await plantMessage(t, SCHOOL);
    assert.deepEqual(
      [m1, m2, m3, m4, m5, m6, m7].map((m) => m.seq),
      [1, 2, 3, 4, 5, 6, 7],
    );
    const lo = await dbNowMs();
    a.send({ type: 'ack', thread_id: t, up_to_seq: 6 });
    const receipt = await donavan.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    const hi = await dbNowMs();
    const at = await deliveredAtOf([m1, m2, m3, m4, m5, m6, m7].map((m) => m.id));
    assert.ok(at.get(m2.id) !== null && at.get(m2.id) === at.get(m6.id), 'one instant');
    assert.equal(at.get(m3.id), EARLIER, 'an earlier stamp keeps its instant');
    for (const m of [m1, m4]) assert.equal(at.get(m.id), null, 'never her own messages');
    assert.equal(at.get(m5.id), null, 'live messages only');
    assert.equal(at.get(m7.id), null, 'nothing above up_to_seq');
    assert.deepEqual(receipt, {
      type: 'receipt',
      thread_id: t,
      state: 'delivered',
      up_to_seq: 6,
      at: at.get(m6.id),
    });
    const stamped = Date.parse(receipt.at as string);
    assert.ok(stamped >= lo - 1 && stamped <= hi + 1, 'the database clock, inside the window');
    await sleep(600);
    assert.equal(donavan.ofType('receipt').length, 1, 'one receipt');
    assert.equal(a.ofType('receipt').length, 0, 'the school’s receipt is never sent to her');
    assert.deepEqual(pagerLines(rt.logs), []);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test('D1: an ack that moves nothing sends nothing (and stamps nothing); an ack that moves a row in another thread still sends its one', async () => {
  const { deliveredAckSink } = await sinkModule();
  const rt = await startRealtimeApp({ startBus: true, onAck: deliveredAckSink });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const still = await plantThread(A);
  const moves = await plantThread(A);
  try {
    await plantMessage(still, HER);
    const stamped = await plantMessage(still, SCHOOL, { deliveredAt: EARLIER });
    a.send({ type: 'ack', thread_id: still, up_to_seq: 2 });
    await sleep(1_200);
    assert.equal(donavan.ofType('receipt').length, 0);
    assert.equal(a.ofType('receipt').length, 0);
    assert.equal((await deliveredAtOf([stamped.id])).get(stamped.id), EARLIER);

    const fresh = await plantMessage(moves, SCHOOL);
    a.send({ type: 'ack', thread_id: moves, up_to_seq: fresh.seq });
    const receipt = await donavan.waitForType('receipt');
    assert.equal(receipt.thread_id, moves);
    assert.equal(receipt.up_to_seq, 1);
  } finally {
    a.end();
    donavan.end();
    await rt.close();
    await removeThreads([still, moves]);
  }
});

test("D1: a staffer's ack stamps the family's live messages <= N, never the school's; the family's socket gets one receipt `delivered`, staff get none", async () => {
  const { deliveredAckSink } = await sinkModule();
  const rt = await startRealtimeApp({ startBus: true, onAck: deliveredAckSink });
  const a = await authed(rt.url, A_UID);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const amber = await authed(rt.url, AMBER_UID);
  const t = await plantThread(A);
  try {
    const m1 = await plantMessage(t, HER);
    const m2 = await plantMessage(t, SCHOOL);
    const m3 = await plantMessage(t, HER);
    const m4 = await plantMessage(t, HER);
    donavan.send({ type: 'ack', thread_id: t, up_to_seq: 3 });
    const receipt = await a.waitFor((f) => f.type === 'receipt' && f.thread_id === t);
    const at = await deliveredAtOf([m1, m2, m3, m4].map((m) => m.id));
    assert.ok(at.get(m1.id) !== null && at.get(m1.id) === at.get(m3.id));
    assert.equal(at.get(m2.id), null, "never the school's own");
    assert.equal(at.get(m4.id), null);
    assert.deepEqual(receipt, {
      type: 'receipt',
      thread_id: t,
      state: 'delivered',
      up_to_seq: 3,
      at: at.get(m3.id),
    });
    await sleep(600);
    assert.equal(a.ofType('receipt').length, 1);
    assert.equal(donavan.ofType('receipt').length, 0, 'her receipt is never sent to staff');
    assert.equal(amber.ofType('receipt').length, 0);
  } finally {
    for (const c of [a, donavan, amber]) c.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test("B2: B's ack naming A's thread, on the real sink, leaves every delivered_at of A's NULL and sends no receipt", async () => {
  const { deliveredAckSink } = await sinkModule();
  const rt = await startRealtimeApp({ startBus: true, onAck: deliveredAckSink });
  const a = await authed(rt.url, A_UID);
  const b = await authed(rt.url, OWNER_B.supabaseUid);
  const donavan = await authed(rt.url, DONAVAN_UID);
  const t = await plantThread(A);
  try {
    const ms = [await plantMessage(t, SCHOOL), await plantMessage(t, SCHOOL)];
    b.send({ type: 'ack', thread_id: t, up_to_seq: 2 });
    await sleep(1_500);
    const at = await deliveredAtOf(ms.map((m) => m.id));
    for (const m of ms) assert.equal(at.get(m.id), null);
    for (const c of [a, b, donavan]) assert.equal(c.ofType('receipt').length, 0);
  } finally {
    for (const c of [a, b, donavan]) c.end();
    await rt.close();
    await removeThreads([t]);
  }
});

test("B2 (the stamp's own check): the sink, handed B's principal and A's thread, stamps nothing and publishes nothing; handed hers, it stamps and publishes one receipt", async () => {
  const { deliveredAckSink } = await sinkModule();
  const t = await plantThread(A);
  try {
    const ms = [await plantMessage(t, SCHOOL), await plantMessage(t, SCHOOL)];
    const forB = recordingPublisher();
    await deliveredAckSink({ kind: 'owner', id: OWNER_B.id }, t, 2, forB);
    const at = await deliveredAtOf(ms.map((m) => m.id));
    for (const m of ms) assert.equal(at.get(m.id), null);
    assert.deepEqual(forB.published, []);

    const forA = recordingPublisher();
    await deliveredAckSink({ kind: 'owner', id: A }, t, 2, forA);
    const after = await deliveredAtOf(ms.map((m) => m.id));
    assert.ok(after.get(ms[1]!.id) !== null);
    assert.deepEqual(forA.published, [
      {
        row: { id: t, owner_id: A },
        event: {
          kind: 'receipt',
          side: 'staff',
          state: 'delivered',
          up_to_seq: 2,
          at: after.get(ms[1]!.id),
        },
      },
    ]);
  } finally {
    await removeThreads([t]);
  }
});

test("the stamp runs under withActor with the acker's actor, as the routes form it: each stamped message's one audit row names `owner:<her id>` or `staff:<the staffer's id>`", async () => {
  const { deliveredAckSink } = await sinkModule();
  const t = await plantThread(A);
  try {
    const school = [await plantMessage(t, SCHOOL), await plantMessage(t, SCHOOL)];
    const hers = await plantMessage(t, HER);
    await deliveredAckSink({ kind: 'owner', id: A }, t, 2, recordingPublisher());
    await deliveredAckSink(
      { kind: 'staff', id: DONAVAN, role: 'trainer' },
      t,
      3,
      recordingPublisher(),
    );
    const ids = [...school, hers].map((m) => m.id);
    const result = await db.execute(sql`
      SELECT row_pk, actor FROM audit_log
       WHERE table_name = 'messages' AND op = 'UPDATE' AND row_pk = ANY(${sql.param(ids)}::text[])
       ORDER BY row_pk`);
    const rows = result.rows as Array<{ row_pk: string; actor: string | null }>;
    assert.deepEqual(
      rows.map((r) => [r.row_pk, r.actor]).sort(),
      [
        [school[0]!.id, `owner:${A}`],
        [school[1]!.id, `owner:${A}`],
        [hers.id, `staff:${DONAVAN}`],
      ].sort(),
    );
  } finally {
    await removeThreads([t]);
  }
});

test('L4: the stamp locks the thread row FIRST: while another connection holds that row it waits having touched no message, then finishes once released', async () => {
  const { deliveredAckSink } = await sinkModule();
  const t = await plantThread(A);
  const holder = await pool.connect();
  let released = false;
  try {
    const m = await plantMessage(t, SCHOOL);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM threads WHERE id = $1 FOR UPDATE', [t]);
    let finished = false;
    const done = deliveredAckSink({ kind: 'owner', id: A }, t, 1, recordingPublisher()).then(() => {
      finished = true;
    });
    await sleep(500);
    assert.equal(finished, false, 'it waits on the thread row');
    // Nothing of the thread's messages is held yet: the lock came first.
    await holder.query("SET LOCAL lock_timeout = '200ms'");
    await holder.query('SELECT 1 FROM messages WHERE thread_id = $1 FOR UPDATE NOWAIT', [t]);
    await holder.query('ROLLBACK');
    released = true;
    await done;
    assert.ok((await deliveredAtOf([m.id])).get(m.id) !== null);
  } finally {
    if (!released) await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await removeThreads([t]);
  }
});

test("onAck on the serving shape: buildApp() wires the real Delivered sink, so her ack on buildApp()'s own socket stamps the school's message and staff hear its receipt", async () => {
  const { buildApp } = await import('../../src/server.js');
  const app = buildApp();
  const t = await plantThread(A);
  const clients: RtClient[] = [];
  try {
    const m = await plantMessage(t, SCHOOL);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    app.realtime.startBus();
    await waitUntil(
      () => (app.realtime.busState() === 'live' ? true : undefined),
      5_000,
      "buildApp()'s bus to go live",
    );
    const url = `ws://127.0.0.1:${address.port}/realtime`;
    const her = await connect(url, (c) => c.send(devAuthFrame(`owner:${A}`)));
    clients.push(her);
    await her.waitForType('ready');
    const staff = await connect(url, (c) => c.send(devAuthFrame(`staff:${DONAVAN}:trainer`)));
    clients.push(staff);
    await staff.waitForType('ready');
    her.send({ type: 'ack', thread_id: t, up_to_seq: m.seq });
    const receipt = await staff.waitFor((f) => f.type === 'receipt' && f.thread_id === t, 5_000);
    const at = (await deliveredAtOf([m.id])).get(m.id);
    assert.ok(at !== null && at !== undefined, 'the row is stamped');
    assert.equal(receipt.at, at);
    assert.equal(receipt.state, 'delivered');
  } finally {
    for (const c of clients) c.end();
    await app.close();
    await removeThreads([t]);
  }
});
