import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { charges, invoices, paymentMethods } from '../../src/db/schema/schema.js';
import {
  MAX_AUTO_CHARGE_ATTEMPTS,
  runInvoiceAutoChargeOnce,
  scheduleNextAttempt,
} from '../../src/workers/invoiceAutoCharge.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

registerFixtureHooks();

async function seedDueInvoice(amountCents = 200_000): Promise<string> {
  const row = await db.transaction(async (tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      // dueAt + nextAttemptAt in the past so the worker scoops it.
      dueAt: '2026-01-01T00:00:00Z',
      nextAttemptAt: '2026-01-01T00:00:00Z',
    }),
  );
  return row.id;
}

async function cleanup(): Promise<void> {
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

test(
  'runInvoiceAutoChargeOnce — succeeded PI marks invoice paid + writes charges row',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    const result = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
    assert.equal(result.scanned, 1);
    assert.equal(result.results[0]?.outcome, 'paid');

    const [inv] = await db
      .select({ status: invoices.status, paidChargeId: invoices.paidChargeId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'paid');
    assert.ok(inv?.paidChargeId);
    await cleanup();
  },
);

test(
  'runInvoiceAutoChargeOnce — Stripe failure increments attempts + reschedules',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    // Simulate the "card was deleted between issue + auto-charge" path
    // via soft-expire (the production lifecycle for cards — RESTRICT FK
    // forbids a hard DELETE while an invoice references the row).
    // The worker's `findLiveByIdForOwner` filters `expired_at IS NULL`,
    // so a soft-expired card surfaces the `skipped-pm-missing` branch.
    await db
      .update(paymentMethods)
      .set({ expiredAt: sql`now()`, isDefault: false })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));

    const result = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
    assert.equal(result.scanned, 1);
    assert.equal(result.results[0]?.outcome, 'skipped-pm-missing');
    assert.equal(result.results[0]?.nextAttemptAt, null);

    const [inv] = await db
      .select({
        status: invoices.status,
        autoChargeAttempts: invoices.autoChargeAttempts,
        nextAttemptAt: invoices.nextAttemptAt,
      })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open');
    assert.equal(inv?.autoChargeAttempts, 1);
    assert.equal(inv?.nextAttemptAt, null, 'parked after missing payment method');

    // Restore the fixture payment method so subsequent tests in this file
    // (none today) and other files see the seeded card live.
    await db
      .update(paymentMethods)
      .set({ expiredAt: null, isDefault: true })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    await cleanup();
  },
);

test(
  'runInvoiceAutoChargeOnce — non-settled PI is cancelled + attempt rescheduled (closes the double-charge window)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    // Off-session confirm returns a non-settled status instead of succeeding.
    stripe.setNextIntentStatus('requires_action');

    const result = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
    assert.equal(result.results[0]?.outcome, 'failed-retry-scheduled');

    // The unsettled PI must be cancelled so it can't later auto-succeed and
    // double-charge against the next retry's fresh PI.
    const cancelCalls = stripe.calls.filter((c) => c.method === 'cancelPaymentIntent');
    assert.equal(cancelCalls.length, 1, 'cancelled the unsettled PaymentIntent');

    const [inv] = await db
      .select({ status: invoices.status, autoChargeAttempts: invoices.autoChargeAttempts })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open', 'not paid');
    assert.equal(inv?.autoChargeAttempts, 1, 'attempt counted toward park');

    const chargeRows = await db
      .select({ id: charges.id })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRows.length, 0, 'no charge row for an unsettled attempt');
    await cleanup();
  },
);

test('scheduleNextAttempt parks after MAX_AUTO_CHARGE_ATTEMPTS', () => {
  // attempt 0..MAX-2 → some ISO string
  for (let i = 0; i < MAX_AUTO_CHARGE_ATTEMPTS - 1; i++) {
    const ts = scheduleNextAttempt(i, new Date('2026-05-26T00:00:00Z'));
    assert.equal(typeof ts, 'string', `attempt ${i} should reschedule`);
  }
  // attempt = MAX-1 → null (next attempt would hit the cap)
  const last = scheduleNextAttempt(MAX_AUTO_CHARGE_ATTEMPTS - 1, new Date('2026-05-26T00:00:00Z'));
  assert.equal(last, null);
});

test('runInvoiceAutoChargeOnce — empty queue returns scanned=0', SKIP_WHEN_NO_DB, async () => {
  await cleanup();
  const stripe = makeStripeStub();
  const result = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
  assert.equal(result.scanned, 0);
  assert.equal(result.results.length, 0);
});
