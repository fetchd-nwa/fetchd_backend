import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoices as invoicesTable, serviceRates } from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffRatesRoute } from '../../src/routes/staffRates.js';
import { FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY } from './_fixture.js';
import { makeStripeStub } from './_stripeStub.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Contract tests for the staff per-location service-rate editor:
 *   - GET  /staff/rates              (active + scheduled catalog, staff-only)
 *   - POST /staff/rates              (effective-dated supersede, staff-only)
 *
 * Effective-dating is the core property: editing a price closes the current
 * window and opens a new one, never an in-place amount change (except a
 * same-day correction). FIXTURE_TODAY = 2026-05-19; fixture seeds day-school
 * @fayetteville $75 (open from 2026-01-01), day-school @null $70, day-care
 * @null $45 (→ 2026-06-01) then $50, boarding @fayetteville $85. private-lesson
 * + board-and-train tracks are unseeded (clean for insert tests).
 */

registerFixtureHooks();

const FIXTURE_TODAY_MS = FIXTURE_TODAY.getTime();
const ONE_DAY_MS = 86_400_000;

function staffApp(principal = FIXTURE_STAFF_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffRatesRoute(app, { authenticate, now: FIXTURE_NOW });
  return { app };
}

/** Owner app with the bookings route — for the PAYG integration test. */
function ownerBookingApp(): { app: ReturnType<typeof makeContractApp>['app'] } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW, stripe: makeStripeStub() });
  return { app };
}

async function postRate(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({ method: 'POST', url: '/staff/rates', headers, payload: opts.payload });
}

/** All rows for one (category, location) track, current state in the DB. */
async function rowsForTrack(category: string, location: string) {
  return db
    .select({
      amountCents: serviceRates.amountCents,
      unit: serviceRates.unit,
      effectiveFrom: serviceRates.effectiveFrom,
      effectiveTo: serviceRates.effectiveTo,
    })
    .from(serviceRates)
    .where(
      and(
        eq(serviceRates.category, category as 'day-school'),
        eq(serviceRates.location, location as 'fayetteville'),
      ),
    );
}

function futureWeekday(nth: number): string {
  let count = 0;
  let offset = 1;
  for (;;) {
    const d = new Date(FIXTURE_TODAY_MS + offset * ONE_DAY_MS);
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

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/rates
// ──────────────────────────────────────────────────────────────────────────

test(
  'GET /staff/rates — staff sees active + scheduled rows; expired excluded',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await app.inject({ method: 'GET', url: '/staff/rates' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Array<{
      category: string;
      location: string | null;
      amount_cents: number;
      unit: string;
      effective_from: string;
      effective_to: string | null;
      note: string | null;
    }>;
    // Active/scheduled fixture rows: day-school fay $75, day-school null $70,
    // day-care null $45 (active) + $50 (future), boarding fay $85. The
    // day-care @bentonville $40 row expired 2026-04-01 → excluded.
    const daySchoolFay = body.find(
      (r) => r.category === 'day-school' && r.location === 'fayetteville',
    );
    assert.ok(daySchoolFay, 'day-school fayetteville present');
    assert.equal(daySchoolFay.amount_cents, 7500);
    assert.equal(daySchoolFay.effective_to, null);
    const expiredBentDaycare = body.find(
      (r) => r.category === 'day-care' && r.location === 'bentonville',
    );
    assert.equal(expiredBentDaycare, undefined, 'expired bentonville day-care excluded');
    // null-location row emits location: null (not omitted).
    assert.ok(
      body.some((r) => r.category === 'day-school' && r.location === null),
      'null-location day-school row present with explicit null',
    );
  },
);

test('GET /staff/rates — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({ method: 'GET', url: '/staff/rates' });
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/rates — insert / correct / supersede
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/rates — first rate for a fresh track inserts an open row',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await postRate({
      app,
      idempotencyKey: `sr-insert-${randomUUID()}`,
      payload: {
        category: 'private-lesson',
        location: 'bentonville',
        amount_cents: 11000,
        unit: 'flat',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { amount_cents: number; effective_from: string; effective_to: null };
    assert.equal(body.amount_cents, 11000);
    assert.equal(body.effective_to, null);
    assert.equal(body.effective_from, '2026-05-19', 'defaults to today (Chicago)');

    const rows = await rowsForTrack('private-lesson', 'bentonville');
    assert.equal(rows.length, 1, 'exactly one row for the fresh track');
    assert.equal(rows[0]!.effectiveTo, null);
  },
);

test(
  'POST /staff/rates — same-day re-edit corrects the open row in place (no new row)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    await postRate({
      app,
      idempotencyKey: `sr-c1-${randomUUID()}`,
      payload: {
        category: 'private-lesson',
        location: 'fayetteville',
        amount_cents: 10000,
        unit: 'flat',
      },
    });
    const second = await postRate({
      app,
      idempotencyKey: `sr-c2-${randomUUID()}`,
      payload: {
        category: 'private-lesson',
        location: 'fayetteville',
        amount_cents: 12000,
        unit: 'flat',
      },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((second.json() as { amount_cents: number }).amount_cents, 12000);

    const rows = await rowsForTrack('private-lesson', 'fayetteville');
    assert.equal(rows.length, 1, 'same-day correction updates in place, no second row');
    assert.equal(rows[0]!.amountCents, 12000);
    assert.equal(rows[0]!.effectiveTo, null);
  },
);

test(
  'POST /staff/rates — future effective_from supersedes: closes the open row, opens a new one',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await postRate({
      app,
      idempotencyKey: `sr-sup-${randomUUID()}`,
      payload: {
        category: 'day-school',
        location: 'fayetteville',
        amount_cents: 8000,
        unit: 'per-day',
        effective_from: '2026-07-01',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { amount_cents: number; effective_from: string; effective_to: null };
    assert.equal(body.amount_cents, 8000);
    assert.equal(body.effective_from, '2026-07-01');
    assert.equal(body.effective_to, null);

    const rows = await rowsForTrack('day-school', 'fayetteville');
    assert.equal(rows.length, 2, 'old window + new window');
    const old = rows.find((r) => r.amountCents === 7500);
    const next = rows.find((r) => r.amountCents === 8000);
    assert.ok(old && next);
    assert.equal(old.effectiveTo, '2026-07-01', 'prior window closed at the new start');
    assert.equal(next.effectiveFrom, '2026-07-01');
    assert.equal(next.effectiveTo, null);
  },
);

test(
  'POST /staff/rates — effective_from before a scheduled future rate → 409 conflict',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    // Schedule a future rate first (fresh track), then try to slot one earlier.
    await postRate({
      app,
      idempotencyKey: `sr-cf1-${randomUUID()}`,
      payload: {
        category: 'boarding',
        location: 'bentonville',
        amount_cents: 9000,
        unit: 'per-night',
        effective_from: '2026-09-01',
      },
    });
    const earlier = await postRate({
      app,
      idempotencyKey: `sr-cf2-${randomUUID()}`,
      payload: {
        category: 'boarding',
        location: 'bentonville',
        amount_cents: 8800,
        unit: 'per-night',
        effective_from: '2026-08-01',
      },
    });
    assert.equal(earlier.statusCode, 409, earlier.body);
    assert.equal((earlier.json() as { error: { code: string } }).error.code, 'conflict');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/rates — validation + auth
// ──────────────────────────────────────────────────────────────────────────

test('POST /staff/rates — back-dated effective_from → 422', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const res = await postRate({
    app,
    idempotencyKey: `sr-back-${randomUUID()}`,
    payload: {
      category: 'day-care',
      location: 'fayetteville',
      amount_cents: 5000,
      unit: 'per-day',
      effective_from: '2026-01-01',
    },
  });
  assert.equal(res.statusCode, 422, res.body);
  assert.match((res.json() as { error: { message: string } }).error.message, /back-dated|past/);
});

test(
  'POST /staff/rates — day-school priced with a non-per-day unit → 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await postRate({
      app,
      idempotencyKey: `sr-unit-${randomUUID()}`,
      payload: {
        category: 'day-school',
        location: 'bentonville',
        amount_cents: 6500,
        unit: 'per-week',
      },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.match((res.json() as { error: { message: string } }).error.message, /per-day/);
  },
);

test('POST /staff/rates — bad enum / amount / missing key', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const bad = async (payload: Record<string, unknown>, key = `sr-bad-${randomUUID()}`) =>
    (await postRate({ app, idempotencyKey: key, payload })).statusCode;

  assert.equal(
    await bad({
      category: 'dog-grooming',
      location: 'fayetteville',
      amount_cents: 5000,
      unit: 'per-day',
    }),
    400,
    'unknown category',
  );
  assert.equal(
    await bad({ category: 'day-care', location: 'tulsa', amount_cents: 5000, unit: 'per-day' }),
    400,
    'unknown location',
  );
  assert.equal(
    await bad({ category: 'day-care', location: 'fayetteville', amount_cents: 0, unit: 'per-day' }),
    400,
    'amount below min',
  );
  assert.equal(
    await bad({
      category: 'day-care',
      location: 'fayetteville',
      amount_cents: 2_000_000,
      unit: 'per-day',
    }),
    400,
    'amount above max',
  );
  // Missing Idempotency-Key.
  const res = await postRate({
    app,
    payload: {
      category: 'day-care',
      location: 'fayetteville',
      amount_cents: 5000,
      unit: 'per-day',
    },
  });
  assert.equal(res.statusCode, 400, 'missing idempotency key');
});

test('POST /staff/rates — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await postRate({
    app,
    idempotencyKey: `sr-403-${randomUUID()}`,
    payload: {
      category: 'day-care',
      location: 'fayetteville',
      amount_cents: 5000,
      unit: 'per-day',
    },
  });
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// Idempotency + concurrency
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/rates — idempotent replay returns the same row, no double supersede',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const key = `sr-idemp-${randomUUID()}`;
    const payload = {
      category: 'board-and-train',
      location: 'fayetteville',
      amount_cents: 200000,
      unit: 'flat',
    };
    const a = await postRate({ app, idempotencyKey: key, payload });
    const b = await postRate({ app, idempotencyKey: key, payload });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.deepEqual(a.json(), b.json(), 'replay returns identical body');
    const rows = await rowsForTrack('board-and-train', 'fayetteville');
    assert.equal(rows.length, 1, 'replay did not insert a second row');
  },
);

test(
  'POST /staff/rates — concurrent edits to one track serialize (one open window)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const payload = (cents: number) => ({
      category: 'day-care' as const,
      location: 'bentonville' as const,
      amount_cents: cents,
      unit: 'per-day' as const,
    });
    const [a, b] = await Promise.all([
      postRate({ app, idempotencyKey: `sr-race1-${randomUUID()}`, payload: payload(4100) }),
      postRate({ app, idempotencyKey: `sr-race2-${randomUUID()}`, payload: payload(4200) }),
    ]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    // Both effective today → the advisory lock makes the second an in-place
    // correction of the first's row, never a second open window.
    const open = await db
      .select({ id: serviceRates.id })
      .from(serviceRates)
      .where(
        and(
          eq(serviceRates.category, 'day-care'),
          eq(serviceRates.location, 'bentonville'),
          isNull(serviceRates.effectiveTo),
        ),
      );
    assert.equal(open.length, 1, 'exactly one open window after concurrent edits');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Integration — a set rate drives the PAYG charge amount
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/rates — a new rate is what the next PAYG booking is charged',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app: staff } = staffApp();
    const { app: owner } = ownerBookingApp();

    // Set a fayetteville-specific day-care rate ($52) — beats the null $45.
    const setRate = await postRate({
      app: staff,
      idempotencyKey: `sr-int-${randomUUID()}`,
      payload: {
        category: 'day-care',
        location: 'fayetteville',
        amount_cents: 5200,
        unit: 'per-day',
      },
    });
    assert.equal(setRate.statusCode, 200, setRate.body);

    const booking = await owner.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `sr-int-book-${randomUUID()}` },
      payload: {
        category: 'day-care',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [futureWeekday(33)],
        location: 'fayetteville',
        payment: 'payg',
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(booking.statusCode, 201, booking.body);
    const bookingId = (booking.json() as Array<{ id: string }>)[0]!.id;

    const [invoice] = await db
      .select({ amountCents: invoicesTable.amountCents })
      .from(invoicesTable)
      .where(eq(invoicesTable.bookingId, bookingId));
    assert.ok(invoice, 'PAYG invoice scheduled');
    assert.equal(
      invoice.amountCents,
      5200,
      'charged the staff-set rate, not the null-location $45',
    );
  },
);
