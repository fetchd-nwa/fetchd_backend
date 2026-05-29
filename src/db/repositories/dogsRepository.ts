import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client.js';
import {
  dogs,
  vets,
  dogVaccines,
  dogMedications,
  dogFeeding,
  dogCompletedClasses,
  type evaluationStatus,
} from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `dogs`. Returns the internal `AssembledDog` domain
 * shape — raw row + joined primary vet + child collections. The wire
 * helper (`lib/dogWire.ts`) handles §B conversion; the repo doesn't know
 * about wire-presentation rules and the wire helper doesn't know about
 * Drizzle.
 *
 * Day-9a extracted `findManyByOwner` (the GET /dogs assembly). Day-9c
 * extends with the dog mutation primitives — `findById` (single-dog
 * assembled read; serves both GET /dogs/:id and the post-mutation
 * response re-fetch inside `withMutation`), `findOwnedExists` (the
 * ownership-check primitive Day-9d's nested resources reuse), `create`,
 * `update`, `softExpire`. Read methods accept a `Tx | typeof db` runner
 * so the same lookup serves both the standalone GET (default pool) and
 * the mutation-internal re-fetch (snapshot consistency on the same Tx).
 */

type Dog = typeof dogs.$inferSelect;
type Runner = Tx | typeof db;
type EvaluationStatus = (typeof evaluationStatus.enumValues)[number];

/**
 * The dogs domain aggregate: raw dog row + joined primary vet (or null)
 * + child collections. Repos return this; the wire helper converts to
 * §B. Defined here (not in `lib/dogWire.ts`) so the data layer owns its
 * own return-type vocabulary — the wire helper is the consumer, not the
 * source of truth.
 */
export interface AssembledDog {
  dog: Dog;
  vet: typeof vets.$inferSelect | null;
  vaccines: (typeof dogVaccines.$inferSelect)[];
  medications: (typeof dogMedications.$inferSelect)[];
  feeding: typeof dogFeeding.$inferSelect | null;
  completedClasses: (typeof dogCompletedClasses.$inferSelect)[];
}

export interface NewDogValues {
  ownerId: string;
  name: string;
  breed: string;
  birthdate: string | null;
  ageMonthsOverride: number | null;
  primaryVetId: string | null;
  specialNotes: string;
  evaluationStatus: EvaluationStatus;
  evaluationDate: string | null;
}

export interface DogUpdate {
  name?: string;
  breed?: string;
  primaryVetId?: string | null;
  specialNotes?: string;
  evaluationStatus?: EvaluationStatus;
  evaluationDate?: string | null;
}

async function findManyByOwner(ownerId: string): Promise<AssembledDog[]> {
  const dogRows = await db
    .select({ dog: dogs, vet: vets })
    .from(dogs)
    .leftJoin(vets, and(eq(vets.id, dogs.primaryVetId), live(vets)))
    .where(and(eq(dogs.ownerId, ownerId), live(dogs)))
    .orderBy(dogs.createdAt, dogs.id);

  if (dogRows.length === 0) return [];

  const dogIds = dogRows.map((r) => r.dog.id);

  const [vaccineRows, medicationRows, feedingRows, completedRows] = await Promise.all([
    db
      .select()
      .from(dogVaccines)
      .where(and(inArray(dogVaccines.dogId, dogIds), live(dogVaccines)))
      .orderBy(dogVaccines.expiresAt, dogVaccines.id),
    db
      .select()
      .from(dogMedications)
      .where(and(inArray(dogMedications.dogId, dogIds), live(dogMedications)))
      .orderBy(dogMedications.id),
    db
      .select()
      .from(dogFeeding)
      .where(and(inArray(dogFeeding.dogId, dogIds), live(dogFeeding))),
    db
      .select()
      .from(dogCompletedClasses)
      .where(and(inArray(dogCompletedClasses.dogId, dogIds), live(dogCompletedClasses)))
      .orderBy(dogCompletedClasses.completedAt, dogCompletedClasses.id),
  ]);

  const vaccinesByDog = bucketBy(vaccineRows, (v) => v.dogId);
  const medicationsByDog = bucketBy(medicationRows, (m) => m.dogId);
  const feedingByDog = new Map(feedingRows.map((f) => [f.dogId, f] as const));
  const completedByDog = bucketBy(completedRows, (c) => c.dogId);

  return dogRows.map(({ dog, vet }) => ({
    dog,
    vet,
    vaccines: vaccinesByDog.get(dog.id) ?? [],
    medications: medicationsByDog.get(dog.id) ?? [],
    feeding: feedingByDog.get(dog.id) ?? null,
    completedClasses: completedByDog.get(dog.id) ?? [],
  }));
}

/**
 * Single-dog assembled read. Ownership-checked in-query (`owner_id = $1
 * AND live()` — a dog the principal doesn't own is indistinguishable from
 * a non-existent one at the API surface, so ids don't enumerate). Returns
 * the wire-ready `AssembledDog` or `undefined`.
 *
 * `runner` polymorphism: the standalone GET /dogs/:id calls this with the
 * default pool connection; POST/PATCH /dogs call it inside their
 * `withMutation` tx so the response reflects the same snapshot the write
 * just committed against (the `audit_capture` AFTER UPDATE trigger has
 * already fired by the time we re-read, and we want to see the new state,
 * not a parallel-connection view of it).
 *
 * Inside a Tx, the underlying pg client serializes commands; the 4 child
 * queries `await` sequentially so they don't trip "cannot issue concurrent
 * queries on the same client." Outside a Tx (default `db` pool runner) the
 * same sequential awaits cost a few extra round-trips on what's already a
 * single-dog read — acceptable for the few-ms overhead vs the parallel
 * branch's complexity.
 */
async function findById(
  id: string,
  ownerId: string,
  runner: Runner = db,
): Promise<AssembledDog | undefined> {
  const [dogRow] = await runner
    .select({ dog: dogs, vet: vets })
    .from(dogs)
    .leftJoin(vets, and(eq(vets.id, dogs.primaryVetId), live(vets)))
    .where(and(eq(dogs.id, id), eq(dogs.ownerId, ownerId), live(dogs)))
    .limit(1);
  if (!dogRow) return undefined;

  const vaccineRows = await runner
    .select()
    .from(dogVaccines)
    .where(and(eq(dogVaccines.dogId, id), live(dogVaccines)))
    .orderBy(dogVaccines.expiresAt, dogVaccines.id);
  const medicationRows = await runner
    .select()
    .from(dogMedications)
    .where(and(eq(dogMedications.dogId, id), live(dogMedications)))
    .orderBy(dogMedications.id);
  const [feedingRow] = await runner
    .select()
    .from(dogFeeding)
    .where(and(eq(dogFeeding.dogId, id), live(dogFeeding)))
    .limit(1);
  const completedRows = await runner
    .select()
    .from(dogCompletedClasses)
    .where(and(eq(dogCompletedClasses.dogId, id), live(dogCompletedClasses)))
    .orderBy(dogCompletedClasses.completedAt, dogCompletedClasses.id);

  return {
    dog: dogRow.dog,
    vet: dogRow.vet,
    vaccines: vaccineRows,
    medications: medicationRows,
    feeding: feedingRow ?? null,
    completedClasses: completedRows,
  };
}

/**
 * Boolean ownership guard for mutation routes. Day-9d's nested-resource
 * mutations (`POST/PATCH/DELETE /dogs/:id/vaccines` etc.) reuse this verbatim
 * as the per-parent-dog ownership gate before touching child rows.
 *
 * Reads inside the withMutation tx so a concurrent PATCH /dogs that just
 * reassigned ownership (not in the current spec, but consistent with the
 * other ownership-aware repo methods) doesn't slip through the gate.
 */
async function findOwnedExists(
  dogId: string,
  ownerId: string,
  runner: Runner = db,
): Promise<boolean> {
  const [row] = await runner
    .select({ exists: sql<boolean>`true` })
    .from(dogs)
    .where(and(eq(dogs.id, dogId), eq(dogs.ownerId, ownerId), live(dogs)))
    .limit(1);
  return row !== undefined;
}

/**
 * Owner create. The route stamps `ownerId` from the authenticated principal;
 * `staff_owner_id` stays NULL (the dogs CHECK enforces exactly-one of
 * owner/staff). The schema's `(birthdate IS NOT NULL OR age_months_override
 * IS NOT NULL)` CHECK is the floor — the route layer enforces it explicitly
 * so the error is `invalid_payload` rather than a raw Postgres
 * `check_violation`.
 *
 * `source='app'` is the table default — owner-created dogs are app-source.
 * `external_ref` stays NULL (only the seed/Gingr import path sets it).
 * `profile_image_path` stays NULL at create — set later by the Day-17 media
 * pipeline, not from this body.
 */
async function create(tx: Tx, values: NewDogValues): Promise<Dog> {
  const [row] = await tx
    .insert(dogs)
    .values({
      ownerId: values.ownerId,
      name: values.name,
      breed: values.breed,
      birthdate: values.birthdate,
      ageMonthsOverride: values.ageMonthsOverride,
      primaryVetId: values.primaryVetId,
      specialNotes: values.specialNotes,
      evaluationStatus: values.evaluationStatus,
      evaluationDate: values.evaluationDate,
    })
    .returning();
  if (!row) {
    throw new Error('dogs.create: insert returned no row');
  }
  return row;
}

/**
 * Owner edit. `set` carries the changed columns the route built from the
 * PATCH body. The `updated_at` touch trigger fires automatically; the
 * `audit_capture` AFTER UPDATE trigger records the prior state under
 * `app.actor`. Returns the updated row, or `undefined` if the row vanished
 * mid-call.
 *
 * The ownership scope is enforced upstream via `findOwnedExists`; this
 * helper only filters `live()` so a soft-expired row isn't accidentally
 * resurrected by a PATCH (the schema layer would let it through; the API
 * layer mustn't).
 */
async function update(tx: Tx, id: string, set: DogUpdate): Promise<Dog | undefined> {
  const [row] = await tx
    .update(dogs)
    .set(set)
    .where(and(eq(dogs.id, id), live(dogs)))
    .returning();
  return row;
}

/**
 * Owner soft-expire. Sets `expired_at = now()` (NEVER `DELETE` — the lifecycle
 * invariant). `live(dogs)` in the WHERE ensures a second call is a no-op
 * (already expired) rather than a redundant timestamp bump. Returns the
 * just-expired row, or `undefined` if the row is already gone (which the
 * route maps to 404).
 *
 * Soft-expiring a dog does NOT cascade to its child rows (vaccines /
 * medications / feeding / completed_classes) — those stay live in DB. They
 * become unreachable through the per-dog read because `findById` filters
 * `live(dogs)` on the parent. This matches the never-DELETE invariant
 * and preserves the dog's `booking_dogs` history.
 */
/**
 * Day-12b batched eval-status lookup for the evaluation booking gate.
 * Returns one row per LIVE dog in `dogIds`; expired or unknown ids
 * silently drop out (the route layer's ownership gate is the
 * not-found path — this helper trusts its inputs are scoped).
 *
 * Used by `lib/bookingGatePreCheck.ts` between the payment and vaccine
 * gates to accumulate `EvaluationGap` per dog whose
 * `evaluation_status !== 'passed'`. Mutation routes thread `tx` so
 * uncommitted writes earlier in the same txn are visible — same
 * polymorphic-runner rationale as `findById` (Day-9c) and the
 * `requestsRepository` batched lookups (Day-12).
 *
 * Returns the `evaluationStatus` enum value verbatim; the helper that
 * accumulates the gap narrows to `UnpassedEvaluationStatus` after
 * filtering out `'passed'`.
 */
async function findEvaluationStatusInTx(
  tx: Tx,
  dogIds: readonly string[],
): Promise<{ dogId: string; evaluationStatus: EvaluationStatus }[]> {
  if (dogIds.length === 0) return [];
  const rows = await tx
    .select({ dogId: dogs.id, evaluationStatus: dogs.evaluationStatus })
    .from(dogs)
    .where(and(inArray(dogs.id, [...dogIds]), live(dogs)));
  return rows;
}

async function softExpire(tx: Tx, id: string): Promise<Dog | undefined> {
  const [row] = await tx
    .update(dogs)
    .set({ expiredAt: sql`now()` })
    .where(and(eq(dogs.id, id), live(dogs)))
    .returning();
  return row;
}

/**
 * Resolve a live dog's `owner_id` inside a tx, cross-owner (staff
 * context). `undefined` if the dog doesn't exist / is expired. The
 * Day-19 report-authoring verb needs the owner to address the
 * `report-published` notification and to confirm the dog exists.
 */
async function findOwnerIdInTx(tx: Tx, dogId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ ownerId: dogs.ownerId })
    .from(dogs)
    .where(and(eq(dogs.id, dogId), live(dogs)))
    .limit(1);
  // owner_id is NOT NULL in the DB; the introspected drizzle type widens
  // it to `string | null`, so coerce the (impossible) null to undefined.
  return row?.ownerId ?? undefined;
}

function bucketBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = result.get(k);
    if (bucket) bucket.push(item);
    else result.set(k, [item]);
  }
  return result;
}

export const dogsRepository = {
  findManyByOwner,
  findById,
  findOwnedExists,
  findEvaluationStatusInTx,
  findOwnerIdInTx,
  create,
  update,
  softExpire,
};
