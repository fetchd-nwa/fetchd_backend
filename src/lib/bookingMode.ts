import { assertNever } from './assertNever.js';
import type { DayProgramCategory } from './bookingSchedule.js';
import type { BookingMode } from '../contracts/wire.js';

/**
 * Map a day-program service category to its credit-axis booking mode
 * (`schema.sql` line 107: `booking_mode AS ENUM ('school', 'daycare')`).
 *
 * Two callers (Day 10 — rule-of-two trigger): (1) the route, picking
 * the right `credit_ledger.mode` for the debit; (2) the day_capacity
 * check, picking the right openings column (`school_openings` vs
 * `daycare_openings`). One source of truth keeps them in sync — a
 * future caller can't get the mapping wrong.
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
