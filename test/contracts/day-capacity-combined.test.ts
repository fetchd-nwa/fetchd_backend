import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dayCapacityRepository } from '../../src/db/repositories/dayCapacityRepository.js';
import { bookingDogs, bookings, dogs } from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import type { ApiError } from '../../src/lib/errors.js';
import { registerAvailabilityRoute } from '../../src/routes/availability.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  createBookableDog,
  createFundedDog,
  removeDogs,
  restoreDaySeeds,
  setCampusSettings,
  type Campus,
} from './_dayFixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * P13 B2 (DAY-U05, rulings (g), (h)): one seat count, not two. Day school and
 * daycare share one cap per campus per date, the cap is read from the campus's
 * settings, and a weekday opens because it is ticked in `open_weekdays_list`.
 */

registerFixtureHooks();

const createdDogIds: string[] = [];
afterEach(async () => {
  await removeDogs(createdDogIds.splice(0));
  await db.execute(sql`DELETE FROM day_capacity WHERE date >= '2026-06-01'`);
  await invalidatePattern('avail:bentonville:*');
  await restoreDaySeeds();
});

/** A row written behind the routes' back, so the read cache has to be told. */
async function writeOverride(query: ReturnType<typeof sql>): Promise<void> {
  await db.execute(query);
  await invalidatePattern('avail:bentonville:*');
}

function app(): ReturnType<typeof makeContractApp>['app'] {
  const { app: built, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerAvailabilityRoute(built, { authenticate });
  registerBookingsRoute(built, { authenticate, now: FIXTURE_NOW });
  return built;
}

type App = ReturnType<typeof app>;

async function book(
  built: App,
  dogId: string,
  category: 'day-school' | 'day-care',
  date: string,
  location: Campus = 'bentonville',
): Promise<{ statusCode: number; body: string }> {
  const res = await built.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `cap-${randomUUID()}` },
    payload: { category, lead_dog_id: dogId, dates: [date], location },
  });
  return { statusCode: res.statusCode, body: res.body };
}

async function day(
  built: App,
  date: string,
  location: Campus = 'bentonville',
): Promise<{ capacity_dogs: number; remaining_dogs: number; date: string; location: string }> {
  const res = await built.inject({
    method: 'GET',
    url: `/availability?from=${date}&to=${date}&location=${location}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  const rows = res.json() as Array<{
    capacity_dogs: number;
    remaining_dogs: number;
    date: string;
    location: string;
  }>;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

const WEDNESDAY = '2026-06-17';
const SATURDAY = '2026-06-20';
const SUNDAY = '2026-06-21';

test(
  '15 seats, 14 day-school dogs: one daycare dog fits, then the next of either program is 422 with no mode',
  SKIP_WHEN_NO_DB,
  async () => {
    const built = app();
    for (let i = 0; i < 14; i += 1) {
      const dogId = await createFundedDog(createdDogIds, 1);
      const res = await book(built, dogId, 'day-school', WEDNESDAY);
      assert.equal(res.statusCode, 201, `day-school dog ${i + 1}: ${res.body}`);
    }
    assert.deepEqual(await day(built, WEDNESDAY), {
      location: 'bentonville',
      date: WEDNESDAY,
      capacity_dogs: 15,
      remaining_dogs: 1,
    });

    const lastSeat = await book(
      built,
      await createFundedDog(createdDogIds, 1),
      'day-care',
      WEDNESDAY,
    );
    assert.equal(lastSeat.statusCode, 201, lastSeat.body);
    assert.equal((await day(built, WEDNESDAY)).remaining_dogs, 0);

    for (const category of ['day-school', 'day-care'] as const) {
      const refused = await book(
        built,
        await createFundedDog(createdDogIds, 1),
        category,
        WEDNESDAY,
      );
      assert.equal(refused.statusCode, 422, refused.body);
      const { error } = JSON.parse(refused.body) as {
        error: { code: string; message: string; details: Record<string, unknown> };
      };
      assert.equal(error.code, 'insufficient_capacity');
      assert.deepEqual(error.details, {
        kind: 'insufficient_capacity',
        location: 'bentonville',
        date: WEDNESDAY,
        openings_remaining: 0,
        requested: 1,
      });
      assert.doesNotMatch(error.message, /Day School|Day Care/, 'the message names no program');
    }
  },
);

test('a Saturday is 0 until a day row opens it', SKIP_WHEN_NO_DB, async () => {
  const built = app();
  assert.equal((await day(built, SATURDAY)).capacity_dogs, 0);
  const closed = await book(built, await createFundedDog(createdDogIds, 2), 'day-school', SATURDAY);
  assert.equal(closed.statusCode, 422, closed.body);
  assert.match(closed.body, /insufficient_capacity/);

  await writeOverride(
    sql`INSERT INTO day_capacity (location, date, capacity_dogs) VALUES ('bentonville', ${SATURDAY}, 4)`,
  );
  assert.deepEqual(await day(built, SATURDAY), {
    location: 'bentonville',
    date: SATURDAY,
    capacity_dogs: 4,
    remaining_dogs: 4,
  });
  const open = await book(built, await createFundedDog(createdDogIds, 2), 'day-school', SATURDAY);
  assert.equal(open.statusCode, 201, open.body);
});

test(
  'ticking Saturday in open_weekdays_list opens it, at that campus only',
  SKIP_WHEN_NO_DB,
  async () => {
    const built = app();
    await setCampusSettings('bentonville', { openWeekdaysList: [1, 2, 3, 4, 5, 6] });
    assert.equal((await day(built, SATURDAY)).capacity_dogs, 15);
    assert.equal((await day(built, SATURDAY, 'fayetteville')).capacity_dogs, 0);
    const res = await book(built, await createFundedDog(createdDogIds, 2), 'day-school', SATURDAY);
    assert.equal(res.statusCode, 201, res.body);
  },
);

test('Sunday is ISO 7, not the 0 of getUTCDay', SKIP_WHEN_NO_DB, async () => {
  const built = app();
  assert.equal((await day(built, SUNDAY)).capacity_dogs, 0);
  await setCampusSettings('bentonville', { openWeekdaysList: [7] });
  assert.equal((await day(built, SUNDAY)).capacity_dogs, 15, 'Sunday is ticked');
  assert.equal((await day(built, '2026-06-15')).capacity_dogs, 0, 'Monday is not');
  const res = await book(built, await createFundedDog(createdDogIds, 2), 'day-school', SUNDAY);
  assert.equal(res.statusCode, 201, res.body);
});

test('the campus cap moves with the setting: no release', SKIP_WHEN_NO_DB, async () => {
  const built = app();
  await setCampusSettings('bentonville', { dailyCapacityDogs: 1 });
  assert.equal((await day(built, WEDNESDAY)).capacity_dogs, 1);
  assert.equal((await day(built, WEDNESDAY, 'fayetteville')).capacity_dogs, 15);
  const first = await book(built, await createFundedDog(createdDogIds, 2), 'day-school', WEDNESDAY);
  assert.equal(first.statusCode, 201, first.body);
  const second = await book(built, await createFundedDog(createdDogIds, 2), 'day-care', WEDNESDAY);
  assert.equal(second.statusCode, 422, second.body);
});

test(
  'a live override of 0 closes an open weekday; a soft-expired one does not',
  SKIP_WHEN_NO_DB,
  async () => {
    const built = app();
    assert.equal((await day(built, WEDNESDAY)).capacity_dogs, 15);
    await writeOverride(
      sql`INSERT INTO day_capacity (location, date, capacity_dogs) VALUES ('bentonville', ${WEDNESDAY}, 0)`,
    );
    assert.equal((await day(built, WEDNESDAY)).capacity_dogs, 0);
    const res = await book(built, await createFundedDog(createdDogIds, 2), 'day-school', WEDNESDAY);
    assert.equal(res.statusCode, 422, res.body);

    await writeOverride(
      sql`UPDATE day_capacity SET expired_at = now() WHERE location = 'bentonville' AND date = ${WEDNESDAY}`,
    );
    const after = await book(
      built,
      await createFundedDog(createdDogIds, 2),
      'day-school',
      WEDNESDAY,
    );
    assert.equal(after.statusCode, 201, after.body);
  },
);

/**
 * The COUPLING note on `dayCapacityRepository`: the two counts spell their date axis
 * differently, so they are compared by the rows they see. Every row below is a shape
 * one predicate could keep and the other drop.
 */
test('the read and the write count the same rows, whatever the row', SKIP_WHEN_NO_DB, async () => {
  const DATE = '2026-06-24';
  const ids: string[] = [];
  const dog = async (): Promise<string> => createBookableDog(createdDogIds);
  const insert = async (values: {
    dogIds: string[];
    category?: 'day-school' | 'day-care' | 'private-lesson' | 'evaluation';
    status?: 'upcoming' | 'cancelled';
    location?: Campus;
    date?: string;
    expiredAt?: string;
  }): Promise<string> => {
    const id = randomUUID();
    ids.push(id);
    await db.insert(bookings).values({
      id,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: values.dogIds[0] as string,
      category: values.category ?? 'day-school',
      status: values.status ?? 'upcoming',
      scheduledAt: `${values.date ?? DATE}T12:30:00Z`,
      location: values.location ?? 'bentonville',
      ...(values.expiredAt === undefined ? {} : { expiredAt: values.expiredAt }),
    });
    await db
      .insert(bookingDogs)
      .values(values.dogIds.map((dogId, i) => ({ bookingId: id, dogId, isLead: i === 0 })));
    return id;
  };

  // Counted: four dogs.
  await insert({ dogIds: [await dog()] });
  await insert({ dogIds: [await dog(), await dog()], category: 'day-care' });
  const partlyCancelled = await insert({ dogIds: [await dog(), await dog()] });
  const leftTheRoster = (
    await db
      .select({ dogId: bookingDogs.dogId })
      .from(bookingDogs)
      .where(and(eq(bookingDogs.bookingId, partlyCancelled), eq(bookingDogs.isLead, false)))
  )[0]?.dogId as string;
  await db
    .update(bookingDogs)
    .set({ expiredAt: '2026-05-01T12:00:00Z' })
    .where(and(eq(bookingDogs.bookingId, partlyCancelled), eq(bookingDogs.dogId, leftTheRoster)));

  // Not counted: a cancelled session, an expired one, another service, the other
  // campus, the next day, an evaluation (P10, P11), and a staff-owned dog.
  await insert({ dogIds: [await dog()], status: 'cancelled' });
  await insert({ dogIds: [await dog()], expiredAt: '2026-05-01T12:00:00Z' });
  await insert({ dogIds: [await dog()], category: 'private-lesson' });
  await insert({ dogIds: [await dog()], location: 'fayetteville' });
  await insert({ dogIds: [await dog()], date: '2026-06-25' });
  await insert({ dogIds: [await dog()], category: 'evaluation' });
  const staffDog = await dog();
  await db
    .update(dogs)
    .set({ ownerId: null, staffOwnerId: FIXTURE_IDS.staffDonavanId })
    .where(eq(dogs.id, staffDog));
  await insert({ dogIds: [staffDog] });

  const [read] = await dayCapacityRepository.findBookedCountsInRange('bentonville', DATE, DATE);
  assert.equal(read?.booked, 4, 'the read');

  const rule = { daily_capacity_dogs: 6, open_weekdays_list: [1, 2, 3, 4, 5] };
  await withActor('system:test', async (tx) => {
    await dayCapacityRepository.assertCapacityWithinLock(tx, {
      location: 'bentonville',
      date: DATE,
      rule,
      requestedCount: 2,
    });
    await assert.rejects(
      dayCapacityRepository.assertCapacityWithinLock(tx, {
        location: 'bentonville',
        date: DATE,
        rule,
        requestedCount: 3,
      }),
      (err: ApiError) => {
        assert.deepEqual(err.details, {
          kind: 'insufficient_capacity',
          location: 'bentonville',
          date: DATE,
          openings_remaining: 2,
          requested: 3,
        });
        return true;
      },
    );
  });

  await db
    .update(dogs)
    .set({ ownerId: FIXTURE_IDS.ownerId, staffOwnerId: null })
    .where(eq(dogs.id, staffDog));
  await db.delete(bookings).where(inArray(bookings.id, ids));
});
