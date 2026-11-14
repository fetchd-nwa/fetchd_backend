import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import {
  bookings,
  charges,
  creditLedger,
  creditPackages,
  dogs,
  invoices,
  notifications,
  orders,
  scheduledNotifications,
  stripeEvents,
} from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { deepLinkToPath, type PostBookingsResponse } from '../../src/contracts/wire.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import {
  FIXTURE_IDS,
  FIXTURE_LOT_EXPIRES_AT,
  FIXTURE_NOW,
  FIXTURE_TODAY,
  futureWeekday,
} from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { QUIET_LOG, clearOrderRows } from './_orderFixture.js';
import {
  clearPlantedPools,
  insufficient,
  plantLot,
  poolBalance,
  waitForBlockedBackends,
} from './_poolFixture.js';
import { signedIntentEvent, verifyingSignatures } from './_signedEvents.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * The live top-up: "buy N more?" inside `POST /bookings` (design §2.3:2613-2703,
 * §2.7:4061-4099; PAY-U09, CRED-U12). A short Confirm's *Yes* is one order and one charge,
 * and a decline books nothing and returns every debit.
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
  await db.update(dogs).set({ isAlumni: false }).where(inArray(dogs.id, createdDogs));
});

function buildApp(capture?: ReturnType<typeof makeLogCapture>) {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  const stripe = verifyingSignatures(makeStripeStub());
  registerBookingsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

type App = ReturnType<typeof buildApp>['app'];

const weekdays = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => futureWeekday(i));

function bodyFor(
  dogId: string,
  dates: readonly string[],
  payment: object = { kind: 'credits' },
  overrides: object = {},
) {
  return {
    category: 'day-school',
    lead_dog_id: dogId,
    dates,
    location: 'bentonville',
    payment,
    ...overrides,
  };
}

function post(app: App, payload: object, key = `top-up-${randomUUID()}`) {
  return app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': key },
    payload,
  });
}

const topUp = (count: number, expected_total_cents: number, extra: object = {}) => ({
  kind: 'credits',
  top_up: {
    count,
    payment_method_id: FIXTURE_IDS.paymentMethod1Id,
    expected_total_cents,
    ...extra,
  },
});

async function dogWithCredits(credits: number): Promise<string> {
  const dogId = await createBookableDog(createdDogs);
  if (credits > 0) await plantLot({ credits, expiresAt: FIXTURE_LOT_EXPIRES_AT });
  return dogId;
}

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

async function assertNothingCharged(dogId: string): Promise<void> {
  assert.deepEqual(await chargesOfOwner(), [], 'no charges row');
  assert.deepEqual(await rowsOf(dogId), [], 'no booking');
}

async function singleDayRow(key = 'single-day-school-bentonville') {
  const [row] = await db.select().from(creditPackages).where(eq(creditPackages.key, key));
  assert.ok(row);
  return row;
}

function deliverEvent(
  app: App,
  stripe: StripeStub,
  type: Parameters<typeof signedIntentEvent>[0]['type'],
  intentId: string,
) {
  const event = signedIntentEvent({ type, intentId, ...stripe.intentSnapshot(intentId) });
  return app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
    payload: event.payload,
  });
}

function deliverSucceeded(app: App, stripe: StripeStub, intentId: string) {
  return deliverEvent(app, stripe, 'payment_intent.succeeded', intentId);
}

// ── the offer ────────────────────────────────────────────────────────────────

test(
  '5 dates with 4 credits and no top_up: 422 with top_up_offer.count = 1',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const dogId = await dogWithCredits(4);
    const dates = weekdays(5);

    const details = insufficient(await post(app, bodyFor(dogId, dates)));

    assert.deepEqual(details.gaps, [
      { location: 'bentonville', mode: 'school', tier: 'regular', balance: 4, required: 5 },
    ]);
    assert.equal(details.shortfall, 1);
    assert.deepEqual(details.short_dates, [{ date: dates[4], reason: 'no_credit' }]);
    assert.deepEqual(details.top_up_offer, {
      count: 1,
      unit_price_cents: 6_000,
      total_cents: 6_000,
      package_key: 'single-day-school-bentonville',
    });
    assert.equal('alternative_package_key' in details, false, 'one short reaches no pack');
    await assertNothingCharged(dogId);
    assert.equal(await poolBalance(), 4, 'No books nothing and charges nothing');
  },
);

for (const [shortfall, have, named] of [
  [8, 0, 'school-2x-weekly-bentonville'],
  [9, 0, 'school-3x-weekly-bentonville'],
  [13, 0, 'school-5x-weekly-bentonville'],
] as const) {
  test(
    `${shortfall} short at Bentonville names ${named}: the smallest pack that covers it`,
    SKIP_WHEN_NO_DB,
    async () => {
      const { app } = buildApp();
      const dogId = await dogWithCredits(have);
      const details = insufficient(await post(app, bodyFor(dogId, weekdays(shortfall))));
      assert.equal(details.alternative_package_key, named);
    },
  );
}

test(
  'a daycare shortfall is offered the daycare single day, with the Day Care Package beside it',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const dogId = await createBookableDog(createdDogs);
    // The fixture's 2 Bentonville daycare credits.
    const details = insufficient(
      await post(app, bodyFor(dogId, weekdays(3), { kind: 'credits' }, { category: 'day-care' })),
    );
    assert.deepEqual(details.top_up_offer, {
      count: 1,
      unit_price_cents: 3_500,
      total_cents: 3_500,
      package_key: 'single-day-daycare-bentonville',
    });
    assert.equal(details.alternative_package_key, 'daycare-10-bentonville');
  },
);

// ── Yes ──────────────────────────────────────────────────────────────────────

test(
  '7 credits, 8 dates, Yes: one $60.00 charge, one lot of 1 already spent, 8 rows upcoming, 0 credits',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(7);
    const dates = weekdays(8);

    const res = await post(app, bodyFor(dogId, dates, topUp(1, 6_000)));

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as PostBookingsResponse;
    assert.equal(body.order.charge_status, 'succeeded');
    assert.deepEqual(
      body.sessions.map((s) => s.status),
      Array.from({ length: 8 }, () => 'upcoming'),
    );

    const [charge, ...moreCharges] = await chargesOfOwner();
    assert.equal(moreCharges.length, 0, 'one charge');
    assert.equal(charge?.amountCents, 6_000);
    assert.equal(charge?.status, 'succeeded');
    assert.equal(charge?.packageId, (await singleDayRow()).id);
    assert.equal(charge?.creditsCount, 1);

    const lots = await db
      .select()
      .from(creditLedger)
      .where(
        and(eq(creditLedger.chargeId, charge?.id as string), eq(creditLedger.reason, 'purchase')),
      );
    assert.equal(lots.length, 1, 'one lot');
    assert.equal(lots[0]?.delta, 1);
    const spent = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.lotId, lots[0]?.id as string));
    assert.equal(spent.length, 1, 'already spent');
    assert.equal(await poolBalance(), 0, '0 credits');
    assert.deepEqual(
      (await rowsOf(dogId)).map((r) => r.status),
      Array.from({ length: 8 }, () => 'upcoming'),
    );
    assert.equal(stripe.executedConfirms().length, 1);

    const paid = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.ownerId, FIXTURE_IDS.ownerId), eq(invoices.status, 'paid')));
    assert.equal(paid.length, 1, 'one paid invoice');
    assert.equal(paid[0]?.packageId, charge?.packageId);
  },
);

test('a decline: 402, 0 rows booked, and the 4 debits returned', SKIP_WHEN_NO_DB, async () => {
  const { app, stripe } = buildApp();
  const dogId = await dogWithCredits(4);
  stripe.setNextIntentThrowsCardError('requires_payment_method', 'card_declined');

  const res = await post(app, bodyFor(dogId, weekdays(5), topUp(1, 6_000)));

  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().error.code, 'payment_failed');
  const rows = await rowsOf(dogId);
  assert.ok(rows.length > 0, 'the rows were held, then cancelled');
  assert.deepEqual(
    rows.filter((r) => r.status !== 'cancelled'),
    [],
    '0 rows booked',
  );
  assert.equal(await poolBalance(), 4, 'the 4 debits came back');
  const lots = await db
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.ownerId, FIXTURE_IDS.ownerId), eq(creditLedger.reason, 'purchase')));
  assert.equal(lots.filter((l) => l.chargeId !== null).length, 0, 'nothing granted');
});

test(
  'processing: rows payment-pending, client_action processing, then the webhook grants, debits and flips them',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(1);
    stripe.setNextIntentStatus('processing');

    const res = await post(app, bodyFor(dogId, weekdays(2), topUp(1, 6_000)));

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as PostBookingsResponse;
    assert.equal(body.order.charge_status, 'requires_payment');
    assert.equal(body.order.client_action, 'processing');
    assert.deepEqual(
      body.sessions.map((s) => s.status),
      ['payment-pending', 'payment-pending'],
    );

    const [charge] = await chargesOfOwner();
    const intentId = charge?.stripePaymentIntentId as string;
    stripe.setIntentState(intentId, 'succeeded');
    const settled = await deliverSucceeded(app, stripe, intentId);
    assert.equal(settled.statusCode, 200, settled.body);

    assert.deepEqual(
      (await rowsOf(dogId)).map((r) => r.status),
      ['upcoming', 'upcoming'],
    );
    assert.equal(await poolBalance(), 0);
  },
);

test(
  'a daycare shortfall sent with package_key: one charge, the pack granted, the days booked from it, its other credits left',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const dogId = await createBookableDog(createdDogs);
    const res = await post(
      app,
      bodyFor(dogId, weekdays(3), topUp(1, 35_000, { package_key: 'daycare-10-bentonville' }), {
        category: 'day-care',
      }),
    );
    assert.equal(res.statusCode, 201, res.body);
    const [charge, ...more] = await chargesOfOwner();
    assert.equal(more.length, 0);
    assert.equal(charge?.amountCents, 35_000);
    assert.equal(charge?.creditsCount, 10);
    assert.equal(await poolBalance({ mode: 'daycare' }), 9, '2 + 10 − 3');
  },
);

// ── alumni ───────────────────────────────────────────────────────────────────

test(
  'an alumni shortfall takes the regular single day: one regular lot, each debit naming its own lot',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const dogId = await createBookableDog(createdDogs);
    await db.update(dogs).set({ isAlumni: true }).where(eq(dogs.id, dogId));
    const alumniLot = await plantLot({
      credits: 1,
      expiresAt: FIXTURE_LOT_EXPIRES_AT,
      location: 'fayetteville',
      tier: 'alumni',
    });
    const dates = weekdays(2);
    const payment = { kind: 'credits', tier: 'alumni' };
    const where = { location: 'fayetteville' };

    const details = insufficient(await post(app, bodyFor(dogId, dates, payment, where)));
    assert.equal(details.top_up_offer?.package_key, 'single-day-school-fayetteville');
    assert.equal(details.alternative_package_key, 'school-alumni-10-fayetteville');
    assert.deepEqual(details.gaps, [
      { location: 'fayetteville', mode: 'school', tier: 'alumni', balance: 1, required: 2 },
    ]);

    const res = await post(
      app,
      bodyFor(dogId, dates, { ...topUp(1, 6_000), tier: 'alumni' }, where),
    );
    assert.equal(res.statusCode, 201, res.body);

    const [charge] = await chargesOfOwner();
    const [lot] = await db
      .select()
      .from(creditLedger)
      .where(
        and(eq(creditLedger.chargeId, charge?.id as string), eq(creditLedger.reason, 'purchase')),
      );
    assert.equal(lot?.tier, 'regular');
    const debits = await db
      .select({ lotId: creditLedger.lotId, tier: creditLedger.tier, dogId: creditLedger.dogId })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.ownerId, FIXTURE_IDS.ownerId),
          eq(creditLedger.reason, 'booking-debit'),
          eq(creditLedger.dogId, dogId),
        ),
      );
    assert.deepEqual(
      debits.map((d) => [d.lotId, d.tier]).sort(),
      [
        [alumniLot, 'alumni'],
        [lot?.id, 'regular'],
      ].sort(),
    );
  },
);

test('tier alumni on a dog that is not: 422, nothing written', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const dogId = await dogWithCredits(5);
  const res = await post(app, bodyFor(dogId, weekdays(1), { kind: 'credits', tier: 'alumni' }));
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.json().error.code, 'alumni_tier_requires_alumni_dog');
  await assertNothingCharged(dogId);
});

// ── a top_up that no longer fits writes nothing ──────────────────────────────

test(
  'a total that differs answers a fresh 422 with the real offer, no charges row, no Stripe call',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(1);
    const details = insufficient(await post(app, bodyFor(dogId, weekdays(2), topUp(1, 5_500))));
    assert.equal(details.top_up_offer?.total_cents, 6_000);
    await assertNothingCharged(dogId);
    assert.equal(stripe.calls.length, 0);
  },
);

test('a count above what the dates need answers 422 with count 1', SKIP_WHEN_NO_DB, async () => {
  const { app, stripe } = buildApp();
  const dogId = await dogWithCredits(1);
  const details = insufficient(await post(app, bodyFor(dogId, weekdays(2), topUp(2, 12_000))));
  assert.equal(details.top_up_offer?.count, 1);
  await assertNothingCharged(dogId);
  assert.equal(stripe.calls.length, 0);
});

test('a count below what the dates need answers 422 with count 2', SKIP_WHEN_NO_DB, async () => {
  const { app, stripe } = buildApp();
  const dogId = await dogWithCredits(1);
  const details = insufficient(await post(app, bodyFor(dogId, weekdays(3), topUp(1, 6_000))));
  assert.equal(details.top_up_offer?.count, 2);
  await assertNothingCharged(dogId);
  assert.equal(stripe.calls.length, 0);
});

test(
  'a credit hand-added before Yes: 422 with shortfall 0, offer null, gaps []',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(2);
    const details = insufficient(await post(app, bodyFor(dogId, weekdays(2), topUp(1, 6_000))));
    assert.equal(details.shortfall, 0);
    assert.equal(details.top_up_offer, null);
    assert.deepEqual(details.gaps, []);
    assert.deepEqual(details.short_dates, []);
    await assertNothingCharged(dogId);
    assert.equal(stripe.calls.length, 0);
  },
);

test(
  'a pack with fewer credits than the shortfall answers the same 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(0);
    const details = insufficient(
      await post(
        app,
        bodyFor(
          dogId,
          weekdays(9),
          topUp(1, 45_600, { package_key: 'school-2x-weekly-bentonville' }),
        ),
      ),
    );
    assert.equal(details.shortfall, 9);
    await assertNothingCharged(dogId);
    assert.equal(stripe.calls.length, 0);
  },
);

test('a package_key from another pool answers the same 422', SKIP_WHEN_NO_DB, async () => {
  const { app, stripe } = buildApp();
  const dogId = await dogWithCredits(1);
  const details = insufficient(
    await post(
      app,
      bodyFor(
        dogId,
        weekdays(2),
        topUp(1, 45_600, { package_key: 'school-2x-weekly-fayetteville' }),
      ),
    ),
  );
  assert.equal(details.shortfall, 1);
  await assertNothingCharged(dogId);
  assert.equal(stripe.calls.length, 0);
});

test(
  'a package_key of the same campus and another tier answers the same 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(0);
    const key = 'school-alumni-10-fayetteville';
    const [row] = await db.select().from(creditPackages).where(eq(creditPackages.key, key));
    assert.ok(row);
    const details = insufficient(
      await post(
        app,
        bodyFor(dogId, weekdays(6), topUp(1, row.priceCents, { package_key: key }), {
          location: 'fayetteville',
        }),
      ),
    );
    assert.equal(details.shortfall, 2, 'the fixture holds 4 Fayetteville credits');
    await assertNothingCharged(dogId);
    assert.equal(stripe.calls.length, 0);
  },
);

test('a card that is not hers is the generic 404', SKIP_WHEN_NO_DB, async () => {
  const { app, stripe } = buildApp();
  const dogId = await dogWithCredits(1);
  const res = await post(
    app,
    bodyFor(dogId, weekdays(2), {
      kind: 'credits',
      top_up: { count: 1, payment_method_id: randomUUID(), expected_total_cents: 6_000 },
    }),
  );
  assert.equal(res.statusCode, 404, res.body);
  await assertNothingCharged(dogId);
  assert.equal(stripe.calls.length, 0);
});

test(
  'a valid top_up on a held date answers already_booked, zero charges',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(1);
    const [held, other] = weekdays(2) as [string, string];
    const first = await post(app, bodyFor(dogId, [held]));
    assert.equal(first.statusCode, 201, first.body);
    // Held day spent the one credit, so a Yes for two dates is two short.
    const res = await post(app, bodyFor(dogId, [held, other], topUp(2, 12_000)));
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json().error.code, 'already_booked');
    assert.deepEqual(await chargesOfOwner(), [], 'zero charges');
    assert.equal(stripe.calls.length, 0);
  },
);

// ── Opus M2: a failure that took the rows down says the booking is gone ─────

const PAST_THE_LEASE = new Date(FIXTURE_TODAY.getTime() + 60 * 60 * 1000);

/**
 * P21 (`brief_must_say` 3; P18 185(b)): the notice says only what came back, as §2.9's
 * credit line for each landing, never "Any credits it used are back in your account",
 * which was false for a credit returned into a dead lot and for a `past` row's.
 */
const gone = (amount: string, credits = '') => ({
  declined: `Your ${amount} payment didn't go through, so you weren't charged and your booking is cancelled.${credits}`,
  cancelled: `Your booking and its ${amount} payment were cancelled, so you weren't charged.${credits}`,
});

/** §2.9's day and month, in Chicago, as every credit line prints a date. */
const shown = (at: Date | string) =>
  new Date(at).toLocaleDateString('en-GB', {
    timeZone: 'America/Chicago',
    day: 'numeric',
    month: 'short',
  });

/** The credit line for `n` credits back into `dogWithCredits`' lot. */
const back = (n: number) =>
  ` +${n} ${n === 1 ? 'credit' : 'credits'}, back to your Bentonville day-school credits (expires ${shown(FIXTURE_LOT_EXPIRES_AT)}).`;

/** What she is told: every failed-payment push queued to her, whichever trigger wrote it. */
const failurePushes = () =>
  db
    .select({
      trigger: scheduledNotifications.trigger,
      title: scheduledNotifications.title,
      body: scheduledNotifications.body,
    })
    .from(scheduledNotifications)
    .where(
      and(
        eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
        eq(scheduledNotifications.type, 'payment-failed'),
      ),
    );

const debitsOf = (dogId: string) =>
  db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.dogId, dogId), eq(creditLedger.reason, 'booking-debit')));

/** Yes on a card that answers `processing`: the screen she reads says Confirmed. */
async function processingTopUp(args: { credits: number; days: number; total: number }) {
  const world = buildApp();
  const dogId = await dogWithCredits(args.credits);
  world.stripe.setNextIntentStatus('processing');
  const res = await post(
    world.app,
    bodyFor(dogId, weekdays(args.days), topUp(args.days - args.credits, args.total)),
  );
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as PostBookingsResponse).order.client_action, 'processing');
  const [charge] = await chargesOfOwner();
  assert.ok(charge?.orderId);
  return {
    ...world,
    dogId,
    chargeId: charge.id,
    orderId: charge.orderId,
    intentId: charge.stripePaymentIntentId as string,
  };
}

async function assertRowsDown(dogId: string, days: number): Promise<void> {
  assert.deepEqual(
    (await rowsOf(dogId)).map((r) => r.status),
    Array.from({ length: days }, () => 'cancelled'),
    'every row came down',
  );
}

test(
  'Opus M2, the late decline: 7 credits, 8 days, Yes, processing, the bank declines, the sweeper takes all 8 down, and her one notice says the booking is gone',
  SKIP_WHEN_NO_DB,
  async () => {
    const world = await processingTopUp({ credits: 7, days: 8, total: 6_000 });
    const { app, stripe, dogId, intentId } = world;

    stripe.setIntentState(intentId, 'requires_payment_method', { failureCode: 'card_declined' });
    const advisory = await deliverEvent(app, stripe, 'payment_intent.payment_failed', intentId);
    assert.equal(advisory.statusCode, 200, advisory.body);
    assert.equal(advisory.json().outcome, 'order-advisory');
    assert.deepEqual(await failurePushes(), [], '`payment_failed` decides nothing');
    assert.deepEqual(
      (await rowsOf(dogId)).map((r) => r.status),
      Array.from({ length: 8 }, () => 'payment-pending'),
    );

    await runOrderSweeperOnce({ stripe, now: PAST_THE_LEASE, log: QUIET_LOG });

    await assertRowsDown(dogId, 8);
    assert.equal(await poolBalance(), 7, 'the 7 debits came back');
    assert.deepEqual(await failurePushes(), [
      {
        trigger: 'charge-failed',
        title: 'Booking cancelled',
        body: gone('$60.00', back(7)).declined,
      },
    ]);
  },
);

test(
  'Opus M2, the webhook road: Stripe says the intent is canceled, and she hears the booking is gone',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe, dogId, intentId } = await processingTopUp({
      credits: 1,
      days: 2,
      total: 6_000,
    });

    stripe.setIntentState(intentId, 'canceled');
    const hook = await deliverEvent(app, stripe, 'payment_intent.canceled', intentId);

    assert.equal(hook.statusCode, 200, hook.body);
    await assertRowsDown(dogId, 2);
    assert.equal(await poolBalance(), 1);
    assert.deepEqual(await failurePushes(), [
      { trigger: 'charge-failed', title: 'Booking cancelled', body: gone('$60.00', back(1)).declined },
    ]);
  },
);

test(
  'Opus M2, a top-up that used no credits: no debit to return, and the notice names no credit (P21)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { stripe, dogId, intentId } = await processingTopUp({
      credits: 0,
      days: 2,
      total: 12_000,
    });
    assert.deepEqual(await debitsOf(dogId), [], 'tx1 debited nothing: the top-up paid every day');

    stripe.setIntentState(intentId, 'requires_payment_method', { failureCode: 'card_declined' });
    await runOrderSweeperOnce({ stripe, now: PAST_THE_LEASE, log: QUIET_LOG });

    await assertRowsDown(dogId, 2);
    assert.equal(await poolBalance(), 0);
    assert.deepEqual(await failurePushes(), [
      { trigger: 'charge-failed', title: 'Booking cancelled', body: gone('$120.00').declined },
    ]);
  },
);

test(
  'P21 (brief_must_say 3): at cred.returned_credit_expiry_months 0, the paying lot dead at the failure → the notice carries §2.9\'s dead-lot line, never "back in your account"',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe, dogId, intentId } = await processingTopUp({
      credits: 1,
      days: 2,
      total: 6_000,
    });
    // The lot that paid the first day dies before the failure is reached: its date moved
    // by SQL to an hour ago (a hand edit's effect), so the return lands in a dead lot.
    const died = new Date(Date.now() - 60 * 60 * 1000);
    await db.execute(sql`
      UPDATE credit_ledger SET expires_at = ${died.toISOString()}
       WHERE owner_id = ${FIXTURE_IDS.ownerId} AND reason = 'purchase' AND note LIKE 'pool-fixture%'`);
    await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
    try {
      stripe.setIntentState(intentId, 'canceled');
      const hook = await deliverEvent(app, stripe, 'payment_intent.canceled', intentId);
      assert.equal(hook.statusCode, 200, hook.body);
      await assertRowsDown(dogId, 2);
      assert.deepEqual(await failurePushes(), [
        {
          trigger: 'charge-failed',
          title: 'Booking cancelled',
          body: gone(
            '$60.00',
            ` 1 credit came back, but its date, ${shown(died)}, has passed. Message us if you'd like it extended.`,
          ).declined,
        },
      ]);
    } finally {
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 1`);
    }
  },
);

test(
  'P21 (brief_must_say 3): a `past` row keeps its debit, so the notice names no credit for it (the row planted by SQL: no src writer of `past` exists, 185(b))',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe, dogId, intentId } = await processingTopUp({
      credits: 1,
      days: 2,
      total: 6_000,
    });
    const [paid] = await debitsOf(dogId);
    assert.ok(paid, 'the credit paid one day');
    const [debit] = await db
      .select({ bookingId: creditLedger.bookingId })
      .from(creditLedger)
      .where(eq(creditLedger.id, paid.id));
    await db.update(bookings).set({ status: 'past' }).where(eq(bookings.id, debit!.bookingId!));

    stripe.setIntentState(intentId, 'canceled');
    const hook = await deliverEvent(app, stripe, 'payment_intent.canceled', intentId);
    assert.equal(hook.statusCode, 200, hook.body);
    assert.deepEqual(
      (await rowsOf(dogId)).map((r) => r.status).sort(),
      ['cancelled', 'past'],
      'the past row stands, with its debit',
    );
    assert.equal(await poolBalance(), 0, 'nothing came back');
    assert.deepEqual(await failurePushes(), [
      { trigger: 'charge-failed', title: 'Booking cancelled', body: gone('$60.00').declined },
    ]);
  },
);

test(
  'Opus M2, abandoned at lease end: no card was tried, the rows came down, and she hears the booking is gone',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(1);
    stripe.nextCreateThrowsTransport(2);

    const res = await post(app, bodyFor(dogId, weekdays(2), topUp(1, 6_000)));
    assert.equal(res.statusCode, 409, res.body);
    const [charge] = await chargesOfOwner();
    assert.equal(charge?.stripePaymentIntentId, null, 'no intent id: no card was tried');

    await runOrderSweeperOnce({ stripe, now: PAST_THE_LEASE, log: QUIET_LOG });

    await assertRowsDown(dogId, 2);
    assert.equal(await poolBalance(), 1);
    assert.deepEqual(await failurePushes(), [
      { trigger: 'charge-failed', title: 'Booking cancelled', body: gone('$60.00', back(1)).declined },
    ]);
  },
);

test(
  'Opus M2, a decline on the request road after her phone stopped waiting: the notice says the booking is gone',
  SKIP_WHEN_NO_DB,
  async () => {
    const clock = { now: FIXTURE_TODAY };
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const stripe = makeStripeStub();
    registerBookingsRoute(app, { authenticate, stripe, now: () => clock.now });
    const dogId = await dogWithCredits(1);
    const confirm = stripe.holdNext('confirm');
    stripe.queueIntentOutcomes([
      { kind: 'cardError', status: 'requires_payment_method', code: 'card_declined' },
    ]);

    const pending = post(app, bodyFor(dogId, weekdays(2), topUp(1, 6_000)));
    await confirm.reached;
    clock.now = new Date(FIXTURE_TODAY.getTime() + 121_000);
    confirm.release();
    const res = await pending;

    assert.equal(res.statusCode, 402, res.body);
    await assertRowsDown(dogId, 2);
    assert.deepEqual(await failurePushes(), [
      { trigger: 'charge-failed', title: 'Booking cancelled', body: gone('$60.00', back(1)).declined },
    ]);
  },
);

test(
  'Opus M2, Cancel order Stripe confirms: the booking and its payment are both named as cancelled',
  SKIP_WHEN_NO_DB,
  async () => {
    const { stripe, dogId, intentId, orderId } = await processingTopUp({
      credits: 1,
      days: 2,
      total: 6_000,
    });
    const { app: staffApp, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffOrdersRoute(staffApp, { authenticate, stripe, now: FIXTURE_NOW });
    stripe.setIntentState(intentId, 'requires_payment_method');

    const cancelled = await staffApp.inject({
      method: 'POST',
      url: `/staff/orders/${orderId}/cancel`,
      headers: { 'idempotency-key': `top-up-cancelled-${randomUUID()}` },
    });

    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().outcome, 'cancelled');
    await assertRowsDown(dogId, 2);
    assert.equal(await poolBalance(), 1);
    assert.deepEqual(await failurePushes(), [
      { trigger: 'order-cancelled', title: 'Booking cancelled', body: gone('$60.00', back(1)).cancelled },
    ]);
  },
);

test(
  'Opus M2, her own cancel of one pending day: the whole order goes, and the notice says so',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe, dogId, intentId } = await processingTopUp({
      credits: 1,
      days: 2,
      total: 6_000,
    });
    stripe.setIntentState(intentId, 'requires_payment_method');
    const [first] = await rowsOf(dogId);
    assert.ok(first);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/bookings/${first.id}/cancel`,
      headers: { 'idempotency-key': `top-up-own-cancel-${randomUUID()}` },
    });

    assert.equal(cancelled.statusCode, 200, cancelled.body);
    await assertRowsDown(dogId, 2);
    assert.equal(await poolBalance(), 1);
    assert.deepEqual(await failurePushes(), [
      { trigger: 'order-cancelled', title: 'Booking cancelled', body: gone('$60.00', back(1)).cancelled },
    ]);
  },
);

// ── §2.7:4019-4021 on a real top-up ──────────────────────────────────────────

test(
  'Cancel order on a real top-up, Stripe answering succeeded: settled_then_cancelled, the rows go back as credits and the lot stands',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const { app: staffApp, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffOrdersRoute(staffApp, { authenticate, stripe, now: FIXTURE_NOW });
    const dogId = await dogWithCredits(1);
    stripe.setNextIntentStatus('processing');

    const res = await post(app, bodyFor(dogId, weekdays(2), topUp(1, 6_000)));
    assert.equal(res.statusCode, 201, res.body);
    const [charge] = await chargesOfOwner();
    assert.ok(charge?.orderId);
    stripe.setIntentState(charge.stripePaymentIntentId as string, 'succeeded');

    const cancelled = await staffApp.inject({
      method: 'POST',
      url: `/staff/orders/${charge.orderId}/cancel`,
      headers: { 'idempotency-key': `top-up-cancel-${randomUUID()}` },
    });

    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().outcome, 'settled_then_cancelled');
    assert.deepEqual(
      (await rowsOf(dogId)).map((r) => r.status),
      ['cancelled', 'cancelled'],
    );
    const [after] = await db.select().from(charges).where(eq(charges.id, charge.id));
    assert.equal(after?.status, 'succeeded', 'the money stands');
    assert.equal(
      await poolBalance(),
      2,
      'both days came back as credits, the bought lot with them',
    );
    // An ordinary cancel of each row: one notice a row, by the row's own link, naming the
    // credit that row got back, read from where it landed (P21 plan_added [0]: never
    // "Refund is on the way" for a credit return).
    const [dog] = await db.select({ name: dogs.name }).from(dogs).where(eq(dogs.id, dogId));
    for (const row of await rowsOf(dogId)) {
      const notices = await db
        .select({ body: notifications.body })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'booking-cancelled'),
            eq(notifications.deepLinkPath, deepLinkToPath({ kind: 'booking', id: row.id })),
          ),
        );
      assert.equal(notices.length, 1, 'one ordinary notice per row');
      const { rows: landed } = await db.execute(sql`
        SELECT lot.expires_at AS "expiresAt"
          FROM credit_ledger r JOIN credit_ledger lot ON lot.id = COALESCE(r.lot_id, r.id)
         WHERE r.booking_id = ${row.id} AND r.reason = 'settlement-return'`);
      assert.equal(landed.length, 1, 'one credit back for this row');
      const day = new Date(row.scheduledAt).toLocaleDateString('en-GB', {
        timeZone: 'America/Chicago',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      assert.equal(
        notices[0]?.body,
        `The school cancelled ${dog!.name}'s day school on ${day}. +1 credit, back to your Bentonville day-school credits (expires ${shown((landed[0] as { expiresAt: string }).expiresAt)}).`,
      );
    }
  },
);

test(
  'a top_up on a held date with credits enough: shortfall 0, then already_booked on the re-send, zero charges',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const dogId = await dogWithCredits(2);
    const [held] = weekdays(1) as [string];
    const first = await post(app, bodyFor(dogId, [held]));
    assert.equal(first.statusCode, 201, first.body);

    const details = insufficient(await post(app, bodyFor(dogId, [held], topUp(1, 6_000))));
    assert.equal(details.shortfall, 0);
    assert.equal(details.top_up_offer, null);

    const resend = await post(app, bodyFor(dogId, [held]));
    assert.equal(resend.statusCode, 422, resend.body);
    assert.equal(resend.json().error.code, 'already_booked');
    assert.deepEqual(await chargesOfOwner(), [], 'zero charges');
  },
);

test('a booking waits for the pool lock before it reads the lots', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const dogId = await dogWithCredits(1);
  const gate = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await gate.connect();
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `pool:${FIXTURE_IDS.ownerId}:bentonville:school:regular`,
    ]);
    const answer = post(app, bodyFor(dogId, weekdays(1)));
    await waitForBlockedBackends(1);
    assert.deepEqual(await rowsOf(dogId), [], 'nothing is written under her lock');
    await gate.query('COMMIT');
    const res = await answer;
    assert.equal(res.statusCode, 201, res.body);
  } finally {
    await gate.query('ROLLBACK').catch(() => undefined);
    await gate.end();
  }
});

test(
  'a settle with more rows to pay than credits bought keeps the money, and one alarm reaches the log',
  SKIP_WHEN_NO_DB,
  async () => {
    const capture = makeLogCapture();
    const { app, stripe } = buildApp(capture);
    const dogId = await dogWithCredits(1);
    stripe.setNextIntentStatus('processing');
    const res = await post(app, bodyFor(dogId, weekdays(2), topUp(1, 6_000)));
    assert.equal(res.statusCode, 201, res.body);
    const [charge] = await chargesOfOwner();
    assert.ok(charge);
    // Only corrupt data gets here: tx1 freezes a count that fits, so drop the debit it wrote.
    await db
      .delete(creditLedger)
      .where(and(eq(creditLedger.dogId, dogId), eq(creditLedger.reason, 'booking-debit')));

    stripe.setIntentState(charge.stripePaymentIntentId as string, 'succeeded');
    const hook = await deliverSucceeded(app, stripe, charge.stripePaymentIntentId as string);

    assert.equal(hook.statusCode, 200, hook.body);
    const alarms = capture.lines.filter((l) => l.level === 50 && l.chargeId === charge.id);
    assert.equal(alarms.length, 1, 'a person hears');
    const [after] = await db.select().from(charges).where(eq(charges.id, charge.id));
    assert.equal(after?.status, 'succeeded', 'the money moved, so the order settles');
  },
);

test(
  'a same-key re-send of a processing top-up is 409, then replays the settled answer',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(1);
    stripe.setNextIntentStatus('processing');
    const key = `top-up-resend-${randomUUID()}`;
    const body = bodyFor(dogId, weekdays(2), topUp(1, 6_000));
    const first = await post(app, body, key);
    assert.equal(first.statusCode, 201, first.body);

    const open = await post(app, body, key);
    assert.equal(open.statusCode, 409, open.body);
    assert.equal(open.json().error.code, 'idempotency_inflight');

    const [charge] = await chargesOfOwner();
    stripe.setIntentState(charge?.stripePaymentIntentId as string, 'succeeded');
    await deliverSucceeded(app, stripe, charge?.stripePaymentIntentId as string);

    const settled = await post(app, body, key);
    assert.equal(settled.statusCode, 201, settled.body);
    assert.equal((settled.json() as PostBookingsResponse).order.charge_status, 'succeeded');
    assert.deepEqual(
      (settled.json() as PostBookingsResponse).sessions.map((s) => s.status),
      ['upcoming', 'upcoming'],
    );
  },
);

test(
  'reminders wait for the settle: none while pending, one set once paid',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const dogId = await dogWithCredits(1);
    stripe.setNextIntentStatus('processing');
    const res = await post(app, bodyFor(dogId, weekdays(2), topUp(1, 6_000)));
    assert.equal(res.statusCode, 201, res.body);
    const reminders = () =>
      db
        .select({ id: scheduledNotifications.id })
        .from(scheduledNotifications)
        .where(
          and(
            eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
            eq(scheduledNotifications.type, 'booking-reminder'),
          ),
        );
    assert.deepEqual(await reminders(), []);

    const [charge] = await chargesOfOwner();
    stripe.setIntentState(charge?.stripePaymentIntentId as string, 'succeeded');
    await deliverSucceeded(app, stripe, charge?.stripePaymentIntentId as string);

    assert.ok((await reminders()).length > 0);
  },
);

/**
 * P21 fix 1, B-F2 (Opus r1 L6 = Fable r1 L2): a pending order cancelled while Stripe says
 * processing gets back the credit it used, and this notice is all she hears of it (the
 * failure arms write no `booking-cancelled` row), so it carries §2.9's credit line for each
 * landing after its sentence, the dead-lot line included, as `order-cancelled` and
 * `charge-failed` do (`brief_must_say` 3). The sentence itself is unchanged.
 */
const WHILE_PROCESSING =
  'Cancelled. If your bank still takes the $60.00, we refund it automatically.';

test(
  'a staff cancel of a processing top-up Stripe refuses: the rows go, and she hears the honest words, with the credit that came back',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const { app: staffApp, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffOrdersRoute(staffApp, { authenticate, stripe, now: FIXTURE_NOW });
    const dogId = await dogWithCredits(1);
    stripe.setNextIntentStatus('processing');
    const res = await post(app, bodyFor(dogId, weekdays(2), topUp(1, 6_000)));
    assert.equal(res.statusCode, 201, res.body);
    const [charge] = await chargesOfOwner();
    assert.ok(charge?.orderId);

    const cancelled = await staffApp.inject({
      method: 'POST',
      url: `/staff/orders/${charge.orderId}/cancel`,
      headers: { 'idempotency-key': `top-up-honest-${randomUUID()}` },
    });

    assert.equal(cancelled.statusCode, 200, cancelled.body);
    await assertRowsDown(dogId, 2);
    assert.equal(await poolBalance(), 1, 'the credit it used came back');
    assert.deepEqual(await failurePushes(), [
      {
        trigger: 'cancel-while-processing',
        title: 'Booking cancelled',
        body: `${WHILE_PROCESSING}${back(1)}`,
      },
    ]);
  },
);

test(
  'her own cancel of a pending day while Stripe says processing: the whole order goes, and the notice names the credit that came back',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, dogId } = await processingTopUp({ credits: 1, days: 2, total: 6_000 });
    const [first] = await rowsOf(dogId);
    assert.ok(first);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/bookings/${first.id}/cancel`,
      headers: { 'idempotency-key': `top-up-own-processing-${randomUUID()}` },
    });

    assert.equal(cancelled.statusCode, 200, cancelled.body);
    await assertRowsDown(dogId, 2);
    assert.equal(await poolBalance(), 1, 'the credit it used came back');
    assert.deepEqual(await failurePushes(), [
      {
        trigger: 'cancel-while-processing',
        title: 'Booking cancelled',
        body: `${WHILE_PROCESSING}${back(1)}`,
      },
    ]);
  },
);

test(
  "the desk's cancel while processing at cred.returned_credit_expiry_months 0, the paying lot dead at the cancel → §2.9's dead-lot line, never '+1'",
  SKIP_WHEN_NO_DB,
  async () => {
    const { stripe, dogId, orderId } = await processingTopUp({ credits: 1, days: 2, total: 6_000 });
    const { app: staffApp, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffOrdersRoute(staffApp, { authenticate, stripe, now: FIXTURE_NOW });
    // The lot that paid the first day dies before the cancel: its date moved by SQL to an
    // hour ago (a hand edit's effect), so at key 0 the return lands in a dead lot.
    const died = new Date(Date.now() - 60 * 60 * 1000);
    await db.execute(sql`
      UPDATE credit_ledger SET expires_at = ${died.toISOString()}
       WHERE owner_id = ${FIXTURE_IDS.ownerId} AND reason = 'purchase' AND note LIKE 'pool-fixture%'`);
    await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
    try {
      const cancelled = await staffApp.inject({
        method: 'POST',
        url: `/staff/orders/${orderId}/cancel`,
        headers: { 'idempotency-key': `top-up-processing-dead-${randomUUID()}` },
      });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      await assertRowsDown(dogId, 2);
      assert.equal(await poolBalance(), 0, 'it came back dead');
      assert.deepEqual(await failurePushes(), [
        {
          trigger: 'cancel-while-processing',
          title: 'Booking cancelled',
          body: `${WHILE_PROCESSING} 1 credit came back, but its date, ${shown(died)}, has passed. Message us if you'd like it extended.`,
        },
      ]);
    } finally {
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 1`);
    }
  },
);

test(
  'Cancel order on a real pack, Stripe answering succeeded: settled, and the lot stands',
  SKIP_WHEN_NO_DB,
  async () => {
    const { registerCreditPackagesRoute } = await import('../../src/routes/creditPackages.js');
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const stripe = makeStripeStub();
    registerCreditPackagesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
    const { app: staffApp, authenticate: staffAuth } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffOrdersRoute(staffApp, { authenticate: staffAuth, stripe, now: FIXTURE_NOW });
    stripe.setNextIntentStatus('processing');

    const res = await app.inject({
      method: 'POST',
      url: '/credit-packages/school-2x-weekly-bentonville/purchase',
      headers: { 'idempotency-key': `pack-cancel-${randomUUID()}` },
      payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id },
    });
    assert.equal(res.statusCode, 201, res.body);
    const [charge] = await chargesOfOwner();
    assert.ok(charge?.orderId);
    stripe.setIntentState(charge.stripePaymentIntentId as string, 'succeeded');

    const cancelled = await staffApp.inject({
      method: 'POST',
      url: `/staff/orders/${charge.orderId}/cancel`,
      headers: { 'idempotency-key': `pack-cancel-${randomUUID()}` },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().outcome, 'settled');
    assert.equal(await poolBalance(), 8, 'the lot stands');
  },
);
