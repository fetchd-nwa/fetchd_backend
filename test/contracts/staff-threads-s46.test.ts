import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import { withActor } from '../../src/db/tx.js';
import { messagesRepository } from '../../src/db/repositories/messagesRepository.js';
import type { Principal } from '../../src/auth/principal.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  plantFamily,
  registerFixtureHooks,
  removeFamilies,
} from './_harness.js';
import {
  getJson,
  ownerApp,
  ownerSend,
  removeMessagesExcept,
  removeSchoolThreads,
  staffApp,
  staffRead,
  staffReply,
  staffStart,
  startThread,
} from './_messaging.js';
import { waitForBlockedBackends } from './_poolFixture.js';
import { plantRequest } from './_requestServices.js';

/**
 * S46 on the API (signed design §2.9:4555, MSG-U15, MSG-U17, NOTIF-U33, as A1 re-cuts it; wire
 * 9.2.0 `StaffThreadWire`, `PostStaffThreadsReadRequest`, `StaffBellWire`):
 *   · `GET /staff/threads`: every live thread, each with its family and the CALLER's own read
 *     state. `addressed_to_me`: a school thread for every owner- and manager-role staffer, a
 *     staffer's own thread for her, a departed participant's thread for the owner and manager
 *     roles. `staff_unread_count`: the family's messages with no read row for the caller.
 *   · `POST /staff/threads/:id/read {message_ids}`: marks read for the caller only the listed
 *     family messages of THIS thread (the ones the portal rendered), so a message that commits
 *     between her GET and her POST stays unread (the signed read races). Stamps *Delivered*. The
 *     family's *Read* time is the school's FIRST read: a second staffer's read never moves it
 *     (B10b, CR14).
 *   · A staff reply, and a staff start, is not the replier's read (MB27 Q4).
 *   · `GET /staff/notifications/summary`: per campus, the caller's threads addressed to her with
 *     anything unread for her, and the live `submitted` requests by the family's campus.
 */

registerFixtureHooks();

const T1 = FIXTURE_IDS.thread1Id;
const T2 = FIXTURE_IDS.thread2Id;
const FIXTURE_MESSAGES = {
  [T1]: [
    FIXTURE_IDS.message1Id,
    FIXTURE_IDS.message2Id,
    FIXTURE_IDS.message3Id,
    FIXTURE_IDS.message4Id,
    FIXTURE_IDS.message5Id,
  ],
  [T2]: [FIXTURE_IDS.message6Id, FIXTURE_IDS.message7Id],
};
const RACHEL: Principal = {
  kind: 'staff',
  staffId: FIXTURE_IDS.staffRachelId,
  role: 'trainer',
  supabaseUid: FIXTURE_IDS.staffRachelSupabaseUid,
};
const plantedRequests: string[] = [];

afterEach(async () => {
  for (const [threadId, keep] of Object.entries(FIXTURE_MESSAGES)) {
    await removeMessagesExcept(threadId, keep);
  }
  await db.execute(sql`
    DELETE FROM message_staff_reads
     WHERE message_id IN (SELECT id FROM messages WHERE thread_id IN (${T1}, ${T2}))`);
  await db.execute(sql`UPDATE messages SET delivered_at = NULL WHERE thread_id IN (${T1}, ${T2})`);
  await removeSchoolThreads();
  // Threads the staff starts created with the fixture family (not the fixture's two).
  await db.execute(sql`
    DELETE FROM threads WHERE owner_id = ${FIXTURE_IDS.ownerId} AND id NOT IN (${T1}, ${T2})`);
  for (const id of plantedRequests.splice(0)) {
    await db.execute(sql`DELETE FROM pending_requests WHERE id = ${id}`);
  }
});
after(removeFamilies);

type StaffThread = {
  id: string;
  owner_id: string;
  owner_name: string;
  addressed_to_me: boolean;
  staff_unread_count: number;
  unread_count: number;
  participant: { id: string };
};
type Msg = { id: string; sender_id: string; seq: number; receipt?: { state: string; at: string } };
type Bell = {
  by_location: Record<
    'fayetteville' | 'bentonville',
    { unread_client_threads: number; pending_requests: number }
  >;
};

async function queue(principal: Principal): Promise<Map<string, StaffThread>> {
  const rows = await getJson<StaffThread[]>(staffApp(principal), '/staff/threads');
  return new Map(rows.map((r) => [r.id, r] as const));
}

async function bell(principal: Principal): Promise<Bell> {
  return getJson<Bell>(staffApp(principal), '/staff/notifications/summary');
}

async function readRows(staffId: string): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(
    sql`SELECT message_id::text AS id FROM message_staff_reads WHERE staff_id = ${staffId} ORDER BY 1`,
  );
  return rows.map((r) => r.id);
}

async function deliveredAt(id: string): Promise<string | null> {
  const { rows } = await db.execute<{ at: string | null }>(
    sql`SELECT delivered_at::text AS at FROM messages WHERE id = ${id}`,
  );
  return rows[0]?.at ?? null;
}

/** The family starts a school thread with one message; its id and the message's. */
async function schoolThread(
  text = 'Ring the desk',
): Promise<{ threadId: string; messageId: string }> {
  const res = await startThread(ownerApp(), { category: 'other', text });
  assert.equal(res.statusCode, 201, res.body);
  const pair = res.json() as { thread: { id: string }; message: { id: string } };
  return { threadId: pair.thread.id, messageId: pair.message.id };
}

describe('GET /staff/threads → StaffThreadWire', () => {
  test(
    'each row carries its family and the caller’s own read state; addressed_to_me by the three arms',
    SKIP_WHEN_NO_DB,
    async () => {
      const school = await schoolThread();
      const donavan = await queue(FIXTURE_STAFF_PRINCIPAL);
      const amber = await queue(FIXTURE_MANAGER_PRINCIPAL);
      const shanthi = await queue(FIXTURE_OWNER_ROLE_PRINCIPAL);

      const t1 = donavan.get(T1);
      assert.ok(t1, 'thread 1 listed');
      assert.equal(t1.owner_id, FIXTURE_IDS.ownerId);
      assert.equal(t1.owner_name, 'Allison Fixture');
      assert.equal(t1.staff_unread_count, 2, 'her two messages, no read row for Donavan');
      assert.equal(t1.unread_count, 2, 'unread_count keeps its owner-side meaning (DRIFT-39)');
      // His own thread is his; Rachel's is not; the school's is not a trainer's.
      assert.equal(t1.addressed_to_me, true);
      assert.equal(donavan.get(T2)?.addressed_to_me, false);
      assert.equal(donavan.get(school.threadId)?.addressed_to_me, false);
      // A school thread is every owner- and manager-role staffer's (question 72).
      assert.equal(amber.get(school.threadId)?.addressed_to_me, true);
      assert.equal(shanthi.get(school.threadId)?.addressed_to_me, true);
      assert.equal(amber.get(T1)?.addressed_to_me, false);
      assert.equal(amber.get(school.threadId)?.staff_unread_count, 1);
    },
  );

  test(
    'a departed participant’s thread is addressed to the owner and manager roles (MSG-37), and still lists',
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(
        sql`UPDATE staff SET expired_at = now() WHERE id = ${FIXTURE_IDS.staffDonavanId}`,
      );
      try {
        assert.equal((await queue(FIXTURE_MANAGER_PRINCIPAL)).get(T1)?.addressed_to_me, true);
        assert.equal((await queue(FIXTURE_OWNER_ROLE_PRINCIPAL)).get(T1)?.addressed_to_me, true);
        assert.equal((await queue(RACHEL)).get(T1)?.addressed_to_me, false);
      } finally {
        await db.execute(
          sql`UPDATE staff SET expired_at = NULL WHERE id = ${FIXTURE_IDS.staffDonavanId}`,
        );
      }
    },
  );
});

describe('POST /staff/threads/:id/read', () => {
  test(
    'marks the listed family messages read for the caller only, stamps Delivered, and ignores foreign ids',
    SKIP_WHEN_NO_DB,
    async () => {
      const res = await staffRead(staffApp(), T1, [
        FIXTURE_IDS.message1Id,
        FIXTURE_IDS.message3Id,
        FIXTURE_IDS.message2Id, // a staff message: not the family's
        FIXTURE_IDS.message6Id, // another thread's
        randomUUID(), // nobody's
      ]);
      assert.equal(res.statusCode, 204, res.body);
      assert.deepEqual(
        await readRows(FIXTURE_IDS.staffDonavanId),
        [FIXTURE_IDS.message1Id, FIXTURE_IDS.message3Id].sort(),
      );
      assert.equal((await queue(FIXTURE_STAFF_PRINCIPAL)).get(T1)?.staff_unread_count, 0);
      assert.equal(
        (await queue(FIXTURE_MANAGER_PRINCIPAL)).get(T1)?.staff_unread_count,
        2,
        'Amber’s count is hers',
      );
      assert.ok((await deliveredAt(FIXTURE_IDS.message1Id)) !== null, 'Delivered stamped');
      assert.equal(await deliveredAt(FIXTURE_IDS.message6Id), null, 'the foreign id untouched');
      const again = await staffRead(staffApp(), T1, [FIXTURE_IDS.message1Id]);
      assert.equal(again.statusCode, 204, 'a repeat is a no-op');
      assert.equal((await readRows(FIXTURE_IDS.staffDonavanId)).length, 2);
    },
  );

  test(
    'the grammar: 1–500 uuids, .strict(), 400 otherwise; an unknown thread 404; a family 403',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = staffApp();
      const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
      for (const body of [
        { message_ids: [] },
        { message_ids: ids(501) },
        { message_ids: ['not-a-uuid'] },
        { message_ids: ids(1), also: true },
        {},
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: `/staff/threads/${T1}/read`,
          headers: { 'idempotency-key': `rd-${randomUUID()}` },
          payload: body,
        });
        assert.equal(res.statusCode, 400, `${JSON.stringify(body).slice(0, 60)}: ${res.body}`);
        assert.equal(res.json().error.code, 'bad_request');
      }
      const ok = await staffRead(app, T1, ids(500));
      assert.equal(ok.statusCode, 204, '500 ids pass the grammar');
      assert.equal((await staffRead(app, randomUUID(), ids(1))).statusCode, 404);
      const family = await staffRead(staffApp(FIXTURE_OWNER_PRINCIPAL), T1, ids(1));
      assert.equal(family.statusCode, 403, family.body);
    },
  );

  test(
    'signed read race (§2.9:4555): a GET, then a family message that commits, then a POST with the GET’s ids leaves the new one unread',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = staffApp();
      const seen = await getJson<Msg[]>(app, `/staff/threads/${T1}/messages`);
      const later = await ownerSend(ownerApp(), T1, { text: 'one more question' });
      assert.equal(later.statusCode, 201, later.body);
      const res = await staffRead(
        app,
        T1,
        seen.filter((m) => m.sender_id === FIXTURE_IDS.ownerId).map((m) => m.id),
      );
      assert.equal(res.statusCode, 204, res.body);
      assert.equal((await queue(FIXTURE_STAFF_PRINCIPAL)).get(T1)?.staff_unread_count, 1);
      assert.equal(
        (await readRows(FIXTURE_IDS.staffDonavanId)).includes((later.json() as Msg).id),
        false,
      );
    },
  );

  test(
    'signed read race (§2.9:4555): a family message held uncommitted on a second connection during the staff open is unread for her after it commits',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = staffApp();
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      let heldId = '';
      try {
        await holder.query('BEGIN');
        const inserted = await holder.query<{ id: string }>(
          `INSERT INTO messages (thread_id, sender_kind, sender_owner_id, text)
           VALUES ($1, 'owner', $2, 'typed while she looked') RETURNING id`,
          [T1, FIXTURE_IDS.ownerId],
        );
        heldId = inserted.rows[0]?.id ?? '';
        const seen = await getJson<Msg[]>(app, `/staff/threads/${T1}/messages`);
        assert.equal(
          seen.some((m) => m.id === heldId),
          false,
          'the open does not see it',
        );
        const pending = staffRead(
          app,
          T1,
          seen.filter((m) => m.sender_id === FIXTURE_IDS.ownerId).map((m) => m.id),
        );
        // The read locks the thread row first, so it waits for the held send.
        await waitForBlockedBackends(1);
        await holder.query('COMMIT');
        const res = await pending;
        assert.equal(res.statusCode, 204, res.body);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
      assert.equal((await readRows(FIXTURE_IDS.staffDonavanId)).includes(heldId), false);
      assert.equal((await queue(FIXTURE_STAFF_PRINCIPAL)).get(T1)?.staff_unread_count, 1);
    },
  );

  test(
    'B10b (CR14): Rachel reads at one instant, Amber the same messages later: the family’s Read stays Rachel’s, and Amber’s read is no first read',
    SKIP_WHEN_NO_DB,
    async () => {
      const sent = await ownerSend(ownerApp(), T2, { text: 'Is my invoice right?' });
      assert.equal(sent.statusCode, 201, sent.body);
      const id = (sent.json() as Msg).id;
      assert.equal((await staffRead(staffApp(RACHEL), T2, [id])).statusCode, 204);
      const { rows } = await db.execute<{ at: string }>(sql`
        SELECT to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
          FROM message_staff_reads WHERE message_id = ${id} AND staff_id = ${FIXTURE_IDS.staffRachelId}`);
      const rachelAt = rows[0]?.at;
      // Amber's read, a moment later, through the route's own repository call.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const amberRead = await withActor(`staff:${FIXTURE_IDS.staffAmberId}`, (tx) =>
        messagesRepository.markReadForStaff(tx, {
          threadId: T2,
          staffId: FIXTURE_IDS.staffAmberId,
          messageIds: [id],
        }),
      );
      assert.equal(amberRead.firstRead, null, 'a second staffer’s read is not the school’s first');
      const seen = (await getJson<Msg[]>(ownerApp(), `/threads/${T2}/messages`)).find(
        (m) => m.id === id,
      );
      assert.deepEqual(seen?.receipt, { state: 'read', at: rachelAt });
    },
  );

  test(
    'B10b: the school’s first read of a message is a first read, with that message’s seq',
    SKIP_WHEN_NO_DB,
    async () => {
      const sent = await ownerSend(ownerApp(), T2, { text: 'Hello?' });
      const msg = sent.json() as Msg;
      const first = await withActor(`staff:${FIXTURE_IDS.staffRachelId}`, (tx) =>
        messagesRepository.markReadForStaff(tx, {
          threadId: T2,
          staffId: FIXTURE_IDS.staffRachelId,
          messageIds: [msg.id, FIXTURE_IDS.message6Id],
        }),
      );
      assert.equal(first.firstRead?.upToSeq, msg.seq);
    },
  );
});

describe('a staff reply is not the replier’s read (MB27 Q4)', () => {
  test(
    'Rachel replies, and starts again, without reading: her unread count and the family’s receipt do not move',
    SKIP_WHEN_NO_DB,
    async () => {
      const sent = await ownerSend(ownerApp(), T2, { text: 'Can you check my balance?' });
      assert.equal(sent.statusCode, 201, sent.body);
      const familyMsg = (sent.json() as Msg).id;
      const before = (await queue(RACHEL)).get(T2)?.staff_unread_count;
      assert.ok((before ?? 0) >= 1);

      const reply = await staffReply(staffApp(RACHEL), T2, { text: 'Looking now.' });
      assert.equal(reply.statusCode, 201, reply.body);
      const again = await staffStart(staffApp(RACHEL), {
        owner_id: FIXTURE_IDS.ownerId,
        category: 'billing',
        text: 'Found it.',
      });
      assert.equal(again.statusCode, 201, again.body);
      assert.equal(
        (again.json() as { thread: { id: string } }).thread.id,
        T2,
        'her own billing thread with the family continues',
      );

      assert.equal((await queue(RACHEL)).get(T2)?.staff_unread_count, before);
      assert.deepEqual(await readRows(FIXTURE_IDS.staffRachelId), []);
      const seen = (await getJson<Msg[]>(ownerApp(), `/threads/${T2}/messages`)).find(
        (m) => m.id === familyMsg,
      );
      assert.notEqual(seen?.receipt?.state, 'read');
    },
  );
});

describe('GET /staff/notifications/summary → StaffBellWire', () => {
  test('a family is 403', SKIP_WHEN_NO_DB, async () => {
    const res = await staffApp(FIXTURE_OWNER_PRINCIPAL).inject({
      method: 'GET',
      url: '/staff/notifications/summary',
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error.code, 'forbidden');
  });

  test(
    'per campus: the caller’s threads addressed to her with anything unread for her; a read clears only her bell',
    SKIP_WHEN_NO_DB,
    async () => {
      const school = await schoolThread();
      // The fixture family is at Fayetteville. Amber (manager) and Shanthi (owner role) both ring.
      assert.equal(
        (await bell(FIXTURE_MANAGER_PRINCIPAL)).by_location.fayetteville.unread_client_threads,
        1,
      );
      assert.equal(
        (await bell(FIXTURE_MANAGER_PRINCIPAL)).by_location.bentonville.unread_client_threads,
        0,
      );
      assert.equal(
        (await bell(FIXTURE_OWNER_ROLE_PRINCIPAL)).by_location.fayetteville.unread_client_threads,
        1,
      );
      // Donavan (trainer): the school thread is not his; his own thread 1 has her unread messages.
      assert.equal(
        (await bell(FIXTURE_STAFF_PRINCIPAL)).by_location.fayetteville.unread_client_threads,
        1,
      );
      // Rachel's thread 2 has nothing unread from the family for her? Both fixture messages there
      // are read by her side in the old sense only, so her one family message is unread for her.
      assert.equal((await bell(RACHEL)).by_location.fayetteville.unread_client_threads, 1);

      assert.equal(
        (await staffRead(staffApp(FIXTURE_MANAGER_PRINCIPAL), school.threadId, [school.messageId]))
          .statusCode,
        204,
      );
      assert.equal(
        (await bell(FIXTURE_MANAGER_PRINCIPAL)).by_location.fayetteville.unread_client_threads,
        0,
      );
      assert.equal(
        (await bell(FIXTURE_OWNER_ROLE_PRINCIPAL)).by_location.fayetteville.unread_client_threads,
        1,
        'Shanthi’s bell still rings (question 72)',
      );
    },
  );

  test(
    'pending_requests: live submitted requests by the family’s campus (A2.3)',
    SKIP_WHEN_NO_DB,
    async () => {
      const before = (await bell(FIXTURE_MANAGER_PRINCIPAL)).by_location;
      const family = await plantFamily(); // Bentonville
      plantedRequests.push(
        await plantRequest({
          category: 'boarding',
          ownerId: family.ownerId,
          dogIds: [family.dogId],
        }),
      );
      const after = (await bell(FIXTURE_MANAGER_PRINCIPAL)).by_location;
      assert.equal(after.bentonville.pending_requests, before.bentonville.pending_requests + 1);
      assert.equal(after.fayetteville.pending_requests, before.fayetteville.pending_requests);
      // The fixture's own submitted request is Fayetteville's.
      assert.ok(after.fayetteville.pending_requests >= 1);
    },
  );

  test(
    'a family with no campus counts on BOTH campuses, her unread thread and her request alike; given a campus, she counts once, on hers (the Opus pass-2 seat’s M2; default pending her answer)',
    SKIP_WHEN_NO_DB,
    async () => {
      const before = (await bell(FIXTURE_MANAGER_PRINCIPAL)).by_location;
      const family = await plantFamily('The Campusless');
      await db.execute(sql`UPDATE owners SET location = NULL WHERE id = ${family.ownerId}`);
      const start = await startThread(ownerApp(family.principal), {
        category: 'billing',
        text: 'Is my invoice right?',
      });
      assert.equal(start.statusCode, 201, start.body);
      plantedRequests.push(
        await plantRequest({
          category: 'boarding',
          ownerId: family.ownerId,
          dogIds: [family.dogId],
        }),
      );
      const counts = (b: Bell['by_location']) =>
        (['fayetteville', 'bentonville'] as const).map((campus) => [
          campus,
          b[campus].unread_client_threads - before[campus].unread_client_threads,
          b[campus].pending_requests - before[campus].pending_requests,
        ]);

      const noCampus = (await bell(FIXTURE_MANAGER_PRINCIPAL)).by_location;
      assert.deepEqual(
        counts(noCampus),
        [
          ['fayetteville', 1, 1],
          ['bentonville', 1, 1],
        ],
        'with no campus she rings both desks: one unread thread and one request on each',
      );

      await db.execute(
        sql`UPDATE owners SET location = 'bentonville' WHERE id = ${family.ownerId}`,
      );
      const hers = (await bell(FIXTURE_MANAGER_PRINCIPAL)).by_location;
      assert.deepEqual(
        counts(hers),
        [
          ['fayetteville', 0, 0],
          ['bentonville', 1, 1],
        ],
        'with a campus she counts once, on hers',
      );
    },
  );
});
