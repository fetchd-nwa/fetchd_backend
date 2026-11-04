import { withCapacityLocks, withDogLocks } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { serviceRatesRepository } from '../db/repositories/serviceRatesRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import type { DayProgramCampusSettingsWire } from '../contracts/wire.js';
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
 * gates → payment plan → overlap guard → per-session capacity/INSERT/money/
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
 *   6. Payment plan: PAYG validates card + per-day rate and skips the credit
 *      pre-check; credits runs the per-dog balance check.
 *   7. Time-overlap guard against live sessions (`lib/bookingConflicts`).
 *   8. Per-session (date ASC): capacity assert → INSERT booking +
 *      booking_dogs → money write (PAYG open invoice / credit debits) →
 *      scheduled reminders.
 */

/**
 * How the group pays. A tagged union so `paymentMethodId` exists *only* on
 * the PAYG arm (the cross-field requirement is enforced at parse time, not
 * re-checked downstream).
 */
export type DayProgramPaymentPlan = { kind: 'credits' } | { kind: 'payg'; paymentMethodId: string };

/** One session to create: the Chicago calendar day (capacity bucket) + its start. */
interface DayProgramSession {
  date: string; // YYYY-MM-DD, America/Chicago
  scheduledAt: Date;
}

/** PAYG auto-charge timing — the open `'payg'` invoice is due one hour before
 * drop-off, so the worker bills just ahead of the session. The free-cancel
 * window is always wider (schema CHECK: hours_before ≥ 1), so a within-window
 * cancel voids the invoice before it charges. */
const PAYG_DUE_BEFORE_DROPOFF_MS = 60 * 60 * 1000;

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
  payment: DayProgramPaymentPlan;
  now: Date;
}

export interface CreateDayProgramBookingsResult {
  wires: BookingWire[];
  /** Dogs whose credit balance moved — feeds `credits:{dogId}:*` cache wipes. */
  creditDebitedDogIds: Set<string>;
}

/** The PAYG money plan resolved in-tx: the validated card + per-session amount. */
interface PaygPlan {
  paymentMethodId: string;
  amountCents: number;
}

/**
 * In-tx PAYG validation. Returns `null` for a `'credits'` group. For PAYG,
 * verifies the card is owned + live and resolves the active per-day rate —
 * both 404 on miss.
 */
async function resolvePaygPlan(
  tx: Tx,
  args: {
    payment: DayProgramPaymentPlan;
    category: DayProgramCategory;
    location: LocationKey;
    ownerId: string;
    now: Date;
  },
): Promise<PaygPlan | null> {
  if (args.payment.kind !== 'payg') return null;

  const card = await paymentMethodsRepository.findLiveByIdForOwner(tx, {
    id: args.payment.paymentMethodId,
    ownerId: args.ownerId,
  });
  if (card === undefined) {
    throw new ApiError('not_found', `payment method ${args.payment.paymentMethodId} not found`);
  }

  const today = bucketChicagoToday(args.now);
  const rate = await serviceRatesRepository.findActiveRate(args.category, args.location, today, tx);
  if (rate === undefined) {
    throw new ApiError(
      'not_found',
      `no active rate for category=${args.category} location=${args.location} on ${today}`,
    );
  }

  // Defense-in-depth (#7): PAYG charges one booking DATE off `amount_cents`,
  // so the rate MUST be per-day. The staff editor enforces this for day
  // programs, but a seed/SQL row could bypass it — refuse to charge rather
  // than silently bill a weekly/flat figure as a daily one. Config invariant
  // → 500 (loud).
  if (rate.unit !== 'per-day') {
    throw new Error(
      `PAYG rate for ${args.category} @ ${args.location} has unit '${rate.unit}', expected 'per-day' — refusing to charge to avoid mis-billing`,
    );
  }

  return { paymentMethodId: args.payment.paymentMethodId, amountCents: rate.amount_cents };
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

      // Payment branch (Δ 2026-06-19). PAYG validates the card + the active
      // per-day rate up front and SKIPS the credit pre-check; 'credits' runs
      // the per-dog balance check.
      const paygPlan = await resolvePaygPlan(tx, {
        payment: args.payment,
        category: args.category,
        location: args.location,
        ownerId: args.ownerId,
        now: args.now,
      });
      if (paygPlan === null) {
        const creditGaps: CreditGap[] = [];
        for (const dogId of allDogIds) {
          const balance =
            (await creditLedgerRepository.balanceForDogInTx(tx, dogId, mode, args.location)) ?? 0;
          if (balance < sessions.length) {
            creditGaps.push({ dog_id: dogId, mode, balance, required: sessions.length });
          }
        }
        if (creditGaps.length > 0) throw insufficientCreditsError(creditGaps);
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

      // Per-session: capacity → INSERT booking + booking_dogs → money write
      // (PAYG invoice schedule, or credit-ledger debits) → reminders.
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
        });

        if (paygPlan !== null) {
          // PAYG: no credit debit. Schedule a card auto-charge 1h before
          // drop-off; the invoiceAutoCharge worker (Day-15) bills the open
          // invoice at due_at. A within-window cancel voids it. Amount is
          // the per-day rate × the roster size — one combined charge per
          // session (one statement line, one Stripe fee).
          const dueAt = new Date(session.scheduledAt.getTime() - PAYG_DUE_BEFORE_DROPOFF_MS);
          await invoicesRepository.createOpen(tx, {
            ownerId: args.ownerId,
            amountCents: paygPlan.amountCents * allDogIds.length,
            purpose: 'payg',
            paymentMethodId: paygPlan.paymentMethodId,
            dueAt: dueAt.toISOString(),
            bookingId: inserted.id,
          });
        } else {
          for (const dogId of allDogIds) {
            await creditLedgerRepository.debitForBooking(tx, {
              dogId,
              mode,
              location: args.location,
              bookingId: inserted.id,
            });
            creditDebitedDogIds.add(dogId);
          }
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
