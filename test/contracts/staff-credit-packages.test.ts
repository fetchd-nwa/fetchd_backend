import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import {
  auditLog,
  creditLedger,
  creditPackages,
  staffSettings,
  orders,
} from '../../src/db/schema/schema.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerStaffCreditPackagesRoute } from '../../src/routes/staffCreditPackages.js';
import { FIXTURE_IDS, FIXTURE_NOW, resetCatalogSeed } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { makeStripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';
import type { CreditPackageWire } from '../../src/contracts/wire.js';

/**
 * CRED-U08 narrowed to this one field (design §1.1:1002-1004, §2.4:3099-3106):
 * `PATCH /staff/credit-packages/:key {expiry_months}`. FIXTURE_TODAY is 2026-05-19, and
 * the ten seeded rows open at 2026-01-01, so an edit of one closes it and opens a
 * successor. What a purchase stamps after an edit is in `package-expiry-stamp.test.ts`.
 */

registerFixtureHooks();
afterEach(resetCatalogSeed);

const KEY = 'school-2x-weekly-fayetteville';

function staffApp(principal: Principal = FIXTURE_MANAGER_PRINCIPAL) {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

function patchPackage(
  app: ReturnType<typeof staffApp>,
  key: string,
  payload: Record<string, unknown>,
  idempotencyKey: string | undefined = `scp-${randomUUID()}`,
) {
  return app.inject({
    method: 'PATCH',
    url: `/staff/credit-packages/${key}`,
    headers: idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey },
    payload,
  });
}

async function rowsOf(key: string) {
  return db
    .select()
    .from(creditPackages)
    .where(eq(creditPackages.key, key))
    .orderBy(asc(creditPackages.effectiveFrom));
}

test(
  'PATCH closes the live row at today and opens its successor, answering the wire row',
  SKIP_WHEN_NO_DB,
  async () => {
    const res = await patchPackage(staffApp(), KEY, { expiry_months: 3 });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      key: KEY,
      location: 'fayetteville',
      mode: 'school',
      tier: 'regular',
      credits: 8,
      price_cents: 45_600,
      label: 'Fayetteville 2x Weekly',
      is_popular: false,
      single_day: false,
      expiry_months: 3,
    });

    const [old, next, ...rest] = await rowsOf(KEY);
    assert.equal(rest.length, 0, 'one successor');
    assert.equal(old!.effectiveTo, '2026-05-19', 'closed at today');
    assert.equal(old!.expiryMonths, 1, 'the old row keeps the months its lots were stamped with');
    assert.equal(next!.effectiveFrom, '2026-05-19', 'its successor opens today');
    assert.equal(next!.effectiveTo, null);
    assert.equal(next!.expiryMonths, 3);
    assert.equal(next!.priceCents, old!.priceCents, 'no price moves');
    assert.equal(next!.credits, old!.credits, 'no count moves');
  },
);

test(
  'a second edit the same Chicago day corrects the row in place: 200, not 23505, no third row',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    assert.equal((await patchPackage(app, KEY, { expiry_months: 3 })).statusCode, 200);
    const second = await patchPackage(app, KEY, { expiry_months: 4 });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((second.json() as CreditPackageWire).expiry_months, 4);
    const rows = await rowsOf(KEY);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.expiryMonths, 4);
  },
);

test(
  'a successor keeps the closed row`s effective_to, so it cannot overlap a window scheduled after it',
  SKIP_WHEN_NO_DB,
  async () => {
    // test-school-5's current window ends 2027-01-01, where a scheduled reprice opens.
    const key = FIXTURE_IDS.creditPackageSchool5Key;
    const res = await patchPackage(staffApp(), key, { expiry_months: 2 });
    assert.equal(res.statusCode, 200, res.body);
    const successor = (await rowsOf(key)).find((r) => r.effectiveFrom === '2026-05-19');
    assert.equal(successor?.effectiveTo, '2027-01-01');
    await db
      .delete(creditPackages)
      .where(and(eq(creditPackages.key, key), eq(creditPackages.effectiveFrom, '2026-05-19')));
    await db
      .update(creditPackages)
      .set({ effectiveTo: '2027-01-01' })
      .where(eq(creditPackages.id, FIXTURE_IDS.creditPackageSchool5Id));
  },
);

test(
  'the catalog reads the new months at once: the cached campus is wiped in the same request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
    registerStaffCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });
    registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });
    const months = async (): Promise<number | undefined> => {
      const res = await app.inject({
        method: 'GET',
        url: '/credit-packages?location=fayetteville',
      });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json() as CreditPackageWire[]).find((r) => r.key === KEY)?.expiry_months;
    };

    assert.equal(await months(), 1, 'read once, so the catalog is cached');
    assert.equal((await patchPackage(app, KEY, { expiry_months: 3 })).statusCode, 200);
    assert.equal(await months(), 3);
  },
);

test(
  'a lot already sold keeps its date when the row`s months change',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate, stripe: makeStripeStub(), now: FIXTURE_NOW });
    const bought = await app.inject({
      method: 'POST',
      url: `/credit-packages/${KEY}/purchase`,
      headers: { 'idempotency-key': `scp-sold-${randomUUID()}` },
      payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id },
    });
    assert.equal(bought.statusCode, 201, bought.body);
    const chargeId = (bought.json() as { charge_id: string }).charge_id;
    const lot = async () => {
      const [row] = await db
        .select({ expiresAt: creditLedger.expiresAt, packageId: creditLedger.packageId })
        .from(creditLedger)
        .where(eq(creditLedger.chargeId, chargeId));
      assert.ok(row);
      return row;
    };
    try {
      const before = await lot();
      assert.equal((await patchPackage(staffApp(), KEY, { expiry_months: 3 })).statusCode, 200);
      assert.deepEqual(await lot(), before);
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.chargeId, chargeId));
      await clearOrderRows();
      await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
    }
  },
);

for (const [why, key] of [
  ['an unknown key', 'no-such-pack'],
  ['a retired key', FIXTURE_IDS.creditPackageRetiredKey],
] as const) {
  test(`${why} is 404 not_found`, SKIP_WHEN_NO_DB, async () => {
    const res = await patchPackage(staffApp(), key, { expiry_months: 2 });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error.code, 'not_found');
  });
}

test(
  'a trainer is 403 credit_edit_role_required and writes nothing; a family is 403 forbidden',
  SKIP_WHEN_NO_DB,
  async () => {
    const trainer = await patchPackage(staffApp(FIXTURE_STAFF_PRINCIPAL), KEY, {
      expiry_months: 3,
    });
    assert.equal(trainer.statusCode, 403, trainer.body);
    assert.equal(trainer.json().error.code, 'credit_edit_role_required');

    const family = await patchPackage(staffApp(FIXTURE_OWNER_PRINCIPAL), KEY, {
      expiry_months: 3,
    });
    assert.equal(family.statusCode, 403, family.body);
    assert.equal(family.json().error.code, 'forbidden');

    assert.equal((await rowsOf(KEY)).length, 1, 'nothing written');
  },
);

test('the manager and the owner role pass at the seed', SKIP_WHEN_NO_DB, async () => {
  for (const principal of [FIXTURE_MANAGER_PRINCIPAL, FIXTURE_OWNER_ROLE_PRINCIPAL]) {
    const res = await patchPackage(staffApp(principal), KEY, { expiry_months: 2 });
    assert.equal(res.statusCode, 200, res.body);
  }
});

test(
  'the list is read at the verb: a role added passes, a role removed is refused, the owner role always passes',
  SKIP_WHEN_NO_DB,
  async () => {
    const setList = (roles: ('owner' | 'manager' | 'trainer')[]) =>
      db.update(staffSettings).set({ creditHandEditRoles: roles });
    try {
      await setList(['owner', 'manager', 'trainer']);
      const trainer = await patchPackage(staffApp(FIXTURE_STAFF_PRINCIPAL), KEY, {
        expiry_months: 2,
      });
      assert.equal(trainer.statusCode, 200, trainer.body);

      await setList(['trainer']);
      const manager = await patchPackage(staffApp(FIXTURE_MANAGER_PRINCIPAL), KEY, {
        expiry_months: 3,
      });
      assert.equal(manager.statusCode, 403, manager.body);
      assert.equal(manager.json().error.code, 'credit_edit_role_required');
      const owner = await patchPackage(staffApp(FIXTURE_OWNER_ROLE_PRINCIPAL), KEY, {
        expiry_months: 3,
      });
      assert.equal(owner.statusCode, 200, owner.body);
    } finally {
      await setList(['owner', 'manager']);
    }
  },
);

test('a bad body is 400 and a missing Idempotency-Key is 400', SKIP_WHEN_NO_DB, async () => {
  const app = staffApp();
  for (const payload of [
    { expiry_months: 0 },
    { expiry_months: 121 },
    { expiry_months: 1.5 },
    { expiry_months: '3' },
    {},
    { expiry_months: 3, price_cents: 1 },
    { expiry_months: 3, credits: 2 },
  ]) {
    const res = await patchPackage(app, KEY, payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)}: ${res.body}`);
  }
  const noKey = await app.inject({
    method: 'PATCH',
    url: `/staff/credit-packages/${KEY}`,
    payload: { expiry_months: 3 },
  });
  assert.equal(noKey.statusCode, 400, noKey.body);
  assert.equal((await rowsOf(KEY)).length, 1, 'nothing written');
});

test('both bounds of expiry_months pass', SKIP_WHEN_NO_DB, async () => {
  const app = staffApp();
  assert.equal((await patchPackage(app, KEY, { expiry_months: 120 })).statusCode, 200);
  assert.equal((await patchPackage(app, KEY, { expiry_months: 1 })).statusCode, 200);
});

test(
  'an idempotent replay answers the same row with no second write',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    const key = `scp-replay-${randomUUID()}`;
    const first = await patchPackage(app, KEY, { expiry_months: 3 }, key);
    const replay = await patchPackage(app, KEY, { expiry_months: 3 }, key);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json());
    assert.equal((await rowsOf(KEY)).length, 2);
  },
);

// DECISIONS 177(d): `credit_packages` is on the audit trigger, because `expiry_months` is
// a money-class edit, and a same-day correction overwrites the only copy of the old value.
async function auditRowsOf(id: string) {
  return db
    .select({ op: auditLog.op, before: auditLog.before, actor: auditLog.actor })
    .from(auditLog)
    .where(and(eq(auditLog.tableName, 'credit_packages'), eq(auditLog.rowPk, id)));
}

test(
  'a PATCH closing a row leaves an audit row naming the staffer, with the prior value',
  SKIP_WHEN_NO_DB,
  async () => {
    const [seed] = await rowsOf(KEY);
    assert.ok(seed);
    await db.delete(auditLog).where(eq(auditLog.rowPk, seed.id));
    assert.equal((await patchPackage(staffApp(), KEY, { expiry_months: 3 })).statusCode, 200);

    const rows = await auditRowsOf(seed.id);
    assert.equal(rows.length, 1, 'one audit row for the row it closed');
    assert.equal(rows[0]?.op, 'UPDATE');
    assert.equal(rows[0]?.actor, `staff:${FIXTURE_IDS.staffAmberId}`);
    const before = rows[0]?.before as { effective_to: string | null; expiry_months: number };
    assert.equal(before.effective_to, null, 'the row as it stood');
    assert.equal(before.expiry_months, 1);
  },
);

test(
  'a same-day correction leaves an audit row naming the staffer, with the value it replaced',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    assert.equal((await patchPackage(app, KEY, { expiry_months: 3 })).statusCode, 200);
    const opened = (await rowsOf(KEY)).find((r) => r.effectiveFrom === '2026-05-19');
    assert.ok(opened);
    assert.equal((await patchPackage(app, KEY, { expiry_months: 4 })).statusCode, 200);

    const rows = await auditRowsOf(opened.id);
    assert.equal(rows.length, 1, 'the correction is the one update of that row');
    assert.equal(rows[0]?.actor, `staff:${FIXTURE_IDS.staffAmberId}`);
    assert.equal((rows[0]?.before as { expiry_months: number }).expiry_months, 3);
  },
);

test(
  'two edits at once serialize on the key: the second waits, then corrects what the first opened',
  SKIP_WHEN_NO_DB,
  async () => {
    // Two connections, forced: the first edit is held uncommitted on its own client,
    // holding the key's lock as the route does, until the route's edit is really
    // waiting. Without the lock the route's statement reads the old row, waits on it,
    // and then opens the same successor: 23505, a 500.
    const first = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await first.connect();
    const lockKey = `credit-package:${KEY}`;
    try {
      await first.query('BEGIN');
      await first.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      await first.query(
        `UPDATE credit_packages SET effective_to = '2026-05-19'
          WHERE key = $1 AND effective_from = '2026-01-01'`,
        [KEY],
      );
      await first.query(
        `INSERT INTO credit_packages
           (key, location, mode, credits, price_cents, label, is_popular, tier, single_day,
            expiry_months, effective_from)
         SELECT key, location, mode, credits, price_cents, label, is_popular, tier, single_day,
                2, '2026-05-19'
           FROM credit_packages WHERE key = $1`,
        [KEY],
      );

      const second = patchPackage(staffApp(), KEY, { expiry_months: 3 });
      await waitForABlockedBackend();
      await first.query('COMMIT');

      const res = await second;
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((res.json() as CreditPackageWire).expiry_months, 3);
      const rows = await rowsOf(KEY);
      assert.equal(rows.length, 2, 'the second corrected the first, and opened nothing');
      assert.equal(rows.filter((r) => r.effectiveTo === null).length, 1, 'one open window');
      assert.equal(rows[1]!.expiryMonths, 3);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await first.end();
    }
  },
);

/**
 * Until some backend on this database is waiting on a lock. A bounded wait: the proof is
 * void if the second edit never reached the lock, so that fails here. On a connection of
 * its own, because `pg_stat_activity` is one snapshot per transaction.
 */
async function waitForABlockedBackend(): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { rows } = await db.execute(sql`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((rows[0] as { blocked: number }).blocked > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the second edit never waited on a lock');
}
