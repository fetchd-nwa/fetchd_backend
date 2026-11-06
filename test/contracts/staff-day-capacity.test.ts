import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import pg from 'pg';
import type { Principal } from '../../src/auth/principal.js';
import { db } from '../../src/db/client.js';
import { auditLog, dayProgramSettings } from '../../src/db/schema/schema.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { registerAvailabilityRoute } from '../../src/routes/availability.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffDayCapacityRoute } from '../../src/routes/staffDayCapacity.js';
import { registerStaffSettingsRoute } from '../../src/routes/staffSettings.js';
import {
  createFundedDog,
  removeDogs,
  restoreDaySeeds,
  setCampusSettings,
  setGlobalSettings,
  type Campus,
} from './_dayFixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * P13 B5 (DAY-U07, DAY-67, ruling (i)): the per-date override and the one
 * cap-lowering check. Its four callers are `PUT`, `DELETE`, and a `PATCH
 * /staff/settings/day/:location` naming `daily_capacity_dogs` or
 * `open_weekdays_list`.
 *
 * The clock sits at Monday 5 Oct 2026, so the design's Fri 23 and Fri 30 are inside
 * the horizon, which ends on 5 Jan 2027.
 */

registerFixtureHooks();

const NOW = (): Date => new Date('2026-10-05T17:00:00Z');
const FRI_23 = '2026-10-23';
const FRI_30 = '2026-10-30';
const SAT_17 = '2026-10-17';
const WEEKDAYS_NO_FRIDAY = [1, 2, 3, 4];

const createdDogIds: string[] = [];
afterEach(async () => {
  await removeDogs(createdDogIds.splice(0));
  await db.execute(sql`DELETE FROM day_capacity WHERE date >= '2026-10-01'`);
  await invalidatePattern('avail:*');
  await restoreDaySeeds();
});

function staffApp(principal: Principal = FIXTURE_STAFF_PRINCIPAL): FastifyInstance {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffDayCapacityRoute(app, { authenticate, now: NOW });
  registerStaffSettingsRoute(app, { authenticate, now: NOW });
  registerAvailabilityRoute(app, { authenticate });
  return app;
}

function ownerApp(): FastifyInstance {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now: NOW });
  registerAvailabilityRoute(app, { authenticate });
  registerStaffDayCapacityRoute(app, { authenticate, now: NOW });
  return app;
}

type Answer = { statusCode: number; body: string; json: () => unknown };

async function put(
  app: FastifyInstance,
  location: string,
  date: string,
  payload: unknown,
  key: string = randomUUID(),
): Promise<Answer> {
  return app.inject({
    method: 'PUT',
    url: `/staff/day-capacity/${location}/${date}`,
    headers: { 'idempotency-key': key },
    payload: payload as Record<string, unknown>,
  });
}

async function del(
  app: FastifyInstance,
  location: string,
  date: string,
  key: string = randomUUID(),
): Promise<Answer> {
  return app.inject({
    method: 'DELETE',
    url: `/staff/day-capacity/${location}/${date}`,
    headers: { 'idempotency-key': key },
  });
}

async function patchDay(
  app: FastifyInstance,
  location: Campus,
  body: Record<string, unknown>,
): Promise<Answer> {
  return app.inject({
    method: 'PATCH',
    url: `/staff/settings/day/${location}`,
    headers: { 'idempotency-key': randomUUID() },
    payload: body,
  });
}

async function patchGlobal(app: FastifyInstance, body: Record<string, unknown>): Promise<Answer> {
  return app.inject({
    method: 'PATCH',
    url: '/staff/settings/day',
    headers: { 'idempotency-key': randomUUID() },
    payload: body,
  });
}

async function globalDay(): Promise<{ horizon: number | null; maxDogs: number | null }> {
  const [row] = await db
    .select({
      horizon: dayProgramSettings.bookingHorizonMonths,
      maxDogs: dayProgramSettings.maxDogsPerBookingCount,
    })
    .from(dayProgramSettings)
    .where(isNull(dayProgramSettings.location));
  return row as { horizon: number | null; maxDogs: number | null };
}

async function bookDogs(
  count: number,
  date: string,
  location: Campus = 'bentonville',
): Promise<void> {
  const app = ownerApp();
  for (let i = 0; i < count; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        payment: { kind: 'credits' },
        category: 'day-school',
        location,
        lead_dog_id: await createFundedDog(createdDogIds, 2),
        dates: [date],
      },
    });
    assert.equal(res.statusCode, 201, res.body);
  }
}

function errorOf(res: Answer): { code: string; details?: { kind: string; dates: string[] } } {
  return (res.json() as { error: { code: string; details?: { kind: string; dates: string[] } } })
    .error;
}

async function weekdays(location: Campus): Promise<number[]> {
  const [row] = await db
    .select({ list: dayProgramSettings.openWeekdaysList })
    .from(dayProgramSettings)
    .where(eq(dayProgramSettings.location, location));
  return row?.list as number[];
}

async function dayCapRows(
  location: string,
  date: string,
): Promise<Array<{ capacity_dogs: number; expired_at: string | null }>> {
  const res = await db.execute(
    sql`SELECT capacity_dogs, expired_at FROM day_capacity WHERE location = ${location} AND date = ${date}`,
  );
  return res.rows as Array<{ capacity_dogs: number; expired_at: string | null }>;
}

async function availability(
  app: FastifyInstance,
  date: string,
  location: string = 'bentonville',
): Promise<{ capacity_dogs: number; remaining_dogs: number }> {
  const res = await app.inject({
    method: 'GET',
    url: `/availability?from=${date}&to=${date}&location=${location}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as Array<{ capacity_dogs: number; remaining_dogs: number }>)[0]!;
}

// ── the design's words (§2.3:2351) ───────────────────────────────────────────

test(
  'untick Friday while three dogs hold a Friday: 422 with those dates, nothing written',
  SKIP_WHEN_NO_DB,
  async () => {
    await bookDogs(3, FRI_23);
    await bookDogs(1, FRI_30);
    const before = await weekdays('bentonville');
    const res = await patchDay(staffApp(), 'bentonville', {
      open_weekdays_list: WEEKDAYS_NO_FRIDAY,
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.deepEqual(errorOf(res).details, {
      kind: 'capacity_below_booked',
      dates: [FRI_23, FRI_30],
    });
    assert.equal(errorOf(res).code, 'capacity_below_booked');
    assert.deepEqual(await weekdays('bentonville'), before);
  },
);

test(
  'PUT, DELETE, PUT on one date: 200 three times; a DELETE of a withdrawn date: 200',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    const first = await put(app, 'bentonville', FRI_23, { capacity_dogs: 9 });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), {
      location: 'bentonville',
      date: FRI_23,
      capacity_dogs: 9,
      remaining_dogs: 9,
    });

    const withdrawn = await del(app, 'bentonville', FRI_23);
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.equal(
      (withdrawn.json() as { capacity_dogs: number }).capacity_dogs,
      15,
      'the rule again',
    );

    const again = await put(app, 'bentonville', FRI_23, { capacity_dogs: 7 });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal((again.json() as { capacity_dogs: number }).capacity_dogs, 7);
    assert.deepEqual(await dayCapRows('bentonville', FRI_23), [
      { capacity_dogs: 7, expired_at: null },
    ]);

    const del1 = await del(app, 'bentonville', FRI_23);
    const del2 = await del(app, 'bentonville', FRI_23);
    assert.equal(del1.statusCode, 200, del1.body);
    assert.equal(del2.statusCode, 200, del2.body);
  },
);

test(
  'a withdrawal on a weekend date with a dog booked: 422, it would fall to 0',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    const opened = await put(app, 'bentonville', SAT_17, { capacity_dogs: 4 });
    assert.equal(opened.statusCode, 200, opened.body);
    await bookDogs(1, SAT_17);
    const res = await del(app, 'bentonville', SAT_17);
    assert.equal(res.statusCode, 422, res.body);
    assert.deepEqual(errorOf(res).details, { kind: 'capacity_below_booked', dates: [SAT_17] });
    assert.deepEqual(await dayCapRows('bentonville', SAT_17), [
      { capacity_dogs: 4, expired_at: null },
    ]);
  },
);

test(
  'Amber, home Bentonville, PUTs Fayetteville: home_locations refuses nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const res = await put(staffApp(FIXTURE_MANAGER_PRINCIPAL), 'fayetteville', SAT_17, {
      capacity_dogs: 6,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      location: 'fayetteville',
      date: SAT_17,
      capacity_dogs: 6,
      remaining_dogs: 6,
    });
  },
);

test(
  'a trainer PATCH naming a money fraction is 403 refused_keys, still',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/staff/settings/day',
      headers: { 'idempotency-key': randomUUID() },
      payload: { sent_home_before_training_return_fraction: 0.5 },
    });
    assert.equal(res.statusCode, 403, res.body);
    const { error } = res.json() as {
      error: { code: string; details: { kind: string; refused_keys: string[] } };
    };
    assert.equal(error.code, 'forbidden');
    assert.deepEqual(error.details, {
      kind: 'refused_keys',
      refused_keys: ['sent_home_before_training_return_fraction'],
    });
  },
);

test(
  'a date with a live override is not undercut by lowering the default',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    const put1 = await put(app, 'bentonville', FRI_23, { capacity_dogs: 10 });
    assert.equal(put1.statusCode, 200, put1.body);
    await bookDogs(8, FRI_23);
    const res = await patchDay(app, 'bentonville', { daily_capacity_dogs: 5 });
    assert.equal(res.statusCode, 200, res.body);
    const after = await availability(app, FRI_23);
    assert.equal(after.capacity_dogs, 10);
    assert.equal(after.remaining_dogs, 2);
  },
);

test(
  'AVAILABILITY_MAX_DATES follows the horizon: 93 dates at 3 months, and the bound moves',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    const window = (from: string, to: string): Promise<Answer> =>
      app.inject({
        method: 'GET',
        url: `/availability?from=${from}&to=${to}&location=bentonville`,
      });

    const legal = await window('2026-11-04', '2027-02-04'); // 93 dates, today through the horizon
    assert.equal(legal.statusCode, 200, legal.body);
    assert.equal((legal.json() as unknown[]).length, 93);

    const over = await window('2026-11-04', '2027-02-06'); // 95 dates
    assert.equal(over.statusCode, 422, over.body);
    assert.match(over.body, /94-date cap/);

    await setGlobalSettings({ bookingHorizonMonths: 1 });
    const shrunk = await window('2026-11-04', '2026-12-06'); // 33 dates
    assert.equal(shrunk.statusCode, 422, shrunk.body);
    assert.match(shrunk.body, /32-date cap/);

    await setGlobalSettings({ bookingHorizonMonths: 6 });
    const grown = await window('2026-11-04', '2027-05-04'); // 182 dates
    assert.equal(grown.statusCode, 200, grown.body);
  },
);

// ── the ceilings (fix round 1, F1) ───────────────────────────────────────────

test(
  'the horizon stops at 12 months: 13 is 422 and writes nothing, 12 is 200',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    const refused = await patchGlobal(app, { booking_horizon_months: 13 });
    assert.equal(refused.statusCode, 422, refused.body);
    assert.equal(errorOf(refused).code, 'invalid_payload');
    assert.equal((await globalDay()).horizon, 3, 'a refused value is not written');

    const accepted = await patchGlobal(app, { booking_horizon_months: 12 });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((await globalDay()).horizon, 12);
  },
);

test(
  'at the ceiling the machine still runs: the last date books, the next is refused, a lowering PATCH completes',
  { ...SKIP_WHEN_NO_DB, timeout: 30_000 },
  async () => {
    const staff = staffApp();
    assert.equal((await patchGlobal(staff, { booking_horizon_months: 12 })).statusCode, 200);

    const owner = ownerApp();
    const dogId = await createFundedDog(createdDogIds, 2);
    const book = (date: string): Promise<Answer> =>
      owner.inject({
        method: 'POST',
        url: '/bookings',
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          payment: { kind: 'credits' },
          category: 'day-school',
          location: 'bentonville',
          lead_dog_id: dogId,
          dates: [date],
        },
      });
    const last = await book('2027-10-05'); // 5 Oct 2026 + 12 months, a Tuesday
    assert.equal(last.statusCode, 201, last.body);
    const next = await book('2027-10-06');
    assert.equal(next.statusCode, 422, next.body);
    assert.equal(errorOf(next).code, 'beyond_booking_horizon');

    // One lock per date it lowers: this is the loop the ceiling bounds.
    const lowered = await patchDay(staff, 'bentonville', { daily_capacity_dogs: 14 });
    assert.equal(lowered.statusCode, 200, lowered.body);
    const unticked = await patchDay(staff, 'bentonville', {
      open_weekdays_list: WEEKDAYS_NO_FRIDAY,
    });
    assert.equal(unticked.statusCode, 200, unticked.body);
  },
);

test(
  'the roster setting stops at the route: 100 is 422 and writes nothing, 99 is 200',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    const refused = await patchGlobal(app, { max_dogs_per_booking_count: 100 });
    assert.equal(refused.statusCode, 422, refused.body);
    assert.equal(errorOf(refused).code, 'invalid_payload');
    assert.equal((await globalDay()).maxDogs, 5, 'a refused value is not written');

    const accepted = await patchGlobal(app, { max_dogs_per_booking_count: 99 });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((await globalDay()).maxDogs, 99);
  },
);

test(
  'at 99 the route takes what the setting promises: 99 dogs clear the ceiling, 100 do not',
  SKIP_WHEN_NO_DB,
  async () => {
    assert.equal(
      (await patchGlobal(staffApp(), { max_dogs_per_booking_count: 99 })).statusCode,
      200,
    );
    const owner = ownerApp();
    const roster = (dogs: number): Promise<Answer> =>
      owner.inject({
        method: 'POST',
        url: '/bookings',
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          payment: { kind: 'credits' },
          category: 'day-school',
          location: 'bentonville',
          lead_dog_id: randomUUID(),
          additional_dog_ids: Array.from({ length: dogs - 1 }, () => randomUUID()),
          dates: [FRI_23],
        },
      });
    // Past the ceiling, the dogs are nobody's: the ownership loop is the next refusal.
    const fits = await roster(99);
    assert.equal(fits.statusCode, 404, fits.body);
    const over = await roster(100);
    assert.equal(over.statusCode, 422, over.body);
    assert.equal(errorOf(over).code, 'invalid_payload');
  },
);

// ── the check's edges ────────────────────────────────────────────────────────

test(
  'PUT below the count: 422 naming the date, the old row stands, the count is the combined one',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    await put(app, 'bentonville', FRI_23, { capacity_dogs: 6 });
    await bookDogs(2, FRI_23);
    const owner = ownerApp();
    const daycare = await owner.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        payment: { kind: 'credits' },
        category: 'day-care',
        location: 'bentonville',
        lead_dog_id: await createFundedDog(createdDogIds, 2),
        dates: [FRI_23],
      },
    });
    assert.equal(daycare.statusCode, 201, daycare.body);

    const res = await put(app, 'bentonville', FRI_23, { capacity_dogs: 2 });
    assert.equal(res.statusCode, 422, res.body);
    assert.deepEqual(errorOf(res).details, { kind: 'capacity_below_booked', dates: [FRI_23] });
    assert.deepEqual(await dayCapRows('bentonville', FRI_23), [
      { capacity_dogs: 6, expired_at: null },
    ]);

    const toCount = await put(app, 'bentonville', FRI_23, { capacity_dogs: 3 });
    assert.equal(toCount.statusCode, 200, toCount.body);
    assert.equal((toCount.json() as { remaining_dogs: number }).remaining_dogs, 0);
  },
);

test(
  'lowering the default names every undercut date, ascending, and only those',
  SKIP_WHEN_NO_DB,
  async () => {
    await bookDogs(3, FRI_30);
    await bookDogs(3, FRI_23);
    await bookDogs(2, '2026-10-26'); // a Monday at 2, which a cap of 2 still seats
    const res = await patchDay(staffApp(), 'bentonville', { daily_capacity_dogs: 2 });
    assert.equal(res.statusCode, 422, res.body);
    assert.deepEqual(errorOf(res).details, {
      kind: 'capacity_below_booked',
      dates: [FRI_23, FRI_30],
    });
  },
);

test(
  'a raise checks nothing: an over-full date neither blocks a PUT up nor a PATCH up',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    await bookDogs(4, FRI_23);
    // Over-full by hand: a date imported over its cap, the shape a raise must not trip.
    await db.execute(
      sql`INSERT INTO day_capacity (location, date, capacity_dogs) VALUES ('bentonville', ${FRI_23}, 2)`,
    );
    await invalidatePattern('avail:bentonville:*');
    const up = await put(app, 'bentonville', FRI_23, { capacity_dogs: 3 });
    assert.equal(up.statusCode, 200, up.body);
    const patched = await patchDay(app, 'bentonville', { daily_capacity_dogs: 20 });
    assert.equal(patched.statusCode, 200, patched.body);
  },
);

test(
  'a DELETE with no live override changes nothing and runs no check, even over-full',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    await bookDogs(3, FRI_23);
    await setCampusSettings('bentonville', { dailyCapacityDogs: 1 });
    const auditRows = async (): Promise<number> =>
      (
        await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(and(eq(auditLog.tableName, 'day_capacity'), eq(auditLog.rowPk, FRI_23)))
      ).length;
    const auditedBefore = await auditRows();
    const res = await del(app, 'bentonville', FRI_23);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      location: 'bentonville',
      date: FRI_23,
      capacity_dogs: 1,
      remaining_dogs: 0,
    });
    assert.equal(await auditRows(), auditedBefore);
  },
);

test(
  'a raise of the weekdays with a lower cap only checks the dates it lowers',
  SKIP_WHEN_NO_DB,
  async () => {
    await bookDogs(3, FRI_23);
    const res = await patchDay(staffApp(), 'bentonville', {
      daily_capacity_dogs: 3,
      open_weekdays_list: [1, 2, 3, 4, 5, 6],
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(await weekdays('bentonville'), [1, 2, 3, 4, 5, 6]);
  },
);

test(
  "past the horizon is not checked, in the design's words, and neither is the past",
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    await db.execute(
      sql`INSERT INTO day_capacity (location, date, capacity_dogs) VALUES ('bentonville', '2027-01-15', 8)`,
    );
    const res = await put(app, 'bentonville', '2027-01-15', { capacity_dogs: 0 });
    assert.equal(res.statusCode, 200, res.body);
    const past = await put(app, 'bentonville', '2026-10-02', { capacity_dogs: 0 });
    assert.equal(past.statusCode, 200, past.body);
  },
);

test(
  'a PATCH naming neither key takes no row lock and runs no check',
  SKIP_WHEN_NO_DB,
  async () => {
    await bookDogs(3, FRI_23);
    const res = await patchDay(staffApp(), 'bentonville', { same_day_cutoff_time: '08:00' });
    assert.equal(res.statusCode, 200, res.body);
  },
);

test(
  'the other campus is untouched: lowering Fayetteville reads Fayetteville',
  SKIP_WHEN_NO_DB,
  async () => {
    await bookDogs(3, FRI_23, 'bentonville');
    const res = await patchDay(staffApp(), 'fayetteville', { daily_capacity_dogs: 1 });
    assert.equal(res.statusCode, 200, res.body);
  },
);

// ── the route's own contract ─────────────────────────────────────────────────

test('an owner principal is 403 on both verbs', SKIP_WHEN_NO_DB, async () => {
  const app = ownerApp();
  const a = await put(app, 'bentonville', FRI_23, { capacity_dogs: 5 });
  const b = await del(app, 'bentonville', FRI_23);
  assert.equal(a.statusCode, 403, a.body);
  assert.equal(b.statusCode, 403, b.body);
});

test('Idempotency-Key is required on both verbs', SKIP_WHEN_NO_DB, async () => {
  const app = staffApp();
  const a = await app.inject({
    method: 'PUT',
    url: `/staff/day-capacity/bentonville/${FRI_23}`,
    payload: { capacity_dogs: 5 },
  });
  const b = await app.inject({
    method: 'DELETE',
    url: `/staff/day-capacity/bentonville/${FRI_23}`,
  });
  assert.equal(a.statusCode, 400, a.body);
  assert.equal(b.statusCode, 400, b.body);
});

test('a bad path or body is 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const app = staffApp();
  for (const res of [
    await put(app, 'rogers', FRI_23, { capacity_dogs: 5 }),
    await put(app, 'bentonville', '2026-02-31', { capacity_dogs: 5 }),
    await put(app, 'bentonville', FRI_23, { capacity_dogs: -1 }),
    await put(app, 'bentonville', FRI_23, { capacity_dogs: 1.5 }),
    await put(app, 'bentonville', FRI_23, { capacity_dogs: 2147483648 }),
    await put(app, 'bentonville', FRI_23, { capacity_dogs: 5, mode: 'school' }),
    await put(app, 'bentonville', FRI_23, {}),
    await del(app, 'rogers', FRI_23),
    await del(app, 'bentonville', 'tomorrow'),
  ]) {
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(errorOf(res).code, 'bad_request');
  }
});

test(
  'the hash carries the path: one key on a second date is 422, a replay returns the body',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    const key = randomUUID();
    const first = await put(app, 'bentonville', FRI_23, { capacity_dogs: 5 }, key);
    assert.equal(first.statusCode, 200, first.body);
    const replay = await put(app, 'bentonville', FRI_23, { capacity_dogs: 5 }, key);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json());
    const second = await put(app, 'bentonville', FRI_30, { capacity_dogs: 5 }, key);
    assert.equal(second.statusCode, 422, second.body);
    assert.equal(errorOf(second).code, 'idempotency_mismatch');
    assert.deepEqual(await dayCapRows('bentonville', FRI_30), []);

    const deleteKey = randomUUID();
    const d1 = await del(app, 'bentonville', FRI_23, deleteKey);
    assert.equal(d1.statusCode, 200, d1.body);
    const d2 = await del(app, 'bentonville', FRI_30, deleteKey);
    assert.equal(d2.statusCode, 422, d2.body);
    assert.equal(errorOf(d2).code, 'idempotency_mismatch');
  },
);

test(
  'both verbs invalidate avail:{location}:*, so the next read sees the write',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    assert.equal((await availability(app, SAT_17)).capacity_dogs, 0, 'cached as no override');
    await put(app, 'bentonville', SAT_17, { capacity_dogs: 6 });
    assert.equal((await availability(app, SAT_17)).capacity_dogs, 6);
    await del(app, 'bentonville', SAT_17);
    assert.equal((await availability(app, SAT_17)).capacity_dogs, 0);
  },
);

test(
  'a write is audited under the staffer, and the PUT re-opens the withdrawn row',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffApp();
    await put(app, 'bentonville', FRI_30, { capacity_dogs: 5 });
    await del(app, 'bentonville', FRI_30);
    await put(app, 'bentonville', FRI_30, { capacity_dogs: 6 });
    const audited = await db
      .select({ op: auditLog.op, actor: auditLog.actor })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tableName, 'day_capacity'),
          eq(auditLog.rowPk, FRI_30),
          inArray(auditLog.op, ['UPDATE']),
        ),
      );
    assert.equal(audited.length, 2);
    for (const row of audited) assert.match(row.actor ?? '', /staff/);
    await db.delete(auditLog).where(eq(auditLog.rowPk, FRI_30));
  },
);

// ── two PATCHes queue; a booking does not (ruling (i) step 1) ────────────────

// A lock test that can only fail by waiting forever must fail by the clock instead.
const LOCK_TEST = { ...SKIP_WHEN_NO_DB, timeout: 20_000 };

async function waitingOnALock(client: pg.Client): Promise<number> {
  const res = await client.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
  return (res.rows[0] as { n: number }).n;
}

async function untilSomethingWaits(client: pg.Client): Promise<void> {
  const deadline = Date.now() + 3000;
  while ((await waitingOnALock(client)) === 0) {
    assert.ok(Date.now() < deadline, 'nothing queued on the held row');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test(
  'a held row lock queues a PATCH and does not block a booking of a date it has not reached',
  LOCK_TEST,
  async () => {
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM day_program_settings WHERE location = 'bentonville' FOR UPDATE`,
      );

      let settled = false;
      const queued = patchDay(staffApp(), 'bentonville', { daily_capacity_dogs: 14 }).then(
        (res) => {
          settled = true;
          return res;
        },
      );
      await untilSomethingWaits(holder);

      // The booking finishes while the row is held: its read is a plain SELECT, and
      // the PATCH queues on the row before it takes any date's lock. If it took them
      // first, this booking would wait behind it, and the race below is what says so
      // rather than a hang.
      const booked = bookDogs(1, FRI_23).then(() => 'booked');
      const timedOut = new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5000));
      const booking = await Promise.race([booked, timedOut]);
      const patchSettledBeforeCommit = settled;

      await holder.query('COMMIT');
      const res = await queued;
      await booked;
      assert.equal(booking, 'booked');
      assert.equal(patchSettledBeforeCommit, false, 'the PATCH is waiting on the row');
      assert.equal(res.statusCode, 200, res.body);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  },
);

test(
  'two PATCHes queue: the second compares its edit with the row the first left',
  LOCK_TEST,
  async () => {
    // Saturday is unticked, and three dogs hold a Saturday (imported, or a withdrawn
    // override's). A first edit ticks Saturday and has not committed. A second lowers
    // the daily cap to 2. Reading the row unlocked, it would see Saturday still closed,
    // find no Saturday to check, and leave three dogs on a day of two seats.
    await put(staffApp(), 'bentonville', SAT_17, { capacity_dogs: 4 });
    await bookDogs(3, SAT_17);
    await db.execute(
      sql`UPDATE day_capacity SET expired_at = now() WHERE location = 'bentonville' AND date = ${SAT_17}`,
    );
    await invalidatePattern('avail:bentonville:*');

    const first = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await first.connect();
    try {
      await first.query('BEGIN');
      await first.query(
        `UPDATE day_program_settings SET open_weekdays_list = '{1,2,3,4,5,6}' WHERE location = 'bentonville'`,
      );

      const second = patchDay(staffApp(), 'bentonville', { daily_capacity_dogs: 2 });
      await untilSomethingWaits(first);
      await first.query('COMMIT');

      const res = await second;
      assert.equal(res.statusCode, 422, res.body);
      assert.deepEqual(errorOf(res).details, { kind: 'capacity_below_booked', dates: [SAT_17] });
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await first.end();
    }
  },
);

// ── on two real connections (design §2.3:2351) ───────────────────────────────

const RACE_ROUNDS = 25;

/** The design's two Fridays that the rule now in force leaves below their count. */
async function fridaysBelowCount(): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT to_char((b.scheduled_at AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') AS date,
           count(*)::int AS booked
      FROM booking_dogs bd JOIN bookings b ON b.id = bd.booking_id
     WHERE b.location = 'bentonville' AND b.status <> 'cancelled'
       AND b.category IN ('day-school', 'day-care') AND b.expired_at IS NULL
     GROUP BY 1`);
  const [campus] = await db
    .select({
      open: dayProgramSettings.openWeekdaysList,
      cap: dayProgramSettings.dailyCapacityDogs,
    })
    .from(dayProgramSettings)
    .where(eq(dayProgramSettings.location, 'bentonville'));
  return (rows.rows as Array<{ date: string; booked: number }>)
    .filter(({ date, booked }) => {
      const iso = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
      const seats = (campus?.open as number[]).includes(iso) ? (campus?.cap as number) : 0;
      return booked > seats && date >= FRI_23 && date <= FRI_30;
    })
    .map((r) => r.date);
}

type Racer = 'patch' | 'booking';

/** The two requests of one round, not yet started. */
async function racers(): Promise<Record<Racer, () => Promise<Answer>>> {
  const dogId = await createFundedDog(createdDogIds, 2);
  const staff = staffApp();
  const owner = ownerApp();
  return {
    patch: () => patchDay(staff, 'bentonville', { open_weekdays_list: WEEKDAYS_NO_FRIDAY }),
    booking: () =>
      owner.inject({
        method: 'POST',
        url: '/bookings',
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          payment: { kind: 'credits' },
          category: 'day-school',
          location: 'bentonville',
          lead_dog_id: dogId,
          dates: [FRI_23, FRI_30],
        },
      }),
  };
}

async function outcomeOf(patched: Answer, booked: Answer): Promise<string> {
  const label = (res: Answer): string =>
    res.statusCode < 400 ? String(res.statusCode) : `${res.statusCode} ${errorOf(res).code}`;
  const below = await fridaysBelowCount();
  const outcome = `patch ${label(patched)}; booking ${label(booked)}; below ${below.length}`;
  await restoreDaySeeds();
  await removeDogs(createdDogIds.splice(0));
  return outcome;
}

async function advisoryWaiters(client: pg.Client): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
  );
  return (res.rows[0] as { n: number }).n;
}

async function untilWaiters(client: pg.Client, wanted: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while ((await advisoryWaiters(client)) < wanted) {
    assert.ok(Date.now() < deadline, `${wanted} request(s) never queued on the Friday's lock`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * One round with the order forced. A third connection holds Fri 23's lock, each
 * request is started only once the one before is queued behind it, and Postgres
 * grants a lock's waiters first come first served, so `first` gets the Friday.
 */
async function forcedRound(first: Racer): Promise<string> {
  const start = await racers();
  const second: Racer = first === 'patch' ? 'booking' : 'patch';
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `capacity:bentonville:${FRI_23}`,
    ]);
    const firstAnswer = start[first]();
    await untilWaiters(holder, 1);
    const secondAnswer = start[second]();
    await untilWaiters(holder, 2);
    await holder.query('COMMIT');
    const answers = { [first]: await firstAnswer, [second]: await secondAnswer };
    return await outcomeOf(answers.patch as Answer, answers.booking as Answer);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
}

/** One round left to run free, the first request a few milliseconds ahead. */
async function freeRound(first: Racer, headStartMs: number): Promise<string> {
  const start = await racers();
  const second: Racer = first === 'patch' ? 'booking' : 'patch';
  const firstAnswer = start[first]();
  await new Promise((resolve) => setTimeout(resolve, headStartMs));
  const secondAnswer = start[second]();
  const answers = { [first]: await firstAnswer, [second]: await secondAnswer };
  return outcomeOf(answers.patch as Answer, answers.booking as Answer);
}

function tally(outcomes: string[]): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const outcome of outcomes) seen[outcome] = (seen[outcome] ?? 0) + 1;
  return seen;
}

// A 40P01 is Postgres aborting one transaction: a 500, so a key not listed here.
const PATCH_WON = 'patch 200; booking 422 insufficient_capacity; below 0';
const BOOKING_WON = 'patch 422 capacity_below_booked; booking 201; below 0';

test(
  'two connections, the PATCH gets the Friday first: the booking reads the new rule',
  SKIP_WHEN_NO_DB,
  async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < RACE_ROUNDS; i += 1) outcomes.push(await forcedRound('patch'));
    console.log(`RACE forced patch-first: ${JSON.stringify(tally(outcomes))}`);
    assert.deepEqual(tally(outcomes), { [PATCH_WON]: RACE_ROUNDS });
  },
);

test(
  'two connections, the booking gets the Friday first: the PATCH counts it and refuses',
  SKIP_WHEN_NO_DB,
  async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < RACE_ROUNDS; i += 1) outcomes.push(await forcedRound('booking'));
    console.log(`RACE forced booking-first: ${JSON.stringify(tally(outcomes))}`);
    assert.deepEqual(tally(outcomes), { [BOOKING_WON]: RACE_ROUNDS });
  },
);

for (const first of ['patch', 'booking'] as const) {
  test(
    `two connections left to run, ${first} started first: no 40P01, no Friday below its count`,
    { ...SKIP_WHEN_NO_DB, timeout: 60_000 },
    async () => {
      const outcomes: string[] = [];
      for (let i = 0; i < RACE_ROUNDS; i += 1) outcomes.push(await freeRound(first, i % 6));
      console.log(`RACE free ${first}-first: ${JSON.stringify(tally(outcomes))}`);
      for (const outcome of outcomes)
        assert.ok([PATCH_WON, BOOKING_WON].includes(outcome), outcome);
    },
  );
}

// ── the horizon under the check (fix round 1, F3; Opus L1) ───────────────────

// Past the 3-month horizon, which ends on 5 Jan 2027; inside a 6-month one, 5 Apr.
const RAISED_FRIDAY = '2027-04-02';
const RAISED_SATURDAY = '2027-04-03';
// The last Friday the untick reaches at 3 months: parked there, it has read everything.
const LAST_FRIDAY_AT_THREE = '2027-01-01';

async function bookDog(dogId: string, date: string): Promise<Answer> {
  return ownerApp().inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      category: 'day-school',
      location: 'bentonville',
      lead_dog_id: dogId,
      dates: [date],
      payment: { kind: 'credits' },
    },
  });
}

async function holdCapacityLock(client: pg.Client, date: string): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `capacity:bentonville:${date}`,
  ]);
}

/** Wait until `done()` or `waiters` requests queue. Never fails: the test's asserts do. */
async function untilSettledOrQueued(
  client: pg.Client,
  done: () => boolean,
  waiters: number,
): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && !done() && (await waitingOnALock(client)) < waiters) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Dogs on the date and the seats the date now has. */
async function dogsAndSeats(date: string): Promise<{ dogs: number; seats: number }> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS dogs
      FROM booking_dogs bd JOIN bookings b ON b.id = bd.booking_id
     WHERE b.location = 'bentonville' AND b.status <> 'cancelled'
       AND (b.scheduled_at AT TIME ZONE 'America/Chicago')::date = ${date}::date`);
  await invalidatePattern('avail:bentonville:*');
  const { capacity_dogs: seats } = await availability(staffApp(), date);
  return { dogs: (res.rows[0] as { dogs: number }).dogs, seats };
}

test(
  'a raise queues behind a rule edit, so the date it would reach cannot be booked under the edit',
  LOCK_TEST,
  async () => {
    const staff = staffApp();
    const dogId = await createFundedDog(createdDogIds, 2);
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holdCapacityLock(holder, LAST_FRIDAY_AT_THREE);
      const edit = patchDay(staff, 'bentonville', { open_weekdays_list: WEEKDAYS_NO_FRIDAY });
      await untilWaiters(holder, 1);

      let raised = false;
      const raise = patchGlobal(staff, { booking_horizon_months: 6 }).then((res) => {
        raised = true;
        return res;
      });
      await untilSettledOrQueued(holder, () => raised, 2);
      const raisedBeforeTheEditEnded = raised;

      // A booking's read of the row is plain, so this answers while the edit is parked.
      const booked = await bookDog(dogId, RAISED_FRIDAY);

      await holder.query('COMMIT');
      const [edited, raisedAnswer] = await Promise.all([edit, raise]);
      assert.equal(edited.statusCode, 200, edited.body);
      assert.equal(raisedAnswer.statusCode, 200, raisedAnswer.body);

      assert.deepEqual(await dogsAndSeats(RAISED_FRIDAY), { dogs: 0, seats: 0 });
      assert.equal(booked.statusCode, 422, booked.body);
      assert.equal(errorOf(booked).code, 'beyond_booking_horizon');
      assert.equal(raisedBeforeTheEditEnded, false, 'the raise waited for the edit');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  },
);

test(
  'a rule edit that starts during a raise waits for it, and checks the raised window',
  LOCK_TEST,
  async () => {
    // A dog holds Fri 2 Apr from when the horizon was 6, and it has since gone to 3.
    await setGlobalSettings({ bookingHorizonMonths: 6 });
    await bookDogs(1, RAISED_FRIDAY);
    await setGlobalSettings({ bookingHorizonMonths: 3 });

    const raiser = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await raiser.connect();
    try {
      await raiser.query('BEGIN');
      await raiser.query(
        `UPDATE day_program_settings SET booking_horizon_months = 6 WHERE location IS NULL`,
      );

      let settled = false;
      const edit = patchDay(staffApp(), 'bentonville', {
        open_weekdays_list: WEEKDAYS_NO_FRIDAY,
      }).then((res) => {
        settled = true;
        return res;
      });
      await untilSettledOrQueued(raiser, () => settled, 1);
      await raiser.query('COMMIT');

      const res = await edit;
      assert.equal(res.statusCode, 422, res.body);
      assert.deepEqual(errorOf(res).details, {
        kind: 'capacity_below_booked',
        dates: [RAISED_FRIDAY],
      });
    } finally {
      await raiser.query('ROLLBACK').catch(() => undefined);
      await raiser.end();
    }
  },
);

for (const arm of [
  {
    verb: 'PUT',
    date: RAISED_FRIDAY,
    prepare: async (): Promise<void> => undefined,
    edit: (app: FastifyInstance): Promise<Answer> =>
      put(app, 'bentonville', RAISED_FRIDAY, { capacity_dogs: 0 }),
  },
  {
    verb: 'DELETE',
    date: RAISED_SATURDAY,
    // A Saturday only its override opens: withdrawing it takes the date to 0.
    prepare: async (): Promise<void> => {
      await setGlobalSettings({ bookingHorizonMonths: 6 });
      await put(staffApp(), 'bentonville', RAISED_SATURDAY, { capacity_dogs: 4 });
      await setGlobalSettings({ bookingHorizonMonths: 3 });
    },
    edit: (app: FastifyInstance): Promise<Answer> => del(app, 'bentonville', RAISED_SATURDAY),
  },
]) {
  test(
    `a raise queues behind a ${arm.verb}, whose date is read and locked before a booking that follows it`,
    LOCK_TEST,
    async () => {
      await arm.prepare();
      const staff = staffApp();
      const dogId = await createFundedDog(createdDogIds, 2);
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      try {
        // The booking queues on the date first and the edit behind it, so the booking
        // is first through, and reads the horizon under its lock.
        await holdCapacityLock(holder, arm.date);
        const booking = bookDog(dogId, arm.date);
        await untilWaiters(holder, 1);
        const edit = arm.edit(staff);
        await untilWaiters(holder, 2);

        let raised = false;
        const raise = patchGlobal(staff, { booking_horizon_months: 6 }).then((res) => {
          raised = true;
          return res;
        });
        await untilSettledOrQueued(holder, () => raised, 3);
        const raisedBeforeTheEditEnded = raised;

        await holder.query('COMMIT');
        const [edited, raisedAnswer] = await Promise.all([edit, raise]);
        await booking;
        assert.equal(edited.statusCode, 200, edited.body);
        assert.equal(raisedAnswer.statusCode, 200, raisedAnswer.body);

        assert.deepEqual(await dogsAndSeats(arm.date), { dogs: 0, seats: 0 });
        assert.equal(raisedBeforeTheEditEnded, false, 'the raise waited for the edit');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    },
  );
}

test(
  'a held global row queues a cap edit, and a booking reads straight past it',
  LOCK_TEST,
  async () => {
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM day_program_settings WHERE location IS NULL FOR UPDATE`);

      let settled = false;
      const edit = put(staffApp(), 'bentonville', FRI_23, { capacity_dogs: 9 }).then((res) => {
        settled = true;
        return res;
      });
      await untilSettledOrQueued(holder, () => settled, 1);
      const settledWhileHeld = settled;

      const booked = bookDogs(1, FRI_30).then(() => 'booked');
      const timedOut = new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5000));
      const booking = await Promise.race([booked, timedOut]);

      await holder.query('COMMIT');
      const res = await edit;
      await booked;
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(booking, 'booked');
      assert.equal(settledWhileHeld, false, 'the edit waited for the row');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  },
);
