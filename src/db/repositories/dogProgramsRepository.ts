import { and, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { dogCompletedPrograms } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';
import type { CurriculumProgram } from '../../lib/alumni.js';

/**
 * Data-access seam for `dog_completed_programs` (DATA-CONTRACT §J.3). Alumni is
 * DERIVED, by the wires that report it: a dog with all 5 live curriculum
 * completions is alumni; there is no status row to drift. Mirrors the
 * `dog_completed_classes` conventions (soft-expire, one live row per
 * (dog, program) via the partial unique).
 */

type Runner = Tx | typeof db;

export interface CompletedProgramRow {
  program: CurriculumProgram;
  completedAt: string;
}

export const dogProgramsRepository = {
  async findLiveByDog(dogId: string, runner: Runner = db): Promise<CompletedProgramRow[]> {
    const rows = await runner
      .select({
        program: dogCompletedPrograms.program,
        completedAt: dogCompletedPrograms.completedAt,
      })
      .from(dogCompletedPrograms)
      .where(and(eq(dogCompletedPrograms.dogId, dogId), live(dogCompletedPrograms)))
      .orderBy(dogCompletedPrograms.completedAt, dogCompletedPrograms.id);
    // The CHECK constraint pins the column to the 5 curriculum values, so the
    // narrow is safe — the wider report_program arms can't appear in this table.
    return rows as CompletedProgramRow[];
  },

  /**
   * Record a course completion. Idempotent per the partial unique — a repeat
   * for the same live (dog, program) is a no-op returning `undefined`.
   */
  async recordCompletion(
    tx: Tx,
    args: { dogId: string; program: CurriculumProgram; staffId: string | null },
  ): Promise<{ id: string } | undefined> {
    const [row] = await tx
      .insert(dogCompletedPrograms)
      .values({
        dogId: args.dogId,
        program: args.program,
        completedByStaffId: args.staffId,
      })
      .onConflictDoNothing()
      .returning({ id: dogCompletedPrograms.id });
    return row;
  },

  /** Soft-expire a live completion (a mistaken record). Returns true if one died. */
  async expireCompletion(
    tx: Tx,
    args: { dogId: string; program: CurriculumProgram; now: Date },
  ): Promise<boolean> {
    const rows = await tx
      .update(dogCompletedPrograms)
      .set({ expiredAt: args.now.toISOString() })
      .where(
        and(
          eq(dogCompletedPrograms.dogId, args.dogId),
          eq(dogCompletedPrograms.program, args.program),
          live(dogCompletedPrograms),
        ),
      )
      .returning({ id: dogCompletedPrograms.id });
    return rows.length > 0;
  },
};
