import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, readSchoolAccount, registerFixtureHooks } from './_harness.js';
import {
  getJson,
  messageRows,
  ownerApp,
  removeMessagesExcept,
  removeSchoolThreads,
  staffApp,
  staffReply,
  startThread,
} from './_messaging.js';

/**
 * MSG-U04's signature (S45; design §2.9:4554, answer 22; wire 9.2.0 `MessageWire.sender_name`
 * doc): a staff reply in a SCHOOL-addressed thread is signed with the replying staffer's first
 * name while `msg.reply_signature_mode` is `staffer_first_name` (the seed), or with the
 * school's name, *NWA School for Dogs*, under `school_name`; the same on both sides. A reply in
 * a trainer-addressed thread keeps the name it always had.
 */

registerFixtureHooks();
const RIVERS = { id: randomUUID(), uid: randomUUID() };
const RIVERS_PRINCIPAL = {
  kind: 'staff' as const,
  staffId: RIVERS.id,
  role: 'trainer' as const,
  supabaseUid: RIVERS.uid,
};
let keep: string[] = [];

afterEach(async () => {
  await removeSchoolThreads();
  if (keep.length > 0) await removeMessagesExcept(FIXTURE_IDS.thread1Id, keep);
  await db.execute(sql`UPDATE messaging_settings SET reply_signature_mode = 'staffer_first_name'`);
});
after(async () => {
  await db.execute(sql`DELETE FROM notifications WHERE sender_staff_id = ${RIVERS.id}`);
  await db.execute(sql`DELETE FROM messages WHERE sender_staff_id = ${RIVERS.id}`);
  await db.execute(sql`DELETE FROM staff WHERE id = ${RIVERS.id}`);
});

async function plantRivers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO staff (id, supabase_uid, name, role, home_locations)
    VALUES (${RIVERS.id}, ${RIVERS.uid}, 'Rachel Rivers', 'trainer', '{fayetteville}')
    ON CONFLICT (id) DO NOTHING`);
}

type Msg = { id: string; text: string; sender_name?: string };

describe('MSG-U04: a reply in a school thread is signed per msg.reply_signature_mode', () => {
  test(
    'staffer_first_name (the seed): her first name, in the reply’s 201, her family’s GET and the staff GET',
    SKIP_WHEN_NO_DB,
    async () => {
      await plantRivers();
      const owner = ownerApp();
      const start = await startThread(owner, { category: 'sessions', text: 'Is Friday open?' });
      const threadId = (start.json() as { thread: { id: string } }).thread.id;
      const reply = await staffReply(staffApp(RIVERS_PRINCIPAL), threadId, {
        text: 'Yes, Friday works.',
      });
      assert.equal(reply.statusCode, 201, reply.body);
      assert.equal((reply.json() as Msg).sender_name, 'Rachel');
      const hers = await getJson<Msg[]>(owner, `/threads/${threadId}/messages`);
      assert.equal(hers.find((m) => m.text === 'Yes, Friday works.')?.sender_name, 'Rachel');
      const theirs = await getJson<Msg[]>(staffApp(), `/staff/threads/${threadId}/messages`);
      assert.equal(theirs.find((m) => m.text === 'Yes, Friday works.')?.sender_name, 'Rachel');
      // Her own message carries no name, as always.
      assert.equal('sender_name' in (hers.find((m) => m.text === 'Is Friday open?') ?? {}), false);
    },
  );

  test('school_name: the school’s name, from the system row', SKIP_WHEN_NO_DB, async () => {
    await plantRivers();
    const school = await readSchoolAccount();
    await db.execute(sql`UPDATE messaging_settings SET reply_signature_mode = 'school_name'`);
    const owner = ownerApp();
    const start = await startThread(owner, { category: 'billing', text: 'A question' });
    const threadId = (start.json() as { thread: { id: string } }).thread.id;
    const reply = await staffReply(staffApp(RIVERS_PRINCIPAL), threadId, { text: 'An answer' });
    assert.equal(reply.statusCode, 201, reply.body);
    assert.equal((reply.json() as Msg).sender_name, school.name);
    const hers = await getJson<Msg[]>(owner, `/threads/${threadId}/messages`);
    assert.equal(hers.find((m) => m.text === 'An answer')?.sender_name, 'NWA School for Dogs');
  });

  test(
    'a reply in a trainer-addressed thread keeps the staffer’s name, whatever the mode',
    SKIP_WHEN_NO_DB,
    async () => {
      await plantRivers();
      keep = (await messageRows(FIXTURE_IDS.thread1Id)).map((m) => m.id);
      await db.execute(sql`UPDATE messaging_settings SET reply_signature_mode = 'school_name'`);
      const reply = await staffReply(staffApp(RIVERS_PRINCIPAL), FIXTURE_IDS.thread1Id, {
        text: 'In Donavan’s thread',
      });
      assert.equal(reply.statusCode, 201, reply.body);
      assert.equal((reply.json() as Msg).sender_name, 'Rachel Rivers');
    },
  );
});
