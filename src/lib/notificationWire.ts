import { pgTimestampToIso } from './pgTimestamp.js';

/**
 * Backend adapter for the Notification wire shape. As of contract 1.1.0 the wire
 * types themselves — `NotificationType`, `NotificationWire`, and the deep-link
 * vocabulary — live in `src/contracts/wire.ts` (their single source of truth,
 * generated verbatim into both clients). This module re-exports them so existing
 * importers keep their `../lib/notificationWire.js` path, and adds the two
 * backend-only pieces the contract has no home for: the camelCase DB-row
 * projection (`NotificationRowForWire`) and the `toNotificationWire` shaper.
 *
 * Wire-shape rules (Day-5a/4a) that `toNotificationWire` implements:
 *   - Required keys always emit. `is_read` is DERIVED from `read_at IS NOT NULL`
 *     — the DB carries the timestamp, the wire carries the boolean.
 *   - Optional `?` keys (`deep_link_path`, `dog_ids`, `sender_staff_id`) are
 *     OMITTED when null/empty rather than emitted as null.
 *
 * `notifications` has NO `expired_at` column (append-only delivered feed —
 * schema comment line 984-985). Every row reads; the route does not apply
 * `live()`.
 */

export type {
  NotificationType,
  NotificationWire,
  NotificationDeepLinkKind,
} from '../contracts/wire.js';

import type { NotificationType, NotificationWire } from '../contracts/wire.js';

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
