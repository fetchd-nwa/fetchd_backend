import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { StaffOwnerWire } from '../../contracts/wire.js';
import { db } from '../client.js';
import { owners } from '../schema/schema.js';
import type { Tx } from '../tx.js';
import type { OwnerPushPrefs } from '../../lib/pushPreferences.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `owners`: the scheduler's push-notification preference
 * pair, and the staff reads of P03 (the owner picker and the owner lookup the
 * staff billing routes 404 on). The `/me` route keeps its inline query (a
 * frozen wire shape, not shared). Add verbs here as more callers need the
 * owners table off the route path.
 */
export const ownersRepository = {
  /**
   * The owner's push-preference pair, read inside the delivery tx so D3
   * enforcement sees a snapshot consistent with the feed INSERT.
   * `pushNotificationCategories` is jsonb — returned raw as `unknown` and
   * narrowed by `shouldSkipPush`. `undefined` when the owner row is gone, which
   * the `scheduled_notifications.owner_id` FK makes a should-never-happen.
   */
  async findPushPrefs(runner: Runner, ownerId: string): Promise<OwnerPushPrefs | undefined> {
    const [row] = await runner
      .select({
        pushNotificationsEnabled: owners.pushNotificationsEnabled,
        pushNotificationCategories: owners.pushNotificationCategories,
      })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .limit(1);
    return row;
  },

  /**
   * `GET /staff/owners`: every LIVE family (an expired account's contact
   * columns are scrubbed), name case-insensitively, then id — the six fields
   * of `StaffOwnerWire` and nothing else (no money field, by design).
   */
  async findLiveForStaff(runner: Runner = db): Promise<StaffOwnerWire[]> {
    return runner
      .select({
        id: owners.id,
        name: owners.name,
        email: owners.email,
        phone: owners.phone,
        location: owners.location,
        source: owners.source,
      })
      .from(owners)
      .where(isNull(owners.expiredAt))
      .orderBy(sql`lower(${owners.name})`, asc(owners.id));
  },

  /** Whether any `owners` row has this id, an expired one included: a
   *  family's invoices, charges and refunds are retained financial records. */
  async exists(ownerId: string, runner: Runner = db): Promise<boolean> {
    const [row] = await runner
      .select({ id: owners.id })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .limit(1);
    return row !== undefined;
  },
};
