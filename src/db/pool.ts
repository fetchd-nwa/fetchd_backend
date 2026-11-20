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
 *
 * `connectionTimeoutMillis` (O-POOLFIX fix 1): a checkout waits at most 10 s for
 * a slot, then rejects with "timeout exceeded when trying to connect"; a new
 * connection that cannot open within 10 s rejects with "Connection terminated
 * due to connection timeout" instead (O-POOLFIX r2 Fable N2, executed: both
 * `pool.query` and `withActor`, at 10,001 ms). A transaction that waits for one
 * of `tx.ts`'s transaction slots gives up at the same 10 s with the first text
 * (fix 2). Without it a pool whose 10 slots were all held waited
 * forever: every route hung, `/health` never answered, no request failed, so
 * nothing logged at level 50 and nothing paged (O-POOLFIX r1 H1, executed). With
 * it, exhaustion is a 500 that pages, and `/health` answers 503, each after the
 * 10 s wait.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: buildSsl(),
  connectionTimeoutMillis: 10_000,
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
 * as before, and neither listener touches it. The caller's error is one of
 * three texts, depending on where the loss lands (and two more come from the
 * 10 s bound above, not from a loss: "timeout exceeded when trying to connect"
 * for a slot or a transaction slot, "Connection terminated due to connection
 * timeout" for a connection that never opened — five in all):
 *   - "terminating connection due to administrator command" (57P01, the
 *     server's own error): the statement was in flight when the server ended
 *     the backend, e.g. a bare `pool.query`, or a transaction's BEGIN;
 *   - "Connection terminated unexpectedly": the socket closed under a statement
 *     already sent, e.g. a transaction killed mid-statement (`withActor`), whose
 *     caller gets its ROLLBACK's error on the dead client;
 *   - "Client has encountered a connection error and is not queryable": the
 *     client already knew its connection was gone when the statement was issued
 *     (a socket reset, or any loss between statements).
 *
 * The pool has no request in scope, so it logs as `withMutation` does
 * (`mutation.ts`): one tagged line written to stderr. It never passes through
 * pino, so it can never reach the level-50 pager tap (`server.ts`'s
 * `alarmForwardingHooks`). At most one line per lost connection: an idle
 * client's error reaches both listeners, and a checked-out one emits twice (the
 * server's error, then "Connection terminated unexpectedly" as the socket
 * closes), and only the first is written. Some losses write none, because the
 * client is gone before any `error` event: a `pool.query` whose statement took
 * the server's error (pg-pool releases the client with it and ends it), and a
 * transaction's client released with its error (`tx.ts`) before its socket's
 * close arrives, as when its BEGIN takes the server's 57P01. There the caller's
 * rejection is the signal, and a route's 500 pages.
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
