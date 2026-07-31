import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { charges, invoices, owners, paymentMethods, refunds } from '../../src/db/schema/schema.js';
import type { LedgerEntryWire } from '../../src/lib/ledgerWire.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Contract tests for `POST /invoices/:id/pay` honouring the card the owner
 * PICKED (wire 1.7.0, Allison 2026-07-31).
 *
 * The defect these exist to prevent: the mobile pay sheet renders the owner's
 * real cards and lets them select one, but until 1.7.0 the selection stopped at
 * the client's repository boundary and the server charged the invoice's BOUND
 * card. An owner tapped "Mastercard ••8203" and their Visa was charged.
 *
 * Three properties are load-bearing and each has a test below:
 *   1. the chosen card is what Stripe is asked to charge;
 *   2. the invoice is REPOINTED at it in the settle tx, so the receipt
 *      (`LedgerEntryWire.settled_card`, derived from `invoices.payment_method_id`
 *      because `charges` stores no card) names the card actually charged;
 *   3. two calls under ONE idempotency key naming DIFFERENT cards do not
 *      collide. Under the old `hashRequestBody({ id })` they hashed the same, so
 *      the second replayed the first's stored 201 — the client was told a card
 *      had been charged that never was.
 */

registerFixtureHooks();

const ONE_DAY_MS = 86_400_000;
const REAL_NOW_MS = Date.now();

// A second live card for the fixture owner — the one the owner "picks" over the
// invoice's bound card. Distinct `stripePaymentMethodId` so the Stripe stub's
// recorded args prove WHICH card was charged rather than merely that one was.
const CARD2_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const CARD2_STRIPE_ID = 'pm_fixture_test_mastercard';
const CARD2_LAST4 = '8203';

// A card belonging to somebody else entirely — the cross-tenant probe.
const OTHER_OWNER_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const OTHER_CARD_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';

// A card of the fixture owner's that has been REMOVED (soft-expired). Live-ness
// is a separate gate from ownership and fails the same way.
const DEAD_CARD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';

type InvoiceApp = ReturnType<typeof makeContractApp>['app'];

function buildApp(): { app: InvoiceApp; stripe: ReturnType<typeof makeStripeStub> } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerInvoicesRoute(app, { authenticate, stripe });
  return { app, stripe };
}

async function seedCards(): Promise<void> {
  await db.insert(paymentMethods).values({
    id: CARD2_ID,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentMethodId: CARD2_STRIPE_ID,
    brand: 'mastercard',
    last4: CARD2_LAST4,
    expMonth: 11,
    expYear: 2031,
    cardholderName: 'Allison Fixture',
    isDefault: false,
  });
  await db.insert(paymentMethods).values({
    id: DEAD_CARD_ID,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentMethodId: 'pm_fixture_test_removed',
    brand: 'visa',
    last4: '0001',
    expMonth: 5,
    expYear: 2032,
    cardholderName: 'Allison Fixture',
    isDefault: false,
    expiredAt: new Date(REAL_NOW_MS - ONE_DAY_MS).toISOString(),
  });
  await db.insert(owners).values({
    id: OTHER_OWNER_ID,
    supabaseUid: randomUUID(),
    name: 'Someone Else',
    email: 'someone.else@example.test',
    phone: '555-0100',
    location: 'fayetteville',
  });
  await db.insert(paymentMethods).values({
    id: OTHER_CARD_ID,
    ownerId: OTHER_OWNER_ID,
    stripePaymentMethodId: 'pm_fixture_other_owner',
    brand: 'visa',
    last4: '9999',
    expMonth: 4,
    expYear: 2033,
    cardholderName: 'Someone Else',
    isDefault: true,
  });
}

async function cleanup(): Promise<void> {
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(paymentMethods).where(eq(paymentMethods.id, CARD2_ID));
  await db.delete(paymentMethods).where(eq(paymentMethods.id, DEAD_CARD_ID));
  await db.delete(paymentMethods).where(eq(paymentMethods.id, OTHER_CARD_ID));
  await db.delete(owners).where(eq(owners.id, OTHER_OWNER_ID));
}

/** An open invoice bound to the fixture owner's DEFAULT card (`paymentMethod1Id`,
 *  Visa ••4242) — so "charged the chosen card" is distinguishable from
 *  "charged the bound card" in every assertion below. */
async function seedOpenInvoice(amountCents = 12_000): Promise<string> {
  const row = await db.transaction((tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: new Date(REAL_NOW_MS + 9 * ONE_DAY_MS).toISOString(),
      bookingId: null,
    }),
  );
  return row.id;
}

async function pay(
  app: InvoiceApp,
  invoiceId: string,
  opts: { card?: string; key?: string; payload?: Record<string, unknown> } = {},
) {
  const payload =
    opts.payload ?? (opts.card === undefined ? {} : { payment_method_id: opts.card });
  return app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay`,
    headers: { 'idempotency-key': opts.key ?? `pick-${randomUUID()}` },
    payload,
  });
}

/** The Stripe payment-method ids this stub was actually asked to charge. */
function chargedStripeCards(stripe: ReturnType<typeof makeStripeStub>): string[] {
  return stripe.calls
    .filter((c) => c.method === 'createAndConfirmPaymentIntent')
    .map((c) => c.args.paymentMethodId);
}

async function boundCardOf(invoiceId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ paymentMethodId: invoices.paymentMethodId })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  return row?.paymentMethodId;
}

// ──────────────────────────────────────────────────────────────────────────
// The chosen card is the card charged
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /invoices/:id/pay — charges the card in the body, not the invoice’s bound card',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    const res = await pay(app, invoiceId, { card: CARD2_ID });
    assert.equal(res.statusCode, 201, res.body);

    assert.deepEqual(
      chargedStripeCards(stripe),
      [CARD2_STRIPE_ID],
      'Stripe was asked to charge the CHOSEN card exactly once',
    );
    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — the receipt names the chosen card (invoice repointed in the settle tx)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app } = buildApp();

    assert.equal(await boundCardOf(invoiceId), FIXTURE_IDS.paymentMethod1Id, 'precondition');
    assert.equal((await pay(app, invoiceId, { card: CARD2_ID })).statusCode, 201);

    assert.equal(
      await boundCardOf(invoiceId),
      CARD2_ID,
      'invoice repointed at the card that actually paid it',
    );

    // The receipt the owner reads. `settled_card` derives from
    // `invoices.payment_method_id`, so without the repoint it would name ••4242
    // — a card that was never charged.
    const ledger = await app.inject({ method: 'GET', url: '/invoices' });
    assert.equal(ledger.statusCode, 200, ledger.body);
    const paid = (ledger.json() as LedgerEntryWire[]).find(
      (e) => 'settled_card' in e && e.settled_card !== undefined,
    );
    assert.ok(paid !== undefined, 'a settled entry is in the ledger');
    assert.equal(
      (paid as { settled_card?: { last4: string } }).settled_card?.last4,
      CARD2_LAST4,
      'receipt names the chosen card',
    );
    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — bodyless call still charges the bound card (pre-1.7.0 behaviour)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    assert.equal((await pay(app, invoiceId)).statusCode, 201);
    assert.deepEqual(
      chargedStripeCards(stripe),
      ['pm_fixture_test_visa'],
      'no card named → the invoice’s bound card',
    );
    assert.equal(
      await boundCardOf(invoiceId),
      FIXTURE_IDS.paymentMethod1Id,
      'nothing repointed when the charge used the already-bound card',
    );
    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — a truly bodyless POST (no payload at all) still settles',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    // Distinct from the `{}` case above, and it is the one that matters: the
    // mobile client omits `body` entirely (no payload, no Content-Type) when the
    // owner hasn't picked a card. Adding a body schema must not turn that into a
    // 400 for every pre-1.7.0 caller.
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `bodyless-${randomUUID()}` },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(chargedStripeCards(stripe), ['pm_fixture_test_visa']);
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Ownership + liveness — the card must be THIS owner's, and live
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /invoices/:id/pay — another owner’s card → 404 and nothing is charged',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    const res = await pay(app, invoiceId, { card: OTHER_CARD_ID });
    // 404 not 403: a tenancy miss collapses to not-found so the endpoint can't
    // be used to probe which card ids exist.
    assert.equal(res.statusCode, 404, res.body);
    assert.deepEqual(chargedStripeCards(stripe), [], 'Stripe never called');

    const [inv] = await db
      .select({ status: invoices.status, pm: invoices.paymentMethodId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open', 'invoice untouched');
    assert.equal(inv?.pm, FIXTURE_IDS.paymentMethod1Id, 'bound card untouched');
    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — a removed (soft-expired) card of the owner’s → 404',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    const res = await pay(app, invoiceId, { card: DEAD_CARD_ID });
    assert.equal(res.statusCode, 404, res.body);
    assert.deepEqual(chargedStripeCards(stripe), [], 'Stripe never called');
    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — an unknown key in the body is rejected, not ignored',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    // The whole bug class here was a client sending a field the server threw
    // away. `.strict()` makes that loud.
    const res = await pay(app, invoiceId, { payload: { paymentMethodId: CARD2_ID } });
    assert.equal(res.statusCode, 422, res.body);
    assert.deepEqual(chargedStripeCards(stripe), [], 'Stripe never called');
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Idempotency — the card is part of the request identity
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /invoices/:id/pay — same key + DIFFERENT card does not replay the first card’s settle',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    const key = `collide-${randomUUID()}`;

    const first = await pay(app, invoiceId, { card: FIXTURE_IDS.paymentMethod1Id, key });
    assert.equal(first.statusCode, 201, first.body);

    // THE REGRESSION. Under `hashRequestBody({ id })` both calls hashed the
    // same, the peek matched, and this returned the first call's stored 201 —
    // reporting a successful charge on a card Stripe was never asked about.
    const second = await pay(app, invoiceId, { card: CARD2_ID, key });
    assert.equal(second.statusCode, 422, `expected idempotency mismatch, got: ${second.body}`);
    assert.match(second.body, /idempotency/i);

    assert.deepEqual(
      chargedStripeCards(stripe),
      ['pm_fixture_test_visa'],
      'exactly one charge, on the first call’s card',
    );
    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — same key + SAME card replays without charging twice',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    const key = `replay-${randomUUID()}`;

    const first = await pay(app, invoiceId, { card: CARD2_ID, key });
    assert.equal(first.statusCode, 201, first.body);
    const second = await pay(app, invoiceId, { card: CARD2_ID, key });
    assert.equal(second.statusCode, 201, second.body);

    assert.deepEqual(first.json(), second.json(), 'replay returns the stored response verbatim');
    assert.deepEqual(chargedStripeCards(stripe), [CARD2_STRIPE_ID], 'charged exactly once');
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 3DS — nothing captured, so nothing is repointed
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /invoices/:id/pay — a 3DS-pending charge on a chosen card does NOT repoint the invoice',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');

    const res = await pay(app, invoiceId, { card: CARD2_ID });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((res.json() as { invoice_status: string }).invoice_status, 'open');

    // Nothing was captured and the invoice is still open. Repointing here would
    // silently rewrite the auto-charge worker's target to a card the owner never
    // successfully paid with, as a side effect of an abandoned 3DS prompt.
    assert.equal(
      await boundCardOf(invoiceId),
      FIXTURE_IDS.paymentMethod1Id,
      'bound card unchanged on the 3DS path',
    );
    await cleanup();
  },
);
