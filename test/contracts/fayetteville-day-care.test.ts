import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  CreditPackageWire,
  CreditsShortDetails,
  InsufficientCapacityDetails,
  OwnerSettingsWire,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { bookings, dayProgramSettings } from '../../src/db/schema/schema.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { registerAvailabilityRoute } from '../../src/routes/availability.js';
import { registerBookingOrdersRoute } from '../../src/routes/bookingOrders.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerSettingsRoute } from '../../src/routes/settings.js';
import {
  D,
  buy,
  check,
  checkThenPost,
  clearOrderWorld,
  ledgerPlan,
  memoryThrottle,
  orderApp,
  part,
  post,
  refused,
  rowCounts,
} from './_bookingOrderFixture.js';
import {
  createAlumniDog,
  createBookableDog,
  createFundedDog,
  removeDogs,
  restoreDaySeeds,
} from './_dayFixture.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { plantLot, poolBalance } from './_poolFixture.js';
import { seededOfferings } from './_seedOfferings.js';

/**
 * Her bug #40 (plan one-off O-BUGS3): "fayetteville does offer day care" (DECISIONS 677 (1)),
 * and her "default" to its three questions (702 (3), 704): Fayetteville day care sold as
 * Bentonville's ($350.00 for 10, $35.00 a single day); the campus's 15 daily places shared
 * with day school (one count per campus, `day_program_settings.daily_capacity_dogs`); alumni
 * credits Bentonville-only (553 (b)). The seed and M5.34 turn it on; nothing in the booking
 * code is per campus, so these read the routes on the seed as it stands.
 */

registerFixtureHooks();
const created: string[] = [];
afterEach(async () => {
  await clearOrderWorld();
  await removeDogs(created.splice(0));
  await db.execute(sql`DELETE FROM day_capacity WHERE location = 'fayetteville'`);
  await invalidatePattern('avail:fayetteville:*');
  await restoreDaySeeds();
  await setFayettevilleDayCare(seededOfferings().fayetteville['day-care']!);
});
after(async () => {
  await clearOrderWorld();
  await removeDogs(created);
});

/** A lot that pays every November and December 2037 day the order clock reaches. */
const ENDS_31_DEC = '2037-12-31T18:00:00.000Z';

const fayCare = (args: { credits: number; tier?: 'regular' | 'alumni' }) =>
  plantLot({
    credits: args.credits,
    expiresAt: ENDS_31_DEC,
    location: 'fayetteville',
    mode: 'daycare',
    tier: args.tier ?? 'regular',
  });

const fayCareBalance = (tier: 'regular' | 'alumni' = 'regular') =>
  poolBalance({ location: 'fayetteville', mode: 'daycare', tier });
const bentonCareBalance = (tier: 'regular' | 'alumni' = 'regular') =>
  poolBalance({ location: 'bentonville', mode: 'daycare', tier });

async function spentCents(): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT coalesce(sum(amount_cents), 0)::int AS cents FROM charges
     WHERE owner_id = ${FIXTURE_IDS.ownerId} AND status = 'succeeded'`);
  return (rows[0] as { cents: number }).cents;
}

/** Fayetteville's `day-care` entry alone, so the other services stay as this run left them. */
async function setFayettevilleDayCare(entry: object): Promise<void> {
  await db
    .update(dayProgramSettings)
    .set({
      offerings: sql`jsonb_set(${dayProgramSettings.offerings}, '{day-care}', ${JSON.stringify(entry)}::jsonb)`,
    })
    .where(eq(dayProgramSettings.location, 'fayetteville'));
}

const fayCarePart = (dogs: readonly string[], dates: readonly string[]) =>
  part({ category: 'day-care', location: 'fayetteville', dogs, dates });

// ── Offered, sold and spent ────────────────────────────────────────────────────

test(
  '#40: Fayetteville day care is offered and shown in GET /settings, and the shop lists its 10-pack at $350.00 and its single day at $35.00, Bentonville’s prices, with no alumni row there',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerSettingsRoute(app, { authenticate });
    registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });

    const settings = (
      await app.inject({ method: 'GET', url: '/settings' })
    ).json<OwnerSettingsWire>();
    assert.deepEqual(
      [
        settings.offerings.fayetteville['day-care'].offered,
        settings.offerings.fayetteville['day-care'].client_visible,
      ],
      [true, true],
    );

    const shop = async (location: 'fayetteville' | 'bentonville') => {
      const res = await app.inject({ method: 'GET', url: `/credit-packages?location=${location}` });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json() as CreditPackageWire[]).filter((row) => row.mode === 'daycare');
    };
    const fayetteville = await shop('fayetteville');
    assert.deepEqual(fayetteville, [
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
      },
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
      },
    ]);
    // As Bentonville's regular day care rows, row for row, but for the campus.
    const asBentonville = (await shop('bentonville'))
      .filter((row) => row.tier === 'regular')
      .map((row) => [
        row.credits,
        row.price_cents,
        row.single_day,
        row.is_popular,
        row.expiry_months,
      ]);
    assert.deepEqual(
      fayetteville.map((row) => [
        row.credits,
        row.price_cents,
        row.single_day,
        row.is_popular,
        row.expiry_months,
      ]),
      asBentonville,
    );
  },
);

test(
  '#40: an order for Lola at Fayetteville day care books, spending a Fayetteville day care credit bought on the shop (2 single days, $70.00): one booking there, one debit from that pool (check = POST)',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    const o = orderApp();
    await buy(o, 'single-day-daycare-fayetteville', 2);
    assert.equal(await spentCents(), 7000, 'two single days at $35.00');
    assert.equal(await fayCareBalance(), 2, 'the purchase lands in the Fayetteville day care pool');

    const res = await checkThenPost(o.app, { parts: [fayCarePart([lola], [D.MON])] });
    assert.equal(res.statusCode, 201, res.body);
    const plan = (res.json() as { plan: unknown[] }).plan;
    assert.deepEqual(plan, [
      { dog_id: lola, location: 'fayetteville', mode: 'daycare', tier: 'regular', count: 1 },
    ]);
    const booked = await db
      .select({ id: bookings.id, category: bookings.category, location: bookings.location })
      .from(bookings)
      .where(eq(bookings.leadDogId, lola));
    assert.deepEqual(
      booked.map((b) => [b.category, b.location]),
      [['day-care', 'fayetteville']],
    );
    assert.deepEqual(await ledgerPlan(booked.map((b) => b.id)), [
      { dog_id: lola, location: 'fayetteville', mode: 'daycare', tier: 'regular', count: 1 },
    ]);
    assert.equal(await fayCareBalance(), 1);
  },
);

// ── One count of 15 places ─────────────────────────────────────────────────────

const WEDNESDAY = '2026-06-17';

function capacityApp() {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerAvailabilityRoute(app, { authenticate });
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });
  registerBookingOrdersRoute(app, { authenticate, now: FIXTURE_NOW, throttle: memoryThrottle() });
  return app;
}

async function remaining(app: ReturnType<typeof capacityApp>): Promise<[number, number]> {
  const res = await app.inject({
    method: 'GET',
    url: `/availability?from=${WEDNESDAY}&to=${WEDNESDAY}&location=fayetteville`,
  });
  assert.equal(res.statusCode, 200, res.body);
  const [row] = res.json() as Array<{ capacity_dogs: number; remaining_dogs: number }>;
  return [row!.capacity_dogs, row!.remaining_dogs];
}

test(
  '#40: Fayetteville’s 15 daily places are one count: 14 day-school dogs and 1 day-care dog fill Wed 17 Jun, and the 16th of either program is 422 insufficient_capacity on both routes',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = capacityApp();
    const bookOld = (dogId: string, category: 'day-school' | 'day-care') =>
      app.inject({
        method: 'POST',
        url: '/bookings',
        headers: { 'idempotency-key': `cap-${randomUUID()}` },
        payload: {
          category,
          lead_dog_id: dogId,
          dates: [WEDNESDAY],
          location: 'fayetteville',
          payment: { kind: 'credits' },
        },
      });

    for (let i = 0; i < 14; i += 1) {
      const res = await bookOld(await createFundedDog(created, 1), 'day-school');
      assert.equal(res.statusCode, 201, `day-school dog ${i + 1}: ${res.body}`);
    }
    assert.deepEqual(await remaining(app), [15, 1]);

    const fifteenth = await post(app, {
      parts: [fayCarePart([await createFundedDog(created, 1)], [WEDNESDAY])],
    });
    assert.equal(fifteenth.statusCode, 201, fifteenth.body);
    assert.deepEqual(await remaining(app), [15, 0]);

    for (const category of ['day-school', 'day-care'] as const) {
      const dogId = await createFundedDog(created, 1);
      const old = await bookOld(dogId, category);
      const gap = refused<InsufficientCapacityDetails>(old, 'insufficient_capacity');
      assert.deepEqual(
        [gap.location, gap.date, gap.openings_remaining, gap.requested],
        ['fayetteville', WEDNESDAY, 0, 1],
        `POST /bookings, ${category}`,
      );
      const order = await post(app, {
        parts: [part({ category, location: 'fayetteville', dogs: [dogId], dates: [WEDNESDAY] })],
      });
      const orderGap = refused<InsufficientCapacityDetails>(order, 'insufficient_capacity');
      assert.deepEqual(
        [orderGap.location, orderGap.date, orderGap.requested],
        ['fayetteville', WEDNESDAY, 1],
        `POST /booking-orders, ${category}`,
      );
    }
    assert.deepEqual(await remaining(app), [15, 0]);
  },
);

// ── Alumni credits stay at Bentonville ─────────────────────────────────────────

test(
  '#40: Waffles (alumni) at Fayetteville day care: his household’s 10 Bentonville alumni credits do not pay it. With no Fayetteville day care credit the order is credits_short on the Fayetteville regular pool (not alumni_credits_short, nothing written); with one, it books on that regular credit and the alumni 10 stay',
  SKIP_WHEN_NO_DB,
  async () => {
    const waffles = await createAlumniDog(created);
    await plantLot({
      credits: 10,
      expiresAt: ENDS_31_DEC,
      location: 'bentonville',
      mode: 'daycare',
      tier: 'alumni',
    });
    const { app } = orderApp();
    const order = { parts: [fayCarePart([waffles], [D.MON])] };

    const before = await rowCounts();
    const short = refused<CreditsShortDetails>(await checkThenPost(app, order), 'credits_short');
    assert.deepEqual(short, {
      kind: 'credits_short',
      pools: [
        {
          location: 'fayetteville',
          mode: 'daycare',
          tier: 'regular',
          balance: 0,
          required: 1,
          shortfall: 1,
          dog_ids: [waffles],
          short_dates: [{ date: D.MON, dog_id: waffles, reason: 'no_credit' }],
        },
      ],
      draws: [
        { location: 'fayetteville', mode: 'daycare', tier: 'regular', balance: 0, draw: 0, short: 1 },
        { location: 'fayetteville', mode: 'daycare', tier: 'alumni', balance: 0, draw: 0, short: 0 },
      ],
    });
    assert.deepEqual(await rowCounts(), before, 'nothing written');
    assert.equal(await bentonCareBalance('alumni'), 10);

    await fayCare({ credits: 1 });
    const res = await checkThenPost(app, order);
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual((res.json() as { plan: unknown[] }).plan, [
      { dog_id: waffles, location: 'fayetteville', mode: 'daycare', tier: 'regular', count: 1 },
    ]);
    assert.deepEqual(
      [
        await bentonCareBalance('alumni'),
        await fayCareBalance('regular'),
        await fayCareBalance('alumni'),
      ],
      [10, 0, 0],
      'the Bentonville alumni credits untouched; the Fayetteville regular one spent',
    );
  },
);

// ── `program_not_offered` no longer answers ─────────────────────────────────────

test(
  '#40: `program_not_offered` no longer answers for Fayetteville day care: POST /bookings books it (201) and the order check finds it bookable; the rule stands: switched off in settings, both answer it again and nothing more is booked',
  SKIP_WHEN_NO_DB,
  async () => {
    const funded = await createFundedDog(created);
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });
    registerBookingOrdersRoute(app, { authenticate, now: FIXTURE_NOW, throttle: memoryThrottle() });
    const bookOld = (date: string) =>
      app.inject({
        method: 'POST',
        url: '/bookings',
        headers: { 'idempotency-key': `offered-${randomUUID()}` },
        payload: {
          category: 'day-care',
          location: 'fayetteville',
          lead_dog_id: funded,
          dates: [date],
          payment: { kind: 'credits' },
        },
      });
    const order = { parts: [fayCarePart([funded], ['2026-06-18'])] };
    const fayettevilleRows = async () =>
      (
        await db
          .select({ id: bookings.id })
          .from(bookings)
          .where(and(eq(bookings.leadDogId, funded), inArray(bookings.location, ['fayetteville'])))
      ).length;

    const old = await bookOld('2026-06-16');
    assert.equal(old.statusCode, 201, old.body);
    const checked = await check(app, order);
    assert.equal(checked.statusCode, 200, checked.body);
    assert.equal((checked.json() as { bookable: boolean }).bookable, true);

    await setFayettevilleDayCare({
      ...seededOfferings().fayetteville['day-care']!,
      offered: false,
      client_visible: false,
    });
    refused(await bookOld('2026-06-17'), 'program_not_offered');
    refused(await check(app, order), 'program_not_offered');
    refused(await post(app, order), 'program_not_offered');
    assert.equal(await fayettevilleRows(), 1, 'only the first, offered, day was booked');
  },
);
