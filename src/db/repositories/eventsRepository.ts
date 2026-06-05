import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { eventRsvpDogs, eventRsvps, events } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';
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
  capacity: events.capacity,
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

  /**
   * Live RSVP'd dog count per event (sum of `event_rsvp_dogs` over each
   * event's live `event_rsvps`), for a batch of event ids. Drives the
   * `spots_filled` wire key on `GET /events` + `GET /events/:id`. Events with
   * zero RSVPs are absent from the map — callers default to 0.
   */
  async countLiveRsvpDogsByEventIds(eventIds: string[]): Promise<Map<string, number>> {
    if (eventIds.length === 0) return new Map();
    const rows = await db
      .select({ eventId: eventRsvps.eventId, count: sql<number>`count(*)::int` })
      .from(eventRsvpDogs)
      .innerJoin(eventRsvps, eq(eventRsvpDogs.rsvpId, eventRsvps.id))
      .where(and(inArray(eventRsvps.eventId, eventIds), live(eventRsvpDogs), live(eventRsvps)))
      .groupBy(eventRsvps.eventId);
    return new Map(rows.map((r) => [r.eventId, r.count]));
  },

  // --- RSVP writes (Day-19e) — all run inside the route's `withMutation` tx ---

  /**
   * Total live RSVP'd dogs for one event, under the caller's lock. The
   * capacity-ceiling numerator: `POST /events/:id/rsvp` reads this (minus the
   * owner's own current dogs) before admitting the new set.
   */
  async countLiveRsvpDogsForEventTx(tx: Tx, eventId: string): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(eventRsvpDogs)
      .innerJoin(eventRsvps, eq(eventRsvpDogs.rsvpId, eventRsvps.id))
      .where(and(eq(eventRsvps.eventId, eventId), live(eventRsvpDogs), live(eventRsvps)));
    return row?.count ?? 0;
  },

  /** The owner's live RSVP row for an event (id + rsvpd_at), or undefined. */
  async findLiveRsvpForOwnerEventTx(
    tx: Tx,
    ownerId: string,
    eventId: string,
  ): Promise<EventRsvpRow | undefined> {
    const [row] = await tx
      .select(EVENT_RSVP_PROJECTION)
      .from(eventRsvps)
      .where(
        and(eq(eventRsvps.ownerId, ownerId), eq(eventRsvps.eventId, eventId), live(eventRsvps)),
      )
      .limit(1);
    return row;
  },

  /** Live dog ids on a specific RSVP, ASC for snapshot stability. */
  async findLiveRsvpDogIdsTx(tx: Tx, rsvpId: string): Promise<string[]> {
    const rows = await tx
      .select({ dogId: eventRsvpDogs.dogId })
      .from(eventRsvpDogs)
      .where(and(eq(eventRsvpDogs.rsvpId, rsvpId), live(eventRsvpDogs)))
      .orderBy(asc(eventRsvpDogs.dogId));
    return rows.map((r) => r.dogId);
  },

  /**
   * Set the owner's RSVP for an event to exactly `dogIds`. Replace =
   * expire any current live RSVP (+ its dogs), then INSERT a fresh RSVP +
   * dog rows. A fresh row (not reuse) is required because `event_rsvp_dogs`
   * has a `(rsvp_id, dog_id)` PRIMARY KEY — re-adding a previously-removed dog
   * to the same rsvp_id would collide with its soft-expired row. The new rsvp
   * keeps the prior one as soft-expired history; the partial unique on
   * `event_rsvps` (one live per event+owner) permits the swap because the old
   * row is expired BEFORE the insert. Returns the new RSVP row.
   */
  async upsertRsvpTx(
    tx: Tx,
    args: { ownerId: string; eventId: string; dogIds: string[] },
  ): Promise<EventRsvpRow> {
    await this.expireOwnerRsvpTx(tx, { ownerId: args.ownerId, eventId: args.eventId });
    const [rsvp] = await tx
      .insert(eventRsvps)
      .values({ ownerId: args.ownerId, eventId: args.eventId })
      .returning(EVENT_RSVP_PROJECTION);
    await tx
      .insert(eventRsvpDogs)
      .values(args.dogIds.map((dogId) => ({ rsvpId: rsvp!.id, dogId })));
    return rsvp!;
  },

  /** Soft-expire the owner's live RSVP for an event (+ its dogs). No-op if none. */
  async expireOwnerRsvpTx(tx: Tx, args: { ownerId: string; eventId: string }): Promise<void> {
    const existing = await this.findLiveRsvpForOwnerEventTx(tx, args.ownerId, args.eventId);
    if (existing === undefined) return;
    await tx
      .update(eventRsvpDogs)
      .set({ expiredAt: sql`now()` })
      .where(and(eq(eventRsvpDogs.rsvpId, existing.id), live(eventRsvpDogs)));
    await tx
      .update(eventRsvps)
      .set({ expiredAt: sql`now()` })
      .where(eq(eventRsvps.id, existing.id));
  },
};
