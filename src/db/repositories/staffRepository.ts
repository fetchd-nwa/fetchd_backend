import { and, asc, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import { db } from '../client.js';
import { staff } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';
import type { StaffRoleValue } from '../../lib/threadWire.js';

type Runner = Tx | typeof db;

/** A staffer as the request services read her (M5.21; wire 9.0.0). */
export interface TrainerRow {
  id: string;
  name: string;
  lessonPriceCents: number | null;
  boardTrainEligible: boolean;
  expiredAt: string | null;
}

const TRAINER_PROJECTION = {
  id: staff.id,
  name: staff.name,
  lessonPriceCents: staff.lessonPriceCents,
  boardTrainEligible: staff.boardTrainEligible,
  expiredAt: staff.expiredAt,
} as const;

/**
 * `livePrincipal(staff) = live AND NOT is_system_account` (design §2.9:4554, S45; rs3 M5.26): the
 * default staff read. The school's system row, *NWA School for Dogs*, is a thread participant
 * and nothing else: never a principal, never on a roster, pick list or responder choice, never a
 * trainer. Every serving read of staff names excludes it (`findNamesByIds` through this predicate,
 * `findAnyNamesByIds` by `NOT is_system_account`; pass-1 audits, Fable M3 and the Opus seat's M1),
 * so a row that names it (a report's trainer, a request's preference) reads as naming nobody. The
 * one read that resolves it is `findParticipantsByIds`: a school thread's participant is the school.
 */
export function livePrincipal(): SQL {
  return and(live(staff), eq(staff.isSystemAccount, false)) as SQL;
}

/** The canonical uuid spelling, so a `staff_preference` that is no uuid never reaches a
 *  uuid comparison in SQL (Postgres would refuse the cast). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Data-access seam for the `staff` table. Day-5a uses one method
 * (`findNamesByIds`) to resolve `bookings.trainer_staff_id` → display
 * name for the §B wire shape. The repo exists as its own file rather
 * than being absorbed into `bookingsRepository` because `staff` is a
 * separate entity, not a tightly-coupled child of `bookings` (cohorts,
 * reports, and `pending_requests.approved_by_staff_id` will all need
 * staff-name resolution too — rule of two will fire soon).
 */
export const staffRepository = {
  /**
   * Names for a batch of staff ids. Returns only LIVE staff (a soft-
   * expired trainer's bookings keep the staff_id reference in the audit
   * trail, but the displayed name disappears from the live wire — the
   * route maps NULL/missing to "no trainer" per the §B optional-omit
   * convention). Never the school's system row (`livePrincipal`): it is no person, so a
   * report naming it as trainer shows no trainer, as one naming a departed staffer does.
   * `runner`: a caller inside a transaction passes its own (a pooled read there waits for a
   * second connection while holding one; O-MSG-LIVE pass 2 fix 1, M1).
   */
  async findNamesByIds(
    ids: string[],
    runner: Runner = db,
  ): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0) return [];
    return runner
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(and(inArray(staff.id, ids), livePrincipal()));
  },

  /**
   * Build a null-aware trainer-name lookup for a batch of rows. Dedupes
   * the unique `trainerStaffId` values, fetches all in one query via
   * `findNamesByIds`, returns a closure callers use per-row.
   *
   * Rule-of-two extraction (Day 6b): `wireBookings` and `wireReports`
   * both did this dance inline. Day-7 events (organizer staff) and
   * Day-12 report mutations (author staff) will reuse. Returns `null`
   * for unknown ids (soft-expired staff, structurally missing rows) —
   * matches the optional-omit `trainer?` convention. `runner`: a caller inside a transaction
   * passes its own (`staffReports.ts` `wireOneReport`; pass 2 fix 1, M1).
   */
  async resolveTrainerNames<T extends { trainerStaffId: string | null }>(
    rows: readonly T[],
    runner: Runner = db,
  ): Promise<(id: string | null) => string | null> {
    const ids = [
      ...new Set(rows.map((r) => r.trainerStaffId).filter((v): v is string => v !== null)),
    ];
    if (ids.length === 0) return () => null;
    const staffRows = await staffRepository.findNamesByIds(ids, runner);
    const namesById = new Map(staffRows.map((s) => [s.id, s.name] as const));
    return (id) => (id === null ? null : (namesById.get(id) ?? null));
  },

  /**
   * Resolve a batch of staff ids to full participant rows (id + name + role
   * + image_path) for thread-participant emission. Day-7a addition for
   * Thread.participant per DATA-CONTRACT §B (the participant key needs
   * role + image_path beyond the trainer-name shape).
   *
   * EXPIRED staff resolve too (P02; design §2.1:2025-2029, r4-opus #4): a
   * departed staffer stays the participant of the threads she was on, and
   * `npm run staff:provision -- --expire` creates exactly that case — a
   * live-only read would make `wireManyThreads` throw and 500 the owner's
   * `GET /threads` and the staff queue the day someone is off-boarded. The
   * design gives this read to MSG-U03 (P31); it is pulled forward because P02
   * ships `--expire`.
   */
  async findParticipantsByIds(ids: string[]): Promise<
    {
      id: string;
      name: string;
      role: StaffRoleValue;
      imagePath: string | null;
      isSchool: boolean;
    }[]
  > {
    if (ids.length === 0) return [];
    return db
      .select({
        id: staff.id,
        name: staff.name,
        role: staff.role,
        imagePath: staff.imagePath,
        // S45 (MSG-U03): the system row is the participant of every school thread, and the
        // wire marks it `is_school` (it is the one exception to `livePrincipal`).
        isSchool: staff.isSystemAccount,
      })
      .from(staff)
      .where(inArray(staff.id, ids));
  },

  /**
   * The school's system row (rs3 M5.26), or `undefined` on a database that lacks it (which
   * no database born from `schema.sql` or rs3 can be). `POST /threads` addresses it; a
   * school thread's `school_name` signature reads its name.
   */
  async findSchoolAccount(runner: Runner = db): Promise<{ id: string; name: string } | undefined> {
    const [row] = await runner
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(and(eq(staff.isSystemAccount, true), live(staff)))
      .limit(1);
    return row;
  },

  /**
   * Names for a batch of staff ids, EXPIRED staff included (P49, wire 9.0.0): what staff
   * approved (`PendingRequestWire.approved_trainer`), whom a family asked for
   * (`StaffRequestWire.preferred_trainer`) and a booked service's trainer
   * (`StaffServiceBookingWire.trainer`) stay facts after she leaves. Never the school's
   * system row (S45): it was never a person, so an id naming it reads as naming nobody.
   */
  async findAnyNamesByIds(
    ids: readonly string[],
    runner: Runner = db,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await runner
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(and(inArray(staff.id, unique), eq(staff.isSystemAccount, false)));
    return new Map(rows.map((r) => [r.id, r.name] as const));
  },

  /**
   * Whether `id` names a staffer: a `staff` row that is not the school's system row, live or
   * since expired (orchestrator ruling MB32). `POST /staff/reports` refuses any other
   * `trainer_staff_id`: one that names no row (a 23503 that paged), and the system row, which is
   * never a trainer (S45). A departed staffer stays acceptable: a report about her session is true.
   */
  async isStaffMember(runner: Runner, id: string): Promise<boolean> {
    const [row] = await runner
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.id, id), eq(staff.isSystemAccount, false)))
      .limit(1);
    return row !== undefined;
  },

  /**
   * The staff row a text value names, live or expired, or `undefined` when it names none:
   * a `focus.staff_preference` that is `'any'`, a slug such as `'rachel'`, or an unknown
   * id (P49, wire 9.0.0, A4; notes R2). `FOR SHARE` inside a transaction, so a roster run
   * cannot change her price or eligibility between this read and the write it decides.
   */
  async findTrainer(
    runner: Runner,
    value: string,
    opts: { lock?: boolean } = {},
  ): Promise<TrainerRow | undefined> {
    if (!UUID.test(value)) return undefined;
    // D15 (A1): never the system row, whatever it holds, so a request or an approve naming
    // it is refused exactly as one naming an unpriced staffer is.
    const query = runner
      .select(TRAINER_PROJECTION)
      .from(staff)
      .where(and(eq(staff.id, value.toLowerCase()), eq(staff.isSystemAccount, false)))
      .limit(1);
    const [row] = await (opts.lock === true ? query.for('share') : query);
    return row;
  },

  /**
   * `GET /trainers` (P49, wire 9.0.0, A9): every live staffer with a lesson price or Board &
   * Train eligibility, ordered by name (ties by id).
   */
  async listTrainers(runner: Runner = db): Promise<TrainerRow[]> {
    return runner
      .select(TRAINER_PROJECTION)
      .from(staff)
      .where(
        and(
          // D15 (A1): `livePrincipal`, so the system row is never listed, whatever it holds.
          livePrincipal(),
          or(isNotNull(staff.lessonPriceCents), eq(staff.boardTrainEligible, true)),
        ),
      )
      .orderBy(asc(staff.name), asc(staff.id));
  },
};
