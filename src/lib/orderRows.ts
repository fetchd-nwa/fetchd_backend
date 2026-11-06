import { deepLinkToPath } from '../contracts/wire.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import type { ServiceCategory } from './bookingBucket.js';
import { noticeInSavepoint, type NoticeLog } from './noticeInSavepoint.js';

/**
 * Return every credit one booking row debited, each to the lot it drew from (or a
 * fresh lot if that lot has since expired). `now` is the caller's cancel instant, so
 * the lot the refund lands in is dated by the same clock as the cancel.
 *
 * Returns the distinct dogs credited, or nothing if this row debited nothing.
 */
export async function returnDebitsToLots(
  tx: Tx,
  args: { bookingId: string; now: Date },
): Promise<string[]> {
  const debits = await creditLedgerRepository.findDebitsForBooking(tx, args.bookingId);
  const creditedDogIds = new Set<string>();
  for (const debit of debits) {
    creditedDogIds.add(debit.dogId);
    await creditLedgerRepository.refundForBooking(tx, {
      dogId: debit.dogId,
      mode: debit.mode,
      location: debit.location,
      bookingId: args.bookingId,
      lotId: debit.lotId,
      lotExpiresAt: debit.lotExpiresAt,
      now: args.now,
    });
  }
  return [...creditedDogIds];
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
 * Notification body for the booking-cancelled push. Brief, category-aware, mentions
 * the forfeit state when applicable so the owner doesn't have to open the booking
 * detail to learn the refund didn't land.
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
export function cancellationBody(
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
        body: cancellationBody(args.category, args.scheduledAt, args.forfeited),
        deepLinkPath: deepLinkToPath({ kind: 'booking', id: args.bookingId }),
        deepLinkKind: 'booking',
        deepLinkId: args.bookingId,
        dogIds: dogJoinRows.map((r) => r.dogId),
      });
    },
  );
}

export interface CancelledOrderRows {
  bookingIds: string[];
  location: string | null;
  /** Distinct dogs credited back: the caller wipes their balance cache post-commit. */
  creditRefundedDogIds: string[];
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
  const dogIds = new Set<string>();
  for (const row of rows) {
    await bookingsRepository.markOrderRowCancelled(tx, {
      id: row.id,
      cancelledBy: args.cancelledBy,
      ...(args.cancelReason !== undefined ? { cancelReason: args.cancelReason } : {}),
      now: args.now,
    });
    for (const dogId of await returnDebitsToLots(tx, { bookingId: row.id, now: args.now })) {
      dogIds.add(dogId);
    }
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
  return {
    bookingIds: rows.map((r) => r.id),
    location: rows[0]?.location ?? null,
    creditRefundedDogIds: [...dogIds],
  };
}
