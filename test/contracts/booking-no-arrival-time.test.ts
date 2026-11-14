import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import type { PostBookingsResponse } from '../../src/contracts/wire.js';
import { bookingDogs, scheduledNotifications } from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { FIXTURE_NOW } from './_fixture.js';
import {
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
 * P13 B4 (DAY-U11, DAY-60, ruling (k)): the day starts when the campus opens and no
 * arrival time is asked. `scheduled_at` is the campus's `dropoff_open_time` on the
 * date, so the cancel deadline and the reminders follow it (DAY-71), and a day goes
 * Past at the campus's `pickup_close_time`, computed at read time.
 */

registerFixtureHooks();

const createdDogIds: string[] = [];
afterEach(async () => {
  await removeDogs(createdDogIds.splice(0));
  await restoreDaySeeds();
});

function appAt(now: () => Date): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now });
  return app;
}

type App = ReturnType<typeof appAt>;
type BookingBody = { id: string; dog_id: string; date: string; cancel_deadline_at?: string };

async function book(
  app: App,
  dogId: string,
  date: string,
  location: Campus = 'bentonville',
  extra: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: string; bookings: BookingBody[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `arrive-${randomUUID()}` },
    payload: {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [date],
      location,
      payment: { kind: 'credits' },
      ...extra,
    },
  });
  const parsed = JSON.parse(res.body) as Partial<PostBookingsResponse>;
  return {
    statusCode: res.statusCode,
    body: res.body,
    bookings: (parsed.sessions ?? []) as BookingBody[],
  };
}

test(
  'sending dropoff_time is refused by .strict(): 400, nothing written',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogIds);
    const res = await book(appAt(FIXTURE_NOW), dogId, '2026-06-16', 'bentonville', {
      dropoff_time: '08:00',
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.body, /bad_request/);
    const rows = await db.select().from(bookingDogs).where(eq(bookingDogs.dogId, dogId));
    assert.equal(rows.length, 0);
  },
);

test(
  'dropoff_open_time at 07:45 moves scheduled_at and the reminder; no deadline is stamped (P21, D3)',
  SKIP_WHEN_NO_DB,
  async () => {
    await setCampusSettings('bentonville', { dropoffOpenTime: '07:45' });
    const dogId = await createFundedDog(createdDogIds);
    const res = await book(appAt(FIXTURE_NOW), dogId, '2026-06-16');
    assert.equal(res.statusCode, 201, res.body);
    const [wire] = res.bookings;
    assert.equal(wire?.date, '2026-06-16T12:45:00.000Z', '07:45 CDT');
    // No cancel window exists from P21 (M5.08): nothing is stamped, so the wire omits it.
    assert.equal(wire?.cancel_deadline_at, undefined);

    const [reminder] = await db
      .select({ scheduledFor: scheduledNotifications.scheduledFor })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.bookingId, wire?.id as string),
          eq(scheduledNotifications.type, 'booking-reminder'),
        ),
      );
    assert.equal(
      new Date(reminder?.scheduledFor as string).toISOString(),
      '2026-06-15T12:45:00.000Z',
    );
  },
);

test(
  'the start is per campus: Fayetteville keeps 07:30 when Bentonville moves',
  SKIP_WHEN_NO_DB,
  async () => {
    await setCampusSettings('bentonville', { dropoffOpenTime: '08:15' });
    const app = appAt(FIXTURE_NOW);
    const fay = await book(app, await createFundedDog(createdDogIds), '2026-06-16', 'fayetteville');
    assert.equal(fay.bookings[0]?.date, '2026-06-16T12:30:00.000Z');
    const ben = await book(app, await createFundedDog(createdDogIds), '2026-06-16', 'bentonville');
    assert.equal(ben.bookings[0]?.date, '2026-06-16T13:15:00.000Z');
  },
);

test('across a DST change the instant is still 07:30 wall clock', SKIP_WHEN_NO_DB, async () => {
  await setCampusSettings('bentonville', { openWeekdaysList: [1, 2, 3, 4, 5, 6, 7] });
  const fall = appAt(() => new Date('2026-10-20T18:00:00Z'));
  const saturday = await book(fall, await createFundedDog(createdDogIds), '2026-10-31');
  assert.equal(saturday.bookings[0]?.date, '2026-10-31T12:30:00.000Z', 'CDT, UTC-5');
  const sunday = await book(fall, await createFundedDog(createdDogIds), '2026-11-01');
  assert.equal(sunday.bookings[0]?.date, '2026-11-01T13:30:00.000Z', 'CST, UTC-6');

  const spring = appAt(() => new Date('2027-03-01T18:00:00Z'));
  const before = await book(spring, await createFundedDog(createdDogIds), '2027-03-13');
  assert.equal(before.bookings[0]?.date, '2027-03-13T13:30:00.000Z', 'CST, UTC-6');
  const after = await book(spring, await createFundedDog(createdDogIds), '2027-03-14');
  assert.equal(after.bookings[0]?.date, '2027-03-14T12:30:00.000Z', 'CDT, UTC-5');
});

async function viewsAt(iso: string, dogId: string): Promise<{ upcoming: boolean; past: boolean }> {
  const app = appAt(() => new Date(iso));
  const read = async (view: string): Promise<boolean> => {
    const res = await app.inject({ method: 'GET', url: `/dogs/${dogId}/bookings?view=${view}` });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json() as unknown[]).length === 1;
  };
  return { upcoming: await read('upcoming'), past: await read('past') };
}

test(
  'pickup_close_time at 18:00: a day is Upcoming at 17:45 and Past at 18:00',
  SKIP_WHEN_NO_DB,
  async () => {
    await setCampusSettings('bentonville', { pickupCloseTime: '18:00' });
    const dogId = await createFundedDog(createdDogIds);
    const res = await book(appAt(FIXTURE_NOW), dogId, '2026-06-16');
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(await viewsAt('2026-06-16T22:45:00Z', dogId), { upcoming: true, past: false });
    assert.deepEqual(await viewsAt('2026-06-16T23:00:00Z', dogId), { upcoming: false, past: true });
  },
);

test('the close is per campus: Fayetteville still flips at 17:30', SKIP_WHEN_NO_DB, async () => {
  await setCampusSettings('bentonville', { pickupCloseTime: '18:00' });
  const dogId = await createFundedDog(createdDogIds);
  const res = await book(appAt(FIXTURE_NOW), dogId, '2026-06-16', 'fayetteville');
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(await viewsAt('2026-06-16T22:29:00Z', dogId), { upcoming: true, past: false });
  assert.deepEqual(await viewsAt('2026-06-16T22:30:00Z', dogId), { upcoming: false, past: true });
});

test('GET /bookings and /bookings/up-next read the same close', SKIP_WHEN_NO_DB, async () => {
  await setCampusSettings('bentonville', { pickupCloseTime: '18:00' });
  const dogId = await createFundedDog(createdDogIds);
  // The 30th: every fixture row that is upcoming then starts later, so up-next is ours.
  const res = await book(appAt(FIXTURE_NOW), dogId, '2026-06-30');
  const id = res.bookings[0]?.id;
  const at1745 = appAt(() => new Date('2026-06-30T22:45:00Z'));
  const upcoming = await at1745.inject({ method: 'GET', url: '/bookings?view=upcoming' });
  assert.ok(
    (upcoming.json() as Array<{ id: string }>).some((b) => b.id === id),
    'still upcoming',
  );
  const at1800 = appAt(() => new Date('2026-06-30T23:00:00Z'));
  const past = await at1800.inject({ method: 'GET', url: '/bookings?view=past' });
  assert.ok(
    (past.json() as Array<{ id: string }>).some((b) => b.id === id),
    'past at the close',
  );
  const next = await at1745.inject({ method: 'GET', url: '/bookings/up-next' });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal((next.json() as { id: string } | null)?.id, id);
});
