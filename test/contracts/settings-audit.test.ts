import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Principal } from '../../src/auth/principal.js';
import { pool } from '../../src/db/pool.js';
import { AUDITED_SETTINGS_TABLES } from '../../src/lib/settingsRegistry.js';
import { registerStaffDayCapacityRoute } from '../../src/routes/staffDayCapacity.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

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

// The day_capacity cases at the end go through the real route, whose stamp is a
// foreign key to `staff`, so the fixture's staff have to exist.
registerFixtureHooks();

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
        `INSERT INTO day_capacity (location, date, capacity_dogs)
         VALUES ('fayetteville', DATE '2031-03-03', 3)`,
      );
      await client.query(
        `UPDATE day_capacity SET capacity_dogs = 4 WHERE location = 'fayetteville' AND date = DATE '2031-03-03'`,
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

/**
 * **A date's first PUT is an INSERT, and `audit_capture` fires only on UPDATE or
 * DELETE** (P13 fix round 1, Opus M2). So the row itself names who set the date
 * (STAFF-74: "every setting edit records the staff member who made it and the
 * time"), which is the one record of who opened a Saturday. Each later edit also
 * leaves the value it replaced in `audit_log`, as every settings table does.
 *
 * Donavan, the fixture's trainer, is the second staffer in these cases.
 */
describe('STAFF-74 on day_capacity: the row names who set the date', SKIP_WHEN_NO_DB, () => {
  const AMBER = FIXTURE_IDS.staffAmberId;
  const DONAVAN = FIXTURE_IDS.staffDonavanId;
  const DATE = '2031-06-07'; // a Saturday no fixture row touches

  function appAs(principal: Principal): FastifyInstance {
    const { app, authenticate } = makeContractApp(principal);
    registerStaffDayCapacityRoute(app, { authenticate });
    return app;
  }

  function putAs(principal: Principal, capacity: number) {
    return appAs(principal).inject({
      method: 'PUT',
      url: `/staff/day-capacity/fayetteville/${DATE}`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { capacity_dogs: capacity },
    });
  }

  function deleteAs(principal: Principal) {
    return appAs(principal).inject({
      method: 'DELETE',
      url: `/staff/day-capacity/fayetteville/${DATE}`,
      headers: { 'idempotency-key': randomUUID() },
    });
  }

  interface Row {
    capacity_dogs: number;
    expired_at: string | null;
    updated_at: Date;
    updated_by_staff_id: string | null;
  }

  async function theRow(): Promise<Row | undefined> {
    const res = await pool.query<Row>(
      `SELECT capacity_dogs, expired_at, updated_at, updated_by_staff_id
         FROM day_capacity WHERE location = 'fayetteville' AND date = $1`,
      [DATE],
    );
    return res.rows[0];
  }

  interface AuditRow {
    op: string;
    actor: string | null;
    before: { capacity_dogs: number; updated_by_staff_id: string | null };
  }

  async function auditRows(): Promise<AuditRow[]> {
    const res = await pool.query<AuditRow>(
      `SELECT op, actor, before FROM audit_log
        WHERE table_name = 'day_capacity' AND row_pk = $1 ORDER BY at, id`,
      [DATE],
    );
    return res.rows;
  }

  afterEach(async () => {
    await pool.query(`DELETE FROM day_capacity WHERE date = $1`, [DATE]);
    await pool.query(`DELETE FROM audit_log WHERE table_name = 'day_capacity' AND row_pk = $1`, [
      DATE,
    ]);
  });

  test("Amber's first PUT is an INSERT: the row names her and a time, and audit_log has nothing", async () => {
    const before = Date.now();
    const res = await putAs(FIXTURE_MANAGER_PRINCIPAL, 4);
    assert.equal(res.statusCode, 200, res.body);

    const row = await theRow();
    assert.equal(row?.capacity_dogs, 4);
    assert.equal(row?.updated_by_staff_id, AMBER);
    const stamped = row?.updated_at.getTime() ?? 0;
    assert.ok(Math.abs(stamped - before) < 60_000, `stamped ${row?.updated_at.toISOString()}`);
    assert.deepEqual(await auditRows(), [], 'the trigger does not see an INSERT');

    // The wire does not change: no staff id is served.
    assert.deepEqual(Object.keys(res.json() as object).sort(), [
      'capacity_dogs',
      'date',
      'location',
      'remaining_dogs',
    ]);
  });

  test("a second PUT by Donavan: the row names him, and audit_log keeps Amber's value and name", async () => {
    await putAs(FIXTURE_MANAGER_PRINCIPAL, 4);
    const first = await theRow();

    const res = await putAs(FIXTURE_STAFF_PRINCIPAL, 6);
    assert.equal(res.statusCode, 200, res.body);

    const row = await theRow();
    assert.equal(row?.capacity_dogs, 6);
    assert.equal(row?.updated_by_staff_id, DONAVAN);
    assert.ok(
      (row?.updated_at.getTime() ?? 0) > (first?.updated_at.getTime() ?? Infinity),
      'the second edit moves the time',
    );

    const audit = await auditRows();
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.op, 'UPDATE');
    assert.equal(audit[0]?.before.capacity_dogs, 4);
    assert.equal(audit[0]?.before.updated_by_staff_id, AMBER);
    assert.match(audit[0]?.actor ?? '', new RegExp(DONAVAN));
  });

  test('a withdrawal stamps its actor, not the staffer who set the value', async () => {
    await putAs(FIXTURE_MANAGER_PRINCIPAL, 4);
    const set = await theRow();

    const res = await deleteAs(FIXTURE_STAFF_PRINCIPAL);
    assert.equal(res.statusCode, 200, res.body);

    const row = await theRow();
    assert.notEqual(row?.expired_at, null);
    assert.equal(row?.updated_by_staff_id, DONAVAN);
    assert.ok((row?.updated_at.getTime() ?? 0) > (set?.updated_at.getTime() ?? Infinity));
  });

  test('a DELETE that finds no live override changes neither column', async () => {
    await putAs(FIXTURE_MANAGER_PRINCIPAL, 4);
    await deleteAs(FIXTURE_MANAGER_PRINCIPAL);
    const withdrawn = await theRow();
    const auditBefore = (await auditRows()).length;

    const res = await deleteAs(FIXTURE_STAFF_PRINCIPAL);
    assert.equal(res.statusCode, 200, res.body);

    const row = await theRow();
    assert.equal(row?.updated_by_staff_id, AMBER, 'the withdrawal still names its author');
    assert.deepEqual(row?.updated_at, withdrawn?.updated_at);
    assert.equal((await auditRows()).length, auditBefore, 'and nothing was written');
  });

  test('a DELETE on a date with no row at all writes nothing', async () => {
    const res = await deleteAs(FIXTURE_STAFF_PRINCIPAL);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await theRow(), undefined);
  });

  test('a PUT that re-opens a withdrawn date stamps whoever re-opened it', async () => {
    await putAs(FIXTURE_MANAGER_PRINCIPAL, 4);
    await deleteAs(FIXTURE_MANAGER_PRINCIPAL);

    const res = await putAs(FIXTURE_STAFF_PRINCIPAL, 2);
    assert.equal(res.statusCode, 200, res.body);

    const row = await theRow();
    assert.equal(row?.expired_at, null);
    assert.equal(row?.capacity_dogs, 2);
    assert.equal(row?.updated_by_staff_id, DONAVAN);
  });
});
