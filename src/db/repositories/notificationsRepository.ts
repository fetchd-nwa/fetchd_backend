import { and, asc, count, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { db } from '../client.js';
import { notificationDogs, notifications } from '../schema/schema.js';
import type { NotificationRowForWire } from '../../lib/notificationWire.js';

/**
 * Data-access seam for `notifications` (+ `notification_dogs` denorm).
 * Day-7b addition; mirrors the Day-5/6/7a repo pattern. Routes import
 * these methods, never query Drizzle directly.
 *
 * `notifications` has no `expired_at` (append-only feed per schema line
 * 984-985); reads return every row. The unread-count + cursor pagination
 * shape derives `is_read` from `read_at IS NULL` per DATA-CONTRACT §B
 * Notification.
 */

export type NotificationRow = NotificationRowForWire;

const NOTIFICATION_PROJECTION = {
  id: notifications.id,
  type: notifications.type,
  title: notifications.title,
  body: notifications.body,
  receivedAt: notifications.receivedAt,
  readAt: notifications.readAt,
  deepLinkPath: notifications.deepLinkPath,
  senderStaffId: notifications.senderStaffId,
} as const;

export interface NotificationCursor {
  receivedAt: string;
  id: string;
}

export const notificationsRepository = {
  /**
   * Owner's notification feed, paginated by keyset. Ordered DESC by
   * `received_at` (matches the FE's `notificationRepository.list()` sort)
   * with `id` DESC as a stable tie-breaker for same-millisecond rows.
   *
   * Keyset cursor: `(received_at, id) < (cursor.received_at, cursor.id)`.
   * Postgres tuple comparison would express this in one operator, but
   * Drizzle's expression API doesn't expose it cleanly across dialects —
   * the equivalent OR-form below compiles to the same query plan against
   * the `notifications_owner_idx (owner_id, received_at DESC)` index.
   *
   * The route caps `limit` at 200 and asks for `limit + 1` here so it can
   * detect "more pages exist" without a separate COUNT query — the extra
   * row, if present, becomes the next cursor anchor.
   */
  async findLiveByOwnerCursor(
    ownerId: string,
    cursor: NotificationCursor | null,
    limit: number,
  ): Promise<NotificationRow[]> {
    const cursorCondition =
      cursor === null
        ? undefined
        : or(
            lt(notifications.receivedAt, cursor.receivedAt),
            and(eq(notifications.receivedAt, cursor.receivedAt), lt(notifications.id, cursor.id)),
          );
    return db
      .select(NOTIFICATION_PROJECTION)
      .from(notifications)
      .where(and(eq(notifications.ownerId, ownerId), cursorCondition))
      .orderBy(desc(notifications.receivedAt), desc(notifications.id))
      .limit(limit);
  },

  /**
   * Bare unread count for the bell badge. `read_at IS NULL` is the
   * unread sentinel per the schema comment. Owner-scoped.
   */
  async findUnreadCountByOwner(ownerId: string): Promise<number> {
    const rows = await db
      .select({ unreadCount: count(notifications.id) })
      .from(notifications)
      .where(and(eq(notifications.ownerId, ownerId), isNull(notifications.readAt)));
    const first = rows[0];
    if (first === undefined) return 0;
    return typeof first.unreadCount === 'string' ? Number(first.unreadCount) : first.unreadCount;
  },

  /**
   * Resolve `notification_dogs` membership for a batch of notification
   * ids. ORDER BY dog_id ASC so the snapshot diff is stable across
   * reseeds. `notification_dogs` has no `expired_at` (M:N denorm with PK
   * `(notification_id, dog_id)`), so no `live()` filter.
   */
  async findDogsByNotificationIds(
    notificationIds: string[],
  ): Promise<{ notificationId: string; dogId: string }[]> {
    if (notificationIds.length === 0) return [];
    return db
      .select({
        notificationId: notificationDogs.notificationId,
        dogId: notificationDogs.dogId,
      })
      .from(notificationDogs)
      .where(inArray(notificationDogs.notificationId, notificationIds))
      .orderBy(asc(notificationDogs.dogId));
  },
};
