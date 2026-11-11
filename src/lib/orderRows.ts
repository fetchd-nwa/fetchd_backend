import { eq } from 'drizzle-orm';
import { deepLinkToPath } from '../contracts/wire.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { lockPools } from '../db/locks.js';
import {
  creditLedgerRepository,
  findReturnLanding,
  type BookingDebitForRefund,
  type ReturnLanding,
} from '../db/repositories/creditLedgerRepository.js';
import { dogs } from '../db/schema/schema.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import type { ServiceCategory } from './bookingBucket.js';
import { noticeInSavepoint, type NoticeLog } from './noticeInSavepoint.js';

/**
 * Every live debit on these rows (one no return names yet), with the row it paid. Each
 * debit names its own pool.
 */
export async function findDebitsOfRows(
  tx: Tx,
  bookingIds: readonly string[],
): Promise<BookingDebitForRefund[]> {
  const debits: BookingDebitForRefund[] = [];
  // One at a time: a transaction is one connection.
  for (const bookingId of bookingIds) {
    debits.push(...(await creditLedgerRepository.findLiveDebits(tx, { bookingId })));
  }
  return debits;
}

/**
 * Return every credit these rows debited and nothing has returned yet, each through the
 * one return writer to the lot it drew from, or a fresh lot if that lot can pay no later
 * date. `now` is the caller's cancel instant, so a fresh lot is dated by the same clock as
 * the cancel. The caller holds the rows, so this takes the pools after them, all at once,
 * in `lockPools`' one order (`db/locks.ts`). The order's cancels use it: a pending row's
 * slots may wait on the settle, so a share with no debit here is not an alarm.
 *
 * Returns the owner credited, whose balance cache the caller wipes post-commit, or nothing
 * if these rows debited nothing.
 */
export async function returnDebitsToLots(
  tx: Tx,
  args: { bookingIds: readonly string[]; now: Date },
): Promise<string | undefined> {
  const debits = await findDebitsOfRows(tx, args.bookingIds);
  await lockPools(tx, debits);
  for (const debit of debits) {
    // A cancel's return names no check-in event (M5.10's link is the board verbs').
    await creditLedgerRepository.refundForBooking(tx, {
      ...debit,
      now: args.now,
      checkinEventId: null,
    });
  }
  return debits[0]?.ownerId;
}

/** The constant sentence of design §2.3:2502-2505's alarm. */
export const NO_LIVE_DEBIT_ALARM =
  'a live share of a day session holds no live booking-debit to return: nothing was moved and the request answered 500';

/**
 * A live share of a non-cancelled day row with no live debit, found by a cancel or a
 * settle that was about to return its credit (design §2.3:2502-2505: every such share
 * carries one). One alarm naming the booking and the dog, then a 500: never "moves
 * nothing".
 */
export function noLiveDebit(log: NoticeLog, share: { bookingId: string; dogId: string }): Error {
  log.error({ bookingId: share.bookingId, dogId: share.dogId }, NO_LIVE_DEBIT_ALARM);
  return new Error(`booking ${share.bookingId}: dog ${share.dogId} holds no live booking-debit`);
}

/**
 * D4: a cancelled booking must never push "reminder tomorrow". Every cancel of a row
 * runs this, a pending row included (design §2.7:4036).
 */
export async function tearDownBookingReminders(tx: Tx, bookingId: string): Promise<void> {
  await scheduledNotificationsRepository.cancelPendingByDedupePrefix(
    tx,
    `booking-reminder:${bookingId}`,
  );
  await scheduledNotificationsRepository.cancelPendingByDedupePrefix(
    tx,
    `boarding-24h:${bookingId}`,
  );
}

/**
 * Where a returned credit landed, for the credit line: its pool's campus and program, the
 * date its lot now carries, and whether that lot counts. `credits` is 1 for one dog.
 */
export interface CreditLanding {
  credits: number;
  location: string;
  mode: 'school' | 'daycare';
  expiresAt: Date;
  live: boolean;
}

/**
 * Every `booking-cancelled` body, by §2.9's two arms (design.md:4546): who, and the credit
 * line. `session` is the whole-session cancel, its body byte for byte as before P20 until
 * P21 rewrites it with the staff reason (NOTIF-U17). `one-dog` is one dog cancelled out of
 * her day (s11), by the owner or by the school (the reason joins at P21). `staff-return`
 * is a credit the door decided: a ticked check-out (*picked up early*) now, and from pass
 * 2 the send-home, the turn-away and *Didn't come*.
 */
export type CancellationNotice =
  | { kind: 'session'; category: ServiceCategory; scheduledAtIso: string; forfeited: boolean }
  | {
      kind: 'one-dog';
      by: 'owner' | 'staff';
      dogName: string;
      category: 'day-school' | 'day-care';
      scheduledAtIso: string;
      credit: CreditLanding;
    }
  | {
      kind: 'staff-return';
      event: 'picked-up-early' | 'sent-home' | 'turned-away' | 'didnt-come';
      dogName: string;
      credit: CreditLanding;
    };

const CHICAGO = 'America/Chicago';

/** "+1 credit, back to your Bentonville day-school credits (expires 19 Oct)", or, into a
 *  dead lot, §2.9's line: never a date she cannot spend shown as current. */
function creditLine(credit: CreditLanding): string {
  const date = credit.expiresAt.toLocaleDateString('en-GB', {
    timeZone: CHICAGO,
    day: 'numeric',
    month: 'short',
  });
  const noun = credit.credits === 1 ? 'credit' : 'credits';
  if (!credit.live) {
    const its = credit.credits === 1 ? 'its' : 'their';
    return `${credit.credits} ${noun} came back, but ${its} date, ${date}, has passed. Message us if you'd like it extended`;
  }
  const campus = `${credit.location.charAt(0).toUpperCase()}${credit.location.slice(1)}`;
  const program = credit.mode === 'school' ? 'day-school' : 'daycare';
  return `+${credit.credits} ${noun}, back to your ${campus} ${program} credits (expires ${date})`;
}

const WHO_AT_THE_DOOR: Record<
  Extract<CancellationNotice, { kind: 'staff-return' }>['event'],
  string
> = {
  'picked-up-early': 'was picked up early',
  'sent-home': 'was sent home early',
  'turned-away': 'was turned away',
  'didnt-come': "didn't come today",
};

export function cancellationBody(notice: CancellationNotice): string {
  switch (notice.kind) {
    case 'session':
      return sessionCancellationBody(notice.category, notice.scheduledAtIso, notice.forfeited);
    case 'one-dog': {
      const day = new Date(notice.scheduledAtIso).toLocaleDateString('en-GB', {
        timeZone: CHICAGO,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      const program = notice.category === 'day-school' ? 'day school' : 'day care';
      const who =
        notice.by === 'owner'
          ? `You cancelled ${notice.dogName}'s ${program}, ${day}`
          : `The school cancelled ${notice.dogName}'s ${program} on ${day}`;
      return `${who}. ${creditLine(notice.credit)}.`;
    }
    case 'staff-return':
      return `${notice.dogName} ${WHO_AT_THE_DOOR[notice.event]}. ${creditLine(notice.credit)}.`;
  }
}

/**
 * The whole-session arm: brief, category-aware, mentions the forfeit state when
 * applicable so the owner doesn't have to open the booking detail to learn the refund
 * didn't land.
 *
 * "Refund is on the way" also covers the `'unroutable'` branch, where it is true
 * because a human will send the money by hand rather than because a worker will.
 * Flagged to Allison with exactly that caveat and **ruled KEEP on 2026-08-20 —
 * explicitly including refunds a human sends by hand** (the money IS coming; the
 * owner does not need to know which channel carries it). Do not "fix" this to a
 * hedged variant without a new ruling.
 *
 * Provenance, because an earlier version of this comment cited the wrong date:
 * 2026-08-19's only ruling was the two flagged push titles. This copy ruling is
 * 2026-08-20.
 */
function sessionCancellationBody(
  category: ServiceCategory,
  scheduledAtIso: string,
  forfeited: boolean,
): string {
  const when = new Date(scheduledAtIso).toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
  });
  const noun =
    category === 'boarding'
      ? `boarding stay starting ${when}`
      : category === 'board-and-train'
        ? `board & train starting ${when}`
        : category === 'private-lesson'
          ? `private lesson on ${when}`
          : category === 'day-school'
            ? `day school on ${when}`
            : category === 'day-care'
              ? `day care on ${when}`
              : category === 'evaluation'
                ? `evaluation on ${when}`
                : `session on ${when}`;
  return forfeited
    ? `Your ${noun} is cancelled. The cancellation window has passed — no refund.`
    : `Your ${noun} is cancelled. Refund is on the way.`;
}

/** The `booking-cancelled` feed row for one row, in its own savepoint. */
export async function noticeBookingCancelled(
  tx: Tx,
  args: {
    bookingId: string;
    ownerId: string;
    category: ServiceCategory;
    scheduledAt: string;
    forfeited: boolean;
    log: NoticeLog;
  },
): Promise<void> {
  await noticeInSavepoint(
    tx,
    {
      subject: { bookingId: args.bookingId },
      dedupeKey: `booking-cancelled:${args.bookingId}`,
      log: args.log,
    },
    async (sp) => {
      const dogJoinRows = await bookingsRepository.findDogsByBookingIds([args.bookingId]);
      await notificationsRepository.enqueue(sp, {
        ownerId: args.ownerId,
        type: 'booking-cancelled',
        title: 'Booking cancelled',
        body: cancellationBody({
          kind: 'session',
          category: args.category,
          scheduledAtIso: args.scheduledAt,
          forfeited: args.forfeited,
        }),
        deepLinkPath: deepLinkToPath({ kind: 'booking', id: args.bookingId }),
        deepLinkKind: 'booking',
        deepLinkId: args.bookingId,
        dogIds: dogJoinRows.map((r) => r.dogId),
      });
    },
  );
}

/**
 * The owner's notice for one credit that came back, in its own savepoint: one dog
 * cancelled out of her day, or a credit the door decided (a ticked check-out). Composed
 * inside the savepoint from where the credit landed, read after the write (§2.9), so a
 * failed read rolls the notice back and never the credit. Until P31 it is a feed row, not
 * a push (`m1_known_gaps`); its trigger, `owner-cancel`, `staff-cancel` or
 * `staff-return`, is the alarm's dedupe key here and has no column until the queue.
 */
export async function noticeCreditReturned(
  tx: Tx,
  args: {
    bookingId: string;
    ownerId: string;
    dogId: string;
    returnId: string;
    /** The notice's arm, less the dog's name and the credit, which compose reads. */
    who:
      | {
          kind: 'one-dog';
          by: 'owner' | 'staff';
          category: 'day-school' | 'day-care';
          scheduledAtIso: string;
        }
      | {
          kind: 'staff-return';
          event: Extract<CancellationNotice, { kind: 'staff-return' }>['event'];
          eventId: string;
        };
    log: NoticeLog;
  },
): Promise<void> {
  const trigger =
    args.who.kind === 'staff-return'
      ? `staff-return:${args.who.eventId}`
      : `${args.who.by}-cancel:${args.bookingId}:${args.dogId}`;
  await noticeInSavepoint(
    tx,
    {
      subject: { bookingId: args.bookingId, dogId: args.dogId },
      dedupeKey: trigger,
      log: args.log,
    },
    async (sp) => {
      const [dog] = await sp.select({ name: dogs.name }).from(dogs).where(eq(dogs.id, args.dogId));
      if (dog === undefined) throw new Error(`dog ${args.dogId} has no row to name`);
      const credit = toCreditLanding(await findReturnLanding(sp, args.returnId));
      const body =
        args.who.kind === 'staff-return'
          ? cancellationBody({
              kind: 'staff-return',
              event: args.who.event,
              dogName: dog.name,
              credit,
            })
          : cancellationBody({
              kind: 'one-dog',
              by: args.who.by,
              dogName: dog.name,
              category: args.who.category,
              scheduledAtIso: args.who.scheduledAtIso,
              credit,
            });
      await notificationsRepository.enqueue(sp, {
        ownerId: args.ownerId,
        type: 'booking-cancelled',
        title: args.who.kind === 'staff-return' ? 'Credit returned' : 'Booking cancelled',
        body,
        deepLinkPath: deepLinkToPath({ kind: 'booking', id: args.bookingId }),
        deepLinkKind: 'booking',
        deepLinkId: args.bookingId,
        dogIds: [args.dogId],
      });
    },
  );
}

function toCreditLanding(landing: ReturnLanding): CreditLanding {
  return {
    credits: 1,
    location: landing.location,
    mode: landing.mode,
    expiresAt: new Date(landing.expiresAt),
    live: landing.live,
  };
}

export interface CancelledOrderRows {
  bookingIds: string[];
  location: string | null;
  /** The owner credited back, if any was: the caller wipes her balance cache post-commit. */
  creditRefundedOwnerId?: string;
}

/**
 * Cancel every row of one order still to come, in one transaction, and return every
 * debit (design §2.7:3893, :4017, :4040-4041: "a decline cancels every row of the order
 * and returns every debit"). A `past` row is a day attended, so it stands, and its
 * ledger rows with it. The caller holds the order's charge lock, which is what
 * serialises two cancels of one order: rows lock in id order under it, the pool after
 * (`db/locks.ts`). Nothing is forfeited, whatever the deadline says. A pending row
 * was never confirmed, and a settled top-up's rows go back as credits.
 *
 * `cancelledBy` is NULL for a failure no person chose. `notifyEachRow` is the
 * `settled_then_cancelled` arm, an ordinary cancel with an ordinary notice; every
 * other caller's one notice is the failed-payment one.
 */
export async function cancelOrderRowsInTx(
  tx: Tx,
  args: {
    orderId: string;
    cancelledBy: 'owner' | 'staff' | null;
    cancelReason?: string;
    now: Date;
    notifyEachRow: boolean;
    log: NoticeLog;
  },
): Promise<CancelledOrderRows> {
  const rows = await bookingsRepository.lockCancellableByOrderId(tx, args.orderId);
  for (const row of rows) {
    await bookingsRepository.markOrderRowCancelled(tx, {
      id: row.id,
      cancelledBy: args.cancelledBy,
      ...(args.cancelReason !== undefined ? { cancelReason: args.cancelReason } : {}),
      now: args.now,
    });
    await tearDownBookingReminders(tx, row.id);
    if (args.notifyEachRow) {
      await noticeBookingCancelled(tx, {
        bookingId: row.id,
        ownerId: row.ownerId,
        category: row.category,
        scheduledAt: row.scheduledAt,
        forfeited: false,
        log: args.log,
      });
    }
  }
  const creditRefundedOwnerId = await returnDebitsToLots(tx, {
    bookingIds: rows.map((r) => r.id),
    now: args.now,
  });
  return {
    bookingIds: rows.map((r) => r.id),
    location: rows[0]?.location ?? null,
    ...(creditRefundedOwnerId !== undefined ? { creditRefundedOwnerId } : {}),
  };
}
