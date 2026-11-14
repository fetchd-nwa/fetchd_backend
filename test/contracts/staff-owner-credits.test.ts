import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import {
  bookings,
  charges,
  creditLedger,
  creditLotExpiryEdits,
  creditPackages,
  creditSettings,
  dogs,
  orders,
  owners,
  staffSettings,
} from '../../src/db/schema/schema.js';
import type {
  BookingWire,
  CreditLotDetailWire,
  PostBookingsResponse,
  StaffCreditPoolWire,
  StaffOwnerCreditsWire,
} from '../../src/contracts/wire.js';
import { creditsInvalidationPattern } from '../../src/db/repositories/creditsRepository.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { bucketChicagoToday } from '../../src/lib/chicagoDate.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { registerStaffCreditPackagesRoute } from '../../src/routes/staffCreditPackages.js';
import { registerStaffCreditsRoute } from '../../src/routes/staffCredits.js';
import { registerStaffSettingsRoute } from '../../src/routes/staffSettings.js';
import { at, boardApp, makeClock, ownerDogCancel, verb } from './_checkinFixture.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
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
import {
  clearPlantedPools,
  plantLot,
  poolBalance,
  waitForBlockedBackends,
} from './_poolFixture.js';
import { makeStripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';

/**
 * The staff's hand on an owner's credits (design §1.1:988-1001, §2.4:3073-3098; CRED-U14,
 * CRED-U15): the read any role has, and the three writes the role list gates. `lot_is_live`
 * reads Postgres's clock and no injected clock reaches it, so the fixed clock here sits in
 * October 2037, as `credit-picker.test.ts`'s does. Lots use Bentonville day school, which
 * the fixture leaves empty.
 */

const createdDogs: string[] = [];
const createdOwners: string[] = [];
after(async () => {
  await clearPlantedPools();
  await clearOrderRows();
  await removeDogs(createdDogs);
});
registerFixtureHooks();
afterEach(async () => {
  await clearPlantedPools();
  await clearOrderRows();
  await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
  if (createdOwners.length > 0) {
    await db.delete(creditLedger).where(inArray(creditLedger.ownerId, createdOwners));
    await db.delete(owners).where(inArray(owners.id, createdOwners.splice(0)));
  }
  await db.update(staffSettings).set({ creditHandEditRoles: ['owner', 'manager'] });
  await db.update(creditSettings).set({ expiryEnforcedEnabled: true, manualGrantExpiryMonths: 1 });
  await invalidatePattern(creditsInvalidationPattern(FIXTURE_IDS.ownerId));
});

const OWNER: string = FIXTURE_IDS.ownerId;
const POOL = { location: 'bentonville', mode: 'school', tier: 'regular' } as const;
const CLOCK = new Date('2037-10-19T14:40:00.000Z'); // 09:40 CDT, Mon 19 Oct 2037
const ONE_MONTH_ON = '2037-11-19T15:40:00.000Z'; // 09:40 CST, Thu 19 Nov 2037
const BOOKING_CLOCK = (): Date => new Date('2037-10-07T00:30:00Z');
const LOT_FAR = '2038-06-01T00:00:00.000Z';
const IN_THE_PAST = '2037-10-18T00:00:00.000Z';
const REAL_YESTERDAY = (): string => new Date(Date.now() - 86_400_000).toISOString();

function staffApp(principal: Principal = FIXTURE_MANAGER_PRINCIPAL, now: () => Date = () => CLOCK) {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffCreditsRoute(app, { authenticate, now });
  return app;
}
type App = ReturnType<typeof staffApp>;

function bookingApp() {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, stripe: makeStripeStub(), now: BOOKING_CLOCK });
  return app;
}

function book(app: ReturnType<typeof bookingApp>, dogId: string, dates: readonly string[]) {
  return app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `hand-${randomUUID()}` },
    payload: {
      category: 'day-school',
      lead_dog_id: dogId,
      dates,
      location: 'bentonville',
      payment: { kind: 'credits' },
    },
  });
}

function read(app: App, ownerId = OWNER) {
  return app.inject({ method: 'GET', url: `/staff/owners/${ownerId}/credits` });
}

function adjust(app: App, payload: object, key = `adj-${randomUUID()}`, ownerId = OWNER) {
  return app.inject({
    method: 'POST',
    url: `/staff/owners/${ownerId}/credit-adjustments`,
    headers: { 'idempotency-key': key },
    payload,
  });
}

function moveLot(app: App, lotId: string, payload: object, key = `lot-${randomUUID()}`) {
  return app.inject({
    method: 'PATCH',
    url: `/staff/credit-lots/${lotId}`,
    headers: { 'idempotency-key': key },
    payload,
  });
}

const addBody = (extra: object = {}) => ({
  kind: 'add',
  ...POOL,
  credits: 2,
  note: 'goodwill after the storm closure',
  ...extra,
});
const removeBody = (lotId: string, credits = 1) => ({
  kind: 'remove',
  lot_id: lotId,
  credits,
  note: 'entered twice',
});

const errorCode = (res: { json: () => unknown }): string =>
  (res.json() as { error: { code: string } }).error.code;

/** Every ledger row of one lot family: the grant and what is tagged to it. */
async function rowsOfLot(lotId: string) {
  return db
    .select()
    .from(creditLedger)
    .where(sql`${creditLedger.id} = ${lotId} OR ${creditLedger.lotId} = ${lotId}`);
}

async function poolOf(ownerId = OWNER) {
  const res = await read(staffApp(), ownerId);
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as StaffOwnerCreditsWire).pools.find(
    (pool) => pool.location === POOL.location && pool.mode === POOL.mode && pool.tier === POOL.tier,
  );
}

const editsOf = (lotId: string) =>
  db
    .select()
    .from(creditLotExpiryEdits)
    .where(eq(creditLotExpiryEdits.lotId, lotId))
    .orderBy(asc(creditLotExpiryEdits.createdAt));

async function otherOwner(): Promise<string> {
  const id = randomUUID();
  createdOwners.push(id);
  await db.insert(owners).values({
    id,
    supabaseUid: randomUUID(),
    email: `other-${id}@example.com`,
    name: 'Other Owner',
  });
  return id;
}

async function lotOfOther(ownerId: string): Promise<string> {
  const [row] = await db
    .insert(creditLedger)
    .values({ ownerId, ...POOL, delta: 3, reason: 'purchase', expiresAt: LOT_FAR })
    .returning({ id: creditLedger.id });
  return row?.id as string;
}

async function withGate<T>(run: (gate: pg.Client) => Promise<T>): Promise<T> {
  const gate = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await gate.connect();
  try {
    await gate.query('BEGIN');
    return await run(gate);
  } finally {
    await gate.query('ROLLBACK').catch(() => undefined);
    await gate.end();
  }
}

const holdPool = (gate: pg.Client) =>
  gate.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `pool:${OWNER}:${POOL.location}:${POOL.mode}:${POOL.tier}`,
  ]);

// ── 1. The role list ─────────────────────────────────────────────────────────

test(
  'Fed: 403 credit_edit_role_required on all three writes, 200 on the read',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 3, expiresAt: LOT_FAR });
    const fed = staffApp(FIXTURE_STAFF_PRINCIPAL);

    const answers = [
      await adjust(fed, addBody()),
      await adjust(fed, removeBody(lotId)),
      await moveLot(fed, lotId, { expires_at: LOT_FAR, note: 'moved' }),
    ];

    for (const res of answers) {
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(errorCode(res), 'credit_edit_role_required');
    }
    assert.equal((await rowsOfLot(lotId)).length, 1, 'nothing written');
    assert.equal(await poolBalance(), 3);
    assert.deepEqual(await editsOf(lotId), []);

    const readable = await read(fed);
    assert.equal(readable.statusCode, 200, readable.body);
    const pool = (readable.json() as StaffOwnerCreditsWire).pools.find(
      (p) => p.location === 'bentonville' && p.mode === 'school',
    );
    assert.equal(pool?.balance, 3, 'he reads the ledger he cannot change');
  },
);

test('an owner principal is 403 on the read and on all three writes', SKIP_WHEN_NO_DB, async () => {
  const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
  const app = staffApp(FIXTURE_OWNER_PRINCIPAL);
  for (const res of [
    await read(app),
    await adjust(app, addBody()),
    await adjust(app, removeBody(lotId)),
    await moveLot(app, lotId, { expires_at: LOT_FAR, note: 'moved' }),
  ]) {
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(errorCode(res), 'forbidden');
  }
});

test(
  'the role list edited to drop a role binds the next write, with no restart',
  SKIP_WHEN_NO_DB,
  async () => {
    const shanti = makeContractApp(FIXTURE_OWNER_ROLE_PRINCIPAL);
    registerStaffSettingsRoute(shanti.app, { authenticate: shanti.authenticate });
    const amber = staffApp();
    const editList = async (roles: string[]) => {
      const res = await shanti.app.inject({
        method: 'PATCH',
        url: '/staff/settings/staff',
        headers: { 'idempotency-key': `roles-${randomUUID()}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ credit_hand_edit_roles: roles }),
      });
      assert.equal(res.statusCode, 200, res.body);
    };

    assert.equal((await adjust(amber, addBody())).statusCode, 201);
    await editList(['owner']);
    const dropped = await adjust(amber, addBody());
    assert.equal(dropped.statusCode, 403, dropped.body);
    assert.equal(errorCode(dropped), 'credit_edit_role_required');
    await editList(['owner', 'manager', 'trainer']);
    assert.equal((await adjust(staffApp(FIXTURE_STAFF_PRINCIPAL), addBody())).statusCode, 201);
  },
);

test('the owner role passes when the list omits it', SKIP_WHEN_NO_DB, async () => {
  await db.update(staffSettings).set({ creditHandEditRoles: ['manager'] });
  const lotId = await plantLot({ credits: 3, expiresAt: LOT_FAR });
  const shanti = staffApp(FIXTURE_OWNER_ROLE_PRINCIPAL);
  assert.equal((await adjust(shanti, addBody())).statusCode, 201);
  assert.equal((await adjust(shanti, removeBody(lotId))).statusCode, 201);
  assert.equal(
    (await moveLot(shanti, lotId, { expires_at: LOT_FAR, note: 'moved' })).statusCode,
    200,
  );
});

test('the catalog PATCH, the fourth door, reads the same list', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffCreditPackagesRoute(app, { authenticate, now: () => CLOCK });
  const res = await app.inject({
    method: 'PATCH',
    url: '/staff/credit-packages/single-day-school-bentonville',
    headers: { 'idempotency-key': `cat-${randomUUID()}` },
    payload: { expiry_months: 2 },
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(errorCode(res), 'credit_edit_role_required');
});

// ── Add ──────────────────────────────────────────────────────────────────────

test(
  'add: the lot, the balance and the GET agree, with expiry, staffer and note',
  SKIP_WHEN_NO_DB,
  async () => {
    const res = await adjust(staffApp(), addBody());
    assert.equal(res.statusCode, 201, res.body);
    const pool = res.json() as StaffCreditPoolWire;
    assert.equal(pool.location, POOL.location);
    assert.equal(pool.mode, POOL.mode);
    assert.equal(pool.tier, POOL.tier);
    assert.equal(pool.balance, 2);
    assert.equal(pool.lots.length, 1);
    const lot = pool.lots[0] as CreditLotDetailWire;
    assert.deepEqual(
      { ...lot, id: 'x', granted_at: 'x' },
      {
        id: 'x',
        reason: 'adjustment',
        granted: 2,
        remaining: 2,
        granted_at: 'x',
        expires_at: ONE_MONTH_ON,
        live: true,
        note: 'goodwill after the storm closure',
        created_by_staff_id: FIXTURE_IDS.staffAmberId,
        last_expiry_edit: null,
        booked_ahead: { count: 0, dates: [] },
      },
    );

    const [row] = await db.select().from(creditLedger).where(eq(creditLedger.id, lot.id));
    assert.equal(row?.ownerId, OWNER);
    assert.equal(row?.dogId, null, 'a grant names no dog');
    assert.equal(row?.delta, 2);
    assert.equal(row?.lotId, null);
    assert.equal(row?.createdByStaffId, FIXTURE_IDS.staffAmberId);
    assert.equal(await poolBalance(), 2);
    assert.deepEqual(await poolOf(), pool);
  },
);

test('add: there is no count cap, the role list is the limit', SKIP_WHEN_NO_DB, async () => {
  const res = await adjust(staffApp(), addBody({ credits: 5000 }));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as StaffCreditPoolWire).balance, 5000);
});

test('add takes the pool lock like every other write on the pool', SKIP_WHEN_NO_DB, async () => {
  await withGate(async (gate) => {
    await holdPool(gate);
    const answer = adjust(staffApp(), addBody());
    await waitForBlockedBackends(1);
    assert.equal(await poolBalance(), 0, 'nothing is written under the lock');
    await gate.query('COMMIT');
    assert.equal((await answer).statusCode, 201);
  });
  assert.equal(await poolBalance(), 2);
});

test(
  'the PATCH takes the pool lock, so a booking mid-pick never has a lot move under it',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
    await withGate(async (gate) => {
      await holdPool(gate);
      const answer = moveLot(staffApp(), lotId, { expires_at: LOT_FAR, note: 'moved' });
      await waitForBlockedBackends(1);
      assert.deepEqual(await editsOf(lotId), [], 'nothing is written under the lock');
      await gate.query('COMMIT');
      assert.equal((await answer).statusCode, 200);
    });
  },
);

test('add: expires_at, when sent, is the lot`s date', SKIP_WHEN_NO_DB, async () => {
  const res = await adjust(staffApp(), addBody({ expires_at: '2038-02-03T04:05:06-06:00' }));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as StaffCreditPoolWire).lots[0]?.expires_at, '2038-02-03T10:05:06.000Z');
});

test(
  'add: the default is cred.manual_grant_expiry_months, read at the verb',
  SKIP_WHEN_NO_DB,
  async () => {
    await db.update(creditSettings).set({ manualGrantExpiryMonths: 3 });
    const res = await adjust(staffApp(), addBody());
    assert.equal(res.statusCode, 201, res.body);
    // 09:40 CDT on 19 Oct is 09:40 CST on 19 Jan.
    assert.equal(
      (res.json() as StaffCreditPoolWire).lots[0]?.expires_at,
      '2038-01-19T15:40:00.000Z',
    );
  },
);

test(
  'add: expires_at not later than now is 422 expiry_not_in_future, nothing written',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const expires_at of [IN_THE_PAST, CLOCK.toISOString()]) {
      const res = await adjust(staffApp(), addBody({ expires_at }));
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(errorCode(res), 'expiry_not_in_future');
    }
    assert.equal(await poolOf(), undefined, 'no lot');
  },
);

test(
  'add: a campus and program no package row sells is 422 pool_not_bookable',
  SKIP_WHEN_NO_DB,
  async () => {
    const res = await adjust(
      staffApp(),
      addBody({ location: 'fayetteville', mode: 'daycare', tier: 'regular' }),
    );
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(errorCode(res), 'pool_not_bookable');
  },
);

test('add: the alumni tier needs an alumni dog on the account', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createBookableDog(createdDogs);
  const alumni = addBody({ location: 'fayetteville', tier: 'alumni' });
  const refused = await adjust(staffApp(), alumni);
  assert.equal(refused.statusCode, 422, refused.body);
  assert.equal(errorCode(refused), 'pool_not_bookable');

  await db.update(dogs).set({ isAlumni: true }).where(eq(dogs.id, dogId));
  const res = await adjust(staffApp(), alumni);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as StaffCreditPoolWire).tier, 'alumni');
  await db.update(dogs).set({ isAlumni: false }).where(eq(dogs.id, dogId));
});

test('an unknown owner is 404 on the read and on a write', SKIP_WHEN_NO_DB, async () => {
  const stranger = randomUUID();
  const reading = await read(staffApp(), stranger);
  assert.equal(reading.statusCode, 404, reading.body);
  assert.equal(errorCode(reading), 'not_found');
  const writing = await adjust(staffApp(), addBody(), undefined, stranger);
  assert.equal(writing.statusCode, 404, writing.body);
  assert.equal(errorCode(writing), 'not_found');
});

test(
  'a body off the wire is 400: no note, a blank note, no credits, an unknown key',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
    for (const body of [
      addBody({ note: undefined }),
      addBody({ note: '' }),
      addBody({ note: 'x'.repeat(501) }),
      addBody({ credits: 0 }),
      addBody({ credits: 1.5 }),
      addBody({ dog_id: FIXTURE_IDS.dog1Id }),
      { ...removeBody(lotId), expires_at: LOT_FAR },
    ]) {
      assert.equal((await adjust(staffApp(), body)).statusCode, 400, JSON.stringify(body));
    }
    const noted = await moveLot(staffApp(), lotId, { expires_at: LOT_FAR });
    assert.equal(noted.statusCode, 400, noted.body);
  },
);

// ── Remove ───────────────────────────────────────────────────────────────────

test(
  'remove: one adjustment row, on the lot, with the staffer and the note',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 3, expiresAt: LOT_FAR });
    const res = await adjust(staffApp(), removeBody(lotId, 2));
    assert.equal(res.statusCode, 201, res.body);
    const pool = res.json() as StaffCreditPoolWire;
    assert.equal(pool.balance, 1);
    assert.equal(pool.lots[0]?.remaining, 1);

    const rows = (await rowsOfLot(lotId)).filter((r) => r.id !== lotId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.delta, -2);
    assert.equal(rows[0]?.reason, 'adjustment');
    assert.equal(rows[0]?.ownerId, OWNER);
    assert.equal(rows[0]?.note, 'entered twice');
    assert.equal(rows[0]?.createdByStaffId, FIXTURE_IDS.staffAmberId);
  },
);

test(
  'remove above the lot`s unspent is 422 lot_insufficient and writes nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 3, expiresAt: LOT_FAR });
    const booked = await book(bookingApp(), dogId, ['2037-10-14']);
    assert.equal(booked.statusCode, 201, booked.body);
    const before = (await rowsOfLot(lotId)).length;

    const res = await adjust(staffApp(), removeBody(lotId, 3));

    assert.equal(res.statusCode, 422, res.body);
    assert.equal(errorCode(res), 'lot_insufficient');
    assert.equal((await rowsOfLot(lotId)).length, before, 'no row');
    assert.equal(await poolBalance(), 2);

    assert.equal(
      (await adjust(staffApp(), removeBody(lotId, 2))).statusCode,
      201,
      'exactly its unspent',
    );
    assert.equal(await poolBalance(), 0);
  },
);

test('remove reaches a lot past its date, whether or not it is live', SKIP_WHEN_NO_DB, async () => {
  const lotId = await plantLot({ credits: 2, expiresAt: REAL_YESTERDAY() });
  const res = await adjust(staffApp(), removeBody(lotId));
  assert.equal(res.statusCode, 201, res.body);
  const pool = res.json() as StaffCreditPoolWire;
  assert.equal(pool.balance, 0);
  assert.equal(pool.lots[0]?.remaining, 1);
  assert.equal(pool.lots[0]?.live, false);
});

test(
  'a lot that is not this owner`s is the generic 404 on the remove',
  SKIP_WHEN_NO_DB,
  async () => {
    const stranger = await otherOwner();
    const theirs = await lotOfOther(stranger);
    const unknown = await adjust(staffApp(), removeBody(randomUUID()));
    const res = await adjust(staffApp(), removeBody(theirs));

    assert.equal(unknown.statusCode, 404, unknown.body);
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(errorCode(res), 'not_found');
    assert.equal(
      res.body,
      unknown.body.replace(/lot [0-9a-f-]+/, `lot ${theirs}`),
      'nothing tells them apart',
    );
    assert.equal((await rowsOfLot(theirs)).length, 1, 'nothing written');
  },
);

test(
  'a row that is no grant is the generic 404 on the remove and on the PATCH',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 2, expiresAt: LOT_FAR });
    assert.equal((await book(bookingApp(), dogId, ['2037-10-14'])).statusCode, 201);
    const [debit] = (await rowsOfLot(lotId)).filter((r) => r.id !== lotId);
    assert.ok(debit);

    const removing = await adjust(staffApp(), removeBody(debit.id));
    const moving = await moveLot(staffApp(), debit.id, { expires_at: LOT_FAR, note: 'moved' });
    const unknown = await moveLot(staffApp(), randomUUID(), { expires_at: LOT_FAR, note: 'moved' });

    for (const res of [removing, moving, unknown]) {
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(errorCode(res), 'not_found');
    }
  },
);

// ── The race (DECISIONS 174(h)) ──────────────────────────────────────────────

for (const first of ['booking', 'remove'] as const) {
  test(
    `remove and a booking race the last credit, ${first} first: one wins, the pool never goes negative`,
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await createBookableDog(createdDogs);
      const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
      const staff = staffApp();
      const owner = bookingApp();
      const sendBooking = () => book(owner, dogId, ['2037-10-14']);
      const sendRemove = () => adjust(staff, removeBody(lotId));

      await withGate(async (gate) => {
        await holdPool(gate);
        const a = first === 'booking' ? sendBooking() : sendRemove();
        await waitForBlockedBackends(1);
        const b = first === 'booking' ? sendRemove() : sendBooking();
        await waitForBlockedBackends(2);
        await gate.query('COMMIT');

        const [winner, loser] = await Promise.all([a, b]);
        assert.equal(winner.statusCode, 201, winner.body);
        assert.equal(loser.statusCode, 422, loser.body);
        assert.equal(
          errorCode(loser),
          first === 'booking' ? 'lot_insufficient' : 'insufficient_credits',
        );
      });

      assert.equal(await poolBalance(), 0);
      const family = await rowsOfLot(lotId);
      assert.equal(
        family.reduce((sum, r) => sum + r.delta, 0),
        0,
        'never negative',
      );
      assert.equal(family.length, 2, 'one grant, one spend');
    },
  );
}

test('two removes race one credit: one wins', SKIP_WHEN_NO_DB, async () => {
  const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
  await withGate(async (gate) => {
    await holdPool(gate);
    const answers = Promise.all([
      adjust(staffApp(), removeBody(lotId)),
      adjust(staffApp(), removeBody(lotId)),
    ]);
    await waitForBlockedBackends(2);
    await gate.query('COMMIT');
    assert.deepEqual((await answers).map((r) => r.statusCode).sort(), [201, 422]);
  });
  assert.equal(await poolBalance(), 0);
});

// ── A lot's date ─────────────────────────────────────────────────────────────

test(
  'moving an expired lot`s date makes it live and spendable: she books with it (CRED-62)',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    const stale = REAL_YESTERDAY();
    const lotId = await plantLot({ credits: 1, expiresAt: stale });
    const owner = bookingApp();

    const refused = await book(owner, dogId, ['2037-10-14']);
    assert.equal(refused.statusCode, 422, refused.body);
    assert.equal(errorCode(refused), 'insufficient_credits');

    const res = await moveLot(staffApp(), lotId, { expires_at: LOT_FAR, note: 'Shanthi agreed' });
    assert.equal(res.statusCode, 200, res.body);
    const lot = res.json() as CreditLotDetailWire;
    assert.equal(lot.id, lotId);
    assert.equal(lot.expires_at, LOT_FAR);
    assert.equal(lot.live, true);
    assert.equal(lot.last_expiry_edit?.to, LOT_FAR);
    assert.equal(lot.last_expiry_edit?.from, stale);
    assert.equal(lot.last_expiry_edit?.staff_id, FIXTURE_IDS.staffAmberId);
    assert.equal(lot.last_expiry_edit?.note, 'Shanthi agreed');

    const booked = await book(owner, dogId, ['2037-10-14']);
    assert.equal(booked.statusCode, 201, booked.body);
    const [debit] = (await rowsOfLot(lotId)).filter((r) => r.reason === 'booking-debit');
    assert.equal(debit?.delta, -1, 'the moved lot paid');
    assert.equal(await poolBalance(), 0);
  },
);

test(
  'the PATCH refuses a date not later than now, and writes nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
    for (const expires_at of [IN_THE_PAST, CLOCK.toISOString()]) {
      const res = await moveLot(staffApp(), lotId, { expires_at, note: 'moved' });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(errorCode(res), 'expiry_not_in_future');
    }
    assert.deepEqual(await editsOf(lotId), []);
    assert.equal((await rowsOfLot(lotId))[0]?.expiresAt?.slice(0, 4), '2038');
  },
);

test(
  'two concurrent PATCHes of one lot leave a history whose dates chain',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
    const first = '2038-07-01T00:00:00.000Z';
    const second = '2038-08-01T00:00:00.000Z';
    await withGate(async (gate) => {
      await holdPool(gate);
      const a = moveLot(staffApp(), lotId, { expires_at: first, note: 'one' });
      await waitForBlockedBackends(1);
      const b = moveLot(staffApp(), lotId, { expires_at: second, note: 'two' });
      await waitForBlockedBackends(2);
      await gate.query('COMMIT');
      assert.equal((await a).statusCode, 200);
      assert.equal((await b).statusCode, 200);
    });

    const edits = await editsOf(lotId);
    assert.deepEqual(
      edits.map((e) => [
        new Date(e.fromExpiresAt).toISOString(),
        new Date(e.toExpiresAt).toISOString(),
      ]),
      [
        [LOT_FAR, first],
        [first, second],
      ],
    );
  },
);

test(
  'the edit`s `from` is what its row lock read, not what stood before it waited',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
    const moved = '2038-07-01T00:00:00.000Z';
    await withGate(async (gate) => {
      await gate.query('UPDATE credit_ledger SET expires_at = $1 WHERE id = $2', [moved, lotId]);
      const answer = moveLot(staffApp(), lotId, { expires_at: LOT_FAR, note: 'back' });
      await waitForBlockedBackends(1);
      await gate.query('COMMIT');
      assert.equal((await answer).statusCode, 200);
    });
    const [edit] = await editsOf(lotId);
    assert.equal(new Date(edit?.fromExpiresAt as string).toISOString(), moved);
  },
);

test(
  'a date move does not hold a debit on that lot: its row lock is NO KEY UPDATE (155(a))',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 2, expiresAt: LOT_FAR });
    await withGate(async (gate) => {
      // Stops the PATCH at its INSERT, holding its row lock on the lot.
      await gate.query('LOCK TABLE credit_lot_expiry_edits IN ACCESS EXCLUSIVE MODE');
      const answer = moveLot(staffApp(), lotId, { expires_at: LOT_FAR, note: 'moved' });
      await waitForBlockedBackends(1);

      // A debit's FK check takes KEY SHARE on the lot, which FOR UPDATE would block.
      const debit = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await debit.connect();
      try {
        await debit.query(`SET statement_timeout = 3000`);
        await debit.query(
          `INSERT INTO credit_ledger (owner_id, location, mode, tier, delta, reason, lot_id, note)
         VALUES ($1, $2, $3, $4, -1, 'adjustment', $5, 'held?')`,
          [OWNER, POOL.location, POOL.mode, POOL.tier, lotId],
        );
      } finally {
        await debit.end();
      }
      await gate.query('COMMIT');
      assert.equal((await answer).statusCode, 200);
    });
  },
);

// ── The read ─────────────────────────────────────────────────────────────────

test(
  'GET: every lot, newest first, spent and expired included, each as the wire says',
  SKIP_WHEN_NO_DB,
  async () => {
    const old = await plantLot({ credits: 2, expiresAt: REAL_YESTERDAY() });
    await db
      .update(creditLedger)
      .set({ createdAt: '2026-01-01T00:00:00Z' })
      .where(eq(creditLedger.id, old));
    const spent = await plantLot({ credits: 1, expiresAt: LOT_FAR });
    await db
      .update(creditLedger)
      .set({ createdAt: '2026-02-01T00:00:00Z' })
      .where(eq(creditLedger.id, spent));
    await adjust(staffApp(), removeBody(spent));
    const [pack] = await db
      .select({ id: creditPackages.id })
      .from(creditPackages)
      .where(eq(creditPackages.key, 'school-2x-weekly-bentonville'));
    const chargeId = randomUUID();
    await db.insert(charges).values({
      id: chargeId,
      ownerId: OWNER,
      amountCents: 45_600,
      status: 'succeeded',
      purpose: 'package',
    });
    const bought = await db
      .insert(creditLedger)
      .values({
        ownerId: OWNER,
        ...POOL,
        delta: 8,
        reason: 'purchase',
        packageId: pack?.id,
        chargeId,
        expiresAt: LOT_FAR,
      })
      .returning({ id: creditLedger.id });
    const returned = await db
      .insert(creditLedger)
      .values({
        ownerId: OWNER,
        ...POOL,
        delta: 1,
        reason: 'cancel-refund',
        expiresAt: LOT_FAR,
        createdAt: '2026-03-01T00:00:00Z',
      })
      .returning({ id: creditLedger.id });

    const pool = await poolOf();
    assert.deepEqual(
      pool?.lots.map((lot) => lot.id),
      [bought[0]?.id, returned[0]?.id, spent, old],
      'newest first',
    );
    assert.equal(pool?.balance, 9, 'the live balance, as the owner reads it');
    const byId = new Map(pool?.lots.map((lot) => [lot.id, lot]));
    const expired = byId.get(old);
    assert.equal(expired?.live, false);
    assert.equal(expired?.remaining, 2);
    assert.equal(expired?.granted_at, '2026-01-01T00:00:00.000Z');
    assert.equal('package_id' in (expired ?? {}), false, 'omitted on a lot no purchase made');
    assert.equal('note' in (expired ?? {}), true);
    assert.equal(byId.get(spent)?.remaining, 0);
    const purchase = byId.get(bought[0]?.id as string);
    assert.equal(purchase?.reason, 'purchase');
    assert.equal(purchase?.package_id, pack?.id);
    assert.equal(purchase?.charge_id, chargeId);
    assert.equal('note' in (purchase ?? {}), false, 'omitted on a lot no staffer wrote');
    assert.equal('created_by_staff_id' in (purchase ?? {}), false);
    // D2 (6.0.0-lg5.1): a lot written as `cancel-refund` before P20 reads as the one
    // return label every writer now uses.
    assert.equal(byId.get(returned[0]?.id as string)?.reason, 'settlement-return');
    await db.delete(creditLedger).where(eq(creditLedger.chargeId, chargeId));
  },
);

test(
  'GET: booked_ahead names the lot`s debits on upcoming days, one date a debit, ascending',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    const second = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 5, expiresAt: LOT_FAR });
    const owner = bookingApp();
    const res = await owner.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `ahead-${randomUUID()}` },
      payload: {
        category: 'day-school',
        lead_dog_id: dogId,
        additional_dog_ids: [second],
        dates: ['2037-10-15', '2037-10-14'],
        location: 'bentonville',
        payment: { kind: 'credits' },
      },
    });
    assert.equal(res.statusCode, 201, res.body);

    // Both days ahead, then a day gone by, then a cancelled row: only what is coming counts.
    const staffAtClock = staffApp(
      FIXTURE_MANAGER_PRINCIPAL,
      () => new Date('2037-10-15T03:00:00Z'),
    );
    const seen = await read(staffAtClock);
    const lot = (seen.json() as StaffOwnerCreditsWire).pools
      .flatMap((pool) => pool.lots)
      .find((l) => l.id === lotId);
    assert.deepEqual(lot?.booked_ahead, {
      count: 4,
      dates: ['2037-10-14', '2037-10-14', '2037-10-15', '2037-10-15'],
    });

    const past = await read(
      staffApp(FIXTURE_MANAGER_PRINCIPAL, () => new Date('2037-10-15T12:00:00Z')),
    );
    const later = (past.json() as StaffOwnerCreditsWire).pools
      .flatMap((pool) => pool.lots)
      .find((l) => l.id === lotId);
    assert.deepEqual(later?.booked_ahead, {
      count: 2,
      dates: ['2037-10-15', '2037-10-15'],
    });

    await db
      .update(bookings)
      .set({ status: 'cancelled' })
      .where(inArray(bookings.leadDogId, [dogId]));
    const none = await read(staffApp(FIXTURE_MANAGER_PRINCIPAL, BOOKING_CLOCK));
    assert.deepEqual(
      (none.json() as StaffOwnerCreditsWire).pools
        .flatMap((pool) => pool.lots)
        .find((l) => l.id === lotId)?.booked_ahead,
      { count: 0, dates: [] },
    );
  },
);

/** One lot as `GET /staff/owners/:id/credits` reads it at `now`. */
async function lotAt(lotId: string, now: () => Date): Promise<CreditLotDetailWire | undefined> {
  const res = await read(staffApp(FIXTURE_MANAGER_PRINCIPAL, now));
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as StaffOwnerCreditsWire).pools
    .flatMap((pool) => pool.lots)
    .find((l) => l.id === lotId);
}

/** Two dogs on these dates, paid in credits, through `POST /bookings`: the session of each date. */
async function bookTwo(
  owner: ReturnType<typeof bookingApp>,
  dogIds: readonly [string, string],
  dates: readonly string[],
): Promise<Map<string, BookingWire>> {
  const res = await owner.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `ahead-${randomUUID()}` },
    payload: {
      category: 'day-school',
      lead_dog_id: dogIds[0],
      additional_dog_ids: [dogIds[1]],
      dates,
      location: 'bentonville',
      payment: { kind: 'credits' },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const { sessions } = res.json() as PostBookingsResponse;
  // `date` is the session's instant: its day is the Chicago one.
  return new Map(sessions.map((s) => [bucketChicagoToday(new Date(s.date)), s]));
}

/** Each dog's `booking-debit` on one session, and the lot it drew from. */
async function debitLots(bookingId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ dogId: creditLedger.dogId, lotId: creditLedger.lotId })
    .from(creditLedger)
    .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'booking-debit')));
  return new Map(rows.map((r) => [r.dogId as string, r.lotId as string]));
}

async function statusOf(bookingId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, bookingId));
  return row?.status;
}

test(
  'GET: booked_ahead, one dog of two cancelled alone: the day is named once, for the dog who stays',
  SKIP_WHEN_NO_DB,
  async () => {
    // Biscuit and Mochi on Tue 20 and Wed 21 Oct, both from one lot. The owner cancels
    // Biscuit alone on the 20th: the session stays upcoming for Mochi, Biscuit's debit
    // stays and a return brings her credit back to the lot.
    const biscuit = await createBookableDog(createdDogs);
    const mochi = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 5, expiresAt: LOT_FAR });
    const owner = bookingApp();
    const sessions = await bookTwo(owner, [biscuit, mochi], ['2037-10-20', '2037-10-21']);
    const tuesday = sessions.get('2037-10-20');
    assert.ok(tuesday !== undefined, 'a session on the 20th');

    const res = await ownerDogCancel(owner, { bookingId: tuesday.id, dogId: biscuit });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as BookingWire).status, 'upcoming', 'Mochi still comes');
    assert.equal(await statusOf(tuesday.id), 'upcoming');

    const lot = await lotAt(lotId, BOOKING_CLOCK);
    assert.equal(lot?.remaining, 2, 'three credits out: Mochi on the 20th, both on the 21st');
    assert.deepEqual(lot?.booked_ahead, {
      count: 3,
      dates: ['2037-10-20', '2037-10-21', '2037-10-21'],
    });
  },
);

test(
  'GET: booked_ahead, a lot whose only debit on a day came back reads that day nowhere, while the session stays',
  SKIP_WHEN_NO_DB,
  async () => {
    // A two-dog household on Thu 22 Oct, each dog paid from her own lot: the one-credit lot
    // is the soonest to expire, so it pays one dog and the other lot pays the other. The
    // owner cancels the dog the small lot paid: that lot's one debit on the 22nd came back,
    // and the session stays upcoming for the other dog.
    const first = await createBookableDog(createdDogs);
    const second = await createBookableDog(createdDogs);
    const small = await plantLot({ credits: 1, expiresAt: '2038-01-01T00:00:00.000Z' });
    const large = await plantLot({ credits: 3, expiresAt: LOT_FAR });
    const owner = bookingApp();
    const thursday = (await bookTwo(owner, [first, second], ['2037-10-22'])).get('2037-10-22');
    assert.ok(thursday !== undefined, 'a session on the 22nd');
    const paidBy = await debitLots(thursday.id);
    assert.deepEqual(
      new Set(paidBy.values()),
      new Set([small, large]),
      'each dog drew from her own lot',
    );
    const leaving = [...paidBy].find(([, lot]) => lot === small)?.[0] as string;

    const res = await ownerDogCancel(owner, { bookingId: thursday.id, dogId: leaving });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await statusOf(thursday.id), 'upcoming', 'the other dog still comes');

    const smallLot = await lotAt(small, BOOKING_CLOCK);
    assert.equal(smallLot?.remaining, 1, 'its credit came back');
    assert.deepEqual(smallLot?.booked_ahead, { count: 0, dates: [] });
    assert.deepEqual((await lotAt(large, BOOKING_CLOCK))?.booked_ahead, {
      count: 1,
      dates: ['2037-10-22'],
    });
  },
);

test(
  'GET: booked_ahead, a turn-away leaves the session upcoming and its day leaves the lot, dog by dog',
  SKIP_WHEN_NO_DB,
  async () => {
    // Fri 23 Oct, two dogs from one lot. At 07:35 the door turns one away: her credit comes
    // back (`day.sent_home_before_training_return_fraction` 1), and no verb writes the
    // booking's status, so the session reads `upcoming` while the day is still today.
    const day = '2037-10-23';
    const one = await createBookableDog(createdDogs);
    const two = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 5, expiresAt: LOT_FAR });
    const friday = (await bookTwo(bookingApp(), [one, two], [day])).get(day);
    assert.ok(friday !== undefined, 'a session on the 23rd');
    const board = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(day, '07:35')));
    const morning = (): Date => at(day, '09:00');
    assert.deepEqual((await lotAt(lotId, morning))?.booked_ahead, {
      count: 2,
      dates: [day, day],
    });

    const away = await verb(board, { bookingId: friday.id, dogId: one, verb: 'turn-away' });
    assert.equal(away.statusCode, 200, away.body);
    assert.equal(await statusOf(friday.id), 'upcoming', 'a turn-away writes no status');
    const afterOne = await lotAt(lotId, morning);
    assert.equal(afterOne?.remaining, 4, 'her credit came back');
    assert.deepEqual(afterOne?.booked_ahead, { count: 1, dates: [day] });

    const both = await verb(board, { bookingId: friday.id, dogId: two, verb: 'turn-away' });
    assert.equal(both.statusCode, 200, both.body);
    assert.equal(await statusOf(friday.id), 'upcoming', 'with every dog turned away, too');
    const afterTwo = await lotAt(lotId, morning);
    assert.equal(afterTwo?.remaining, 5);
    assert.deepEqual(afterTwo?.booked_ahead, { count: 0, dates: [] });
  },
);

test(
  'GET: last_expiry_edit is the newest edit, and null until the date has moved',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
    assert.equal((await poolOf())?.lots[0]?.last_expiry_edit, null);
    const first = '2038-07-01T00:00:00.000Z';
    const second = '2038-08-01T00:00:00.000Z';
    await moveLot(staffApp(), lotId, { expires_at: first, note: 'one' });
    await moveLot(staffApp(), lotId, { expires_at: second, note: 'two' });

    const edit = (await poolOf())?.lots[0]?.last_expiry_edit;
    assert.equal(edit?.from, first);
    assert.equal(edit?.to, second);
    assert.equal(edit?.note, 'two');
    assert.equal(edit?.staff_id, FIXTURE_IDS.staffAmberId);
    assert.match(edit?.at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
  },
);

test(
  'GET: expiry_enforced is the live switch, and off a past lot reads live',
  SKIP_WHEN_NO_DB,
  async () => {
    await plantLot({ credits: 2, expiresAt: REAL_YESTERDAY() });
    assert.equal(((await read(staffApp())).json() as StaffOwnerCreditsWire).expiry_enforced, true);
    await db.update(creditSettings).set({ expiryEnforcedEnabled: false });
    const body = (await read(staffApp())).json() as StaffOwnerCreditsWire;
    assert.equal(body.expiry_enforced, false);
    const pool = body.pools.find((p) => p.location === 'bentonville' && p.mode === 'school');
    assert.equal(pool?.lots[0]?.live, true);
    assert.equal(pool?.balance, 2);
  },
);

test(
  'GET: pools order by location, program, then regular before alumni; none is []',
  SKIP_WHEN_NO_DB,
  async () => {
    const stranger = await otherOwner();
    assert.deepEqual((await read(staffApp(), stranger)).json(), {
      owner_id: stranger,
      expiry_enforced: true,
      pools: [],
    });

    for (const [location, mode, tier] of [
      ['fayetteville', 'school', 'alumni'],
      ['fayetteville', 'school', 'regular'],
      ['bentonville', 'school', 'regular'],
      ['bentonville', 'daycare', 'regular'],
    ] as const) {
      await db.insert(creditLedger).values({
        ownerId: stranger,
        location,
        mode,
        tier,
        delta: 1,
        reason: 'purchase',
        expiresAt: LOT_FAR,
      });
    }
    const body = (await read(staffApp(), stranger)).json() as StaffOwnerCreditsWire;
    assert.deepEqual(
      body.pools.map((p) => [p.location, p.mode, p.tier]),
      [
        ['bentonville', 'daycare', 'regular'],
        ['bentonville', 'school', 'regular'],
        ['fayetteville', 'school', 'regular'],
        ['fayetteville', 'school', 'alumni'],
      ],
    );
  },
);

// ── Idempotency, and what she reads next ─────────────────────────────────────

test(
  'add, replayed under its key: one lot, the stored answer, even past its own date',
  SKIP_WHEN_NO_DB,
  async () => {
    const key = `adj-replay-${randomUUID()}`;
    const body = addBody({ expires_at: '2037-10-20T00:00:00.000Z' });
    const first = await adjust(staffApp(), body, key);
    assert.equal(first.statusCode, 201, first.body);

    const later = staffApp(FIXTURE_MANAGER_PRINCIPAL, () => new Date('2037-10-25T00:00:00Z'));
    const replay = await adjust(later, body, key);

    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), first.json());
    const lots = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.reason, 'adjustment'), eq(creditLedger.note, addBody().note)));
    assert.equal(lots.length, 1, 'one lot');
  },
);

test('remove, replayed under its key: one row, the stored answer', SKIP_WHEN_NO_DB, async () => {
  const lotId = await plantLot({ credits: 3, expiresAt: LOT_FAR });
  const key = `rem-replay-${randomUUID()}`;
  const body = removeBody(lotId);
  const first = await adjust(staffApp(), body, key);
  assert.equal(first.statusCode, 201, first.body);
  const replay = await adjust(staffApp(), body, key);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json(), first.json());
  assert.equal(await poolBalance(), 2, 'one credit went');
});

test(
  'a PATCH, replayed under its key: one edit, the stored answer, even past its own date',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
    const key = `lot-replay-${randomUUID()}`;
    const body = { expires_at: '2037-10-20T00:00:00.000Z', note: 'moved' };
    const first = await moveLot(staffApp(), lotId, body, key);
    assert.equal(first.statusCode, 200, first.body);

    const later = staffApp(FIXTURE_MANAGER_PRINCIPAL, () => new Date('2037-10-25T00:00:00Z'));
    const replay = await moveLot(later, lotId, body, key);

    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json());
    assert.equal((await editsOf(lotId)).length, 1, 'one edit');
  },
);

test(
  'a key reused with another body is 422 idempotency_mismatch, on each write',
  SKIP_WHEN_NO_DB,
  async () => {
    const lotId = await plantLot({ credits: 3, expiresAt: LOT_FAR });
    const key = `adj-mismatch-${randomUUID()}`;
    assert.equal((await adjust(staffApp(), removeBody(lotId), key)).statusCode, 201);
    const other = await adjust(staffApp(), removeBody(lotId, 2), key);
    assert.equal(other.statusCode, 422, other.body);
    assert.equal(errorCode(other), 'idempotency_mismatch');

    const lotKey = `lot-mismatch-${randomUUID()}`;
    await moveLot(staffApp(), lotId, { expires_at: LOT_FAR, note: 'one' }, lotKey);
    const again = await moveLot(staffApp(), lotId, { expires_at: LOT_FAR, note: 'two' }, lotKey);
    assert.equal(again.statusCode, 422, again.body);
    assert.equal(errorCode(again), 'idempotency_mismatch');
  },
);

test('each write needs an Idempotency-Key', SKIP_WHEN_NO_DB, async () => {
  const lotId = await plantLot({ credits: 1, expiresAt: LOT_FAR });
  const app = staffApp();
  const add = await app.inject({
    method: 'POST',
    url: `/staff/owners/${OWNER}/credit-adjustments`,
    payload: addBody(),
  });
  assert.equal(add.statusCode, 400, add.body);
  const move = await app.inject({
    method: 'PATCH',
    url: `/staff/credit-lots/${lotId}`,
    payload: { expires_at: LOT_FAR, note: 'moved' },
  });
  assert.equal(move.statusCode, 400, move.body);
});

test('each write wipes her cached credits: her next read is fresh', SKIP_WHEN_NO_DB, async () => {
  const { app: ownerApp, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerCreditsRoute(ownerApp, { authenticate });
  const balance = async (): Promise<number | undefined> => {
    const res = await ownerApp.inject({ method: 'GET', url: '/credits?location=bentonville' });
    assert.equal(res.statusCode, 200, res.body);
    const { pools } = res.json() as { pools: { mode: string; balance: number }[] };
    return pools.find((pool) => pool.mode === 'school')?.balance;
  };
  await invalidatePattern(creditsInvalidationPattern(OWNER));
  assert.equal(await balance(), undefined, 'read once, so the empty pool is cached');

  const added = await adjust(staffApp(), addBody({ expires_at: LOT_FAR }));
  assert.equal(await balance(), 2, 'the add');

  const lotId = (added.json() as StaffCreditPoolWire).lots[0]?.id as string;
  await adjust(staffApp(), removeBody(lotId));
  assert.equal(await balance(), 1, 'the remove');

  await db
    .update(creditLedger)
    .set({ expiresAt: REAL_YESTERDAY() })
    .where(eq(creditLedger.id, lotId));
  await invalidatePattern(creditsInvalidationPattern(OWNER));
  assert.equal(await balance(), undefined, 'expired, and cached so');
  await moveLot(staffApp(), lotId, { expires_at: LOT_FAR, note: 'moved' });
  assert.equal(await balance(), 1, 'the date move');
});
