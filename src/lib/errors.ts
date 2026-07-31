/**
 * Typed API failures, never swallowed. Each carries the HTTP status the
 * route layer maps it to and a stable machine `code` (the FE keys recovery
 * copy off the code, not the prose). The categories are deliberately
 * distinct — "no token" and "valid token but you were never invited" are
 * different user situations with different recovery paths.
 *
 * Started life as `AuthError` in `src/auth/` (Day 2, auth-only). Day 3a
 * added idempotency_* codes; Day 5a added not_found; Day 9b added conflict
 * (DELETE blocked by referential state — e.g., expiring a vet referenced
 * by live dogs); at the 9th non-auth code the class graduated from "auth
 * thing" to "API thing" and moved to `src/lib/` so non-auth layers (`db/`,
 * `routes/*`) don't have to import across the auth seam to throw a typed
 * error. Behavior unchanged.
 *
 * Day 10 (booking-write surface) extends with the gate-error code family
 * (`payment_required`, `vaccine_missing`, `agreement_unsigned`,
 * `insufficient_credits`, `insufficient_capacity`) AND grows the envelope
 * with an optional, typed `details` payload — discriminated by `kind` so a
 * FE consumer can branch once and read the right structured fields (which
 * vaccine, which document, which date) for deep-link recovery instead of
 * parsing prose. Existing error paths emit no `details` and serialize
 * unchanged — additive on the wire (§A amendment 2026-05-22).
 *
 * Day 11 (cohort enrollment) adds two more discriminated arms:
 * `cohort_full` (capacity ceiling reached) and `eligibility_missing`
 * (R7 server-derived prereq gap). Both 422 — request was syntactically
 * fine, semantically blocked by current state.
 *
 * Day 12b (evaluation gate) adds `evaluation_required` (422) — the 4th
 * BOOKING GATE, mirroring payment/vaccine/agreement: any dog in a gated
 * category (day-school / day-care / board-and-train / boarding) must have
 * `evaluation_status='passed'`. Slots between payment and vaccine in
 * priority order (§H "Booking gates"). Joins the discriminated `details`
 * union as `kind: 'evaluation_required'`.
 *
 * The `details` payload's typed shape lives in `lib/bookingErrors.ts` so
 * the discriminated union can grow (Day 13 cancel window, …) without
 * this file taking on every booking-flow concern. The envelope serializer
 * in `auth/plugin.ts` reads `details` opaquely — same cross-cutting seam,
 * one place to change the wire shape.
 */
export type ApiErrorCode =
  | 'unauthenticated' // missing/malformed Authorization header or bad token
  | 'not_provisioned' // token verifies, but no live mirror row for this uid
  | 'forbidden' // authenticated, but the role gate rejected the route
  | 'not_found' // resource exists or doesn't, but not visible to this principal
  | 'bad_request' // client sent a malformed/unaccepted request body
  | 'invalid_payload' // signature OK, but the payload is semantically unusable
  | 'conflict' // request conflicts with current state (e.g. DELETE referenced)
  | 'idempotency_mismatch' // Idempotency-Key reused on a different endpoint+body
  | 'idempotency_inflight' // duplicate Idempotency-Key request still in progress
  | 'ambiguous_principal' // integrity: uid in BOTH owners and staff
  | 'payment_required' // Day 10: booking blocked — owner has no live payment_methods row
  | 'vaccine_missing' // Day 10: booking blocked — required vaccines missing/expired (per dog)
  | 'agreement_unsigned' // Day 10: booking blocked — required agreements unsigned at current version
  | 'insufficient_credits' // Day 10: booking blocked — per-dog credit balance would go negative
  | 'insufficient_capacity' // Day 10: booking blocked — day_capacity for (location,date,mode) exhausted
  | 'cohort_full' // Day 11: enrollment blocked — cohort.filled + requested > cohort.capacity
  | 'eligibility_missing' // Day 11: enrollment blocked — dog(s) missing OR-prereq for cohort's class (R7)
  | 'evaluation_required' // Day 12b: booking blocked — dog(s) missing passed evaluation for gated category
  | 'already_booked' // Day 19d: day-program booking blocked — dog already has a live booking for (category, day)
  | 'already_enrolled' // Day 19d: enrollment blocked — dog already enrolled in this cohort
  | 'already_requested' // Day 19d: request blocked — dog already has an open request of this category
  | 'event_full' // Day 19e: event RSVP blocked — live rsvp dogs + requested > events.capacity (owner self-serve soft cap)
  | 'already_waitlisted' // 2026-07-30: this dog already holds a live place in this queue
  | 'waitlist_not_needed'; // 2026-07-30: seats are available — book it, don't queue for it

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  not_provisioned: 403,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  invalid_payload: 422,
  conflict: 409,
  idempotency_mismatch: 422,
  idempotency_inflight: 409,
  ambiguous_principal: 500,
  // Day 10 gate failures + capacity/credit assertions are all 422 — the
  // request was syntactically fine but semantically blocked by current state.
  payment_required: 422,
  vaccine_missing: 422,
  agreement_unsigned: 422,
  insufficient_credits: 422,
  insufficient_capacity: 422,
  // Day 11 enrollment gates — same 422 family (state-blocked, not malformed).
  cohort_full: 422,
  eligibility_missing: 422,
  // Day 12b evaluation gate — 422 (dog-readiness state-block, not malformed).
  evaluation_required: 422,
  // Day 19d duplicate guards — 422 (state-block: the booking already exists).
  already_booked: 422,
  already_enrolled: 422,
  already_requested: 422,
  // Day 19e event RSVP soft cap — 422 (state-block: event is full).
  event_full: 422,
  // Waitlist duplicate + not-needed guards — same 422 family (state-block).
  already_waitlisted: 422,
  waitlist_not_needed: 422,
};

/**
 * Structured payload accompanying a typed error. Discriminator: `kind`.
 * Defined as `unknown` here to keep `lib/errors.ts` free of feature-layer
 * imports; the *concrete* shapes live in `lib/bookingErrors.ts` (and grow
 * as new gate/conflict categories land). The serializer in
 * `auth/plugin.ts` passes the payload through verbatim — the only
 * constraint is JSON-serializability, which the typed constructors in
 * `bookingErrors.ts` guarantee.
 */
export type ApiErrorDetails = { readonly kind: string } & Record<string, unknown>;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: ApiErrorDetails | undefined;

  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}
