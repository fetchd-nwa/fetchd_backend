import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { requiredVaccines } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `required_vaccines`. The gating-vaccine catalog is
 * a small shared read (a handful of rows) plus a key-existence gate used
 * by Day-9d's `POST/PATCH /dogs/:id/vaccines` to validate
 * `requirement_key` against a live catalog entry.
 *
 * Extracted Day-9d at the rule-of-two trigger: Day-4b's `routes/required
 * Vaccines.ts` was reading Drizzle directly (an existing violation of
 * "routes query repos, never Drizzle directly" — flagged retroactively
 * here so Day-9d's second consumer doesn't multiply the violation).
 * Boy-Scout cleanup while in the neighborhood.
 */

type RequiredVaccine = typeof requiredVaccines.$inferSelect;
type Runner = Tx | typeof db;

/**
 * Full live catalog, ordered by `key` for snapshot stability. Pagination
 * is YAGNI — production seed is a handful of rows.
 */
async function findAllLive(): Promise<RequiredVaccine[]> {
  return db
    .select()
    .from(requiredVaccines)
    .where(live(requiredVaccines))
    .orderBy(asc(requiredVaccines.key));
}

/**
 * Boolean existence check for a `required_vaccines.key`, scoped to live
 * rows. Day-9d's vaccine POST/PATCH calls this on the body's
 * `requirement_key` before write — a non-live key (typo, retired, or
 * unknown) routes to 422 `invalid_payload` at the route layer.
 *
 * `runner` polymorphism mirrors the established pattern: standalone read
 * uses the default pool; mutation-internal pre-check passes the tx so
 * the catalog read is on the same transaction as the dependent write.
 */
async function keyIsLive(key: string, runner: Runner = db): Promise<boolean> {
  const [row] = await runner
    .select({ key: requiredVaccines.key })
    .from(requiredVaccines)
    .where(and(eq(requiredVaccines.key, key), live(requiredVaccines)))
    .limit(1);
  return row !== undefined;
}

export const requiredVaccinesRepository = {
  findAllLive,
  keyIsLive,
};
