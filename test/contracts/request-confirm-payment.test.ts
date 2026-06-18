import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { requestsRepository } from '../../src/db/repositories/requestsRepository.js';
import {
  bookings,
  charges,
  invoices,
  notifications,
  pendingRequestDogs,
  pendingRequests,
} from '../../src/db/schema/schema.js';
import { registerRequestConfirmPaymentRoute } from '../../src/routes/requestConfirmPayment.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';

registerFixtureHooks();

function buildApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerRequestConfirmPaymentRoute(app, { authenticate, stripe });
  return { app, stripe };
}

async function seedApprovedAwaitingPaymentBT(): Promise<string> {
  // Create a B&T pending request at status='approved-awaiting-payment',
  // single-dog (Waffles), length_weeks=2.
  const { id } = await db.transaction(async (tx) =>
    requestsRepository.create(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'board-and-train',
      notesPerDog: 'Build a foundation cue set',
      notesJoint: null,
      staffPreference: null,
      descriptorKeys: [],
      lengthWeeks: 2,
    }),
  );
  await db.transaction(async (tx) =>
    requestsRepository.addDogs(tx, id, { lead: FIXTURE_IDS.dog1Id, additional: [] }),
  );
  await db.transaction(async (tx) =>
    requestsRepository.markApprovedAwaitingPayment(tx, id, {
      approvedByStaffId: FIXTURE_IDS.staffRachelId,
    }),
  );
  return id;
}

async function cleanup(): Promise<void> {
  // Order: notifications + invoices + charges + booking_dogs (cascade)
  // + bookings + pending_request_dogs (cascade) + pending_requests.
  await db.delete(notifications).where(eq(notifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  // Drop any test-created pending requests (not the two fixture rows
  // pendingRequest1Id / pendingRequest2Id — those have specific ids).
  // Cascade pulls down pending_request_dogs + preferred_dates.
  const created = await db
    .select({ id: pendingRequests.id })
    .from(pendingRequests)
    .where(eq(pendingRequests.ownerId, FIXTURE_IDS.ownerId));
  const testIds = created
    .map((r) => r.id)
    .filter((id) => id !== FIXTURE_IDS.pendingRequest1Id && id !== FIXTURE_IDS.pendingRequest2Id);
  if (testIds.length > 0) {
    // pending_request_dogs cascades; pending_request_preferred_dates cascades.
    await db.delete(pendingRequestDogs).where(inArray(pendingRequestDogs.requestId, testIds));
    await db.delete(pendingRequests).where(inArray(pendingRequests.id, testIds));
  }
  // Drop any test-created bookings (not the fixture's 10 booking ids).
  const fixtureBookingIds = [
    FIXTURE_IDS.booking1Id,
    FIXTURE_IDS.booking2Id,
    FIXTURE_IDS.booking3Id,
    FIXTURE_IDS.booking4Id,
    FIXTURE_IDS.booking5Id,
    FIXTURE_IDS.booking6Id,
    FIXTURE_IDS.booking7Id,
    FIXTURE_IDS.booking8Id,
    FIXTURE_IDS.booking9Id,
    FIXTURE_IDS.bookingDstId,
  ];
  const allBookings = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.ownerId, FIXTURE_IDS.ownerId));
  const testBookingIds = allBookings
    .map((b) => b.id)
    .filter((id) => !fixtureBookingIds.includes(id));
  if (testBookingIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.id, testBookingIds));
  }
}

test(
  'POST /requests/:id/confirm-payment pay-now — Stripe succeeded → charges + booking + request converted',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const requestId = await seedApprovedAwaitingPaymentBT();
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/requests/${requestId}/confirm-payment`,
      headers: { 'idempotency-key': `cp-bt-${randomUUID()}` },
      payload: {
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        scheduled_at: '2026-07-01T15:00:00Z',
        dropoff_at: '2026-07-01T15:00:00Z',
        pickup_at: '2026-07-15T17:00:00Z',
        location: 'fayetteville',
        notes: 'standard 2-week program',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { id: string; status: string };
    assert.equal(body.status, 'converted');

    const [chargeRow] = await db
      .select({ amountCents: charges.amountCents, purpose: charges.purpose })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRow?.amountCents, 200_000);
    assert.equal(chargeRow?.purpose, 'board-train');

    // PI called once at the B&T price.
    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 1);
    assert.equal(piCalls[0]?.args.amountCents, 200_000);

    await cleanup();
  },
);

test(
  'POST /requests/:id/confirm-payment pay-later — open invoice + booking + request converted, no charge',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const requestId = await seedApprovedAwaitingPaymentBT();
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/requests/${requestId}/confirm-payment`,
      headers: { 'idempotency-key': `cp-bt-later-${randomUUID()}` },
      payload: {
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        scheduled_at: '2026-07-01T15:00:00Z',
        dropoff_at: '2026-07-01T15:00:00Z',
        pickup_at: '2026-07-15T17:00:00Z',
        location: 'fayetteville',
        pay_later: true,
        due_at: '2026-07-01T00:00:00Z',
      },
    });
    assert.equal(res.statusCode, 200, res.body);

    // No charges row — pay-later path.
    const chargesRows = await db
      .select()
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargesRows.length, 0);

    // One open invoice with the correct amount.
    const [inv] = await db.select().from(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
    assert.ok(inv, 'invoice was written');
    assert.equal(inv?.status, 'open');
    assert.equal(inv?.amountCents, 200_000);
    assert.equal(inv?.purpose, 'board-train');
    assert.equal(inv?.requestId, requestId);

    // Stripe wasn't called.
    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 0);

    await cleanup();
  },
);

test(
  'POST /requests/:id/confirm-payment — request in wrong state (submitted) → 409',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // Seed a 'submitted' request (no markApprovedAwaitingPayment).
    const { id } = await db.transaction(async (tx) =>
      requestsRepository.create(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: FIXTURE_IDS.dog1Id,
        category: 'board-and-train',
        notesPerDog: null,
        notesJoint: null,
        staffPreference: null,
        descriptorKeys: [],
        lengthWeeks: 2,
      }),
    );
    await db.transaction(async (tx) =>
      requestsRepository.addDogs(tx, id, { lead: FIXTURE_IDS.dog1Id, additional: [] }),
    );
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/requests/${id}/confirm-payment`,
      headers: { 'idempotency-key': `cp-bt-409-${randomUUID()}` },
      payload: {
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        scheduled_at: '2026-07-01T15:00:00Z',
        dropoff_at: '2026-07-01T15:00:00Z',
        pickup_at: '2026-07-15T17:00:00Z',
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 409);
    await cleanup();
  },
);

test('POST /requests/:id/confirm-payment — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await app.inject({
    method: 'POST',
    url: '/requests/00000000-0000-4000-8000-000000000000/confirm-payment',
    headers: { 'idempotency-key': `cp-bt-staff-${randomUUID()}` },
    payload: {
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      scheduled_at: '2026-07-01T15:00:00Z',
      dropoff_at: '2026-07-01T15:00:00Z',
      pickup_at: '2026-07-15T17:00:00Z',
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 403);
});
