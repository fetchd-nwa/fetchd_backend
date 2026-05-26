import { eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { cancelWindowSettings } from '../schema/schema.js';
import type { Tx } from '../tx.js';
import type { ServiceCategory } from '../../lib/bookingBucket.js';
import { defaultFreeCancelHoursBefore } from '../../lib/cancelWindow.js';

/**
 * Data-access seam for `cancel_window_settings` (schema.sql ~line 629).
 * Owner-tunable per-category free-cancel hours; one row per category;
 * seeded at 48h flat (Day 13).
 *
 * Read pattern: `resolveHoursFor(category)` is called at booking-creation
 * time to stamp `bookings.cancel_deadline_at`. Polymorphic runner so a
 * route can read the policy inside its `withMutation` tx (the cancel
 * route doesn't need it — `bookings.cancel_deadline_at` is already
 * stamped on the row).
 *
 * No Redis read-through: 7-row table, single-row lookup, <1ms uncached.
 * Adding a cache seam would buy nothing measurable and require an
 * invalidation hop on the staff PATCH. YAGNI.
 *
 * Defaults fallback: if a category row is somehow missing (a future ALTER
 * forgot to seed, a manual DELETE in dev), we return the per-category
 * default from `lib/cancelWindow.ts`. The seed in schema.sql means this
 * fallback is unreachable in practice, but the API stays correct under
 * the unexpected case rather than returning undefined.
 */

export interface CancelWindowSettingRow {
  category: ServiceCategory;
  hoursBefore: number;
  updatedAt: string;
  updatedByStaffId: string | null;
}

const PROJECTION = {
  category: cancelWindowSettings.category,
  hoursBefore: cancelWindowSettings.hoursBefore,
  updatedAt: cancelWindowSettings.updatedAt,
  updatedByStaffId: cancelWindowSettings.updatedByStaffId,
} as const;

export const cancelWindowSettingsRepository = {
  /**
   * Resolve the free-cancel hours for one category. Reads the DB row;
   * falls back to the per-category default from `lib/cancelWindow.ts`
   * if no row exists (unreachable in practice — the schema seeds all 7
   * categories — but keeps the API correct under unexpected state).
   *
   * Polymorphic runner: defaults to the pool `db`; pass a Tx for
   * in-transaction reads (callers don't need this today — bookings
   * stamp `cancel_deadline_at` outside the tx). Future: a staff PATCH
   * that wants to write + read-back-its-own-write would use the tx.
   */
  async resolveHoursFor(category: ServiceCategory, runner: Tx | typeof db = db): Promise<number> {
    const [row] = await runner
      .select({ hoursBefore: cancelWindowSettings.hoursBefore })
      .from(cancelWindowSettings)
      .where(eq(cancelWindowSettings.category, category))
      .limit(1);
    return row?.hoursBefore ?? defaultFreeCancelHoursBefore(category);
  },

  /**
   * Every cancel-window setting, ordered by category for stable wire
   * output. Backs `GET /staff/cancel-window`. Always returns 7 rows
   * (the seed is exhaustive); on the rare race where a row is missing
   * the staff-portal UI surfaces "policy never customized" via the
   * `updatedByStaffId IS NULL` signal — not a hole in the response.
   */
  async findAll(runner: Tx | typeof db = db): Promise<CancelWindowSettingRow[]> {
    return runner
      .select(PROJECTION)
      .from(cancelWindowSettings)
      .orderBy(cancelWindowSettings.category);
  },

  /**
   * UPDATE one category's `hours_before`. Stamps `updated_at = now()`
   * and `updated_by_staff_id = $staffId`. Returns the updated row so the
   * staff PATCH can wire it back as the response (one round trip).
   * Throws if the category row doesn't exist (404 territory — shouldn't
   * happen given the seed, but the API is honest about it).
   */
  async updateHoursFor(
    tx: Tx,
    args: {
      category: ServiceCategory;
      hoursBefore: number;
      staffId: string;
    },
  ): Promise<CancelWindowSettingRow | undefined> {
    const [row] = await tx
      .update(cancelWindowSettings)
      .set({
        hoursBefore: args.hoursBefore,
        updatedAt: sql`now()`,
        updatedByStaffId: args.staffId,
      })
      .where(eq(cancelWindowSettings.category, args.category))
      .returning(PROJECTION);
    return row;
  },
};
