import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

/**
 * Introspection-only config. `npm run db:introspect` (`drizzle-kit pull`)
 * reads the *already-loaded* `schema.sql` out of the live DB and writes a
 * typed table surface to `src/db/schema/`. Drizzle never generates or owns
 * migrations here (Day-0 lock #1 + #5): `schema.sql` is canonical, this only
 * mirrors it into TypeScript. The generated dir is committed (it is the typed
 * query surface) but lint/prettier-ignored (it is machine-authored).
 *
 * This is a build-time CLI tool, so it reads `DATABASE_URL` /
 * `DATABASE_SSL_CA` straight from the environment (dotenv) rather than the
 * app's Zod env module — drizzle-kit's own config loader can't resolve the
 * app's ESM specifiers, and the runtime env contract is not this tool's
 * concern.
 */
const sslCa = process.env.DATABASE_SSL_CA;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema',
  out: './src/db/schema',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
    ssl: sslCa ? { ca: readFileSync(sslCa, 'utf8'), rejectUnauthorized: true } : undefined,
  },
});
