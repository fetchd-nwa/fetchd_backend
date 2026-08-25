import { pgTimestampToIso } from './pgTimestamp.js';

/**
 * Backend adapter for the Announcement wire shape. As of contract 1.13.0 the wire types
 * themselves — `AnnouncementCategory`, `AnnouncementCtaKind`, `AnnouncementCtaWire` and
 * `AnnouncementWire` — live in `src/contracts/wire.ts` (their single source of truth,
 * generated verbatim into both clients), and the emit conventions + the "NOT emitted"
 * list travel with them there. This module re-exports the four so existing importers keep
 * their `../lib/announcementWire.js` path, and keeps the two backend-only pieces the
 * contract has no home for: the camelCase DB-row projection (`AnnouncementRowForWire`) and
 * the `toAnnouncementWire` shaper. Same split as `notificationWire.ts`.
 *
 * Wire-shape rules (Day-5a/4a) that `toAnnouncementWire` implements:
 *   - Required keys always emit: `id`, `category`, `title`, `published_at`.
 *   - Optional `?` keys are OMITTED when null/empty: `body`, `deep_link_path`.
 *   - `cta` (Day 19e) is emitted as a nested object only when all three columns are
 *     present — the DB CHECK guarantees all-or-none. The FE parses `kind` + `target` into
 *     a typed discriminated union at its wire boundary (route allowlist enforced there).
 */

export type {
  AnnouncementCategory,
  AnnouncementCtaKind,
  AnnouncementCtaWire,
  AnnouncementWire,
} from '../contracts/wire.js';

import type {
  AnnouncementCategory,
  AnnouncementCtaKind,
  AnnouncementWire,
} from '../contracts/wire.js';

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
