import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';
import {
  applyStep,
  clientConfig,
  findTransactionControl,
  parseStep,
  projectRefOf,
  checkProject,
  resolveTarget,
  type StepFile,
} from '../src/db/migrate.js';

/**
 * `npm run migrate:apply` — the one way a step reaches a database (design §4
 * preamble, design.md:6077-6092; S01).
 *
 * What is proven here, and why each matters:
 *   - R6 (red-first, design.md:6077-6082): a step file that contains a
 *     transaction-control statement is refused unless its header says
 *     `-- migrate: no-transaction`, because a `COMMIT` in the middle of a step
 *     would end the runner's transaction and log the step in autocommit —
 *     half a step applied and recorded as whole.
 *   - The detector reads SQL, not text: `BEGIN` inside a function body, a
 *     comment or a string is not transaction control (M1.18's own
 *     `audit_capture()` body begins with `BEGIN`).
 *   - The project-ref check refuses a `--project` that does not match the URL.
 *   - Against a real throwaway database: the log row is written last in the
 *     step's own transaction, with the sha256 of the file's exact bytes; a step
 *     that fails leaves nothing and logs nothing; a logged step is refused; the
 *     actor is `system:migrate-<step_id>`; and the class-catalog cache clear
 *     fires for the step whose header declares it, and only for that step.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LG1 = path.join(REPO_ROOT, 'migrations', 'lg1');

function step(fileName: string, sql: string): StepFile {
  const parsed = parseStep(fileName, Buffer.from(sql, 'utf8'));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return parsed.step;
}

// ── R6: transaction control ──────────────────────────────────────────────────

describe('R6 — a step may not carry its own transaction control', () => {
  for (const [label, sql] of [
    ['BEGIN', 'BEGIN;\nCREATE TABLE t (x int);\n'],
    ['COMMIT', 'CREATE TABLE t (x int);\nCOMMIT;\n'],
    ['ROLLBACK', 'CREATE TABLE t (x int);\nrollback;\n'],
    ['START TRANSACTION', 'start   transaction;\nCREATE TABLE t (x int);\n'],
    ['END (a COMMIT synonym)', 'CREATE TABLE t (x int);\nEND;\n'],
    ['ABORT (a ROLLBACK synonym)', 'CREATE TABLE t (x int);\nABORT;\n'],
  ] as const) {
    test(`a file containing ${label} is refused without the header`, () => {
      const parsed = parseStep('M9.01_probe.sql', Buffer.from(sql, 'utf8'));
      assert.equal(parsed.ok, false, `${label} was accepted`);
      assert.match(parsed.ok ? '' : parsed.reason, /transaction control/);
    });
  }

  // DECISIONS 64 (adversary M1): every END/ABORT statement form, and a `$`
  // inside an identifier that must not open a dollar quote.
  for (const [label, sql] of [
    [
      'END TRANSACTION AND CHAIN',
      'CREATE TABLE a(x int);\nEND TRANSACTION AND CHAIN;\nCREATE TABLE b(x int);',
    ],
    ['ABORT AND NO CHAIN', 'CREATE TABLE a(x int);\nABORT AND NO CHAIN;\nCREATE TABLE b(x int);'],
    [
      'END WORK AND NO CHAIN',
      'CREATE TABLE a(x int);\nEND WORK AND NO CHAIN;\nCREATE TABLE b(x int);',
    ],
    [
      'ABORT TRANSACTION AND CHAIN',
      'CREATE TABLE a(x int);\nABORT TRANSACTION AND CHAIN;\nCREATE TABLE b(x int);',
    ],
    ['COMMIT after an identifier holding $$', 'SELECT 1 AS a$$tag$;\nCOMMIT;\nSELECT 1 AS b$tag$;'],
    ['PREPARE TRANSACTION', "CREATE TABLE a(x int);\nPREPARE TRANSACTION 'p01';"],
  ] as const) {
    test(`the adversary's probe is refused: ${label}`, () => {
      const parsed = parseStep('M9.01_probe.sql', Buffer.from(sql, 'utf8'));
      assert.equal(parsed.ok, false, `${label} was accepted`);
      assert.match(parsed.ok ? '' : parsed.reason, /transaction control/);
    });
  }

  // DECISIONS 71 (adversary r2 L1): two places the lexer read SQL differently
  // from Postgres, each of which let a bare COMMIT through.
  for (const [label, sql] of [
    ['a CR-only line ending after a -- comment', 'SELECT 1; -- c\rCOMMIT;'],
    [
      "a $ before e'…' (x$e is one identifier, '\\' a standard string)",
      "CREATE DOMAIN x$e AS text; SELECT x$e'\\'; COMMIT; SELECT '';",
    ],
    [
      "a non-ASCII letter before e'…' (née is one identifier)",
      "SELECT née'\\'; COMMIT; SELECT '';",
    ],
  ] as const) {
    test(`the r2 probe is refused: ${label}`, () => {
      const parsed = parseStep('M9.01_probe.sql', Buffer.from(sql, 'utf8'));
      assert.equal(parsed.ok, false, `${label} was accepted`);
      assert.match(parsed.ok ? '' : parsed.reason, /transaction control/);
    });
  }

  test("a real E'…' escape string still hides what it holds, CRLF comments still end at the line", () => {
    assert.deepEqual(
      findTransactionControl("SELECT E'it\\'s; COMMIT;';\r\n-- COMMIT\r\nSELECT 1;"),
      [],
    );
    assert.deepEqual(findTransactionControl("SELECT (e'\\''), 'x';"), []);
  });

  test('an identifier holding $ does not hide a real dollar-quoted body, nor fake one', () => {
    assert.deepEqual(
      findTransactionControl(
        'CREATE FUNCTION f$x() RETURNS void AS $body$ BEGIN PERFORM 1; END $body$ LANGUAGE plpgsql;\nSELECT a$1 FROM t$$;',
      ),
      [],
    );
  });

  test('the same file is accepted under `-- migrate: no-transaction`', () => {
    const parsed = parseStep(
      'M9.01_probe.sql',
      Buffer.from("-- migrate: no-transaction\nALTER TYPE x ADD VALUE 'y';\nCOMMIT;\n", 'utf8'),
    );
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    assert.ok(parsed.step.directives.has('no-transaction'));
  });

  test('BEGIN/COMMIT inside a function body, a DO block, a comment or a string is not control', () => {
    const sql = [
      '-- BEGIN; COMMIT; this comment is not a statement',
      '/* ROLLBACK; /* nested */ still a comment */',
      'CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$',
      'BEGIN',
      "  RAISE NOTICE 'COMMIT';",
      '  RETURN NULL;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'DO $body$ BEGIN PERFORM 1; END $body$;',
      "INSERT INTO t (note) VALUES ('begin; commit; rollback; end;');",
      'SELECT "begin" FROM "commit";',
      'SELECT CASE WHEN true THEN 1 ELSE 0 END;',
    ].join('\n');
    assert.deepEqual(findTransactionControl(sql), []);
  });

  test('each hit names its line', () => {
    const hits = findTransactionControl('CREATE TABLE t (x int);\n\n  COMMIT;\n');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.line, 3);
  });
});

// ── the header and the file name ─────────────────────────────────────────────

describe('the step file', () => {
  test('the step id comes from the file name and the sha256 is of the exact bytes', () => {
    const bytes = Buffer.from('CREATE TABLE t (x int);\r\n', 'utf8');
    const parsed = parseStep('M1.07_day_program_settings.sql', bytes);
    assert.ok(parsed.ok);
    assert.equal(parsed.step.stepId, 'M1.07');
    assert.equal(parsed.step.sha256, createHash('sha256').update(bytes).digest('hex'));
  });

  test('a file that starts with a UTF-8 BOM is refused (the hash must be of the bytes sent)', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('SELECT 1;\n')]);
    const parsed = parseStep('M9.01_bom.sql', bytes);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /BOM/);
  });

  test('a file name with no step id is refused', () => {
    assert.equal(parseStep('day_program_settings.sql', Buffer.from('SELECT 1;')).ok, false);
    assert.equal(parseStep('M1.7_x.sql', Buffer.from('SELECT 1;')).ok, false);
  });

  test('an unknown directive is refused rather than ignored', () => {
    const parsed = parseStep(
      'M9.01_probe.sql',
      Buffer.from('-- migrate: no-transacton\nSELECT 1;\n'),
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /unknown directive/);
  });

  test('a directive below the header is refused rather than ignored', () => {
    const parsed = parseStep(
      'M9.01_probe.sql',
      Buffer.from('SELECT 1;\n-- migrate: invalidate-class-catalog\n'),
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /header/);
  });

  test('every committed LG1 step file parses', () => {
    const files = fs.readdirSync(LG1).filter((f) => f.endsWith('.sql'));
    assert.ok(files.length > 0, 'no step files found');
    for (const file of files) {
      const parsed = parseStep(file, fs.readFileSync(path.join(LG1, file)));
      assert.ok(parsed.ok, `${file}: ${parsed.ok ? '' : parsed.reason}`);
    }
  });
});

// ── the project-ref check ────────────────────────────────────────────────────

describe('the project-ref check (staff:provision’s rule)', () => {
  test('the ref is read from the direct host, the pooler user, or localhost', () => {
    assert.equal(projectRefOf('postgres://postgres:pw@localhost:5432/postgres'), 'local');
    assert.equal(projectRefOf('postgres://postgres:pw@127.0.0.1:5433/postgres'), 'local');
    assert.equal(
      projectRefOf('postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres'),
      'abcdefghijklmnop',
    );
    assert.equal(
      projectRefOf(
        'postgresql://postgres.abcdefghijklmnop:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
      ),
      'abcdefghijklmnop',
    );
    assert.equal(projectRefOf('postgres://postgres:pw@db.example.com:5432/postgres'), null);
  });

  test('a --project that does not match the URL is refused, naming both', () => {
    const url = 'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres';
    const refused = checkProject(url, 'zyxwvutsrqponmlk');
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.reason, /abcdefghijklmnop/);
    assert.match(refused.ok ? '' : refused.reason, /zyxwvutsrqponmlk/);
    assert.equal(checkProject(url, 'abcdefghijklmnop').ok, true);
    assert.equal(
      checkProject('postgres://postgres:pw@localhost:5433/x', 'abcdefghijklmnop').ok,
      false,
    );
    assert.equal(checkProject('postgres://postgres:pw@localhost:5433/x', 'local').ok, true);
    assert.equal(checkProject('postgres://postgres:pw@db.example.com/x', 'local').ok, false);
  });
});

describe('the URL is parsed once, and the driver connects to what was checked (DECISIONS 64, adversary M2)', () => {
  for (const [project, url] of [
    ['local', 'postgres://postgres:pw@localhost:5432/postgres?host=db.prodref123.supabase.co'],
    [
      'devref',
      'postgres://postgres.devref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?user=postgres.prodref123',
    ],
    ['prodref123', 'postgres://postgres:pw@db.prodref123.supabase.co:5432/postgres?ssl=0'],
    ['prodref123', 'postgres://postgres:pw@db.prodref123.supabase.co:5432/postgres#x'],
  ] as const) {
    test(`a URL carrying a query or fragment is refused: ${url.split('@')[1]}`, () => {
      const refused = checkProject(url, project);
      assert.equal(refused.ok, false, 'accepted');
      assert.match(refused.ok ? '' : refused.reason, /query|fragment/);
    });
  }

  test("Supabase's transaction pooler (port 6543) is refused, naming the direct 5432 URL (DECISIONS 70)", () => {
    const refused = checkProject(
      'postgres://postgres.prodref123:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      'prodref123',
    );
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.reason, /6543/);
    assert.match(refused.ok ? '' : refused.reason, /db\.prodref123\.supabase\.co:5432/);
    // The session-mode pooler port and the direct host stay accepted.
    assert.equal(
      checkProject(
        'postgres://postgres.prodref123:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
        'prodref123',
      ).ok,
      true,
    );
    assert.equal(
      checkProject('postgres://postgres:pw@db.prodref123.supabase.co:5432/postgres', 'prodref123')
        .ok,
      true,
    );
  });

  test('the client is built from the parsed fields, ssl last, verified TLS for a project', () => {
    const target = resolveTarget(
      'postgresql://postgres:p%40ss@db.prodref123.supabase.co:5432/postgres',
    );
    assert.ok(target.ok, target.ok ? '' : target.reason);
    const config = clientConfig(target, 'THE-CA');
    assert.deepEqual(Object.keys(config), ['host', 'port', 'user', 'password', 'database', 'ssl']);
    assert.deepEqual(config, {
      host: 'db.prodref123.supabase.co',
      port: 5432,
      user: 'postgres',
      password: 'p@ss',
      database: 'postgres',
      ssl: { ca: 'THE-CA', rejectUnauthorized: true },
    });
    const client = new pg.Client(config); // constructed, never connected
    assert.equal(client.connectionParameters.host, 'db.prodref123.supabase.co');
    assert.equal(client.connectionParameters.user, 'postgres');
    assert.deepEqual(client.connectionParameters.ssl, { ca: 'THE-CA', rejectUnauthorized: true });
  });

  test('a local target connects without TLS, and a project without a CA is refused', () => {
    const local = resolveTarget('postgres://postgres:pw@localhost:5433/postgres');
    assert.ok(local.ok);
    assert.equal(clientConfig(local, undefined).ssl, false);
    const remote = resolveTarget('postgres://postgres:pw@db.prodref123.supabase.co:5432/postgres');
    assert.ok(remote.ok);
    assert.throws(() => clientConfig(remote, undefined), /CA/);
  });
});

// ── against a real, throwaway database ───────────────────────────────────────

const ADMIN_URL = process.env.DATABASE_URL;
const NO_DB = ADMIN_URL === undefined ? { skip: 'DATABASE_URL not set' } : { skip: false as const };

describe('applying steps to a throwaway database', NO_DB, () => {
  const dbName = `migrate_runner_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let scratchUrl = '';
  let client: pg.Client;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(ADMIN_URL as string);
    url.pathname = `/${dbName}`;
    scratchUrl = url.toString();
    client = new pg.Client({ connectionString: scratchUrl });
    await client.connect();
  });

  after(async () => {
    await client?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  async function logRows(): Promise<
    Array<{ step_id: string; sql_sha256: string; applied_by: string }>
  > {
    const res = await client.query(
      'SELECT step_id, sql_sha256, applied_by FROM migrations_applied ORDER BY applied_at, step_id',
    );
    return res.rows;
  }

  test('M1.00 itself goes through the runner and logs itself', async () => {
    const file = path.join(LG1, 'M1.00_migrations_applied.sql');
    const parsed = parseStep(path.basename(file), fs.readFileSync(file));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    const result = await applyStep(client, parsed.step, { appliedBy: 'test' });
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.deepEqual(await logRows(), [
      { step_id: 'M1.00', sql_sha256: parsed.step.sha256, applied_by: 'test' },
    ]);
  });

  test('the step runs as system:migrate-<step_id>, in the same transaction as its log row', async () => {
    const probe = step(
      'M9.01_actor_probe.sql',
      "CREATE TABLE actor_probe (actor text);\nINSERT INTO actor_probe VALUES (current_setting('app.actor', true));\n",
    );
    const result = await applyStep(client, probe, { appliedBy: 'test' });
    assert.ok(result.ok, result.ok ? '' : result.reason);
    const { rows } = await client.query('SELECT actor FROM actor_probe');
    assert.deepEqual(rows, [{ actor: 'system:migrate-M9.01' }]);
    // A session-local actor would outlive the step; a transaction-local one does not.
    const after = await client.query("SELECT current_setting('app.actor', true) AS actor");
    assert.ok(after.rows[0].actor === null || after.rows[0].actor === '');
  });

  test('a failing step leaves nothing behind and logs nothing', async () => {
    const broken = step(
      'M9.02_broken.sql',
      'CREATE TABLE half_applied (x int);\nSELECT * FROM no_such_table;\n',
    );
    const result = await applyStep(client, broken, { appliedBy: 'test' });
    assert.equal(result.ok, false);
    const exists = await client.query("SELECT to_regclass('public.half_applied') AS t");
    assert.equal(exists.rows[0].t, null, 'the first statement of a failed step survived');
    assert.ok(!(await logRows()).some((r) => r.step_id === 'M9.02'), 'a failed step was logged');
  });

  test('a step already logged is refused before anything runs', async () => {
    const again = step('M9.01_actor_probe.sql', "INSERT INTO actor_probe VALUES ('second run');\n");
    const result = await applyStep(client, again, { appliedBy: 'test' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /already applied/);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM actor_probe');
    assert.equal(rows[0].n, 1);
  });

  test('a no-transaction step runs bare and is logged afterwards', async () => {
    const bare = step(
      'M9.03_bare.sql',
      "-- migrate: no-transaction\nCREATE TYPE bare_probe AS ENUM ('a');\nALTER TYPE bare_probe ADD VALUE 'b';\n",
    );
    const result = await applyStep(client, bare, { appliedBy: 'test' });
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.ok((await logRows()).some((r) => r.step_id === 'M9.03'));
  });

  test('a step that commits mid-way is caught at runtime even when the parser is bypassed (DECISIONS 64)', async () => {
    // Built by hand, NOT through parseStep, so nothing refuses it before it
    // runs: the runtime txid check is the only line of defence being tested.
    const sql =
      'CREATE TABLE chain_head (x int);\nEND TRANSACTION AND CHAIN;\nCREATE TABLE chain_tail (x int);\n';
    const bytes = Buffer.from(sql, 'utf8');
    const smuggled: StepFile = {
      stepId: 'M9.07',
      fileName: 'M9.07_chain.sql',
      bytes,
      sql,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      directives: new Set(),
    };
    const result = await applyStep(client, smuggled, { appliedBy: 'test' });
    assert.equal(result.ok, false, 'a mid-step commit was logged as a whole step');
    assert.match(result.ok ? '' : result.reason, /part before that point COMMITTED/);
    assert.ok(!(await logRows()).some((r) => r.step_id === 'M9.07'), 'the step was logged');
    const tables = await client.query(
      "SELECT to_regclass('public.chain_head') AS head, to_regclass('public.chain_tail') AS tail",
    );
    assert.equal(tables.rows[0].tail, null, 'the chained tail survived the rollback');
    // The head DID commit — which is exactly what the message must say.
    assert.equal(tables.rows[0].head, 'chain_head');
  });

  // DECISIONS 71 (adversary r2 M2): after ANY failure the runner asks Postgres
  // what became of its transaction, instead of assuming it rolled back.
  function smuggle(stepId: string, sql: string): StepFile {
    const bytes = Buffer.from(sql, 'utf8');
    return {
      stepId,
      fileName: `${stepId}_smuggled.sql`,
      bytes,
      sql,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      directives: new Set(),
    };
  }

  test('a hidden COMMIT followed by a failing statement: the runner says part may have committed, logs nothing', async () => {
    const result = await applyStep(
      client,
      smuggle(
        'M9.08',
        'CREATE TABLE m2_head (x int);\nCOMMIT;\nCREATE TABLE m2_tail (x int);\nSELECT 1/0;\n',
      ),
      { appliedBy: 'test' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.committed, true, 'reported as rolled back');
    assert.match(result.ok ? '' : result.reason, /committed/);
    assert.doesNotMatch(result.ok ? '' : result.reason, /nothing was applied/);
    assert.ok(!(await logRows()).some((r) => r.step_id === 'M9.08'), 'the step was logged');
    const tables = await client.query(
      "SELECT to_regclass('public.m2_head') AS head, to_regclass('public.m2_tail') AS tail",
    );
    assert.equal(
      tables.rows[0].head,
      'm2_head',
      'the head did commit — the report must not deny it',
    );
    assert.equal(tables.rows[0].tail, null);
  });

  test('a hidden plain COMMIT with a clean tail: detected, and the report does not claim the tail rolled back', async () => {
    const result = await applyStep(
      client,
      smuggle('M9.09', 'CREATE TABLE m2b_head (x int);\nCOMMIT;\nCREATE TABLE m2b_tail (x int);\n'),
      { appliedBy: 'test' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.committed, true);
    assert.doesNotMatch(result.ok ? '' : result.reason, /was rolled back/);
    assert.ok(!(await logRows()).some((r) => r.step_id === 'M9.09'));
    // Postgres ran the tail in its own implicit transaction, which committed.
    const tail = await client.query("SELECT to_regclass('public.m2b_tail') AS tail");
    assert.equal(tail.rows[0].tail, 'm2b_tail');
  });

  test('a plain failing step is still reported as nothing applied (txid_status: aborted)', async () => {
    const result = await applyStep(
      client,
      smuggle('M9.10', 'CREATE TABLE m2c (x int);\nSELECT 1/0;\n'),
      {
        appliedBy: 'test',
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.committed, false);
    assert.match(result.ok ? '' : result.reason, /nothing was applied/);
  });

  test('the class-catalog cache clear is refused up front when nothing can clear it', async () => {
    const pricing = step(
      'M9.04_price_seed.sql',
      '-- migrate: invalidate-class-catalog\nCREATE TABLE price_probe (x int);\n',
    );
    const result = await applyStep(client, pricing, { appliedBy: 'test' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /redis/i);
    const exists = await client.query("SELECT to_regclass('public.price_probe') AS t");
    assert.equal(exists.rows[0].t, null);
  });

  test('the CLI clears groupclasses:* after a step whose header declares it — and only then', async () => {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379/1';
    const redis = new Redis(redisUrl);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-runner-'));
    try {
      const plain = path.join(dir, 'M9.05_plain.sql');
      fs.writeFileSync(plain, 'CREATE TABLE plain_probe (x int);\n');
      const pricing = path.join(dir, 'M9.06_class_price_seed.sql');
      fs.writeFileSync(
        pricing,
        '-- migrate: invalidate-class-catalog\nCREATE TABLE catalog_probe (x int);\n',
      );

      const run = (file: string) =>
        spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            'scripts/migrate-apply.ts',
            file,
            '--url',
            scratchUrl,
            '--project',
            'local',
            '--redis-url',
            redisUrl,
          ],
          { cwd: REPO_ROOT, encoding: 'utf-8', env: { PATH: process.env.PATH ?? '' } },
        );

      await redis.set('groupclasses:catalog', 'stale');
      const first = run(plain);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(
        await redis.get('groupclasses:catalog'),
        'stale',
        'a plain step touched the cache',
      );

      const second = run(pricing);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(
        await redis.get('groupclasses:catalog'),
        null,
        'the declared clear did not fire',
      );
    } finally {
      await redis.del('groupclasses:catalog');
      redis.disconnect();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the CLI refuses a project mismatch before connecting', () => {
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/migrate-apply.ts',
        path.join(LG1, 'M1.01_account_settings.sql'),
        '--url',
        scratchUrl,
        '--project',
        'abcdefghijklmnop',
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8', env: { PATH: process.env.PATH ?? '' } },
    );
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /project/);
  });
});

// ── the per-table REVOKE, every step file (DECISIONS 71; adversary r2 M3) ─────

/**
 * Every `CREATE TABLE <t>` in a step file must be followed, in that file, by
 * `REVOKE ALL ON <t> FROM anon, authenticated`. On the path where production's
 * default privileges are global (DECISIONS 51's open reading), M1.00's per-schema
 * revoke does not reach them, and this line is the ONLY thing keeping a new
 * table closed — and the rehearsal, which replays per-schema defaults, cannot
 * see it go missing. So it is checked here, statically.
 *
 * `MIGRATIONS_DIR` points the check at another tree: that is how it is proven
 * red, on a scratch copy, so a mutant never sits in `migrations/`.
 */
function tablesMissingTheirRevoke(root: string): string[] {
  const missing: string[] = [];
  const walk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((d) =>
        d.isDirectory()
          ? walk(path.join(dir, d.name))
          : d.name.endsWith('.sql')
            ? [path.join(dir, d.name)]
            : [],
      );
  for (const file of walk(root)) {
    const sql = fs
      .readFileSync(file, 'utf8')
      .replace(/--[^\r\n]*/g, '') // comments may mention either statement
      .replace(/\s+/g, ' ');
    for (const create of sql.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?("?[A-Za-z_][A-Za-z0-9_]*"?)/gi,
    )) {
      const table = (create[1] as string).replaceAll('"', '');
      const after = sql.slice((create.index ?? 0) + create[0].length);
      const revoke = new RegExp(
        `REVOKE ALL ON (?:TABLE )?"?${table}"? FROM anon, ?authenticated\\s*;`,
        'i',
      );
      if (!revoke.test(after)) missing.push(`${path.relative(root, file)}: ${table}`);
    }
  }
  return missing;
}

describe('every CREATE TABLE in a step file is followed by its REVOKE (DECISIONS 71)', () => {
  test('the step files under test', () => {
    const root = process.env.MIGRATIONS_DIR ?? path.join(REPO_ROOT, 'migrations');
    const files = fs.readdirSync(path.join(REPO_ROOT, 'migrations', 'lg1'));
    assert.ok(files.length > 0);
    assert.deepEqual(tablesMissingTheirRevoke(root), []);
  });

  test('the check goes red on a scratch copy with one REVOKE deleted (the mutant never sits in migrations/)', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-check-'));
    try {
      fs.cpSync(path.join(REPO_ROOT, 'migrations'), scratch, { recursive: true });
      const target = path.join(scratch, 'lg1', 'M1.02_alumni_settings.sql');
      const before = fs.readFileSync(target, 'utf8');
      const after = before.replace('REVOKE ALL ON alumni_settings FROM anon, authenticated;\n', '');
      assert.notEqual(after, before, 'the mutation did not land');
      fs.writeFileSync(target, after);
      assert.deepEqual(tablesMissingTheirRevoke(scratch), [
        path.join('lg1', 'M1.02_alumni_settings.sql') + ': alumni_settings',
      ]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
