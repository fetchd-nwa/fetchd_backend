import { pgTimestampToIso } from './pgTimestamp.js';
import type { ServiceCategory } from './bookingBucket.js';
import type { LocationKey } from './bookingWire.js';
import { requestStatus } from '../db/schema/schema.js';
import type {
  PendingRequestNotesWire,
  PendingRequestFocusWire,
  PendingRequestWire,
} from '../contracts/wire.js';

/**
 * Wire shape for `PendingRequest` per DATA-CONTRACT §B (R1, R8). The DB
 * stores notes as two separate `text` columns (`notes_per_dog`,
 * `notes_joint`) and focus as a scalar (`staff_preference text`) plus a
 * staff-defined trait list (`descriptor_keys text[]`); the wire composes
 * them into structured sub-objects. Optional-omit follows the Day-4a
 * convention: omit a key when its source is null/empty.
 *
 *   - `additional_dog_ids?` — omit when there's only a lead dog.
 *   - `notes?` (whole object) — omit when BOTH notes_per_dog AND notes_joint
 *     are null/empty. Inner keys are individually optional-omit.
 *   - `focus` — REQUIRED outer key per §B (R8); always emit an object,
 *     even if it's `{}`. Inner keys are individually optional-omit so
 *     `{ descriptor_keys: ['nervous'] }` and `{}` are both valid shapes.
 *     Δ 2026-06-17: `descriptor_keys: string[]` (staff-defined multi-select
 *     trait pills) replaced the single `comfort_level` enum.
 *   - `length_weeks?` — board-and-train-only on the FE; omit when null.
 *   - `approved_at?`, `converted_booking_id?` — emit only after the
 *     staff portal converts the request.
 *   - `approved_by_staff_id?` (wire 1.13.0) — emit only when a STAFF actor
 *     resolved the request (approve OR deny). Its ABSENCE on a `'cancelled'`
 *     row is what says "the owner withdrew this" — the discriminator
 *     DATA-CONTRACT.md:1221 pins, now actually on the wire (DRIFT-8).
 */
export type RequestStatus = (typeof requestStatus.enumValues)[number];

// These wire shapes are owned by the single-source contract (contracts/wire.ts).
export type { PendingRequestNotesWire, PendingRequestFocusWire, PendingRequestWire };

/**
 * The subset of `pending_requests` columns the wire helper consumes.
 * Structural type — keeps the helper decoupled from full Drizzle row
 * inference. Matches the projection the repo emits.
 */
export interface PendingRequestRowForWire {
  id: string;
  category: ServiceCategory;
  status: RequestStatus;
  submittedAt: string;
  notesPerDog: string | null;
  notesJoint: string | null;
  staffPreference: string | null;
  descriptorKeys: string[];
  lengthWeeks: number | null;
  lessonSetting: 'home' | 'public' | null;
  approvedAt: string | null;
  approvedByStaffId: string | null;
  convertedBookingId: string | null;
  // Day-program divert columns (Shanthi 2026-07-14); NULL/empty on the
  // classic request categories.
  location: LocationKey | null;
  payment: 'credits' | 'payg' | null;
  divertReasons: string[];
}

/** Lead + additional dog ids for one request, sorted for snapshot stability. */
export interface PendingRequestDogIds {
  lead: string;
  additional: string[];
}

/** A `pending_request_dogs` join row passed in by the repo. */
export interface PendingRequestDogRow {
  requestId: string;
  dogId: string;
  isLead: boolean;
}

/**
 * Pre-resolved preferred dates for one request, ordered by `ordinal` ASC
 * upstream of this helper (the repo does the sort + emits ISO strings).
 */
export interface PreferredDatesForRequest {
  requestId: string;
  preferredAt: string[]; // ISO-8601 strings, ordinal-ordered
}

/**
 * Emit the wire shape. Lead + additional dog ids come pre-resolved
 * (same pattern as `toBookingWire`); preferred dates come pre-resolved
 * + ordinal-ordered upstream.
 */
export function toRequestWire(
  row: PendingRequestRowForWire,
  dogIds: PendingRequestDogIds,
  preferredDates: string[],
): PendingRequestWire {
  const wire: PendingRequestWire = {
    id: row.id,
    dog_id: dogIds.lead,
    category: row.category,
    submitted_at: pgTimestampToIso(row.submittedAt),
    preferred_dates: preferredDates,
    focus: buildFocus(row),
    status: row.status,
  };
  if (dogIds.additional.length > 0) wire.additional_dog_ids = dogIds.additional;
  const notes = buildNotes(row);
  if (notes !== undefined) wire.notes = notes;
  if (row.lengthWeeks !== null) wire.length_weeks = row.lengthWeeks;
  if (row.lessonSetting !== null) wire.lesson_setting = row.lessonSetting;
  if (row.approvedAt !== null) wire.approved_at = pgTimestampToIso(row.approvedAt);
  // Wire 1.13.0 — the staff actor, omit-on-null. Present ⇒ a staffer approved
  // or denied; absent ⇒ the owner self-cancelled, or nobody has acted yet.
  if (row.approvedByStaffId !== null) wire.approved_by_staff_id = row.approvedByStaffId;
  if (row.convertedBookingId !== null) wire.converted_booking_id = row.convertedBookingId;
  // Day-program divert fields — omit-on-null keeps every classic request's
  // wire byte-identical to pre-divert (snapshots unchanged).
  if (row.location !== null) wire.location = row.location;
  if (row.payment !== null) wire.payment = row.payment;
  if (row.divertReasons.length > 0) wire.divert_reasons = row.divertReasons;
  return wire;
}

function buildNotes(row: PendingRequestRowForWire): PendingRequestNotesWire | undefined {
  const perDog = row.notesPerDog ?? '';
  const joint = row.notesJoint ?? '';
  if (perDog === '' && joint === '') return undefined;
  const notes: PendingRequestNotesWire = {};
  if (perDog !== '') notes.per_dog = perDog;
  if (joint !== '') notes.joint = joint;
  return notes;
}

function buildFocus(row: PendingRequestRowForWire): PendingRequestFocusWire {
  const focus: PendingRequestFocusWire = {};
  if (row.staffPreference !== null && row.staffPreference !== '') {
    focus.staff_preference = row.staffPreference;
  }
  if (row.descriptorKeys.length > 0) focus.descriptor_keys = row.descriptorKeys;
  return focus;
}

/**
 * Group `pending_request_dogs` rows into a per-request
 * `{ lead, additional[] }`. Mirrors `groupBookingDogs` exactly — throws
 * on the structural invariant that every request has a lead row, and
 * sorts additional ids for snapshot stability.
 */
export function groupRequestDogs(rows: PendingRequestDogRow[]): Map<string, PendingRequestDogIds> {
  const accumulator = new Map<string, { lead: string | null; additional: string[] }>();
  for (const row of rows) {
    let entry = accumulator.get(row.requestId);
    if (entry === undefined) {
      entry = { lead: null, additional: [] };
      accumulator.set(row.requestId, entry);
    }
    if (row.isLead) entry.lead = row.dogId;
    else entry.additional.push(row.dogId);
  }
  const result = new Map<string, PendingRequestDogIds>();
  for (const [requestId, { lead, additional }] of accumulator) {
    if (lead === null) {
      throw new Error(`pending_request ${requestId}: no pending_request_dogs row marked is_lead`);
    }
    result.set(requestId, { lead, additional: [...additional].sort() });
  }
  return result;
}
