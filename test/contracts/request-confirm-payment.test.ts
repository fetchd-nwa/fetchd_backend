import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { hashRequestBody } from '../../src/db/mutation.js';
import { withActor } from '../../src/db/tx.js';
import { requestsRepository } from '../../src/db/repositories/requestsRepository.js';
import {
  bookings,
  charges,
  idempotencyKeys,
  invoices,
  notifications,
  pendingRequestDogs,
  pendingRequests,
  scheduledNotifications,
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
import { makeStripeStub, type StripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';
import type {
  StripeClient,
  StripePaymentIntentResult,
  StripePaymentIntentStatus,
} from '../../src/lib/stripe.js';

registerFixtureHooks();

/**
 * `wrapStripe` lets a test interpose on the seam the route talks to while still
 * reading the underlying stub's recorded `calls` — the unwind test uses it to
 * make a concurrent conversion land in the window between the pre-tx read and
 * the transaction, which is the only place that race can be reproduced.
 */
function buildApp(
  principal: Principal = FIXTURE_OWNER_PRINCIPAL,
  wrapStripe: (base: StripeStub) => StripeClient = (base) => base,
): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: StripeStub;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerRequestConfirmPaymentRoute(app, { authenticate, stripe: wrapStripe(stripe) });
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

/** The PaymentIntent ids this stub was asked to cancel. */
function cancelledIntents(stripe: StripeStub): string[] {
  return stripe.calls
    .filter((c) => c.method === 'cancelPaymentIntent')
    .map((c) => c.args.paymentIntentId);
}

/** The Stripe idempotency keys this stub was asked to refund under — the key
 *  names which unwind fired, so a test can't mistake one refund for another. */
function refundKeys(stripe: StripeStub): string[] {
  return stripe.calls.filter((c) => c.method === 'createRefund').map((c) => c.idempotencyKey);
}

/**
 * Everything this route is capable of creating, counted for the fixture owner.
 * Counted rather than asserted-absent because the fixture already owns
 * bookings and reminder rows: the load-bearing claim is the DELTA, so
 * "no booking was created" can't be quietly satisfied by a cleanup that
 * deleted one.
 */
interface GrantFootprint {
  bookings: number;
  charges: number;
  notifications: number;
  scheduledNotifications: number;
}

async function grantFootprint(): Promise<GrantFootprint> {
  const [bookingRows, chargeRows, notificationRows, scheduledRows] = await Promise.all([
    db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ownerId, FIXTURE_IDS.ownerId)),
    db.select({ id: charges.id }).from(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId)),
    db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.ownerId, FIXTURE_IDS.ownerId)),
    db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId)),
  ]);
  return {
    bookings: bookingRows.length,
    charges: chargeRows.length,
    notifications: notificationRows.length,
    scheduledNotifications: scheduledRows.length,
  };
}

function footprintSince(before: GrantFootprint, after: GrantFootprint): GrantFootprint {
  return {
    bookings: after.bookings - before.bookings,
    charges: after.charges - before.charges,
    notifications: after.notifications - before.notifications,
    scheduledNotifications: after.scheduledNotifications - before.scheduledNotifications,
  };
}

const NOTHING_CREATED: GrantFootprint = {
  bookings: 0,
  charges: 0,
  notifications: 0,
  scheduledNotifications: 0,
};

/** How many `idempotency_keys` rows this key claimed. A refusal throws before
 *  `withMutation` opens, so the key is never claimed and a retry is clean. */
async function idempotencyRowsFor(key: string): Promise<number> {
  const rows = await db
    .select({ key: idempotencyKeys.key })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key));
  return rows.length;
}

async function statusOf(requestId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: pendingRequests.status })
    .from(pendingRequests)
    .where(eq(pendingRequests.id, requestId));
  return row?.status;
}

const CONFIRM_PAYLOAD = {
  payment_method_id: FIXTURE_IDS.paymentMethod1Id,
  scheduled_at: '2026-07-01T15:00:00Z',
  dropoff_at: '2026-07-01T15:00:00Z',
  pickup_at: '2026-07-15T17:00:00Z',
  location: 'fayetteville',
} as const;

test(
  'POST /requests/:id/confirm-payment pay-now — Stripe succeeded → charges + booking + request converted',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const requestId = await seedApprovedAwaitingPaymentBT();
    const { app, stripe } = buildApp();
    const before = await grantFootprint();
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
      .select({
        amountCents: charges.amountCents,
        purpose: charges.purpose,
        status: charges.status,
      })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRow?.amountCents, 200_000);
    assert.equal(chargeRow?.purpose, 'board-train');

    // PI called once at the B&T price.
    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 1);
    assert.equal(piCalls[0]?.args.amountCents, 200_000);

    // The whole grant landed, and nothing was undone: money that settled is
    // never cancelled and never refunded. This is the arm the refusal below
    // must leave exactly as it is.
    assert.equal(chargeRow?.status, 'succeeded');
    assert.deepEqual(cancelledIntents(stripe), []);
    assert.deepEqual(refundKeys(stripe), []);
    assert.deepEqual(
      footprintSince(before, await grantFootprint()),
      // booking + charge + the "Board & Train confirmed!" push + the two
      // reminder rows (booking-reminder, boarding-profile-check).
      { bookings: 1, charges: 1, notifications: 1, scheduledNotifications: 2 },
    );

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

// ──────────────────────────────────────────────────────────────────────────
// A pay-now confirm that did NOT settle refuses the grant (wire 1.8.0)
//
// Board & Train is the priciest thing the school sells, and the booking IS the
// grant: created, drop-off/pick-up stamped, reminders enqueued, request
// converted, "Board & Train confirmed!" pushed. This route used to map Stripe's
// status and then never read it, so all of that landed on money that never
// moved — with the charges row parked at `requires_payment`, no invoice behind
// it for anything to ever re-settle, and a live PaymentIntent that could
// auto-succeed against a later attempt. `POST /memberships` and
// `POST /enrollments` — the other two grant-creating confirm sites — have always
// refused. This is the third.
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /requests/:id/confirm-payment pay-now — a non-succeeded confirm creates NOTHING and 402s',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const requestId = await seedApprovedAwaitingPaymentBT();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');
    const key = `cp-bt-refuse-${randomUUID()}`;
    const before = await grantFootprint();

    const res = await app.inject({
      method: 'POST',
      url: `/requests/${requestId}/confirm-payment`,
      headers: { 'idempotency-key': key },
      payload: { ...CONFIRM_PAYLOAD, notes: 'standard 2-week program' },
    });

    assert.equal(res.statusCode, 402, res.body);
    const body = res.json() as {
      error: { code: string; details?: { kind: string; charge_blocker: string } };
    };
    assert.equal(body.error.code, 'payment_failed');
    assert.equal(body.error.details?.kind, 'payment_failed');
    assert.equal(body.error.details?.charge_blocker, 'authentication_required');

    // The negative space, run rather than grepped: no booking, no reminder
    // rows, no charges row, no push.
    assert.deepEqual(footprintSince(before, await grantFootprint()), NOTHING_CREATED);

    // The request is exactly where it was, so the owner can retry with another
    // card, and the key was never claimed, so that retry is clean.
    assert.equal(await statusOf(requestId), 'approved-awaiting-payment');
    assert.equal(await idempotencyRowsFor(key), 0);

    // And the intent it created is dead — an intent left live after a
    // non-succeeded confirm can auto-succeed later and double-charge against
    // the next attempt's fresh one.
    const piCall = stripe.calls.find((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.ok(piCall !== undefined, 'Stripe was called');
    assert.equal(cancelledIntents(stripe).length, 1, 'the confirmed intent was cancelled');

    await cleanup();
  },
);

test(
  'POST /requests/:id/confirm-payment pay-now — a THROWN card decline refuses identically (wire 1.9.0)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Stripe reports a declined stored card two ways. Before 1.9.0 only the
    // RETURNED fork reached this refusal; the THROWN one blew past it to the
    // global handler as a 500, and the owner read "We couldn't reach the
    // server." on a card that was simply declined. Both forks are now one code
    // path, and this is the assertion that says so at this site.
    await cleanup();
    const requestId = await seedApprovedAwaitingPaymentBT();
    const { app, stripe } = buildApp();
    stripe.setNextIntentThrowsCardError('requires_payment_method');
    const before = await grantFootprint();

    const res = await app.inject({
      method: 'POST',
      url: `/requests/${requestId}/confirm-payment`,
      headers: { 'idempotency-key': `cp-bt-thrown-${randomUUID()}` },
      payload: CONFIRM_PAYLOAD,
    });

    assert.equal(res.statusCode, 402, res.body);
    const body = res.json() as {
      error: { code: string; details?: { charge_blocker: string } };
    };
    assert.equal(body.error.code, 'payment_failed');
    assert.equal(body.error.details?.charge_blocker, 'declined');
    assert.deepEqual(footprintSince(before, await grantFootprint()), NOTHING_CREATED);
    assert.equal(await statusOf(requestId), 'approved-awaiting-payment');
    assert.equal(cancelledIntents(stripe).length, 1, 'the failed intent is cancelled here too');

    await cleanup();
  },
);

test(
  'POST /requests/:id/confirm-payment pay-now — a Stripe TRANSPORT error is not a decline',
  SKIP_WHEN_NO_DB,
  async () => {
    // The other side of the same seam. "We could not reach Stripe" must stay
    // "we do not know whether money moved" — a 402 here would tell the owner to
    // try a different card during an outage, which is wrong advice.
    await cleanup();
    const requestId = await seedApprovedAwaitingPaymentBT();
    const { app, stripe } = buildApp();
    stripe.setNextIntentThrowsTransport();
    const before = await grantFootprint();

    const res = await app.inject({
      method: 'POST',
      url: `/requests/${requestId}/confirm-payment`,
      headers: { 'idempotency-key': `cp-bt-transport-${randomUUID()}` },
      payload: CONFIRM_PAYLOAD,
    });

    assert.notEqual(res.statusCode, 402);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'internal');
    assert.deepEqual(footprintSince(before, await grantFootprint()), NOTHING_CREATED);
    assert.equal(await statusOf(requestId), 'approved-awaiting-payment');

    await cleanup();
  },
);

test(
  'POST /requests/:id/confirm-payment pay-now — a cancel Stripe refuses still refuses the booking',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const requestId = await seedApprovedAwaitingPaymentBT();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const before = await grantFootprint();

    // The cancel is best-effort housekeeping; the refusal is the guarantee.
    // An uncancellable intent must never be the reason a booking gets granted
    // on money that did not move.
    const res = await app.inject({
      method: 'POST',
      url: `/requests/${requestId}/confirm-payment`,
      headers: { 'idempotency-key': `cp-bt-refuse-nocancel-${randomUUID()}` },
      payload: CONFIRM_PAYLOAD,
    });

    assert.equal(res.statusCode, 402, res.body);
    const body = res.json() as { error: { code: string; details?: { charge_blocker: string } } };
    assert.equal(body.error.code, 'payment_failed');
    assert.equal(body.error.details?.charge_blocker, 'processing');
    assert.equal(cancelledIntents(stripe).length, 1, 'the cancel was attempted');
    assert.deepEqual(footprintSince(before, await grantFootprint()), NOTHING_CREATED);
    assert.equal(await statusOf(requestId), 'approved-awaiting-payment');

    await cleanup();
  },
);

/**
 * Every non-succeeded raw Stripe status and the blocker the owner is told
 * about. `charge_status` cannot carry this — five of these six collapse into
 * `requires_payment` — and "needs verification" / "was declined" / "still
 * processing" are three different sentences with three different next actions.
 * Pinned here so a re-derivation can't quietly re-lump them.
 */
const BLOCKER_BY_RAW_STATUS: ReadonlyArray<readonly [StripePaymentIntentStatus, string]> = [
  ['requires_action', 'authentication_required'],
  ['requires_payment_method', 'declined'],
  ['processing', 'processing'],
  ['requires_confirmation', 'authentication_required'],
  ['requires_capture', 'processing'],
  ['canceled', 'declined'],
];

for (const [rawStatus, blocker] of BLOCKER_BY_RAW_STATUS) {
  test(
    `POST /requests/:id/confirm-payment — ${rawStatus} refuses with charge_blocker '${blocker}'`,
    SKIP_WHEN_NO_DB,
    async () => {
      await cleanup();
      const requestId = await seedApprovedAwaitingPaymentBT();
      const { app, stripe } = buildApp();
      stripe.setNextIntentStatus(rawStatus);

      const res = await app.inject({
        method: 'POST',
        url: `/requests/${requestId}/confirm-payment`,
        headers: { 'idempotency-key': `cp-bt-blocker-${randomUUID()}` },
        payload: CONFIRM_PAYLOAD,
      });

      assert.equal(res.statusCode, 402, res.body);
      const body = res.json() as { error: { details?: { charge_blocker: string } } };
      assert.equal(body.error.details?.charge_blocker, blocker);

      await cleanup();
    },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// A SUCCEEDED confirm whose transaction rolls back gets its money back
//
// The other half of the same guard. The card is charged pre-tx (a long Stripe
// call can't pin a transaction open), so any failure between capture and a
// committed booking strands captured money with no charges row and nothing to
// find it by. `POST /enrollments` has unwound since 2026-07-18; this route did
// not.
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /requests/:id/confirm-payment pay-now — a tx that rolls back after capture refunds the money',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const requestId = await seedApprovedAwaitingPaymentBT();

    // Reproduce the real race: a concurrent confirm under a DIFFERENT key wins
    // and converts the request while our card is being charged. The Stripe call
    // is the only point that sits between this route's pre-tx read (which saw
    // 'approved-awaiting-payment') and the in-tx state check that 409s, so the
    // seam is where the other confirm has to land.
    const { app, stripe } = buildApp(FIXTURE_OWNER_PRINCIPAL, (base) => ({
      ...base,
      async createAndConfirmPaymentIntent(args, key) {
        const result = await base.createAndConfirmPaymentIntent(args, key);
        await db.transaction(async (tx) =>
          requestsRepository.markConverted(tx, requestId, {
            approvedByStaffId: FIXTURE_IDS.staffRachelId,
            convertedBookingId: FIXTURE_IDS.booking1Id,
          }),
        );
        return result;
      },
    }));
    const idempotencyKey = `cp-bt-unwind-${randomUUID()}`;
    const before = await grantFootprint();

    const res = await app.inject({
      method: 'POST',
      url: `/requests/${requestId}/confirm-payment`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: CONFIRM_PAYLOAD,
    });

    // The ORIGINAL error reaches the owner — the unwind must not replace a
    // truthful 409 with a refund's own failure mode.
    assert.equal(res.statusCode, 409, res.body);

    // The money went back, under the key that names this unwind specifically.
    assert.deepEqual(refundKeys(stripe), [`${idempotencyKey}:confirm-unwind`]);
    const refund = stripe.calls.find((c) => c.method === 'createRefund');
    assert.equal(refund?.method === 'createRefund' ? refund.args.amountCents : undefined, 200_000);

    // The rollback held: the charge that was captured has no row, so the refund
    // is the only record — which is exactly why it has to happen.
    assert.deepEqual(footprintSince(before, await grantFootprint()), NOTHING_CREATED);

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// …EXCEPT when the capture is not ours: losing the idempotency claim race
//
// The mirror of `enrollments.ts`. Two confirms, ONE Idempotency-Key: the
// capture is keyed `<key>:payment-intent`, so Stripe's own idempotency hands
// the second confirm the FIRST one's already-captured PaymentIntent. Unwinding
// there refunds the charge the first confirm is about to write its charges row
// and booking against — the owner is charged, booked, AND refunded.
//
// Note the test directly above: it is also a 409 (`conflict`), and it MUST
// still refund. The exclusion is keyed on the error code, never the status.
//
// Reproduction note (same as `enrollment-create.test.ts`): `withIdempotency`
// claims in the same transaction as the work, so a genuinely concurrent
// same-key request BLOCKS on the uncommitted claim row and resolves as a
// replay — `idempotency_inflight` requires a COMMITTED claim with
// `completed_at IS NULL`. The in-flight window is therefore placed by hand
// (the device `test/idempotency.test.ts` uses); the capture, the 409, the
// refund decision and the committed money are the real code paths.
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /requests/:id/confirm-payment pay-now that LOSES the claim race → 409 idempotency_inflight, and the in-flight confirm’s captured PaymentIntent is left alone (booked, not refunded)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const requestId = await seedApprovedAwaitingPaymentBT();
    const key = `cp-bt-inflight-${randomUUID()}`;

    // Stripe as it really behaves on idempotency: the same key returns the SAME
    // PaymentIntent rather than minting a second one.
    const intentByKey = new Map<string, StripePaymentIntentResult>();
    const { app, stripe } = buildApp(FIXTURE_OWNER_PRINCIPAL, (base) => ({
      ...base,
      async createAndConfirmPaymentIntent(args, idempotencyKey) {
        const replayed = intentByKey.get(idempotencyKey);
        if (replayed !== undefined) {
          base.calls.push({ method: 'createAndConfirmPaymentIntent', args, idempotencyKey });
          return replayed;
        }
        const created = await base.createAndConfirmPaymentIntent(args, idempotencyKey);
        intentByKey.set(idempotencyKey, created);
        return created;
      },
    }));

    // The confirm that owns the key is mid-transaction: claimed, not completed.
    await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
      await tx.insert(idempotencyKeys).values({
        key,
        ownerId: FIXTURE_IDS.ownerId,
        endpoint: 'POST /requests/:id/confirm-payment',
        requestHash: hashRequestBody({ id: requestId, ...CONFIRM_PAYLOAD, pay_later: false }),
      });
    });

    const before = await grantFootprint();
    const loser = await app.inject({
      method: 'POST',
      url: `/requests/${requestId}/confirm-payment`,
      headers: { 'idempotency-key': key },
      payload: CONFIRM_PAYLOAD,
    });
    assert.equal(loser.statusCode, 409, loser.body);
    assert.equal(
      (loser.json() as { error: { code: string } }).error.code,
      'idempotency_inflight',
      'the loser surfaces its 409 — a mismatch here would mean the seeded claim never matched',
    );

    const sharedIntentId = intentByKey.get(`${key}:payment-intent`)?.id;
    assert.ok(sharedIntentId, 'the loser did capture — that is why the unwind was tempting');
    assert.deepEqual(
      refundKeys(stripe),
      [],
      'the loser must NOT refund a PaymentIntent it does not own',
    );
    assert.deepEqual(cancelledIntents(stripe), [], 'and must not cancel it either');
    assert.deepEqual(footprintSince(before, await grantFootprint()), NOTHING_CREATED);

    // ── The in-flight confirm now finishes: its claim resolves and its
    //    transaction commits the booking against that same intent. ──
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    const winner = await app.inject({
      method: 'POST',
      url: `/requests/${requestId}/confirm-payment`,
      headers: { 'idempotency-key': key },
      payload: CONFIRM_PAYLOAD,
    });
    assert.equal(winner.statusCode, 200, winner.body);
    assert.equal((winner.json() as { status: string }).status, 'converted');

    const chargeRows = await db
      .select({ status: charges.status, intentId: charges.stripePaymentIntentId })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRows.length, 1, 'exactly one charges row');
    assert.equal(chargeRows[0]?.status, 'succeeded');
    assert.equal(
      chargeRows[0]?.intentId,
      sharedIntentId,
      'the committed charge IS the intent the loser was holding — refunding it would have undone this money',
    );
    assert.deepEqual(
      footprintSince(before, await grantFootprint()),
      { bookings: 1, charges: 1, notifications: 1, scheduledNotifications: 2 },
      'the booking exists: charged once, booked, and nothing given back',
    );
    assert.deepEqual(refundKeys(stripe), [], 'no refund was ever issued');

    await cleanup();
  },
);
