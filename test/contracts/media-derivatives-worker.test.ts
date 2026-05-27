import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '../../src/db/client.js';
import { mediaAssets } from '../../src/db/schema/schema.js';
import { mediaAssetsRepository } from '../../src/db/repositories/mediaAssetsRepository.js';
import { mediaDerivativeJobsRepository } from '../../src/db/repositories/mediaDerivativeJobsRepository.js';
import { runMediaDerivativesOnce } from '../../src/workers/mediaDerivatives.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { makeR2Stub, type R2Stub } from './_r2Stub.js';

/**
 * Day-17 contract tests for the media-derivatives worker. Real sharp +
 * blurhash run against an in-process synthesized PNG; R2 IO routes
 * through the stub so the DB is the only real-world thing the test
 * touches.
 *
 * Coverage:
 *  - Empty queue → scanned: 0, no calls to R2.
 *  - Image source → 3 derivative WebPs written to R2 with the expected
 *    sizes; media_assets.derivatives + width/height/blurhash populated;
 *    job flips to 'done'.
 *  - Video source → job flips to 'failed' with a clear last_error; no
 *    R2 puts; source row stays usable at original size.
 *  - R2 putObject transport failure → job flips to 'failed' with the
 *    error message captured; source row unchanged.
 *  - SKIP LOCKED ordering — claim flips pending → processing in one
 *    statement so a second worker tick on a re-claimed batch finds
 *    nothing.
 */

registerFixtureHooks();

/** Synthesize a real PNG in-memory so sharp can decode it deterministically. */
async function makePngBytes(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

async function seedAssetAndJob(args: {
  kind: 'image' | 'video';
  bytes: Uint8Array;
  contentType: string;
  r2: R2Stub;
}): Promise<{ assetId: string; jobId: string; objectKey: string }> {
  const objectKey = `owner-avatar/owner-test/${randomUUID()}.bin`;
  args.r2.seedObject({ key: objectKey, contentType: args.contentType, bytes: args.bytes });

  // Insert the asset row directly — these tests skip the route plumbing
  // and exercise the worker against a known DB state. The route tests
  // already cover INSERT semantics.
  let assetId = '';
  let jobId = '';
  await db.transaction(async (tx) => {
    const asset = await mediaAssetsRepository.create(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      kind: args.kind,
      purpose: 'owner-avatar',
      objectKey,
      contentType: args.contentType,
      bytes: args.bytes.byteLength,
      createdBy: 'owner',
    });
    assetId = asset.id;
    const job = await mediaDerivativeJobsRepository.enqueue(tx, { mediaAssetId: asset.id });
    jobId = job!.id;
  });
  return { assetId, jobId, objectKey };
}

test('runMediaDerivativesOnce — empty queue returns scanned:0', SKIP_WHEN_NO_DB, async () => {
  const r2 = makeR2Stub();
  const result = await runMediaDerivativesOnce({ r2, limit: 5 });
  assert.equal(result.scanned, 0);
  assert.deepStrictEqual(result.results, []);
  assert.equal(r2.calls.length, 0);
});

test(
  'runMediaDerivativesOnce — image source produces 3 derivatives + blurhash + dims',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2 = makeR2Stub();
    const png = await makePngBytes(800, 600);
    const { assetId, jobId } = await seedAssetAndJob({
      kind: 'image',
      bytes: png,
      contentType: 'image/png',
      r2,
    });

    const result = await runMediaDerivativesOnce({ r2, limit: 5 });
    assert.equal(result.scanned, 1);
    assert.equal(result.results.length, 1);
    const job = result.results[0]!;
    assert.equal(job.outcome, 'done');
    assert.equal(job.derivativesCount, 3);

    // 3 WebP keys landed in R2 under `derivative/<label>/<asset-id>/...webp`.
    const derivativeKeys = Array.from(r2.objects.keys()).filter((k) => k.startsWith('derivative/'));
    assert.equal(derivativeKeys.length, 3, `expected 3 derivatives, got ${derivativeKeys.length}`);
    for (const label of ['thumb', 'feed', 'lightbox']) {
      assert.ok(
        derivativeKeys.some((k) => k.startsWith(`derivative/${label}/${assetId}/`)),
        `missing ${label} derivative`,
      );
    }

    // media_assets row updated with manifest + dims + blurhash.
    const row = await mediaAssetsRepository.findById(assetId);
    assert.equal(row!.width, 800);
    assert.equal(row!.height, 600);
    assert.equal(row!.derivatives.length, 3);
    assert.ok(row!.blurhash !== null && row!.blurhash.length > 0, 'blurhash should be populated');

    // The 'thumb' WebP that landed in R2 is decodable by sharp at the
    // requested width (200) — proves the pipeline produced real bytes.
    const thumbDerivative = row!.derivatives.find((d) => d.label === 'thumb');
    assert.ok(thumbDerivative, 'thumb derivative present');
    const thumbObject = r2.objects.get(thumbDerivative!.objectKey)!;
    const thumbMetadata = await sharp(Buffer.from(thumbObject.bytes)).metadata();
    assert.equal(thumbMetadata.width, 200);
    assert.equal(thumbMetadata.format, 'webp');

    // Job flipped 'done'.
    const jobRow = await mediaDerivativeJobsRepository.findByMediaAssetId(db, assetId);
    assert.equal(jobRow!.status, 'done');
    assert.equal(jobRow!.id, jobId);
    assert.ok(jobRow!.attempts >= 1, 'attempts should have been incremented');
  },
);

test(
  'runMediaDerivativesOnce — video source parks job with clear last_error',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2 = makeR2Stub();
    // A tiny placeholder video byte sequence — the worker should never
    // call sharp on it (it short-circuits on kind='video' before reading).
    const placeholder = new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112]);
    const { assetId } = await seedAssetAndJob({
      kind: 'video',
      bytes: placeholder,
      contentType: 'video/mp4',
      r2,
    });

    const result = await runMediaDerivativesOnce({ r2, limit: 5 });
    assert.equal(result.scanned, 1);
    assert.equal(result.results[0]!.outcome, 'failed-video');

    // No R2 puts (no derivatives produced).
    assert.equal(
      r2.calls.filter((c) => c.method === 'putObjectBytes').length,
      0,
      'video should not trigger R2 puts',
    );

    // Job parked with a clear last_error.
    const job = await mediaDerivativeJobsRepository.findByMediaAssetId(db, assetId);
    assert.equal(job!.status, 'failed');
    assert.match(job!.lastError ?? '', /video derivatives not yet implemented/);

    // Source row stays usable at original size — derivatives empty, dims null.
    const row = await mediaAssetsRepository.findById(assetId);
    assert.equal(row!.derivatives.length, 0);
  },
);

test(
  'runMediaDerivativesOnce — R2 putObject failure parks job + leaves source usable',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2 = makeR2Stub();
    const png = await makePngBytes(400, 300);
    const { assetId } = await seedAssetAndJob({
      kind: 'image',
      bytes: png,
      contentType: 'image/png',
      r2,
    });

    // Make the FIRST putObjectBytes throw — the worker will run sharp,
    // attempt to upload the thumb, fail, and park the job.
    r2.throwOnNextPutObject();

    const result = await runMediaDerivativesOnce({ r2, limit: 5 });
    assert.equal(result.results[0]!.outcome, 'failed-other');
    assert.match(result.results[0]!.error ?? '', /R2 putObject/);

    // Job parked, source row's derivatives still empty.
    const job = await mediaDerivativeJobsRepository.findByMediaAssetId(db, assetId);
    assert.equal(job!.status, 'failed');
    const row = await mediaAssetsRepository.findById(assetId);
    assert.equal(row!.derivatives.length, 0);
  },
);

test(
  'runMediaDerivativesOnce — claim is atomic: a second concurrent tick processes nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const r2A = makeR2Stub();
    const r2B = makeR2Stub();
    const png = await makePngBytes(200, 200);
    const { assetId } = await seedAssetAndJob({
      kind: 'image',
      bytes: png,
      contentType: 'image/png',
      r2: r2A,
    });
    // Share the source-key data into r2B so if tick B somehow claimed
    // the row it could actually read the source — but it shouldn't claim
    // it because tick A already flipped status to 'processing'.
    const sourceKey = (
      await db
        .select({ objectKey: mediaAssets.objectKey })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, assetId))
    )[0]!.objectKey;
    r2B.seedObject({ key: sourceKey, contentType: 'image/png', bytes: png });

    // Run both ticks sequentially — the second should see 0 work even
    // though the first will eventually mark 'done'. (True concurrent
    // execution against a single connection is tricky to test without
    // multiple workers; this proves the status-filter half of the
    // claim invariant. The FOR UPDATE SKIP LOCKED half is structural.)
    const resA = await runMediaDerivativesOnce({ r2: r2A, limit: 5 });
    const resB = await runMediaDerivativesOnce({ r2: r2B, limit: 5 });
    assert.equal(resA.scanned, 1);
    assert.equal(resB.scanned, 0, 'second tick should see no pending rows after the first claimed');
  },
);
