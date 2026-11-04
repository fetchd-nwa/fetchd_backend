import { beyondBookingHorizonError } from './bookingErrors.js';
import { bucketChicagoToday } from './chicagoDate.js';
import { ApiError } from './errors.js';

/**
 * The booking horizon (DAY-U10, DAY-09; wire `PostBookingsRequest`). The last
 * bookable date is today in America/Chicago plus `day.booking_horizon_months`
 * calendar months, inclusive, and a day the target month lacks falls on its last
 * day: 30 Nov + 3 months is 28 Feb. It is months, not 92 days.
 *
 * One helper, used by every create that takes a date: `POST /bookings`, `POST
 * /requests`, `PATCH /requests/:id`, `POST /enrollments`, and the cap-lowering
 * check's window. **`addMonthsUtc` (`creditExpiry.ts`) is not this:** it overflows,
 * so 30 Nov + 3 months is 2 Mar, which is a different rule for a different purpose.
 */
export function lastBookableDate(now: Date, horizonMonths: number): string {
  const [year, month, day] = bucketChicagoToday(now).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  // Day 0 of the next month is the last day of the target month.
  const monthEnd = new Date(Date.UTC(year, month - 1 + horizonMonths + 1, 0));
  const clamped = new Date(
    Date.UTC(
      monthEnd.getUTCFullYear(),
      monthEnd.getUTCMonth(),
      Math.min(day, monthEnd.getUTCDate()),
    ),
  );
  return clamped.toISOString().slice(0, 10);
}

/**
 * Every date of a `POST /bookings`, on the clock: none in the past (`invalid_payload`)
 * and none past the horizon (`beyond_booking_horizon`). Runs after the idempotency
 * claim, so a replay outlives both (DECISIONS 128(a)). The dates are YYYY-MM-DD, so
 * string order is calendar order.
 */
export function assertDatesBookable(
  dates: readonly string[],
  now: Date,
  horizonMonths: number,
): void {
  const today = bucketChicagoToday(now);
  const last = lastBookableDate(now, horizonMonths);
  for (const date of dates) {
    if (date < today) {
      throw new ApiError(
        'invalid_payload',
        `date ${date} is in the past (today in America/Chicago is ${today})`,
      );
    }
    if (date > last) throw beyondBookingHorizonError(date, last);
  }
}
