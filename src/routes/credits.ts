import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { creditsRepository } from '../db/repositories/creditsRepository.js';

/**
 * `GET /dogs/:id/credits` `[auth]` — per-dog, per-mode credit balance
 * (DATA-CONTRACT §B Credits Δ 2026-05-20).
 *
 * Owner-scoped: the dog must belong to the authenticated principal owner
 * (staff principals get 404, same response as "dog doesn't exist" so ids
 * don't enumerate). A freshly-provisioned dog with no `credit_ledger`
 * rows emits the zero sentinel `{ dog_id, school: 0, daycare: 0 }` — the
 * repo's LEFT JOIN through dogs guarantees a wire shape whenever the dog
 * exists, regardless of ledger state.
 */

const uuidParamSchema = z.object({ id: z.string().uuid() });

export interface CreditsWire {
  dog_id: string;
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
      if (principal.kind !== 'owner') {
        throw new ApiError('not_found', `dog ${dogId} not found`);
      }
      const balances = await creditsRepository.findBalancesForOwnedDog(dogId, principal.ownerId);
      if (balances === null) {
        throw new ApiError('not_found', `dog ${dogId} not found`);
      }
      return { dog_id: dogId, school: balances.school, daycare: balances.daycare };
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
