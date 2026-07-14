import { bucketToChicagoDate, chicagoWallTimeToUtc } from './chicagoDate.js';
import { pgTimestampToDate } from './pgTimestamp.js';
import type { ServiceCategory } from './bookingBucket.js';

/**
 * Server-side time-overlap conflict rules for a proposed DAY PROGRAM
 * (day-school / day-care) — the only session `POST /bookings` creates. This is
 * the authoritative backstop for the FE engine in
 * `mobile/src/lib/bookingConflicts.ts` (Δ 2026-07-09, locked): the FE prevents
 * conflicts pre-submit, this guarantees the invariant against a racing client,
 * a second device, or a direct API call. The two implementations MUST agree, so
 * the rules here mirror that file exactly:
 *
 *   • Occupied window, day-school / day-care → the FIXED block [07:00, 17:00)
 *     America/Chicago on the calendar day — the "dog is unavailable" span,
 *     deliberately wider than the API's operational drop-off/pick-up windows
 *     and independent of the exact drop-off.
 *   • private-lesson / evaluation → [scheduled_at, scheduled_at + duration]
 *     (60-min fallback).
 *   • boarding / board-and-train (residential) → the whole calendar day(s) of
 *     the stay (drop-off day through pick-up day) — the dog lives on-site, so
 *     anything else that day collides.
 *
 * Carve-outs (both directions): GROUP CLASSES never conflict (they meet
 * weekends / after 5pm, outside every window) and TWO PRIVATE LESSONS stack.
 * The proposal here is always a day program, so only the group-class carve-out
 * is reachable — a day program never pairs private↔private.
 *
 * Everything else that overlaps conflicts symmetrically: day-program ↔
 * day-program (school + care included), day-program ↔ private/eval (by time),
 * day-program ↔ residential (a boarding dog can't also attend day school).
 */

const DAY_PROGRAM_OPEN_MINUTES = 7 * 60; // 07:00 Chicago
const DAY_PROGRAM_CLOSE_MINUTES = 17 * 60; // 17:00 Chicago
const PRIVATE_LESSON_FALLBACK_MINUTES = 60;
const MS_PER_MINUTE = 60_000;

/** The existing-booking columns the conflict check reads. */
export interface ConflictCandidate {
  category: ServiceCategory;
  /** pg timestamp string (drop-off instant / session start). */
  scheduledAt: string;
  /** Sessional length; NULL for day programs (fixed window) + residential. */
  durationMinutes: number | null;
  /** Stay end for residential; NULL otherwise (or an unbounded stay). */
  pickupAt: string | null;
}

function isResidential(category: ServiceCategory): boolean {
  return category === 'boarding' || category === 'board-and-train';
}

function isDayProgram(category: ServiceCategory): boolean {
  return category === 'day-school' || category === 'day-care';
}

interface Interval {
  startMs: number;
  endMs: number;
}

// Standard half-open interval overlap — exclusive at the touching edge, so a
// session ending at 17:00 doesn't clash with one starting 17:00.
function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

// The [07:00, 17:00) Chicago block on `chicagoDate` (YYYY-MM-DD), as UTC ms.
function dayProgramInterval(chicagoDate: string): Interval {
  const atMinutes = (minutes: number): number =>
    chicagoWallTimeToUtc(chicagoDate, Math.floor(minutes / 60), minutes % 60).getTime();
  return {
    startMs: atMinutes(DAY_PROGRAM_OPEN_MINUTES),
    endMs: atMinutes(DAY_PROGRAM_CLOSE_MINUTES),
  };
}

// Whole calendar days a residential stay covers (drop-off day → pick-up day,
// inclusive). An unbounded stay (no pick-up yet — pending approval) covers only
// its known drop-off day. YYYY-MM-DD strings compare chronologically.
function residentialCoversDate(stay: ConflictCandidate, chicagoDate: string): boolean {
  const startDay = bucketToChicagoDate(pgTimestampToDate(stay.scheduledAt));
  const endDay =
    stay.pickupAt !== null ? bucketToChicagoDate(pgTimestampToDate(stay.pickupAt)) : startDay;
  return startDay <= chicagoDate && chicagoDate <= endDay;
}

/**
 * Does a proposed day program on `chicagoDate` conflict with `existing`?
 * Mirrors `findBookingConflicts` in the FE engine for the day-program proposal.
 */
export function dayProgramConflictsWith(chicagoDate: string, existing: ConflictCandidate): boolean {
  // Group classes are outside every window — never a conflict.
  if (existing.category === 'group-class') return false;

  if (isResidential(existing.category)) {
    return residentialCoversDate(existing, chicagoDate);
  }

  // Non-residential (day-program / private / evaluation): a day program only
  // occupies its own calendar day, so only a same-day existing session can
  // overlap the proposed [07:00, 17:00) block.
  const existingStart = pgTimestampToDate(existing.scheduledAt);
  if (bucketToChicagoDate(existingStart) !== chicagoDate) return false;

  const proposed = dayProgramInterval(chicagoDate);
  const existingInterval: Interval = isDayProgram(existing.category)
    ? dayProgramInterval(chicagoDate)
    : {
        startMs: existingStart.getTime(),
        endMs:
          existingStart.getTime() +
          (existing.durationMinutes ?? PRIVATE_LESSON_FALLBACK_MINUTES) * MS_PER_MINUTE,
      };

  return intervalsOverlap(proposed, existingInterval);
}
