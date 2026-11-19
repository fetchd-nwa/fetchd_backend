import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import type { ExpoPushClient } from '../../src/lib/expoPush.js';
import { drainInFlight } from '../../src/realtime/settle.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  plantFamily,
  registerFixtureHooks,
  removeFamilies,
} from './_harness.js';
import { makeExpoPushStub, type ExpoPushStub } from './_expoPushStub.js';
import {
  getJson,
  ownerApp,
  plantStaffMedia,
  removePlantedMedia,
  removePlantedStaffTraces,
  staffApp,
  staffReply,
  startThread,
} from './_messaging.js';
import { makePoolHangKit, sleep } from './_poolHang.js';
import { makeR2Stub } from './_r2Stub.js';

/**
 * M1 (the Fable pass-2 seat; orchestrator ruling MB41): the notice's sender name is read on the
 * send's own savepoint, never on the pool. An attachment-only staff reply's feed row says
 * *Amber sent a photo*, so the notice reads the name inside the send's transaction. Read on the
 * pool, it needs a SECOND connection while the transaction holds its first; ten such replies in
 * one thread then hold all ten connections, nine of them queued on the thread's row lock, and the
 * one holding the lock waits for an eleventh: the whole API hangs, and nothing logs.
 *
 * The ten provably overlap (`_poolHang.ts`): a connection of the test's own holds the thread row
 * `FOR UPDATE` until all ten are blocked on it inside their transactions. Then the lock goes, and
 * all ten must answer 201 within 10 s of the database clock, each feed row and push naming her
 * the way her thread names the message (`MessageWire.sender_name`).
 *
 * The red run ends by itself: the test times out, and the `after` hook below (registered BEFORE
 * the fixture's) force-ends the pool so the stuck requests settle and the teardown runs.
 */

const REPLIES = 10;
/** The bound on the database clock, from the lock's release to the tenth 201. */
const BOUND_SECONDS = 10;

const kit = makePoolHangKit();
const planted: string[] = [];

// Registered before `registerFixtureHooks()`, so it runs before the fixture's teardown.
after(async () => {
  await kit.release('message-notice-pool');
  await Promise.race([drainInFlight(), sleep(15_000)]);
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  // Before the fixture's teardown deletes its staff: what the replies left that names Amber.
  await removePlantedStaffTraces();
  await removePlantedMedia(planted.splice(0));
  await removeFamilies();
});

registerFixtureHooks();

/** Expo's real ticket shape, after a real delay (tens of milliseconds, never the same tick). */
function slowed(stub: ExpoPushStub, ms = 40): ExpoPushClient {
  return {
    async sendBatch(messages) {
      await sleep(ms);
      return stub.sendBatch(messages);
    },
  };
}

test(
  'M1: ten attachment-only staff replies at once in one thread all answer 201 within 10 s of the database clock, each named as her thread names it',
  { ...SKIP_WHEN_NO_DB, timeout: 45_000 },
  async () => {
    const family = await plantFamily('The Hendersons');
    const started = await startThread(ownerApp(family.principal), {
      category: 'sessions',
      text: 'Hello school',
    });
    assert.equal(started.statusCode, 201, started.body);
    const threadId = (started.json() as { thread: { id: string } }).thread.id;
    const token = `ExponentPushToken[${randomUUID()}]`;
    await db.execute(sql`
      INSERT INTO device_tokens (owner_id, expo_push_token, platform)
      VALUES (${family.ownerId}, ${token}, 'ios')`);
    const media: string[] = [];
    for (let i = 0; i < REPLIES; i += 1) media.push(await plantStaffMedia(family.ownerId));
    planted.push(...media);

    const stub = makeExpoPushStub();
    const app = staffApp(FIXTURE_MANAGER_PRINCIPAL, makeR2Stub(), slowed(stub));
    const { results: replies, seconds } = await kit.overlapAll(
      'SELECT 1 FROM threads WHERE id = $1 FOR UPDATE',
      [threadId],
      REPLIES,
      () =>
        media.map((id) =>
          staffReply(app, threadId, { attachment_media_ids: [id] }, `m1-pool-${randomUUID()}`),
        ),
    );

    assert.deepEqual(
      replies.map((r) => r.statusCode),
      Array<number>(REPLIES).fill(201),
      replies.map((r) => r.body.slice(0, 200)).join('\n'),
    );
    assert.ok(
      seconds < BOUND_SECONDS,
      `ten replies took ${seconds} s on the database clock (bound ${BOUND_SECONDS} s)`,
    );
    for (const r of replies) {
      assert.deepEqual((r.json() as { reach?: unknown }).reach, {
        channel: 'push',
        why: 'device',
      });
    }

    // The name, exactly as her thread shows it on these messages (`MessageWire.sender_name`).
    await drainInFlight();
    const ids = new Set(replies.map((r) => (r.json() as { id: string }).id));
    const hers = await getJson<Array<{ id: string; sender_name?: string }>>(
      ownerApp(family.principal),
      `/threads/${threadId}/messages`,
    );
    const names = [...new Set(hers.filter((m) => ids.has(m.id)).map((m) => m.sender_name))];
    assert.deepEqual(names, ['Amber'], 'her thread names each of the ten Amber');
    const { rows: feed } = await db.execute<{ body: string }>(sql`
      SELECT body FROM notifications
       WHERE owner_id = ${family.ownerId} AND type = 'message-received'`);
    assert.deepEqual(
      feed.map((f) => f.body),
      Array<string>(REPLIES).fill('Amber sent a photo'),
    );
    const pushes = stub.calls.flatMap((c) => c.messages);
    assert.deepEqual(
      pushes.map((p) => [p.to, p.title, p.body]),
      Array<[string, string, string]>(REPLIES).fill([token, 'Amber', 'Amber sent a photo']),
    );
  },
);
