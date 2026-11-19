import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  plantFamily,
  readSchoolAccount,
  registerFixtureHooks,
  removeFamilies,
} from './_harness.js';
import {
  getJson,
  messageRows,
  overlapping,
  ownerApp,
  plantOwnerMedia,
  plantStaffMedia,
  removePlantedMedia,
  removeSchoolThreads,
  startThread,
} from './_messaging.js';

/**
 * `POST /threads` `[owner]` (wire 9.2.0 `PostThreadsRequest` → `PostThreadsResponse`; design
 * §2.9:4554 S45, MSG-U05; contract-notes mechanics 13, 19, 20): a family starts, or continues,
 * her conversation with the school on one topic. One live school thread per family and topic
 * (rs3 M5.27's partial unique index), whose participant is the system row (`is_school`). The
 * message grammar is the owner send's; a `client_message_id` repeat is always the stored pair,
 * 200. The signed rows: one uncontended start first; racing starts give one thread.
 */

registerFixtureHooks();
const planted: string[] = [];
afterEach(async () => {
  await removeSchoolThreads();
  await removePlantedMedia(planted.splice(0));
});
after(removeFamilies);

interface StartedPair {
  thread: {
    id: string;
    category: string;
    title: string;
    sub_text: string;
    participant: { id: string; name: string; role: string; is_school?: true; image_path?: string };
    related_dog_ids: string[];
    last_message: string;
    unread_count: number;
    last_seq: number;
  };
  message: {
    id: string;
    thread_id: string;
    sender_id: string;
    sender_name?: string;
    text: string;
    seq: number;
    client_message_id?: string;
    reach?: unknown;
    is_read: boolean;
  };
}

describe('POST /threads: the family starts a conversation with the school (S45)', () => {
  test(
    'uncontended, first: 201, a school thread whose participant is the system row (is_school), titled by the topic, the sub-topic as sub_text, her dog; message seq 1 with her client_message_id',
    SKIP_WHEN_NO_DB,
    async () => {
      const school = await readSchoolAccount();
      const app = ownerApp();
      const cmid = randomUUID();
      const res = await startThread(app, {
        category: 'sessions',
        subtopic: '  Day School — Apr 14  ',
        dog_ids: [FIXTURE_IDS.dog1Id],
        text: '  Can Waffles stay till 6 tonight? Running late.  ',
        client_message_id: cmid,
      });
      assert.equal(res.statusCode, 201, res.body);
      const body = res.json() as StartedPair;
      assert.deepEqual(body.thread.participant, {
        id: school.id,
        name: 'NWA School for Dogs',
        role: 'trainer',
        is_school: true,
      });
      assert.equal(body.thread.category, 'sessions');
      assert.equal(body.thread.title, 'Sessions');
      assert.equal(body.thread.sub_text, 'Day School — Apr 14');
      assert.deepEqual(body.thread.related_dog_ids, [FIXTURE_IDS.dog1Id]);
      assert.equal(body.thread.last_message, 'Can Waffles stay till 6 tonight? Running late.');
      assert.equal(body.thread.unread_count, 0);
      assert.equal(body.thread.last_seq, 1);
      assert.equal(body.message.thread_id, body.thread.id);
      assert.equal(body.message.sender_id, FIXTURE_IDS.ownerId);
      assert.equal('sender_name' in body.message, false);
      assert.equal(body.message.text, 'Can Waffles stay till 6 tonight? Running late.');
      assert.equal(body.message.seq, 1);
      assert.equal(body.message.client_message_id, cmid);
      assert.equal('reach' in body.message, false, 'an owner route never emits reach (CR33)');
      // Her list and the thread read show it, with the school participant.
      const list = await getJson<StartedPair['thread'][]>(app, '/threads');
      const listed = list.find((t) => t.id === body.thread.id);
      assert.equal(listed?.participant.is_school, true);
      const one = await getJson<StartedPair['thread']>(app, `/threads/${body.thread.id}`);
      assert.deepEqual(one, body.thread);
      const { rows } = await db.execute<{ addressed_to_school: boolean }>(
        sql`SELECT addressed_to_school FROM threads WHERE id = ${body.thread.id}`,
      );
      assert.equal(rows[0]?.addressed_to_school, true);
    },
  );

  test(
    'a second start on the same topic continues the thread: 201, the same id, seq 2, the newest sub-topic, the union of her dogs',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = ownerApp();
      const first = (
        await startThread(app, {
          category: 'billing',
          subtopic: 'Packages',
          dog_ids: [FIXTURE_IDS.dog1Id],
          text: 'Which package is best?',
        })
      ).json() as StartedPair;
      const second = await startThread(app, {
        category: 'billing',
        subtopic: 'Payments',
        dog_ids: [FIXTURE_IDS.dog2Id, FIXTURE_IDS.dog1Id],
        text: 'And can I pay at the desk?',
      });
      assert.equal(second.statusCode, 201, second.body);
      const body = second.json() as StartedPair;
      assert.equal(body.thread.id, first.thread.id);
      assert.equal(body.message.seq, 2);
      assert.equal(body.thread.last_seq, 2);
      assert.equal(body.thread.sub_text, 'Payments');
      assert.deepEqual(
        [...body.thread.related_dog_ids].sort(),
        [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id].sort(),
      );
      assert.equal(body.thread.last_message, 'And can I pay at the desk?');
      // A start with no sub-topic keeps the last one.
      const third = (
        await startThread(app, { category: 'billing', text: 'Thanks!' })
      ).json() as StartedPair;
      assert.equal(third.thread.sub_text, 'Payments');
      assert.equal((await messageRows(first.thread.id)).length, 3);
    },
  );

  test(
    'another topic opens another school thread; an expired school thread does not block a new one',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = ownerApp();
      const sessions = (
        await startThread(app, { category: 'sessions', text: 'a' })
      ).json() as StartedPair;
      const other = (
        await startThread(app, { category: 'other', text: 'b' })
      ).json() as StartedPair;
      assert.notEqual(sessions.thread.id, other.thread.id);
      assert.equal(other.thread.title, 'Other');
      assert.equal(other.thread.sub_text, '');
      await db.execute(sql`UPDATE threads SET expired_at = now() WHERE id = ${sessions.thread.id}`);
      const again = await startThread(app, { category: 'sessions', text: 'c' });
      assert.equal(again.statusCode, 201, again.body);
      const body = again.json() as StartedPair;
      assert.notEqual(body.thread.id, sessions.thread.id);
      assert.equal(body.message.seq, 1);
    },
  );

  test(
    'racing starts on one topic, no client_message_id, two real connections: both 201, one thread id (§2.9:4554)',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = ownerApp();
      const [a, b] = await overlapping('LOCK TABLE threads IN SHARE MODE', [], 2, () => [
        startThread(app, { category: 'enrollment', text: 'first tap' }),
        startThread(app, { category: 'enrollment', text: 'second tap' }),
      ]);
      assert.equal(a?.statusCode, 201, a?.body);
      assert.equal(b?.statusCode, 201, b?.body);
      const threadA = (a?.json() as StartedPair).thread.id;
      const threadB = (b?.json() as StartedPair).thread.id;
      assert.equal(threadA, threadB, 'two racing starts opened two school threads');
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM threads
           WHERE owner_id = ${FIXTURE_IDS.ownerId} AND addressed_to_school AND category = 'enrollment' AND expired_at IS NULL`,
      );
      assert.equal(rows[0]?.n, 1);
      assert.deepEqual(
        (await messageRows(threadA)).map((m) => m.thread_seq),
        [1, 2],
      );
    },
  );

  test(
    'FL1 on the create verb: two racing starts with ONE client_message_id and two keys, two real connections: 201 and 200, one message',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = ownerApp();
      const cmid = randomUUID();
      const [a, b] = await overlapping('LOCK TABLE threads IN SHARE MODE', [], 2, () => [
        startThread(app, { category: 'other', text: 'once', client_message_id: cmid }),
        startThread(app, { category: 'other', text: 'once', client_message_id: cmid }),
      ]);
      assert.deepEqual(
        [a?.statusCode, b?.statusCode].sort(),
        [200, 201],
        `${a?.body} | ${b?.body}`,
      );
      const pa = a?.json() as StartedPair;
      const pb = b?.json() as StartedPair;
      assert.equal(pa.message.id, pb.message.id);
      assert.equal(pa.thread.id, pb.thread.id);
      assert.equal((await messageRows(pa.thread.id)).length, 1);
    },
  );

  test(
    'a client_message_id repeat is always the stored pair, 200, whatever the body or key (mechanic 13; never 409)',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = ownerApp();
      const cmid = randomUUID();
      const key = `start-${randomUUID()}`;
      const first = await startThread(
        app,
        { category: 'sessions', text: 'original', client_message_id: cmid },
        key,
      );
      assert.equal(first.statusCode, 201, first.body);
      const stored = first.json() as StartedPair;
      // Same key, changed body: the lookup runs before the key's hash, so no 422.
      const sameKey = await startThread(
        app,
        {
          category: 'billing',
          text: 'changed',
          dog_ids: [FIXTURE_IDS.dog2Id],
          client_message_id: cmid,
        },
        key,
      );
      // New key, changed body.
      const newKey = await startThread(app, {
        category: 'other',
        text: 'changed again',
        client_message_id: cmid,
      });
      for (const res of [sameKey, newKey]) {
        assert.equal(res.statusCode, 200, res.body);
        const body = res.json() as StartedPair;
        assert.equal(body.message.id, stored.message.id);
        assert.equal(body.thread.id, stored.thread.id);
        assert.equal(body.message.text, 'original');
        assert.equal(body.message.client_message_id, cmid);
      }
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM threads WHERE owner_id = ${FIXTURE_IDS.ownerId} AND addressed_to_school AND expired_at IS NULL`,
      );
      assert.equal(rows[0]?.n, 1, 'a repeat opened a thread');
    },
  );

  test(
    'the body grammar: 400 for an unknown key, no text and no attachment, a blank or 121-character sub-topic, a dog twice, eleven dogs, a bad category or a malformed client_message_id',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = ownerApp();
      const bad: Array<Record<string, unknown>> = [
        { category: 'sessions', text: 'hi', closure: true },
        { category: 'sessions' },
        { category: 'sessions', text: '   ' },
        { category: 'sessions', text: 'hi', subtopic: '   ' },
        { category: 'sessions', text: 'hi', subtopic: 'x'.repeat(121) },
        { category: 'sessions', text: 'hi', dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog1Id] },
        {
          category: 'sessions',
          text: 'hi',
          dog_ids: Array.from({ length: 11 }, () => randomUUID()),
        },
        { category: 'urgent', text: 'hi' },
        { category: 'sessions', text: 'hi', client_message_id: 'not-a-uuid' },
        { category: 'sessions', text: 'x'.repeat(4001) },
      ];
      for (const payload of bad) {
        const res = await startThread(app, payload);
        assert.equal(res.statusCode, 400, `${JSON.stringify(payload).slice(0, 80)}: ${res.body}`);
        assert.equal(res.json().error.code, 'bad_request');
      }
      const ok = await startThread(app, {
        category: 'sessions',
        text: 'hi',
        subtopic: 'x'.repeat(120),
      });
      assert.equal(ok.statusCode, 201, ok.body);
    },
  );

  test(
    'a dog that is not hers is 404 and opens nothing; a staff principal is 403',
    SKIP_WHEN_NO_DB,
    async () => {
      const family = await plantFamily();
      const app = ownerApp();
      const res = await startThread(app, {
        category: 'sessions',
        text: 'hi',
        dog_ids: [family.dogId],
      });
      assert.equal(res.statusCode, 404, res.body);
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM threads WHERE owner_id = ${FIXTURE_IDS.ownerId} AND addressed_to_school`,
      );
      assert.equal(rows[0]?.n, 0);
      const staff = await startThread(ownerApp(FIXTURE_STAFF_PRINCIPAL), {
        category: 'sessions',
        text: 'hi',
      });
      assert.equal(staff.statusCode, 403, staff.body);
    },
  );

  test(
    'B12 on the create verb: a staff upload is 404, another family’s upload is 404, one id twice is 400; her own photo alone is a message',
    SKIP_WHEN_NO_DB,
    async () => {
      const family = await plantFamily();
      const staffMedia = await plantStaffMedia();
      const theirs = await plantOwnerMedia(family.ownerId);
      const mine = await plantOwnerMedia();
      planted.push(staffMedia, theirs, mine);
      const app = ownerApp();
      const staffRes = await startThread(app, {
        category: 'sessions',
        attachment_media_ids: [staffMedia],
      });
      assert.equal(staffRes.statusCode, 404, staffRes.body);
      const theirsRes = await startThread(app, {
        category: 'sessions',
        attachment_media_ids: [theirs],
      });
      assert.equal(theirsRes.statusCode, 404, theirsRes.body);
      const twice = await startThread(app, {
        category: 'sessions',
        attachment_media_ids: [mine, mine],
      });
      assert.equal(twice.statusCode, 400, twice.body);
      const photo = await startThread(app, { category: 'sessions', attachment_media_ids: [mine] });
      assert.equal(photo.statusCode, 201, photo.body);
      const body = photo.json() as StartedPair & {
        message: { attachments?: Array<{ media_id: string }> };
      };
      assert.equal(body.message.text, '');
      assert.deepEqual(
        body.message.attachments?.map((a) => a.media_id),
        [mine],
      );
      assert.equal(body.thread.last_message, 'Photo');
    },
  );
});
