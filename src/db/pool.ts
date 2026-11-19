import { readFileSync } from 'node:fs';
import pg from 'pg';
import { env } from '../env.js';

/**
 * TLS config. Supabase's direct connection presents a cert signed by
 * Supabase's own CA, which is not in Node's default trust store — verifying
 * against that CA (rather than disabling verification) is the only secure
 * option and is also correct for prod. `rejectUnauthorized` stays true: we
 * verify the chain, we just teach Node which CA to trust. When no CA is
 * configured (bare local Postgres), TLS is left off entirely.
 */
function buildSsl() {
  if (!env.DATABASE_SSL_CA) return undefined;
  return { ca: readFileSync(env.DATABASE_SSL_CA, 'utf8'), rejectUnauthorized: true };
}

/**
 * The single `pg` connection pool. Drizzle is bound to this (see `client.ts`);
 * nothing else in the codebase constructs a Pool. Day-0 lock #3: the API owns
 * all data access over this pool with a privileged app role — no PostgREST,
 * no Supabase client SDK, no RLS.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: buildSsl(),
});

/**
 * A pooled connection that dies is a warn: never a crash, never a page (O-MSG-LIVE
 * p2a fix 1; brief LR5, "nothing un-awaited can exit the process").
 *
 * When the server closes a connection (Supabase restarts, fails over, or reaps
 * it), node-postgres emits `error` on the CLIENT, and pg-pool re-emits it on the
 * POOL when that client sat idle. An `error` event nobody listens to is an
 * uncaught exception, and the process exits 1 (executed: the p2a audit's pool
 * probe, exit 1 within 6 ms of `pg_terminate_backend`). So two listeners:
 *   - the pool's, for an idle client: pg-pool has already dropped it, and the
 *     next query opens a fresh connection;
 *   - every client's own, attached as it connects and never removed, for a
 *     client checked out at the time (a transaction, idle between statements or
 *     with a statement running), which pg-pool's idle listener does not cover.
 * A query running when its connection dies still rejects to its caller exactly
 * as before, and neither listener touches it: a bare query fails with the
 * server's error (57P01), and a drizzle transaction (`withActor`) with
 * "Connection terminated unexpectedly", its rollback's error on the dead client.
 *
 * The pool has no request in scope, so it logs as `withMutation` does
 * (`mutation.ts`): one tagged line written to stderr. It never passes through
 * pino, so it can never reach the level-50 pager tap (`server.ts`'s
 * `alarmForwardingHooks`). One line per lost connection: an idle client's error
 * reaches both listeners, and a checked-out one emits twice (the server's error,
 * then "Connection terminated unexpectedly" as the socket closes).
 */
const reportedClients = new WeakSet<object>();

function warnConnectionLost(client: object, err: Error): void {
  if (reportedClients.has(client)) return;
  reportedClients.add(client);
  const code = (err as { code?: unknown }).code;
  const reason = `${typeof code === 'string' ? `${code} ` : ''}${err.message}`.replace(/\s+/g, ' ');
  try {
    process.stderr.write(
      `[pool] warn: a postgres connection was lost (${reason}); the pool opens a fresh one on the next query\n`,
    );
  } catch {
    // stderr is gone; the pool recovers without the line.
  }
}

pool.on('error', (err, client) => warnConnectionLost(client, err));
pool.on('connect', (client) => {
  client.on('error', (err) => warnConnectionLost(client, err));
});

export async function pingDb(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
