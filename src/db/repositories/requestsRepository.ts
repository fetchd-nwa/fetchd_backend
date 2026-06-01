import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../client.js';
import {
  pendingRequestDogs,
  pendingRequestPreferredDates,
  pendingRequests,
} from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';
import type {
  ComfortLevel,
  PendingRequestDogRow,
  PendingRequestRowForWire,
  RequestStatus,
} from '../../lib/requestWire.js';
import type { ServiceCategory } from '../../lib/bookingBucket.js';

/**
 * Data-access seam for `pending_requests` + the two child tables
 * (`pending_request_dogs`, `pending_request_preferred_dates`). Mirrors
 * `bookingsRepository`'s shape — the route layer parses query/params,
 * calls into here, then passes the rows to the wire helper
 * (`lib/requestWire.ts`) for response shaping.
 *
 * Day 6a shipped the read methods (`findLiveByOwner`,
 * `findByIdForOwner`, child-row resolvers). Day 12 extends with the
 * mutation primitives composing inside `withMutation`:
 *
 *   - `findFullByIdInTx` — full row read with `ownerId` /
 *     `approvedByStaffId` (the wire helper doesn't need these, the
 *     route's owner-scope assertion and state-machine guard do).
 *   - `lockById(tx, id)` — `SELECT ... FOR UPDATE` on the request row.
 *     Concurrent approve attempts on the same request serialize here.
 *   - `create(tx, values)` — INSERT a new pending_requests row at
 *     status='submitted'.
 *   - `addDogs(tx, requestId, { lead, additional })` — INSERT the
 *     pending_request_dogs join rows.
 *   - `addPreferredDates(tx, requestId, dates)` — INSERT the
 *     pending_request_preferred_dates rows in ordinal order.
 *   - `update(tx, id, set)` — partial UPDATE of editable scalar
 *     columns (notes/focus/length_weeks).
 *   - `replacePreferredDates(tx, requestId, dates)` — soft-expire the
 *     existing preferred-date rows and re-INSERT in the new order.
 *   - `markConverted(tx, id, ...)`, `markApprovedAwaitingPayment`,
 *     `markCancelled` — state-machine transitions. `approvedByStaffId`
 *     is set even on `cancelled` when the actor was staff (deny verb);
 *     NULL when an owner cancelled their own request.
 */

export type PendingRequestRow = PendingRequestRowForWire;

/**
 * Full row projection — includes `ownerId` and `approvedByStaffId` not
 * exposed on the wire. The route uses `ownerId` for cross-owner
 * defense (404 same response as not-found) and `approvedByStaffId` to
 * distinguish owner-cancel from staff-deny on the same `cancelled`
 * status.
 */
export interface PendingRequestFullRow extends PendingRequestRow {
  ownerId: string;
  leadDogId: string;
  approvedByStaffId: string | null;
  expiredAt: string | null;
}

const PENDING_REQUEST_PROJECTION = {
  id: pendingRequests.id,
  category: pendingRequests.category,
  status: pendingRequests.status,
  submittedAt: pendingRequests.submittedAt,
  notesPerDog: pendingRequests.notesPerDog,
  notesJoint: pendingRequests.notesJoint,
  staffPreference: pendingRequests.staffPreference,
  comfortLevel: pendingRequests.comfortLevel,
  lengthWeeks: pendingRequests.lengthWeeks,
  approvedAt: pendingRequests.approvedAt,
  convertedBookingId: pendingRequests.convertedBookingId,
} as const;

const PENDING_REQUEST_FULL_PROJECTION = {
  ...PENDING_REQUEST_PROJECTION,
  ownerId: pendingRequests.ownerId,
  leadDogId: pendingRequests.leadDogId,
  approvedByStaffId: pendingRequests.approvedByStaffId,
  expiredAt: pendingRequests.expiredAt,
} as const;

// A request is "open" (still in flight) in these states — the Day-19d
// duplicate guard counts only these. `converted` + `cancelled` are resolved,
// so a dog can submit a fresh same-category request once a prior one closes.
const OPEN_REQUEST_STATUSES = ['submitted', 'approved', 'approved-awaiting-payment'] as const;

export const requestsRepository = {
  /**
   * Every live pending request for one owner, newest-submitted first.
   * Optionally filtered by `status` — the route validates the enum
   * before passing it in.
   */
  async findLiveByOwner(
    ownerId: string,
    statusFilter?: RequestStatus,
  ): Promise<PendingRequestRow[]> {
    const conditions =
      statusFilter !== undefined
        ? and(
            eq(pendingRequests.ownerId, ownerId),
            eq(pendingRequests.status, statusFilter),
            live(pendingRequests),
          )
        : and(eq(pendingRequests.ownerId, ownerId), live(pendingRequests));
    return db.select(PENDING_REQUEST_PROJECTION).from(pendingRequests).where(conditions);
  },

  /**
   * Every live pending request across ALL owners, optionally filtered by
   * `status` — the Day-19 staff-portal queue read. Cross-owner by design
   * (`requireStaff` gates the route); the owner-scoped sibling is
   * `findLiveByOwner`. The route sorts by submitted_at.
   */
  async findLive(statusFilter?: RequestStatus): Promise<PendingRequestRow[]> {
    const conditions =
      statusFilter !== undefined
        ? and(eq(pendingRequests.status, statusFilter), live(pendingRequests))
        : live(pendingRequests);
    return db.select(PENDING_REQUEST_PROJECTION).from(pendingRequests).where(conditions);
  },

  /**
   * Single request by id, owner-scoped. Same response for not-found vs
   * not-yours so attackers can't enumerate request ids.
   */
  async findByIdForOwner(id: string, ownerId: string): Promise<PendingRequestRow | undefined> {
    const rows = await db
      .select(PENDING_REQUEST_PROJECTION)
      .from(pendingRequests)
      .where(
        and(
          eq(pendingRequests.id, id),
          eq(pendingRequests.ownerId, ownerId),
          live(pendingRequests),
        ),
      )
      .limit(1);
    return rows[0];
  },

  /**
   * Resolve dog membership for a batch of request ids — lead +
   * additional per request. Caller groups via
   * `lib/requestWire.groupRequestDogs` for snapshot-stable ordering.
   *
   * Polymorphic runner: defaults to the pool `db`; pass a Tx to read
   * back rows written earlier in the same transaction (Day-12 mutation
   * routes need this — uncommitted INSERTs aren't visible to a fresh
   * pool connection at READ COMMITTED isolation).
   */
  async findDogsByRequestIds(
    requestIds: string[],
    runner: Tx | typeof db = db,
  ): Promise<PendingRequestDogRow[]> {
    if (requestIds.length === 0) return [];
    return runner
      .select({
        requestId: pendingRequestDogs.requestId,
        dogId: pendingRequestDogs.dogId,
        isLead: pendingRequestDogs.isLead,
      })
      .from(pendingRequestDogs)
      .where(and(inArray(pendingRequestDogs.requestId, requestIds), live(pendingRequestDogs)));
  },

  /**
   * Resolve preferred-date arrays for a batch of request ids, ordered by
   * ordinal ASC. Returns one row per (request_id, ordinal) — the caller
   * groups + ISO-encodes upstream of the wire helper.
   *
   * Polymorphic runner — see `findDogsByRequestIds`.
   */
  async findPreferredDatesByRequestIds(
    requestIds: string[],
    runner: Tx | typeof db = db,
  ): Promise<{ requestId: string; ordinal: number; preferredAt: string }[]> {
    if (requestIds.length === 0) return [];
    return runner
      .select({
        requestId: pendingRequestPreferredDates.requestId,
        ordinal: pendingRequestPreferredDates.ordinal,
        preferredAt: pendingRequestPreferredDates.preferredAt,
      })
      .from(pendingRequestPreferredDates)
      .where(
        and(
          inArray(pendingRequestPreferredDates.requestId, requestIds),
          live(pendingRequestPreferredDates),
        ),
      )
      .orderBy(asc(pendingRequestPreferredDates.ordinal));
  },

  // -------------------------------------------------------------------
  // Day 12 — write path. Tx-only methods compose inside `withMutation`.
  // The route's request hash + idempotency check happen one level up
  // (`db/mutation.ts`); this layer trusts its inputs (the route is the
  // validation boundary) and returns the affected rows.
  // -------------------------------------------------------------------

  /**
   * Read the full row by id, in-transaction. Includes the columns the
   * route needs for cross-owner defense (`ownerId`) and state-machine
   * guards (`approvedByStaffId`, `expiredAt`). Owner scope is enforced
   * by the route's `ownerId` check on the returned row, not in SQL —
   * mirrors `dogsRepository.findById`'s polymorphic-runner shape.
   */
  async findFullByIdInTx(tx: Tx, id: string): Promise<PendingRequestFullRow | undefined> {
    const rows = await tx
      .select(PENDING_REQUEST_FULL_PROJECTION)
      .from(pendingRequests)
      .where(and(eq(pendingRequests.id, id), live(pendingRequests)))
      .limit(1);
    return rows[0];
  },

  /**
   * Row-lock a pending request for the duration of the transaction.
   * Concurrent approve attempts on the same request serialize here.
   * Returns the locked row (full projection) so the caller can read
   * status / approvedByStaffId / expiredAt without a second read.
   * `undefined` if the id doesn't exist.
   *
   * Soft-expire is NOT filtered here — the lock acquires on
   * existence-by-id; the caller decides the semantic for a row whose
   * `expiredAt` is set (Day-11's `lockCohort` follows the same
   * convention).
   */
  async lockById(tx: Tx, id: string): Promise<PendingRequestFullRow | undefined> {
    const [row] = await tx
      .select(PENDING_REQUEST_FULL_PROJECTION)
      .from(pendingRequests)
      .where(eq(pendingRequests.id, id))
      .for('update');
    return row;
  },

  /**
   * INSERT a new pending_requests row at status='submitted'. Returns
   * the new id (the caller assembles the wire shape by re-reading
   * via `findFullByIdInTx` once the child rows are inserted).
   *
   * `category`, `leadDogId`, `ownerId` are required. Optional scalars
   * (notes/focus/length_weeks) come through with null when absent —
   * the route normalizes empty strings to null upstream.
   */
  /**
   * Day-19d duplicate guard. Of the given dogs, which already appear on a
   * LIVE, still-OPEN request of this category — `status` ∈ submitted /
   * approved / approved-awaiting-payment. `converted` + `cancelled` don't
   * count, so a dog can re-request once a prior request resolves. Matched on
   * the `pending_request_dogs` roster (lead or additional). Run inside the
   * submit txn.
   */
  async findOpenByDogsAndCategory(
    tx: Tx,
    dogIds: string[],
    category: ServiceCategory,
  ): Promise<string[]> {
    if (dogIds.length === 0) return [];
    const rows = await tx
      .selectDistinct({ dogId: pendingRequestDogs.dogId })
      .from(pendingRequests)
      .innerJoin(pendingRequestDogs, eq(pendingRequestDogs.requestId, pendingRequests.id))
      .where(
        and(
          inArray(pendingRequestDogs.dogId, dogIds),
          live(pendingRequestDogs),
          eq(pendingRequests.category, category),
          inArray(pendingRequests.status, [...OPEN_REQUEST_STATUSES]),
          live(pendingRequests),
        ),
      );
    return rows.map((r) => r.dogId);
  },

  async create(
    tx: Tx,
    values: {
      ownerId: string;
      leadDogId: string;
      category: ServiceCategory;
      notesPerDog: string | null;
      notesJoint: string | null;
      staffPreference: string | null;
      comfortLevel: ComfortLevel | null;
      lengthWeeks: number | null;
    },
  ): Promise<{ id: string }> {
    const [row] = await tx
      .insert(pendingRequests)
      .values({
        ownerId: values.ownerId,
        leadDogId: values.leadDogId,
        category: values.category,
        notesPerDog: values.notesPerDog,
        notesJoint: values.notesJoint,
        staffPreference: values.staffPreference,
        comfortLevel: values.comfortLevel,
        lengthWeeks: values.lengthWeeks,
        // status defaults to 'submitted' (schema); submittedAt /
        // createdAt / updatedAt default to now(); source defaults to
        // 'app'; expiredAt remains NULL (live).
      })
      .returning({ id: pendingRequests.id });
    if (!row) {
      throw new Error('requestsRepository.create: pending_requests INSERT returned no row');
    }
    return row;
  },

  /**
   * INSERT the pending_request_dogs join rows for one request: one
   * `is_lead=true` row + N `is_lead=false` rows. The route is
   * responsible for ensuring `lead` is distinct from every `additional`
   * — this method trusts its inputs.
   */
  async addDogs(
    tx: Tx,
    requestId: string,
    dogs: { lead: string; additional: readonly string[] },
  ): Promise<void> {
    const rows = [
      { requestId, dogId: dogs.lead, isLead: true },
      ...dogs.additional.map((dogId) => ({ requestId, dogId, isLead: false })),
    ];
    await tx.insert(pendingRequestDogs).values(rows);
  },

  /**
   * INSERT the pending_request_preferred_dates rows in ordinal order.
   * Caller passes ISO datetimes in the order the owner ranked them
   * (slot 1 first). The ordinal is the 1-based index.
   */
  async addPreferredDates(tx: Tx, requestId: string, dates: readonly string[]): Promise<void> {
    if (dates.length === 0) return;
    const rows = dates.map((preferredAt, idx) => ({
      requestId,
      ordinal: idx + 1,
      preferredAt,
    }));
    await tx.insert(pendingRequestPreferredDates).values(rows);
  },

  /**
   * Partial UPDATE of editable scalar columns. `live()` filter so
   * an expired row stays expired (mirrors `dogsRepository.update`).
   * Caller ensures the row's status allows edits (only 'submitted'
   * is editable per the state-machine).
   *
   * Values explicitly typed `null | undefined` per field: `undefined`
   * = leave unchanged; `null` = set to null. Mirrors the Day-9c PATCH
   * convention so the route can pass `body.X ?? undefined` for skips.
   */
  async update(
    tx: Tx,
    id: string,
    set: {
      notesPerDog?: string | null;
      notesJoint?: string | null;
      staffPreference?: string | null;
      comfortLevel?: ComfortLevel | null;
      lengthWeeks?: number | null;
    },
  ): Promise<void> {
    // Drop undefined keys so they don't appear in the SET clause as
    // null overrides. Required because Drizzle's `.set({k: undefined})`
    // emits `k = NULL` in some adapter versions.
    const cleaned = Object.fromEntries(
      Object.entries(set).filter(([, v]) => v !== undefined),
    ) as Partial<typeof set>;
    if (Object.keys(cleaned).length === 0) return;
    await tx
      .update(pendingRequests)
      .set(cleaned)
      .where(and(eq(pendingRequests.id, id), live(pendingRequests)));
  },

  /**
   * Replace the preferred-date set for a request. The schema's
   * `(request_id, ordinal)` PK is NOT partial-on-expired (unlike the
   * other natural-key uniques fixed in the §A 2026-05-19 hardening
   * bake), so a naive soft-expire-then-INSERT at the same ordinal
   * would PK-collide.
   *
   * Strategy: UPSERT each new date at its ordinal — UPDATE in place
   * if the row exists, INSERT if it doesn't — then soft-expire any
   * leftover live rows whose ordinal exceeds the new length.
   * `audit_capture` (AFTER UPDATE) records the prior `preferred_at`
   * value, so the audit trail still holds the old dates for recovery.
   *
   * The route guards "edits only when status='submitted'"; this
   * method itself trusts that.
   */
  async replacePreferredDates(tx: Tx, requestId: string, dates: readonly string[]): Promise<void> {
    // UPSERT each new date at ordinal i+1. `expiredAt: null` covers
    // the case of re-linking a row that was previously soft-expired
    // for being beyond the prior length.
    for (let i = 0; i < dates.length; i++) {
      await tx
        .insert(pendingRequestPreferredDates)
        .values({
          requestId,
          ordinal: i + 1,
          preferredAt: dates[i]!,
        })
        .onConflictDoUpdate({
          target: [pendingRequestPreferredDates.requestId, pendingRequestPreferredDates.ordinal],
          set: { preferredAt: dates[i]!, expiredAt: null },
        });
    }
    // Soft-expire any leftover live rows whose ordinal is past the
    // new length (the request used to have more preferred-dates than
    // it does now).
    await tx
      .update(pendingRequestPreferredDates)
      .set({ expiredAt: sql`now()` })
      .where(
        and(
          eq(pendingRequestPreferredDates.requestId, requestId),
          gt(pendingRequestPreferredDates.ordinal, dates.length),
          live(pendingRequestPreferredDates),
        ),
      );
  },

  /**
   * State-machine transition for non-B&T approval: 'submitted' →
   * 'converted'. Stamps `approvedAt = now()`, `approvedByStaffId`, and
   * `convertedBookingId` (the route created the booking row earlier in
   * the txn and threads its id in here).
   */
  async markConverted(
    tx: Tx,
    id: string,
    args: { approvedByStaffId: string; convertedBookingId: string },
  ): Promise<void> {
    await tx
      .update(pendingRequests)
      .set({
        status: 'converted',
        approvedAt: sql`now()`,
        approvedByStaffId: args.approvedByStaffId,
        convertedBookingId: args.convertedBookingId,
      })
      .where(eq(pendingRequests.id, id));
  },

  /**
   * State-machine transition for B&T approval: 'submitted' →
   * 'approved-awaiting-payment'. NO booking is created at this step;
   * the Day-14 confirm-payment verb completes the conversion by
   * INSERTing the booking and flipping the state to 'converted'.
   */
  async markApprovedAwaitingPayment(
    tx: Tx,
    id: string,
    args: { approvedByStaffId: string },
  ): Promise<void> {
    await tx
      .update(pendingRequests)
      .set({
        status: 'approved-awaiting-payment',
        approvedAt: sql`now()`,
        approvedByStaffId: args.approvedByStaffId,
      })
      .where(eq(pendingRequests.id, id));
  },

  /**
   * State-machine transition: → 'cancelled'. Covers BOTH owner self-
   * cancel (approvedByStaffId omitted) and staff deny (approvedByStaffId
   * set). The schema's `request_status` enum has no 'denied' state, so
   * the API distinguishes the two actors by `approvedByStaffId`'s
   * presence — owner self-cancel leaves it NULL, staff deny stamps it.
   * Surface in HANDOFF as a known semantic gap pending a future §A
   * amendment that adds 'denied' to the enum.
   */
  async markCancelled(
    tx: Tx,
    id: string,
    args: { approvedByStaffId?: string } = {},
  ): Promise<void> {
    const updates: Record<string, unknown> = { status: 'cancelled' as const };
    if (args.approvedByStaffId !== undefined) {
      updates['approvedAt'] = sql`now()`;
      updates['approvedByStaffId'] = args.approvedByStaffId;
    }
    await tx.update(pendingRequests).set(updates).where(eq(pendingRequests.id, id));
  },
};
