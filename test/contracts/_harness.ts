import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inArray, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { registerAuth } from '../../src/auth/plugin.js';
import type { Principal } from '../../src/auth/principal.js';
import { db } from '../../src/db/client.js';
import { dogs, owners, threads } from '../../src/db/schema/schema.js';
import { closeRedis, redis } from '../../src/redis.js';
import { assertNoPoolReadInTransaction, installPoolReadGuard } from './_poolReadGuard.js';
import {
  FIXTURE_IDS,
  seedFixture,
  setRequestServicesOffered,
  teardownFixture,
} from './_fixture.js';

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
 * The fixture manager (Amber, P02; design §2.1:1961-1968) — owner and manager
 * pass the role-gated routes (`requireStaffRole('owner', 'manager')`) and edit
 * `money`-class settings; the trainer above does neither. A real row, so the
 * guards and `GET /me` (which reads the row) agree.
 */
export const FIXTURE_MANAGER_PRINCIPAL: Principal = {
  kind: 'staff',
  staffId: FIXTURE_IDS.staffAmberId,
  role: 'manager',
  supabaseUid: FIXTURE_IDS.staffAmberSupabaseUid,
};

/**
 * The fixture owner ROLE (Shanthi, P02) — a staff principal, not a family:
 * the one role that edits `roles`-class settings (the five lists, the idle
 * minutes) and passes every list whatever it holds (STAFF-09).
 */
export const FIXTURE_OWNER_ROLE_PRINCIPAL: Principal = {
  kind: 'staff',
  staffId: FIXTURE_IDS.staffShanthiId,
  role: 'owner',
  supabaseUid: FIXTURE_IDS.staffShanthiSupabaseUid,
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
 * O-POOLFIX fix 2: it also installs the pool-read guard (`_poolReadGuard.ts`):
 * a test whose route reads on the pool inside its own transaction fails
 * (`afterEach`), and so does the file for one recorded in a hook (`after`).
 *
 * No-ops when no DB is configured (the tests skip individually).
 */
export function registerFixtureHooks(): void {
  if (!DB_CONFIGURED) return;
  installPoolReadGuard();
  afterEach(() => {
    assertNoPoolReadInTransaction('this test');
  });
  before(async () => {
    await redis.flushdb();
    await seedFixture();
  });
  after(async () => {
    // Always close Redis even if teardownFixture throws. ioredis keeps a
    // live socket that pins the subprocess event loop; if teardown
    // bubbles before closeRedis runs, the process hangs indefinitely
    // (earned 2026-05-26 — a Day-13 FK violation in teardown left the
    // booking-cancel subprocess alive for 2h+ instead of failing
    // cleanly). try/finally guarantees the close.
    try {
      await teardownFixture();
    } finally {
      // Node 25's `--test-isolation=process` default spawns one subprocess
      // per test file. The ioredis socket keeps THIS subprocess's event
      // loop alive after the tests finish, so node:test can't exit
      // cleanly. Closing here is local to this subprocess.
      await closeRedis();
    }
    assertNoPoolReadInTransaction("this file's hooks");
  });
}

/**
 * A test file that posts a request calls this once at module load (P13 ruling
 * (f)): `before` switches boarding, board-and-train and private lessons on, so
 * `POST /requests` never answers `service_not_offered` for a reason the test is not
 * about. The one door is `setRequestServicesOffered`, and `after` switches all three
 * off again. That is not the seed since M5.24 (P49), which offers lessons and Board &
 * Train: it is a fixed state the next suite starts from.
 */
export function registerRequestServicesOn(): void {
  if (!DB_CONFIGURED) return;
  before(async () => {
    await setRequestServicesOffered(true);
  });
  after(async () => {
    await setRequestServicesOffered(false);
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

/**
 * Collect every log line a route emits, so a test can assert on logging that is
 * itself the product behavior — an operator-facing alarm no HTTP response
 * carries. `lines` are the parsed pino records (`level` 60 = fatal, 50 = error,
 * 40 = warn).
 */
export interface LogCapture {
  lines: Array<Record<string, unknown>>;
  stream: { write(msg: string): void };
}

export function makeLogCapture(): LogCapture {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    stream: {
      write(msg: string): void {
        // pino writes one NDJSON record per call; a non-JSON line would be a
        // transport misconfiguration and should fail the test loudly.
        lines.push(JSON.parse(msg) as Record<string, unknown>);
      },
    },
  };
}

export function makeContractApp(principal: Principal, capture?: LogCapture): ContractApp {
  // Logger on so unhandled errors surface on stderr — the default `Fastify()`
  // silently swallows them and the test only sees a 500. Disable noisy
  // request-log lines; we want errors only. A `capture` swaps the destination
  // and drops the level floor so a test can assert on the records themselves.
  const app =
    capture === undefined
      ? Fastify({ logger: { level: 'error' } })
      : Fastify({ logger: { level: 'trace', stream: capture.stream } });
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

// ── messaging (plan unit P45 with O-MSG-LIVE) ────────────────────────────────

/**
 * The school's system row, *NWA School for Dogs* (rs3 M5.26): the participant of every
 * school-addressed thread. `schema.sql` inserts it, so every database the suite runs on holds
 * it from its load; the harness READS it and never inserts it (brief CR8), and the fixture's
 * teardown deletes staff by id, never this row. Exactly one live row, or the load is wrong.
 */
export async function readSchoolAccount(): Promise<{ id: string; name: string }> {
  const { rows } = await db.execute<{ id: string; name: string }>(
    sql`SELECT id::text AS id, name FROM staff WHERE is_system_account AND expired_at IS NULL`,
  );
  if (rows.length !== 1) {
    throw new Error(
      `expected one live system staff row (schema.sql's M5.26 row), found ${rows.length}: reload the test database from schema.sql`,
    );
  }
  return rows[0] as { id: string; name: string };
}

/** A second family for the stranger cases (B's thread, B's dog), removed by `removeFamilies`. */
export interface PlantedFamily {
  principal: Extract<Principal, { kind: 'owner' }>;
  ownerId: string;
  dogId: string;
}

const plantedFamilies: string[] = [];

export async function plantFamily(name = 'The Hendersons'): Promise<PlantedFamily> {
  const ownerId = randomUUID();
  const supabaseUid = randomUUID();
  const dogId = randomUUID();
  plantedFamilies.push(ownerId);
  await db.insert(owners).values({
    id: ownerId,
    supabaseUid,
    name,
    email: `family-${ownerId.slice(0, 8)}@example.com`,
    location: 'bentonville',
  });
  await db
    .insert(dogs)
    .values({ id: dogId, ownerId, name: 'Biscuit', breed: 'Beagle', birthdate: '2024-03-01' });
  return { principal: { kind: 'owner', ownerId, supabaseUid }, ownerId, dogId };
}

/** Every family `plantFamily` made: their threads (messages cascade), dogs and rows. */
export async function removeFamilies(): Promise<void> {
  const ids = plantedFamilies.splice(0);
  if (ids.length === 0) return;
  await db.delete(threads).where(inArray(threads.ownerId, ids));
  await db.execute(sql`DELETE FROM media_assets WHERE owner_id = ANY(${sql.param(ids)}::uuid[])`);
  await db.delete(dogs).where(inArray(dogs.ownerId, ids));
  await db.execute(
    sql`DELETE FROM idempotency_keys WHERE owner_id = ANY(${sql.param(ids)}::uuid[])`,
  );
  await db.delete(owners).where(inArray(owners.id, ids));
}
