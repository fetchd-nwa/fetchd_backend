import { pgTimestampToIso } from './pgTimestamp.js';

/**
 * Wire shapes for `Event` + `EventRsvp` per DATA-CONTRACT §B + the FE
 * `eventRepository.ts` translators (the "wire keys exactly as the current
 * `toX()` translators read them" clause from §B line 289-292).
 *
 * Two flattenings:
 *   - `events.starts_at` → wire key `date` (the FE Raw shape uses `date`,
 *     not `starts_at`). Schema column kept its name (`starts_at` is more
 *     accurate at the DB layer where ranges + duration math live), but the
 *     wire honors the FE contract.
 *   - `events.loc_*` (4 flat columns: loc_label, loc_address, loc_latitude,
 *     loc_longitude) → nested `location: { label, address, latitude,
 *     longitude }` object.
 *
 * Deferred (additive when FE consumes): `events.series_id`, `events.capacity`.
 * Both are real DB state but absent from the current FE Raw type; per §B
 * "No shape changes beyond R5 (absolute dates) and R6 (uuid ids)" we don't
 * emit them yet. The day the FE adds a capacity bar or series indicator,
 * each is an additive wire key — no breaking change.
 *
 * RSVPs: `event_rsvps` carries `owner_id` + `event_id` + timestamp, and
 * `event_rsvp_dogs` is the M:N to dogs. The wire denormalizes the dog ids
 * back into the RSVP row. Owner-scoping is the route's job; this helper
 * trusts that rows passed in already belong to the requester.
 */

export interface EventLocationWire {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface EventWire {
  id: string;
  name: string;
  date: string;
  duration_minutes: number;
  location: EventLocationWire;
  description?: string;
  is_recurring: boolean;
}

export interface EventRsvpWire {
  id: string;
  event_id: string;
  dog_ids: string[];
  rsvpd_at: string;
}

/**
 * Subset of `events` columns the wire helper consumes. Structural —
 * matches the `EVENT_PROJECTION` in `eventsRepository.ts`.
 */
export interface EventRowForWire {
  id: string;
  name: string;
  startsAt: string;
  durationMinutes: number;
  locLabel: string;
  locAddress: string;
  locLatitude: number;
  locLongitude: number;
  description: string | null;
  isRecurring: boolean;
}

/** Subset of `event_rsvps` columns the wire helper consumes. */
export interface EventRsvpRowForWire {
  id: string;
  eventId: string;
  rsvpdAt: string;
}

/**
 * Emit the Event wire shape. Pure JSON shaping — no DB access.
 * Optional-omit on `description?` per the Day-4a convention (omit when
 * null/empty); all other keys are required.
 */
export function toEventWire(row: EventRowForWire): EventWire {
  const wire: EventWire = {
    id: row.id,
    name: row.name,
    date: pgTimestampToIso(row.startsAt),
    duration_minutes: row.durationMinutes,
    location: {
      label: row.locLabel,
      address: row.locAddress,
      latitude: row.locLatitude,
      longitude: row.locLongitude,
    },
    is_recurring: row.isRecurring,
  };
  if (row.description !== null && row.description !== '') {
    wire.description = row.description;
  }
  return wire;
}

/**
 * Emit the EventRsvp wire shape. `dogIds` come pre-resolved from
 * `event_rsvp_dogs` (the route batches the lookup across all the
 * owner's rsvps).
 */
export function toEventRsvpWire(row: EventRsvpRowForWire, dogIds: string[]): EventRsvpWire {
  return {
    id: row.id,
    event_id: row.eventId,
    dog_ids: dogIds,
    rsvpd_at: pgTimestampToIso(row.rsvpdAt),
  };
}
