import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { bookingAttendance, bookingDogs, bookings } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { ServiceCategory } from '../../lib/bookingBucket.js';
import type { BookingStatus, LocationKey } from '../../lib/bookingWire.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `bookings` + the tightly-coupled `booking_dogs`
 * join table. The route layer parses query/params, calls into here, then
 * passes the rows to the wire helper (`lib/bookingWire.ts`) for response
 * shaping. The dependency rule: routes → repos → drizzle; the wire helper
 * is pure (takes structural rows in, emits wire shapes out — no DB).
 *
 * Why a repo at all (Day-5a extraction): the four bookings endpoints share
 * the same projection + the same wire assembly. Without the repo seam the
 * queries get re-written inline four times and the route file does data
 * access + bucketing + denormalization + sorting + response shaping —
 * five concerns in one place. The repo carves off "data access" cleanly.
 * Day 8 (Redis read-through) wraps these methods with a cache decorator.
 */

/**
 * The shape every booking read returns. Matches DATA-CONTRACT §B Booking
 * columns the wire helper consumes, plus `pickupAt` (needed by `isInView`
 * for stays) and `trainerStaffId` (resolved separately by the route via
 * `staffRepository`). Drizzle's pg `mode: 'string'` is why timestamptz
 * comes back as `string` not `Date` — the wire helper converts on emit.
 */
export interface BookingRow {
  id: string;
  category: ServiceCategory;
  status: BookingStatus;
  scheduledAt: string;
  durationMinutes: number | null;
  notes: string | null;
  sessionReportId: string | null;
  location: LocationKey | null;
  lessonSetting: 'home' | 'public' | null;
  cancelledAt: string | null;
  cancelForfeited: boolean;
  cancelDeadlineAt: string | null;
  cancelledBy: 'owner' | 'staff' | null;
  cancelReason: string | null;
  pickupAt: string | null;
  trainerStaffId: string | null;
  cohortId: string | null;
}

/**
 * Full row with `ownerId` — a field the route layer needs for cross-owner
 * defense, but the public wire shape doesn't carry. Day-13 cancel txn reads
 * this projection. (`cancelDeadlineAt` graduated to the base `BookingRow`
 * Δ 2026-07-08 — it's now on the wire for the overlap-cancel forfeit warning.)
 */
export interface BookingFullRow extends BookingRow {
  ownerId: string;
  leadDogId: string;
  expiredAt: string | null;
}

/** A `booking_dogs` join row — lead + additional per booking. */
export interface BookingDogJoinRow {
  bookingId: string;
  dogId: string;
  isLead: boolean;
}

/**
 * Column projection every read shares. Centralized so adding a new column
 * (Day-6+) only touches one constant. Kept private to the repo — the route
 * layer never selects directly off `bookings.*`.
 */
const BOOKING_PROJECTION = {
  id: bookings.id,
  category: bookings.category,
  status: bookings.status,
  scheduledAt: bookings.scheduledAt,
  durationMinutes: bookings.durationMinutes,
  notes: bookings.notes,
  sessionReportId: bookings.sessionReportId,
  location: bookings.location,
  lessonSetting: bookings.lessonSetting,
  cancelledAt: bookings.cancelledAt,
  cancelForfeited: bookings.cancelForfeited,
  cancelDeadlineAt: bookings.cancelDeadlineAt,
  cancelledBy: bookings.cancelledBy,
  cancelReason: bookings.cancelReason,
  pickupAt: bookings.pickupAt,
  trainerStaffId: bookings.trainerStaffId,
  cohortId: bookings.cohortId,
} as const;

const BOOKING_FULL_PROJECTION = {
  ...BOOKING_PROJECTION,
  ownerId: bookings.ownerId,
  leadDogId: bookings.leadDogId,
  expiredAt: bookings.expiredAt,
} as const;

export const bookingsRepository = {
  /**
   * Every live, non-cancelled booking for one owner. The base query for
   * the bookings list endpoints. Runtime bucketing (`isInView`) and
   * sort happen in the route over this result.
   */
  async findLiveActiveByOwner(ownerId: string): Promise<BookingRow[]> {
    return db
      .select(BOOKING_PROJECTION)
      .from(bookings)
      .where(and(eq(bookings.ownerId, ownerId), ne(bookings.status, 'cancelled'), live(bookings)));
  },

  /**
   * Every live, non-cancelled booking across ALL owners — the Day-19
   * staff-portal queue read (`GET /staff/bookings`). Cross-owner by
   * design (`requireStaff` gates the route); the owner-scoped sibling is
   * `findLiveActiveByOwner`. The route sorts by scheduled_at.
   */
  async findLiveActive(): Promise<BookingRow[]> {
    return db
      .select(BOOKING_PROJECTION)
      .from(bookings)
      .where(and(ne(bookings.status, 'cancelled'), live(bookings)));
  },

  /**
   * Single booking by id, owner-scoped. INCLUDES cancelled rows — the
   * `/bookings/:id` endpoint surfaces cancellations for the detail
   * view; list endpoints exclude them via `findLiveActiveByOwner`.
   */
  async findByIdForOwner(id: string, ownerId: string): Promise<BookingRow | undefined> {
    const rows = await db
      .select(BOOKING_PROJECTION)
      .from(bookings)
      .where(and(eq(bookings.id, id), eq(bookings.ownerId, ownerId), live(bookings)))
      .limit(1);
    return rows[0];
  },

  /**
   * Bookings where the given dog is on the `booking_dogs` roster as
   * EITHER lead OR additional. Owner-scoped (defense in depth — the
   * booking flow refuses to add a dog the booker doesn't own, but the
   * filter guards against a future drift). Non-cancelled. Live.
   */
  async findLiveActiveForDog(dogId: string, ownerId: string): Promise<BookingRow[]> {
    const idRows = await db
      .select({ bookingId: bookingDogs.bookingId })
      .from(bookingDogs)
      .where(and(eq(bookingDogs.dogId, dogId), live(bookingDogs)));
    const bookingIds = idRows.map((r) => r.bookingId);
    if (bookingIds.length === 0) return [];
    return db
      .select(BOOKING_PROJECTION)
      .from(bookings)
      .where(
        and(
          inArray(bookings.id, bookingIds),
          eq(bookings.ownerId, ownerId),
          ne(bookings.status, 'cancelled'),
          live(bookings),
        ),
      );
  },

  /**
   * Count the dog's PAST (completed, non-cancelled) sessions in a category —
   * dog on the `booking_dogs` roster (lead or additional). Cross-owner (staff
   * context, no owner filter). Drives the report author's auto visit number:
   * the report being written is visit `count + 1`.
   */
  async countPastSessionsForDog(dogId: string, category: ServiceCategory): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bookings)
      .innerJoin(bookingDogs, eq(bookingDogs.bookingId, bookings.id))
      .where(
        and(
          eq(bookingDogs.dogId, dogId),
          live(bookingDogs),
          eq(bookings.category, category),
          eq(bookings.status, 'past'),
          live(bookings),
        ),
      );
    return row?.count ?? 0;
  },

  /**
   * When NWA last SAW this dog for the 3-month re-evaluation staleness rule
   * (Shanthi 2026-07-14): the latest day-school / day-care session the dog
   * actually ATTENDED (per-dog `booking_dogs.attendance = 'attended'` —
   * bookings created but no-showed don't count, and per Allison's ruling
   * group classes / private lessons / stays don't reset the clock either).
   * `undefined` = never attended a day program.
   */
  async findLastAttendedDayProgramAt(tx: Tx, dogId: string): Promise<Date | undefined> {
    const [row] = await tx
      .select({ lastAt: sql<string | null>`max(${bookings.scheduledAt})` })
      .from(bookings)
      .innerJoin(bookingDogs, eq(bookingDogs.bookingId, bookings.id))
      .where(
        and(
          eq(bookingDogs.dogId, dogId),
          eq(bookingDogs.attendance, 'attended'),
          live(bookingDogs),
          inArray(bookings.category, ['day-school', 'day-care']),
          live(bookings),
        ),
      );
    return row?.lastAt == null ? undefined : new Date(row.lastAt);
  },

  /**
   * Candidate live (non-cancelled) bookings a new day program on `chicagoDates`
   * could conflict with, matched on the `booking_dogs` roster (lead OR
   * additional). Feeds the `POST /bookings` time-overlap guard
   * (`lib/bookingConflicts.dayProgramConflictsWith`), which applies the exact
   * FE rules to each candidate. Two shapes:
   *   • sessional — day-school / day-care / private-lesson / evaluation whose
   *     Chicago day is one of `chicagoDates` (a day program only occupies its
   *     own day, so only same-day sessions can overlap). Group classes are
   *     excluded — they never conflict.
   *   • residential — boarding / board-and-train stays whose [drop-off, pick-up]
   *     day range can cover a target day. Kept when the stay hasn't ended before
   *     the earliest target (unbounded stays — no pick-up yet — always kept);
   *     the JS coverage check narrows to exact days.
   *
   * Run inside the booking txn under the (location, date) capacity lock so a
   * concurrent create on the same bucket can't slip an overlap past the check.
   */
  async findConflictCandidatesForDog(
    tx: Tx,
    dogId: string,
    chicagoDates: string[],
  ): Promise<
    {
      category: ServiceCategory;
      scheduledAt: string;
      durationMinutes: number | null;
      pickupAt: string | null;
    }[]
  > {
    if (chicagoDates.length === 0) return [];
    const minDate = chicagoDates[0]!;
    const maxDate = chicagoDates[chicagoDates.length - 1]!;
    const projection = {
      category: bookings.category,
      scheduledAt: bookings.scheduledAt,
      durationMinutes: bookings.durationMinutes,
      pickupAt: bookings.pickupAt,
    } as const;

    const sessional = await tx
      .select(projection)
      .from(bookings)
      .innerJoin(bookingDogs, eq(bookingDogs.bookingId, bookings.id))
      .where(
        and(
          eq(bookingDogs.dogId, dogId),
          live(bookingDogs),
          inArray(bookings.category, ['day-school', 'day-care', 'private-lesson', 'evaluation']),
          ne(bookings.status, 'cancelled'),
          live(bookings),
          inArray(
            sql`(${bookings.scheduledAt} AT TIME ZONE 'America/Chicago')::date`,
            chicagoDates,
          ),
        ),
      );

    const residential = await tx
      .select(projection)
      .from(bookings)
      .innerJoin(bookingDogs, eq(bookingDogs.bookingId, bookings.id))
      .where(
        and(
          eq(bookingDogs.dogId, dogId),
          live(bookingDogs),
          inArray(bookings.category, ['boarding', 'board-and-train']),
          ne(bookings.status, 'cancelled'),
          live(bookings),
          sql`(${bookings.scheduledAt} AT TIME ZONE 'America/Chicago')::date <= ${maxDate}`,
          sql`(${bookings.pickupAt} IS NULL OR (${bookings.pickupAt} AT TIME ZONE 'America/Chicago')::date >= ${minDate})`,
        ),
      );

    return [...sessional, ...residential];
  },

  /**
   * Day-19d duplicate guard (cohort enrollment). Of the given dogs, which
   * already have a live (non-cancelled) booking in this cohort. Run inside the
   * enrollment txn under the cohort lock so a concurrent enroll can't slip a
   * duplicate past the check.
   */
  async findEnrolledDogsInCohort(tx: Tx, cohortId: string, dogIds: string[]): Promise<string[]> {
    if (dogIds.length === 0) return [];
    const rows = await tx
      .selectDistinct({ leadDogId: bookings.leadDogId })
      .from(bookings)
      .where(
        and(
          eq(bookings.cohortId, cohortId),
          inArray(bookings.leadDogId, dogIds),
          ne(bookings.status, 'cancelled'),
          live(bookings),
        ),
      );
    return rows.map((r) => r.leadDogId);
  },

  /**
   * The live (non-cancelled) booking ids for one dog in one cohort, oldest
   * session first (Δ 2026-06-09 group-class withdraw). An enrollment is
   * `weeks` weekly rows for the (cohort, dog); the withdraw verb cancels all of
   * them. The earliest `scheduled_at` doubles as the cohort's first-session
   * instant for the "class hasn't started" guard. Empty = not enrolled.
   */
  async findLiveBookingsForCohortDog(
    tx: Tx,
    cohortId: string,
    dogId: string,
  ): Promise<{ id: string; scheduledAt: string }[]> {
    return tx
      .select({ id: bookings.id, scheduledAt: bookings.scheduledAt })
      .from(bookings)
      .where(
        and(
          eq(bookings.cohortId, cohortId),
          eq(bookings.leadDogId, dogId),
          ne(bookings.status, 'cancelled'),
          live(bookings),
        ),
      )
      .orderBy(asc(bookings.scheduledAt));
  },

  /**
   * Resolve booking_dogs rows for a batch of booking ids — lead +
   * additional per booking. Caller groups via
   * `lib/bookingWire.groupBookingDogs` for snapshot-stable ordering.
   */
  async findDogsByBookingIds(bookingIds: string[]): Promise<BookingDogJoinRow[]> {
    if (bookingIds.length === 0) return [];
    return db
      .select({
        bookingId: bookingDogs.bookingId,
        dogId: bookingDogs.dogId,
        isLead: bookingDogs.isLead,
      })
      .from(bookingDogs)
      .where(and(inArray(bookingDogs.bookingId, bookingIds), live(bookingDogs)));
  },

  // -------------------------------------------------------------------
  // Day 10 — write path. Tx-only methods compose inside `withMutation`'s
  // body. The route's request hash + idempotency check happen one level
  // up (`db/mutation.ts`); this layer trusts its inputs (the route is
  // the validation boundary) and returns the inserted rows for the wire
  // assembly step.
  // -------------------------------------------------------------------

  /**
   * INSERT one bookings row + the `booking_dogs` rows for lead +
   * additionals. Single repo call so the route doesn't have to interleave
   * two writes (the failure modes — partial insert, FK violation between
   * the two — are contained here, not exposed to the route).
   *
   * Returns the full `BookingRow` projection — the same shape every read
   * endpoint uses (`BOOKING_PROJECTION`). The route consumes this
   * directly via `toBookingWire` and skips a second round-trip through
   * `findByIdInTx`. This is the same projection because the wire-shape
   * helper is structurally typed on it; the create operation's
   * return-value IS its read-by-id projection, no drift between the two.
   *
   * Lead-dog invariant: exactly one `is_lead=true` row, matching
   * `bookings.lead_dog_id`. Schema enforces this implicitly via the
   * BEFORE-INSERT triggers reading `NEW.lead_dog_id` (the gate triggers
   * check the lead dog's vaccines/owner's signatures/payment-methods).
   *
   * Day 11 additions:
   *  - `cohortId` — required when `category === 'group-class'` (schema
   *    CHECK `(category = 'group-class') = (cohort_id IS NOT NULL)`),
   *    must be undefined / null for all other categories.
   *  - `sessionReportId` — the shared per-(cohort, dog) report a future
   *    Day-19 staff "author report" verb will link back. NULL at
   *    enrollment time (no report exists yet).
   *
   * One primitive serves both paths because the only INSERT difference
   * is the cohort/session_report columns — extracting a sibling
   * `createForCohort` would duplicate the gate-trigger surface and the
   * booking_dogs interleave for no real benefit.
   */
  async create(
    tx: Tx,
    values: {
      ownerId: string;
      leadDogId: string;
      category: ServiceCategory;
      scheduledAt: Date;
      location: LocationKey;
      notes: string | null;
      cancelDeadlineAt: Date;
      additionalDogIds: readonly string[];
      cohortId?: string | null;
      sessionReportId?: string | null;
      // Δ 2026-07-14: private-lesson only — copied from the request at approve.
      lessonSetting?: 'home' | 'public' | null;
    },
  ): Promise<BookingRow> {
    const [bookingRow] = await tx
      .insert(bookings)
      .values({
        ownerId: values.ownerId,
        leadDogId: values.leadDogId,
        category: values.category,
        scheduledAt: values.scheduledAt.toISOString(),
        location: values.location,
        notes: values.notes,
        cancelDeadlineAt: values.cancelDeadlineAt.toISOString(),
        cohortId: values.cohortId ?? null,
        sessionReportId: values.sessionReportId ?? null,
        lessonSetting: values.lessonSetting ?? null,
        // status defaults to 'upcoming' (schema), durationMinutes/trainer*/
        // report_id/confirmed*/dropoff*/pickup*/cancelled*/source all
        // remain at their schema defaults (NULL / 'app' / false).
      })
      .returning(BOOKING_PROJECTION);
    if (!bookingRow) {
      throw new Error('bookingsRepository.create: bookings INSERT returned no row');
    }
    const dogRows = [
      { bookingId: bookingRow.id, dogId: values.leadDogId, isLead: true },
      ...values.additionalDogIds.map((dogId) => ({
        bookingId: bookingRow.id,
        dogId,
        isLead: false,
      })),
    ];
    await tx.insert(bookingDogs).values(dogRows);
    return bookingRow;
  },

  // -------------------------------------------------------------------
  // Day 13 — cancel path. `lockById` + `findFullByIdInTx` give the
  // cancel route the row-lock + ownership/state checks it needs;
  // `markCancelled` performs the soft-cancel write (no row delete).
  // -------------------------------------------------------------------

  /**
   * Row-lock a booking for the duration of the transaction. Concurrent
   * cancel attempts on the same booking serialize here. Returns the
   * locked row (full projection: includes `ownerId`, `cancelDeadlineAt`,
   * `cohortId` — the cancel txn needs all three for owner/state checks
   * and the capacity-release branch).
   *
   * `undefined` if the id doesn't exist. Mirrors
   * `requestsRepository.lockById` — soft-expire is NOT filtered here;
   * the caller decides the semantic for an expired row (the cancel
   * route treats `expiredAt IS NOT NULL` as 404, same as not-found).
   */
  async lockById(tx: Tx, id: string): Promise<BookingFullRow | undefined> {
    const [row] = await tx
      .select(BOOKING_FULL_PROJECTION)
      .from(bookings)
      .where(eq(bookings.id, id))
      .for('update');
    return row;
  },

  /**
   * Re-read the full row inside the tx after a mutation, so the route
   * can wire back the post-cancel shape (status='cancelled',
   * cancelledAt set, cancelForfeited resolved). No `live()` filter —
   * mirrors `lockById`'s "existence-by-id" semantic; the route already
   * decided liveness when it locked the row.
   */
  async findFullByIdInTx(tx: Tx, id: string): Promise<BookingFullRow | undefined> {
    const [row] = await tx
      .select(BOOKING_FULL_PROJECTION)
      .from(bookings)
      .where(eq(bookings.id, id))
      .limit(1);
    return row;
  },

  /**
   * The drop-off / scheduled anchor + lead dog for one booking. Backs the
   * pay-in-person payment-due reminder (R3): it schedules 24h before the
   * stay's drop-off (`dropoffAt`), falling back to `scheduledAt` for the
   * non-stay categories that carry no drop-off. Deliberately narrow — no
   * `live()` filter, no ownership scope (the caller already validated the
   * invoice that references this booking).
   */
  async findScheduleAnchorById(
    runner: Tx | typeof db,
    id: string,
  ): Promise<{ dropoffAt: string | null; scheduledAt: string; leadDogId: string } | undefined> {
    const [row] = await runner
      .select({
        dropoffAt: bookings.dropoffAt,
        scheduledAt: bookings.scheduledAt,
        leadDogId: bookings.leadDogId,
      })
      .from(bookings)
      .where(eq(bookings.id, id))
      .limit(1);
    return row;
  },

  /**
   * Soft-cancel one booking. Sets `status='cancelled'`, `cancelledAt =
   * now()`, `cancelForfeited` per the per-row deadline check, and — R5
   * (Allison sim-QA 2026-07-27) — `cancelledBy` ('owner' | 'staff') plus
   * the optional `cancelReason` staff supplies. These drive the owner
   * app's cancelled-booking banner ("You cancelled this…" vs "The school
   * cancelled this…" + the reason line). (The older `cancellation_reason`
   * column stays unused — the new `cancel_reason` supersedes it.)
   *
   * `cancelForfeited` is computed in SQL against `cancel_deadline_at`
   * (`now() > cancel_deadline_at`). Doing the check in SQL means a
   * deadline of NULL — possible on legacy-import rows pre-Day-10 —
   * coerces to `cancel_forfeited = false` (NULL > anything is NULL,
   * COALESCEd to false). Defensible behavior: a missing deadline can't
   * be enforced, so treat the cancel as in-window.
   *
   * No `expired_at` write — DATA-CONTRACT §A2 "never DELETE" applies:
   * cancellation is a status flip, not a row-expire. Audit row captures
   * the prior status.
   */
  async markCancelled(
    tx: Tx,
    args: { id: string; cancelledBy: 'owner' | 'staff'; cancelReason?: string | null },
  ): Promise<void> {
    await tx
      .update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: sql`now()`,
        cancelForfeited: sql`COALESCE(now() > ${bookings.cancelDeadlineAt}, false)`,
        cancelledBy: args.cancelledBy,
        cancelReason: args.cancelReason ?? null,
      })
      .where(eq(bookings.id, args.id));
  },

  // -------------------------------------------------------------------
  // Day 19 — staff portal verb 4 (confirm + per-dog attendance). The
  // shared cancel txn lives in `lib/cancelBookingService.ts`.
  // -------------------------------------------------------------------

  /**
   * Staff confirm. Stamps `confirmed_at = now()` ONLY when currently
   * NULL, so a re-confirm with a fresh Idempotency-Key is a no-op that
   * preserves the FIRST confirm time (the value drives reminder
   * scheduling). The route re-reads + wires; this returns nothing.
   */
  async setConfirmed(tx: Tx, id: string): Promise<void> {
    await tx
      .update(bookings)
      .set({ confirmedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(bookings.id, id), isNull(bookings.confirmedAt)));
  },

  /**
   * Back-link a booking to a freshly-authored report (Day-19 verb 2).
   * Sets `session_report_id` on a live booking whose `lead_dog_id`
   * matches the report's dog; returns the matched id (or `undefined` for
   * no live booking / dog mismatch, which the route maps to 422). The
   * `lead_dog_id` predicate is the coherence guard — a report can only
   * link a booking for the same dog.
   *
   * Group-class multi-week back-link (Day-19b, DATA-CONTRACT group-class
   * enrollment): a group-class report covers the whole cohort run, so when
   * the picked booking is a group-class booking it propagates the link to
   * EVERY live weekly booking for that (cohort, dog) — not just the one. The
   * `lead_dog_id = dog` predicate holds for all weekly rows (enrollment
   * stamps `lead_dog_id = $dog` per row). Non-group-class is unchanged
   * (single booking). `report_id` (the other bookings→reports FK) is left
   * untouched — its role is documented-open, not part of this linkage.
   */
  async setSessionReportId(
    tx: Tx,
    args: { bookingId: string; reportId: string; dogId: string },
  ): Promise<string | undefined> {
    const [row] = await tx
      .update(bookings)
      .set({ sessionReportId: args.reportId, updatedAt: sql`now()` })
      .where(
        and(eq(bookings.id, args.bookingId), eq(bookings.leadDogId, args.dogId), live(bookings)),
      )
      .returning({ id: bookings.id, category: bookings.category, cohortId: bookings.cohortId });
    if (row === undefined) return undefined;

    if (row.category === 'group-class' && row.cohortId !== null) {
      await tx
        .update(bookings)
        .set({ sessionReportId: args.reportId, updatedAt: sql`now()` })
        .where(
          and(
            eq(bookings.cohortId, row.cohortId),
            eq(bookings.leadDogId, args.dogId),
            live(bookings),
          ),
        );
    }
    return row.id;
  },

  /**
   * Record a per-dog check-in (Day-19 attendance). Sets `attendance`,
   * `checked_in_at = now()`, and the acting `checked_in_by_staff_id` on
   * the `booking_dogs` row, returning the resolved `attendance` +
   * `checkedInAt` for the wire. `undefined` when the (booking, dog) pair
   * isn't on the roster — the route 404s on that (the `RETURNING` folds
   * the existence check into the write). The route validates `status` to
   * the non-'pending' subset before calling.
   */
  async setAttendance(
    tx: Tx,
    args: {
      bookingId: string;
      dogId: string;
      status: (typeof bookingAttendance.enumValues)[number];
      staffId: string;
    },
  ): Promise<
    { attendance: (typeof bookingAttendance.enumValues)[number]; checkedInAt: string } | undefined
  > {
    const [row] = await tx
      .update(bookingDogs)
      .set({
        attendance: args.status,
        checkedInAt: sql`now()`,
        checkedInByStaffId: args.staffId,
      })
      .where(and(eq(bookingDogs.bookingId, args.bookingId), eq(bookingDogs.dogId, args.dogId)))
      .returning({
        attendance: bookingDogs.attendance,
        checkedInAt: bookingDogs.checkedInAt,
      });
    if (row === undefined || row.checkedInAt === null) return undefined;
    return { attendance: row.attendance, checkedInAt: row.checkedInAt };
  },
};
