import { pgTimestampToDate, pgTimestampToIso } from './pgTimestamp.js';
import type { ServiceCategory } from './bookingBucket.js';
import { bookingStatus, type LocationKey } from '../db/schema/schema.js';
import type { BookingWire } from '../contracts/wire.js';

/**
 * Wire shape for `Booking` per DATA-CONTRACT §B (Δ 2026-05-19 +
 * Δ 2026-05-20 Day 5). Required keys always emit; optional `?` keys omit
 * when null/empty (Day-4a convention). `cancelled_at` + `cancel_forfeited`
 * only emit when `status='cancelled'` — they describe a cancellation,
 * not a not-yet-happened-event.
 */
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type { LocationKey };

// BookingWire's shape is owned by the single-source contract (contracts/wire.ts).
// This module owns only the DB-row → wire shaping below.
export type { BookingWire };

/**
 * The subset of `bookings` columns the wire shape consumes. A structural
 * type kept narrow so the query layer doesn't accidentally couple the wire
 * helper to columns it doesn't need (confirmed_at, cancellation_reason,
 * dropoff_at, pickup_at, external_ref, source — all internal state, none on
 * the §B wire today). `cohortId` joined the wire Day-19d so the FE can group +
 * title group-class bookings; `cancelDeadlineAt` joined Δ 2026-07-08 for the
 * booking-overlap flow's forfeit warning. Since P21 (wire 6.0.0-lg5.2) no cancel
 * forfeits and nothing stamps it: it is passed through for a row stamped earlier,
 * and nothing reads it.
 */
export interface BookingRowForWire {
  id: string;
  category: ServiceCategory;
  status: BookingStatus;
  scheduledAt: string;
  durationMinutes: number | null;
  notes: string | null;
  sessionReportId: string | null;
  location: LocationKey | null;
  lessonSetting: 'home' | 'public' | null;
  cancelledAt: string | null;
  cancelForfeited: boolean;
  cancelDeadlineAt: string | null;
  cancelledBy: 'owner' | 'staff' | null;
  cancelReason: string | null;
  cohortId: string | null;
  orderId: string | null;
}

export interface BookingDogRow {
  bookingId: string;
  dogId: string;
  isLead: boolean;
  /** Set on a share cancelled alone (the one-dog cancel's stamp); absent on a live read. */
  expiredAt?: string | null;
}

/**
 * The dogs of one booking, as the wire names them: `lead` and `additional` are the dogs
 * still coming (`BookingWire.dog_id`, `additional_dog_ids`), and `cancelled` the shares
 * cancelled alone, earliest first.
 */
export interface BookingDogIds {
  lead: string;
  additional: string[];
  cancelled?: { dogId: string; cancelledAt: string }[];
}

/**
 * Whether a cancel would be accepted now (6.0.0-lg5.1, CXL-U09): `BookingWire.can_cancel`
 * for the whole session and `dog_shares[].can_cancel` per dog, computed by
 * `lib/dayCancel.ts` from the same fold and clock the cancels refuse on. Day-school and
 * day-care rows only; every other category omits both.
 */
export interface CancelFacts {
  canCancel: boolean;
  /** By dog: whether a one-dog cancel of her would be accepted now. */
  shareCanCancel: ReadonlyMap<string, boolean>;
}

/**
 * What each share of a day row carries beyond its cancel (6.0.0-lg5.2): her after-school
 * opt-in (`dog_shares[].after_school`, M5.04), and, on a share whose credit has not come
 * back, the date that credit would carry if it came back now
 * (`dog_shares[].return_expires_at`, D1), read by `returnExpiryFor` through the return
 * writer's own predicate.
 */
export interface ShareFacts {
  afterSchool: ReadonlyMap<string, boolean>;
  returnExpiresAt: ReadonlyMap<string, string>;
}

/**
 * Emit the wire shape. The denormalization is explicit: lead + additional
 * dog ids come pre-resolved by `groupBookingDogs` (rule-of-two with the
 * four bookings endpoints below); trainer name is pre-resolved by the
 * route via a staff join (`trainer_staff_id` → `staff.name`).
 */
export function toBookingWire(
  row: BookingRowForWire,
  dogIds: BookingDogIds,
  trainerName: string | null,
  groupClassName?: string,
  cancel?: CancelFacts,
  shares?: ShareFacts,
): BookingWire {
  const wire: BookingWire = {
    id: row.id,
    dog_id: dogIds.lead,
    category: row.category,
    status: row.status,
    date: pgTimestampToIso(row.scheduledAt),
  };
  if (dogIds.additional.length > 0) wire.additional_dog_ids = dogIds.additional;
  if (trainerName !== null && trainerName !== '') wire.trainer = trainerName;
  if (row.durationMinutes !== null) wire.duration_minutes = row.durationMinutes;
  if (row.notes !== null && row.notes !== '') wire.notes = row.notes;
  if (row.sessionReportId !== null) wire.session_report_id = row.sessionReportId;
  if (row.location !== null) wire.location = row.location;
  if (row.lessonSetting !== null) wire.lesson_setting = row.lessonSetting;
  if (row.cancelDeadlineAt !== null) {
    wire.cancel_deadline_at = pgTimestampToIso(row.cancelDeadlineAt);
  }
  if (row.cohortId !== null) wire.cohort_id = row.cohortId;
  if (row.orderId !== null) wire.order_id = row.orderId;
  if (groupClassName !== undefined && groupClassName !== '') {
    wire.group_class_name = groupClassName;
  }
  if (row.status === 'cancelled') {
    if (row.cancelledAt !== null) wire.cancelled_at = pgTimestampToIso(row.cancelledAt);
    wire.cancel_forfeited = row.cancelForfeited;
    // R5: WHO/WHY, omit-on-null like `cancelled_at`. Legacy cancelled rows
    // (pre-2026-07-27) carry NULL here, so the banner falls back gracefully.
    if (row.cancelledBy !== null) wire.cancelled_by = row.cancelledBy;
    if (row.cancelReason !== null && row.cancelReason !== '') {
      wire.cancel_reason = row.cancelReason;
    }
  }
  if (cancel !== undefined) {
    wire.can_cancel = cancel.canCancel;
    // `dog_id`, then `additional_dog_ids` in their order, then the shares cancelled
    // alone by `cancelled_at` (the wire's order).
    wire.dog_shares = [
      ...[dogIds.lead, ...dogIds.additional].map((dogId) => {
        const returnExpiresAt = shares?.returnExpiresAt.get(dogId);
        return {
          dog_id: dogId,
          can_cancel: cancel.shareCanCancel.get(dogId) ?? false,
          after_school: shares?.afterSchool.get(dogId) ?? false,
          ...(returnExpiresAt !== undefined ? { return_expires_at: returnExpiresAt } : {}),
        };
      }),
      ...(dogIds.cancelled ?? []).map((share) => ({
        dog_id: share.dogId,
        can_cancel: false,
        after_school: shares?.afterSchool.get(share.dogId) ?? false,
        cancelled_at: pgTimestampToIso(share.cancelledAt),
      })),
    ];
  }
  return wire;
}

/**
 * Group `booking_dogs` rows into a per-booking `{ lead, additional[], cancelled[] }`
 * (P20 notes D3). `lead` and `additional` are the shares still live, so a card never
 * names a dog who is not coming: the stored lead while she is, else the first remaining
 * dog in `additional`'s order, who then leaves that list. `cancelled` holds the shares
 * cancelled alone, earliest first. The last dog of a session cancelled one dog at a time
 * keeps her share (cancelling her cancels the session), so a booking always has a live
 * share; one with none is a broken database and throws. Additional ids sorted ascending so
 * snapshot tests don't flap on insert order.
 */
export function groupBookingDogs(rows: BookingDogRow[]): Map<string, BookingDogIds> {
  const accumulator = new Map<
    string,
    {
      lead: string | null;
      additional: string[];
      cancelled: { dogId: string; cancelledAt: string }[];
    }
  >();
  for (const row of rows) {
    let entry = accumulator.get(row.bookingId);
    if (entry === undefined) {
      entry = { lead: null, additional: [], cancelled: [] };
      accumulator.set(row.bookingId, entry);
    }
    if (row.expiredAt != null)
      entry.cancelled.push({ dogId: row.dogId, cancelledAt: row.expiredAt });
    else if (row.isLead) entry.lead = row.dogId;
    else entry.additional.push(row.dogId);
  }
  const result = new Map<string, BookingDogIds>();
  for (const [bookingId, { lead, additional, cancelled }] of accumulator) {
    const remaining = [...additional].sort();
    const first = lead ?? remaining.shift();
    if (first === undefined) {
      throw new Error(`booking ${bookingId}: no live booking_dogs row`);
    }
    const ids: BookingDogIds = { lead: first, additional: remaining };
    if (cancelled.length > 0) {
      ids.cancelled = [...cancelled].sort(
        (a, b) =>
          pgTimestampToDate(a.cancelledAt).getTime() - pgTimestampToDate(b.cancelledAt).getTime(),
      );
    }
    result.set(bookingId, ids);
  }
  return result;
}
