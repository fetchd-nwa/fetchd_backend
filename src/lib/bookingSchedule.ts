import { chicagoWallTimeToUtc } from './chicagoDate.js';
import { DAY_PROGRAM_DROPOFF_WINDOW } from './bookingBucket.js';
import { ApiError } from './errors.js';
import type { ServiceCategory } from './bookingBucket.js';

/**
 * Compose a booking's `scheduled_at` from user-authored drop-off intent
 * (day-school / day-care) and resolve start-time defaults the API owns
 * for every credit-debited category. Pure: no DB, no clock side effects;
 * `now` if needed flows in from the caller.
 *
 * §B Δ 2026-05-20 (DATA-CONTRACT line 221): for day-school / day-care the
 * `scheduled_at` IS the user-authored drop-off time, anywhere within
 * `DAY_PROGRAM_DROPOFF_WINDOW` (07:30 → 09:00 America/Chicago). The
 * pick-up window (16:30 → 17:30) is implicit — bookings don't carry
 * `pickup_at` for day programs (parents arrive when they arrive; the
 * runtime bucket flips Upcoming → Past at the close of the pick-up
 * window via `lib/bookingBucket.sessionEndTime`).
 *
 * This module is intentionally narrow — only categories that ship in
 * Day 10 (day-school + day-care) are wired today. Group-class start
 * times come from the cohort row (Day 11); B&T / boarding come from the
 * approval flow (Day 12); private-lesson / evaluation come from
 * staff-picked slots. Extending here when those land keeps the
 * scheduling rule in one place — the type narrows the input so the
 * compiler enforces the routing.
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
 * `HH:MM` (24h, two-digit each). Validated at the route layer via Zod —
 * this regex is also imported by the body schema so the wire validator
 * and this helper agree byte-for-byte on what "valid" means.
 */
export const DROPOFF_TIME_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** The default drop-off time when the body omits one — opens of the window. */
export const DEFAULT_DROPOFF_TIME: DropoffTime = {
  hour: DAY_PROGRAM_DROPOFF_WINDOW.open.hour,
  minute: DAY_PROGRAM_DROPOFF_WINDOW.open.minute,
};

export interface DropoffTime {
  readonly hour: number;
  readonly minute: number;
}

/**
 * Parse a `HH:MM` string into a structured `DropoffTime`. Throws
 * `ApiError('bad_request')` on a malformed string — Zod catches the same
 * case at the route boundary; this is the defense-in-depth for any
 * caller that bypasses the route schema (none today, but the contract
 * is honest about what's required).
 */
export function parseDropoffTime(raw: string): DropoffTime {
  if (!DROPOFF_TIME_REGEX.test(raw)) {
    throw new ApiError('bad_request', `dropoff_time must be HH:MM, got "${raw}"`);
  }
  const [hourStr, minuteStr] = raw.split(':');
  return { hour: Number(hourStr), minute: Number(minuteStr) };
}

/**
 * Assert the drop-off time is inside `DAY_PROGRAM_DROPOFF_WINDOW`
 * (07:30 → 09:00 Chicago). Inclusive on both ends — 07:30 is the open,
 * 09:00 is the close, both accepted. The window edges live in
 * `bookingBucket.ts` as the day-program operating constants; this
 * helper is the single check site.
 *
 * The choice of inclusive-inclusive matches how parents read the
 * window ("we open at 7:30, latest drop-off is 9am") and means a
 * 09:00 drop-off rounds *to* the close rather than falling outside.
 */
export function assertDropoffWithinWindow(time: DropoffTime): void {
  const minutes = time.hour * 60 + time.minute;
  const open = DAY_PROGRAM_DROPOFF_WINDOW.open.hour * 60 + DAY_PROGRAM_DROPOFF_WINDOW.open.minute;
  const close =
    DAY_PROGRAM_DROPOFF_WINDOW.close.hour * 60 + DAY_PROGRAM_DROPOFF_WINDOW.close.minute;
  if (minutes < open || minutes > close) {
    throw new ApiError(
      'bad_request',
      `dropoff_time must be within ${pad(DAY_PROGRAM_DROPOFF_WINDOW.open.hour)}:${pad(
        DAY_PROGRAM_DROPOFF_WINDOW.open.minute,
      )}-${pad(DAY_PROGRAM_DROPOFF_WINDOW.close.hour)}:${pad(
        DAY_PROGRAM_DROPOFF_WINDOW.close.minute,
      )} America/Chicago`,
    );
  }
}

/**
 * Compose the `bookings.scheduled_at` UTC instant for a day-program
 * booking from (date, drop-off wall time). Routes through
 * `chicagoWallTimeToUtc` so DST is handled the same way it is in the
 * runtime bucket helper (`bookingBucket.sessionEndTime`) — same Intl
 * + tzdata backbone, no chance of drift between the create-side and
 * the read-side time math.
 *
 * Day-program categories only. Splitting by category is deliberate —
 * a future caller passing 'boarding' here will fail at the type level,
 * not silently produce a wrong scheduled_at. When boarding/B&T scheduling
 * lands (Day 12), extend the union; the compiler will surface the
 * exhaustive switch.
 */
export function computeDayProgramScheduledAt(
  _category: DayProgramCategory,
  dateIso: string,
  dropoff: DropoffTime,
): Date {
  return chicagoWallTimeToUtc(dateIso, dropoff.hour, dropoff.minute);
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
