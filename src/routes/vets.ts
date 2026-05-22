import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { ApiError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { toVetWire, type VetWire } from '../lib/vetWire.js';
import { vetsRepository } from '../db/repositories/vetsRepository.js';

/**
 * `GET /vets?q=` `[auth]` — vet typeahead. The create-dog flow searches
 * this FIRST so owners pick an existing row instead of duplicating a
 * clinic (DATA-CONTRACT §A vets amendment: "de-dup is a create-flow
 * concern, never a DB constraint"). Without `q` the route returns the
 * full live catalog (bounded by `VET_SEARCH_LIMIT` and the ~50-row seed);
 * with `q`, case-insensitive substring on the clinic name.
 *
 * No principal scoping: vets is a SHARED catalog (any owner can pick any
 * row); the `[auth]` guard is enough. `live(vets)` filtering happens in
 * the repo.
 *
 * Day-9a refactor: query mechanics moved into `vetsRepository.search`;
 * the route handles request validation + wire conversion. Same external
 * behavior as Day-4b; the contract snapshot is unchanged.
 */

const VET_SEARCH_LIMIT = 50;

const querySchema = z.object({
  q: z.string().trim().min(1).optional(),
});

export function registerVetsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  app.get('/vets', { preHandler: [authHook] }, async (request): Promise<VetWire[]> => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
    }
    const rows = await vetsRepository.search(parsed.data.q, VET_SEARCH_LIMIT);
    return rows.map(toVetWire);
  });
}
