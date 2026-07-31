import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../client.js';
import {
  cohorts,
  dogs,
  waitlistEntries,
  waitlistEntryDogs,
  type LocationKey,
} from '../schema/schema.js';
import { DAY_PROGRAM_DROPOFF_WINDOW } from '../../lib/bookingBucket.js';
import type { BookingMode } from '../../lib/bookingMode.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for the waitlist (Allison 2026-07-29/30). See the DDL in
 * `schema.sql` for the model; the two rules that shape every query here:
 *
 *   1. **FIFO within a target, gate-blocked entries last.** Order is
 *      `(gate_blocked_at IS NOT NULL) ASC, created_at ASC, id ASC` — see
 *      `QUEUE_ORDER`. The id tiebreak matters because two entries created in
 *      the same millisecond would otherwise order nondeterministically, and
 *      "who was first" is the whole promise of a queue.
 *   2. **A queue is per-target, not per-owner.** Position is counted among the
 *      entries waiting for the SAME date+location+mode (or the same cohort),
 *      because that's the thing there's a shortage of.
 *
 * `'waiting'` and `'offered'` are the LIVE statuses: an offered entry still
 * occupies its place (it's holding a seat pending an answer), so it counts for
 * position and blocks a duplicate join.
 */

export const LIVE_WAITLIST_STATUSES = ['waiting', 'offered'] as const;

/** What an entry is waiting FOR — the discriminated target from the DDL. */
export type WaitlistTarget =
  | {
      kind: 'day-program';
      category: 'day-school' | 'day-care';
      sessionDate: string;
      location: LocationKey;
      mode: BookingMode;
    }
  | { kind: 'group-class'; cohortId: string };

export type WaitlistStatus =
  | 'waiting'
  | 'offered'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'cancelled';

export interface WaitlistEntryRow {
  id: string;
  ownerId: string;
  leadDogId: string;
  category: string;
  status: WaitlistStatus;
  sessionDate: string | null;
  location: LocationKey | null;
  mode: BookingMode | null;
  cohortId: string | null;
  offeredAt: string | null;
  offerExpiresAt: string | null;
  resolvedAt: string | null;
  bookingId: string | null;
  /** Set ⇒ the offer was a staff cap override, not a seat that genuinely
   *  freed. Accept reads it to let the booking past the capacity ceiling. */
  offeredByStaffId: string | null;
  /** Set ⇒ this entry failed a booking gate the last time a seat reached it
   *  (R6). It sorts to the back of the queue and is flagged for staff until
   *  the gate passes again. Paired with `gateBlockedReason` by a CHECK. */
  gateBlockedAt: string | null;
  /** The `ApiErrorCode` of the gate that blocked it — `vaccine_missing`,
   *  `payment_required`, `evaluation_required`, `agreement_unsigned`. */
  gateBlockedReason: string | null;
  createdAt: string;
  /** Every dog on the entry, lead first. Promotion needs the full count. */
  dogIds: string[];
}

const ENTRY_PROJECTION = {
  id: waitlistEntries.id,
  ownerId: waitlistEntries.ownerId,
  leadDogId: waitlistEntries.leadDogId,
  category: waitlistEntries.category,
  status: waitlistEntries.status,
  sessionDate: waitlistEntries.sessionDate,
  location: waitlistEntries.location,
  mode: waitlistEntries.mode,
  cohortId: waitlistEntries.cohortId,
  offeredAt: waitlistEntries.offeredAt,
  offerExpiresAt: waitlistEntries.offerExpiresAt,
  resolvedAt: waitlistEntries.resolvedAt,
  bookingId: waitlistEntries.bookingId,
  offeredByStaffId: waitlistEntries.offeredByStaffId,
  gateBlockedAt: waitlistEntries.gateBlockedAt,
  gateBlockedReason: waitlistEntries.gateBlockedReason,
  createdAt: waitlistEntries.createdAt,
} as const;

/**
 * Queue order — Allison 2026-07-31 ruling 7: "if there's someone who passes all
 * gates, they get moved to the top". Every entry that currently passes every
 * gate sorts above every entry that doesn't (`false < true` in Postgres); FIFO
 * decides within each group.
 *
 * The demotion is expressed as a sort key rather than a stamped position on
 * purpose: clearing `gate_blocked_at` restores the entry's ORIGINAL place,
 * because its `created_at` never moved. The demotion lasts exactly as long as
 * the problem.
 */
const QUEUE_ORDER = [
  sql`${waitlistEntries.gateBlockedAt} IS NOT NULL`,
  asc(waitlistEntries.createdAt),
  asc(waitlistEntries.id),
];

/** Attach each entry's dog ids in ONE round trip (no N+1 across a queue read). */
async function withDogs(
  runner: Runner,
  rows: Omit<WaitlistEntryRow, 'dogIds'>[],
): Promise<WaitlistEntryRow[]> {
  if (rows.length === 0) return [];
  const links = await runner
    .select({
      entryId: waitlistEntryDogs.waitlistEntryId,
      dogId: waitlistEntryDogs.dogId,
      isLead: waitlistEntryDogs.isLead,
    })
    .from(waitlistEntryDogs)
    .where(
      inArray(
        waitlistEntryDogs.waitlistEntryId,
        rows.map((r) => r.id),
      ),
    );
  const byEntry = new Map<string, { dogId: string; isLead: boolean }[]>();
  for (const link of links) {
    const list = byEntry.get(link.entryId) ?? [];
    list.push({ dogId: link.dogId, isLead: link.isLead });
    byEntry.set(link.entryId, list);
  }
  return rows.map((row) => ({
    ...row,
    dogIds: (byEntry.get(row.id) ?? [])
      // Lead first so the caller can render "Waffles + 1" without re-sorting.
      .sort((a, b) => Number(b.isLead) - Number(a.isLead))
      .map((d) => d.dogId),
  }));
}

/** The target predicate, shared by every per-queue query. */
function targetWhere(target: WaitlistTarget) {
  return target.kind === 'day-program'
    ? and(
        eq(waitlistEntries.sessionDate, target.sessionDate),
        eq(waitlistEntries.location, target.location),
        eq(waitlistEntries.mode, target.mode),
      )
    : eq(waitlistEntries.cohortId, target.cohortId);
}

/**
 * The stable identity of one queue, as a string. Two targets share a queue iff
 * they share this key — the in-memory counterpart of `targetWhere`, used to
 * dedupe targets across a scan and to derive the per-queue advisory lock key.
 */
export function waitlistTargetKey(target: WaitlistTarget): string {
  return target.kind === 'day-program'
    ? `day:${target.location}:${target.sessionDate}:${target.mode}`
    : `cohort:${target.cohortId}`;
}

/**
 * The columns `waitlistTargetOf` reads. Narrower than `WaitlistEntryRow` so
 * callers with their own projection (the staff queue screen selects a
 * different column set) can resolve a target without carrying fields the
 * function never looks at.
 */
export type WaitlistTargetColumns = Pick<
  WaitlistEntryRow,
  'id' | 'category' | 'sessionDate' | 'location' | 'mode' | 'cohortId'
>;

/**
 * Read an entry's target back out of its columns. The `waitlist_target_shape`
 * CHECK in `schema.sql` guarantees exactly one shape is populated per category,
 * so a row that fails these narrows is a violated DB constraint, not a case to
 * handle — hence the throw rather than an `undefined` the caller would have to
 * invent a meaning for.
 *
 * Generic over the row rather than pinned to `WaitlistTargetColumns` so callers
 * can pass a WIDER row — including one they assemble inline — without
 * TypeScript's excess-property check rejecting fields this function never reads.
 */
export function waitlistTargetOf<TEntry extends WaitlistTargetColumns>(
  entry: TEntry,
): WaitlistTarget {
  if (entry.category === 'group-class') {
    if (entry.cohortId === null) {
      throw new Error(`waitlistTargetOf: group-class entry ${entry.id} has no cohort_id`);
    }
    return { kind: 'group-class', cohortId: entry.cohortId };
  }
  if (entry.category !== 'day-school' && entry.category !== 'day-care') {
    throw new Error(
      `waitlistTargetOf: entry ${entry.id} has unsupported category ${entry.category}`,
    );
  }
  if (entry.sessionDate === null || entry.location === null || entry.mode === null) {
    throw new Error(`waitlistTargetOf: day-program entry ${entry.id} has an incomplete target`);
  }
  return {
    kind: 'day-program',
    category: entry.category,
    sessionDate: entry.sessionDate,
    location: entry.location,
    mode: entry.mode,
  };
}

/**
 * The drop-off window's opening as a `HH:MM` literal for SQL. A day-program
 * waitlist row carries only a DATE, so "when does that session start" resolves
 * to the earliest moment a seat could be used — 07:30 America/Chicago, the same
 * constant `computeDayProgramScheduledAt` defaults a booking's drop-off to.
 */
const DROPOFF_OPEN_WALL_CLOCK = `${String(DAY_PROGRAM_DROPOFF_WINDOW.open.hour).padStart(2, '0')}:${String(
  DAY_PROGRAM_DROPOFF_WINDOW.open.minute,
).padStart(2, '0')}`;

export const waitlistRepository = {
  /**
   * Add an entry to the back of its queue. The partial unique indexes make a
   * duplicate live join a constraint violation rather than a silent second
   * place in line — callers map that to a 409.
   */
  async join(
    tx: Tx,
    args: {
      ownerId: string;
      leadDogId: string;
      /** Every dog on the submission, lead included. */
      dogIds: readonly string[];
      target: WaitlistTarget;
    },
  ): Promise<WaitlistEntryRow> {
    const [entry] = await tx
      .insert(waitlistEntries)
      .values(
        args.target.kind === 'day-program'
          ? {
              ownerId: args.ownerId,
              leadDogId: args.leadDogId,
              category: args.target.category,
              sessionDate: args.target.sessionDate,
              location: args.target.location,
              mode: args.target.mode,
            }
          : {
              ownerId: args.ownerId,
              leadDogId: args.leadDogId,
              category: 'group-class' as const,
              cohortId: args.target.cohortId,
            },
      )
      .returning(ENTRY_PROJECTION);
    if (entry === undefined) throw new Error('waitlistRepository.join: insert returned no row');

    await tx.insert(waitlistEntryDogs).values(
      args.dogIds.map((dogId) => ({
        waitlistEntryId: entry.id,
        dogId,
        isLead: dogId === args.leadDogId,
      })),
    );

    const [withDogIds] = await withDogs(tx, [entry]);
    if (withDogIds === undefined) throw new Error('waitlistRepository.join: dog attach failed');
    return withDogIds;
  },

  /**
   * 1-based place in line among the LIVE entries for the same target. An
   * offered entry still holds its spot, so it counts — otherwise everyone
   * behind would see their position improve, then worsen again if the offer
   * lapsed.
   *
   * Ranked by `QUEUE_ORDER`, so the number an owner is shown (R3, "the owner
   * sees their position") is the order promotion will actually walk — a
   * gate-blocked entry that still displayed its old place would be telling its
   * owner they're next when they are not.
   */
  async positionOf(runner: Runner, entryId: string): Promise<number | undefined> {
    const [row] = await runner
      .execute(
        sql`
      SELECT position FROM (
        SELECT w.id,
               row_number() OVER (
                 PARTITION BY w.session_date, w.location, w.mode, w.cohort_id
                 ORDER BY (w.gate_blocked_at IS NOT NULL) ASC, w.created_at ASC, w.id ASC
               ) AS position
        FROM ${waitlistEntries} w
        WHERE w.status IN ('waiting','offered')
      ) ranked
      WHERE ranked.id = ${entryId}
    `,
      )
      .then((r) => r.rows as { position: string | number }[]);
    return row === undefined ? undefined : Number(row.position);
  },

  /** An owner's live entries (waiting or holding an offer), in `QUEUE_ORDER`. */
  async findLiveForOwner(runner: Runner, ownerId: string): Promise<WaitlistEntryRow[]> {
    const rows = await runner
      .select(ENTRY_PROJECTION)
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.ownerId, ownerId),
          inArray(waitlistEntries.status, [...LIVE_WAITLIST_STATUSES]),
        ),
      )
      .orderBy(...QUEUE_ORDER);
    return withDogs(runner, rows as Omit<WaitlistEntryRow, 'dogIds'>[]);
  },

  /**
   * The whole waiting queue for one target, in `QUEUE_ORDER`. The promotion
   * scan walks this rather than taking only the head: the head may need more
   * seats than just freed (a two-dog entry can't take one seat), and skipping
   * it to offer a one-dog entry behind is the right call — the alternative is a
   * seat sitting empty while everyone waits on an entry that doesn't fit.
   */
  async findWaitingQueue(tx: Tx, target: WaitlistTarget): Promise<WaitlistEntryRow[]> {
    const rows = await tx
      .select(ENTRY_PROJECTION)
      .from(waitlistEntries)
      .where(and(eq(waitlistEntries.status, 'waiting'), targetWhere(target)))
      .orderBy(...QUEUE_ORDER);
    return withDogs(tx, rows as Omit<WaitlistEntryRow, 'dogIds'>[]);
  },

  async findByIdForOwner(
    runner: Runner,
    args: { id: string; ownerId: string },
  ): Promise<WaitlistEntryRow | undefined> {
    const rows = await runner
      .select(ENTRY_PROJECTION)
      .from(waitlistEntries)
      .where(and(eq(waitlistEntries.id, args.id), eq(waitlistEntries.ownerId, args.ownerId)))
      .limit(1);
    const [withDogIds] = await withDogs(runner, rows as Omit<WaitlistEntryRow, 'dogIds'>[]);
    return withDogIds;
  },

  /**
   * Move a waiting entry to 'offered'. Conditional on it still being
   * 'waiting' so two concurrent promotion passes can't both offer the same
   * seat — the loser gets 0 rows and moves on. `offeredByStaffId` records a
   * cap override (staff let someone in without a seat freeing).
   */
  async markOffered(
    tx: Tx,
    args: { id: string; offeredAt: Date; offerExpiresAt: Date; offeredByStaffId?: string },
  ): Promise<boolean> {
    const updated = await tx
      .update(waitlistEntries)
      .set({
        status: 'offered',
        offeredAt: args.offeredAt.toISOString(),
        offerExpiresAt: args.offerExpiresAt.toISOString(),
        ...(args.offeredByStaffId !== undefined ? { offeredByStaffId: args.offeredByStaffId } : {}),
      })
      .where(and(eq(waitlistEntries.id, args.id), eq(waitlistEntries.status, 'waiting')))
      .returning({ id: waitlistEntries.id });
    return updated.length === 1;
  },

  /**
   * Flag an entry that failed a booking gate when a seat reached it (R6). It
   * keeps its 'waiting' status — nothing was offered and nothing was resolved —
   * but sorts to the back of the queue (`QUEUE_ORDER`) and carries the failing
   * gate's code for the staff screen.
   *
   * `gate_blocked_at` is COALESCEd rather than restamped, so it answers
   * "blocked SINCE when", which is what makes a staff queue actionable ("this
   * family has been stuck on rabies for three weeks"). The reason is always
   * refreshed — an owner who fixes their vaccines and then lets a card expire
   * has a new problem, and stale copy would send staff after the wrong thing.
   */
  async markGateBlocked(
    tx: Tx,
    args: { id: string; blockedAt: Date; reason: string },
  ): Promise<void> {
    await tx
      .update(waitlistEntries)
      .set({
        gateBlockedAt: sql<string>`coalesce(${waitlistEntries.gateBlockedAt}, ${args.blockedAt.toISOString()}::timestamptz)`,
        gateBlockedReason: args.reason,
      })
      .where(eq(waitlistEntries.id, args.id));
  },

  /**
   * The gate that blocked this entry passes again — restore it to its original
   * place in line. Both columns clear together because the DDL's CHECK pairs
   * them, and a reason without a timestamp would be a lie about live state.
   */
  async clearGateBlock(tx: Tx, id: string): Promise<void> {
    await tx
      .update(waitlistEntries)
      .set({ gateBlockedAt: null, gateBlockedReason: null })
      .where(eq(waitlistEntries.id, id));
  },

  /**
   * Resolve an offered entry (accept / decline / expire) or cancel a waiting
   * one. Conditional on the expected current status so a decline racing an
   * expiry sweep can't double-resolve; the loser gets `false`.
   */
  async resolve(
    tx: Tx,
    args: {
      id: string;
      from: WaitlistStatus;
      to: Extract<WaitlistStatus, 'accepted' | 'declined' | 'expired' | 'cancelled'>;
      resolvedAt: Date;
      bookingId?: string;
    },
  ): Promise<boolean> {
    const updated = await tx
      .update(waitlistEntries)
      .set({
        status: args.to,
        resolvedAt: args.resolvedAt.toISOString(),
        ...(args.bookingId !== undefined ? { bookingId: args.bookingId } : {}),
      })
      .where(and(eq(waitlistEntries.id, args.id), eq(waitlistEntries.status, args.from)))
      .returning({ id: waitlistEntries.id });
    return updated.length === 1;
  },

  /**
   * Are ANY of these dogs already holding a live place in this queue?
   *
   * The partial unique indexes in `schema.sql` only cover `lead_dog_id`, which
   * a multi-dog entry can slip past: Waffles could be lead on one entry and a
   * passenger on another for the same target, and the index would allow it even
   * though it means one dog holding two places. Expressing that constraint in
   * the DB would need the target denormalized onto `waitlist_entry_dogs`; until
   * there's a reason to pay for that, this check is the guard and the indexes
   * are the backstop for the common (lead) case.
   */
  async findDogsAlreadyQueued(
    tx: Tx,
    args: { dogIds: readonly string[]; target: WaitlistTarget },
  ): Promise<string[]> {
    if (args.dogIds.length === 0) return [];
    const rows = await tx
      .select({ dogId: waitlistEntryDogs.dogId })
      .from(waitlistEntryDogs)
      .innerJoin(waitlistEntries, eq(waitlistEntries.id, waitlistEntryDogs.waitlistEntryId))
      .where(
        and(
          inArray(waitlistEntryDogs.dogId, [...args.dogIds]),
          inArray(waitlistEntries.status, [...LIVE_WAITLIST_STATUSES]),
          targetWhere(args.target),
        ),
      );
    return [...new Set(rows.map((r) => r.dogId))];
  },

  /**
   * Seats currently HELD by outstanding offers on this target. An 'offered'
   * entry has been promised its dogs' seats and hasn't answered yet, so those
   * seats are spoken for even though no booking exists: promotion subtracts
   * this from the raw free-seat count. Skip it and a queue with one free seat
   * and two waiting entries offers that seat twice — both owners are told yes,
   * one of them is lied to at accept.
   *
   * Staff-owned dogs are excluded for the same reason `capacityForDay` excludes
   * them from `used` (`dogs.staff_owner_id IS NULL`; uniform capacity exemption
   * locked 2026-05-19). Promotion computes `openings − used − held`, and
   * counting a dog population on one side that the other side never counted
   * would make that subtraction meaningless — a staff dog on a queue would burn
   * a seat that was never occupied. Same population and same status predicate
   * as `dayCapacityRepository`'s `countHeldSeats`, so the booking path and
   * promotion can't disagree about which seats are spoken for.
   */
  async countOfferedSeats(tx: Tx, target: WaitlistTarget): Promise<number> {
    const [row] = await tx
      .select({ seats: sql<number>`count(*)::int`.as('seats') })
      .from(waitlistEntryDogs)
      .innerJoin(waitlistEntries, eq(waitlistEntries.id, waitlistEntryDogs.waitlistEntryId))
      .innerJoin(dogs, eq(dogs.id, waitlistEntryDogs.dogId))
      .where(
        and(
          eq(waitlistEntries.status, 'offered'),
          targetWhere(target),
          sql`${dogs.staffOwnerId} IS NULL`,
        ),
      );
    return row?.seats ?? 0;
  },

  /**
   * Serialize one queue's promotion pass for the rest of the transaction.
   *
   * Promotion is read-then-act (count free seats → count outstanding offers →
   * offer), and `runSchedulerTickOnce` is documented as safe to run
   * concurrently. Without this, two ticks both read "one seat free, no
   * outstanding offers" and each offers it to a different entry — the
   * double-promise `countOfferedSeats` exists to prevent, reintroduced by the
   * race. `markOffered`'s status guard doesn't help: the two ticks pick
   * DIFFERENT entries, so both UPDATEs succeed.
   *
   * Transaction-scoped advisory lock, released on commit or rollback. The
   * `waitlist:` key namespace is disjoint from the booking locks in
   * `db/locks.ts` (`capacity:`, `<dogId>:<mode>:<location>`) and promotion
   * takes none of those, so no cross-namespace deadlock cycle exists. A caller
   * locking several queues in one transaction must acquire them in sorted
   * `waitlistTargetKey` order so concurrent callers agree on the order.
   */
  async lockQueue(tx: Tx, target: WaitlistTarget): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`waitlist:${waitlistTargetKey(target)}`}))`,
    );
  },

  /**
   * Live entries whose session has already begun — Allison 2026-07-30 ruling 4,
   * "the entry dies when the session starts". Both live statuses are in scope:
   * an unanswered OFFER for a session that has started is as dead as a waiting
   * entry, and leaving it 'offered' would keep holding seats nobody can use.
   *
   * The two target shapes carry their start differently. A cohort has a real
   * start instant on the row, so it compares directly. A day-program row has
   * only a date, so the comparison reconstructs the drop-off opening in Chicago
   * — `date + time AT TIME ZONE` is DST-correct because Postgres resolves the
   * offset for that specific local timestamp, the same way `chicagoWallTimeToUtc`
   * does on the API side.
   */
  async findLiveWithStartedSession(tx: Tx, now: Date): Promise<WaitlistEntryRow[]> {
    const nowIso = now.toISOString();
    const rows = await tx
      .select(ENTRY_PROJECTION)
      .from(waitlistEntries)
      .leftJoin(cohorts, eq(cohorts.id, waitlistEntries.cohortId))
      .where(
        and(
          inArray(waitlistEntries.status, [...LIVE_WAITLIST_STATUSES]),
          or(
            sql`(${waitlistEntries.sessionDate} + ${DROPOFF_OPEN_WALL_CLOCK}::time) AT TIME ZONE 'America/Chicago' <= ${nowIso}::timestamptz`,
            sql`${cohorts.startDate} <= ${nowIso}::timestamptz`,
          ),
        ),
      )
      .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id));
    return withDogs(tx, rows as Omit<WaitlistEntryRow, 'dogIds'>[]);
  },

  /** Offers whose deadline has passed — the sweep rolls these to the next in line. */
  async findLapsedOffers(tx: Tx, now: Date): Promise<WaitlistEntryRow[]> {
    const rows = await tx
      .select(ENTRY_PROJECTION)
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.status, 'offered'),
          sql`${waitlistEntries.offerExpiresAt} <= ${now.toISOString()}`,
        ),
      )
      .orderBy(asc(waitlistEntries.offerExpiresAt));
    return withDogs(tx, rows as Omit<WaitlistEntryRow, 'dogIds'>[]);
  },
};
