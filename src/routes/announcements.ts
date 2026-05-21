import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { toAnnouncementWire, type AnnouncementWire } from '../lib/announcementWire.js';
import {
  announcementsRepository,
  type AppLocation,
} from '../db/repositories/announcementsRepository.js';
import { locationKey } from '../db/schema/schema.js';

/**
 * `GET /announcements?location=` `[auth]` — school-wide announcements
 * catalog (DATA-CONTRACT §C announcements + §B Announcement). Not
 * owner-scoped — both owners and staff see the same list (staff might
 * want to confirm what owners are seeing).
 *
 * The `?location=` query param accepts the **`location_key`** slug
 * (`fayetteville` / `bentonville`) for consistency with every other
 * location-taking endpoint (bookings, availability, rates, day_capacity
 * all use `location_key`). The server maps to the `app_location` enum
 * value (`'Fayetteville, AR'` / `'Bentonville, AR'`) that the schema
 * column carries — a 2-entry lookup, not worth a generic mapper.
 *
 * Filter semantics:
 *   - no param → all live announcements (every target).
 *   - param set → school-wide rows (NULL target) + rows targeting that
 *     exact location.
 *
 * Ordering: pinned first, then newest published.
 */

const LOCATION_VALUES = pgEnumTuple(locationKey);
type LocationKey = (typeof LOCATION_VALUES)[number];

const listQuerySchema = z.object({
  location: z.enum(LOCATION_VALUES).optional(),
});

/**
 * The two-entry slug → app_location mapping. Inlined here because the
 * mapping has exactly two values and no other consumer; promote to
 * `lib/location.ts` only if a second use shows up.
 */
const LOCATION_KEY_TO_APP_LOCATION: Record<LocationKey, AppLocation> = {
  fayetteville: 'Fayetteville, AR',
  bentonville: 'Bentonville, AR',
};

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
      const target = location === undefined ? null : LOCATION_KEY_TO_APP_LOCATION[location];
      const rows = await announcementsRepository.findLive(target);
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
