import { deepLinkToPath } from '../contracts/wire.js';
import { lockCohort } from '../db/locks.js';
import { dayCapacityRepository } from '../db/repositories/dayCapacityRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import {
  waitlistRepository,
  waitlistTargetKey,
  waitlistTargetOf,
  type WaitlistEntryRow,
  type WaitlistTarget,
} from '../db/repositories/waitlistRepository.js';
import { DAY_PROGRAM_DROPOFF_WINDOW } from './bookingBucket.js';
import { checkBookingGates } from './bookingGatePreCheck.js';
import { chicagoWallTimeToUtc } from './chicagoDate.js';
import { ApiError } from './errors.js';
import { pgTimestampToDate } from './pgTimestamp.js';
import type { Tx } from '../db/tx.js';

/**
 * Waitlist promotion + the lapsed-offer sweep (Allison 2026-07-29/30).
 *
 * A seat freeing does not book anybody — it produces an OFFER (ruling 1). This
 * module is the "a seat freed, who gets told" half; accept/decline (and the
 * booking + payment that accept creates) live with the owner-facing routes.
 *
 * Four rules shape every pass:
 *
 *   1. **An offered entry is holding its seats.** Offering two entries against
 *      one free seat promises it twice; the second owner finds out at accept.
 *      Free seats are therefore `capacity − used − seats already offered`, and
 *      the whole read-then-offer sequence runs under a per-queue advisory lock
 *      so two concurrent scheduler ticks can't each spend the same seat.
 *   2. **One seat per dog, and a seat never sits empty.** Entries are
 *      multi-dog. When the head of the queue needs more seats than are free we
 *      skip it and keep walking — strict FIFO would leave a seat unused while
 *      a one-dog entry two places back could have taken it. The skipped entry
 *      keeps its place for the next pass.
 *   3. **`openings === 0` means CLOSED, not full.** A day with no openings at
 *      all can never free a seat, so there is nothing to promote into. Same
 *      distinction `POST /waitlist` makes when it refuses the join.
 *   4. **The gates decide who is next** (Allison 2026-07-31, rulings 6 + 7).
 *      Before an entry is offered a seat its booking gates are re-run: passing
 *      every gate auto-offers with no human in the loop, failing any gate
 *      flags the entry for staff and passes the seat straight to the next
 *      ELIGIBLE entry. Gates ran at join and run again at accept, but a
 *      vaccine can expire between April and June — an offer handed to someone
 *      who would be refused at accept holds a real seat hostage for a day
 *      while a family who could use it waits behind them.
 */

/**
 * How long an owner has to answer an offer before it rolls to the next in
 * line. Allison didn't rule a number; 24h survives a work day plus a night's
 * sleep, and is short enough that a queue for a session several days out still
 * gets two or three chances to fill the seat before it starts.
 */
export const OFFER_WINDOW_HOURS = 24;

const OFFER_WINDOW_MS = OFFER_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * The shortest offer worth making. An offer's push is not sent inline — it is
 * enqueued as a `scheduled_notifications` row and delivered by the scheduler's
 * notifications phase, which runs BEFORE promotion in the tick order, so the
 * owner first hears about the seat on the FOLLOWING tick at the earliest.
 * Against a deadline clamped to the session start (below), an offer made
 * minutes before drop-off can therefore expire before its own notification
 * goes out: the owner is told they lost a seat they were never told they had,
 * and the seat is burned for everyone behind them.
 *
 * 15 minutes is the floor at which an offer is a real chance rather than a
 * formality — a tick to deliver, and time to open the app and answer. Under
 * it we make no offer at all and leave the entry waiting; ruling 4 cancels it
 * when the session starts.
 */
const MIN_OFFER_WINDOW_MINUTES = 15;

const MIN_OFFER_WINDOW_MS = MIN_OFFER_WINDOW_MINUTES * 60 * 1000;

export interface PromoteOpts {
  /**
   * Offer deadline window in milliseconds. Defaults to `OFFER_WINDOW_HOURS`;
   * tests shorten it to drive offer → lapse → re-offer against a pinned clock.
   * `MIN_OFFER_WINDOW_MINUTES` still applies — shorten it below that floor and
   * nothing is offered at all, which is the point of the floor.
   */
  offerWindowMs?: number;
}

export interface PromotionResult {
  /** Seats genuinely free at the start of the pass (outstanding offers held back). */
  seatsFree: number;
  /** Entries moved 'waiting' → 'offered' by this pass. */
  offered: number;
}

const NOTHING_PROMOTED: PromotionResult = { seatsFree: 0, offered: 0 };

/**
 * What promotion needs to know about a target: whether it can be promoted into
 * at all, and if so how many seats its capacity model says are free before
 * outstanding offers are subtracted. `promotable: false` collapses every reason
 * there is nothing to do — closed day, deleted cohort, session already started
 * — because the caller's response to all of them is identical.
 */
type TargetSeats =
  | { promotable: false }
  | {
      promotable: true;
      /**
       * Seats the capacity model says exist, BEFORE outstanding offers are
       * subtracted — `openings − used` for a day, `capacity − filled` for a
       * cohort. Gross on purpose: `promoteForTarget` subtracts the held seats
       * itself, once, for both target kinds. Handing it a number that had
       * already netted them out on one branch and not the other would spend
       * every offered seat twice on that branch.
       */
      capacitySeats: number;
      sessionStartsAt: Date;
      /**
       * Group-class targets only: the cohort's class key, threaded into the
       * gate re-check so the vaccine gate applies its class-key exemption
       * (Shanthi 2026-07-14 — puppy classes don't require rabies). Omitting it
       * would block a puppy-class queue on a shot that class never needed.
       */
      groupClassKey?: string;
    };

/**
 * The instant a day-program session starts. The waitlist row carries only a
 * date, so the earliest a seat could be used is the drop-off window opening
 * (07:30 America/Chicago) — the same constant the booking path defaults a
 * drop-off time to.
 */
function dayProgramSessionStart(sessionDate: string): Date {
  return chicagoWallTimeToUtc(
    sessionDate,
    DAY_PROGRAM_DROPOFF_WINDOW.open.hour,
    DAY_PROGRAM_DROPOFF_WINDOW.open.minute,
  );
}

async function resolveTargetSeats(tx: Tx, target: WaitlistTarget, now: Date): Promise<TargetSeats> {
  if (target.kind === 'day-program') {
    const sessionStartsAt = dayProgramSessionStart(target.sessionDate);
    if (sessionStartsAt.getTime() <= now.getTime()) return { promotable: false };
    // `remaining` is deliberately NOT read: it already nets out the seats held
    // by outstanding offers, and `promoteForTarget` subtracts those itself.
    const { openings, used } = await dayCapacityRepository.capacityForDay(tx, {
      location: target.location,
      date: target.sessionDate,
      mode: target.mode,
    });
    // CLOSED, not full — no seat will ever free, so promoting anyone into it
    // would be a promise the school can't keep.
    if (openings === 0) return { promotable: false };
    // Goes negative when staff lower an override below current usage; that's an
    // over-booked day, not a day with seats to hand out.
    return { promotable: true, capacitySeats: Math.max(0, openings - used), sessionStartsAt };
  }

  // Row-lock the cohort for the same reason `POST /enrollments` does: `filled`
  // is the number promotion decides against, and an enrollment committing
  // between our read and our offer would hand out a seat that no longer exists.
  const cohort = await lockCohort(tx, target.cohortId);
  if (cohort === undefined || cohort.expiredAt !== null) return { promotable: false };
  const sessionStartsAt = pgTimestampToDate(cohort.startDate);
  if (sessionStartsAt.getTime() <= now.getTime()) return { promotable: false };
  return {
    promotable: true,
    capacitySeats: Math.max(0, cohort.capacity - cohort.filled),
    sessionStartsAt,
    groupClassKey: cohort.classKey,
  };
}

/**
 * Re-run this entry's booking gates (Allison 2026-07-31 ruling 6). Returns the
 * failing gate's code, or `undefined` when every gate passes.
 *
 * `checkBookingGates` reports failure by throwing a typed `ApiError` — that is
 * the right shape for a route, where the throw IS the response, and the wrong
 * shape here, where a failure is an ordinary answer ("not this family, then").
 * This is the one place that translation happens. Anything that is not an
 * `ApiError` is not a gate verdict — a dead connection or a bug — and must not
 * be recorded as one, so it propagates.
 */
async function findFailingGate(
  tx: Tx,
  entry: WaitlistEntryRow,
  target: WaitlistTarget,
  groupClassKey: string | undefined,
): Promise<string | undefined> {
  try {
    await checkBookingGates(tx, {
      ownerId: entry.ownerId,
      dogIds: entry.dogIds,
      // Taken from the TARGET, not the row's free-text `category`: the target
      // is the narrow union promotion already proved, so no unsupported
      // category can reach the gate check.
      category: target.kind === 'day-program' ? target.category : 'group-class',
      ...(groupClassKey === undefined ? {} : { groupClassKey }),
    });
    return undefined;
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
}

/**
 * Re-verify the entries this queue demoted on an earlier pass, and un-demote
 * the ones whose problem is gone. Returns whether any block cleared — i.e.
 * whether the queue's ORDER has changed and must be re-read.
 *
 * Allison 2026-07-31 ruling 7: "the demotion lasts exactly as long as the
 * problem". `gate_blocked_at` is a cached verdict, and nothing tells us when an
 * owner uploads the missing vaccine record — so a demoted entry has to be
 * re-checked BEFORE the seat is handed out. Without this, an owner who fixed
 * their problem stays behind every later joiner until the queue ahead of them
 * happens to empty, and a busy queue starves them indefinitely: the demotion
 * would outlive the problem by months.
 *
 * Only flagged entries are re-checked. An unflagged entry's verdict is taken
 * when it comes up for a seat, which is the cheapest place to pay for it.
 */
async function refreshGateBlocks(
  tx: Tx,
  queue: readonly WaitlistEntryRow[],
  target: WaitlistTarget,
  now: Date,
  groupClassKey: string | undefined,
): Promise<boolean> {
  let anyCleared = false;
  for (const entry of queue) {
    if (entry.gateBlockedAt === null) continue;
    const failingGate = await findFailingGate(tx, entry, target, groupClassKey);
    if (failingGate === undefined) {
      await waitlistRepository.clearGateBlock(tx, entry.id);
      anyCleared = true;
      continue;
    }
    // Still blocked, but on something else now — staff chasing the old reason
    // would be chasing a problem the owner already solved.
    if (failingGate !== entry.gateBlockedReason) {
      await waitlistRepository.markGateBlocked(tx, {
        id: entry.id,
        blockedAt: now,
        reason: failingGate,
      });
    }
  }
  return anyCleared;
}

/** Chicago-local "Aug 2, 6:00 PM" — the deadline the owner is working against. */
function formatDeadline(deadline: Date): string {
  return deadline.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Body copy. Names the thing that opened up and the deadline, because both are
 * what the owner needs to decide — and the deadline is the part that makes the
 * queue keep moving if they don't.
 */
function spotOpenBody(entry: WaitlistEntryRow, offerExpiresAt: Date): string {
  // Midday anchor: `session_date` is already a Chicago calendar date, and
  // reading it back through the Chicago formatter from noon keeps it that date
  // whatever the offset — the off-by-one trap of formatting a bare UTC midnight.
  const when =
    entry.sessionDate === null
      ? ''
      : ` on ${chicagoWallTimeToUtc(entry.sessionDate, 12, 0).toLocaleDateString('en-US', {
          timeZone: 'America/Chicago',
          month: 'short',
          day: 'numeric',
        })}`;
  const noun =
    entry.category === 'day-school'
      ? `day school${when}`
      : entry.category === 'day-care'
        ? `day care${when}`
        : 'the class you were waiting for';
  return `A spot opened up for ${noun}. Accept by ${formatDeadline(offerExpiresAt)} or it goes to the next family in line.`;
}

/**
 * Tell the owner their seat is waiting. One scheduled notification per offer —
 * it lands in the in-app feed on the next delivery pass and pushes under
 * 'urgent-updates'.
 */
async function enqueueSpotOpenNotification(
  tx: Tx,
  entry: WaitlistEntryRow,
  offeredAt: Date,
  offerExpiresAt: Date,
): Promise<void> {
  await scheduledNotificationsRepository.enqueueIdempotent(tx, {
    ownerId: entry.ownerId,
    type: 'waitlist-spot-open',
    trigger: 'waitlist-promotion',
    // Keyed on the OFFER, not the entry. `offered_at` is restamped by every
    // `markOffered`, so an entry that lapses and is later re-offered produces a
    // different key and a second notification. `waitlist-spot-open:<entryId>`
    // would collide with the first offer's row, ON CONFLICT DO NOTHING would
    // swallow it, and the owner would never hear about the seat they just got.
    dedupeKey: `waitlist-spot-open:${entry.id}:${offeredAt.toISOString()}`,
    scheduledFor: offeredAt,
    title: 'A spot opened up',
    body: spotOpenBody(entry, offerExpiresAt),
    deepLinkPath: deepLinkToPath({ kind: 'waitlist', id: entry.id }),
    deepLinkKind: 'waitlist',
    deepLinkId: entry.id,
    dogId: entry.leadDogId,
  });
}

/**
 * Offer every free seat on one target to the waiting queue: FIFO, gate-blocked
 * entries last, with a best-fit skip. Returns how many seats were free and how
 * many entries were offered; `offered` can be 0 with seats free when everyone
 * who fits fails a gate, or when the session is too close for the offer to be a
 * real chance.
 *
 * Callers other than the sweep (a staff cap override) can call this directly —
 * it takes its own per-queue lock and is safe to run inside any mutation
 * transaction. A caller freeing the seat itself wants `promoteFreedSeat`, which
 * adds the error boundary a user-facing mutation needs.
 */
export async function promoteForTarget(
  tx: Tx,
  target: WaitlistTarget,
  now: Date,
  opts: PromoteOpts = {},
): Promise<PromotionResult> {
  await waitlistRepository.lockQueue(tx, target);

  const seats = await resolveTargetSeats(tx, target, now);
  if (!seats.promotable) return NOTHING_PROMOTED;

  const held = await waitlistRepository.countOfferedSeats(tx, target);
  const seatsFree = Math.max(0, seats.capacitySeats - held);
  if (seatsFree === 0) return NOTHING_PROMOTED;

  // Never let an offer outlive the session it's for — an offer that expires
  // after drop-off can't be accepted, and it would keep holding the seat until
  // then instead of rolling to someone who could still use it.
  const windowMs = opts.offerWindowMs ?? OFFER_WINDOW_MS;
  const offerExpiresAt = new Date(
    Math.min(now.getTime() + windowMs, seats.sessionStartsAt.getTime()),
  );
  // Too late in the day for the offer to be a real chance — see
  // MIN_OFFER_WINDOW_MINUTES. The seats stay free and unoffered rather than
  // being spent on an offer that expires before the owner hears about it.
  if (offerExpiresAt.getTime() - now.getTime() < MIN_OFFER_WINDOW_MS) {
    return { seatsFree, offered: 0 };
  }

  // Bring every demoted entry's flag up to date first, so the order the seat is
  // handed out in reflects who passes the gates NOW (ruling 7), not who passed
  // them the last time a seat came along. Re-read only when something actually
  // cleared — that is the only way the order can have changed.
  let queue = await waitlistRepository.findWaitingQueue(tx, target);
  if (await refreshGateBlocks(tx, queue, target, now, seats.groupClassKey)) {
    queue = await waitlistRepository.findWaitingQueue(tx, target);
  }

  let remainingSeats = seatsFree;
  let offered = 0;
  for (const entry of queue) {
    if (remainingSeats === 0) break;
    const seatsNeeded = entry.dogIds.length;
    // A dogless entry is a broken row — `join` always writes at least the lead
    // — and offering it would consume no seat while promising one to nobody.
    if (seatsNeeded === 0) continue;
    // Doesn't fit: keep its place and try the next entry rather than leave the
    // seat empty until this one shrinks (it never will).
    if (seatsNeeded > remainingSeats) continue;
    // Still flagged after the refresh above, so its gates were re-checked this
    // pass and still fail. Skip it without paying for the gate queries twice.
    if (entry.gateBlockedAt !== null) continue;

    // Ruling 6: the seat only goes to someone who could actually book it. A
    // failing gate demotes the entry (`QUEUE_ORDER` sorts it last) and flags it
    // for staff; the seat falls through to the next eligible entry on this same
    // pass rather than waiting for a human.
    const failingGate = await findFailingGate(tx, entry, target, seats.groupClassKey);
    if (failingGate !== undefined) {
      await waitlistRepository.markGateBlocked(tx, {
        id: entry.id,
        blockedAt: now,
        reason: failingGate,
      });
      continue;
    }

    const won = await waitlistRepository.markOffered(tx, {
      id: entry.id,
      offeredAt: now,
      offerExpiresAt,
    });
    // Lost the conditional UPDATE: the entry stopped being 'waiting' between
    // the queue read and now (the owner left, staff resolved it). No seat was
    // spent, so the budget is unchanged and the next entry can have it.
    if (!won) continue;

    remainingSeats -= seatsNeeded;
    offered += 1;
    await enqueueSpotOpenNotification(tx, entry, now, offerExpiresAt);
  }

  return { seatsFree, offered };
}

/**
 * Promote the queue whose seat the caller's own mutation just freed — a
 * cancelled booking, a cohort withdrawal — inside that same transaction, but
 * behind an error boundary. Never throws.
 *
 * WHY promotion runs in the freeing transaction: a seat is free the moment the
 * cancel commits, and nothing else in the system watches for that. The
 * scheduler only re-promotes queues where an offer LAPSED, and no offer can
 * lapse until one has been made — so a queue that has never been promoted is
 * never promoted at all. Promoting here is what closes that loop, and it means
 * the freed seat and the offer for it commit together or not at all.
 *
 * WHY the boundary: the person freeing the seat and the person receiving it are
 * different people. `promoteForTarget` re-runs the booking gates, and a gate
 * failure is an `ApiError` — uncaught, a stranger's expired rabies shot would
 * surface to the canceller as a 422 about a dog they don't own, and would roll
 * back their cancellation and its refund with it. The waitlist is a courtesy
 * built on top of the cancel; it never gets a veto over it.
 *
 * WHY a SAVEPOINT rather than a bare try/catch: inside a transaction a failed
 * statement poisons everything after it, so catching the error would not save
 * the cancel — its own remaining writes would fail too. `tx.transaction`
 * issues a SAVEPOINT, so a promotion that blows up rolls back to exactly the
 * state the cancel had reached and nothing else.
 *
 * The failure is written to stderr rather than swallowed — the same loud,
 * non-propagating channel `withMutation` uses for its post-commit failures, and
 * the same operator signal until the observability seam lands.
 */
export async function promoteFreedSeat(
  tx: Tx,
  target: WaitlistTarget,
  now: Date,
  opts: PromoteOpts = {},
): Promise<PromotionResult> {
  try {
    return await tx.transaction((savepoint) => promoteForTarget(savepoint, target, now, opts));
  } catch (err) {
    process.stderr.write(
      `[waitlistPromotion] promoting the freed seat on ${waitlistTargetKey(target)} failed; ` +
        `the seat is free but nobody was offered it: ` +
        `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return NOTHING_PROMOTED;
  }
}

export interface WaitlistSweepResult {
  /** Offers whose deadline had passed when the sweep ran. */
  lapsed: number;
  /** Lapsed offers actually flipped to 'expired' (a racing answer can win). */
  expired: number;
  /** Entries offered by the re-promotion that follows the expiries. */
  promoted: number;
}

/**
 * Expire offers nobody answered, then re-promote the queues they were holding
 * seats in.
 *
 * This is the deadlock-breaker. An 'offered' entry holds its seats against
 * every later promotion pass, so one owner who never opens the app would stall
 * their whole queue indefinitely — the seat would be neither used nor offered
 * to anyone else. Expiring the offer and immediately re-promoting the same
 * target inside the same transaction is what makes the seat roll to the next
 * person on this tick rather than the next one.
 */
export async function sweepLapsedOffers(
  tx: Tx,
  now: Date,
  opts: PromoteOpts = {},
): Promise<WaitlistSweepResult> {
  const lapsed = await waitlistRepository.findLapsedOffers(tx, now);

  const targets = new Map<string, WaitlistTarget>();
  let expired = 0;
  for (const entry of lapsed) {
    const resolved = await waitlistRepository.resolve(tx, {
      id: entry.id,
      from: 'offered',
      to: 'expired',
      resolvedAt: now,
    });
    // An accept or decline landed first. That owner answered, so the seat is
    // theirs to keep or release — their resolution, not ours, decides it.
    if (!resolved) continue;
    expired += 1;
    const target = waitlistTargetOf(entry);
    targets.set(waitlistTargetKey(target), target);
  }

  // Sorted by queue key so two concurrent sweeps acquire the per-queue locks in
  // the same order and can't deadlock against each other.
  const ordered = [...targets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let promoted = 0;
  for (const [, target] of ordered) {
    const result = await promoteForTarget(tx, target, now, opts);
    promoted += result.offered;
  }

  return { lapsed: lapsed.length, expired, promoted };
}

export interface WaitlistSessionExpiryResult {
  /** Live entries whose session had already started. */
  scanned: number;
  /** Entries resolved to 'cancelled' (a racing answer can win). */
  cancelled: number;
}

/**
 * Allison 2026-07-30 ruling 4: "the entry dies when the session starts."
 *
 * Resolved to 'cancelled' rather than 'expired' — nothing lapsed and nobody
 * failed to answer; the thing they were queued for simply happened without
 * them, which is the same "no longer in the queue, nothing owed" state as
 * leaving voluntarily. Outstanding offers die too: an offer for a session
 * already under way can't be accepted, and leaving it 'offered' would hold
 * seats that no longer exist.
 */
export async function cancelEntriesForStartedSessions(
  tx: Tx,
  now: Date,
): Promise<WaitlistSessionExpiryResult> {
  const entries = await waitlistRepository.findLiveWithStartedSession(tx, now);
  let cancelled = 0;
  for (const entry of entries) {
    const resolved = await waitlistRepository.resolve(tx, {
      id: entry.id,
      from: entry.status,
      to: 'cancelled',
      resolvedAt: now,
    });
    if (resolved) cancelled += 1;
  }
  return { scanned: entries.length, cancelled };
}
