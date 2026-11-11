import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
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
 *     `(owner_id, endpoint, request_hash)` match, replay the stored `response_status` /
 *     `response_body` without re-executing. If they don't match the key was reused
 *     for a different request, or by another principal — `idempotency_mismatch` (422).
 *
 *  3. **Still in flight.** Existing row, `completed_at IS NULL`, the same request —
 *     another request with this key is mid-execution. `idempotency_inflight` (409).
 *     Returns to the client; the in-flight call will complete or roll back on
 *     its own.
 *
 * **Errors roll back the entire transaction**, including the idempotency row
 * itself. A retry therefore re-attempts the work rather than replaying the
 * error — correct for transient failures, and permanent failures (a 422
 * validation error) are deterministic for a given body so the retry sees the
 * same outcome. Nothing here stores an error.
 *
 * **The order engine is the one exception, and it does not run through here**
 * (P15, design §2.7:3939-3944). Its claim outlives the transaction that made it, so
 * it uses the two halves below: {@link claimIdempotencyKey} in tx1, and
 * {@link completeOrderClaim} from whichever step settles the order, days later if
 * Stripe says so. Its final answer may be the committed 402 `payment_failed`, stored
 * as the envelope `auth/plugin.ts` sends, so a replay returns the same 402 and no
 * card is tried. A same-key request that finds the claim open answers 409
 * `idempotency_inflight`, and a retry never creates a second order or intent.
 */
export async function withIdempotency<T>(
  tx: Tx,
  claim: IdempotencyClaim,
  fn: () => Promise<MutationResponse<T>>,
): Promise<IdempotencyOutcome<T>> {
  const claimed = await claimIdempotencyKey<T>(tx, claim);
  if (!claimed.won) return claimed.stored;

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

/** The claim half: this request owns the key, or here is what the key answers. */
export type IdempotencyClaimResult<T> =
  | { won: true }
  | { won: false; stored: IdempotencyOutcome<T> };

/**
 * Decide the three states of {@link withIdempotency}, and leave the row open if this
 * request won. Throws `idempotency_mismatch` and `idempotency_inflight`.
 */
export async function claimIdempotencyKey<T>(
  tx: Tx,
  claim: IdempotencyClaim,
): Promise<IdempotencyClaimResult<T>> {
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
    if (!sameRequest(existing, claim)) throw mismatch();
    if (existing.completedAt === null) throw inflight();
    return {
      won: false,
      stored: {
        status: existing.responseStatus ?? 200,
        body: existing.responseBody as T,
        replayed: true,
      },
    };
  }
  return { won: true };
}

/** How long an OPEN claim survives the sweep (design §2.7:3946-3948): well past any
 *  processing hold, so a same-key retry can never start a second order. */
export const IDEMPOTENCY_OPEN_CLAIM_MAX_DAYS = 7;

function inflight(): ApiError {
  return new ApiError(
    'idempotency_inflight',
    'a request with this Idempotency-Key is still in progress',
  );
}

function mismatch(): ApiError {
  return new ApiError('idempotency_mismatch', 'Idempotency-Key reused with a different request');
}

/**
 * Is this the request the key was claimed for? The same principal first: a key is the
 * owner's who made it (`owner_id`, NULL for every staff principal, so a staff route's
 * keys answer staff), and another household presenting it, even with the very body the
 * first sent, learns nothing of the first answer, not even that it is still running (P19
 * fix 1, F1; P15 Opus L7's class, which `/invoices/:id/pay` closed with its own ownership
 * 404). Then the same route and the same body, as always.
 */
function sameRequest(
  existing: { ownerId: string | null; endpoint: string; requestHash: string },
  request: { ownerId: string | null; endpoint: string; requestHash: string },
): boolean {
  return (
    existing.ownerId === request.ownerId &&
    existing.endpoint === request.endpoint &&
    existing.requestHash === request.requestHash
  );
}

/** Name the order on the claim that opened it, in tx1. */
export async function attachOrderToClaim(
  tx: Tx,
  args: { key: string; orderId: string },
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ orderId: args.orderId })
    .where(eq(idempotencyKeys.key, args.key));
}

/**
 * Record an order's final answer on its open claim, from whichever step settles the
 * order: the settle transaction, the webhook arm, the sweeper, a *Cancel order*.
 * Only an open claim is touched, so the first settler's answer stands. Nothing to
 * complete is a no-op: the sweep removed the claim (`IDEMPOTENCY_OPEN_CLAIM_MAX_DAYS`),
 * or no claim was ever open. It logs one line naming the order, and the money commits.
 */
export async function completeOrderClaim<T>(
  tx: Tx,
  args: {
    orderId: string;
    status: number;
    body: T;
    log: { info(obj: Record<string, unknown>, msg?: string): void };
  },
): Promise<void> {
  const completed = await tx
    .update(idempotencyKeys)
    .set({
      responseStatus: args.status,
      responseBody: args.body as unknown,
      completedAt: sql`now()`,
    })
    .where(and(eq(idempotencyKeys.orderId, args.orderId), isNull(idempotencyKeys.completedAt)))
    .returning({ key: idempotencyKeys.key });
  if (completed.length === 0) {
    args.log.info(
      { orderId: args.orderId, status: args.status },
      'no open claim to complete for this order: a re-send cannot replay it',
    );
  }
}

/** The stored answer on a key, read on the pool. `undefined`: none yet. */
export async function readCompletedClaim<T>(key: string): Promise<MutationResponse<T> | undefined> {
  const [row] = await db
    .select({
      completedAt: idempotencyKeys.completedAt,
      responseStatus: idempotencyKeys.responseStatus,
      responseBody: idempotencyKeys.responseBody,
    })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  if (row === undefined || row.completedAt === null) return undefined;
  return { status: row.responseStatus ?? 200, body: row.responseBody as T };
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
 * `requestHash` differ, or another principal made it (`ownerId`: the caller's
 * owner id, `null` for staff) — same semantic as `withIdempotency`'s mismatch
 * path; surfaces a client bug at the boundary rather than letting the
 * route proceed against stale state, and runs before any of a route's
 * pre-transaction money work.
 */
export async function peekCompletedIdempotency<T>(
  key: string,
  endpoint: string,
  requestHash: string,
  ownerId: string | null,
): Promise<IdempotencyOutcome<T> | undefined> {
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  if (!existing) return undefined;
  if (!sameRequest(existing, { ownerId, endpoint, requestHash })) throw mismatch();
  if (existing.completedAt === null) return undefined;
  return {
    status: existing.responseStatus ?? 200,
    body: existing.responseBody as T,
    replayed: true,
  };
}

/**
 * {@link peekCompletedIdempotency} for a route on the order engine. Its claim stays
 * open for as long as the order does, so an open claim is not a request about to race
 * this one but a real answer: 409 `idempotency_inflight`, before any pre-validation
 * can answer for a state the open order is itself changing.
 */
export async function peekEngineClaim<T>(
  key: string,
  endpoint: string,
  requestHash: string,
  ownerId: string,
): Promise<IdempotencyOutcome<T> | undefined> {
  // A stored answer is the owner's who made it: another owner's key reads as absent.
  const [claim] = await db
    .select({ ownerId: idempotencyKeys.ownerId })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  if (claim?.ownerId !== ownerId) return undefined;
  const stored = await peekCompletedIdempotency<T>(key, endpoint, requestHash, ownerId);
  if (stored !== undefined) return stored;
  const [open] = await db
    .select({ key: idempotencyKeys.key })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key), isNull(idempotencyKeys.completedAt)))
    .limit(1);
  if (open !== undefined) throw inflight();
  return undefined;
}

/**
 * Amend the STORED response of an already-completed idempotency record
 * (2026-08-20, manual-capture enrollments).
 *
 * `withIdempotency` stores the response at COMMIT time, which is the honest
 * moment for every mutation whose truth is complete at commit. Manual capture
 * introduces one that isn't: `POST /enrollments` commits the enrollment and
 * then captures each dog's authorization, so the body stored in-tx says
 * `payment_state: 'pending'` and `total_captured_cents: 0` for money that moves
 * a few hundred milliseconds later. Without this, a client that retried after
 * the capture would replay a body claiming nothing had been charged while the
 * charge rows said otherwise — a replay that is *less* true than the original
 * response, which defeats the point of storing one.
 *
 * Deliberately narrow, because this rewrites the record a client's retry is
 * answered from:
 *   - Only a row that is **already completed** is touched. An in-flight claim
 *     belongs to the request executing under it.
 *   - `endpoint` + `requestHash` must match, same as `peekCompletedIdempotency`
 *     — a key that has since been reused for a different request is a client
 *     bug and must not have its record overwritten by this one.
 *   - The **status is not changed.** 201 stays 201. Capture completing does
 *     not change what happened; it changes what is true about the money.
 *
 * Pool runner: this fires post-commit, outside the request transaction, and
 * must not be able to roll back the enrollment it is describing. Returns
 * whether a row was amended, so the caller can log the miss rather than assume.
 */
export async function updateStoredResponse<T>(args: {
  key: string;
  endpoint: string;
  requestHash: string;
  body: T;
}): Promise<boolean> {
  const updated = await db
    .update(idempotencyKeys)
    .set({ responseBody: args.body as unknown })
    .where(
      and(
        eq(idempotencyKeys.key, args.key),
        eq(idempotencyKeys.endpoint, args.endpoint),
        eq(idempotencyKeys.requestHash, args.requestHash),
        isNotNull(idempotencyKeys.completedAt),
      ),
    )
    .returning({ key: idempotencyKeys.key });
  return updated.length > 0;
}

/**
 * TTL sweep for `idempotency_keys`. The ONE schema table exempt from
 * never-delete: rows older than the retry-safety window get pruned
 * (schema.sql lines ~918-920). Day-16 scheduler composition wires this
 * into the recurring tick.
 *
 * Two windows since P15 (design §2.7:3945-3948), because an open claim is no longer
 * always a request about to finish: one whose charge is processing is the only record
 * of an order a same-key retry must not start again. A completed claim goes 24h after
 * it COMPLETED, not after it was opened, so a claim that sat open for three days still
 * answers a replay of its final answer. An open one goes at 7 days, well past any
 * processing hold. The caller holds both constants.
 *
 * Pool runner by design: this is maintenance, not part of a request tx.
 * A failed sweep is logged-and-swallowed by the scheduler (the next tick
 * retries; one missed sweep is benign).
 */
export async function sweepExpiredIdempotencyKeys(args: {
  completedBefore: Date;
  openBefore: Date;
}): Promise<number> {
  const deleted = await db
    .delete(idempotencyKeys)
    .where(
      or(
        lt(idempotencyKeys.completedAt, args.completedBefore.toISOString()),
        and(
          isNull(idempotencyKeys.completedAt),
          lt(idempotencyKeys.createdAt, args.openBefore.toISOString()),
        ),
      ),
    )
    .returning({ key: idempotencyKeys.key });
  return deleted.length;
}
