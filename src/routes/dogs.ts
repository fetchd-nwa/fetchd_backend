import type { FastifyInstance } from 'fastify';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { toDogWire } from '../lib/dogWire.js';

/**
 * `GET /dogs` `[auth]` — every live dog the authenticated owner owns,
 * emitted in the DATA-CONTRACT §B Dog wire shape: `vet?` resolved from
 * `dogs.primary_vet_id`, `age_months` computed in America/Chicago,
 * `vaccines` / `medications` / `feeding` / `completed_class_keys` assembled
 * from per-dog joins. Staff principals get an empty list (owner app only
 * surfaces owner-owned dogs, R3).
 *
 * Day-9a refactor: the 5-query assembly moved into `dogsRepository.
 * findManyByOwner`; the wire-shape conversion moved into `lib/dogWire.ts`.
 * The route is now a thin orchestrator: auth → repo → wire helper. Same
 * external behavior as Day-4a; the contract snapshot is unchanged.
 */

export interface DogsRouteOptions extends AuthRouteOptions {
  /**
   * Injectable clock so contract tests get a deterministic `age_months`. A
   * factory (not a `Date`) is the right shape: a captured `Date` at
   * registration time would freeze production's clock. Default factory =
   * `() => new Date()`.
   */
  now?: () => Date;
}

export function registerDogsRoute(app: FastifyInstance, opts: DogsRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const now = opts.now ?? (() => new Date());

  app.get('/dogs', { preHandler: [authHook] }, async (request) => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') return [];

    const assembled = await dogsRepository.findManyByOwner(principal.ownerId);
    const today = now();
    return assembled.map((d) => toDogWire(d, today));
  });
}
