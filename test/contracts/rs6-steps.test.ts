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
  'M5.34 run a second time changes nothing: the same offerings, every credit_packages row the same, and no audit row written (Fable r1 N1)',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await beforeTheStep(client);
      await client.query(STEP_SQL);
      const once = {
        offerings: await offerings(client),
        rows: (await client.query(EVERY_CATALOG_ROW)).rows,
      };
      const audited = async (): Promise<number | undefined> =>
        (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log')).rows[0]?.n;
      const auditedOnce = await audited();
      await client.query(STEP_SQL);
      const twice = {
        offerings: await offerings(client),
        rows: (await client.query(EVERY_CATALOG_ROW)).rows,
      };
      assert.deepEqual(twice, once);
      assert.equal(await audited(), auditedOnce, 'a run that changes nothing writes no audit row');
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

/** A Fayetteville day care booking of Waffles at `daysFromNow` (Chicago), one debit from `lotId`. */
async function debitedBooking(
  client: pg.Client,
  args: { lotId: string; daysFromNow: number; status?: string },
): Promise<{ bookingId: string; debitId: string }> {
  const bookingId = randomUUID();
  const debitId = randomUUID();
  await client.query(
    `INSERT INTO bookings (id, owner_id, lead_dog_id, category, scheduled_at, location, status)
     VALUES ($1, $2, $3, 'day-care',
             ((now() AT TIME ZONE 'America/Chicago')::date + $4::int + time '07:30') AT TIME ZONE 'America/Chicago',
             'fayetteville', $5)`,
    [
      bookingId,
      FIXTURE_IDS.ownerId,
      FIXTURE_IDS.dog1Id,
      args.daysFromNow,
      args.status ?? 'upcoming',
    ],
  );
  await client.query(
    `INSERT INTO booking_dogs (booking_id, dog_id, is_lead) VALUES ($1, $2, true)`,
    [bookingId, FIXTURE_IDS.dog1Id],
  );
  await client.query(
    `INSERT INTO credit_ledger (id, owner_id, dog_id, location, mode, tier, delta, reason, booking_id, lot_id)
     VALUES ($1, $2, $3, 'fayetteville', 'daycare', 'alumni', -1, 'booking-debit', $4, $5)`,
    [debitId, FIXTURE_IDS.ownerId, FIXTURE_IDS.dog1Id, bookingId, args.lotId],
  );
  return { bookingId, debitId };
}

test(
  "M5.34 guard (Fable r1 L3, M5.25's third clause): it refuses while a Fayetteville day care alumni debit is live on a booking today or later, whose cancel would put the credit back there, though its lot is spent; a past, a cancelled or an already-returned debit does not block",
  SKIP_WHEN_NO_DB,
  async () => {
    const plant = async (client: pg.Client, daysFromNow: number, status?: string) => {
      // A lot of one credit, spent: its balance is 0, so only the debit can block.
      const lotId = await lot(client, { tier: 'alumni', credits: 1 });
      return debitedBooking(client, { lotId, daysFromNow, ...(status ? { status } : {}) });
    };
    for (const days of [0, 3]) {
      await withClient(async (client) => {
        await beforeTheStep(client);
        const { bookingId } = await plant(client, days);
        await client.query('SAVEPOINT before_step');
        await refusedWith(client, new RegExp(`${FIXTURE_IDS.ownerId} booking ${bookingId}`));
        await client.query('ROLLBACK TO SAVEPOINT before_step');
        assert.deepEqual(
          (await offerings(client)).fayetteville,
          PRE_M534.fayetteville,
          'nothing applied',
        );
      });
    }
    await withClient(async (client) => {
      await beforeTheStep(client);
      await plant(client, -1);
      await plant(client, 3, 'cancelled');
      const { bookingId, debitId } = await plant(client, 3);
      const returned = await client.query<{ id: string }>(
        `INSERT INTO credit_ledger (owner_id, dog_id, location, mode, tier, delta, reason, booking_id, reverses_entry_id, expires_at)
         VALUES ($1, $2, 'fayetteville', 'daycare', 'alumni', 1, 'settlement-return', $3, $4, '2020-01-01T00:00:00Z')
         RETURNING id`,
        [FIXTURE_IDS.ownerId, FIXTURE_IDS.dog1Id, bookingId, debitId],
      );
      // The returned credit is a lot of its own, which the first clause reads, so it is moved by
      // hand first, as the runbook does (CRED-26). The debit it reversed is this control.
      await client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, tier, delta, reason, lot_id, note, created_by_staff_id)
         VALUES ($1, 'fayetteville', 'daycare', 'alumni', -1, 'adjustment', $2, 'rs6-steps: moved by hand', $3)`,
        [FIXTURE_IDS.ownerId, returned.rows[0]?.id, FIXTURE_IDS.staffDonavanId],
      );
      await client.query(STEP_SQL);
      assert.deepEqual((await offerings(client)).fayetteville?.['day-care'], on);
    });
  },
);

const CATALOG_ROW = `
  INSERT INTO credit_packages (key, location, mode, tier, credits, price_cents, label, is_popular,
                               single_day, expiry_months, effective_from, effective_to)
  VALUES ($1, 'fayetteville', 'daycare', $2, $3, $4, 'rs6-steps: by hand', false, $5, 1, $6, $7)`;
type HandRow = [
  key: string,
  tier: string,
  credits: number,
  priceCents: number,
  singleDay: boolean,
  from: string,
  to: string | null,
];

test(
  "M5.34 guard (Fable r1 L4): it refuses while Fayetteville day care's catalog holds a row other than the step's two, live or to come (another key, an alumni row, another date, or the step's key and date on other terms), or a closed row of the step's keys on other terms that its reopen could open; a closed row of another key does not block, nor a catalog editor's successor closed by the reversal",
  SKIP_WHEN_NO_DB,
  async () => {
    const refused: Array<[HandRow, RegExp]> = [
      [
        ['daycare-10-fayetteville', 'regular', 10, 35000, false, '2026-06-01', null],
        /daycare-10-fayetteville from 2026-06-01\. /,
      ],
      [
        ['daycare-alumni-10-fayetteville', 'alumni', 10, 32000, false, '2026-01-01', null],
        /daycare-alumni-10-fayetteville from 2026-01-01/,
      ],
      [
        ['daycare-10-fayetteville', 'regular', 10, 40000, false, '2026-01-01', null],
        /daycare-10-fayetteville from 2026-01-01 \(not this step's terms\)/,
      ],
      [
        ['single-day-daycare-fayetteville', 'regular', 1, 3500, true, '2036-01-01', null],
        /single-day-daycare-fayetteville from 2036-01-01/,
      ],
      [
        ['single-day-daycare-fayetteville', 'regular', 1, 3000, true, '2026-03-01', '2026-03-01'],
        /single-day-daycare-fayetteville from 2026-03-01 to 2026-03-01 \(not this step's terms\)/,
      ],
    ];
    for (const [row, pattern] of refused) {
      await withClient(async (client) => {
        await beforeTheStep(client);
        await client.query(CATALOG_ROW, row);
        await client.query('SAVEPOINT before_step');
        await refusedWith(client, pattern);
        await client.query('ROLLBACK TO SAVEPOINT before_step');
        assert.deepEqual(
          (await offerings(client)).fayetteville,
          PRE_M534.fayetteville,
          'nothing applied',
        );
      });
    }

    // A closed row of another key, and a key's window that ended before today: the step applies.
    await withClient(async (client) => {
      await beforeTheStep(client);
      await client.query(CATALOG_ROW, [
        'daycare-alumni-10-fayetteville',
        'alumni',
        10,
        32000,
        false,
        '2026-01-01',
        '2026-01-01',
      ]);
      await client.query(CATALOG_ROW, [
        'daycare-5-fayetteville',
        'regular',
        5,
        18000,
        false,
        '2025-01-01',
        '2025-06-01',
      ]);
      await client.query(STEP_SQL);
      assert.deepEqual((await offerings(client)).fayetteville?.['day-care'], on);
    });

    // The catalog editor's road: applied, then staff change a row's months (the row closes today and
    // its successor opens today), then the reversal closes every row of the two keys; the step
    // applies again and reopens the successor, staff's months kept.
    await withClient(async (client) => {
      await beforeTheStep(client);
      await client.query(STEP_SQL);
      const today = `(now() AT TIME ZONE 'America/Chicago')::date`;
      await client.query(
        `UPDATE credit_packages SET effective_to = ${today} WHERE key = 'daycare-10-fayetteville'`,
      );
      await client.query(
        `INSERT INTO credit_packages (key, location, mode, tier, credits, price_cents, label, is_popular,
                                      single_day, expiry_months, effective_from)
         SELECT key, location, mode, tier, credits, price_cents, label, is_popular, single_day, 3, ${today}
           FROM credit_packages WHERE key = 'daycare-10-fayetteville' AND effective_from = '2026-01-01'`,
      );
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
      await client.query(STEP_SQL);
      const open = await client.query<{ effective_from: string; expiry_months: number }>(
        `SELECT effective_from::text, expiry_months FROM credit_packages
          WHERE key = 'daycare-10-fayetteville' AND effective_to IS NULL`,
      );
      assert.equal(open.rows.length, 1, 'one live row of the key');
      assert.equal(open.rows[0]?.expiry_months, 3, "the successor, staff's months kept");
    });
  },
);

test(
  'M5.34 refuses, naming the missing row, when the database holds no Fayetteville day_program_settings row, rather than put the two rows on sale with day care not offered (Fable r1 N2)',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await beforeTheStep(client);
      await client.query(`DELETE FROM day_program_settings WHERE location = 'fayetteville'`);
      await client.query('SAVEPOINT before_step');
      await refusedWith(client, /no day_program_settings row for fayetteville/);
      await client.query('ROLLBACK TO SAVEPOINT before_step');
      assert.equal((await client.query(CATALOG_ROWS, [NEW_KEYS])).rows.length, 0, 'no row added');
    });
  },
);

/** A connection of its own, outside the step's transaction; rolled back and ended whatever happens. */
async function withSecondClient(run: (other: pg.Client) => Promise<void>): Promise<void> {
  const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  try {
    await run(other);
  } finally {
    await other.query('ROLLBACK').catch(() => undefined);
    await other.end();
  }
}

const ALUMNI_LOT = `
  INSERT INTO credit_ledger (id, owner_id, location, mode, tier, delta, reason, expires_at, note)
  VALUES ($1, $2, 'fayetteville', 'daycare', 'alumni', 3, 'adjustment', '2036-01-01T00:00:00Z',
          'rs6-steps: a second connection')`;

function lockNotAvailable(err: { code?: string; message?: string }): boolean {
  assert.equal(err.code, '55P03', err.message);
  return true;
}

test(
  'M5.34 under a second connection, the step first (Fable r1 L2): while its transaction is open no alumni lot and no Fayetteville day care catalog row can be written past its guard',
  SKIP_WHEN_NO_DB,
  async () => {
    // The step first, its transaction still open: the second connection's writes wait for its
    //    commit (here they time out) instead of landing between the guard's read and the commit.
    await withClient(async (client) => {
      await beforeTheStep(client);
      await client.query(STEP_SQL);
      await withSecondClient(async (other) => {
        await other.query('BEGIN');
        await other.query(`SET LOCAL lock_timeout = '300ms'`);
        await assert.rejects(
          other.query(ALUMNI_LOT, [randomUUID(), FIXTURE_IDS.ownerId]),
          lockNotAvailable,
        );
        await other.query('ROLLBACK');
        await other.query('BEGIN');
        await other.query(`SET LOCAL lock_timeout = '300ms'`);
        await assert.rejects(
          other.query(CATALOG_ROW, [
            'daycare-alumni-10-fayetteville',
            'alumni',
            10,
            32000,
            false,
            '2026-01-01',
            null,
          ]),
          lockNotAvailable,
        );
      });
    });
  },
);

test(
  'M5.34 under a second connection, the lot first (Fable r1 L2): an alumni lot written but not yet committed when the step starts is waited for, then read by the guard, and the step refuses',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = randomUUID();
    try {
      await withSecondClient(async (other) => {
        await other.query('BEGIN');
        await other.query(ALUMNI_LOT, [lotId, FIXTURE_IDS.ownerId]);
        await withClient(async (client) => {
          await beforeTheStep(client);
          const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
            .rows[0]?.pid;
          let settled = false;
          const run = client
            .query(STEP_SQL)
            .then(
              () => undefined,
              (err: { code?: string; message?: string }) => err,
            )
            .finally(() => {
              settled = true;
            });
          const deadline = Date.now() + 4000;
          let waited = false;
          while (!settled && !waited && Date.now() < deadline) {
            const { rows } = await other.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND NOT granted',
              [pid],
            );
            waited = (rows[0]?.n ?? 0) > 0;
            if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await other.query('COMMIT');
          const err = await run;
          assert.ok(err, 'the step applied past an alumni lot committed while it ran');
          assert.equal(err.code, 'P0001', err.message);
          assert.match(err.message ?? '', new RegExp(`lot ${lotId} holds 3`));
          assert.equal(waited, true, "the step waited for the lot's transaction");
        });
      });
    } finally {
      await withSecondClient(async (cleaner) => {
        await cleaner.query('DELETE FROM credit_ledger WHERE id = $1', [lotId]);
      });
    }
  },
);
