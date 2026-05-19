/**
 * Auth failures are typed values, never swallowed. Each carries the HTTP
 * status the route layer maps it to and a stable machine `code` (the FE keys
 * recovery copy off the code, not the prose). The categories are deliberately
 * distinct — "no token" and "valid token but you were never invited" are
 * different user situations with different recovery paths.
 *
 * Not a frozen-contract shape: there is no error envelope in DATA-CONTRACT
 * yet, so `{ error: { code, message } }` is a Day-2 design choice (same
 * standing as the `/health` shape), to be ratified — not amended — later.
 */
export type AuthErrorCode =
  | 'unauthenticated' // missing/malformed Authorization header or bad token
  | 'not_provisioned' // token verifies, but no live mirror row for this uid
  | 'forbidden' // authenticated, but the role gate rejected the route
  | 'bad_request' // client sent a malformed/unaccepted request body
  | 'invalid_payload' // signature OK, but the payload is semantically unusable
  | 'idempotency_mismatch' // Idempotency-Key reused on a different endpoint+body
  | 'idempotency_inflight' // duplicate Idempotency-Key request still in progress
  | 'ambiguous_principal'; // integrity: uid in BOTH owners and staff

const STATUS_BY_CODE: Record<AuthErrorCode, number> = {
  unauthenticated: 401,
  not_provisioned: 403,
  forbidden: 403,
  bad_request: 400,
  invalid_payload: 422,
  idempotency_mismatch: 422,
  idempotency_inflight: 409,
  ambiguous_principal: 500,
};

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
