import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { charges, invoices, refunds } from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { settleInvoiceCharge } from '../../src/lib/settleInvoiceCharge.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { clearInvoiceChargeAttempts, FIXTURE_IDS } from './_fixture.js';
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
  await clearInvoiceChargeAttempts();
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

    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 1);
    await cleanupInvoicesAndCharges();
  },
);

test(
  'POST /invoices/:id/pay — requires_action returns client_secret, invoice stays open, charge at requires_payment',
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
    assert.equal(res.statusCode, 201);
    const body = res.json() as {
      charge_id: string;
      charge_status: string;
      invoice_status: string;
      client_secret: string | null;
    };
    assert.equal(body.charge_status, 'requires_payment');
    assert.equal(body.invoice_status, 'open');
    assert.ok(body.client_secret !== null);
    const [inv] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open');
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
    const confirmPaymentIntent = stripe.createAndConfirmPaymentIntent.bind(stripe);
    let originalChargeId = '';
    let routePaymentIntentId = '';
    let preSettled = false;
    const winnerPaymentIntentId = 'pi_test_winner_mid_flight';
    stripe.createAndConfirmPaymentIntent = async (args, idempotencyKey) => {
      const intent = await confirmPaymentIntent(args, idempotencyKey);
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
    const piConfirmCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
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
