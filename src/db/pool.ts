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

export async function pingDb(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
