import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  creditLedger,
  invoices as invoicesTable,
  serviceRates,
} from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY, topUpCredits } from './_fixture.js';
import { makeStripeStub } from './_stripeStub.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Contract tests for the PAYG branch of POST /bookings + the cancel-void
 * (DATA-CONTRACT Amendment 2026-06-19). A day-program group paid
 * `payment: 'payg'` books WITHOUT debiting credits and instead schedules an
 * open `'payg'` invoice (due ~1h before drop-off) the auto-charge worker bills;
 * a within-window cancel voids that invoice, a forfeited cancel leaves it.
 *
 * Fixture rates (active at FIXTURE_TODAY=2026-05-19): day-school @ fayetteville
 * $75/day; day-care @ null-location $45/day. The fixture seeds Allison's only
 * live card (`paymentMethod1Id`); Lola (`dog2Id`) has 0 school credits, which
 * lets the "PAYG never fires insufficient_credits" assertion stand on a real
 * zero balance. The credits path is exercised end-to-end by booking-create —
 * the regression test here only guards that PAYG doesn't perturb it.
 */

registerFixtureHooks();

const FIXTURE_TODAY_MS = FIXTURE_TODAY.getTime();
const REAL_NOW_MS = Date.now();
const ONE_DAY_MS = 86_400_000;
const ONE_HOUR_MS = 3_600_000;
const DAY_SCHOOL_FAY_RATE_CENTS = 7500;
const DAY_CARE_RATE_CENTS = 4500;

/** YYYY-MM-DD for the `nth` weekday after FIXTURE_TODAY (validation clock).
 * Weekday-only so day_capacity defaults to 3/3 (weekends seed 0/0 = closed). */
function futureWeekday(nth: number): string {
  return nthWeekday(FIXTURE_TODAY_MS, nth);
}

/** Same, anchored on REAL now — the cancel route's forfeit math uses Postgres
 * `now()`, so a booking that must be inside its window when cancelled needs a
 * real-clock-relative date (see booking-cancel.test.ts for the full rationale). */
function realFutureWeekday(nth: number): string {
  return nthWeekday(REAL_NOW_MS, nth);
}

function nthWeekday(anchorMs: number, nth: number): string {
  let count = 0;
  let offset = 1;
  for (;;) {
    const d = new Date(anchorMs + offset * ONE_DAY_MS);
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

function bookingApp(principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW, stripe: makeStripeStub() });
  return { app };
}

async function postBooking(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({ method: 'POST', url: '/bookings', headers, payload: opts.payload });
}

async function postCancel(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  bookingId: string;
  idempotencyKey: string;
}) {
  return opts.app.inject({
    method: 'POST',
    url: `/bookings/${opts.bookingId}/cancel`,
    headers: { 'idempotency-key': opts.idempotencyKey },
    payload: {},
  });
}

/** Open `'payg'` invoices for a booking. */
async function paygInvoicesFor(bookingId: string) {
  return db
    .select({
      status: invoicesTable.status,
      purpose: invoicesTable.purpose,
      amountCents: invoicesTable.amountCents,
      paymentMethodId: invoicesTable.paymentMethodId,
      dueAt: invoicesTable.dueAt,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.bookingId, bookingId));
}

async function bookingDebitsFor(bookingId: string) {
  return db
    .select({ delta: creditLedger.delta, reason: creditLedger.reason })
    .from(creditLedger)
    .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'booking-debit')));
}

// ──────────────────────────────────────────────────────────────────────────
// Books without debiting — schedules the auto-charge invoice
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — PAYG books a zero-credit dog (no insufficient_credits), no debit, schedules one open payg invoice',
  SKIP_WHEN_NO_DB,
  async () => {
    // Hard-zero Lola's school ledger so the 201 proves PAYG skips the credit
    // check on a real zero balance (test-only scaffolding; the route never
    // deletes ledger rows).
    await db.delete(creditLedger).where(eq(creditLedger.dogId, FIXTURE_IDS.dog2Id));
    const { app } = bookingApp();
    const date = futureWeekday(40);
    const res = await postBooking({
      app,
      idempotencyKey: `pg-book-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog2Id,
        dates: [date],
        location: 'fayetteville',
        payment: 'payg',
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 201, `expected 201 (PAYG bypasses credits), got: ${res.body}`);
    const body = res.json() as Array<{ id: string }>;
    assert.equal(body.length, 1);
    const bookingId = body[0]!.id;

    assert.equal((await bookingDebitsFor(bookingId)).length, 0, 'PAYG must not debit credits');

    const invs = await paygInvoicesFor(bookingId);
    assert.equal(invs.length, 1, 'exactly one payg invoice per booking date');
    assert.equal(invs[0]!.status, 'open');
    assert.equal(invs[0]!.purpose, 'payg');
    assert.equal(invs[0]!.amountCents, DAY_SCHOOL_FAY_RATE_CENTS, 'amount = active per-day rate');
    assert.equal(invs[0]!.paymentMethodId, FIXTURE_IDS.paymentMethod1Id);

    const [booking] = await db
      .select({ scheduledAt: bookingsTable.scheduledAt })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    const delta = new Date(booking!.scheduledAt).getTime() - new Date(invs[0]!.dueAt).getTime();
    assert.equal(delta, ONE_HOUR_MS, 'invoice due_at is one hour before drop-off');
  },
);

test(
  'POST /bookings — multi-date PAYG schedules one open payg invoice per booking, each due 1h before its drop-off',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = bookingApp();
    const dates = [futureWeekday(43), futureWeekday(44)];
    const res = await postBooking({
      app,
      idempotencyKey: `pg-multi-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog2Id,
        dates,
        location: 'fayetteville',
        payment: 'payg',
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Array<{ id: string }>;
    assert.equal(body.length, 2);

    for (const { id } of body) {
      const invs = await paygInvoicesFor(id);
      assert.equal(invs.length, 1, `one payg invoice for booking ${id}`);
      assert.equal(invs[0]!.status, 'open');
      assert.equal(invs[0]!.amountCents, DAY_SCHOOL_FAY_RATE_CENTS);
      assert.equal((await bookingDebitsFor(id)).length, 0);
      const [booking] = await db
        .select({ scheduledAt: bookingsTable.scheduledAt })
        .from(bookingsTable)
        .where(eq(bookingsTable.id, id));
      assert.equal(
        new Date(booking!.scheduledAt).getTime() - new Date(invs[0]!.dueAt).getTime(),
        ONE_HOUR_MS,
      );
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Validation — card required, card valid, rate present
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — payment:payg without payment_method_id → 422 invalid_payload',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `pg-nocard-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog2Id,
        dates: [futureWeekday(45)],
        location: 'fayetteville',
        payment: 'payg',
      },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_payload');
  },
);

test(
  'POST /bookings — payment:payg with a non-owned / unknown card → 404 not_found',
  SKIP_WHEN_NO_DB,
  async () => {
    // The owner still has their live fixture card, so the payment GATE passes;
    // the 404 comes from validating the *specific* (unknown) card to charge.
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `pg-badcard-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog2Id,
        dates: [futureWeekday(46)],
        location: 'fayetteville',
        payment: 'payg',
        payment_method_id: randomUUID(),
      },
    });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'not_found');
  },
);

test(
  'POST /bookings — payment:payg with no active rate for (category, location) → 404 not_found',
  SKIP_WHEN_NO_DB,
  async () => {
    // Close the only active day-care rate (the null-location $45 window); the
    // bentonville-specific row is already expired and the future row hasn't
    // opened, so the lookup finds nothing at FIXTURE_TODAY.
    await db
      .update(serviceRates)
      .set({ effectiveTo: '2026-01-01' })
      .where(eq(serviceRates.id, FIXTURE_IDS.serviceRateDaycareCurrentId));
    try {
      const { app } = bookingApp();
      const res = await postBooking({
        app,
        idempotencyKey: `pg-norate-${randomUUID()}`,
        payload: {
          category: 'day-care',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          dates: [futureWeekday(47)],
          location: 'fayetteville',
          payment: 'payg',
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        },
      });
      assert.equal(res.statusCode, 404, res.body);
      const body = res.json() as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'not_found');
      assert.match(body.error.message, /no active rate/);
    } finally {
      await db
        .update(serviceRates)
        .set({ effectiveTo: '2026-06-01' })
        .where(eq(serviceRates.id, FIXTURE_IDS.serviceRateDaycareCurrentId));
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Cancel — within window voids the pending charge, forfeit leaves it
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings/:id/cancel — within window voids the open payg invoice (no auto-charge)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `pg-cancel-in-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [realFutureWeekday(3)],
        location: 'fayetteville',
        payment: 'payg',
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const bookingId = (res.json() as Array<{ id: string }>)[0]!.id;
    assert.equal(
      (await paygInvoicesFor(bookingId))[0]!.status,
      'open',
      'invoice open before cancel',
    );

    const cancel = await postCancel({ app, bookingId, idempotencyKey: `pg-cn-in-${randomUUID()}` });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.notEqual((cancel.json() as { cancel_forfeited?: boolean }).cancel_forfeited, true);

    const invs = await paygInvoicesFor(bookingId);
    assert.equal(invs.length, 1);
    assert.equal(invs[0]!.status, 'void', 'within-window cancel voids the pending auto-charge');
  },
);

test(
  'POST /bookings/:id/cancel — past window (forfeit) leaves the open payg invoice (it charges = forfeit)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `pg-cancel-out-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [realFutureWeekday(4)],
        location: 'fayetteville',
        payment: 'payg',
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const bookingId = (res.json() as Array<{ id: string }>)[0]!.id;

    // Force the cancel window closed (deadline 6h in the past).
    await db
      .update(bookingsTable)
      .set({ cancelDeadlineAt: new Date(REAL_NOW_MS - 6 * ONE_HOUR_MS).toISOString() })
      .where(eq(bookingsTable.id, bookingId));

    const cancel = await postCancel({
      app,
      bookingId,
      idempotencyKey: `pg-cn-out-${randomUUID()}`,
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal((cancel.json() as { cancel_forfeited?: boolean }).cancel_forfeited, true);

    const invs = await paygInvoicesFor(bookingId);
    assert.equal(invs.length, 1);
    assert.equal(invs[0]!.status, 'open', 'forfeited cancel leaves the invoice to charge');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Regression — the credits path is unchanged (debits, no payg invoice)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — credits path still debits and schedules NO payg invoice',
  SKIP_WHEN_NO_DB,
  async () => {
    await db.delete(creditLedger).where(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id));
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `pg-credits-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [futureWeekday(48)],
        location: 'fayetteville',
        payment: 'credits',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const bookingId = (res.json() as Array<{ id: string }>)[0]!.id;

    const debits = await bookingDebitsFor(bookingId);
    assert.equal(debits.length, 1, 'credits path debits exactly once per dog');
    assert.equal(debits[0]!.delta, -1);
    assert.equal((await paygInvoicesFor(bookingId)).length, 0, 'credits path schedules no invoice');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Multi-dog billing — one combined charge for the whole roster
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — multi-dog PAYG schedules one invoice for the per-day rate × the roster size',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `pg-multidog-${randomUUID()}`,
      payload: {
        category: 'day-care',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        additional_dog_ids: [FIXTURE_IDS.dog2Id],
        dates: [futureWeekday(49)],
        location: 'fayetteville',
        payment: 'payg',
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const bookingId = (res.json() as Array<{ id: string }>)[0]!.id;

    const invs = await paygInvoicesFor(bookingId);
    assert.equal(invs.length, 1, 'one combined invoice for the booking, not one per dog');
    assert.equal(invs[0]!.amountCents, DAY_CARE_RATE_CENTS * 2, 'per-day rate × 2 dogs');
    assert.equal((await bookingDebitsFor(bookingId)).length, 0, 'PAYG never debits credits');
  },
);
