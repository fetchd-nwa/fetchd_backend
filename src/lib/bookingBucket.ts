import { bucketToChicagoDate, chicagoTimeOnDate } from './chicagoDate.js';
import { pgTimestampToDate } from './pgTimestamp.js';
import type { serviceCategory } from '../db/schema/schema.js';

/**
 * Fallback session length for sessional categories whose `duration_minutes`
 * is NULL. A NULL here is a data bug — the booking flow always sets one —
 * but bucketing must still produce a determinate end-time. Per-category
 * defaults match the historical FE behavior + the realistic floor for
 * each session type.
 */
const SESSIONAL_DURATION_FALLBACK_MIN: Partial<Record<ServiceCategory, number>> = {
  'private-lesson': 60,
  'group-class': 50,
  evaluation: 30,
};
const SESSIONAL_DURATION_FALLBACK_DEFAULT_MIN = 60;

export type ServiceCategory = (typeof serviceCategory.enumValues)[number];

/**
 * Just the booking columns the bucket helper needs. A structural type
 * (not a Drizzle row) so unit tests can construct one without touching DB.
 */
export interface BookingForBucket {
  category: ServiceCategory;
  scheduledAt: string;
  durationMinutes: number | null;
  pickupAt: string | null;
  /** The campus whose `day.pickup_close_time` ends a day-program row. */
  location: string | null;
}

/**
 * `day.pickup_close_time` per campus, `HH:MM`. Each list route reads it once per
 * request (`settingsRepository.dayCampuses`) and passes it down, so a list of
 * fifty bookings costs one settings read and every row sees the same value.
 */
export type PickupCloseByCampus = ReadonlyMap<string, string>;

/**
 * The close for one day-program row. A row with no campus, which only a legacy
 * import can be, has no close of its own, so it takes the latest of the campuses':
 * a day that stays Upcoming a little long is honest, and one that flips early hides
 * a dog still on site.
 */
function pickupCloseFor(location: string | null, byCampus: PickupCloseByCampus): string {
  const own = location === null ? undefined : byCampus.get(location);
  if (own !== undefined) return own;
  const latest = [...byCampus.values()].sort().at(-1);
  if (latest === undefined) {
    throw new Error('sessionEndTime: no campus has a pickup_close_time — apply M1.07');
  }
  return latest;
}

/**
 * The UTC instant a booking is "done" — the boundary that flips it from
 * Upcoming to Past. `null` means "no end resolved yet" — the only case is
 * a `boarding` / `board-and-train` row that hasn't had `pickup_at` set
 * (Day 12's request → approval txn sets it). Such a booking stays Upcoming
 * indefinitely until approval lands. That's the honest semantics — a
 * stay with no scheduled end can't be made past by clock alone.
 *
 * Rules, by category:
 *   • day-school / day-care → the campus's `day.pickup_close_time` in Chicago
 *     on the scheduled calendar day, computed at read time (DAY-60). `duration_
 *     minutes` is ignored — day programs have a fixed close, not a per-booking
 *     duration. Using the close, not the open, is what keeps a parent picking
 *     up at 17:25 looking at an Upcoming booking.
 *   • boarding / board-and-train → `pickup_at` (the scheduled stay end),
 *     or `null` if unset.
 *   • group-class / private-lesson / evaluation → `scheduled_at +
 *     duration_minutes`, with per-category fallback when `duration_minutes`
 *     is NULL (private-lesson 60 / group-class 50 / evaluation 30).
 */
export function sessionEndTime(b: BookingForBucket, pickupClose: PickupCloseByCampus): Date | null {
  if (b.category === 'boarding' || b.category === 'board-and-train') {
    return b.pickupAt === null ? null : pgTimestampToDate(b.pickupAt);
  }
  if (b.category === 'day-school' || b.category === 'day-care') {
    const chicagoDay = bucketToChicagoDate(pgTimestampToDate(b.scheduledAt));
    return chicagoTimeOnDate(chicagoDay, pickupCloseFor(b.location, pickupClose));
  }
  const start = pgTimestampToDate(b.scheduledAt);
  const minutes =
    b.durationMinutes ??
    SESSIONAL_DURATION_FALLBACK_MIN[b.category] ??
    SESSIONAL_DURATION_FALLBACK_DEFAULT_MIN;
  return new Date(start.getTime() + minutes * 60_000);
}

export type BookingView = 'upcoming' | 'past';

/**
 * `view=upcoming|past` runtime bucket filter. The caller has already
 * excluded `status='cancelled'` rows (those are not in either view).
 *
 *   upcoming = end === null  (no resolved end yet — stay pending approval)
 *              OR end > now
 *   past     = end !== null AND end <= now
 *
 * The booking-status column is allowed to lag: a row with status='upcoming'
 * but end ≤ now correctly buckets to Past. The Day-16 worker transitions
 * the column to 'past' eventually, but the read never has to wait for it.
 */
export function isInView(
  b: BookingForBucket,
  view: BookingView,
  now: Date,
  pickupClose: PickupCloseByCampus,
): boolean {
  const end = sessionEndTime(b, pickupClose);
  if (view === 'upcoming') {
    return end === null || end.getTime() > now.getTime();
  }
  return end !== null && end.getTime() <= now.getTime();
}
