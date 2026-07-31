import type { NotificationType } from '../contracts/wire.js';

/**
 * D3 push-preference enforcement for the scheduler. The in-app feed entry is
 * ALWAYS written by the delivery tx — the DB is the source of truth; this module
 * decides only whether the PUSH channel fires for a given delivery, honoring the
 * owner's account toggles.
 *
 * Two gates, both opt-OUT (the default is "send"):
 *   1. `push_notifications_enabled = false` — the master switch mutes every push.
 *   2. `push_notification_categories[category] = false` — the owner muted the one
 *      category this notification belongs to. The jsonb column defaults to '{}',
 *      so a MISSING key means "send"; only an explicit boolean `false` opts out.
 */

/**
 * The account screen exposes six per-category push toggles — the mobile
 * `NotificationCategoryKey` union (mobile/src/types/user.ts), rendered by
 * `NotificationCategoryPanel`: booking-confirmations, booking-reminders,
 * report-cards, session-photos, urgent-updates, announcements. Only two of them
 * gate a scheduled type the worker actually pushes today, so `PUSH_TYPE_CATEGORY`
 * below is total over exactly the ten push-capable scheduled types and no others.
 */
type PushCategoryKey = 'booking-reminders' | 'urgent-updates';

/**
 * The only notification types the scheduler delivers over the push channel
 * today. Every other arm of `NotificationType` is feed-only (or never enqueued
 * to `scheduled_notifications`), so no per-category toggle governs it.
 */
type PushCapableType =
  | 'booking-reminder'
  | 'boarding-profile-check'
  | 'alumni-attendance'
  | 'payment-failed'
  | 'payment-due'
  | 'credits-expiring'
  | 'spay-neuter-reminder'
  | 'invoice-overdue'
  | 'card-expiring'
  | 'waitlist-spot-open';

const PUSH_TYPE_CATEGORY: Record<PushCapableType, PushCategoryKey> = {
  'booking-reminder': 'booking-reminders',
  'boarding-profile-check': 'booking-reminders',
  'alumni-attendance': 'booking-reminders',
  'payment-failed': 'urgent-updates',
  // R3: the cash/check "bring payment at drop-off" reminder is action-required.
  'payment-due': 'urgent-updates',
  'credits-expiring': 'urgent-updates',
  'spay-neuter-reminder': 'urgent-updates',
  // Allison 2026-07-29: both mean money is about to stop moving and only the
  // owner can fix it — the definition of urgent-updates.
  'invoice-overdue': 'urgent-updates',
  'card-expiring': 'urgent-updates',
  // Allison 2026-07-30: an offered seat is on a clock — miss the deadline and
  // it goes to the next family. 'urgent-updates' rather than
  // 'booking-reminders': there is no booking yet, and the owner must ACT, which
  // is the line between the two categories.
  'waitlist-spot-open': 'urgent-updates',
};

const PUSH_CAPABLE_TYPES: ReadonlySet<string> = new Set(Object.keys(PUSH_TYPE_CATEGORY));

function isPushCapable(type: NotificationType): type is PushCapableType {
  return PUSH_CAPABLE_TYPES.has(type);
}

/**
 * The two owner columns the skip decision reads. `pushNotificationCategories` is
 * a jsonb column, so it arrives as `unknown` and is narrowed at the point of use.
 */
export interface OwnerPushPrefs {
  pushNotificationsEnabled: boolean;
  pushNotificationCategories: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True only when the owner has explicitly muted `category` (value `=== false`).
 * A missing key, a non-boolean, or `true` all fall through to "send" — the jsonb
 * is untyped at the DB seam, so we narrow rather than trust its shape.
 */
function categoryMuted(categories: unknown, category: PushCategoryKey): boolean {
  return isRecord(categories) && categories[category] === false;
}

/**
 * Should the scheduler SKIP the push for this delivery? Pure — no DB, no clock.
 * The feed INSERT has already happened by the time this is consulted.
 */
export function shouldSkipPush(type: NotificationType, prefs: OwnerPushPrefs): boolean {
  if (prefs.pushNotificationsEnabled === false) return true;
  if (!isPushCapable(type)) return false;
  return categoryMuted(prefs.pushNotificationCategories, PUSH_TYPE_CATEGORY[type]);
}
