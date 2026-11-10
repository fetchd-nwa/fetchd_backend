import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseStep } from '../../src/db/migrate.js';
import { CATALOG_SEED_KEYS, FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * M4.05 to M4.12 (P18 passes 1 to 4). The rehearsal proves the DDL against schema.sql and
 * its row check proves the seed, but it starts from an empty catalog, so M4.05's re-key only
 * runs here, the ten rows are only read against the design here, and what a constraint or a
 * predicate REFUSES is only read here.
 */

registerFixtureHooks();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const M405_NAME = 'M4.05_credit_package_catalog_columns.sql';
const M406_NAME = 'M4.06_seed_ten_credit_packages.sql';
const stepBytes = (name: string): Buffer =>
  fs.readFileSync(path.join(REPO_ROOT, 'migrations', 'lg4', name));
const SCHEMA_PATH = path.join(REPO_ROOT, '.claude', 'backend', 'schema.sql');

const CATALOG_ROWS = `
  SELECT key, location, mode, tier, credits, price_cents, label, is_popular, single_day,
         expiry_months, effective_from::text, effective_to::text
    FROM credit_packages
   WHERE key = ANY($1)
   ORDER BY key`;

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

/** Every `credit_packages` INSERT in a SQL text. */
function seedStatementsIn(sqlText: string): string[] {
  return sqlText.match(/^\s*insert\s+into\s+(?:public\.)?credit_packages\b[\s\S]*?;\s*$/gim) ?? [];
}

test('M4.05 and M4.06 parse as steps, each in one transaction', () => {
  for (const name of [M405_NAME, M406_NAME]) {
    const parsed = parseStep(name, stepBytes(name));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    assert.equal(parsed.step.directives.has('no-transaction'), false);
  }
});

test(
  'M4.05 on a populated catalog: a key at two campuses is re-keyed, whole, and the UNIQUE lands',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await client.query(`SELECT set_config('app.actor', 'system:migrate-M4.05', true)`);
      // The table as it stood before the step, holding what seed-dev.ts wrote: every key
      // at both campuses on one `effective_from`.
      await client.query(`DROP TRIGGER credit_packages_audit ON credit_packages`);
      await client.query(`
        ALTER TABLE credit_packages
          DROP CONSTRAINT credit_packages_key_effective_from_key,
          DROP COLUMN tier,
          DROP COLUMN expiry_months,
          DROP COLUMN single_day,
          DROP COLUMN created_at,
          ADD CONSTRAINT credit_packages_key_location_effective_from_key
            UNIQUE (key, location, effective_from)`);
      await client.query(`
        INSERT INTO credit_packages (key, location, mode, credits, price_cents, label, effective_from, effective_to)
        VALUES
          ('dev-pack', 'fayetteville', 'school', 8, 45600, 'a', '2026-02-01', NULL),
          ('dev-pack', 'bentonville', 'school', 8, 45600, 'b', '2026-02-01', '2026-03-01'),
          ('dev-pack', 'bentonville', 'school', 8, 46000, 'c', '2026-03-01', NULL),
          ('dev-solo', 'bentonville', 'school', 8, 45600, 'd', '2026-02-01', NULL)`);

      await client.query(stepBytes(M405_NAME).toString('utf8'));

      const { rows } = await client.query(`
        SELECT key, location, effective_from::text AS from, tier, expiry_months, single_day
          FROM credit_packages WHERE key LIKE 'dev-%' ORDER BY location, effective_from, key`);
      assert.deepEqual(
        rows.map((r) => [r.key, r.location, r.from]),
        [
          ['dev-pack', 'bentonville', '2026-02-01'],
          ['dev-solo', 'bentonville', '2026-02-01'],
          ['dev-pack', 'bentonville', '2026-03-01'],
          ['dev-pack-fayetteville', 'fayetteville', '2026-02-01'],
        ],
        'one campus keeps the key, the other carries its name, and a lone key is left alone',
      );
      for (const row of rows) {
        assert.deepEqual([row.tier, row.expiry_months, row.single_day], ['regular', 1, false]);
      }
    });
  },
);

test(
  "M4.05's constraints: a second campus on one key and day is 23505, a bad tier and a zero window 23514",
  SKIP_WHEN_NO_DB,
  async () => {
    for (const [sql, code] of [
      [
        `INSERT INTO credit_packages (key, location, mode, credits, price_cents, label, effective_from)
         VALUES ('school-2x-weekly-fayetteville', 'bentonville', 'school', 8, 1, 'x', '2026-01-01')`,
        '23505',
      ],
      [
        `INSERT INTO credit_packages (key, location, mode, credits, price_cents, label, tier)
         VALUES ('check-tier', 'bentonville', 'school', 8, 1, 'x', 'Regular')`,
        '23514',
      ],
      [
        `INSERT INTO credit_packages (key, location, mode, credits, price_cents, label, expiry_months)
         VALUES ('check-months', 'bentonville', 'school', 8, 1, 'x', 0)`,
        '23514',
      ],
    ] as const) {
      await withClient(async (client) => {
        await assert.rejects(client.query(sql), (err: { code?: string }) => err.code === code);
      });
    }
  },
);

test(
  "M4.06: its bytes run twice in a rolled-back transaction find exactly ten rows, equal to schema.sql's and the volume's",
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      const keys = [CATALOG_SEED_KEYS];
      const volume = (await client.query(CATALOG_ROWS, keys)).rows;
      assert.equal(volume.length, 10, 'the volume holds the ten seed rows');

      await client.query(`DELETE FROM credit_packages WHERE key = ANY($1)`, keys);
      assert.equal((await client.query(CATALOG_ROWS, keys)).rows.length, 0, 'the rows are removed');
      const step = stepBytes(M406_NAME).toString('utf8');
      await client.query(step);
      await client.query(step);
      const fromStep = (await client.query(CATALOG_ROWS, keys)).rows;
      assert.equal(fromStep.length, 10, 'two runs of the step leave ten rows');

      const fromDesign = fromStep.map((r) => [
        r.key,
        r.location,
        r.mode,
        r.tier,
        r.credits,
        r.price_cents,
        r.single_day,
        r.expiry_months,
        r.effective_from,
        r.effective_to,
      ]);
      assert.deepEqual(fromDesign, [
        [
          'daycare-10-bentonville',
          'bentonville',
          'daycare',
          'regular',
          10,
          35000,
          false,
          1,
          '2026-01-01',
          null,
        ],
        [
          'school-2x-weekly-bentonville',
          'bentonville',
          'school',
          'regular',
          8,
          45600,
          false,
          1,
          '2026-01-01',
          null,
        ],
        [
          'school-2x-weekly-fayetteville',
          'fayetteville',
          'school',
          'regular',
          8,
          45600,
          false,
          1,
          '2026-01-01',
          null,
        ],
        [
          'school-3x-weekly-bentonville',
          'bentonville',
          'school',
          'regular',
          12,
          64800,
          false,
          1,
          '2026-01-01',
          null,
        ],
        [
          'school-3x-weekly-fayetteville',
          'fayetteville',
          'school',
          'regular',
          12,
          64800,
          false,
          1,
          '2026-01-01',
          null,
        ],
        [
          'school-5x-weekly-bentonville',
          'bentonville',
          'school',
          'regular',
          20,
          102000,
          false,
          1,
          '2026-01-01',
          null,
        ],
        [
          'school-alumni-10-fayetteville',
          'fayetteville',
          'school',
          'alumni',
          10,
          32000,
          false,
          1,
          '2026-01-01',
          null,
        ],
        [
          'single-day-daycare-bentonville',
          'bentonville',
          'daycare',
          'regular',
          1,
          3500,
          true,
          1,
          '2026-01-01',
          null,
        ],
        [
          'single-day-school-bentonville',
          'bentonville',
          'school',
          'regular',
          1,
          6000,
          true,
          1,
          '2026-01-01',
          null,
        ],
        [
          'single-day-school-fayetteville',
          'fayetteville',
          'school',
          'regular',
          1,
          6000,
          true,
          1,
          '2026-01-01',
          null,
        ],
      ]);

      await client.query(`DELETE FROM credit_packages WHERE key = ANY($1)`, keys);
      const statements = seedStatementsIn(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      assert.equal(statements.length, 1, 'schema.sql seeds the catalog once');
      await client.query(statements[0] as string);
      const fromSchema = (await client.query(CATALOG_ROWS, keys)).rows;
      assert.deepEqual(fromStep, fromSchema, "the step's rows are schema.sql's rows");
      assert.deepEqual(fromStep, volume, "the step's rows are the volume's rows");
    });
  },
);

test('a seeded effective_from is a literal, never CURRENT_DATE', () => {
  const step = stepBytes(M406_NAME).toString('utf8');
  assert.equal(/CURRENT_DATE|now\(\)/i.test(step.replace(/^--.*$/gm, '')), false);
});

// ── M4.10: a row cannot spend another pool (design §2.4:2935-2940) ───────────

async function plantLot(client: pg.Client, ownerId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, expires_at)
     VALUES ($1, 'fayetteville', 'school', 5, 'purchase', '2036-01-01')
     RETURNING id`,
    [ownerId],
  );
  return rows[0]?.id as string;
}

test("M4.10: a row naming another owner's lot raises 23503", SKIP_WHEN_NO_DB, async () => {
  await withClient(async (client) => {
    const lotId = await plantLot(client, FIXTURE_IDS.ownerId);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO owners (supabase_uid, email, name)
       VALUES (gen_random_uuid(), 'other-owner@example.com', 'Other Owner') RETURNING id`,
    );
    const stranger = rows[0]?.id as string;
    await assert.rejects(
      client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, lot_id)
         VALUES ($1, 'fayetteville', 'school', -1, 'booking-debit', $2)`,
        [stranger, lotId],
      ),
      (err: { code?: string }) => err.code === '23503',
    );
  });
});

test("M4.10: a row naming another pool's lot raises 23503", SKIP_WHEN_NO_DB, async () => {
  await withClient(async (client) => {
    const lotId = await plantLot(client, FIXTURE_IDS.ownerId);
    await assert.rejects(
      client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, tier, delta, reason, lot_id)
         VALUES ($1, 'fayetteville', 'school', 'alumni', -1, 'booking-debit', $2)`,
        [FIXTURE_IDS.ownerId, lotId],
      ),
      (err: { code?: string }) => err.code === '23503',
    );
  });
});

test("M4.10: tier = 'Regular' raises 23514", SKIP_WHEN_NO_DB, async () => {
  await withClient(async (client) => {
    await assert.rejects(
      client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, tier, delta, reason, expires_at)
         VALUES ($1, 'fayetteville', 'school', 'Regular', 5, 'purchase', '2036-01-01')`,
        [FIXTURE_IDS.ownerId],
      ),
      (err: { code?: string }) => err.code === '23514',
    );
  });
});

test('M4.10: a debit on its own lot and pool is accepted', SKIP_WHEN_NO_DB, async () => {
  await withClient(async (client) => {
    const lotId = await plantLot(client, FIXTURE_IDS.ownerId);
    await client.query(
      `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, lot_id)
       VALUES ($1, 'fayetteville', 'school', -1, 'booking-debit', $2)`,
      [FIXTURE_IDS.ownerId, lotId],
    );
  });
});

// ── M4.08: the two predicates (design §2.4:2896-2915) ────────────────────────

const pays = async (client: pg.Client, expiresAt: string, date: string): Promise<boolean> => {
  const { rows } = await client.query<{ pays: boolean }>(
    `SELECT lot_pays_date($1::timestamptz, $2::date) AS pays`,
    [expiresAt, date],
  );
  return rows[0]?.pays as boolean;
};

test(
  'M4.08: a lot expiring Mon 09:40 pays that Monday and not the Tuesday',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      // 19 Oct 2037 is a Monday, and CDT: 09:40 is 14:40Z.
      assert.equal(await pays(client, '2037-10-19T14:40:00Z', '2037-10-19'), true);
      assert.equal(await pays(client, '2037-10-19T14:40:00Z', '2037-10-20'), false);
    });
  },
);

test(
  'M4.08: lot_pays_date reads the Chicago midnight across a DST change',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      // 1 Nov 2037 falls back: its midnight is CDT, 05:00Z, and 2 Nov's is CST, 06:00Z.
      assert.equal(await pays(client, '2037-11-01T05:30:00Z', '2037-11-01'), true);
      assert.equal(await pays(client, '2037-11-02T05:30:00Z', '2037-11-02'), false);
      assert.equal(await pays(client, '2037-11-02T06:30:00Z', '2037-11-02'), true);
      // 8 Mar 2037 springs forward: its midnight is CST, 06:00Z, and 9 Mar's is CDT, 05:00Z.
      assert.equal(await pays(client, '2037-03-09T05:30:00Z', '2037-03-09'), true);
      assert.equal(await pays(client, '2037-03-08T05:30:00Z', '2037-03-08'), false);
    });
  },
);

test(
  'M4.08: a lot expiring exactly at midnight does not pay that date',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      assert.equal(await pays(client, '2037-10-20T05:00:00Z', '2037-10-20'), false);
      assert.equal(await pays(client, '2037-10-20T05:00:00Z', '2037-10-19'), true);
    });
  },
);

test(
  'M4.08: switching expiry off makes every stamped lot pay every date',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await client.query(`UPDATE credit_settings SET expiry_enforced_enabled = false`);
      assert.equal(await pays(client, '2020-01-01T00:00:00Z', '2037-10-20'), true);
      const { rows } = await client.query<{ live: boolean }>(
        `SELECT lot_is_live('2020-01-01T00:00:00Z'::timestamptz) AS live`,
      );
      assert.equal(rows[0]?.live, true);
    });
  },
);

test(
  'M4.08: with outliving on, a live lot pays a date past its expiry',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await client.query(`UPDATE credit_settings SET booking_outlives_lot_expiry_enabled = true`);
      assert.equal(await pays(client, '2037-10-19T14:40:00Z', '2037-10-20'), true);
      assert.equal(
        await pays(client, '2020-01-01T00:00:00Z', '2037-10-20'),
        false,
        'a dead lot never',
      );
    });
  },
);

test(
  'M4.11: the backfill sets alumni on five live levels and no fewer',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      const programs = ['foundation', 'advanced', 'loose-leash', 'house-manners', 'cgc'];
      for (const program of programs) {
        await client.query(
          `INSERT INTO dog_completed_programs (dog_id, program) VALUES ($1, $2::report_program)`,
          [FIXTURE_IDS.dog1Id, program],
        );
      }
      await client.query(
        `INSERT INTO dog_completed_programs (dog_id, program) VALUES ($1, 'foundation')`,
        [FIXTURE_IDS.dog2Id],
      );
      await client.query(`ALTER TABLE dogs DROP COLUMN is_alumni`);
      await client.query(stepBytes('M4.11_dogs_is_alumni.sql').toString('utf8'));
      const { rows } = await client.query<{ id: string; is_alumni: boolean }>(
        `SELECT id, is_alumni FROM dogs WHERE id = ANY($1) ORDER BY id`,
        [[FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id]],
      );
      const flag = new Map(rows.map((r) => [r.id, r.is_alumni]));
      assert.equal(flag.get(FIXTURE_IDS.dog1Id), true);
      assert.equal(flag.get(FIXTURE_IDS.dog2Id), false);
    });
  },
);

// ── M4.12: who wrote a hand edit, why, and every date a lot moved through ────

test(
  'M4.12: an adjustment with no note raises 23514, and one with a note lands',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await client.query('SAVEPOINT before');
      await assert.rejects(
        client.query(
          `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, expires_at)
         VALUES ($1, 'fayetteville', 'school', 1, 'adjustment', '2036-01-01')`,
          [FIXTURE_IDS.ownerId],
        ),
        (err: { code?: string }) => err.code === '23514',
      );
      await client.query('ROLLBACK TO SAVEPOINT before');
      await client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, expires_at, note)
       VALUES ($1, 'fayetteville', 'school', 1, 'adjustment', '2036-01-01', 'goodwill')`,
        [FIXTURE_IDS.ownerId],
      );
    });
  },
);

test(
  "M4.12: a staffer's row going leaves the ledger and the history with NULL",
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      const { rows: staff } = await client.query<{ id: string }>(
        `INSERT INTO staff (supabase_uid, name, role, home_locations)
       VALUES (gen_random_uuid(), 'Leaver', 'manager', '{fayetteville}') RETURNING id`,
      );
      const staffId = staff[0]?.id as string;
      const { rows: lots } = await client.query<{ id: string }>(
        `INSERT INTO credit_ledger
         (owner_id, location, mode, delta, reason, expires_at, note, created_by_staff_id)
       VALUES ($1, 'fayetteville', 'school', 1, 'adjustment', '2036-01-01', 'goodwill', $2)
       RETURNING id`,
        [FIXTURE_IDS.ownerId, staffId],
      );
      const lotId = lots[0]?.id as string;
      await client.query(
        `INSERT INTO credit_lot_expiry_edits (lot_id, from_expires_at, to_expires_at, staff_id, note)
       VALUES ($1, '2036-01-01', '2036-02-01', $2, 'moved')`,
        [lotId, staffId],
      );

      await client.query('DELETE FROM staff WHERE id = $1', [staffId]);

      const { rows } = await client.query(
        `SELECT l.created_by_staff_id, e.staff_id, e.note
         FROM credit_ledger l JOIN credit_lot_expiry_edits e ON e.lot_id = l.id
        WHERE l.id = $1`,
        [lotId],
      );
      assert.deepEqual(rows, [{ created_by_staff_id: null, staff_id: null, note: 'moved' }]);
    });
  },
);

test('M4.12: an edit names a real lot and carries a note', SKIP_WHEN_NO_DB, async () => {
  await withClient(async (client) => {
    await client.query('SAVEPOINT before');
    await assert.rejects(
      client.query(
        `INSERT INTO credit_lot_expiry_edits (lot_id, from_expires_at, to_expires_at, note)
         VALUES (gen_random_uuid(), '2036-01-01', '2036-02-01', 'moved')`,
      ),
      (err: { code?: string }) => err.code === '23503',
    );
    await client.query('ROLLBACK TO SAVEPOINT before');
    const lotId = await plantLot(client, FIXTURE_IDS.ownerId);
    await assert.rejects(
      client.query(
        `INSERT INTO credit_lot_expiry_edits (lot_id, from_expires_at, to_expires_at)
         VALUES ($1, '2036-01-01', '2036-02-01')`,
        [lotId],
      ),
      (err: { code?: string }) => err.code === '23502',
    );
  });
});

test(
  'M4.12: the API roles cannot read the history, and credit_ledger stays off the audit list',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      const { rows: grants } = await client.query<{ grantee: string }>(
        `SELECT grantee FROM information_schema.role_table_grants
        WHERE table_name = 'credit_lot_expiry_edits' AND grantee IN ('anon', 'authenticated')`,
      );
      assert.deepEqual(grants, []);
      const { rows: table } = await client.query(
        `SELECT 1 FROM pg_class WHERE relname = 'credit_lot_expiry_edits' AND relkind = 'r'`,
      );
      assert.equal(table.length, 1, 'the history table exists');
      const { rows: audit } = await client.query(
        `SELECT tgname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'credit_ledger'::regclass AND p.proname = 'audit_capture'`,
      );
      assert.deepEqual(audit, []);
    });
  },
);

// ── M4.09: the never-expiring class is retired (design §2.4:2919-2925) ───────

/** A rejection with this SQLSTATE and this constraint, so another refusal cannot stand in. */
const refusedBy =
  (code: string, constraint: string) =>
  (err: { code?: string; constraint?: string }): boolean =>
    err.code === code && err.constraint === constraint;

test('M4.09: grant_has_expiry refuses a grant with no date', SKIP_WHEN_NO_DB, async () => {
  await withClient(async (client) => {
    await assert.rejects(
      client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason)
         VALUES ($1, 'fayetteville', 'school', 5, 'purchase')`,
        [FIXTURE_IDS.ownerId],
      ),
      refusedBy('23514', 'grant_has_expiry'),
    );
  });
});

test('M4.09: debit_names_lot refuses a debit that names no lot', SKIP_WHEN_NO_DB, async () => {
  await withClient(async (client) => {
    await assert.rejects(
      client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason)
         VALUES ($1, 'fayetteville', 'school', -1, 'booking-debit')`,
        [FIXTURE_IDS.ownerId],
      ),
      refusedBy('23514', 'debit_names_lot'),
    );
  });
});

test(
  'M4.09: one_expiry_copy refuses a row that names a lot and carries a date',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      const lotId = await plantLot(client, FIXTURE_IDS.ownerId);
      await assert.rejects(
        client.query(
          `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, lot_id, expires_at)
         VALUES ($1, 'fayetteville', 'school', 1, 'cancel-refund', $2, '2036-01-01')`,
          [FIXTURE_IDS.ownerId, lotId],
        ),
        refusedBy('23514', 'one_expiry_copy'),
      );
    });
  },
);

test('M4.09: every shape the model writes still lands', SKIP_WHEN_NO_DB, async () => {
  await withClient(async (client) => {
    const lotId = await plantLot(client, FIXTURE_IDS.ownerId);
    // A debit on its lot, a return to its lot with no date, and a fresh lot with one.
    await client.query(
      `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, lot_id)
       VALUES ($1, 'fayetteville', 'school', -1, 'booking-debit', $2),
              ($1, 'fayetteville', 'school', 1, 'cancel-refund', $2)`,
      [FIXTURE_IDS.ownerId, lotId],
    );
    await client.query(
      `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, expires_at)
       VALUES ($1, 'fayetteville', 'school', 1, 'cancel-refund', '2036-02-01')`,
      [FIXTURE_IDS.ownerId],
    );
  });
});

/** A succeeded package charge on `client`, for the purchase index. */
async function plantCharge(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO charges (owner_id, amount_cents, status, purpose)
     VALUES ($1, 45600, 'succeeded', 'package') RETURNING id`,
    [FIXTURE_IDS.ownerId],
  );
  return rows[0]?.id as string;
}

const insertPurchase = (client: pg.Client, chargeId: string) =>
  client.query(
    `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, expires_at, charge_id)
     VALUES ($1, 'fayetteville', 'school', 8, 'purchase', '2036-01-01', $2)`,
    [FIXTURE_IDS.ownerId, chargeId],
  );

test(
  'M4.09: the partial unique index refuses a second purchase lot on one charge',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      const chargeId = await plantCharge(client);
      await insertPurchase(client, chargeId);
      await assert.rejects(
        insertPurchase(client, chargeId),
        refusedBy('23505', 'credit_ledger_purchase_charge_uidx'),
      );
    });
  },
);

test(
  'M4.09: the index reaches purchases only: another row may name the charge',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      const chargeId = await plantCharge(client);
      await insertPurchase(client, chargeId);
      await client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason, expires_at, note, charge_id)
       VALUES ($1, 'fayetteville', 'school', 1, 'adjustment', '2036-01-01', 'why', $2)`,
        [FIXTURE_IDS.ownerId, chargeId],
      );
    });
  },
);

const M407_NAME = 'M4.07_drop_credit_expiry_settings.sql';
const M409_NAME = 'M4.09_retire_never_expiring.sql';

test(
  'M4.07: the settings row is in audit_log after the drop, and the table is gone',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      // On this volume the table is schema.sql's to have or not, so the step runs on a
      // stand-in in this transaction, which holds the shape and the seed row M4.07 meets.
      await client.query('DROP TABLE IF EXISTS credit_expiry_settings');
      await client.query(`
        CREATE TABLE credit_expiry_settings (
          location text, expiry_window_months integer NOT NULL, warning_lead_days integer NOT NULL
        )`);
      await client.query('INSERT INTO credit_expiry_settings VALUES (NULL, 12, 60), ($1, 6, 30)', [
        'fayetteville',
      ]);

      await client.query(stepBytes(M407_NAME).toString('utf8'));

      const { rows: table } = await client.query(
        `SELECT to_regclass('credit_expiry_settings') AS oid`,
      );
      assert.equal(table[0].oid, null, 'the table is gone');
      const { rows } = await client.query(
        `SELECT row_pk, op, actor, before ->> 'expiry_window_months' AS months
           FROM audit_log WHERE table_name = 'credit_expiry_settings'
          ORDER BY row_pk COLLATE "C"`,
      );
      assert.deepEqual(rows, [
        {
          row_pk: '<global>',
          op: 'MIGRATION-DROP',
          actor: 'system:migration:M4.07',
          months: '12',
        },
        {
          row_pk: 'fayetteville',
          op: 'MIGRATION-DROP',
          actor: 'system:migration:M4.07',
          months: '6',
        },
      ]);
    });
  },
);

/** Takes M4.09 back off this transaction, so its bytes can run on a row they refuse. */
async function withoutM409(client: pg.Client): Promise<void> {
  await client.query(`
    ALTER TABLE credit_ledger
      DROP CONSTRAINT IF EXISTS grant_has_expiry,
      DROP CONSTRAINT IF EXISTS debit_names_lot,
      DROP CONSTRAINT IF EXISTS one_expiry_copy;
    DROP INDEX IF EXISTS credit_ledger_purchase_charge_uidx;
  `);
}

test(
  'M4.09 on rows it refuses: the validate stops the step, naming the constraint',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const [bad, constraint] of [
      [
        `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason)
       VALUES ('${FIXTURE_IDS.ownerId}', 'fayetteville', 'school', 5, 'purchase')`,
        'grant_has_expiry',
      ],
      [
        `INSERT INTO credit_ledger (owner_id, location, mode, delta, reason)
       VALUES ('${FIXTURE_IDS.ownerId}', 'fayetteville', 'school', -1, 'booking-debit')`,
        'debit_names_lot',
      ],
    ] as const) {
      await withClient(async (client) => {
        await withoutM409(client);
        await client.query(bad);
        await assert.rejects(
          client.query(stepBytes(M409_NAME).toString('utf8')),
          (err: { code?: string; constraint?: string; message: string }) =>
            err.code === '23514' && err.message.includes(constraint),
        );
      });
    }
  },
);

test(
  'M4.09 on rows it allows: it lands, and each CHECK reads validated',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await withoutM409(client);
      await client.query(stepBytes(M409_NAME).toString('utf8'));
      const { rows } = await client.query(
        `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'credit_ledger'::regclass
          AND conname IN ('grant_has_expiry', 'debit_names_lot', 'one_expiry_copy')
        ORDER BY conname`,
      );
      assert.deepEqual(rows, [
        { conname: 'debit_names_lot', convalidated: true },
        { conname: 'grant_has_expiry', convalidated: true },
        { conname: 'one_expiry_copy', convalidated: true },
      ]);
    });
  },
);
