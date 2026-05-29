import { bookingsRepository, type BookingRow } from '../db/repositories/bookingsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import { groupBookingDogs, toBookingWire, type BookingWire } from './bookingWire.js';
import { pgTimestampToDate } from './pgTimestamp.js';

/**
 * Batched denormalization of N booking rows into `BookingWire` shapes.
 * Two join lookups (booking_dogs + trainer names) regardless of row
 * count. Takes already-sorted, already-bucketed rows; returns the JSON
 * the FE consumes.
 *
 * Extracted at the rule-of-three: the owner bookings reads
 * (`routes/bookings.ts`), the Day-19 staff queue (`GET /staff/bookings`),
 * and the shared cancel service (`lib/cancelBookingService.ts`) all need
 * the same batched resolve. Mirrors `wireManyRequests` — a wire helper
 * that deliberately couples to repo calls because every call site needs
 * the live join-row resolve.
 *
 * Throws if a booking has no `booking_dogs` rows — a schema-level
 * invariant violation, so a loud throw beats emitting a malformed wire.
 */
export async function wireManyBookings(rows: BookingRow[]): Promise<BookingWire[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [bookingDogRows, trainerName] = await Promise.all([
    bookingsRepository.findDogsByBookingIds(ids),
    staffRepository.resolveTrainerNames(rows),
  ]);
  const dogsByBooking = groupBookingDogs(bookingDogRows);
  return rows.map((row) => {
    const dogIds = dogsByBooking.get(row.id);
    if (dogIds === undefined) {
      throw new Error(`booking ${row.id}: no booking_dogs rows found`);
    }
    return toBookingWire(row, dogIds, trainerName(row.trainerStaffId));
  });
}

/**
 * Pure sort by scheduled_at. Owner list views use ASC (upcoming, soonest
 * first) / DESC (past, most recent first); the Day-19 staff queue uses
 * ASC. Uses `pgTimestampToDate` (not `new Date`) so PG's default
 * timestamptz format round-trips correctly.
 */
export function sortBookingsByScheduledAt(
  rows: BookingRow[],
  direction: 'asc' | 'desc',
): BookingRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      pgTimestampToDate(a.scheduledAt).getTime() - pgTimestampToDate(b.scheduledAt).getTime(),
  );
  return direction === 'desc' ? sorted.reverse() : sorted;
}
