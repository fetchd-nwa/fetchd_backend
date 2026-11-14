import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  bookingDogs as bookingDogsTable,
  charges,
  creditLedger,
  notifications,
  refunds,
} from '../../src/db/schema/schema.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { makeStripeStub } from './_stripeStub.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day 19 contract tests for the staff-portal verb 4 (bookings):
 *   GET  /staff/bookings              — cross-owner queue
 *   POST /staff/bookings/:id/confirm  — stamp confirmed_at
 *   POST /staff/bookings/:id/cancel   — shared cancel txn, cross-owner
 *   POST /staff/bookings/:id/attendance — per-dog check-in
 *
 * The cancel txn itself (forfeit / credit-back / money-back branching) is
 * exercised exhaustively by `booking-cancel.test.ts` against the owner
 * route; here we prove the STAFF wiring — `requireStaff`, cross-owner
 * scope (`requireOwnerId: null`), and that the money-back postCommit fires
 * the Stripe refund. Each test seeds unique booking ids; the fixture's
 * hard-DELETE teardown wipes by owner.
 */

registerFixtureHooks();

const ONE_HOUR_MS = 3_600_000;
const REAL_NOW_MS = Date.now();

function staffBookingsApp(principal = FIXTURE_STAFF_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerStaffBookingsRoute(app, { authenticate, stripe });
  return { app, stripe };
}

async function seedBooking(args: {
  status?: 'upcoming' | 'past' | 'cancelled';
  category?: 'day-school' | 'private-lesson' | 'boarding';
  scheduledAt?: string;
  confirmedAt?: string | null;
  cancelDeadlineAt?: string | null;
  leadDogId?: string;
  location?: 'fayetteville' | 'bentonville';
}): Promise<string> {
  const id = randomUUID();
  const leadDogId = args.leadDogId ?? FIXTURE_IDS.dog1Id;
  await db.insert(bookingsTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId,
    category: args.category ?? 'day-school',
    status: args.status ?? 'upcoming',
    scheduledAt: args.scheduledAt ?? new Date(REAL_NOW_MS + 72 * ONE_HOUR_MS).toISOString(),
    location: args.location ?? 'fayetteville',
    ...(args.confirmedAt !== undefined ? { confirmedAt: args.confirmedAt } : {}),
    ...(args.cancelDeadlineAt !== undefined ? { cancelDeadlineAt: args.cancelDeadlineAt } : {}),
  });
  await db.insert(bookingDogsTable).values([{ bookingId: id, dogId: leadDogId, isLead: true }]);
  return id;
}

async function seedSucceededCharge(bookingId: string, amountCents: number): Promise<void> {
  await db.insert(charges).values({
    id: randomUUID(),
    ownerId: FIXTURE_IDS.ownerId,
    bookingId,
    amountCents,
    status: 'succeeded',
    purpose: 'group-class',
    stripePaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
  });
}

function post(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  url: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: opts.url,
    headers,
    payload: opts.payload ?? {},
  });
}

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/bookings
// ──────────────────────────────────────────────────────────────────────────

test(
  'GET /staff/bookings — staff sees a live booking with the §B wire shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedBooking({ category: 'private-lesson' });
    const { app } = staffBookingsApp();
    const res = await app.inject({ method: 'GET', url: '/staff/bookings' });
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json() as { id: string; category: string; status: string; dog_id: string }[];
    const mine = rows.find((r) => r.id === id);
    assert.ok(mine, 'seeded booking present in the staff queue');
    assert.equal(mine.category, 'private-lesson');
    assert.equal(mine.dog_id, FIXTURE_IDS.dog1Id);
  },
);

test('GET /staff/bookings — excludes cancelled bookings', SKIP_WHEN_NO_DB, async () => {
  const cancelledId = await seedBooking({ status: 'cancelled' });
  const { app } = staffBookingsApp();
  const res = await app.inject({ method: 'GET', url: '/staff/bookings' });
  assert.equal(res.statusCode, 200, res.body);
  const ids = (res.json() as { id: string }[]).map((r) => r.id);
  assert.ok(!ids.includes(cancelledId), 'cancelled booking excluded from the queue');
});

test('GET /staff/bookings — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffBookingsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({ method: 'GET', url: '/staff/bookings' });
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/bookings — server-side filters (wire 1.13.0 `GetStaffBookingsQuery`,
// built in 2.3b). Exactly four keys, all OPTIONAL:
//   from / to — YYYY-MM-DD America/Chicago calendar days, INCLUSIVE both ends
//   category / location — exact-match single values
// `?search=` is deliberately absent (Allison ruling WC-A5 — deferred to
// phase 3), and an all-omitted query must reproduce the old response exactly.
// ──────────────────────────────────────────────────────────────────────────

/** Fetch the queue and return just the ids, asserting a 200. */
async function queueIds(
  app: ReturnType<typeof makeContractApp>['app'],
  query = '',
): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: `/staff/bookings${query}` });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { id: string }[]).map((r) => r.id);
}

test(
  'GET /staff/bookings — KEEP-GREEN: no query reproduces the unfiltered queue',
  SKIP_WHEN_NO_DB,
  async () => {
    const boarding = await seedBooking({ category: 'boarding', location: 'bentonville' });
    const lesson = await seedBooking({ category: 'private-lesson', location: 'fayetteville' });
    const cancelled = await seedBooking({ status: 'cancelled' });
    const { app } = staffBookingsApp();
    const ids = await queueIds(app);
    assert.ok(ids.includes(boarding), 'unfiltered queue still carries every live category');
    assert.ok(ids.includes(lesson), 'unfiltered queue still carries every live location');
    assert.ok(!ids.includes(cancelled), 'and still excludes cancelled rows');
  },
);

test(
  'GET /staff/bookings — KEEP-GREEN: an uncontracted query key is ignored, not rejected (§14.1 — no tightening; ?search= is WC-A5-deferred)',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedBooking({ category: 'private-lesson' });
    const { app } = staffBookingsApp();
    const ids = await queueIds(app, '?search=waffles');
    assert.ok(ids.includes(id), 'an unknown key yields the unfiltered queue, not a 400');
  },
);

test('GET /staff/bookings?category= — exact-match filter', SKIP_WHEN_NO_DB, async () => {
  const boarding = await seedBooking({ category: 'boarding' });
  const lesson = await seedBooking({ category: 'private-lesson' });
  const { app } = staffBookingsApp();
  const ids = await queueIds(app, '?category=boarding');
  assert.ok(ids.includes(boarding), 'matching category kept');
  assert.ok(!ids.includes(lesson), 'non-matching category filtered out');
});

test('GET /staff/bookings?location= — exact-match filter', SKIP_WHEN_NO_DB, async () => {
  const benton = await seedBooking({ location: 'bentonville' });
  const fay = await seedBooking({ location: 'fayetteville' });
  const { app } = staffBookingsApp();
  const ids = await queueIds(app, '?location=bentonville');
  assert.ok(ids.includes(benton), 'matching location kept');
  assert.ok(!ids.includes(fay), 'non-matching location filtered out');
});

test(
  'GET /staff/bookings?from=&to= — inclusive on BOTH ends, bucketed to the America/Chicago calendar day (not UTC)',
  SKIP_WHEN_NO_DB,
  async () => {
    // 04:00Z on 07-15 is 23:00 CDT on 07-14 — the whole point of the Chicago
    // bucket. A UTC-truncating implementation files this under 2027-07-15 and
    // both assertions below flip.
    const lateEvening = await seedBooking({ scheduledAt: '2027-07-15T04:00:00Z' }); // Chicago 07-14
    const middle = await seedBooking({ scheduledAt: '2027-07-15T17:00:00Z' }); // Chicago 07-15
    const upperEdge = await seedBooking({ scheduledAt: '2027-07-16T17:00:00Z' }); // Chicago 07-16
    const outside = await seedBooking({ scheduledAt: '2027-07-18T17:00:00Z' }); // Chicago 07-18
    const { app } = staffBookingsApp();

    const inRange = await queueIds(app, '?from=2027-07-14&to=2027-07-16');
    assert.ok(inRange.includes(lateEvening), 'lower bound is INCLUSIVE, on the Chicago day');
    assert.ok(inRange.includes(middle), 'interior day kept');
    assert.ok(inRange.includes(upperEdge), 'upper bound is INCLUSIVE');
    assert.ok(!inRange.includes(outside), 'past the upper bound, dropped');

    const fromChicagoNextDay = await queueIds(app, '?from=2027-07-15');
    assert.ok(
      !fromChicagoNextDay.includes(lateEvening),
      'the 04:00Z row is a 07-14 booking in Chicago — a UTC bucket would have kept it',
    );
    assert.ok(fromChicagoNextDay.includes(middle), 'open-ended `from` alone keeps everything after');
    assert.ok(fromChicagoNextDay.includes(outside), 'and has no implicit upper bound');
  },
);

test('GET /staff/bookings?to= alone — open-ended lower bound', SKIP_WHEN_NO_DB, async () => {
  const early = await seedBooking({ scheduledAt: '2027-08-02T17:00:00Z' });
  const late = await seedBooking({ scheduledAt: '2027-08-20T17:00:00Z' });
  const { app } = staffBookingsApp();
  const ids = await queueIds(app, '?to=2027-08-02');
  assert.ok(ids.includes(early), 'inclusive upper bound with no lower bound');
  assert.ok(!ids.includes(late), 'after the upper bound, dropped');
});

test(
  'GET /staff/bookings — filters compose (category AND location AND range)',
  SKIP_WHEN_NO_DB,
  async () => {
    const match = await seedBooking({
      category: 'boarding',
      location: 'bentonville',
      scheduledAt: '2027-09-10T17:00:00Z',
    });
    const wrongLocation = await seedBooking({
      category: 'boarding',
      location: 'fayetteville',
      scheduledAt: '2027-09-10T17:00:00Z',
    });
    const wrongDay = await seedBooking({
      category: 'boarding',
      location: 'bentonville',
      scheduledAt: '2027-09-12T17:00:00Z',
    });
    const { app } = staffBookingsApp();
    const ids = await queueIds(
      app,
      '?category=boarding&location=bentonville&from=2027-09-10&to=2027-09-10',
    );
    assert.ok(ids.includes(match));
    assert.ok(!ids.includes(wrongLocation));
    assert.ok(!ids.includes(wrongDay));
  },
);

test(
  'GET /staff/bookings — a filter never widens: a cancelled row stays out of a matching range',
  SKIP_WHEN_NO_DB,
  async () => {
    const cancelled = await seedBooking({
      status: 'cancelled',
      scheduledAt: '2027-10-05T17:00:00Z',
    });
    const { app } = staffBookingsApp();
    const ids = await queueIds(app, '?from=2027-10-05&to=2027-10-05');
    assert.ok(!ids.includes(cancelled), 'filters narrow the live queue, they never widen it');
  },
);

test(
  'GET /staff/bookings — malformed `from` → 400 bad_request (query convention, not invalid_payload)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffBookingsApp();
    for (const bad of ['?from=07-15-2027', '?from=2027-13-40', '?to=nope']) {
      const res = await app.inject({ method: 'GET', url: `/staff/bookings${bad}` });
      assert.equal(res.statusCode, 400, `${bad}: ${res.body}`);
      const body = res.json() as { error?: { code?: string } };
      assert.equal(body.error?.code, 'bad_request', bad);
    }
  },
);

test(
  'GET /staff/bookings — unknown category/location VALUE → 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffBookingsApp();
    for (const bad of ['?category=grooming', '?location=springdale']) {
      const res = await app.inject({ method: 'GET', url: `/staff/bookings${bad}` });
      assert.equal(res.statusCode, 400, `${bad}: ${res.body}`);
      const body = res.json() as { error?: { code?: string } };
      assert.equal(body.error?.code, 'bad_request', bad);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/bookings/:id/confirm
// ──────────────────────────────────────────────────────────────────────────

test('POST /staff/bookings/:id/confirm — stamps confirmed_at', SKIP_WHEN_NO_DB, async () => {
  const id = await seedBooking({ confirmedAt: null });
  const { app } = staffBookingsApp();
  const res = await post({
    app,
    url: `/staff/bookings/${id}/confirm`,
    idempotencyKey: `cf-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  const [row] = await db
    .select({ confirmedAt: bookingsTable.confirmedAt })
    .from(bookingsTable)
    .where(eq(bookingsTable.id, id));
  assert.ok(row?.confirmedAt !== null, 'confirmed_at stamped');
});

test(
  'POST /staff/bookings/:id/confirm — idempotency replay returns stored body',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedBooking({ confirmedAt: null });
    const { app } = staffBookingsApp();
    const key = `cf-idem-${randomUUID()}`;
    const first = await post({ app, url: `/staff/bookings/${id}/confirm`, idempotencyKey: key });
    assert.equal(first.statusCode, 200, first.body);
    const replay = await post({ app, url: `/staff/bookings/${id}/confirm`, idempotencyKey: key });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json(), 'replay byte-identical');
  },
);

test('POST /staff/bookings/:id/confirm — cancelled booking → 409', SKIP_WHEN_NO_DB, async () => {
  const id = await seedBooking({ status: 'cancelled' });
  const { app } = staffBookingsApp();
  const res = await post({
    app,
    url: `/staff/bookings/${id}/confirm`,
    idempotencyKey: `cf-409-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 409, res.body);
});

test('POST /staff/bookings/:id/confirm — unknown id → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffBookingsApp();
  const res = await post({
    app,
    url: `/staff/bookings/${randomUUID()}/confirm`,
    idempotencyKey: `cf-404-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /staff/bookings/:id/confirm — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const id = await seedBooking({});
  const { app } = staffBookingsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await post({
    app,
    url: `/staff/bookings/${id}/confirm`,
    idempotencyKey: `cf-owner-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/bookings/:id/cancel
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/bookings/:id/cancel — within-window free cancel → cancelled + owner notified',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedBooking({
      category: 'private-lesson',
      scheduledAt: new Date(REAL_NOW_MS + 72 * ONE_HOUR_MS).toISOString(),
      cancelDeadlineAt: new Date(REAL_NOW_MS + 48 * ONE_HOUR_MS).toISOString(),
    });
    const { app } = staffBookingsApp();
    const res = await post({
      app,
      url: `/staff/bookings/${id}/cancel`,
      idempotencyKey: `cx-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { status: string };
    assert.equal(body.status, 'cancelled');

    const notes = await db
      .select({ type: notifications.type })
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, FIXTURE_IDS.ownerId),
          eq(notifications.deepLinkPath, `/bookings/${id}`),
        ),
      );
    assert.ok(
      notes.some((n) => n.type === 'booking-cancelled'),
      'booking-cancelled notification enqueued to the owner',
    );
  },
);

test(
  'POST /staff/bookings/:id/cancel — over a planted succeeded charge, the staff cancel mints no refund and fires no Stripe call (P21: no cancel moves money)',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedBooking({
      category: 'private-lesson',
      scheduledAt: new Date(REAL_NOW_MS + 72 * ONE_HOUR_MS).toISOString(),
      cancelDeadlineAt: new Date(REAL_NOW_MS + 48 * ONE_HOUR_MS).toISOString(),
    });
    await seedSucceededCharge(id, 9000);
    const { app, stripe } = staffBookingsApp();
    const res = await post({
      app,
      url: `/staff/bookings/${id}/cancel`,
      idempotencyKey: `cx-money-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);

    // The P20 tree minted a pending refund here and fired Stripe after commit. No route a
    // v1 client reaches puts a charge on a private lesson; money comes back only as a staff
    // refund, case by case (design.md:4151-4154; P22).
    const refundCalls = stripe.calls.filter((c) => c.method === 'createRefund');
    assert.equal(refundCalls.length, 0, 'no Stripe refund');

    const refundRows = await db
      .select({ amountCents: refunds.amountCents })
      .from(refunds)
      .where(eq(refunds.bookingId, id));
    assert.equal(refundRows.length, 0, 'no refunds row');
  },
);

test('POST /staff/bookings/:id/cancel — already cancelled → 409', SKIP_WHEN_NO_DB, async () => {
  const id = await seedBooking({ status: 'cancelled' });
  const { app } = staffBookingsApp();
  const res = await post({
    app,
    url: `/staff/bookings/${id}/cancel`,
    idempotencyKey: `cx-409-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error.code, 'conflict', res.body);
});

test('POST /staff/bookings/:id/cancel — unknown id → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffBookingsApp();
  const res = await post({
    app,
    url: `/staff/bookings/${randomUUID()}/cancel`,
    idempotencyKey: `cx-404-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /staff/bookings/:id/cancel — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const id = await seedBooking({});
  const { app } = staffBookingsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await post({
    app,
    url: `/staff/bookings/${id}/cancel`,
    idempotencyKey: `cx-owner-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 403, res.body);
});

// POST /staff/bookings/:id/attendance left at 6.0.0-lg5.1 (M5.12): its five tests went
// with it ("marks check-in + stamps acting staff", "dog not on the booking → 404",
// "cancelled booking → 409", "pending status rejected", "owner principal → 403"), and
// `removed-routes.test.ts` holds its 404. The board's verbs are `checkin-verbs.test.ts`'s.

// ──────────────────────────────────────────────────────────────────────────
// Cancel — the credit-back refund branch NOT covered above, plus idempotency
// replay, proving the shared cancel txn is correct through the cross-owner
// staff route.
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/bookings/:id/cancel — credit-paid within window → settlement-return ledger row',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedBooking({
      category: 'day-school',
      scheduledAt: new Date(REAL_NOW_MS + 72 * ONE_HOUR_MS).toISOString(),
      cancelDeadlineAt: new Date(REAL_NOW_MS + 48 * ONE_HOUR_MS).toISOString(),
    });
    // Seed the booking-debit the cancel txn's credit-back branch reverses.
    await db.insert(creditLedger).values({
      ownerId: FIXTURE_IDS.ownerId,
      dogId: FIXTURE_IDS.dog1Id,
      mode: 'school',
      location: 'fayetteville',
      delta: -1,
      reason: 'booking-debit',
      bookingId: id,
      lotId: FIXTURE_IDS.creditLedgerPurchaseId,
    });

    const { app } = staffBookingsApp();
    const res = await post({
      app,
      url: `/staff/bookings/${id}/cancel`,
      idempotencyKey: `cx-credit-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);

    const refundLedger = await db
      .select({ delta: creditLedger.delta, dogId: creditLedger.dogId })
      .from(creditLedger)
      .where(and(eq(creditLedger.bookingId, id), eq(creditLedger.reason, 'settlement-return')));
    assert.equal(refundLedger.length, 1, 'one settlement-return row for the credit-paid booking');
    assert.equal(refundLedger[0]!.delta, 1);
    assert.equal(refundLedger[0]!.dogId, FIXTURE_IDS.dog1Id);
  },
);

test(
  'POST /staff/bookings/:id/cancel — idempotency replay returns stored body, no double-cancel',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedBooking({
      category: 'private-lesson',
      scheduledAt: new Date(REAL_NOW_MS + 72 * ONE_HOUR_MS).toISOString(),
      cancelDeadlineAt: new Date(REAL_NOW_MS + 48 * ONE_HOUR_MS).toISOString(),
    });
    const { app } = staffBookingsApp();
    const key = `cx-idem-${randomUUID()}`;
    const first = await post({ app, url: `/staff/bookings/${id}/cancel`, idempotencyKey: key });
    assert.equal(first.statusCode, 200, first.body);
    const replay = await post({ app, url: `/staff/bookings/${id}/cancel`, idempotencyKey: key });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json(), 'replay byte-identical');
  },
);

// The attendance verb's idempotency replay test left with the verb (M5.12); each board
// verb's replay is in `checkin-verbs.test.ts`.
