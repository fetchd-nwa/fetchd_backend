import { pgTimestampToIso } from './pgTimestamp.js';
import type { ServiceCategory } from './bookingBucket.js';
import { bookingStatus, locationKey } from '../db/schema/schema.js';

/**
 * Wire shape for `Booking` per DATA-CONTRACT §B (Δ 2026-05-19 +
 * Δ 2026-05-20 Day 5). Required keys always emit; optional `?` keys omit
 * when null/empty (Day-4a convention). `cancelled_at` + `cancel_forfeited`
 * only emit when `status='cancelled'` — they describe a cancellation,
 * not a not-yet-happened-event.
 */
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type LocationKey = (typeof locationKey.enumValues)[number];

export interface BookingWire {
  id: string;
  dog_id: string;
  additional_dog_ids?: string[];
  category: ServiceCategory;
  status: BookingStatus;
  date: string;
  trainer?: string;
  duration_minutes?: number;
  notes?: string;
  session_report_id?: string;
  location?: LocationKey;
  cancelled_at?: string;
  cancel_forfeited?: boolean;
}

/**
 * The subset of `bookings` columns the wire shape consumes. A structural
 * type kept narrow so the query layer doesn't accidentally couple the wire
 * helper to columns it doesn't need (cohort_id, confirmed_at,
 * cancellation_reason, cancel_deadline_at, dropoff_at, pickup_at,
 * external_ref, source — all internal state, none on the §B wire today).
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
  cancelledAt: string | null;
  cancelForfeited: boolean;
}

export interface BookingDogRow {
  bookingId: string;
  dogId: string;
  isLead: boolean;
}

/** Lead + additional dog ids for one booking, sorted for snapshot stability. */
export interface BookingDogIds {
  lead: string;
  additional: string[];
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
  if (row.status === 'cancelled') {
    if (row.cancelledAt !== null) wire.cancelled_at = pgTimestampToIso(row.cancelledAt);
    wire.cancel_forfeited = row.cancelForfeited;
  }
  return wire;
}

/**
 * Group `booking_dogs` rows into a per-booking `{ lead, additional[] }`.
 * Throws on a structural invariant violation (a booking with no lead) —
 * that's a bug in the seed/migration, not a runtime condition the read
 * layer should silently paper over. Additional ids sorted ascending so
 * snapshot tests don't flap on insert order.
 */
export function groupBookingDogs(rows: BookingDogRow[]): Map<string, BookingDogIds> {
  const accumulator = new Map<string, { lead: string | null; additional: string[] }>();
  for (const row of rows) {
    let entry = accumulator.get(row.bookingId);
    if (entry === undefined) {
      entry = { lead: null, additional: [] };
      accumulator.set(row.bookingId, entry);
    }
    if (row.isLead) entry.lead = row.dogId;
    else entry.additional.push(row.dogId);
  }
  const result = new Map<string, BookingDogIds>();
  for (const [bookingId, { lead, additional }] of accumulator) {
    if (lead === null) {
      throw new Error(`booking ${bookingId}: no booking_dogs row marked is_lead`);
    }
    result.set(bookingId, { lead, additional: [...additional].sort() });
  }
  return result;
}
