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
 * error. Day 10 grew the envelope with the typed `details` payload
 * (discriminated by `kind`); Days 11/12b/19d/19e and wire 1.8.0 grew the
 * code family to 23.
 *
 * Wire 1.13.0 fold-in (designs/wire-contract-completion.md §3.3): the code
 * union, the status table, and the `details` union are THE CONTRACT now —
 * this file imports `ApiErrorCode` / `API_ERROR_STATUS` / `ApiErrorDetailWire`
 * from `contracts/wire.ts` instead of declaring its own. Consequences,
 * deliberate:
 *   - a route inventing a `details` literal outside the union is a `tsc`
 *     error at the construction site (the drift guard the old opaque
 *     `{ kind: string } & Record<string, unknown>` typing deliberately
 *     lacked);
 *   - changing a status is now visibly a wire change (one table, contractual);
 *   - `'internal'` (the serializer's fallback code, `auth/plugin.ts`) is a
 *     member of the union and therefore constructible here in principle —
 *     don't: it marks "a non-ApiError escaped", and throwing it as an
 *     ApiError would launder an unhandled-error signal into a typed one.
 *
 * The concrete detail shapes still live in wire.ts §1 with their prose; the
 * gate constructors that build them stay in `lib/bookingErrors.ts`. The
 * envelope serializer in `auth/plugin.ts` reads `details` opaquely — same
 * cross-cutting seam, one place to change the wire shape.
 */
import type { ApiErrorCode, ApiErrorDetailWire } from '../contracts/wire.js';
import { API_ERROR_STATUS } from '../contracts/wire.js';

export type { ApiErrorCode, ApiErrorDetailWire };

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: ApiErrorDetailWire | undefined;

  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetailWire) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.details = details;
  }
}

/**
 * "Another request holds this Idempotency-Key and is still running"
 * (`db/idempotency.ts` state 3). Read the `code`, never the message — the
 * prose is a UI string and changing it must not change behavior.
 *
 * Exists for the two routes that capture money BEFORE their transaction opens
 * (`routes/enrollments.ts`, `routes/requestConfirmPayment.ts`). Their catch
 * blocks unwind the capture on any failure, and this is the ONE failure where
 * unwinding is wrong: losing the claim race means the money the caller is
 * holding is the OTHER request's — Stripe's own idempotency keyed off the same
 * `Idempotency-Key` handed this request back the in-flight one's PaymentIntent.
 * Refunding it would undo a charge that request is about to commit a booking
 * against. One predicate, two call sites, so the exclusion is one decision.
 */
export function isIdempotencyInflight(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'idempotency_inflight';
}
