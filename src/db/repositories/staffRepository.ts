import { and, inArray } from 'drizzle-orm';
import { db } from '../client.js';
import { staff } from '../schema/schema.js';
import { live } from '../softExpire.js';

/**
 * Data-access seam for the `staff` table. Day-5a uses one method
 * (`findNamesByIds`) to resolve `bookings.trainer_staff_id` → display
 * name for the §B wire shape. The repo exists as its own file rather
 * than being absorbed into `bookingsRepository` because `staff` is a
 * separate entity, not a tightly-coupled child of `bookings` (cohorts,
 * reports, and `pending_requests.approved_by_staff_id` will all need
 * staff-name resolution too — rule of two will fire soon).
 */
export const staffRepository = {
  /**
   * Names for a batch of staff ids. Returns only LIVE staff (a soft-
   * expired trainer's bookings keep the staff_id reference in the audit
   * trail, but the displayed name disappears from the live wire — the
   * route maps NULL/missing to "no trainer" per the §B optional-omit
   * convention).
   */
  async findNamesByIds(ids: string[]): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0) return [];
    return db
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(and(inArray(staff.id, ids), live(staff)));
  },

  /**
   * Build a null-aware trainer-name lookup for a batch of rows. Dedupes
   * the unique `trainerStaffId` values, fetches all in one query via
   * `findNamesByIds`, returns a closure callers use per-row.
   *
   * Rule-of-two extraction (Day 6b): `wireBookings` and `wireReports`
   * both did this dance inline. Day-7 events (organizer staff) and
   * Day-12 report mutations (author staff) will reuse. Returns `null`
   * for unknown ids (soft-expired staff, structurally missing rows) —
   * matches the optional-omit `trainer?` convention.
   */
  async resolveTrainerNames<T extends { trainerStaffId: string | null }>(
    rows: readonly T[],
  ): Promise<(id: string | null) => string | null> {
    const ids = [
      ...new Set(rows.map((r) => r.trainerStaffId).filter((v): v is string => v !== null)),
    ];
    if (ids.length === 0) return () => null;
    const staffRows = await staffRepository.findNamesByIds(ids);
    const namesById = new Map(staffRows.map((s) => [s.id, s.name] as const));
    return (id) => (id === null ? null : (namesById.get(id) ?? null));
  },
};
