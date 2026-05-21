import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../client.js';
import { announcements, appLocation } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { AnnouncementRowForWire } from '../../lib/announcementWire.js';

/**
 * Data-access seam for `announcements`. Day-7b addition; mirrors the
 * Day-5/6/7a repo pattern. Announcements are NOT owner-scoped — a global
 * catalog with optional `target_location` filtering.
 *
 * Ordering: `is_pinned DESC, published_at DESC` per the schema comment
 * line 1050 (Public Pups + similar always-top items pin to the top of
 * the list, then newest published).
 */

export type AnnouncementRow = AnnouncementRowForWire;
export type AppLocation = (typeof appLocation.enumValues)[number];

const ANNOUNCEMENT_PROJECTION = {
  id: announcements.id,
  category: announcements.category,
  title: announcements.title,
  body: announcements.body,
  publishedAt: announcements.publishedAt,
  deepLinkPath: announcements.deepLinkPath,
} as const;

export const announcementsRepository = {
  /**
   * Live announcements, optionally filtered by location. NULL
   * `target_location` rows match every location (school-wide); a
   * non-NULL filter additionally matches rows targeting that exact
   * location. Drives `GET /announcements`.
   *
   * The `is_pinned, published_at` index is the natural order for both
   * the unfiltered and filtered reads — the location filter is selective
   * enough that the planner will still pick the same ORDER BY.
   */
  async findLive(location: AppLocation | null): Promise<AnnouncementRow[]> {
    const locationCondition =
      location === null
        ? undefined
        : or(isNull(announcements.targetLocation), eq(announcements.targetLocation, location));
    return db
      .select(ANNOUNCEMENT_PROJECTION)
      .from(announcements)
      .where(and(live(announcements), locationCondition))
      .orderBy(
        desc(announcements.isPinned),
        desc(announcements.publishedAt),
        asc(announcements.id),
      );
  },
};
