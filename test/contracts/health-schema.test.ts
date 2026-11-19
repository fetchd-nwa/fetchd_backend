import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyStep, parseStep } from '../../src/db/migrate.js';

/**
 * `/health` reads the schema, never the ledger (O-MSG-LIVE pass 2a; brief LR1, which
 * replaces A2 OM4 and DECISIONS 598(1); CR23). 200 with `checks.schema: 'ok'` only when
 * `to_regclass('public.message_pushes')` is not null AND rs3's last object,
 * `device_tokens_live_token_uidx`, exists as a UNIQUE index partial on `expired_at IS NULL`
 * (p2a fix 1, F4: the name alone is not the index); otherwise 503 with `checks.schema:
 * 'behind'`. `migrations_applied` is never read. Railway's healthcheck reads `/health`, so
 * new code on an old schema never takes traffic: the old deployment stays live.
 *
 * Through the real boot path: each case spawns `src/index.ts` itself (the production
 * entry point: `initObservability` + `buildApp` + `listen`) on an explicit ephemeral PORT,
 * against a scratch database loaded from this tree's `schema.sql`, and asks it over HTTP.
 * The child's environment is explicit (p2a fix 1, F2; see {@link childEnv}): never the
 * ambient one, and `NODE_ENV=staging`, so it loads no `.env` file.
 * The scratch databases are this file's and are dropped by it (the pattern at
 * `test/migrateRunner.test.ts`'s M1.19 block).
 *
 * The M5.30 objects are made here with `IF NOT EXISTS` / dropped with `IF EXISTS`, so the
 * file holds whether or not `schema.sql` carries rs3 yet: today (this lane) it does not;
 * after integration the "current" database is purely born from `schema.sql`.
 */

const ADMIN_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const NO_DB =
  ADMIN_URL === undefined || REDIS_URL === undefined
    ? { skip: 'DATABASE_URL or REDIS_URL not set' }
    : { skip: false as const };
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_SQL = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'backend', 'schema.sql'), 'utf-8');

/** rs3 M5.30's two objects `/health` reads (pass 1's DDL, as the brief names them). */
const MESSAGE_PUSHES_DDL = `
  CREATE TABLE IF NOT EXISTS message_pushes (
    message_id      uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
    claimed_at      timestamptz NOT NULL DEFAULT now(),
    tickets_ok      integer,
    tickets_error   integer
  );
  REVOKE ALL ON message_pushes FROM anon, authenticated;`;
const LIVE_TOKEN_INDEX_DDL = `
  CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_live_token_uidx
    ON device_tokens (expo_push_token) WHERE expired_at IS NULL;`;

interface HealthAnswer {
  status: number;
  body: { status: string; checks: Record<string, string> };
}

interface RunningApi {
  child: ChildProcess;
  /** The keys of the child's environment (names only: the report shows these, never values). */
  envKeys: string[];
  /** The first 16 KB of the child's stdout: its boot banner says which env layer it loaded. */
  stdoutHead(): string;
  health(): Promise<HealthAnswer>;
  /** SIGTERM, then the exit code (null if it had to be killed). */
  stop(): Promise<number | null>;
}

function urlFor(dbName: string): string {
  const url = new URL(ADMIN_URL as string);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/** A fresh scratch database loaded from this tree's `schema.sql`. */
async function createScratch(dbName: string): Promise<void> {
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${dbName}`));
  const client = new pg.Client({ connectionString: urlFor(dbName) });
  await client.connect();
  try {
    await client.query(SCHEMA_SQL);
  } finally {
    await client.end();
  }
}

async function dropScratch(dbName: string): Promise<void> {
  await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
}

async function onScratch(dbName: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: urlFor(dbName) });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** The non-secret placeholders of `test/cors.test.ts` BASE_ENV: `env.ts` refuses to boot without them. */
const PLACEHOLDERS: Record<string, string> = {
  SUPABASE_JWKS_URL: 'https://project.invalid/auth/v1/.well-known/jwks.json',
  SUPABASE_JWT_AUD: 'authenticated',
  SUPABASE_JWT_ISS: 'https://project.invalid/auth/v1',
  SUPABASE_AUTH_WEBHOOK_SECRET: 'whsec_placeholder',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
  SCHEDULER_WEBHOOK_SECRET: 'scheduler_placeholder',
  R2_ACCOUNT_ID: 'placeholder',
  R2_ACCESS_KEY_ID: 'placeholder',
  R2_SECRET_ACCESS_KEY: 'placeholder',
  R2_BUCKET: 'nwa-media-test',
};

/**
 * The child's whole environment, in `test/cors.test.ts` BASE_ENV's form (p2a fix 1, the audit's
 * M1): never `{...process.env}`. Unset, `NODE_ENV` reads as development and `src/env.ts` loads
 * `.env.local` then `.env` from the working directory, and on the real tree `.env` is
 * production. `staging` loads no file. The database is this file's scratch database on this
 * run's server, Redis is this run's, and the realtime prefix (when the run sets one) is passed
 * through so a child's channels stay this run's.
 */
function childEnv(dbName: string, port: number): Record<string, string> {
  const prefix = process.env.REALTIME_CHANNEL_PREFIX;
  return {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'staging', // no .env files are loaded outside development/test
    LOG_LEVEL: 'info', // the boot banner names the env layer it loaded
    DATABASE_URL: urlFor(dbName),
    REDIS_URL: REDIS_URL as string,
    PORT: String(port),
    ...(prefix === undefined ? {} : { REALTIME_CHANNEL_PREFIX: prefix }),
    ...PLACEHOLDERS,
  };
}

/** An ephemeral port the OS just handed out (never 3000, 8081, 52815 or 55330). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Boot the real entry point against `dbName` and wait until it answers `/health`. */
async function bootApi(dbName: string): Promise<RunningApi> {
  const port = await freePort();
  const env = childEnv(dbName, port);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < 16_000) stdout = (stdout + chunk.toString('utf-8')).slice(0, 16_000);
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf-8')).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

  const health = async (): Promise<HealthAnswer> => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return { status: res.status, body: (await res.json()) as HealthAnswer['body'] };
  };

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`the API exited during boot (code ${child.exitCode}); stderr tail:\n${stderr}`);
    }
    try {
      await health();
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`the API did not answer /health within 60 s; stderr tail:\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return {
    child,
    envKeys: Object.keys(env),
    stdoutHead: () => stdout,
    health,
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

describe('LR1-a · a database behind rs3 (no M5.30): 503 behind, and the process stays up', NO_DB, () => {
  const dbName = `msg_p2a_health_behind_${suffix}`;
  let api: RunningApi | undefined;

  before(async () => {
    await createScratch(dbName);
    // rs2 shape: neither M5.30 object (a no-op while schema.sql has no rs3).
    await onScratch(
      dbName,
      'DROP INDEX IF EXISTS device_tokens_live_token_uidx; DROP TABLE IF EXISTS message_pushes;',
    );
    // F2 (p2a fix 1): an ambient variable must never reach the child. A child that inherited
    // this one would refuse to boot (`PORTAL_ORIGIN='*'` is refused, `test/cors.test.ts`).
    const ambient = process.env.PORTAL_ORIGIN;
    process.env.PORTAL_ORIGIN = '*';
    try {
      api = await bootApi(dbName);
    } finally {
      if (ambient === undefined) delete process.env.PORTAL_ORIGIN;
      else process.env.PORTAL_ORIGIN = ambient;
    }
  });

  after(async () => {
    await api?.stop();
    await dropScratch(dbName);
  });

  test('F2: the child runs on an explicit environment: NODE_ENV=staging loads no .env file, and the ambient PORTAL_ORIGIN did not reach it', async (t) => {
    t.diagnostic(`child env keys: ${api!.envKeys.join(', ')}`);
    assert.match(
      api!.stdoutHead(),
      /env: host-injected only \(no \.env files loaded\)/,
      `the boot banner must say no .env file was loaded; stdout head:\n${api!.stdoutHead().slice(0, 2000)}`,
    );
    assert.equal(api!.child.exitCode, null, 'it booted: the ambient PORTAL_ORIGIN=* was not inherited');
  });

  test('LR1-a: the new code on an rs2 database answers 503, checks.schema behind, beside the DB and Redis probes', async () => {
    const first = await api!.health();
    assert.equal(first.status, 503, JSON.stringify(first.body));
    assert.equal(first.body.status, 'degraded');
    assert.deepEqual(first.body.checks, { db: 'ok', redis: 'ok', schema: 'behind' });

    // The process is up, and keeps serving: a 503 is an answer, not a crash.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(api!.child.exitCode, null, 'the API process is still running');
    assert.equal((await api!.health()).status, 503);
  });

  test('LR1-a: message_pushes alone is still behind — M5.30’s last object, the live-token index, is read too', async () => {
    await onScratch(dbName, MESSAGE_PUSHES_DDL);
    const res = await api!.health();
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.checks.schema, 'behind');
  });

  // F4 (p2a fix 1; the audit's N1): the name alone is not the index. `message_pushes` is in place
  // from the test above, so only the index decides; each shape is dropped after its read.
  test('F4: an index of that name that is NOT unique is still behind', async () => {
    await onScratch(
      dbName,
      'CREATE INDEX device_tokens_live_token_uidx ON device_tokens (expo_push_token) WHERE expired_at IS NULL;',
    );
    try {
      const res = await api!.health();
      assert.equal(res.status, 503, JSON.stringify(res.body));
      assert.equal(res.body.checks.schema, 'behind');
    } finally {
      await onScratch(dbName, 'DROP INDEX device_tokens_live_token_uidx;');
    }
  });

  test('F4: a unique index of that name that is NOT partial on expired_at IS NULL is still behind', async () => {
    await onScratch(dbName, 'CREATE UNIQUE INDEX device_tokens_live_token_uidx ON device_tokens (expo_push_token);');
    try {
      const res = await api!.health();
      assert.equal(res.status, 503, JSON.stringify(res.body));
      assert.equal(res.body.checks.schema, 'behind');
    } finally {
      await onScratch(dbName, 'DROP INDEX device_tokens_live_token_uidx;');
    }
  });

  test('F4: control: the exact index (unique, partial on expired_at IS NULL) on the same database answers 200 ok', async () => {
    await onScratch(dbName, LIVE_TOKEN_INDEX_DDL);
    try {
      const res = await api!.health();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.checks, { db: 'ok', redis: 'ok', schema: 'ok' });
    } finally {
      await onScratch(dbName, 'DROP INDEX device_tokens_live_token_uidx;');
    }
  });

  test('LR1-a: the process stayed up throughout, and SIGTERM ends it cleanly', async () => {
    assert.equal(api!.child.exitCode, null);
    assert.equal(await api!.stop(), 0);
  });
});

describe('LR1-b, LR1-c · a database carrying rs3: 200 ok, whatever the ledger holds', NO_DB, () => {
  const dbName = `msg_p2a_health_current_${suffix}`;
  let api: RunningApi | undefined;

  before(async () => {
    await createScratch(dbName);
    await onScratch(dbName, MESSAGE_PUSHES_DDL + LIVE_TOKEN_INDEX_DDL);
    api = await bootApi(dbName);
  });

  after(async () => {
    await api?.stop();
    await dropScratch(dbName);
  });

  test('LR1-b: both M5.30 objects present, the ledger empty (a database born from schema.sql) → 200, checks.schema ok', async () => {
    const ledger = await withScratchClient(dbName, (c) =>
      c.query<{ n: number }>('SELECT count(*)::int AS n FROM migrations_applied'),
    );
    assert.equal(ledger.rows[0]?.n, 0, 'precondition: the ledger is empty');
    const res = await api!.health();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'ok');
    assert.deepEqual(res.body.checks, { db: 'ok', redis: 'ok', schema: 'ok' });
  });

  test('LR1-c: one later ledger row through applyStep (M5.32), and no M5.30 row → still 200 ok (the ledger is never read)', async () => {
    const parsed = parseStep('M5.32_lr1c_ledger_probe.sql', Buffer.from('SELECT 1;\n'));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    const applied = await withScratchClient(dbName, (c) =>
      applyStep(c, parsed.step, { appliedBy: 'test:lr1-c' }),
    );
    assert.ok(applied.ok, applied.ok ? '' : applied.reason);
    const ledger = await withScratchClient(dbName, (c) =>
      c.query<{ step_id: string }>('SELECT step_id FROM migrations_applied ORDER BY step_id'),
    );
    assert.deepEqual(
      ledger.rows.map((r) => r.step_id),
      ['M5.32'],
      'the ledger holds a later step and no M5.30',
    );

    const res = await api!.health();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checks.schema, 'ok');
  });
});

async function withScratchClient<T>(dbName: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor(dbName) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
