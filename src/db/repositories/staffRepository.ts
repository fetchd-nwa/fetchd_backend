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
};
