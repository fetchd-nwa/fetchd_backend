import { lockPools, withCapacityLocks, withDogLocks } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { cancelWindowSettingsRepository } from '../db/repositories/cancelWindowSettingsRepository.js';
import {
  creditLedgerRepository,
  findPayableLots,
  type CreditPool,
} from '../db/repositories/creditLedgerRepository.js';
import {
  creditPackagesRepository,
  type CreditPackageWithId,
} from '../db/repositories/creditPackagesRepository.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import type { DayProgramCampusSettingsWire, PostBookingsRequest } from '../contracts/wire.js';
import { dayProgramConflictsWith } from './bookingConflicts.js';
import {
  alreadyBookedError,
  creditExpiredBeforeDateError,
  insufficientCreditsError,
  type AlreadyBookedConflict,
} from './bookingErrors.js';
import { checkBookingGates } from './bookingGatePreCheck.js';
import { assertDatesBookable } from './bookingHorizon.js';
import { dayProgramCategoryToMode } from './bookingMode.js';
import { computeDayProgramScheduledAt, type DayProgramCategory } from './bookingSchedule.js';
import { toBookingWire, type BookingWire, type LocationKey } from './bookingWire.js';
import { bucketChicagoToday, chicagoTimeOnDate } from './chicagoDate.js';
import { computeCancelDeadlineFromHours } from './cancelWindow.js';
import { addChicagoMonths } from './creditExpiry.js';
import {
  alternativePack,
  assignCredits,
  expiryPaysDate,
  lotDatesBind,
  shortReason,
  type PaidSlot,
} from './creditPicker.js';
import { enqueueBookingReminders } from './enqueueBookingReminders.js';
import { ApiError } from './errors.js';
import { insertBookingWithGateMapping } from './insertBookingWithGateMapping.js';
import { pgTimestampToIso } from './pgTimestamp.js';

/**
 * The day-program (day-school / day-care) booking-creation core — locks →
 * gates → credits → overlap guard → per-session capacity/INSERT/debits/
 * reminders. `POST /bookings` is its one caller (wire 3.0.0 deleted the staff
 * approve conversion that was its second).
 *
 * The caller owns: body parsing/validation, ownership gates, idempotency
 * (`withMutation`, or the engine's claim for a top-up), and post-commit cache
 * invalidation.
 *
 * The transaction protocol — DEADLOCK ORDER MATTERS, do not reorder:
 *   1. `withDogLocks(dogs ASC)` then `withCapacityLocks(location, dates ASC)`
 *      — both acquire in canonical sorted order, and the pool comes after them.
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
 *   6. The tier: `alumni` needs every dog of the request to be alumni (DECISIONS D21).
 *   7. The credit check, on the owner's pool under its lock: the two-pass picker assigns
 *      every dog's every date to a lot, and a `top_up` is re-checked against what it
 *      leaves short, before anything is written.
 *   8. Time-overlap guard against live sessions (`lib/bookingConflicts`). After the credit
 *      check on purpose (D22): a `top_up` on a day she holds answers `shortfall: 0` when
 *      her credits cover it and `already_booked` when they do not, and either way no
 *      arm that refuses reaches a card.
 *   9. Per-session (date ASC): capacity assert → INSERT booking + booking_dogs → the
 *      debits the picker assigned → scheduled reminders. With a `top_up` every row is born
 *      `payment-pending`, the dates her lots could not pay stay undebited, and the settle
 *      debits them and queues the reminders.
 *
 * Every booking spends a credit (R1): this core opens no invoice and touches no card. The
 * one charge a booking can carry buys credits, and the engine makes it from the terms this
 * returns.
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

/** What a `top_up` that fits will charge: the engine's `ChargeTerms`, frozen in tx1. */
export interface TopUpTerms {
  amountCents: number;
  packageId: string;
  creditsCount: number;
}

export interface CreateDayProgramBookingsResult {
  wires: BookingWire[];
  /** Set exactly when the body carried a `top_up` that fits. */
  topUp?: TopUpTerms;
}

type TopUp = NonNullable<PostBookingsRequest['payment']['top_up']>;

/**
 * Does this `top_up` buy what the dates need, at the total she saw? A single-day row is
 * charged only when `count` is the shortfall exactly, and a pack is bought whole, so never
 * more days than the dates need and never a total she did not see (design §2.3:2621-2630).
 * Any live row of the booking's pool, or the regular single day the offer names, so long
 * as a lot of it `reaches` every day it would pay.
 */
function topUpFits(args: {
  row: CreditPackageWithId | undefined;
  topUp: TopUp;
  shortfall: number;
  tier: CreditPool['tier'];
  reaches: boolean;
}): args is typeof args & { row: CreditPackageWithId } {
  const { row, topUp, shortfall, tier, reaches } = args;
  if (row === undefined || !reaches) return false;
  if (row.tier !== tier && !(row.single_day && row.tier === 'regular')) return false;
  const buysTheShortfall = row.single_day
    ? topUp.count === shortfall
    : topUp.count === 1 && row.credits >= shortfall;
  return buysTheShortfall && topUp.count * row.price_cents === topUp.expected_total_cents;
}

/**
 * The credit check (design §2.3:2631-2659, §2.4:2906-2912): who pays which date, under the
 * pool lock, and whether a `top_up` still fits. It writes nothing, and every refusal is a
 * throw, so a refused request has no rows, no debits and no charge.
 *
 * With a top-up on an alumni booking the bought lot is regular, so the regular pool is
 * locked too, the alumni pool first (`lockPools`).
 */
async function planCredits(
  tx: Tx,
  args: {
    pool: CreditPool;
    dates: readonly string[];
    dogIds: readonly string[];
    topUp: TopUp | undefined;
    now: Date;
  },
): Promise<{ paid: PaidSlot[]; topUp?: TopUpTerms }> {
  const { pool, dates, dogIds, topUp, now } = args;
  await lockPools(tx, topUp !== undefined ? [pool, { ...pool, tier: 'regular' }] : [pool]);

  const settings = await settingsRepository.credit(tx);
  const rows = await creditPackagesRepository.findLiveForProgram(tx, {
    location: pool.location,
    mode: pool.mode,
    today: bucketChicagoToday(now),
  });
  const single = rows.find((row) => row.single_day && row.tier === 'regular');

  // The date a lot of this row bought now would carry. With expiry off, or outliving on, a
  // bought credit reaches every date, so no stamp binds it.
  //
  // The settle stamps that lot from the PaymentIntent's `created` (design §2.4:3003), which
  // Stripe gives in whole seconds and which comes after this transaction, so this judges on
  // the whole second it runs in: on clocks that agree, the stamp's anchor is that second or
  // later, and the lot pays every date this says it reaches (Fable r2 N2). Judged on `now`
  // itself, a top-up in the first second after a Chicago midnight, for the date a month
  // out, fit here and then paged a person when its lot ended at that midnight.
  const stampAnchor = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const stampOf = (row: CreditPackageWithId): Date | undefined =>
    lotDatesBind(settings) ? addChicagoMonths(stampAnchor, row.expiry_months) : undefined;

  // A date past the reach of a credit bought today can only be paid by a lot she holds.
  const reach = single !== undefined ? stampOf(single) : undefined;
  const beyondReach = new Set(
    reach === undefined ? [] : dates.filter((date) => !expiryPaysDate(reach, date)),
  );

  const lots = await findPayableLots(tx, pool, dates);
  const picked = assignCredits({ dates, dogIds, lots, beyondReach });

  if (picked.unreachable.length > 0 && reach !== undefined) {
    const latest = lots[lots.length - 1];
    throw creditExpiredBeforeDateError({
      expiresAt: latest !== undefined ? pgTimestampToIso(latest.expiresAt) : reach.toISOString(),
      dates: [...new Set(picked.unreachable.map((slot) => slot.date))],
    });
  }

  const shortfall = picked.short.length;
  const why = shortReason(picked, lots);

  // A bought lot pays the slots left short, so a row is judged on those dates. A pack is
  // offered and bought only if it pays them (`designs/p18-pack-reach-and-moved-dates.md`).
  const shortDates = picked.short.map((slot) => slot.date);
  const rowReaches = (row: CreditPackageWithId, paying: readonly string[]): boolean => {
    const stamp = stampOf(row);
    return stamp === undefined || paying.every((date) => expiryPaysDate(stamp, date));
  };

  const refusal = async () =>
    insufficientCreditsError({
      gap: {
        ...pickPoolKey(pool),
        balance: await creditLedgerRepository.poolBalanceInTx(tx, pool),
        required: dates.length * dogIds.length,
      },
      shortDates: picked.short.map((slot) => ({
        date: slot.date,
        reason: why.reason,
        ...(why.expiresAt !== undefined ? { expires_at: pgTimestampToIso(why.expiresAt) } : {}),
      })),
      offer:
        single === undefined
          ? null
          : {
              count: shortfall,
              unit_price_cents: single.price_cents,
              total_cents: shortfall * single.price_cents,
              package_key: single.key,
            },
      alternativePackageKey: alternativePack({
        packs: rows.filter(
          (row) => !row.single_day && row.tier === pool.tier && rowReaches(row, shortDates),
        ),
        shortfall,
        namedFromTheFirstDay: pool.mode === 'daycare' || pool.tier === 'alumni',
      }),
    });

  if (topUp === undefined) {
    if (shortfall > 0) throw await refusal();
    return { paid: picked.paid };
  }
  if (shortfall === 0) throw await refusal();
  const row =
    topUp.package_key === undefined ? single : rows.find((r) => r.key === topUp.package_key);
  const reaches = row !== undefined && rowReaches(row, shortDates);
  const fit = { row, topUp, shortfall, tier: pool.tier, reaches };
  if (!topUpFits(fit)) throw await refusal();
  return {
    paid: picked.paid,
    topUp: {
      amountCents: topUp.expected_total_cents,
      packageId: fit.row.id,
      creditsCount: topUp.count * fit.row.credits,
    },
  };
}

function pickPoolKey({ location, mode, tier }: CreditPool) {
  return { location, mode, tier };
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
  const pool: CreditPool = {
    ownerId: args.ownerId,
    location: args.location,
    mode,
    tier: args.payment.tier ?? 'regular',
  };
  let topUp: TopUpTerms | undefined;

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

      if (pool.tier === 'alumni' && !(await dogsRepository.allAlumni(tx, allDogIds))) {
        throw new ApiError(
          'alumni_tier_requires_alumni_dog',
          'an alumni credit pays only for an alumni dog',
        );
      }

      const plan = await planCredits(tx, {
        pool,
        dates: sortedDates,
        dogIds: allDogIds,
        topUp: args.payment.top_up,
        now: args.now,
      });
      topUp = plan.topUp;

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
          ...(topUp !== undefined ? { status: 'payment-pending' as const } : {}),
        });

        for (const slot of plan.paid.filter((paid) => paid.date === session.date)) {
          await creditLedgerRepository.debitLot(tx, {
            ...pool,
            lotId: slot.lotId,
            dogId: slot.dogId,
            bookingId: inserted.id,
          });
        }

        // Day-16: enqueue the scheduled reminder rows for this booking. UNIQUE on
        // dedupe_key makes an idempotent replay safe; the rows roll back with the
        // booking on any later in-tx failure. A pending row's reminders wait for its
        // settle: a decline would otherwise leave nothing to remind her of.
        if (topUp === undefined) {
          await enqueueBookingReminders(tx, {
            bookingId: inserted.id,
            ownerId: args.ownerId,
            leadDogId: args.leadDogId,
            category: args.category,
            scheduledAt: session.scheduledAt,
          });
        }

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

  return { wires, ...(topUp !== undefined ? { topUp } : {}) };
}
