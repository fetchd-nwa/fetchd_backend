import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import type { Tx } from '../db/tx.js';
import { gateTriggerErrorToApiError } from './bookingErrors.js';

/**
 * INSERT one booking + its `booking_dogs` rows with the route-layer
 * typed-error mapping for the three gate triggers
 * (`bookings_payment_guarantee`, `bookings_vaccine_guard`,
 * `bookings_agreement_guard` — schema.sql lines ~1184/1231/1272).
 *
 * **Why this wrapper exists.** The route-layer gate pre-check
 * (`lib/bookingGatePreCheck.ts`) produces friendly structured `details`
 * for the typical case. The BEFORE-INSERT triggers are the unbypassable
 * DB floor that catches the race window where the pre-check passes but
 * a concurrent mutation (vaccine soft-expire, payment-method removal,
 * agreement-document version bump) invalidates the state between the
 * check and the INSERT. When that happens the trigger fires a
 * `check_violation`; without this wrapper the route would surface a
 * generic 500. With it, the violation maps back to the same typed
 * `ApiError` family the pre-check would have thrown, so the wire shape
 * stays consistent across both paths.
 *
 * Extracted Day 12 at rule-of-three (Day-10 day-program bookings +
 * Day-11 cohort enrollments + Day-12 staff approve verb all need the
 * same wrapper). Two prior inline copies (`routes/bookings.ts:
 * insertBookingWithGateMapping`, `routes/enrollments.ts:
 * insertCohortBookingWithGateMapping`) collapse into this one.
 *
 * Signature mirrors `bookingsRepository.create` so a call site can swap
 * `bookingsRepository.create(tx, values)` → `insertBookingWithGate
 * Mapping(tx, values)` mechanically. Any non-gate error re-throws
 * verbatim — the wrapper catches ONLY the three gate-violation arms.
 */
export async function insertBookingWithGateMapping(
  tx: Tx,
  values: Parameters<typeof bookingsRepository.create>[1],
): Promise<Awaited<ReturnType<typeof bookingsRepository.create>>> {
  try {
    return await bookingsRepository.create(tx, values);
  } catch (err) {
    const mapped = gateTriggerErrorToApiError(err);
    if (mapped !== undefined) throw mapped;
    throw err;
  }
}
