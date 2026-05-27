import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { mediaAssets } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `media_assets` (schema.sql ~line 425) — the metadata
 * row for every photo/video stored in Cloudflare R2. The bytes live in R2;
 * this table holds the object key + ownership + derivatives manifest.
 *
 * Lifecycle (Day 17):
 *   - **Create** — `create` is called by POST /media after the route has
 *     verified the R2 upload via `r2.headObject(key)`. Returns the row so
 *     the route can enqueue a derivative job in the same tx (rolls back
 *     together on any post-insert failure).
 *   - **Read** — `findById` filters `expired_at IS NULL` so a soft-expired
 *     row is invisible to the API. GET /media/:id uses this before signing
 *     the presigned-GET URL.
 *   - **Derivatives** — `setDerivatives` is called by the worker after
 *     sharp generates thumb/feed/lightbox WebPs + blurhash. The jsonb on
 *     the source row is the source of truth for "what derivatives exist";
 *     the worker's job row is the workflow state.
 *   - **Soft-expire** — `softExpire` sets `expired_at = now()`. The R2
 *     object stays in the bucket (per the never-delete invariant);
 *     Day-20+ cleanup sweeps long-expired objects.
 */

export type MediaKind = 'image' | 'video';

export type MediaPurpose =
  | 'dog-profile'
  | 'owner-avatar'
  | 'report-photo'
  | 'report-video'
  | 'message-attachment';

/** One derivative variant produced by sharp (size + key + dims). */
export interface MediaDerivative {
  label: string;
  objectKey: string;
  width: number;
  height: number;
  contentType: string;
}

export interface MediaAssetRow {
  id: string;
  ownerId: string;
  dogId: string | null;
  reportId: string | null;
  kind: MediaKind;
  purpose: MediaPurpose;
  objectKey: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  blurhash: string | null;
  derivatives: MediaDerivative[];
  createdAt: string;
  expiredAt: string | null;
}

const MEDIA_ASSET_PROJECTION = {
  id: mediaAssets.id,
  ownerId: mediaAssets.ownerId,
  dogId: mediaAssets.dogId,
  reportId: mediaAssets.reportId,
  kind: mediaAssets.kind,
  purpose: mediaAssets.purpose,
  objectKey: mediaAssets.objectKey,
  contentType: mediaAssets.contentType,
  bytes: mediaAssets.bytes,
  width: mediaAssets.width,
  height: mediaAssets.height,
  durationMs: mediaAssets.durationMs,
  blurhash: mediaAssets.blurhash,
  derivatives: mediaAssets.derivatives,
  createdAt: mediaAssets.createdAt,
  expiredAt: mediaAssets.expiredAt,
} as const;

/**
 * Narrow the drizzle projection (which types `derivatives` as `unknown`
 * because it's a JSONB column) onto our typed `MediaAssetRow`. Single
 * place that asserts the shape — every consumer reads typed values.
 * The worker is the only writer of `derivatives`, and it always writes
 * a {@link MediaDerivative}[] manifest, so the runtime shape is
 * trustworthy at this boundary.
 */
function projectMediaAssetRow(raw: {
  id: string;
  ownerId: string;
  dogId: string | null;
  reportId: string | null;
  kind: MediaKind;
  purpose: MediaPurpose;
  objectKey: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  blurhash: string | null;
  derivatives: unknown;
  createdAt: string;
  expiredAt: string | null;
}): MediaAssetRow {
  return {
    ...raw,
    derivatives: (raw.derivatives ?? []) as MediaDerivative[],
  };
}

export const mediaAssetsRepository = {
  /**
   * INSERT a new media-asset row. Called by POST /media after `r2.headObject`
   * confirms the upload landed. `derivatives` defaults to `[]` (the worker
   * fills it later); `width`/`height`/`blurhash` start NULL for images and
   * get populated by the worker.
   */
  async create(
    tx: Tx,
    values: {
      ownerId: string;
      dogId?: string | null;
      reportId?: string | null;
      kind: MediaKind;
      purpose: MediaPurpose;
      objectKey: string;
      contentType: string;
      bytes: number;
      createdBy: 'owner' | 'staff';
    },
  ): Promise<MediaAssetRow> {
    const [raw] = await tx
      .insert(mediaAssets)
      .values({
        ownerId: values.ownerId,
        dogId: values.dogId ?? null,
        reportId: values.reportId ?? null,
        kind: values.kind,
        purpose: values.purpose,
        objectKey: values.objectKey,
        contentType: values.contentType,
        bytes: values.bytes,
        createdBy: values.createdBy,
      })
      .returning(MEDIA_ASSET_PROJECTION);
    if (raw === undefined) {
      throw new Error('mediaAssets.create: INSERT returned no row');
    }
    return projectMediaAssetRow(raw);
  },

  /**
   * Live row by id (filters soft-expired). GET /media/:id uses this before
   * the ownership check + presigned-GET issuance. `runner` defaults to the
   * pool so route GETs can call without an open tx; mutations + the worker
   * pass their `tx` to read inside the audit-stamped scope.
   */
  async findById(id: string, runner: Runner = db): Promise<MediaAssetRow | undefined> {
    const [raw] = await runner
      .select(MEDIA_ASSET_PROJECTION)
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, id), isNull(mediaAssets.expiredAt)))
      .limit(1);
    return raw === undefined ? undefined : projectMediaAssetRow(raw);
  },

  /**
   * Worker side: replace the derivatives manifest + populate
   * width/height/blurhash from the source image. One UPDATE captures every
   * field sharp produced so the row is internally consistent after a
   * successful run (no half-populated state visible to readers).
   */
  async setDerivatives(
    tx: Tx,
    args: {
      id: string;
      derivatives: MediaDerivative[];
      width: number;
      height: number;
      blurhash: string;
    },
  ): Promise<number> {
    const updated = await tx
      .update(mediaAssets)
      .set({
        derivatives: args.derivatives,
        width: args.width,
        height: args.height,
        blurhash: args.blurhash,
      })
      .where(and(eq(mediaAssets.id, args.id), isNull(mediaAssets.expiredAt)))
      .returning({ id: mediaAssets.id });
    return updated.length;
  },

  /**
   * Soft-expire the row. Per the never-delete invariant the R2 object is
   * NOT deleted here — a Day-20+ cleanup job sweeps long-expired objects
   * from the bucket. The route's DELETE /media/:id is the only caller.
   */
  async softExpire(tx: Tx, id: string): Promise<number> {
    const updated = await tx
      .update(mediaAssets)
      .set({ expiredAt: sql`now()` })
      .where(and(eq(mediaAssets.id, id), isNull(mediaAssets.expiredAt)))
      .returning({ id: mediaAssets.id });
    return updated.length;
  },
};
