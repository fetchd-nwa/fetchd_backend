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
 * The `details` payload's typed shape lives in `lib/bookingErrors.ts` so
 * the discriminated union can grow (Day 11 cohort capacity, Day 13 cancel
 * window, …) without this file taking on every booking-flow concern. The
 * envelope serializer in `auth/plugin.ts` reads `details` opaquely — same
 * cross-cutting seam, one place to change the wire shape.
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
  | 'insufficient_capacity'; // Day 10: booking blocked — day_capacity for (location,date,mode) exhausted

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
