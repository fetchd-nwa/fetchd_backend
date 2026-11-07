import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { scheduledNotificationsRepository } from '../../src/db/repositories/scheduledNotificationsRepository.js';
import {
  charges,
  creditLedger,
  invoices,
  notifications,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { clearInvoiceReferrers, FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * The payment-failure channel, end to end (wire 1.9.0,
 * `designs/payment-failure-channel.md`).
 *
 * Three things are pinned here that nothing else pins:
 *
 *  1. **Both of Stripe's failure forks are the same code path.** Stripe reports
 *     a declined stored card either by RETURNING a non-succeeded PaymentIntent
 *     or by THROWING a card error that carries it. Before 1.9.0 only the first
 *     was built, so the most common real payment failure rendered the most
 *     generic sentence in the app ("We couldn't reach the server."). Each confirm
 *     site is driven down both forks and the two outcomes are compared field for
 *     field — same status body, same rows, same Stripe calls.
 *  2. **A transport failure is NOT a decline.** The seam rethrows connection /
 *     API / rate-limit errors untouched. Getting this backwards would tell every
 *     owner at once that their card was declined during a Stripe outage, and
 *     "try a different card" is the wrong advice for it.
 *  3. **The late-settle promise is kept.** A `processing` credit purchase tells
 *     the owner "we'll let you know"; the webhook flip is the only place that
 *     can happen, and without it the copy points at nothing and the honest
 *     advice becomes "buy again" — the double-charge/double-grant path.
 *
 * Plus the reason-bearing producers, whose emitted `deep_link_path` IS the
 * framing the settle sheet reads.
 */

registerFixtureHooks();

// ── shared scaffolding ────────────────────────────────────────────────────

function invoicesApp(): { app: ReturnType<typeof makeContractApp>['app']; stripe: StripeStub } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerInvoicesRoute(app, { authenticate, stripe });
  return { app, stripe };
}

function creditsApp(): { app: ReturnType<typeof makeContractApp>['app']; stripe: StripeStub } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerCreditPackagesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

function webhookApp(capture?: ReturnType<typeof makeLogCapture>): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: StripeStub;
} {
  const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  const stripe = makeStripeStub();
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

async function seedOpenInvoice(
  opts: { dueAt?: string; amountCents?: number } = {},
): Promise<string> {
  const row = await db.transaction(async (tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: opts.amountCents ?? 200_000,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: opts.dueAt ?? '2026-06-15T00:00:00Z',
    }),
  );
  return row.id;
}

async function cleanup(): Promise<void> {
  await db.delete(creditLedger).where(isNotNull(creditLedger.chargeId));
  await clearInvoiceReferrers();
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  // Break the scheduled -> feed FK link before dropping either side; the
  // dedupe keys are id-stable, so a stale row would silently block the next
  // enqueue and make an assertion pass for the wrong reason.
  await db
    .update(scheduledNotifications)
    .set({ emittedNotificationId: null })
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.ownerId, FIXTURE_IDS.ownerId),
        inArray(notifications.type, ['payment-succeeded', 'payment-failed']),
      ),
    );
  await db
    .delete(scheduledNotifications)
    .where(
      and(
        eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
        inArray(scheduledNotifications.type, [
          'payment-succeeded',
          'payment-failed',
          'payment-due',
        ]),
      ),
    );
}

/** The Stripe-side footprint of one request, so two forks can be compared as a
 *  whole rather than one assertion at a time. */
function stripeFootprint(stripe: StripeStub): {
  confirms: number;
  cancels: number;
  refunds: number;
} {
  return {
    confirms: stripe.calls.filter(
      (c) => c.method === 'createAndConfirmPaymentIntent' || c.method === 'confirmPaymentIntent',
    ).length,
    cancels: stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length,
    refunds: stripe.calls.filter((c) => c.method === 'createRefund').length,
  };
}

async function chargeRowsForOwner(): Promise<{ status: string; purpose: string }[]> {
  return db
    .select({ status: charges.status, purpose: charges.purpose })
    .from(charges)
    .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Both forks, per confirm site
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /invoices/:id/pay — a THROWN card decline lands the same 402 + rows as a RETURNED one',
  SKIP_WHEN_NO_DB,
  async () => {
    const outcomes: {
      body: Record<string, unknown>;
      footprint: ReturnType<typeof stripeFootprint>;
      rows: { status: string; purpose: string }[];
      invoiceStatus: string | undefined;
    }[] = [];

    for (const fork of ['returned', 'thrown'] as const) {
      await cleanup();
      const invoiceId = await seedOpenInvoice();
      const { app, stripe } = invoicesApp();
      // A real returned decline carries its code on `last_payment_error`, so the two
      // forks read one card's answer alike (P16). A bare status names no card.
      if (fork === 'returned') {
        stripe.queueIntentOutcomes([
          { kind: 'returnedDecline', code: 'card_declined', declineCode: 'generic_decline' },
        ]);
      } else {
        stripe.setNextIntentThrowsCardError('requires_payment_method');
      }

      const res = await app.inject({
        method: 'POST',
        url: `/invoices/${invoiceId}/pay`,
        headers: { 'idempotency-key': `pfc-inv-${fork}-${randomUUID()}` },
        payload: {},
      });
      assert.equal(res.statusCode, 402, `${fork}: ${res.body}`);
      const [inv] = await db
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, invoiceId));
      const { error } = res.json() as {
        error: { code: string; details: Record<string, unknown> };
      };
      const { order_id: orderId, ...details } = error.details;
      void orderId;
      outcomes.push({
        body: { code: error.code, ...details },
        footprint: stripeFootprint(stripe),
        rows: await chargeRowsForOwner(),
        invoiceStatus: inv?.status,
      });
    }

    const [returned, thrown] = outcomes;
    assert.deepEqual(thrown, returned, 'the two forks must be indistinguishable downstream');
    // And the shared outcome is the RIGHT one — an equivalence between two
    // wrong answers would satisfy the assertion above.
    assert.equal(returned!.body.code, 'payment_failed');
    assert.equal(returned!.body.charge_blocker, 'declined');
    assert.equal(returned!.invoiceStatus, 'open', 'the obligation stays open on both forks');
    assert.equal(returned!.footprint.cancels, 0, 'wire 1.7.1 is gone from this route');
    assert.deepEqual(
      returned!.rows,
      [{ status: 'failed', purpose: 'board-train' }],
      'the failed charge is recorded on both forks (R32 keeps it out of the ledger)',
    );

    await cleanup();
  },
);

test(
  'POST /credit-packages/:key/purchase — a THROWN card decline lands the same 402 + rows as a RETURNED one',
  SKIP_WHEN_NO_DB,
  async () => {
    const outcomes: {
      details: Record<string, unknown>;
      footprint: ReturnType<typeof stripeFootprint>;
      rows: { status: string; purpose: string }[];
      ledger: number;
    }[] = [];

    for (const fork of ['returned', 'thrown'] as const) {
      await cleanup();
      const { app, stripe } = creditsApp();
      if (fork === 'returned') stripe.setNextIntentStatus('requires_action');
      // The code is passed explicitly since 2026-08-11. Equivalence between the
      // forks is now conditional: they agree on the blocker WHEN the thrown
      // code says what the status implies. Leaving the default `card_declined`
      // here would pair a `requires_action` status with a decline code and
      // assert they must agree — demanding the fix be undone.
      else stripe.setNextIntentThrowsCardError('requires_action', 'authentication_required');

      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
        headers: { 'idempotency-key': `pfc-cp-${fork}-${randomUUID()}` },
        payload: {
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        },
      });
      assert.equal(res.statusCode, 402, `${fork}: ${res.body}`);
      const ledger = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(isNotNull(creditLedger.chargeId));
      const details = {
        ...(res.json() as { error: { details: Record<string, unknown> } }).error.details,
      };
      delete details.order_id;
      outcomes.push({
        details,
        footprint: stripeFootprint(stripe),
        rows: await chargeRowsForOwner(),
        ledger: ledger.length,
      });
    }

    const [returned, thrown] = outcomes;
    assert.deepEqual(thrown, returned);
    assert.equal(returned!.details.charge_blocker, 'authentication_required');
    assert.equal(returned!.ledger, 0, 'no grant on either fork');

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 1b. RECORDED Stripe — the arm wire 1.8.0 exists for, reached at last
//
// Everything above drives the stub with HAND-BUILT card errors. These drive it
// with the error live Stripe actually threw (`test/fixtures/stripe-thrown-
// confirm.json`, recorded by `npm run probe:stripe -- --record`).
//
// Why that distinction earned its own section: off-session, Stripe reports a
// 3DS failure as `code=authentication_required` on an intent that has ALREADY
// been reset to `requires_payment_method`. Deriving the blocker from that
// status alone yields `declined`, so every owner whose card needed
// verification was told to go find a different card — on all five routes, for
// as long as the field has existed. No hand-built error contained that shape,
// because nobody imagined it; the recording contains it because Stripe sent it.
//
// Each site gets the recorded PAIR — authentication-required AND declined —
// because pinning only the new arm would leave the inverse un-pinned, and
// relabelling genuine declines as "needs verification" would be worse than the
// bug being fixed.
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /invoices/:id/pay — a RECORDED 3DS failure says authentication_required, and a RECORDED decline still says declined',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const [scenario, expected] of [
      ['authentication-required', 'authentication_required'],
      ['saved-card-declined', 'declined'],
    ] as const) {
      await cleanup();
      const invoiceId = await seedOpenInvoice();
      const { app, stripe } = invoicesApp();
      stripe.setNextIntentThrowsRecorded(scenario);

      const res = await app.inject({
        method: 'POST',
        url: `/invoices/${invoiceId}/pay`,
        headers: { 'idempotency-key': `pfc-inv-rec-${scenario}-${randomUUID()}` },
        payload: {},
      });

      assert.equal(res.statusCode, 402, `${scenario}: ${res.body}`);
      const body = res.json() as {
        error: { code: string; details: { charge_blocker: string } };
      };
      assert.equal(
        body.error.details.charge_blocker,
        expected,
        `${scenario}: the owner's sentence`,
      );
      // Everything that MOVES or RECORDS money is unchanged by which sentence
      // the owner reads — the amended fork invariant, asserted rather than
      // assumed.
      assert.equal(body.error.code, 'payment_failed');
      const [inv] = await db
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, invoiceId));
      assert.equal(inv?.status, 'open', 'the obligation stays open on both codes');
      assert.deepEqual(await chargeRowsForOwner(), [{ status: 'failed', purpose: 'board-train' }]);
    }
    await cleanup();
  },
);

test(
  'POST /credit-packages/:key/purchase — a RECORDED 3DS failure says authentication_required, grants nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const [scenario, expected] of [
      ['authentication-required', 'authentication_required'],
      ['saved-card-declined', 'declined'],
    ] as const) {
      await cleanup();
      const { app, stripe } = creditsApp();
      stripe.setNextIntentThrowsRecorded(scenario);

      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
        headers: { 'idempotency-key': `pfc-cp-rec-${scenario}-${randomUUID()}` },
        payload: {
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        },
      });

      assert.equal(res.statusCode, 402, `${scenario}: ${res.body}`);
      const body = res.json() as { error: { details: { charge_blocker: string } } };
      assert.equal(body.error.details.charge_blocker, expected);
      const ledger = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(isNotNull(creditLedger.chargeId));
      assert.equal(ledger.length, 0, 'run what would go red: nothing was granted');
      assert.deepEqual(await chargeRowsForOwner(), [{ status: 'failed', purpose: 'package' }]);
      assert.equal(stripeFootprint(stripe).cancels, 0, 'the watch cancels it, not the request');
    }
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 2. A transport failure is not a decline
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /invoices/:id/pay — a Stripe CONNECTION error is not relabelled a decline',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice();
    const { app, stripe } = invoicesApp();
    // Twice: the engine re-sends one lost create under K0, so one failure heals.
    stripe.nextCreateThrowsTransport(2);

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `pfc-inv-net-${randomUUID()}` },
      payload: {},
    });

    // NOT 201-with-a-blocker and NOT 402: there is no answer yet, and the client's
    // same-key re-send is the right recovery. The sweeper answers it past the lease.
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'idempotency_inflight');
    assert.deepEqual(
      await chargeRowsForOwner(),
      [{ status: 'requires_payment', purpose: 'board-train' }],
      'tx1 committed: the charge is on the books, and no card was tried',
    );
    const [inv] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open');
    assert.equal(stripeFootprint(stripe).confirms, 0, 'no confirm was sent');
    assert.equal(stripeFootprint(stripe).cancels, 0, 'nothing to cancel — we never got an intent');

    await cleanup();
  },
);

test(
  'POST /credit-packages/:key/purchase — a Stripe RATE-LIMIT error is not relabelled a decline',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { app, stripe } = creditsApp();
    // Twice: the engine re-sends one lost create under K0, so one failure heals.
    stripe.nextCreateThrowsTransport(2);

    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': `pfc-cp-net-${randomUUID()}` },
      payload: {
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    // No answer yet: the client's same-key re-send is the recovery, and the sweeper
    // answers it past the lease.
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'idempotency_inflight');
    assert.deepEqual(await chargeRowsForOwner(), [
      { status: 'requires_payment', purpose: 'package' },
    ]);
    assert.equal(stripeFootprint(stripe).confirms, 0, 'no confirm was sent');

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 3. The late-settle pushes — the `processing` promise, kept
// ──────────────────────────────────────────────────────────────────────────

const PACKAGE_METADATA: Record<string, string> = {
  owner_id: FIXTURE_IDS.ownerId,
  dog_id: FIXTURE_IDS.dog1Id,
  package_id: FIXTURE_IDS.creditPackageSchool5Id,
  package_key: FIXTURE_IDS.creditPackageSchool5Key,
  credits: '5',
  mode: 'school',
  location: 'fayetteville',
};

/** A credit purchase parked at `requires_payment` — the shape the credit route
 *  commits BEFORE its 201 on a `processing` intent. */
async function seedProcessingPackageCharge(paymentIntentId: string): Promise<string> {
  const charge = await withActor('test', async (tx) =>
    chargesRepository.create(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 25_000,
      status: 'requires_payment',
      purpose: 'package',
      stripePaymentIntentId: paymentIntentId,
      dogId: FIXTURE_IDS.dog1Id,
    }),
  );
  return charge.id;
}

async function postWebhook(
  app: ReturnType<typeof makeContractApp>['app'],
  stripe: StripeStub,
  event: Parameters<StripeStub['setNextEvent']>[0],
): Promise<{ outcome: string }> {
  stripe.setNextEvent(event);
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'stripe-signature': 't=1,v1=fake' },
    payload: { id: randomUUID() },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { outcome: string };
}

test(
  'webhook: a package charge with no order grants nothing, and one alarm reaches the log',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const piId = `pi_late_${randomUUID().slice(0, 8)}`;
    const chargeId = await seedProcessingPackageCharge(piId);
    const capture = makeLogCapture();
    const { app, stripe } = webhookApp(capture);

    const result = await postWebhook(app, stripe, {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: piId,
      amountCents: 25_000,
      metadata: PACKAGE_METADATA,
    });

    assert.equal(result.outcome, 'flipped-charge-succeeded');
    const alarms = capture.lines.filter((l) => l.level === 50 && l.chargeId === chargeId);
    assert.equal(alarms.length, 1, 'a person hears');
    const lots = await db.select().from(creditLedger).where(eq(creditLedger.chargeId, chargeId));
    assert.deepEqual(lots, [], 'metadata buys nothing');

    await cleanup();
  },
);

test(
  'webhook: an ALREADY-SUCCEEDED package charge pushes nothing (the 201 already told them)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const piId = `pi_sync_${randomUUID().slice(0, 8)}`;
    const charge = await withActor('test', async (tx) =>
      chargesRepository.create(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 25_000,
        status: 'succeeded',
        purpose: 'package',
        stripePaymentIntentId: piId,
        dogId: FIXTURE_IDS.dog1Id,
      }),
    );
    const { app, stripe } = webhookApp();

    const result = await postWebhook(app, stripe, {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: piId,
      amountCents: 25_000,
      metadata: PACKAGE_METADATA,
    });
    assert.equal(result.outcome, 'charge-already-terminal');
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(db, `package-flip:${charge.id}`),
      undefined,
      'a synchronous purchase gets its answer in the 201, not on the push channel',
    );

    await cleanup();
  },
);

test(
  'webhook: an INVOICE charge flip pushes nothing (R36 is its own design)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const piId = `pi_inv_${randomUUID().slice(0, 8)}`;
    await withActor('test', async (tx) =>
      chargesRepository.create(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 200_000,
        status: 'requires_payment',
        purpose: 'board-train',
        stripePaymentIntentId: piId,
      }),
    );
    const { app, stripe } = webhookApp();

    await postWebhook(app, stripe, {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: piId,
      amountCents: 200_000,
      metadata: { owner_id: FIXTURE_IDS.ownerId, invoice_id: randomUUID(), purpose: 'board-train' },
    });
    const rows = await db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
          inArray(scheduledNotifications.type, ['payment-succeeded', 'payment-failed']),
        ),
      );
    assert.equal(rows.length, 0, 'the new pushes are scoped to credit purchases');

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 4. The receipt, which deliberately carries no reason.
// ──────────────────────────────────────────────────────────────────────────

test(
  'the settle receipt deliberately carries NO reason (a paid invoice has no settle framing)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice({ dueAt: '2026-01-01T00:00:00Z' });
    const { app } = invoicesApp(); // default: succeeds
    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `receipt-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 201, res.body);

    const [receipt] = await db
      .select({ deepLinkPath: scheduledNotifications.deepLinkPath })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
          eq(scheduledNotifications.type, 'payment-succeeded'),
        ),
      );
    assert.equal(
      receipt?.deepLinkPath,
      `/account/invoices?invoiceId=${invoiceId}`,
      'byte-identical to the pre-1.9.0 path — a receipt opens a PAID invoice',
    );

    await cleanup();
  },
);
