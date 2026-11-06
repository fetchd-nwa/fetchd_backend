import { withCapacityLocks, withDogLocks } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import type { DayProgramCampusSettingsWire, PostBookingsRequest } from '../contracts/wire.js';
import { dayProgramConflictsWith } from './bookingConflicts.js';
import {
  alreadyBookedError,
  insufficientCreditsError,
  type AlreadyBookedConflict,
  type CreditGap,
} from './bookingErrors.js';
import { checkBookingGates } from './bookingGatePreCheck.js';
import { assertDatesBookable } from './bookingHorizon.js';
import { dayProgramCategoryToMode } from './bookingMode.js';
import { computeDayProgramScheduledAt, type DayProgramCategory } from './bookingSchedule.js';
import { toBookingWire, type BookingWire, type LocationKey } from './bookingWire.js';
import { bucketChicagoToday, chicagoTimeOnDate } from './chicagoDate.js';
import { computeCancelDeadlineFromHours } from './cancelWindow.js';
import { enqueueBookingReminders } from './enqueueBookingReminders.js';
import { ApiError } from './errors.js';
import { insertBookingWithGateMapping } from './insertBookingWithGateMapping.js';

/**
 * The day-program (day-school / day-care) booking-creation core — locks →
 * gates → credits → overlap guard → per-session capacity/INSERT/debits/
 * reminders. `POST /bookings` is its one caller (wire 3.0.0 deleted the staff
 * approve conversion that was its second).
 *
 * The caller owns: body parsing/validation, ownership gates, idempotency
 * (`withMutation`), and post-commit cache invalidation (the returned
 * `creditDebitedDogIds` + the location feed `patternsToInvalidate`).
 *
 * The transaction protocol — DEADLOCK ORDER MATTERS, do not reorder:
 *   1. `withDogLocks(dogs ASC)` then `withCapacityLocks(location, dates ASC)`
 *      — both acquire in canonical sorted order.
 *   2. The settings, read ONCE for the whole request, UNDER the locks: an edit
 *      and a booking must serialise on the same keys (design §2.3:2344), so a
 *      read before the locks could act on a cap a concurrent edit just lowered.
 *      A campus row held `FOR UPDATE` by a PATCH does not block this plain read.
 *   3. What the campus says before what the clock says (DECISIONS 128(b)):
 *      `program_not_offered` → the past-date check and `beyond_booking_horizon` →
 *      `same_day_cutoff_passed`. Each runs after the idempotency claim, because
 *      the caller's `withMutation` holds it: a replay outlives every clock.
 *   4. Each session's `scheduled_at`, from the campus row just read.
 *   5. Gate pre-check (payment → evaluation → vaccine → agreement).
 *   6. The credit check, per dog.
 *   7. Time-overlap guard against live sessions (`lib/bookingConflicts`).
 *   8. Per-session (date ASC): capacity assert → INSERT booking +
 *      booking_dogs → credit debits → scheduled reminders.
 *
 * Every booking spends a credit (R1): this core opens no invoice and touches no card.
 */

/** One session to create: the Chicago calendar day (capacity bucket) + its start. */
interface DayProgramSession {
  date: string; // YYYY-MM-DD, America/Chicago
  scheduledAt: Date;
}

export interface CreateDayProgramBookingsArgs {
  ownerId: string;
  category: DayProgramCategory;
  leadDogId: string;
  additionalDogIds: string[];
  /**
   * YYYY-MM-DD Chicago days, distinct. MUST be date-ASC (the caller sorts at parse
   * time). Dates, not sessions: each start is computed here, from the campus row
   * read under the locks.
   */
  dates: string[];
  location: LocationKey;
  notes: string | null;
  payment: PostBookingsRequest['payment'];
  now: Date;
  /** The Confirm's order: every session of it carries this id (PAY-U04). */
  orderId: string;
}

export interface CreateDayProgramBookingsResult {
  wires: BookingWire[];
  /** Dogs whose credit balance moved — feeds `credits:{dogId}:*` cache wipes. */
  creditDebitedDogIds: Set<string>;
}

/** DAY-U04: `offerings[category].offered`, the service's one store, at this campus. */
function assertProgramOffered(
  campus: DayProgramCampusSettingsWire,
  category: DayProgramCategory,
): void {
  if (campus.offerings[category].offered) return;
  throw new ApiError('program_not_offered', `${category} is not offered at ${campus.location}`);
}

/**
 * DAY-U10, DAY-07: refused when a date is today in Chicago and `now` is at or past
 * the cutoff's wall-clock instant, so 07:29:59 books and 07:30:00 does not. Owners
 * only (DAY-08), and this path is owner-only: `POST /bookings` is the one
 * day-program create, and P26's walk-in does not call this.
 */
function assertBeforeSameDayCutoff(dates: readonly string[], now: Date, cutoffTime: string): void {
  const today = bucketChicagoToday(now);
  if (!dates.includes(today)) return;
  if (now.getTime() < chicagoTimeOnDate(today, cutoffTime).getTime()) return;
  throw new ApiError('same_day_cutoff_passed', `same-day booking closed at ${cutoffTime} today`);
}

export async function createDayProgramBookings(
  tx: Tx,
  args: CreateDayProgramBookingsArgs,
): Promise<CreateDayProgramBookingsResult> {
  const allDogIds = [args.leadDogId, ...args.additionalDogIds];
  const mode = dayProgramCategoryToMode(args.category);
  const sortedDates = args.dates;
  const creditDebitedDogIds = new Set<string>();

  const wires = await withDogLocks(tx, allDogIds, () =>
    withCapacityLocks(tx, args.location, sortedDates, async () => {
      // Once, for the whole request, under the locks (see the protocol above).
      const global = await settingsRepository.dayGlobal(tx);
      const campus = await settingsRepository.dayCampus(args.location, tx);

      assertProgramOffered(campus, args.category);
      assertDatesBookable(sortedDates, args.now, global.booking_horizon_months);
      assertBeforeSameDayCutoff(sortedDates, args.now, campus.same_day_cutoff_time);

      const sessions: DayProgramSession[] = sortedDates.map((date) => ({
        date,
        scheduledAt: computeDayProgramScheduledAt(date, campus.dropoff_open_time),
      }));

      // Gates (payment → evaluation → vaccine → agreement) above the DB
      // trigger floor. See `lib/bookingGatePreCheck.ts` for the sequence
      // rationale; first failure aborts with full structured details.
      await checkBookingGates(tx, {
        ownerId: args.ownerId,
        dogIds: allDogIds,
        category: args.category,
      });

      // The credit check, per dog, under the dog locks.
      const creditGaps: CreditGap[] = [];
      for (const dogId of allDogIds) {
        const balance =
          (await creditLedgerRepository.balanceForDogInTx(tx, dogId, mode, args.location)) ?? 0;
        if (balance < sessions.length) {
          creditGaps.push({ dog_id: dogId, mode, balance, required: sessions.length });
        }
      }
      if (creditGaps.length > 0 || args.payment.top_up !== undefined) {
        // `top_up` is typed and refused until P18 opens this branch for the count and
        // the total that hold: no offer exists, so none can be honoured, and booking on
        // credits instead would succeed a body that said "buy". The card is not read.
        throw insufficientCreditsError(creditGaps, sortedDates);
      }

      // Time-overlap guard — the authoritative backstop for the FE conflict
      // engine (exact rules in `lib/bookingConflicts`, Δ 2026-07-09). Runs
      // under the dog locks, which key on the lowercased id alone (normalised
      // at the route's parse boundary), so a concurrent create for the same
      // dog, in any mode at either campus, can't slip an overlap past this.
      const conflicts: AlreadyBookedConflict[] = [];
      for (const dogId of allDogIds) {
        const candidates = await bookingsRepository.findConflictCandidatesForDog(
          tx,
          dogId,
          sortedDates,
        );
        for (const date of sortedDates) {
          for (const candidate of candidates) {
            if (dayProgramConflictsWith(date, candidate)) {
              conflicts.push({ dog_id: dogId, category: candidate.category, date });
            }
          }
        }
      }
      if (conflicts.length > 0) throw alreadyBookedError(conflicts);

      // Per-session: capacity → INSERT booking + booking_dogs → credit-ledger
      // debits → reminders.
      const created: BookingWire[] = [];
      for (const session of sessions) {
        await dayCapacityRepository.assertCapacityWithinLock(tx, {
          location: args.location,
          date: session.date,
          rule: campus,
          requestedCount: allDogIds.length,
        });

        // Resolve the active free-cancel hours from `cancel_window_settings`
        // (Day 13 — staff-tunable). Stamped at creation; a later policy
        // change does NOT retroactively re-stamp existing bookings.
        const hours = await cancelWindowSettingsRepository.resolveHoursFor(args.category, tx);
        const cancelDeadlineAt = computeCancelDeadlineFromHours(session.scheduledAt, hours);

        const inserted = await insertBookingWithGateMapping(tx, {
          ownerId: args.ownerId,
          leadDogId: args.leadDogId,
          category: args.category,
          scheduledAt: session.scheduledAt,
          location: args.location,
          notes: args.notes,
          cancelDeadlineAt,
          additionalDogIds: args.additionalDogIds,
          orderId: args.orderId,
        });

        for (const dogId of allDogIds) {
          await creditLedgerRepository.debitForBooking(tx, {
            dogId,
            mode,
            location: args.location,
            bookingId: inserted.id,
          });
          creditDebitedDogIds.add(dogId);
        }

        // Day-16: enqueue the scheduled reminder rows for this booking.
        // UNIQUE on dedupe_key makes an idempotent replay safe; the rows
        // roll back with the booking on any later in-tx failure.
        await enqueueBookingReminders(tx, {
          bookingId: inserted.id,
          ownerId: args.ownerId,
          leadDogId: args.leadDogId,
          category: args.category,
          scheduledAt: session.scheduledAt,
        });

        created.push(
          toBookingWire(
            inserted,
            {
              lead: args.leadDogId,
              additional: [...args.additionalDogIds].sort(),
            },
            null /* day programs carry no trainer */,
          ),
        );
      }
      return created;
    }),
  );

  return { wires, creditDebitedDogIds };
}
