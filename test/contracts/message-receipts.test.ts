import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeLogCapture,
  registerFixtureHooks,
  type LogCapture,
} from './_harness.js';
import {
  getJson,
  messageRows,
  ownerApp,
  ownerRead,
  ownerSend,
  removeMessagesExcept,
  staffApp,
  staffRead,
  staffReply,
} from './_messaging.js';
import { waitForBlockedBackends } from './_poolFixture.js';
import { makeR2Stub } from './_r2Stub.js';

/**
 * Receipts and reads (wire 9.2.0; design §4 W3–W5, B10; contract-notes mechanics 9, 10, 15–17;
 * brief CR4, CR34; L4):
 *   · `MessageWire.receipt` rides only the reader's OWN side's messages: hers on her routes, the
 *     school's (every staffer's) on the staff routes. `sent` at `sent_at`, `delivered` at the first
 *     delivery, `read` at the first read: on a family's message the EARLIEST staffer's read, on
 *     the school's her own read.
 *   · `?after_seq=` on both lists returns the messages above it; out of range, a fraction or not
 *     a number is 400, logged below the pager's level (M1-a: never Postgres' 22003, a 500).
 *   · `POST /threads/:id/read {up_to_seq?}`: absent and `{}` read every unread school message, as
 *     before; with `up_to_seq` only the school's messages at or below it, so one committed after
 *     her GET stays unread (B10). Reads stamp *Delivered*. `.strict()`. The key's hash covers
 *     `up_to_seq` (B10c). The thread row is locked first (L4).
 */

registerFixtureHooks();

const T1 = FIXTURE_IDS.thread1Id;
const FIXTURE_T1 = [
  FIXTURE_IDS.message1Id,
  FIXTURE_IDS.message2Id,
  FIXTURE_IDS.message3Id,
  FIXTURE_IDS.message4Id,
  FIXTURE_IDS.message5Id,
];

afterEach(async () => {
  await removeMessagesExcept(T1, FIXTURE_T1);
  await db.execute(
    sql`DELETE FROM message_staff_reads WHERE message_id = ANY(${sql.param(FIXTURE_T1)}::uuid[])`,
  );
  // Put the fixture's read state back: messages 4 and 5 unread, nothing delivered.
  await db.execute(sql`
    UPDATE messages SET read_at = NULL, delivered_at = NULL
     WHERE id IN (${FIXTURE_IDS.message4Id}, ${FIXTURE_IDS.message5Id})`);
  await db.execute(sql`UPDATE messages SET delivered_at = NULL WHERE thread_id = ${T1}`);
});

type Receipt = { state: 'sent' | 'delivered' | 'read'; at: string };
type Msg = {
  id: string;
  sender_id: string;
  seq: number;
  sent_at: string;
  is_read: boolean;
  receipt?: Receipt;
};

async function rowTimes(
  id: string,
): Promise<{ sent_at: string; read_at: string | null; delivered_at: string | null }> {
  const { rows } = await db.execute<{
    sent_at: string;
    read_at: string | null;
    delivered_at: string | null;
  }>(sql`
    SELECT to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sent_at,
           to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read_at,
           to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS delivered_at
      FROM messages WHERE id = ${id}`);
  const row = rows[0];
  if (row === undefined) throw new Error(`message ${id} not found`);
  return row;
}

async function staffReadAt(messageId: string, staffId: string): Promise<string> {
  const { rows } = await db.execute<{ at: string }>(sql`
    SELECT to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
      FROM message_staff_reads WHERE message_id = ${messageId} AND staff_id = ${staffId}`);
  const row = rows[0];
  if (row === undefined) throw new Error(`no read row for ${messageId} by ${staffId}`);
  return row.at;
}

function pagerLines(capture: LogCapture): Array<Record<string, unknown>> {
  return capture.lines.filter(
    (l) => typeof l['level'] === 'number' && (l['level'] as number) >= 50,
  );
}

describe('receipts ride the reader’s own side only', () => {
  test(
    'mechanic 10: on her routes only her messages carry a receipt; on the staff routes only the school’s',
    SKIP_WHEN_NO_DB,
    async () => {
      const mine = await getJson<Msg[]>(ownerApp(), `/threads/${T1}/messages`);
      for (const m of mine) {
        if (m.sender_id === FIXTURE_IDS.ownerId) {
          assert.deepEqual(m.receipt, { state: 'sent', at: m.sent_at }, `her message ${m.id}`);
        } else {
          assert.equal(
            'receipt' in m,
            false,
            `the school's message ${m.id} carries no receipt for her`,
          );
        }
      }
      const school = await getJson<Msg[]>(staffApp(), `/staff/threads/${T1}/messages`);
      for (const m of school) {
        if (m.sender_id === FIXTURE_IDS.ownerId) {
          assert.equal('receipt' in m, false, `her message ${m.id} carries no receipt for staff`);
        }
      }
      // The fixture's message 2 was read by her at 13:15; 4 and 5 are unread.
      const byId = new Map(school.map((m) => [m.id, m] as const));
      assert.deepEqual(byId.get(FIXTURE_IDS.message2Id)?.receipt, {
        state: 'read',
        at: '2026-05-19T13:15:00.000Z',
      });
      assert.equal(byId.get(FIXTURE_IDS.message4Id)?.receipt?.state, 'sent');
      assert.equal(byId.get(FIXTURE_IDS.message5Id)?.receipt?.state, 'sent');
    },
  );

  test(
    'mechanic 9: her message reads Sent, then Delivered at the first delivery, then Read at the staffer’s read',
    SKIP_WHEN_NO_DB,
    async () => {
      const sent = await ownerSend(ownerApp(), T1, { text: 'Is Friday still on?' });
      assert.equal(sent.statusCode, 201, sent.body);
      const msg = sent.json() as Msg;
      assert.deepEqual(msg.receipt, { state: 'sent', at: msg.sent_at }, 'the 201 carries it too');

      // An open portal acked it (pass 3's `ack` writes this column; the instant is the step's).
      await db.execute(sql`UPDATE messages SET delivered_at = now() WHERE id = ${msg.id}`);
      const delivered = (await rowTimes(msg.id)).delivered_at;
      const afterAck = (await getJson<Msg[]>(ownerApp(), `/threads/${T1}/messages`)).find(
        (m) => m.id === msg.id,
      );
      assert.deepEqual(afterAck?.receipt, { state: 'delivered', at: delivered });

      const read = await staffRead(staffApp(FIXTURE_MANAGER_PRINCIPAL), T1, [msg.id]);
      assert.equal(read.statusCode, 204, read.body);
      const at = await staffReadAt(msg.id, FIXTURE_IDS.staffAmberId);
      const afterRead = (await getJson<Msg[]>(ownerApp(), `/threads/${T1}/messages`)).find(
        (m) => m.id === msg.id,
      );
      assert.deepEqual(afterRead?.receipt, { state: 'read', at });
    },
  );

  test(
    'the school’s message reads Sent, then Read at her read; her read stamps Delivered at the same instant (B10)',
    SKIP_WHEN_NO_DB,
    async () => {
      const reply = await staffReply(staffApp(), T1, { text: 'Bring her flat collar.' });
      assert.equal(reply.statusCode, 201, reply.body);
      const msg = reply.json() as Msg;
      assert.deepEqual(msg.receipt, { state: 'sent', at: msg.sent_at });

      const read = await ownerRead(ownerApp(), T1);
      assert.equal(read.statusCode, 204, read.body);
      const times = await rowTimes(msg.id);
      assert.ok(times.read_at !== null, 'read');
      assert.equal(times.delivered_at, times.read_at, 'her read stamps Delivered too');
      const seen = (await getJson<Msg[]>(staffApp(), `/staff/threads/${T1}/messages`)).find(
        (m) => m.id === msg.id,
      );
      assert.deepEqual(seen?.receipt, { state: 'read', at: times.read_at });
    },
  );
});

describe('?after_seq= on both lists (W4) and its bound (M1-a)', () => {
  test(
    'after_seq returns only the messages above it, on her list and on the staff list',
    SKIP_WHEN_NO_DB,
    async () => {
      for (const [app, base] of [
        [ownerApp(), `/threads/${T1}/messages`],
        [staffApp(), `/staff/threads/${T1}/messages`],
      ] as const) {
        assert.deepEqual(
          (await getJson<Msg[]>(app, `${base}?after_seq=3`)).map((m) => m.seq),
          [4, 5],
        );
        assert.deepEqual(
          (await getJson<Msg[]>(app, `${base}?after_seq=0`)).map((m) => m.seq),
          [1, 2, 3, 4, 5],
        );
        assert.deepEqual(await getJson<Msg[]>(app, `${base}?after_seq=5`), []);
      }
    },
  );

  test(
    'M1-a: after_seq past MAX_MESSAGE_SEQ, negative, a fraction, 1e10 or not a number is 400 on both lists, and nothing logs at level 50 or above',
    SKIP_WHEN_NO_DB,
    async () => {
      const capture = makeLogCapture();
      const owner = ownerApp(undefined, makeR2Stub(), capture);
      const staff = staffApp(undefined, makeR2Stub(), undefined, capture);
      for (const bad of ['2147483648', '-1', '1.5', '1e10', 'abc']) {
        for (const [app, url] of [
          [owner, `/threads/${T1}/messages?after_seq=${bad}`],
          [staff, `/staff/threads/${T1}/messages?after_seq=${bad}`],
        ] as const) {
          const res = await app.inject({ method: 'GET', url });
          assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
          assert.equal(res.json().error.code, 'bad_request');
        }
      }
      const max = await owner.inject({
        method: 'GET',
        url: `/threads/${T1}/messages?after_seq=2147483647`,
      });
      assert.equal(max.statusCode, 200, max.body);
      assert.deepEqual(pagerLines(capture), [], 'a line reached the pager');
    },
  );
});

describe('POST /threads/:id/read {up_to_seq?} (W5)', () => {
  test(
    'B10: up_to_seq never marks a message committed after her GET; it stamps Delivered only on what it read',
    SKIP_WHEN_NO_DB,
    async () => {
      const owner = ownerApp();
      const before = await getJson<Msg[]>(owner, `/threads/${T1}/messages`);
      const rendered = Math.max(...before.map((m) => m.seq));
      const late = await staffReply(staffApp(), T1, { text: 'One more thing.' });
      assert.equal(late.statusCode, 201, late.body);
      const lateMsg = late.json() as Msg;
      assert.ok(lateMsg.seq > rendered);

      const read = await ownerRead(owner, T1, { up_to_seq: rendered });
      assert.equal(read.statusCode, 204, read.body);
      const lateTimes = await rowTimes(lateMsg.id);
      assert.equal(lateTimes.read_at, null, 'the later message stays unread');
      assert.equal(lateTimes.delivered_at, null, 'and undelivered');
      for (const id of [FIXTURE_IDS.message4Id, FIXTURE_IDS.message5Id]) {
        const t = await rowTimes(id);
        assert.ok(t.read_at !== null, `${id} read`);
        assert.equal(t.delivered_at, t.read_at, `${id} delivered at its read`);
      }
      const [thread] = (
        await getJson<Array<{ id: string; unread_count: number }>>(owner, '/threads')
      ).filter((t) => t.id === T1);
      assert.equal(thread?.unread_count, 1);
    },
  );

  test(
    'an absent body and {} each read every unread school message, as before',
    SKIP_WHEN_NO_DB,
    async () => {
      for (const body of [undefined, {}]) {
        const late = await staffReply(staffApp(), T1, { text: `unread ${randomUUID()}` });
        assert.equal(late.statusCode, 201, late.body);
        const res = await ownerRead(ownerApp(), T1, body);
        assert.equal(res.statusCode, 204, res.body);
        const t = await rowTimes((late.json() as Msg).id);
        assert.ok(t.read_at !== null, `${JSON.stringify(body)}: read`);
      }
    },
  );

  test(
    'M1-a: up_to_seq past MAX_MESSAGE_SEQ, negative, a fraction, a string, or an unknown key is 400; nothing is read and nothing logs at 50 or above',
    SKIP_WHEN_NO_DB,
    async () => {
      const capture = makeLogCapture();
      const owner = ownerApp(undefined, makeR2Stub(), capture);
      for (const body of [
        { up_to_seq: 2147483648 },
        { up_to_seq: -1 },
        { up_to_seq: 1.5 },
        { up_to_seq: '3' },
        { up_to_seq: 3, also: true },
      ]) {
        const res = await ownerRead(owner, T1, body);
        assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
        assert.equal(res.json().error.code, 'bad_request');
      }
      assert.equal((await rowTimes(FIXTURE_IDS.message4Id)).read_at, null, 'nothing was read');
      assert.deepEqual(pagerLines(capture), [], 'a line reached the pager');
    },
  );

  test(
    'B10c: one key with two up_to_seq values is 422 idempotency_mismatch, never a replayed 204; the same value replays',
    SKIP_WHEN_NO_DB,
    async () => {
      const owner = ownerApp();
      const key = `read-${randomUUID()}`;
      const first = await ownerRead(owner, T1, { up_to_seq: 4 }, key);
      assert.equal(first.statusCode, 204, first.body);
      const other = await ownerRead(owner, T1, { up_to_seq: 5 }, key);
      assert.equal(other.statusCode, 422, other.body);
      assert.equal(other.json().error.code, 'idempotency_mismatch');
      assert.equal(
        (await rowTimes(FIXTURE_IDS.message5Id)).read_at,
        null,
        'message 5 stays unread',
      );
      const same = await ownerRead(owner, T1, { up_to_seq: 4 }, key);
      assert.equal(same.statusCode, 204, same.body);
    },
  );

  test('L4: the read locks the thread row first', SKIP_WHEN_NO_DB, async () => {
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM threads WHERE id = $1 FOR UPDATE', [T1]);
      const pending = ownerRead(ownerApp(), T1);
      await waitForBlockedBackends(1);
      assert.equal(
        (await rowTimes(FIXTURE_IDS.message4Id)).read_at,
        null,
        'nothing read while it waits',
      );
      await holder.query('ROLLBACK');
      const res = await pending;
      assert.equal(res.statusCode, 204, res.body);
      assert.ok((await rowTimes(FIXTURE_IDS.message4Id)).read_at !== null);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  });
});

// The fixture's message count in thread 1 is the other files' business; this file keeps it.
test('the fixture keeps its five messages in thread 1', SKIP_WHEN_NO_DB, async () => {
  assert.equal((await messageRows(T1)).length, 5);
});
