import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { mediaDerivativeJobs } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `media_derivative_jobs` (schema.sql Day-17 §A) —
 * the worker queue for sharp/ffmpeg derivative processing. One row per
 * media_assets row that needs processing; the `media_asset_id` UNIQUE
 * makes enqueue idempotent (a POST /media replay can't double-add).
 *
 * Lifecycle:
 *   - **Enqueue** — `enqueue` is called inside the POST /media tx so the
 *     job rolls back with the media_assets row on any later failure.
 *     ON CONFLICT DO NOTHING — re-enqueue under an Idempotency-Key replay
 *     is a no-op.
 *   - **Claim** — `lockDueForRun` claims 'pending' rows via FOR UPDATE
 *     SKIP LOCKED + flips to 'processing' atomically (one statement, no
 *     race window). Bound by limit; the scheduler tick caps per-tick
 *     processing so a backlog drains over multiple ticks rather than
 *     stretching a single tick to 30s+.
 *   - **Settle** — `markDone` on success; `markFailed` records the
 *     last_error and parks the row. Today there is no auto-retry —
 *     Day-20 observability decides whether to re-enqueue failed rows.
 *
 * Append-only by nature — no expired_at; a parked job stays as a
 * record of the failure for the staff portal to surface.
 */

export type MediaDerivativeJobStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface MediaDerivativeJobRow {
  id: string;
  mediaAssetId: string;
  status: MediaDerivativeJobStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

const MEDIA_DERIVATIVE_JOB_PROJECTION = {
  id: mediaDerivativeJobs.id,
  mediaAssetId: mediaDerivativeJobs.mediaAssetId,
  status: mediaDerivativeJobs.status,
  attempts: mediaDerivativeJobs.attempts,
  lastError: mediaDerivativeJobs.lastError,
  createdAt: mediaDerivativeJobs.createdAt,
  updatedAt: mediaDerivativeJobs.updatedAt,
} as const;

export const mediaDerivativeJobsRepository = {
  /**
   * Idempotent enqueue. INSERT ... ON CONFLICT (media_asset_id) DO NOTHING
   * RETURNING. A return of `undefined` means a job for this asset already
   * exists (a prior POST /media, possibly under an Idempotency-Key replay)
   * — the caller treats that as success, not as an error.
   */
  async enqueue(
    tx: Tx,
    args: { mediaAssetId: string },
  ): Promise<MediaDerivativeJobRow | undefined> {
    const [row] = await tx
      .insert(mediaDerivativeJobs)
      .values({ mediaAssetId: args.mediaAssetId })
      .onConflictDoNothing({ target: mediaDerivativeJobs.mediaAssetId })
      .returning(MEDIA_DERIVATIVE_JOB_PROJECTION);
    return row;
  },

  /**
   * Atomic claim-and-mark-processing. Selects up to `limit` 'pending' rows
   * with FOR UPDATE SKIP LOCKED, flips them to 'processing', and bumps
   * `attempts`. The single-statement form prevents a race where another
   * worker could claim a row between SELECT and UPDATE.
   *
   * Ordered by `created_at ASC` so the oldest job goes first — mild
   * fairness when a backlog drains over multiple ticks.
   */
  async lockDueForRun(tx: Tx, args: { limit: number }): Promise<MediaDerivativeJobRow[]> {
    // Drizzle doesn't natively express the "UPDATE ... WHERE id IN (SELECT
    // FOR UPDATE SKIP LOCKED)" idiom, so the SELECT + UPDATE happen as two
    // statements within the caller's tx — equivalent in practice because
    // the SELECT holds row locks until the tx commits.
    const claimed = await tx
      .select({ id: mediaDerivativeJobs.id })
      .from(mediaDerivativeJobs)
      .where(eq(mediaDerivativeJobs.status, 'pending'))
      .orderBy(asc(mediaDerivativeJobs.createdAt))
      .limit(args.limit)
      .for('update', { skipLocked: true });
    if (claimed.length === 0) return [];
    const ids = claimed.map((row) => row.id);
    const updated = await tx
      .update(mediaDerivativeJobs)
      .set({
        status: 'processing',
        attempts: sql`${mediaDerivativeJobs.attempts} + 1`,
      })
      .where(inArray(mediaDerivativeJobs.id, ids))
      .returning(MEDIA_DERIVATIVE_JOB_PROJECTION);
    return updated;
  },

  /**
   * Mark the job done. Filters on `status = 'processing'` so a stray double-
   * settle (shouldn't happen under SKIP LOCKED) doesn't flip a 'failed' row
   * to 'done'.
   */
  async markDone(tx: Tx, args: { id: string }): Promise<number> {
    const updated = await tx
      .update(mediaDerivativeJobs)
      .set({ status: 'done' })
      .where(and(eq(mediaDerivativeJobs.id, args.id), eq(mediaDerivativeJobs.status, 'processing')))
      .returning({ id: mediaDerivativeJobs.id });
    return updated.length;
  },

  /**
   * Park the job as 'failed' with the error message preserved. The source
   * media_assets row stays usable at original size — only derivatives are
   * unavailable. Day-20 observability surfaces parked jobs for triage.
   */
  async markFailed(tx: Tx, args: { id: string; lastError: string }): Promise<number> {
    const updated = await tx
      .update(mediaDerivativeJobs)
      .set({ status: 'failed', lastError: args.lastError })
      .where(and(eq(mediaDerivativeJobs.id, args.id), eq(mediaDerivativeJobs.status, 'processing')))
      .returning({ id: mediaDerivativeJobs.id });
    return updated.length;
  },

  /**
   * Test-only lookup by media_asset_id. Routes never need this — the
   * relationship is 1:1 and the worker scans by status. Tests use it to
   * assert "POST /media enqueued a job for this asset."
   */
  async findByMediaAssetId(
    runner: Runner,
    mediaAssetId: string,
  ): Promise<MediaDerivativeJobRow | undefined> {
    const [row] = await runner
      .select(MEDIA_DERIVATIVE_JOB_PROJECTION)
      .from(mediaDerivativeJobs)
      .where(eq(mediaDerivativeJobs.mediaAssetId, mediaAssetId))
      .limit(1);
    return row;
  },
};
