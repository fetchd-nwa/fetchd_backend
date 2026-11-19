import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { and, count, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { mediaAssets, mediaDerivativeJobs, owners, threads } from '../../src/db/schema/schema.js';
import { registerMediaRoute } from '../../src/routes/media.js';
import type { Principal } from '../../src/auth/principal.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeR2Stub, type R2Stub } from './_r2Stub.js';

/**
 * Staff photos and videos in a conversation (O-MSG-LIVE pass 2a; her answer 6, DECISIONS
 * 589: up to 25 MB, no PDFs; design §4 W7, A2 OL5, A2.5 item 4; mechanic 24; CR4; CR10;
 * `PostMediaUploadMessageAttachmentQuery`'s doc in wire.ts 9.2.0).
 *
 *   - `POST /media/upload?purpose=message-attachment&thread_id=<uuid>` (the portal's
 *     proxy): the row is stamped with THAT thread's owner and `created_by = 'staff'`; a
 *     missing or expired thread is 404, a malformed id 400.
 *   - `DELETE /media/:id`: an owner deleting a `created_by = 'staff'` row gets 404 and the
 *     row stays live — Amber's photo of the scrape on Waffles' paw is the school's record,
 *     not Allison's to remove. That also covers staff REPORT media stamped with her id
 *     (A2.5 item 4, named: an existing route's behaviour changes beyond messaging). Her own
 *     attachment still deletes (204). The `thread.changed` publish on an attachment's
 *     removal is pass 3's.
 *
 * Photos are unprovable in a clone build (R2's endpoint is hard-coded, CR10): every R2 call
 * here goes to the routes' injected stub, answering its real shape after a real delay.
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

// The Hendersons: a second family, so the stamp provably follows the THREAD's owner.
const OWNER_B_ID = randomUUID();
const B_THREAD_ID = randomUUID();
const B_EXPIRED_THREAD_ID = randomUUID();

before(async () => {
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  await db.insert(owners).values({
    id: OWNER_B_ID,
    supabaseUid: randomUUID(),
    name: 'The Hendersons',
    email: `hendersons-media-${OWNER_B_ID}@example.test`,
    phone: '555-0143',
    location: 'fayetteville',
  });
  await db.insert(threads).values([
    {
      id: B_THREAD_ID,
      ownerId: OWNER_B_ID,
      category: 'sessions',
      title: 'Biscuit — recall',
      subText: 'with the school',
    },
    {
      id: B_EXPIRED_THREAD_ID,
      ownerId: OWNER_B_ID,
      category: 'other',
      title: 'An old conversation',
      subText: 'with the school',
      expiredAt: '2026-10-01T12:00:00Z',
    },
  ]);
});

after(async () => {
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  // Owner delete cascades her threads and media rows (and their derivative jobs).
  await db.delete(owners).where(eq(owners.id, OWNER_B_ID));
});

const JPEG = Buffer.from('fake-jpeg-bytes-for-a-staff-conversation-photo');

function staffApp(r2: R2Stub): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerMediaRoute(app, { authenticate, r2 });
  return app;
}

function ownerApp(r2: R2Stub, principal: Principal = FIXTURE_OWNER_PRINCIPAL): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(principal);
  registerMediaRoute(app, { authenticate, r2 });
  return app;
}

function upload(
  app: ReturnType<typeof staffApp>,
  query: string,
  opts: { contentType?: string; key?: string; bytes?: Buffer } = {},
): ReturnType<ReturnType<typeof staffApp>['inject']> {
  return app.inject({
    method: 'POST',
    url: `/media/upload?${query}`,
    headers: {
      'content-type': opts.contentType ?? 'image/jpeg',
      'idempotency-key': opts.key ?? `p2a-upload-${randomUUID()}`,
    },
    payload: opts.bytes ?? JPEG,
  });
}

function del(app: ReturnType<typeof staffApp>, id: string): ReturnType<ReturnType<typeof staffApp>['inject']> {
  return app.inject({
    method: 'DELETE',
    url: `/media/${id}`,
    headers: { 'idempotency-key': `p2a-del-${randomUUID()}` },
  });
}

async function mediaRowCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(mediaAssets);
  return row?.n ?? 0;
}

async function rawRow(id: string): Promise<
  | {
      ownerId: string;
      dogId: string | null;
      reportId: string | null;
      purpose: string;
      kind: string;
      createdBy: string;
      objectKey: string;
      bytes: number;
      expiredAt: string | null;
    }
  | undefined
> {
  const [row] = await db
    .select({
      ownerId: mediaAssets.ownerId,
      dogId: mediaAssets.dogId,
      reportId: mediaAssets.reportId,
      purpose: mediaAssets.purpose,
      kind: mediaAssets.kind,
      createdBy: mediaAssets.createdBy,
      objectKey: mediaAssets.objectKey,
      bytes: mediaAssets.bytes,
      expiredAt: mediaAssets.expiredAt,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id));
  return row === undefined ? undefined : { ...row, bytes: Number(row.bytes) };
}

function errorCode(res: { json(): unknown }): string {
  return (res.json() as { error: { code: string } }).error.code;
}

// ---------------------------------------------------------------------------
// POST /media/upload — the message-attachment arm (W7)
// ---------------------------------------------------------------------------

test(
  'W7: a staff photo for a thread is stamped with THAT thread’s owner and created_by = staff',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2 = makeDelayedR2();
    const res = await upload(staffApp(r2), `purpose=message-attachment&thread_id=${B_THREAD_ID}`);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { id: string; purpose: string; kind: string; url: string };
    assert.equal(body.purpose, 'message-attachment');
    assert.equal(body.kind, 'image');
    assert.ok(body.url.startsWith('https://stub.r2.invalid/message-attachment/'), body.url);

    const put = r2.calls.find((c) => c.method === 'putObjectBytes');
    assert.ok(put, 'the server streamed the bytes to R2');
    assert.ok(
      put.key.startsWith(`message-attachment/staff-${FIXTURE_IDS.staffDonavanId}/`),
      `server-generated key in the staffer's scope: ${put.key}`,
    );
    assert.deepEqual(await rawRow(body.id), {
      ownerId: OWNER_B_ID,
      dogId: null,
      reportId: null,
      purpose: 'message-attachment',
      kind: 'image',
      createdBy: 'staff',
      objectKey: put.key,
      bytes: JPEG.byteLength,
      expiredAt: null,
    });
    const jobs = await db
      .select({ id: mediaDerivativeJobs.id })
      .from(mediaDerivativeJobs)
      .where(eq(mediaDerivativeJobs.mediaAssetId, body.id));
    assert.equal(jobs.length, 1, 'a derivatives job, as for every other upload');
  },
);

test('W7: a staff video for a thread → 201, kind video', SKIP_WHEN_NO_DB, async () => {
  const r2 = makeDelayedR2();
  const res = await upload(staffApp(r2), `purpose=message-attachment&thread_id=${B_THREAD_ID}`, {
    contentType: 'video/mp4',
    bytes: Buffer.from('fake-mp4-bytes'),
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as { kind: string }).kind, 'video');
  assert.equal((await rawRow((res.json() as { id: string }).id))?.ownerId, OWNER_B_ID);
});

test(
  'W7: a thread that does not exist, or is expired, is 404 not_found and writes no row',
  SKIP_WHEN_NO_DB,
  async () => {
    const before = await mediaRowCount();
    for (const threadId of ['99999999-9999-4999-8999-99999999a7a7', B_EXPIRED_THREAD_ID]) {
      const res = await upload(staffApp(makeDelayedR2()), `purpose=message-attachment&thread_id=${threadId}`);
      assert.equal(res.statusCode, 404, `${threadId}: ${res.body}`);
      assert.equal(errorCode(res), 'not_found');
    }
    assert.equal(await mediaRowCount(), before, 'no media row for a 404');
  },
);

test(
  'W7: a malformed thread_id is 400 bad_request, before any R2 call (CR4: every new id is a uuid)',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2 = makeDelayedR2();
    for (const threadId of ['not-a-uuid', '', '11111111-1111-4111-8111-aaaaaaaaaaa1x']) {
      const res = await upload(staffApp(r2), `purpose=message-attachment&thread_id=${threadId}`);
      assert.equal(res.statusCode, 400, `'${threadId}': ${res.body}`);
      assert.equal(errorCode(res), 'bad_request');
    }
    const missing = await upload(staffApp(r2), 'purpose=message-attachment');
    assert.equal(missing.statusCode, 400, 'thread_id is required on this arm');
    assert.equal(r2.calls.length, 0, 'nothing reached R2');
  },
);

test(
  'W7: the two arms do not mix — a thread on the report arm, or a report on this arm, is 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2 = makeDelayedR2();
    const mixed = await upload(
      staffApp(r2),
      `purpose=message-attachment&thread_id=${B_THREAD_ID}&report_id=${FIXTURE_IDS.reportFoundationId}`,
    );
    assert.equal(mixed.statusCode, 400, mixed.body);
    const reportWithThread = await upload(
      staffApp(r2),
      `purpose=report-photo&thread_id=${B_THREAD_ID}`,
    );
    assert.equal(reportWithThread.statusCode, 400, reportWithThread.body);
    assert.equal(r2.calls.length, 0);
  },
);

test('W7: no PDFs (her answer 6; MSG-U22 is later) → 400', SKIP_WHEN_NO_DB, async () => {
  const r2 = makeDelayedR2();
  const res = await upload(staffApp(r2), `purpose=message-attachment&thread_id=${B_THREAD_ID}`, {
    contentType: 'application/pdf',
    bytes: Buffer.from('%PDF-1.7 fake'),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(r2.calls.length, 0, 'refused before R2');
});

test('W7: the arm is staff-only — an owner is 403', SKIP_WHEN_NO_DB, async () => {
  const res = await upload(ownerApp(makeDelayedR2()), `purpose=message-attachment&thread_id=${FIXTURE_IDS.thread1Id}`);
  assert.equal(res.statusCode, 403, res.body);
});

test(
  'W7: the Idempotency-Key covers the query — a replay is the first row; another thread under the same key is 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2 = makeDelayedR2();
    const key = `p2a-upload-replay-${randomUUID()}`;
    const first = await upload(staffApp(r2), `purpose=message-attachment&thread_id=${B_THREAD_ID}`, { key });
    const replay = await upload(staffApp(r2), `purpose=message-attachment&thread_id=${B_THREAD_ID}`, { key });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal((replay.json() as { id: string }).id, (first.json() as { id: string }).id);
    const other = await upload(
      staffApp(r2),
      `purpose=message-attachment&thread_id=${FIXTURE_IDS.thread1Id}`,
      { key },
    );
    assert.equal(other.statusCode, 422, other.body);
    assert.equal(errorCode(other), 'idempotency_mismatch');
  },
);

// ---------------------------------------------------------------------------
// DELETE /media/:id — an owner cannot remove what the school uploaded (OL5)
// ---------------------------------------------------------------------------

test(
  'OL5: Allison deleting Amber’s photo in her own thread gets 404, and the photo stays live',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2 = makeDelayedR2();
    const up = await upload(staffApp(r2), `purpose=message-attachment&thread_id=${FIXTURE_IDS.thread1Id}`);
    assert.equal(up.statusCode, 201, up.body);
    const id = (up.json() as { id: string }).id;
    assert.equal((await rawRow(id))?.ownerId, FIXTURE_IDS.ownerId, 'stamped with her id');

    const res = await del(ownerApp(r2), id);
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(errorCode(res), 'not_found');
    assert.equal((await rawRow(id))?.expiredAt, null, 'the row stays live');

    // She can still see it: reading is unchanged.
    const read = await ownerApp(r2).inject({ method: 'GET', url: `/media/${id}` });
    assert.equal(read.statusCode, 200, read.body);
  },
);

test(
  'OL5 (A2.5 item 4, named): staff REPORT media stamped with her id is not hers to delete either — 404, row live; staff still can',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2 = makeDelayedR2();
    const up = await upload(
      staffApp(r2),
      `purpose=report-photo&report_id=${FIXTURE_IDS.reportFoundationId}`,
      { contentType: 'image/png' },
    );
    assert.equal(up.statusCode, 201, up.body);
    const id = (up.json() as { id: string }).id;
    assert.equal((await rawRow(id))?.ownerId, FIXTURE_IDS.ownerId);

    const res = await del(ownerApp(r2), id);
    assert.equal(res.statusCode, 404, res.body);
    assert.equal((await rawRow(id))?.expiredAt, null);

    const staffDel = await del(staffApp(r2), id);
    assert.equal(staffDel.statusCode, 204, staffDel.body);
    assert.notEqual((await rawRow(id))?.expiredAt, null);
  },
);

test('OL5: her own attachment still deletes — 204, expired', SKIP_WHEN_NO_DB, async () => {
  const r2 = makeDelayedR2();
  const key = `message-attachment/owner-${FIXTURE_IDS.ownerId}/${randomUUID()}.jpg`;
  r2.seedObject({ key, contentType: 'image/jpeg', bytes: new Uint8Array(2048) });
  const created = await ownerApp(r2).inject({
    method: 'POST',
    url: '/media',
    headers: { 'idempotency-key': `p2a-own-${randomUUID()}` },
    payload: { key, purpose: 'message-attachment' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = (created.json() as { id: string }).id;
  assert.equal((await rawRow(id))?.createdBy, 'owner');

  const res = await del(ownerApp(r2), id);
  assert.equal(res.statusCode, 204, res.body);
  assert.notEqual((await rawRow(id))?.expiredAt, null);
});

test('OL5: another family’s staff photo is 404 to her too (existence never leaks)', SKIP_WHEN_NO_DB, async () => {
  const r2 = makeDelayedR2();
  const up = await upload(staffApp(r2), `purpose=message-attachment&thread_id=${B_THREAD_ID}`);
  const id = (up.json() as { id: string }).id;
  const res = await del(ownerApp(r2), id);
  assert.equal(res.statusCode, 404);
  const [row] = await db
    .select({ n: count() })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, id), eq(mediaAssets.ownerId, OWNER_B_ID)));
  assert.equal(row?.n, 1);
  assert.equal((await rawRow(id))?.expiredAt, null);
});
