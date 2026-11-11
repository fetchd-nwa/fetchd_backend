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
  'expiring_lots counts the lead in Chicago calendar days, across fall-back (Sun 1 Nov 2026, 02:00 CDT → 01:00 CST)',
  SKIP_WHEN_NO_DB,
  async () => {
    // `lot_is_live` reads Postgres's clock, and these dates are behind it, so expiry is off:
    // the lots stay live, and expiring_lots reads their dates on the injected clock.
    await db.update(creditSettings).set({ expiryEnforcedEnabled: false });
    // 10:00 CDT Sat 31 Oct. The seed's lead is 7 days, so the window is every lot whose
    // Chicago date is 31 Oct to Sat 7 Nov, as P31's scan counts it (design §S42, CRED-U13):
    // "Chicago expiry date minus today's Chicago date". 7 × 24 h from now is 09:00 CST on the
    // 7th, an hour short of the wall clock, because the 1st has 25 hours.
    const now = new Date('2026-10-31T15:00:00.000Z');
    const morning = '2026-11-07T15:30:00.000Z'; // 09:30 CST Sat 7 Nov: day 7, inside
    const night = '2026-11-08T05:30:00.000Z'; // 23:30 CST Sat 7 Nov: day 7, inside
    const sunday = '2026-11-08T06:30:00.000Z'; // 00:30 CST Sun 8 Nov: day 8, outside
    await plantLot({ location: 'bentonville', credits: 1, expiresAt: morning });
    await plantLot({ location: 'bentonville', credits: 2, expiresAt: night });
    await plantLot({ location: 'bentonville', credits: 4, expiresAt: sunday });

    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate, now: () => now });
    const res = await app.inject({ method: 'GET', url: '/credits?location=bentonville' });
    assert.equal(res.statusCode, 200, res.body);
    const school = (res.json() as OwnerCreditsWire).pools.find((p) => p.mode === 'school');
    assert.deepEqual(school?.expiring_lots, [
      { mode: 'school', remaining: 1, expires_at: morning },
      { mode: 'school', remaining: 2, expires_at: night },
    ]);
  },
);

test(
  "expiring_lots reads today in Chicago, not UTC: at 23:30 CDT Sat 31 Oct, already 1 Nov in UTC, the window still ends Sat 7 Nov (Opus L3)",
  SKIP_WHEN_NO_DB,
  async () => {
    // The same three lots as above, at an hour where the two calendars disagree. Read in
    // UTC, today would be 1 Nov and the window would reach Sun 8 Nov, listing the 00:30 lot.
    await db.update(creditSettings).set({ expiryEnforcedEnabled: false });
    const now = new Date('2026-11-01T04:30:00.000Z'); // 23:30 CDT Sat 31 Oct
    const morning = '2026-11-07T15:30:00.000Z'; // 09:30 CST Sat 7 Nov: day 7, inside
    const night = '2026-11-08T05:30:00.000Z'; // 23:30 CST Sat 7 Nov: day 7, inside
    const sunday = '2026-11-08T06:30:00.000Z'; // 00:30 CST Sun 8 Nov: day 8, outside
    await plantLot({ location: 'bentonville', credits: 1, expiresAt: morning });
    await plantLot({ location: 'bentonville', credits: 2, expiresAt: night });
    await plantLot({ location: 'bentonville', credits: 4, expiresAt: sunday });

    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate, now: () => now });
    const res = await app.inject({ method: 'GET', url: '/credits?location=bentonville' });
    assert.equal(res.statusCode, 200, res.body);
    const school = (res.json() as OwnerCreditsWire).pools.find((p) => p.mode === 'school');
    assert.deepEqual(school?.expiring_lots, [
      { mode: 'school', remaining: 1, expires_at: morning },
      { mode: 'school', remaining: 2, expires_at: night },
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
