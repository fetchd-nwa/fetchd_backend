import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import { parseStep } from '../../src/db/migrate.js';
import { serviceRates } from '../../src/db/schema/schema.js';
import { EVALUATION_RATE_SEED_IDS, seedFixture } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * P12 B3: the three LG2 steps this unit adds. The rehearsal proves their DDL
 * against schema.sql, but its fingerprint reads no seed rows, so the M3.05 test
 * here is the only proof of those two rows (DECISIONS 118(c)).
 */

registerFixtureHooks();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const M305_NAME = 'M3.05_evaluation_rates.sql';
const M305_PATH = path.join(REPO_ROOT, 'migrations', 'lg2', M305_NAME);
const SCHEMA_PATH = path.join(REPO_ROOT, '.claude', 'backend', 'schema.sql');

const EVALUATION_ROWS = `
  SELECT id, category, location, amount_cents, unit, effective_from::text, effective_to::text,
         note, created_by_staff_id, voided_at, voided_by_staff_id
    FROM service_rates WHERE category = 'evaluation' ORDER BY location`;

/** Every `service_rates` INSERT in a SQL text. */
function seedStatementsIn(sqlText: string): string[] {
  return sqlText.match(/^\s*insert\s+into\s+(?:public\.)?service_rates\b[\s\S]*?;\s*$/gim) ?? [];
}

/** Every `service_rates` seed statement in schema.sql, which a fresh volume ran at init. */
function schemaSeedStatements(): string[] {
  const statements = seedStatementsIn(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  assert.ok(statements.length > 0, 'schema.sql carries an INSERT INTO service_rates');
  return statements;
}

test('the seed reader finds the INSERT however schema.sql spells it', () => {
  for (const spelling of [
    `INSERT INTO service_rates (id) VALUES ('a');`,
    `insert into service_rates (id) values ('a');`,
    `Insert Into  service_rates (id) VALUES ('a');`,
    `  INSERT INTO service_rates (id) VALUES ('a');`,
    `INSERT\n  INTO service_rates (id) VALUES ('a');`,
    `INSERT INTO public.service_rates (id) VALUES ('a');`,
    `INSERT INTO service_rates (id) VALUES ('a') ;  `,
  ]) {
    const found = seedStatementsIn(`SELECT 1;\n${spelling}\nSELECT 2;\n`);
    assert.equal(found.length, 1, `missed: ${JSON.stringify(spelling)}`);
    assert.ok(found[0]?.includes(`('a')`), `cut short: ${JSON.stringify(spelling)}`);
  }
  assert.deepEqual(seedStatementsIn('INSERT INTO service_rates_archive (id) VALUES (1);\n'), []);
});

test(
  "M3.05: its bytes run twice in a rolled-back transaction find exactly two rows, equal to schema.sql's and the volume's",
  SKIP_WHEN_NO_DB,
  async () => {
    const bytes = fs.readFileSync(M305_PATH);
    const parsed = parseStep(M305_NAME, bytes);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const volume = (await client.query(EVALUATION_ROWS)).rows;
      assert.equal(volume.length, 2, 'the volume holds the two seed rows');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.actor', 'system:migrate-M3.05', true)`);

      await client.query(`DELETE FROM service_rates WHERE category = 'evaluation'`);
      assert.equal((await client.query(EVALUATION_ROWS)).rows.length, 0, 'the rows are removed');
      await client.query(bytes.toString('utf8'));
      await client.query(bytes.toString('utf8'));
      const fromStep = (await client.query(EVALUATION_ROWS)).rows;
      assert.equal(fromStep.length, 2, 'two runs of the step leave two rows');
      assert.deepEqual(fromStep.map((r) => r.id).sort(), [...EVALUATION_RATE_SEED_IDS].sort());
      assert.deepEqual(
        fromStep.map((r) => [r.location, r.amount_cents, r.unit, r.effective_from, r.effective_to]),
        [
          ['bentonville', 0, 'per-session', '2025-01-01', null],
          ['fayetteville', 0, 'per-session', '2025-01-01', null],
        ],
      );

      await client.query(`DELETE FROM service_rates WHERE category = 'evaluation'`);
      for (const statement of schemaSeedStatements()) await client.query(statement);
      const fromSchema = (await client.query(EVALUATION_ROWS)).rows;
      assert.deepEqual(fromStep, fromSchema, "the step's rows are schema.sql's rows");
      assert.deepEqual(fromStep, volume, "the step's rows are the volume's rows");
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  },
);

test(
  'the fixture keeps the two seed rows: it reopens one a test closed, and removes every other row',
  SKIP_WHEN_NO_DB,
  async () => {
    const [closed] = EVALUATION_RATE_SEED_IDS as [string, string];
    await db
      .update(serviceRates)
      .set({ effectiveTo: '2026-06-01', voidedAt: new Date().toISOString() })
      .where(eq(serviceRates.id, closed));
    const stray = randomUUID();
    await db.insert(serviceRates).values({
      id: stray,
      category: 'evaluation',
      location: 'fayetteville',
      amountCents: 0,
      unit: 'per-session',
      effectiveFrom: '2026-06-01',
    });

    await seedFixture();

    const rows = await db
      .select({
        id: serviceRates.id,
        effectiveTo: serviceRates.effectiveTo,
        voidedAt: serviceRates.voidedAt,
      })
      .from(serviceRates)
      .where(eq(serviceRates.category, 'evaluation'));
    assert.deepEqual(
      rows.sort((a, b) => a.id.localeCompare(b.id)),
      [...EVALUATION_RATE_SEED_IDS].sort().map((id) => ({ id, effectiveTo: null, voidedAt: null })),
    );
  },
);

test(
  'M2.16 and M2.17: the volume has dogs.last_seen_on date NULL, and pending_requests has none of the four divert columns or the FK',
  SKIP_WHEN_NO_DB,
  async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const seen = await client.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'dogs' AND column_name = 'last_seen_on'`,
      );
      assert.deepEqual(seen.rows, [{ data_type: 'date', is_nullable: 'YES' }]);

      const gone = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'pending_requests'
            AND column_name IN ('divert_reasons', 'location', 'payment', 'payment_method_id')`,
      );
      assert.deepEqual(gone.rows, []);

      const fk = await client.query(
        `SELECT conname FROM pg_constraint
          WHERE conname = 'pending_requests_payment_method_id_fkey'`,
      );
      assert.deepEqual(fk.rows, []);
    } finally {
      await client.end();
    }
  },
);
