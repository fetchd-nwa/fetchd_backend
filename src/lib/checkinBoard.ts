import type { CheckinBoardWire, LocationKey } from '../contracts/wire.js';
import { db } from '../db/client.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { checkinEventsRepository } from '../db/repositories/checkinEventsRepository.js';
import { dogVaccinesRepository } from '../db/repositories/dogVaccinesRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { foldCheckinLog, isOnSite } from './checkinFold.js';
import { returnedCreditsByEvent, toCheckinEventWire } from './checkinVerbs.js';
import { chicagoTimeOnDate } from './chicagoDate.js';
import { cancelFacts, dayHasEnded, statesByDog } from './dayCancel.js';

/**
 * `GET /staff/checkin-board?location&date` (DAY-U29, DAY-U40; design §2.3:2406-2418; P20
 * notes D6, D7, D18, D19): one row per live share of a day-school or day-care session at
 * that campus on that Chicago date that is not cancelled. No order is promised.
 *
 *   - `late_pickup_due`: on site and Chicago now at or past the campus's
 *     `day.late_pickup_call_time` on the board's date. Nothing checks a dog out by itself
 *     (DAY-68).
 *   - `gate_warnings`: `'vaccine_lapsed'` when the booking gate's own vaccine read, run for
 *     the board's date, finds a requirement she no longer meets. The other two kinds are
 *     typed and never sent (P09, S14).
 *   - `can_cancel`: her `dog_shares[].can_cancel` on a staff read.
 */
export async function readCheckinBoard(args: {
  location: LocationKey;
  date: string;
  now: Date;
}): Promise<CheckinBoardWire[]> {
  const sessions = await bookingsRepository.findBoardSessions(args.location, args.date);
  if (sessions.length === 0) return [];
  const ids = sessions.map((s) => s.id);
  const [shares, events, returned, campus] = await Promise.all([
    bookingsRepository.findSharesByBookingIds(db, ids),
    checkinEventsRepository.findForBookings(db, ids),
    returnedCreditsByEvent(db, ids),
    settingsRepository.dayCampus(args.location),
  ]);
  const lateCall = chicagoTimeOnDate(args.date, campus.late_pickup_call_time);
  const pickupClose = new Map([[args.location as string, campus.pickup_close_time]]);

  const rows: CheckinBoardWire[] = [];
  for (const session of sessions) {
    const sessionEvents = events.filter((e) => e.bookingId === session.id);
    const live = shares.filter((s) => s.bookingId === session.id && s.expiredAt === null);
    const facts = cancelFacts({
      status: session.status,
      ended: dayHasEnded(session, pickupClose, args.now),
      liveDogIds: live.map((s) => s.dogId),
      states: statesByDog(sessionEvents),
      viewer: 'staff',
      perDogCancelEnabled: true,
    });
    for (const share of live) {
      const folded = foldCheckinLog(sessionEvents.filter((e) => e.dogId === share.dogId));
      const lapsed = await dogVaccinesRepository.findMissingForCategory(
        db,
        share.dogId,
        session.category,
        undefined,
        args.date,
      );
      rows.push({
        booking_id: session.id,
        dog_id: share.dogId,
        state: folded.state,
        events: folded.log.map((e) => toCheckinEventWire(e, returned)),
        booking_status: session.status,
        late_pickup_due: isOnSite(folded.state) && args.now.getTime() >= lateCall.getTime(),
        settled: folded.settled,
        can_cancel: facts.shareCanCancel.get(share.dogId) ?? false,
        payment_pending: session.status === 'payment-pending',
        gate_warnings: lapsed.length > 0 ? ['vaccine_lapsed'] : [],
      });
    }
  }
  return rows;
}
