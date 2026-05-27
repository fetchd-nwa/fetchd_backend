import { eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import { ApiError } from '../lib/errors.js';
import { idempotencyKeys } from './schema/schema.js';
import type { Tx } from './tx.js';

/**
 * One bound mutation request, all four fields are part of the dedupe identity.
 * `endpoint` is the canonical `METHOD path` (e.g. `'PATCH /me'`) so the same
 * key can't be reused across routes; `requestHash` is the canonical-JSON SHA
 * of the body so the same key on the same route can't be reused with a
 * different payload (defense against client-side bugs that recycle keys).
 */
export interface IdempotencyClaim {
  key: string;
  ownerId: string | null;
  endpoint: string;
  requestHash: string;
}

/**
 * What every mutation route's transactional `fn` returns: the HTTP status the
 * client should see + the JSON body. Status is stored so a replay restores it
 * exactly — not every successful mutation is a 200 (POST creates → 201, async
 * accept → 202), and a retry must return the same status the first call did.
 */
export interface MutationResponse<T> {
  status: number;
  body: T;
}

export interface IdempotencyOutcome<T> extends MutationResponse<T> {
  /** True when this request returned a stored response (no work re-executed). */
  replayed: boolean;
}

/**
 * Transport-layer mutation dedupe (`schema.sql` Transaction contract notes,
 * IDEMPOTENCY; `idempotency_keys` table). Every mutating endpoint composes
 * around this — clients retry on network drop, the API guarantees the work
 * runs at most once per Idempotency-Key.
 *
 * Three states, decided atomically:
 *
 *  1. **First arrival.** Atomic claim: `INSERT ... ON CONFLICT (key) DO
 *     NOTHING RETURNING key`. If a row is returned we own the key; run `fn`,
 *     then `UPDATE` the row with the response. Two concurrent retries with
 *     the same key cannot both win — Postgres serializes the INSERTs and the
 *     loser sees no RETURNING row.
 *
 *  2. **Completed already.** Existing row, `completed_at IS NOT NULL`. If the
 *     `(endpoint, request_hash)` match, replay the stored `response_status` /
 *     `response_body` without re-executing. If they don't match the client
 *     reused the key for a different request — `idempotency_mismatch` (422).
 *
 *  3. **Still in flight.** Existing row, `completed_at IS NULL` — another
 *     request with this key is mid-execution. `idempotency_inflight` (409).
 *     Returns to the client; the in-flight call will complete or roll back on
 *     its own.
 *
 * **Errors roll back the entire transaction**, including the idempotency row
 * itself. A retry therefore re-attempts the work rather than replaying the
 * error — correct for transient failures, and permanent failures (a 422
 * validation error) are deterministic for a given body so the retry sees the
 * same outcome. We do NOT cache error responses (the schema's contract is
 * "set the response + completed_at" on success — no mention of error storage,
 * and the simpler shape is the one that actually fits the schema's text).
 */
export async function withIdempotency<T>(
  tx: Tx,
  claim: IdempotencyClaim,
  fn: () => Promise<MutationResponse<T>>,
): Promise<IdempotencyOutcome<T>> {
  const won = await tx
    .insert(idempotencyKeys)
    .values({
      key: claim.key,
      ownerId: claim.ownerId,
      endpoint: claim.endpoint,
      requestHash: claim.requestHash,
    })
    .onConflictDoNothing({ target: idempotencyKeys.key })
    .returning({ key: idempotencyKeys.key });

  if (won.length === 0) {
    const [existing] = await tx
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, claim.key))
      .limit(1);
    if (!existing) {
      // Lost the INSERT race and then the row vanished before our SELECT.
      // The TTL sweep is the only thing that deletes; the window is the slice
      // between two statements in this transaction. Vanishingly rare, and a
      // retry from the client resolves it cleanly.
      throw new ApiError(
        'ambiguous_principal',
        'idempotency row vanished mid-resolve (retry the request)',
      );
    }
    if (existing.endpoint !== claim.endpoint || existing.requestHash !== claim.requestHash) {
      throw new ApiError('idempotency_mismatch', 'Idempotency-Key reused with a different request');
    }
    if (existing.completedAt === null) {
      throw new ApiError(
        'idempotency_inflight',
        'a request with this Idempotency-Key is still in progress',
      );
    }
    return {
      status: existing.responseStatus ?? 200,
      body: existing.responseBody as T,
      replayed: true,
    };
  }

  const response = await fn();

  await tx
    .update(idempotencyKeys)
    .set({
      responseStatus: response.status,
      responseBody: response.body as unknown,
      completedAt: sql`now()`,
    })
    .where(eq(idempotencyKeys.key, claim.key));

  return { ...response, replayed: false };
}

/**
 * Pool-level peek for a completed idempotency record. Day-15 addition —
 * routes whose pre-validation depends on state that the mutation itself
 * mutates (`POST /invoices/:id/pay` flips invoice → 'paid'; a replay's
 * pre-validation would see 'paid' and 409 BEFORE the idempotency layer
 * could replay the original 201) call this FIRST, replay if found,
 * else continue normally.
 *
 * Returns the stored response (with `replayed: true`) when a completed
 * record exists for the given key + endpoint + body hash. Returns
 * undefined for:
 *   - Key never seen (first arrival — caller proceeds normally).
 *   - Key seen but `completed_at IS NULL` (in-flight elsewhere — the
 *     `withIdempotency` claim path will throw `idempotency_inflight` on
 *     this attempt; the peek just defers to the claim).
 *
 * Throws `idempotency_mismatch` when the key matches but `endpoint` /
 * `requestHash` differ — same semantic as `withIdempotency`'s mismatch
 * path; surfaces a client bug at the boundary rather than letting the
 * route proceed against stale state.
 */
export async function peekCompletedIdempotency<T>(
  key: string,
  endpoint: string,
  requestHash: string,
): Promise<IdempotencyOutcome<T> | undefined> {
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  if (!existing) return undefined;
  if (existing.endpoint !== endpoint || existing.requestHash !== requestHash) {
    throw new ApiError('idempotency_mismatch', 'Idempotency-Key reused with a different request');
  }
  if (existing.completedAt === null) return undefined;
  return {
    status: existing.responseStatus ?? 200,
    body: existing.responseBody as T,
    replayed: true,
  };
}
