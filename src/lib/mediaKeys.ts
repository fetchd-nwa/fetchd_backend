import { randomUUID } from 'node:crypto';
import type { MediaPurpose } from '../contracts/wire.js';
import { ApiError } from './errors.js';

/**
 * Shared media key-generation + content-type validation (Day-17 + Day-19c).
 * Two call sites: `POST /uploads/sign` (presign-direct, the mobile path) and
 * `POST /media/upload` (server-side proxy, the portal path). Extracted at the
 * rule-of-two so both produce identical R2 keys + enforce the same MIME rules.
 *
 * The R2 object key is always SERVER-generated (`{purpose}/{scope}/{uuid}.{ext}`)
 * so a client can't choose or collide a key, and a leaked credential can't
 * write outside its own scope namespace.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB — generous for high-res phone photos

// Promoted to the contract at 1.13.0 — re-exported so no consumer moves
// (designs/wire-contract-completion.md §6; digest reports/S). Member-for-member
// identical to the union it replaces.
export type { MediaPurpose };

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

/**
 * Enforce the per-purpose content-type rule. Image purposes accept image/*;
 * `report-video` accepts video MIMEs; `message-attachment` accepts EITHER
 * (owners send both photos and videos in chat). Day-17 ships sharp-only — a
 * video's derivatives job parks until ffmpeg lands, but the source is still
 * stored + readable. Throws 400 on a mismatch.
 */
export function assertContentTypeMatchesPurpose(purpose: MediaPurpose, contentType: string): void {
  const isImage = IMAGE_TYPES.has(contentType);
  const isVideo = VIDEO_TYPES.has(contentType);

  if (purpose === 'message-attachment') {
    if (!isImage && !isVideo) {
      throw new ApiError(
        'bad_request',
        `purpose '${purpose}' requires an image or video content_type, got '${contentType}'`,
      );
    }
    return;
  }

  const wantsVideo = purpose === 'report-video';
  if (wantsVideo && !isVideo) {
    throw new ApiError(
      'bad_request',
      `purpose '${purpose}' requires a video content_type (mp4/quicktime/webm), got '${contentType}'`,
    );
  }
  if (!wantsVideo && !isImage) {
    throw new ApiError(
      'bad_request',
      `purpose '${purpose}' requires an image content_type (jpeg/png/webp/heic/heif), got '${contentType}'`,
    );
  }
}

/** Map a content type to its media kind. Videos are `video/*`; everything else image. */
export function mediaKindForContentType(contentType: string): 'image' | 'video' {
  return contentType.startsWith('video/') ? 'video' : 'image';
}

/** Server-generated R2 object key: `{purpose}/{principal-scope}/{uuid}.{ext}`. */
export function mediaObjectKey(
  purpose: MediaPurpose,
  principalScope: string,
  contentType: string,
): string {
  return `${purpose}/${principalScope}/${randomUUID()}${extensionForContentType(contentType)}`;
}

function extensionForContentType(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/heic':
      return '.heic';
    case 'image/heif':
      return '.heif';
    case 'video/mp4':
      return '.mp4';
    case 'video/quicktime':
      return '.mov';
    case 'video/webm':
      return '.webm';
    default:
      return '';
  }
}
