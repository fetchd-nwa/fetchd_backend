import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Stripe from 'stripe';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { membershipsRepository } from '../../src/db/repositories/membershipsRepository.js';
import { scheduledNotificationsRepository } from '../../src/db/repositories/scheduledNotificationsRepository.js';
import {
  charges,
  creditLedger,
  invoices,
  memberships,
  notifications,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { enqueueInvoiceOverdueWarnings } from '../../src/lib/enqueueInvoiceOverdueWarnings.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { registerMembershipsRoute } from '../../src/routes/memberships.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { runInvoiceAutoChargeOnce } from '../../src/workers/invoiceAutoCharge.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
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

function membershipsApp(): { app: ReturnType<typeof makeContractApp>['app']; stripe: StripeStub } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerMembershipsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

function webhookApp(): { app: ReturnType<typeof makeContractApp>['app']; stripe: StripeStub } {
  const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

async function seedOpenInvoice(
  opts: { dueAt?: string; nextAttemptAt?: string; amountCents?: number } = {},
): Promise<string> {
  const row = await db.transaction(async (tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: opts.amountCents ?? 200_000,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: opts.dueAt ?? '2026-06-15T00:00:00Z',
      ...(opts.nextAttemptAt !== undefined ? { nextAttemptAt: opts.nextAttemptAt } : {}),
    }),
  );
  return row.id;
}

async function cleanup(): Promise<void> {
  await db.delete(creditLedger).where(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id));
  await db.delete(memberships).where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
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
        inArray(notifications.type, ['payment-succeeded', 'payment-failed', 'invoice-overdue']),
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
          'invoice-overdue',
        ]),
      ),
    );
}

/** The Stripe-side footprint of one request, so two forks can be compared as a
 *  whole rather than one assertion at a time. */
function stripeFootprint(stripe: StripeStub): { confirms: number; cancels: number; refunds: number } {
  return {
    confirms: stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent').length,
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

/** Strip the server-generated ids so two runs of the same request compare. */
function withoutIds(body: Record<string, unknown>): Record<string, unknown> {
  const { charge_id, stripe_payment_intent_id, client_secret, ...rest } = body;
  void charge_id;
  void stripe_payment_intent_id;
  void client_secret;
  return rest;
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Both forks, per confirm site
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /invoices/:id/pay — a THROWN card decline lands the same 201 + rows as a RETURNED one',
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
      if (fork === 'returned') stripe.setNextIntentStatus('requires_payment_method');
      else stripe.setNextIntentThrowsCardError('requires_payment_method');

      const res = await app.inject({
        method: 'POST',
        url: `/invoices/${invoiceId}/pay`,
        headers: { 'idempotency-key': `pfc-inv-${fork}-${randomUUID()}` },
        payload: {},
      });
      assert.equal(res.statusCode, 201, `${fork}: ${res.body}`);
      const [inv] = await db
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, invoiceId));
      outcomes.push({
        body: withoutIds(res.json() as Record<string, unknown>),
        footprint: stripeFootprint(stripe),
        rows: await chargeRowsForOwner(),
        invoiceStatus: inv?.status,
      });
    }

    const [returned, thrown] = outcomes;
    assert.deepEqual(thrown, returned, 'the two forks must be indistinguishable downstream');
    // And the shared outcome is the RIGHT one — an equivalence between two
    // wrong answers would satisfy the assertion above.
    assert.equal(returned!.body.charge_status, 'requires_payment');
    assert.equal(returned!.body.invoice_status, 'open');
    assert.equal(returned!.body.charge_blocker, 'declined');
    assert.equal(returned!.invoiceStatus, 'open', 'the obligation stays open on both forks');
    assert.equal(returned!.footprint.cancels, 1, 'the 1.7.1 cancel rule fires on both forks');
    assert.deepEqual(
      returned!.rows,
      [{ status: 'requires_payment', purpose: 'board-train' }],
      'the audit charge row is written on both forks (R32 keeps it out of the ledger)',
    );

    await cleanup();
  },
);

test(
  'POST /credit-packages/:key/purchase — a THROWN card decline lands the same 201 + rows as a RETURNED one',
  SKIP_WHEN_NO_DB,
  async () => {
    const outcomes: {
      body: Record<string, unknown>;
      footprint: ReturnType<typeof stripeFootprint>;
      rows: { status: string; purpose: string }[];
      ledger: number;
    }[] = [];

    for (const fork of ['returned', 'thrown'] as const) {
      await cleanup();
      const { app, stripe } = creditsApp();
      if (fork === 'returned') stripe.setNextIntentStatus('requires_action');
      else stripe.setNextIntentThrowsCardError('requires_action');

      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
        headers: { 'idempotency-key': `pfc-cp-${fork}-${randomUUID()}` },
        payload: {
          dog_id: FIXTURE_IDS.dog1Id,
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 201, `${fork}: ${res.body}`);
      const ledger = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'purchase')));
      outcomes.push({
        body: withoutIds(res.json() as Record<string, unknown>),
        footprint: stripeFootprint(stripe),
        rows: await chargeRowsForOwner(),
        ledger: ledger.length,
      });
    }

    const [returned, thrown] = outcomes;
    assert.deepEqual(thrown, returned);
    assert.equal(returned!.body.charge_blocker, 'authentication_required');
    assert.equal(returned!.body.credits_granted, 0);
    assert.equal(returned!.ledger, 0, 'no grant on either fork');

    await cleanup();
  },
);

test(
  'POST /memberships — a THROWN card decline 402s with the same blocker and creates nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const outcomes: {
      status: number;
      error: unknown;
      footprint: ReturnType<typeof stripeFootprint>;
      memberships: number;
      charges: number;
    }[] = [];

    for (const fork of ['returned', 'thrown'] as const) {
      await cleanup();
      const { app, stripe } = membershipsApp();
      if (fork === 'returned') stripe.setNextIntentStatus('requires_payment_method');
      else stripe.setNextIntentThrowsCardError('requires_payment_method');

      const res = await app.inject({
        method: 'POST',
        url: '/memberships',
        headers: { 'idempotency-key': `pfc-mem-${fork}-${randomUUID()}` },
        payload: {
          dog_id: FIXTURE_IDS.dog1Id,
          package_key: FIXTURE_IDS.creditPackageSchool5Key,
          location: 'fayetteville',
          term_months: 6,
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        },
      });
      const rows = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
      outcomes.push({
        status: res.statusCode,
        error: res.json(),
        footprint: stripeFootprint(stripe),
        memberships: rows.length,
        charges: (await chargeRowsForOwner()).length,
      });
    }

    const [returned, thrown] = outcomes;
    assert.deepEqual(thrown, returned);
    assert.equal(returned!.status, 402);
    assert.deepEqual(returned!.error, {
      error: {
        code: 'payment_failed',
        message:
          'card could not be charged synchronously (declined or requires authentication) — memberships need a card that charges without extra steps; try a different card',
        details: { kind: 'payment_failed', charge_blocker: 'declined' },
      },
    });
    // Run what would go red if the refusal leaked: no membership, no charge.
    assert.equal(returned!.memberships, 0, 'no half-created membership on either fork');
    assert.equal(returned!.charges, 0, 'the refusal beats withMutation — nothing written');

    await cleanup();
  },
);

test(
  'invoice auto-charge worker — a THROWN card decline now CANCELS the intent, like the returned fork',
  SKIP_WHEN_NO_DB,
  async () => {
    const outcomes: {
      outcome: string;
      footprint: ReturnType<typeof stripeFootprint>;
      attempts: number | undefined;
      invoiceStatus: string | undefined;
    }[] = [];

    for (const fork of ['returned', 'thrown'] as const) {
      await cleanup();
      const invoiceId = await seedOpenInvoice({
        dueAt: '2026-01-01T00:00:00Z',
        nextAttemptAt: '2026-01-01T00:00:00Z',
      });
      const stripe = makeStripeStub();
      if (fork === 'returned') stripe.setNextIntentStatus('requires_payment_method');
      else stripe.setNextIntentThrowsCardError('requires_payment_method');

      const tick = await runInvoiceAutoChargeOnce({
        stripe,
        limit: 1,
        now: new Date('2026-02-01T12:00:00Z'),
      });
      const [inv] = await db
        .select({ status: invoices.status, attempts: invoices.autoChargeAttempts })
        .from(invoices)
        .where(eq(invoices.id, invoiceId));
      outcomes.push({
        outcome: tick.results[0]!.outcome,
        footprint: stripeFootprint(stripe),
        attempts: inv?.attempts,
        invoiceStatus: inv?.status,
      });
    }

    const [returned, thrown] = outcomes;
    assert.deepEqual(thrown, returned);
    assert.equal(returned!.outcome, 'failed-retry-scheduled');
    assert.equal(returned!.attempts, 1, 'the attempt still counts toward the park cap');
    assert.equal(returned!.invoiceStatus, 'open');
    // The behavior CHANGE this design bought the worker: a thrown decline used
    // to hit the catch and leave the failed PI live. It is cancelled now.
    assert.equal(returned!.footprint.cancels, 1, 'the failed intent is cancelled on both forks');

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
    stripe.setNextIntentThrowsTransport();

    const res = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/pay`,
      headers: { 'idempotency-key': `pfc-inv-net-${randomUUID()}` },
      payload: {},
    });

    // NOT 201-with-a-blocker and NOT 402: we do not know whether money moved,
    // and the client's `network` arm (reused-key retry) is the right recovery.
    assert.notEqual(res.statusCode, 201);
    assert.notEqual(res.statusCode, 402);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'internal');
    assert.deepEqual(await chargeRowsForOwner(), [], 'no charge row for an unknown outcome');
    const [inv] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open');
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
    stripe.setNextIntentThrowsTransport(
      new Stripe.errors.StripeRateLimitError({ message: 'slow down' }),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
      headers: { 'idempotency-key': `pfc-cp-net-${randomUUID()}` },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        location: 'fayetteville',
      },
    });
    assert.notEqual(res.statusCode, 201);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'internal');
    assert.deepEqual(await chargeRowsForOwner(), []);

    await cleanup();
  },
);

test(
  'invoice auto-charge worker — a transport error still takes the catch (attempt counted, no cancel)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice({
      dueAt: '2026-01-01T00:00:00Z',
      nextAttemptAt: '2026-01-01T00:00:00Z',
    });
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();

    const tick = await runInvoiceAutoChargeOnce({
      stripe,
      limit: 1,
      now: new Date('2026-02-01T12:00:00Z'),
    });
    assert.equal(tick.results[0]!.outcome, 'failed-retry-scheduled');
    const [inv] = await db
      .select({ status: invoices.status, attempts: invoices.autoChargeAttempts })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.attempts, 1);
    assert.equal(inv?.status, 'open');
    // The catch has no intent id to cancel — that is precisely why the card
    // fork must NOT arrive here any more.
    assert.equal(stripeFootprint(stripe).cancels, 0);

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
  quantity: '1',
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
  'webhook: a package charge flipping to SUCCEEDED enqueues the late-settle push, once',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const piId = `pi_late_${randomUUID().slice(0, 8)}`;
    const chargeId = await seedProcessingPackageCharge(piId);
    const { app, stripe } = webhookApp();

    const first = await postWebhook(app, stripe, {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: piId,
      amountCents: 25_000,
      metadata: PACKAGE_METADATA,
    });
    assert.equal(first.outcome, 'flipped-charge-succeeded');

    const row = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `package-flip:${chargeId}`,
    );
    assert.ok(row !== undefined, 'the promised follow-up was enqueued');
    assert.equal(row?.type, 'payment-succeeded');
    assert.equal(row?.title, 'Purchase complete');
    // Allison's copy, 2026-08-04. Named amount, named credit count, named dog —
    // "credits were added" without saying whose is the kind of vague that makes
    // someone open the app to find out.
    assert.equal(
      row?.body,
      'Your $250 credit purchase went through — 5 credits were added for Waffles.',
    );
    assert.equal(
      row?.deepLinkPath,
      `/dog-profile/${FIXTURE_IDS.dog1Id}?highlight=credits`,
      'the tap lands on the credits card that just changed',
    );
    assert.equal(row?.deepLinkKind, 'credits');
    assert.equal(row?.dogId, FIXTURE_IDS.dog1Id);

    // A REPLAYED delivery of the same flip must not push twice. The event id
    // differs, so the receiver's `stripe_events` dedupe does not cover this —
    // the per-charge dedupe key is what does.
    const replay = await postWebhook(app, stripe, {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: piId,
      amountCents: 25_000,
      metadata: PACKAGE_METADATA,
    });
    assert.equal(replay.outcome, 'charge-already-terminal', 'the charge is terminal now');
    const rows = await db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
          eq(scheduledNotifications.type, 'payment-succeeded'),
        ),
      );
    assert.equal(rows.length, 1, 'exactly one push per flipped charge, ever');

    await cleanup();
  },
);

test(
  'webhook: a package charge flipping to FAILED enqueues the "you were not charged" push',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const piId = `pi_latefail_${randomUUID().slice(0, 8)}`;
    const chargeId = await seedProcessingPackageCharge(piId);
    const { app, stripe } = webhookApp();

    const result = await postWebhook(app, stripe, {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.payment_failed',
      paymentIntentId: piId,
      amountCents: 25_000,
      metadata: PACKAGE_METADATA,
    });
    assert.equal(result.outcome, 'flipped-charge-failed');

    const row = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `package-flip-failed:${chargeId}`,
    );
    assert.ok(row !== undefined, 'the owner is told the purchase resolved badly');
    assert.equal(row?.type, 'payment-failed');
    assert.equal(
      row?.body,
      "Your credit purchase didn't go through — you weren't charged. No credits were added.",
    );
    assert.equal(row?.deepLinkPath, `/dog-profile/${FIXTURE_IDS.dog1Id}?highlight=credits`);
    // And no succeeded twin was enqueued alongside it.
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(db, `package-flip:${chargeId}`),
      undefined,
    );

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
  'webhook: a MEMBERSHIP month-1 charge carrying package fields pushes nothing (§J.1)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const piId = `pi_mem_${randomUUID().slice(0, 8)}`;
    // Same package metadata a membership month-1 PI carries — the one guard
    // that knows the difference is `purpose: 'membership'`.
    const charge = await withActor('test', async (tx) =>
      chargesRepository.create(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 25_000,
        status: 'requires_payment',
        purpose: 'package',
        stripePaymentIntentId: piId,
        dogId: FIXTURE_IDS.dog1Id,
      }),
    );
    const { app, stripe } = webhookApp();

    await postWebhook(app, stripe, {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: piId,
      amountCents: 25_000,
      metadata: { ...PACKAGE_METADATA, purpose: 'membership' },
    });
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(db, `package-flip:${charge.id}`),
      undefined,
      'a membership month-1 PI is never a package purchase',
    );

    await cleanup();
  },
);

test(
  'webhook: a RECONSTRUCTED orphan purchase also pushes (the owner has no 201 naming it)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const piId = `pi_orphan_${randomUUID().slice(0, 8)}`;
    const { app, stripe } = webhookApp();

    const result = await postWebhook(app, stripe, {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: piId,
      amountCents: 25_000,
      metadata: PACKAGE_METADATA,
    });
    assert.equal(result.outcome, 'reconstructed-package-purchase');

    const [charge] = await db
      .select({ id: charges.id })
      .from(charges)
      .where(eq(charges.stripePaymentIntentId, piId));
    assert.ok(charge !== undefined);
    const row = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `package-flip:${charge!.id}`,
    );
    assert.ok(row !== undefined, 'a reconstruct is exactly when the push matters most');
    assert.equal(row?.type, 'payment-succeeded');

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
// 4. The last reason-bearing producer (the other three are pinned in their
//    own files: the parked-invoice push, the pay-in-person reminder, and the
//    receipt that deliberately carries NO reason).
// ──────────────────────────────────────────────────────────────────────────

test(
  'invoice-overdue safety net — emits &reason=payment-due',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice({ dueAt: '2026-01-01T00:00:00Z' });

    const result = await withActor('test', async (tx) =>
      enqueueInvoiceOverdueWarnings(tx, new Date('2026-02-01T12:00:00Z')),
    );
    assert.equal(result.enqueued, 1, 'the scan found the overdue invoice');

    const row = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `invoice-overdue:${invoiceId}`,
    );
    assert.equal(
      row?.deepLinkPath,
      `/account/invoices?invoiceId=${invoiceId}&reason=payment-due`,
      'money is still owed — the sheet must open saying so',
    );

    await cleanup();
  },
);

test(
  'the settle receipt deliberately carries NO reason (a paid invoice has no settle framing)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedOpenInvoice({
      dueAt: '2026-01-01T00:00:00Z',
      nextAttemptAt: '2026-01-01T00:00:00Z',
    });
    const stripe = makeStripeStub(); // default: succeeds
    await runInvoiceAutoChargeOnce({ stripe, limit: 1, now: new Date('2026-02-01T12:00:00Z') });

    const [receipt] = await db
      .select({ deepLinkPath: notifications.deepLinkPath })
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, FIXTURE_IDS.ownerId),
          eq(notifications.type, 'payment-succeeded'),
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

// Keep the fixture's membership repo import honest: the memberships test above
// asserts absence through the table directly, and this guards the helper the
// route uses to find an existing subscription (a stale one would make that
// absence assertion pass for the wrong reason).
test('fixture baseline: the owner holds no active school membership', SKIP_WHEN_NO_DB, async () => {
  await cleanup();
  const existing = await membershipsRepository.findActiveForDogMode(db, {
    dogId: FIXTURE_IDS.dog1Id,
    mode: 'school',
  });
  assert.equal(existing, undefined);
});
