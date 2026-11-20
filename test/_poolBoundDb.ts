import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { db as appDb, type schema } from '../src/db/client.js';

/**
 * Tests only: the app's pool-bound `db`, typed WITH `transaction`.
 *
 * `src/db/client.ts` types `db` without `transaction`, so no route can open a transaction that skips `tx.ts`'s
 * release-on-every-path and its slot bound (O-POOLFIX-B; r3 Opus N1 = Fable NB1). A test that holds a transaction of
 * its own (a lock it keeps, a fixture written in one) still may. This is the same object, re-typed, so nothing about
 * what such a test runs changes.
 */
export const db = appDb as NodePgDatabase<typeof schema> & { $client: Pool };
