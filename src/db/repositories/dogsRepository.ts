import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../client.js';
import {
  dogs,
  vets,
  dogVaccines,
  dogMedications,
  dogFeeding,
  dogCompletedClasses,
} from '../schema/schema.js';
import { live } from '../softExpire.js';

/**
 * Data-access seam for `dogs`. Returns the internal `AssembledDog` domain
 * shape — raw row + joined primary vet + child collections. The wire
 * helper (`lib/dogWire.ts`) handles §B conversion; the repo doesn't know
 * about wire-presentation rules and the wire helper doesn't know about
 * Drizzle.
 *
 * Day-9a: extracted from `routes/dogs.ts` inline assembly (no behavior
 * change). The 5-query plan (1 dog+vet join + 4 parallel child IN-reads)
 * preserves the existing N+1-avoidance shape.
 *
 * Day-9c adds `findById` (for GET /dogs/:id + mutation-response
 * re-fetches), `findOwnedExists` (the ownership-check primitive),
 * and `softExpire` (the cascade that drops the dog + its child rows
 * in one txn).
 */

/**
 * The dogs domain aggregate: raw dog row + joined primary vet (or null)
 * + child collections. Repos return this; the wire helper converts to
 * §B. Defined here (not in `lib/dogWire.ts`) so the data layer owns its
 * own return-type vocabulary — the wire helper is the consumer, not the
 * source of truth.
 */
export interface AssembledDog {
  dog: typeof dogs.$inferSelect;
  vet: typeof vets.$inferSelect | null;
  vaccines: (typeof dogVaccines.$inferSelect)[];
  medications: (typeof dogMedications.$inferSelect)[];
  feeding: typeof dogFeeding.$inferSelect | null;
  completedClasses: (typeof dogCompletedClasses.$inferSelect)[];
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
};
