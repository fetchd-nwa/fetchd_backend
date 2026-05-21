import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import {
  toEventRsvpWire,
  toEventWire,
  type EventRsvpWire,
  type EventWire,
} from '../lib/eventWire.js';
import { eventsRepository } from '../db/repositories/eventsRepository.js';

/**
 * `GET /events` `[auth]` · `GET /events/:id` `[auth]` ·
 * `GET /events/rsvps` `[auth]` — events catalog + owner's-rsvps surface
 * (DATA-CONTRACT §C events). Events are a shared catalog (no owner_id);
 * RSVPs are owner-scoped through `event_rsvps.owner_id`.
 *
 * Day-7a scope decision: matches the §C contract + FE wire verbatim —
 * NO `my_rsvp` denorm on Event (the earlier HANDOFF proposal would have
 * contradicted both). Owner consumes `/events` + `/events/rsvps`
 * separately and zips them client-side. `GET /dogs/:id/event-attendance`
 * is also in §C but deferred (no FE consumer yet; YAGNI until staff
 * portal or per-dog history surface wants it).
 *
 * Events themselves are visible to both owners and staff principals
 * (staff need to read the catalog too); RSVPs are owner-only, staff
 * principals get an empty list (staff don't RSVP — they organize).
 */

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

export function registerEventsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /events --------------------------------------------------------
  app.get('/events', { preHandler: [authHook] }, async (): Promise<EventWire[]> => {
    const rows = await eventsRepository.findLive();
    return rows.map((row) => toEventWire(row));
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
    return toEventWire(row);
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
