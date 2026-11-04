import { assertNever } from './assertNever.js';
import type { DayProgramCategory } from './bookingSchedule.js';
import type { BookingMode } from '../contracts/wire.js';

/**
 * Map a day-program service category to its credit-axis booking mode
 * (`schema.sql` line 107: `booking_mode AS ENUM ('school', 'daycare')`).
 *
 * Its reader is the booking core, picking the right `credit_ledger.mode`
 * for the debit. The seat count has no mode: day school and daycare share
 * one cap per (location, date) (DAY-U05).
 *
 * Total over `DayProgramCategory` (the narrow type from
 * `bookingSchedule.ts`). The compiler enforces exhaustiveness via
 * `assertNever`; widening the input union without updating this
 * function fails the build.
 *
 * Why not extend to all of `ServiceCategory`? Other categories don't
 * have a booking mode — group-class is paid per-purchase (no credits);
 * B&T / boarding are billed via charges (no credits); private-lesson
 * + evaluation likewise. Returning a `BookingMode | null` for those
 * would obscure that the credit-debit path is *only* legal for day
 * programs — better to narrow the input type and let the type system
 * reject the rest.
 */
// Wire 1.13.0 (§5.3): `BookingMode` is contract-owned now — re-exported from
// wire.ts (the `ChargeStatus`/`chargesRepository` precedent); `conformance.ts`
// pins it to the `booking_mode` pgEnum, so DB ↔ wire drift stays a `tsc` error.
export type { BookingMode };

export function dayProgramCategoryToMode(category: DayProgramCategory): BookingMode {
  switch (category) {
    case 'day-school':
      return 'school';
    case 'day-care':
      return 'daycare';
    default:
      return assertNever(category);
  }
}
