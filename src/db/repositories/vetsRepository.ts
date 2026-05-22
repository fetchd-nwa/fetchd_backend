import { and, asc, eq, ilike, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { dogs, vets } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `vets`. The catalog is shared across all owners
 * (no per-owner scoping) — `[auth]` is enough for reads; `[staff]` is
 * enforced at the route layer for PATCH/DELETE per the §A vets
 * amendment.
 *
 * Day-9a: extracted from the inline ilike in `routes/vets.ts`. Day-9b
 * extends with the first mutation surface (findById / hasLiveDogReferences /
 * create / update / softExpire). Mutation methods take a `Tx` so they
 * compose inside `withMutation`; read methods accept a `Tx | typeof db`
 * runner (default `db`) so the same lookup works both inside and outside
 * a transaction.
 */

type Vet = typeof vets.$inferSelect;
type Runner = Tx | typeof db;

export interface NewVetValues {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
}

export interface VetUpdate {
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
}

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

/**
 * Single-vet lookup. Filters soft-expired rows via `live()` so an expired
 * vet is invisible at the API boundary — admin-dashboard provenance is
 * deferred (§A amendment). `runner` lets the mutation routes look up the
 * row inside the same transaction (snapshot consistency) while the GET
 * route uses the default pool connection.
 */
async function findById(id: string, runner: Runner = db): Promise<Vet | undefined> {
  const [row] = await runner
    .select()
    .from(vets)
    .where(and(eq(vets.id, id), live(vets)))
    .limit(1);
  return row;
}

/**
 * The §A amendment's API-block guard: a vet may not be soft-expired while
 * any live dog still names it as `primary_vet_id`. Owners must reassign
 * first. Returns `true` if at least one live `dogs.primary_vet_id = $1`
 * row exists. Read inside the DELETE transaction so a concurrent reassign
 * during the same call window doesn't slip through.
 */
async function hasLiveDogReferences(vetId: string, tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ exists: sql<boolean>`true` })
    .from(dogs)
    .where(and(eq(dogs.primaryVetId, vetId), live(dogs)))
    .limit(1);
  return row !== undefined;
}

/**
 * Owner/staff create — `source='app'` per §A. `external_ref` is reserved
 * for the seed/Gingr import path and never settable from this route.
 * Optional fields arrive already-normalized (empty string → null) from
 * the route layer so the wire's omit-on-null convention round-trips
 * cleanly on the next GET.
 *
 * No dedupe constraint — fuzzy clinic names can't be UNIQUE. Dedup is a
 * create-flow concern on the FE (search-existing-first typeahead).
 */
async function create(tx: Tx, values: NewVetValues): Promise<Vet> {
  const [row] = await tx
    .insert(vets)
    .values({
      name: values.name,
      phone: values.phone,
      email: values.email,
      address: values.address,
      notes: values.notes,
      source: 'app',
    })
    .returning();
  if (!row) {
    // The INSERT ... RETURNING contract guarantees a row on success; this
    // branch exists only so the TS narrows to `Vet`, not `Vet | undefined`.
    throw new Error('vets.create: insert returned no row');
  }
  return row;
}

/**
 * Staff-only edit. `set` carries the changed columns the route built from
 * the PATCH body (already empty-string-normalized). The `updated_at` touch
 * trigger fires automatically; the `audit_capture` AFTER UPDATE trigger
 * records the prior state under `app.actor`. Returns the updated row, or
 * `undefined` if the row vanished mid-call.
 */
async function update(tx: Tx, id: string, set: VetUpdate): Promise<Vet | undefined> {
  const [row] = await tx
    .update(vets)
    .set(set)
    .where(and(eq(vets.id, id), live(vets)))
    .returning();
  return row;
}

/**
 * Staff-only soft-expire. Sets `expired_at = now()` (NEVER `DELETE` — the
 * lifecycle invariant). `live(vets)` in the WHERE ensures the second call
 * with the same id is a no-op (already expired) rather than a redundant
 * timestamp bump. Returns the just-expired row, or `undefined` if the row
 * is already gone (which the route maps to 404).
 *
 * `RELINK` is NOT applied here — soft-expire CLOSES the live row, it
 * doesn't re-link. The next create-or-re-link decision is owner UX, not
 * a DB primitive.
 */
async function softExpire(tx: Tx, id: string): Promise<Vet | undefined> {
  const [row] = await tx
    .update(vets)
    .set({ expiredAt: sql`now()` })
    .where(and(eq(vets.id, id), live(vets)))
    .returning();
  return row;
}

export const vetsRepository = {
  search,
  findById,
  hasLiveDogReferences,
  create,
  update,
  softExpire,
};
