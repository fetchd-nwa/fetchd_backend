import { createHash } from 'node:crypto';
import {
  invalidate as invalidateCacheKeys,
  invalidatePattern as invalidateCachePattern,
} from '../lib/cache.js';
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

export interface MutationParams<T = unknown> {
  principal: Principal;
  /** Client-supplied `Idempotency-Key` header value. */
  idempotencyKey: string;
  /** Canonical `METHOD path` for this route (e.g. `'PATCH /me'`). */
  endpoint: string;
  /** Hash of the request body — usually `hashRequestBody(parsedBody)`. */
  requestHash: string;
  /**
   * Day-8: optional post-commit cache invalidation. Fires **once**, after
   * the transaction has committed, **only** for new (non-replayed)
   * outcomes — a replay returned the stored response so the cache state
   * doesn't need re-invalidating.
   *
   * Receives the response body so keys can depend on server-generated
   * values (a newly-minted booking id, the location the mutation
   * touched). Returns the list of exact-match cache keys to drop.
   * For range/pattern wipes (e.g. every `avail:{location}:*` entry on
   * a `day_capacity` write), call `invalidatePattern` from
   * `lib/cache.ts` directly in the route — the static-keys callback
   * here is the load-bearing common case, not the only one.
   *
   * Failure mode (Day-8 decision): errors from the callback or from
   * `cache.invalidate` are **logged and swallowed** — the mutation
   * already committed honestly, and propagating a 5xx for a
   * successful write would lie to the client AND leave them stuck
   * (their retry hits the `replayed` path which skips this callback,
   * so the cache stays stale either way). The cache self-heals via
   * TTL; the log line is the operator's signal. Day-20 routes this
   * through the observability seam so the signal reaches Sentry
   * rather than just stderr.
   */
  keysToInvalidate?: (body: T) => string[] | Promise<string[]>;
  /**
   * Day-10: post-commit Redis pattern wipes (`SCAN ... MATCH glob ...
   * UNLINK`). Used for range/window caches where a single write affects
   * many keys — `avail:{location}:*` is the canonical example: a
   * `bookings` INSERT changes the computed remaining capacity at
   * `(location, date)`, which invalidates every range cache that spans
   * that date.
   *
   * Same lifecycle as `keysToInvalidate`: post-commit, non-replay
   * outcomes only, errors logged + swallowed. Patterns are passed to
   * `invalidatePattern` from `lib/cache.ts` — a `SCAN` + batched
   * `UNLINK`, never `KEYS` (which blocks Redis).
   *
   * Callers should anchor patterns with an entity prefix
   * (`avail:fayetteville:*`, NOT `*`) — a global wildcard would drop
   * the wrong namespace. The cache module enforces this only by
   * convention; the §3 map in `lib/cache.ts` is the documentation-as-
   * contract.
   */
  patternsToInvalidate?: (body: T) => string[] | Promise<string[]>;
  /**
   * Day-14: post-commit side effect that ISN'T cache invalidation —
   * typically a third-party API call (Stripe detach, Stripe refund,
   * future R2 finalize, etc.) that the route wants to fire AFTER the DB
   * commit but BEFORE returning to the client. Same lifecycle as
   * `keysToInvalidate` / `patternsToInvalidate`:
   *
   *   - Fires **once** per non-replayed outcome (replay path skips it
   *     because the first call's effect already landed).
   *   - Failures are **logged + swallowed** — the DB commit is the
   *     source of truth; the side effect's reconciliation lives
   *     elsewhere (Stripe webhooks, retry workers, etc.).
   *   - Receives the response body so the callback can read server-
   *     generated state (newly-minted id, the location the mutation
   *     touched). Routes that need additional state (e.g. the cancel
   *     route's refund-PI handle, captured during the tx body) close
   *     over a local variable — the body parameter is the
   *     route-independent surface.
   *
   * Two production sites today (Day-14):
   *   1. `DELETE /payment-methods/:id` — `stripe.detachPaymentMethod`
   *   2. `POST /bookings/:id/cancel` — `stripe.createRefund` (closure-
   *      captured refund handle, fired conditionally on money-back
   *      branch).
   *
   * Adding a third site (Day-15 invoice-pay / setup_intent.succeeded
   * webhook) is "implement the callback" — no boilerplate copy.
   */
  postCommit?: (body: T) => Promise<void>;
}

/**
 * The single mutation entrypoint every audited write route composes around
 * (`schema.sql` Transaction contract notes, GLOBAL + IDEMPOTENCY). Wraps the
 * two cross-cutting invariants in dependency order so neither can be skipped:
 *
 *   withActor(actorOf(principal),         // stamps app.actor for audit_capture
 *     withIdempotency(claim,              // dedupes on Idempotency-Key
 *       fn))                              // your business logic
 *   → on success + !replayed: keysToInvalidate(body) → cache.invalidate(keys)
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
  params: MutationParams<T>,
  fn: (tx: Tx) => Promise<MutationResponse<T>>,
): Promise<IdempotencyOutcome<T>> {
  const outcome = await withActor(actorOf(params.principal), (tx) =>
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

  if (!outcome.replayed) {
    if (params.keysToInvalidate !== undefined) {
      try {
        const keys = await params.keysToInvalidate(outcome.body);
        await invalidateCacheKeys(keys);
      } catch (err) {
        // Mutation already committed — we do NOT propagate. See the
        // `keysToInvalidate` doc on MutationParams for the full rationale.
        // The log line is the only signal an operator gets until Day-20
        // wires the observability seam; keep it loud + contextual.
        process.stderr.write(
          `[withMutation] post-commit invalidate failed for ${params.endpoint} ` +
            `(idempotency_key=${params.idempotencyKey}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
      }
    }
    if (params.patternsToInvalidate !== undefined) {
      try {
        const patterns = await params.patternsToInvalidate(outcome.body);
        for (const pattern of patterns) {
          await invalidateCachePattern(pattern);
        }
      } catch (err) {
        // Same swallow-and-log semantic as exact-key invalidation. Pattern
        // wipes are an additional cleanup pass — the mutation committed
        // either way, and the SCAN-based wipe self-completes on retry
        // (the cache also self-heals via TTL).
        process.stderr.write(
          `[withMutation] post-commit pattern-invalidate failed for ${params.endpoint} ` +
            `(idempotency_key=${params.idempotencyKey}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
      }
    }
    if (params.postCommit !== undefined) {
      try {
        await params.postCommit(outcome.body);
      } catch (err) {
        // Day-14 seam: third-party API call (Stripe detach / refund /
        // ...) failed AFTER the DB commit. Same swallow-and-log policy
        // as cache invalidation — the DB is the source of truth; the
        // side effect reconciles via webhook (Day-15) or admin retry.
        // Day-20 will route this through the observability seam so
        // Sentry catches the drift.
        process.stderr.write(
          `[withMutation] post-commit side-effect failed for ${params.endpoint} ` +
            `(idempotency_key=${params.idempotencyKey}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
      }
    }
  }

  return outcome;
}
