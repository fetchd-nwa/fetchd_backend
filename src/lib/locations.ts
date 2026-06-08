import { LOCATION_SLUGS, type LocationKey } from '../db/schema/schema.js';

/**
 * The owner/staff profile WIRE uses the human display label ('Fayetteville, AR')
 * — the mobile `User.location` union — while the DB stores the location `slug`
 * (FK `locations.slug`). These translate between the two at that boundary.
 *
 * `locations.display_name` is the DB source of truth for the label; this static
 * map mirrors it for the wire-validation + translation path and stays in lockstep
 * with the mobile `Location` union when a school is added. Every OTHER location
 * surface (bookings, credits, capacity, rates) already uses the slug end-to-end,
 * so no translation is needed there.
 */
export const LOCATION_DISPLAY_NAMES = ['Fayetteville, AR', 'Bentonville, AR'] as const;
export type LocationDisplay = (typeof LOCATION_DISPLAY_NAMES)[number];

export const LOCATION_DISPLAY: Record<LocationKey, LocationDisplay> = {
  fayetteville: 'Fayetteville, AR',
  bentonville: 'Bentonville, AR',
};

const SLUG_BY_DISPLAY: Record<LocationDisplay, LocationKey> = {
  'Fayetteville, AR': 'fayetteville',
  'Bentonville, AR': 'bentonville',
};

export function displayToSlug(display: LocationDisplay): LocationKey {
  return SLUG_BY_DISPLAY[display];
}

export function slugToDisplay(slug: LocationKey): LocationDisplay {
  return LOCATION_DISPLAY[slug];
}

// Re-exported for callers that validate/iterate slugs alongside the display map.
export { LOCATION_SLUGS, type LocationKey };
