import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { scheduledNotificationsRepository } from '../../src/db/repositories/scheduledNotificationsRepository.js';
import {
  bookings,
  charges,
  invoices,
  refunds,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import type { LedgerEntryWire } from '../../src/lib/ledgerWire.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { clearInvoiceChargeAttempts, FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Contract tests for SWITCHING a pay-in-person invoice back to card — the
 * "actually, charge my card now" branch of the settle sheet (Allison
 * 2026-07-31).
 *
 * There is no dedicated verb for the switch, and there must not be one: an
 * in-person invoice is still `status='open'`, and `POST /invoices/:id/pay`
 * gates on status alone, so it already accepts one. The settle path
 * (`settleInvoiceCharge`) cancels the pending `payment-due:<invoiceId>`
 * reminder in the same tx as `markPaid`.
 *
 * These tests pin that emergent behaviour so nobody "tightens" the pay route
 * with a `payment_expected='card'` guard, and nobody moves the reminder
 * teardown out of the settle tx. The failure they exist to prevent: an owner
 * pays by card and is still told to bring cash to drop-off.
 */

registerFixtureHooks();

const ONE_DAY_MS = 86_400_000;
const REAL_NOW_MS = Date.now();

function buildApp(): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerInvoicesRoute(app, { authenticate, stripe });
  return { app, stripe };
}

async function cleanup(bookingIds: string[] = []): Promise<void> {
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await clearInvoiceChargeAttempts();
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  if (bookingIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.id, bookingIds));
  }
}

/** A board-and-train booking whose drop-off is far enough out that the 24h
 *  reminder lead lands in the future (no clamp) — so "cancelled" can't be
 *  confused with "already fired". */
async function seedBookingWithFutureDropoff(): Promise<string> {
  const id = randomUUID();
  const dropoffAt = new Date(REAL_NOW_MS + 10 * ONE_DAY_MS);
  await db.insert(bookings).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: FIXTURE_IDS.dog1Id,
    category: 'board-and-train',
    status: 'upcoming',
    scheduledAt: dropoffAt.toISOString(),
    dropoffAt: dropoffAt.toISOString(),
    location: 'fayetteville',
  });
  return id;
}

async function seedOpenInvoice(bookingId: string | null, amountCents = 12_000): Promise<string> {
  const row = await db.transaction((tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: new Date(REAL_NOW_MS + 9 * ONE_DAY_MS).toISOString(),
      bookingId,
    }),
  );
  return row.id;
}

type InvoiceApp = ReturnType<typeof buildApp>['app'];

async function payInPerson(app: InvoiceApp, invoiceId: string) {
  return app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay-in-person`,
    headers: { 'idempotency-key': `pip-${randomUUID()}` },
    payload: {},
  });
}

async function payByCard(app: InvoiceApp, invoiceId: string, idempotencyKey?: string) {
  return app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay`,
    headers: { 'idempotency-key': idempotencyKey ?? `switch-${randomUUID()}` },
    payload: {},
  });
}

/** Flag an invoice in-person through the real verb, asserting the reminder
 *  it enqueues is pending — the precondition every switch test needs. */
async function flagInPerson(app: InvoiceApp, invoiceId: string): Promise<void> {
  const res = await payInPerson(app, invoiceId);
  assert.equal(res.statusCode, 204, res.body);
  const reminder = await scheduledNotificationsRepository.findByDedupeKey(
    db,
    `payment-due:${invoiceId}`,
  );
  assert.equal(reminder?.status, 'pending', 'precondition: payment-due reminder is pending');
}

test(
  'POST /invoices/:id/pay — accepts an in-person invoice: it settles AND cancels the payment-due reminder',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const bookingId = await seedBookingWithFutureDropoff();
    const invoiceId = await seedOpenInvoice(bookingId);
    const { app, stripe } = buildApp();
    await flagInPerson(app, invoiceId);

    // The switch: no new verb, the same /pay the card path uses.
    const res = await payByCard(app, invoiceId);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { invoice_status: string; charge_refunded: boolean };
    assert.equal(body.invoice_status, 'paid', 'in-person invoice is payable by card');
    assert.equal(body.charge_refunded, false);

    const [inv] = await db
      .select({ status: invoices.status, paymentExpected: invoices.paymentExpected })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'paid');
    // `payment_expected` is NOT rewritten: it records what the owner elected
    // while the invoice was open. `status='paid'` + `paid_charge_id` is how the
    // money actually moved, and that's what the ledger renders.
    assert.equal(inv?.paymentExpected, 'in-person');

    // THE failure this file exists to prevent: money collected on the card and
    // a "bring $120 at drop-off" push still queued behind it.
    const reminder = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-due:${invoiceId}`,
    );
    assert.equal(reminder?.status, 'cancelled', 'settling by card tore down the cash reminder');

    // Exactly one PaymentIntent — the switch charges once, not once per flag flip.
    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 1);

    await cleanup([bookingId]);
  },
);

test(
  'POST /invoices/:id/pay — the settled invoice reads as a plain card payment in GET /invoices',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice(null);
    const { app } = buildApp();
    await flagInPerson(app, invoiceId);
    assert.equal((await payByCard(app, invoiceId)).statusCode, 201);

    const ledger = (await app.inject({ method: 'GET', url: '/invoices' })).json();
    const entries = ledger as LedgerEntryWire[];

    // The open in-person row is gone — nothing left for the app to render as
    // "pay at drop-off", which is what made the row non-tappable.
    assert.equal(
      entries.find((e) => e.id === invoiceId),
      undefined,
      'no open entry survives for a settled invoice',
    );

    const settled = entries.find((e) => e.invoice_id === invoiceId);
    assert.ok(settled !== undefined, 'the settling charge is on the ledger');
    assert.equal(settled.status, 'paid');
    assert.equal(settled.settled_method, 'card', 'settled by card, not cash');
    assert.equal(
      settled.payment_expected,
      undefined,
      'a paid entry carries no pay-in-person flag, even though the invoice row keeps it',
    );

    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — cancels only THIS invoice reminder, not every pending payment-due',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const switchedId = await seedOpenInvoice(null);
    const untouchedId = await seedOpenInvoice(null, 8_000);
    const { app } = buildApp();
    await flagInPerson(app, switchedId);
    await flagInPerson(app, untouchedId);

    assert.equal((await payByCard(app, switchedId)).statusCode, 201);

    // The teardown is a dedupe-key PREFIX cancel (`payment-due:<id>`); a sloppy
    // prefix would take the owner's other cash invoice down with it.
    const survivor = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-due:${untouchedId}`,
    );
    assert.equal(survivor?.status, 'pending', "the other invoice's reminder is untouched");
    const [other] = await db
      .select({ status: invoices.status, paymentExpected: invoices.paymentExpected })
      .from(invoices)
      .where(eq(invoices.id, untouchedId));
    assert.equal(other?.status, 'open');
    assert.equal(other?.paymentExpected, 'in-person');

    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — 3DS on an in-person invoice: invoice stays open, reminder stays PENDING',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice(null);
    const { app, stripe } = buildApp();
    await flagInPerson(app, invoiceId);

    // requires_action = nothing captured yet. Cancelling the reminder here
    // would tell the owner to leave the cash at home for a payment that may
    // never complete.
    stripe.setNextIntentStatus('requires_action');
    const res = await payByCard(app, invoiceId);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { invoice_status: string; client_secret: string | null };
    assert.equal(body.invoice_status, 'open');
    assert.ok(body.client_secret !== null, '3DS handoff returned to the client');

    const reminder = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-due:${invoiceId}`,
    );
    assert.equal(reminder?.status, 'pending', 'un-captured payment leaves the cash reminder up');
    const [inv] = await db
      .select({ status: invoices.status, paymentExpected: invoices.paymentExpected })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open');
    assert.equal(inv?.paymentExpected, 'in-person', 'still owed in person until it captures');

    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — double-tapping the switch charges once (replay) and 409s on a fresh key',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice(null);
    const { app, stripe } = buildApp();
    await flagInPerson(app, invoiceId);

    const key = `switch-replay-${randomUUID()}`;
    const first = await payByCard(app, invoiceId, key);
    assert.equal(first.statusCode, 201, first.body);
    const replay = await payByCard(app, invoiceId, key);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), first.json(), 'replay returns the stored body');

    // A genuinely new attempt on the now-paid invoice is a conflict, not a
    // second charge — the sheet can be reopened from a stale notification.
    const afterPaid = await payByCard(app, invoiceId);
    assert.equal(afterPaid.statusCode, 409, afterPaid.body);

    const chargeRows = await db
      .select({ id: charges.id })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRows.length, 1, 'the owner was charged exactly once');
    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 1, 'no second PaymentIntent for the replay or the 409');

    const reminder = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-due:${invoiceId}`,
    );
    assert.equal(reminder?.status, 'cancelled', 'the reminder stays cancelled across replays');

    await cleanup();
  },
);
