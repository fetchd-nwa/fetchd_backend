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
  maskSql,
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

  // P02 item 0b (Opus r3 L1; DECISIONS 72): Postgres's dollar-quote tag takes
  // any byte from \200-\377 (scan.l dolq_start/dolq_cont), so every non-ASCII
  // character is a tag character. An ASCII-only tag rule read `$é$` as a
  // parameter plus the identifier `é$`, and the `'` after it opened a "string"
  // that swallowed the real COMMIT. The five probe variants of
  // units/P02/evidence/probe-lexer.out, each refused:
  for (const [label, sql] of [
    ['a non-ASCII tag $é$ hiding $$', 'SELECT $é$ $$ $é$; COMMIT; SELECT 1;'],
    ['a tag $aé$ (ASCII start, non-ASCII after)', 'SELECT $aé$ $$ $aé$; COMMIT; SELECT 1;'],
    ['$é$ with a failing tail', 'SELECT $é$ $$ $é$; COMMIT; SELECT 1/0;'],
    ["$é$ hiding a ' quote (the brief's probe)", "SELECT $é$ ' $é$; COMMIT; SELECT 'x';"],
    ['a no-break-space tag $\u00a0$', 'SELECT $\u00a0$ $$ $\u00a0$; COMMIT; SELECT 1;'],
  ] as const) {
    test(`a non-ASCII dollar-quote tag is a tag: ${label}`, () => {
      const parsed = parseStep('M9.01_probe.sql', Buffer.from(sql, 'utf8'));
      assert.equal(parsed.ok, false, `${label} was accepted`);
      assert.match(parsed.ok ? '' : parsed.reason, /COMMIT/);
    });
  }

  test('a non-ASCII-tagged body still hides what it holds (the widened tag is not a false refusal)', () => {
    assert.deepEqual(
      findTransactionControl(
        'DO $é$ BEGIN PERFORM 1; END $é$;\nCREATE FUNCTION g() RETURNS int AS $aé1$ SELECT 1 $aé1$ LANGUAGE sql;',
      ),
      [],
    );
  });

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

  // P02 (M1.19, design.md:2122-2128): the census gate is a header directive,
  // so it is in the bytes the sha256 covers and production receives.
  test('`-- migrate: census-empty <table>` names a table that must be empty before the step', () => {
    const parsed = parseStep(
      'M9.11_census.sql',
      Buffer.from('-- migrate: census-empty staff\n-- why\nSELECT 1;\n'),
    );
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    assert.deepEqual(parsed.step.censusEmpty, ['staff']);
    assert.equal(parsed.step.directives.size, 0);
  });

  test('a census gate needs the runner’s transaction: census-empty with no-transaction is refused', () => {
    const parsed = parseStep(
      'M9.12_census.sql',
      Buffer.from('-- migrate: no-transaction\n-- migrate: census-empty staff\nSELECT 1;\n'),
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /a census gate needs the runner's transaction/);
  });

  test('a census gate on something that is not a plain table name is refused', () => {
    for (const bad of [
      'census-empty',
      'census-empty staff; DROP TABLE x',
      'census-empty "Staff"',
    ]) {
      const parsed = parseStep('M9.13_census.sql', Buffer.from(`-- migrate: ${bad}\nSELECT 1;\n`));
      assert.equal(parsed.ok, false, bad);
      assert.match(parsed.ok ? '' : parsed.reason, /census-empty takes one plain table name/, bad);
    }
  });

  test('a directive below the header is refused rather than ignored', () => {
    const parsed = parseStep(
      'M9.01_probe.sql',
      Buffer.from('SELECT 1;\n-- migrate: invalidate-class-catalog\n'),
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /header/);
  });

  // P02 fix round 1 (adversary nice N1): a near-miss of the directive form
  // must not be read as a plain comment — a census gate that silently
  // switches off is P01's "misspelt no-transaction" again. Fail closed.
  test('a near-miss of `-- migrate: <directive>` is refused, never dropped as a comment', () => {
    for (const header of [
      '-- migrate: census-empy staff',
      '-- Migrate: census-empty staff',
      '-- migrate : census-empty staff',
      '--MIGRATE: no-transaction',
      '/* migrate: census-empty staff */',
    ]) {
      const parsed = parseStep('M9.14_probe.sql', Buffer.from(`${header}\nSELECT 1;\n`));
      assert.equal(parsed.ok, false, header);
    }
  });

  test('lone-CR line endings: the header is read line by line and the directive holds', () => {
    const parsed = parseStep(
      'M9.15_cr.sql',
      Buffer.from('-- migrate: census-empty staff\r-- why\rSELECT 1;\r'),
    );
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    assert.deepEqual(parsed.step.censusEmpty, ['staff']);
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
      censusEmpty: [],
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
      censusEmpty: [],
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

// ── M1.19's census gate and its cast (STAFF-U02; design.md:2122-2128, :6150) ──

describe('M1.19 — the census gate and the role cast, on a throwaway database', NO_DB, () => {
  const dbName = `migrate_census_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let scratchUrl = '';
  let client: pg.Client;
  const M119 = path.join(LG1, 'M1.19_staff_role_rebuild.sql');

  /** The pre-M1.19 shape of what M1.19 touches: the old enum and a staff table. */
  const BEFORE = `
    CREATE TABLE migrations_applied (step_id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text NOT NULL, sql_sha256 text NOT NULL);
    CREATE TYPE staff_role AS ENUM ('owner-shanthi', 'trainer', 'office');
    CREATE TABLE staff (id serial PRIMARY KEY, name text NOT NULL, role staff_role NOT NULL);`;

  async function reset(rows: Array<[string, string]>): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS staff; DROP TABLE IF EXISTS migrations_applied; DROP TYPE IF EXISTS staff_role; DROP TYPE IF EXISTS staff_role_v2;',
    );
    await client.query(BEFORE);
    for (const [name, role] of rows) {
      await client.query('INSERT INTO staff (name, role) VALUES ($1, $2)', [name, role]);
    }
  }

  async function enumLabels(): Promise<string[]> {
    const { rows } = await client.query<{ label: string }>(
      "SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'staff_role' ORDER BY e.enumsortorder",
    );
    return rows.map((r) => r.label);
  }

  function m119(): StepFile {
    const parsed = parseStep(path.basename(M119), fs.readFileSync(M119));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    return parsed.step;
  }

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

  test('the committed M1.19 declares the census gate on staff', () => {
    assert.deepEqual(m119().censusEmpty, ['staff']);
  });

  test('a staff row present → the runner stops before the step: nothing cast, nothing logged', async () => {
    await reset([['Shanthi', 'owner-shanthi']]);
    const result = await applyStep(client, m119(), { appliedBy: 'test' });
    assert.equal(result.ok, false, 'M1.19 ran over a staff row');
    assert.equal(result.ok ? undefined : result.committed, false);
    assert.match(result.ok ? '' : result.reason, /census/i);
    assert.match(result.ok ? '' : result.reason, /staff holds 1 row/);
    assert.deepEqual(await enumLabels(), ['owner-shanthi', 'trainer', 'office']);
    const logged = await client.query('SELECT count(*)::int AS n FROM migrations_applied');
    assert.equal(logged.rows[0].n, 0);
  });

  test('an empty staff table → the enum is rebuilt as owner, manager, trainer and the step is logged', async () => {
    await reset([]);
    const result = await applyStep(client, m119(), { appliedBy: 'test' });
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.deepEqual(await enumLabels(), ['owner', 'manager', 'trainer']);
    const types = await client.query(
      "SELECT count(*)::int AS n FROM pg_type WHERE typname IN ('staff_role_v2', '_staff_role_v2')",
    );
    assert.equal(types.rows[0].n, 0, 'the v2 name (or its array type) survived the rename');
  });

  test('dev waives the census (skipCensus) and takes the CASE cast: owner-shanthi → owner, trainer → trainer', async () => {
    await reset([
      ['Shanthi', 'owner-shanthi'],
      ['Fed', 'trainer'],
    ]);
    const result = await applyStep(client, m119(), { appliedBy: 'test', skipCensus: ['staff'] });
    assert.ok(result.ok, result.ok ? '' : result.reason);
    const { rows } = await client.query('SELECT name, role::text AS role FROM staff ORDER BY name');
    assert.deepEqual(rows, [
      { name: 'Fed', role: 'trainer' },
      { name: 'Shanthi', role: 'owner' },
    ]);
  });

  test("a live 'office' row aborts the cast, and the step rolls back whole (map it by hand first)", async () => {
    await reset([
      ['Shanthi', 'owner-shanthi'],
      ['Desk', 'office'],
    ]);
    const result = await applyStep(client, m119(), { appliedBy: 'test', skipCensus: ['staff'] });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.committed, false);
    assert.deepEqual(await enumLabels(), ['owner-shanthi', 'trainer', 'office']);
    const v2 = await client.query("SELECT to_regtype('staff_role_v2') AS t");
    assert.equal(v2.rows[0].t, null, 'the new type survived the rollback');
  });

  test('a census waiver that names no gate of the step is refused (a typo must not pass silently)', async () => {
    await reset([['Shanthi', 'owner-shanthi']]);
    const result = await applyStep(client, m119(), { appliedBy: 'test', skipCensus: ['staf'] });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /staf/);
    assert.deepEqual(await enumLabels(), ['owner-shanthi', 'trainer', 'office']);
  });

  // Adversary nice N4: every authenticated request reads `staff`; behind a long
  // or idle transaction the census lock must not queue all of them for as
  // long as it waits.
  test('the census lock waits a few seconds at most (lock_timeout), then the step rolls back whole', async () => {
    await reset([]);
    const holder = new pg.Client({ connectionString: scratchUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT count(*) FROM staff'); // ACCESS SHARE, held until ROLLBACK
      const release = setTimeout(
        () => void holder.query('ROLLBACK').catch(() => undefined),
        10_000,
      );
      const started = Date.now();
      const result = await applyStep(client, m119(), { appliedBy: 'test' });
      const waited = Date.now() - started;
      clearTimeout(release);
      assert.equal(result.ok, false, `the step waited ${waited} ms for the lock and ran`);
      assert.equal(result.ok ? undefined : result.committed, false);
      assert.match(result.ok ? '' : result.reason, /lock timeout/);
      assert.ok(waited < 9_000, `waited ${waited} ms`);
      assert.deepEqual(await enumLabels(), ['owner-shanthi', 'trainer', 'office']);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  });

  test('the CLI refuses --skip-census for any project but local, before connecting', () => {
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/migrate-apply.ts',
        M119,
        '--url',
        'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
        '--project',
        'abcdefghijklmnop',
        '--skip-census',
        'staff',
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8', env: { PATH: process.env.PATH ?? '' } },
    );
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /--skip-census.*local/);
  });

  test('the CLI with --skip-census on local applies M1.19 over a seeded roster (the dev path)', async () => {
    await reset([['Shanthi', 'owner-shanthi']]);
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/migrate-apply.ts',
        M119,
        '--url',
        scratchUrl,
        '--project',
        'local',
        '--skip-census',
        'staff',
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8', env: { PATH: process.env.PATH ?? '' } },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /census\s+SKIPPED: staff/);
    assert.deepEqual(await enumLabels(), ['owner', 'manager', 'trainer']);
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
 * It reads SQL, not text (P02 item 0c; DECISIONS 72), through the runner's own
 * lexer (`maskSql`), with two masks of each file that align offset for offset:
 *
 *   - the CREATEs are found with comments blanked and everything else kept —
 *     a `CREATE TABLE` in a string or a `DO` body (`EXECUTE '…'`) still counts,
 *     because over-reading a create costs a rewrite and under-reading one
 *     leaves a table open;
 *   - the REVOKEs are found with comments, strings, quoted identifiers and
 *     dollar bodies blanked, so a REVOKE inside a comment, a string, a quoted
 *     name or a function body does not count (a REVOKE written straight into a
 *     `DO` body is real but is not credited either — write it at the top
 *     level); each one found is then read, at the same offsets, from a mask
 *     that keeps quoted identifiers, so a quoted table name still matches.
 *
 * A create is `CREATE [UNLOGGED] TABLE [IF NOT EXISTS] [<schema>.]<name>`,
 * quoted or bare; `public.x` is the table `x` (an unqualified name is
 * public's), a bare name folds to lower case and a quoted one keeps its case.
 * A revoke is `REVOKE ALL [PRIVILEGES] ON [TABLE] <list> FROM <grantees>` whose
 * list names the table and whose grantees include both anon and authenticated.
 *
 * An EMPTY tree is refused, not passed: a check that finds no step file proves
 * nothing, and `MIGRATIONS_DIR` pointing at the wrong place must go red.
 *
 * `MIGRATIONS_DIR` points the check at another tree: that is how it is proven
 * red, on a scratch copy, so a mutant never sits in `migrations/`.
 */
const NAME = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)`;
const QUALIFIED = String.raw`${NAME}(?:\s*\.\s*${NAME})?`;
const CREATE_TABLE = new RegExp(
  String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`,
  'gi',
);
const REVOKE_ALL =
  /\bREVOKE\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+(?:TABLE\s+)?([^;]*?)\s+FROM\s+([^;]*?)\s*;/gi;
/** The same statement, read whole: its bounds come from the masked match, and
 *  a quoted name inside it may hold a `;`. */
const REVOKE_PARTS =
  /^REVOKE\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+(?:TABLE\s+)?([\s\S]*?)\s+FROM\s+([\s\S]*?)\s*;$/i;

/** One identifier as Postgres reads it: a quoted one verbatim, a bare one folded. */
function identifier(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase();
}

/** `[schema.]name` → `schema.name`, with an unqualified name in public. */
function qualifiedName(raw: string): string {
  const parts = [...raw.matchAll(new RegExp(NAME, 'g'))].map((m) => identifier(m[0]));
  return parts.length === 2 ? `${parts[0]}.${parts[1]}` : `public.${parts[0]}`;
}

/** The comma-separated names of a list, commas inside quotes kept. */
function listNames(raw: string): string[] {
  return [...raw.matchAll(new RegExp(QUALIFIED, 'g'))].map((m) => qualifiedName(m[0]));
}

function stepFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) =>
      d.isDirectory()
        ? stepFiles(path.join(dir, d.name))
        : d.name.endsWith('.sql')
          ? [path.join(dir, d.name)]
          : [],
    );
}

function tablesMissingTheirRevoke(root: string): string[] {
  const files = stepFiles(root);
  if (files.length === 0) {
    throw new Error(`no step file under ${root}: an empty tree proves nothing (MIGRATIONS_DIR?)`);
  }
  const missing: string[] = [];
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    const creates = maskSql(sql, {
      comments: true,
      strings: false,
      quotedIdentifiers: false,
      dollarBodies: false,
    });
    const code = maskSql(sql, {
      comments: true,
      strings: true,
      quotedIdentifiers: false,
      dollarBodies: true,
    });
    const revokes = [...maskSql(sql).matchAll(REVOKE_ALL)].flatMap((m) => {
      const at = m.index ?? 0;
      const parts = REVOKE_PARTS.exec(code.slice(at, at + m[0].length));
      if (parts === null) return [];
      return [
        {
          at,
          tables: new Set(listNames(parts[1] as string)),
          grantees: new Set(
            (parts[2] as string)
              .replace(/\s+(CASCADE|RESTRICT)\s*$/i, '')
              .split(',')
              .map((g) => identifier(g.trim())),
          ),
        },
      ];
    });
    for (const create of creates.matchAll(CREATE_TABLE)) {
      const table = qualifiedName(create[1] as string);
      const end = (create.index ?? 0) + create[0].length;
      const revoked = revokes.some(
        (r) =>
          r.at >= end &&
          r.tables.has(table) &&
          r.grantees.has('anon') &&
          r.grantees.has('authenticated'),
      );
      if (!revoked) {
        const shown = table.startsWith('public.') ? table.slice('public.'.length) : table;
        missing.push(`${path.relative(root, file)}: ${shown}`);
      }
    }
  }
  return missing;
}

describe('every CREATE TABLE in a step file is followed by its REVOKE (DECISIONS 71)', () => {
  test('the step files under test', () => {
    const root = process.env.MIGRATIONS_DIR ?? path.join(REPO_ROOT, 'migrations');
    assert.deepEqual(tablesMissingTheirRevoke(root), []);
  });

  // P02 item 0c (Opus r3 L2, Fable r3 L3; DECISIONS 72): the check reads SQL,
  // not text. Each case is a one-file scratch tree.
  function scratchTree(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-case-'));
    for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
    return dir;
  }
  function missingIn(files: Record<string, string>): string[] {
    const dir = scratchTree(files);
    try {
      return tablesMissingTheirRevoke(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a REVOKE inside a block comment or a string does not count', () => {
    assert.deepEqual(
      missingIn({
        'M9.01_a.sql':
          'CREATE TABLE a (x int);\n/* REVOKE ALL ON a FROM anon, authenticated; */\nSELECT 1;\n',
      }),
      ['M9.01_a.sql: a'],
    );
    assert.deepEqual(
      missingIn({
        'M9.01_b.sql':
          "CREATE TABLE b (x int);\nCOMMENT ON TABLE b IS 'REVOKE ALL ON b FROM anon, authenticated;';\n",
      }),
      ['M9.01_b.sql: b'],
    );
  });

  test('CREATE UNLOGGED TABLE and CREATE TABLE IF NOT EXISTS are tables too', () => {
    assert.deepEqual(missingIn({ 'M9.01_c.sql': 'CREATE UNLOGGED TABLE c (x int);\n' }), [
      'M9.01_c.sql: c',
    ]);
    assert.deepEqual(
      missingIn({ 'M9.01_d.sql': 'CREATE UNLOGGED TABLE IF NOT EXISTS d (x int);\n' }),
      ['M9.01_d.sql: d'],
    );
  });

  test('public.x is the table x, not a table named "public"; a quoted name keeps its case', () => {
    assert.deepEqual(
      missingIn({
        'M9.01_e.sql':
          'CREATE TABLE public.e (x int);\nREVOKE ALL ON public.e FROM anon, authenticated;\n',
      }),
      [],
    );
    assert.deepEqual(
      missingIn({
        'M9.01_f.sql':
          'CREATE TABLE public.f (x int);\nREVOKE ALL ON f FROM anon, authenticated;\n',
      }),
      [],
    );
    assert.deepEqual(
      missingIn({ 'M9.01_g.sql': 'CREATE TABLE IF NOT EXISTS public."Gee" (x int);\n' }),
      ['M9.01_g.sql: Gee'],
    );
  });

  // Adversary nice N2: a REVOKE spelled inside a quoted identifier is a name,
  // not a statement.
  test('a REVOKE inside a quoted identifier does not count', () => {
    assert.deepEqual(
      missingIn({
        'M9.01_h.sql':
          'CREATE TABLE h (x int, "x; REVOKE ALL ON h FROM anon, authenticated;" int);\n',
      }),
      ['M9.01_h.sql: h'],
    );
    // A quoted name in a real REVOKE is still read.
    assert.deepEqual(
      missingIn({
        'M9.01_i.sql':
          'CREATE TABLE "Eye" (x int);\nREVOKE ALL ON "Eye" FROM "anon", authenticated;\n',
      }),
      [],
    );
  });

  test('an empty MIGRATIONS_DIR tree is refused, not passed vacuously', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-empty-'));
    try {
      assert.throws(() => tablesMissingTheirRevoke(empty), /no step file/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
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
