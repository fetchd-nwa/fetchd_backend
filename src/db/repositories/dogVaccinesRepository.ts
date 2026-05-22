import { and, eq, sql } from 'drizzle-orm';
import { dogVaccines } from '../schema/schema.js';
import { live } from '../softExpire.js';
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

export const dogVaccinesRepository = {
  findByIdForDog,
  create,
  update,
  softExpire,
};
