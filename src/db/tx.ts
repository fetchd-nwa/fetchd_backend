import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { schema } from './client.js';
import { pool } from './pool.js';

/**
 * The Drizzle transaction handle every write runs on. Day 3's idempotency +
 * txn wrappers compose *around* `withActor` and hand this `tx` to repositories.
 * Read off a client-bound drizzle (`bindTo`), since the pool-bound `db` has no
 * `transaction` (O-POOLFIX-B); the handle is the same type either way.
 */
export type Tx = Parameters<Parameters<ReturnType<typeof bindTo>['transaction']>[0]>[0];

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
 * Transactions together hold at most `max − 1` of the pool's slots (O-POOLFIX fix 2; r2 Fable M1 = Opus L3).
 *
 * A transaction body that awaits a read on the pool (`db`, not its `tx`) needs two slots at once: the one its
 * transaction holds and one more for the read. With ten such bodies in flight (the pool's size) each held a slot
 * and waited for a slot only another waiter could free: nothing moved. Executed at the production entry, twelve
 * parallel `DELETE /events/:id/rsvp` from one signed-in owner did that — before fix 1 a permanent, silent wedge of
 * every route; with fix 1's checkout timeout a 10 s stall of every route, twelve 500s and twelve pages. Reserving
 * one slot that no transaction may take means a pool read (such a body's, `/health`'s, any route's) always finds a
 * slot within one statement's time, so the pool cannot deadlock on itself whatever a route does inside its
 * transaction. The reads the seats found are also moved onto `tx` (fix 2's second commit), and a test guard fails
 * any new one; this bound covers a route no test drives.
 *
 * A transaction that finds every slot taken waits for one, first come first served, at most as long as a checkout
 * waits for a connection (`pool.ts`'s `connectionTimeoutMillis`, 10 s), and then rejects with pg-pool's own text,
 * "timeout exceeded when trying to connect", so a route's 500, its page and its log read exactly as they do for an
 * exhausted pool. The wait is for the slot; the checkout that follows has its own 10 s bound, so in the worst case
 * (every non-transaction slot also held) a transaction waits for both in turn.
 *
 * The bound does not cover a transaction opened inside another transaction's body (it would hold a second slot
 * while its outer one waits): nine outers each opening one stall every transaction for the slot timeout. So one is
 * refused at once, before it takes a slot or a connection (`inTransaction`; O-POOLFIX-B, r3 Fable N5 = Opus N5).
 * A savepoint (`tx.transaction`) is not one: it runs on the outer's connection.
 */
/** Exported read-only for the tests' pool-hang kit (`test/contracts/_poolHang.ts`), so the two cannot drift. */
export const TRANSACTION_SLOTS = Math.max(1, (pool.options.max ?? 10) - 1);
let transactionsHolding = 0;
const transactionWaiters: Array<() => void> = [];

/** Takes a slot when one is free, synchronously. */
function takeTransactionSlot(): boolean {
  if (transactionsHolding >= TRANSACTION_SLOTS) return false;
  transactionsHolding += 1;
  return true;
}

/** Resolves once a releasing transaction hands this waiter its slot; rejects at the checkout timeout. */
function waitForTransactionSlot(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const waiter = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const waitMs = pool.options.connectionTimeoutMillis;
    if (waitMs) {
      timer = setTimeout(() => {
        const at = transactionWaiters.indexOf(waiter);
        if (at >= 0) transactionWaiters.splice(at, 1);
        reject(new Error('timeout exceeded when trying to connect'));
      }, waitMs);
      timer.unref();
    }
    transactionWaiters.push(waiter);
  });
}

/** Hands the slot straight to the longest waiter, or frees it. */
function releaseTransactionSlot(): void {
  const next = transactionWaiters.shift();
  if (next !== undefined) next();
  else transactionsHolding -= 1;
}

/**
 * One transaction on a client this module checks out, and releases on EVERY
 * path (O-POOLFIX fix 1), once it holds one of the transaction slots above
 * (fix 2).
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
 * Nothing a caller relies on changes: the statements are drizzle's — a plain
 * `begin` (no isolation level, as before), a savepoint per nested
 * `tx.transaction`, then `commit` or `rollback` — plus one `select 1` after the
 * body (fix 2, below), all on one connection, so a transaction-local
 * `set_config` and every `pg_advisory_xact_lock` (`locks.ts`) hold for exactly
 * the transaction, as before; and a rejection reaches the caller with the same
 * error drizzle threw. The one new rejection is the `select 1`'s, when the body
 * returned over an aborted transaction: that used to resolve as success.
 */
async function inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (openTransaction.getStore()?.open === true) {
    throw new Error(
      "a transaction was opened inside another transaction's body: it would hold a second pool slot while its outer " +
        'one waits (outside the max − 1 bound). Pass the outer tx, or use tx.transaction for a savepoint (src/db/tx.ts).',
    );
  }
  // A free transaction slot is taken synchronously, so the checkout below starts in this same tick (no await
  // before it) unless the transactions are all busy.
  if (!takeTransactionSlot()) await waitForTransactionSlot();
  const scope = { open: true };
  try {
    return await openTransaction.run(scope, () => onCheckedOutClient(fn));
  } finally {
    scope.open = false;
    releaseTransactionSlot();
  }
}

/**
 * Marks the async context of an open transaction, so `inTransaction` can refuse one opened inside it. The mark is
 * an object whose `open` goes false when its transaction ends, so work the body started that outlives it (a timer, a
 * fire-and-forget) may open a transaction afterwards.
 */
const openTransaction = new AsyncLocalStorage<{ open: boolean }>();

async function onCheckedOutClient<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let bodyFailed = false;
  let bodyError: unknown;
  let broken: Error | undefined;
  try {
    return await boundTo(client).transaction(async (tx) => {
      try {
        const result = await fn(tx);
        // A body that swallowed a statement's error has left the transaction aborted, and Postgres answers its
        // COMMIT with the command tag ROLLBACK and no error, so drizzle would resolve over a rollback and the caller
        // would answer 2xx with nothing written (O-POOLFIX r2, Opus L1 / Fable L3; executed under a query-cancel
        // stream on a live connection: 13 of 1,500). One statement after the body turns that into the caller's
        // error: an aborted transaction refuses it (25P02), drizzle rolls back, and the rejection reaches the caller
        // as the body's own (the connection is live, so the client goes back to the pool).
        await tx.execute(sql`select 1`);
        return result;
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
