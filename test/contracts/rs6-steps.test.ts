import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseStep } from '../../src/db/migrate.js';
import { CATALOG_SEED_KEYS, FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { seededOfferings, type OfferingsDocument } from './_seedOfferings.js';

/**
 * M5.34 (plan one-off O-BUGS3, her bug #40; DECISIONS 677 (1), 702 (3), 704): day care offered
 * at Fayetteville and sold there at Bentonville's prices. The rehearsal proves the step's
 * catalog rows against `schema.sql` (`credit_packages` is one of its reference-data tables);
 * it reads no `day_program_settings` row, so the offerings flip is proven equal to the seed
 * here, with the guard, a second run and a run after the reversal, each in one transaction
 * that is rolled back.
 */

registerFixtureHooks();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const M534 = 'M5.34_fayetteville_day_care.sql';
const STEP = fs.readFileSync(path.join(REPO_ROOT, 'migrations', 'rs6', M534));
const STEP_SQL = STEP.toString('utf8');

const NEW_KEYS = ['daycare-10-fayetteville', 'single-day-daycare-fayetteville'];
/** Every seed key, live and closed: the rows the step must leave equal to the volume's. */
const ALL_SEED_KEYS = [...CATALOG_SEED_KEYS, 'school-alumni-10-fayetteville'];

const CATALOG_ROWS = `
  SELECT key, location, mode, tier, credits, price_cents, label, is_popular, single_day,
         expiry_months, effective_from::text, effective_to::text
    FROM credit_packages
   WHERE key = ANY($1)
   ORDER BY key, effective_from`;
const EVERY_CATALOG_ROW = `
  SELECT key, location, mode, tier, credits, price_cents, label, is_popular, single_day,
         expiry_months, effective_from::text, effective_to::text
    FROM credit_packages
   ORDER BY key, effective_from`;
const OFFERINGS = `
  SELECT location, offerings FROM day_program_settings
   WHERE location IN ('fayetteville', 'bentonville') ORDER BY location`;

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

const on = { offered: true, client_visible: true, name: null, description: null };
const off = { offered: false, client_visible: false, name: null, description: null };

/**
 * Both campuses' documents before M5.34, as literals: `schema.sql`'s seed at 549c14e
 * (M5.24's result): day care off at Fayetteville, boarding off at both, the rest on.
 */
const PRE_M534: Record<'fayetteville' | 'bentonville', OfferingsDocument> = {
  fayetteville: {
    'day-school': on,
    'day-care': off,
    'group-class': on,
    evaluation: on,
    'private-lesson': on,
    'board-and-train': on,
    boarding: off,
  },
  bentonville: {
    'day-school': on,
    'day-care': on,
    'group-class': on,
    evaluation: on,
    'private-lesson': on,
    'board-and-train': on,
    boarding: off,
  },
};

/** The database as it stood before the step: the 549c14e documents, no Fayetteville rows. */
async function beforeTheStep(client: pg.Client): Promise<void> {
  for (const campus of ['fayetteville', 'bentonville'] as const) {
    await client.query(
      'UPDATE day_program_settings SET offerings = $1::jsonb WHERE location = $2',
      [JSON.stringify(PRE_M534[campus]), campus],
    );
  }
  await client.query('DELETE FROM credit_packages WHERE key = ANY($1)', [NEW_KEYS]);
}

async function offerings(client: pg.Client): Promise<Record<string, OfferingsDocument>> {
  const { rows } = await client.query<{ location: string; offerings: OfferingsDocument }>(
    OFFERINGS,
  );
  return Object.fromEntries(rows.map((r) => [r.location, r.offerings]));
}

async function refusedWith(client: pg.Client, pattern: RegExp): Promise<void> {
  await assert.rejects(client.query(STEP_SQL), (err: { code?: string; message?: string }) => {
    assert.equal(err.code, 'P0001', err.message);
    assert.match(err.message ?? '', pattern);
    return true;
  });
}

/** A Fayetteville day care lot of the fixture owner's. */
async function lot(
  client: pg.Client,
  args: { tier: 'regular' | 'alumni'; credits: number; expiresAt?: string },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO credit_ledger (id, owner_id, location, mode, tier, delta, reason, expires_at, note)
     VALUES ($1, $2, 'fayetteville', 'daycare', $3, $4, 'adjustment', $5, 'rs6-steps')`,
    [id, FIXTURE_IDS.ownerId, args.tier, args.credits, args.expiresAt ?? '2036-01-01T00:00:00Z'],
  );
  return id;
}

test("M5.34 parses as a step that runs inside the runner's transaction, its lock timeout first", () => {
  const parsed = parseStep(M534, STEP);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  assert.equal(parsed.step.directives.has('no-transaction'), false);
  const firstStatement = STEP_SQL.split('\n').find((line) => line !== '' && !line.startsWith('--'));
  assert.equal(firstStatement, "SET LOCAL lock_timeout = '5s';");
});

test(
  "M5.34 seed equals step: from 549c14e's documents and catalog, the step's own text leaves both campuses' offerings and every seed catalog row exactly as schema.sql seeds them (day care on at Fayetteville, $350.00 / 10 and $35.00 single there)",
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      const volume = (await client.query(CATALOG_ROWS, [ALL_SEED_KEYS])).rows;
      assert.equal(
        volume.length,
        13,
        'the volume holds the twelve live seed rows and the closed one',
      );
      await beforeTheStep(client);
      assert.equal((await client.query(CATALOG_ROWS, [NEW_KEYS])).rows.length, 0);

      await client.query(STEP_SQL);

      const after = await offerings(client);
      assert.deepEqual(after, seededOfferings(), "the step's documents are schema.sql's seed");
      assert.deepEqual(after.fayetteville?.['day-care'], on);
      assert.deepEqual(after.bentonville, PRE_M534.bentonville, 'Bentonville untouched');
      assert.deepEqual(
        (await client.query(CATALOG_ROWS, [ALL_SEED_KEYS])).rows,
        volume,
        "the step's rows are the seed's",
      );
      assert.deepEqual((await client.query(CATALOG_ROWS, [NEW_KEYS])).rows, [
        {
          key: 'daycare-10-fayetteville',
          location: 'fayetteville',
          mode: 'daycare',
          tier: 'regular',
          credits: 10,
          price_cents: 35000,
          label: 'Fayetteville Day Care Package',
          is_popular: false,
          single_day: false,
          expiry_months: 1,
          effective_from: '2026-01-01',
          effective_to: null,
        },
        {
          key: 'single-day-daycare-fayetteville',
          location: 'fayetteville',
          mode: 'daycare',
          tier: 'regular',
          credits: 1,
          price_cents: 3500,
          label: 'Single Day Care Day · Fayetteville',
          is_popular: false,
          single_day: true,
          expiry_months: 1,
          effective_from: '2026-01-01',
          effective_to: null,
        },
      ]);
    });
  },
);

test(
  'M5.34 run a second time changes nothing: the same offerings and every credit_packages row the same',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await beforeTheStep(client);
      await client.query(STEP_SQL);
      const once = {
        offerings: await offerings(client),
        rows: (await client.query(EVERY_CATALOG_ROW)).rows,
      };
      await client.query(STEP_SQL);
      const twice = {
        offerings: await offerings(client),
        rows: (await client.query(EVERY_CATALOG_ROW)).rows,
      };
      assert.deepEqual(twice, once);
    });
  },
);

test(
  "M5.34 moves only the two flags of Fayetteville's day care: a name and description staff gave it stay, and a document that lost its day-care entry gets a whole one rather than going NULL",
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await beforeTheStep(client);
      const named = {
        ...PRE_M534.fayetteville,
        'day-care': { ...off, name: 'Day Camp', description: 'Play all day.' },
      };
      await client.query(
        `UPDATE day_program_settings SET offerings = $1::jsonb WHERE location = 'fayetteville'`,
        [JSON.stringify(named)],
      );
      await client.query(STEP_SQL);
      assert.deepEqual((await offerings(client)).fayetteville, {
        ...named,
        'day-care': {
          offered: true,
          client_visible: true,
          name: 'Day Camp',
          description: 'Play all day.',
        },
      });

      const withoutDayCare = Object.fromEntries(
        Object.entries(PRE_M534.fayetteville).filter(([service]) => service !== 'day-care'),
      );
      await client.query(
        `UPDATE day_program_settings SET offerings = $1::jsonb WHERE location = 'fayetteville'`,
        [JSON.stringify(withoutDayCare)],
      );
      await client.query(STEP_SQL);
      assert.deepEqual((await offerings(client)).fayetteville, {
        ...withoutDayCare,
        'day-care': on,
      });
    });
  },
);

test(
  'M5.34 guard: it refuses, and nothing applies, while a Fayetteville day care ALUMNI lot holds credits, live or expired, naming owner, lot and balance (alumni credits are Bentonville-only, 553 (b)); a regular lot there, or an alumni lot emptied by hand, does not block',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const expiresAt of ['2036-01-01T00:00:00Z', '2020-01-01T00:00:00Z']) {
      await withClient(async (client) => {
        await beforeTheStep(client);
        const id = await lot(client, { tier: 'alumni', credits: 3, expiresAt });
        await client.query('SAVEPOINT before_step');
        await refusedWith(
          client,
          new RegExp(
            `${FIXTURE_IDS.ownerId} holds 3 \\(lot ${id} holds 3${expiresAt.startsWith('2020') ? ', expired' : ''}\\)`,
          ),
        );
        await client.query('ROLLBACK TO SAVEPOINT before_step');
        assert.deepEqual(
          (await offerings(client)).fayetteville,
          PRE_M534.fayetteville,
          'nothing applied',
        );
        assert.equal((await client.query(CATALOG_ROWS, [NEW_KEYS])).rows.length, 0, 'no row added');
      });
    }
    await withClient(async (client) => {
      await beforeTheStep(client);
      await lot(client, { tier: 'regular', credits: 4 });
      const alumni = await lot(client, { tier: 'alumni', credits: 2 });
      await client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, tier, delta, reason, lot_id, note, created_by_staff_id)
         VALUES ($1, 'fayetteville', 'daycare', 'alumni', -2, 'adjustment', $2, 'rs6-steps: moved by hand', $3)`,
        [FIXTURE_IDS.ownerId, alumni, FIXTURE_IDS.staffDonavanId],
      );
      await client.query(STEP_SQL);
      assert.deepEqual((await offerings(client)).fayetteville?.['day-care'], on);
    });
  },
);

test(
  'M5.34 after its reversal (day care off, both rows closed with effective_to = effective_from) applies again with both rows back on sale, not left closed',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await beforeTheStep(client);
      await client.query(STEP_SQL);
      const applied = (await client.query(CATALOG_ROWS, [NEW_KEYS])).rows;
      // The reversal, as the step's header spells it.
      await client.query(
        `UPDATE day_program_settings
            SET offerings = jsonb_set(offerings, '{day-care}',
                  (offerings -> 'day-care') || '{"offered": false, "client_visible": false}'::jsonb)
          WHERE location = 'fayetteville'`,
      );
      await client.query(
        'UPDATE credit_packages SET effective_to = effective_from WHERE key = ANY($1)',
        [NEW_KEYS],
      );
      assert.deepEqual((await offerings(client)).fayetteville, PRE_M534.fayetteville);

      await client.query(STEP_SQL);
      assert.deepEqual((await client.query(CATALOG_ROWS, [NEW_KEYS])).rows, applied);
      assert.deepEqual((await offerings(client)).fayetteville, seededOfferings().fayetteville);
    });
  },
);
