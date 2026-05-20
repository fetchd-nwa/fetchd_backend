/**
 * Typed API failures, never swallowed. Each carries the HTTP status the
 * route layer maps it to and a stable machine `code` (the FE keys recovery
 * copy off the code, not the prose). The categories are deliberately
 * distinct — "no token" and "valid token but you were never invited" are
 * different user situations with different recovery paths.
 *
 * Started life as `AuthError` in `src/auth/` (Day 2, auth-only). Day 3a
 * added idempotency_* codes; Day 5a added not_found; at that 9th non-auth
 * code the class graduated from "auth thing" to "API thing" and moved to
 * `src/lib/` so non-auth layers (`db/`, `routes/*`) don't have to import
 * across the auth seam to throw a typed error. Behavior unchanged.
 *
 * Not a frozen-contract shape: there is no error envelope in DATA-CONTRACT
 * yet, so `{ error: { code, message } }` is a Day-2 design choice (same
 * standing as the `/health` shape), to be ratified — not amended — later.
 */
export type ApiErrorCode =
  | 'unauthenticated' // missing/malformed Authorization header or bad token
  | 'not_provisioned' // token verifies, but no live mirror row for this uid
  | 'forbidden' // authenticated, but the role gate rejected the route
  | 'not_found' // resource exists or doesn't, but not visible to this principal
  | 'bad_request' // client sent a malformed/unaccepted request body
  | 'invalid_payload' // signature OK, but the payload is semantically unusable
  | 'idempotency_mismatch' // Idempotency-Key reused on a different endpoint+body
  | 'idempotency_inflight' // duplicate Idempotency-Key request still in progress
  | 'ambiguous_principal'; // integrity: uid in BOTH owners and staff

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  not_provisioned: 403,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  invalid_payload: 422,
  idempotency_mismatch: 422,
  idempotency_inflight: 409,
  ambiguous_principal: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
