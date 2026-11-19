import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import {
  MEDIA_PURPOSES,
  type MediaWire,
  type PostMediaRequest,
  type PostMediaUploadMessageAttachmentQuery,
  type PostMediaUploadQuery,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import {
  mediaAssetsRepository,
  type MediaAssetRow,
  type MediaKind,
  type MediaPurpose,
} from '../db/repositories/mediaAssetsRepository.js';
import { mediaDerivativeJobsRepository } from '../db/repositories/mediaDerivativeJobsRepository.js';
import { reportsRepository } from '../db/repositories/reportsRepository.js';
import { threadsRepository } from '../db/repositories/threadsRepository.js';
import { mediaAssets } from '../db/schema/schema.js';
import type { Tx } from '../db/tx.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { ApiError } from '../lib/errors.js';
import {
  MAX_UPLOAD_BYTES,
  assertContentTypeMatchesPurpose,
  mediaKindForContentType,
  mediaObjectKey,
} from '../lib/mediaKeys.js';
import {
  requireOwner,
  requireStaff,
  type OwnerPrincipal,
  type StaffPrincipal,
} from '../lib/principalNarrows.js';
import { defaultR2Client, type HeadObjectResult, type R2Client } from '../lib/r2.js';
import { uuidId } from '../lib/uuidId.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * Media surface (Day 17 + Day-19c staff-author arm, DATA-CONTRACT §C.2):
 *
 *   - `POST /media`        `[auth]`  — register an upload landed in R2
 *   - `GET /media/:id`     `[auth]`  — ownership-checked presigned GET
 *   - `DELETE /media/:id`  `[auth]`  — soft-expire (R2 bytes retained)
 *
 * Two POST arms, split on `purpose`:
 *   - **Owner uploads:** dog-profile, owner-avatar, message-attachment.
 *     `dog-profile` requires the principal to own the dog; the other two
 *     scope to the principal's own owner_id. A staff principal POSTing one
 *     of these → 403 (owner-only). `createdBy='owner'`.
 *   - **Staff report media (Day-19c):** report-photo, report-video. Staff-
 *     authored — the route resolves `report_id → report.dog_id →
 *     dogs.owner_id` and stamps that owner on the row, so the dog's owner
 *     (not the staffer) can read it back via the owner-scoped GET. An owner
 *     principal POSTing one of these → 403 (staff-only). `createdBy='staff'`.
 *
 *   - **Staff conversation media (wire 9.2.0, O-MSG-LIVE; her answer 6):** a
 *     staffer's photo or video for a thread, through the `POST /media/upload`
 *     proxy's second arm (`purpose=message-attachment&thread_id=…`). The row is
 *     stamped with that thread's owner and `createdBy='staff'`.
 *
 * Read/delete scope: an owner sees + soft-expires only their own media
 * (cross-tenant → 404, never reveal existence), and from 9.2.0 never a row the
 * school uploaded (`created_by = 'staff'`, A2 OL5): a staffer's conversation
 * photo or report photo stamped with her id reads as hers but is the school's
 * record, so her DELETE of it is the same 404. Staff are cross-owner trusted
 * — the staff portal reads dogs/bookings/threads cross-owner, so a staffer
 * may GET/DELETE any live media (reviewing a report needs the dog's photos
 * regardless of which owner authored them).
 *
 * Lifecycle:
 *   1. `POST /uploads/sign` → PUT bytes directly to R2.
 *   2. `POST /media {key, purpose, dog_id?|report_id?}` → server
 *      `r2.headObject` to confirm the upload landed → INSERT media_assets row
 *      + enqueue a `media_derivative_jobs` row in the same tx (rolls back
 *      together on any post-insert failure).
 *   3. Background: the derivatives worker (`runMediaDerivativesOnce`,
 *      composed into the scheduler tick) claims the job, runs sharp,
 *      writes thumb/feed/lightbox WebPs to R2, updates `media_assets.
 *      derivatives` + `blurhash` + `width`/`height`.
 *   4. Client: `GET /media/:id` returns a short-lived signed URL rendered
 *      via expo-image (owner app) / `<img>` (portal). Signed-URL refresh on
 *      TTL expiry is a client concern.
 */

const GET_URL_TTL_SECONDS = 60 * 5; // 5 min — short enough to be useless if leaked

const paramsSchema = z.object({
  id: uuidId(),
});

// §5.4 swap (1.13.0) — see uploadsSign.ts for the identical collapse. Member
// set, and therefore accept/reject behavior, is unchanged.
const mediaPurposeSchema = z.enum(MEDIA_PURPOSES);

const postBodySchema = z
  .object({
    key: z.string().min(1),
    purpose: mediaPurposeSchema,
    dog_id: uuidId().nullable().optional(),
    report_id: uuidId().nullable().optional(),
  })
  .strict();

type PostMediaBody = z.infer<typeof postBodySchema>;

// §5.1.3 — `PostMediaRequest` (wire) IS this schema's input. `z.input`, not
// `z.infer`; `PostMediaBody` above stays `z.infer` because it types the
// POST-PARSE value the handlers pass around.
export type PostMediaBodyConformance = Expect<
  Equal<z.input<typeof postBodySchema>, PostMediaRequest>
>;

/**
 * POST /media/upload query — the staff report-media proxy. The bytes ride in
 * the request body (raw, parsed as a Buffer in the scoped parser below); the
 * metadata rides here. report_id is required (the row's owner resolves through
 * it); dog_id is derived from the report, never supplied.
 */
const uploadQuerySchema = z
  .object({
    purpose: z.enum(['report-photo', 'report-video']),
    report_id: uuidId(),
  })
  .strict();

// §5.1.3 — the query half of the staff proxy path.
export type PostMediaUploadQueryConformance = Expect<
  Equal<z.input<typeof uploadQuerySchema>, PostMediaUploadQuery>
>;

/**
 * POST /media/upload query, its second arm (wire 9.2.0, O-MSG-LIVE; design §4 W7;
 * her answer 6): a staffer's photo or video for a conversation. `thread_id` is a
 * uuid (CR4: malformed → 400); the row is stamped with that LIVE thread's owner
 * (missing or expired → 404) and `createdBy='staff'`, so it can be attached only to
 * a staff message to that family and an owner's DELETE treats it as missing.
 */
const uploadMessageAttachmentQuerySchema = z
  .object({
    purpose: z.literal('message-attachment'),
    thread_id: uuidId(),
  })
  .strict();

// §5.1.3 — the second arm is its own interface, so the first pin above stays untouched.
export type PostMediaUploadMessageAttachmentQueryConformance = Expect<
  Equal<
    z.input<typeof uploadMessageAttachmentQuerySchema>,
    PostMediaUploadMessageAttachmentQuery
  >
>;

/** The route's schema: both arms, told apart by `purpose`, each `.strict()`. */
const uploadQueryArmsSchema = z.discriminatedUnion('purpose', [
  uploadQuerySchema,
  uploadMessageAttachmentQuerySchema,
]);

type UploadQuery = z.infer<typeof uploadQueryArmsSchema>;

// §5.1.3 — "The server pins its schema to the union of both arms" (wire.ts 9.2.0).
export type PostMediaUploadQueryArmsConformance = Expect<
  Equal<
    z.input<typeof uploadQueryArmsSchema>,
    PostMediaUploadQuery | PostMediaUploadMessageAttachmentQuery
  >
>;

// MediaWire is owned by the single-source contract (contracts/wire.ts).
export type { MediaWire };

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
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parsePostBody(request.body);

    // Split on purpose: report-photo/report-video are staff-authored (resolve
    // report → dog → owner); the other three are owner uploads. The role gate
    // runs before any R2 round-trip so a forbidden request never touches R2.
    if (body.purpose === 'report-photo' || body.purpose === 'report-video') {
      requireStaff(principal, 'author report media');
      return authorStaffReportMedia(principal, body, idempotencyKey, r2, reply);
    }
    requireOwner(principal, 'upload media');
    return uploadOwnerMedia(principal, body, idempotencyKey, r2, reply);
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

    // Owners see only their own media — a cross-tenant read is a 404, never a
    // 403, so existence never leaks. Staff are cross-owner trusted (the staff
    // portal reads dogs/bookings/threads cross-owner; a staffer reviewing a
    // report needs the dog's photos regardless of which owner authored them).
    if (principal.kind === 'owner' && row.ownerId !== principal.ownerId) {
      throw new ApiError('not_found', 'media not found');
    }

    return signMediaUrls(row, r2);
  });

  // -------------------------------------------------------------------------
  // DELETE /media/:id — soft-expire (R2 bytes retained for Day-20+ sweep)
  // -------------------------------------------------------------------------

  app.delete('/media/:id', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
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
        // Owner: only their own row, and never one the school uploaded (A2
        // OL5: `created_by = 'staff'`, a conversation photo or a report photo
        // stamped with her id). Staff: any row (cross-owner trusted). Every
        // miss is the same 404 so existence never leaks across tenants.
        const row = await findLiveMediaUploaderInTx(tx, id);
        if (
          row === undefined ||
          (principal.kind === 'owner' &&
            (row.ownerId !== principal.ownerId || row.createdBy === 'staff'))
        ) {
          throw new ApiError('not_found', 'media not found');
        }
        await mediaAssetsRepository.softExpire(tx, id);
        return { status: 204, body: null };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });

  registerMediaUploadProxy(app, authHook, r2);
}

/**
 * POST /media/upload `[staff]` — the Day-19c portal upload path. The portal
 * (a browser) POSTs the file bytes here and the SERVER streams them to R2;
 * the browser never touches R2 (so no per-origin bucket CORS, no presigned-URL
 * exposure). The mobile path keeps the presign flow (`POST /uploads/sign` +
 * `POST /media`) — native clients aren't CORS-bound and direct upload avoids
 * proxying large photos through the API. Report photos are small, so the
 * server holding the bytes is cheap.
 *
 * Bytes ride in the raw request body (a scoped `*` content-type parser reads
 * them as a Buffer — encapsulated so the other media routes keep JSON parsing);
 * the metadata rides in the query string, one of two arms: `purpose` +
 * `report_id` (report media; the row's owner resolves through the report, see
 * {@link resolveStaffReportLinkage}) or, from wire 9.2.0, `purpose=message-
 * attachment` + `thread_id` (a conversation photo or video; the row's owner is
 * the thread's, see {@link resolveStaffThreadLinkage}). Staff-only.
 */
function registerMediaUploadProxy(
  app: FastifyInstance,
  authHook: ReturnType<typeof resolveAuthHook>,
  r2: R2Client,
): void {
  app.register(async (scope) => {
    // Within this encapsulated scope ONLY, every body is read as a raw Buffer.
    // The portal sends the file with its real image/video Content-Type; the
    // app's default JSON parsing is untouched outside this scope.
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );

    scope.post(
      '/media/upload',
      { preHandler: [authHook], bodyLimit: MAX_UPLOAD_BYTES },
      async (request, reply): Promise<MediaWire> => {
        const principal = requirePrincipal(request);
        requireStaff(principal, 'author report media');
        const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

        const query = parseUploadQuery(request.query);
        const contentType = request.headers['content-type'] ?? '';
        assertContentTypeMatchesPurpose(query.purpose, contentType);

        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          throw new ApiError('bad_request', 'empty upload body');
        }

        // Stream the bytes to R2 server-side, then record the row. The PUT is
        // before `withMutation` (third-party calls stay off the tx); a retry
        // with the same Idempotency-Key replays the first row and leaves this
        // PUT's object as a swept-later orphan — so the request hash is the
        // STABLE metadata (not the per-call random key).
        const key = mediaObjectKey(query.purpose, `staff-${principal.staffId}`, contentType);
        await r2.putObjectBytes({ key, contentType, bytes: new Uint8Array(bytes) });

        // A conversation attachment is a photo OR a video, by what was sent.
        const kind: MediaKind =
          query.purpose === 'message-attachment'
            ? mediaKindForContentType(contentType)
            : query.purpose === 'report-video'
              ? 'video'
              : 'image';
        const outcome = await withMutation<MediaAssetRow>(
          {
            principal,
            idempotencyKey,
            endpoint: 'POST /media/upload',
            requestHash: hashRequestBody(query),
            keysToInvalidate: () => [],
          },
          async (tx) => {
            const linkage =
              query.purpose === 'message-attachment'
                ? await resolveStaffThreadLinkage(tx, query.thread_id)
                : {
                    ...(await resolveStaffReportLinkage(tx, query.report_id)),
                    reportId: query.report_id,
                  };
            const row = await createMediaRow(tx, {
              ownerId: linkage.ownerId,
              dogId: linkage.dogId,
              reportId: linkage.reportId,
              kind,
              purpose: query.purpose,
              objectKey: key,
              contentType,
              bytes: bytes.length,
              createdBy: 'staff',
            });
            return { status: 201, body: row };
          },
        );

        return finishMedia(reply, outcome.status, outcome.body, r2);
      },
    );
  });
}

/**
 * Owner upload arm: dog-profile / owner-avatar / message-attachment. Stamps
 * the principal's own owner_id; `dog-profile` additionally requires + verifies
 * ownership of the dog. Mirrors the staff arm's structure (verify upload →
 * tx[create + enqueue] → sign), differing only in the linkage source.
 */
async function uploadOwnerMedia(
  principal: OwnerPrincipal,
  body: PostMediaBody,
  idempotencyKey: string,
  r2: R2Client,
  reply: FastifyReply,
): Promise<MediaWire> {
  const linkage = ownerUploadLinkage(body.purpose, body.dog_id ?? null, body.report_id ?? null);
  const head = await verifyUploadLanded(r2, body.key);
  // Kind follows the actual uploaded content type — a message-attachment can be
  // a photo OR a video; dog-profile/owner-avatar are image-gated upstream.
  const kind = mediaKindForContentType(head.contentType);

  const outcome = await withMutation<MediaAssetRow>(
    {
      principal,
      idempotencyKey,
      endpoint: 'POST /media',
      requestHash: hashRequestBody(body),
      keysToInvalidate: () => [],
    },
    async (tx) => {
      if (linkage.dogId !== null) {
        const owned = await dogsRepository.findOwnedExists(linkage.dogId, principal.ownerId, tx);
        if (!owned) {
          throw new ApiError('not_found', 'dog not found (ownership scope filtered)');
        }
      }
      const row = await createMediaRow(tx, {
        ownerId: principal.ownerId,
        dogId: linkage.dogId,
        reportId: linkage.reportId,
        kind,
        purpose: body.purpose,
        objectKey: body.key,
        contentType: head.contentType,
        bytes: head.bytes,
        createdBy: 'owner',
      });
      return { status: 201, body: row };
    },
  );

  return finishMedia(reply, outcome.status, outcome.body, r2);
}

/**
 * Staff report-media arm (Day-19c): report-photo / report-video. The row's
 * owner is resolved `report_id → report.dog_id → dogs.owner_id` so the dog's
 * owner — not the authoring staffer — can read it back via the owner-scoped
 * GET. `dog_id` is derived from the report (a client-supplied one is rejected
 * to prevent a dog/report mismatch). `createdBy='staff'`.
 */
async function authorStaffReportMedia(
  principal: StaffPrincipal,
  body: PostMediaBody,
  idempotencyKey: string,
  r2: R2Client,
  reply: FastifyReply,
): Promise<MediaWire> {
  const reportId = body.report_id ?? null;
  if (reportId === null || reportId === '') {
    throw new ApiError('bad_request', `purpose '${body.purpose}' requires report_id`);
  }
  if (body.dog_id !== null && body.dog_id !== undefined && body.dog_id !== '') {
    throw new ApiError(
      'bad_request',
      `purpose '${body.purpose}' derives dog_id from the report; do not supply it`,
    );
  }
  const kind: MediaKind = body.purpose === 'report-video' ? 'video' : 'image';
  const head = await verifyUploadLanded(r2, body.key);

  const outcome = await withMutation<MediaAssetRow>(
    {
      principal,
      idempotencyKey,
      endpoint: 'POST /media',
      requestHash: hashRequestBody(body),
      keysToInvalidate: () => [],
    },
    async (tx) => {
      const linkage = await resolveStaffReportLinkage(tx, reportId);
      const row = await createMediaRow(tx, {
        ownerId: linkage.ownerId,
        dogId: linkage.dogId,
        reportId,
        kind,
        purpose: body.purpose,
        objectKey: body.key,
        contentType: head.contentType,
        bytes: head.bytes,
        createdBy: 'staff',
      });
      return { status: 201, body: row };
    },
  );

  return finishMedia(reply, outcome.status, outcome.body, r2);
}

/**
 * Validate purpose + payload combo for the OWNER upload arm and return the
 * resolved linkage. `dog_id` is required for dog-profile, forbidden elsewhere;
 * `report_id` belongs to the staff arm and is rejected here everywhere.
 * report-photo / report-video never reach this function — the route routes
 * them to {@link authorStaffReportMedia} — so they're a defensive 403.
 */
function ownerUploadLinkage(
  purpose: MediaPurpose,
  dogId: string | null,
  reportId: string | null,
): { dogId: string | null; reportId: string | null } {
  if (purpose === 'dog-profile') {
    if (dogId === null || dogId === '') {
      throw new ApiError('bad_request', `purpose 'dog-profile' requires dog_id`);
    }
    if (reportId !== null && reportId !== '') {
      throw new ApiError('bad_request', `purpose 'dog-profile' cannot carry report_id`);
    }
    return { dogId, reportId: null };
  }
  if (purpose === 'owner-avatar' || purpose === 'message-attachment') {
    // No FK linkage; the row carries owner_id (the principal) only.
    if (dogId !== null && dogId !== '') {
      throw new ApiError('bad_request', `purpose '${purpose}' cannot carry dog_id`);
    }
    if (reportId !== null && reportId !== '') {
      throw new ApiError('bad_request', `purpose '${purpose}' cannot carry report_id`);
    }
    return { dogId: null, reportId: null };
  }
  throw new ApiError('forbidden', `purpose '${purpose}' is authored via the staff portal`);
}

/** Parse the POST /media body or throw a 400 with the Zod issue detail. */
function parsePostBody(raw: unknown): PostMediaBody {
  const parsed = postBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid media payload: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Parse the POST /media/upload query (either arm) or throw a 400. */
function parseUploadQuery(raw: unknown): UploadQuery {
  const parsed = uploadQueryArmsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid upload query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Resolve a report's owner for staff-authored media: `report_id →
 * report.dog_id → dogs.owner_id`. The media row carries THAT owner so the
 * dog's owner — not the authoring staffer — can read it back via the
 * owner-scoped GET. 404 if the report (or its dog) isn't live. Shared by the
 * `POST /media` staff arm + the `POST /media/upload` proxy.
 */
async function resolveStaffReportLinkage(
  tx: Parameters<typeof reportsRepository.findByIdInTx>[0],
  reportId: string,
): Promise<{ ownerId: string; dogId: string }> {
  const report = await reportsRepository.findByIdInTx(tx, reportId);
  if (report === undefined) {
    throw new ApiError('not_found', `report ${reportId} not found`);
  }
  const ownerId = await dogsRepository.findOwnerIdInTx(tx, report.dogId);
  if (ownerId === undefined) {
    // dogs.owner_id is NOT NULL; only reachable if the report's dog was
    // soft-expired between authoring and now.
    throw new ApiError('not_found', `report ${reportId} dog is no longer live`);
  }
  return { ownerId, dogId: report.dogId };
}

/**
 * Resolve a live thread's owner for a staffer's conversation photo or video
 * (wire 9.2.0, W7): the media row carries THAT owner, so the family reads it
 * back and it can be attached only to a staff message in her threads. 404 when
 * the thread does not exist or is expired (the contract's "names a live thread").
 * No dog or report linkage.
 */
async function resolveStaffThreadLinkage(
  tx: Tx,
  threadId: string,
): Promise<{ ownerId: string; dogId: null; reportId: null }> {
  const ownerId = await threadsRepository.findOwnerById(tx, threadId);
  if (ownerId === undefined) {
    throw new ApiError('not_found', `thread ${threadId} not found`);
  }
  return { ownerId, dogId: null, reportId: null };
}

/**
 * The live row's owner stamp and uploader, for `DELETE /media/:id`'s scope check
 * (A2 OL5). Read here rather than through `mediaAssetsRepository.findById`, whose
 * row carries no `created_by`. `undefined` when the id is missing or expired.
 */
async function findLiveMediaUploaderInTx(
  tx: Tx,
  id: string,
): Promise<{ ownerId: string; createdBy: 'owner' | 'staff' } | undefined> {
  const [row] = await tx
    .select({ ownerId: mediaAssets.ownerId, createdBy: mediaAssets.createdBy })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, id), isNull(mediaAssets.expiredAt)))
    .limit(1);
  return row;
}

/**
 * Create-side shared by every POST arm: INSERT the row + enqueue its
 * derivatives job in the SAME tx so a `withMutation` rollback drops both (no
 * orphan jobs for non-existent assets). Three callers (owner register / staff
 * register / staff proxy) — extracted at the rule-of-two.
 */
async function createMediaRow(
  tx: Parameters<typeof mediaAssetsRepository.create>[0],
  values: Parameters<typeof mediaAssetsRepository.create>[1],
): Promise<MediaAssetRow> {
  const row = await mediaAssetsRepository.create(tx, values);
  await mediaDerivativeJobsRepository.enqueue(tx, { mediaAssetId: row.id });
  return row;
}

/**
 * Confirm the upload actually landed in R2 BEFORE inserting a row that
 * references the key. Returns the head (real bytes + content-type) so the row
 * records what landed, not the advisory sign-time `byte_size`. 422 if absent.
 */
async function verifyUploadLanded(r2: R2Client, key: string): Promise<HeadObjectResult> {
  const head = await r2.headObject({ key });
  if (head === null) {
    throw new ApiError(
      'invalid_payload',
      'no R2 object exists at the supplied key — did the upload complete?',
      { kind: 'media-upload-missing' },
    );
  }
  return head;
}

/**
 * Sign the row's URLs POST-commit, set the response status, and return the
 * wire. Signing lives outside `withMutation` to keep the third-party seam off
 * the tx (the Day-14/15 "call after commit" invariant). Both POST arms end here.
 */
async function finishMedia(
  reply: FastifyReply,
  status: number,
  row: MediaAssetRow,
  r2: R2Client,
): Promise<MediaWire> {
  const wire = await signMediaUrls(row, r2);
  reply.code(status);
  return wire;
}

/**
 * Sign the base + derivative GET URLs for a media row and project to the
 * wire shape. POST and GET both end here so a freshly-created row carries
 * the same shape later reads will return. Signing happens against the R2
 * seam — tests inject the stub which returns predictable `stub.r2.invalid`
 * URLs the assertions can match on.
 */
async function signMediaUrls(row: MediaAssetRow, r2: R2Client): Promise<MediaWire> {
  // Sign the base + every derivative URL in parallel. The stub returns
  // synchronously; the production AWS SDK signer is async (SigV4 over
  // crypto) so each `signGetUrl` is an independent IO unit — `Promise.all`
  // collapses N round-trips' worth of latency into one.
  const [baseUrl, derivativeUrls] = await Promise.all([
    r2.signGetUrl({ key: row.objectKey, expiresSeconds: GET_URL_TTL_SECONDS }),
    signDerivativeUrls(row.derivatives, r2),
  ]);
  const expiresAt = new Date(Date.now() + GET_URL_TTL_SECONDS * 1000).toISOString();

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

async function signDerivativeUrls(
  derivatives: MediaAssetRow['derivatives'],
  r2: R2Client,
): Promise<Record<string, string>> {
  const signed = await Promise.all(
    derivatives.map(async (d) => {
      const url = await r2.signGetUrl({
        key: d.objectKey,
        expiresSeconds: GET_URL_TTL_SECONDS,
      });
      return [d.label, url] as const;
    }),
  );
  return Object.fromEntries(signed);
}
