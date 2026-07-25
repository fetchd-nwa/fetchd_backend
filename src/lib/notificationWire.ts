import { pgTimestampToIso } from './pgTimestamp.js';
import { notificationType } from '../db/schema/schema.js';

/**
 * Wire shapes for `Notification` per DATA-CONTRACT §B (line 289-292 — "wire
 * keys exactly as the current `toX()` translators read them") + the FE
 * `notificationRepository.ts` Raw type.
 *
 * Conventions (Day-5a/4a wire-shape rules):
 *   - Required keys (no `?` in FE Raw): always emit. `is_read` is DERIVED
 *     from `read_at IS NOT NULL` — the DB carries the timestamp, the wire
 *     carries the boolean (FE doesn't care WHEN it was read for the list,
 *     just whether).
 *   - Optional `?` keys: omit when null/empty. `deep_link_path` is declared
 *     as `string | null` in the FE Raw type but consumed via the spread-
 *     when-truthy pattern, which handles both forms; we pick OMIT for
 *     consistency with the rest of the optional-`?` keys.
 *   - `dog_ids?` and `sender_staff_id?` are both omit-when-empty/null per
 *     the same convention.
 *
 * `notifications` has NO `expired_at` column (append-only delivered feed —
 * schema comment line 984-985). Every row reads; the route does not apply
 * `live()`.
 */

export type NotificationType = (typeof notificationType.enumValues)[number];

// Backend-local pin of the deep-link vocabulary (decision 3); migrates into
// wire.ts as NOTIFICATION_DEEP_LINK_KIND in Phase 3. 'credits'/'announcement'
// are reserved arms with no producer.
export type NotificationDeepLinkKind =
  | 'booking'
  | 'report'
  | 'thread'
  | 'invoice'
  | 'membership'
  | 'dog-profile'
  | 'dog-manage'
  | 'credits'
  | 'announcement';

export interface NotificationWire {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  received_at: string;
  is_read: boolean;
  deep_link_path?: string;
  dog_ids?: string[];
  sender_staff_id?: string;
}

/**
 * Subset of `notifications` columns the wire helper consumes. Structural
 * type — matches `NOTIFICATION_PROJECTION` in `notificationsRepository.ts`.
 */
export interface NotificationRowForWire {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  receivedAt: string;
  readAt: string | null;
  deepLinkPath: string | null;
  senderStaffId: string | null;
}

/**
 * Emit the Notification wire shape. `dogIds` come pre-resolved from
 * `notification_dogs` (the route batches the lookup across the page). Pure
 * JSON shaping — no DB access.
 */
export function toNotificationWire(
  row: NotificationRowForWire,
  dogIds: string[],
): NotificationWire {
  const wire: NotificationWire = {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    received_at: pgTimestampToIso(row.receivedAt),
    is_read: row.readAt !== null,
  };
  if (row.deepLinkPath !== null && row.deepLinkPath !== '') {
    wire.deep_link_path = row.deepLinkPath;
  }
  if (dogIds.length > 0) {
    wire.dog_ids = dogIds;
  }
  if (row.senderStaffId !== null) {
    wire.sender_staff_id = row.senderStaffId;
  }
  return wire;
}
