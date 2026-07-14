import { and, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { dogCompletedPrograms } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';
import {
  ALUMNI_QUALIFYING_CATEGORIES,
  CURRICULUM_PROGRAMS,
  type CurriculumProgram,
} from '../../lib/alumni.js';

/**
 * Data-access seam for `dog_completed_programs` + the alumni derivation
 * (DATA-CONTRACT §J.3). Alumni is DERIVED — a dog with all 5 live curriculum
 * completions is alumni; there is no status row to drift. Mirrors the
 * `dog_completed_classes` conventions (soft-expire, one live row per
 * (dog, program) via the partial unique).
 */

type Runner = Tx | typeof db;

export interface CompletedProgramRow {
  program: CurriculumProgram;
  completedAt: string;
}

/** A dog the monthly attendance scan evaluates, with its closed-month count. */
export interface AlumniDogAttendance {
  dogId: string;
  dogName: string;
  ownerId: string;
  attendedCount: number;
  alreadyFlagged: boolean;
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

  /** True when the dog has all 5 live curriculum completions (§J.3). */
  async isAlumni(dogId: string, runner: Runner = db): Promise<boolean> {
    const [row] = await runner
      .select({ count: sql<number>`count(*)::int` })
      .from(dogCompletedPrograms)
      .where(and(eq(dogCompletedPrograms.dogId, dogId), live(dogCompletedPrograms)));
    return (row?.count ?? 0) === CURRICULUM_PROGRAMS.length;
  },

  /**
   * Record a course completion. Idempotent per the partial unique — a repeat
   * for the same live (dog, program) is a no-op returning `undefined`, so the
   * caller can distinguish "newly recorded" (drives the became-alumni check)
   * from "already on file".
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

  /**
   * The monthly scan's read: every ALUMNI dog (all 5 live completions) with a
   * real owner, plus its count of ATTENDED qualifying sessions (group-class /
   * day-school / day-care — §J.3 pin answer) inside the closed Chicago month
   * `[windowStartIso, windowEndIso)`. Attendance is per-dog on `booking_dogs`;
   * cancelled bookings never reach `attendance='attended'` so no status filter
   * is needed beyond the attendance value itself.
   */
  async findAlumniDogsWithAttendance(
    tx: Tx,
    args: { windowStartIso: string; windowEndIso: string },
  ): Promise<AlumniDogAttendance[]> {
    // One bound literal per qualifying category (parameterized, never
    // interpolated) — same sql.join convention as findExpiringLotsForWarning.
    const categoryClause = sql.join(
      ALUMNI_QUALIFYING_CATEGORIES.map((category) => sql`${category}`),
      sql`, `,
    );
    const result = await tx.execute(sql`
      SELECT
        d.id AS "dogId",
        d.name AS "dogName",
        d.owner_id AS "ownerId",
        (d.alumni_attendance_flagged_at IS NOT NULL) AS "alreadyFlagged",
        COALESCE(att.attended_count, 0)::int AS "attendedCount"
      FROM dogs d
      JOIN (
        SELECT dog_id
        FROM dog_completed_programs
        WHERE expired_at IS NULL
        GROUP BY dog_id
        HAVING count(*) = ${CURRICULUM_PROGRAMS.length}
      ) alumni ON alumni.dog_id = d.id
      LEFT JOIN (
        SELECT bd.dog_id, count(*) AS attended_count
        FROM booking_dogs bd
        JOIN bookings b ON b.id = bd.booking_id
        WHERE bd.attendance = 'attended'
          AND b.category IN (${categoryClause})
          AND b.scheduled_at >= ${args.windowStartIso}::timestamptz
          AND b.scheduled_at < ${args.windowEndIso}::timestamptz
        GROUP BY bd.dog_id
      ) att ON att.dog_id = d.id
      WHERE d.owner_id IS NOT NULL
        AND d.expired_at IS NULL
    `);
    // Raw SQL boundary: the SELECT projects exactly the AlumniDogAttendance
    // shape. (The Tx | db union widens .rows, so route through unknown.)
    return result.rows as unknown as AlumniDogAttendance[];
  },
};
