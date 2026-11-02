import type pg from 'pg';

/**
 * `withActor` for a connection the caller owns (design §2.1:1979-1980,
 * r3-opus #6): opens a transaction on `client`, stamps `app.actor`
 * transaction-locally as its first statement, runs `fn` on that same
 * connection, and commits — or rolls back and rethrows. Every `audit_capture`
 * row the work fires records `actor`, which STAFF-74 requires.
 *
 * Its own module, not `db/tx.ts` as the design places it: `tx.ts` imports the
 * shared pool, which loads `src/env.ts` — and `npm run staff:provision`, its
 * one caller, must never load `src/env.ts` (it reads three variables only).
 */
export async function withActorOn<T>(
  client: pg.ClientBase,
  actor: string,
  fn: (client: pg.ClientBase) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.actor', $1, true)", [actor]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
