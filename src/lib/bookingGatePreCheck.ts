import { agreementSignaturesRepository } from '../db/repositories/agreementSignaturesRepository.js';
import { dogVaccinesRepository } from '../db/repositories/dogVaccinesRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import type { Tx } from '../db/tx.js';
import {
  agreementUnsignedError,
  evaluationRequiredError,
  paymentRequiredError,
  vaccineMissingError,
  type EvaluationGap,
  type UnpassedEvaluationStatus,
  type VaccineGap,
} from './bookingErrors.js';
import type { ServiceCategory } from './bookingBucket.js';

/**
 * Categories the EVALUATION gate applies to. Pinned at Day 12b
 * (DATA-CONTRACT §A Amendment 2026-05-23, §H "Booking gates"):
 *   - `day-school`, `day-care`, `board-and-train`, `boarding` — gated.
 *   - `evaluation` — bypasses (the booking that records the eval can't
 *     require the eval to exist first).
 *   - `group-class` — uses the R7 prereq system (`class_prereq_options`)
 *     instead.
 *   - `private-lesson` — staff-curated; not eval-gated.
 *
 * Mirrors the trigger predicate in schema.sql `assert_dog_evaluation_passed`.
 * Keeping both in sync is a frozen-contract obligation — adding a new
 * gated category requires changing BOTH this set AND the trigger's
 * `category IN (...)` clause.
 */
const EVAL_GATED_CATEGORIES = new Set<ServiceCategory>([
  'day-school',
  'day-care',
  'board-and-train',
  'boarding',
]);

/**
 * Run the four booking gates in priority order
 * (payment → evaluation → vaccine → agreement) above the DB trigger
 * floor. Each gate produces the **complete** state of THAT category —
 * every missing vaccine across every booking_dog, every unsigned
 * required agreement, every dog missing a passing evaluation — so the
 * user sees one full picture per failure and fixes it in one round-
 * trip. The FIRST failing gate aborts; the next gate (if any) surfaces
 * on retry.
 *
 * Extracted Day 12 at rule-of-three. The three sites all run the same
 * gate sequence with the same priority order:
 *   1. Day-10 (`routes/bookings.ts`, POST /bookings, day-school/day-care
 *      multi-dog credit-debited bookings).
 *   2. Day-11 (`routes/enrollments.ts`, POST /enrollments, group-class
 *      cohort enrollments — per-dog vaccine accumulate because each dog
 *      becomes a lead in its own per-week bookings).
 *   3. Day-12 (`routes/staffRequests.ts`, POST /staff/requests/:id/
 *      approve — booking INSERT for private-lesson / boarding /
 *      board-and-train approval). B&T approve does NOT call this
 *      helper — no booking is created at the approve step; the gates
 *      will fire at confirm-payment (Day 14) instead.
 *
 * The gates are owner-once (payment, agreement) or per-dog (vaccine,
 * evaluation). Vaccine + evaluation are per-dog because the BEFORE-
 * INSERT triggers check `NEW.lead_dog_id` only — a multi-dog booking
 * emits separate `booking_dogs` rows but only ONE bookings row, so the
 * triggers only inspect the lead. The API enforces the full set across
 * ALL `booking_dogs` and accumulates one gap per dog so the FE renders
 * the complete picture.
 *
 * Eval-gate scope (Day 12b): only `day-school`, `day-care`,
 * `board-and-train`, `boarding` invoke the evaluation gate; `evaluation`
 * itself bypasses by construction, `group-class` uses R7 prereqs, and
 * `private-lesson` is staff-curated. The category whitelist is the
 * `EVAL_GATED_CATEGORIES` constant above; it mirrors the trigger
 * predicate in `schema.sql`.
 *
 * Staff-owned dogs are exempt at the trigger floor (uniform exemption
 * ruled 2026-05-19, DATA-CONTRACT §H). The pre-check doesn't filter
 * staff dogs explicitly — owners can't own staff dogs (XOR), so the
 * `principal.ownerId` scope already excludes them.
 *
 * Returns void; throws typed `ApiError` (`payment_required`,
 * `evaluation_required`, `vaccine_missing`, or `agreement_unsigned`) on
 * the first failure.
 */
export async function checkBookingGates(
  tx: Tx,
  args: {
    ownerId: string;
    dogIds: readonly string[];
    category: ServiceCategory;
    /** Group-class only: the cohort's class key, threaded into the vaccine
     * gate so class-key-exempt requirements are skipped (Shanthi 2026-07-14:
     * puppy classes don't require rabies). Mirrors the trigger's clause. */
    groupClassKey?: string;
  },
): Promise<void> {
  // 1. Payment — owner has a live payment_methods row. Anti-scam floor
  //    per §G; the unbypassable DB trigger has the same predicate.
  const hasPayment = await paymentMethodsRepository.hasLiveForOwner(tx, args.ownerId);
  if (!hasPayment) throw paymentRequiredError();

  // 2. Evaluation (per dog, if category gated) — dog-readiness floor
  //    before health/legal which assume the dog is approved to attend.
  //    Categories outside the whitelist skip entirely (evaluation /
  //    group-class / private-lesson).
  if (EVAL_GATED_CATEGORIES.has(args.category)) {
    const statuses = await dogsRepository.findEvaluationStatusInTx(tx, args.dogIds);
    const evaluationGaps: EvaluationGap[] = [];
    for (const row of statuses) {
      if (row.evaluationStatus !== 'passed') {
        evaluationGaps.push({
          dog_id: row.dogId,
          // Narrow: 'passed' is excluded by the conditional above.
          evaluation_status: row.evaluationStatus as UnpassedEvaluationStatus,
        });
      }
    }
    if (evaluationGaps.length > 0) throw evaluationRequiredError(evaluationGaps);
  }

  // 3. Vaccine (per dog) — accumulate every missing required vaccine
  //    across every booking_dog so the user sees the complete picture in
  //    one round-trip.
  const vaccineGaps: VaccineGap[] = [];
  for (const dogId of args.dogIds) {
    const missing = await dogVaccinesRepository.findMissingForCategory(
      tx,
      dogId,
      args.category,
      args.groupClassKey,
    );
    for (const m of missing) {
      vaccineGaps.push({
        dog_id: dogId,
        requirement_key: m.requirement_key,
        label: m.label,
      });
    }
  }
  if (vaccineGaps.length > 0) throw vaccineMissingError(vaccineGaps);

  // 4. Agreement — owner has signed every required agreement at its
  //    current version for this category. Owner-once (one principal,
  //    one signature set), so no per-dog loop.
  const missingAgreements = await agreementSignaturesRepository.findMissingForOwnerCategory(
    tx,
    args.ownerId,
    args.category,
  );
  if (missingAgreements.length > 0) throw agreementUnsignedError(missingAgreements);
}
