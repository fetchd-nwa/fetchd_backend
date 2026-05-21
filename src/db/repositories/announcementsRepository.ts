import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { readThrough } from '../../lib/cache.js';
import { pgEnumTuple } from '../../lib/pgEnumTuple.js';
import { db } from '../client.js';
import { announcementCategory, announcements, appLocation } from '../schema/schema.js';
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

/**
 * Day-8 cache: announcements are a small, school-wide catalog that
 * changes only on staff publish/expire (Day 12+ portal verb). 5 minutes
 * is the right TTL — fast enough that a manual expire is reflected
 * shortly even before the writing-service invalidation lands, slow
 * enough that the cache earns its keep on the read traffic.
 */
const ANNOUNCEMENTS_TTL_SEC = 300;

const ANNOUNCEMENT_ROW_SCHEMA: z.ZodType<AnnouncementRow> = z.object({
  id: z.string().uuid(),
  category: z.enum(pgEnumTuple(announcementCategory)),
  title: z.string(),
  body: z.string().nullable(),
  publishedAt: z.string(),
  deepLinkPath: z.string().nullable(),
});
const ANNOUNCEMENT_ROWS_SCHEMA = ANNOUNCEMENT_ROW_SCHEMA.array();

/** Cache key for `findLive`. `'all'` is the bare-query (no `?location=`). */
export function announcementsCacheKey(location: AppLocation | null): string {
  return `ann:${location ?? 'all'}`;
}

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
   *
   * Day-8 read-through cached under `ann:{location|all}` for 5 min.
   * Invalidated by Day-12+ announcement publish/expire mutations via
   * `invalidate([announcementsCacheKey(loc)])`.
   */
  async findLive(location: AppLocation | null): Promise<AnnouncementRow[]> {
    return readThrough(
      announcementsCacheKey(location),
      ANNOUNCEMENTS_TTL_SEC,
      ANNOUNCEMENT_ROWS_SCHEMA,
      () => {
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
    );
  },
};
