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
 *   - `cta?` (Day 19e) — the Recent-Updates detail CTA. Emitted as a nested
 *     object so its three correlated fields travel as a unit (the DB CHECK
 *     guarantees all-or-none). The FE parses `kind`+`target` into a typed
 *     discriminated union at its wire boundary (route allowlist enforced there).
 *
 * NOT emitted (server-side concerns):
 *   - `target_location` — server uses it for the `?location=` query filter;
 *     the FE doesn't display per-row location targeting.
 *   - `is_pinned` — drives server-side sort; FE displays in returned order.
 *   - `created_at` / `expired_at` — internal lifecycle metadata.
 */

export type AnnouncementCategory = (typeof announcementCategory.enumValues)[number];

/** CTA target discriminator. See `announcements.cta_kind` (schema.sql). */
export type AnnouncementCtaKind = 'enroll' | 'route' | 'external';

export interface AnnouncementCtaWire {
  label: string;
  kind: AnnouncementCtaKind;
  target: string;
}

export interface AnnouncementWire {
  id: string;
  category: AnnouncementCategory;
  title: string;
  body?: string;
  published_at: string;
  deep_link_path?: string;
  cta?: AnnouncementCtaWire;
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
  ctaLabel: string | null;
  ctaKind: AnnouncementCtaKind | null;
  ctaTarget: string | null;
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
  // CTA is all-or-none at the DB; emit as a unit only when fully present.
  if (row.ctaLabel !== null && row.ctaKind !== null && row.ctaTarget !== null) {
    wire.cta = { label: row.ctaLabel, kind: row.ctaKind, target: row.ctaTarget };
  }
  return wire;
}
