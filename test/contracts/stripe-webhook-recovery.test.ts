import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { charges, creditLedger, stripeEvents } from '../../src/db/schema/schema.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import type { StripeWebhookEvent } from '../../src/lib/stripe.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Money-correctness recovery paths for `POST /webhooks/stripe`
 * (booking/refund review, 2026-06-18):
 *
 *   #1 — a SUCCEEDED PaymentIntent with no `charges` row is no order of ours: the
 *        engine writes its charge before Stripe. Metadata grants nothing, and a person
 *        hears.
 *   #3 — a `charge.refund.updated` whose `refunds` row isn't found throws
 *        (releases the claim → Stripe redelivers) instead of being marked
 *        processed and stranding the refund at 'pending'.
 */

registerFixtureHooks();

function buildApp(capture?: ReturnType<typeof makeLogCapture>): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  const stripe = makeStripeStub();
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

async function cleanup(): Promise<void> {
  await db.delete(creditLedger).where(isNotNull(creditLedger.chargeId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

function evtId(): string {
  return `evt_test_${randomUUID().slice(0, 8)}`;
}

function packageSucceededEvent(paymentIntentId: string): StripeWebhookEvent {
  return {
    id: evtId(),
    type: 'payment_intent.succeeded',
    paymentIntentId,
    amountCents: 12_000,
    metadata: {
      owner_id: FIXTURE_IDS.ownerId,
      dog_id: FIXTURE_IDS.dog1Id,
      package_id: FIXTURE_IDS.creditPackageSchool5Id,
      package_key: FIXTURE_IDS.creditPackageSchool5Key,
      credits: '5',
      mode: 'school',
      location: 'fayetteville',
    },
  };
}

async function postEvent(
  app: ReturnType<typeof buildApp>['app'],
  stripe: ReturnType<typeof buildApp>['stripe'],
  event: StripeWebhookEvent,
): Promise<{ statusCode: number; outcome?: string }> {
  stripe.setNextEvent(event);
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'stripe-signature': 't=1,v1=fake' },
    payload: { id: event.id, type: event.type },
  });
  const body =
    res.statusCode === 200 ? (res.json() as { outcome: string }) : { outcome: undefined };
  return { statusCode: res.statusCode, outcome: body.outcome };
}

// ── #1: Stripe took money and no charge row names it ──────────────────────

test(
  'a succeeded intent with no charge row grants nothing from its metadata, and a person hears, each delivery',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const capture = makeLogCapture();
    const { app, stripe } = buildApp(capture);
    const piId = `pi_test_orphan_${randomUUID().slice(0, 8)}`;

    for (const delivery of [1, 2]) {
      const result = await postEvent(app, stripe, packageSucceededEvent(piId));
      assert.equal(result.statusCode, 200);
      assert.equal(result.outcome, 'orphan-event');
      const alarms = capture.lines.filter((l) => l.level === 50 && l.paymentIntentId === piId);
      assert.equal(alarms.length, delivery);
    }

    const chargeRows = await db
      .select({ id: charges.id })
      .from(charges)
      .where(eq(charges.stripePaymentIntentId, piId));
    assert.deepEqual(chargeRows, [], 'nothing is reconstructed');
    const grants = await db.select().from(creditLedger).where(isNotNull(creditLedger.chargeId));
    assert.deepEqual(grants, [], 'nothing is granted');
    await cleanup();
  },
);

test(
  'payment_intent.succeeded with no charge row AND no package metadata stays a dropped orphan',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { app, stripe } = buildApp();
    const result = await postEvent(app, stripe, {
      id: evtId(),
      type: 'payment_intent.succeeded',
      paymentIntentId: `pi_test_unknown_${randomUUID().slice(0, 8)}`,
      amountCents: 5000,
      metadata: {},
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.outcome, 'orphan-event');

    const chargeRows = await db
      .select({ id: charges.id })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRows.length, 0, 'no charge fabricated for a non-package orphan');
    await cleanup();
  },
);

// ── #3: refund webhook forces redelivery instead of stranding ─────────────

test(
  'charge.refund.updated with no matching refunds row → 500 + claim released (redelivery)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const eventId = evtId();
    stripe.setNextEvent({
      id: eventId,
      type: 'charge.refund.updated',
      refundId: `re_test_unrecorded_${randomUUID().slice(0, 8)}`,
      paymentIntentId: null, // no PI → race-fallback skipped → row truly not found
      amountCents: 5000,
      status: 'succeeded',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=1,v1=fake' },
      payload: { id: eventId, type: 'charge.refund.updated' },
    });
    assert.equal(res.statusCode, 500);

    // The claim must be RELEASED (row deleted) so Stripe's redelivery re-enters
    // dispatch rather than short-circuiting as a duplicate.
    const rows = await db
      .select({ eventId: stripeEvents.eventId })
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, eventId));
    assert.equal(rows.length, 0, 'stripe_events claim released after retryable throw');
  },
);
