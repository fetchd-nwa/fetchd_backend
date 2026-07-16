import { and, eq, sql } from 'drizzle-orm';
import { dogVaccines, requiredVaccines } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { ServiceCategory } from '../../lib/bookingBucket.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `dog_vaccines`. Day-9d's nested-resource surface
 * — `POST/PATCH/DELETE /dogs/:id/vaccines/:vid`. Every method takes a
 * `Tx` because every consumer composes inside a `withMutation` body
 * (parent-dog ownership gate, optional `requirement_key` FK pre-check,
 * then the write).
 *
 * `findByIdForDog(vid, dogId, tx)` enforces the parent-child relationship
 * — a vaccine that exists but belongs to a different dog returns
 * `undefined`, mapped to 404 at the route. Without this gate, vaccine ids
 * would enumerate across dogs (PATCH/DELETE /dogs/A/vaccines/{B's vid}
 * would otherwise leak through).
 *
 * `requirement_key` (FK to `required_vaccines.key`) validation happens in
 * the route via `requiredVaccinesRepository.keyIsLive(key, tx)` before
 * calling `create`/`update` — the repo here trusts its inputs because
 * the FK guard is a route-layer concern (different error semantics for
 * "key doesn't exist" vs "vaccine doesn't exist").
 */

type DogVaccine = typeof dogVaccines.$inferSelect;

export interface NewVaccineValues {
  dogId: string;
  name: string;
  requirementKey: string | null;
  expiresAt: string;
}

export interface VaccineUpdate {
  name?: string;
  requirementKey?: string | null;
  expiresAt?: string;
}

/**
 * Parent-child guard. Returns the live vaccine row iff it belongs to
 * the named dog; `undefined` otherwise. The single query enforces both
 * the id match and the dog ownership in one indexed lookup.
 */
async function findByIdForDog(vid: string, dogId: string, tx: Tx): Promise<DogVaccine | undefined> {
  const [row] = await tx
    .select()
    .from(dogVaccines)
    .where(and(eq(dogVaccines.id, vid), eq(dogVaccines.dogId, dogId), live(dogVaccines)))
    .limit(1);
  return row;
}

async function create(tx: Tx, values: NewVaccineValues): Promise<DogVaccine> {
  const [row] = await tx
    .insert(dogVaccines)
    .values({
      dogId: values.dogId,
      name: values.name,
      requirementKey: values.requirementKey,
      expiresAt: values.expiresAt,
    })
    .returning();
  if (!row) {
    throw new Error('dogVaccines.create: insert returned no row');
  }
  return row;
}

async function update(tx: Tx, vid: string, set: VaccineUpdate): Promise<DogVaccine | undefined> {
  const [row] = await tx
    .update(dogVaccines)
    .set(set)
    .where(and(eq(dogVaccines.id, vid), live(dogVaccines)))
    .returning();
  return row;
}

/**
 * Soft-expire. Idempotent — second call on an already-expired row is a
 * no-op via the `live()` filter. Soft-expiring a vaccine row that
 * satisfied a gating `requirement_key` removes that satisfaction; the
 * next bookings INSERT will see the new state through the
 * `bookings_vaccine_guard` trigger (Day-10's responsibility).
 */
async function softExpire(tx: Tx, vid: string): Promise<DogVaccine | undefined> {
  const [row] = await tx
    .update(dogVaccines)
    .set({ expiredAt: sql`now()` })
    .where(and(eq(dogVaccines.id, vid), live(dogVaccines)))
    .returning();
  return row;
}

/**
 * Day 10 vaccine-gate pre-check — Tx-only. Returns the list of required
 * vaccination requirements that gate `category` for which the dog does
 * NOT have a live, in-date `dog_vaccines` row (i.e., the dog's missing or
 * expired requirements). Empty array ⇒ the dog has every required
 * vaccine current for this category.
 *
 * Mirrors the DB trigger `assert_vaccines_current` (schema.sql:1200-1229)
 * — same "live, not soft-expired, `expires_at >= today_ct`" semantic,
 * same `gates_categories` array filter. Date comparison uses Chicago
 * calendar today (`(now() AT TIME ZONE 'America/Chicago')::date`),
 * identical to the trigger so an edge-case vaccine that expires today
 * is treated the same way by the pre-check and the trigger floor.
 *
 * Returns labels + requirement_keys so the route can construct typed
 * `VaccineGap` entries with deep-link-ready data. One dog at a time —
 * the route batches across dogs in the booking and aggregates the
 * resulting gaps.
 *
 * Staff-owned dogs are exempt at the trigger level; the route narrows
 * to owner-owned dogs upstream (parent-dog ownership gate runs first),
 * so this repo doesn't need to re-check.
 */
async function findMissingForCategory(
  tx: Tx,
  dogId: string,
  category: ServiceCategory,
  /** Group-class only: the cohort's class key — requirements listing it in
   * `exempt_class_keys` are skipped (Shanthi 2026-07-14: puppy classes don't
   * require rabies). Mirrors the trigger's exemption clause exactly. */
  groupClassKey?: string,
): Promise<{ requirement_key: string; label: string }[]> {
  // Live required_vaccines whose gates_categories includes this category
  // AND for which no live, in-date dog_vaccines row exists on this dog.
  // Single query via correlated NOT EXISTS, same shape as the trigger.
  const exemptionClause =
    groupClassKey !== undefined
      ? sql` AND NOT (${groupClassKey}::group_class_key = ANY (rv.exempt_class_keys))`
      : sql``;
  const rows = await tx.execute(sql`
    SELECT rv.key AS requirement_key, rv.label AS label
    FROM ${requiredVaccines} rv
    WHERE rv.expired_at IS NULL
      AND ${category}::service_category = ANY (rv.gates_categories)${exemptionClause}
      AND NOT EXISTS (
        SELECT 1
        FROM ${dogVaccines} dv
        WHERE dv.dog_id = ${dogId}
          AND dv.requirement_key = rv.key
          AND dv.expired_at IS NULL
          AND dv.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date
      )
    ORDER BY rv.key ASC
  `);
  return (rows.rows as { requirement_key: string; label: string }[]).map((r) => ({
    requirement_key: r.requirement_key,
    label: r.label,
  }));
}

export const dogVaccinesRepository = {
  findByIdForDog,
  create,
  update,
  softExpire,
  findMissingForCategory,
};
