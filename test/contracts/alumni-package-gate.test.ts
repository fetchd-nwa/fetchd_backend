import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Principal } from '../../src/auth/principal.js';
import type { CreditPackageWire, CurriculumProgram } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { creditPackagesCacheKey } from '../../src/db/repositories/creditPackagesRepository.js';
import {
  charges,
  creditLedger,
  dogs,
  idempotencyKeys,
  invoices,
  orders,
  owners,
} from '../../src/db/schema/schema.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { bucketChicagoToday } from '../../src/lib/chicagoDate.js';
import { redis } from '../../src/redis.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerStaffAlumniRoute } from '../../src/routes/staffAlumni.js';
import { CATALOG_SEED_KEYS, FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * ALUM-U11 (design §2.4:3060-3069; wire 5.0.0 `CreditPackageWire.withheld_reason`,
 * `AlumniPackageIneligibleDetails`): the Alumni Fayetteville 10 Visits row sells only to
 * a household with a live dog `is_alumni`. The gate is the household's, never a dog's: no
 * dog is named on a purchase. The list says so ahead of time, per owner and after the
 * shared catalog cache; the purchase refuses it before any order opens.
 *
 * The catalog is the seed's (M4.06): at Fayetteville, two tiers, the regular 2x, 3x and
 * single day beside the alumni 10 (P19 `brief_must_say` item 12). The fixture's two
 * `test-school-*` rows ride along and are regular.
 *
 * Opus cut-fix1 L4 (build DECISIONS 206(e)) closes here: the phone cannot refuse a sale
 * over an alumni change it has not read, so the server reads the household on every
 * request. Every way the household's last alumni dog goes is driven below.
 */

registerFixtureHooks();

const ALUMNI = 'school-alumni-10-fayetteville';
const OWNER = FIXTURE_IDS.ownerId;
const FAYETTEVILLE_SEED = CATALOG_SEED_KEYS.filter((key) => key.endsWith('-fayetteville'));

const plantedDogs: string[] = [];
const plantedOwners: string[] = [];

async function removePlanted(): Promise<void> {
  if (plantedDogs.length > 0) {
    await db.delete(dogs).where(inArray(dogs.id, plantedDogs.splice(0)));
  }
  if (plantedOwners.length > 0) {
    await db.delete(owners).where(inArray(owners.id, plantedOwners.splice(0)));
  }
}

afterEach(async () => {
  await db.delete(creditLedger).where(isNotNull(creditLedger.chargeId));
  await clearOrderRows();
  await db.delete(orders).where(eq(orders.ownerId, OWNER));
  await removePlanted();
  await redis.flushdb();
});

/** A live dog of `ownerId`, alumni or not. Not one she books with: no purchase names a dog. */
async function plantDog(ownerId: string, isAlumni: boolean): Promise<string> {
  const id = randomUUID();
  plantedDogs.push(id);
  await db.insert(dogs).values({
    id,
    ownerId,
    name: `Gate ${id.slice(0, 6)}`,
    breed: 'Test Breed',
    birthdate: '2022-01-01',
    isAlumni,
  });
  return id;
}

type OwnerPrincipal = Extract<Principal, { kind: 'owner' }>;

/** A second household, for the cache: it holds no card, so it only reads. */
async function plantOwner(): Promise<OwnerPrincipal> {
  const id = randomUUID();
  const supabaseUid = randomUUID();
  plantedOwners.push(id);
  await db.insert(owners).values({
    id,
    supabaseUid,
    name: 'Second Household',
    email: `gate-${id.slice(0, 8)}@example.com`,
  });
  return { kind: 'owner', ownerId: id, supabaseUid };
}

async function catalogAs(principal: Principal): Promise<CreditPackageWire[]> {
  const { app, authenticate } = makeContractApp(principal);
  registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });
  const res = await app.inject({ method: 'GET', url: '/credit-packages?location=fayetteville' });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as CreditPackageWire[];
}

/** The rows that carry the field, by key and reason: the whole of what is withheld. */
function withheld(rows: readonly CreditPackageWire[]): [string, string][] {
  return rows
    .filter((row) => 'withheld_reason' in row)
    .map((row) => [row.key, String(row.withheld_reason)]);
}

function purchaseApp() {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerCreditPackagesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

function buy(
  world: ReturnType<typeof purchaseApp>,
  key: string,
  idempotencyKey = `gate-${randomUUID()}`,
) {
  return world.app.inject({
    method: 'POST',
    url: `/credit-packages/${key}/purchase`,
    headers: { 'idempotency-key': idempotencyKey },
    payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id },
  });
}

/** Every row a purchase can write, counted for this household and one key. */
async function moneyRows(idempotencyKey: string) {
  return {
    orders: (await db.select({ id: orders.id }).from(orders).where(eq(orders.ownerId, OWNER)))
      .length,
    charges: (await db.select({ id: charges.id }).from(charges).where(eq(charges.ownerId, OWNER)))
      .length,
    invoices: (
      await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.ownerId, OWNER))
    ).length,
    ledger: (
      await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.ownerId, OWNER))
    ).length,
    claims: (
      await db
        .select({ key: idempotencyKeys.key })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, idempotencyKey))
    ).length,
  };
}

function assertIneligible(res: { statusCode: number; json(): unknown; body: string }): void {
  assert.equal(res.statusCode, 422, res.body);
  const { error } = res.json() as { error: { code: string; details?: unknown } };
  assert.equal(error.code, 'alumni_package_ineligible');
  assert.deepEqual(error.details, { kind: 'alumni_package_ineligible', reason: 'no-alumni-dog' });
}

async function alumniLots() {
  return db
    .select({ tier: creditLedger.tier, dogId: creditLedger.dogId })
    .from(creditLedger)
    .where(and(isNotNull(creditLedger.chargeId), eq(creditLedger.tier, 'alumni')));
}

// ── the list ─────────────────────────────────────────────────────────────────

test(
  'GET /credit-packages: a household with no live alumni dog reads the Alumni 10 withheld "alumni-only", and only it',
  SKIP_WHEN_NO_DB,
  async () => {
    const rows = await catalogAs(FIXTURE_OWNER_PRINCIPAL);
    assert.deepEqual(
      rows.filter((r) => FAYETTEVILLE_SEED.includes(r.key)).map((r) => [r.key, r.tier]),
      [
        ['single-day-school-fayetteville', 'regular'],
        ['school-2x-weekly-fayetteville', 'regular'],
        ['school-alumni-10-fayetteville', 'alumni'],
        ['school-3x-weekly-fayetteville', 'regular'],
      ],
      'the seed catalog at Fayetteville: two tiers',
    );
    assert.deepEqual(withheld(rows), [[ALUMNI, 'alumni-only']]);
    // The row is still listed, whole: the app greys it, and the price stays exact.
    const alumni = rows.find((r) => r.key === ALUMNI);
    assert.equal(alumni?.price_cents, 32_000);
    assert.equal(alumni?.credits, 10);
  },
);

test(
  'GET /credit-packages: any one live alumni dog on the account opens it, and no row carries the field',
  SKIP_WHEN_NO_DB,
  async () => {
    await plantDog(OWNER, false);
    await plantDog(OWNER, true);
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), []);
  },
);

test(
  'GET /credit-packages as staff never carries the field, whatever any household holds',
  SKIP_WHEN_NO_DB,
  async () => {
    assert.deepStrictEqual(
      await catalogAs(FIXTURE_STAFF_PRINCIPAL),
      loadSnapshot('credit-packages'),
    );
    await plantDog(OWNER, true);
    assert.deepStrictEqual(
      await catalogAs(FIXTURE_STAFF_PRINCIPAL),
      loadSnapshot('credit-packages'),
    );
  },
);

test(
  'the catalog cache stays shared and unpoisoned: A, then B, then staff, then A again, each reads its own answer',
  SKIP_WHEN_NO_DB,
  async () => {
    await redis.flushdb();
    const householdB = await plantOwner();
    await plantDog(householdB.ownerId, true);
    const cacheKey = creditPackagesCacheKey('fayetteville', bucketChicagoToday(FIXTURE_NOW()));

    // A has no alumni dog, and her read is the one that fills the cache.
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), [[ALUMNI, 'alumni-only']]);
    const cached = await redis.get(cacheKey);
    assert.ok(cached, "A's read filled the shared cache");
    assert.equal(cached.includes('withheld_reason'), false, 'nothing per owner is cached');

    assert.deepEqual(withheld(await catalogAs(householdB)), [], 'B is alumni: nothing withheld');
    assert.deepStrictEqual(
      await catalogAs(FIXTURE_STAFF_PRINCIPAL),
      loadSnapshot('credit-packages'),
      'staff read the rows bare',
    );
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), [[ALUMNI, 'alumni-only']]);
    assert.equal((await redis.get(cacheKey))?.includes('withheld_reason'), false);
  },
);

// ── the purchase ─────────────────────────────────────────────────────────────

test(
  'POST the Alumni 10 with no live alumni dog: 422 alumni_package_ineligible, before any order opens',
  SKIP_WHEN_NO_DB,
  async () => {
    await plantDog(OWNER, false); // a live dog, not alumni: the household still has none
    const world = purchaseApp();
    const key = `gate-refused-${randomUUID()}`;
    const before = await moneyRows(key);

    assertIneligible(await buy(world, ALUMNI, key));

    assert.deepEqual(
      await moneyRows(key),
      before,
      'no order, charge, invoice, lot, ledger row or claim',
    );
    assert.equal(world.stripe.calls.length, 0, 'the Stripe stub records no call');
  },
);

test(
  'POST the Alumni 10 when some other live dog on the account is alumni: 201, and the lot names no dog',
  SKIP_WHEN_NO_DB,
  async () => {
    await plantDog(OWNER, true); // not Waffles or her sister, the dogs she books with
    const world = purchaseApp();
    const res = await buy(world, ALUMNI);
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(await alumniLots(), [{ tier: 'alumni', dogId: null }]);
  },
);

test(
  'the gate reads only the Alumni 10: a regular row sells to a household with no alumni dog',
  SKIP_WHEN_NO_DB,
  async () => {
    const res = await buy(purchaseApp(), 'school-2x-weekly-fayetteville');
    assert.equal(res.statusCode, 201, res.body);
  },
);

// ── every way the household's last alumni dog goes (Opus cut-fix1 L4) ───────

test(
  'DELETE /dogs/:id of her last alumni dog: the next list withholds the row and the next purchase is refused',
  SKIP_WHEN_NO_DB,
  async () => {
    const first = await plantDog(OWNER, true);
    const last = await plantDog(OWNER, true);
    const { app: dogsApp, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(dogsApp, { authenticate });
    const remove = (dogId: string) =>
      dogsApp.inject({
        method: 'DELETE',
        url: `/dogs/${dogId}`,
        headers: { 'idempotency-key': `gate-rm-${randomUUID()}` },
      });

    assert.equal((await remove(first)).statusCode, 204);
    assert.deepEqual(
      withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)),
      [],
      'one alumni dog is left',
    );

    assert.equal((await remove(last)).statusCode, 204);
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), [[ALUMNI, 'alumni-only']]);
    const world = purchaseApp();
    assertIneligible(await buy(world, ALUMNI));
    assert.equal(world.stripe.calls.length, 0);
  },
);

test(
  "an operator's data edit, is_alumni = false (no route clears it): the next list withholds and the next purchase is refused",
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await plantDog(OWNER, true);
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), []);
    await db.update(dogs).set({ isAlumni: false }).where(eq(dogs.id, dogId));
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), [[ALUMNI, 'alumni-only']]);
    assertIneligible(await buy(purchaseApp(), ALUMNI));
  },
);

test(
  "an operator's expiry of her alumni dog (expired_at by hand): the next list withholds and the next purchase is refused",
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await plantDog(OWNER, true);
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), []);
    await db
      .update(dogs)
      .set({ expiredAt: sql`now()` })
      .where(eq(dogs.id, dogId));
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), [[ALUMNI, 'alumni-only']]);
    assertIneligible(await buy(purchaseApp(), ALUMNI));
  },
);

test(
  'the staff record: the fifth level opens the pack, and un-recording one does not close it again (M4.11)',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await plantDog(OWNER, false);
    const { app: staffApp, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffAlumniRoute(staffApp, { authenticate });
    const record = (program: CurriculumProgram) =>
      staffApp.inject({
        method: 'POST',
        url: `/staff/dogs/${dogId}/completed-programs`,
        headers: { 'idempotency-key': `gate-rec-${randomUUID()}` },
        payload: { program },
      });

    for (const program of CURRICULUM_PROGRAMS.slice(0, -1)) {
      assert.equal((await record(program)).statusCode, 201);
    }
    assert.deepEqual(
      withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)),
      [[ALUMNI, 'alumni-only']],
      'four levels are not alumni',
    );
    assertIneligible(await buy(purchaseApp(), ALUMNI));

    const fifth = CURRICULUM_PROGRAMS[CURRICULUM_PROGRAMS.length - 1];
    assert.ok(fifth);
    assert.equal((await record(fifth)).statusCode, 201);
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), [], 'the fifth level');

    const unrecord = await staffApp.inject({
      method: 'DELETE',
      url: `/staff/dogs/${dogId}/completed-programs/${fifth}`,
      headers: { 'idempotency-key': `gate-unrec-${randomUUID()}` },
    });
    assert.equal(unrecord.statusCode, 200, unrecord.body);
    assert.deepEqual(withheld(await catalogAs(FIXTURE_OWNER_PRINCIPAL)), [], 'never cleared');
    const res = await buy(purchaseApp(), ALUMNI);
    assert.equal(res.statusCode, 201, res.body);
  },
);

// ── where the refusal sits against the claim (DECISIONS 128(a)) ──────────────

test(
  'a refusal is not stored: the same key, sent again once a dog of hers is alumni, buys the pack',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = purchaseApp();
    const key = `gate-retry-${randomUUID()}`;
    assertIneligible(await buy(world, ALUMNI, key));
    assert.equal((await moneyRows(key)).claims, 0, 'tx1 rolled back, claim and all');

    await plantDog(OWNER, true);
    const res = await buy(world, ALUMNI, key);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((await alumniLots()).length, 1);
  },
);

test(
  "a stored 201 replays under its key after the household's last alumni dog is gone",
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await plantDog(OWNER, true);
    const world = purchaseApp();
    const key = `gate-replay-${randomUUID()}`;
    const first = await buy(world, ALUMNI, key);
    assert.equal(first.statusCode, 201, first.body);

    await db
      .update(dogs)
      .set({ expiredAt: sql`now()` })
      .where(eq(dogs.id, dogId));
    const replay = await buy(world, ALUMNI, key);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), first.json(), 'the stored answer, byte for byte');
    assert.equal((await alumniLots()).length, 1, 'one lot: a replay buys nothing');
    assert.equal(
      world.stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent').length,
      1,
    );
  },
);
