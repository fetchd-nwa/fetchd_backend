import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  registerFixtureHooks,
} from './_harness.js';
import {
  getJson,
  messageRows,
  overlapping,
  ownerApp,
  ownerSend,
  plantOwnerMedia,
  removeMessagesExcept,
  removePlantedMedia,
  staffApp,
  staffReply,
} from './_messaging.js';

/**
 * W2 on the pass-1 verbs (wire 9.2.0 `client_message_id?` on `PostThreadsMessagesRequest` and
 * `PostStaffThreadsMessagesRequest`; design §4 W2 as A2 OL2 and the Opus seat's last read N6
 * amend it; contract-notes mechanics 11–13; brief LR11, LR18):
 *   · unique per SENDER, looked up BEFORE the Idempotency-Key's body hash: a repeat by the same
 *     sender of a message the server holds is that message, 200, whatever the body or key (B8);
 *   · on the two `/messages` verbs, the same sender's id on a message in ANOTHER thread is 409
 *     `conflict` (LR18); another sender's identical id is another message (OL2);
 *   · two concurrent first sends with one id give one 201, one 200 and one row, on two real
 *     connections, the 23505 handled OUTSIDE the aborted transaction (FL1, LR11);
 *   · echoed only to the sender's own side (mechanic 11).
 */

registerFixtureHooks();

// The fixture's seven messages stay; whatever a test sends is removed.
const FIXTURE_MESSAGES = {
  [FIXTURE_IDS.thread1Id]: [] as string[],
  [FIXTURE_IDS.thread2Id]: [] as string[],
};
const planted: string[] = [];

async function rememberFixture(): Promise<void> {
  for (const threadId of [FIXTURE_IDS.thread1Id, FIXTURE_IDS.thread2Id]) {
    if ((FIXTURE_MESSAGES[threadId] ?? []).length === 0) {
      FIXTURE_MESSAGES[threadId] = (await messageRows(threadId)).map((m) => m.id);
    }
  }
}

afterEach(async () => {
  for (const [threadId, keep] of Object.entries(FIXTURE_MESSAGES)) {
    if (keep.length > 0) await removeMessagesExcept(threadId, keep);
  }
  await removePlantedMedia(planted.splice(0));
});

type Msg = { id: string; thread_id: string; seq: number; text: string; client_message_id?: string };

describe('W2: client_message_id on the owner send and the staff reply', () => {
  test(
    'mechanic 11: her client_message_id is echoed on her side only — her GET shows it, the staff GET does not; a staffer’s is echoed to staff only',
    SKIP_WHEN_NO_DB,
    async () => {
      await rememberFixture();
      const owner = ownerApp();
      const staff = staffApp();
      const mine = randomUUID();
      const theirs = randomUUID();
      const sent = await ownerSend(owner, FIXTURE_IDS.thread1Id, {
        text: 'echo me',
        client_message_id: mine,
      });
      assert.equal(sent.statusCode, 201, sent.body);
      assert.equal((sent.json() as Msg).client_message_id, mine);
      const reply = await staffReply(staff, FIXTURE_IDS.thread1Id, {
        text: 'echo us',
        client_message_id: theirs,
      });
      assert.equal(reply.statusCode, 201, reply.body);
      assert.equal((reply.json() as Msg).client_message_id, theirs);

      const ownerView = await getJson<Msg[]>(owner, `/threads/${FIXTURE_IDS.thread1Id}/messages`);
      const staffView = await getJson<Msg[]>(
        staff,
        `/staff/threads/${FIXTURE_IDS.thread1Id}/messages`,
      );
      const find = (list: Msg[], text: string) => list.find((m) => m.text === text);
      assert.equal(find(ownerView, 'echo me')?.client_message_id, mine);
      assert.equal('client_message_id' in (find(ownerView, 'echo us') ?? {}), false);
      assert.equal('client_message_id' in (find(staffView, 'echo me') ?? {}), false);
      assert.equal(find(staffView, 'echo us')?.client_message_id, theirs);
      // Every fixture message, sent with none, carries none on either side.
      assert.ok(
        ownerView
          .filter((m) => m.text !== 'echo me' && m.text !== 'echo us')
          .every((m) => !('client_message_id' in m)),
      );
    },
  );

  test(
    'B8: a send with an attachment commits and its response is lost; the retry (same client_message_id, its idempotency row deleted, body changed) is the stored message, 200, no second message',
    SKIP_WHEN_NO_DB,
    async () => {
      await rememberFixture();
      const owner = ownerApp();
      const photo = await plantOwnerMedia();
      planted.push(photo);
      const cmid = randomUUID();
      const key = `b8-${randomUUID()}`;
      const first = await ownerSend(
        owner,
        FIXTURE_IDS.thread1Id,
        { text: 'with a photo', attachment_media_ids: [photo], client_message_id: cmid },
        key,
      );
      assert.equal(first.statusCode, 201, first.body);
      const stored = first.json() as Msg & { attachments?: Array<{ media_id: string }> };
      // The response is lost, and so is its idempotency row (the TTL sweep, or a new key).
      await db.execute(sql`DELETE FROM idempotency_keys WHERE key = ${key}`);
      const retry = await ownerSend(
        owner,
        FIXTURE_IDS.thread1Id,
        { text: 'edited before retry', client_message_id: cmid },
        key,
      );
      assert.equal(retry.statusCode, 200, retry.body);
      const body = retry.json() as Msg & { attachments?: Array<{ media_id: string }> };
      assert.equal(body.id, stored.id);
      assert.equal(body.text, 'with a photo');
      assert.deepEqual(
        body.attachments?.map((a) => a.media_id),
        [photo],
      );
      assert.equal(body.client_message_id, cmid);
      const rows = (await messageRows(FIXTURE_IDS.thread1Id)).filter(
        (m) => m.client_message_id === cmid,
      );
      assert.equal(rows.length, 1);
    },
  );

  test(
    'B8 (the lookup before the hash): the same key, a changed body and the same client_message_id is the stored message, 200, never 422 idempotency_mismatch',
    SKIP_WHEN_NO_DB,
    async () => {
      await rememberFixture();
      const owner = ownerApp();
      const cmid = randomUUID();
      const key = `b8h-${randomUUID()}`;
      const first = await ownerSend(
        owner,
        FIXTURE_IDS.thread2Id,
        { text: 'first words', client_message_id: cmid },
        key,
      );
      assert.equal(first.statusCode, 201, first.body);
      const again = await ownerSend(
        owner,
        FIXTURE_IDS.thread2Id,
        { text: 'other words', client_message_id: cmid },
        key,
      );
      assert.equal(again.statusCode, 200, again.body);
      assert.equal((again.json() as Msg).id, (first.json() as Msg).id);
      // The staff reply, the same.
      const staff = staffApp();
      const scmid = randomUUID();
      const skey = `b8s-${randomUUID()}`;
      const reply = await staffReply(
        staff,
        FIXTURE_IDS.thread2Id,
        { text: 'staff words', client_message_id: scmid },
        skey,
      );
      assert.equal(reply.statusCode, 201, reply.body);
      const replyAgain = await staffReply(
        staff,
        FIXTURE_IDS.thread2Id,
        { text: 'changed', client_message_id: scmid },
        skey,
      );
      assert.equal(replyAgain.statusCode, 200, replyAgain.body);
      assert.equal((replyAgain.json() as Msg).id, (reply.json() as Msg).id);
      assert.equal((replyAgain.json() as Msg).text, 'staff words');
    },
  );

  test(
    'LR18: the same sender’s id on a message in another thread is 409 conflict, on the owner send and on the staff reply, and sends nothing',
    SKIP_WHEN_NO_DB,
    async () => {
      await rememberFixture();
      const owner = ownerApp();
      const cmid = randomUUID();
      assert.equal(
        (await ownerSend(owner, FIXTURE_IDS.thread1Id, { text: 'in one', client_message_id: cmid }))
          .statusCode,
        201,
      );
      const elsewhere = await ownerSend(owner, FIXTURE_IDS.thread2Id, {
        text: 'in two',
        client_message_id: cmid,
      });
      assert.equal(elsewhere.statusCode, 409, elsewhere.body);
      assert.equal(elsewhere.json().error.code, 'conflict');
      assert.equal(
        (await messageRows(FIXTURE_IDS.thread2Id)).some((m) => m.text === 'in two'),
        false,
      );

      const staff = staffApp();
      const scmid = randomUUID();
      assert.equal(
        (
          await staffReply(staff, FIXTURE_IDS.thread1Id, {
            text: 'staff one',
            client_message_id: scmid,
          })
        ).statusCode,
        201,
      );
      const staffElsewhere = await staffReply(staff, FIXTURE_IDS.thread2Id, {
        text: 'staff two',
        client_message_id: scmid,
      });
      assert.equal(staffElsewhere.statusCode, 409, staffElsewhere.body);
      assert.equal(staffElsewhere.json().error.code, 'conflict');
    },
  );

  test(
    'OL2: one uuid from the family and from a staffer, and from two staffers, in one thread, is three messages',
    SKIP_WHEN_NO_DB,
    async () => {
      await rememberFixture();
      const cmid = randomUUID();
      const a = await ownerSend(ownerApp(), FIXTURE_IDS.thread1Id, {
        text: 'family',
        client_message_id: cmid,
      });
      const b = await staffReply(staffApp(), FIXTURE_IDS.thread1Id, {
        text: 'Donavan',
        client_message_id: cmid,
      });
      const c = await staffReply(staffApp(FIXTURE_MANAGER_PRINCIPAL), FIXTURE_IDS.thread1Id, {
        text: 'Amber',
        client_message_id: cmid,
      });
      assert.deepEqual(
        [a.statusCode, b.statusCode, c.statusCode],
        [201, 201, 201],
        `${a.body} ${b.body} ${c.body}`,
      );
      const rows = (await messageRows(FIXTURE_IDS.thread1Id)).filter(
        (m) => m.client_message_id === cmid,
      );
      assert.deepEqual(rows.map((r) => r.text).sort(), ['Amber', 'Donavan', 'family']);
    },
  );

  test(
    'FL1 + LR11 (owner send): two concurrent first sends with one client_message_id and two keys, on two real connections: one 201, one 200, one row',
    SKIP_WHEN_NO_DB,
    async () => {
      await rememberFixture();
      const owner = ownerApp();
      const cmid = randomUUID();
      const [a, b] = await overlapping(
        'SELECT 1 FROM threads WHERE id = $1 FOR UPDATE',
        [FIXTURE_IDS.thread2Id],
        2,
        () => [
          ownerSend(owner, FIXTURE_IDS.thread2Id, {
            text: 'twice at once',
            client_message_id: cmid,
          }),
          ownerSend(owner, FIXTURE_IDS.thread2Id, {
            text: 'twice at once',
            client_message_id: cmid,
          }),
        ],
      );
      assert.deepEqual(
        [a?.statusCode, b?.statusCode].sort(),
        [200, 201],
        `${a?.body} | ${b?.body}`,
      );
      assert.equal((a?.json() as Msg).id, (b?.json() as Msg).id);
      const rows = (await messageRows(FIXTURE_IDS.thread2Id)).filter(
        (m) => m.client_message_id === cmid,
      );
      assert.equal(rows.length, 1);
    },
  );

  test('FL1 + LR11 (staff reply): the same, for one staffer', SKIP_WHEN_NO_DB, async () => {
    await rememberFixture();
    const staff = staffApp(FIXTURE_STAFF_PRINCIPAL);
    const cmid = randomUUID();
    const [a, b] = await overlapping(
      'SELECT 1 FROM threads WHERE id = $1 FOR UPDATE',
      [FIXTURE_IDS.thread2Id],
      2,
      () => [
        staffReply(staff, FIXTURE_IDS.thread2Id, {
          text: 'reply at once',
          client_message_id: cmid,
        }),
        staffReply(staff, FIXTURE_IDS.thread2Id, {
          text: 'reply at once',
          client_message_id: cmid,
        }),
      ],
    );
    assert.deepEqual([a?.statusCode, b?.statusCode].sort(), [200, 201], `${a?.body} | ${b?.body}`);
    assert.equal((a?.json() as Msg).id, (b?.json() as Msg).id);
    const rows = (await messageRows(FIXTURE_IDS.thread2Id)).filter(
      (m) => m.client_message_id === cmid,
    );
    assert.equal(rows.length, 1);
  });

  test(
    'the staff reply’s three schema keys parse (CR18); until pass 2 a reply without text keeps its 422 and a staff attachment is refused 422',
    SKIP_WHEN_NO_DB,
    async () => {
      await rememberFixture();
      const staff = staffApp();
      const keys = await staffReply(staff, FIXTURE_IDS.thread1Id, {
        text: 'with every key',
        attachment_media_ids: [],
        client_message_id: randomUUID(),
      });
      assert.equal(keys.statusCode, 201, keys.body);
      const noText = await staffReply(staff, FIXTURE_IDS.thread1Id, {
        client_message_id: randomUUID(),
      });
      assert.equal(noText.statusCode, 422, noText.body);
      assert.equal(noText.json().error.code, 'invalid_payload');
      const photo = await staffReply(staff, FIXTURE_IDS.thread1Id, {
        text: 'a photo',
        attachment_media_ids: [randomUUID()],
      });
      assert.equal(photo.statusCode, 422, photo.body);
      const unknown = await staffReply(staff, FIXTURE_IDS.thread1Id, { text: 'x', closure: true });
      assert.equal(unknown.statusCode, 422, unknown.body);
    },
  );
});
