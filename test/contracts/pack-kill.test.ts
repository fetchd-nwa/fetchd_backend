import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  charges,
  creditLedger,
  invoices,
  orders,
  stripeEvents,
} from '../../src/db/schema/schema.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { QUIET_LOG, clearOrderRows, receiptsFor } from './_orderFixture.js';
import { signedIntentEvent, verifyingSignatures, type SignedEvent } from './_signedEvents.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * The money pass's crash windows, with a real process death (DECISIONS 171(b), 174(b)).
 *
 * WHAT IS KILLED, AND HOW: `_packKillChild.ts`, a child Node process running the production
 * route on the real test database. It sends SIGKILL to its own pid at the exact point
 * named, and this file asserts the child's exit signal was SIGKILL, so a child that
 * finished cleanly cannot pass for a death. What the child committed before dying is all
 * that survives it, and the parent recovers from that alone.
 */

registerFixtureHooks();

const KEY = 'school-2x-weekly-fayetteville';
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '_packKillChild.ts');

afterEach(async () => {
  await db.delete(creditLedger).where(isNotNull(creditLedger.chargeId));
  await clearOrderRows();
  await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(stripeEvents);
});

function killedChild(args: string[]): { stdout: string } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', CHILD, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.signal, 'SIGKILL', `the child was not killed: ${run.stdout} ${run.stderr}`);
  return { stdout: run.stdout };
}

function buildApp(stripe: StripeStub = verifyingSignatures(makeStripeStub())) {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerCreditPackagesRoute(app, { authenticate, stripe });
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

function deliver(app: ReturnType<typeof buildApp>['app'], event: SignedEvent) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
    payload: event.payload,
  });
}

/** A pack through the production route, left `processing`: a charge in `requires_payment`. */
async function processingPack(app: ReturnType<typeof buildApp>['app'], stripe: StripeStub) {
  stripe.setNextIntentStatus('processing');
  const res = await app.inject({
    method: 'POST',
    url: `/credit-packages/${KEY}/purchase`,
    headers: { 'idempotency-key': `kill-${randomUUID()}` },
    payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { charge_id: string; stripe_payment_intent_id: string };
  return { chargeId: body.charge_id, intentId: body.stripe_payment_intent_id };
}

async function settledRows(chargeId: string) {
  const lots = await db
    .select({ delta: creditLedger.delta })
    .from(creditLedger)
    .where(and(eq(creditLedger.chargeId, chargeId), eq(creditLedger.reason, 'purchase')));
  const paid = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.paidChargeId, chargeId), eq(invoices.status, 'paid')));
  return { lots, paid };
}

/** A worker's clock past any lease this file writes. */
const PAST_LEASE = (): Date => new Date(Date.now() + 60 * 60 * 1000);

async function killBetweenClaimAndHandler(event: SignedEvent, chargeId: string): Promise<void> {
  killedChild(['claim', event.payload, event.signature]);

  const [claim] = await db.select().from(stripeEvents).where(eq(stripeEvents.eventId, event.id));
  assert.ok(claim, 'the claim committed before the death');
  assert.equal(claim.processedAt, null, 'and nothing finished it');
  const [charge] = await db.select().from(charges).where(eq(charges.id, chargeId));
  assert.equal(charge?.status, 'requires_payment', 'the handler never ran');
  assert.deepEqual((await settledRows(chargeId)).lots, []);
}

test(
  'L2: killed between claim and handler, then a redelivery: one lot, one paid invoice',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const { chargeId, intentId } = await processingPack(app, stripe);
    stripe.setIntentState(intentId, 'succeeded');
    const event = signedIntentEvent({
      type: 'payment_intent.succeeded',
      intentId,
      ...stripe.intentSnapshot(intentId),
    });

    await killBetweenClaimAndHandler(event, chargeId);

    const redelivered = await deliver(app, event);
    assert.equal(redelivered.statusCode, 200, redelivered.body);
    const { lots, paid } = await settledRows(chargeId);
    assert.deepEqual(lots, [{ delta: 8 }], 'one lot');
    assert.equal(paid.length, 1, 'one paid invoice');
  },
);

test(
  'L2: killed between claim and handler with no redelivery: the sweeper settles it',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe } = buildApp();
    const { chargeId, intentId } = await processingPack(app, stripe);
    stripe.setIntentState(intentId, 'succeeded');
    const event = signedIntentEvent({
      type: 'payment_intent.succeeded',
      intentId,
      ...stripe.intentSnapshot(intentId),
    });

    await killBetweenClaimAndHandler(event, chargeId);

    await runOrderSweeperOnce({ stripe, now: PAST_LEASE(), log: QUIET_LOG });
    const { lots, paid } = await settledRows(chargeId);
    assert.deepEqual(lots, [{ delta: 8 }], 'one lot');
    assert.equal(paid.length, 1, 'one paid invoice');
  },
);

test(
  "the route killed after Stripe's answer: the webhook, metadata {order_id, charge_id} only, writes one lot, one invoice, one receipt",
  SKIP_WHEN_NO_DB,
  async () => {
    const { stdout } = killedChild([
      'answer',
      KEY,
      `kill-answer-${randomUUID()}`,
      FIXTURE_IDS.paymentMethod1Id,
    ]);
    const intent = JSON.parse(stdout.trim()) as {
      id: string;
      amountCents: number;
      metadata: Record<string, string>;
    };
    assert.deepEqual(
      Object.keys(intent.metadata).sort(),
      ['charge_id', 'order_id'],
      'the metadata is the two ids and nothing that could grant',
    );

    const { app, stripe } = buildApp();
    stripe.adoptIntent({ ...intent, status: 'succeeded' });
    const event = signedIntentEvent({
      type: 'payment_intent.succeeded',
      intentId: intent.id,
      amountCents: intent.amountCents,
      metadata: intent.metadata,
    });
    const res = await deliver(app, event);
    assert.equal(res.statusCode, 200, res.body);

    const chargeId = intent.metadata.charge_id as string;
    const { lots, paid } = await settledRows(chargeId);
    assert.deepEqual(lots, [{ delta: 8 }], 'one lot: the charge row says what was bought');
    assert.equal(paid.length, 1, 'one paid invoice');
    assert.equal((await receiptsFor(chargeId)).length, 1, 'one receipt');
  },
);
