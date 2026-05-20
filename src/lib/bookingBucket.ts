import { bucketToChicagoDate, chicagoWallTimeToUtc } from './chicagoDate.js';
import { pgTimestampToDate } from './pgTimestamp.js';
import type { serviceCategory } from '../db/schema/schema.js';

/**
 * Day-program operating windows in America/Chicago (locked 2026-05-20).
 *
 * Drop-off and pick-up are RANGES — owners arrive any time within these.
 * Same at both locations until per-location windows are modeled (deferred).
 *
 *   Drop-off:  07:30 → 09:00  (owner may show up any time in this window)
 *   Pick-up:   16:30 → 17:30  (owner may show up any time in this window)
 *
 * Bucketing uses the CLOSE of the pick-up window: a parent picking up at
 * 17:25 should still see the booking in Upcoming — anything earlier is a
 * lie. The FE's pre-Day-5 constant `DAY_PROGRAM_PICKUP_HOUR = 17` is off by
 * 30 min vs. the actual rule; Day 18 swap inherits this corrected boundary.
 */
export const DAY_PROGRAM_DROPOFF_WINDOW = {
  open: { hour: 7, minute: 30 },
  close: { hour: 9, minute: 0 },
} as const;

export const DAY_PROGRAM_PICKUP_WINDOW = {
  open: { hour: 16, minute: 30 },
  close: { hour: 17, minute: 30 },
} as const;

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
 *   • day-school / day-care → end of pick-up window in Chicago on the
 *     scheduled calendar day (`DAY_PROGRAM_PICKUP_WINDOW.close = 17:30`).
 *     `duration_minutes` is ignored — day programs have a fixed window,
 *     not a per-booking duration.
 *   • boarding / board-and-train → `pickup_at` (the scheduled stay end),
 *     or `null` if unset.
 *   • group-class / private-lesson / evaluation → `scheduled_at +
 *     duration_minutes`, with per-category fallback when `duration_minutes`
 *     is NULL (private-lesson 60 / group-class 50 / evaluation 30).
 */
export function sessionEndTime(b: BookingForBucket): Date | null {
  if (b.category === 'boarding' || b.category === 'board-and-train') {
    return b.pickupAt === null ? null : pgTimestampToDate(b.pickupAt);
  }
  if (b.category === 'day-school' || b.category === 'day-care') {
    const chicagoDay = bucketToChicagoDate(pgTimestampToDate(b.scheduledAt));
    return chicagoWallTimeToUtc(
      chicagoDay,
      DAY_PROGRAM_PICKUP_WINDOW.close.hour,
      DAY_PROGRAM_PICKUP_WINDOW.close.minute,
    );
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
export function isInView(b: BookingForBucket, view: BookingView, now: Date): boolean {
  const end = sessionEndTime(b);
  if (view === 'upcoming') {
    return end === null || end.getTime() > now.getTime();
  }
  return end !== null && end.getTime() <= now.getTime();
}
