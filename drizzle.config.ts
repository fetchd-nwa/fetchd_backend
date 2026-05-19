import { defineConfig } from 'drizzle-kit';
import { env } from './src/env.js';

/**
 * Introspection-only config. `npm run db:introspect` (`drizzle-kit pull`)
 * reads the *already-loaded* `schema.sql` out of the live DB and writes a
 * typed table surface to `src/db/schema/`. Drizzle never generates or owns
 * migrations here (Day-0 lock #1 + #5): `schema.sql` is canonical, this only
 * mirrors it into TypeScript. The generated dir is committed (it is the typed
 * query surface) but lint/prettier-ignored (it is machine-authored).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema',
  out: './src/db/schema',
  dbCredentials: { url: env.DATABASE_URL },
});
