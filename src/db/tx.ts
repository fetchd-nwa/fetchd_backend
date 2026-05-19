import { sql } from 'drizzle-orm';
import { db } from './client.js';

/**
 * The Drizzle transaction handle every write runs on. Day 3's idempotency +
 * txn wrappers compose *around* `withActor` and hand this `tx` to repositories.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 */
export async function withActor<T>(actor: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.actor', ${actor}, true)`);
    return fn(tx);
  });
}
