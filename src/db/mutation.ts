import { createHash } from 'node:crypto';
import { ApiError } from '../lib/errors.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { withIdempotency, type IdempotencyOutcome, type MutationResponse } from './idempotency.js';
import { withActor, type Tx } from './tx.js';

/**
 * Length-bounded so a hostile client can't fill the `idempotency_keys` table
 * with arbitrarily large keys. Stripe's limit is 255; Standard Webhooks
 * recommends UUIDs (36). 255 is generous and matches existing convention.
 */
export const IDEMPOTENCY_KEY_MAX_LEN = 255;

/**
 * Parse the `Idempotency-Key` header from a Fastify request's `headers` slot.
 * Required on every mutating endpoint (`schema.sql` Transaction contract
 * notes, IDEMPOTENCY) — missing/blank/over-length → 400 `bad_request`. The
 * client is responsible for generating one UUID per logical mutation; retries
 * reuse it. Extracted from the route layer so it's testable without spinning
 * up Fastify.
 */
export function requireIdempotencyKey(raw: string | string[] | undefined): string {
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== 'string' || key.length === 0) {
    throw new ApiError('bad_request', 'Idempotency-Key header is required for mutations');
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LEN) {
    throw new ApiError(
      'bad_request',
      `Idempotency-Key exceeds ${IDEMPOTENCY_KEY_MAX_LEN} characters`,
    );
  }
  return key;
}

/**
 * Canonical JSON: keys sorted recursively so `{a:1,b:2}` and `{b:2,a:1}`
 * hash to the same value. The hash guards `idempotency_keys.request_hash` —
 * a client that reuses a key with a different body is detected at the
 * boundary (`idempotency_mismatch` 422), not silently treated as a new call.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)]),
  );
}

/** SHA-256(canonical-JSON(body)). Stable across object-key reorderings. */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(body)))
    .digest('hex');
}

export interface MutationParams {
  principal: Principal;
  /** Client-supplied `Idempotency-Key` header value. */
  idempotencyKey: string;
  /** Canonical `METHOD path` for this route (e.g. `'PATCH /me'`). */
  endpoint: string;
  /** Hash of the request body — usually `hashRequestBody(parsedBody)`. */
  requestHash: string;
}

/**
 * The single mutation entrypoint every audited write route composes around
 * (`schema.sql` Transaction contract notes, GLOBAL + IDEMPOTENCY). Wraps the
 * two cross-cutting invariants in dependency order so neither can be skipped:
 *
 *   withActor(actorOf(principal),         // stamps app.actor for audit_capture
 *     withIdempotency(claim,              // dedupes on Idempotency-Key
 *       fn))                              // your business logic
 *
 * `app.actor` is set first (transaction-locally, Day-2 lock), then the
 * idempotency claim runs on the same connection so the `INSERT INTO
 * idempotency_keys` is captured by the same actor chain. The business `fn`
 * runs against the same `tx` and returns `{ status, body }` — both stored
 * so a replay restores the original status exactly.
 *
 * Owner principals' id is recorded as `idempotency_keys.owner_id` (FK), so
 * the TTL sweep can scope by owner if it ever needs to. Staff and system
 * principals don't fit the FK shape and stay NULL on the owner column.
 */
export async function withMutation<T>(
  params: MutationParams,
  fn: (tx: Tx) => Promise<MutationResponse<T>>,
): Promise<IdempotencyOutcome<T>> {
  return withActor(actorOf(params.principal), (tx) =>
    withIdempotency(
      tx,
      {
        key: params.idempotencyKey,
        ownerId: params.principal.kind === 'owner' ? params.principal.ownerId : null,
        endpoint: params.endpoint,
        requestHash: params.requestHash,
      },
      () => fn(tx),
    ),
  );
}
