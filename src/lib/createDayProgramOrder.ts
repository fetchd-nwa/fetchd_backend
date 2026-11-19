import { sql } from 'drizzle-orm';
import { withCapacityLocksAcross, withDogLocks } from '../db/locks.js';
import { bookingsRepository, type BookingRow } from '../db/repositories/bookingsRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { ordersRepository, type OrderRow } from '../db/repositories/ordersRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import {
  BOOKING_MODES,
  CREDIT_TIERS,
  LOCATIONS,
  type DayProgramCampusSettingsWire,
  type DogCreditPlanWire,
  type LocationKey,
  type PoolDrawWire,
} from '../contracts/wire.js';
import { dayProgramConflictsWith } from './bookingConflicts.js';
import {
  afterSchoolFullError,
  alreadyBookedError,
  alumniNoDaySchoolError,
  type AlreadyBookedConflict,
} from './bookingErrors.js';
import { checkBookingGates } from './bookingGatePreCheck.js';
import { assertDatesBookable } from './bookingHorizon.js';
import { computeDayProgramScheduledAt } from './bookingSchedule.js';
import type { BookingWire } from './bookingWire.js';
import { assertBeforeSameDayCutoff, assertProgramOffered } from './createDayProgramBookings.js';
import type { ValidatedBookingOrder } from './dayBookingBody.js';
import { enqueueBookingReminders } from './enqueueBookingReminders.js';
import { ApiError } from './errors.js';
import { insertBookingWithGateMapping } from './insertBookingWithGateMapping.js';
import { planOrderCredits, type OrderPaidSlot } from './orderCreditPlan.js';
import { sortBookingsByScheduledAt, wireManyBookings } from './wireManyBookings.js';

/**
 * The whole-order day-program core (wire 9.1.0, `POST /booking-orders` and its check;
 * designs/credits-joint-booking.md §3.2; the brief's "The credit plan"). One transaction books
 * every part of one Confirm, every dog, campus and date of it, or nothing. The caller owns
 * the parse and the body's own checks (`validateBookingOrderBody`), the idempotency claim
 * (`withMutation`) or the check's rollback, and post-commit cache invalidation.
 *
 * The transaction protocol — DEADLOCK ORDER MATTERS, do not reorder (`db/locks.ts`):
 *   0. (The caller's claim.) The dog ceiling (`day.max_dogs_per_booking_count`, 422), then
 *      ownership of every dog in the order's dog order (404), as `POST /bookings` does.
 *   1. `withDogLocks` once over every dog of the order, ascending.
 *   2. `withCapacityLocksAcross` over every `(campus, date)`, by key string.
 *   3. The settings, read once under the locks: the global row and each campus of the
 *      order. The dog flags, read once: `alumniAmong`, `FOR SHARE`, ascending id.
 *   4. Each part in body order: `program_not_offered`, the past date and
 *      `beyond_booking_horizon`, `same_day_cutoff_passed` (campus before clock, DECISIONS
 *      128(b)); then the gates; then `alumni_no_day_school`.
 *   5. Overlap: each dog against his live sessions (`already_booked`). A dog on one date in
 *      two parts is the body's own bound, so it never reaches here.
 *   6. The capacity pre-pass, every `(campus, date)` with the order's dogs there summed:
 *      `insufficient_capacity`, then `after_school_full` (named by campus). This route has
 *      no `top_up`, so D22's reason for credits first does not apply.
 *   7. The credit plan (`orderCreditPlan.ts`), which takes the pools of both tiers of every
 *      campus and program first.
 *   8. The writes: one order row, then each part's dates ascending, the capacity and
 *      after-school asserts again as the floor, INSERT, each dog's debit from the lot and
 *      tier the plan gave it, the reminders.
 *   9. The `plan`, read from the debits just written. `draws` (9.2.0-pre.1) is the credit
 *      plan's, read in step 7 before any write; the check answers it beside the `plan`.
 * Every refusal is a throw, so the transaction writes nothing: no booking, debit, order,
 * reminder or stored answer.
 */

export interface DayProgramOrderResult {
  order: OrderRow;
  /** Every session, ascending by `scheduled_at`, ties in part order. */
  sessions: BookingWire[];
  plan: DogCreditPlanWire[];
  /** Each pool's draw (`PoolDrawWire`), from the credit plan before any write. Its `draw` is
   *  its pool's `plan` counts summed. The check answers it; the POST's 201 does not. */
  draws: PoolDrawWire[];
}

/** The after-school assert, naming its campus as this route's `after_school_full` does. */
async function assertAfterSchoolAt(
  tx: Tx,
  args: { location: LocationKey; date: string; capacity: number; requestedCount: number },
): Promise<void> {
  try {
    await dayCapacityRepository.assertAfterSchoolWithinLock(tx, args);
  } catch (err) {
    if (err instanceof ApiError && err.details?.kind === 'after_school_full') {
      throw afterSchoolFullError({
        date: err.details.date,
        capacity: err.details.capacity,
        booked: err.details.booked,
        location: args.location,
      });
    }
    throw err;
  }
}

/** The plan the debits of these bookings spell, in the wire's order (mechanic 8). */
async function planFromDebits(
  tx: Tx,
  bookingIds: readonly string[],
  dogOrder: readonly string[],
): Promise<DogCreditPlanWire[]> {
  if (bookingIds.length === 0) return [];
  const result = await tx.execute(sql`
    SELECT dog_id::text AS dog_id, location, mode::text AS mode, tier, count(*)::int AS count
      FROM credit_ledger
     WHERE booking_id IN (SELECT unnest(string_to_array(${bookingIds.join(',')}, ',')::uuid[]))
       AND reason = 'booking-debit'
     GROUP BY dog_id, location, mode, tier`);
  const rows = result.rows as unknown as DogCreditPlanWire[];
  const index = <T>(list: readonly T[], value: T): number => list.indexOf(value);
  return [...rows].sort(
    (a, b) =>
      index(dogOrder, a.dog_id) - index(dogOrder, b.dog_id) ||
      index(LOCATIONS, a.location) - index(LOCATIONS, b.location) ||
      index(BOOKING_MODES, a.mode) - index(BOOKING_MODES, b.mode) ||
      index(CREDIT_TIERS, a.tier) - index(CREDIT_TIERS, b.tier),
  );
}

export async function createDayProgramOrder(
  tx: Tx,
  args: { ownerId: string; order: ValidatedBookingOrder; now: Date },
): Promise<DayProgramOrderResult> {
  const { parts, dogOrder, consent } = args.order;

  // 0. The ceiling, then ownership (the protocol above).
  const { max_dogs_per_booking_count: maxDogs } = await settingsRepository.dayGlobal(tx);
  if (dogOrder.length > maxDogs) {
    throw new ApiError(
      'invalid_payload',
      `at most ${maxDogs} dogs per order (got ${dogOrder.length})`,
    );
  }
  for (const dogId of dogOrder) {
    if (!(await dogsRepository.findOwnedExists(dogId, args.ownerId, tx))) {
      throw new ApiError('not_found', `dog ${dogId} not found`);
    }
  }

  const cells = parts.flatMap((part) =>
    part.sortedDates.map((date) => ({ location: part.location, date })),
  );

  return withDogLocks(tx, dogOrder, () =>
    withCapacityLocksAcross(tx, cells, async () => {
      // 3. Once, under the locks.
      const global = await settingsRepository.dayGlobal(tx);
      const campuses = new Map<LocationKey, DayProgramCampusSettingsWire>();
      for (const location of LOCATIONS) {
        if (parts.some((part) => part.location === location)) {
          campuses.set(location, await settingsRepository.dayCampus(location, tx));
        }
      }
      const campusOf = (location: LocationKey): DayProgramCampusSettingsWire => {
        const campus = campuses.get(location);
        if (campus === undefined) throw new Error(`no settings read for ${location}`);
        return campus;
      };
      const alumni = await dogsRepository.alumniAmong(tx, dogOrder);

      // 4. Each part, in body order.
      for (const part of parts) {
        const campus = campusOf(part.location);
        assertProgramOffered(campus, part.category);
        assertDatesBookable(part.sortedDates, args.now, global.booking_horizon_months);
        assertBeforeSameDayCutoff(part.sortedDates, args.now, campus.same_day_cutoff_time);
        await checkBookingGates(tx, {
          ownerId: args.ownerId,
          dogIds: part.allDogIds,
          category: part.category,
        });
        if (part.category === 'day-school') {
          const refused = part.allDogIds.filter((dogId) => alumni.has(dogId));
          if (refused.length > 0) throw alumniNoDaySchoolError(refused);
        }
      }

      // 5. Overlap, each dog against his live sessions, in the order's dog order.
      const conflicts: AlreadyBookedConflict[] = [];
      for (const dogId of dogOrder) {
        const dates = parts
          .filter((part) => part.allDogIds.includes(dogId))
          .flatMap((part) => part.sortedDates)
          .sort();
        const candidates = await bookingsRepository.findConflictCandidatesForDog(tx, dogId, dates);
        for (const date of dates) {
          for (const candidate of candidates) {
            if (dayProgramConflictsWith(date, candidate)) {
              conflicts.push({ dog_id: dogId, category: candidate.category, date });
            }
          }
        }
      }
      if (conflicts.length > 0) throw alreadyBookedError(conflicts);

      // 6. The capacity pre-pass: every (campus, date) with the order's dogs there summed.
      const census: { location: LocationKey; date: string; dogs: number; staying: number }[] = [];
      for (const location of LOCATIONS) {
        const here = parts.filter((part) => part.location === location);
        const dates = [...new Set(here.flatMap((part) => part.sortedDates))].sort();
        for (const date of dates) {
          const on = here.filter((part) => part.sortedDates.includes(date));
          census.push({
            location,
            date,
            dogs: on.reduce((sum, part) => sum + part.allDogIds.length, 0),
            staying: on.reduce(
              (sum, part) =>
                sum +
                part.allDogIds.filter((dogId) => part.afterSchool.get(dogId)?.has(date)).length,
              0,
            ),
          });
        }
      }
      for (const cell of census) {
        await dayCapacityRepository.assertCapacityWithinLock(tx, {
          location: cell.location,
          date: cell.date,
          rule: campusOf(cell.location),
          requestedCount: cell.dogs,
        });
      }
      for (const cell of census) {
        await assertAfterSchoolAt(tx, {
          location: cell.location,
          date: cell.date,
          capacity: campusOf(cell.location).after_school_capacity_count,
          requestedCount: cell.staying,
        });
      }

      // 7. The credit plan, under the pools of both tiers it touches.
      const { paid, draws } = await planOrderCredits(tx, {
        ownerId: args.ownerId,
        parts: parts.map((part) => ({
          location: part.location,
          mode: part.mode,
          sortedDates: part.sortedDates,
          allDogIds: part.allDogIds,
        })),
        dogOrder,
        alumni,
        consent,
        now: args.now,
      });
      const paidAt = new Map<string, OrderPaidSlot>();
      for (const slot of paid) paidAt.set(`${slot.partIndex}:${slot.date}:${slot.dogId}`, slot);

      // 8. The writes: one order, then each part's sessions.
      const order = await ordersRepository.create(tx, { ownerId: args.ownerId });
      const created: BookingRow[] = [];
      for (const [partIndex, part] of parts.entries()) {
        const campus = campusOf(part.location);
        for (const date of part.sortedDates) {
          await dayCapacityRepository.assertCapacityWithinLock(tx, {
            location: part.location,
            date,
            rule: campus,
            requestedCount: part.allDogIds.length,
          });
          const staying = part.allDogIds.filter((dogId) => part.afterSchool.get(dogId)?.has(date));
          await assertAfterSchoolAt(tx, {
            location: part.location,
            date,
            capacity: campus.after_school_capacity_count,
            requestedCount: staying.length,
          });
          const scheduledAt = computeDayProgramScheduledAt(date, campus.dropoff_open_time);
          const inserted = await insertBookingWithGateMapping(tx, {
            ownerId: args.ownerId,
            leadDogId: part.leadDogId,
            category: part.category,
            scheduledAt,
            location: part.location,
            notes: part.notes,
            additionalDogIds: part.additionalDogIds,
            orderId: order.id,
            afterSchoolDogIds: staying,
          });
          for (const dogId of part.allDogIds) {
            const slot = paidAt.get(`${partIndex}:${date}:${dogId}`);
            if (slot === undefined) {
              throw new Error(`the plan paid no lot for ${dogId} on ${date} (part ${partIndex})`);
            }
            await creditLedgerRepository.debitLot(tx, {
              ownerId: args.ownerId,
              location: part.location,
              mode: part.mode,
              tier: slot.tier,
              lotId: slot.lotId,
              dogId,
              bookingId: inserted.id,
              // A creation debit names no check-in event (designs/p20-event-ledger-link.md §9 (d)).
              checkinEventId: null,
            });
          }
          await enqueueBookingReminders(tx, {
            bookingId: inserted.id,
            ownerId: args.ownerId,
            leadDogId: part.leadDogId,
            category: part.category,
            scheduledAt,
          });
          created.push(inserted);
        }
      }

      // 9. The plan, from the debits just written; the sessions through the one wire.
      const plan = await planFromDebits(
        tx,
        created.map((row) => row.id),
        dogOrder,
      );
      const sessions = await wireManyBookings(sortBookingsByScheduledAt(created, 'asc'), {
        now: args.now,
        viewer: 'owner',
        runner: tx,
      });
      return { order, sessions, plan, draws };
    }),
  );
}
