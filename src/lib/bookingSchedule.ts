import { chicagoTimeOnDate } from './chicagoDate.js';
import type { ServiceCategory } from './bookingBucket.js';

/**
 * Compose a day-program booking's `scheduled_at`. Pure: no DB, no clock side
 * effects.
 *
 * The day starts when the campus opens and no arrival time is asked (DAY-U11;
 * design §2.3): `scheduled_at` is the campus's `day.dropoff_open_time` on the date,
 * so an edit to that setting moves the next booking's start, its cancel deadline and
 * its reminders (DAY-71), and never a booking already stamped. Pick-up is implicit:
 * bookings don't carry `pickup_at` for day programs, and the runtime bucket flips
 * Upcoming to Past at the campus's `day.pickup_close_time`
 * (`lib/bookingBucket.sessionEndTime`).
 *
 * Group-class start times come from the cohort row; B&T and boarding come from the
 * approval flow; private-lesson and evaluation from staff-picked slots.
 */

/**
 * The subset of `service_category` that POST /bookings creates today.
 * Other categories use different endpoints (POST /enrollments for
 * group-class, request flows for B&T / boarding, staff-picked slots
 * for private-lesson / evaluation). Narrowed here so the route's Zod
 * schema, the body parser, and this helper share one source of truth.
 */
export type DayProgramCategory = Extract<ServiceCategory, 'day-school' | 'day-care'>;

/**
 * The `bookings.scheduled_at` UTC instant for a day-program date: the campus's
 * `dropoff_open_time`, `HH:MM`, on that Chicago calendar day. Routes through
 * `chicagoTimeOnDate` so DST is handled the way the runtime bucket handles it.
 */
export function computeDayProgramScheduledAt(dateIso: string, dropoffOpenTime: string): Date {
  return chicagoTimeOnDate(dateIso, dropoffOpenTime);
}
