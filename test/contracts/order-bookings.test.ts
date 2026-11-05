import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { bookings, charges, creditLedger, dogs, orders } from '../../src/db/schema/schema.js';
import type {
  ApiErrorEnvelope,
  BookingWire,
  LedgerEntryWire,
  PostBookingsResponse,
} from '../../src/contracts/wire.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { createBookableDog, createFundedDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, FIXTURE_NOW, futureWeekday } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows, seedOpenInvoice } from './_orderFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * `POST /bookings` answers `{order, sessions}` (P15, PAY-U04, DAY-U16). One Confirm
 * is one order, credits-only included. A credits-only Confirm never enters the
 * engine, so the Stripe stub is here to prove it is never called.
 */

const createdDogs: string[] = [];
after(async () => {
  await clearOrderRows();
  await removeDogs(createdDogs);
});
registerFixtureHooks();
afterEach(clearOrderRows);

function buildApp() {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerBookingsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  registerInvoicesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

function book(
  app: ReturnType<typeof buildApp>['app'],
  dogId: string,
  dates: readonly string[],
  key: string,
) {
  return app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': key },
    payload: {
      category: 'day-school',
      lead_dog_id: dogId,
      dates,
      location: 'fayetteville',
      payment: 'credits',
    },
  });
}

test(
  'POST /bookings: one order per Confirm, replay returns the same order, sessions ascending by date',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs);
    const { app, stripe } = buildApp();
    const key = `order-${randomUUID()}`;
    const dates = [futureWeekday(3), futureWeekday(1), futureWeekday(2)];

    const res = await book(app, dogId, dates, key);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as PostBookingsResponse;

    assert.equal(body.order.owner_id, FIXTURE_IDS.ownerId);
    assert.equal(body.order.charge_status, 'none');
    assert.equal(body.order.client_action, undefined);
    assert.ok(body.order.created_at);

    assert.equal(body.sessions.length, 3, 'one row per date');
    const scheduled = body.sessions.map((s) => s.date);
    assert.deepEqual(scheduled, [...scheduled].sort(), 'ascending');
    assert.ok(body.sessions.every((s) => s.order_id === body.order.id));
    assert.ok(body.sessions.every((s) => s.status === 'upcoming'));

    const rows = await db
      .select({ orderId: bookings.orderId })
      .from(bookings)
      .where(eq(bookings.leadDogId, dogId));
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.orderId === body.order.id));
    const orderRows = await db.select().from(orders).where(eq(orders.id, body.order.id));
    assert.equal(orderRows.length, 1, 'one order');
    assert.equal(orderRows[0]?.invoiceId, null);

    const replay = await book(app, dogId, dates, key);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), body, 'the same order');
    const after = await db.select().from(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(after.length, 1, 'no second order');

    assert.equal(stripe.calls.length, 0, 'a credits-only Confirm never enters the engine');
    const chargeRows = await db.select().from(charges).where(eq(charges.orderId, body.order.id));
    assert.equal(chargeRows.length, 0, 'and writes no charge');
  },
);

test(
  'a gated dog on POST /bookings is refused, no credit debited, the Stripe stub never called',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(createdDogs);
    await db.update(dogs).set({ evaluationStatus: 'not-evaluated' }).where(eq(dogs.id, dogId));
    const { app, stripe } = buildApp();

    const res = await book(app, dogId, [futureWeekday(1)], `gated-${randomUUID()}`);
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as ApiErrorEnvelope).error.code, 'evaluation_required');

    const debits = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.dogId, dogId));
    assert.equal(debits.length, 0, 'no credit debited');
    assert.equal(stripe.calls.length, 0, 'the Stripe stub never called');
    const orderRows = await db.select().from(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(orderRows.length, 0, 'and a refusal leaves no order behind');
  },
);

test('order_id reads back on every read of the row', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createFundedDog(createdDogs);
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerBookingsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  const staff = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffBookingsRoute(staff.app, { authenticate: staff.authenticate, stripe });

  const res = await book(app, dogId, [futureWeekday(1)], `read-${randomUUID()}`);
  assert.equal(res.statusCode, 201, res.body);
  const { order, sessions } = res.json() as PostBookingsResponse;
  const bookingId = sessions[0]?.id;

  const list = await app.inject({ method: 'GET', url: '/bookings?view=upcoming' });
  assert.equal(list.statusCode, 200, list.body);
  const listed = (list.json() as BookingWire[]).find((b) => b.id === bookingId);
  assert.equal(listed?.order_id, order.id, 'GET /bookings');

  const one = await app.inject({ method: 'GET', url: `/bookings/${bookingId}` });
  assert.equal(one.statusCode, 200, one.body);
  assert.equal((one.json() as BookingWire).order_id, order.id, 'GET /bookings/:id');

  const queue = await staff.app.inject({ method: 'GET', url: '/staff/bookings' });
  assert.equal(queue.statusCode, 200, queue.body);
  const queued = (queue.json() as BookingWire[]).find((b) => b.id === bookingId);
  assert.equal(queued?.order_id, order.id, 'GET /staff/bookings');

  const cancelled = await app.inject({
    method: 'POST',
    url: `/bookings/${bookingId}/cancel`,
    headers: { 'idempotency-key': `read-cancel-${randomUUID()}` },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal((cancelled.json() as BookingWire).order_id, order.id, 'the cancel body');
});

test('a row made any other way has no order_id on the wire', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createFundedDog(createdDogs);
  const { app } = buildApp();
  const res = await book(app, dogId, [futureWeekday(1)], `omit-${randomUUID()}`);
  const { sessions } = res.json() as PostBookingsResponse;
  await db
    .update(bookings)
    .set({ orderId: null })
    .where(
      inArray(
        bookings.id,
        sessions.map((s) => s.id),
      ),
    );
  const one = await app.inject({ method: 'GET', url: `/bookings/${sessions[0]?.id}` });
  assert.equal(one.statusCode, 200, one.body);
  assert.equal('order_id' in (one.json() as BookingWire), false, 'omit-on-null');
});

test(
  'LedgerEntryWire.order_id: on a charge the engine made, and omitted on an open invoice',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = buildApp();
    const paid = await seedOpenInvoice();
    const open = await seedOpenInvoice(1_000);
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${paid}/pay`,
      headers: { 'idempotency-key': `ledger-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 201, res.body);
    const { charge_id: chargeId } = res.json() as { charge_id: string };
    const [charge] = await db.select().from(charges).where(eq(charges.id, chargeId));

    const ledger = await app.inject({ method: 'GET', url: '/invoices' });
    assert.equal(ledger.statusCode, 200, ledger.body);
    const entries = ledger.json() as LedgerEntryWire[];
    const paidEntry = entries.find((e) => e.id === chargeId);
    assert.ok(charge?.orderId);
    assert.equal(paidEntry?.order_id, charge.orderId);
    const openEntry = entries.find((e) => e.id === open);
    assert.ok(openEntry);
    assert.equal('order_id' in (openEntry as object), false);
  },
);
