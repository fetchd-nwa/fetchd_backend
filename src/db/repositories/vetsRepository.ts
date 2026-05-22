import { and, asc, ilike } from 'drizzle-orm';
import { db } from '../client.js';
import { vets } from '../schema/schema.js';
import { live } from '../softExpire.js';

/**
 * Data-access seam for `vets`. The catalog is shared across all owners
 * (no per-owner scoping) — `[auth]` is enough for reads; `[staff]` is
 * enforced at the route layer for PATCH/DELETE per the §A vets
 * amendment.
 *
 * Day-9a: extracted from the inline ilike in `routes/vets.ts` (no
 * behavior change). Day-9b extends with `findById` + `hasLiveDogReferences`
 * (the "expiring a vet referenced by live dogs is API-blocked" guard).
 */

type Vet = typeof vets.$inferSelect;

/**
 * Vet typeahead. `ilike(name, '%q%')` is case-insensitive substring on
 * the clinic name. Wildcards (`%`/`_`) in user input are interpreted by
 * `ilike` — a deliberate trade for the typeahead UX (no realistic case
 * where an owner types `%` and means literally that character).
 *
 * `q === undefined` → return the full live catalog (bounded by `limit`
 * and the ~50-row seed). `live(vets)` excludes soft-expired entries so
 * a retired clinic doesn't surface in the create-dog flow.
 */
async function search(q: string | undefined, limit: number): Promise<Vet[]> {
  const where = q !== undefined ? and(live(vets), ilike(vets.name, `%${q}%`)) : live(vets);
  return db.select().from(vets).where(where).orderBy(asc(vets.name), asc(vets.id)).limit(limit);
}

export const vetsRepository = {
  search,
};
