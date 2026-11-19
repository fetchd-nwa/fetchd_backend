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

import { pgTimestampToDate } from './pgTimestamp.js';

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
 * When the dog became alumni (wire 9.2.0-pre.2, `DogWire.alumni_at`; her #33, "Alumni on
 * [insert date]"; build DECISIONS 702(1), 704, 705): the fifth level's record date, i.e.
 * the LATEST `completedAt` among her live records. The record that made five is when
 * `is_alumni` was set; a level un-recorded and recorded again later moves it.
 *
 * `null` (the wire omits the key, and the app shows "Alumni" alone) unless she is alumni
 * AND every level has a live record: an imported alumni dog with no level records, an
 * alumni dog with a level un-recorded since (`is_alumni` is never cleared, M4.11), and a
 * dog that is not alumni whatever her records.
 *
 * `liveRecords` are the dog's LIVE rows (`AssembledDog.completedPrograms`). Returns the
 * row's own Postgres text; the wire mapper turns it into an ISO instant.
 */
export function alumniRecordedAt(
  isAlumni: boolean,
  liveRecords: ReadonlyArray<{ program: string; completedAt: string }>,
): string | null {
  if (!isAlumni) return null;
  const levels = new Set(liveRecords.map((r) => r.program));
  if (!CURRICULUM_PROGRAMS.every((program) => levels.has(program))) return null;
  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const record of liveRecords) {
    const ms = pgTimestampToDate(record.completedAt).getTime();
    if (ms > latestMs) {
      latest = record.completedAt;
      latestMs = ms;
    }
  }
  return latest;
}
