import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  plantFamily,
  registerFixtureHooks,
  removeFamilies,
  type PlantedFamily,
} from './_harness.js';
import {
  overlapping,
  ownerApp,
  removeMessagesExcept,
  removePlantedStaffTraces,
  removeSchoolThreads,
  staffApp,
  staffReply,
  staffStart,
  startThread,
} from './_messaging.js';

/**
 * `POST /staff/threads` `[staff]` (S46, MSG-U13; signed design §2.9:4555 as A1 re-cuts it; wire
 * 9.2.0 `PostStaffThreadsRequest`, `PostStaffThreadsResponse`; contract-notes mechanics 12, 13,
 * 20–22; brief CR9 / B8c, OL2, LR18):
 *   · a staffer starts a conversation with a family, or CONTINUES her own live thread with that
 *     family on that topic (by lookup; a school thread is never hers to continue);
 *   · `.strict()`, text only, `text` 1–4000 after trim, `owner_id` a live family and `dog_ids`
 *     hers (404 otherwise), at most 10, no repeats; a body failing the schema is 400 (R6);
 *   · 201 `{thread: StaffThreadWire, message}`, the message carrying `reach`;
 *   · a `client_message_id` repeat is ALWAYS the stored pair, 200, never 409, whatever thread it
 *     is in, and two concurrent first starts with one id give 201 + 200 and one message.
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
  await removeSchoolThreads();
  // A planted family's staff-started threads and feed rows name fixture staffers: gone before
  // the fixture's staff are (the fixture's teardown runs before this file's `after`).
  await removePlantedStaffTraces();
  await db.execute(sql`
    DELETE FROM threads WHERE owner_id = ${FIXTURE_IDS.ownerId}
       AND id NOT IN (${T1}, ${FIXTURE_IDS.thread2Id})`);
});
after(removeFamilies);

type StaffThread = {
  id: string;
  owner_id: string;
  owner_name: string;
  addressed_to_me: boolean;
  staff_unread_count: number;
  title: string;
  sub_text: string;
  related_dog_ids: string[];
  participant: { id: string; is_school?: true };
  last_seq: number;
};
type Msg = {
  id: string;
  thread_id: string;
  sender_id: string;
  text: string;
  seq: number;
  client_message_id?: string;
  receipt?: { state: string };
  reach?: { channel: string; why: string };
};
type Pair = { thread: StaffThread; message: Msg };

async function messagesIn(threadId: string): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM messages WHERE thread_id = ${threadId}`,
  );
  return rows[0]?.n ?? 0;
}

async function threadsOf(ownerId: string): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM threads WHERE owner_id = ${ownerId} AND expired_at IS NULL`,
  );
  return rows[0]?.n ?? 0;
}

describe('POST /staff/threads: start or continue', () => {
  let family: PlantedFamily;

  test(
    'a first start: 201, the staffer’s own thread with the family, and the message with reach',
    SKIP_WHEN_NO_DB,
    async () => {
      family = await plantFamily();
      const cmid = randomUUID();
      const res = await staffStart(staffApp(), {
        owner_id: family.ownerId,
        category: 'sessions',
        dog_ids: [family.dogId],
        text: '  Biscuit did great today!  ',
        client_message_id: cmid,
      });
      assert.equal(res.statusCode, 201, res.body);
      const { thread, message } = res.json() as Pair;
      assert.equal(thread.owner_id, family.ownerId);
      assert.equal(thread.owner_name, 'The Hendersons');
      assert.equal(thread.participant.id, FIXTURE_IDS.staffDonavanId);
      assert.equal('is_school' in thread.participant, false);
      assert.equal(thread.addressed_to_me, true);
      assert.equal(thread.staff_unread_count, 0);
      assert.equal(thread.title, 'Sessions');
      assert.deepEqual(thread.related_dog_ids, [family.dogId]);
      assert.equal(thread.last_seq, 1);
      assert.equal(message.thread_id, thread.id);
      assert.equal(message.sender_id, FIXTURE_IDS.staffDonavanId);
      assert.equal(message.text, 'Biscuit did great today!');
      assert.equal(message.seq, 1);
      assert.equal(message.client_message_id, cmid, 'echoed to staff, the sender’s side');
      assert.equal(message.receipt?.state, 'sent');
      assert.deepEqual(message.reach, { channel: 'feed-only', why: 'no-device' });
    },
  );

  test(
    'a second start on that topic continues her thread; another topic, or another staffer, starts a new one',
    SKIP_WHEN_NO_DB,
    async () => {
      family = await plantFamily();
      const first = (
        await staffStart(staffApp(), {
          owner_id: family.ownerId,
          category: 'sessions',
          text: 'one',
        })
      ).json() as Pair;
      const again = await staffStart(staffApp(), {
        owner_id: family.ownerId,
        category: 'sessions',
        dog_ids: [family.dogId],
        text: 'two',
      });
      assert.equal(again.statusCode, 201, again.body);
      const second = again.json() as Pair;
      assert.equal(second.thread.id, first.thread.id);
      assert.equal(second.message.seq, 2);
      assert.deepEqual(second.thread.related_dog_ids, [family.dogId], 'dogs are the union');

      const billing = (
        await staffStart(staffApp(), {
          owner_id: family.ownerId,
          category: 'billing',
          text: 'three',
        })
      ).json() as Pair;
      assert.notEqual(billing.thread.id, first.thread.id);
      const amber = (
        await staffStart(staffApp(FIXTURE_MANAGER_PRINCIPAL), {
          owner_id: family.ownerId,
          category: 'sessions',
          text: 'four',
        })
      ).json() as Pair;
      assert.notEqual(amber.thread.id, first.thread.id, 'Amber’s conversation is her own');
      assert.equal(amber.thread.participant.id, FIXTURE_IDS.staffAmberId);
      assert.equal(await threadsOf(family.ownerId), 3);
    },
  );

  test(
    'a family’s school thread on that topic is never continued by a staff start',
    SKIP_WHEN_NO_DB,
    async () => {
      const school = await startThread(ownerApp(), {
        category: 'enrollment',
        text: 'to the school',
      });
      assert.equal(school.statusCode, 201, school.body);
      const schoolId = (school.json() as Pair).thread.id;
      const res = await staffStart(staffApp(), {
        owner_id: FIXTURE_IDS.ownerId,
        category: 'enrollment',
        text: 'from Donavan',
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.notEqual((res.json() as Pair).thread.id, schoolId);
      assert.equal(await messagesIn(schoolId), 1);
    },
  );
});

describe('POST /staff/threads: refusals', () => {
  test(
    'a body failing the schema is 400 bad_request (R6), and nothing is stored',
    SKIP_WHEN_NO_DB,
    async () => {
      const family = await plantFamily();
      const base = { owner_id: family.ownerId, category: 'sessions', text: 'hi' };
      for (const body of [
        {},
        { ...base, closure: true },
        { ...base, attachment_media_ids: [randomUUID()] },
        { ...base, text: '   ' },
        { ...base, text: 'x'.repeat(4001) },
        { ...base, owner_id: 'not-a-uuid' },
        { ...base, category: 'gossip' },
        { ...base, dog_ids: [family.dogId, family.dogId] },
        { ...base, dog_ids: Array.from({ length: 11 }, () => randomUUID()) },
        { ...base, client_message_id: 'nope' },
      ]) {
        const res = await staffStart(staffApp(), body);
        assert.equal(res.statusCode, 400, `${JSON.stringify(body).slice(0, 80)}: ${res.body}`);
        assert.equal(res.json().error.code, 'bad_request');
      }
      assert.equal(await threadsOf(family.ownerId), 0);
    },
  );

  test(
    'an unknown or departed family, or a dog not hers, is 404; a family principal is 403; no key is 400',
    SKIP_WHEN_NO_DB,
    async () => {
      const family = await plantFamily();
      const unknown = await staffStart(staffApp(), {
        owner_id: randomUUID(),
        category: 'other',
        text: 'x',
      });
      assert.equal(unknown.statusCode, 404, unknown.body);
      const notHers = await staffStart(staffApp(), {
        owner_id: family.ownerId,
        category: 'other',
        dog_ids: [FIXTURE_IDS.dog1Id],
        text: 'x',
      });
      assert.equal(notHers.statusCode, 404, notHers.body);
      assert.equal(await threadsOf(family.ownerId), 0, 'nothing was stored');
      await db.execute(sql`UPDATE owners SET expired_at = now() WHERE id = ${family.ownerId}`);
      const departed = await staffStart(staffApp(), {
        owner_id: family.ownerId,
        category: 'other',
        text: 'x',
      });
      assert.equal(departed.statusCode, 404, departed.body);
      const asFamily = await staffStart(staffApp(FIXTURE_OWNER_PRINCIPAL), {
        owner_id: FIXTURE_IDS.ownerId,
        category: 'other',
        text: 'x',
      });
      assert.equal(asFamily.statusCode, 403, asFamily.body);
      const noKey = await staffApp().inject({
        method: 'POST',
        url: '/staff/threads',
        payload: { owner_id: FIXTURE_IDS.ownerId, category: 'other', text: 'x' },
      });
      assert.equal(noKey.statusCode, 400, noKey.body);
    },
  );
});

describe('POST /staff/threads: client_message_id (CR9, OL2, LR18)', () => {
  test(
    'mechanic 13: a repeat is always the stored pair, 200, whatever the body or key, with no reach and no second message',
    SKIP_WHEN_NO_DB,
    async () => {
      const family = await plantFamily();
      const cmid = randomUUID();
      const first = await staffStart(staffApp(), {
        owner_id: family.ownerId,
        category: 'other',
        text: 'first words',
        client_message_id: cmid,
      });
      assert.equal(first.statusCode, 201, first.body);
      const repeat = await staffStart(staffApp(), {
        owner_id: family.ownerId,
        category: 'billing',
        text: 'changed words',
        client_message_id: cmid,
      });
      assert.equal(repeat.statusCode, 200, repeat.body);
      const pair = repeat.json() as Pair;
      assert.equal(pair.message.id, (first.json() as Pair).message.id);
      assert.equal(pair.message.text, 'first words');
      assert.equal('reach' in pair.message, false, 'the notice was decided once');
      assert.equal(pair.thread.id, (first.json() as Pair).thread.id);
      assert.equal(await threadsOf(family.ownerId), 1);
    },
  );

  test(
    'LR18: the create verb never answers 409: her id from a reply in another thread is that stored pair, 200; the reply verb with her start’s id elsewhere is 409',
    SKIP_WHEN_NO_DB,
    async () => {
      const family = await plantFamily();
      const replyId = randomUUID();
      const reply = await staffReply(staffApp(), T1, {
        text: 'in thread 1',
        client_message_id: replyId,
      });
      assert.equal(reply.statusCode, 201, reply.body);
      const start = await staffStart(staffApp(), {
        owner_id: family.ownerId,
        category: 'other',
        text: 'elsewhere',
        client_message_id: replyId,
      });
      assert.equal(start.statusCode, 200, start.body);
      assert.equal((start.json() as Pair).thread.id, T1);
      assert.equal((start.json() as Pair).message.id, (reply.json() as Msg).id);

      const startId = randomUUID();
      const own = await staffStart(staffApp(), {
        owner_id: family.ownerId,
        category: 'other',
        text: 'a start',
        client_message_id: startId,
      });
      assert.equal(own.statusCode, 201, own.body);
      const conflict = await staffReply(staffApp(), T1, {
        text: 'reused',
        client_message_id: startId,
      });
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.equal(conflict.json().error.code, 'conflict');
    },
  );

  test(
    'OL2: two staffers with one id get two messages; a family and a staffer with one id get two messages',
    SKIP_WHEN_NO_DB,
    async () => {
      const family = await plantFamily();
      const cmid = randomUUID();
      const donavan = await staffStart(staffApp(), {
        owner_id: family.ownerId,
        category: 'other',
        text: 'from Donavan',
        client_message_id: cmid,
      });
      const amber = await staffStart(staffApp(FIXTURE_MANAGER_PRINCIPAL), {
        owner_id: family.ownerId,
        category: 'other',
        text: 'from Amber',
        client_message_id: cmid,
      });
      assert.equal(donavan.statusCode, 201, donavan.body);
      assert.equal(amber.statusCode, 201, amber.body);
      assert.equal((amber.json() as Pair).message.text, 'from Amber');
      const theirs = await startThread(ownerApp(family.principal), {
        category: 'other',
        text: 'from the family',
        client_message_id: cmid,
      });
      assert.equal(theirs.statusCode, 201, theirs.body);
      assert.equal((theirs.json() as { message: Msg }).message.text, 'from the family');
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM messages WHERE client_message_id = ${cmid}`,
      );
      assert.equal(rows[0]?.n, 3);
    },
  );

  test(
    'B8c (CR9): two concurrent continues with one id and two keys, on two real connections: 201 + 200, one message, never 409',
    SKIP_WHEN_NO_DB,
    async () => {
      const cmid = randomUUID();
      const app = staffApp(FIXTURE_STAFF_PRINCIPAL);
      const body = {
        owner_id: FIXTURE_IDS.ownerId,
        category: 'sessions',
        text: 'at once',
        client_message_id: cmid,
      };
      const [a, b] = await overlapping(
        'SELECT 1 FROM threads WHERE id = $1 FOR UPDATE',
        [T1],
        2,
        () => [staffStart(app, body), staffStart(app, body)],
      );
      assert.deepEqual(
        [a?.statusCode, b?.statusCode].sort(),
        [200, 201],
        `${a?.body} | ${b?.body}`,
      );
      assert.equal((a?.json() as Pair).message.id, (b?.json() as Pair).message.id);
      assert.equal(
        (a?.json() as Pair).thread.id,
        T1,
        'Donavan’s sessions thread with the family continues',
      );
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM messages WHERE client_message_id = ${cmid}`,
      );
      assert.equal(rows[0]?.n, 1);
    },
  );

  test(
    'B8c (CR9): two concurrent first starts with one id on a topic with no thread: 201 + 200, one message, one thread',
    SKIP_WHEN_NO_DB,
    async () => {
      const family = await plantFamily();
      const cmid = randomUUID();
      const app = staffApp();
      const body = {
        owner_id: family.ownerId,
        category: 'enrollment',
        text: 'hello',
        client_message_id: cmid,
      };
      const [a, b] = await Promise.all([staffStart(app, body), staffStart(app, body)]);
      assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 201], `${a.body} | ${b.body}`);
      assert.equal(await threadsOf(family.ownerId), 1);
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM messages WHERE client_message_id = ${cmid}`,
      );
      assert.equal(rows[0]?.n, 1);
    },
  );
});
