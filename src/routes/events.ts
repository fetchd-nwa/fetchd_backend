import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { lockEvent } from '../db/locks.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues, parseOrThrow } from '../lib/zodIssues.js';
import { requireOwner } from '../lib/principalNarrows.js';
import {
  toEventRsvpWire,
  toEventWire,
  type EventRsvpWire,
  type EventWire,
} from '../lib/eventWire.js';
import { eventsRepository } from '../db/repositories/eventsRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';

/**
 * `GET /events` `[auth]` · `GET /events/:id` `[auth]` ·
 * `GET /events/rsvps` `[auth]` · `POST /events/:id/rsvp` `[auth, owner]` ·
 * `DELETE /events/:id/rsvp` `[auth, owner]` — events catalog + owner RSVP
 * surface (DATA-CONTRACT §C events). Events are a shared catalog (no
 * owner_id); RSVPs are owner-scoped through `event_rsvps.owner_id`.
 *
 * Day-19e: the read wire grew `spots_filled` (+ `capacity`) so the
 * data-driven `/event/[id]` screen can render the spots bar, and the RSVP
 * write endpoints landed. `spots_filled` is a batched count of live
 * `event_rsvp_dogs` per event. The RSVP write enforces `events.capacity` as
 * a SOFT cap for owner self-serve (schema.sql: staff/portal may exceed it;
 * NOT a DB CHECK) under a per-event row lock so concurrent RSVPs serialize.
 *
 * `GET /dogs/:id/event-attendance` (also §C) stays deferred — no consumer.
 *
 * Events are visible to both owners and staff; RSVPs are owner-only (staff
 * get an empty list on reads and 403 on writes — they organize, not RSVP).
 */

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

// Body cap on dogs per RSVP — mirrors POST /enrollments + /bookings. Bounds a
// hostile body BEFORE the DB; 5 covers every plausible household.
const MAX_RSVP_DOGS = 5;
const rsvpBodySchema = z.object({
  dog_ids: z.array(z.string().uuid()).min(1).max(MAX_RSVP_DOGS),
});

export function registerEventsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /events --------------------------------------------------------
  app.get('/events', { preHandler: [authHook] }, async (): Promise<EventWire[]> => {
    const rows = await eventsRepository.findLive();
    const spots = await eventsRepository.countLiveRsvpDogsByEventIds(rows.map((r) => r.id));
    return rows.map((row) => toEventWire(row, spots.get(row.id) ?? 0));
  });

  // --- GET /events/rsvps --------------------------------------------------
  // NOTE: ordering matters — this MUST register before `/events/:id` so
  // Fastify's path-matcher doesn't catch `rsvps` as an :id param. Day-5b
  // hit the same gotcha with `/credit-packages` vs `/credits/:dogId`; same
  // fix.
  app.get(
    '/events/rsvps',
    { preHandler: [authHook] },
    async (request): Promise<EventRsvpWire[]> => {
      const principal = requirePrincipal(request);
      if (principal.kind !== 'owner') return [];
      const rsvpRows = await eventsRepository.findLiveRsvpsByOwner(principal.ownerId);
      if (rsvpRows.length === 0) return [];
      const dogRows = await eventsRepository.findDogsByRsvpIds(rsvpRows.map((r) => r.id));
      const dogsByRsvp = groupDogIds(dogRows);
      return rsvpRows.map((row) => toEventRsvpWire(row, dogsByRsvp.get(row.id) ?? []));
    },
  );

  // --- GET /events/:id ----------------------------------------------------
  app.get('/events/:id', { preHandler: [authHook] }, async (request): Promise<EventWire> => {
    const { id } = parseUuidParam(request.params);
    const row = await eventsRepository.findLiveById(id);
    if (row === undefined) {
      throw new ApiError('not_found', `event ${id} not found`);
    }
    const spots = await eventsRepository.countLiveRsvpDogsByEventIds([id]);
    return toEventWire(row, spots.get(id) ?? 0);
  });

  // --- POST /events/:id/rsvp ----------------------------------------------
  // Create/replace the owner's RSVP for an event to exactly `dog_ids`.
  // Idempotent, owner-only, soft-cap enforced under a per-event row lock.
  app.post('/events/:id/rsvp', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'RSVP to an event');
    const { id: eventId } = parseUuidParam(request.params);
    const body = parseOrThrow(rsvpBodySchema, request.body, 'body');
    const dogIds = validateDistinctDogs(body.dog_ids);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    // cache-noop: events / event_rsvps aren't read-through cached (no §3 cache map entry).
    const outcome = await withMutation<EventRsvpWire>(
      {
        principal,
        idempotencyKey,
        endpoint: 'POST /events/:id/rsvp',
        requestHash: hashRequestBody({ eventId, dog_ids: dogIds }),
      },
      async (tx) => {
        // 1. Ownership gate — every requested dog must belong to the principal.
        //    Same response for "not owned" vs "doesn't exist" so dog ids can't
        //    enumerate across owners.
        for (const dogId of dogIds) {
          const owned = await dogsRepository.findOwnedExists(dogId, principal.ownerId, tx);
          if (!owned) {
            throw new ApiError('not_found', `dog ${dogId} not found`);
          }
        }
        // 2. Lock the event row — concurrent RSVPs serialize here. Liveness is
        //    checked under the lock (a soft-expired/cancelled event = "no such
        //    event" for RSVP).
        const eventRow = await lockEvent(tx, eventId);
        if (eventRow === undefined || eventRow.expiredAt !== null) {
          throw new ApiError('not_found', `event ${eventId} not found`);
        }
        // 3. Soft capacity ceiling (owner self-serve). `dog_ids` REPLACES the
        //    owner's current set, so subtract their existing dogs from the live
        //    total before admitting the new ones. NULL capacity = uncapped.
        if (eventRow.capacity !== null) {
          const liveDogs = await eventsRepository.countLiveRsvpDogsForEventTx(tx, eventId);
          const existing = await eventsRepository.findLiveRsvpForOwnerEventTx(
            tx,
            principal.ownerId,
            eventId,
          );
          const ownerCurrent =
            existing === undefined
              ? 0
              : (await eventsRepository.findLiveRsvpDogIdsTx(tx, existing.id)).length;
          if (liveDogs - ownerCurrent + dogIds.length > eventRow.capacity) {
            throw new ApiError('event_full', `event ${eventId} is at capacity`);
          }
        }
        // 4. Upsert + return the saved RSVP.
        const rsvp = await eventsRepository.upsertRsvpTx(tx, {
          ownerId: principal.ownerId,
          eventId,
          dogIds,
        });
        const savedDogIds = await eventsRepository.findLiveRsvpDogIdsTx(tx, rsvp.id);
        return { status: 200, body: toEventRsvpWire(rsvp, savedDogIds) };
      },
    );
    reply.code(outcome.status);
    return outcome.body;
  });

  // --- DELETE /events/:id/rsvp --------------------------------------------
  // Un-RSVP the owner from an event (soft-expire their live RSVP + dogs).
  // Idempotent: a no-op when they have no live RSVP.
  app.delete('/events/:id/rsvp', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'cancel an event RSVP');
    const { id: eventId } = parseUuidParam(request.params);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    // cache-noop: events / event_rsvps aren't read-through cached (no §3 cache map entry).
    const outcome = await withMutation<{ ok: true }>(
      {
        principal,
        idempotencyKey,
        endpoint: 'DELETE /events/:id/rsvp',
        requestHash: hashRequestBody({ eventId }),
      },
      async (tx) => {
        const eventRow = await eventsRepository.findLiveById(eventId);
        if (eventRow === undefined) {
          throw new ApiError('not_found', `event ${eventId} not found`);
        }
        await eventsRepository.expireOwnerRsvpTx(tx, { ownerId: principal.ownerId, eventId });
        return { status: 200, body: { ok: true as const } };
      },
    );
    reply.code(outcome.status);
    return outcome.body;
  });
}

// ---- param parsing -------------------------------------------------------

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** The same dog twice in one RSVP body is a client defect — reject distinctly. */
function validateDistinctDogs(dogIds: string[]): string[] {
  if (new Set(dogIds).size !== dogIds.length) {
    throw new ApiError('bad_request', 'dog_ids must be distinct');
  }
  return dogIds;
}

// ---- batched denorm ------------------------------------------------------

function groupDogIds(rows: { rsvpId: string; dogId: string }[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const existing = result.get(row.rsvpId) ?? [];
    existing.push(row.dogId);
    result.set(row.rsvpId, existing);
  }
  return result;
}
