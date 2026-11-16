import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type {
  AfterSchoolFullDetails,
  ApiErrorEnvelope,
  DayCapacityWire,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  dayCapacity,
  dayProgramSettings,
  dogs,
  orders,
} from '../../src/db/schema/schema.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { registerAvailabilityRoute } from '../../src/routes/availability.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffDayCapacityRoute } from '../../src/routes/staffDayCapacity.js';
import { at, createSession, removeSessions, type Campus } from './_checkinFixture.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { clearPlantedPools, plantLot } from './_poolFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * P48 (wire 6.2.0; her #8: "say like X/10 for each day so people know when booking or
 * grey it out if full", and 11-14: "i want the capacity shown for each day for the user to
 * see"): every `DayCapacityWire` of `GET /availability` carries the date's after-school
 * places, `day.after_school_capacity_count` for the campus (Fayetteville 10, Bentonville 5;
 * design §3.4), 0 on a date with no day school, and the places still free, counted by the
 * one function the booking's 422 `after_school_full` counts with (DAY-U43). Advisory: the
 * 422 stays the authority.
 *
 * The sessions are written straight to the tables, so the counted population is stated
 * outright; the parity tests book through `POST /bookings`. December 2026 holds no fixture
 * row, and every test clears what it wrote, because the count has no owner clause.
 */

registerFixtureHooks();
const createdDogs: string[] = [];
const sessions: string[] = [];
const overrides: { location: Campus; date: string }[] = [];
/** Dogs lent to staff for a test, given back first: the fixture's teardown wipes by owner. */
const staffDogs: string[] = [];
/** Campus offerings a test moved, put back as they were. */
const offeringsMoved: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const restore of offeringsMoved.splice(0)) await restore();
  for (const dogId of staffDogs.splice(0)) {
    await db
      .update(dogs)
      .set({ ownerId: FIXTURE_IDS.ownerId, staffOwnerId: null })
      .where(eq(dogs.id, dogId));
  }
  await removeSessions(sessions.splice(0));
  await clearOrderRows();
  await clearPlantedPools();
  await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
  for (const { location, date } of overrides.splice(0)) {
    await db
      .delete(dayCapacity)
      .where(and(eq(dayCapacity.location, location), eq(dayCapacity.date, date)));
    await invalidatePattern(`avail:${location}:*`);
  }
});
after(async () => {
  await removeDogs(createdDogs);
});

const WED = '2026-12-02';
const THU = '2026-12-03';
const FRI = '2026-12-04';
const SAT = '2026-12-05';
const MON = '2026-12-07';
const NOW = at('2026-12-01', '19:00');
const FAR = at('2030-01-01', '12:00');

function availabilityApp(): FastifyInstance {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerAvailabilityRoute(app, { authenticate });
  return app;
}

async function places(location: Campus, from: string, to = from): Promise<DayCapacityWire[]> {
  const res = await availabilityApp().inject({
    method: 'GET',
    url: `/availability?from=${from}&to=${to}&location=${location}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<DayCapacityWire[]>();
}

async function newDogs(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(await createBookableDog(createdDogs));
  return ids;
}

/** One session of `dogIds` on `date`, each staying for after-school unless `staying` is false. */
async function session(args: {
  dogIds: readonly string[];
  date: string;
  location?: Campus;
  category?: 'day-school' | 'day-care';
  status?: 'upcoming' | 'payment-pending';
  staying?: boolean;
}): Promise<string> {
  const { bookingId } = await createSession({
    dogIds: args.dogIds,
    date: args.date,
    location: args.location ?? 'bentonville',
    ...(args.category !== undefined ? { category: args.category } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ledger: sessions,
  });
  if (args.staying !== false) {
    await db
      .update(bookingDogs)
      .set({ afterSchool: true })
      .where(eq(bookingDogs.bookingId, bookingId));
  }
  return bookingId;
}

describe('the places, by campus and date', () => {
  test(
    'Fayetteville: ten staying Thu 3 Dec → after_school_capacity 10, after_school_remaining 0; three Fri → 10 / 7; none Wed → 10 / 10',
    SKIP_WHEN_NO_DB,
    async () => {
      await session({ dogIds: await newDogs(6), date: THU, location: 'fayetteville' });
      await session({ dogIds: await newDogs(4), date: THU, location: 'fayetteville' });
      await session({ dogIds: await newDogs(3), date: FRI, location: 'fayetteville' });
      assert.deepEqual(await places('fayetteville', WED, FRI), [
        {
          location: 'fayetteville',
          date: WED,
          capacity_dogs: 15,
          remaining_dogs: 15,
          after_school_capacity: 10,
          after_school_remaining: 10,
        },
        {
          location: 'fayetteville',
          date: THU,
          capacity_dogs: 15,
          remaining_dogs: 5,
          after_school_capacity: 10,
          after_school_remaining: 0,
        },
        {
          location: 'fayetteville',
          date: FRI,
          capacity_dogs: 15,
          remaining_dogs: 12,
          after_school_capacity: 10,
          after_school_remaining: 7,
        },
      ]);
    },
  );

  test(
    'Bentonville: five staying Thu → 5 / 0; the other campus is not counted',
    SKIP_WHEN_NO_DB,
    async () => {
      await session({ dogIds: await newDogs(5), date: THU });
      const [thu] = await places('bentonville', THU);
      assert.deepEqual(thu, {
        location: 'bentonville',
        date: THU,
        capacity_dogs: 15,
        remaining_dogs: 10,
        after_school_capacity: 5,
        after_school_remaining: 0,
      });
      const [fayThu] = await places('fayetteville', THU);
      assert.equal(
        fayThu?.after_school_remaining,
        10,
        "Bentonville's five hold no Fayetteville place",
      );
    },
  );

  test(
    'a closed date has no after-school: Saturday by the rule, and a Monday whose override is 0 though a dog stays → 0 / 0',
    SKIP_WHEN_NO_DB,
    async () => {
      await db.insert(dayCapacity).values({ location: 'bentonville', date: MON, capacityDogs: 0 });
      overrides.push({ location: 'bentonville', date: MON });
      await invalidatePattern('avail:bentonville:*');
      await session({ dogIds: await newDogs(1), date: MON });
      const byDate = new Map((await places('bentonville', SAT, MON)).map((d) => [d.date, d]));
      for (const date of [SAT, MON]) {
        const day = byDate.get(date);
        assert.equal(day?.capacity_dogs, 0, date);
        assert.equal(day?.after_school_capacity, 0, date);
        assert.equal(day?.after_school_remaining, 0, date);
      }
      assert.equal(byDate.get('2026-12-06')?.after_school_capacity, 0, 'Sunday too');
    },
  );
});

describe('what holds a place: the seat population, opted in', () => {
  test(
    'not counted: a share cancelled alone, a cancelled session, a day-care booking, a dog not staying and a staff-owned dog; two counted → Thu 5 / 3',
    SKIP_WHEN_NO_DB,
    async () => {
      // Counted: two dogs staying on one live day-school session.
      await session({ dogIds: await newDogs(2), date: THU });

      // A share cancelled alone, still flagged: her place is free (and her seat).
      const [stays, leftAlone] = await newDogs(2);
      const partly = await session({ dogIds: [stays!, leftAlone!], date: THU, staying: false });
      await db
        .update(bookingDogs)
        .set({ afterSchool: true, expiredAt: at(THU, '06:00').toISOString() })
        .where(and(eq(bookingDogs.bookingId, partly), eq(bookingDogs.dogId, leftAlone!)));

      // A cancelled session, its dog flagged.
      const cancelled = await session({ dogIds: await newDogs(1), date: THU });
      await db.execute(
        sql`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = ${cancelled}`,
      );

      // A day-care booking of three: three seats, no place (after-school rides day school).
      await session({ dogIds: await newDogs(3), date: THU, category: 'day-care', staying: false });

      // A staff-owned dog staying: capacity-exempt, as `remaining_dogs` counts her.
      const [staffDog] = await newDogs(1);
      staffDogs.push(staffDog!);
      await db
        .update(dogs)
        .set({ ownerId: null, staffOwnerId: FIXTURE_IDS.staffDonavanId })
        .where(eq(dogs.id, staffDog!));
      await session({ dogIds: [staffDog!], date: THU });

      const [thu] = await places('bentonville', THU);
      assert.deepEqual(thu, {
        location: 'bentonville',
        date: THU,
        capacity_dogs: 15,
        // Seats: the two staying, `stays`, the three day-care dogs.
        remaining_dogs: 9,
        after_school_capacity: 5,
        after_school_remaining: 3,
      });
    },
  );

  test(
    'a payment-pending session holds its places, as it holds its seats',
    SKIP_WHEN_NO_DB,
    async () => {
      await session({ dogIds: await newDogs(2), date: THU, status: 'payment-pending' });
      const [thu] = await places('bentonville', THU);
      assert.equal(thu?.after_school_remaining, 3);
      assert.equal(thu?.remaining_dogs, 13);
    },
  );

  test(
    'remaining floors at 0 when a date holds more than its places',
    SKIP_WHEN_NO_DB,
    async () => {
      await session({ dogIds: await newDogs(7), date: THU });
      const [thu] = await places('bentonville', THU);
      assert.equal(thu?.after_school_capacity, 5);
      assert.equal(thu?.after_school_remaining, 0);
    },
  );
});

describe("the count is the 422's count (one function, DAY-U43)", () => {
  function bookingApp(): FastifyInstance {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: () => NOW, stripe: makeStripeStub() });
    return app;
  }

  function book(app: FastifyInstance, dogIds: readonly string[], staying: readonly string[]) {
    const [lead, ...rest] = dogIds;
    return app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `p48-places-${randomUUID()}` },
      payload: {
        category: 'day-school',
        lead_dog_id: lead,
        ...(rest.length > 0 ? { additional_dog_ids: rest } : {}),
        dates: [THU],
        location: 'bentonville',
        payment: { kind: 'credits' },
        after_school: Object.fromEntries(staying.map((dogId) => [dogId, [THU]])),
      },
    });
  }

  function full(res: { statusCode: number; body: string }): AfterSchoolFullDetails {
    assert.equal(res.statusCode, 422, res.body);
    const { error } = JSON.parse(res.body) as ApiErrorEnvelope;
    assert.equal(error.code, 'after_school_full', res.body);
    return error.details as AfterSchoolFullDetails;
  }

  test(
    'four staying → remaining 1: two dogs ticking Thu → 422 {5, 4}, whose capacity − booked is that 1; one dog → 201; then remaining 0 and the next tick → 422 {5, 5}',
    SKIP_WHEN_NO_DB,
    async () => {
      const app = bookingApp();
      const four = await newDogs(4);
      await plantLot({ credits: 7, expiresAt: FAR });
      const first = await book(app, four, four);
      assert.equal(first.statusCode, 201, first.body);

      const [one] = await places('bentonville', THU);
      assert.equal(one?.after_school_remaining, 1);
      const [a, b] = await newDogs(2);
      const two = full(await book(app, [a!, b!], [a!, b!]));
      assert.deepEqual(two, { kind: 'after_school_full', date: THU, capacity: 5, booked: 4 });
      assert.equal(two.capacity - two.booked, one?.after_school_remaining, 'the read is the 422');

      const taken = await book(app, [a!], [a!]);
      assert.equal(taken.statusCode, 201, taken.body);
      const [none] = await places('bentonville', THU);
      assert.equal(none?.after_school_remaining, 0);
      const last = full(await book(app, [b!], [b!]));
      assert.deepEqual(last, { kind: 'after_school_full', date: THU, capacity: 5, booked: 5 });
      assert.equal(last.capacity - last.booked, none?.after_school_remaining);
    },
  );
});

describe('no day school, no after-school (build DECISIONS 428; wire: 0 when the campus does not offer day school)', () => {
  /** Switch day school off at a campus, as a settings edit would; `afterEach` puts it back. */
  async function dayCareOnly(location: Campus): Promise<void> {
    const [row] = await db
      .select({ offerings: dayProgramSettings.offerings })
      .from(dayProgramSettings)
      .where(eq(dayProgramSettings.location, location));
    const offerings = row!.offerings as Record<string, { offered: boolean }>;
    offeringsMoved.push(async () => {
      await db
        .update(dayProgramSettings)
        .set({ offerings })
        .where(eq(dayProgramSettings.location, location));
    });
    await db
      .update(dayProgramSettings)
      .set({
        offerings: { ...offerings, 'day-school': { ...offerings['day-school']!, offered: false } },
      })
      .where(eq(dayProgramSettings.location, location));
  }

  test(
    'Bentonville with day school off and day care on: Thu keeps its seats and offers 0 places, in GET /availability and in the staff PUT answer; Fayetteville is untouched',
    SKIP_WHEN_NO_DB,
    async () => {
      await session({ dogIds: await newDogs(1), date: THU, category: 'day-care', staying: false });
      await dayCareOnly('bentonville');

      const [thu] = await places('bentonville', THU);
      assert.deepEqual(thu, {
        location: 'bentonville',
        date: THU,
        capacity_dogs: 15,
        remaining_dogs: 14,
        after_school_capacity: 0,
        after_school_remaining: 0,
      });

      const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
      registerStaffDayCapacityRoute(app, { authenticate, now: () => NOW });
      overrides.push({ location: 'bentonville', date: THU });
      const put = await app.inject({
        method: 'PUT',
        url: `/staff/day-capacity/bentonville/${THU}`,
        headers: { 'idempotency-key': `p48-l2-${randomUUID()}` },
        payload: { capacity_dogs: 12 },
      });
      assert.equal(put.statusCode, 200, put.body);
      assert.deepEqual(put.json(), {
        location: 'bentonville',
        date: THU,
        capacity_dogs: 12,
        remaining_dogs: 11,
        after_school_capacity: 0,
        after_school_remaining: 0,
      });

      const [fay] = await places('fayetteville', THU);
      assert.equal(fay?.after_school_capacity, 10, 'the other campus still offers its places');
    },
  );
});
