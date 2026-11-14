import { eq, inArray } from 'drizzle-orm';
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

/** One credit a cancel returned: the row and dog it paid for, and the return's id. */
export interface ReturnedCredit {
  bookingId: string;
  dogId: string | null;
  ownerId: string;
  returnId: string;
}

/**
 * Return every credit these rows debited and nothing has returned yet, each through the
 * one return writer to the lot it drew from, or a fresh lot if that lot can pay no later
 * date. `now` is the caller's cancel instant, so a fresh lot is dated by the same clock as
 * the cancel. The caller holds the rows, so this takes the pools after them, all at once,
 * in `lockPools`' one order (`db/locks.ts`). The order's cancels use it: a pending row's
 * slots may wait on the settle, so a share with no debit here is not an alarm.
 *
 * Answers every return written, empty if these rows debited nothing: the owner's notice
 * reads where each landed, and the caller wipes her balance cache post-commit.
 */
export async function returnDebitsToLots(
  tx: Tx,
  args: { bookingIds: readonly string[]; now: Date },
): Promise<ReturnedCredit[]> {
  const debits = await findDebitsOfRows(tx, args.bookingIds);
  await lockPools(tx, debits);
  const returned: ReturnedCredit[] = [];
  for (const debit of debits) {
    // A cancel's return names no check-in event (M5.10's link is the board verbs').
    const { id } = await creditLedgerRepository.refundForBooking(tx, {
      ...debit,
      now: args.now,
      checkinEventId: null,
    });
    returned.push({
      bookingId: debit.bookingId,
      dogId: debit.dogId,
      ownerId: debit.ownerId,
      returnId: id,
    });
  }
  return returned;
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
 * Who cancelled: the owner, or the school with the staff reason, quoted verbatim in the
 * notice when there is one (D13: the whole-session staff cancel's `reason?` stays
 * optional; the one-dog staff cancel requires one).
 */
export type CancellationWho = { by: 'owner' } | { by: 'staff'; reason?: string };

/**
 * Every `booking-cancelled` body, by §2.9's two arms (design.md:4546): who, and the credit
 * line. `cancel` is a cancel of the whole session or of one dog of it (s11), by the owner
 * or by the school, naming the dogs it took and every credit that came back, one entry
 * per credit, each read from where it landed (none for a row that spent no credit: a
 * private lesson, an evaluation). `staff-return` is a credit the door decided: a ticked
 * check-out (*picked up early*), the send-home, the turn-away and *Didn't come*. No arm
 * names money (P21, NOTIF-U17): a cancel returns a credit and nothing else.
 */
export type CancellationNotice =
  | {
      kind: 'cancel';
      who: CancellationWho;
      dogNames: readonly string[];
      category: ServiceCategory;
      scheduledAtIso: string;
      credits: readonly CreditLanding[];
    }
  | {
      kind: 'staff-return';
      event: 'picked-up-early' | 'sent-home' | 'turned-away' | 'didnt-come';
      dogName: string;
      credit: CreditLanding;
    };

const CHICAGO = 'America/Chicago';

/** A lot's date as every credit line prints it: "10 Nov", in Chicago. */
function shownDate(at: Date): string {
  return at.toLocaleDateString('en-GB', { timeZone: CHICAGO, day: 'numeric', month: 'short' });
}

/** "+1 credit, back to your Bentonville day-school credits (expires 19 Oct)", or, into a
 *  dead lot, §2.9's line: never a date she cannot spend shown as current. */
function creditLine(credit: CreditLanding): string {
  const date = shownDate(credit.expiresAt);
  const noun = credit.credits === 1 ? 'credit' : 'credits';
  if (!credit.live) {
    const its = credit.credits === 1 ? 'its' : 'their';
    return `${credit.credits} ${noun} came back, but ${its} date, ${date}, has passed. Message us if you'd like it extended`;
  }
  const campus = `${credit.location.charAt(0).toUpperCase()}${credit.location.slice(1)}`;
  const program = credit.mode === 'school' ? 'day-school' : 'daycare';
  return `+${credit.credits} ${noun}, back to your ${campus} ${program} credits (expires ${date})`;
}

/**
 * One credit line per landing, each true (brief B-5; §2.9 is silent on a day whose returns
 * landed in more than one place): credits that read the same line (one pool, one printed
 * date, both live or both dead) are summed into it ("+2 credits"), and two dogs on two
 * lots of two dates get two lines, never one date for credits that carry two. No landing,
 * no line. Shared by `booking-cancelled` and the failed-payment notice.
 */
export function creditLines(landings: readonly CreditLanding[]): string[] {
  const merged = new Map<string, CreditLanding>();
  for (const landing of landings) {
    const key = [landing.location, landing.mode, landing.live, shownDate(landing.expiresAt)].join(
      '|',
    );
    const seen = merged.get(key);
    merged.set(
      key,
      seen === undefined ? landing : { ...seen, credits: seen.credits + landing.credits },
    );
  }
  return [...merged.values()].map(creditLine);
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

/** What a cancel takes, as its notice names it. */
const PROGRAM: Record<ServiceCategory, string> = {
  'day-school': 'day school',
  'day-care': 'day care',
  'group-class': 'class',
  'private-lesson': 'private lesson',
  boarding: 'boarding stay',
  'board-and-train': 'board & train',
  evaluation: 'evaluation',
};

/** "Pepper", "Bao and Luna", "Bao, Luna and Pepper". */
function namesOf(dogNames: readonly string[]): string {
  if (dogNames.length <= 1) return dogNames[0] ?? 'your dog';
  return `${dogNames.slice(0, -1).join(', ')} and ${dogNames[dogNames.length - 1]}`;
}

export function cancellationBody(notice: CancellationNotice): string {
  switch (notice.kind) {
    case 'cancel': {
      const day = new Date(notice.scheduledAtIso).toLocaleDateString('en-GB', {
        timeZone: CHICAGO,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      const whose = `${namesOf(notice.dogNames)}'s ${PROGRAM[notice.category]}`;
      const who =
        notice.who.by === 'owner'
          ? `You cancelled ${whose}, ${day}`
          : notice.who.reason === undefined
            ? `The school cancelled ${whose} on ${day}`
            : `The school cancelled ${whose} on ${day}: "${notice.who.reason}"`;
      return [who, ...creditLines(notice.credits)].map((sentence) => `${sentence}.`).join(' ');
    }
    case 'staff-return':
      return `${notice.dogName} ${WHO_AT_THE_DOOR[notice.event]}. ${creditLine(notice.credit)}.`;
  }
}

/**
 * The `booking-cancelled` feed row for a cancelled row, in its own savepoint: who, the
 * dogs it took, and a credit line for each credit that came back, composed inside the
 * savepoint from where each return landed, read after the write (§2.9), so a failed read
 * rolls the notice back and never the credit. `dogIds` are the dogs the cancel took (a
 * day's live shares; every dog on any other row); `returnIds` the returns it wrote, none
 * for a row that spent no credit. Until P31 it is a feed row, not a push
 * (`m1_known_gaps`), so the reason is quoted whole.
 */
export async function noticeBookingCancelled(
  tx: Tx,
  args: {
    bookingId: string;
    ownerId: string;
    category: ServiceCategory;
    scheduledAt: string;
    who: CancellationWho;
    dogIds: readonly string[];
    returnIds: readonly string[];
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
      const named =
        args.dogIds.length === 0
          ? []
          : await sp
              .select({ id: dogs.id, name: dogs.name })
              .from(dogs)
              .where(inArray(dogs.id, [...args.dogIds]));
      // In the cancel's own order (a day's lead first), not the read's.
      const dogNames = args.dogIds.map((id) => {
        const dog = named.find((d) => d.id === id);
        if (dog === undefined) throw new Error(`dog ${id} has no row to name`);
        return dog.name;
      });
      const credits: CreditLanding[] = [];
      for (const returnId of args.returnIds) {
        credits.push(toCreditLanding(await findReturnLanding(sp, returnId)));
      }
      await notificationsRepository.enqueue(sp, {
        ownerId: args.ownerId,
        type: 'booking-cancelled',
        title: 'Booking cancelled',
        body: cancellationBody({
          kind: 'cancel',
          who: args.who,
          dogNames,
          category: args.category,
          scheduledAtIso: args.scheduledAt,
          credits,
        }),
        deepLinkPath: deepLinkToPath({ kind: 'booking', id: args.bookingId }),
        deepLinkKind: 'booking',
        deepLinkId: args.bookingId,
        dogIds: [...args.dogIds],
      });
    },
  );
}

/**
 * The owner's notice for one credit that came back, in its own savepoint: one dog
 * cancelled out of her day, or a credit the door decided (a ticked check-out, a settling
 * verb). Composed inside the savepoint from where the credit landed, read after the write
 * (§2.9), so a failed read rolls the notice back and never the credit. Until P31 it is a
 * feed row, not a push (`m1_known_gaps`); its trigger, `owner-cancel`, `staff-cancel` or
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
          by: CancellationWho;
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
      : `${args.who.by.by}-cancel:${args.bookingId}:${args.dogId}`;
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
              kind: 'cancel',
              who: args.who.by,
              dogNames: [dog.name],
              category: args.who.category,
              scheduledAtIso: args.who.scheduledAtIso,
              credits: [credit],
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

/**
 * Each row's dogs still on it (a share cancelled alone is not), lead first then by id: the
 * dogs a whole cancel takes, in the order its notice names them. Through the caller's
 * transaction.
 */
export async function liveDogsLeadFirst(
  tx: Tx,
  bookingIds: readonly string[],
): Promise<Map<string, string[]>> {
  const shares = (await bookingsRepository.findSharesByBookingIds(tx, [...bookingIds]))
    .filter((share) => share.expiredAt === null)
    .sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.dogId.localeCompare(b.dogId));
  const byRow = new Map<string, string[]>();
  for (const share of shares) {
    byRow.set(share.bookingId, [...(byRow.get(share.bookingId) ?? []), share.dogId]);
  }
  return byRow;
}

/** Where one return landed, as a credit line reads it (one credit a return). */
export function toCreditLanding(landing: ReturnLanding): CreditLanding {
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
  /** Every credit these rows got back, each return's own id: what a notice reads. */
  returned: ReturnedCredit[];
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
 * `settled_then_cancelled` arm, an ordinary cancel with an ordinary notice per row, each
 * naming the credit that row got back (P21 `plan_added` [0]: never "Refund is on the
 * way"), so every notice is written after every return; every other caller's one notice
 * is the failed-payment one, which reads `returned`.
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
  }
  const returned = await returnDebitsToLots(tx, {
    bookingIds: rows.map((r) => r.id),
    now: args.now,
  });
  if (args.notifyEachRow) {
    if (args.cancelledBy === null) {
      throw new Error(`order ${args.orderId}: an ordinary cancel's notice needs who cancelled`);
    }
    const who: CancellationWho =
      args.cancelledBy === 'owner'
        ? { by: 'owner' }
        : { by: 'staff', ...(args.cancelReason !== undefined ? { reason: args.cancelReason } : {}) };
    const shares = await liveDogsLeadFirst(
      tx,
      rows.map((r) => r.id),
    );
    for (const row of rows) {
      await noticeBookingCancelled(tx, {
        bookingId: row.id,
        ownerId: row.ownerId,
        category: row.category,
        scheduledAt: row.scheduledAt,
        who,
        dogIds: shares.get(row.id) ?? [],
        returnIds: returned.filter((r) => r.bookingId === row.id).map((r) => r.returnId),
        log: args.log,
      });
    }
  }
  const creditRefundedOwnerId = returned[0]?.ownerId;
  return {
    bookingIds: rows.map((r) => r.id),
    location: rows[0]?.location ?? null,
    ...(creditRefundedOwnerId !== undefined ? { creditRefundedOwnerId } : {}),
    returned,
  };
}
