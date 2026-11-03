import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { StaffOwnerWire } from '../../contracts/wire.js';
import { db } from '../client.js';
import { owners } from '../schema/schema.js';
import type { Tx } from '../tx.js';
import { visibleOrNull } from '../visibleText.js';
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
   * columns are scrubbed) — the six fields of `StaffOwnerWire` and nothing else
   * (no money field, by design). `name`, `phone` and `location` may be NULL
   * from M2.01 and are emitted as `null`; a stored `name` or `phone` with no
   * visible character is none too, so it is emitted as `null` (`visibleOrNull`,
   * the SQL twin of the sign-up map's `isNonBlank`; P05 fix round 1, BF1).
   * Ordered by what a reader prints, `lower(coalesce(name, email))` over that
   * same name, then id: a reader prints the email for an unnamed family (design
   * §2.2:2244), and `lower(name)` alone would sort every unnamed family last
   * (X6) — and a blank one first.
   */
  async findLiveForStaff(runner: Runner = db): Promise<StaffOwnerWire[]> {
    return runner
      .select({
        id: owners.id,
        name: visibleOrNull(owners.name),
        email: owners.email,
        phone: visibleOrNull(owners.phone),
        location: owners.location,
        source: owners.source,
      })
      .from(owners)
      .where(isNull(owners.expiredAt))
      .orderBy(
        sql`lower(coalesce(${visibleOrNull(owners.name)}, ${owners.email}))`,
        asc(owners.id),
      );
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
