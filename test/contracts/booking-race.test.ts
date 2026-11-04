import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings,
  creditLedger,
  dogVaccines,
  dogs,
  invoices,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import {
  clearInvoiceChargeAttempts,
  futureWeekday,
  FIXTURE_IDS,
  FIXTURE_NOW,
  topUpCredits,
} from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * P12 fix round 1: a dog is in one place on a day. Two concurrent `POST /bookings`
 * for one dog and one day leave one booking and move money once, whatever their
 * mode or campus.
 *
 * Every round races two real requests against the real Postgres, and each test
 * tallies the whole outcome per round: the statuses, the bookings, and the money.
 * A key that carried the campus lets R1, R4 and R5 through; one that carried the
 * mode lets R3 through as well. R0 and R2 are the controls: those two never raced,
 * because the same campus shares the `capacity:<location>:<date>` lock.
 */

const ROUNDS = 20;

// After EACH test, not once per file: the fixture's hooks run per file, so one
// test's seats would otherwise fill a later test's dates and turn its refusal
// into `insufficient_capacity`. It also clears these dogs ahead of
// teardownFixture, whose wipe by owner their no-action FKs would block.
const createdDogIds: string[] = [];
afterEach(async () => {
  if (createdDogIds.length === 0) return;
  const dogIds = createdDogIds.splice(0);
  const bookingIds = (
    await db.select({ id: bookings.id }).from(bookings).where(inArray(bookings.leadDogId, dogIds))
  ).map((r) => r.id);
  if (bookingIds.length > 0) {
    await db
      .delete(scheduledNotifications)
      .where(inArray(scheduledNotifications.bookingId, bookingIds));
    await clearInvoiceChargeAttempts();
    await db.delete(invoices).where(inArray(invoices.bookingId, bookingIds));
    await db.delete(creditLedger).where(inArray(creditLedger.bookingId, bookingIds));
  }
  await db.delete(scheduledNotifications).where(inArray(scheduledNotifications.dogId, dogIds));
  await db.delete(creditLedger).where(inArray(creditLedger.dogId, dogIds));
  if (bookingIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.id, bookingIds)); // booking_dogs CASCADE
  }
  await db.delete(dogVaccines).where(inArray(dogVaccines.dogId, dogIds));
  await db.delete(dogs).where(inArray(dogs.id, dogIds));
});

registerFixtureHooks();

function ownerApp(): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

type App = ReturnType<typeof ownerApp>;
type Post = { statusCode: number; body: string };

/** A fixture-owned dog that passes every gate. */
async function createTestDog(): Promise<string> {
  const dogId = randomUUID();
  createdDogIds.push(dogId);
  await db.insert(dogs).values({
    id: dogId,
    ownerId: FIXTURE_IDS.ownerId,
    name: `Race ${dogId.slice(0, 8)}`,
    breed: 'Test Breed',
    birthdate: '2023-01-01',
    evaluationStatus: 'passed',
  });
  // Vaccines are checked by a trigger on the real clock, so the expiry is too.
  const expiresAt = new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db
    .insert(dogVaccines)
    .values(
      [FIXTURE_IDS.requiredVaccineRabiesKey, FIXTURE_IDS.requiredVaccineBordetellaKey].map(
        (requirementKey) => ({ dogId, name: requirementKey, requirementKey, expiresAt }),
      ),
    );
  return dogId;
}

/** Credits in both modes at both campuses: no refusal here is about the balance. */
async function createFundedDog(): Promise<string> {
  const dogId = await createTestDog();
  for (const location of ['fayetteville', 'bentonville'] as const) {
    await topUpCredits(dogId, 'school', 5, location);
    await topUpCredits(dogId, 'daycare', 5, location);
  }
  return dogId;
}

async function postBooking(app: App, payload: Record<string, unknown>): Promise<Post> {
  const res = await app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `race-${randomUUID()}` },
    payload,
  });
  return { statusCode: res.statusCode, body: res.body };
}

/** The two statuses, sorted so a round reads the same whichever request won. */
function statusesOf(a: Post, b: Post): string {
  const label = (r: Post): string => {
    if (r.statusCode !== 422) return String(r.statusCode);
    const { error } = JSON.parse(r.body) as { error: { code: string } };
    return `422 ${error.code}`;
  };
  return [label(a), label(b)].sort().join(' + ');
}

async function debitsOf(dogId: string): Promise<number> {
  const rows = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.dogId, dogId), eq(creditLedger.reason, 'booking-debit')));
  return rows.length;
}

async function upcomingBookingIds(dogIds: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(inArray(bookings.leadDogId, dogIds), eq(bookings.status, 'upcoming')));
  return rows.map((r) => r.id);
}

async function openInvoicesOf(bookingIds: string[]): Promise<number> {
  if (bookingIds.length === 0) return 0;
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(inArray(invoices.bookingId, bookingIds), eq(invoices.status, 'open')));
  return rows.length;
}

/** Runs `round` ROUNDS times and returns how many rounds ended each way. */
async function tally(round: (i: number) => Promise<string>): Promise<Record<string, number>> {
  const seen: Record<string, number> = {};
  for (let i = 0; i < ROUNDS; i += 1) {
    const outcome = await round(i);
    seen[outcome] = (seen[outcome] ?? 0) + 1;
  }
  return seen;
}

const ONE_WINNER = '201 + 422 already_booked';

const SCENARIOS = [
  {
    name: 'R0 control: same mode, same campus',
    a: { category: 'day-school', location: 'fayetteville' },
    b: { category: 'day-school', location: 'fayetteville' },
  },
  {
    name: 'R1: same mode, two campuses',
    a: { category: 'day-school', location: 'fayetteville' },
    b: { category: 'day-school', location: 'bentonville' },
  },
  {
    name: 'R2 control: school + care, one campus',
    a: { category: 'day-school', location: 'bentonville' },
    b: { category: 'day-care', location: 'bentonville' },
  },
  {
    name: 'R3: school + care, two campuses',
    a: { category: 'day-school', location: 'fayetteville' },
    b: { category: 'day-care', location: 'bentonville' },
  },
];

for (const { name, a, b } of SCENARIOS) {
  test(`${name}: one dog, one day: one booking, one credit`, SKIP_WHEN_NO_DB, async () => {
    const app = ownerApp();
    const rounds = await tally(async (i) => {
      const dogId = await createFundedDog();
      const date = futureWeekday(40 + i);
      const [ra, rb] = await Promise.all([
        postBooking(app, { ...a, lead_dog_id: dogId, dates: [date] }),
        postBooking(app, { ...b, lead_dog_id: dogId, dates: [date] }),
      ]);
      const booked = (await upcomingBookingIds([dogId])).length;
      return `${statusesOf(ra, rb)}; bookings ${booked}; debits ${await debitsOf(dogId)}`;
    });
    assert.deepEqual(rounds, { [`${ONE_WINNER}; bookings 1; debits 1`]: ROUNDS });
  });
}

test(
  'R4: two-dog rosters in opposite order, two campuses, cross-mode: no deadlock, one winner',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = ownerApp();
    const rounds = await tally(async (i) => {
      const dogA = await createFundedDog();
      const dogB = await createFundedDog();
      const date = futureWeekday(10 + i);
      const [ra, rb] = await Promise.all([
        postBooking(app, {
          category: 'day-school',
          location: 'fayetteville',
          lead_dog_id: dogA,
          additional_dog_ids: [dogB],
          dates: [date],
        }),
        postBooking(app, {
          category: 'day-care',
          location: 'bentonville',
          lead_dog_id: dogB,
          additional_dog_ids: [dogA],
          dates: [date],
        }),
      ]);
      const booked = (await upcomingBookingIds([dogA, dogB])).length;
      const debits = `${await debitsOf(dogA)}/${await debitsOf(dogB)}`;
      return `${statusesOf(ra, rb)}; bookings ${booked}; debits ${debits}`;
    });
    // A deadlock is Postgres aborting one transaction: a 500, so a different key here.
    assert.deepEqual(rounds, { [`${ONE_WINNER}; bookings 1; debits 1/1`]: ROUNDS });
  },
);

test(
  'R5: PAYG, one dog, one day, two campuses: one booking, one open invoice, no credit',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = ownerApp();
    const rounds = await tally(async (i) => {
      const dogId = await createTestDog();
      const base = {
        category: 'day-school',
        lead_dog_id: dogId,
        dates: [futureWeekday(10 + i)],
        payment: 'payg',
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      };
      const [ra, rb] = await Promise.all([
        postBooking(app, { ...base, location: 'fayetteville' }),
        postBooking(app, { ...base, location: 'bentonville' }),
      ]);
      const ids = await upcomingBookingIds([dogId]);
      const open = await openInvoicesOf(ids);
      return `${statusesOf(ra, rb)}; bookings ${ids.length}; open invoices ${open}; debits ${await debitsOf(dogId)}`;
    });
    assert.deepEqual(rounds, { [`${ONE_WINNER}; bookings 1; open invoices 1; debits 0`]: ROUNDS });
  },
);

test(
  'R6 control: one dog, two DIFFERENT days, two campuses: both book, the lock only queues them',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = ownerApp();
    const rounds = await tally(async (i) => {
      const dogId = await createFundedDog();
      const [ra, rb] = await Promise.all([
        postBooking(app, {
          category: 'day-school',
          location: 'fayetteville',
          lead_dog_id: dogId,
          dates: [futureWeekday(10 + i)],
        }),
        postBooking(app, {
          category: 'day-care',
          location: 'bentonville',
          lead_dog_id: dogId,
          dates: [futureWeekday(31 + i)],
        }),
      ]);
      const booked = (await upcomingBookingIds([dogId])).length;
      return `${statusesOf(ra, rb)}; bookings ${booked}; debits ${await debitsOf(dogId)}`;
    });
    assert.deepEqual(rounds, { '201 + 201; bookings 2; debits 2': ROUNDS });
  },
);
