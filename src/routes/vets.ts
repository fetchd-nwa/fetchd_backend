import type { FastifyInstance } from 'fastify';
import { and, asc, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { vets } from '../db/schema/schema.js';
import { resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { AuthError } from '../auth/errors.js';
import { live } from '../db/softExpire.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { toVetWire, type VetWire } from '../lib/vetWire.js';

/**
 * `GET /vets?q=` `[auth]` — vet typeahead. The create-dog flow searches this
 * FIRST so owners pick an existing row instead of duplicating a clinic
 * (DATA-CONTRACT R6 vets amendment: "de-dup is a create-flow concern, never a
 * DB constraint"). Without `q` the route returns the full live catalog
 * (bounded by the ~50-row seed); with `q`, case-insensitive substring on
 * `vets.name`. Wildcards (`%`/`_`) in user input are interpreted by `ilike` —
 * a deliberate trade for the typeahead use case (no realistic UX where an
 * owner types `%` and means literally that character).
 *
 * No principal scoping: vets is a SHARED catalog (any owner can pick any
 * row); the `[auth]` guard is enough. `live(vets)` excludes soft-expired
 * entries; result capped at `VET_SEARCH_LIMIT` so a runaway typeahead can't
 * drag a huge list across the wire.
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
      throw new AuthError('bad_request', `invalid query: ${formatZodIssues(parsed.error)}`);
    }
    const { q } = parsed.data;

    const where = q !== undefined ? and(live(vets), ilike(vets.name, `%${q}%`)) : live(vets);

    const rows = await db
      .select()
      .from(vets)
      .where(where)
      .orderBy(asc(vets.name), asc(vets.id))
      .limit(VET_SEARCH_LIMIT);

    return rows.map(toVetWire);
  });
}
