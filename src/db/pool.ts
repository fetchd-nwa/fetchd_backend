import pg from 'pg';
import { env } from '../env.js';

/**
 * The single `pg` connection pool. Drizzle is bound to this (see `client.ts`);
 * nothing else in the codebase constructs a Pool. Day-0 lock #3: the API owns
 * all data access over this pool with a privileged app role — no PostgREST,
 * no Supabase client SDK, no RLS.
 */
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

export async function pingDb(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
