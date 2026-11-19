import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { db, schema } from './client.js';
import { pool } from './pool.js';

/**
 * The Drizzle transaction handle every write runs on. Day 3's idempotency +
 * txn wrappers compose *around* `withActor` and hand this `tx` to repositories.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Drizzle bound to ONE checked-out client: it neither checks a client out nor releases one. */
function bindTo(client: PoolClient) {
  return drizzle({ client, schema });
}

/**
 * One binding per pooled connection, made the first time that connection runs a
 * transaction and reused after (a pooled client lives across many checkouts;
 * building drizzle's relational config costs about 0.2 ms, measured). Weak, so
 * a client the pool destroys takes its binding with it.
 */
const bindings = new WeakMap<PoolClient, ReturnType<typeof bindTo>>();

function boundTo(client: PoolClient): ReturnType<typeof bindTo> {
  let bound = bindings.get(client);
  if (bound === undefined) {
    bound = bindTo(client);
    bindings.set(client, bound);
  }
  return bound;
}

/**
 * One transaction on a client this module checks out, and releases on EVERY
 * path (O-POOLFIX fix 1).
 *
 * Why not `db.transaction`: drizzle-orm 0.36.4 (`node-postgres/session.js`
 * `NodePgSession.transaction`) checks a client out of the pool and sends `begin`
 * BEFORE its `try { … } finally { release() }`. A BEGIN that meets a lost
 * connection — the server ended it in flight, or it died between checkout and
 * BEGIN — therefore never released its client: pg-pool counted it checked out
 * for good, and ten of them (the pool's size) wedged every route with no error
 * and no page (O-POOLFIX r1 H1, executed). Here the checkout, and so the
 * release, is ours: drizzle runs on the one client (bound to a client rather
 * than the pool, it does not release it), and the `finally` releases it
 * whatever happened, BEGIN included.
 *
 * The client goes back to the pool only when all of drizzle's own statements
 * answered: the transaction resolved (COMMIT answered), or it rejected with the
 * body's own error (so ROLLBACK answered). Any other rejection — BEGIN, COMMIT
 * or ROLLBACK failed — releases it WITH that error, and pg-pool destroys it
 * rather than hand out a connection in an unknown state. (pg-pool also destroys
 * a released client that is no longer queryable, whatever it is released with.)
 *
 * Nothing a caller relies on changes: the statements are drizzle's, unchanged —
 * a plain `begin` (no isolation level, as before), a savepoint per nested
 * `tx.transaction`, then `commit` or `rollback` — all on one connection, so a
 * transaction-local `set_config` and every `pg_advisory_xact_lock`
 * (`locks.ts`) hold for exactly the transaction, as before; and a rejection
 * reaches the caller with the same error drizzle threw.
 */
async function inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let bodyFailed = false;
  let bodyError: unknown;
  let broken: Error | undefined;
  try {
    return await boundTo(client).transaction(async (tx) => {
      try {
        return await fn(tx);
      } catch (err) {
        bodyFailed = true;
        bodyError = err;
        throw err;
      }
    });
  } catch (err) {
    if (!bodyFailed || err !== bodyError) {
      broken = err instanceof Error ? err : new Error(String(err));
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * The per-transaction actor primitive — the load-bearing Day-2 deliverable
 * that Day 3+ builds directly on. Opens a transaction, stamps `app.actor`
 * **transaction-locally**, then runs `fn` on that same connection.
 *
 * Why this exact shape:
 * - `set_config(name, value, is_local => true)` is the parameterized form of
 *   `SET LOCAL`. The actor is a **bound parameter**, never interpolated — an
 *   attacker-controlled id can't break out of the GUC.
 * - `is_local = true` scopes it to this transaction, so it cannot bleed across
 *   pooled connections. This is exactly why Day-0 lock #3 mandates the direct/
 *   session connection (5432), never the txn pooler (6543).
 * - It is set as the first statement, so every subsequent write in `fn` —
 *   and every `audit_capture` AFTER-trigger it fires — reads the right actor
 *   via `current_setting('app.actor', true)`. Skip this and the audit trail
 *   records a NULL actor. There is no write path that legitimately bypasses it.
 *
 * `actor` is the `<kind>:<id>` string from `actorOf(principal)` (or a system
 * actor for Day-2b's webhook / Day-16's workers).
 *
 * The transaction's client is checked out and released by {@link inTransaction},
 * on every path, BEGIN included (O-POOLFIX fix 1).
 */
export async function withActor<T>(actor: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(async (tx) => {
    await tx.execute(sql`select set_config('app.actor', ${actor}, true)`);
    return fn(tx);
  });
}

/**
 * A transaction with no actor, for a read that needs a transaction's locks and
 * writes nothing: `refundProposal` (`staffRefunds.ts`) reads under the charge's
 * row lock. Every WRITE goes through {@link withActor}; a write here would
 * audit a NULL actor. Its client is released on every path, as `withActor`'s is.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(fn);
}
