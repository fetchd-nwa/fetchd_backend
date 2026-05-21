import { pgTimestampToIso } from './pgTimestamp.js';
import { announcementCategory } from '../db/schema/schema.js';

/**
 * Wire shape for `Announcement` per DATA-CONTRACT §B (line 289-292 — "wire
 * keys exactly as the current `toX()` translators read them") + the FE
 * `announcementRepository.ts` Raw type.
 *
 * Conventions (Day-5a/4a wire-shape rules):
 *   - Required keys: always emit. (`id`, `category`, `title`, `published_at`).
 *   - Optional `?` keys: omit when null/empty. `body?` and `deep_link_path?`.
 *
 * NOT emitted (server-side concerns):
 *   - `target_location` — server uses it for the `?location=` query filter;
 *     the FE doesn't display per-row location targeting.
 *   - `is_pinned` — drives server-side sort; FE displays in returned order.
 *   - `created_at` / `expired_at` — internal lifecycle metadata.
 */

export type AnnouncementCategory = (typeof announcementCategory.enumValues)[number];

export interface AnnouncementWire {
  id: string;
  category: AnnouncementCategory;
  title: string;
  body?: string;
  published_at: string;
  deep_link_path?: string;
}

/**
 * Subset of `announcements` columns the wire helper consumes. Structural —
 * matches `ANNOUNCEMENT_PROJECTION` in `announcementsRepository.ts`.
 */
export interface AnnouncementRowForWire {
  id: string;
  category: AnnouncementCategory;
  title: string;
  body: string | null;
  publishedAt: string;
  deepLinkPath: string | null;
}

/**
 * Emit the Announcement wire shape. Pure JSON shaping — no DB access.
 */
export function toAnnouncementWire(row: AnnouncementRowForWire): AnnouncementWire {
  const wire: AnnouncementWire = {
    id: row.id,
    category: row.category,
    title: row.title,
    published_at: pgTimestampToIso(row.publishedAt),
  };
  if (row.body !== null && row.body !== '') {
    wire.body = row.body;
  }
  if (row.deepLinkPath !== null && row.deepLinkPath !== '') {
    wire.deep_link_path = row.deepLinkPath;
  }
  return wire;
}
