import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { drainInFlight } from '../../src/realtime/settle.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { ownerApp, ownerSend, removeMessagesExcept, staffApp, staffReply } from './_messaging.js';

/**
 * A8 (the Fable pass-1 audit's L4): an Idempotency-Key whose response was stored by code from
 * before 9.2.0 holds a message with no `seq` (the owner send stored the row without `threadSeq`;
 * the staff reply stored a 9.1.0 `MessageWire`). Replayed after the deploy, the answer re-reads
 * the stored message, so it carries the `seq` 9.2.0 makes required. Deploy window only.
 */

registerFixtureHooks();
afterEach(async () => {
  await drainInFlight();
  await removeMessagesExcept(FIXTURE_IDS.thread1Id, [
    FIXTURE_IDS.message1Id,
    FIXTURE_IDS.message2Id,
    FIXTURE_IDS.message3Id,
    FIXTURE_IDS.message4Id,
    FIXTURE_IDS.message5Id,
  ]);
});

type Msg = { id: string; seq: number; text: string };

test(
  'A8: the owner send’s key stored before 9.2.0 (a row with no threadSeq) replays with its seq',
  SKIP_WHEN_NO_DB,
  async () => {
    const key = `pre-${randomUUID()}`;
    const first = await ownerSend(
      ownerApp(),
      FIXTURE_IDS.thread1Id,
      { text: 'before the deploy' },
      key,
    );
    assert.equal(first.statusCode, 201, first.body);
    const msg = first.json() as Msg;
    // What 9.1.0 stored: the row, without the columns rs3 added.
    await db.execute(sql`
    UPDATE idempotency_keys
       SET response_body = response_body - 'threadSeq' - 'clientMessageId' - 'deliveredAt'
     WHERE key = ${key}`);
    const replay = await ownerSend(
      ownerApp(),
      FIXTURE_IDS.thread1Id,
      { text: 'before the deploy' },
      key,
    );
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal((replay.json() as Msg).id, msg.id);
    assert.equal((replay.json() as Msg).seq, msg.seq);
  },
);

test(
  'A8: the staff reply’s key stored before 9.2.0 (a 9.1.0 MessageWire) replays with its seq',
  SKIP_WHEN_NO_DB,
  async () => {
    const key = `pre-${randomUUID()}`;
    const first = await staffReply(
      staffApp(),
      FIXTURE_IDS.thread1Id,
      { text: 'before the deploy' },
      key,
    );
    assert.equal(first.statusCode, 201, first.body);
    const msg = first.json() as Msg & {
      sender_id: string;
      sender_name: string;
      sent_at: string;
      thread_id: string;
    };
    const legacy = {
      id: msg.id,
      thread_id: msg.thread_id,
      sender_id: msg.sender_id,
      sender_name: msg.sender_name,
      text: msg.text,
      sent_at: msg.sent_at,
      is_read: false,
    };
    await db.execute(
      sql`UPDATE idempotency_keys SET response_body = ${JSON.stringify(legacy)}::jsonb WHERE key = ${key}`,
    );
    const replay = await staffReply(
      staffApp(),
      FIXTURE_IDS.thread1Id,
      { text: 'before the deploy' },
      key,
    );
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal((replay.json() as Msg).id, msg.id);
    assert.equal((replay.json() as Msg).seq, msg.seq);
  },
);
