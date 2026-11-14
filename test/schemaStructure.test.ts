import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import {
  parseSchemaStructure,
  readDatabaseStructure,
  structureDifferences,
  type SchemaStructure,
} from '../scripts/schema-structure.js';
import { assertTestDatabaseUrl } from './contracts/_dbGuard.js';

/**
 * `db:dev:check`'s structural half (P21 B-2; DECISIONS 264(c), 265(c)): the tables, columns
 * and enum labels `schema.sql` creates, parsed from the file at run time, compared both ways
 * with a database's catalog. These tests pin the parse on the forms that would fool it, the
 * refusals that keep it from passing what it cannot read, the comparison's every arm, and
 * (the honesty proof) the real `schema.sql` against the test database, which is a fresh load
 * of it: zero differences.
 */

const structure = (
  tables: Record<string, string[]>,
  enums: Record<string, string[]> = {},
): SchemaStructure => ({
  tables: new Map(Object.entries(tables).map(([t, cols]) => [t, new Set(cols)])),
  enums: new Map(Object.entries(enums)),
});

describe('parseSchemaStructure', () => {
  test('reads tables, columns and enum labels; never a table in a comment, a string or a function body', () => {
    const sql = `
      -- CREATE TABLE ghost_in_a_line_comment (x int);
      /* CREATE TABLE ghost_in_a_block (x int); /* nested */ CREATE TYPE ghost AS ENUM ('x'); */
      CREATE TYPE mood AS ENUM ('calm', 'it''s busy', 'payment-pending');
      CREATE TYPE   "Quoted Enum"   AS   ENUM
        ('a');
      CREATE TABLE alpha (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        note        text DEFAULT 'a ; semicolon -- and a dash, (and a paren',
        "Odd Name"  int,
        price_cents int NOT NULL CHECK (price_cents >= 0 AND price_cents IN (1, 2, 3)),
        CONSTRAINT alpha_note_ck CHECK (note <> ''),
        UNIQUE (id, price_cents),
        PRIMARY KEY (id),
        FOREIGN KEY (id) REFERENCES beta(id) ON DELETE CASCADE,
        EXCLUDE USING gist (id WITH =)
      );
      CREATE FUNCTION f() RETURNS void AS $body$
        BEGIN CREATE TABLE ghost_in_a_body (x int); END;
      $body$ LANGUAGE plpgsql;
      DO $$ BEGIN EXECUTE 'CREATE TABLE ghost_in_do (x int)'; END $$;
      CREATE TABLE beta (id uuid, alpha_id uuid REFERENCES alpha(id));
      ALTER TABLE beta
        ADD CONSTRAINT beta_alpha_fk FOREIGN KEY (alpha_id) REFERENCES alpha(id);
      CREATE INDEX beta_idx ON beta (alpha_id);
      COMMENT ON TABLE beta IS 'CREATE TABLE ghost_in_a_comment_string (x int);';
      INSERT INTO beta (id) VALUES (gen_random_uuid());
    `;
    const parsed = parseSchemaStructure(sql);
    assert.deepEqual(
      [...parsed.tables].map(([t, cols]) => [t, [...cols]]),
      [
        ['alpha', ['id', 'note', 'Odd Name', 'price_cents']],
        ['beta', ['id', 'alpha_id']],
      ],
    );
    assert.deepEqual(
      [...parsed.enums],
      [
        ['mood', ['calm', "it's busy", 'payment-pending']],
        ['Quoted Enum', ['a']],
      ],
    );
  });

  for (const [form, sql] of [
    ['ALTER TABLE … ADD COLUMN', 'CREATE TABLE a (x int); ALTER TABLE a ADD COLUMN y int;'],
    [
      'ALTER TABLE … ADD <column> (no COLUMN word)',
      'CREATE TABLE a (x int); ALTER TABLE a ADD y int;',
    ],
    ['ALTER TABLE … DROP COLUMN', 'CREATE TABLE a (x int, y int); ALTER TABLE a DROP COLUMN y;'],
    ['ALTER TABLE … RENAME', 'CREATE TABLE a (x int); ALTER TABLE a RENAME x TO y;'],
    ['ALTER TYPE … ADD VALUE', "CREATE TYPE e AS ENUM ('a'); ALTER TYPE e ADD VALUE 'b';"],
    ['a composite CREATE TYPE', 'CREATE TYPE c AS (x int);'],
    ['CREATE TABLE … (LIKE …)', 'CREATE TABLE a (x int); CREATE TABLE b (LIKE a);'],
    ['CREATE TABLE … AS', 'CREATE TABLE a AS SELECT 1 AS x;'],
    [
      'CREATE TABLE … PARTITION OF',
      'CREATE TABLE a (x int); CREATE TABLE a1 PARTITION OF a FOR VALUES IN (1);',
    ],
    ['CREATE TABLE … INHERITS', 'CREATE TABLE a (x int); CREATE TABLE b (y int) INHERITS (a);'],
    ['DROP TABLE', 'CREATE TABLE a (x int); DROP TABLE a;'],
    ['a table created twice', 'CREATE TABLE a (x int); CREATE TABLE a (y int);'],
  ] as const) {
    test(`refuses what it cannot read rather than pass it: ${form}`, () => {
      assert.throws(() => parseSchemaStructure(sql), /schema-structure cannot read/);
    });
  }
});

describe('structureDifferences', () => {
  test('names every difference, both ways, and nothing when they agree', () => {
    const expected = structure(
      { booking_dogs: ['booking_id', 'dog_id', 'after_school'], checkin_events: ['id'] },
      { ledger_reason: ['purchase', 'booking-debit'], gone_enum: ['x'] },
    );
    const actual = structure(
      {
        booking_dogs: ['booking_id', 'dog_id', 'attendance'],
        after_school_optins: ['booking_id'],
      },
      { ledger_reason: ['booking-debit', 'purchase'], extra_enum: ['y'] },
    );
    assert.deepEqual(structureDifferences(expected, actual), [
      'table checkin_events: in schema.sql, absent here',
      'table after_school_optins: here, not in schema.sql',
      'column booking_dogs.after_school: in schema.sql, absent here',
      'column booking_dogs.attendance: here, not in schema.sql',
      'enum gone_enum: in schema.sql, absent here',
      'enum extra_enum: here, not in schema.sql',
      'enum ledger_reason: labels differ: schema.sql (purchase, booking-debit), here (booking-debit, purchase)',
    ]);
    assert.deepEqual(structureDifferences(expected, expected), []);
  });
});

describe('the real schema.sql against the test database (a fresh load of it)', () => {
  after(async () => {
    await pool.end();
  });

  test('zero differences: the parse is honest about every table, column and enum the load made', async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL ?? '');
    const schemaPath = fileURLToPath(new URL('../.claude/backend/schema.sql', import.meta.url));
    const expected = parseSchemaStructure(readFileSync(schemaPath, 'utf8'));
    assert.ok(expected.tables.size > 50, `parsed ${expected.tables.size} tables`);
    assert.ok(expected.enums.size > 20, `parsed ${expected.enums.size} enums`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      const actual = await readDatabaseStructure((text) => client.query(text));
      await client.query('ROLLBACK');
      assert.deepEqual(structureDifferences(expected, actual), []);
    } finally {
      client.release();
    }
  });
});
