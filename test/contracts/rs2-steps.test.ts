import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { CreditPackageWire } from '../../src/contracts/wire.js';
import { parseStep } from '../../src/db/migrate.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { createAlumniDog, removeDogs } from './_dayFixture.js';
import { CATALOG_SEED_KEYS, FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * M5.25 (plan one-off O-CREDITS; her ruling 553 (b)): the alumni pack moves to Bentonville
 * day care, and the Fayetteville day-school pack is retired, behind a guard. The rehearsal
 * proves the step's rows against `schema.sql`; what the guard REFUSES, and the reversal
 * (`test/fixtures/m525-reversal.sql`, never a step), are proven only here, each in one
 * transaction that is rolled back.
 *
 * The step holds `ACCESS EXCLUSIVE` on `credit_packages` until that transaction ends, so the
 * shop is read OUTSIDE it (DECISIONS 580, the Opus seat's note): a route called inside would
 * wait on the lock, and Postgres cannot see that as a deadlock.
 */

registerFixtureHooks();
const created: string[] = [];
after(() => removeDogs(created));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const M525 = 'M5.25_alumni_pack_bentonville_daycare.sql';
const STEP = fs.readFileSync(path.join(REPO_ROOT, 'migrations', 'rs2', M525));
const REVERSAL = fs.readFileSync(
  path.join(REPO_ROOT, 'test', 'fixtures', 'm525-reversal.sql'),
  'utf8',
);

const OLD = 'school-alumni-10-fayetteville';
const NEW = 'daycare-alumni-10-bentonville';

const CATALOG_ROWS = `
  SELECT key, location, mode, tier, credits, price_cents, label, is_popular, single_day,
         expiry_months, effective_from::text, effective_to::text
    FROM credit_packages
   WHERE key = ANY($1)
   ORDER BY key, effective_from`;

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

/** The catalog as M4.06 left it: the Fayetteville pack open, no Bentonville pack. */
async function beforeTheStep(client: pg.Client): Promise<void> {
  await client.query(`DELETE FROM credit_packages WHERE key = $1`, [NEW]);
  await client.query(`UPDATE credit_packages SET effective_to = NULL WHERE key = $1`, [OLD]);
}

async function refusedWith(client: pg.Client, sqlText: string, pattern: RegExp): Promise<void> {
  await assert.rejects(client.query(sqlText), (err: { code?: string; message?: string }) => {
    assert.equal(err.code, 'P0001', err.message);
    assert.match(err.message ?? '', pattern);
    return true;
  });
}

/** A lot of one pool for the fixture owner. */
async function lot(
  client: pg.Client,
  args: { location: string; mode: string; tier: string; credits: number; expiresAt?: string },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO credit_ledger (id, owner_id, location, mode, tier, delta, reason, expires_at, note)
     VALUES ($1, $2, $3, $4, $5, $6, 'adjustment', $7, 'rs2-steps')`,
    [
      id,
      FIXTURE_IDS.ownerId,
      args.location,
      args.mode,
      args.tier,
      args.credits,
      args.expiresAt ?? '2036-01-01T00:00:00Z',
    ],
  );
  return id;
}

/** A booking of Waffles at `daysFromNow` (Chicago, by Postgres's clock), with one debit from `lotId`. */
async function debitedBooking(
  client: pg.Client,
  args: {
    lotId: string;
    location: string;
    mode: string;
    tier: string;
    daysFromNow: number;
    status?: string;
  },
): Promise<{ bookingId: string; debitId: string }> {
  const bookingId = randomUUID();
  const debitId = randomUUID();
  await client.query(
    `INSERT INTO bookings (id, owner_id, lead_dog_id, category, scheduled_at, location, status)
     VALUES ($1, $2, $3, $4,
             ((now() AT TIME ZONE 'America/Chicago')::date + $5::int + time '07:30') AT TIME ZONE 'America/Chicago',
             $6, $7)`,
    [
      bookingId,
      FIXTURE_IDS.ownerId,
      FIXTURE_IDS.dog1Id,
      args.mode === 'school' ? 'day-school' : 'day-care',
      args.daysFromNow,
      args.location,
      args.status ?? 'upcoming',
    ],
  );
  await client.query(
    `INSERT INTO booking_dogs (booking_id, dog_id, is_lead) VALUES ($1, $2, true)`,
    [bookingId, FIXTURE_IDS.dog1Id],
  );
  await client.query(
    `INSERT INTO credit_ledger (id, owner_id, dog_id, location, mode, tier, delta, reason, booking_id, lot_id)
     VALUES ($1, $2, $3, $4, $5, $6, -1, 'booking-debit', $7, $8)`,
    [
      debitId,
      FIXTURE_IDS.ownerId,
      FIXTURE_IDS.dog1Id,
      args.location,
      args.mode,
      args.tier,
      bookingId,
      args.lotId,
    ],
  );
  return { bookingId, debitId };
}

/** A purchase charge of `key`'s live row, at `status`. */
async function charge(
  client: pg.Client,
  key: string,
  status: string,
  nextSweepAt: string | null,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO charges (id, owner_id, amount_cents, status, purpose, package_id, credits_count, next_sweep_at)
     SELECT $1, $2, price_cents, $3::charge_status, 'package', id, credits, $5
       FROM credit_packages WHERE key = $4 ORDER BY effective_from DESC LIMIT 1`,
    [id, FIXTURE_IDS.ownerId, status, key, nextSweepAt],
  );
  return id;
}

test("M5.25 parses as a step that runs inside the runner's transaction", () => {
  const parsed = parseStep(M525, STEP);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  assert.equal(parsed.step.directives.has('no-transaction'), false);
  assert.match(STEP.toString('utf8'), /^SET LOCAL lock_timeout = '5s';$/m);
});

test(
  "B21: the step equals the seed: from M4.06's catalog, its text leaves the rows schema.sql seeds (the Fayetteville pack closed, the Bentonville pack live at $320.00 for 10; M5.34's two Fayetteville day care rows untouched)",
  SKIP_WHEN_NO_DB,
  async () => {
    const keys = [[...CATALOG_SEED_KEYS, OLD]];
    await withClient(async (client) => {
      const seeded = (await client.query(CATALOG_ROWS, keys)).rows;
      // Twelve live since M5.34 (her #40) added Fayetteville day care's two; M5.25 moves none of them.
      assert.equal(seeded.length, 13, 'the volume holds the twelve live rows and the closed one');
      await beforeTheStep(client);
      await client.query(STEP.toString('utf8'));
      assert.deepEqual(
        (await client.query(CATALOG_ROWS, keys)).rows,
        seeded,
        "the step's rows are the seed's",
      );
      const moved = (await client.query(CATALOG_ROWS, [[OLD, NEW]])).rows;
      assert.deepEqual(moved, [
        {
          key: NEW,
          location: 'bentonville',
          mode: 'daycare',
          tier: 'alumni',
          credits: 10,
          price_cents: 32000,
          label: 'Alumni Bentonville 10 Visits',
          is_popular: false,
          single_day: false,
          expiry_months: 1,
          effective_from: '2026-01-01',
          effective_to: null,
        },
        {
          key: OLD,
          location: 'fayetteville',
          mode: 'school',
          tier: 'alumni',
          credits: 10,
          price_cents: 32000,
          label: 'Alumni Fayetteville 10 Visits',
          is_popular: false,
          single_day: false,
          expiry_months: 1,
          effective_from: '2026-01-01',
          effective_to: '2026-01-01',
        },
      ]);
    });
  },
);

test(
  'B21: the guard refuses, and nothing applies, while a live Fayetteville day-school alumni lot holds credits (it names the owner and the balance)',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await beforeTheStep(client);
      await lot(client, { location: 'fayetteville', mode: 'school', tier: 'alumni', credits: 3 });
      await refusedWith(
        client,
        STEP.toString('utf8'),
        new RegExp(`${FIXTURE_IDS.ownerId} holds 3`),
      );
    });
  },
);

test(
  'B21: the guard refuses while a purchase of the old pack is pending (`requires_payment`, or `failed` with a sweep due); a `failed` charge with nothing left to look at does not block',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const [status, sweep] of [
      ['requires_payment', null],
      ['failed', '2037-01-01T00:00:00Z'],
    ] as const) {
      await withClient(async (client) => {
        await beforeTheStep(client);
        const id = await charge(client, OLD, status, sweep);
        await refusedWith(client, STEP.toString('utf8'), new RegExp(`charge ${id} ${status}`));
      });
    }
    await withClient(async (client) => {
      await beforeTheStep(client);
      await charge(client, OLD, 'failed', null);
      await client.query(STEP.toString('utf8'));
    });
  },
);

test(
  "B21: the guard refuses while a live debit from a Fayetteville alumni lot sits on an uncancelled booking dated today or later (it names the booking and the owner); a past day's, a cancelled booking's and a returned debit do not block, nor does a credit returned into its lot once the desk empties that lot (Opus r2 N1)",
  SKIP_WHEN_NO_DB,
  async () => {
    const plant = async (client: pg.Client, daysFromNow: number, status?: string) => {
      // A lot of one credit, spent: its balance is 0, so only the debit can block.
      const lotId = await lot(client, {
        location: 'fayetteville',
        mode: 'school',
        tier: 'alumni',
        credits: 1,
      });
      return debitedBooking(client, {
        lotId,
        location: 'fayetteville',
        mode: 'school',
        tier: 'alumni',
        daysFromNow,
        ...(status !== undefined ? { status } : {}),
      });
    };
    for (const days of [0, 3]) {
      await withClient(async (client) => {
        await beforeTheStep(client);
        const { bookingId } = await plant(client, days);
        await refusedWith(
          client,
          STEP.toString('utf8'),
          new RegExp(`${FIXTURE_IDS.ownerId} booking ${bookingId}`),
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
         VALUES ($1, $2, 'fayetteville', 'school', 'alumni', 1, 'settlement-return', $3, $4, '2020-01-01T00:00:00Z')
         RETURNING id`,
        [FIXTURE_IDS.ownerId, FIXTURE_IDS.dog1Id, bookingId, debitId],
      );
      // The returned credit is a fresh lot past its date, which the guard's first clause
      // reads too since fix 1 (Fable L6), so it is moved by hand first, as the runbook does
      // (CRED-26). The debit it reversed is what this control is about.
      await client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, tier, delta, reason, lot_id, note)
         VALUES ($1, 'fayetteville', 'school', 'alumni', -1, 'adjustment', $2, 'rs2-steps: moved by hand')`,
        [FIXTURE_IDS.ownerId, returned.rows[0]?.id],
      );
      await client.query(STEP.toString('utf8'));
    });

    // Her playground's shape (Opus r2 N1): one lot of 10, eight days debited from it, and
    // every cancel's return written back INTO the lot (`lot_id` the lot, no date of its own),
    // as the return writer (`creditLedgerRepository.refundForBooking`) does while the lot can
    // pay a later date. Every booking cancelled, then the lot emptied by the desk's remove
    // (`removeFromLot`'s row): the step applies. A return into its lot is not a lot; clause
    // 1's `g.lot_id IS NULL` is all that keeps each one from reading as a lot holding 1.
    await withClient(async (client) => {
      await beforeTheStep(client);
      const lotId = await lot(client, {
        location: 'fayetteville',
        mode: 'school',
        tier: 'alumni',
        credits: 10,
      });
      const unspent = async (): Promise<number | undefined> =>
        (
          await client.query<{ unspent: number }>(
            `SELECT SUM(delta)::int AS unspent FROM credit_ledger WHERE id = $1 OR lot_id = $1`,
            [lotId],
          )
        ).rows[0]?.unspent;
      const returns: string[] = [];
      for (let days = 1; days <= 8; days += 1) {
        const { bookingId, debitId } = await debitedBooking(client, {
          lotId,
          location: 'fayetteville',
          mode: 'school',
          tier: 'alumni',
          daysFromNow: days,
        });
        await client.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId]);
        const returned = await client.query<{ id: string }>(
          `INSERT INTO credit_ledger (owner_id, dog_id, location, mode, tier, delta, reason, booking_id, reverses_entry_id, lot_id)
           VALUES ($1, $2, 'fayetteville', 'school', 'alumni', 1, 'settlement-return', $3, $4, $5)
           RETURNING id`,
          [FIXTURE_IDS.ownerId, FIXTURE_IDS.dog1Id, bookingId, debitId, lotId],
        );
        returns.push(returned.rows[0]?.id ?? '');
      }
      assert.equal(await unspent(), 10, 'every return went back into the lot');
      await client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, tier, delta, reason, lot_id, note, created_by_staff_id)
         VALUES ($1, 'fayetteville', 'school', 'alumni', -10, 'adjustment', $2, 'rs2-steps: moved by hand', $3)`,
        [FIXTURE_IDS.ownerId, lotId, FIXTURE_IDS.staffDonavanId],
      );
      assert.equal(await unspent(), 0, "the desk's remove emptied the lot");
      const refused = await client.query(STEP.toString('utf8')).then(
        () => undefined,
        (err: { message?: string }) => err.message ?? String(err),
      );
      assert.equal(
        refused,
        undefined,
        `the eight returns into lot ${lotId} are not lots of their own: ${returns.join(', ')}`,
      );
    });
  },
);

test(
  'B21: the guard refuses while a Fayetteville day-school alumni lot holds credits though it has expired (switching expiry off revives them), naming the owner; the same lot emptied by hand applies (fix 1, Fable L6)',
  SKIP_WHEN_NO_DB,
  async () => {
    const expired = {
      location: 'fayetteville',
      mode: 'school',
      tier: 'alumni',
      credits: 5,
      expiresAt: '2026-01-01T06:00:00Z',
    } as const;
    const liveBalance = async (client: pg.Client): Promise<number> =>
      (
        await client.query<{ balance: number }>(
          `SELECT COALESCE(SUM(balance), 0)::int AS balance FROM owner_credit_balance
            WHERE owner_id = $1 AND location = 'fayetteville' AND mode = 'school' AND tier = 'alumni'`,
          [FIXTURE_IDS.ownerId],
        )
      ).rows[0]?.balance ?? 0;

    // What the clause guards against: the live balance cannot see the lot, until expiry is
    // switched off (Postgres's clock is past its date; the injected clock never reaches it).
    await withClient(async (client) => {
      await beforeTheStep(client);
      await lot(client, expired);
      assert.equal(await liveBalance(client), 0, 'expired: the live balance does not count it');
      await client.query(`UPDATE credit_settings SET expiry_enforced_enabled = false`);
      assert.equal(await liveBalance(client), 5, 'expiry switched off: its 5 credits are back');
    });

    await withClient(async (client) => {
      await beforeTheStep(client);
      await lot(client, expired);
      await refusedWith(
        client,
        STEP.toString('utf8'),
        new RegExp(`${FIXTURE_IDS.ownerId} holds 5 .*expired`),
      );
    });

    await withClient(async (client) => {
      await beforeTheStep(client);
      const lotId = await lot(client, expired);
      await client.query(
        `INSERT INTO credit_ledger (owner_id, location, mode, tier, delta, reason, lot_id, note)
         VALUES ($1, 'fayetteville', 'school', 'alumni', -5, 'adjustment', $2, 'rs2-steps: moved by hand')`,
        [FIXTURE_IDS.ownerId, lotId],
      );
      await client.query(STEP.toString('utf8'));
    });
  },
);

test(
  'B21: the reversal refuses on its mirror (a live Bentonville day care alumni balance; a pending purchase of the new pack), not on a live debit, and otherwise restores the Fayetteville pack and closes the Bentonville one',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await lot(client, { location: 'bentonville', mode: 'daycare', tier: 'alumni', credits: 2 });
      await refusedWith(client, REVERSAL, new RegExp(`${FIXTURE_IDS.ownerId} holds 2`));
    });
    await withClient(async (client) => {
      const id = await charge(client, NEW, 'requires_payment', null);
      await refusedWith(client, REVERSAL, new RegExp(`charge ${id} requires_payment`));
    });
    await withClient(async (client) => {
      const lotId = await lot(client, {
        location: 'bentonville',
        mode: 'daycare',
        tier: 'alumni',
        credits: 1,
      });
      await debitedBooking(client, {
        lotId,
        location: 'bentonville',
        mode: 'daycare',
        tier: 'alumni',
        daysFromNow: 3,
      });
      await client.query(REVERSAL);
      const live = (
        await client.query(
          `SELECT key, effective_to::text FROM credit_packages WHERE key = ANY($1) ORDER BY key`,
          [[OLD, NEW]],
        )
      ).rows;
      assert.deepEqual(live, [
        { key: NEW, effective_to: '2026-01-01' },
        { key: OLD, effective_to: null },
      ]);
    });
  },
);

/** The alumni rows on sale today in Chicago: `[effective_from, effective_to)` holds the day. */
async function alumniOnSale(client: pg.Client) {
  return (
    await client.query(
      `SELECT key, location, mode, price_cents, expiry_months, effective_from::text
         FROM credit_packages
        WHERE tier = 'alumni'
          AND effective_from <= (now() AT TIME ZONE 'America/Chicago')::date
          AND (effective_to IS NULL OR effective_to > (now() AT TIME ZONE 'America/Chicago')::date)
        ORDER BY key, effective_from`,
    )
  ).rows;
}

test(
  'B21: the step, its reversal, then the step again leaves exactly one alumni pack on sale, Bentonville day care at $320.00, the Fayetteville pack closed; a Bentonville row repriced before the reversal comes back at its latest (fix 1, Fable L5)',
  SKIP_WHEN_NO_DB,
  async () => {
    await withClient(async (client) => {
      await beforeTheStep(client);
      await client.query(STEP.toString('utf8'));
      await client.query(REVERSAL);
      assert.deepEqual(
        (await alumniOnSale(client)).map((row) => row.key),
        [OLD],
        'the reversal: Fayetteville on sale again',
      );
      await client.query(STEP.toString('utf8'));
      assert.deepEqual(await alumniOnSale(client), [
        {
          key: NEW,
          location: 'bentonville',
          mode: 'daycare',
          price_cents: 32000,
          expiry_months: 1,
          effective_from: '2026-01-01',
        },
      ]);
      const old = (await client.query(CATALOG_ROWS, [[OLD]])).rows;
      assert.ok(old.length > 0);
      for (const row of old) assert.equal(row.effective_to, row.effective_from, 'no live day');
    });

    // A staff reprice (`setExpiryMonths`' shape): the first row closed, a successor opened.
    await withClient(async (client) => {
      await client.query(
        `UPDATE credit_packages SET effective_to = '2026-06-01' WHERE key = $1 AND effective_to IS NULL`,
        [NEW],
      );
      await client.query(
        `INSERT INTO credit_packages (key, location, mode, tier, credits, price_cents, label, is_popular, single_day, expiry_months, effective_from)
         SELECT key, location, mode, tier, credits, price_cents, label, is_popular, single_day, 3, '2026-06-01'
           FROM credit_packages WHERE key = $1 AND effective_from = '2026-01-01'`,
        [NEW],
      );
      await client.query(REVERSAL);
      await client.query(STEP.toString('utf8'));
      assert.deepEqual(
        (await alumniOnSale(client)).map((row) => [row.key, row.expiry_months, row.effective_from]),
        [[NEW, 3, '2026-06-01']],
      );
    });
  },
);

test(
  'B21: the shop, read outside any step transaction: Bentonville day care lists the alumni pack to an alumni family; Fayetteville lists none',
  SKIP_WHEN_NO_DB,
  async () => {
    await createAlumniDog(created);
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });
    const list = async (location: string) => {
      const res = await app.inject({ method: 'GET', url: `/credit-packages?location=${location}` });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json() as CreditPackageWire[]).filter((row) => row.tier === 'alumni');
    };

    const bentonville = await list('bentonville');
    assert.deepEqual(
      bentonville.map((row) => [
        row.key,
        row.mode,
        row.price_cents,
        row.credits,
        row.label,
        row.withheld_reason,
      ]),
      [[NEW, 'daycare', 32000, 10, 'Alumni Bentonville 10 Visits', undefined]],
    );
    assert.deepEqual(await list('fayetteville'), []);
  },
);
