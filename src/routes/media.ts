import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import {
  mediaAssetsRepository,
  type MediaAssetRow,
  type MediaKind,
  type MediaPurpose,
} from '../db/repositories/mediaAssetsRepository.js';
import { mediaDerivativeJobsRepository } from '../db/repositories/mediaDerivativeJobsRepository.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { ApiError } from '../lib/errors.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * Media surface (Day 17, DATA-CONTRACT §C.2):
 *
 *   - `POST /media`        `[auth]`  — register an upload landed in R2
 *   - `GET /media/:id`     `[auth]`  — ownership-checked presigned GET
 *   - `DELETE /media/:id`  `[auth]`  — soft-expire (R2 bytes retained)
 *
 * Scope (Day 17 cut, see HANDOFF):
 *   - **Owner uploads only:** dog-profile, owner-avatar, message-attachment.
 *     `dog-profile` requires the principal to own the dog; the other two
 *     scope to the principal's owner_id.
 *   - **Report-photo / report-video are deferred to Day 19** (staff portal).
 *     POSTing those purposes today returns 422 with a clear message — the
 *     authoring path lives with the staff report-creation surface, not the
 *     owner upload surface. The schema enum + R2 + worker all support it
 *     today; Day-19 adds the route arm.
 *
 * Lifecycle:
 *   1. Owner: `POST /uploads/sign` → PUT bytes directly to R2.
 *   2. Owner: `POST /media {key, purpose, dog_id?}` → server `r2.headObject`
 *      to confirm the upload landed → INSERT media_assets row + enqueue a
 *      `media_derivative_jobs` row in the same tx (rolls back together on
 *      any post-insert failure).
 *   3. Background: the derivatives worker (`runMediaDerivativesOnce`,
 *      composed into the scheduler tick) claims the job, runs sharp,
 *      writes thumb/feed/lightbox WebPs to R2, updates `media_assets.
 *      derivatives` + `blurhash` + `width`/`height`.
 *   4. FE: `GET /media/:id` returns a short-lived signed URL the FE renders
 *      via expo-image. The FE caches by id; signed-URL refresh on TTL
 *      expiry is a Day-18 concern.
 */

const GET_URL_TTL_SECONDS = 60 * 5; // 5 min — short enough to be useless if leaked

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const mediaPurposeSchema = z.enum([
  'dog-profile',
  'owner-avatar',
  'report-photo',
  'report-video',
  'message-attachment',
]);

const postBodySchema = z
  .object({
    key: z.string().min(1),
    purpose: mediaPurposeSchema,
    dog_id: z.string().uuid().nullable().optional(),
    report_id: z.string().uuid().nullable().optional(),
  })
  .strict();

export interface MediaWire {
  id: string;
  purpose: MediaPurpose;
  kind: MediaKind;
  url: string;
  expires_at: string;
  blurhash: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  /**
   * Derivative URLs, keyed by label ('thumb' / 'feed' / 'lightbox'). Each
   * URL is presigned with the same TTL as the base `url`. Empty until the
   * derivatives worker has run (the source is still readable at original
   * size — that's `url`).
   */
  derivatives: Record<string, string>;
}

export interface MediaRouteOpts extends AuthRouteOptions {
  /** Override the R2 client (contract tests inject the stub). */
  r2?: R2Client;
}

export function registerMediaRoute(app: FastifyInstance, opts: MediaRouteOpts = {}): void {
  const authHook = resolveAuthHook(opts);
  const r2 = opts.r2 ?? defaultR2Client;

  // -------------------------------------------------------------------------
  // POST /media — register an upload
  // -------------------------------------------------------------------------

  app.post('/media', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') {
      throw new ApiError(
        'forbidden',
        'staff media uploads land with the Day-19 staff portal; owner uploads only today',
      );
    }
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsed = postBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('bad_request', `invalid media payload: ${formatZodIssues(parsed.error)}`);
    }
    const { key, purpose, dog_id: dogId, report_id: reportId } = parsed.data;

    const linkage = ownerUploadLinkage(purpose, dogId ?? null, reportId ?? null);

    // Verify the upload actually landed in R2 BEFORE we INSERT the row.
    // Confirms the client's claim AND captures real bytes/content-type for
    // the row (vs. trusting the sign-time `byte_size` which is advisory).
    const head = await r2.headObject({ key });
    if (head === null) {
      throw new ApiError(
        'invalid_payload',
        'no R2 object exists at the supplied key — did the upload complete?',
        { kind: 'media-upload-missing' },
      );
    }

    // Carry the created row out of the tx so the post-commit URL signing
    // doesn't need a second DB hit. The `body` type is `MediaAssetRow`
    // mid-flight; we map to `MediaWire` after the URL sign below.
    const outcome = await withMutation<MediaAssetRow>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /media',
        requestHash: hashRequestBody(parsed.data),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (linkage.dogId !== null) {
          const owned = await dogsRepository.findOwnedExists(linkage.dogId, principal.ownerId, tx);
          if (!owned) {
            throw new ApiError('not_found', 'dog not found (ownership scope filtered)');
          }
        }

        const row = await mediaAssetsRepository.create(tx, {
          ownerId: principal.ownerId,
          dogId: linkage.dogId,
          reportId: linkage.reportId,
          kind: linkage.kind,
          purpose,
          objectKey: key,
          contentType: head.contentType,
          bytes: head.bytes,
          createdBy: 'owner',
        });

        // Enqueue the derivatives job in the SAME tx so a withMutation
        // rollback also rolls back the job row — no orphan jobs for
        // non-existent media_assets rows. The worker (composed into the
        // scheduler tick) picks it up on the next cron firing.
        await mediaDerivativeJobsRepository.enqueue(tx, { mediaAssetId: row.id });

        return { status: 201, body: row };
      },
    );

    // Sign the URL POST-commit so the response carries a working URL.
    // Outside `withMutation` to keep the third-party seam off the tx
    // (matches the Day-14/15 "Stripe calls go after commit" invariant).
    const wire = await signMediaUrls(outcome.body, r2);
    reply.code(outcome.status);
    return wire;
  });

  // -------------------------------------------------------------------------
  // GET /media/:id — owner-scoped read with presigned URL
  // -------------------------------------------------------------------------

  app.get('/media/:id', { preHandler: [authHook] }, async (request): Promise<MediaWire> => {
    const principal = requirePrincipal(request);
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw new ApiError('bad_request', `invalid media id: ${formatZodIssues(parsedParams.error)}`);
    }

    const row = await mediaAssetsRepository.findById(parsedParams.data.id);
    if (row === undefined) {
      throw new ApiError('not_found', 'media not found');
    }

    // Owner-scoped: a media row belongs to one owner. Staff are also
    // authenticated principals; today the staff path isn't wired to
    // browse arbitrary media — Day-19 adds the staff portal arm. For
    // now staff principals get 404 (same shape as an owner reading
    // someone else's media — never reveal cross-tenant existence).
    if (principal.kind !== 'owner' || row.ownerId !== principal.ownerId) {
      throw new ApiError('not_found', 'media not found');
    }

    return signMediaUrls(row, r2);
  });

  // -------------------------------------------------------------------------
  // DELETE /media/:id — soft-expire (R2 bytes retained for Day-20+ sweep)
  // -------------------------------------------------------------------------

  app.delete('/media/:id', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') {
      throw new ApiError('forbidden', 'staff media deletion lands with the Day-19 staff portal');
    }

    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw new ApiError('bad_request', `invalid media id: ${formatZodIssues(parsedParams.error)}`);
    }
    const { id } = parsedParams.data;

    const outcome = await withMutation<null>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /media/:id',
        requestHash: hashRequestBody({ id }),
        keysToInvalidate: () => [],
      },
      async (tx) => {
        const row = await mediaAssetsRepository.findById(id, tx);
        if (row === undefined || row.ownerId !== principal.ownerId) {
          throw new ApiError('not_found', 'media not found');
        }
        await mediaAssetsRepository.softExpire(tx, id);
        return { status: 204, body: null };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });
}

/**
 * Validate purpose + payload combo and pull out the linkage fields for the
 * owner upload path. `dog_id` is required for dog-profile, forbidden
 * elsewhere. `report_id` is the staff path (deferred to Day-19) so today's
 * owner route rejects it everywhere.
 *
 * The function returns the resolved fields (kind + cleaned dog_id/report_id)
 * so the caller doesn't repeat the per-purpose branching.
 */
function ownerUploadLinkage(
  purpose: MediaPurpose,
  dogId: string | null,
  reportId: string | null,
): { dogId: string | null; reportId: string | null; kind: MediaKind } {
  if (purpose === 'report-photo' || purpose === 'report-video') {
    throw new ApiError(
      'invalid_payload',
      `purpose '${purpose}' is authored via the staff portal; not yet implemented`,
      { kind: 'media-staff-upload-deferred' },
    );
  }
  if (purpose === 'dog-profile') {
    if (dogId === null || dogId === '') {
      throw new ApiError('bad_request', `purpose 'dog-profile' requires dog_id`);
    }
    if (reportId !== null && reportId !== '') {
      throw new ApiError('bad_request', `purpose 'dog-profile' cannot carry report_id`);
    }
    return { dogId, reportId: null, kind: 'image' };
  }
  // owner-avatar + message-attachment: no FK linkage; the row carries
  // owner_id (the principal) only.
  if (dogId !== null && dogId !== '') {
    throw new ApiError('bad_request', `purpose '${purpose}' cannot carry dog_id`);
  }
  if (reportId !== null && reportId !== '') {
    throw new ApiError('bad_request', `purpose '${purpose}' cannot carry report_id`);
  }
  return { dogId: null, reportId: null, kind: 'image' };
}

/**
 * Sign the base + derivative GET URLs for a media row and project to the
 * wire shape. POST and GET both end here so a freshly-created row carries
 * the same shape later reads will return. Signing happens against the R2
 * seam — tests inject the stub which returns predictable `stub.r2.invalid`
 * URLs the assertions can match on.
 */
async function signMediaUrls(row: MediaAssetRow, r2: R2Client): Promise<MediaWire> {
  const baseUrl = await r2.signGetUrl({
    key: row.objectKey,
    expiresSeconds: GET_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + GET_URL_TTL_SECONDS * 1000).toISOString();

  const derivativeUrls: Record<string, string> = {};
  for (const derivative of row.derivatives) {
    derivativeUrls[derivative.label] = await r2.signGetUrl({
      key: derivative.objectKey,
      expiresSeconds: GET_URL_TTL_SECONDS,
    });
  }

  return {
    id: row.id,
    purpose: row.purpose,
    kind: row.kind,
    url: baseUrl,
    expires_at: expiresAt,
    blurhash: row.blurhash,
    width: row.width,
    height: row.height,
    duration_ms: row.durationMs,
    derivatives: derivativeUrls,
  };
}
