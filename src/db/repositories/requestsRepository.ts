import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../client.js';
import {
  pendingRequestDogs,
  pendingRequestPreferredDates,
  pendingRequests,
} from '../schema/schema.js';
import { live } from '../softExpire.js';
import type {
  PendingRequestDogRow,
  PendingRequestRowForWire,
  RequestStatus,
} from '../../lib/requestWire.js';

/**
 * Data-access seam for `pending_requests` + the two child tables
 * (`pending_request_dogs`, `pending_request_preferred_dates`). Mirrors
 * `bookingsRepository`'s shape so the route is structurally identical to
 * the bookings reads — parse → repo → wire → respond.
 *
 * The repo is read-only (Day 6a is part of the read surface). Mutations —
 * `POST /requests`, `PATCH /requests/:id`, the portal verbs — are Day 12.
 */

export type PendingRequestRow = PendingRequestRowForWire;

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
   */
  async findDogsByRequestIds(requestIds: string[]): Promise<PendingRequestDogRow[]> {
    if (requestIds.length === 0) return [];
    return db
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
   */
  async findPreferredDatesByRequestIds(
    requestIds: string[],
  ): Promise<{ requestId: string; ordinal: number; preferredAt: string }[]> {
    if (requestIds.length === 0) return [];
    return db
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
};
