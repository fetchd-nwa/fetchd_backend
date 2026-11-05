import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { idempotencyKeys, invoices } from '../../src/db/schema/schema.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { clearOrderRows, seedInvoiceOrder, seedOpenInvoice } from './_orderFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * The request key's two new rules (design §2.7:3939-3948): a claim stays open while
 * its charge is processing, so the TTL sweep must not take it, and completing a claim
 * the sweep already removed is a no-op that says so.
 */

after(clearOrderRows);
registerFixtureHooks();
afterEach(clearOrderRows);

const NOW = new Date('2026-05-26T12:00:00Z');
const hoursAgo = (n: number): string => new Date(NOW.getTime() - n * 3_600_000).toISOString();

test(
  'a claim survives the sweep while open; a completed one does not',
  SKIP_WHEN_NO_DB,
  async () => {
    const openKey = `open-${randomUUID()}`;
    const ancientOpenKey = `open-ancient-${randomUUID()}`;
    const completedKey = `completed-${randomUUID()}`;
    const freshCompletedKey = `completed-fresh-${randomUUID()}`;
    await db.insert(idempotencyKeys).values([
      { key: openKey, endpoint: 'POST /t', requestHash: 'h', createdAt: hoursAgo(48) },
      { key: ancientOpenKey, endpoint: 'POST /t', requestHash: 'h', createdAt: hoursAgo(8 * 24) },
      {
        key: completedKey,
        endpoint: 'POST /t',
        requestHash: 'h',
        createdAt: hoursAgo(48),
        completedAt: hoursAgo(48),
        responseStatus: 201,
        responseBody: {},
      },
      {
        // Open for three days and settled a minute ago: it must still answer a replay.
        key: freshCompletedKey,
        endpoint: 'POST /t',
        requestHash: 'h',
        createdAt: hoursAgo(72),
        completedAt: hoursAgo(0.02),
        responseStatus: 201,
        responseBody: {},
      },
    ]);

    await runSchedulerTickOnce({
      expoPush: makeExpoPushStub(),
      stripe: makeStripeStub(),
      now: NOW,
    });

    const left = await db
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(
        inArray(idempotencyKeys.key, [openKey, ancientOpenKey, completedKey, freshCompletedKey]),
      );
    const keys = left.map((r) => r.key).sort();
    assert.deepEqual(keys, [openKey, freshCompletedKey].sort());
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.key, keys));
  },
);

test(
  'completing a claim the sweep already removed is a no-op that logs one line naming the order',
  SKIP_WHEN_NO_DB,
  async () => {
    const invoiceId = await seedOpenInvoice();
    const capture = makeLogCapture();
    const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
    const stripe = makeStripeStub();
    registerStripeWebhookRoute(app, { stripe });
    const seeded = await seedInvoiceOrder(stripe, {
      invoiceId,
      now: NOW,
      intentStatus: 'succeeded',
      attemptingUntil: new Date(NOW.getTime() + 150_000),
    });
    assert.ok(seeded.intentId);
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, seeded.claimKey));

    stripe.setNextEvent({
      id: `evt_test_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: seeded.intentId,
      amountCents: 8_500,
      metadata: {},
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
      payload: '{}',
    });
    assert.equal(res.statusCode, 200, res.body);
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    assert.equal(invoice?.status, 'paid', 'the money settles regardless');
    const lines = capture.lines.filter((l) => l.orderId === seeded.orderId && l.level === 30);
    assert.equal(lines.length, 1, 'one line naming the order');
  },
);
