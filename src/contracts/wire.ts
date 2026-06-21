/**
 * THE shared API↔client wire contract — single source of truth.
 *
 * This module is **dependency-free on purpose**: no imports (not Drizzle, not
 * anything). It is the file the staff portal's `src/api/contracts.ts` is
 * GENERATED from (verbatim + a banner, via the portal's `npm run sync:contracts`),
 * so it must never drag server code (Drizzle schema, Node APIs) into a browser
 * bundle. Keep it pure types + literal value tuples + pure helpers.
 *
 * Two halves:
 *   1. **Enum unions + value tuples.** Declared here as literals. Their values
 *      are canonically owned by the DB (`schema.sql` → Drizzle `pgEnum`); the
 *      literals here are a hand-maintained mirror that `contracts/conformance.ts`
 *      pins to the Drizzle enums with a compile-time `Equal<…>` assert — so if
 *      `schema.sql` changes an enum, `tsc` fails until this file is updated.
 *      (We assert rather than rewire `pgEnum(...)` because `schema.ts` is
 *      drizzle-introspection-generated and a `db:introspect` pull would clobber
 *      any hand-wired tuple import.)
 *   2. **Wire interfaces.** The JSON shapes the API emits. snake_case keys are
 *      intentional — they're the literal JSON keys on the wire. These have no
 *      other canonical home, so THIS file is their single definition; the API's
 *      `lib/*Wire.ts` + the staff routes import them from here.
 */

// ---- enum unions -----------------------------------------------------------

export type ServiceCategory =
  | 'day-school'
  | 'day-care'
  | 'group-class'
  | 'private-lesson'
  | 'board-and-train'
  | 'boarding'
  | 'evaluation';

export type BookingStatus = 'upcoming' | 'past' | 'cancelled';

export type RequestStatus =
  | 'submitted'
  | 'approved'
  | 'approved-awaiting-payment'
  | 'converted'
  | 'cancelled';

export type ThreadCategory = 'sessions' | 'billing' | 'enrollment' | 'other';

export type ReportProgram =
  | 'foundation'
  | 'advanced'
  | 'loose-leash'
  | 'house-manners'
  | 'cgc'
  | 'private-lesson'
  | 'boarding-session'
  | 'group-class-session'
  | 'board-train-session';

export type LocationKey = 'fayetteville' | 'bentonville';

export type RateUnit = 'per-day' | 'per-night' | 'per-session' | 'per-week' | 'flat';

export type StaffRole = 'owner-shanthi' | 'trainer' | 'office';

/** Attendance values a staff check-in can set. The DB `booking_attendance` enum
 *  also carries `'pending'` (the never-an-action default); the wire excludes it.
 *  `conformance.ts` asserts this is exactly `Exclude<booking_attendance, 'pending'>`. */
export type AttendanceStatus = 'attended' | 'no-show' | 'excused';

export type MediaPurpose =
  | 'dog-profile'
  | 'owner-avatar'
  | 'report-photo'
  | 'report-video'
  | 'message-attachment';

export type MediaKind = 'image' | 'video';

// ---- enum value tuples (for `<select>` options + Zod `enum`) ---------------

export const SERVICE_CATEGORIES: readonly [ServiceCategory, ...ServiceCategory[]] = [
  'day-school',
  'day-care',
  'group-class',
  'private-lesson',
  'board-and-train',
  'boarding',
  'evaluation',
];

export const LOCATIONS: readonly [LocationKey, ...LocationKey[]] = ['fayetteville', 'bentonville'];

export const RATE_UNITS: readonly [RateUnit, ...RateUnit[]] = [
  'per-day',
  'per-night',
  'per-session',
  'per-week',
  'flat',
];

export const REPORT_PROGRAMS: readonly [ReportProgram, ...ReportProgram[]] = [
  'foundation',
  'advanced',
  'loose-leash',
  'house-manners',
  'cgc',
  'private-lesson',
  'boarding-session',
  'group-class-session',
  'board-train-session',
];

/** Report programs that carry a `*_content` variant doc (REQUIRED). The rest are
 *  curriculum programs that carry a `results` envelope and forbid `content`.
 *  `satisfies` guards against a typo slipping a non-program into the subset. */
export const SESSION_PROGRAMS = [
  'private-lesson',
  'boarding-session',
  'board-train-session',
  'group-class-session',
] as const satisfies readonly ReportProgram[];

export function isSessionProgram(program: ReportProgram): boolean {
  return (SESSION_PROGRAMS as readonly ReportProgram[]).includes(program);
}

// ---- bookingWire.ts --------------------------------------------------------

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
  // Group-class only (DATA-CONTRACT §A Amendment 2026-06-01). `cohort_id` is the
  // stable key the FE groups weekly sessions by; `group_class_name` titles the card.
  cohort_id?: string;
  group_class_name?: string;
}

/** POST /staff/bookings/:id/attendance response (§A clarification 2026-05-28). */
export interface AttendanceWire {
  booking_id: string;
  dog_id: string;
  attendance: AttendanceStatus;
  checked_in_at: string;
}

// ---- requestWire.ts --------------------------------------------------------

export interface PendingRequestNotesWire {
  per_dog?: string;
  joint?: string;
}

export interface PendingRequestFocusWire {
  staff_preference?: string;
  // Δ 2026-06-17: staff-defined multi-select trait pills replaced the single
  // `comfort_level` enum.
  descriptor_keys?: string[];
}

export interface PendingRequestWire {
  id: string;
  dog_id: string;
  additional_dog_ids?: string[];
  category: ServiceCategory;
  submitted_at: string;
  preferred_dates: string[];
  notes?: PendingRequestNotesWire;
  focus: PendingRequestFocusWire;
  length_weeks?: number;
  status: RequestStatus;
  approved_at?: string;
  converted_booking_id?: string;
}

// ---- threadWire.ts ---------------------------------------------------------

export interface ThreadParticipantWire {
  id: string;
  name: string;
  role: StaffRole;
  image_path?: string;
}

export interface ThreadWire {
  id: string;
  category: ThreadCategory;
  title: string;
  sub_text: string;
  participant: ThreadParticipantWire;
  related_dog_ids: string[];
  last_message: string;
  last_message_at: string;
  unread_count: number;
}

/** One photo/video attachment on a message. `url` is a short-lived signed GET
 *  (5-min TTL); width/height/blurhash let the FE lay out without a round-trip;
 *  `duration_ms` is video-only. */
export interface MessageAttachmentWire {
  media_id: string;
  kind: MediaKind;
  url: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  duration_ms: number | null;
}

export interface MessageWire {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_name?: string;
  text: string;
  /** Photo/video attachments, ordered as sent. Omitted when the message has none. */
  attachments?: MessageAttachmentWire[];
  sent_at: string;
  is_read: boolean;
}

// ---- reportWire.ts ---------------------------------------------------------

export interface SkillResult {
  status: 'pass' | 'learning' | 'pending';
  score?: string;
  meta?: { label: string; value: string }[];
}

export interface PracticeItem {
  text: string;
}

export interface ReportWire {
  id: string;
  dog_id: string;
  date: string;
  trainer?: string;
  category: ServiceCategory;
  program: ReportProgram;
  excerpt: string;
  full_text: string;
  visit_count?: number;
  verdict_headline?: string;
  results?: Record<string, SkillResult>;
  practice_at_home?: PracticeItem[];
  friends_today?: string[];
  additional_skills_completed?: string[];
  private_lesson_content?: unknown;
  boarding_session_content?: unknown;
  board_train_session_content?: unknown;
  group_class_session_content?: unknown;
}

// ---- media (POST /media/upload + GET /media/:id) ---------------------------

/** `POST /media/upload` + `GET /media/:id` response. `url` + derivative URLs are
 *  short-lived presigned GETs; `derivatives` is empty until the derivatives
 *  worker runs (the source is still readable at original size — that's `url`). */
export interface MediaWire {
  id: string;
  purpose: MediaPurpose;
  kind: MediaKind;
  url: string;
  expires_at: string;
  blurhash: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  derivatives: Record<string, string>;
}

// ---- GET /staff/dogs -------------------------------------------------------

/** Dog directory for the cross-owner staff verbs (which reference dogs by UUID
 *  and carry no names). Resolves dog_id → name + owner for display. */
export interface StaffDogWire {
  id: string;
  name: string;
  breed: string;
  owner_id: string;
  owner_name: string;
  profile_image_path?: string;
}

// ---- staff/rates (append-only / void / history) ---------------------------

/** Staff-config view of the effective-dated price catalog. Rows are addressable
 *  (`id`) for void/edit; `effective_to`/`created_by_staff_id`/`note`/`location`
 *  always present (vs the owner-facing read). */
export interface StaffRateWire {
  id: string;
  category: ServiceCategory;
  location: LocationKey | null;
  amount_cents: number;
  unit: RateUnit;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_by_staff_id: string | null;
}

export interface StaffRateHistoryWire extends StaffRateWire {
  created_at: string;
  voided_at: string | null;
  voided_by_staff_id: string | null;
}
