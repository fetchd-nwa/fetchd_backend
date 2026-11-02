import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type pg from 'pg';
import { pool } from '../../src/db/pool.js';
import { AUDITED_SETTINGS_TABLES } from '../../src/lib/settingsRegistry.js';
import { SKIP_WHEN_NO_DB } from './_harness.js';

/**
 * **Every settings edit keeps the value it replaced** (STAFF-U22, M1.18;
 * design.md:2175-2178, §4 M1.18; STAFF-74).
 *
 * GENERATED from `AUDITED_SETTINGS_TABLES` — one case per table — so P02's
 * `staff_settings` joins this test by joining that list. For each table: UPDATE
 * one seeded row (its `updated_at`, which every settings table carries) under
 * a known actor, and expect exactly one `audit_log` row from that transaction,
 * with a non-null `row_pk`, the actor, and the replaced row as `before`.
 *
 * `audit_log.row_pk` is NOT NULL, so a table whose key `audit_capture()` cannot
 * name aborts the UPDATE outright (r3-opus #3) — the failure this test exists
 * to catch for every singleton (`id`), the key/scope table, the category and
 * field_key tables, and the two-tier tables' NULL-location global row.
 *
 * Each case runs in its own transaction and rolls back: no seed changes, and no
 * audit row is left behind.
 */

const ACTOR = 'system:settings-audit-test';

async function inRolledBackTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor', $1, true)", [ACTOR]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe(
  'R4 — an UPDATE of a seeded settings row writes exactly one audit_log row',
  SKIP_WHEN_NO_DB,
  () => {
    for (const table of AUDITED_SETTINGS_TABLES) {
      test(table, async () => {
        await inRolledBackTx(async (client) => {
          const updated = await client.query(
            `UPDATE ${table} SET updated_at = now() WHERE ctid = (SELECT ctid FROM ${table} LIMIT 1)`,
          );
          assert.equal(updated.rowCount, 1, `${table} has no seeded row to update`);
          const audit = await client.query<{
            row_pk: string | null;
            op: string;
            actor: string | null;
          }>(
            `SELECT row_pk, op, actor FROM audit_log WHERE table_name = $1 AND txid = txid_current()`,
            [table],
          );
          assert.equal(audit.rows.length, 1, `${table}: expected exactly one audit row`);
          const [row] = audit.rows;
          assert.ok(
            row !== undefined && row.row_pk !== null && row.row_pk !== '',
            `${table}: row_pk is empty`,
          );
          assert.equal(row.op, 'UPDATE');
          assert.equal(row.actor, ACTOR);
        });
      });
    }
  },
);

describe('row_pk names the row the way each table is keyed', SKIP_WHEN_NO_DB, () => {
  const cases: Array<{ table: string; where: string; rowPk: string }> = [
    { table: 'credit_settings', where: 'id', rowPk: 'true' },
    {
      table: 'payment_settings',
      where: "key = 'charge_timing_mode' AND scope = 'day-school'",
      rowPk: 'charge_timing_mode/day-school',
    },
    {
      table: 'payment_settings',
      where: "key = 'card_attempts_max_count'",
      rowPk: 'card_attempts_max_count/global',
    },
    { table: 'day_program_settings', where: 'location IS NULL', rowPk: '<global>' },
    { table: 'day_program_settings', where: "location = 'bentonville'", rowPk: 'bentonville' },
    { table: 'evaluation_settings', where: 'location IS NULL', rowPk: '<global>' },
    { table: 'credit_expiry_settings', where: 'location IS NULL', rowPk: '<global>' },
    { table: 'cancel_window_settings', where: "category = 'day-school'", rowPk: 'day-school' },
    { table: 'intake_field_settings', where: "field_key = 'feeding'", rowPk: 'feeding' },
    { table: 'dog_descriptors', where: "key = 'nervous'", rowPk: 'nervous' },
  ];
  for (const { table, where, rowPk } of cases) {
    test(`${table} WHERE ${where} → ${rowPk}`, async () => {
      await inRolledBackTx(async (client) => {
        await client.query(`UPDATE ${table} SET updated_at = now() WHERE ${where}`);
        const audit = await client.query<{ row_pk: string }>(
          'SELECT row_pk FROM audit_log WHERE table_name = $1 AND txid = txid_current()',
          [table],
        );
        assert.deepEqual(
          audit.rows.map((r) => r.row_pk),
          [rowPk],
        );
      });
    });
  }

  test('a day_capacity update still records its date (the new arms come after date)', async () => {
    await inRolledBackTx(async (client) => {
      await client.query(
        `INSERT INTO day_capacity (location, date, school_openings, daycare_openings)
         VALUES ('fayetteville', DATE '2031-03-03', 3, 3)`,
      );
      await client.query(
        `UPDATE day_capacity SET school_openings = 4 WHERE location = 'fayetteville' AND date = DATE '2031-03-03'`,
      );
      const audit = await client.query<{ row_pk: string }>(
        "SELECT row_pk FROM audit_log WHERE table_name = 'day_capacity' AND txid = txid_current()",
      );
      assert.deepEqual(
        audit.rows.map((r) => r.row_pk),
        ['2031-03-03'],
      );
    });
  });

  test("a DELETE keeps the deleted row's pre-image too", async () => {
    await inRolledBackTx(async (client) => {
      await client.query("DELETE FROM payment_settings WHERE key = 'seat_hold_max_minutes'");
      const audit = await client.query<{ op: string; before: { value: number } }>(
        "SELECT op, before FROM audit_log WHERE table_name = 'payment_settings' AND txid = txid_current()",
      );
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0]?.op, 'DELETE');
      assert.equal(audit.rows[0]?.before.value, 2);
    });
  });
});
