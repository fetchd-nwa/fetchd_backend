import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import type { Principal } from '../../src/auth/principal.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, plantFamily, registerFixtureHooks, removeFamilies } from './_harness.js';
import {
  getJson,
  messageRows,
  ownerApp,
  ownerSend,
  removeMessagesExcept,
  removeSchoolThreads,
  startThread,
} from './_messaging.js';

/**
 * Two families, one road each (the Fable pass-1 audit's M1 and M2, the Opus seat's L1; carried to
 * pass 2 as A2 and A3): the two owner-scoped lookups pass 1 built right and nothing pinned.
 *   · A family's `POST /threads` continues HER OWN live school thread on that topic, never another
 *     family's (`threadsRepository.findOrCreateSchoolThread`'s owner filter). Unpinned, a start by
 *     Allison lands in the Hendersons' thread and they read her words.
 *   · A family's `client_message_id` is looked up among HER OWN messages only
 *     (`messagesRepository.findByOwnerClientMessageId`'s sender filter; A2 OL2: unique per
 *     sender). Two families who mint one id each get their own message back, on both owner verbs.
 */

registerFixtureHooks();
let keep: string[] = [];
afterEach(async () => {
  await removeSchoolThreads();
  if (keep.length > 0) await removeMessagesExcept(FIXTURE_IDS.thread1Id, keep);
});
after(async () => {
  // Under a regression a family's message may sit in another family's thread (a row that can exist
  // only then): remove every such row first, or the families' removal fails on the sender's
  // foreign key and takes the next file's fixture with it.
  await db.execute(sql`
    DELETE FROM messages m USING threads t
     WHERE t.id = m.thread_id AND m.sender_owner_id IS NOT NULL AND m.sender_owner_id <> t.owner_id`);
  await removeEarlyFamily();
  await removeFamilies();
});

/**
 * A family whose owner id sorts BEFORE the fixture family's (`11111111-…`), so an unscoped read of
 * the school threads meets hers first whether Postgres scans the heap (hers is inserted first) or
 * the `(owner_id, category)` index: the regression is then always visible, never a coin toss.
 */
const EARLY_OWNER_ID = `0${randomUUID().slice(1)}`;
const EARLY_FAMILY: Principal = {
  kind: 'owner',
  ownerId: EARLY_OWNER_ID,
  supabaseUid: randomUUID(),
};

async function plantEarlyFamily(): Promise<void> {
  await db.execute(sql`
    INSERT INTO owners (id, supabase_uid, name, email, location)
    VALUES (${EARLY_OWNER_ID}, ${randomUUID()}, 'The Hendersons', ${`early-${EARLY_OWNER_ID}@example.com`},
            'bentonville')`);
}

async function removeEarlyFamily(): Promise<void> {
  await db.execute(sql`DELETE FROM threads WHERE owner_id = ${EARLY_OWNER_ID}`);
  await db.execute(sql`DELETE FROM idempotency_keys WHERE owner_id = ${EARLY_OWNER_ID}`);
  await db.execute(sql`DELETE FROM owners WHERE id = ${EARLY_OWNER_ID}`);
}

type Pair = { thread: { id: string }; message: { id: string; text: string } };
type Msg = { id: string; text: string; thread_id: string; client_message_id?: string };

describe('two families: each start and each client_message_id stays in its own family', () => {
  test(
    'A2: the Hendersons hold a live Enrollment school thread; Allison starts Enrollment: her message goes to a thread of her own, never theirs',
    SKIP_WHEN_NO_DB,
    async () => {
      await plantEarlyFamily();
      const theirs = ownerApp(EARLY_FAMILY);
      const b = await startThread(theirs, { category: 'enrollment', text: 'Henderson private' });
      assert.equal(b.statusCode, 201, b.body);
      const bThread = (b.json() as Pair).thread.id;
      const a = await startThread(ownerApp(), { category: 'enrollment', text: 'Allison private' });
      const strays = (await messageRows(bThread)).filter((m) => m.text === 'Allison private');
      const seen = await getJson<Array<{ text: string }>>(theirs, `/threads/${bThread}/messages`);
      // A leaked row is removed before the asserts, so a red run never leaves it behind.
      await db.execute(
        sql`DELETE FROM messages WHERE thread_id = ${bThread} AND text = 'Allison private'`,
      );
      assert.equal(strays.length, 0, 'Allison’s message was stored in the Hendersons’ thread');
      assert.deepEqual(
        seen.map((m) => m.text),
        ['Henderson private'],
        'the Hendersons read only their own words',
      );
      assert.equal(a.statusCode, 201, a.body);
      assert.notEqual((a.json() as Pair).thread.id, bThread);
    },
  );

  test(
    'A3: two families mint one client_message_id: each gets her own message back, 201, on the owner send and on POST /threads',
    SKIP_WHEN_NO_DB,
    async () => {
      keep = (await messageRows(FIXTURE_IDS.thread1Id)).map((m) => m.id);
      const family = await plantFamily();
      const theirs = ownerApp(family.principal);
      const sendId = randomUUID();
      const startId = randomUUID();

      // The owner send: Allison first, then the Hendersons with the same id.
      const a = await ownerSend(ownerApp(), FIXTURE_IDS.thread1Id, {
        text: 'Allison sends',
        client_message_id: sendId,
      });
      assert.equal(a.statusCode, 201, a.body);
      const bStart = await startThread(theirs, { category: 'other', text: 'Hendersons start' });
      assert.equal(bStart.statusCode, 201, bStart.body);
      const bThread = (bStart.json() as Pair).thread.id;
      const b = await ownerSend(theirs, bThread, {
        text: 'Hendersons send',
        client_message_id: sendId,
      });
      assert.equal(b.statusCode, 201, b.body);
      const bMsg = b.json() as Msg;
      assert.equal(bMsg.text, 'Hendersons send');
      assert.equal(bMsg.thread_id, bThread);
      assert.notEqual(bMsg.id, (a.json() as Msg).id);

      // POST /threads: the Hendersons first this time, then Allison.
      const bCreate = await startThread(theirs, {
        category: 'billing',
        text: 'Hendersons create',
        client_message_id: startId,
      });
      assert.equal(bCreate.statusCode, 201, bCreate.body);
      const aCreate = await startThread(ownerApp(), {
        category: 'billing',
        text: 'Allison creates',
        client_message_id: startId,
      });
      assert.equal(aCreate.statusCode, 201, aCreate.body);
      const aPair = aCreate.json() as Pair;
      assert.equal(aPair.message.text, 'Allison creates');
      assert.notEqual(aPair.thread.id, (bCreate.json() as Pair).thread.id);

      // Each family's own copy of each id is one row.
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM messages WHERE client_message_id IN (${sendId}, ${startId})`,
      );
      assert.equal(rows[0]?.n, 4);
    },
  );
});
