/**
 * Alumni business rules (DATA-CONTRACT §J.3, ruled 2026-07-09). PURE — no DB
 * imports; the repository layer (`dogProgramsRepository`) owns the reads and
 * writes.
 *
 * A dog is ALUMNI when it has completed all 5 day-school curriculum programs
 * (`dog_completed_programs`). One status, no tier, and it never lapses: nothing
 * reads attendance to take it away (ALUM-U01). Alumni credits expire like
 * everyone's (ALUM-U16).
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
