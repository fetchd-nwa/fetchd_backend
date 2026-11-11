import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import type { GetCreditsQuery, OwnerCreditsWire } from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { creditsRepository } from '../db/repositories/creditsRepository.js';
import { LOCATION_SLUGS } from '../db/schema/schema.js';
import { requireOwner } from '../lib/principalNarrows.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `GET /credits?location=<key>` `[auth, owner]` — the caller's credit pools at one campus
 * (CRED-U10, CRED-U33; design §1.1:957-961). Credits are the owner's, one pool per campus,
 * program and tier, so the route names no dog. A staff principal is 403 `forbidden`: with
 * no id in the request there is nothing a 404 would protect.
 */

const creditsQuerySchema = z.object({ location: z.enum(LOCATION_SLUGS) });

/** Zod ↔ wire pin for the query string (design §5.1.3, `z.input`). */
export type GetCreditsQueryConformance = Expect<
  Equal<z.input<typeof creditsQuerySchema>, GetCreditsQuery>
>;

export interface CreditsRouteOptions extends AuthRouteOptions {
  /** A test's clock for `expiring_lots`. A factory, so a captured clock can't freeze production. */
  now?: () => Date;
}

export function registerCreditsRoute(app: FastifyInstance, opts: CreditsRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);
  const nowFactory = opts.now ?? ((): Date => new Date());

  app.get('/credits', { preHandler: [authHook] }, async (request): Promise<OwnerCreditsWire> => {
    const principal = requirePrincipal(request);
    requireOwner(principal, 'read credits');
    const { location } = parseOrThrow(creditsQuerySchema, request.query, 'query');
    return {
      location,
      pools: await creditsRepository.findPools(principal.ownerId, location, nowFactory()),
    };
  });
}
