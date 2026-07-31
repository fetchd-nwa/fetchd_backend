import { withCapacityLocks, withDogModeLocks } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { serviceRatesRepository } from '../db/repositories/serviceRatesRepository.js';
import type { Tx } from '../db/tx.js';
import { dayProgramConflictsWith } from './bookingConflicts.js';
import {
  alreadyBookedError,
  insufficientCreditsError,
  type AlreadyBookedConflict,
  type CreditGap,
} from './bookingErrors.js';
import { checkBookingGates } from './bookingGatePreCheck.js';
import { dayProgramCategoryToMode } from './bookingMode.js';
import type { DayProgramCategory } from './bookingSchedule.js';
import { toBookingWire, type BookingWire, type LocationKey } from './bookingWire.js';
import { bucketChicagoToday } from './chicagoDate.js';
import { computeCancelDeadlineFromHours } from './cancelWindow.js';
import { enqueueBookingReminders } from './enqueueBookingReminders.js';
import { ApiError } from './errors.js';
import { insertBookingWithGateMapping } from './insertBookingWithGateMapping.js';

/**
 * The day-program (day-school / day-care) booking-creation core — locks →
 * gates → payment plan → overlap guard → per-session capacity/INSERT/money/
 * reminders. Extracted from `POST /bookings` (Day-10..Δ 2026-06-19) when the
 * Shanthi-2026-07-14 approval divert gave it a second caller: the staff
 * portal's `POST /staff/requests/:id/approve` converts a diverted day-program
 * request by running EXACTLY this — same gates, same credit debits / PAYG
 * invoice, same reminders — so an approved request can never book on looser
 * rules than a direct booking.
 *
 * Callers own: body parsing/validation, ownership gates, idempotency
 * (`withMutation`), and post-commit cache invalidation (the returned
 * `creditDebitedDogIds` + the location feed `patternsToInvalidate`).
 *
 * The transaction protocol — DEADLOCK ORDER MATTERS, do not reorder:
 *   1. `withDogModeLocks(dogs ASC, mode)` then `withCapacityLocks(location,
 *      dates ASC)` — both acquire in canonical sorted order.
 *   2. Gate pre-check (payment → evaluation → vaccine → agreement).
 *   3. Payment plan: PAYG validates card + per-day rate and skips the credit
 *      pre-check; credits runs the per-dog balance check.
 *   4. Time-overlap guard against live sessions (`lib/bookingConflicts`).
 *   5. Per-session (date ASC): capacity assert (skipped only under
 *      `allowOverCapacity`, the staff cap override) → INSERT booking +
 *      booking_dogs → money write (PAYG open invoice / credit debits) →
 *      scheduled reminders.
 */

/**
 * How the group pays. A tagged union so `paymentMethodId` exists *only* on
 * the PAYG arm (the cross-field requirement is enforced at parse time, not
 * re-checked downstream).
 */
export type DayProgramPaymentPlan = { kind: 'credits' } | { kind: 'payg'; paymentMethodId: string };

/**
 * One session to create: the Chicago calendar day (capacity bucket) + the
 * exact UTC instant (drop-off applied). POST /bookings derives these from
 * `dates[]` + `dropoff_time`; the approve conversion reads them back from
 * `pending_request_preferred_dates`.
 */
export interface DayProgramSession {
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
  /** MUST be date-ASC (both callers sort at parse/read time). */
  sessions: DayProgramSession[];
  location: LocationKey;
  notes: string | null;
  payment: DayProgramPaymentPlan;
  now: Date;
  /**
   * Staff cap override (Allison 2026-07-30 ruling 2, "staff can override the
   * cap"). Skips the `day_capacity` ceiling — and nothing else. Every gate
   * still runs, because an override is about CAPACITY, not safety, and the
   * (location, date) lock is still held, so concurrent creates still serialize.
   *
   * The only caller that sets it is the waitlist accept, from
   * `waitlist_entries.offered_by_staff_id` — a column only
   * `POST /staff/waitlist/:id/offer` writes, under `requireStaff`. No route
   * body schema parses this field, so an owner cannot ask for it; both callers
   * build this args object field by field, so it can't ride in on a spread.
   */
  allowOverCapacity?: boolean;
  /**
   * The 'offered' waitlist entry this booking is converting, if any. An
   * outstanding offer HOLDS its dogs' seats, and accept books BEFORE it flips
   * the entry to 'accepted' — so without naming the entry here, the accepting
   * owner would be counted against their own hold and refused their own seat.
   * See `DayCapacityQuery.convertingWaitlistEntryId`.
   */
  convertingWaitlistEntryId?: string;
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
 * both 404 on miss. Also called STANDALONE by the POST /bookings divert path
 * so a dead card fails at submit time, not at staff-approval time.
 */
export async function resolvePaygPlan(
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

export async function createDayProgramBookings(
  tx: Tx,
  args: CreateDayProgramBookingsArgs,
): Promise<CreateDayProgramBookingsResult> {
  const allDogIds = [args.leadDogId, ...args.additionalDogIds];
  const mode = dayProgramCategoryToMode(args.category);
  const sortedDates = args.sessions.map((s) => s.date);
  const creditDebitedDogIds = new Set<string>();

  const wires = await withDogModeLocks(tx, allDogIds, mode, args.location, () =>
    withCapacityLocks(tx, args.location, sortedDates, async () => {
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
          if (balance < args.sessions.length) {
            creditGaps.push({
              dog_id: dogId,
              mode,
              balance,
              required: args.sessions.length,
            });
          }
        }
        if (creditGaps.length > 0) throw insufficientCreditsError(creditGaps);
      }

      // Time-overlap guard — the authoritative backstop for the FE conflict
      // engine (exact rules in `lib/bookingConflicts`, Δ 2026-07-09). Runs
      // under the (location, date) capacity lock, so a concurrent create on
      // the same bucket can't slip an overlap past this.
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
      for (const session of args.sessions) {
        // A staff cap override is the one thing that books past the ceiling
        // (R2). Skipping the assert is the WHOLE override: the day is still
        // locked, the gates above still ran, and `day_capacity` has no DB-side
        // ceiling to fall back on — the count is dynamic, asserted only here.
        if (args.allowOverCapacity !== true) {
          await dayCapacityRepository.assertCapacityWithinLock(tx, {
            location: args.location,
            date: session.date,
            mode,
            requestedCount: allDogIds.length,
            ...(args.convertingWaitlistEntryId === undefined
              ? {}
              : { convertingWaitlistEntryId: args.convertingWaitlistEntryId }),
          });
        }

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
