import type { ServiceCategory } from './bookingBucket.js';

/**
 * Per-category free-cancel windows.
 *
 * Day 10 (2026-05-22) stamped these as the resolved policy in
 * `bookings.cancel_deadline_at` at creation time. Day 13 (2026-05-26)
 * moved the active policy to the `cancel_window_settings` DB table —
 * owner-tunable from the staff portal. The values in this file are
 * now the **API-side fallback**: if a category row is missing in the
 * DB (shouldn't happen — the schema seeds all 7 at 48h — but defensive
 * code is correct code), the API uses the per-category default below.
 *
 * Hours-before-scheduled-at, the original spec-author rationale (size
 * to the business cost of a late cancel):
 *
 *   day-school / day-care        24h   short session, daily credit
 *   private-lesson               24h   1:1 staff time, same scale as day programs
 *   group-class                  48h   cohort capacity reserved; late cancels
 *                                       strand a seat for the cohort run
 *   boarding                     72h   multi-night stay, staff scheduling
 *   board-and-train             168h   multi-week stay (7 days); refusing late
 *                                       cancels protects committed weeks
 *   evaluation                   24h   free service, but still needs notice
 *
 * **These are FALLBACKS only.** The active policy lives in
 * `cancel_window_settings` — read via `cancelWindowSettingsRepository.
 * resolveHoursFor(category)`. Schema seed is 48h flat across all
 * categories (Shanthi's Day-13 call).
 *
 * A booking row's `cancel_deadline_at` is computed at creation time
 * and travels with the row. Changing either the DB policy OR these
 * defaults later does NOT retroactively re-stamp existing rows —
 * promise made at booking time honors at cancel time even if policy
 * moves later.
 *
 * Math is pure UTC offset (`scheduledAt − hours`) — NOT a Chicago
 * wall-clock subtraction. Two reasons: (1) "48 real hours before" is
 * what the user means in plain English; "two days ago at the same
 * wall time" would silently shrink to 47h on spring-forward and grow
 * to 49h on fall-back. (2) The cancel deadline is rendered relative
 * by the FE ("8 hours left to cancel free"), never as a wall clock —
 * so the small absolute-wall-time shift on DST days is user-invisible.
 *
 * Day 11+ may add per-cohort overrides (e.g., a holiday class with a
 * 7-day cancel rule); the route will resolve the override over the
 * `cancel_window_settings` per-category default the same way
 * `day_capacity` overrides resolve over the per-location default.
 * Not built today — YAGNI until a real case lands.
 */

const HOUR_MS = 60 * 60 * 1000;

const FREE_CANCEL_HOURS_BEFORE: Record<ServiceCategory, number> = {
  'day-school': 24,
  'day-care': 24,
  'private-lesson': 24,
  'group-class': 48,
  boarding: 72,
  'board-and-train': 168,
  evaluation: 24,
};

/**
 * Pure arithmetic: scheduledAt − hours. The hours value is the only
 * variable input — caller resolved it from the DB (Day 13 + later) or
 * from the defaults table (tests + unreachable fallback path).
 *
 * Negative results are possible: a same-day day-school booking has
 * `scheduledAt < now + hours`, so the deadline is in the past at
 * creation time. That's not invalid — it just means the booking has
 * no free-cancel window. The route may surface this as a UX hint;
 * the math is the same.
 */
export function computeCancelDeadlineFromHours(scheduledAt: Date, hoursBefore: number): Date {
  return new Date(scheduledAt.getTime() - hoursBefore * HOUR_MS);
}

/**
 * Convenience wrapper for tests + the API-side fallback path. Computes
 * the deadline from the per-category DEFAULT (not the live DB policy).
 * Production code paths should use
 * `cancelWindowSettingsRepository.resolveHoursFor(category)` +
 * `computeCancelDeadlineFromHours(scheduledAt, hours)` so the active
 * staff-tunable policy is honored.
 */
export function computeCancelDeadline(category: ServiceCategory, scheduledAt: Date): Date {
  return computeCancelDeadlineFromHours(scheduledAt, FREE_CANCEL_HOURS_BEFORE[category]);
}

/**
 * The API-side fallback hours for a category — used by
 * `cancelWindowSettingsRepository.resolveHoursFor` when a DB row is
 * missing (unreachable in practice given the schema seed, but defensive).
 * Not the active policy; the DB row is.
 *
 * Exposed for tests + as the FE "X hours left to cancel free" hint
 * generator would consume — but the FE today reads
 * `bookings.cancel_deadline_at` directly off the row, so this isn't
 * actually a wire-emitted value.
 */
export function defaultFreeCancelHoursBefore(category: ServiceCategory): number {
  return FREE_CANCEL_HOURS_BEFORE[category];
}
