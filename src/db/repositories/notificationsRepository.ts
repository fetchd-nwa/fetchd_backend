import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { notificationDogs, notifications } from '../schema/schema.js';
import type { Tx } from '../tx.js';
import type { NotificationDeepLinkKind, NotificationRowForWire } from '../../lib/notificationWire.js';

type NotificationType = (typeof notifications.$inferInsert)['type'] extends infer T
  ? T & string
  : never;

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
      .where(
        and(
          eq(notifications.ownerId, ownerId),
          isNull(notifications.dismissedAt),
          cursorCondition,
        ),
      )
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
      .where(
        and(
          eq(notifications.ownerId, ownerId),
          isNull(notifications.readAt),
          isNull(notifications.dismissedAt),
        ),
      );
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

  /**
   * Mark a single notification read (idempotent). `COALESCE` preserves the
   * original read instant on repeat calls; the matched-row count is the
   * existence signal — 0 ⇒ not found or not this owner's ⇒ the route 404s
   * (anti-enumeration: owner_id is in the WHERE, no separate ownership SELECT).
   */
  async markReadForOwner(tx: Tx, id: string, ownerId: string): Promise<number> {
    const rows = await tx
      .update(notifications)
      .set({ readAt: sql`COALESCE(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, id), eq(notifications.ownerId, ownerId)))
      .returning({ id: notifications.id });
    return rows.length;
  },

  /**
   * Mark every unread notification read for the owner (the "mark all read"
   * verb). Bulk, always succeeds (204) — no existence signal needed.
   */
  async markAllReadForOwner(tx: Tx, ownerId: string): Promise<void> {
    await tx
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.ownerId, ownerId), isNull(notifications.readAt)));
  },

  /**
   * Dismiss (soft-delete) a single notification. `dismissed_at` is a tombstone
   * — feed reads + the unread count filter `dismissed_at IS NULL`, so a
   * dismissed row disappears from the app but is retained for audit. Idempotent
   * via `COALESCE`; 0 matched rows ⇒ 404 (same anti-enumeration as read).
   */
  async dismissForOwner(tx: Tx, id: string, ownerId: string): Promise<number> {
    const rows = await tx
      .update(notifications)
      .set({ dismissedAt: sql`COALESCE(${notifications.dismissedAt}, now())` })
      .where(and(eq(notifications.id, id), eq(notifications.ownerId, ownerId)))
      .returning({ id: notifications.id });
    return rows.length;
  },

  /**
   * Soft-hide every LIVE notification whose structured deep link points at
   * one target — the cascade a "the thing this notification links to is
   * gone" delete owes the owner.
   *
   * `dismissed_at` is the mechanism, not a new one: it is the same tombstone
   * `dismissForOwner` stamps, and the two reads that define "live" for the
   * feed (`findLiveByOwnerCursor` :74, `findUnreadCountByOwner` :94) already
   * filter it. The row is retained for audit; only its visibility ends.
   * `notifications` has no `expired_at`, so `live()` does not apply here
   * (schema line 984-985, append-only feed).
   *
   * Owner-scoped on top of `(kind, id)`. The id alone is a UUID and already
   * unique, so the owner predicate is defense in depth — it makes a wrong
   * `deep_link_id` unable to reach across owners even in principle.
   *
   * Returns how many rows this call newly hid (already-dismissed rows are
   * excluded by the WHERE, so a repeat call reports 0 rather than
   * re-stamping a fresh instant over the owner's own dismissal).
   *
   * First caller: `DELETE /staff/reports/:id` (2.6 adversary, fix round 1) —
   * before it, deleting a report stranded the owner's `report-published`
   * bell entry and its already-delivered push on a dead deep link.
   */
  async dismissByDeepLinkTarget(
    tx: Tx,
    args: { ownerId: string; kind: NotificationDeepLinkKind; targetId: string },
  ): Promise<number> {
    const rows = await tx
      .update(notifications)
      .set({ dismissedAt: sql`now()` })
      .where(
        and(
          eq(notifications.ownerId, args.ownerId),
          eq(notifications.deepLinkKind, args.kind),
          eq(notifications.deepLinkId, args.targetId),
          isNull(notifications.dismissedAt),
        ),
      )
      .returning({ id: notifications.id });
    return rows.length;
  },

  /**
   * INSERT a notifications row (+ optional notification_dogs join
   * rows). The feed is content-immutable; the only mutations are read
   * (`markReadForOwner` / `markAllReadForOwner`) and dismiss
   * (`dismissForOwner`, a soft tombstone) — the row is never destroyed.
   *
   * Day 12 added the first write path: the staff approve verb enqueues
   * a `booking-confirmed` notification when a non-B&T request converts
   * to a booking. Day 13 (cancel) will enqueue `booking-cancelled`;
   * Day 16 (worker) will enqueue from `scheduled_notifications`. The
   * generic body shape (type / title / body / deep_link / dogIds) keeps
   * the seam open for all of them.
   *
   * `senderStaffId` is the staff actor for message-received notifications
   * (Day-16); leave undefined for booking-flow notifications. `dogIds`
   * optional — empty/undefined produces no `notification_dogs` rows
   * (the bell row falls back to its category icon).
   *
   * `deepLinkKind`/`deepLinkId` are the structured deep-link ref (decision 3);
   * the hand-written `deepLinkPath` stays until Phase 3 derives it.
   */
  async enqueue(
    tx: Tx,
    values: {
      ownerId: string;
      type: NotificationType;
      title: string;
      body: string;
      deepLinkPath?: string | null;
      deepLinkKind?: NotificationDeepLinkKind | null;
      deepLinkId?: string | null;
      senderStaffId?: string | null;
      dogIds?: readonly string[];
    },
  ): Promise<{ id: string }> {
    const [row] = await tx
      .insert(notifications)
      .values({
        ownerId: values.ownerId,
        type: values.type,
        title: values.title,
        body: values.body,
        deepLinkPath: values.deepLinkPath ?? null,
        deepLinkKind: values.deepLinkKind ?? null,
        deepLinkId: values.deepLinkId ?? null,
        senderStaffId: values.senderStaffId ?? null,
        // receivedAt / createdAt default to now(); readAt remains NULL
        // (unread sentinel).
      })
      .returning({ id: notifications.id });
    if (!row) {
      throw new Error('notificationsRepository.enqueue: notifications INSERT returned no row');
    }
    const dogIds = values.dogIds ?? [];
    if (dogIds.length > 0) {
      await tx.insert(notificationDogs).values(
        dogIds.map((dogId) => ({
          notificationId: row.id,
          dogId,
        })),
      );
    }
    return row;
  },
};
