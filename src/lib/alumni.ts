import { chicagoWallPartsAt, chicagoWallTimeToUtc } from './chicagoDate.js';

/**
 * Alumni business rules (DATA-CONTRACT §J.3, ruled 2026-07-09). PURE — no DB
 * imports; the repository layer (`dogProgramsRepository`) owns the reads and
 * writes, this module owns the constants + the Chicago month math the monthly
 * attendance scan needs.
 *
 * A dog is ALUMNI when it has completed all 5 day-school curriculum programs
 * (`dog_completed_programs`). Alumni credit lots never expire. Alumni is kept
 * by attending >= ALUMNI_MIN_MONTHLY_SESSIONS qualifying sessions per Chicago
 * calendar month; falling short sets `dogs.alumni_attendance_flagged_at`
 * (staff re-check before the next booking) — the dog STAYS alumni.
 */

/** The "5 day-school courses" — the report_program enum's curriculum values. */
export const CURRICULUM_PROGRAMS = [
  'foundation',
  'advanced',
  'loose-leash',
  'house-manners',
  'cgc',
] as const;

export type CurriculumProgram = (typeof CURRICULUM_PROGRAMS)[number];

export function isCurriculumProgram(value: string): value is CurriculumProgram {
  return (CURRICULUM_PROGRAMS as readonly string[]).includes(value);
}

/**
 * Booking categories that count toward the monthly attendance requirement
 * (Allison's 2026-07-09 pin answer): group classes + the two day programs.
 * Private lessons and boarding/B&T do NOT count.
 */
export const ALUMNI_QUALIFYING_CATEGORIES = ['group-class', 'day-school', 'day-care'] as const;

/** Attended qualifying sessions required per Chicago month to stay unflagged. */
export const ALUMNI_MIN_MONTHLY_SESSIONS = 2;

export interface ChicagoMonthWindow {
  /** UTC instant of the closed month's first midnight (inclusive bound). */
  startUtc: Date;
  /** UTC instant of the current month's first midnight (exclusive bound). */
  endUtc: Date;
  /** The closed month as `YYYY-MM` — the scan's per-dog dedupe-key suffix. */
  monthKey: string;
}

/**
 * The just-closed Chicago calendar month as UTC instants. Month boundaries are
 * CHICAGO midnights converted to UTC (DST-correct via `chicagoWallTimeToUtc`) —
 * never raw-UTC month math, per the §F business-timezone invariant.
 */
export function previousChicagoMonthWindow(now: Date): ChicagoMonthWindow {
  const { date } = chicagoWallPartsAt(now);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  const monthKey = `${previousYear}-${String(previousMonth).padStart(2, '0')}`;
  return {
    startUtc: chicagoWallTimeToUtc(`${monthKey}-01`, 0, 0),
    endUtc: chicagoWallTimeToUtc(`${date.slice(0, 7)}-01`, 0, 0),
    monthKey,
  };
}

/** True on the 1st (Chicago) — the one day the monthly scan does real work. */
export function isFirstOfChicagoMonth(now: Date): boolean {
  return chicagoWallPartsAt(now).date.endsWith('-01');
}
