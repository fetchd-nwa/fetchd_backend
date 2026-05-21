import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../client.js';
import { eventRsvpDogs, eventRsvps, events } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { EventRowForWire, EventRsvpRowForWire } from '../../lib/eventWire.js';

/**
 * Data-access seam for `events` (+ `event_rsvps` + `event_rsvp_dogs`).
 * Day-7a addition; mirrors the threads/messages split — events catalog
 * separate from owner's-rsvps. Events themselves are a public-ish
 * resource (no owner_id column); the owner-scoping happens only on
 * RSVPs through `event_rsvps.owner_id`.
 */

export type EventRow = EventRowForWire;
export type EventRsvpRow = EventRsvpRowForWire;

const EVENT_PROJECTION = {
  id: events.id,
  name: events.name,
  startsAt: events.startsAt,
  durationMinutes: events.durationMinutes,
  locLabel: events.locLabel,
  locAddress: events.locAddress,
  locLatitude: events.locLatitude,
  locLongitude: events.locLongitude,
  description: events.description,
  isRecurring: events.isRecurring,
} as const;

const EVENT_RSVP_PROJECTION = {
  id: eventRsvps.id,
  eventId: eventRsvps.eventId,
  rsvpdAt: eventRsvps.rsvpdAt,
} as const;

export const eventsRepository = {
  /**
   * Every live event, oldest start first. Not owner-scoped — events are a
   * shared resource (Public Pups, Yappy Hour, etc.). Drives `GET /events`.
   * Past events are intentionally included so the FE can show "this week"
   * vs "last week" lists — the FE filters by date, not the API.
   */
  async findLive(): Promise<EventRow[]> {
    return db
      .select(EVENT_PROJECTION)
      .from(events)
      .where(live(events))
      .orderBy(asc(events.startsAt));
  },

  /** Single event by id, live only. Returns undefined when not found / expired. */
  async findLiveById(id: string): Promise<EventRow | undefined> {
    const rows = await db
      .select(EVENT_PROJECTION)
      .from(events)
      .where(and(eq(events.id, id), live(events)))
      .limit(1);
    return rows[0];
  },

  /**
   * The owner's live RSVPs across all events, oldest first. Drives
   * `GET /events/rsvps`. Owner-scoped via `event_rsvps.owner_id`. Caller
   * batches dog-id resolution upstream via `findDogsByRsvpIds`.
   */
  async findLiveRsvpsByOwner(ownerId: string): Promise<EventRsvpRow[]> {
    return db
      .select(EVENT_RSVP_PROJECTION)
      .from(eventRsvps)
      .where(and(eq(eventRsvps.ownerId, ownerId), live(eventRsvps)))
      .orderBy(asc(eventRsvps.rsvpdAt));
  },

  /**
   * Resolve `event_rsvp_dogs` membership for a batch of rsvp ids. Live
   * rows only, ordered by `dog_id` ASC for snapshot stability. The
   * convention matches `threadsRepository.findDogsByThreadIds`.
   */
  async findDogsByRsvpIds(rsvpIds: string[]): Promise<{ rsvpId: string; dogId: string }[]> {
    if (rsvpIds.length === 0) return [];
    return db
      .select({
        rsvpId: eventRsvpDogs.rsvpId,
        dogId: eventRsvpDogs.dogId,
      })
      .from(eventRsvpDogs)
      .where(and(inArray(eventRsvpDogs.rsvpId, rsvpIds), live(eventRsvpDogs)))
      .orderBy(asc(eventRsvpDogs.dogId));
  },
};
