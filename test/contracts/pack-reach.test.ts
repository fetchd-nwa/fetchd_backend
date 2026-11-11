import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings,
  charges,
  creditLedger,
  creditSettings,
  orders,
  stripeEvents,
} from '../../src/db/schema/schema.js';
import { expiryPaysDate } from '../../src/lib/creditPicker.js';
import { defaultStripeClient } from '../../src/lib/stripe.js';
import {
  initObservability,
  type AlarmEvent,
  type AlarmTransport,
} from '../../src/lib/observability.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffCreditPackagesRoute } from '../../src/routes/staffCreditPackages.js';
import { buildApp as buildProductionApp } from '../../src/server.js';
import type { PostBookingsResponse } from '../../src/contracts/wire.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, resetCatalogSeed } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { clearPlantedPools, insufficient, plantLot, refusalOf } from './_poolFixture.js';
import { signedIntentEvent, verifyingSignatures } from './_signedEvents.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * A pack is offered, and bought by a `top_up`, only if a lot of it bought now pays every
 * date of the shortfall (`designs/p18-pack-reach-and-moved-dates.md`; SIGNOFF.md:229-230,
 * "a credit pays only days up to its own date").
 *
 * The clock is November 2037, as `credit-picker.test.ts`'s is October, because
 * `lot_pays_date` reads Postgres's clock and no injected clock reaches it. 7 Nov 2037 is a
 * Saturday, as 7 Nov 2026 was in the note's example, so its dates hold.
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
  await db.delete(stripeEvents);
  await resetCatalogSeed();
  await db
    .update(creditSettings)
    .set({ expiryEnforcedEnabled: true, bookingOutlivesLotExpiryEnabled: false });
});

// Noon CST, Sat 7 Nov 2037.
const SATURDAY = new Date('2037-11-07T18:00:00Z');
const NOON_CST_7_DEC = '2037-12-07T18:00:00.000Z';
const NOON_CST_7_FEB = '2038-02-07T18:00:00.000Z';
/** Outlives this file's clock, which the fixture's 2036 lots do not: they pay nothing here. */
const LOT_OUTLIVES_THE_CLOCK = '2039-01-01T00:00:00.000Z';

const SINGLE = 'single-day-school-bentonville';
const TWO_X = 'school-2x-weekly-bentonville';
const THREE_X = 'school-3x-weekly-bentonville';
const FIVE_X = 'school-5x-weekly-bentonville';

/** The eight weekdays from Thu 17 to Mon 28 Dec. */
const LATE_DECEMBER = [
  '2037-12-17',
  '2037-12-18',
  '2037-12-21',
  '2037-12-22',
  '2037-12-23',
  '2037-12-24',
  '2037-12-25',
  '2037-12-28',
];
/** Twelve weekdays from Tue 8 Dec, every one past a lot bought today at 1 month. */
const TWELVE_DECEMBER_DAYS = [
  '2037-12-08',
  '2037-12-09',
  '2037-12-10',
  '2037-12-11',
  '2037-12-14',
  '2037-12-15',
  '2037-12-16',
  '2037-12-17',
  '2037-12-18',
  '2037-12-21',
  '2037-12-22',
  '2037-12-23',
];
/** Eight weekdays ending Mon 7 Dec, the day a lot bought on Sat 7 Nov at 1 month expires. */
const ENDING_ON_THE_EXPIRY_DAY = [
  '2037-11-26',
  '2037-11-27',
  '2037-11-30',
  '2037-12-01',
  '2037-12-02',
  '2037-12-03',
  '2037-12-04',
  '2037-12-07',
];
/** The same eight moved on one weekday, so the last is Tue 8 Dec. */
const ENDING_THE_DAY_AFTER = [...ENDING_ON_THE_EXPIRY_DAY.slice(1), '2037-12-08'];
/** Eight weekdays inside a month of Sat 7 Nov. */
const NEXT_TWO_WEEKS = [
  '2037-11-09',
  '2037-11-10',
  '2037-11-11',
  '2037-11-12',
  '2037-11-13',
  '2037-11-16',
  '2037-11-17',
  '2037-11-18',
];

function buildApp(capture?: ReturnType<typeof makeLogCapture>, at: Date = SATURDAY) {
  const owner = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  const stripe = verifyingSignatures(makeStripeStub());
  stripe.setIntentsCreatedAt(at);
  registerBookingsRoute(owner.app, { authenticate: owner.authenticate, stripe, now: () => at });
  const staff = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
  registerStaffCreditPackagesRoute(staff.app, {
    authenticate: staff.authenticate,
    now: () => at,
  });
  return { app: owner.app, staff: staff.app, stripe };
}

type World = ReturnType<typeof buildApp>;

/** What the portal allows: Shanthi's edit, over the route. */
async function setMonths(world: World, key: string, expiry_months: number): Promise<void> {
  const res = await world.staff.inject({
    method: 'PATCH',
    url: `/staff/credit-packages/${key}`,
    headers: { 'idempotency-key': `pack-reach-months-${randomUUID()}` },
    payload: { expiry_months },
  });
  assert.equal(res.statusCode, 200, res.body);
}

function book(
  world: World,
  dogId: string,
  dates: readonly string[],
  payment: object = { kind: 'credits' },
  overrides: object = {},
) {
  return world.app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `pack-reach-${randomUUID()}` },
    payload: {
      category: 'day-school',
      lead_dog_id: dogId,
      dates,
      location: 'bentonville',
      payment,
      ...overrides,
    },
  });
}

const topUp = (count: number, expected_total_cents: number, package_key?: string) => ({
  kind: 'credits',
  top_up: {
    count,
    payment_method_id: FIXTURE_IDS.paymentMethod1Id,
    expected_total_cents,
    ...(package_key !== undefined ? { package_key } : {}),
  },
});

const chargesOfOwner = () =>
  db
    .select()
    .from(charges)
    .where(and(eq(charges.ownerId, FIXTURE_IDS.ownerId), eq(charges.purpose, 'package')));

const rowsOf = (dogId: string) =>
  db
    .select()
    .from(bookings)
    .where(eq(bookings.leadDogId, dogId))
    .orderBy(asc(bookings.scheduledAt));

async function lotOf(chargeId: string) {
  const [lot] = await db
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.chargeId, chargeId), eq(creditLedger.reason, 'purchase')));
  assert.ok(lot, 'the charge bought a lot');
  return lot;
}

const debitsOn = (lotId: string) =>
  db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.lotId, lotId), eq(creditLedger.reason, 'booking-debit')));

async function assertNothingWritten(world: World, dogId: string): Promise<void> {
  assert.deepEqual(await chargesOfOwner(), [], 'no charges row');
  assert.deepEqual(await rowsOf(dogId), [], 'no booking');
  assert.equal(world.stripe.calls.length, 0, 'no Stripe call');
}

const EIGHT_SINGLES = {
  count: 8,
  unit_price_cents: 6_000,
  total_cents: 48_000,
  package_key: SINGLE,
};

/** Shanthi sets the single day to 3 months and leaves the 2x at 1, and Dana has no credits. */
async function danasCatalog(world: World): Promise<void> {
  await setMonths(world, SINGLE, 3);
}

// ── the one comparison ───────────────────────────────────────────────────────

test("a lot pays a date while it expires after that date's Chicago midnight, so never at it", () => {
  // Midnight Mon 16 Nov 2026, CST, is 06:00Z.
  const expiring = (iso: string): boolean => expiryPaysDate(new Date(iso), '2026-11-16');
  assert.equal(expiring('2026-11-16T15:40:00.000Z'), true, 'the expiry day itself counts');
  assert.equal(expiring('2026-11-16T06:00:00.001Z'), true);
  assert.equal(expiring('2026-11-16T06:00:00.000Z'), false, 'strict at midnight');
  assert.equal(expiring('2026-11-15T23:59:59.000Z'), false);
});

test("the midnight a lot is read against is the date's own, across a clock change", () => {
  // Mon 15 Mar 2027 is in CDT, so its midnight is 05:00Z, not 06:00Z.
  assert.equal(expiryPaysDate(new Date('2027-03-15T05:30:00.000Z'), '2027-03-15'), true);
});

// ── Dana ─────────────────────────────────────────────────────────────────────

test(
  'Dana, no credits, 8 days 17 to 28 Dec, single day at 3 months, 2x at 1: the 422 offers 8 single days and names no pack',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    await danasCatalog(world);
    const dogId = await createBookableDog(createdDogs);

    const details = insufficient(await book(world, dogId, LATE_DECEMBER));

    assert.equal(details.shortfall, 8);
    assert.deepEqual(details.top_up_offer, EIGHT_SINGLES);
    assert.equal(details.alternative_package_key, undefined, 'the 2x dies on 7 Dec');
    await assertNothingWritten(world, dogId);
  },
);

test(
  'a top_up.package_key for the 2x, an app holding an old offer: the fresh 422, the current offer, nothing written',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    await danasCatalog(world);
    const dogId = await createBookableDog(createdDogs);

    const details = insufficient(await book(world, dogId, LATE_DECEMBER, topUp(1, 45_600, TWO_X)));

    assert.equal(details.shortfall, 8);
    assert.deepEqual(details.top_up_offer, EIGHT_SINGLES);
    assert.equal(details.alternative_package_key, undefined);
    await assertNothingWritten(world, dogId);
  },
);

test(
  'and Yes on the single days: one $480.00 charge, one lot to 7 Feb that pays all 8, and no alarm',
  SKIP_WHEN_NO_DB,
  async () => {
    const capture = makeLogCapture();
    const world = buildApp(capture);
    await danasCatalog(world);
    const dogId = await createBookableDog(createdDogs);

    const res = await book(world, dogId, LATE_DECEMBER, topUp(8, 48_000));

    assert.equal(res.statusCode, 201, res.body);
    assert.equal((res.json() as PostBookingsResponse).order.charge_status, 'succeeded');
    const [charge] = await chargesOfOwner();
    assert.ok(charge);
    assert.equal(charge.amountCents, 48_000);
    const lot = await lotOf(charge.id);
    assert.equal(new Date(lot.expiresAt as string).toISOString(), NOON_CST_7_FEB);
    assert.equal((await debitsOn(lot.id)).length, 8);
    assert.deepEqual(
      capture.lines.filter((l) => l.level === 50),
      [],
      'every date is inside the lot',
    );
  },
);

test(
  'the smallest pack that covers and reaches is the one named: past a 3x that dies first, the 5x',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    await danasCatalog(world);
    await setMonths(world, TWO_X, 3);
    await setMonths(world, FIVE_X, 3);
    const dogId = await createBookableDog(createdDogs);

    const details = insufficient(await book(world, dogId, TWELVE_DECEMBER_DAYS));

    assert.equal(details.shortfall, 12);
    assert.equal(details.alternative_package_key, FIVE_X);
  },
);

test(
  'the filter runs first, so the threshold moves with it: the 2x gone, 8 short is under the 3x, and no pack is named',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    await danasCatalog(world);
    await setMonths(world, THREE_X, 3);
    const dogId = await createBookableDog(createdDogs);

    const details = insufficient(await book(world, dogId, LATE_DECEMBER));

    assert.equal(details.alternative_package_key, undefined);
    assert.deepEqual(details.top_up_offer, EIGHT_SINGLES);
  },
);

test(
  'a pack of the pool named from the first day is held to the same rule: the Day Care Package',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    await setMonths(world, 'single-day-daycare-bentonville', 3);
    const dogId = await createBookableDog(createdDogs);
    const dayCare = { category: 'day-care' };
    await plantLot({ credits: 2, expiresAt: LOT_OUTLIVES_THE_CLOCK, mode: 'daycare' });
    const short = (dates: string[]) =>
      book(world, dogId, ['2037-11-09', '2037-11-10', ...dates], { kind: 'credits' }, dayCare);

    const inside = insufficient(await short(['2037-11-11']));
    assert.equal(inside.alternative_package_key, 'daycare-10-bentonville');

    const past = insufficient(await short(['2037-12-17']));
    assert.equal(past.shortfall, 1);
    assert.equal(past.alternative_package_key, undefined);
  },
);

// ── a shortfall that straddles the pack's date: it must pay every one ───────

test(
  "eight days ending on the 2x's own expiry day: the expiry day counts, so it is named and buys them",
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    await danasCatalog(world);
    const dogId = await createBookableDog(createdDogs);

    const details = insufficient(await book(world, dogId, ENDING_ON_THE_EXPIRY_DAY));
    assert.equal(details.alternative_package_key, TWO_X);

    const bought = await book(world, dogId, ENDING_ON_THE_EXPIRY_DAY, topUp(1, 45_600, TWO_X));
    assert.equal(bought.statusCode, 201, bought.body);
  },
);

test(
  'eight days ending the day after: seven it could pay do not carry the eighth, so it is unnamed and refused',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    await danasCatalog(world);
    const dogId = await createBookableDog(createdDogs);

    const details = insufficient(await book(world, dogId, ENDING_THE_DAY_AFTER));
    assert.equal(details.alternative_package_key, undefined);
    assert.deepEqual(details.top_up_offer, EIGHT_SINGLES);

    const refused = insufficient(
      await book(world, dogId, ENDING_THE_DAY_AFTER, topUp(1, 45_600, TWO_X)),
    );
    assert.equal(refused.shortfall, 8);
    await assertNothingWritten(world, dogId);
  },
);

// ── a partly covered booking: `dates` is the dates of `picked.short` ─────────

test(
  'partly covered, the shortfall past the 2x: her credit pays November, and the 8 left short keep the pack unnamed',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    await danasCatalog(world);
    const dogId = await createBookableDog(createdDogs);
    await plantLot({ credits: 1, expiresAt: LOT_OUTLIVES_THE_CLOCK });

    const details = insufficient(await book(world, dogId, ['2037-11-16', ...LATE_DECEMBER]));

    assert.deepEqual(
      details.short_dates.map((d) => d.date),
      LATE_DECEMBER,
    );
    assert.deepEqual(details.top_up_offer, EIGHT_SINGLES);
    assert.equal(details.alternative_package_key, undefined);
  },
);

test(
  'partly covered, a day past the 2x already paid: only the short days are judged, so the 2x is named and buys them',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    const dogId = await createBookableDog(createdDogs);
    // Every row at 1 month, so 21 Dec is past a credit bought today and the lot pays it first.
    await plantLot({ credits: 1, expiresAt: LOT_OUTLIVES_THE_CLOCK });
    const dates = [...NEXT_TWO_WEEKS, '2037-12-21'];

    const details = insufficient(await book(world, dogId, dates));

    assert.deepEqual(
      details.short_dates.map((d) => d.date),
      NEXT_TWO_WEEKS,
    );
    assert.equal(details.alternative_package_key, TWO_X);

    const bought = await book(world, dogId, dates, topUp(1, 45_600, TWO_X));
    assert.equal(bought.statusCode, 201, bought.body);
  },
);

// ── what does not move ───────────────────────────────────────────────────────

for (const [name, setting] of [
  ['expiry off', { expiryEnforcedEnabled: false }],
  ['outliving on', { bookingOutlivesLotExpiryEnabled: true }],
] as const) {
  test(
    `with ${name} no reach applies: the 2x is named as before and buys the days, and nothing alarms`,
    SKIP_WHEN_NO_DB,
    async () => {
      await db.update(creditSettings).set(setting);
      const capture = makeLogCapture();
      const world = buildApp(capture);
      await danasCatalog(world);
      const dogId = await createBookableDog(createdDogs);

      const details = insufficient(await book(world, dogId, LATE_DECEMBER));
      assert.equal(details.alternative_package_key, TWO_X);

      const bought = await book(world, dogId, LATE_DECEMBER, topUp(1, 45_600, TWO_X));
      assert.equal(bought.statusCode, 201, bought.body);
      const [charge] = await chargesOfOwner();
      assert.ok(charge);
      assert.equal(
        new Date((await lotOf(charge.id)).expiresAt as string).toISOString(),
        NOON_CST_7_DEC,
      );
      assert.deepEqual(
        capture.lines.filter((l) => l.level === 50),
        [],
        'with no reach, a date past the lot is no fault',
      );
    },
  );
}

test(
  'a seeded catalog, every row at 1 month: the 2x is named and bought on dates inside it',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    const dogId = await createBookableDog(createdDogs);

    const details = insufficient(await book(world, dogId, NEXT_TWO_WEEKS));
    assert.equal(details.shortfall, 8);
    assert.equal(details.alternative_package_key, TWO_X);

    const bought = await book(world, dogId, NEXT_TWO_WEEKS, topUp(1, 45_600, TWO_X));
    assert.equal(bought.statusCode, 201, bought.body);
  },
);

test(
  'a seeded catalog on dates past it: the refusal it always was, with the reach of a credit bought today',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    const dogId = await createBookableDog(createdDogs);
    const refused = refusalOf<{ dates: string[]; expires_at: string }>(
      await book(world, dogId, LATE_DECEMBER),
      'credit_expired_before_date',
    );
    assert.deepEqual(refused.dates, LATE_DECEMBER);
    assert.equal(refused.expires_at, NOON_CST_7_DEC);
  },
);

test(
  'a pack longer than the single day does not extend the reach that greys a date',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = buildApp();
    await setMonths(world, TWO_X, 3);
    const dogId = await createBookableDog(createdDogs);
    const refused = refusalOf<{ dates: string[] }>(
      await book(world, dogId, LATE_DECEMBER, topUp(1, 45_600, TWO_X)),
      'credit_expired_before_date',
    );
    assert.deepEqual(refused.dates, LATE_DECEMBER);
    assert.deepEqual(await chargesOfOwner(), []);
  },
);

// ── the alarm: what the offer's check cannot reach ───────────────────────────

/** Records what the pager was asked to send. */
function recordingTransport(): AlarmTransport & { events: AlarmEvent[] } {
  const events: AlarmEvent[] = [];
  return {
    events,
    send(event: AlarmEvent): Promise<void> {
      events.push(event);
      return Promise.resolve();
    },
  };
}

/** A top-up that fit at tx1 and is still `processing`. */
async function takenOffer(world: World, dogId: string) {
  world.stripe.setNextIntentStatus('processing');
  const res = await book(world, dogId, LATE_DECEMBER, topUp(1, 45_600, TWO_X));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as PostBookingsResponse).order.client_action, 'processing');
  const [charge] = await chargesOfOwner();
  assert.ok(charge?.stripePaymentIntentId);
  return { chargeId: charge.id, intentId: charge.stripePaymentIntentId };
}

test(
  'buildApp(), a real signed event: a same-day correction under a taken offer pages once, and the money and the booking stand',
  SKIP_WHEN_NO_DB,
  async (t) => {
    const world = buildApp();
    await setMonths(world, SINGLE, 3);
    await setMonths(world, TWO_X, 3);
    const dogId = await createBookableDog(createdDogs);
    const { chargeId, intentId } = await takenOffer(world, dogId);

    // Opened today, so this corrects the row the charge names in place.
    await setMonths(world, TWO_X, 1);
    world.stripe.setIntentState(intentId, 'succeeded');

    const transport = recordingTransport();
    initObservability({ transport, installProcessHandlers: false });
    // The production route table, logger and signature check. Only the one verb that would
    // leave this machine answers from the stub.
    t.mock.method(defaultStripeClient, 'retrievePaymentIntent', world.stripe.retrievePaymentIntent);
    const app = buildProductionApp();
    const event = signedIntentEvent({
      type: 'payment_intent.succeeded',
      intentId,
      ...world.stripe.intentSnapshot(intentId),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
      payload: event.payload,
    });
    await app.close();

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().outcome, 'order-settled');
    const [charge] = await db.select().from(charges).where(eq(charges.id, chargeId));
    assert.equal(charge?.status, 'succeeded', 'the money stands');
    assert.deepEqual(
      (await rowsOf(dogId)).map((r) => r.status),
      LATE_DECEMBER.map(() => 'upcoming'),
      'the booking stands',
    );
    const lot = await lotOf(chargeId);
    assert.equal(new Date(lot.expiresAt as string).toISOString(), NOON_CST_7_DEC);
    assert.equal((await debitsOn(lot.id)).length, 8, 'the lot paid them, past its date');

    assert.equal(transport.events.length, 1, JSON.stringify(transport.events));
    const page = transport.events[0];
    assert.ok(page);
    assert.equal(page.level, 'error', 'pino level 50');
    const extra = page.extra as Record<string, unknown>;
    assert.equal(extra['chargeId'], chargeId);
    assert.deepEqual(extra['dates'], LATE_DECEMBER);
    assert.equal(extra['reqId'] !== undefined, true, "the page carries the route logger's reqId");
  },
);

test(
  'two clocks that disagree: an intent created before tx1 stamps the lot short, and a person hears once',
  SKIP_WHEN_NO_DB,
  async () => {
    const capture = makeLogCapture();
    const world = buildApp(capture);
    await setMonths(world, SINGLE, 3);
    await setMonths(world, TWO_X, 3);
    const dogId = await createBookableDog(createdDogs);
    // Two months behind ours, so a 3-month lot dies on 7 Dec.
    world.stripe.setIntentsCreatedAt(new Date('2037-09-07T17:00:00Z'));

    const res = await book(world, dogId, LATE_DECEMBER, topUp(1, 45_600, TWO_X));

    assert.equal(res.statusCode, 201, res.body);
    const [charge] = await chargesOfOwner();
    assert.equal(charge?.status, 'succeeded');
    const alarms = capture.lines.filter((l) => l.level === 50 && l.chargeId === charge?.id);
    assert.equal(alarms.length, 1, 'one log, not one per day');
    assert.deepEqual(alarms[0]?.dates, LATE_DECEMBER);
  },
);

// ── the whole-second floor, both sides (Fable r2 N2; P19 fix 1 F2) ───────────

test(
  'a top-up in the first second after a Chicago midnight is refused for the date a month out: the lot it would buy is stamped at 00:00:00 and dies at that midnight (Fable r2 N2)',
  SKIP_WHEN_NO_DB,
  async () => {
    // 00:00:00.400 CST Sat 7 Nov 2037. Stripe's `created` is whole seconds, so an intent
    // created in this second says 00:00:00, and the settle stamps the lot from it (design
    // §2.4:3003): a single day's month then ends at 00:00:00 CST Mon 7 Dec, the Chicago
    // midnight of the date she asks for, which it therefore cannot pay. Before the floor
    // this sold and paged a person (`redfirst-B3b.log`); the sale through a real webhook is
    // the next test's, one second later.
    const at = new Date('2037-11-07T06:00:00.400Z');
    const world = buildApp(undefined, at);
    const dogId = await createBookableDog(createdDogs);

    const res = await book(world, dogId, ['2037-12-07'], topUp(1, 6_000));

    const details = refusalOf<{ dates: string[] }>(res, 'credit_expired_before_date');
    assert.deepEqual(details.dates, ['2037-12-07']);
    await assertNothingWritten(world, dogId);
  },
);

test(
  'buildApp(), a real signed event: a top-up at 00:00:01.000 CST for the date a month out sells, its lot pays that date, and no one is paged (the floor is one second wide, not wider)',
  SKIP_WHEN_NO_DB,
  async (t) => {
    // Fable's probe (P19 review L1). The bound the refusal above needs: a floor any wider
    // than the whole second would refuse this sale too.
    const at = new Date('2037-11-07T06:00:01.000Z');
    const world = buildApp(undefined, at);
    const dogId = await createBookableDog(createdDogs);
    const transport = recordingTransport();
    initObservability({ transport, installProcessHandlers: false });

    world.stripe.setNextIntentStatus('processing');
    const res = await book(world, dogId, ['2037-12-07'], topUp(1, 6_000));
    assert.equal(res.statusCode, 201, res.body);

    const [charge] = await chargesOfOwner();
    assert.ok(charge?.stripePaymentIntentId);
    const intentId = charge.stripePaymentIntentId;
    world.stripe.setIntentState(intentId, 'succeeded');
    t.mock.method(defaultStripeClient, 'retrievePaymentIntent', world.stripe.retrievePaymentIntent);
    const app = buildProductionApp();
    const event = signedIntentEvent({
      type: 'payment_intent.succeeded',
      intentId,
      ...world.stripe.intentSnapshot(intentId),
    });
    const hook = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
      payload: event.payload,
    });
    await app.close();
    assert.equal(hook.statusCode, 200, hook.body);

    const lot = await lotOf(charge.id);
    assert.equal(
      new Date(lot.expiresAt as string).toISOString(),
      '2037-12-07T06:00:01.000Z',
      'stamped from the whole second',
    );
    assert.equal((await debitsOn(lot.id)).length, 1, 'the lot paid 7 Dec');
    assert.equal((await rowsOf(dogId)).length, 1, 'one row booked');
    assert.deepEqual(
      transport.events.map((e) => [e.level, e.extra]),
      [],
      'nothing tx1 sold dies before a date it was sold for, so the pager is silent',
    );
  },
);

test(
  "with no credits, a booking in the first second after a Chicago midnight is told no credit reaches the date a month out, which is true: a lot bought in that second is stamped at the second, and a lot pays a date only while it expires after that date's midnight (Opus L2)",
  SKIP_WHEN_NO_DB,
  async () => {
    // A credits-only booking, no top-up: what an M1 family sees, since she buys in the
    // shop and then books. HEAD answered `insufficient_credits` here, which offered a
    // single day that, bought in this second, would not reach 7 Dec.
    const dogId = await createBookableDog(createdDogs);

    const inTheFirstSecond = buildApp(undefined, new Date('2037-11-07T06:00:00.100Z'));
    const refused = refusalOf<{ dates: string[] }>(
      await book(inTheFirstSecond, dogId, ['2037-12-07']),
      'credit_expired_before_date',
    );
    assert.deepEqual(refused.dates, ['2037-12-07']);
    await assertNothingWritten(inTheFirstSecond, dogId);

    // One second later a credit bought now does reach it, so she is told what is short.
    const aSecondLater = buildApp(undefined, new Date('2037-11-07T06:00:01.000Z'));
    const short = insufficient(await book(aSecondLater, dogId, ['2037-12-07']));
    assert.equal(short.shortfall, 1);
    await assertNothingWritten(aSecondLater, dogId);
  },
);
