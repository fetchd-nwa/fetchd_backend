import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * **A Postgres connection that dies must not end the API** (O-MSG-LIVE p2a fix 1; the p2a audit's H1; brief LR5,
 * "nothing un-awaited can exit the process").
 *
 * node-postgres emits `error` on a CLIENT whose socket the server closes (Supabase restarts, fails over, or reaps an
 * idle connection), and pg-pool re-emits it on the POOL for an idle client. An `error` event nobody listens to is an
 * uncaught exception, so the process exits 1: the audit executed it (exit 1 within 6 ms of `pg_terminate_backend`,
 * idle and checked-out alike). Only a real process can answer that, so each case spawns one, in production's shape:
 * `initObservability()` first (as `src/index.ts` does), with an in-memory transport that records every page.
 *
 * Each child opens its pool on this run's database, reads the backend pid of the client it opened, and terminates
 * that pid only (`datname = current_database()`): it never touches a connection it did not open.
 *
 *   F1-a  an idle pooled client's backend is terminated: the child lives, writes one warn line, pages nobody, and the
 *         pool answers a fresh `SELECT 1`.
 *   F1-b  the same for a client checked out with no query running, released afterwards.
 *   F1-c  a query running when its backend is terminated still rejects to its caller with the server's error
 *         (`57P01`), through `pool.query` and through a checked-out client (a transaction's road), and the child lives.
 *   F1-d  a checked-out client whose backend was terminated refuses its NEXT statement (a transaction idle between
 *         statements cannot carry on); released, it leaves the pool (`totalCount` 0), and a fresh `SELECT 1` answers.
 *   F1-e  production's road: a `withActor` transaction (`src/db/tx.ts`, drizzle's `db.transaction`) whose backend is
 *         terminated mid-`pg_sleep` rejects to its caller, nothing of it commits (the table and row it wrote are
 *         gone), its client leaves the pool, and a fresh `withActor` commits with its actor stamped.
 *
 * F1-e's probe tables are created inside the transactions under test, so the killed one is rolled back by Postgres
 * itself (also when the child crashes, as it does at base); the fresh one is dropped by the child, which then reports
 * the residue of both names (0).
 *
 * The child's environment is explicit (`test/cors.test.ts` BASE_ENV's form, never `{...process.env}`):
 * `NODE_ENV=staging`, so no `.env` file is loaded; this run's `DATABASE_URL` and `REDIS_URL`; an explicit ephemeral
 * `PORT` (the child binds nothing).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const NO_DB =
  DATABASE_URL === undefined || REDIS_URL === undefined
    ? { skip: 'DATABASE_URL or REDIS_URL not set' }
    : { skip: false as const };
const RUN_DB = DATABASE_URL === undefined ? '' : new URL(DATABASE_URL).pathname.slice(1);

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

function childEnv(port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'staging', // no .env files are loaded outside development/test
    LOG_LEVEL: 'warn',
    DATABASE_URL: DATABASE_URL as string,
    REDIS_URL: REDIS_URL as string,
    PORT: String(port),
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

type Variant =
  | 'idle'
  | 'checked-out'
  | 'running-pool-query'
  | 'running-checked-out-query'
  | 'checked-out-next-query'
  | 'with-actor-running';

/** F1-e's transaction actor (a system actor, as workers and webhooks use). */
const ACTOR = 'system:pool-loss-test';

/**
 * The child. It adds no `error` listener of its own to the pool or to any client: one would absorb the very event
 * under test. The admin connection is a separate `pg.Client`, never from the pool.
 */
function childProgram(variant: Variant): string {
  return `
const VARIANT = ${JSON.stringify(variant)};
const ACTOR = ${JSON.stringify(ACTOR)};
const pg = (await import('pg')).default;
const o = await import('./src/lib/observability.js');
const pages = [];
o.initObservability({ transport: { send: (event) => { pages.push(event.message); return Promise.resolve(); } } });
const { pool } = await import('./src/db/pool.js');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
const out = { variant: VARIANT };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidOf = async (q) => (await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
async function waitRunning(pid) {
  for (let i = 0; i < 250; i += 1) {
    const r = await admin.query('SELECT state, query FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (r.rows[0]?.state === 'active' && String(r.rows[0]?.query).includes('pg_sleep')) return;
    await sleep(20);
  }
  throw new Error('backend ' + pid + ' never ran the pg_sleep query');
}
async function terminate(pid) {
  const r = await admin.query(
    'SELECT pg_terminate_backend(pid) AS killed, datname FROM pg_stat_activity WHERE pid = $1 AND datname = current_database()',
    [pid],
  );
  out.killed = r.rows.length === 1 && r.rows[0].killed === true;
  out.db = r.rows[0]?.datname ?? null;
  for (let i = 0; i < 250; i += 1) {
    const g = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (g.rows[0].n === 0) break;
    await sleep(20);
  }
  await sleep(500); // the client's socket delivers the server's FATAL and its close
}
const settled = (p) =>
  p.then(
    () => ({ resolved: true }),
    (e) => ({ code: e.code ?? null, severity: e.severity ?? null, message: e.message }),
  );
if (VARIANT === 'idle') {
  const c = await pool.connect();
  const pid = await pidOf(c);
  c.release();
  out.idleBeforeKill = pool.idleCount;
  await terminate(pid);
} else if (VARIANT === 'checked-out') {
  const c = await pool.connect();
  const pid = await pidOf(c);
  await terminate(pid);
  c.release();
} else if (VARIANT === 'running-pool-query') {
  const pid = await pidOf(pool); // warms the one client the next pool.query reuses
  const running = settled(pool.query('SELECT pg_sleep(20)'));
  await waitRunning(pid);
  await terminate(pid);
  out.rejected = await running;
} else if (VARIANT === 'running-checked-out-query') {
  const c = await pool.connect();
  const pid = await pidOf(c);
  const running = settled(c.query('SELECT pg_sleep(20)'));
  await waitRunning(pid);
  await terminate(pid);
  out.rejected = await running;
  c.release();
} else if (VARIANT === 'checked-out-next-query') {
  const c = await pool.connect();
  const pid = await pidOf(c);
  await terminate(pid);
  out.nextQuery = await settled(c.query('SELECT 1 AS ok')); // the statement after the kill, on the same client
  c.release();
  out.totalAfterRelease = pool.totalCount;
} else if (VARIANT === 'with-actor-running') {
  // Production's road: every transaction opens through withActor -> drizzle's db.transaction (src/db/tx.ts).
  const { withActor } = await import('./src/db/tx.js');
  const { sql } = await import('drizzle-orm');
  const tag = Math.random().toString(16).slice(2, 10);
  const KILLED = 'pool_loss_probe_killed_' + tag;
  const FRESH = 'pool_loss_probe_fresh_' + tag;
  let tellPid;
  const pidKnown = new Promise((resolve) => { tellPid = resolve; });
  const running = settled(
    withActor(ACTOR, async (tx) => {
      await tx.execute(sql.raw('CREATE TABLE ' + KILLED + ' (actor text)'));
      await tx.execute(sql.raw('INSERT INTO ' + KILLED + " (actor) VALUES (current_setting('app.actor', true))"));
      tellPid((await tx.execute(sql\`select pg_backend_pid() as pid\`)).rows[0].pid);
      await tx.execute(sql\`select pg_sleep(20)\`);
      out.ranPastSleep = true;
      return 'committed';
    }),
  );
  const pid = await Promise.race([
    pidKnown,
    running.then((r) => { throw new Error('withActor settled before its pg_sleep: ' + JSON.stringify(r)); }),
  ]);
  await waitRunning(pid);
  await terminate(pid);
  out.rejected = await running;
  out.totalAfterRejection = pool.totalCount;
  out.killedTable = (await admin.query('SELECT to_regclass($1)::text AS r', ['public.' + KILLED])).rows[0].r;
  out.freshTx = await withActor(ACTOR, async (tx) => {
    await tx.execute(sql.raw('CREATE TABLE ' + FRESH + ' (actor text)'));
    await tx.execute(sql.raw('INSERT INTO ' + FRESH + " (actor) VALUES (current_setting('app.actor', true))"));
    return 'returned';
  });
  out.freshRows = (await admin.query('SELECT actor FROM ' + FRESH)).rows.map((r) => r.actor);
  await admin.query('DROP TABLE ' + FRESH);
  out.residue = (
    await admin.query('SELECT count(*)::int AS n FROM pg_class WHERE relname IN ($1, $2)', [KILLED, FRESH])
  ).rows[0].n;
} else {
  throw new Error('unknown variant ' + VARIANT);
}
out.fresh = (await pool.query('SELECT 1 AS ok')).rows[0].ok;
out.pages = pages;
await admin.end();
await pool.end();
process.stdout.write('RESULT ' + JSON.stringify(out) + '\\n');
`;
}

interface ChildResult {
  variant: Variant;
  killed: boolean;
  db: string | null;
  idleBeforeKill?: number;
  rejected?: Settled;
  nextQuery?: Settled;
  totalAfterRelease?: number;
  totalAfterRejection?: number;
  ranPastSleep?: true;
  killedTable?: string | null;
  freshTx?: string;
  freshRows?: string[];
  residue?: number;
  fresh: number;
  pages: string[];
}

/** A promise's outcome as the child reports it: `{ resolved: true }`, or the rejection's code, severity, message. */
interface Settled {
  resolved?: true;
  code?: string | null;
  severity?: string | null;
  message?: string;
}

interface ChildRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  result: ChildResult | undefined;
  envKeys: string[];
}

async function runChild(variant: Variant): Promise<ChildRun> {
  const env = childEnv(await freePort());
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', childProgram(variant)], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf-8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once('close', (code, sig) => resolve([code, sig])),
  );
  clearTimeout(killer);
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return {
    status,
    signal,
    stderr,
    result: line === undefined ? undefined : (JSON.parse(line.slice('RESULT '.length)) as ChildResult),
    envKeys: Object.keys(env),
  };
}

/** The pool's warn lines on the child's stderr. */
function poolWarns(stderr: string): string[] {
  return stderr.split('\n').filter((l) => l.startsWith('[pool] warn:'));
}

const SERVER_TERMINATE = {
  code: '57P01',
  severity: 'FATAL',
  message: 'terminating connection due to administrator command',
};

/** What every case requires: the child lived, killed only its own backend, paged nobody, and the pool still answers. */
function assertSurvived(t: TestContext, run: ChildRun): ChildResult {
  t.diagnostic(`child env keys: ${run.envKeys.join(', ')}`);
  assert.equal(run.status, 0, `the child must survive the kill (exit ${run.status}, signal ${run.signal}); stderr:\n${run.stderr}`);
  assert.doesNotMatch(run.stderr, /Unhandled 'error' event|uncaughtException/, run.stderr);
  const result = run.result;
  assert.ok(result, `the child printed no RESULT line; stderr:\n${run.stderr}`);
  assert.equal(result.killed, true, 'the child terminated exactly the backend it opened');
  assert.equal(result.db, RUN_DB, "the backend was on this run's database");
  t.diagnostic(`terminated one backend on ${result.db}`);
  const warns = poolWarns(run.stderr);
  t.diagnostic(`${warns.length} pool warn line(s)${warns.map((w) => `\n${w}`).join('')}`);
  assert.equal(result.fresh, 1, 'the pool answers a fresh SELECT 1 after the kill');
  assert.deepEqual(result.pages, [], 'a lost connection is a warn, never a page');
  return result;
}

test('F1-a: an idle pooled client’s backend is terminated: the process lives, one warn line, the pool answers SELECT 1', { ...NO_DB, timeout: 90_000 }, async (t) => {
  const run = await runChild('idle');
  const result = assertSurvived(t, run);
  assert.equal(result.idleBeforeKill, 1, 'precondition: the client sat idle in the pool when it was killed');
  const warns = poolWarns(run.stderr);
  assert.equal(warns.length, 1, `exactly one warn line; stderr:\n${run.stderr}`);
  assert.match(warns[0]!, /57P01/);
});

test('F1-b: a checked-out client with no query running is terminated: the process lives, one warn line, released, SELECT 1 answers', { ...NO_DB, timeout: 90_000 }, async (t) => {
  const run = await runChild('checked-out');
  assertSurvived(t, run);
  const warns = poolWarns(run.stderr);
  assert.equal(warns.length, 1, `exactly one warn line; stderr:\n${run.stderr}`);
  assert.match(warns[0]!, /57P01/);
});

test('F1-c: a running pool.query whose backend is terminated rejects to its caller with the server’s 57P01, and the process lives', { ...NO_DB, timeout: 90_000 }, async (t) => {
  const run = await runChild('running-pool-query');
  const result = assertSurvived(t, run);
  assert.deepEqual(result.rejected, SERVER_TERMINATE, 'the caller gets the server’s error, exactly as before');
  // pg-pool releases the client with the query's error and ends it, so no `error` event follows: no warn line.
  assert.equal(poolWarns(run.stderr).length, 0, `no warn line; stderr:\n${run.stderr}`);
});

test('F1-c: a running query on a checked-out client (a transaction’s road) rejects to its caller with 57P01, and the process lives', { ...NO_DB, timeout: 90_000 }, async (t) => {
  const run = await runChild('running-checked-out-query');
  const result = assertSurvived(t, run);
  assert.deepEqual(result.rejected, SERVER_TERMINATE, 'the caller gets the server’s error, exactly as before');
  // The socket's close then reaches the still-checked-out client as an `error` event: the line, not a crash.
  const warns = poolWarns(run.stderr);
  assert.equal(warns.length, 1, `exactly one warn line; stderr:\n${run.stderr}`);
  assert.match(warns[0]!, /Connection terminated unexpectedly/);
});

test('F1-d: a checked-out client whose backend was terminated refuses its next statement; released, it leaves the pool, and SELECT 1 answers', { ...NO_DB, timeout: 90_000 }, async (t) => {
  const run = await runChild('checked-out-next-query');
  const result = assertSurvived(t, run);
  t.diagnostic(`the next statement on the dead client: ${JSON.stringify(result.nextQuery)}`);
  assert.ok(result.nextQuery !== undefined, 'the child reported the next statement’s outcome');
  assert.equal(result.nextQuery.resolved, undefined, 'the statement after the kill must reject, never run');
  // node-postgres marks the client dead before it emits `error` (pg client.js `_handleErrorEvent`), so the next
  // statement is refused on the client side: the transaction cannot carry on.
  assert.match(result.nextQuery.message ?? '', /not queryable/, 'refused as a dead client, not by the server');
  assert.equal(result.totalAfterRelease, 0, 'released, the dead client left the pool rather than going back to it');
  const warns = poolWarns(run.stderr);
  assert.equal(warns.length, 1, `exactly one warn line; stderr:\n${run.stderr}`);
  assert.match(warns[0]!, /57P01/);
});

test('F1-e: a withActor transaction whose backend is terminated mid-statement rejects to its caller, commits nothing, and a fresh withActor commits', { ...NO_DB, timeout: 90_000 }, async (t) => {
  const run = await runChild('with-actor-running');
  const result = assertSurvived(t, run);
  t.diagnostic(`withActor's caller got: ${JSON.stringify(result.rejected)}`);
  assert.ok(result.rejected !== undefined, 'the child reported the transaction’s outcome');
  assert.equal(result.rejected.resolved, undefined, 'withActor must reject to its caller');
  // Drizzle's catch awaits a `rollback` on the dead client and rethrows ITS error (drizzle-orm node-postgres
  // session.js), so the caller sees the client-side connection loss rather than the server's 57P01.
  assert.match(
    result.rejected.message ?? '',
    /Connection terminated unexpectedly|not queryable|terminating connection due to administrator command/,
    'it rejected for the lost connection, not for anything else',
  );
  assert.equal(result.ranPastSleep, undefined, 'the transaction body never continued past the killed statement');
  assert.equal(result.killedTable, null, 'nothing of the killed transaction committed: its table and row are gone');
  assert.equal(result.totalAfterRejection, 0, 'its client left the pool');
  assert.equal(result.freshTx, 'returned', 'a fresh withActor runs to its end');
  assert.deepEqual(result.freshRows, [ACTOR], 'and commits, with its actor stamped transaction-locally');
  assert.equal(result.residue, 0, 'no probe table is left on the database');
  // The 57P01 went to the running statement; the socket's close reaches the checked-out client as the one line.
  const warns = poolWarns(run.stderr);
  assert.equal(warns.length, 1, `exactly one warn line; stderr:\n${run.stderr}`);
  assert.match(warns[0]!, /Connection terminated unexpectedly/);
});
