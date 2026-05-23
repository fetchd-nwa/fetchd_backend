import type { ServiceCategory } from './bookingBucket.js';

/**
 * Per-category free-cancel windows (locked Day 10, 2026-05-22).
 *
 * The schema stores the **resolved outcome** (`bookings.cancel_deadline_at`),
 * the cancellation rule is API logic (DATA-CONTRACT §I lines 682-696). One
 * source of truth lives here so Day 10 (booking creation, sets the deadline)
 * and Day 13 (cancel route, reads it) consult the same numbers.
 *
 * Hours-before-scheduled-at by category — sized to the business cost of a
 * late cancel, not a uniform default:
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
 * **Numbers TUNABLE — confirm with Shanthi before launch.** A change here
 * affects newly-created bookings only; rows already in the DB keep the
 * `cancel_deadline_at` they were stamped with at creation (that's the right
 * behavior — promise made at booking time is honored at cancel time, even
 * if the policy moves later).
 *
 * Math is pure UTC offset (`scheduledAt − hours`) — NOT a Chicago wall-clock
 * subtraction. Two reasons: (1) "24 real hours before" is what the user
 * means in plain English; "yesterday at the same wall time" would silently
 * shrink to 23h on spring-forward and grow to 25h on fall-back, a 4% policy
 * drift twice a year. (2) The cancel deadline is rendered relative by the
 * FE ("8 hours left to cancel free"), never as a wall clock — so the small
 * absolute-wall-time shift on DST days is user-invisible.
 *
 * Day 11+ may add per-cohort overrides (e.g., a holiday class with a 7-day
 * cancel rule); the route will resolve the override over this default table
 * the same way `day_capacity` overrides resolve over the per-location
 * default rule. Not built today — YAGNI until a real case lands.
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
 * The instant past which a free cancel is no longer available. Anything
 * later than this and `cancel_forfeited` flips true on the cancel txn
 * (Day 13). Pure function; callers stamp `bookings.cancel_deadline_at`
 * with the result at creation time.
 *
 * Negative results are possible in principle (booking dropped into a
 * scheduledAt < `now + window` — e.g., a same-day day-school booking).
 * That's not invalid: it just means the deadline has already passed and
 * any cancel is forfeited. The route can choose to surface "same-day
 * booking has no free cancel" as a UX hint, but the stamping math is
 * the same.
 */
export function computeCancelDeadline(category: ServiceCategory, scheduledAt: Date): Date {
  const hours = FREE_CANCEL_HOURS_BEFORE[category];
  return new Date(scheduledAt.getTime() - hours * HOUR_MS);
}

/**
 * Exposed for tests + Day 13's "X hours left to cancel free" UX hint. Not
 * exported as a `Record` because the FE shouldn't be in the business of
 * recomputing this — it reads `cancel_deadline_at` off the booking row.
 */
export function freeCancelHoursBefore(category: ServiceCategory): number {
  return FREE_CANCEL_HOURS_BEFORE[category];
}
