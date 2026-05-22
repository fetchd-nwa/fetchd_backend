import { and, eq, sql } from 'drizzle-orm';
import { dogMedications } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `dog_medications`. Day-9d's nested-resource
 * surface — `POST/PATCH/DELETE /dogs/:id/medications/:mid`. Symmetric
 * with `dogVaccinesRepository` minus the `requirement_key` FK (no gating
 * catalog for medications today — free-text fields only).
 *
 * `findByIdForDog(mid, dogId, tx)` enforces the parent-child relationship.
 * Without it, medication ids would enumerate across dogs at PATCH/DELETE.
 */

type DogMedication = typeof dogMedications.$inferSelect;

export interface NewMedicationValues {
  dogId: string;
  name: string;
  dose: string;
  frequency: string;
}

export interface MedicationUpdate {
  name?: string;
  dose?: string;
  frequency?: string;
}

async function findByIdForDog(
  mid: string,
  dogId: string,
  tx: Tx,
): Promise<DogMedication | undefined> {
  const [row] = await tx
    .select()
    .from(dogMedications)
    .where(and(eq(dogMedications.id, mid), eq(dogMedications.dogId, dogId), live(dogMedications)))
    .limit(1);
  return row;
}

async function create(tx: Tx, values: NewMedicationValues): Promise<DogMedication> {
  const [row] = await tx
    .insert(dogMedications)
    .values({
      dogId: values.dogId,
      name: values.name,
      dose: values.dose,
      frequency: values.frequency,
    })
    .returning();
  if (!row) {
    throw new Error('dogMedications.create: insert returned no row');
  }
  return row;
}

async function update(
  tx: Tx,
  mid: string,
  set: MedicationUpdate,
): Promise<DogMedication | undefined> {
  const [row] = await tx
    .update(dogMedications)
    .set(set)
    .where(and(eq(dogMedications.id, mid), live(dogMedications)))
    .returning();
  return row;
}

async function softExpire(tx: Tx, mid: string): Promise<DogMedication | undefined> {
  const [row] = await tx
    .update(dogMedications)
    .set({ expiredAt: sql`now()` })
    .where(and(eq(dogMedications.id, mid), live(dogMedications)))
    .returning();
  return row;
}

export const dogMedicationsRepository = {
  findByIdForDog,
  create,
  update,
  softExpire,
};
