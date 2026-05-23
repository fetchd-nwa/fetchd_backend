import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../client.js';
import { bookingDogs, bookings } from '../schema/schema.js';
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
  cancelledAt: string | null;
  cancelForfeited: boolean;
  pickupAt: string | null;
  trainerStaffId: string | null;
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
  cancelledAt: bookings.cancelledAt,
  cancelForfeited: bookings.cancelForfeited,
  pickupAt: bookings.pickupAt,
  trainerStaffId: bookings.trainerStaffId,
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
        // status defaults to 'upcoming' (schema), durationMinutes/trainer*/
        // cohort*/report*/confirmed*/dropoff*/pickup*/cancelled*/source all
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
};
