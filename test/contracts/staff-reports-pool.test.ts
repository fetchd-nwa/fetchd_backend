import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { inArray, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { reports } from '../../src/db/schema/schema.js';
import { registerStaffReportsRoute } from '../../src/routes/staffReports.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { postJson } from './_messaging.js';
import { makePoolHangKit } from './_poolHang.js';

/**
 * M1's second shape (pass 2 fix 1; found by running every pass-2 transactional verb on a pool of
 * one connection): `POST /staff/reports` re-reads the report it wrote and resolves the trainer's
 * name INSIDE its transaction (`wireOneReport`), and that name read went to the pool. Pass 2's
 * Fork A put the trainer check in this transaction and changed that read (`findNamesByIds`). Ten
 * reports at once then hold all ten pooled connections and each waits for an eleventh: the whole
 * API hangs. Ten for one dog provably overlap (`_poolHang.ts`): a connection of the test's own
 * holds the dog row `FOR UPDATE`, which every report's insert waits on (its foreign key), until all
 * ten are blocked inside their transactions. Then all ten must answer 201 within 10 s of the
 * database clock, each naming its trainer as before. The red run ends by itself (a test timeout,
 * then the pool force-ended in the `after` hook registered before the fixture's).
 */

const REPORTS = 10;
const BOUND_SECONDS = 10;

const kit = makePoolHangKit();
const reportIds: string[] = [];

after(async () => {
  await kit.release('staff-reports-pool');
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  const { rows } = await db.execute<{ id: string }>(
    sql`SELECT id::text FROM reports WHERE excerpt LIKE 'pool-in-transaction %'`,
  );
  reportIds.push(...rows.map((r) => r.id));
  if (reportIds.length > 0) {
    await db.execute(
      sql`DELETE FROM notifications WHERE deep_link_kind = 'report' AND deep_link_id = ANY(${sql.param(reportIds)}::uuid[])`,
    );
    await db.delete(reports).where(inArray(reports.id, reportIds));
  }
});

registerFixtureHooks();

test(
  'ten POST /staff/reports at once for one dog all answer 201 within 10 s of the database clock, each naming its trainer',
  { ...SKIP_WHEN_NO_DB, timeout: 45_000 },
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffReportsRoute(app, { authenticate });
    const { results, seconds } = await kit.overlapAll(
      'SELECT 1 FROM dogs WHERE id = $1 FOR UPDATE',
      [FIXTURE_IDS.dog1Id],
      REPORTS,
      () =>
        Array.from({ length: REPORTS }, (_, i) =>
          postJson(
            app,
            '/staff/reports',
            {
              dog_id: FIXTURE_IDS.dog1Id,
              date: '2026-05-20T15:00:00Z',
              category: 'group-class',
              program: 'foundation',
              excerpt: `pool-in-transaction ${i}`,
              full_text: 'Waffles held a down-stay through two distractions.',
              trainer_staff_id: FIXTURE_IDS.staffAmberId,
            },
            `reports-pool-${randomUUID()}`,
          ),
        ),
    );
    reportIds.push(
      ...results.filter((r) => r.statusCode === 201).map((r) => (r.json() as { id: string }).id),
    );
    assert.deepEqual(
      results.map((r) => r.statusCode),
      Array<number>(REPORTS).fill(201),
      results.map((r) => r.body.slice(0, 200)).join('\n'),
    );
    assert.ok(
      seconds < BOUND_SECONDS,
      `ten reports took ${seconds} s on the database clock (bound ${BOUND_SECONDS} s)`,
    );
    assert.deepEqual(
      [...new Set(results.map((r) => (r.json() as { trainer?: string }).trainer))],
      ['Amber'],
      'each report names its trainer, read on its own transaction',
    );
  },
);
