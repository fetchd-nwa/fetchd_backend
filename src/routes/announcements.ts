import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { toAnnouncementWire, type AnnouncementWire } from '../lib/announcementWire.js';
import { announcementsRepository } from '../db/repositories/announcementsRepository.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';

/**
 * `GET /announcements?location=` `[auth]` — school-wide announcements
 * catalog (DATA-CONTRACT §C announcements + §B Announcement). Not
 * owner-scoped — both owners and staff see the same list (staff might
 * want to confirm what owners are seeing).
 *
 * The `?location=` query param is the location `slug` (`fayetteville` /
 * `bentonville`) — the same value `announcements.target_location` stores
 * (FK `locations(slug)`), so it filters directly with no translation.
 *
 * Filter semantics:
 *   - no param → all live announcements (every target).
 *   - param set → school-wide rows (NULL target) + rows targeting that
 *     exact location.
 *
 * Ordering: pinned first, then newest published.
 */

const LOCATION_VALUES = LOCATION_SLUGS;
type LocationKey = (typeof LOCATION_VALUES)[number];

const listQuerySchema = z.object({
  location: z.enum(LOCATION_VALUES).optional(),
});

export function registerAnnouncementsRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  app.get(
    '/announcements',
    { preHandler: [authHook] },
    async (request): Promise<AnnouncementWire[]> => {
      const { location } = parseListQuery(request.query);
      const rows = await announcementsRepository.findLive(location ?? null);
      return rows.map((row) => toAnnouncementWire(row));
    },
  );
}

// ---- query parsing -------------------------------------------------------

function parseListQuery(query: unknown): { location?: LocationKey } {
  const parsed = listQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
