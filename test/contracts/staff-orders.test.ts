import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings,
  creditPackages,
  charges,
  creditLedger,
  idempotencyKeys,
  invoices,
  notifications,
  orders,
  owners,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { deepLinkToPath } from '../../src/contracts/wire.js';
import type {
  ApiErrorEnvelope,
  BookingWire,
  GetStaffPaymentsPendingResponse,
  PostStaffOrdersCancelResponse,
} from '../../src/contracts/wire.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { createFundedDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, FIXTURE_NOW, futureWeekday } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import {
  clearOrderRows,
  seedInvoiceOrder,
  seedOpenInvoice,
  seedPendingBookingOrder,
  seedPendingPurchaseOrder,
  type SeededOrder,
} from './_orderFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';

/**
 * PAY-U07's two staff routes and the order-wide cancel, on seeded rows (DECISIONS
 * 142(d)). Every outcome of *Cancel order* is asserted here by name: the union is
 * inline, so mutant mE showed the compiler will not hold it (notes A16).
 */

const createdDogs: string[] = [];
after(async () => {
  await clearOrderRows();
  await removeDogs(createdDogs);
});
registerFixtureHooks();
afterEach(clearOrderRows);

const T0 = FIXTURE_NOW();
const LEASE_END = new Date(T0.getTime() + 150_000);

function buildApp(principal: Principal = FIXTURE_STAFF_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: StripeStub;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerStaffOrdersRoute(app, { authenticate, stripe, now: () => T0 });
  registerStaffBookingsRoute(app, { authenticate, stripe, now: () => T0 });
  registerBookingsRoute(app, { authenticate, stripe, now: () => T0 });
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

type App = ReturnType<typeof buildApp>['app'];

function cancelOrder(app: App, orderId: string, key = `cancel-${randomUUID()}`) {
  return app.inject({
    method: 'POST',
    url: `/staff/orders/${orderId}/cancel`,
    headers: { 'idempotency-key': key },
  });
}

async function statuses(seeded: SeededOrder): Promise<string[]> {
  if (seeded.bookingIds.length === 0) return [];
  const rows = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(inArray(bookings.id, seeded.bookingIds));
  return rows.map((r) => r.status);
}

async function chargeStatus(chargeId: string): Promise<string | undefined> {
  const [row] = await db.select().from(charges).where(eq(charges.id, chargeId));
  return row?.status;
}

async function balance(dogId: string): Promise<number> {
  const rows = await db
    .select({ delta: creditLedger.delta })
    .from(creditLedger)
    .where(eq(creditLedger.dogId, dogId));
  return rows.reduce((sum, r) => sum + r.delta, 0);
}

async function claimOf(seeded: SeededOrder) {
  const [claim] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, seeded.claimKey));
  return claim;
}

function stripeCount(stripe: StripeStub, method: string): number {
  return stripe.calls.filter((c) => c.method === method).length;
}

// ── POST /staff/orders/:id/cancel ────────────────────────────────────────────

test(
  'Cancel order: cancelled when Stripe answers canceled: rows, debits, charge, claim, notice',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const before = await balance(dogId);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1), futureWeekday(2)],
      now: T0,
      intentStatus: 'requires_confirmation',
    });
    assert.equal(await balance(dogId), before - 2, 'the seed debited two');

    const res = await cancelOrder(app, seeded.orderId);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      order_id: seeded.orderId,
      outcome: 'cancelled',
    } satisfies PostStaffOrdersCancelResponse);

    assert.equal(stripeCount(stripe, 'cancelPaymentIntent'), 1, 'Stripe was asked first');
    assert.deepEqual(await statuses(seeded), ['cancelled', 'cancelled']);
    assert.equal(await balance(dogId), before, 'every debit returned');
    assert.equal(await chargeStatus(seeded.chargeId), 'failed');
    const claim = await claimOf(seeded);
    assert.equal(claim?.responseStatus, 402, 'the claim is completed with the 402');
    const stored = claim?.responseBody as ApiErrorEnvelope;
    assert.equal(stored.error.code, 'payment_failed');
    const [notice] = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, `order-cancelled:${seeded.chargeId}`));
    assert.equal(notice?.type, 'payment-failed');
    assert.equal(notice?.trigger, 'order-cancelled');
    assert.match(notice?.body ?? '', /weren't charged/);
  },
);

test(
  'Cancel order: cancelled with no intent id: no Stripe call, because the create cannot charge',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1)],
      now: T0,
      intentStatus: null,
      attemptCount: 0,
    });
    const res = await cancelOrder(app, seeded.orderId);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as PostStaffOrdersCancelResponse).outcome, 'cancelled');
    assert.equal(stripeCount(stripe, 'cancelPaymentIntent'), 0);
    assert.equal(await chargeStatus(seeded.chargeId), 'failed');
    const stored = (await claimOf(seeded))?.responseBody as ApiErrorEnvelope;
    assert.equal(
      (stored.error.details as { outcome?: string; attempts?: number }).outcome,
      'abandoned',
      'no confirm was sent',
    );
  },
);

test(
  'Cancel order: still processing: cancelled anyway, and nothing says the payment failed',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1)],
      now: T0,
      intentStatus: 'processing',
    });
    const res = await cancelOrder(app, seeded.orderId);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as PostStaffOrdersCancelResponse).outcome, 'cancelled');
    assert.equal(await chargeStatus(seeded.chargeId), 'failed');
    assert.deepEqual(await statuses(seeded), ['cancelled']);

    const stored = (await claimOf(seeded))?.responseBody as ApiErrorEnvelope;
    assert.equal(
      (stored.error.details as { charge_blocker?: string }).charge_blocker,
      'processing',
      'the stored 402 says money may be in motion',
    );
    assert.doesNotMatch(stored.error.message, /fail|declin/i);
    const failedNotices = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.type, 'payment-failed'));
    assert.equal(failedNotices.length, 0, 'never "payment failed"');
  },
);

test(
  'Cancel order: settled: a purchase whose charge already succeeded stands, and Stripe is not asked',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const seeded = await seedPendingPurchaseOrder(stripe, {
      now: T0,
      intentStatus: 'succeeded',
      chargeStatus: 'succeeded',
    });
    const before = stripe.calls.length;
    const res = await cancelOrder(app, seeded.orderId);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      order_id: seeded.orderId,
      outcome: 'settled',
    } satisfies PostStaffOrdersCancelResponse);
    assert.equal(stripe.calls.length, before);
    assert.equal(await chargeStatus(seeded.chargeId), 'succeeded');
  },
);

test(
  'Cancel order: settled: the payment won the race on an invoice order, so the settle runs',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'requires_confirmation',
      attemptingUntil: LEASE_END,
    });
    stripe.captureBeforeCancel();

    const res = await cancelOrder(app, seeded.orderId);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as PostStaffOrdersCancelResponse).outcome, 'settled');
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    assert.equal(invoice?.status, 'paid');
    assert.equal(await chargeStatus(seeded.chargeId), 'succeeded');
    assert.equal((await claimOf(seeded))?.responseStatus, 201, 'the 201 is what the key replays');
  },
);

test(
  'Cancel order: settled_then_cancelled: a succeeded top-up keeps its charge and its rows go back as credits',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const before = await balance(dogId);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1), futureWeekday(2)],
      now: T0,
      intentStatus: 'succeeded',
      chargeStatus: 'succeeded',
      rowStatus: 'upcoming',
    });
    const res = await cancelOrder(app, seeded.orderId);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      order_id: seeded.orderId,
      outcome: 'settled_then_cancelled',
    } satisfies PostStaffOrdersCancelResponse);
    assert.equal(await chargeStatus(seeded.chargeId), 'succeeded', 'the money stands');
    assert.deepEqual(await statuses(seeded), ['cancelled', 'cancelled']);
    assert.equal(await balance(dogId), before, 'each back to its lot');
    // An ordinary cancel of each row: one notice a row, by the row's own link.
    for (const bookingId of seeded.bookingIds) {
      const rowNotices = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'booking-cancelled'),
            eq(notifications.deepLinkPath, deepLinkToPath({ kind: 'booking', id: bookingId })),
          ),
        );
      assert.equal(rowNotices.length, 1, 'one ordinary notice per row');
    }
  },
);

test(
  'Cancel order on a settled order never cancels an attended day: the past row stands and its ledger rows do not move',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1), futureWeekday(2)],
      now: T0,
      intentStatus: 'succeeded',
      chargeStatus: 'succeeded',
      rowStatus: 'upcoming',
    });
    const [attended, coming] = seeded.bookingIds;
    assert.ok(attended && coming);
    await db.update(bookings).set({ status: 'past' }).where(eq(bookings.id, attended));
    const ledgerOf = () =>
      db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.bookingId, attended));
    const ledgerBefore = (await ledgerOf()).length;

    const res = await cancelOrder(app, seeded.orderId);

    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as PostStaffOrdersCancelResponse).outcome, 'settled_then_cancelled');
    const rows = await db
      .select({ id: bookings.id, status: bookings.status })
      .from(bookings)
      .where(inArray(bookings.id, seeded.bookingIds));
    assert.equal(rows.find((r) => r.id === attended)?.status, 'past', 'the attended day stands');
    assert.equal(rows.find((r) => r.id === coming)?.status, 'cancelled');
    assert.equal((await ledgerOf()).length, ledgerBefore, 'its ledger rows do not move');
  },
);

test('Cancel order: 404 for an id naming no order', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await cancelOrder(app, randomUUID());
  assert.equal(res.statusCode, 404, res.body);
  assert.equal((res.json() as ApiErrorEnvelope).error.code, 'not_found');
});

test('Cancel order: 409 for an order with nothing pending', SKIP_WHEN_NO_DB, async () => {
  const { app, stripe } = buildApp();

  // No charge: a credits-only Confirm.
  const [bare] = await db
    .insert(orders)
    .values({ ownerId: FIXTURE_IDS.ownerId })
    .returning({ id: orders.id });
  assert.ok(bare);
  const noCharge = await cancelOrder(app, bare.id);
  assert.equal(noCharge.statusCode, 409, noCharge.body);
  assert.equal((noCharge.json() as ApiErrorEnvelope).error.code, 'conflict');

  // A charge already failed.
  const seeded = await seedPendingPurchaseOrder(stripe, { now: T0, chargeStatus: 'failed' });
  const failed = await cancelOrder(app, seeded.orderId);
  assert.equal(failed.statusCode, 409, failed.body);
  assert.equal(stripeCount(stripe, 'cancelPaymentIntent'), 0, 'and Stripe is not asked');
});

test(
  'Cancel order: a retry on one key replays, and asks Stripe once',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1)],
      now: T0,
      intentStatus: 'requires_confirmation',
    });
    const key = `cancel-retry-${randomUUID()}`;
    const first = await cancelOrder(app, seeded.orderId, key);
    assert.equal(first.statusCode, 200, first.body);
    const asked = stripe.calls.length;

    const second = await cancelOrder(app, seeded.orderId, key);
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json(), first.json());
    assert.equal(stripe.calls.length, asked, 'a replay asks Stripe nothing');
  },
);

test(
  'Cancel order: any staff role; an owner principal is 403; a bad id is 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const trainer = buildApp(FIXTURE_STAFF_PRINCIPAL);
    const seeded = await seedPendingBookingOrder(trainer.stripe, {
      dogId,
      dates: [futureWeekday(1)],
      now: T0,
      intentStatus: 'requires_confirmation',
    });
    const family = buildApp(FIXTURE_OWNER_PRINCIPAL);
    const forbidden = await cancelOrder(family.app, seeded.orderId);
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    const malformed = await cancelOrder(trainer.app, 'not-a-uuid');
    assert.equal(malformed.statusCode, 400, malformed.body);
    const missingKey = await trainer.app.inject({
      method: 'POST',
      url: `/staff/orders/${seeded.orderId}/cancel`,
    });
    assert.equal(missingKey.statusCode, 400, missingKey.body);
    const allowed = await cancelOrder(trainer.app, seeded.orderId);
    assert.equal(allowed.statusCode, 200, allowed.body);
  },
);

// ── GET /staff/payments/pending ──────────────────────────────────────────────

test(
  'GET /staff/payments/pending: a package row names its pack, from charges.package_id, and no other kind carries the label',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const [pack] = await db
      .select({ id: creditPackages.id })
      .from(creditPackages)
      .where(eq(creditPackages.key, 'school-2x-weekly-fayetteville'));
    assert.ok(pack);
    const longAgo = new Date(T0.getTime() - 60 * 60_000);
    const purchase = await seedPendingPurchaseOrder(stripe, {
      now: T0,
      createdAt: longAgo,
      amountCents: 45_600,
      packageId: pack.id,
      creditsCount: 8,
    });

    const res = await app.inject({ method: 'GET', url: '/staff/payments/pending' });

    assert.equal(res.statusCode, 200, res.body);
    const row = (res.json() as GetStaffPaymentsPendingResponse).find(
      (r) => r.order_id === purchase.orderId,
    );
    assert.equal(row?.kind, 'package');
    assert.equal(row?.package_label, 'Fayetteville 2x Weekly');
  },
);

test(
  'GET /staff/payments/pending: a top-up names its rows and no package_label',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 1);
    const { app, stripe } = buildApp(FIXTURE_MANAGER_PRINCIPAL);
    const [pack] = await db
      .select({ id: creditPackages.id })
      .from(creditPackages)
      .where(eq(creditPackages.key, 'school-2x-weekly-fayetteville'));
    assert.ok(pack);
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1)],
      now: T0,
      createdAt: new Date(T0.getTime() - 60 * 60_000),
    });
    await db.update(charges).set({ packageId: pack.id }).where(eq(charges.id, seeded.chargeId));

    const res = await app.inject({ method: 'GET', url: '/staff/payments/pending' });

    assert.equal(res.statusCode, 200, res.body);
    const row = (res.json() as GetStaffPaymentsPendingResponse).find(
      (r) => r.order_id === seeded.orderId,
    );
    assert.ok(row);
    assert.notEqual(row.kind, 'package');
    assert.equal('package_label' in row, false);
  },
);

test(
  'GET /staff/payments/pending: past the limit, oldest first, every campus, with sessions on a booking order',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const { app, stripe } = buildApp(FIXTURE_MANAGER_PRINCIPAL);
    const minutesAgo = (n: number): Date => new Date(T0.getTime() - n * 60_000);

    const inside = await seedPendingPurchaseOrder(stripe, { now: T0, createdAt: minutesAgo(9) });
    const pack = await seedPendingPurchaseOrder(stripe, { now: T0, createdAt: minutesAgo(11) });
    const booking = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(2), futureWeekday(1)],
      now: T0,
      createdAt: minutesAgo(25),
    });
    const invoiceId = await seedOpenInvoice();
    const invoiceOrder = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: T0,
      intentStatus: 'processing',
      attemptingUntil: minutesAgo(20),
    });
    await db
      .update(orders)
      .set({ createdAt: minutesAgo(30).toISOString() })
      .where(eq(orders.id, invoiceOrder.orderId));

    const res = await app.inject({ method: 'GET', url: '/staff/payments/pending' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as GetStaffPaymentsPendingResponse;
    assert.deepEqual(
      body.map((p) => p.order_id),
      [booking.orderId, pack.orderId],
      'oldest first, past the limit, and no invoice payment (A1)',
    );
    assert.ok(!body.some((p) => p.order_id === inside.orderId), 'nine minutes is not past ten');

    const [first, second] = body;
    assert.equal(first?.kind, 'booking');
    assert.equal(first?.amount_cents, 6_000);
    assert.equal(first?.minutes_pending, 25);
    assert.equal(first?.owner.id, FIXTURE_IDS.ownerId);
    assert.ok(first?.owner.name);
    const dates = (first?.sessions ?? []).map((s: BookingWire) => s.date);
    assert.deepEqual(dates, [...dates].sort(), 'sessions ascending');
    assert.equal(first?.sessions?.length, 2);
    assert.ok((first?.sessions ?? []).every((s: BookingWire) => s.order_id === booking.orderId));

    assert.equal(second?.kind, 'package');
    assert.equal(second?.sessions, undefined, 'omitted on an order with none');
  },
);

test(
  'GET /staff/payments/pending: a family with no name reads by its email; an owner principal is 403',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    await seedPendingPurchaseOrder(stripe, {
      now: T0,
      createdAt: new Date(T0.getTime() - 15 * 60_000),
    });
    const [owner] = await db
      .select({ name: owners.name, email: owners.email })
      .from(owners)
      .where(eq(owners.id, FIXTURE_IDS.ownerId));
    await db.update(owners).set({ name: null }).where(eq(owners.id, FIXTURE_IDS.ownerId));
    try {
      const res = await app.inject({ method: 'GET', url: '/staff/payments/pending' });
      assert.equal(res.statusCode, 200, res.body);
      const [row] = res.json() as GetStaffPaymentsPendingResponse;
      assert.equal(row?.owner.name, owner?.email);
    } finally {
      await db
        .update(owners)
        .set({ name: owner?.name ?? null })
        .where(eq(owners.id, FIXTURE_IDS.ownerId));
    }
    const family = buildApp(FIXTURE_OWNER_PRINCIPAL);
    const forbidden = await family.app.inject({ method: 'GET', url: '/staff/payments/pending' });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
  },
);

// ── a pending row cancels the order ──────────────────────────────────────────

test(
  'a seeded pending order: the owner cancelling any one row cancels all of it and returns every debit',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const before = await balance(dogId);
    const { app, stripe } = buildApp(FIXTURE_OWNER_PRINCIPAL);
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1), futureWeekday(2), futureWeekday(3)],
      now: T0,
      intentStatus: 'requires_confirmation',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/bookings/${seeded.bookingIds[1]}/cancel`,
      headers: { 'idempotency-key': `row-cancel-${randomUUID()}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as BookingWire).status, 'cancelled');
    assert.deepEqual(await statuses(seeded), ['cancelled', 'cancelled', 'cancelled']);
    assert.equal(await balance(dogId), before, 'every debit returned');
    assert.equal(await chargeStatus(seeded.chargeId), 'failed');
    assert.equal(stripeCount(stripe, 'cancelPaymentIntent'), 1, 'Stripe was asked first');

    const reminders = await db
      .select({ status: scheduledNotifications.status })
      .from(scheduledNotifications)
      .where(inArray(scheduledNotifications.bookingId, seeded.bookingIds));
    assert.ok(
      reminders.every((r) => r.status !== 'pending'),
      'every reminder is torn down',
    );
    const [forfeit] = await db
      .select({ cancelForfeited: bookings.cancelForfeited })
      .from(bookings)
      .where(eq(bookings.id, seeded.bookingIds[0]!));
    assert.equal(forfeit?.cancelForfeited, false, 'a pending row forfeits nothing');
  },
);

test(
  'a seeded pending order: staff cancelling any one row cancels the whole order, through the one service',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 3);
    const before = await balance(dogId);
    const { app, stripe } = buildApp();
    const seeded = await seedPendingBookingOrder(stripe, {
      dogId,
      dates: [futureWeekday(1), futureWeekday(2)],
      now: T0,
      intentStatus: 'processing',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/staff/bookings/${seeded.bookingIds[0]}/cancel`,
      headers: { 'idempotency-key': `staff-row-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(await statuses(seeded), ['cancelled', 'cancelled']);
    assert.equal(await balance(dogId), before);
    assert.equal(await chargeStatus(seeded.chargeId), 'failed');
  },
);

test(
  'lock order: Cancel order, the webhook failure policy and a row cancel raced on one order answer without a 40P01',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createFundedDog(createdDogs, 30);
    for (let round = 0; round < 12; round += 1) {
      const staffApp = buildApp(FIXTURE_STAFF_PRINCIPAL);
      const ownerApp = buildApp(FIXTURE_OWNER_PRINCIPAL);
      const seeded = await seedPendingBookingOrder(staffApp.stripe, {
        dogId,
        dates: [futureWeekday(round + 1)],
        now: T0,
        intentStatus: 'canceled',
      });
      assert.ok(seeded.intentId);
      staffApp.stripe.setNextEvent({
        id: `evt_test_${randomUUID().slice(0, 8)}`,
        type: 'payment_intent.canceled',
        paymentIntentId: seeded.intentId,
        amountCents: 6_000,
        metadata: {},
      });
      const responses = await Promise.all([
        staffApp.app.inject({
          method: 'POST',
          url: '/webhooks/stripe',
          headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
          payload: '{}',
        }),
        cancelOrder(staffApp.app, seeded.orderId),
        staffApp.app.inject({
          method: 'POST',
          url: `/staff/bookings/${seeded.bookingIds[0]}/cancel`,
          headers: { 'idempotency-key': `race-staff-${randomUUID()}` },
          payload: {},
        }),
        ownerApp.app.inject({
          method: 'POST',
          url: `/bookings/${seeded.bookingIds[0]}/cancel`,
          headers: { 'idempotency-key': `race-owner-${randomUUID()}` },
        }),
      ]);
      for (const res of responses) {
        assert.ok(res.statusCode < 500, `round ${round}: ${res.statusCode} ${res.body}`);
      }
      assert.deepEqual(await statuses(seeded), ['cancelled']);
      await clearOrderRows();
    }
  },
);
