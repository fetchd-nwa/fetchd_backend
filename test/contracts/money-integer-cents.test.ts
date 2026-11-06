import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { SKIP_WHEN_NO_DB } from './_harness.js';

/**
 * TAX-10: money is a whole number of cents in USD, everywhere it is stored. No other
 * test asked the schema, so a column turned `numeric` would have stayed green while
 * half-cents crept into a refund's ceiling. What this reads is the database it runs
 * against, which is the point: the running test volume, not the text of `schema.sql`.
 */

test('TAX-10: every *_cents column in a base table is an integer', SKIP_WHEN_NO_DB, async () => {
  const columns = await db.execute<{ table_name: string; column_name: string; data_type: string }>(
    sql`
      SELECT c.table_name, c.column_name, c.data_type
        FROM information_schema.columns c
        JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND c.column_name LIKE '%\_cents'
    `,
  );

  const tables = new Set(columns.rows.map((c) => c.table_name));
  for (const table of ['charges', 'invoices', 'refunds', 'credit_packages', 'service_rates']) {
    assert.ok(tables.has(table), `the query reached ${table}, or its silence proves nothing`);
  }
  assert.deepEqual(
    columns.rows.filter((c) => c.data_type !== 'integer'),
    [],
    'no money column may hold a fraction of a cent',
  );
});

test('TAX-10: every stored currency is USD by default', SKIP_WHEN_NO_DB, async () => {
  const columns = await db.execute<{ table_name: string; column_default: string | null }>(sql`
    SELECT table_name, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'currency'
  `);

  const tables = new Set(columns.rows.map((c) => c.table_name));
  assert.ok(tables.has('charges'), 'the query reached charges');
  assert.deepEqual(
    columns.rows.filter((c) => !(c.column_default ?? '').startsWith("'usd'")),
    [],
  );
});
