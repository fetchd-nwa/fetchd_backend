import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { sql } from 'drizzle-orm';
import type { CreditLotDetailWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';
import { registerStaffCreditsRoute } from '../../src/routes/staffCredits.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearPlantedPools, plantLot } from './_poolFixture.js';

/**
 * P18's hand-edit low (a), Opus r1 N1 (P20 B1-9): `last_expiry_edit` names the edit that
 * committed last. Two moves of one lot whose transactions begin in one order and commit
 * in the other: the one that began first waits at its claim, the other runs and
 * commits, then the first runs and commits. Ordered by `created_at` (the transaction's
 * start) the read named the edit that was overwritten.
 */

registerFixtureHooks();
afterEach(async () => {
  await clearPlantedPools();
});

const CLOCK = new Date('2026-10-13T15:00:00Z');

test(
  'two racing expiry edits: the read names the edit that committed last',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 3, expiresAt: '2038-06-01T00:00:00.000Z' });
    const { app, authenticate } = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
    registerStaffCreditsRoute(app, { authenticate, now: () => CLOCK });
    const move = (key: string, expiresAt: string, note: string) =>
      app.inject({
        method: 'PATCH',
        url: `/staff/credit-lots/${lotId}`,
        headers: { 'idempotency-key': key },
        payload: { expires_at: expiresAt, note },
      });

    // The first edit's transaction begins, then waits on a claim a third connection holds.
    const firstKey = `p20-lot-first-${randomUUID()}`;
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(
      `INSERT INTO idempotency_keys (key, endpoint, request_hash) VALUES ($1, 'held', 'held')`,
      [firstKey],
    );
    const first = move(firstKey, '2039-01-01T06:00:00.000Z', 'began first, committed last');
    try {
      for (let tries = 0; ; tries += 1) {
        const { rows } = await db.execute(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        if ((rows[0] as { n: number }).n >= 1) break;
        assert.ok(tries < 300, 'the first edit never reached its claim');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // A short pause so the second edit's transaction starts measurably later.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await move(
        `p20-lot-second-${randomUUID()}`,
        '2038-12-01T06:00:00.000Z',
        'began second, committed first',
      );
      assert.equal(second.statusCode, 200, second.body);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const firstRes = await first;
    assert.equal(firstRes.statusCode, 200, firstRes.body);
    const moved = JSON.parse(firstRes.body) as CreditLotDetailWire;
    assert.equal(moved.expires_at, '2039-01-01T06:00:00.000Z', 'the lot carries the last commit');
    assert.equal(moved.last_expiry_edit?.note, 'began first, committed last');
    assert.equal(moved.last_expiry_edit?.to, '2039-01-01T06:00:00.000Z');
    assert.equal(
      moved.last_expiry_edit?.from,
      '2038-12-01T06:00:00.000Z',
      'it moved the date the other edit left',
    );
  },
);
