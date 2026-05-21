import fs from 'node:fs';
import path from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { registerAuth } from '../../src/auth/plugin.js';
import type { Principal } from '../../src/auth/principal.js';
import { closeRedis, redis } from '../../src/redis.js';
import { FIXTURE_IDS, seedFixture, teardownFixture } from './_fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The fixture owner — the Principal every owner-scoped contract test runs
 * as. Extracted so a test file says `makeContractApp(FIXTURE_OWNER_PRINCIPAL)`
 * instead of re-typing the kind/ids/uid trio in every test case. Frozen as
 * `const` so a stray `principal.kind = 'staff'` mutation in a test would
 * fail to compile.
 */
export const FIXTURE_OWNER_PRINCIPAL: Principal = {
  kind: 'owner',
  ownerId: FIXTURE_IDS.ownerId,
  supabaseUid: FIXTURE_IDS.ownerSupabaseUid,
};

/**
 * The fixture staff trainer (Donavan), for tests that exercise the
 * staff-principal branch (owner endpoints return [] / 404 to staff).
 */
export const FIXTURE_STAFF_PRINCIPAL: Principal = {
  kind: 'staff',
  staffId: FIXTURE_IDS.staffDonavanId,
  role: 'trainer',
  supabaseUid: FIXTURE_IDS.staffDonavanSupabaseUid,
};

/**
 * `true` when DATABASE_URL is set — every contract test that hits the DB
 * is gated on this. Reads `process.env` once at import time (the test
 * runner doesn't toggle env vars mid-run).
 */
const DB_CONFIGURED = typeof process.env.DATABASE_URL === 'string';

/**
 * Pass to `test(name, SKIP_WHEN_NO_DB, fn)` so a contract test gracefully
 * skips when no DB is configured rather than failing on the first import
 * of `db/client.js` (which would tank the entire file's results).
 */
export const SKIP_WHEN_NO_DB: { skip: false | string } = DB_CONFIGURED
  ? { skip: false }
  : { skip: 'DATABASE_URL not set' };

/**
 * Register before/after hooks against the calling test file's root test
 * context. node:test scopes top-level hooks to the file that imports the
 * `before`/`after` symbol — calling them from this helper still attaches
 * to the test file that invoked `registerFixtureHooks()`, because the
 * test runtime tracks the active test by execution stack, not by import
 * site. Each contract test file calls this exactly once at module load.
 *
 * Day-8 addition: each `seedFixture` flushes the test Redis DB so a
 * stale cache entry from a prior run can't survive a fixture re-seed
 * (the FE cache validator catches shape drift, not value drift).
 * `npm test` points REDIS_URL at DB 1, so this only ever wipes the
 * test partition.
 *
 * No-ops when no DB is configured (the tests skip individually).
 */
export function registerFixtureHooks(): void {
  if (!DB_CONFIGURED) return;
  before(async () => {
    await redis.flushdb();
    await seedFixture();
  });
  after(async () => {
    await teardownFixture();
    // Node 25's `--test-isolation=process` default spawns one subprocess
    // per test file. The ioredis socket keeps THIS subprocess's event
    // loop alive after the tests finish, so node:test can't exit
    // cleanly. Closing here is local to this subprocess.
    await closeRedis();
  });
}

/**
 * Build a Fastify app with the live `registerAuth` error mapper but a stubbed
 * `authenticate` that pins `request.principal` to the fixture identity. The
 * contract tests exercise the real request → handler → response path against
 * the live DB; the only thing stubbed is the JWKS verifier (its job is
 * confirmed end-to-end in `auth.test.ts` already).
 *
 * Wire shape under test:
 *   const { app, authenticate } = makeContractApp(principal);
 *   registerDogsRoute(app, { authenticate, now: FIXTURE_NOW });
 *   const res = await app.inject({ method: 'GET', url: '/dogs' });
 */
export interface ContractApp {
  app: FastifyInstance;
  authenticate: preHandlerHookHandler;
}

export function makeContractApp(principal: Principal): ContractApp {
  // Logger on so unhandled errors surface on stderr — the default `Fastify()`
  // silently swallows them and the test only sees a 500. Disable noisy
  // request-log lines; we want errors only.
  const app = Fastify({ logger: { level: 'error' } });
  registerAuth(app);
  const authenticate: preHandlerHookHandler = async (request) => {
    request.principal = principal;
  };
  return { app, authenticate };
}

/**
 * Load a snapshot JSON file from `test/contracts/snapshots/<name>.json`. The
 * snapshot is the frozen wire shape; `deepStrictEqual` against the inject()
 * response body is the regression net (DATA-CONTRACT §B's "byte-match"
 * intent — semantically equivalent JSON, not literal byte equality, since
 * JSON consumers ignore object-key order).
 */
export function loadSnapshot(name: string): unknown {
  const file = path.join(__dirname, 'snapshots', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
