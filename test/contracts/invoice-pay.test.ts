import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import {
  bookingDogs,
  bookings,
  charges,
  cohorts,
  invoices,
  refunds,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { settleInvoiceCharge } from '../../src/lib/settleInvoiceCharge.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { clearInvoiceReferrers, FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
  type LogCapture,
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
  registerInvoicesRoute(app, { authenticate, stripe });
  return { app, stripe };
}

async function seedOpenInvoice(amountCents = 200_000): Promise<string> {
  const row = await db.transaction(async (tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: '2026-06-15T00:00:00Z',
    }),
  );
  return row.id;
}

async function cleanupInvoicesAndCharges(): Promise<void> {
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await clearInvoiceReferrers();
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

test(
  'POST /invoices/:id/pay — succeeded PI → charges row + invoice flipped to paid',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `inv-pay-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      charge_id: string;
      charge_status: string;
      invoice_status: string;
      stripe_payment_intent_id: string;
    };
    assert.equal(body.charge_status, 'succeeded');
    assert.equal(body.invoice_status, 'paid');
    assert.match(body.stripe_payment_intent_id, /^pi_test_/);

    const [inv] = await db
      .select({ status: invoices.status, paidChargeId: invoices.paidChargeId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'paid');
    assert.equal(inv?.paidChargeId, body.charge_id);

    const piCalls = stripe.calls.filter((c) => c.method === 'createUnconfirmedPaymentIntent');
    assert.equal(piCalls.length, 1);
    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — requires_action is a final decline: 402, invoice stays open, the failed charge recorded',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `inv-3ds-${randomUUID()}` },
      payload: {},
    });
    // A card that needs authentication cannot pay off-session (question 61).
    assert.equal(res.statusCode, 402, res.body);
    const body = res.json() as {
      error: { code: string; details: { charge_blocker: string } };
    };
    assert.equal(body.error.code, 'payment_failed');
    assert.equal(body.error.details.charge_blocker, 'authentication_required');
    const [inv] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open');
    const rows = await db
      .select({ status: charges.status })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.deepEqual(rows, [{ status: 'failed' }]);
    await cleanupInvoicesAndCharges();
  },
);

test('POST /invoices/:id/pay — unknown invoice → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/invoices/00000000-0000-4000-8000-000000000000/pay',
    headers: { 'idempotency-key': `inv-404-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 404);
});

test('POST /invoices/:id/pay — already-paid invoice → 409', SKIP_WHEN_NO_DB, async () => {
  await cleanupInvoicesAndCharges();
  const invoiceId = await seedOpenInvoice();
  // Mark paid out-of-band so the route sees an invalid state. The schema
  // CHECK `(status <> 'paid' OR paid_at IS NOT NULL)` requires paid_at
  // when status='paid', so stamp now() in the same UPDATE.
  await db
    .update(invoices)
    .set({ status: 'paid', paidAt: sql`now()` })
    .where(eq(invoices.id, invoiceId));
  const { app } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay`,
    headers: { 'idempotency-key': `inv-409-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 409);
  await cleanupInvoicesAndCharges();
});

test('POST /invoices/:id/pay — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await app.inject({
    method: 'POST',
    url: '/invoices/00000000-0000-4000-8000-000000000000/pay',
    headers: { 'idempotency-key': `inv-staff-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
});

test(
  'POST /invoices/:id/pay — replay returns identical body, no extra rows',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const invoiceId = await seedOpenInvoice();
    const { app } = buildApp();
    const key = `inv-replay-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': key },
      payload: {},
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json();
    const replay = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': key },
      payload: {},
    });
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), firstBody);

    const chargesRows = await db
      .select()
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargesRows.length, 1);
    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — lost settle race: invoice already paid, charge refunded, response is honest',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    // Drive the real in-tx race: fire TWO /pay calls concurrently against the
    // same open invoice. Each mints its own succeeded PI at Stripe; the
    // conditional markPaid claim lets exactly one flip open->paid (settled),
    // and the other sees flipped=0 (refunded duplicate). A pre-check
    // short-circuit (one call 409s before charging) is also a valid race
    // resolution — the test asserts the money invariant under both.
    const keyA = `inv-race-a-${randomUUID()}`;
    const keyB = `inv-race-b-${randomUUID()}`;
    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/invoices/${invoiceId}/pay`,
        headers: { 'idempotency-key': keyA },
        payload: {},
      }),
      app.inject({
        method: 'POST',
        url: `/invoices/${invoiceId}/pay`,
        headers: { 'idempotency-key': keyB },
        payload: {},
      }),
    ]);

    // One of the two may 409 (pre-check caught the already-paid state) OR both
    // pass pre-check and the in-tx claim splits them into one settled + one
    // refunded. Both outcomes are correct; assert the INVARIANT either way:
    // the invoice is paid exactly once and the customer nets one charge.
    const bodies = [resA, resB]
      .filter((r) => r.statusCode === 201)
      .map(
        (r) =>
          r.json() as {
            charge_id: string;
            invoice_status: string;
            charge_refunded: boolean;
          },
      );

    const [inv] = await db
      .select({ status: invoices.status, paidChargeId: invoices.paidChargeId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'paid', 'invoice settled exactly once');

    const refundRows = await db
      .select({ chargeId: refunds.chargeId, amountCents: refunds.amountCents })
      .from(refunds)
      .where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));

    // If BOTH calls passed pre-check, the loser took the refund branch.
    if (bodies.length === 2) {
      const refunded = bodies.filter((b) => b.charge_refunded);
      const clean = bodies.filter((b) => !b.charge_refunded);
      assert.equal(refunded.length, 1, 'exactly one charge was refunded');
      assert.equal(clean.length, 1, 'exactly one clean settle');
      assert.equal(clean[0]?.invoice_status, 'paid');
      // The refunded response is HONEST: invoice paid, but charge_refunded=true.
      assert.equal(refunded[0]?.invoice_status, 'paid');
      assert.equal(refunded[0]?.charge_refunded, true);
      assert.equal(refundRows.length, 1, 'one pending refund row for the duplicate');
      assert.equal(
        refundRows[0]?.chargeId,
        refunded[0]?.charge_id,
        'refund targets the loser charge',
      );
      assert.equal(refundRows[0]?.amountCents, 200_000, 'full duplicate amount refunded');

      // A Stripe createRefund fired post-commit for exactly the duplicate.
      const refundCalls = stripe.calls.filter((c) => c.method === 'createRefund');
      assert.equal(refundCalls.length, 1, 'exactly one Stripe refund fired for the duplicate');
    } else {
      // The pre-check caught the race: one 409, one clean 201, no refund.
      assert.equal(refundRows.length, 0, 'pre-check short-circuit needs no refund');
    }

    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — DETERMINISTIC lost-race: invoice settled mid-flight forces the in-tx refund branch',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    // Deterministically reproduce the lost-settle race WITHOUT relying on the
    // OS scheduler. The route reads the invoice (`status='open'`) and calls
    // Stripe BEFORE it opens its settle tx. We wrap the injected Stripe seam so
    // that, at the exact instant the route's PI confirms, a *concurrent* settle
    // path flips the invoice open->paid against its OWN (winning) charge. By
    // the time the route's tx runs its conditional `markPaid`, the invoice is
    // already paid → `flipped === 0` → the in-tx refund branch fires. The
    // pre-check passed (it read 'open'); the claim lost. No `Promise.all`, no
    // timing luck — the interleave is forced by ordering, so the route→
    // postCommit Stripe-fire wiring is asserted on every run.
    const confirmPaymentIntent = stripe.confirmPaymentIntent.bind(stripe);
    let originalChargeId = '';
    let routePaymentIntentId = '';
    let preSettled = false;
    const winnerPaymentIntentId = 'pi_test_winner_mid_flight';
    stripe.confirmPaymentIntent = async (paymentIntentId, args, idempotencyKey, budget) => {
      const intent = await confirmPaymentIntent(paymentIntentId, args, idempotencyKey, budget);
      routePaymentIntentId = intent.id;
      if (!preSettled) {
        preSettled = true;
        const invoiceRow = await invoicesRepository.findByIdForOwner(db, {
          id: invoiceId,
          ownerId: FIXTURE_IDS.ownerId,
        });
        if (invoiceRow === undefined) throw new Error('test setup: invoice vanished mid-flight');
        const winner = await withActor('system:test-race', (tx) =>
          settleInvoiceCharge(tx, {
            invoice: invoiceRow,
            paymentIntentId: winnerPaymentIntentId,
            amountCents: invoiceRow.amountCents,
            purpose: invoiceRow.purpose,
            notifyOwner: false,
          }),
        );
        assert.equal(winner.outcome, 'settled', 'the mid-flight path wins the open->paid claim');
        originalChargeId = winner.chargeId;
      }
      return intent;
    };

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `inv-det-race-${randomUUID()}` },
      payload: {},
    });

    // The route's own charge lost the claim → it MUST return the honest
    // refunded shape: paid (by the winner) + charge_refunded=true.
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      charge_id: string;
      charge_status: string;
      invoice_status: string;
      charge_refunded: boolean;
    };
    assert.equal(body.invoice_status, 'paid', 'invoice is paid (by the mid-flight winner)');
    assert.equal(body.charge_refunded, true, 'this duplicate charge is being refunded');
    assert.equal(body.charge_status, 'succeeded', 'the PI really captured before losing the claim');
    assert.notEqual(body.charge_id, originalChargeId, "this is the loser charge, not the winner's");

    // The invoice still links the ORIGINAL (winning) charge — the route's
    // duplicate charge never replaces it.
    const [inv] = await db
      .select({ status: invoices.status, paidChargeId: invoices.paidChargeId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'paid');
    assert.equal(inv?.paidChargeId, originalChargeId, 'invoice links the winner, not this charge');

    // A single PENDING refund row exists for THIS /pay charge, full amount.
    const refundRows = await db
      .select({
        chargeId: refunds.chargeId,
        amountCents: refunds.amountCents,
        status: refunds.status,
      })
      .from(refunds)
      .where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(refundRows.length, 1, "exactly one refund — the route's duplicate charge");
    assert.equal(refundRows[0]?.chargeId, body.charge_id, 'refund targets THIS /pay charge');
    assert.equal(refundRows[0]?.amountCents, 200_000, 'full duplicate amount refunded');
    assert.equal(refundRows[0]?.status, 'pending', 'written pending in-tx, reconciled by webhook');

    // The route fired exactly ONE post-commit Stripe createRefund, against
    // THIS charge's PaymentIntent (not the mid-flight winner's PI). This is
    // the route→postCommit wiring the racy test only covered non-deterministically.
    const refundCalls = stripe.calls.filter((c) => c.method === 'createRefund');
    assert.equal(refundCalls.length, 1, 'exactly one post-commit Stripe refund fired');
    const piConfirmCalls = stripe.calls.filter((c) => c.method === 'confirmPaymentIntent');
    assert.equal(piConfirmCalls.length, 1, 'the route confirmed exactly one PaymentIntent');
    if (refundCalls[0]?.method === 'createRefund') {
      assert.equal(
        refundCalls[0].args.paymentIntentId,
        routePaymentIntentId,
        "refund fires against the route's own confirmed PI",
      );
      assert.notEqual(
        refundCalls[0].args.paymentIntentId,
        winnerPaymentIntentId,
        "refund does NOT target the mid-flight winner's PI",
      );
      assert.equal(
        refundCalls[0].args.amountCents,
        200_000,
        'refund is for the full charge amount',
      );
    }

    await cleanupInvoicesAndCharges();
  },
);

// ─────────────────────────────────────────────────────────────────────────
// The anchor on the charge `/pay` writes (§A3.18 D1, §A3.19 F2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * `holdInvoiceForPayment` (`routes/invoices.ts`) is the live write of a charge's
 * `booking_id`: tx1 of every real `/pay`. The §A3.18 and §A3.19 tests in
 * `enrollment-partial.test.ts` and `enrollment-dead-money.test.ts` hold the same rule
 * through `settleInvoiceCharge()`'s first half, which no production path calls
 * (DECISIONS 168(a), 169(a)), so these are the tests of the write itself. The stake is
 * the board-train cancel below, which finds the charge it refunds by this column alone.
 */
const ANCHOR_COHORT_START = '2026-07-06T23:00:00Z';
const ANCHOR_DAY_MS = 24 * 60 * 60 * 1000;

function anchorApp(capture?: LogCapture): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  const stripe = makeStripeStub();
  registerInvoicesRoute(app, { authenticate, stripe });
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  registerBookingsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

async function seedAnchorCohort(): Promise<string> {
  const id = randomUUID();
  await db.insert(cohorts).values({
    id,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate: ANCHOR_COHORT_START,
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks: 4,
    capacity: 6,
    filled: 0,
  });
  return id;
}

/** A real pay-later enroll, so the invoice is stamped by the path that stamps it. */
async function enrolPayLater(
  app: ReturnType<typeof makeContractApp>['app'],
  dogId: string,
): Promise<typeof invoices.$inferSelect> {
  const cohortId = await seedAnchorCohort();
  const enrolled = await app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `anchor-enrol-${randomUUID()}` },
    payload: {
      cohort_id: cohortId,
      dog_ids: [dogId],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: true,
    },
  });
  assert.equal(enrolled.statusCode, 201, enrolled.body);
  const [invoice] = await db.select().from(invoices).where(eq(invoices.cohortId, cohortId));
  assert.ok(invoice !== undefined, 'the pay-later enroll wrote an invoice');
  return invoice;
}

/** A board-train stay and its invoice, dated by the clock the cancel route runs on. */
async function seedBoardTrainInvoice(
  amountCents: number,
): Promise<{ bookingId: string; invoiceId: string }> {
  const scheduledAt = new Date(FIXTURE_TODAY.getTime() + 20 * ANCHOR_DAY_MS);
  const bookingId = randomUUID();
  await db.insert(bookings).values({
    id: bookingId,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: FIXTURE_IDS.dog1Id,
    category: 'board-and-train',
    status: 'upcoming',
    scheduledAt: scheduledAt.toISOString(),
    dropoffAt: scheduledAt.toISOString(),
    pickupAt: new Date(scheduledAt.getTime() + 14 * ANCHOR_DAY_MS).toISOString(),
    cancelDeadlineAt: new Date(scheduledAt.getTime() - 10 * ANCHOR_DAY_MS).toISOString(),
    location: 'fayetteville',
  });
  await db.insert(bookingDogs).values({ bookingId, dogId: FIXTURE_IDS.dog1Id, isLead: true });
  const invoice = await db.transaction(async (tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: scheduledAt.toISOString(),
      bookingId,
      dogId: FIXTURE_IDS.dog1Id,
    }),
  );
  return { bookingId, invoiceId: invoice.id };
}

/** Pay through the real route, and read what that tender wrote. */
async function payForCharge(
  app: ReturnType<typeof makeContractApp>['app'],
  invoiceId: string,
): Promise<{ chargeId: string; bookingId: string | null; intentId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay`,
    headers: { 'idempotency-key': `anchor-pay-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as {
    charge_id: string;
    invoice_status: string;
    stripe_payment_intent_id: string;
  };
  assert.equal(body.invoice_status, 'paid');
  const [charge] = await db
    .select({ bookingId: charges.bookingId, status: charges.status })
    .from(charges)
    .where(eq(charges.id, body.charge_id));
  assert.ok(charge !== undefined, 'the tender wrote a charge');
  assert.equal(charge.status, 'succeeded');
  return {
    chargeId: body.charge_id,
    bookingId: charge.bookingId,
    intentId: body.stripe_payment_intent_id,
  };
}

test(
  'POST /invoices/:id/pay — a class invoice: the charge carries the anchor the invoice names (§A3.18 D1)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const { app } = anchorApp();
    const invoice = await enrolPayLater(app, FIXTURE_IDS.dog1Id);
    assert.ok(invoice.bookingId !== null, 'the enroll stamped its anchor on the invoice');
    const [anchor] = await db
      .select({ cohortId: bookings.cohortId, leadDogId: bookings.leadDogId })
      .from(bookings)
      .where(eq(bookings.id, invoice.bookingId));
    assert.deepEqual(anchor, { cohortId: invoice.cohortId, leadDogId: FIXTURE_IDS.dog1Id });

    const { bookingId } = await payForCharge(app, invoice.id);

    assert.equal(bookingId, invoice.bookingId);
    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — a board-train invoice: the charge carries the invoice’s own booking',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupInvoicesAndCharges();
    const { app } = anchorApp();
    const { bookingId, invoiceId } = await seedBoardTrainInvoice(300_000);

    const charge = await payForCharge(app, invoiceId);

    assert.equal(charge.bookingId, bookingId);
    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — the stake: a paid board-train invoice, its booking cancelled in the window, refunds in full',
  SKIP_WHEN_NO_DB,
  async () => {
    // `cancelBookingService` finds the charge with `findSucceededForBooking`, by
    // `charges.booking_id` and nothing else. With no anchor the cancel still answers
    // 200, and $3,000.00 stays taken with no refund row and no alarm.
    await cleanupInvoicesAndCharges();
    const { app, stripe } = anchorApp();
    const { bookingId, invoiceId } = await seedBoardTrainInvoice(300_000);
    const { chargeId, intentId } = await payForCharge(app, invoiceId);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': `anchor-cancel-${randomUUID()}` },
      payload: {},
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const body = cancelled.json() as { status: string; cancel_forfeited: boolean };
    assert.equal(body.status, 'cancelled');
    assert.equal(body.cancel_forfeited, false, 'inside the window, so the money comes back');

    const rows = await db
      .select({
        chargeId: refunds.chargeId,
        amountCents: refunds.amountCents,
        reason: refunds.reason,
      })
      .from(refunds)
      .where(eq(refunds.bookingId, bookingId));
    assert.deepEqual(rows, [{ chargeId, amountCents: 300_000, reason: 'cancel' }]);

    const sent = stripe.calls.filter((call) => call.method === 'createRefund');
    assert.equal(sent.length, 1, 'and the refund is sent to Stripe, once');
    const args = sent[0]?.args as { paymentIntentId: string; amountCents: number };
    assert.equal(args.paymentIntentId, intentId);
    assert.equal(args.amountCents, 300_000);
    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — a class invoice that lost its anchor: the same-transaction witness names it, and WARNs (§A3.19 F2)',
  SKIP_WHEN_NO_DB,
  async () => {
    // What `ON DELETE SET NULL` leaves, or an invoice minted before the stamp existed.
    // The enroll wrote the invoice and its bookings in one transaction, so
    // `bookings.created_at = invoices.issued_at` still names them.
    await cleanupInvoicesAndCharges();
    const capture = makeLogCapture();
    const { app } = anchorApp(capture);
    const invoice = await enrolPayLater(app, FIXTURE_IDS.dog2Id);
    const anchor = invoice.bookingId;
    assert.ok(anchor !== null);
    await db.update(invoices).set({ bookingId: null }).where(eq(invoices.id, invoice.id));

    const { bookingId } = await payForCharge(app, invoice.id);

    assert.equal(bookingId, anchor, 'the witness finds the enrollment the stamp named');
    const warns = capture.lines.filter(
      (line) => line.level === 40 && line.invoiceId === invoice.id,
    );
    assert.equal(warns.length, 1, 'every firing of the fallback WARNs');
    assert.equal(warns[0]?.resolvedBookingId, anchor);
    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — no anchor and no witness: it pays, the charge’s booking_id is NULL, and the WARN names the invoice',
  SKIP_WHEN_NO_DB,
  async () => {
    // Minted on its own, so no booking shares its transaction instant. Nothing is proven
    // about whose money this is, so nothing is claimed, and the legacy time rule is the
    // net behind the NULL.
    await cleanupInvoicesAndCharges();
    const capture = makeLogCapture();
    const { app } = anchorApp(capture);
    const cohortId = await seedAnchorCohort();
    const invoice = await db.transaction(async (tx) =>
      invoicesRepository.createOpen(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 25_000,
        purpose: 'group-class',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        dueAt: ANCHOR_COHORT_START,
        cohortId,
        dogId: FIXTURE_IDS.dog1Id,
      }),
    );
    assert.equal(invoice.bookingId, null);

    const { bookingId } = await payForCharge(app, invoice.id);

    assert.equal(bookingId, null);
    const warns = capture.lines.filter(
      (line) => line.level === 40 && line.invoiceId === invoice.id,
    );
    assert.equal(warns.length, 1, 'a human can find it');
    assert.match(String(warns[0]?.msg), /NO enrollment anchor/);
    await cleanupInvoicesAndCharges();
  },
);
