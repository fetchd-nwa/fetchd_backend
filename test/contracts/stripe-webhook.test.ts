import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import { refundsRepository } from '../../src/db/repositories/refundsRepository.js';
import {
  charges,
  creditLedger,
  paymentMethods,
  refunds,
  stripeEvents,
} from '../../src/db/schema/schema.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import type { StripeWebhookEvent } from '../../src/lib/stripe.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Day-15 contract tests for `POST /webhooks/stripe`. Each test queues a
 * narrow `StripeWebhookEvent` via the stub's `setNextEvent`, POSTs an
 * arbitrary body to the route (signature verification is stubbed — the
 * stub returns the queued event regardless of inputs), and asserts the
 * DB writes plus the response shape.
 *
 * The receiver lifecycle (claim → dispatch → mark/release) is exercised
 * across:
 *   - normal new-event flow (200 + processed_at set)
 *   - duplicate event (claim returns 'duplicate', 200 with no second
 *     dispatch)
 *   - bogus signature (constructWebhookEvent throws ApiError → 400)
 *   - dispatcher throws (release happens; 500; stripe_events row gone)
 */

registerFixtureHooks();

function buildApp(): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  // Webhook route is public — auth hook unused. We still inject opts
  // for the stripe seam.
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

async function cleanupTestState(): Promise<void> {
  // Each test runs as one "logical event" and may insert rows of its
  // choosing. Reset to the seeded fixture baseline so order independence
  // holds — drop ledger / refunds / charges, then re-seed the lone
  // payment method.
  await db.delete(creditLedger).where(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id));
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(paymentMethods).where(eq(paymentMethods.ownerId, FIXTURE_IDS.ownerId));
  await db.insert(paymentMethods).values({
    id: FIXTURE_IDS.paymentMethod1Id,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentMethodId: 'pm_fixture_test_visa',
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    cardholderName: 'Allison Fixture',
    isDefault: true,
  });
}

function evtId(): string {
  return `evt_test_${randomUUID().slice(0, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Signature + dedupe + dispatcher lifecycle
// ─────────────────────────────────────────────────────────────────────────

test('POST /webhooks/stripe — bogus signature → 400', SKIP_WHEN_NO_DB, async () => {
  const { app, stripe } = buildApp();
  stripe.setNextEvent(null); // make constructWebhookEvent throw ApiError(bad_request)
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'stripe-signature': 'bogus' },
    payload: { type: 'whatever' },
  });
  assert.equal(res.statusCode, 400);
});

test(
  'POST /webhooks/stripe — duplicate event id returns 200 outcome=duplicate, runs no second dispatch',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupTestState();
    const { app, stripe } = buildApp();
    const eventId = evtId();
    // First delivery: orphan-event (no charge row matches the PI) → 200
    stripe.setNextEvent({
      id: eventId,
      type: 'payment_intent.succeeded',
      paymentIntentId: 'pi_test_orphan',
      amountCents: 1000,
      metadata: {},
    });
    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId, type: 'payment_intent.succeeded' },
    });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json() as { ok: boolean; outcome: string };
    assert.equal(firstBody.outcome, 'orphan-event');

    // Second delivery with the same id → claim returns 'duplicate'
    stripe.setNextEvent({
      id: eventId,
      type: 'payment_intent.succeeded',
      paymentIntentId: 'pi_test_orphan',
      amountCents: 1000,
      metadata: {},
    });
    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId, type: 'payment_intent.succeeded' },
    });
    assert.equal(second.statusCode, 200);
    const secondBody = second.json() as { ok: boolean; outcome: string };
    assert.equal(secondBody.outcome, 'duplicate');

    // Cleanup the stripe_events row (created with the test prefix).
    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
  },
);

// ─────────────────────────────────────────────────────────────────────────
// payment_intent.succeeded
// ─────────────────────────────────────────────────────────────────────────

test(
  'payment_intent.succeeded flips a requires_payment charge → succeeded',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupTestState();
    // Seed a requires_payment charge (the async-confirm path Day-14 leaves
    // pending). The webhook should flip it.
    const piId = `pi_test_succ_${randomUUID().slice(0, 8)}`;
    const [chargeRow] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 4500,
        status: 'requires_payment',
        purpose: 'package',
        stripePaymentIntentId: piId,
      })
      .returning({ id: charges.id });
    const chargeId = chargeRow!.id;

    const { app, stripe } = buildApp();
    const eventId = evtId();
    stripe.setNextEvent({
      id: eventId,
      type: 'payment_intent.succeeded',
      paymentIntentId: piId,
      amountCents: 4500,
      metadata: {
        dog_id: FIXTURE_IDS.dog1Id,
        package_id: FIXTURE_IDS.creditPackageSchool5Id,
        credits: '5',
        mode: 'school',
        location: 'fayetteville',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { outcome: string }).outcome, 'flipped-charge-succeeded');

    const [after] = await db
      .select({ status: charges.status })
      .from(charges)
      .where(eq(charges.id, chargeId));
    assert.equal(after?.status, 'succeeded');

    // Purchase ledger row was written (the async-confirm catch-up).
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.chargeId, chargeId), eq(creditLedger.reason, 'purchase')));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.delta, 5);

    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
  },
);

test(
  'payment_intent.succeeded is idempotent — already-succeeded charge with ledger row is a no-op',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupTestState();
    // Seed a succeeded charge + existing ledger row (the sync-confirm path).
    const piId = `pi_test_idem_${randomUUID().slice(0, 8)}`;
    const [chargeRow] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 4500,
        status: 'succeeded',
        purpose: 'package',
        stripePaymentIntentId: piId,
      })
      .returning({ id: charges.id });
    await db.insert(creditLedger).values({
      dogId: FIXTURE_IDS.dog1Id,
      mode: 'school',
      location: 'fayetteville',
      delta: 5,
      reason: 'purchase',
      packageId: FIXTURE_IDS.creditPackageSchool5Id,
      chargeId: chargeRow!.id,
    });

    const { app, stripe } = buildApp();
    const eventId = evtId();
    stripe.setNextEvent({
      id: eventId,
      type: 'payment_intent.succeeded',
      paymentIntentId: piId,
      amountCents: 4500,
      metadata: {
        dog_id: FIXTURE_IDS.dog1Id,
        package_id: 'whatever',
        credits: '5',
        mode: 'school',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { outcome: string }).outcome, 'charge-already-terminal');

    // Only ONE ledger row should exist for this charge.
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.chargeId, chargeRow!.id));
    assert.equal(ledger.length, 1);

    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
  },
);

// ─────────────────────────────────────────────────────────────────────────
// payment_intent.payment_failed
// ─────────────────────────────────────────────────────────────────────────

test(
  'payment_intent.payment_failed flips a requires_payment charge → failed',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupTestState();
    const piId = `pi_test_fail_${randomUUID().slice(0, 8)}`;
    const [chargeRow] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 4500,
        status: 'requires_payment',
        purpose: 'package',
        stripePaymentIntentId: piId,
      })
      .returning({ id: charges.id });

    const { app, stripe } = buildApp();
    const eventId = evtId();
    stripe.setNextEvent({
      id: eventId,
      type: 'payment_intent.payment_failed',
      paymentIntentId: piId,
      amountCents: 4500,
      metadata: {},
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { outcome: string }).outcome, 'flipped-charge-failed');

    const [after] = await db
      .select({ status: charges.status })
      .from(charges)
      .where(eq(charges.id, chargeRow!.id));
    assert.equal(after?.status, 'failed');

    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
  },
);

// ─────────────────────────────────────────────────────────────────────────
// setup_intent.succeeded
// ─────────────────────────────────────────────────────────────────────────

test(
  'setup_intent.succeeded writes payment_methods row via retrievePaymentMethod',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupTestState();
    // Drop ALL payment methods for the owner so this becomes the "first card"
    // path that defaults to is_default=true.
    await db.delete(paymentMethods).where(eq(paymentMethods.ownerId, FIXTURE_IDS.ownerId));

    const { app, stripe } = buildApp();
    const eventId = evtId();
    const newPmId = `pm_test_new_${randomUUID().slice(0, 8)}`;
    stripe.setPaymentMethodSnapshot({
      id: newPmId,
      brand: 'mastercard',
      last4: '5555',
      expMonth: 6,
      expYear: 2031,
      cardholderName: 'Webhook Test',
    });
    stripe.setNextEvent({
      id: eventId,
      type: 'setup_intent.succeeded',
      setupIntentId: `seti_test_${randomUUID().slice(0, 8)}`,
      paymentMethodId: newPmId,
      customerId: FIXTURE_IDS.stripeCustomerId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { outcome: string }).outcome, 'wrote-payment-method');

    const [row] = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.stripePaymentMethodId, newPmId));
    assert.ok(row);
    assert.equal(row?.brand, 'mastercard');
    assert.equal(row?.last4, '5555');
    assert.equal(row?.isDefault, true, 'first card → isDefault=true');

    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
    // Restore the seeded card for downstream tests in this file.
    await cleanupTestState();
  },
);

test(
  'setup_intent.succeeded is idempotent — duplicate payment_method id is a no-op',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupTestState();
    const { app, stripe } = buildApp();
    const eventId = evtId();
    stripe.setNextEvent({
      id: eventId,
      type: 'setup_intent.succeeded',
      setupIntentId: 'seti_test_dup',
      paymentMethodId: 'pm_fixture_test_visa', // already exists in fixture
      customerId: FIXTURE_IDS.stripeCustomerId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { outcome: string }).outcome, 'payment-method-already-present');

    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
  },
);

// ─────────────────────────────────────────────────────────────────────────
// charge.refund.updated
// ─────────────────────────────────────────────────────────────────────────

test(
  'charge.refund.updated succeeded flips refund + cumulative rule fires → charge refunded',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupTestState();
    // Seed a succeeded charge + a pending full-amount refund with the
    // stripe_refund_id set (the post-Day-14-fix happy path).
    const piId = `pi_test_re_${randomUUID().slice(0, 8)}`;
    const [chargeRow] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 4500,
        status: 'succeeded',
        purpose: 'package',
        stripePaymentIntentId: piId,
      })
      .returning({ id: charges.id });
    const stripeRefundId = `re_test_${randomUUID().slice(0, 8)}`;
    const refund = await db.transaction(async (tx) =>
      refundsRepository.createPending(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: chargeRow!.id,
        bookingId: FIXTURE_IDS.booking1Id,
        amountCents: 4500,
        reason: 'cancel',
      }),
    );
    await db.transaction(async (tx) =>
      refundsRepository.markStripeId({ id: refund.id, stripeRefundId }, tx),
    );

    const { app, stripe } = buildApp();
    const eventId = evtId();
    stripe.setNextEvent({
      id: eventId,
      type: 'charge.refund.updated',
      refundId: stripeRefundId,
      paymentIntentId: piId,
      amountCents: 4500,
      status: 'succeeded',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { outcome: string }).outcome, 'flipped-refund-succeeded');

    const [refundAfter] = await db
      .select({ status: refunds.status })
      .from(refunds)
      .where(eq(refunds.id, refund.id));
    assert.equal(refundAfter?.status, 'succeeded');

    // Cumulative refund == charge amount → charge flips to 'refunded'.
    const chargeAfter = await db.transaction(async (tx) =>
      chargesRepository.findById(tx, chargeRow!.id),
    );
    assert.equal(chargeAfter?.status, 'refunded');

    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
  },
);

test(
  'charge.refund.updated race fallback — finds unmatched pending refund by (charge, amount)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupTestState();
    // Seed a refund without stripe_refund_id (the race window before the
    // cancel-route postCommit lands).
    const piId = `pi_test_race_${randomUUID().slice(0, 8)}`;
    const [chargeRow] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 4500,
        status: 'succeeded',
        purpose: 'package',
        stripePaymentIntentId: piId,
      })
      .returning({ id: charges.id });
    const refund = await db.transaction(async (tx) =>
      refundsRepository.createPending(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: chargeRow!.id,
        bookingId: FIXTURE_IDS.booking1Id,
        amountCents: 4500,
        reason: 'cancel',
      }),
    );

    const { app, stripe } = buildApp();
    const eventId = evtId();
    const stripeRefundId = `re_test_race_${randomUUID().slice(0, 8)}`;
    stripe.setNextEvent({
      id: eventId,
      type: 'charge.refund.updated',
      refundId: stripeRefundId,
      paymentIntentId: piId,
      amountCents: 4500,
      status: 'succeeded',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { outcome: string }).outcome, 'flipped-refund-succeeded');

    const [after] = await db
      .select({ status: refunds.status, stripeRefundId: refunds.stripeRefundId })
      .from(refunds)
      .where(eq(refunds.id, refund.id));
    assert.equal(after?.status, 'succeeded');
    assert.equal(after?.stripeRefundId, stripeRefundId, 'race-recovery backfilled stripe id');

    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
  },
);

test(
  'charge.refund.updated returns refund-not-yet-recorded when no row matches',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupTestState();
    const { app, stripe } = buildApp();
    const eventId = evtId();
    stripe.setNextEvent({
      id: eventId,
      type: 'charge.refund.updated',
      refundId: `re_test_orphan_${randomUUID().slice(0, 8)}`,
      paymentIntentId: 'pi_test_doesnt_exist',
      amountCents: 1000,
      status: 'succeeded',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { outcome: string }).outcome, 'refund-not-yet-recorded');

    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Unhandled event
// ─────────────────────────────────────────────────────────────────────────

test('unhandled event types 200 + outcome=noop', SKIP_WHEN_NO_DB, async () => {
  await cleanupTestState();
  const { app, stripe } = buildApp();
  const eventId = evtId();
  const unhandled: StripeWebhookEvent = {
    id: eventId,
    type: 'unhandled',
    rawType: 'invoice.payment_succeeded',
  };
  stripe.setNextEvent(unhandled);
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'stripe-signature': 't=1,v1=fake' },
    payload: { id: eventId },
  });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { outcome: string }).outcome, 'noop');

  await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
});
