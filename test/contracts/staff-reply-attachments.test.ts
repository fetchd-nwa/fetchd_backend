import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { registerMediaRoute } from '../../src/routes/media.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  plantFamily,
  registerFixtureHooks,
  removeFamilies,
} from './_harness.js';
import {
  getJson,
  messageRows,
  ownerApp,
  plantOwnerMedia,
  plantStaffMedia,
  removeMessagesExcept,
  removePlantedMedia,
  removePlantedStaffTraces,
  staffApp,
  staffReply,
  startThread,
} from './_messaging.js';
import { makeR2Stub } from './_r2Stub.js';

/**
 * W6, the staff reply widened (wire 9.2.0 `PostStaffThreadsMessagesRequest`; her answer 6, build
 * DECISIONS 589: staff photos and videos up to 25 MB, no PDFs; design §4 W6, B12; contract-notes
 * mechanics 14, 24):
 *   · a reply carries non-empty `text` OR at least one attachment, at most 10, no id twice; a
 *     body failing the schema keeps its 422 `invalid_payload` (the asymmetry W6 keeps);
 *   · each id must be a live `message-attachment` row a staffer uploaded for THIS family
 *     (`POST /media/upload?purpose=message-attachment&thread_id=…`, the p2a lane's arm, stamps
 *     the thread's owner and `created_by = 'staff'`); missing, another family's, or a family's own
 *     upload is 404, and nothing is stored;
 *   · an attachment-only reply is stored as `text: ''` and previews as *Photo*.
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
const planted: string[] = [];
afterEach(async () => {
  await removeMessagesExcept(T1, FIXTURE_T1);
  await removePlantedMedia(planted.splice(0));
  await db.execute(
    sql`DELETE FROM media_assets WHERE owner_id = ${FIXTURE_IDS.ownerId} AND created_by = 'staff'`,
  );
  await removePlantedStaffTraces();
});
after(removeFamilies);

type Msg = {
  id: string;
  text: string;
  attachments?: Array<{ media_id: string; kind: string; url: string }>;
};

const JPEG = Buffer.from('a staff photo of a scrape on Waffles’ paw');

/** A staff photo through the real upload arm (the p2a lane's), stamped for `threadId`'s family. */
async function uploadStaffPhoto(threadId: string, contentType = 'image/jpeg'): Promise<string> {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerMediaRoute(app, { authenticate, r2: makeR2Stub() });
  const res = await app.inject({
    method: 'POST',
    url: `/media/upload?purpose=message-attachment&thread_id=${threadId}`,
    headers: { 'content-type': contentType, 'idempotency-key': `up-${randomUUID()}` },
    payload: JPEG,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = (res.json() as { id: string }).id;
  planted.push(id);
  return id;
}

async function previewOf(threadId: string): Promise<string | undefined> {
  const { rows } = await db.execute<{ last_message: string }>(
    sql`SELECT last_message FROM threads WHERE id = ${threadId}`,
  );
  return rows[0]?.last_message;
}

describe('W6: the staff reply carries photos and videos', () => {
  test(
    'a photo uploaded for this family through the upload arm, sent alone: 201, text "", the attachment on both sides, preview Photo',
    SKIP_WHEN_NO_DB,
    async () => {
      const photo = await uploadStaffPhoto(T1);
      const res = await staffReply(staffApp(), T1, { attachment_media_ids: [photo] });
      assert.equal(res.statusCode, 201, res.body);
      const msg = res.json() as Msg;
      assert.equal(msg.text, '');
      assert.deepEqual(
        msg.attachments?.map((a) => [a.media_id, a.kind]),
        [[photo, 'image']],
      );
      assert.equal(await previewOf(T1), 'Photo');
      const hers = (await getJson<Msg[]>(ownerApp(), `/threads/${T1}/messages`)).find(
        (m) => m.id === msg.id,
      );
      assert.deepEqual(
        hers?.attachments?.map((a) => a.media_id),
        [photo],
        'she sees it',
      );
    },
  );

  test(
    'text with attachments keeps their order; a video counts; 10 pass, 11 are 422',
    SKIP_WHEN_NO_DB,
    async () => {
      const a = await uploadStaffPhoto(T1);
      const b = await uploadStaffPhoto(T1, 'video/mp4');
      const res = await staffReply(staffApp(), T1, {
        text: 'two angles',
        attachment_media_ids: [b, a],
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.deepEqual(
        (res.json() as Msg).attachments?.map((x) => [x.media_id, x.kind]),
        [
          [b, 'video'],
          [a, 'image'],
        ],
      );
      const eleven = Array.from({ length: 11 }, () => randomUUID());
      const tooMany = await staffReply(staffApp(), T1, {
        text: 'many',
        attachment_media_ids: eleven,
      });
      assert.equal(tooMany.statusCode, 422, tooMany.body);
      assert.equal(tooMany.json().error.code, 'invalid_payload');
    },
  );

  test(
    'A7: an id named twice is 422 invalid_payload, and nothing is sent',
    SKIP_WHEN_NO_DB,
    async () => {
      const photo = await uploadStaffPhoto(T1);
      const before = (await messageRows(T1)).length;
      const res = await staffReply(staffApp(), T1, {
        text: 'twice',
        attachment_media_ids: [photo, photo],
      });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(res.json().error.code, 'invalid_payload');
      assert.equal((await messageRows(T1)).length, before);
    },
  );

  test(
    'neither text nor an attachment is 422; a 9.1.0 body (text alone) still sends',
    SKIP_WHEN_NO_DB,
    async () => {
      const none = await staffReply(staffApp(), T1, { attachment_media_ids: [] });
      assert.equal(none.statusCode, 422, none.body);
      const blank = await staffReply(staffApp(), T1, { text: '   ' });
      assert.equal(blank.statusCode, 422, blank.body);
      const old = await staffReply(staffApp(), T1, { text: 'just words' });
      assert.equal(old.statusCode, 201, old.body);
    },
  );
});

describe('B12, the staff half: whose media a staff reply may carry', () => {
  test(
    'a staff photo uploaded for another family is 404 in this family’s thread, and nothing is stored',
    SKIP_WHEN_NO_DB,
    async () => {
      const family = await plantFamily();
      const theirs = await startThread(ownerApp(family.principal), {
        category: 'sessions',
        text: 'hi',
      });
      assert.equal(theirs.statusCode, 201, theirs.body);
      const theirThread = (theirs.json() as { thread: { id: string } }).thread.id;
      const forThem = await uploadStaffPhoto(theirThread);
      const before = (await messageRows(T1)).length;
      const res = await staffReply(staffApp(), T1, {
        text: 'wrong family',
        attachment_media_ids: [forThem],
      });
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(res.json().error.code, 'not_found');
      assert.equal((await messageRows(T1)).length, before);
      // In their own thread it sends.
      const right = await staffReply(staffApp(), theirThread, { attachment_media_ids: [forThem] });
      assert.equal(right.statusCode, 201, right.body);
    },
  );

  test(
    'a family’s own upload, an unknown id and an expired staff photo are each 404',
    SKIP_WHEN_NO_DB,
    async () => {
      const hers = await plantOwnerMedia(FIXTURE_IDS.ownerId);
      planted.push(hers);
      const expired = await uploadStaffPhoto(T1);
      await db.execute(sql`UPDATE media_assets SET expired_at = now() WHERE id = ${expired}`);
      for (const id of [hers, randomUUID(), expired]) {
        const res = await staffReply(staffApp(), T1, { text: 'look', attachment_media_ids: [id] });
        assert.equal(res.statusCode, 404, `${id}: ${res.body}`);
      }
    },
  );

  test(
    'a staff upload of this family that is not a message attachment is 422 invalid_payload',
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await plantStaffMedia(FIXTURE_IDS.ownerId);
      planted.push(id);
      await db.execute(sql`UPDATE media_assets SET purpose = 'report-photo' WHERE id = ${id}`);
      const res = await staffReply(staffApp(), T1, {
        text: 'a report photo',
        attachment_media_ids: [id],
      });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(res.json().error.code, 'invalid_payload');
    },
  );
});
