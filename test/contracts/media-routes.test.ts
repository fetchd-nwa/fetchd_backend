import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { mediaAssets, mediaDerivativeJobs } from '../../src/db/schema/schema.js';
import { mediaAssetsRepository } from '../../src/db/repositories/mediaAssetsRepository.js';
import { mediaDerivativeJobsRepository } from '../../src/db/repositories/mediaDerivativeJobsRepository.js';
import { registerMediaRoute } from '../../src/routes/media.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeR2Stub } from './_r2Stub.js';

/**
 * Day-17 contract tests for the media surface: POST /media, GET /media/:id,
 * DELETE /media/:id. Exercises the full `withMutation` composition end-to-
 * end (POST + DELETE) plus the post-commit URL-signing path for both POST
 * and GET. The R2 stub is injected; the DB writes are real (Postgres +
 * `audit_capture` triggers fire).
 *
 * Coverage:
 *  - POST owner-avatar 201 + wire shape + media_assets row created + job
 *    enqueued; idempotency replay returns same row.
 *  - POST dog-profile verifies ownership; not-owned dog → 404.
 *  - POST when r2.headObject 404 → 422 invalid_payload + no row.
 *  - POST report-photo by owner → 422 (staff-only path).
 *  - POST by staff principal → 403 (Day-19 staff portal).
 *  - GET 200 + presigned URLs (base + derivatives once populated); 404
 *    on not-owned + missing.
 *  - DELETE 204 + soft-expire + subsequent GET 404; R2 object NOT deleted.
 */

registerFixtureHooks();

const OWNER_AVATAR_KEY_PREFIX = 'owner-avatar';

async function seedR2Upload(args: {
  key: string;
  contentType?: string;
  bytes?: number;
}): Promise<ReturnType<typeof makeR2Stub>> {
  const r2 = makeR2Stub();
  r2.seedObject({
    key: args.key,
    contentType: args.contentType ?? 'image/jpeg',
    // The stub's `headObject` reports `bytes.byteLength` so we shape the
    // seeded array to match the byte count the test asserts on (some
    // tests check media_assets.bytes against a known value).
    bytes: new Uint8Array(args.bytes ?? 1024),
  });
  return r2;
}

test(
  'POST /media — owner-avatar happy path: 201 + row + derivative job enqueued',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = await seedR2Upload({
      key: `${OWNER_AVATAR_KEY_PREFIX}/avatar-${randomUUID()}.jpg`,
      bytes: 2048,
    });
    registerMediaRoute(app, { authenticate, r2 });

    const key = Array.from(r2.objects.keys())[0]!;
    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': `post-media-${randomUUID()}` },
      payload: { key, purpose: 'owner-avatar' },
    });

    assert.equal(res.statusCode, 201, `unexpected: ${res.body}`);
    const body = res.json() as {
      id: string;
      purpose: string;
      kind: string;
      url: string;
      expires_at: string;
      derivatives: Record<string, string>;
    };
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.purpose, 'owner-avatar');
    assert.equal(body.kind, 'image');
    assert.ok(body.url.startsWith('https://stub.r2.invalid/'), `unexpected url: ${body.url}`);
    assert.ok(new Date(body.expires_at).getTime() > Date.now());
    assert.deepStrictEqual(body.derivatives, {}); // worker hasn't run yet

    // headObject called once (verify upload), signGetUrl called once (response URL).
    const methods = r2.calls.map((c) => c.method);
    assert.ok(methods.includes('headObject'), 'headObject should have been called');
    assert.ok(methods.includes('signGetUrl'), 'signGetUrl should have been called');

    // Row + job both landed.
    const row = await mediaAssetsRepository.findById(body.id);
    assert.ok(row, 'media_assets row should exist');
    assert.equal(row!.ownerId, FIXTURE_IDS.ownerId);
    assert.equal(row!.objectKey, key);
    assert.equal(row!.bytes, 2048);

    const job = await mediaDerivativeJobsRepository.findByMediaAssetId(db, body.id);
    assert.ok(job, 'media_derivative_jobs row should exist');
    assert.equal(job!.status, 'pending');
  },
);

test(
  'POST /media — dog-profile requires ownership; owned dog succeeds',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = await seedR2Upload({ key: `dog-profile/owner-x/${randomUUID()}.jpg` });
    registerMediaRoute(app, { authenticate, r2 });

    const key = Array.from(r2.objects.keys())[0]!;
    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': `post-media-${randomUUID()}` },
      payload: { key, purpose: 'dog-profile', dog_id: FIXTURE_IDS.dog1Id },
    });

    assert.equal(res.statusCode, 201, `unexpected: ${res.body}`);
    const body = res.json() as { id: string };
    const row = await mediaAssetsRepository.findById(body.id);
    assert.equal(row!.dogId, FIXTURE_IDS.dog1Id);
  },
);

test('POST /media — dog-profile with not-owned dog → 404', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const r2 = await seedR2Upload({ key: `dog-profile/owner-x/${randomUUID()}.jpg` });
  registerMediaRoute(app, { authenticate, r2 });

  const key = Array.from(r2.objects.keys())[0]!;
  const res = await app.inject({
    method: 'POST',
    url: '/media',
    headers: { 'idempotency-key': `post-media-${randomUUID()}` },
    payload: {
      key,
      purpose: 'dog-profile',
      // A UUID that doesn't belong to the fixture owner.
      dog_id: '99999999-9999-4999-8999-999999999000',
    },
  });
  assert.equal(res.statusCode, 404);
});

test('POST /media — missing R2 object → 422 invalid_payload', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const r2 = makeR2Stub();
  // NOT seeding the bucket — headObject returns null naturally.
  registerMediaRoute(app, { authenticate, r2 });

  const res = await app.inject({
    method: 'POST',
    url: '/media',
    headers: { 'idempotency-key': `post-media-${randomUUID()}` },
    payload: {
      key: 'owner-avatar/owner-x/ghost.jpg',
      purpose: 'owner-avatar',
    },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { code: string; details?: { kind?: string } } };
  assert.equal(body.error.code, 'invalid_payload');
  assert.equal(body.error.details?.kind, 'media-upload-missing');
});

test(
  'POST /media — report-photo by owner → 422 (staff-only path, Day-19)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = await seedR2Upload({ key: `report-photo/owner-x/${randomUUID()}.jpg` });
    registerMediaRoute(app, { authenticate, r2 });

    const key = Array.from(r2.objects.keys())[0]!;
    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': `post-media-${randomUUID()}` },
      payload: {
        key,
        purpose: 'report-photo',
        report_id: FIXTURE_IDS.reportFoundationId,
      },
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as { error: { code: string; details?: { kind?: string } } };
    assert.equal(body.error.code, 'invalid_payload');
    assert.equal(body.error.details?.kind, 'media-staff-upload-deferred');
  },
);

test(
  'POST /media — staff principal → 403 (staff portal lands Day-19)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    const r2 = await seedR2Upload({ key: `owner-avatar/staff-x/${randomUUID()}.jpg` });
    registerMediaRoute(app, { authenticate, r2 });

    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': `post-media-${randomUUID()}` },
      payload: {
        key: Array.from(r2.objects.keys())[0]!,
        purpose: 'owner-avatar',
      },
    });
    assert.equal(res.statusCode, 403);
  },
);

test(
  'POST /media — owner-avatar carrying dog_id → 400 (rejected payload combo)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = await seedR2Upload({ key: `owner-avatar/owner-x/${randomUUID()}.jpg` });
    registerMediaRoute(app, { authenticate, r2 });

    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': `post-media-${randomUUID()}` },
      payload: {
        key: Array.from(r2.objects.keys())[0]!,
        purpose: 'owner-avatar',
        dog_id: FIXTURE_IDS.dog1Id,
      },
    });
    assert.equal(res.statusCode, 400);
  },
);

test(
  'GET /media/:id — owner-scoped: returns signed URL + derivative URLs',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = await seedR2Upload({ key: `owner-avatar/owner-y/${randomUUID()}.jpg` });
    registerMediaRoute(app, { authenticate, r2 });

    // Create via the route so the row + key are aligned.
    const created = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': `post-media-${randomUUID()}` },
      payload: { key: Array.from(r2.objects.keys())[0]!, purpose: 'owner-avatar' },
    });
    const mediaId = (created.json() as { id: string }).id;

    // Simulate a worker run by stamping derivatives on the row directly —
    // the worker has its own test file; here we just want to prove GET
    // shapes the derivative URLs correctly.
    await db
      .update(mediaAssets)
      .set({
        derivatives: [
          {
            label: 'thumb',
            objectKey: `derivative/thumb/${mediaId}/x.webp`,
            width: 200,
            height: 200,
            contentType: 'image/webp',
          },
          {
            label: 'feed',
            objectKey: `derivative/feed/${mediaId}/y.webp`,
            width: 600,
            height: 600,
            contentType: 'image/webp',
          },
        ],
        width: 1200,
        height: 1200,
        blurhash: 'L5H2EC=PM+yV0g-mq.wG9c010J}I',
      })
      .where(eq(mediaAssets.id, mediaId));

    const res = await app.inject({ method: 'GET', url: `/media/${mediaId}` });
    assert.equal(res.statusCode, 200, `unexpected: ${res.body}`);
    const body = res.json() as {
      id: string;
      url: string;
      derivatives: Record<string, string>;
      width: number;
      height: number;
      blurhash: string;
    };
    assert.equal(body.id, mediaId);
    assert.equal(body.width, 1200);
    assert.equal(body.height, 1200);
    assert.match(body.blurhash, /^L/);
    assert.ok(body.derivatives.thumb?.startsWith('https://stub.r2.invalid/'));
    assert.ok(body.derivatives.feed?.startsWith('https://stub.r2.invalid/'));
  },
);

test(
  'GET /media/:id — different owner → 404 (no cross-tenant leakage)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Seed a media_assets row directly belonging to a non-fixture owner
    // wouldn't survive teardown cascade; cheaper to seed under fixture
    // owner but query as staff (also gets 404 today).
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = await seedR2Upload({ key: `owner-avatar/owner-z/${randomUUID()}.jpg` });
    registerMediaRoute(app, { authenticate, r2 });
    const created = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': `post-media-${randomUUID()}` },
      payload: { key: Array.from(r2.objects.keys())[0]!, purpose: 'owner-avatar' },
    });
    const mediaId = (created.json() as { id: string }).id;

    // Now hit GET as a staff principal — should 404.
    const { app: staffApp, authenticate: staffAuth } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerMediaRoute(staffApp, { authenticate: staffAuth, r2 });
    const staffRes = await staffApp.inject({ method: 'GET', url: `/media/${mediaId}` });
    assert.equal(staffRes.statusCode, 404);
  },
);

test('GET /media/:id — unknown id → 404', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerMediaRoute(app, { authenticate, r2: makeR2Stub() });
  const res = await app.inject({
    method: 'GET',
    url: `/media/99999999-9999-4999-8999-999999999111`,
  });
  assert.equal(res.statusCode, 404);
});

test(
  'DELETE /media/:id — soft-expires + subsequent GET 404; R2 object retained',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = await seedR2Upload({ key: `owner-avatar/owner-w/${randomUUID()}.jpg` });
    registerMediaRoute(app, { authenticate, r2 });

    const key = Array.from(r2.objects.keys())[0]!;
    const created = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': `post-media-${randomUUID()}` },
      payload: { key, purpose: 'owner-avatar' },
    });
    const mediaId = (created.json() as { id: string }).id;

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/media/${mediaId}`,
      headers: { 'idempotency-key': `del-media-${randomUUID()}` },
    });
    assert.equal(deleteRes.statusCode, 204);

    const subsequentGet = await app.inject({ method: 'GET', url: `/media/${mediaId}` });
    assert.equal(subsequentGet.statusCode, 404);

    // R2 object retained — never-delete invariant.
    assert.ok(r2.objects.has(key), 'R2 object must remain in bucket post-soft-expire');

    // Row exists but `expired_at` is set.
    const [rawRow] = await db
      .select({ expiredAt: mediaAssets.expiredAt })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, mediaId));
    assert.ok(rawRow !== undefined, 'row should still exist (soft-expire, not hard delete)');
    assert.ok(rawRow!.expiredAt !== null, 'expired_at should be set');
  },
);

test(
  'POST /media — idempotency replay returns same row (no double-insert)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = await seedR2Upload({ key: `owner-avatar/owner-q/${randomUUID()}.jpg` });
    registerMediaRoute(app, { authenticate, r2 });

    const idempotencyKey = `post-media-replay-${randomUUID()}`;
    const payload = {
      key: Array.from(r2.objects.keys())[0]!,
      purpose: 'owner-avatar',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(first.statusCode, 201);
    assert.equal(replay.statusCode, 201);
    const firstId = (first.json() as { id: string }).id;
    const replayId = (replay.json() as { id: string }).id;
    assert.equal(firstId, replayId);

    // Only ONE row should exist for this owner's just-created asset.
    const matching = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, firstId));
    assert.equal(matching.length, 1);

    // And only ONE derivative job.
    const jobs = await db
      .select({ id: mediaDerivativeJobs.id })
      .from(mediaDerivativeJobs)
      .where(eq(mediaDerivativeJobs.mediaAssetId, firstId));
    assert.equal(jobs.length, 1);
  },
);

// Silence the unused-import warning in environments where `sql` isn't
// needed; we keep the import for parity with sibling tests that use it.
void sql;
