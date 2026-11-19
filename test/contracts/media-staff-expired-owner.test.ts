import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, test, type TestContext } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { owners, threads } from '../../src/db/schema/schema.js';
import { registerMediaRoute } from '../../src/routes/media.js';
import { registerStaffThreadsRoute } from '../../src/routes/staffThreads.js';
import {
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeR2Stub, type R2Stub } from './_r2Stub.js';

/**
 * A staff photo in a live thread of an EXPIRED family answers exactly as the staff reply in
 * that thread does (O-MSG-LIVE p2a fix 1, F3; the audit's L4). Both routes resolve the thread
 * through ONE function, `threadsRepository.findOwnerById` (the thread live, nothing about its
 * owner): `POST /staff/threads/:id/messages` and the `message-attachment` arm of
 * `POST /media/upload`. The rule is the reply's; the upload adds no second one.
 *
 * Both are pinned to 201 by name, not merely to each other: an equality pin stays green when both
 * calls fail for one shared, unrelated reason (executed in p2a fix 2: with the Idempotency-Key
 * dropped from both, the reply and the upload each answered 400 and the old pin passed). If the
 * reply's rule is ever changed on purpose, this goes red, and both expectations move together.
 *
 * Executed here, not read: the Parkers' account is expired and their thread is still live.
 */

registerFixtureHooks();

const R2_DELAY_MS = 25;

/** The routes' R2 stub, each call answering after a real delay. */
function makeDelayedR2(): R2Stub {
  const inner = makeR2Stub();
  const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, R2_DELAY_MS));
  return {
    ...inner,
    async signPutUrl(args) {
      await wait();
      return inner.signPutUrl(args);
    },
    async signGetUrl(args) {
      await wait();
      return inner.signGetUrl(args);
    },
    async headObject(args) {
      await wait();
      return inner.headObject(args);
    },
    async getObjectBytes(args) {
      await wait();
      return inner.getObjectBytes(args);
    },
    async putObjectBytes(args) {
      await wait();
      return inner.putObjectBytes(args);
    },
  };
}

// The Parkers: an expired family with a thread nobody expired.
const OWNER_C_ID = randomUUID();
const C_LIVE_THREAD_ID = randomUUID();

before(async () => {
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  await db.insert(owners).values({
    id: OWNER_C_ID,
    supabaseUid: randomUUID(),
    name: 'The Parkers',
    email: `parkers-expired-${OWNER_C_ID}@example.test`,
    phone: '555-0177',
    location: 'bentonville',
    expiredAt: '2026-10-15T12:00:00Z',
  });
  await db.insert(threads).values({
    id: C_LIVE_THREAD_ID,
    ownerId: OWNER_C_ID,
    category: 'sessions',
    title: 'Juniper — leash manners',
    subText: 'with the school',
  });
});

/**
 * Owner delete cascades her threads, their messages, her notifications and media rows. It runs
 * at the end of the test itself: the harness's `after` (registered first, so run first) deletes
 * the fixture staffer, which the staff reply's message still names until this cascade.
 */
async function deleteTheParkers(): Promise<void> {
  await db.delete(owners).where(eq(owners.id, OWNER_C_ID));
}

test(
  'F3: an expired family’s live thread: the staff upload answers exactly as the staff reply does (one thread check)',
  SKIP_WHEN_NO_DB,
  async (t) => {
    try {
      await expiredFamilyCase(t);
    } finally {
      await deleteTheParkers();
    }
  },
);

async function expiredFamilyCase(t: TestContext): Promise<void> {
  const [owner] = await db.select({ expiredAt: owners.expiredAt }).from(owners).where(eq(owners.id, OWNER_C_ID));
  const [thread] = await db
    .select({ expiredAt: threads.expiredAt })
    .from(threads)
    .where(eq(threads.id, C_LIVE_THREAD_ID));
  assert.ok(owner !== undefined && thread !== undefined, 'precondition: the family and the thread exist');
  assert.notEqual(owner.expiredAt, null, 'precondition: the family is expired');
  assert.equal(thread.expiredAt, null, 'precondition: the thread is live');

  const staffThreads = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffThreadsRoute(staffThreads.app, { authenticate: staffThreads.authenticate });
  const reply = await staffThreads.app.inject({
    method: 'POST',
    url: `/staff/threads/${C_LIVE_THREAD_ID}/messages`,
    headers: { 'idempotency-key': `p2a-fix1-reply-${randomUUID()}` },
    payload: { text: 'Juniper did great on the loose-leash walk today.' },
  });

  const media = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerMediaRoute(media.app, { authenticate: media.authenticate, r2: makeDelayedR2() });
  const upload = await media.app.inject({
    method: 'POST',
    url: `/media/upload?purpose=message-attachment&thread_id=${C_LIVE_THREAD_ID}`,
    headers: { 'content-type': 'image/jpeg', 'idempotency-key': `p2a-fix1-upload-${randomUUID()}` },
    payload: Buffer.from('fake-jpeg-bytes-for-an-expired-familys-thread'),
  });

  t.diagnostic(`staff reply ${reply.statusCode}; staff upload ${upload.statusCode}`);
  const both = `reply ${reply.statusCode} ${reply.body}; upload ${upload.statusCode} ${upload.body}`;
  assert.equal(reply.statusCode, 201, `the staff reply in the expired family's live thread is accepted (201): ${both}`);
  assert.equal(upload.statusCode, 201, `the upload must answer as the reply does (201): ${both}`);
}
