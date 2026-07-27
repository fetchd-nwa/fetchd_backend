import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { owners } from '../schema/schema.js';
import type { Tx } from '../tx.js';
import type { OwnerPushPrefs } from '../../lib/pushPreferences.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `owners`. Today it exposes only the one read the
 * scheduler needs — the push-notification preference pair — because every other
 * owner read still goes through the `/me` route's inline query (a frozen wire
 * shape, not shared). Add verbs here as more callers need the owners table off
 * the route path.
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
};
