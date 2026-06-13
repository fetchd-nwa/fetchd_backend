import {
  mediaAssetsRepository,
  type MediaPurpose,
} from '../db/repositories/mediaAssetsRepository.js';
import type { Tx } from '../db/tx.js';
import { ApiError } from './errors.js';
import type { R2Client } from './r2.js';

/**
 * Resolve stored profile/avatar image paths (`dogs.profile_image_path`,
 * `owners.avatar_image_path`) to signed GET URLs at READ time, so the FE wire
 * shape stays a plain string — exactly as schema.sql documents
 * ("the API resolves id → signed URL at read time so the FE shape is unchanged").
 *
 * A media-asset UUID (set once an owner uploads a photo) → a 1h signed URL.
 * A seed/bundled path (`images/dogs/...`) or '' → returned unchanged, so the FE
 * keeps resolving bundled assets locally and the dog/me byte-match snapshots
 * stay green (seed paths aren't UUIDs, so they never enter the sign path).
 *
 * Signing is local SigV4 HMAC (no R2 round-trip), and the lookup + signing are
 * batched, so resolving a screen full of avatars is one query + parallel HMACs.
 */

// 1h — profile pics are low-sensitivity, and every list that embeds them
// refetches far inside this window, so a cached wire never holds a dead URL.
const PROFILE_IMAGE_URL_TTL_SECONDS = 60 * 60;

const MEDIA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a stored image path is a media_assets UUID (vs a bundled-asset path). */
export function isMediaId(path: string): boolean {
  return MEDIA_UUID_RE.test(path);
}

/**
 * Build a path→URL resolver for a batch of stored image paths. Looks up the
 * media rows for the UUID paths once, signs each in parallel, and returns a
 * pure function that maps a UUID path to its signed URL (and passes everything
 * else through untouched). Returns the identity function when no path is a UUID.
 */
export async function buildProfileImageUrlResolver(
  paths: string[],
  r2: R2Client,
): Promise<(path: string) => string> {
  const ids = [...new Set(paths.filter(isMediaId))];
  if (ids.length === 0) return (path) => path;

  const rows = await mediaAssetsRepository.findManyByIds(ids);
  const signed = await Promise.all(
    rows.map(async (row) => {
      const url = await r2.signGetUrl({
        key: row.objectKey,
        expiresSeconds: PROFILE_IMAGE_URL_TTL_SECONDS,
      });
      return [row.id, url] as const;
    }),
  );
  const urlById = new Map(signed);
  return (path) => (isMediaId(path) ? (urlById.get(path) ?? path) : path);
}

/**
 * Guard a WRITE of a profile/avatar image path. When the path is a media-asset
 * UUID it MUST be the owner's own, live, with the expected purpose — otherwise
 * an owner could point their dog/avatar at another tenant's media UUID and the
 * read-time resolver would happily sign + serve it (cross-tenant leak). A
 * non-UUID path (bundled '' / seed asset) is left to the existing permissive
 * contract. Call inside the mutation tx, before persisting the path.
 */
export async function assertOwnedImagePath(
  tx: Tx,
  ownerId: string,
  path: string,
  expectedPurpose: MediaPurpose,
): Promise<void> {
  if (!isMediaId(path)) return;
  const row = await mediaAssetsRepository.findById(path, tx);
  if (row === undefined || row.ownerId !== ownerId || row.purpose !== expectedPurpose) {
    throw new ApiError(
      'invalid_payload',
      `image media ${path} is not an uploadable ${expectedPurpose}`,
    );
  }
}
