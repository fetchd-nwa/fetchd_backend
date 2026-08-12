import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import {
  charges,
  idempotencyKeys,
  invoices,
  owners,
  paymentMethods,
  refunds,
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
import type { StripePaymentIntentStatus } from '../../src/lib/stripe.js';

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
 *
 * Wire 1.7.1 adds a fourth, in the last section: a confirm that does NOT settle
 * leaves no live PaymentIntent behind.
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
  await clearInvoiceChargeAttempts();
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
  const payload = opts.payload ?? (opts.card === undefined ? {} : { payment_method_id: opts.card });
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

/** The invoice fields a pay attempt is allowed to move — read as one snapshot so
 *  "untouched" is a single assertion rather than three that can drift apart. */
async function invoiceRowOf(invoiceId: string) {
  const [row] = await db
    .select({
      status: invoices.status,
      paymentMethodId: invoices.paymentMethodId,
      nextAttemptAt: invoices.nextAttemptAt,
      autoChargeAttempts: invoices.autoChargeAttempts,
      paidChargeId: invoices.paidChargeId,
      paidAt: invoices.paidAt,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  assert.ok(row !== undefined, `invoice ${invoiceId} exists`);
  return row;
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

// ──────────────────────────────────────────────────────────────────────────
// The abandoned PaymentIntent is cancelled (wire 1.7.1)
//
// The hazard: an intent left live after a non-succeeded confirm can auto-succeed
// later while the owner's next attempt captures on a fresh one — two succeeded
// charges against one invoice, and `settleInvoiceCharge`'s duplicate refund only
// fires inside a settle, so neither reverses. The auto-charge worker has always
// cancelled for this reason; this route did not until 1.7.1.
// ──────────────────────────────────────────────────────────────────────────

/** The PaymentIntent ids this stub was asked to cancel. */
function cancelledIntents(stripe: ReturnType<typeof makeStripeStub>): string[] {
  return stripe.calls
    .filter((c) => c.method === 'cancelPaymentIntent')
    .map((c) => c.args.paymentIntentId);
}

test(
  'POST /invoices/:id/pay — a non-succeeded confirm cancels the PaymentIntent it just created',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');

    const res = await pay(app, invoiceId, { card: CARD2_ID });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { stripe_payment_intent_id: string; invoice_status: string };
    assert.equal(body.invoice_status, 'open');

    assert.deepEqual(
      cancelledIntents(stripe),
      [body.stripe_payment_intent_id],
      'the intent named in the response is the intent that was cancelled',
    );
    await cleanup();
  },
);

test('POST /invoices/:id/pay — a succeeded confirm cancels nothing', SKIP_WHEN_NO_DB, async () => {
  await cleanup();
  await seedCards();
  const invoiceId = await seedOpenInvoice();
  const { app, stripe } = buildApp();

  assert.equal((await pay(app, invoiceId, { card: CARD2_ID })).statusCode, 201);
  assert.deepEqual(cancelledIntents(stripe), [], 'never cancel money that settled');
  await cleanup();
});

test(
  'POST /invoices/:id/pay — a cancel Stripe refuses does not fail the request',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');
    stripe.throwOnCancel();

    // Best-effort is the whole point: an uncancellable intent (a `processing`
    // one Stripe is already settling) must not turn a recorded attempt into a
    // 500 the owner reads as "nothing happened".
    const res = await pay(app, invoiceId, { card: CARD2_ID });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { charge_id: string; charge_status: string };
    assert.equal(body.charge_status, 'requires_payment');
    assert.equal(cancelledIntents(stripe).length, 1, 'the cancel was attempted');

    // The charge row is still written — it is the audit trail for an attempt
    // that reached Stripe.
    const [charge] = await db
      .select({ status: charges.status })
      .from(charges)
      .where(eq(charges.id, body.charge_id));
    assert.equal(charge?.status, 'requires_payment');
    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — a cancelled-PI attempt leaves the invoice exactly as it found it',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();

    const before = await invoiceRowOf(invoiceId);
    stripe.setNextIntentStatus('requires_action');
    assert.equal((await pay(app, invoiceId, { card: CARD2_ID })).statusCode, 201);

    // The auto-charge worker's schedule and the owner's next manual attempt both
    // have to proceed as if this attempt never happened — so status, bound card
    // and the retry clock are all untouched on this arm.
    assert.deepEqual(await invoiceRowOf(invoiceId), before);
    assert.equal(before.status, 'open', 'precondition: it was open to begin with');
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// `charge_blocker` — WHY the confirm stopped (wire 1.8.0)
//
// `charge_status` cannot say: it is pinned to the `charge_status` pgEnum, and
// five Stripe intent states collapse into `requires_payment` on the way in. The
// client's copy depends on exactly what that collapse destroys — "needs
// verification", "was declined" and "still processing" are three different true
// sentences with three different next actions, and the mobile fallback shipped
// against 1.7.1 had to GUESS between them.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Every non-succeeded raw Stripe status and the blocker the owner is told
 * about. Pinned as a table so a re-derivation can't quietly re-lump
 * `processing` under authentication-required — the copy for that one invites
 * the retry that can double-charge, on the single status the cancel rule
 * cannot kill.
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
    `POST /invoices/:id/pay — ${rawStatus} reports charge_blocker '${blocker}'`,
    SKIP_WHEN_NO_DB,
    async () => {
      await cleanup();
      await seedCards();
      const invoiceId = await seedOpenInvoice();
      const { app, stripe } = buildApp();
      stripe.setNextIntentStatus(rawStatus);

      const res = await pay(app, invoiceId, { card: CARD2_ID });
      assert.equal(res.statusCode, 201, res.body);
      const body = res.json() as {
        invoice_status: string;
        charge_status: string;
        charge_blocker?: string;
      };
      // The field rides BESIDE the collapsed status, never instead of it.
      assert.equal(body.invoice_status, 'open');
      assert.equal(body.charge_blocker, blocker);
      await cleanup();
    },
  );
}

test(
  'POST /invoices/:id/pay — a settled confirm omits charge_blocker entirely',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app } = buildApp();

    const res = await pay(app, invoiceId, { card: CARD2_ID });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.invoice_status, 'paid');
    // Omitted, not null: "present IFF non-succeeded" is what lets a client read
    // the field's mere presence as "this did not settle".
    assert.equal(
      'charge_blocker' in body,
      false,
      'a settled arm must not carry a reason it stopped',
    );
    await cleanup();
  },
);

test(
  'POST /invoices/:id/pay — a pre-1.8.0 stored replay without the field still parses',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedCards();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = buildApp();
    stripe.setNextIntentStatus('requires_action');
    const key = `pay-blocker-replay-${randomUUID()}`;

    const first = await pay(app, invoiceId, { card: CARD2_ID, key });
    assert.equal(first.statusCode, 201, first.body);

    // Rewrite the stored response to the pre-1.8.0 shape, then replay: this is
    // the real population of bodies a 1.8.0 client will meet — responses stored
    // by the old server that nothing will ever re-derive the field for.
    const [stored] = await db
      .select({ body: idempotencyKeys.responseBody })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key));
    const legacy = { ...(stored?.body as Record<string, unknown>) };
    delete legacy.charge_blocker;
    await db
      .update(idempotencyKeys)
      .set({ responseBody: legacy })
      .where(eq(idempotencyKeys.key, key));

    const replay = await pay(app, invoiceId, { card: CARD2_ID, key });
    assert.equal(replay.statusCode, 201, replay.body);
    const body = replay.json() as Record<string, unknown>;
    assert.equal('charge_blocker' in body, false, 'the field is absent, and that is legal');
    assert.equal(body.charge_status, 'requires_payment', 'the rest of the body still arrives');
    await cleanup();
  },
);
