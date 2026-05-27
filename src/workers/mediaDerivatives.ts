import { randomUUID } from 'node:crypto';
import { encode as encodeBlurhash } from 'blurhash';
import sharp from 'sharp';
import {
  mediaAssetsRepository,
  type MediaAssetRow,
  type MediaDerivative,
} from '../db/repositories/mediaAssetsRepository.js';
import {
  mediaDerivativeJobsRepository,
  type MediaDerivativeJobRow,
} from '../db/repositories/mediaDerivativeJobsRepository.js';
import { withActor } from '../db/tx.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';

interface WorkerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Media derivatives worker (Day 17). Composed as the fourth phase of
 * `runSchedulerTickOnce` so one cron firing handles outbound notifications,
 * invoice dunning, idempotency-key sweep, AND derivative generation. Pattern
 * matches the other workers: one-shot function, injectable seam, returns a
 * per-job result summary.
 *
 * Per-tick lifecycle (split into THREE tx scopes — different from
 * scheduled-notifications which holds one tx for all rows):
 *
 *   1. **Claim tx** (`system:scheduler` actor) — atomic SELECT FOR UPDATE
 *      SKIP LOCKED + UPDATE to flip `status='processing'`. Commits
 *      immediately so the pg connection isn't held during sharp CPU work.
 *   2. **Out-of-tx processing** — for each claimed job: get the source
 *      bytes from R2 → sharp pipeline (resize to thumb/feed/lightbox,
 *      blurhash, dimensions) → put each derivative back to R2.
 *   3. **Settle tx** (one per job, `system:scheduler` actor) — update the
 *      media_assets row with the derivatives manifest + blurhash + dims,
 *      then `markDone` the job. On any sharp/R2 failure inside step 2,
 *      the settle tx instead `markFailed`s the job with `last_error`
 *      captured.
 *
 * Why three tx scopes instead of one big one (Day-16 pattern): sharp is
 * CPU-bound (libvips native) and a single image takes ~200-500ms. Holding
 * a pg connection across that latency would starve the pool under
 * even modest concurrency. The cost: a worker crash between claim and
 * settle leaves the row 'processing' forever — Day-20 observability
 * sweeps stalled rows back to 'pending'.
 *
 * Video (`media_kind='video'`) is deferred to a later day — ffmpeg has
 * its own binary-distribution + native-deps story to do right. Today
 * video jobs are claimed, immediately marked 'failed' with a clear
 * `last_error`, and the source remains usable at original size.
 */

/** sharp output sizes — thumb/feed/lightbox triple. */
const DERIVATIVE_SIZES = [
  { label: 'thumb', width: 200 },
  { label: 'feed', width: 600 },
  { label: 'lightbox', width: 1200 },
] as const;

/** Blurhash component counts — 4×3 is the sweet spot for landscape thumbs. */
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 3;
/** Blurhash encode against a 32×32 pixel grid — kept small for speed; final
 *  blurhash is the same at any sample size, but tiny inputs encode fastest. */
const BLURHASH_SAMPLE_SIZE = 32;

/** WebP quality for derivatives — visual cliff is ~75; 80 gives headroom. */
const WEBP_QUALITY = 80;

/** Worker actor — shared with the scheduler tick. */
const WORKER_ACTOR = 'system:scheduler';

export interface MediaDerivativesOpts {
  /** R2 client override. Contract tests inject the in-memory stub. */
  r2?: R2Client;
  /** Per-tick batch size. Default 5 — keeps a single tick under ~3s on a
   *  cold backlog so other scheduler phases aren't starved. */
  limit?: number;
  /** Logger. Defaults to no-op so tests stay quiet. */
  log?: WorkerLogger;
}

export type MediaDerivativeOutcome = 'done' | 'failed-video' | 'failed-other';

export interface MediaDerivativeAttemptResult {
  jobId: string;
  mediaAssetId: string;
  outcome: MediaDerivativeOutcome;
  derivativesCount?: number;
  error?: string;
}

export interface MediaDerivativesTickResult {
  scanned: number;
  results: MediaDerivativeAttemptResult[];
}

const NOOP_LOG: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DEFAULT_LIMIT = 5;

/**
 * Run one media-derivatives tick. Each job goes through claim → process →
 * settle independently; one failure doesn't poison the batch.
 */
export async function runMediaDerivativesOnce(
  opts: MediaDerivativesOpts = {},
): Promise<MediaDerivativesTickResult> {
  const r2 = opts.r2 ?? defaultR2Client;
  const log = opts.log ?? NOOP_LOG;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const claimed = await claimBatch(limit);
  log.info(
    { workerTick: 'scheduler', phase: 'media-derivatives', batchSize: claimed.length },
    'media-derivatives tick claimed batch',
  );

  const results: MediaDerivativeAttemptResult[] = [];
  for (const job of claimed) {
    const result = await processOne(job, r2, log);
    results.push(result);
  }

  return { scanned: claimed.length, results };
}

async function claimBatch(limit: number): Promise<MediaDerivativeJobRow[]> {
  let claimed: MediaDerivativeJobRow[] = [];
  await withActor(WORKER_ACTOR, async (tx) => {
    claimed = await mediaDerivativeJobsRepository.lockDueForRun(tx, { limit });
  });
  return claimed;
}

async function processOne(
  job: MediaDerivativeJobRow,
  r2: R2Client,
  log: WorkerLogger,
): Promise<MediaDerivativeAttemptResult> {
  // Re-fetch the source row OUTSIDE the claim tx — fine because the job
  // row's UNIQUE on media_asset_id pins the relationship, and the asset
  // isn't going anywhere mid-tick (DELETE soft-expires; the worker still
  // produces derivatives so a later un-expire would have them ready).
  const asset = await mediaAssetsRepository.findById(job.mediaAssetId);
  if (asset === undefined) {
    await settleFailed(job.id, 'source media_assets row missing or expired', log);
    return {
      jobId: job.id,
      mediaAssetId: job.mediaAssetId,
      outcome: 'failed-other',
      error: 'source missing',
    };
  }

  if (asset.kind === 'video') {
    await settleFailed(job.id, 'video derivatives not yet implemented (ffmpeg deferred)', log);
    return {
      jobId: job.id,
      mediaAssetId: job.mediaAssetId,
      outcome: 'failed-video',
    };
  }

  let derivatives: MediaDerivative[];
  let width: number;
  let height: number;
  let blurhash: string;
  try {
    const processed = await processImage(asset, r2);
    derivatives = processed.derivatives;
    width = processed.width;
    height = processed.height;
    blurhash = processed.blurhash;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { workerTick: 'scheduler', phase: 'media-derivatives', jobId: job.id, err: message },
      'media derivative processing failed',
    );
    await settleFailed(job.id, message, log);
    return {
      jobId: job.id,
      mediaAssetId: job.mediaAssetId,
      outcome: 'failed-other',
      error: message,
    };
  }

  await settleDone(job.id, asset.id, { derivatives, width, height, blurhash }, log);
  return {
    jobId: job.id,
    mediaAssetId: job.mediaAssetId,
    outcome: 'done',
    derivativesCount: derivatives.length,
  };
}

interface ProcessedImage {
  derivatives: MediaDerivative[];
  width: number;
  height: number;
  blurhash: string;
}

async function processImage(asset: MediaAssetRow, r2: R2Client): Promise<ProcessedImage> {
  const { bytes } = await r2.getObjectBytes({ key: asset.objectKey });
  const sourceBuffer = Buffer.from(bytes);

  // sharp().metadata() reads the header only — cheap. Validates that the
  // bytes are a parseable image before we kick off three resize pipelines.
  const metadata = await sharp(sourceBuffer).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error('sharp: source image has no decodable dimensions');
  }

  const derivatives: MediaDerivative[] = [];
  for (const size of DERIVATIVE_SIZES) {
    // `withoutEnlargement` so a 200×150 source stays its native size for
    // the 'feed' (600) and 'lightbox' (1200) variants — no point upscaling
    // pixels we don't have. The thumb is always produced.
    const pipeline = sharp(sourceBuffer)
      .rotate() // honor EXIF orientation; iPhone uploads often arrive sideways
      .resize({ width: size.width, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    const derivativeKey = derivativeKeyFor(asset, size.label);
    await r2.putObjectBytes({
      key: derivativeKey,
      contentType: 'image/webp',
      bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    });
    derivatives.push({
      label: size.label,
      objectKey: derivativeKey,
      width: info.width,
      height: info.height,
      contentType: 'image/webp',
    });
  }

  const blurhash = await computeBlurhash(sourceBuffer);

  return { derivatives, width: sourceWidth, height: sourceHeight, blurhash };
}

async function computeBlurhash(sourceBuffer: Buffer): Promise<string> {
  // Blurhash needs raw RGBA pixels in a small grid. Resize to a fixed size
  // first so the encode is fast regardless of source resolution.
  const { data, info } = await sharp(sourceBuffer)
    .rotate()
    .resize({ width: BLURHASH_SAMPLE_SIZE, height: BLURHASH_SAMPLE_SIZE, fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return encodeBlurhash(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    BLURHASH_COMPONENTS_X,
    BLURHASH_COMPONENTS_Y,
  );
}

/**
 * Build the R2 key for one derivative. Co-locates the variant under a
 * `derivative/<label>/<asset-uuid>/<random>.webp` path so a future
 * cleanup sweep (Day-20+) can find all derivatives of a soft-expired
 * source via prefix scan.
 */
function derivativeKeyFor(asset: MediaAssetRow, label: string): string {
  return `derivative/${label}/${asset.id}/${randomUUID()}.webp`;
}

async function settleDone(
  jobId: string,
  mediaAssetId: string,
  payload: { derivatives: MediaDerivative[]; width: number; height: number; blurhash: string },
  log: WorkerLogger,
): Promise<void> {
  try {
    await withActor(WORKER_ACTOR, async (tx) => {
      await mediaAssetsRepository.setDerivatives(tx, {
        id: mediaAssetId,
        derivatives: payload.derivatives,
        width: payload.width,
        height: payload.height,
        blurhash: payload.blurhash,
      });
      await mediaDerivativeJobsRepository.markDone(tx, { id: jobId });
    });
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'media-derivatives',
        jobId,
        err: err instanceof Error ? err.message : String(err),
      },
      'media-derivatives: settle-done tx failed; job stays processing for Day-20 sweep',
    );
  }
}

async function settleFailed(jobId: string, lastError: string, log: WorkerLogger): Promise<void> {
  try {
    await withActor(WORKER_ACTOR, async (tx) => {
      await mediaDerivativeJobsRepository.markFailed(tx, { id: jobId, lastError });
    });
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'media-derivatives',
        jobId,
        err: err instanceof Error ? err.message : String(err),
      },
      'media-derivatives: settle-failed tx failed; job stays processing for Day-20 sweep',
    );
  }
}
