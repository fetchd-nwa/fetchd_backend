import { pgTimestampToIso } from './pgTimestamp.js';
import type {
  CohortWire,
  GroupClassEnrollmentType,
  GroupClassWire,
  GroupEligibilityWire,
} from '../contracts/wire.js';
import type { GroupClassKey, GroupClassRow } from '../db/repositories/groupClassesRepository.js';
import type { CohortRow } from '../db/repositories/cohortsRepository.js';

/**
 * Mappers for the group-class read surface. The three wire SHAPES —
 * `GroupClassWire`, `CohortWire`, `GroupEligibilityWire` — moved into the
 * versioned contract at wire 1.13.0 (`src/contracts/wire.ts`, domain fence
 * `enrollments`), and the DATA-CONTRACT §B (Δ 2026-05-20, Day 6a) design notes
 * that used to live here travel with them. They are re-exported below so no
 * consumer moves this pass (designs/wire-contract-completion.md §6).
 */

export type { CohortWire, GroupClassWire, GroupEligibilityWire };

export function toGroupClassWire(row: GroupClassRow): GroupClassWire {
  const wire: GroupClassWire = {
    key: row.key,
    name: row.name,
    weeks: row.weeks,
    price_per_dog_cents: row.pricePerDogCents,
    capacity: row.capacity,
    description: row.description,
    // `GroupClassRow.enrollmentType` is `string` because its row parser is
    // `z.string()` — untouched (§14.1). The narrowing's guarantee is the table
    // CHECK `enrollment_type IN ('open','cohort')` (schema.sql:497); its runtime
    // pin is test/contracts/group-class-wire-narrowing.test.ts.
    enrollment_type: row.enrollmentType as GroupClassEnrollmentType,
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
