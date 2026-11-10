import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq, like } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { creditLedger, creditSettings } from '../../src/db/schema/schema.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { FIXTURE_IDS, FIXTURE_LOT_EXPIRES_AT } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { redis } from '../../src/redis.js';
import type { OwnerCreditsWire } from '../../src/contracts/wire.js';
import type { Principal } from '../../src/auth/principal.js';

/**
 * `GET /credits?location=` (CRED-U10, CRED-U33; design §1.1:957-961): the owner's pools at
 * one campus. No balance is a dog's, so the route names none.
 */

registerFixtureHooks();

const NOTE = 'credits-read-test';
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(async () => {
  await db.delete(creditLedger).where(like(creditLedger.note, `${NOTE}%`));
  await db.update(creditSettings).set({ expiryEnforcedEnabled: true });
  await redis.flushdb();
});

function read(url: string, principal: Principal = FIXTURE_OWNER_PRINCIPAL) {
  const { app, authenticate } = makeContractApp(principal);
  registerCreditsRoute(app, { authenticate });
  return app.inject({ method: 'GET', url });
}

async function plantLot(args: {
  location?: 'fayetteville' | 'bentonville';
  mode?: 'school' | 'daycare';
  tier?: 'regular' | 'alumni';
  credits: number;
  expiresAt: Date | string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(creditLedger).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    location: args.location ?? 'fayetteville',
    mode: args.mode ?? 'school',
    tier: args.tier ?? 'regular',
    delta: args.credits,
    reason: 'adjustment',
    expiresAt: typeof args.expiresAt === 'string' ? args.expiresAt : args.expiresAt.toISOString(),
    note: NOTE,
  });
  return id;
}

test("GET /credits answers the owner's pool at the campus asked about", SKIP_WHEN_NO_DB, async () => {
  const res = await read('/credits?location=fayetteville');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepStrictEqual(res.json(), {
    location: 'fayetteville',
    pools: [
      {
        mode: 'school',
        tier: 'regular',
        balance: 4,
        lots: [{ remaining: 4, expires_at: FIXTURE_LOT_EXPIRES_AT }],
        expiring_lots: [],
      },
    ],
  });
});

test('GET /credits is campus-scoped: the other campus is another pool', SKIP_WHEN_NO_DB, async () => {
  const res = await read('/credits?location=bentonville');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as OwnerCreditsWire;
  assert.equal(body.location, 'bentonville');
  assert.deepEqual(
    body.pools.map((p) => [p.mode, p.tier, p.balance]),
    [['daycare', 'regular', 2]],
  );
});

test('GET /credits without a location is 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const res = await read('/credits');
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'bad_request');
});

test('GET /credits as staff is 403 forbidden: there is no id to read', SKIP_WHEN_NO_DB, async () => {
  const res = await read('/credits?location=fayetteville', FIXTURE_STAFF_PRINCIPAL);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'forbidden');
});

test(
  'pools order by program, then regular before alumni, and lots soonest-expiring first',
  SKIP_WHEN_NO_DB,
  async () => {
    const soon = new Date(Date.now() + 100 * DAY_MS);
    const later = new Date(Date.now() + 200 * DAY_MS);
    await plantLot({ location: 'bentonville', tier: 'alumni', credits: 1, expiresAt: later });
    await plantLot({ location: 'bentonville', credits: 2, expiresAt: later });
    await plantLot({ location: 'bentonville', credits: 3, expiresAt: soon });

    const body = (await read('/credits?location=bentonville')).json() as OwnerCreditsWire;
    assert.deepEqual(
      body.pools.map((p) => [p.mode, p.tier, p.balance]),
      [
        ['school', 'regular', 5],
        ['school', 'alumni', 1],
        ['daycare', 'regular', 2],
      ],
    );
    assert.deepEqual(body.pools[0]?.lots, [
      { remaining: 3, expires_at: soon.toISOString() },
      { remaining: 2, expires_at: later.toISOString() },
    ]);
  },
);

test('a lot stamped yesterday counts nowhere', SKIP_WHEN_NO_DB, async () => {
  await plantLot({
    location: 'bentonville',
    tier: 'alumni',
    credits: 3,
    expiresAt: new Date(Date.now() - DAY_MS),
  });
  const body = (await read('/credits?location=bentonville')).json() as OwnerCreditsWire;
  assert.equal(body.pools.find((p) => p.tier === 'alumni'), undefined);
});

test(
  'expiring_lots are the lots within the longest lead: seven days at the seed',
  SKIP_WHEN_NO_DB,
  async () => {
    const inside = new Date(Date.now() + 6 * DAY_MS);
    await plantLot({ location: 'bentonville', credits: 1, expiresAt: inside });
    await plantLot({
      location: 'bentonville',
      credits: 2,
      expiresAt: new Date(Date.now() + 8 * DAY_MS),
    });

    const body = (await read('/credits?location=bentonville')).json() as OwnerCreditsWire;
    const school = body.pools.find((p) => p.mode === 'school');
    assert.equal(school?.balance, 3);
    assert.deepEqual(school?.expiring_lots, [
      { mode: 'school', remaining: 1, expires_at: inside.toISOString() },
    ]);
  },
);

test(
  'with expiry off a lot past its date is live and in `lots`, and is never in expiring_lots',
  SKIP_WHEN_NO_DB,
  async () => {
    await db.update(creditSettings).set({ expiryEnforcedEnabled: false });
    const past = new Date(Date.now() - DAY_MS);
    await plantLot({ location: 'bentonville', credits: 3, expiresAt: past });

    const body = (await read('/credits?location=bentonville')).json() as OwnerCreditsWire;
    const school = body.pools.find((p) => p.mode === 'school');
    assert.equal(school?.balance, 3);
    assert.deepEqual(school?.lots, [{ remaining: 3, expires_at: past.toISOString() }]);
    assert.deepEqual(school?.expiring_lots, []);
  },
);

// Last: it deletes the fixture's Bentonville row, which the tests above read.
test('an owner with no live credit reads pools: [], the zero sentinel', SKIP_WHEN_NO_DB, async () => {
  await db
    .delete(creditLedger)
    .where(
      and(eq(creditLedger.ownerId, FIXTURE_IDS.ownerId), eq(creditLedger.location, 'bentonville')),
    );
  const res = await read('/credits?location=bentonville');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepStrictEqual(res.json(), { location: 'bentonville', pools: [] });
});
