import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import {
  MAX_UPLOAD_BYTES,
  assertContentTypeMatchesPurpose,
  mediaObjectKey,
} from '../lib/mediaKeys.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * `POST /uploads/sign` `[auth]` — issue a presigned R2 PUT URL the client
 * uploads bytes directly to. The server generates the R2 object key (clients
 * can't choose or collide) and returns it alongside the URL + Content-Type
 * header the FE must echo on the PUT. The client follows up with
 * `POST /media` to record the upload + kick off derivative processing
 * (DATA-CONTRACT §C.2).
 *
 * Auth: any authenticated principal (owner or staff). The signed URL is
 * single-use and short-lived; abuse vectors are bounded by the TTL. The
 * server generates the key under `{purpose}/{owner_id-or-staff_id}/{uuid}`
 * so a leaked credential can't write to another principal's path namespace.
 *
 * No `Idempotency-Key` required — this route doesn't write to the DB.
 * A client retry just gets a new presigned URL + new key; orphan keys
 * never referenced by POST /media stay in R2 until a Day-20+ cleanup
 * sweep finds them.
 */

const PUT_URL_TTL_SECONDS = 60 * 15; // 15 min — long enough for a slow connection

const mediaPurposeSchema = z.enum([
  'dog-profile',
  'owner-avatar',
  'report-photo',
  'report-video',
  'message-attachment',
]);

const bodySchema = z
  .object({
    purpose: mediaPurposeSchema,
    content_type: z.string().min(1),
    byte_size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  })
  .strict();

export interface UploadsSignRequest {
  purpose: z.infer<typeof mediaPurposeSchema>;
  content_type: string;
  byte_size: number;
}

export interface UploadsSignResponse {
  /** Presigned PUT URL — the client PUTs bytes directly to this URL. */
  url: string;
  /** Headers the client MUST send with the PUT (signed-in Content-Type). */
  headers: Record<string, string>;
  /**
   * The R2 object key the upload lands at. Pass this to POST /media after
   * the PUT completes. Server-generated — clients cannot specify.
   */
  key: string;
  /** ISO timestamp at which the presigned URL stops working. */
  expires_at: string;
}

export interface UploadsSignRouteOpts extends AuthRouteOptions {
  /** Override the R2 client (contract tests inject the stub). */
  r2?: R2Client;
}

export function registerUploadsSignRoute(
  app: FastifyInstance,
  opts: UploadsSignRouteOpts = {},
): void {
  const authHook = resolveAuthHook(opts);
  const r2 = opts.r2 ?? defaultR2Client;

  app.post(
    '/uploads/sign',
    { preHandler: [authHook] },
    async (request): Promise<UploadsSignResponse> => {
      const principal = requirePrincipal(request);
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError(
          'bad_request',
          `invalid upload sign payload: ${formatZodIssues(parsed.error)}`,
        );
      }
      const { purpose, content_type, byte_size } = parsed.data;

      assertContentTypeMatchesPurpose(purpose, content_type);

      const principalScope =
        principal.kind === 'owner' ? `owner-${principal.ownerId}` : `staff-${principal.staffId}`;
      const key = mediaObjectKey(purpose, principalScope, content_type);

      const { url, headers } = await r2.signPutUrl({
        key,
        contentType: content_type,
        expiresSeconds: PUT_URL_TTL_SECONDS,
      });

      const expiresAt = new Date(Date.now() + PUT_URL_TTL_SECONDS * 1000).toISOString();

      // Byte-size is informational at sign-time (R2 will enforce on PUT
      // via the actual content-length); we log it for observability so
      // an attacker-claimed small upload that arrives large is visible.
      request.log.info({ purpose, key, byteSize: byte_size }, 'r2 upload signed');

      return { url, headers, key, expires_at: expiresAt };
    },
  );
}
