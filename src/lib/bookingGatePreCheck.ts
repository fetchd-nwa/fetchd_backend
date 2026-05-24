import { agreementSignaturesRepository } from '../db/repositories/agreementSignaturesRepository.js';
import { dogVaccinesRepository } from '../db/repositories/dogVaccinesRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import type { Tx } from '../db/tx.js';
import {
  agreementUnsignedError,
  paymentRequiredError,
  vaccineMissingError,
  type VaccineGap,
} from './bookingErrors.js';
import type { ServiceCategory } from './bookingBucket.js';

/**
 * Run the three booking gates in priority order (payment → vaccine →
 * agreement) above the DB trigger floor. Each gate produces the
 * **complete** state of THAT category — every missing vaccine across
 * every booking_dog, every unsigned required agreement — so the user
 * sees one full picture per failure and fixes it in one round-trip.
 * The FIRST failing gate aborts; the next gate (if any) surfaces on
 * retry.
 *
 * Extracted Day 12 at rule-of-three. The three sites all run the same
 * three-gate sequence with the same priority order:
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
 * The gates are owner-once (payment, agreement) or per-dog (vaccine).
 * Vaccine is per-dog because the BEFORE-INSERT trigger checks
 * `NEW.lead_dog_id`'s vaccines — a multi-dog booking emits separate
 * `booking_dogs` rows but only ONE bookings row, so the trigger only
 * inspects the lead's vaccines. The API enforces the gate across ALL
 * `booking_dogs` (the route doc says "across all booking_dogs and
 * surfaces them earlier in the UX") so the pre-check accumulates a
 * `VaccineGap` per dog × per missing requirement.
 *
 * Staff-owned dogs are exempt at the trigger floor (uniform exemption
 * ruled 2026-05-19, DATA-CONTRACT §H). The pre-check doesn't filter
 * staff dogs explicitly — owners can't own staff dogs (XOR), so the
 * `principal.ownerId` scope already excludes them.
 *
 * Returns void; throws typed `ApiError` (`payment_required`,
 * `vaccine_missing`, or `agreement_unsigned`) on the first failure.
 * Day-12b will add an `evaluation_required` gate before vaccine — when
 * it lands, the call site shape stays identical; only the priority
 * sequence inside this helper changes.
 */
export async function checkBookingGates(
  tx: Tx,
  args: {
    ownerId: string;
    dogIds: readonly string[];
    category: ServiceCategory;
  },
): Promise<void> {
  // 1. Payment — owner has a live payment_methods row. Anti-scam floor
  //    per §G; the unbypassable DB trigger has the same predicate.
  const hasPayment = await paymentMethodsRepository.hasLiveForOwner(tx, args.ownerId);
  if (!hasPayment) throw paymentRequiredError();

  // 2. Vaccine (per dog) — accumulate every missing required vaccine
  //    across every booking_dog so the user sees the complete picture in
  //    one round-trip.
  const vaccineGaps: VaccineGap[] = [];
  for (const dogId of args.dogIds) {
    const missing = await dogVaccinesRepository.findMissingForCategory(tx, dogId, args.category);
    for (const m of missing) {
      vaccineGaps.push({
        dog_id: dogId,
        requirement_key: m.requirement_key,
        label: m.label,
      });
    }
  }
  if (vaccineGaps.length > 0) throw vaccineMissingError(vaccineGaps);

  // 3. Agreement — owner has signed every required agreement at its
  //    current version for this category. Owner-once (one principal,
  //    one signature set), so no per-dog loop.
  const missingAgreements = await agreementSignaturesRepository.findMissingForOwnerCategory(
    tx,
    args.ownerId,
    args.category,
  );
  if (missingAgreements.length > 0) throw agreementUnsignedError(missingAgreements);
}
