import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { bookingDogs, cohorts, creditLedger, pendingRequests } from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  createBookableDog,
  createFundedDog,
  removeDogs,
  restoreDaySeeds,
  setCampusSettings,
  setGlobalSettings,
  type Campus,
} from './_dayFixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
  registerRequestServicesOn,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * P13 B3 (DAY-U04, DAY-U10, rulings (a) to (e)): what the campus says and what the
 * clock says, read at runtime and refused after the idempotency claim, so a replay
 * outlives every clock.
 */

registerFixtureHooks();
registerRequestServicesOn();

const createdDogIds: string[] = [];
const createdRequestIds: string[] = [];
afterEach(async () => {
  for (const id of createdRequestIds.splice(0)) {
    await db.delete(pendingRequests).where(eq(pendingRequests.id, id));
  }
  await removeDogs(createdDogIds.splice(0));
  await restoreDaySeeds();
});

type Clock = () => Date;
const at =
  (iso: string): Clock =>
  () =>
    new Date(iso);

function appAt(now: Clock): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now });
  registerRequestsRoute(app, { authenticate, now });
  return app;
}

type App = ReturnType<typeof appAt>;
type Result = { statusCode: number; code: string | undefined; body: string };

function result(res: { statusCode: number; body: string }): Result {
  const parsed = JSON.parse(res.body) as { error?: { code: string } };
  return { statusCode: res.statusCode, code: parsed.error?.code, body: res.body };
}

async function book(
  app: App,
  payload: { lead_dog_id: string; dates: string[]; additional_dog_ids?: string[] } & Partial<{
    category: 'day-school' | 'day-care';
    location: Campus;
  }>,
  key = `day-${randomUUID()}`,
): Promise<Result> {
  const res = await app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': key },
    payload: {
      category: 'day-school',
      location: 'bentonville',
      payment: { kind: 'credits' },
      ...payload,
    },
  });
  return result(res);
}

async function bookedRows(dogId: string): Promise<number> {
  const rows = await db
    .select({ id: bookingDogs.bookingId })
    .from(bookingDogs)
    .where(eq(bookingDogs.dogId, dogId));
  return rows.length;
}

async function debits(dogId: string): Promise<number> {
  const rows = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.dogId, dogId), eq(creditLedger.reason, 'booking-debit')));
  return rows.length;
}

// ── program_not_offered (DAY-U04) ────────────────────────────────────────────

test(
  'daycare at Fayetteville: 422 program_not_offered, no row, no debit',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = appAt(FIXTURE_NOW);
    const dogId = await createFundedDog(createdDogIds);
    const res = await book(app, {
      category: 'day-care',
      location: 'fayetteville',
      lead_dog_id: dogId,
      dates: ['2026-06-16'],
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.code, 'program_not_offered');
    assert.equal(await bookedRows(dogId), 0);
    assert.equal(await debits(dogId), 0);
  },
);

test('daycare at Bentonville, and day school at both, are offered', SKIP_WHEN_NO_DB, async () => {
  const app = appAt(FIXTURE_NOW);
  for (const [category, location] of [
    ['day-care', 'bentonville'],
    ['day-school', 'bentonville'],
    ['day-school', 'fayetteville'],
  ] as const) {
    const res = await book(app, {
      category,
      location,
      lead_dog_id: await createFundedDog(createdDogIds),
      dates: ['2026-06-16'],
    });
    assert.equal(res.statusCode, 201, `${category} at ${location}: ${res.body}`);
  }
});

// ── same_day_cutoff_passed (DAY-U10, ruling (c)) ─────────────────────────────

// Tuesday 2026-06-02 in CDT, so 07:30 Chicago is 12:30Z.
const TODAY = '2026-06-02';
const TOMORROW = '2026-06-03';

test(
  'today at 07:29:59 books; today at 07:30:00 is 422 same_day_cutoff_passed',
  SKIP_WHEN_NO_DB,
  async () => {
    const before = await book(appAt(at('2026-06-02T12:29:59Z')), {
      lead_dog_id: await createFundedDog(createdDogIds),
      dates: [TODAY],
    });
    assert.equal(before.statusCode, 201, before.body);

    const dogId = await createFundedDog(createdDogIds);
    const after = await book(appAt(at('2026-06-02T12:30:00Z')), {
      lead_dog_id: dogId,
      dates: [TODAY],
    });
    assert.equal(after.statusCode, 422, after.body);
    assert.equal(after.code, 'same_day_cutoff_passed');
    assert.equal(await bookedRows(dogId), 0);
    assert.equal(await debits(dogId), 0);
  },
);

test('tomorrow at 20:00 books: the cutoff binds today only', SKIP_WHEN_NO_DB, async () => {
  const res = await book(appAt(at('2026-06-03T01:00:00Z')), {
    lead_dog_id: await createFundedDog(createdDogIds),
    dates: [TOMORROW],
  });
  assert.equal(res.statusCode, 201, res.body);
});

test(
  'one date of two is today past the cutoff: the whole request is refused',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogIds);
    const res = await book(appAt(at('2026-06-02T15:00:00Z')), {
      lead_dog_id: dogId,
      dates: [TOMORROW, TODAY],
    });
    assert.equal(res.code, 'same_day_cutoff_passed');
    assert.equal(await bookedRows(dogId), 0);
  },
);

test(
  'the cutoff is the campus setting: Bentonville at 09:00 takes an 08:00 booking',
  SKIP_WHEN_NO_DB,
  async () => {
    await setCampusSettings('bentonville', { sameDayCutoffTime: '09:00' });
    const now = appAt(at('2026-06-02T13:00:00Z'));
    const open = await book(now, {
      lead_dog_id: await createFundedDog(createdDogIds),
      dates: [TODAY],
    });
    assert.equal(open.statusCode, 201, open.body);
    const fay = await book(now, {
      location: 'fayetteville',
      lead_dog_id: await createFundedDog(createdDogIds),
      dates: [TODAY],
    });
    assert.equal(fay.code, 'same_day_cutoff_passed', 'Fayetteville kept its 07:30');
  },
);

// ── a replay outlives every clock (ruling (a)) ───────────────────────────────

test(
  'booked at 07:29, replayed at 07:31 with its key: the stored 201, no second debit',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogIds);
    const key = `replay-${randomUUID()}`;
    const first = await book(
      appAt(at('2026-06-02T12:29:00Z')),
      { lead_dog_id: dogId, dates: [TODAY] },
      key,
    );
    assert.equal(first.statusCode, 201, first.body);

    const replay = await book(
      appAt(at('2026-06-02T12:31:00Z')),
      { lead_dog_id: dogId, dates: [TODAY] },
      key,
    );
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(JSON.parse(replay.body), JSON.parse(first.body));
    assert.equal(await debits(dogId), 1);
    assert.equal(await bookedRows(dogId), 1);
  },
);

test(
  'the past-date check has the same trap: a replay the day after is the stored 201',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogIds);
    const key = `replay-${randomUUID()}`;
    const first = await book(
      appAt(at('2026-06-02T12:00:00Z')),
      { lead_dog_id: dogId, dates: [TODAY] },
      key,
    );
    assert.equal(first.statusCode, 201, first.body);
    const replay = await book(
      appAt(at('2026-06-03T12:00:00Z')),
      { lead_dog_id: dogId, dates: [TODAY] },
      key,
    );
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(JSON.parse(replay.body), JSON.parse(first.body));
    assert.equal(await debits(dogId), 1);
  },
);

test('a replay after the horizon setting moves is the stored 201', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createFundedDog(createdDogIds);
  const key = `replay-${randomUUID()}`;
  const app = appAt(FIXTURE_NOW);
  const first = await book(app, { lead_dog_id: dogId, dates: ['2026-08-19'] }, key);
  assert.equal(first.statusCode, 201, first.body);
  await setGlobalSettings({ bookingHorizonMonths: 1 });
  const replay = await book(app, { lead_dog_id: dogId, dates: ['2026-08-19'] }, key);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(await debits(dogId), 1);
});

test('a date in the past on a new key is still 422 invalid_payload', SKIP_WHEN_NO_DB, async () => {
  const res = await book(appAt(at('2026-06-03T12:00:00Z')), {
    lead_dog_id: await createFundedDog(createdDogIds),
    dates: [TODAY],
  });
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.code, 'invalid_payload');
});

// ── beyond_booking_horizon (DAY-U10, ruling (d)) ─────────────────────────────

test(
  'the last bookable date books; the day after is 422 beyond_booking_horizon',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = appAt(FIXTURE_NOW); // Tue 19 May 2026, so the last date is Wed 19 Aug
    const last = await book(app, {
      lead_dog_id: await createFundedDog(createdDogIds),
      dates: ['2026-08-19'],
    });
    assert.equal(last.statusCode, 201, last.body);

    const dogId = await createFundedDog(createdDogIds);
    const past = await book(app, { lead_dog_id: dogId, dates: ['2026-08-20'] });
    assert.equal(past.statusCode, 422, past.body);
    assert.equal(past.code, 'beyond_booking_horizon');
    assert.equal(await bookedRows(dogId), 0);
    assert.equal(await debits(dogId), 0);
  },
);

test('30 Nov + 3 months lands on 28 Feb, not 2 Mar', SKIP_WHEN_NO_DB, async () => {
  await setCampusSettings('bentonville', { openWeekdaysList: [1, 2, 3, 4, 5, 6, 7] });
  const app = appAt(at('2026-11-30T18:00:00Z'));
  const past = await book(app, {
    lead_dog_id: await createFundedDog(createdDogIds),
    dates: ['2027-03-01'],
  });
  assert.equal(past.code, 'beyond_booking_horizon');
  const last = await book(app, {
    lead_dog_id: await createFundedDog(createdDogIds),
    dates: ['2027-02-28'],
  });
  assert.equal(last.statusCode, 201, last.body);
});

test('setting the horizon to 1 moves it with no release', SKIP_WHEN_NO_DB, async () => {
  await setGlobalSettings({ bookingHorizonMonths: 1 });
  const app = appAt(FIXTURE_NOW);
  const last = await book(app, {
    lead_dog_id: await createFundedDog(createdDogIds),
    dates: ['2026-06-19'],
  });
  assert.equal(last.statusCode, 201, last.body);
  const past = await book(app, {
    lead_dog_id: await createFundedDog(createdDogIds),
    dates: ['2026-06-22'],
  });
  assert.equal(past.code, 'beyond_booking_horizon');
});

// ── the order inside the transaction (ruling (b)) ────────────────────────────

test(
  'the campus speaks before the horizon, and the horizon before the cutoff',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = appAt(at('2026-06-02T15:00:00Z'));
    const dogId = await createFundedDog(createdDogIds);
    const notOffered = await book(app, {
      category: 'day-care',
      location: 'fayetteville',
      lead_dog_id: dogId,
      dates: [TODAY, '2026-12-01'],
    });
    assert.equal(notOffered.code, 'program_not_offered');

    const beyond = await book(app, { lead_dog_id: dogId, dates: [TODAY, '2026-12-01'] });
    assert.equal(beyond.code, 'beyond_booking_horizon');
  },
);

test(
  'the three refusals come before the gates: a dog with no credits still hears the clock',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogIds);
    const res = await book(appAt(at('2026-06-02T15:00:00Z')), {
      lead_dog_id: dogId,
      dates: [TODAY],
    });
    assert.equal(res.code, 'same_day_cutoff_passed');
  },
);

test(
  'the roster ceiling comes before ownership: a hostile roster costs one read',
  SKIP_WHEN_NO_DB,
  async () => {
    const res = await book(appAt(FIXTURE_NOW), {
      lead_dog_id: randomUUID(),
      additional_dog_ids: Array.from({ length: 5 }, () => randomUUID()),
      dates: ['2026-06-16'],
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.code, 'invalid_payload');
  },
);

// ── the roster, read at runtime (ruling (e)) ─────────────────────────────────

test(
  'a sixth dog with the setting at 5 is refused; raising it to 6 books her',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = appAt(FIXTURE_NOW);
    const six: string[] = [];
    for (let i = 0; i < 6; i += 1) six.push(await createFundedDog(createdDogIds));
    const [lead, ...additional] = six as [string, ...string[]];
    const payload = { lead_dog_id: lead, additional_dog_ids: additional, dates: ['2026-06-16'] };

    const refused = await book(app, payload);
    assert.equal(refused.statusCode, 422, refused.body);
    assert.equal(refused.code, 'invalid_payload');

    await setGlobalSettings({ maxDogsPerBookingCount: 6 });
    const booked = await book(app, payload);
    assert.equal(booked.statusCode, 201, booked.body);
    for (const dogId of six) assert.equal(await debits(dogId), 1);
  },
);

test(
  'the hostile-body ceiling stays: a hundred additional dogs is 400',
  SKIP_WHEN_NO_DB,
  async () => {
    await setGlobalSettings({ maxDogsPerBookingCount: 1000 });
    const res = await book(appAt(FIXTURE_NOW), {
      lead_dog_id: randomUUID(),
      additional_dog_ids: Array.from({ length: 100 }, () => randomUUID()),
      dates: ['2026-06-16'],
    });
    assert.equal(res.statusCode, 400, res.body);
  },
);

// ── POST /requests, PATCH /requests/:id, POST /enrollments ───────────────────

const LAST_REQUEST_DATE = '2026-08-19T23:00:00-05:00'; // 19 Aug in Chicago
const PAST_THE_HORIZON = '2026-08-20T15:00:00Z';

async function requestBoarding(
  app: App,
  preferred: string,
  key = `req-${randomUUID()}`,
): Promise<Result & { id: string | undefined }> {
  const res = await app.inject({
    method: 'POST',
    url: '/requests',
    headers: { 'idempotency-key': key },
    payload: {
      category: 'private-lesson',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      preferred_dates: [preferred],
    },
  });
  const parsed = JSON.parse(res.body) as { id?: string };
  if (parsed.id !== undefined) createdRequestIds.push(parsed.id);
  return { ...result(res), id: parsed.id };
}

test(
  'POST /requests: the last date is accepted, one past it is 422 beyond_booking_horizon',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = appAt(FIXTURE_NOW);
    const last = await requestBoarding(app, LAST_REQUEST_DATE);
    assert.equal(last.statusCode, 201, last.body);
    const past = await requestBoarding(app, PAST_THE_HORIZON);
    assert.equal(past.statusCode, 422, past.body);
    assert.equal(past.code, 'beyond_booking_horizon');
  },
);

test(
  'PATCH /requests/:id past the horizon: 422 beyond_booking_horizon, the row keeps its dates',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = appAt(FIXTURE_NOW);
    const made = await requestBoarding(app, '2026-07-15T15:00:00Z');
    assert.equal(made.statusCode, 201, made.body);
    const res = await app.inject({
      method: 'PATCH',
      url: `/requests/${made.id}`,
      headers: { 'idempotency-key': `req-${randomUUID()}` },
      payload: { preferred_dates: [PAST_THE_HORIZON] },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(result(res).code, 'beyond_booking_horizon');
    const read = await app.inject({ method: 'GET', url: `/requests/${made.id}` });
    assert.deepEqual((read.json() as { preferred_dates: unknown[] }).preferred_dates.length, 1);
    assert.match(read.body, /2026-07-15/);
  },
);

test(
  'POST /requests replays past its own preferred date: the stored 201',
  SKIP_WHEN_NO_DB,
  async () => {
    const key = `req-${randomUUID()}`;
    const first = await requestBoarding(appAt(FIXTURE_NOW), '2026-06-15T15:00:00Z', key);
    assert.equal(first.statusCode, 201, first.body);
    const replay = await requestBoarding(
      appAt(at('2026-06-16T15:00:00Z')),
      '2026-06-15T15:00:00Z',
      key,
    );
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.id, first.id);
  },
);

async function enroll(
  startDate: string,
  allowPartial: boolean,
): Promise<{ res: Result; stripeCalls: number; filled: number | undefined }> {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  const cohortId = randomUUID();
  await db.insert(cohorts).values({
    id: cohortId,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate,
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks: 6,
    capacity: 6,
    filled: 0,
  });
  const response = await app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `enr-${randomUUID()}` },
    payload: {
      cohort_id: cohortId,
      dog_ids: [FIXTURE_IDS.dog1Id],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      ...(allowPartial ? { allow_partial: true } : {}),
    },
  });
  const [row] = await db
    .select({ filled: cohorts.filled })
    .from(cohorts)
    .where(eq(cohorts.id, cohortId));
  return { res: result(response), stripeCalls: stripe.calls.length, filled: row?.filled };
}

for (const allowPartial of [false, true]) {
  test(
    `POST /enrollments with allow_partial ${allowPartial}: a cohort past the horizon is 422, no Stripe call`,
    SKIP_WHEN_NO_DB,
    async () => {
      const { res, stripeCalls, filled } = await enroll('2026-08-20T23:00:00Z', allowPartial);
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(res.code, 'beyond_booking_horizon');
      assert.equal(stripeCalls, 0);
      assert.equal(filled, 0);
    },
  );
}

test(
  'POST /enrollments: a six-week class starting inside the horizon stays bookable past it',
  SKIP_WHEN_NO_DB,
  async () => {
    // Starts 18 Aug, five weeks of sessions land past the 19 Aug horizon.
    const { res } = await enroll('2026-08-18T23:00:00Z', false);
    assert.equal(res.statusCode === 422 && res.code === 'beyond_booking_horizon', false, res.body);
  },
);
