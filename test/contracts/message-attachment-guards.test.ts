import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, plantFamily, registerFixtureHooks, removeFamilies } from './_harness.js';
import {
  messageRows,
  ownerApp,
  ownerSend,
  plantOwnerMedia,
  plantStaffMedia,
  removeMessagesExcept,
  removePlantedMedia,
  staffApp,
  staffReply,
  startThread,
} from './_messaging.js';

/**
 * B12's owner half (wire 9.2.0 `PostThreadsMessagesRequest`, its 9.2.0 paragraph; contract-notes
 * mechanic 14; design §5 B12): a family can attach only her own uploads to her own thread.
 *   · A staff upload (`created_by = 'staff'`), even one stamped with her id, is treated as
 *     missing: 404.
 *   · Media of another family cannot go in her thread, and hers cannot go in theirs: 404.
 *   · An id named twice is 400 `bad_request` (it was a 500 on
 *     `message_attachments_message_media_uidx`, P45 `plan_added`), and 422 on the staff reply
 *     (its asymmetry kept).
 */

registerFixtureHooks();
const planted: string[] = [];
let keep: string[] = [];
afterEach(async () => {
  if (keep.length > 0) await removeMessagesExcept(FIXTURE_IDS.thread1Id, keep);
  await removePlantedMedia(planted.splice(0));
});
after(removeFamilies);

describe('B12: whose media a message may carry', () => {
  test(
    'a staff upload stamped with her id is 404 on her send, and nothing is sent',
    SKIP_WHEN_NO_DB,
    async () => {
      keep = (await messageRows(FIXTURE_IDS.thread1Id)).map((m) => m.id);
      const staffMedia = await plantStaffMedia(FIXTURE_IDS.ownerId);
      planted.push(staffMedia);
      const res = await ownerSend(ownerApp(), FIXTURE_IDS.thread1Id, {
        text: 'look',
        attachment_media_ids: [staffMedia],
      });
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(res.json().error.code, 'not_found');
      assert.equal((await messageRows(FIXTURE_IDS.thread1Id)).length, keep.length);
    },
  );

  test(
    'another family’s media cannot go in her thread, nor hers in theirs: 404 both ways',
    SKIP_WHEN_NO_DB,
    async () => {
      keep = (await messageRows(FIXTURE_IDS.thread1Id)).map((m) => m.id);
      const family = await plantFamily();
      const theirs = await plantOwnerMedia(family.ownerId);
      const mine = await plantOwnerMedia(FIXTURE_IDS.ownerId);
      planted.push(theirs, mine);
      const intoMine = await ownerSend(ownerApp(), FIXTURE_IDS.thread1Id, {
        attachment_media_ids: [theirs],
      });
      assert.equal(intoMine.statusCode, 404, intoMine.body);
      const theirApp = ownerApp(family.principal);
      const theirThread = await startThread(theirApp, { category: 'sessions', text: 'hello' });
      assert.equal(theirThread.statusCode, 201, theirThread.body);
      const threadId = (theirThread.json() as { thread: { id: string } }).thread.id;
      const intoTheirs = await ownerSend(theirApp, threadId, { attachment_media_ids: [mine] });
      assert.equal(intoTheirs.statusCode, 404, intoTheirs.body);
    },
  );

  test(
    'an id named twice: 400 bad_request on the owner send (was a 500), 422 on the staff reply',
    SKIP_WHEN_NO_DB,
    async () => {
      keep = (await messageRows(FIXTURE_IDS.thread1Id)).map((m) => m.id);
      const mine = await plantOwnerMedia(FIXTURE_IDS.ownerId);
      planted.push(mine);
      const twice = await ownerSend(ownerApp(), FIXTURE_IDS.thread1Id, {
        text: 'twice',
        attachment_media_ids: [mine, mine.toUpperCase()],
      });
      assert.equal(twice.statusCode, 400, twice.body);
      assert.equal(twice.json().error.code, 'bad_request');
      const staffTwice = await staffReply(staffApp(), FIXTURE_IDS.thread1Id, {
        text: 'twice',
        attachment_media_ids: [mine, mine],
      });
      assert.equal(staffTwice.statusCode, 422, staffTwice.body);
      assert.equal(staffTwice.json().error.code, 'invalid_payload');
      // Her own photo, once, still sends.
      const once = await ownerSend(ownerApp(), FIXTURE_IDS.thread1Id, {
        attachment_media_ids: [mine],
      });
      assert.equal(once.statusCode, 201, once.body);
    },
  );
});
