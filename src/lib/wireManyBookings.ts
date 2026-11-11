import { db } from '../db/client.js';
import { bookingsRepository, type BookingRow } from '../db/repositories/bookingsRepository.js';
import { checkinEventsRepository } from '../db/repositories/checkinEventsRepository.js';
import { cohortsRepository } from '../db/repositories/cohortsRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { staffRepository } from '../db/repositories/staffRepository.js';
import type { Tx } from '../db/tx.js';
import type { PickupCloseByCampus } from './bookingBucket.js';
import {
  groupBookingDogs,
  toBookingWire,
  type BookingWire,
  type CancelFacts,
} from './bookingWire.js';
import { cancelFacts, dayHasEnded, isDayProgram, statesByDog } from './dayCancel.js';
import { pgTimestampToDate } from './pgTimestamp.js';

/**
 * Who is reading, and when. `viewer` decides `dog_shares[].can_cancel`'s switch (an owner's
 * read folds in `cxl.per_dog_cancel_enabled`, a staff read ignores it, D14); `now` is the
 * route's clock, the one its cancels refuse on. `runner` is the caller's transaction when
 * the rows were written in it (a cancel's answer), so the read sees its own writes.
 */
export interface WireReadContext {
  now: Date;
  viewer: 'owner' | 'staff';
  runner?: Tx | typeof db;
}

/**
 * Batched denormalization of N booking rows into `BookingWire` shapes.
 * A fixed number of lookups (booking_dogs, trainer names, class names, and for day
 * rows the check-in log and the day's settings) regardless of row count. Takes
 * already-sorted, already-bucketed rows; returns the JSON the FE consumes.
 *
 * Extracted at the rule-of-three: the owner bookings reads
 * (`routes/bookings.ts`), the Day-19 staff queue (`GET /staff/bookings`),
 * and the shared cancel service (`lib/cancelBookingService.ts`) all need
 * the same batched resolve. Mirrors `wireManyRequests` — a wire helper
 * that deliberately couples to repo calls because every call site needs
 * the live join-row resolve.
 *
 * Every share is read, the ones cancelled alone included (`dog_shares`, D3), and a
 * day-school or day-care row carries `can_cancel` and `dog_shares` from the same fold and
 * clock the cancels refuse on (`lib/dayCancel.ts`).
 *
 * Throws if a booking has no live `booking_dogs` row — a schema-level
 * invariant violation, so a loud throw beats emitting a malformed wire.
 */
export async function wireManyBookings(
  rows: BookingRow[],
  context: WireReadContext,
): Promise<BookingWire[]> {
  if (rows.length === 0) return [];
  const runner = context.runner ?? db;
  const ids = rows.map((r) => r.id);
  // Cohort ids on group-class bookings → resolve the class name so the FE can
  // title the booking with its class ("Manners 1") instead of "Group Class".
  const cohortIds = rows.map((r) => r.cohortId).filter((id): id is string => id !== null);
  const [shareRows, trainerName, classNamesByCohort] = await Promise.all([
    bookingsRepository.findSharesByBookingIds(runner, ids),
    staffRepository.resolveTrainerNames(rows),
    cohortsRepository.resolveClassNamesByIds(cohortIds),
  ]);
  const dogsByBooking = groupBookingDogs(shareRows);
  const factsByBooking = await dayCancelFacts(
    rows.filter((row) => isDayProgram(row.category)),
    dogsByBooking,
    context,
    runner,
  );
  return rows.map((row) => {
    const dogIds = dogsByBooking.get(row.id);
    if (dogIds === undefined) {
      throw new Error(`booking ${row.id}: no booking_dogs rows found`);
    }
    const groupClassName = row.cohortId !== null ? classNamesByCohort.get(row.cohortId) : undefined;
    return toBookingWire(
      row,
      dogIds,
      trainerName(row.trainerStaffId),
      groupClassName,
      factsByBooking.get(row.id),
    );
  });
}

/** `can_cancel` and each share's, for the day rows, from one read of the log and the day. */
async function dayCancelFacts(
  dayRows: BookingRow[],
  dogsByBooking: ReturnType<typeof groupBookingDogs>,
  context: WireReadContext,
  runner: Tx | typeof db,
): Promise<Map<string, CancelFacts>> {
  if (dayRows.length === 0) return new Map();
  const [events, campuses, perDogCancelEnabled] = await Promise.all([
    checkinEventsRepository.findForBookings(
      runner,
      dayRows.map((row) => row.id),
    ),
    settingsRepository.dayCampuses(runner),
    context.viewer === 'owner' ? settingsRepository.perDogCancelEnabled(runner) : true,
  ]);
  const pickupClose: PickupCloseByCampus = new Map(
    campuses.map((campus) => [campus.location, campus.pickup_close_time]),
  );
  const facts = new Map<string, CancelFacts>();
  for (const row of dayRows) {
    const dogIds = dogsByBooking.get(row.id);
    if (dogIds === undefined) continue;
    facts.set(
      row.id,
      cancelFacts({
        status: row.status,
        ended: dayHasEnded(row, pickupClose, context.now),
        liveDogIds: [dogIds.lead, ...dogIds.additional],
        states: statesByDog(events.filter((e) => e.bookingId === row.id)),
        viewer: context.viewer,
        perDogCancelEnabled,
      }),
    );
  }
  return facts;
}

/**
 * Pure sort by scheduled_at. Owner list views use ASC (upcoming, soonest
 * first) / DESC (past, most recent first); the Day-19 staff queue uses
 * ASC. Uses `pgTimestampToDate` (not `new Date`) so PG's default
 * timestamptz format round-trips correctly.
 */
export function sortBookingsByScheduledAt(
  rows: BookingRow[],
  direction: 'asc' | 'desc',
): BookingRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      pgTimestampToDate(a.scheduledAt).getTime() - pgTimestampToDate(b.scheduledAt).getTime(),
  );
  return direction === 'desc' ? sorted.reverse() : sorted;
}
