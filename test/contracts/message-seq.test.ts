import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import { messages, threads } from '../../src/db/schema/schema.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import {
  getJson,
  ownerApp,
  ownerSend,
  removeSchoolThreads,
  staffApp,
  startThread,
} from './_messaging.js';

/**
 * W1 (wire 9.2.0 `MessageWire.seq`, `ThreadWire.last_seq`; design messaging-live-v1 §4 W1,
 * M1; rs3 M5.29; contract-notes mechanic 16): a message's number in its thread, from 1,
 * strictly increasing in COMMIT order, assigned by the trigger under the thread's row lock.
 * Both message lists are in `seq` order. B7's `seq` half (concurrent sends follow commit order;
 * an expired message keeps its number; a seed-shaped insert gets one), FL8/LR12 (one send
 * writes exactly two `threads` audit rows) and B14's schema.sql half.
 */

registerFixtureHooks();
const made: string[] = [];
afterEach(async () => {
  await removeSchoolThreads();
  for (const id of made.splice(0)) await db.execute(sql`DELETE FROM threads WHERE id = ${id}`);
});

type Msg = { id: string; seq: number; sent_at: string; text: string };

/** A fresh trainer thread for the fixture family (Donavan), removed after the test. */
async function freshThread(): Promise<string> {
  const id = randomUUID();
  made.push(id);
  await db.insert(threads).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    participantStaffId: FIXTURE_IDS.staffDonavanId,
    category: 'other',
    title: 'seq probe',
    subText: '',
  });
  return id;
}

describe('W1: seq and last_seq', () => {
  test(
    'the fixture’s messages carry seq 1..n per thread, and GET /threads and GET /threads/:id carry last_seq',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = ownerApp();
      const one = await getJson<Msg[]>(app, `/threads/${FIXTURE_IDS.thread1Id}/messages`);
      assert.deepEqual(
        one.map((m) => m.seq),
        [1, 2, 3, 4, 5],
      );
      const two = await getJson<Msg[]>(app, `/threads/${FIXTURE_IDS.thread2Id}/messages`);
      assert.deepEqual(
        two.map((m) => m.seq),
        [1, 2],
      );
      const list = await getJson<Array<{ id: string; last_seq: number }>>(app, '/threads');
      assert.deepEqual(Object.fromEntries(list.map((t) => [t.id, t.last_seq])), {
        [FIXTURE_IDS.thread1Id]: 5,
        [FIXTURE_IDS.thread2Id]: 2,
      });
      const thread = await getJson<{ last_seq: number }>(app, `/threads/${FIXTURE_IDS.thread1Id}`);
      assert.equal(thread.last_seq, 5);
      const staffList = await getJson<Array<{ id: string; last_seq: number }>>(
        staffApp(),
        '/staff/threads',
      );
      assert.equal(staffList.find((t) => t.id === FIXTURE_IDS.thread1Id)?.last_seq, 5);
    },
  );

  test(
    'B7: concurrent sends follow COMMIT order, and both lists are in seq order, not sent_at order',
    SKIP_WHEN_NO_DB,
    async () => {
      const threadId = await freshThread();
      const early = new pg.Client({ connectionString: process.env.DATABASE_URL });
      const late = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await early.connect();
      await late.connect();
      try {
        // `early` opens its transaction first, so its `sent_at` (the transaction's start) is
        // earlier, but it commits second.
        await early.query('BEGIN');
        await early.query('SELECT now()');
        await new Promise((resolve) => setTimeout(resolve, 30));
        await late.query('BEGIN');
        await late.query(
          `INSERT INTO messages (thread_id, sender_kind, sender_owner_id, text)
         VALUES ($1, 'owner', $2, 'committed first')`,
          [threadId, FIXTURE_IDS.ownerId],
        );
        await late.query('COMMIT');
        await early.query(
          `INSERT INTO messages (thread_id, sender_kind, sender_staff_id, text)
         VALUES ($1, 'staff', $2, 'committed second')`,
          [threadId, FIXTURE_IDS.staffDonavanId],
        );
        await early.query('COMMIT');
      } finally {
        await early.query('ROLLBACK').catch(() => undefined);
        await early.end();
        await late.end();
      }
      for (const [app, url] of [
        [ownerApp(), `/threads/${threadId}/messages`],
        [staffApp(), `/staff/threads/${threadId}/messages`],
      ] as const) {
        const list = await getJson<Msg[]>(app, url);
        assert.deepEqual(
          list.map((m) => [m.text, m.seq]),
          [
            ['committed first', 1],
            ['committed second', 2],
          ],
          url,
        );
        const [first, second] = list;
        assert.ok(
          (second?.sent_at ?? '') < (first?.sent_at ?? ''),
          'precondition: the second-committed message started first',
        );
      }
    },
  );

  test(
    'B7: an expired message keeps its number — 4 live, 5 expired, 6 new: the list reads 1–4 then 6, last_seq 6; a seed-shaped insert gets its seq',
    SKIP_WHEN_NO_DB,
    async () => {
      const threadId = await freshThread();
      // seed-dev.ts's shape: `db.insert(messages).values(...)`, naming no seq.
      const inserted = await db
        .insert(messages)
        .values(
          [1, 2, 3, 4, 5].map((n) => ({
            threadId,
            senderKind: 'owner' as const,
            senderOwnerId: FIXTURE_IDS.ownerId,
            text: `seeded ${n}`,
          })),
        )
        .returning({ id: messages.id, threadSeq: messages.threadSeq });
      assert.deepEqual(
        inserted.map((r) => r.threadSeq),
        [1, 2, 3, 4, 5],
      );
      await db.execute(sql`UPDATE messages SET expired_at = now() WHERE id = ${inserted[4]?.id}`);
      const app = ownerApp();
      const sent = await ownerSend(app, threadId, { text: 'the sixth' });
      assert.equal(sent.statusCode, 201, sent.body);
      assert.equal((sent.json() as Msg).seq, 6);
      const list = await getJson<Msg[]>(app, `/threads/${threadId}/messages`);
      assert.deepEqual(
        list.map((m) => m.seq),
        [1, 2, 3, 4, 6],
      );
      const thread = await getJson<{ last_seq: number }>(app, `/threads/${threadId}`);
      assert.equal(thread.last_seq, 6);
    },
  );

  test(
    'FL8/LR12: one send writes exactly two threads audit rows (the trigger’s last_seq bump and the preview bump), under the sender’s actor; POST /threads too',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = ownerApp();
      const auditRows = async (threadId: string) =>
        (
          await db.execute<{ actor: string | null }>(
            sql`SELECT actor FROM audit_log WHERE table_name = 'threads' AND row_pk = ${threadId} ORDER BY id`,
          )
        ).rows;
      const before = (await auditRows(FIXTURE_IDS.thread2Id)).length;
      const sent = await ownerSend(app, FIXTURE_IDS.thread2Id, { text: 'audit me' });
      assert.equal(sent.statusCode, 201, sent.body);
      const after = await auditRows(FIXTURE_IDS.thread2Id);
      assert.equal(after.length - before, 2, 'one send must write exactly two threads audit rows');
      assert.deepEqual(
        after.slice(before).map((r) => r.actor),
        [`owner:${FIXTURE_IDS.ownerId}`, `owner:${FIXTURE_IDS.ownerId}`],
      );
      await db.execute(sql`DELETE FROM messages WHERE id = ${(sent.json() as Msg).id}`);

      const first = await startThread(app, {
        category: 'sessions',
        subtopic: 'One',
        text: 'start',
      });
      const threadId = (first.json() as { thread: { id: string } }).thread.id;
      assert.equal((await auditRows(threadId)).length, 2, 'a new school thread’s first send');
      const second = await startThread(app, {
        category: 'sessions',
        subtopic: 'Two',
        text: 'more',
      });
      assert.equal(second.statusCode, 201, second.body);
      assert.equal(
        (await auditRows(threadId)).length,
        4,
        'a continued start (a new sub-topic included) must write exactly two more',
      );
    },
  );

  test(
    'B14 (schema.sql half): on the suite database an UPDATE that changes threads.owner_id raises',
    SKIP_WHEN_NO_DB,
    async () => {
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query('BEGIN');
        // The BEFORE trigger runs before the foreign key is checked, so a made-up owner id is
        // refused by the trigger (and, without it, by the foreign key: a different error).
        await assert.rejects(
          client.query('UPDATE threads SET owner_id = gen_random_uuid() WHERE id = $1', [
            FIXTURE_IDS.thread1Id,
          ]),
          (err: { message?: string; code?: string }) =>
            /owner_id never changes/.test(err.message ?? '') && err.code === '23001',
        );
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    },
  );
});
