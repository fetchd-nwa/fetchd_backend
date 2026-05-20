import { pgTimestampToIso } from './pgTimestamp.js';
import type { GroupClassKey, GroupClassRow } from '../db/repositories/groupClassesRepository.js';
import type { CohortRow } from '../db/repositories/cohortsRepository.js';
import type { LocationKey } from './bookingWire.js';

/**
 * Wire shapes for `GroupClass`, `Cohort`, and `GroupEligibility` per
 * DATA-CONTRACT §B (Δ 2026-05-20, Day 6a):
 *
 *   - GroupClass: `price_per_dog_cents` is cents-on-wire (financial-amount
 *     convention). `age_range?` is optional-omit (omitted when null). The
 *     wire deliberately does NOT carry prereqs — those are server-derived
 *     via the eligibility endpoint and depend on the dog, not the class.
 *
 *   - Cohort: `capacity` is additive (Day-6a) — server-of-record per
 *     cohort, in case a future cohort runs at a custom cap. `end_date?` is
 *     optional-omit. Open-enrollment cohorts have a null `end_date`.
 *
 *   - GroupEligibility: `eligible: true` → `missing_prereq_options` is
 *     omitted (Day-4a convention). `eligible: false` → emits the OR-list
 *     the dog could complete to unlock the class (enum-natural-ordered).
 */

export interface GroupClassWire {
  key: GroupClassKey;
  name: string;
  weeks: number;
  price_per_dog_cents: number;
  capacity: number;
  age_range?: string;
  description: string;
  enrollment_type: string; // 'open' | 'cohort' per the CHECK constraint
}

export interface CohortWire {
  id: string;
  class_key: GroupClassKey;
  location: LocationKey;
  start_date: string;
  end_date?: string;
  weekly_time: string;
  weeks: number;
  capacity: number;
  filled: number;
}

export interface GroupEligibilityWire {
  class_key: GroupClassKey;
  eligible: boolean;
  missing_prereq_options?: GroupClassKey[];
}

export function toGroupClassWire(row: GroupClassRow): GroupClassWire {
  const wire: GroupClassWire = {
    key: row.key,
    name: row.name,
    weeks: row.weeks,
    price_per_dog_cents: row.pricePerDogCents,
    capacity: row.capacity,
    description: row.description,
    enrollment_type: row.enrollmentType,
  };
  if (row.ageRange !== null && row.ageRange !== '') wire.age_range = row.ageRange;
  return wire;
}

export function toCohortWire(row: CohortRow): CohortWire {
  const wire: CohortWire = {
    id: row.id,
    class_key: row.classKey,
    location: row.location,
    start_date: pgTimestampToIso(row.startDate),
    weekly_time: row.weeklyTime,
    weeks: row.weeks,
    capacity: row.capacity,
    filled: row.filled,
  };
  if (row.endDate !== null) wire.end_date = pgTimestampToIso(row.endDate);
  return wire;
}

/**
 * Compute the eligibility wire shape from the OR-prereq options + the
 * dog's completed-class set. Pure function — the route owns the IO; this
 * just decides eligible/not + which keys to surface as missing.
 *
 * Semantics: a class with zero prereq options is eligible-by-default. A
 * class with N options is eligible iff the dog has completed AT LEAST ONE
 * of them (OR semantics). If none match, the wire emits the full option
 * list as `missing_prereq_options` (the OR-alternatives the dog could
 * pursue).
 */
export function computeEligibility(
  classKey: GroupClassKey,
  prereqOptions: readonly GroupClassKey[],
  completedKeys: readonly GroupClassKey[],
): GroupEligibilityWire {
  if (prereqOptions.length === 0) {
    return { class_key: classKey, eligible: true };
  }
  const completed = new Set<GroupClassKey>(completedKeys);
  const hasMatch = prereqOptions.some((opt) => completed.has(opt));
  if (hasMatch) {
    return { class_key: classKey, eligible: true };
  }
  return {
    class_key: classKey,
    eligible: false,
    missing_prereq_options: [...prereqOptions],
  };
}
