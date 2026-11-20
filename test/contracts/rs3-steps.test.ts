import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyStep, parseStep, type StepFile } from '../../src/db/migrate.js';
import { assertTestDatabaseUrl } from './_dbGuard.js';

/**
 * rs3, M5.26–M5.30 (plan unit P45 with its one-off O-MSG-LIVE; brief "Migrations: `rs3`" and
 * LR3, LR4, LR12, LR15, CR8, ON2, FM3): each step file run through the runner's own
 * `applyStep` against a scratch database of its own (the pattern at
 * `test/migrateRunner.test.ts`, its M1.19 harness), so what is proven is the bytes production
 * receives. Two scratch databases, both dropped by this file:
 *
 *   · `reference`: a fresh load of the WORKING TREE's `schema.sql`, before any fixture. It
 *     holds the school's system row (M5.26-s) and is what M5.26's row is compared with
 *     (M5.26-eq). The rehearsal cannot prove that row: it compares rows only for
 *     `credit_packages` and `service_rates` (`scripts/migrate-rehearse.sh`, the Fable seat's
 *     last read, N4), so this file is that proof.
 *   · `harness`: the pre-unit shape (`test/fixtures/rs3-pre-unit.sql`, the base's own DDL for
 *     the tables rs3 touches), seeded with real rows, then the five steps in order. Between
 *     them: ON2 (a lock held on `threads`: M5.29 fails within 5 s and leaves nothing), LR15
 *     (the backfill on real rows, fixed uuids chosen against both wrong orders), FM3-b,
 *     B14, and OH1-b/LR3 (the device-token history with no winner).
 */

const ADMIN_URL = process.env.DATABASE_URL;
const NO_DB = ADMIN_URL === undefined ? { skip: 'DATABASE_URL not set' } : { skip: false as const };
if (ADMIN_URL !== undefined) assertTestDatabaseUrl(ADMIN_URL);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RS3 = path.join(REPO_ROOT, 'migrations', 'rs3');
const SCHEMA_SQL = path.join(REPO_ROOT, '.claude', 'backend', 'schema.sql');
const PRE_UNIT = path.join(REPO_ROOT, 'test', 'fixtures', 'rs3-pre-unit.sql');

const SCHOOL_NAME = 'NWA School for Dogs';

function rs3Step(stepId: string): StepFile {
  const file = fs.readdirSync(RS3).find((name) => name.startsWith(`${stepId}_`));
  assert.ok(file !== undefined, `migrations/rs3 holds no ${stepId} step file`);
  const parsed = parseStep(file, fs.readFileSync(path.join(RS3, file)));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return parsed.step;
}

async function applyOk(client: pg.Client, stepId: string): Promise<void> {
  const result = await applyStep(client, rs3Step(stepId), { appliedBy: 'rs3-steps' });
  assert.ok(result.ok, result.ok ? '' : result.reason);
}

async function createScratch(prefix: string): Promise<{ name: string; url: string }> {
  const name = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL as string);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropScratch(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** The system row as a comparable value: every column but the load's timestamp. */
const SYSTEM_ROW = `
  SELECT to_jsonb(s) - 'created_at' AS row
    FROM staff s
   WHERE s.is_system_account AND s.expired_at IS NULL`;

// Fixed ids (LR15; the Opus seat's contract read, L4): chosen against both wrong orders. The
// later `sent_at` gets the LOWER uuid (red on an `id`-only backfill), and of the two sharing a
// `sent_at` the HIGHER uuid is inserted first (red on a `sent_at`-only one).
const OWNER_A = 'a1a1a1a1-0000-4000-8000-000000000001';
const OWNER_B = 'b2b2b2b2-0000-4000-8000-000000000002';
const STAFF_AMBER = 'cccccccc-0000-4000-8000-0000000000a1';
const T1 = '10000000-0000-4000-8000-0000000000f1';
const T2 = '10000000-0000-4000-8000-0000000000f2';
const T3 = '10000000-0000-4000-8000-0000000000f3';
const M = {
  // T1, in their true order by (sent_at, id):
  first: '99999999-0000-4000-8000-000000000009', // 09:00, the highest id
  tieLow: '22222222-0000-4000-8000-000000000002', // 10:00
  tieHigh: '33333333-0000-4000-8000-000000000003', // 10:00, inserted BEFORE tieLow
  later: '11111111-0000-4000-8000-000000000001', // 11:00, the lowest id
  expired: '55555555-0000-4000-8000-000000000005', // 12:00, expired: keeps its number
  // T2:
  t2First: '88888888-0000-4000-8000-000000000008', // 08:00
  t2Second: '77777777-0000-4000-8000-000000000007', // 09:30, a lower id
};
const TOKEN_T = 'ExponentPushToken[rs3-shared-phone]';
const TOKEN_U = 'ExponentPushToken[rs3-one-family]';

async function seedPreUnit(client: pg.Client): Promise<void> {
  await client.query(fs.readFileSync(PRE_UNIT, 'utf8'));
  await client.query(`INSERT INTO owners (id, name) VALUES ($1, 'Allison'), ($2, 'Hendersons')`, [
    OWNER_A,
    OWNER_B,
  ]);
  await client.query(
    `INSERT INTO staff (id, supabase_uid, name, role, home_locations)
     VALUES ($1, gen_random_uuid(), 'Amber', 'manager', '{bentonville}')`,
    [STAFF_AMBER],
  );
  await client.query(
    `INSERT INTO threads (id, owner_id, participant_staff_id, category, title, sub_text)
     VALUES ($1, $4, $5, 'sessions', 'Sessions', ''),
            ($2, $4, $5, 'billing', 'Billing', ''),
            ($3, $6, $5, 'other', 'Other', '')`,
    [T1, T2, T3, OWNER_A, STAFF_AMBER, OWNER_B],
  );
  const rows: Array<[string, string, string, 'owner' | 'staff', boolean]> = [
    // insertion order is deliberate: the tie's higher id first
    [M.expired, T1, '2026-11-01T12:00:00Z', 'owner', true],
    [M.tieHigh, T1, '2026-11-01T10:00:00Z', 'staff', false],
    [M.later, T1, '2026-11-01T11:00:00Z', 'owner', false],
    [M.tieLow, T1, '2026-11-01T10:00:00Z', 'owner', false],
    [M.first, T1, '2026-11-01T09:00:00Z', 'owner', false],
    [M.t2Second, T2, '2026-11-02T09:30:00Z', 'staff', false],
    [M.t2First, T2, '2026-11-02T08:00:00Z', 'owner', false],
  ];
  for (const [id, threadId, sentAt, kind, expired] of rows) {
    await client.query(
      `INSERT INTO messages (id, thread_id, sender_kind, sender_owner_id, sender_staff_id, text, sent_at, expired_at)
       VALUES ($1, $2, $3::sender_kind,
               CASE WHEN $3 = 'owner' THEN $4::uuid END,
               CASE WHEN $3 = 'staff' THEN $5::uuid END,
               'hello', $6, CASE WHEN $7 THEN $6::timestamptz + interval '1 hour' END)`,
      [id, threadId, kind, OWNER_A, STAFF_AMBER, sentAt, expired],
    );
  }
  // LR3's history (OH1-b): Allison registers T on 1 Nov, the Hendersons on 10 Nov, and
  // Allison re-registers on 15 Nov — the pre-unit upsert keeps her row's 1 Nov created_at
  // (`deviceTokensRepository.upsert` sets only `platform`), so "newest wins" would leave the
  // Hendersons' row live on the phone she is holding. U is one family's alone; an expired row
  // of T stays as it is.
  await client.query(
    `INSERT INTO device_tokens (owner_id, expo_push_token, platform, created_at, expired_at) VALUES
       ($1, $3, 'ios', '2026-11-01T15:00:00Z', NULL),
       ($2, $3, 'ios', '2026-11-10T15:00:00Z', NULL),
       ($2, $3, 'ios', '2026-10-01T15:00:00Z', '2026-10-02T15:00:00Z'),
       ($1, $4, 'android', '2026-11-03T15:00:00Z', NULL)`,
    [OWNER_A, OWNER_B, TOKEN_T, TOKEN_U],
  );
  // Her 15 Nov re-registration, as the pre-unit upsert writes it: an UPDATE of `platform`.
  await client.query(
    `UPDATE device_tokens SET platform = 'ios'
      WHERE owner_id = $1 AND expo_push_token = $2 AND expired_at IS NULL`,
    [OWNER_A, TOKEN_T],
  );
  // The seed's own audit rows are not the steps'.
  await client.query('DELETE FROM audit_log');
}

let reference: { name: string; url: string } | undefined;
let harness: { name: string; url: string } | undefined;
let ref: pg.Client;
let db: pg.Client;

before(async () => {
  if (ADMIN_URL === undefined) return;
  reference = await createScratch('rs3_reference');
  ref = new pg.Client({ connectionString: reference.url });
  await ref.connect();
  await ref.query(fs.readFileSync(SCHEMA_SQL, 'utf8'));

  harness = await createScratch('rs3_harness');
  db = new pg.Client({ connectionString: harness.url });
  await db.connect();
  await seedPreUnit(db);
});

after(async () => {
  await ref?.end().catch(() => undefined);
  await db?.end().catch(() => undefined);
  if (reference !== undefined) await dropScratch(reference.name);
  if (harness !== undefined) await dropScratch(harness.name);
});

describe('rs3: every step opens with its lock_timeout and sets no actor (ON2, LR12)', () => {
  test('M5.26–M5.30 each exist, open with SET LOCAL lock_timeout = 5s, and never name app.actor', () => {
    const files = fs.readdirSync(RS3).filter((name) => /^M\d+\.\d+_.*\.sql$/.test(name));
    assert.deepEqual(files.map((name) => name.split('_')[0]).sort(), [
      'M5.26',
      'M5.27',
      'M5.28',
      'M5.29',
      'M5.30',
    ]);
    for (const file of files) {
      const sql = fs.readFileSync(path.join(RS3, file), 'utf8');
      const statements = sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim();
      assert.ok(
        statements.startsWith("SET LOCAL lock_timeout = '5s';"),
        `${file} does not open with SET LOCAL lock_timeout = '5s'`,
      );
      // The runner sets `system:migrate-<step>` (migrate.ts); a step's own actor would replace it.
      assert.equal(/app\.actor/.test(statements), false, `${file} names app.actor`);
    }
  });
});

describe('M5.26-s: schema.sql inserts the school system row (CR8)', NO_DB, () => {
  test('a fresh load of the working tree’s schema.sql, before any fixture: one live system row, the school’s name, no uid, both campuses', async () => {
    const { rows } = await ref.query<{
      id: string;
      name: string;
      supabase_uid: string | null;
      role: string;
      image_path: string | null;
      home_locations: string[];
      lesson_price_cents: number | null;
      board_train_eligible: boolean;
    }>(
      `SELECT id, name, supabase_uid, role::text AS role, image_path, home_locations,
              lesson_price_cents, board_train_eligible
         FROM staff WHERE is_system_account AND expired_at IS NULL`,
    );
    assert.equal(rows.length, 1, `live system rows: ${rows.length}`);
    const [row] = rows;
    assert.equal(row?.name, SCHOOL_NAME);
    assert.equal(row?.supabase_uid, null);
    assert.deepEqual([...(row?.home_locations ?? [])].sort(), ['bentonville', 'fayetteville']);
    assert.equal(row?.role, 'trainer', 'role trainer, which confers nothing (design §4 M8.03)');
    assert.equal(row?.image_path, null);
    assert.equal(row?.lesson_price_cents, null);
    assert.equal(row?.board_train_eligible, false);
    const all = await ref.query<{ n: number }>('SELECT count(*)::int AS n FROM staff');
    assert.equal(all.rows[0]?.n, 1, 'the system row is the only staff row of a fresh load');
  });

  test('the CHECK and the one-live-system-row index hold on the fresh load', async () => {
    await ref.query('BEGIN');
    try {
      await assert.rejects(
        ref.query('UPDATE staff SET supabase_uid = gen_random_uuid() WHERE is_system_account'),
        (err: { code?: string }) => err.code === '23514',
      );
    } finally {
      await ref.query('ROLLBACK');
    }
    await ref.query('BEGIN');
    try {
      await assert.rejects(
        ref.query(
          `INSERT INTO staff (name, role, home_locations, is_system_account)
           VALUES ('A second school', 'trainer', '{fayetteville}', true)`,
        ),
        (err: { code?: string }) => err.code === '23505',
      );
    } finally {
      await ref.query('ROLLBACK');
    }
  });
});

describe('rs3 on the pre-unit shape, step by step', NO_DB, () => {
  test('M5.26 applies, and M5.26-eq: its row equals schema.sql’s on every column but the timestamp (CR8)', async () => {
    await applyOk(db, 'M5.26');
    const stepped = await db.query<{ row: Record<string, unknown> }>(SYSTEM_ROW);
    const loaded = await ref.query<{ row: Record<string, unknown> }>(SYSTEM_ROW);
    assert.equal(stepped.rows.length, 1, 'M5.26 inserted no live system row');
    assert.equal(loaded.rows.length, 1);
    assert.deepEqual(stepped.rows[0]?.row, loaded.rows[0]?.row);
    // The existing person row is untouched and still has its uid.
    const amber = await db.query<{ ok: boolean }>(
      'SELECT supabase_uid IS NOT NULL AND NOT is_system_account AS ok FROM staff WHERE id = $1',
      [STAFF_AMBER],
    );
    assert.equal(amber.rows[0]?.ok, true);
  });

  test('M5.27 and M5.28 apply', async () => {
    await applyOk(db, 'M5.27');
    await applyOk(db, 'M5.28');
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM threads WHERE addressed_to_school',
    );
    assert.equal(rows[0]?.n, 0, 'no existing thread becomes a school thread');
  });

  test('ON2: with a lock held on threads, M5.29 fails within 5 s and leaves nothing applied or logged', async () => {
    const holder = new pg.Client({ connectionString: harness?.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE threads IN ACCESS SHARE MODE');
      const started = Date.now();
      const step = applyStep(db, rs3Step('M5.29'), { appliedBy: 'rs3-steps' });
      const outcome = await Promise.race([
        step.then((result) => ({ result })),
        new Promise<'still waiting'>((resolve) =>
          setTimeout(() => resolve('still waiting'), 8_000),
        ),
      ]);
      if (outcome === 'still waiting') {
        await holder.query('ROLLBACK');
        await step.catch(() => undefined);
        assert.fail('M5.29 was still waiting on the lock after 8 s: no lock_timeout');
      }
      const elapsed = Date.now() - started;
      assert.equal(outcome.result.ok, false, 'M5.29 ran over a held lock');
      assert.equal(outcome.result.ok ? undefined : outcome.result.committed, false);
      assert.match(outcome.result.ok ? '' : outcome.result.reason, /lock timeout/i);
      assert.ok(elapsed < 7_500, `it waited ${elapsed} ms`);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
    const logged = await db.query("SELECT 1 FROM migrations_applied WHERE step_id = 'M5.29'");
    assert.equal(logged.rows.length, 0);
    const column = await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'thread_seq'",
    );
    assert.equal(column.rows.length, 0, 'thread_seq exists after a failed step');
  });

  test('LR15: M5.29 numbers real rows 1..n per thread by (sent_at, id), last_seq is the max (0 for an empty thread), every audit row is the runner’s', async () => {
    await applyOk(db, 'M5.29');
    const seq = await db.query<{ id: string; thread_seq: number }>(
      'SELECT id, thread_seq FROM messages ORDER BY thread_id, thread_seq',
    );
    const byId = new Map(seq.rows.map((r) => [r.id, r.thread_seq] as const));
    assert.deepEqual(
      [M.first, M.tieLow, M.tieHigh, M.later, M.expired].map((id) => byId.get(id)),
      [1, 2, 3, 4, 5],
      'T1 is not numbered by (sent_at, id)',
    );
    assert.deepEqual(
      [M.t2First, M.t2Second].map((id) => byId.get(id)),
      [1, 2],
      'T2 is not numbered by (sent_at, id)',
    );
    const last = await db.query<{ id: string; last_seq: number }>(
      'SELECT id, last_seq FROM threads ORDER BY id',
    );
    assert.deepEqual(
      last.rows.map((r) => [r.id, r.last_seq]),
      [
        [T1, 5],
        [T2, 2],
        [T3, 0],
      ],
    );
    const audit = await db.query<{ table_name: string; actor: string | null; n: number }>(
      `SELECT table_name, actor, count(*)::int AS n FROM audit_log
        GROUP BY table_name, actor ORDER BY table_name`,
    );
    assert.deepEqual(
      audit.rows.map((r) => [r.table_name, r.actor, r.n]),
      [
        ['messages', 'system:migrate-M5.29', 7],
        ['threads', 'system:migrate-M5.29', 2],
      ],
    );
  });

  test('FM3-b: an INSERT naming no thread_seq gets the next number; with the trigger dropped it fails 23502 (the NOT NULL is real)', async () => {
    const { rows } = await db.query<{ thread_seq: number }>(
      `INSERT INTO messages (thread_id, sender_kind, sender_owner_id, text)
       VALUES ($1, 'owner', $2, 'a seed-shaped insert') RETURNING thread_seq`,
      [T3, OWNER_B],
    );
    assert.equal(rows[0]?.thread_seq, 1);
    const t3 = await db.query<{ last_seq: number }>('SELECT last_seq FROM threads WHERE id = $1', [
      T3,
    ]);
    assert.equal(t3.rows[0]?.last_seq, 1);
    await db.query('BEGIN');
    try {
      await db.query('DROP TRIGGER messages_assign_thread_seq ON messages');
      await assert.rejects(
        db.query(
          `INSERT INTO messages (thread_id, sender_kind, sender_owner_id, text)
           VALUES ($1, 'owner', $2, 'no trigger')`,
          [T3, OWNER_B],
        ),
        (err: { code?: string; column?: string }) =>
          err.code === '23502' && err.column === 'thread_seq',
      );
    } finally {
      await db.query('ROLLBACK');
    }
  });

  test('B14 (step half): UPDATE threads SET owner_id raises after M5.29; a preview bump still passes', async () => {
    await db.query('BEGIN');
    try {
      await assert.rejects(
        db.query('UPDATE threads SET owner_id = $2 WHERE id = $1', [T1, OWNER_B]),
        /owner_id never changes/,
      );
    } finally {
      await db.query('ROLLBACK');
    }
    await db.query('BEGIN');
    try {
      await db.query("UPDATE threads SET last_message = 'x', owner_id = owner_id WHERE id = $1", [
        T1,
      ]);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  test('OH1-b (LR3): M5.30 leaves zero live rows for a token live for two families, and a one-family token untouched; the dedupe is the runner’s', async () => {
    await db.query('DELETE FROM audit_log');
    await applyOk(db, 'M5.30');
    const live = await db.query<{ owner_id: string; token: string }>(
      `SELECT owner_id::text, expo_push_token AS token FROM device_tokens
        WHERE expired_at IS NULL ORDER BY expo_push_token`,
    );
    assert.deepEqual(
      live.rows.map((r) => [r.owner_id, r.token]),
      [[OWNER_A, TOKEN_U]],
      'T is still live for a family, or U was touched',
    );
    const audit = await db.query<{ table_name: string; actor: string | null; n: number }>(
      `SELECT table_name, actor, count(*)::int AS n FROM audit_log
        GROUP BY table_name, actor ORDER BY table_name`,
    );
    assert.deepEqual(
      audit.rows.map((r) => [r.table_name, r.actor, r.n]),
      [['device_tokens', 'system:migrate-M5.30', 2]],
    );
    // The live-token index now holds: T can be live once.
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO device_tokens (owner_id, expo_push_token, platform) VALUES ($1, $2, 'ios')`,
        [OWNER_A, TOKEN_T],
      );
      await assert.rejects(
        db.query(
          `INSERT INTO device_tokens (owner_id, expo_push_token, platform) VALUES ($1, $2, 'ios')`,
          [OWNER_B, TOKEN_T],
        ),
        (err: { code?: string; constraint?: string }) =>
          err.code === '23505' && err.constraint === 'device_tokens_live_token_uidx',
      );
    } finally {
      await db.query('ROLLBACK');
    }
  });

  test('after rs3 the five steps are logged in order, with their own hashes', async () => {
    const { rows } = await db.query<{ step_id: string; sql_sha256: string }>(
      'SELECT step_id, sql_sha256 FROM migrations_applied ORDER BY applied_at, step_id',
    );
    assert.deepEqual(
      rows.map((r) => [r.step_id, r.sql_sha256]),
      ['M5.26', 'M5.27', 'M5.28', 'M5.29', 'M5.30'].map((id) => [id, rs3Step(id).sha256]),
    );
  });

  test('the objects rs3 leaves equal schema.sql’s, on every table it touches: columns, constraints, indexes, triggers, its two functions, and no grant to anon or authenticated', async () => {
    const [stepped, loaded] = await Promise.all([rs3Objects(db), rs3Objects(ref)]);
    assert.deepEqual(stepped, loaded);
  });
});

/**
 * The catalog of what rs3 creates or changes, read the way `scripts/db/fingerprint.sql` reads
 * a schema (column, constraint, index and trigger definitions, function bodies), for the
 * tables rs3 touches only: the harness holds the base's DDL for those and a reduced `owners`
 * and `notifications`, so the whole-schema proof stays the rehearsal's. `thread_dogs` is read
 * without its constraints (the harness drops its `dogs` foreign key, having no `dogs`).
 */
const RS3_TABLES = [
  'staff',
  'threads',
  'messages',
  'device_tokens',
  'message_staff_reads',
  'message_pushes',
];
const RS3_FUNCTIONS = ['messages_assign_thread_seq', 'threads_owner_id_immutable'];

async function rs3Objects(client: pg.Client): Promise<Record<string, unknown>> {
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  return {
    columns: await q(
      `SELECT table_name, column_name, udt_name, is_nullable, coalesce(column_default, '') AS dflt
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)
        ORDER BY table_name, column_name`,
      [RS3_TABLES],
    ),
    constraints: await q(
      `SELECT conrelid::regclass::text AS table_name, conname, contype::text, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text = ANY($1)
        ORDER BY 1, 2`,
      [RS3_TABLES],
    ),
    indexes: await q(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY 1, 2`,
      [[...RS3_TABLES, 'thread_dogs']],
    ),
    triggers: await q(
      `SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS def
         FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($1) ORDER BY 1, 2`,
      [[...RS3_TABLES, 'thread_dogs']],
    ),
    functions: await q(
      `SELECT proname, pg_get_functiondef(oid) AS def,
              has_function_privilege('anon', oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', oid, 'EXECUTE') AS authenticated
         FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)
        ORDER BY 1`,
      [RS3_FUNCTIONS],
    ),
    grants: await q(
      `SELECT c.relname,
              has_table_privilege('anon', c.oid, 'SELECT') AS anon,
              has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) AND c.relkind = 'r'
        ORDER BY 1`,
      [['message_staff_reads', 'message_pushes']],
    ),
    systemRow: (await q(SYSTEM_ROW))[0],
  };
}

/**
 * Item 20 (the messaging take-back; build DECISIONS 770 (a), her default; HANDBACK §4 item 20): M5.28
 * marks every family message that exists when it runs as read for every live staffer, since the
 * portal already showed them. Without it every old thread rings every bell and her old messages
 * read *Sent*. A removed staffer gets no row, and neither does the school's system row (no
 * person: `livePrincipal`). A message sent after the step is unread. Production is born clean, so
 * there the step inserts nothing. Its own scratch databases, so the harness above keeps its rows.
 */
const BF_OWNER = 'a1a1a1a1-0000-4000-8000-0000000000b1';
const BF_LIVE_1 = 'cccccccc-0000-4000-8000-0000000000b1';
const BF_LIVE_2 = 'cccccccc-0000-4000-8000-0000000000b2';
const BF_REMOVED = 'cccccccc-0000-4000-8000-0000000000b3';
const BF_THREAD = '10000000-0000-4000-8000-0000000000b1';
const BF_HERS = '44444444-0000-4000-8000-0000000000b1';
const BF_STAFF_REPLY = '44444444-0000-4000-8000-0000000000b2';

describe(
  'M5.28, item 20: family messages from before the step are read for every live staffer',
  NO_DB,
  () => {
    let backfill: { name: string; url: string } | undefined;
    let empty: { name: string; url: string } | undefined;
    let bf: pg.Client;
    let em: pg.Client;

    before(async () => {
      if (ADMIN_URL === undefined) return;
      backfill = await createScratch('rs3_backfill');
      bf = new pg.Client({ connectionString: backfill.url });
      await bf.connect();
      await bf.query(fs.readFileSync(PRE_UNIT, 'utf8'));
      await bf.query(`INSERT INTO owners (id, name) VALUES ($1, 'Allison')`, [BF_OWNER]);
      await bf.query(
        `INSERT INTO staff (id, supabase_uid, name, role, home_locations, expired_at)
       VALUES ($1, gen_random_uuid(), 'Amber', 'manager', '{bentonville}', NULL),
              ($2, gen_random_uuid(), 'Rachel', 'trainer', '{fayetteville}', NULL),
              ($3, gen_random_uuid(), 'Gone', 'trainer', '{bentonville}', '2026-11-10T00:00:00Z')`,
        [BF_LIVE_1, BF_LIVE_2, BF_REMOVED],
      );
      await bf.query(
        `INSERT INTO threads (id, owner_id, participant_staff_id, category, title, sub_text)
       VALUES ($1, $2, $3, 'sessions', 'Sessions', '')`,
        [BF_THREAD, BF_OWNER, BF_LIVE_1],
      );
      await bf.query(
        `INSERT INTO messages (id, thread_id, sender_kind, sender_owner_id, sender_staff_id, text, sent_at)
       VALUES ($1, $3, 'owner', $4, NULL, 'before the step', '2026-11-01T09:00:00Z'),
              ($2, $3, 'staff', NULL, $5, 'a reply, before the step', '2026-11-01T10:00:00Z')`,
        [BF_HERS, BF_STAFF_REPLY, BF_THREAD, BF_OWNER, BF_LIVE_1],
      );
      await bf.query('DELETE FROM audit_log');

      empty = await createScratch('rs3_backfill_empty');
      em = new pg.Client({ connectionString: empty.url });
      await em.connect();
      await em.query(fs.readFileSync(PRE_UNIT, 'utf8'));
      await em.query(
        `INSERT INTO staff (id, supabase_uid, name, role, home_locations)
       VALUES ($1, gen_random_uuid(), 'Amber', 'manager', '{bentonville}')`,
        [BF_LIVE_1],
      );
    });

    after(async () => {
      await bf?.end().catch(() => undefined);
      await em?.end().catch(() => undefined);
      if (backfill !== undefined) await dropScratch(backfill.name);
      if (empty !== undefined) await dropScratch(empty.name);
    });

    const readers = async (c: pg.Client, messageId: string): Promise<string[]> =>
      (
        await c.query<{ staff_id: string }>(
          'SELECT staff_id::text AS staff_id FROM message_staff_reads WHERE message_id = $1 ORDER BY 1',
          [messageId],
        )
      ).rows.map((r) => r.staff_id);

    /** `staff_unread_count` as `threadsRepository.findStaffUnreadCounts` counts it, for one staffer. */
    const unreadFor = async (c: pg.Client, staffId: string): Promise<number> =>
      (
        await c.query<{ n: number }>(
          `SELECT count(m.id)::int AS n FROM messages m
           LEFT JOIN message_staff_reads r ON r.message_id = m.id AND r.staff_id = $2
          WHERE m.thread_id = $1 AND m.sender_kind = 'owner' AND m.expired_at IS NULL
            AND r.message_id IS NULL`,
          [BF_THREAD, staffId],
        )
      ).rows[0]?.n ?? -1;

    test('after M5.26–M5.28, her message is read for both live staffers and not for the removed one; the school and a staff reply get no row', async () => {
      for (const step of ['M5.26', 'M5.27', 'M5.28']) await applyOk(bf, step);
      assert.deepEqual(await readers(bf, BF_HERS), [BF_LIVE_1, BF_LIVE_2]);
      assert.equal(await unreadFor(bf, BF_LIVE_1), 0, 'a live staffer still has it unread');
      assert.equal(await unreadFor(bf, BF_LIVE_2), 0, 'a live staffer still has it unread');
      assert.equal(await unreadFor(bf, BF_REMOVED), 1, 'the removed staffer was marked');
      const school = await bf.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM message_staff_reads r JOIN staff s ON s.id = r.staff_id
        WHERE s.is_system_account`,
      );
      assert.equal(school.rows[0]?.n, 0, 'the school system row was marked');
      assert.deepEqual(await readers(bf, BF_STAFF_REPLY), [], 'a staff message was marked');
      const audit = await bf.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'message_staff_reads'`,
      );
      assert.equal(audit.rows[0]?.n, 0, 'the backfill wrote audit rows');
    });

    test('a family message sent after rs3 is unread for both live staffers', async () => {
      await applyOk(bf, 'M5.29');
      await applyOk(bf, 'M5.30');
      const { rows } = await bf.query<{ id: string }>(
        `INSERT INTO messages (thread_id, sender_kind, sender_owner_id, text)
       VALUES ($1, 'owner', $2, 'after the step') RETURNING id::text AS id`,
        [BF_THREAD, BF_OWNER],
      );
      assert.deepEqual(await readers(bf, rows[0]?.id as string), []);
      assert.equal(await unreadFor(bf, BF_LIVE_1), 1);
      assert.equal(await unreadFor(bf, BF_LIVE_2), 1);
    });

    test('on a database with no messages (production is born clean) the step inserts nothing', async () => {
      for (const step of ['M5.26', 'M5.27', 'M5.28']) await applyOk(em, step);
      const { rows } = await em.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM message_staff_reads',
      );
      assert.equal(rows[0]?.n, 0);
    });
  },
);
