import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { bookings, creditLedger, creditSettings, orders } from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import type {
  CreditExpiredBeforeDateDetails,
  PostBookingsResponse,
} from '../../src/contracts/wire.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, FIXTURE_LOT_EXPIRES_AT, FIXTURE_NOW, futureWeekday } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import {
  clearPlantedPools,
  insufficient,
  plantLot,
  poolBalance,
  refusalOf,
} from './_poolFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * The two-pass picker (design §2.3:2631-2659, §2.4:2899-2915; CRED-U12). `lot_pays_date`
 * reads Postgres's clock and no injected clock reaches it, so the fixed clocks here sit in
 * October 2037, past any real date a run can have. 19 Oct 2037 is a Monday, as 19 Oct 2026
 * was in the design's worked example, so the example's dates hold.
 */

const createdDogs: string[] = [];
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
  await db.update(creditSettings).set({
    expiryEnforcedEnabled: true,
    bookingOutlivesLotExpiryEnabled: false,
    returnedCreditExpiryMonths: 1,
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
// 09:40 CDT, Mon 19 Oct 2037.
const LOT_I_EXPIRES = '2037-10-19T14:40:00.000Z';

function buildApp(now: () => Date) {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerBookingsRoute(app, { authenticate, stripe, now });
  return { app, stripe };
}

type App = ReturnType<typeof buildApp>['app'];

function book(
  app: App,
  dogId: string,
  dates: readonly string[],
  payment: object = { kind: 'credits' },
) {
  return app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `picker-${randomUUID()}` },
    payload: {
      category: 'day-school',
      lead_dog_id: dogId,
      dates,
      location: 'bentonville',
      payment,
    },
  });
}

async function debitsByDate(dogId: string): Promise<Record<string, string | null>> {
  const rows = await db
    .select({ date: bookings.scheduledAt, lotId: creditLedger.lotId })
    .from(creditLedger)
    .innerJoin(bookings, eq(bookings.id, creditLedger.bookingId))
    .where(and(eq(creditLedger.dogId, dogId), eq(creditLedger.reason, 'booking-debit')))
    .orderBy(asc(bookings.scheduledAt));
  return Object.fromEntries(rows.map((r) => [r.date.slice(0, 10), r.lotId]));
}

test(
  'a lot stamped yesterday is counted in no balance and picked for no date',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    await plantLot({ credits: 3, expiresAt: new Date(Date.now() - DAY_MS) });
    const { app } = buildApp(FIXTURE_NOW);
    const dates = [futureWeekday(0), futureWeekday(1)];

    const details = insufficient(await book(app, dogId, dates));

    assert.equal(await poolBalance(), 0, 'in no balance');
    assert.deepEqual(details.gaps, [
      { location: 'bentonville', mode: 'school', tier: 'regular', balance: 0, required: 2 },
    ]);
    assert.equal(details.shortfall, 2, 'picked for no date');
  },
);

test(
  'a lot expiring Mon 19 Oct 09:40 pays Mon 19 and not Tue 20: she is short one, and told why',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    await plantLot({ credits: 2, expiresAt: LOT_I_EXPIRES });
    // Sat 17 Oct 18:00 CDT.
    const { app } = buildApp(() => new Date('2037-10-17T23:00:00Z'));

    const details = insufficient(await book(app, dogId, ['2037-10-19', '2037-10-20']));

    assert.deepEqual(details.gaps, [
      { location: 'bentonville', mode: 'school', tier: 'regular', balance: 2, required: 2 },
    ]);
    assert.equal(details.shortfall, 1);
    assert.deepEqual(details.short_dates, [
      { date: '2037-10-20', reason: 'credits_expire_first', expires_at: LOT_I_EXPIRES },
    ]);
    assert.equal(details.top_up_offer?.count, 1);
  },
);

test(
  'the same lot pays the Monday alone: the expiry day itself still counts',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 2, expiresAt: LOT_I_EXPIRES });
    const { app } = buildApp(() => new Date('2037-10-17T23:00:00Z'));

    const res = await book(app, dogId, ['2037-10-19']);

    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(await debitsByDate(dogId), { '2037-10-19': lotId });
  },
);

test(
  'a date past every lot that a credit bought today reaches gets the offer; one no credit reaches is refused with the date',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    const expiresAt = '2037-10-03T17:00:00.000Z';
    await plantLot({ credits: 1, expiresAt });
    // Thu 1 Oct: a credit bought now lasts to 1 Nov.
    const { app } = buildApp(() => new Date('2037-10-01T17:00:00Z'));

    const reachable = insufficient(await book(app, dogId, ['2037-10-20']));
    assert.equal(reachable.shortfall, 1);
    assert.deepEqual(reachable.short_dates, [
      { date: '2037-10-20', reason: 'credits_expire_first', expires_at: expiresAt },
    ]);

    const refused = refusalOf<CreditExpiredBeforeDateDetails>(
      await book(app, dogId, ['2037-10-20', '2037-11-12']),
      'credit_expired_before_date',
    );
    assert.deepEqual(refused.dates, ['2037-11-12']);
    assert.equal(refused.expires_at, expiresAt, 'the latest expiry among her live lots');
  },
);

test(
  'with no live lot, a date no credit reaches is refused with the reach of a credit bought today',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    const { app } = buildApp(() => new Date('2037-10-01T17:00:00Z'));
    const refused = refusalOf<CreditExpiredBeforeDateDetails>(
      await book(app, dogId, ['2037-11-12']),
      'credit_expired_before_date',
    );
    assert.deepEqual(refused.dates, ['2037-11-12']);
    // One Chicago month from noon CDT is noon CST: the clocks went back that morning.
    assert.equal(refused.expires_at, '2037-11-01T18:00:00.000Z');
  },
);

const LOT_P_EXPIRES = '2038-01-07T01:00:00.000Z'; // Wed 6 Jan 2038 19:00 CST
const EIGHT_OCTOBER_DAYS = [
  '2037-10-08',
  '2037-10-09',
  '2037-10-12',
  '2037-10-13',
  '2037-10-14',
  '2037-10-15',
  '2037-10-16',
  '2037-10-19',
];

test(
  'lot P, 8 credits, nine dates ending 14 Dec: the far date goes first, so she is one short and never refused',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    await plantLot({ credits: 8, expiresAt: LOT_P_EXPIRES });
    // Tue 6 Oct 19:30 CDT.
    const { app } = buildApp(() => new Date('2037-10-07T00:30:00Z'));

    const details = insufficient(await book(app, dogId, [...EIGHT_OCTOBER_DAYS, '2037-12-14']));

    assert.equal(details.shortfall, 1);
    assert.deepEqual(details.short_dates, [{ date: '2037-10-19', reason: 'no_credit' }]);
  },
);

test(
  'and Yes: the single day pays Mon 19 Oct, and lot P pays 14 Dec',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    const lotP = await plantLot({ credits: 8, expiresAt: LOT_P_EXPIRES });
    const { app } = buildApp(() => new Date('2037-10-07T00:30:00Z'));

    const res = await book(app, dogId, [...EIGHT_OCTOBER_DAYS, '2037-12-14'], {
      kind: 'credits',
      top_up: {
        count: 1,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        expected_total_cents: 6_000,
      },
    });

    assert.equal(res.statusCode, 201, res.body);
    assert.equal((res.json() as PostBookingsResponse).order.charge_status, 'succeeded');
    const paid = await debitsByDate(dogId);
    assert.equal(paid['2037-12-14'], lotP, 'lot P pays 14 Dec');
    assert.notEqual(paid['2037-10-19'], lotP, 'the bought day pays Mon 19 Oct');
    assert.notEqual(paid['2037-10-19'], null);
  },
);

test('credits spend the soonest-expiring lot that pays the date', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createBookableDog(createdDogs);
  const later = await plantLot({ credits: 1, expiresAt: '2037-12-01T17:00:00.000Z' });
  const sooner = await plantLot({ credits: 1, expiresAt: '2037-11-01T17:00:00.000Z' });
  const { app } = buildApp(() => new Date('2037-10-07T00:30:00Z'));

  const res = await book(app, dogId, ['2037-10-08']);

  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(await debitsByDate(dogId), { '2037-10-08': sooner });
  assert.notEqual(sooner, later);
});

test('two dogs on one date spend two credits of one pool', SKIP_WHEN_NO_DB, async () => {
  const [lead, second] = [
    await createBookableDog(createdDogs),
    await createBookableDog(createdDogs),
  ];
  await plantLot({ credits: 1, expiresAt: FIXTURE_LOT_EXPIRES_AT });
  const { app } = buildApp(FIXTURE_NOW);
  const date = futureWeekday(0);

  const details = insufficient(
    await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `picker-${randomUUID()}` },
      payload: {
        category: 'day-school',
        lead_dog_id: lead,
        additional_dog_ids: [second],
        dates: [date],
        location: 'bentonville',
        payment: { kind: 'credits' },
      },
    }),
  );
  assert.equal(details.shortfall, 1);
  assert.deepEqual(details.short_dates, [{ date, reason: 'no_credit' }]);
  assert.deepEqual(details.gaps, [
    { location: 'bentonville', mode: 'school', tier: 'regular', balance: 1, required: 2 },
  ]);
});

test(
  'with the switch false a lot stamped yesterday pays a date next week',
  SKIP_WHEN_NO_DB,
  async () => {
    await db.update(creditSettings).set({ expiryEnforcedEnabled: false });
    const dogId = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 1, expiresAt: new Date(Date.now() - DAY_MS) });
    const { app } = buildApp(() => new Date('2037-10-07T00:30:00Z'));

    const res = await book(app, dogId, ['2037-10-14']);

    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(await debitsByDate(dogId), { '2037-10-14': lotId });
  },
);

test(
  'with outliving true the Mon 19 Oct lot pays Tue 20, and nothing answers credit_expired_before_date',
  SKIP_WHEN_NO_DB,
  async () => {
    await db.update(creditSettings).set({ bookingOutlivesLotExpiryEnabled: true });
    const dogId = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 1, expiresAt: LOT_I_EXPIRES });
    const { app } = buildApp(() => new Date('2037-10-17T23:00:00Z'));

    const paid = await book(app, dogId, ['2037-10-20']);
    assert.equal(paid.statusCode, 201, paid.body);
    assert.deepEqual(await debitsByDate(dogId), { '2037-10-20': lotId });

    // No lot left, and a date a month's reach would miss: a shortfall, never the refusal.
    const details = insufficient(await book(app, dogId, ['2037-12-30']));
    assert.equal(details.shortfall, 1);
  },
);

test('a lot whose date is moved later is live again', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createBookableDog(createdDogs);
  const lotId = await plantLot({ credits: 1, expiresAt: new Date(Date.now() - DAY_MS) });
  assert.equal(await poolBalance(), 0);
  await db
    .update(creditLedger)
    .set({ expiresAt: FIXTURE_LOT_EXPIRES_AT })
    .where(eq(creditLedger.id, lotId));
  assert.equal(await poolBalance(), 1);

  const { app } = buildApp(FIXTURE_NOW);
  const res = await book(app, dogId, [futureWeekday(0)]);
  assert.equal(res.statusCode, 201, res.body);
});

// ── a return (CRED-U16; design §2.4:2955-2974) ───────────────────────────────

async function cancelBooking(app: App, bookingId: string) {
  return app.inject({
    method: 'POST',
    url: `/bookings/${bookingId}/cancel`,
    headers: { 'idempotency-key': `picker-cancel-${randomUUID()}` },
  });
}

async function returnRow(bookingId: string) {
  const [row] = await db
    .select({ lotId: creditLedger.lotId, expiresAt: creditLedger.expiresAt })
    .from(creditLedger)
    .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'cancel-refund')));
  assert.ok(row, 'the credit came back');
  return row;
}

test(
  'a cancel returns to its lot, with its date, while that lot can pay a later date',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 1, expiresAt: LOT_P_EXPIRES });
    const { app } = buildApp(() => new Date('2037-10-07T00:30:00Z'));
    const res = await book(app, dogId, ['2037-10-14']);
    assert.equal(res.statusCode, 201, res.body);
    const bookingId = (res.json() as PostBookingsResponse).sessions[0]?.id as string;

    const cancelled = await cancelBooking(app, bookingId);
    assert.equal(cancelled.statusCode, 200, cancelled.body);

    const row = await returnRow(bookingId);
    assert.equal(row.lotId, lotId);
    assert.equal(row.expiresAt, null, 'it keeps its lot`s date');
  },
);

test(
  'a lot that can pay no later date takes the return as a fresh lot, cred.returned_credit_expiry_months out',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    // Lives past Tue 20, then dies: alive, and paying no date after today once it is Tue 20.
    const lotId = await plantLot({ credits: 1, expiresAt: '2037-10-20T20:00:00.000Z' });
    const { app } = buildApp(() => new Date('2037-10-07T00:30:00Z'));
    const res = await book(app, dogId, ['2037-10-20']);
    assert.equal(res.statusCode, 201, res.body);
    const bookingId = (res.json() as PostBookingsResponse).sessions[0]?.id as string;

    // Tue 20 Oct 09:00 CDT, the lot's own last day: it pays no date after today.
    const { app: later } = buildApp(() => new Date('2037-10-20T14:00:00Z'));
    await db
      .update(bookings)
      .set({ cancelDeadlineAt: '2037-10-20T20:00:00.000Z' })
      .where(eq(bookings.id, bookingId));
    const cancelled = await cancelBooking(later, bookingId);
    assert.equal(cancelled.statusCode, 200, cancelled.body);

    const row = await returnRow(bookingId);
    assert.equal(row.lotId, null, 'one row with lot_id NULL');
    assert.equal(
      new Date(row.expiresAt as string).toISOString(),
      '2037-11-20T15:00:00.000Z',
      'one Chicago month from the return: 09:00 CDT becomes 09:00 CST',
    );
    assert.notEqual(lotId, null);
  },
);

test(
  'a fresh lot from a return is dated by cred.returned_credit_expiry_months, read at the return',
  SKIP_WHEN_NO_DB,
  async () => {
    await db.update(creditSettings).set({ returnedCreditExpiryMonths: 3 });
    const dogId = await createBookableDog(createdDogs);
    await plantLot({ credits: 1, expiresAt: '2037-10-20T20:00:00.000Z' });
    const { app } = buildApp(() => new Date('2037-10-07T00:30:00Z'));
    const res = await book(app, dogId, ['2037-10-20']);
    assert.equal(res.statusCode, 201, res.body);
    const bookingId = (res.json() as PostBookingsResponse).sessions[0]?.id as string;

    const { app: later } = buildApp(() => new Date('2037-10-20T14:00:00Z'));
    await db
      .update(bookings)
      .set({ cancelDeadlineAt: '2037-10-20T20:00:00.000Z' })
      .where(eq(bookings.id, bookingId));
    const cancelled = await cancelBooking(later, bookingId);
    assert.equal(cancelled.statusCode, 200, cancelled.body);

    const row = await returnRow(bookingId);
    assert.equal(row.lotId, null);
    assert.equal(
      new Date(row.expiresAt as string).toISOString(),
      '2038-01-20T15:00:00.000Z',
      'three Chicago months from the return: 09:00 CDT becomes 09:00 CST',
    );
  },
);

test(
  'with cred.returned_credit_expiry_months 0, the return goes into the old lot, its date passed',
  SKIP_WHEN_NO_DB,
  async () => {
    await db.update(creditSettings).set({ returnedCreditExpiryMonths: 0 });
    const dogId = await createBookableDog(createdDogs);
    const lotId = await plantLot({ credits: 1, expiresAt: '2037-10-20T20:00:00.000Z' });
    const { app } = buildApp(() => new Date('2037-10-07T00:30:00Z'));
    const res = await book(app, dogId, ['2037-10-20']);
    assert.equal(res.statusCode, 201, res.body);
    const bookingId = (res.json() as PostBookingsResponse).sessions[0]?.id as string;

    const { app: later } = buildApp(() => new Date('2037-10-20T14:00:00Z'));
    await db
      .update(bookings)
      .set({ cancelDeadlineAt: '2037-10-20T20:00:00.000Z' })
      .where(eq(bookings.id, bookingId));
    const cancelled = await cancelBooking(later, bookingId);
    assert.equal(cancelled.statusCode, 200, cancelled.body);

    const row = await returnRow(bookingId);
    assert.equal(row.lotId, lotId);
    assert.equal(row.expiresAt, null);
  },
);

test(
  'a debit names its dog, and every dog of a booking gets her own debit',
  SKIP_WHEN_NO_DB,
  async () => {
    const [lead, second] = [
      await createBookableDog(createdDogs),
      await createBookableDog(createdDogs),
    ];
    await plantLot({ credits: 2, expiresAt: FIXTURE_LOT_EXPIRES_AT });
    const { app } = buildApp(FIXTURE_NOW);
    const res = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `picker-${randomUUID()}` },
      payload: {
        category: 'day-school',
        lead_dog_id: lead,
        additional_dog_ids: [second],
        dates: [futureWeekday(0)],
        location: 'bentonville',
        payment: { kind: 'credits' },
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const debits = await db
      .select({ dogId: creditLedger.dogId })
      .from(creditLedger)
      .where(
        and(
          inArray(creditLedger.dogId, [lead as string, second as string]),
          eq(creditLedger.reason, 'booking-debit'),
        ),
      );
    assert.equal(debits.length, 2);
    assert.equal(new Set(debits.map((d) => d.dogId)).size, 2);
  },
);
