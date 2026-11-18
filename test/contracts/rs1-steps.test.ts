import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseStep } from '../../src/db/migrate.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * Plan unit P49's steps (`migrations/rs1/`; design request-services-v1 §5.1). The rehearsal
 * proves M5.20–M5.22 against `schema.sql` (columns, constraints, enums and function bodies),
 * but it reads the rows of `credit_packages` and `service_rates` only, so a step that changes
 * other rows is proven here, on the test database, in one transaction that is rolled back.
 */

registerFixtureHooks();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEPS = path.join(REPO_ROOT, 'migrations', 'rs1');
const stepBytes = (name: string): Buffer => fs.readFileSync(path.join(STEPS, name));

const M520 = 'M5.20_notification_request_approved.sql';
const M523 = 'M5.23_stale_bt_requests.sql';

async function withClient(run: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

test('M5.20 runs outside a transaction (ALTER TYPE … ADD VALUE); M5.23 inside one', () => {
  const m520 = parseStep(M520, stepBytes(M520));
  assert.ok(m520.ok, m520.ok ? '' : m520.reason);
  assert.equal(m520.step.directives.has('no-transaction'), true);
  const m523 = parseStep(M523, stepBytes(M523));
  assert.ok(m523.ok, m523.ok ? '' : m523.reason);
  assert.equal(m523.step.directives.has('no-transaction'), false);
});

test(
  "M5.23 on planted rows: an old-flow approved-awaiting-payment row with no approved dates goes back to submitted with no approver; a new-flow row and a converted row stay as they were",
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      const oldFlow = randomUUID();
      const newFlow = randomUUID();
      const converted = randomUUID();
      const insert = `
        INSERT INTO pending_requests
          (id, owner_id, lead_dog_id, category, status, length_weeks, approved_at,
           approved_by_staff_id, approved_trainer_staff_id, approved_dropoff_at,
           approved_pickup_at, approved_price_cents)
        VALUES ($1, $2, $3, 'board-and-train', $4, 2, $5, $6, $7, $8, $9, $10)`;
      const owner = FIXTURE_IDS.ownerId;
      const dog = FIXTURE_IDS.dog1Id;
      const rachel = FIXTURE_IDS.staffRachelId;
      await client.query(insert, [
        oldFlow, owner, dog, 'approved-awaiting-payment', '2026-05-10T15:00:00Z', rachel,
        null, null, null, null,
      ]);
      await client.query(insert, [
        newFlow, owner, dog, 'approved-awaiting-payment', '2026-05-11T15:00:00Z', rachel,
        rachel, '2026-06-08T13:00:00Z', '2026-06-21T20:00:00Z', 200000,
      ]);
      await client.query(insert, [
        converted, owner, dog, 'converted', '2026-05-12T15:00:00Z', rachel,
        null, null, null, null,
      ]);
      const read = async () =>
        (
          await client.query<{
            id: string;
            status: string;
            approved_at: string | null;
            approved_by_staff_id: string | null;
            approved_trainer_staff_id: string | null;
            approved_dropoff_at: string | null;
            approved_pickup_at: string | null;
            approved_price_cents: number | null;
          }>(
            `SELECT id, status::text, approved_at::text, approved_by_staff_id::text,
                    approved_trainer_staff_id::text, approved_dropoff_at::text,
                    approved_pickup_at::text, approved_price_cents
               FROM pending_requests WHERE id = ANY($1) ORDER BY approved_at NULLS FIRST, id`,
            [[oldFlow, newFlow, converted]],
          )
        ).rows;
      const before = await read();

      await client.query(stepBytes(M523).toString('utf8'));
      const after = await read();
      const byId = (rows: typeof after, id: string) => rows.find((r) => r.id === id);

      assert.deepEqual(byId(after, oldFlow), {
        id: oldFlow,
        status: 'submitted',
        approved_at: null,
        approved_by_staff_id: null,
        approved_trainer_staff_id: null,
        approved_dropoff_at: null,
        approved_pickup_at: null,
        approved_price_cents: null,
      });
      assert.deepEqual(byId(after, newFlow), byId(before, newFlow), 'a row with approved dates moved');
      assert.deepEqual(byId(after, converted), byId(before, converted), 'a converted row moved');
    });
  },
);
