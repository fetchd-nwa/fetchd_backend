import { lockPools } from '../db/locks.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import type { NoticeLog } from './noticeInSavepoint.js';
import { noLiveDebit, noticeCreditReturned } from './orderRows.js';

/**
 * What a settling event returns, in the verb's own transaction (DAY-U34; design
 * §2.3:2479-2505, :2517-2527; P20 brief B2-3). **Always a credit, never money** (the
 * refund ruling): no card arm, no invoice arm, no refund row, no Stripe call.
 *
 *   fraction = `day.sent_home_after_training_return_fraction` for a send-home marked
 *              finished, else `day.sent_home_before_training_return_fraction` (an
 *              unmarked send-home, a turn-away, *Didn't come*), daycare too (DAY-75);
 *              both 0 or 1 (D5).
 *   credits  = round(fraction × 1).
 *
 * The credit goes back through the one return writer, `settlement-return` naming the
 * share's LIVE debit (the newest no return names yet, so after a same-day re-check-in it
 * is the re-debit), to that debit's lot while the lot can pay a later date, else as a
 * fresh one-credit lot of `cred.returned_credit_expiry_months`. A return queues the
 * owner's notice, its who-line and the credit line read from where the credit landed; a
 * finished send-home writes nothing and sends nothing (DAY-45). The `cxl.*` fractions and
 * fees are read by nothing here. The return names the settling event (M5.10's
 * `checkin_event_id`), and what names the event is what `CheckinEventWire.settlement`
 * reports (D15).
 *
 * Every live share of a day row carries one live debit: one with none is the alarm and a
 * 500 (design §2.3:2502-2505), whatever the fraction, never a settle that "moves nothing".
 * The caller holds the booking row; the pool lock comes after it (`db/locks.ts`).
 */
export async function settleDayShare(
  tx: Tx,
  args: {
    bookingId: string;
    dogId: string;
    ownerId: string;
    event: { id: string; kind: 'turn-away' | 'sent-home' | 'no-show'; trainingCompleted: boolean };
    now: Date;
    log: NoticeLog;
  },
): Promise<{ creditsOwnerId?: string }> {
  const [debit] = await creditLedgerRepository.findLiveDebits(tx, {
    bookingId: args.bookingId,
    dogId: args.dogId,
  });
  if (debit === undefined) throw noLiveDebit(args.log, args);

  const day = await settingsRepository.dayGlobal(tx);
  const fraction =
    args.event.kind === 'sent-home' && args.event.trainingCompleted
      ? day.sent_home_after_training_return_fraction
      : day.sent_home_before_training_return_fraction;
  if (Math.round(fraction * 1) === 0) return {};

  await lockPools(tx, [debit]);
  const returned = await creditLedgerRepository.refundForBooking(tx, {
    ...debit,
    now: args.now,
    checkinEventId: args.event.id,
  });
  await noticeCreditReturned(tx, {
    bookingId: args.bookingId,
    ownerId: args.ownerId,
    dogId: args.dogId,
    returnId: returned.id,
    who: {
      kind: 'staff-return',
      event: WHO[args.event.kind],
      eventId: args.event.id,
    },
    log: args.log,
  });
  return { creditsOwnerId: debit.ownerId };
}

const WHO = {
  'turn-away': 'turned-away',
  'sent-home': 'sent-home',
  'no-show': 'didnt-come',
} as const;
