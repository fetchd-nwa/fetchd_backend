import type { DogWire, FeedingWire, MedicationWire, VaccineWire } from '../contracts/wire.js';
import type { AssembledDog } from '../db/repositories/dogsRepository.js';
import { ageInMonths } from './ageMonths.js';
import { CURRICULUM_PROGRAMS } from './alumni.js';
import { pgTimestampToIso } from './pgTimestamp.js';
import { toVetWire } from './vetWire.js';

/**
 * Dog wire shape per DATA-CONTRACT §B Dog. Required keys always emit;
 * optional `?` keys follow the Day-4a wire-shape convention (omit when
 * null/empty). Day-9 refactor: extracted from `routes/dogs.ts` so the
 * GET assembly path + the upcoming POST/PATCH/DELETE response paths
 * share one wire-conversion seam.
 *
 * Nullability decisions (carried from Day 4a, applied through 4b+):
 *   - `evaluation_date`, `completed_class_keys`, `vet` — optional; omit
 *     when null/empty.
 *   - `feeding.notes` — `string | null`, always present per the FE Raw
 *     type (the FE reads `notes` unconditionally).
 *   - `profile_image_path` — required; null DB text → ''.
 *
 * The input shape (`AssembledDog`) is the data layer's vocabulary, defined
 * by `dogsRepository`. This module is the presentation translator that
 * consumes it.
 */

// The wire shapes moved to `contracts/wire.ts` in 1.13.0 (digest
// dogs-profile/L). Re-exported here so every existing importer keeps working
// unchanged; this module keeps the mappers, which is all it ever really owned.
// `EvaluationStatus` / `GroupClassKey` are now §2 shared unions pinned to their
// pgEnums in `contracts/conformance.ts` — the module-private aliases that used
// to live here are gone, not duplicated.
export type { DogWire, FeedingWire, MedicationWire, VaccineWire } from '../contracts/wire.js';

export function toDogWire(assembled: AssembledDog, today: Date): DogWire {
  const { dog, vet, vaccines, medications, feeding, completedClasses, completedPrograms } =
    assembled;

  const wire: DogWire = {
    id: dog.id,
    name: dog.name,
    breed: dog.breed,
    age_months: ageInMonths({
      birthdate: dog.birthdate,
      ageMonthsOverride: dog.ageMonthsOverride,
      today,
    }),
    profile_image_path: dog.profileImagePath ?? '',
    vaccines: vaccines.map(toVaccineWire),
    medications: medications.map(toMedicationWire),
    feeding: toFeedingWire(feeding),
    special_notes: dog.specialNotes,
    evaluation_status: dog.evaluationStatus,
    boarding_enabled: dog.boardingEnabled,
    is_alumni: completedPrograms.length === CURRICULUM_PROGRAMS.length,
  };

  if (dog.evaluationDate !== null) wire.evaluation_date = pgTimestampToIso(dog.evaluationDate);
  if (dog.alumniAttendanceFlaggedAt !== null) {
    wire.alumni_attendance_flagged_at = pgTimestampToIso(dog.alumniAttendanceFlaggedAt);
  }
  if (dog.spayedNeutered !== null) wire.spayed_neutered = dog.spayedNeutered;
  if (dog.spayNeuterPlannedOn !== null) wire.spay_neuter_planned_on = dog.spayNeuterPlannedOn;

  const completedKeys = completedClasses.map((c) => c.classKey);
  if (completedKeys.length > 0) wire.completed_class_keys = completedKeys;

  if (vet !== null) wire.vet = toVetWire(vet);

  return wire;
}

/**
 * Single-vaccine wire conversion. Exported so Day-9d's mutation routes can
 * shape their POST/PATCH responses without re-implementing the omit-on-null
 * convention for `requirement_key`. The toDogWire path uses it on each row
 * in the per-dog vaccines array.
 */
export function toVaccineWire(row: AssembledDog['vaccines'][number]): VaccineWire {
  const wire: VaccineWire = {
    id: row.id,
    name: row.name,
    expires_at: row.expiresAt,
  };
  if (row.requirementKey !== null) wire.requirement_key = row.requirementKey;
  return wire;
}

/**
 * Single-medication wire conversion. Symmetric with `toVaccineWire` so
 * Day-9d's mutation routes have a single helper per child resource. The
 * fields are all required so no omit-on-null branch.
 */
export function toMedicationWire(row: AssembledDog['medications'][number]): MedicationWire {
  return {
    id: row.id,
    name: row.name,
    dose: row.dose,
    frequency: row.frequency,
  };
}

/**
 * No-feeding-row → empty-string defaults so the wire stays stable. A dog
 * without a `dog_feeding` row is valid (feeding is optional per the schema);
 * the FE reads `feeding.brand` unconditionally, so a null sentinel here
 * would break the FE Raw shape. Same defaults the Day-4a route used inline.
 */
export function toFeedingWire(row: AssembledDog['feeding']): FeedingWire {
  if (row === null) return { brand: '', amount: '', frequency: '', notes: null };
  return {
    brand: row.brand,
    amount: row.amount,
    frequency: row.frequency,
    notes: row.notes,
  };
}
