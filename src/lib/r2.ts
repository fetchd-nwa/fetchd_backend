import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

/**
 * Cloudflare R2 seam (Day 17). All R2 calls flow through `R2Client`; routes +
 * the derivatives worker consume it via DI (`registerXxxRoute(app, { r2 })`)
 * so contract tests substitute an in-memory stub and the suite stays offline.
 *
 * Design choices:
 *   - **R2 is S3-API compatible** so we use the AWS SDK v3 with R2's
 *     endpoint URL (`https://<account_id>.r2.cloudflarestorage.com`) and
 *     `region: 'auto'`. No R2-specific SDK exists — the S3 SDK is the
 *     canonical path Cloudflare documents.
 *   - **The bucket is private.** Reads + writes ALWAYS go through a
 *     short-lived presigned URL — there is no public-bucket fallback. This
 *     keeps photos owner-private without RLS (DATA-CONTRACT §C.2).
 *   - **The client never proxies bytes.** Owners upload directly to R2 via
 *     presigned PUT; the FE downloads directly via presigned GET. Node only
 *     issues the URLs and verifies via `headObject`. This is the only way to
 *     keep the API hot path off the byte stream.
 *   - **`deleteObject` is intentionally absent.** Per the never-delete
 *     invariant, the API soft-expires the `media_assets` row only; a Day-20+
 *     cleanup job sweeps long-expired R2 objects. Wiring delete here today
 *     would invite accidental hard-deletes from a future caller.
 *
 * The interface is narrow — only the 3 verbs Day-17 actually calls. Adding a
 * method here when a future day needs it is the rule-of-two trigger.
 */

export interface SignPutUrlArgs {
  key: string;
  contentType: string;
  /** TTL in seconds. The route picks the value; the seam doesn't default. */
  expiresSeconds: number;
}

export interface SignPutUrlResult {
  /** Presigned URL the client PUTs the bytes to. */
  url: string;
  /**
   * Headers the client MUST send with the PUT. `Content-Type` is enforced
   * by the SigV4 signature; mismatched values will reject. The FE forwards
   * these verbatim to its upload step.
   */
  headers: Record<string, string>;
}

export interface SignGetUrlArgs {
  key: string;
  expiresSeconds: number;
}

export interface HeadObjectResult {
  /** Byte size of the object as reported by R2. */
  bytes: number;
  /** Content-Type the client PUT with (R2 echoes what was signed). */
  contentType: string;
  etag: string;
}

export interface GetObjectBytesResult {
  bytes: Uint8Array;
  contentType: string;
}

export interface R2Client {
  /**
   * Sign a single-use PUT URL the client uploads bytes directly to. The
   * server-generated `key` is what the client passes back to POST /media
   * after the upload completes.
   *
   * `Content-Type` is part of the signature (anti-tampering); a mismatched
   * upload Content-Type will be rejected by R2 with 403. Tests that drive
   * the route assert the route returns a `Content-Type` header so the FE
   * can attach it on the actual PUT.
   */
  signPutUrl(args: SignPutUrlArgs): Promise<SignPutUrlResult>;

  /**
   * Sign a single-use GET URL. Used by GET /media/:id after the route
   * verifies ownership. Short TTL (route-controlled — 5 min in production)
   * keeps the URL useless if it leaks; the FE re-fetches on expiry.
   */
  signGetUrl(args: SignGetUrlArgs): Promise<string>;

  /**
   * Verify an object actually exists and return its size + content-type.
   * Used by POST /media to confirm the client actually completed the PUT
   * before we INSERT a row referencing the key. If R2 returns 404 the seam
   * surfaces it as `null` (route maps to 422 `media_upload_missing`).
   */
  headObject(args: { key: string }): Promise<HeadObjectResult | null>;

  /**
   * Fetch the raw bytes of an object. Used by the derivatives worker to
   * read the source image, run sharp, and re-PUT each derivative. Worker-
   * only — routes never call this (presigned GET is the answer for clients).
   */
  getObjectBytes(args: { key: string }): Promise<GetObjectBytesResult>;

  /**
   * Upload bytes directly (worker-side, no presign). The derivatives worker
   * writes thumbnail/feed/lightbox WebPs straight to R2 — there's no client
   * round-trip to presign for. The `key` is server-generated to live
   * adjacent to the source (`derivative/<size>/<uuid>.webp`).
   */
  putObjectBytes(args: { key: string; contentType: string; bytes: Uint8Array }): Promise<void>;
}

const R2_ENDPOINT = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const s3Singleton = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Default production R2 client. Wraps the AWS SDK v3 with R2's endpoint.
 * Errors from R2 are surfaced as-is (S3ServiceException subclasses); callers
 * either swallow + log (post-commit worker) or re-throw (sync route paths).
 * The seam intentionally does NOT translate S3 errors to ApiError — that's
 * the route's job, with context about which operation failed.
 */
export const defaultR2Client: R2Client = {
  async signPutUrl({ key, contentType, expiresSeconds }) {
    const command = new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(s3Singleton, command, { expiresIn: expiresSeconds });
    return {
      url,
      headers: { 'Content-Type': contentType },
    };
  },

  async signGetUrl({ key, expiresSeconds }) {
    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
    });
    return getSignedUrl(s3Singleton, command, { expiresIn: expiresSeconds });
  },

  async headObject({ key }) {
    try {
      const out = await s3Singleton.send(
        new HeadObjectCommand({
          Bucket: env.R2_BUCKET,
          Key: key,
        }),
      );
      return {
        bytes: out.ContentLength ?? 0,
        contentType: out.ContentType ?? 'application/octet-stream',
        etag: (out.ETag ?? '').replace(/"/g, ''),
      };
    } catch (err) {
      // The SDK throws NotFound (404) or NoSuchKey for missing objects.
      // Surface as null so the route maps to a typed 422 rather than 500;
      // any other error (auth, transport) re-throws so it surfaces in logs.
      if (isNotFoundError(err)) return null;
      throw err;
    }
  },

  async getObjectBytes({ key }) {
    const out = await s3Singleton.send(
      new GetObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
      }),
    );
    if (out.Body === undefined) {
      throw new Error(`R2 getObject ${key}: empty Body`);
    }
    const bytes = await out.Body.transformToByteArray();
    return {
      bytes,
      contentType: out.ContentType ?? 'application/octet-stream',
    };
  },

  async putObjectBytes({ key, contentType, bytes }) {
    await s3Singleton.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        ContentType: contentType,
        Body: bytes,
      }),
    );
  },
};

function isNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
  if (e.$metadata !== undefined && e.$metadata.httpStatusCode === 404) return true;
  return false;
}
