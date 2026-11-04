import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseStep } from '../../src/db/migrate.js';
import { SKIP_WHEN_NO_DB } from './_harness.js';

/**
 * P13 B1: M3.01's bytes against a throwaway table state. `day_capacity` here is a
 * temp table in the old shape, created inside a transaction that always rolls back:
 * `pg_temp` is searched first, so the step's unqualified name lands on it and the
 * real table is never touched. A temp table's foreign key may reference only another
 * temp table, so `staff` gets a temp stand-in beside it, which the same search lands
 * the step's `REFERENCES staff(id)` on. The rehearsal proves the step's DDL equals
 * schema.sql; it holds no rows, so only this test proves the refusal.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEP_NAME = 'M3.01_day_capacity_combined.sql';
const STEP_PATH = path.join(REPO_ROOT, 'migrations', 'lg3', STEP_NAME);

const OLD_SHAPE = `
  CREATE TEMP TABLE day_capacity (
    location          text NOT NULL,
    date              date NOT NULL,
    school_openings   integer NOT NULL CHECK (school_openings   >= 0),
    daycare_openings  integer NOT NULL CHECK (daycare_openings  >= 0),
    expired_at        timestamptz,
    PRIMARY KEY (location, date)
  ) ON COMMIT DROP`;

const STAFF_STAND_IN = `CREATE TEMP TABLE staff (id uuid PRIMARY KEY) ON COMMIT DROP`;

const COLUMNS_OF_TEMP = `
  SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
    FROM pg_attribute a
   WHERE a.attrelid = 'pg_temp.day_capacity'::regclass AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attname`;

const COLUMNS_OF_PUBLIC = `
  SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
    FROM pg_attribute a
   WHERE a.attrelid = 'public.day_capacity'::regclass AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attname`;

async function inThrowawayTransaction(run: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(OLD_SHAPE);
    await client.query(STAFF_STAND_IN);
    await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

function stepSql(): string {
  const bytes = fs.readFileSync(STEP_PATH);
  const parsed = parseStep(STEP_NAME, bytes);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return bytes.toString('utf8');
}

test('M3.01 parses as a step in one transaction', () => {
  const parsed = parseStep(STEP_NAME, fs.readFileSync(STEP_PATH));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  assert.equal(parsed.step.stepId, 'M3.01');
  assert.equal(parsed.step.directives.has('no-transaction'), false);
});

test(
  'M3.01 with a row in the table refuses by name and changes nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    await inThrowawayTransaction(async (client) => {
      await client.query(
        `INSERT INTO day_capacity (location, date, school_openings, daycare_openings)
       VALUES ('fayetteville', '2026-06-01', 2, 1)`,
      );
      const before = (await client.query(COLUMNS_OF_TEMP)).rows;
      await client.query('SAVEPOINT step');
      await assert.rejects(client.query(stepSql()), (err: { message: string; code: string }) => {
        assert.match(err.message, /M3\.01/, 'the refusal names the step');
        assert.match(err.message, /day_capacity/, 'and the table');
        assert.match(err.message, /1 row/, 'and how many rows it met');
        assert.equal(err.code, 'P0001', 'a RAISE EXCEPTION, not a NOT NULL accident');
        return true;
      });
      await client.query('ROLLBACK TO SAVEPOINT step');
      assert.deepEqual(
        (await client.query(COLUMNS_OF_TEMP)).rows,
        before,
        'the shape is unchanged',
      );
      const rows = await client.query(`SELECT school_openings, daycare_openings FROM day_capacity`);
      assert.deepEqual(rows.rows, [{ school_openings: 2, daycare_openings: 1 }]);
    });
  },
);

test(
  'M3.01 counts a soft-expired row too: a withdrawn override is still a row',
  SKIP_WHEN_NO_DB,
  async () => {
    await inThrowawayTransaction(async (client) => {
      await client.query(
        `INSERT INTO day_capacity (location, date, school_openings, daycare_openings, expired_at)
       VALUES ('fayetteville', '2026-06-01', 0, 0, now())`,
      );
      await assert.rejects(client.query(stepSql()), /M3\.01/);
    });
  },
);

test(
  'M3.01 on an empty table reshapes it, to the shape of the schema of record',
  SKIP_WHEN_NO_DB,
  async () => {
    await inThrowawayTransaction(async (client) => {
      await client.query(stepSql());
      const after = (await client.query(COLUMNS_OF_TEMP)).rows;
      assert.deepEqual(
        after.map((c: { name: string }) => c.name),
        ['capacity_dogs', 'date', 'expired_at', 'location', 'updated_at', 'updated_by_staff_id'],
      );
      assert.deepEqual(after, (await client.query(COLUMNS_OF_PUBLIC)).rows);

      await client.query(
        `INSERT INTO day_capacity (location, date, capacity_dogs) VALUES ('fayetteville', '2026-06-01', 0)`,
      );
      await client.query('SAVEPOINT negative');
      await assert.rejects(
        client.query(
          `INSERT INTO day_capacity (location, date, capacity_dogs) VALUES ('fayetteville', '2026-06-02', -1)`,
        ),
        /check constraint/,
      );
      await client.query('ROLLBACK TO SAVEPOINT negative');
      await client.query('SAVEPOINT missing');
      await assert.rejects(
        client.query(
          `INSERT INTO day_capacity (location, date) VALUES ('fayetteville', '2026-06-03')`,
        ),
        /null value/,
      );
      await client.query('ROLLBACK TO SAVEPOINT missing');

      // STAFF-74's pair: a row written with neither is stamped now, by nobody, and a
      // staffer's id must be one the staff table holds.
      const stamped = await client.query<{ fresh: boolean; by: string | null }>(
        `SELECT updated_at >= now() AS fresh, updated_by_staff_id AS by
           FROM day_capacity WHERE date = '2026-06-01'`,
      );
      assert.deepEqual(stamped.rows, [{ fresh: true, by: null }]);
      await client.query('SAVEPOINT stranger');
      await assert.rejects(
        client.query(
          `UPDATE day_capacity SET updated_by_staff_id = gen_random_uuid() WHERE date = '2026-06-01'`,
        ),
        /foreign key/,
      );
      await client.query('ROLLBACK TO SAVEPOINT stranger');
    });
  },
);
