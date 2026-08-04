import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  bookingDogs as bookingDogsTable,
  charges,
  creditLedger,
  notifications,
  refunds,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { redis } from '../../src/redis.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { FIXTURE_IDS, topUpCredits } from './_fixture.js';
import { makeStripeStub } from './_stripeStub.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day 13 contract tests for `POST /bookings/:id/cancel` — owner-self
 * cancel with three outcome branches (forfeit / credit-back /
 * money-back) plus the obvious edge cases.
 *
 * Test seed strategy:
 *   - Credit-back path uses POST /bookings to create the booking + its
 *     debit row naturally (the API substrate).
 *   - Money-back path manually seeds a `charges` row alongside a hand-
 *     inserted booking (no API path writes `charges` until Day 14).
 *   - Forfeit path hand-inserts a booking with a `cancel_deadline_at`
 *     already in the past; the markCancelled SQL `now() > deadline`
 *     resolves forfeited=true on commit.
 *   - Free-service (eval-style) path hand-inserts a booking with NO
 *     ledger rows and NO charge — the route's "neither credit-paid
 *     nor money-paid" branch.
 *
 * Cross-test isolation: each test uses unique idempotency keys + new
 * booking ids; the fixture's hard-DELETE teardown wipes everything.
 */

registerFixtureHooks();

const ONE_DAY_MS = 86_400_000;
const ONE_HOUR_MS = 3_600_000;
/** Real-time anchor — see `realFutureWeekday` for the reason. Cancel
 * route reads Postgres `now()` for the forfeit calculation, so seeded
 * scheduledAt + cancel_deadline_at need to be relative to real clock,
 * not FIXTURE_TODAY. */
const REAL_NOW_MS = Date.now();

/**
 * Day-13 cancel tests anchor dates on REAL `now()`, not `FIXTURE_TODAY`.
 * The cancel route's `cancel_forfeited` computation uses Postgres `now()`
 * (real clock), so a booking dated relative to FIXTURE_TODAY (2026-05-19)
 * but cancelled at real-today lands forfeited unexpectedly. Real-time-
 * anchored dates pass BOTH validation (the booking-creation route's
 * "scheduledAt >= FIXTURE_NOW" check is satisfied since real now is
 * after FIXTURE_TODAY) AND the cancel-time forfeit math. Earned
 * 2026-05-26.
 */
function realFutureWeekday(nth: number): string {
  const realTodayMs = Date.now();
  let count = 0;
  let offset = 1;
  for (;;) {
    const d = new Date(realTodayMs + offset * ONE_DAY_MS);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      if (count === nth) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }
      count += 1;
    }
    offset += 1;
  }
}

function cancelApp(principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  // Dates in this suite are anchored on the REAL clock (see `realFutureWeekday`
  // and REAL_NOW_MS above) because the cancel route's forfeit math runs on
  // Postgres `now()`. Injecting FIXTURE_NOW here put the CREATION route on a
  // different clock from the dates it validates: the lookahead cap froze at
  // FIXTURE_TODAY + 92 = 2026-08-19 while the dates kept moving, and the suite
  // went red on 2026-08-20 by exactly one day. Same clock both sides.
  registerBookingsRoute(app, { authenticate, now: () => new Date(REAL_NOW_MS), stripe });
  return { app, stripe };
}

/** Staff-principal app for the cross-owner `POST /staff/bookings/:id/cancel`. */
function staffCancelApp(): { app: ReturnType<typeof makeContractApp>['app'] } {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffBookingsRoute(app, { authenticate, stripe: makeStripeStub() });
  return { app };
}

async function postCancel(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  bookingId: string;
  idempotencyKey?: string;
}) {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: `/bookings/${opts.bookingId}/cancel`,
    headers,
    payload: {},
  });
}

/**
 * Create a credit-paid day-school booking via POST /bookings. Returns
 * the booking id; the route writes the `booking-debit` ledger row as
 * part of its txn, so the credit-back branch has a debit to reverse.
 */
async function createCreditPaidBooking(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  date: string;
  leadDogId?: string;
  additionalDogIds?: readonly string[];
}): Promise<string> {
  const allDogs = [opts.leadDogId ?? FIXTURE_IDS.dog1Id, ...(opts.additionalDogIds ?? [])];
  for (const dogId of allDogs) await topUpCredits(dogId, 'school', 1);
  const res = await opts.app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `seed-${randomUUID()}` },
    payload: {
      category: 'day-school',
      lead_dog_id: opts.leadDogId ?? FIXTURE_IDS.dog1Id,
      additional_dog_ids: opts.additionalDogIds ?? [],
      dates: [opts.date],
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 201, `seed failed: ${res.body}`);
  const body = res.json() as Array<{ id: string }>;
  return body[0]!.id;
}

/**
 * Hand-seed a booking row + booking_dogs row at the given category /
 * scheduledAt / cancelDeadlineAt. Used for forfeit + free-service +
 * money-back tests where POST /bookings can't shape the row directly.
 */
async function seedRawBooking(opts: {
  category: 'day-school' | 'private-lesson' | 'evaluation' | 'boarding' | 'board-and-train';
  scheduledAt: Date;
  cancelDeadlineAt: Date;
  location?: 'fayetteville' | 'bentonville' | null;
  leadDogId?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(bookingsTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: opts.leadDogId ?? FIXTURE_IDS.dog1Id,
    category: opts.category,
    status: 'upcoming',
    scheduledAt: opts.scheduledAt.toISOString(),
    cancelDeadlineAt: opts.cancelDeadlineAt.toISOString(),
    location: opts.location === undefined ? 'fayetteville' : opts.location,
  });
  await db.insert(bookingDogsTable).values({
    bookingId: id,
    dogId: opts.leadDogId ?? FIXTURE_IDS.dog1Id,
    isLead: true,
  });
  return id;
}

/**
 * Hand-seed a succeeded charge attached to a booking. Used for
 * money-back tests until Day-14 wires the real Stripe path.
 */
async function seedSucceededCharge(opts: {
  bookingId: string;
  amountCents: number;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(charges).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    bookingId: opts.bookingId,
    amountCents: opts.amountCents,
    status: 'succeeded',
    purpose: 'payg',
    stripePaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
  });
  return id;
}

// ──────────────────────────────────────────────────────────────────────────
// Branch 1 — Forfeit
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings/:id/cancel — forfeit branch (past deadline) → cancel_forfeited=true, no ledger, no refund',
  SKIP_WHEN_NO_DB,
  async () => {
    // scheduledAt 30h ahead, deadline 6h ago → outside the 48h window.
    const scheduledAt = new Date(REAL_NOW_MS + 30 * ONE_HOUR_MS);
    const cancelDeadlineAt = new Date(REAL_NOW_MS - 6 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'private-lesson',
      scheduledAt,
      cancelDeadlineAt,
      location: null, // private-lesson commonly null in fixture
    });

    const { app } = cancelApp();
    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-forfeit-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { id: string; status: string; cancel_forfeited?: boolean };
    assert.equal(body.id, bookingId);
    assert.equal(body.status, 'cancelled');
    assert.equal(body.cancel_forfeited, true);

    const [row] = await db
      .select({
        status: bookingsTable.status,
        cancelForfeited: bookingsTable.cancelForfeited,
        cancelledAt: bookingsTable.cancelledAt,
      })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    assert.equal(row?.status, 'cancelled');
    assert.equal(row?.cancelForfeited, true);
    assert.ok(row?.cancelledAt !== null, 'cancelled_at stamped');

    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'cancel-refund')));
    assert.equal(ledgerRows.length, 0, 'no cancel-refund ledger row on forfeit');

    const refundRows = await db.select().from(refunds).where(eq(refunds.bookingId, bookingId));
    assert.equal(refundRows.length, 0, 'no refunds row on forfeit');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Branch 2 — Credit-back
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings/:id/cancel — credit-back single dog → +1 cancel-refund row, no refund row',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = cancelApp();
    const bookingId = await createCreditPaidBooking({ app, date: realFutureWeekday(5) });

    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-credit-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { status: string; cancel_forfeited?: boolean };
    assert.equal(body.status, 'cancelled');
    assert.notEqual(body.cancel_forfeited, true);

    // One cancel-refund row, delta=+1, mode=school, dog=dog1, booking=this one.
    const refunds_ = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'cancel-refund')));
    assert.equal(refunds_.length, 1);
    assert.equal(refunds_[0]!.delta, 1);
    assert.equal(refunds_[0]!.dogId, FIXTURE_IDS.dog1Id);
    assert.equal(refunds_[0]!.mode, 'school');

    const moneyRefunds = await db.select().from(refunds).where(eq(refunds.bookingId, bookingId));
    assert.equal(moneyRefunds.length, 0, 'no refunds row for credit-paid');
  },
);

test(
  'POST /bookings/:id/cancel — credit-back multi-dog → one refund row per debit',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = cancelApp();
    const bookingId = await createCreditPaidBooking({
      app,
      date: realFutureWeekday(6),
      additionalDogIds: [FIXTURE_IDS.dog2Id],
    });

    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-credit-multi-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);

    const refundsRows = await db
      .select({ dogId: creditLedger.dogId, delta: creditLedger.delta })
      .from(creditLedger)
      .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'cancel-refund')));
    assert.equal(refundsRows.length, 2, 'one cancel-refund row per dog');
    const dogIdsRefunded = new Set(refundsRows.map((r) => r.dogId));
    assert.ok(dogIdsRefunded.has(FIXTURE_IDS.dog1Id));
    assert.ok(dogIdsRefunded.has(FIXTURE_IDS.dog2Id));
    for (const r of refundsRows) assert.equal(r.delta, 1);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Branch 3 — Money-back
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings/:id/cancel — money-back creates pending refunds row equal to charge amount',
  SKIP_WHEN_NO_DB,
  async () => {
    const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
    const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'private-lesson',
      scheduledAt,
      cancelDeadlineAt,
      location: null,
    });
    const chargeId = await seedSucceededCharge({ bookingId, amountCents: 8500 });

    const { app } = cancelApp();
    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-money-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);

    const refundRows = await db
      .select({
        chargeId: refunds.chargeId,
        amountCents: refunds.amountCents,
        status: refunds.status,
      })
      .from(refunds)
      .where(eq(refunds.bookingId, bookingId));
    assert.equal(refundRows.length, 1);
    assert.equal(refundRows[0]!.chargeId, chargeId);
    assert.equal(refundRows[0]!.amountCents, 8500);
    assert.equal(refundRows[0]!.status, 'pending');

    const ledgerRefunds = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'cancel-refund')));
    assert.equal(ledgerRefunds.length, 0, 'no ledger refund for money-paid');
  },
);

test(
  'POST /bookings/:id/cancel — money-back honors cumulative-refund cap (charge − prior succeeded)',
  SKIP_WHEN_NO_DB,
  async () => {
    const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
    const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'private-lesson',
      scheduledAt,
      cancelDeadlineAt,
      location: null,
    });
    const chargeId = await seedSucceededCharge({ bookingId, amountCents: 10_000 });
    // Pre-existing partial refund of $30 (succeeded) — cancel should
    // only refund the remaining $70.
    await db.insert(refunds).values({
      ownerId: FIXTURE_IDS.ownerId,
      chargeId,
      bookingId,
      amountCents: 3000,
      status: 'succeeded',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });

    const { app } = cancelApp();
    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-money-partial-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);

    const cancelRefundRows = await db
      .select({ amountCents: refunds.amountCents, status: refunds.status })
      .from(refunds)
      .where(and(eq(refunds.bookingId, bookingId), eq(refunds.status, 'pending')));
    assert.equal(cancelRefundRows.length, 1);
    assert.equal(cancelRefundRows[0]!.amountCents, 7000, 'remaining = 10000 - 3000 prior');
  },
);

test(
  'POST /bookings/:id/cancel — money-back fires post-commit Stripe refund (Day-14 seam)',
  SKIP_WHEN_NO_DB,
  async () => {
    const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
    const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'private-lesson',
      scheduledAt,
      cancelDeadlineAt,
      location: null,
    });
    await seedSucceededCharge({ bookingId, amountCents: 12_345 });

    const { app, stripe } = cancelApp();
    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-money-stripe-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);

    const refundCalls = stripe.calls.filter((c) => c.method === 'createRefund');
    assert.equal(refundCalls.length, 1, 'post-commit Stripe refund fired exactly once');
    const args = refundCalls[0]!.args as { paymentIntentId: string; amountCents: number };
    assert.equal(args.amountCents, 12_345);
    assert.match(args.paymentIntentId, /^pi_test_/);
  },
);

test(
  'POST /bookings/:id/cancel — money-back: Stripe refund failure is swallowed (DB refund row persists)',
  SKIP_WHEN_NO_DB,
  async () => {
    const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
    const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'private-lesson',
      scheduledAt,
      cancelDeadlineAt,
      location: null,
    });
    await seedSucceededCharge({ bookingId, amountCents: 5_000 });

    const { app, stripe } = cancelApp();
    stripe.throwOnRefund();
    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-money-stripe-fail-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, 'route still returns success — DB is source of truth');

    const refundRows = await db
      .select({ amountCents: refunds.amountCents, status: refunds.status })
      .from(refunds)
      .where(eq(refunds.bookingId, bookingId));
    assert.equal(refundRows.length, 1);
    assert.equal(refundRows[0]!.status, 'pending', 'Day-15 webhook reconciles to terminal state');
  },
);

test(
  'POST /bookings/:id/cancel — replay does NOT re-fire Stripe refund',
  SKIP_WHEN_NO_DB,
  async () => {
    const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
    const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'private-lesson',
      scheduledAt,
      cancelDeadlineAt,
      location: null,
    });
    await seedSucceededCharge({ bookingId, amountCents: 3_000 });

    const { app, stripe } = cancelApp();
    const key = `cn-money-replay-${randomUUID()}`;
    const first = await postCancel({ app, bookingId, idempotencyKey: key });
    assert.equal(first.statusCode, 200);
    assert.equal(stripe.calls.filter((c) => c.method === 'createRefund').length, 1);

    const replay = await postCancel({ app, bookingId, idempotencyKey: key });
    assert.equal(replay.statusCode, 200);
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      1,
      'replay skipped the post-commit Stripe round-trip',
    );
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Branch 4 — Free service (eval): no debit, no charge
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings/:id/cancel — free service within window → status flip only, no ledger, no refund',
  SKIP_WHEN_NO_DB,
  async () => {
    const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
    const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'evaluation',
      scheduledAt,
      cancelDeadlineAt,
      location: 'fayetteville',
    });

    const { app } = cancelApp();
    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-free-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);

    const ledgerRefunds = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'cancel-refund')));
    assert.equal(ledgerRefunds.length, 0);

    const refundRows = await db.select().from(refunds).where(eq(refunds.bookingId, bookingId));
    assert.equal(refundRows.length, 0);

    const [row] = await db
      .select({ status: bookingsTable.status, cancelForfeited: bookingsTable.cancelForfeited })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    assert.equal(row?.status, 'cancelled');
    assert.equal(row?.cancelForfeited, false);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────────

test('POST /bookings/:id/cancel — unknown booking id → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = cancelApp();
  const res = await postCancel({
    app,
    bookingId: '99999999-9999-4999-8999-999999999999',
    idempotencyKey: `cn-404-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /bookings/:id/cancel — already-cancelled → 409', SKIP_WHEN_NO_DB, async () => {
  const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
  const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
  const bookingId = await seedRawBooking({
    category: 'private-lesson',
    scheduledAt,
    cancelDeadlineAt,
    location: null,
  });
  const { app } = cancelApp();
  // First cancel succeeds.
  const r1 = await postCancel({
    app,
    bookingId,
    idempotencyKey: `cn-conflict-1-${randomUUID()}`,
  });
  assert.equal(r1.statusCode, 200);
  // Second cancel (different idempotency key) hits the state guard.
  const r2 = await postCancel({
    app,
    bookingId,
    idempotencyKey: `cn-conflict-2-${randomUUID()}`,
  });
  assert.equal(r2.statusCode, 409, r2.body);
});

test('POST /bookings/:id/cancel — group-class booking → 422', SKIP_WHEN_NO_DB, async () => {
  // Hand-seed a group-class booking (the seedRawBooking helper would
  // need a cohort_id for this — quick inline seed).
  const id = randomUUID();
  await db.insert(bookingsTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: FIXTURE_IDS.dog1Id,
    category: 'group-class',
    status: 'upcoming',
    scheduledAt: new Date(REAL_NOW_MS + 7 * ONE_DAY_MS).toISOString(),
    cancelDeadlineAt: new Date(REAL_NOW_MS + 5 * ONE_DAY_MS).toISOString(),
    cohortId: FIXTURE_IDS.cohortPuppyId,
    location: 'fayetteville',
  });
  await db.insert(bookingDogsTable).values({
    bookingId: id,
    dogId: FIXTURE_IDS.dog1Id,
    isLead: true,
  });

  const { app } = cancelApp();
  const res = await postCancel({ app, bookingId: id, idempotencyKey: `cn-gc-${randomUUID()}` });
  assert.equal(res.statusCode, 422, res.body);
  const body = res.json() as { error: { message: string } };
  assert.match(body.error.message, /cohort withdraw/);
});

test('POST /bookings/:id/cancel — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
  const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
  const bookingId = await seedRawBooking({
    category: 'private-lesson',
    scheduledAt,
    cancelDeadlineAt,
    location: null,
  });
  const { app } = cancelApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await postCancel({
    app,
    bookingId,
    idempotencyKey: `cn-staff-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('POST /bookings/:id/cancel — missing Idempotency-Key → 400', SKIP_WHEN_NO_DB, async () => {
  const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
  const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
  const bookingId = await seedRawBooking({
    category: 'private-lesson',
    scheduledAt,
    cancelDeadlineAt,
    location: null,
  });
  const { app } = cancelApp();
  const res = await postCancel({ app, bookingId });
  assert.equal(res.statusCode, 400, res.body);
});

test(
  'POST /bookings/:id/cancel — replay returns the stored response idempotently',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = cancelApp();
    const bookingId = await createCreditPaidBooking({ app, date: realFutureWeekday(7) });
    const key = `cn-replay-${randomUUID()}`;

    const r1 = await postCancel({ app, bookingId, idempotencyKey: key });
    assert.equal(r1.statusCode, 200);
    const r2 = await postCancel({ app, bookingId, idempotencyKey: key });
    assert.equal(r2.statusCode, 200);
    assert.deepStrictEqual(r2.json(), r1.json(), 'replay returns identical body');

    // Exactly ONE cancel-refund row exists — the replay didn't double-credit.
    const refundsRows = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'cancel-refund')));
    assert.equal(refundsRows.length, 1, 'replay did not insert a second refund row');
  },
);

test(
  'POST /bookings/:id/cancel — enqueues a booking-cancelled notification',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = cancelApp();
    const bookingId = await createCreditPaidBooking({ app, date: realFutureWeekday(8) });

    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-notif-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200);

    const notifRows = await db
      .select({ type: notifications.type, deepLinkPath: notifications.deepLinkPath })
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, FIXTURE_IDS.ownerId),
          eq(notifications.type, 'booking-cancelled'),
          eq(notifications.deepLinkPath, `/bookings/${bookingId}`),
        ),
      );
    assert.equal(notifRows.length, 1, 'booking-cancelled notification enqueued');
  },
);

test(
  'POST /bookings/:id/cancel — flips a pending booking-reminder scheduled row to cancelled (D4)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = cancelApp();
    // POST /bookings enqueues a pending `booking-reminder:<bookingId>` schedule
    // row via the shared booking-creation core — the natural fixture for the
    // cancel-on-cancel path, so no hand-seeding of scheduled_notifications.
    const bookingId = await createCreditPaidBooking({ app, date: realFutureWeekday(11) });

    const reminderKey = `booking-reminder:${bookingId}`;
    const [before] = await db
      .select({ status: scheduledNotifications.status })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, reminderKey));
    assert.equal(before?.status, 'pending', 'reminder enqueued pending pre-cancel');

    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-d4-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);

    const [after] = await db
      .select({ status: scheduledNotifications.status })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, reminderKey));
    assert.equal(after?.status, 'cancelled', 'cancel supersedes the pending reminder');
  },
);

test(
  'POST /bookings/:id/cancel — releases capacity (seat available for a new booking on the same date)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = cancelApp();
    const date = realFutureWeekday(9);
    // Drive day_capacity to a 1-seat ceiling at this date so the cancel
    // → re-book sequence is observable. The default rule is 3/3; the
    // override below shrinks it to 1/1 just for this calendar day.
    await db.execute(sql`
      INSERT INTO day_capacity (location, date, school_openings, daycare_openings)
      VALUES ('fayetteville', ${date}::date, 1, 1)
      ON CONFLICT (location, date) DO UPDATE SET school_openings = 1, daycare_openings = 1
    `);

    // Step 1: book the only seat.
    const firstId = await createCreditPaidBooking({ app, date });

    // Step 2: re-book the same date → should 422 insufficient_capacity.
    await topUpCredits(FIXTURE_IDS.dog2Id, 'school', 1);
    const blocked = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `cap-blocked-${randomUUID()}` },
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog2Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(blocked.statusCode, 422, `expected capacity 422, got ${blocked.body}`);

    // Step 3: cancel the first booking → seat returns.
    const cancelled = await postCancel({
      app,
      bookingId: firstId,
      idempotencyKey: `cap-cancel-${randomUUID()}`,
    });
    assert.equal(cancelled.statusCode, 200);

    // Step 4: re-book succeeds now.
    const rebook = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `cap-rebook-${randomUUID()}` },
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog2Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(rebook.statusCode, 201, `expected re-book 201, got ${rebook.body}`);

    // Clean up the override for cross-test isolation.
    await db.execute(
      sql`DELETE FROM day_capacity WHERE location='fayetteville' AND date=${date}::date`,
    );
  },
);

test(
  'POST /bookings/:id/cancel — drops avail:{location}:* cache patterns post-commit',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = cancelApp();
    const bookingId = await createCreditPaidBooking({ app, date: realFutureWeekday(10) });

    // Pre-warm a fake range cache so we can prove invalidation happens.
    const sentinelKey = `avail:fayetteville:2026-12-01:2026-12-31`;
    await redis.set(sentinelKey, JSON.stringify([{ date: '2026-12-15', remaining: 3 }]), 'EX', 300);
    assert.equal(await redis.exists(sentinelKey), 1);

    const res = await postCancel({
      app,
      bookingId,
      idempotencyKey: `cn-cache-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(await redis.exists(sentinelKey), 0, 'avail:fayetteville:* wiped on cancel');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// R5 — cancelled_by + cancel_reason (WHO/WHY)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings/:id/cancel — owner self-cancel stamps cancelled_by=owner (no reason) + wire emits it',
  SKIP_WHEN_NO_DB,
  async () => {
    const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
    const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'private-lesson',
      scheduledAt,
      cancelDeadlineAt,
      location: null,
    });

    const { app } = cancelApp();
    const res = await postCancel({ app, bookingId, idempotencyKey: `cn-owner-by-${randomUUID()}` });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { cancelled_by?: string; cancel_reason?: string };
    assert.equal(body.cancelled_by, 'owner', 'wire carries cancelled_by=owner');
    assert.equal('cancel_reason' in body, false, 'owner cancel has no reason line');

    const [row] = await db
      .select({ cancelledBy: bookingsTable.cancelledBy, cancelReason: bookingsTable.cancelReason })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    assert.equal(row?.cancelledBy, 'owner');
    assert.equal(row?.cancelReason, null);
  },
);

test(
  'POST /staff/bookings/:id/cancel — staff cancel with reason stamps cancelled_by=staff + cancel_reason + wire emits both',
  SKIP_WHEN_NO_DB,
  async () => {
    const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
    const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'private-lesson',
      scheduledAt,
      cancelDeadlineAt,
      location: null,
    });

    const { app } = staffCancelApp();
    const res = await app.inject({
      method: 'POST',
      url: `/staff/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': `cx-reason-${randomUUID()}` },
      payload: { reason: 'Trainer out sick — rescheduling' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { cancelled_by?: string; cancel_reason?: string };
    assert.equal(body.cancelled_by, 'staff');
    assert.equal(body.cancel_reason, 'Trainer out sick — rescheduling');

    const [row] = await db
      .select({ cancelledBy: bookingsTable.cancelledBy, cancelReason: bookingsTable.cancelReason })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    assert.equal(row?.cancelledBy, 'staff');
    assert.equal(row?.cancelReason, 'Trainer out sick — rescheduling');
  },
);

test(
  'POST /staff/bookings/:id/cancel — staff cancel WITHOUT a reason stamps cancelled_by=staff, omits cancel_reason',
  SKIP_WHEN_NO_DB,
  async () => {
    const scheduledAt = new Date(REAL_NOW_MS + 7 * ONE_DAY_MS);
    const cancelDeadlineAt = new Date(scheduledAt.getTime() - 48 * ONE_HOUR_MS);
    const bookingId = await seedRawBooking({
      category: 'private-lesson',
      scheduledAt,
      cancelDeadlineAt,
      location: null,
    });

    const { app } = staffCancelApp();
    const res = await app.inject({
      method: 'POST',
      url: `/staff/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': `cx-noreason-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { cancelled_by?: string; cancel_reason?: string };
    assert.equal(body.cancelled_by, 'staff');
    assert.equal('cancel_reason' in body, false, 'no reason supplied → field omitted');

    const [row] = await db
      .select({ cancelledBy: bookingsTable.cancelledBy, cancelReason: bookingsTable.cancelReason })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    assert.equal(row?.cancelledBy, 'staff');
    assert.equal(row?.cancelReason, null);
  },
);
