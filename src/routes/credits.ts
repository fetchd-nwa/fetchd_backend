import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { creditsRepository } from '../db/repositories/creditsRepository.js';
import { locationKey } from '../db/schema/schema.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';

/**
 * `GET /dogs/:id/credits?location=<key>` `[auth]` — per-dog, per-mode,
 * per-LOCATION credit balance (DATA-CONTRACT §B Credits Δ 2026-06-04;
 * supersedes the Δ 2026-05-20 single-balance shape). Credits balances are
 * scoped to a school since the per-location pricing landed, so `location`
 * is a required query param — the owner app passes its set location.
 *
 * Owner-scoped: the dog must belong to the authenticated principal owner
 * (staff principals get 404, same response as "dog doesn't exist" so ids
 * don't enumerate). A freshly-provisioned dog with no `credit_ledger`
 * rows for this location emits the zero sentinel
 * `{ dog_id, location, school: 0, daycare: 0 }` — the repo's LEFT JOIN
 * through dogs guarantees a wire shape whenever the dog exists.
 */

const LOCATION_KEYS = pgEnumTuple(locationKey);
type LocationKey = (typeof LOCATION_KEYS)[number];

const uuidParamSchema = z.object({ id: z.string().uuid() });
const creditsQuerySchema = z.object({ location: z.enum(LOCATION_KEYS) });

export interface CreditsWire {
  dog_id: string;
  location: LocationKey;
  school: number;
  daycare: number;
}

export function registerCreditsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  app.get(
    '/dogs/:id/credits',
    { preHandler: [authHook] },
    async (request): Promise<CreditsWire> => {
      const principal = requirePrincipal(request);
      const { id: dogId } = parseUuidParam(request.params);
      const { location } = parseCreditsQuery(request.query);
      if (principal.kind !== 'owner') {
        throw new ApiError('not_found', `dog ${dogId} not found`);
      }
      const balances = await creditsRepository.findBalancesForOwnedDog(
        dogId,
        principal.ownerId,
        location,
      );
      if (balances === null) {
        throw new ApiError('not_found', `dog ${dogId} not found`);
      }
      return { dog_id: dogId, location, school: balances.school, daycare: balances.daycare };
    },
  );
}

function parseUuidParam(params: unknown): { id: string } {
  const parsed = uuidParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid path: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseCreditsQuery(query: unknown): { location: LocationKey } {
  const parsed = creditsQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
