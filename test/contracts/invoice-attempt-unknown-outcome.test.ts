import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { invoiceChargeAttemptsRepository } from '../../src/db/repositories/invoiceChargeAttemptsRepository.js';
import { stripeCustomersRepository } from '../../src/db/repositories/stripeCustomersRepository.js';
import {
  fireDuplicateRefundPostCommit,
  settleInvoiceCharge,
} from '../../src/lib/settleInvoiceCharge.js';
import { scheduledNotificationsRepository } from '../../src/db/repositories/scheduledNotificationsRepository.js';
import {
  charges,
  invoiceChargeAttempts,
  invoices,
  notifications,
  paymentMethods,
  refunds,
  scheduledNotifications,
  stripeCustomers,
} from '../../src/db/schema/schema.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { runInvoiceAutoChargeOnce } from '../../src/workers/invoiceAutoCharge.js';
import {
  reissueLooksReplayed,
  runInvoiceAttemptVerifyOnce,
} from '../../src/workers/invoiceAttemptVerify.js';
import { runDuplicateRefundRetryOnce } from '../../src/workers/duplicateRefundRetry.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { enqueueInvoiceOverdueWarnings } from '../../src/lib/enqueueInvoiceOverdueWarnings.js';
import { withActor } from '../../src/db/tx.js';
import { clearInvoiceChargeAttempts, FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * The unknown-outcome protocol (`designs/auto-charge-unknown-outcome.md`).
 *
 * The defect these pins exist for: the auto-charge worker's transport catch —
 * the arm that runs precisely when NOBODY KNOWS whether money moved — used to
 * call `recordFailed`, which incremented `invoices.auto_charge_attempts`, which
 * was the suffix of the Stripe idempotency key, which meant the next tick asked
 * Stripe for NEW money against a charge that may already have succeeded. And
 * when it did succeed, the resulting `payment_intent.succeeded` webhook found no
 * `charges` row, failed the package-metadata parse, and was DROPPED — so the
 * money settled with nothing here knowing, while the owner held a push inviting
 * them to pay again.
 *
 * Two keystone pins, each proven red against pre-fix behavior before being
 * trusted (see the mutation table in the hand-back):
 *   1. the idempotency key does NOT rotate on an unknown outcome, and
 *   2. a parked invoice's orphaned `payment_intent.succeeded` is not dropped.
 */

registerFixtureHooks();

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function cleanup(): Promise<void> {
  await clearInvoiceChargeAttempts();
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
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
          'payment-failed',
          'payment-succeeded',
          'invoice-overdue',
        ]),
      ),
    );
}

async function seedDueInvoice(
  opts: { amountCents?: number; purpose?: 'board-train' | 'payg' | 'group-class' } = {},
): Promise<string> {
  const row = await db.transaction((tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: opts.amountCents ?? 12_000,
      purpose: opts.purpose ?? 'group-class',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: '2026-01-01T00:00:00Z',
      nextAttemptAt: '2026-01-01T00:00:00Z',
    }),
  );
  return row.id;
}

function confirmCalls(stripe: StripeStub) {
  return stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
}

async function readInvoice(id: string) {
  const [row] = await db
    .select({
      status: invoices.status,
      autoChargeAttempts: invoices.autoChargeAttempts,
      nextAttemptAt: invoices.nextAttemptAt,
      paidChargeId: invoices.paidChargeId,
    })
    .from(invoices)
    .where(eq(invoices.id, id));
  return row;
}

/**
 * A FIXED instant to backdate an attempt row to, so every date a park push
 * renders is pinned to a literal instead of to whatever `new Date()` said while
 * the suite ran. 12:00Z on a March day is 06:00 in Chicago — same calendar day
 * either way, so the pin cannot be an accident of the offset.
 *
 * Only `created_at` is movable: `invoice_charge_attempts` carries the
 * `touch_updated_at` trigger, so any UPDATE stamps `updated_at = now()`
 * regardless of what it sets. That is also why every verify pass below is given
 * an injected `now` at least a verify interval past the real clock — the claim
 * query reads the real `updated_at`.
 */
const ATTEMPT_TRIED_AT = '2026-03-02T12:00:00Z';
const ATTEMPT_TRIED_ON = 'Mar 2';

async function backdateAttempt(invoiceId: string, createdAt = ATTEMPT_TRIED_AT): Promise<void> {
  await db
    .update(invoiceChargeAttempts)
    .set({ createdAt })
    .where(eq(invoiceChargeAttempts.invoiceId, invoiceId));
}

async function readAttempt(invoiceId: string) {
  const [row] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
  return row;
}

async function pushBody(dedupeKey: string): Promise<string | undefined> {
  const push = await scheduledNotificationsRepository.findByDedupeKey(db, dedupeKey);
  return push?.body;
}

// ──────────────────────────────────────────────────────────────────────────
// KEYSTONE 1 — the idempotency key does not rotate on an unknown outcome.
// ──────────────────────────────────────────────────────────────────────────

test(
  'KEYSTONE — an unknown outcome keeps its idempotency key: the re-issue replays instead of charging again',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    // The request REACHED Stripe and succeeded there; only the response was
    // lost. This is the case that costs real money if the key rotates.
    stripe.setNextIntentLandsThenThrowsTransport('succeeded');

    const now = new Date();
    const first = await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    assert.equal(first.results[0]?.outcome, 'unknown-outcome-pending');

    // The doubt is ON THE BOOKS, not in a log line.
    const [attempt] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    assert.ok(attempt, 'an attempt row exists — written BEFORE the Stripe call');
    assert.equal(attempt.outcome, 'pending', 'pending IS the honest state for "we do not know"');
    assert.equal(attempt.stripePaymentIntentId, null, 'no PI id was ever learned');

    // Nothing about a failure was recorded: the ladder is untouched and the
    // owner was told nothing (there is nothing true to tell yet).
    const afterFirst = await readInvoice(invoiceId);
    assert.equal(
      afterFirst?.autoChargeAttempts,
      0,
      'an unknown outcome consumes no dunning attempt',
    );
    assert.equal(
      (
        await db
          .select({ id: scheduledNotifications.id })
          .from(scheduledNotifications)
          .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId))
      ).length,
      0,
      'no push while the outcome is unknown',
    );

    // The verify lane re-issues under the RECORDED key.
    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'settled');

    const calls = confirmCalls(stripe);
    assert.equal(calls.length, 2, 'exactly two confirm calls: the original and its re-issue');
    // THE PIN. Pre-fix, these were `auto-charge:<id>:0` and `auto-charge:<id>:1`
    // — two keys, therefore two PaymentIntents, therefore two charges.
    assert.equal(
      calls[1]?.idempotencyKey,
      calls[0]?.idempotencyKey,
      'the re-issue reuses the SAME idempotency key — this is the whole design',
    );
    assert.equal(calls[1]?.idempotencyKey, attempt.idempotencyKey);
    // Metadata is part of Stripe's idempotent request hash, so a mutable
    // counter here would have made even a correct same-key retry fail.
    assert.equal(
      calls[0]?.args.metadata.auto_charge_attempt,
      calls[1]?.args.metadata.auto_charge_attempt,
      'the frozen attempt number rides the metadata, not the mutable ladder count',
    );

    // Exactly ONE charge exists for money that moved once.
    const chargeRows = await db
      .select({ id: charges.id, pi: charges.stripePaymentIntentId })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRows.length, 1, 'one charge for one payment — never two');
    const settled = await readInvoice(invoiceId);
    assert.equal(settled?.status, 'paid');
    const [resolvedAttempt] = await invoiceChargeAttemptsRepository.findAllForInvoice(
      db,
      invoiceId,
    );
    assert.equal(resolvedAttempt?.outcome, 'succeeded');
    await cleanup();
  },
);

test(
  'the charge lane REFUSES to charge while an earlier attempt is unresolved',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();

    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    assert.equal(confirmCalls(stripe).length, 1);

    // Past the lease horizon: the invoice is due again, and the lane sees it.
    const second = await runInvoiceAutoChargeOnce({
      stripe,
      limit: 5,
      now: new Date(now.getTime() + 10 * MINUTE),
    });
    assert.equal(second.scanned, 1, 'the invoice WAS leased — this is a refusal, not invisibility');
    assert.equal(second.results[0]?.outcome, 'skipped-unresolved-attempt');
    assert.equal(
      confirmCalls(stripe).length,
      1,
      'no second charge attempt while the first is in doubt',
    );
    await cleanup();
  },
);

test(
  'the DB refuses a second unresolved attempt for one invoice, even if the code asks for it',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    await withActor('system:stripe-webhook', (tx) =>
      invoiceChargeAttemptsRepository.mint(tx, {
        invoiceId,
        autoChargeAttempts: 0,
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        stripePaymentMethodId: 'pm_fixture_test_visa',
        stripeCustomerId: FIXTURE_IDS.stripeCustomerId,
        amountCents: 12_000,
      }),
    );
    // Ask the DB directly for the thing the worker must never do. The partial
    // unique index — not worker discipline — is what refuses.
    await assert.rejects(
      () =>
        db.insert(invoiceChargeAttempts).values({
          invoiceId,
          attemptNo: 99,
          paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
          stripePaymentMethodId: 'pm_fixture_test_visa',
          stripeCustomerId: FIXTURE_IDS.stripeCustomerId,
          amountCents: 12_000,
          idempotencyKey: `auto-charge:${invoiceId}:99`,
        }),
      (err: { code?: string }) => err.code === '23505',
      'the unresolved partial unique index is the interlock',
    );
    await cleanup();
  },
);

test(
  'the attempt number seeds from the dunning counter, so no in-flight pre-deploy key is collided with or reused',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    // An invoice mid-ladder under the OLD code: three failures recorded, so the
    // next key the old worker would have minted is `auto-charge:<id>:3`.
    await db.update(invoices).set({ autoChargeAttempts: 3 }).where(eq(invoices.id, invoiceId));

    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('requires_payment_method');
    await runInvoiceAutoChargeOnce({ stripe, limit: 5 });

    assert.equal(
      confirmCalls(stripe)[0]?.idempotencyKey,
      `auto-charge:${invoiceId}:3`,
      'byte-identical to the key the old code would have minted next',
    );
    const [attempt] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    assert.equal(attempt?.attemptNo, 3);
    await cleanup();
  },
);

test(
  'a known-dead attempt DOES rotate the key — the ladder is not deleted, only unknowns are protected',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();

    stripe.setNextIntentStatus('requires_payment_method'); // a real decline
    const now = new Date();
    const first = await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    assert.equal(first.results[0]?.outcome, 'failed-retry-scheduled');

    stripe.setNextIntentStatus('requires_payment_method');
    await runInvoiceAutoChargeOnce({
      stripe,
      limit: 5,
      now: new Date(now.getTime() + 10 * MINUTE),
    });

    const calls = confirmCalls(stripe);
    assert.equal(calls.length, 2);
    assert.notEqual(
      calls[1]?.idempotencyKey,
      calls[0]?.idempotencyKey,
      'a genuine retry after a real decline must be a NEW PaymentIntent',
    );
    assert.equal(calls[0]?.idempotencyKey, `auto-charge:${invoiceId}:0`);
    assert.equal(calls[1]?.idempotencyKey, `auto-charge:${invoiceId}:1`);
    const inv = await readInvoice(invoiceId);
    assert.equal(inv?.autoChargeAttempts, 2, 'known failures DO consume dunning attempts');
    await cleanup();
  },
);

test(
  'the re-issue sends the FROZEN params, not freshly-resolved ones',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    // The owner swaps their card mid-doubt. A re-issue that re-resolved the
    // wallet would send different params under a LIVE key — which Stripe
    // rejects, and which is why the params live on the attempt row.
    const swappedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb77';
    await db.insert(paymentMethods).values({
      id: swappedId,
      ownerId: FIXTURE_IDS.ownerId,
      stripePaymentMethodId: 'pm_fixture_swapped_card',
      brand: 'visa',
      last4: '9999',
      expMonth: 12,
      expYear: 2035,
      cardholderName: 'Allison Fixture',
      isDefault: false,
    });
    await db.update(invoices).set({ paymentMethodId: swappedId }).where(eq(invoices.id, invoiceId));

    try {
      await runInvoiceAttemptVerifyOnce({ stripe, now: new Date(now.getTime() + 20 * MINUTE) });
      const calls = confirmCalls(stripe);
      assert.equal(calls.length, 2);
      assert.equal(
        calls[1]?.args.paymentMethodId,
        calls[0]?.args.paymentMethodId,
        'the re-issue sends the card recorded at mint time',
      );
      assert.equal(calls[1]?.args.paymentMethodId, 'pm_fixture_test_visa');
      assert.equal(calls[1]?.args.amountCents, calls[0]?.args.amountCents);
      assert.equal(
        calls[1]?.args.customerId,
        calls[0]?.args.customerId,
        'the customer is a frozen param too — Stripe hashes it into the request',
      );
    } finally {
      await cleanup();
      await db.delete(paymentMethods).where(eq(paymentMethods.id, swappedId));
    }
  },
);

test(
  'a re-link of the Stripe customer mid-doubt does NOT drift the re-issue off its frozen params',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    const attempt = await readAttempt(invoiceId);
    assert.equal(attempt?.stripeCustomerId, FIXTURE_IDS.stripeCustomerId, 'frozen at mint');

    // Support re-links the owner to a different Stripe customer while the
    // outcome is unknown. Re-reading it at re-issue time changes the request
    // Stripe hashed the key against, which is a rejected key and a permanent
    // park — for a bookkeeping change that has nothing to do with this charge.
    await db
      .update(stripeCustomers)
      .set({ stripeCustomerId: 'cus_relinked_by_support' })
      .where(eq(stripeCustomers.ownerId, FIXTURE_IDS.ownerId));

    try {
      await runInvoiceAttemptVerifyOnce({ stripe, now: new Date(now.getTime() + 20 * MINUTE) });
      const calls = confirmCalls(stripe);
      assert.equal(calls.length, 2);
      assert.equal(
        calls[1]?.args.customerId,
        FIXTURE_IDS.stripeCustomerId,
        'the re-issue sends the customer recorded at mint time, not the live one',
      );
    } finally {
      await db
        .update(stripeCustomers)
        .set({ stripeCustomerId: FIXTURE_IDS.stripeCustomerId })
        .where(eq(stripeCustomers.ownerId, FIXTURE_IDS.ownerId));
      await cleanup();
    }
  },
);

test(
  'a re-issue that EXECUTES instead of replaying is parked, not settled — and the money still lands on the books',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    // Nothing was recorded at Stripe: the create was lost in transit. So the
    // re-issue has nothing to replay and EXECUTES — the benign reading of which
    // is "this simply is attempt N happening". The expensive reading is "the
    // key expired early and we have now charged the card a second time", and
    // from in here the two are the same event.
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(
      verify.results[0]?.outcome,
      'parked-fresh-execution',
      'a confirm Stripe did not REPLAY is never settled on the strength of the window assumption',
    );
    const parked = await readInvoice(invoiceId);
    assert.equal(parked?.status, 'open', 'nothing was settled from a pass that could not tell');
    assert.equal(parked?.nextAttemptAt, null, 'handed to a human');
    assert.equal(parked?.autoChargeAttempts, 0, 'nothing failed, so nothing is counted as failed');
    const attempt = await readAttempt(invoiceId);
    assert.equal(
      attempt?.reconcileReason,
      'fresh-execution',
      'WHY a human is needed is on the row, not only in a log line',
    );
    assert.ok(attempt?.stripePaymentIntentId, 'the id we learned is kept — it is knowledge');
    assert.match(
      (await pushBody(`payment-unconfirmed:${invoiceId}`)) ?? '',
      /please don't pay it again/i,
      'the owner is told we are checking, and never invited to pay again',
    );

    // …and "do not charge twice" must never become "do not charge". The id is
    // on the row now, so the next pass RETRIEVES (a GET moves no money) and the
    // money that did move lands on the books with the promised receipt.
    const second = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 40 * MINUTE),
    });
    assert.equal(second.results[0]?.outcome, 'settled');
    assert.equal((await readInvoice(invoiceId))?.status, 'paid');
    const chargeRows = await db
      .select({ id: charges.id })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRows.length, 1, 'one charge for one payment');
    assert.equal(
      confirmCalls(stripe).length,
      2,
      'the original and its one re-issue — the park sent nothing further to Stripe',
    );
    await cleanup();
  },
);

test('reissueLooksReplayed: the header wins, the clock is the fallback', () => {
  const attempt = { createdAt: '2026-03-02T12:00:00Z' };
  const base = { id: 'pi_x', status: 'succeeded' as const, clientSecret: null, amountCents: 100 };

  assert.equal(
    reissueLooksReplayed({ ...base, replayed: true, createdAt: new Date('2026-03-03T12:00:00Z') }, attempt),
    true,
    'Idempotency-Replayed outranks a creation time that looks fresh',
  );
  assert.equal(
    reissueLooksReplayed({ ...base, replayed: false, createdAt: new Date(attempt.createdAt) }, attempt),
    false,
    'and outranks one that looks replayed — Stripe said it executed',
  );
  // Header unreadable: fall back to when Stripe says the intent was created.
  assert.equal(
    reissueLooksReplayed({ ...base, createdAt: new Date('2026-03-02T12:00:02Z') }, attempt),
    true,
    'two seconds after the attempt row IS the original confirm',
  );
  assert.equal(
    reissueLooksReplayed({ ...base, createdAt: new Date('2026-03-02T12:11:00Z') }, attempt),
    false,
    'eleven minutes later cannot be: a re-issue is a whole verify interval away',
  );
  assert.equal(
    reissueLooksReplayed(base, attempt),
    false,
    'neither signal readable is not the same as a reassuring one',
  );
});

// ──────────────────────────────────────────────────────────────────────────
// The verify lane's other arms.
// ──────────────────────────────────────────────────────────────────────────

test(
  'verify RETRIEVES when the PI id is known: a late success settles and receipts',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel(); // Stripe refuses to stop an in-flight intent
    const now = new Date();
    const tick = await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    assert.equal(tick.results[0]?.outcome, 'in-flight-pending');
    assert.equal(
      (await readInvoice(invoiceId))?.autoChargeAttempts,
      0,
      'nothing declined, so the ladder is untouched',
    );

    // The bank clears it while we were waiting.
    const [attempt] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    assert.ok(attempt?.stripePaymentIntentId);
    stripe.setIntentState(attempt.stripePaymentIntentId, 'succeeded');

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'settled');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'retrievePaymentIntent').length,
      1,
      'a GET, not a charge, is how doubt is resolved when the id is known',
    );
    assert.equal((await readInvoice(invoiceId))?.status, 'paid');
    const receipts = await db
      .select({ body: notifications.body })
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, FIXTURE_IDS.ownerId),
          eq(notifications.type, 'payment-succeeded'),
        ),
      );
    assert.equal(receipts.length, 1, '"if it went through you\'ll get a receipt" — kept');
    await cleanup();
  },
);

test(
  'verify RETRIEVES a terminally dead intent: the ladder advances and the owner hears the real reason',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    // One short of the park cap, so the resolved failure parks it.
    await db.update(invoices).set({ autoChargeAttempts: 3 }).where(eq(invoices.id, invoiceId));
    const [attempt] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    stripe.setIntentState(attempt!.stripePaymentIntentId!, 'requires_payment_method');

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'no-charge');
    const inv = await readInvoice(invoiceId);
    assert.equal(inv?.autoChargeAttempts, 4, 'a KNOWN failure advances the ladder');
    assert.equal(inv?.nextAttemptAt, null, 'parked at MAX');
    const push = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-failed:${invoiceId}`,
    );
    assert.ok(push);
    assert.match(push!.body, /your card was declined/i);
    assert.equal(
      push!.deepLinkPath,
      `/account/invoices?invoiceId=${invoiceId}&reason=payment-failed`,
    );
    const [resolved] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    assert.equal(resolved?.outcome, 'no-charge');
    await cleanup();
  },
);

test(
  'verify PARKS an intent stuck processing past the cap, and the push does not invite a retry',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 20_000, purpose: 'board-train' });
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 25 * HOUR),
    });
    assert.equal(verify.results[0]?.outcome, 'parked-in-flight');

    const inv = await readInvoice(invoiceId);
    assert.equal(inv?.nextAttemptAt, null, 'parked onto the staff worklist');
    assert.equal(inv?.autoChargeAttempts, 0, 'nothing failed, so nothing is counted as a failure');

    const push = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-unconfirmed:${invoiceId}`,
    );
    assert.ok(push, 'the owner is told, under the unconfirmed dedupe key');
    assert.equal(push!.title, 'Payment still processing');
    assert.match(push!.body, /\$200/, 'names the amount');
    assert.match(push!.body, /still processing with your bank/i);
    assert.match(push!.body, /please don't pay it again/i, 'NEVER invites a second payment');
    assert.doesNotMatch(push!.body, /didn't go through/i, 'does not assert an outcome we lack');
    assert.doesNotMatch(push!.body, /another card/i, 'no retry invitation of any kind');
    assert.equal(
      push!.deepLinkPath,
      `/account/invoices?invoiceId=${invoiceId}&reason=payment-unconfirmed`,
      'wire 1.10.0: the sheet opens under the framing the push used',
    );
    await cleanup();
  },
);

test(
  'verify PARKS a pending attempt past the idempotency-key window — and re-issues NOTHING',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    assert.equal(confirmCalls(stripe).length, 1);

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 21 * HOUR),
    });
    assert.equal(verify.results[0]?.outcome, 'parked-unconfirmed');
    assert.equal(
      confirmCalls(stripe).length,
      1,
      'past the key window a re-issue could EXECUTE a second time — so it never happens',
    );

    const inv = await readInvoice(invoiceId);
    assert.equal(inv?.nextAttemptAt, null, 'handed to a human');
    assert.equal(inv?.autoChargeAttempts, 0, 'we still do not know it failed');
    const [attempt] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    assert.equal(attempt?.outcome, 'pending', 'inventing a terminal outcome would be a lie');

    const push = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-unconfirmed:${invoiceId}`,
    );
    assert.ok(push);
    assert.equal(push!.title, "We're checking your payment");
    assert.match(push!.body, /can't yet confirm whether it went through/i);
    assert.match(push!.body, /please don't pay it again/i);
    assert.match(push!.body, /you'll get a receipt/i, 'names the promise the settle path keeps');
    assert.doesNotMatch(push!.body, /another card/i);
    await cleanup();
  },
);

test(
  'the verify loop terminates: an attempt at the pass cap is never claimed again',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    // Drive the row to the hard bound the claim query enforces.
    await db
      .update(invoiceChargeAttempts)
      .set({ verifyCount: 200, updatedAt: sql`now() - interval '1 day'` })
      .where(eq(invoiceChargeAttempts.invoiceId, invoiceId));

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 30 * HOUR),
    });
    assert.equal(verify.scanned, 0, 'the row has left the worklist for good');
    assert.equal(confirmCalls(stripe).length, 1, 'and nothing further is sent to Stripe');
    await cleanup();
  },
);

test(
  'an unconfirmed-parked invoice is NOT nagged by the overdue safety net',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    await runInvoiceAttemptVerifyOnce({ stripe, now: new Date(now.getTime() + 21 * HOUR) });
    assert.ok(
      await scheduledNotificationsRepository.findByDedupeKey(
        db,
        `payment-unconfirmed:${invoiceId}`,
      ),
    );

    // The invoice is long past due, which is exactly when the overdue scan
    // would fire — and its copy ("check the card on file") is the opposite
    // advice to the one the owner was just given.
    const result = await withActor('system:scheduler', (tx) =>
      enqueueInvoiceOverdueWarnings(tx, new Date(now.getTime() + 30 * 24 * HOUR)),
    );
    const nagged = result.scanned > 0;
    assert.equal(nagged, false, 'an unknown outcome must not be nagged into a second payment');
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(db, `invoice-overdue:${invoiceId}`),
      undefined,
    );
    await cleanup();
  },
);

test(
  'the no-card park says nothing has been charged — because nothing was tried',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    await db
      .update(paymentMethods)
      .set({ expMonth: 1, expYear: 2020 })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    const stripe = makeStripeStub();
    try {
      const tick = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
      assert.equal(tick.results[0]?.outcome, 'skipped-pm-missing');
      assert.equal(confirmCalls(stripe).length, 0, 'ZERO Stripe calls on this path');

      const push = await scheduledNotificationsRepository.findByDedupeKey(
        db,
        `payment-failed:${invoiceId}`,
      );
      assert.ok(push);
      assert.match(push!.body, /there's no card on file we can charge/i);
      assert.match(push!.body, /nothing has been charged/i);
      assert.match(push!.body, /add a card in the app/i);
      // The sentence this arm used to send was flatly false.
      assert.doesNotMatch(push!.body, /we tried your/i, 'never claim we tried when we did not');
    } finally {
      await cleanup();
      await db
        .update(paymentMethods)
        .set({ expMonth: 12, expYear: 2030 })
        .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// The re-issue is a CHARGE, so it owes every guard a charge owes.
// ──────────────────────────────────────────────────────────────────────────

test(
  'verify REFUSES to re-issue once the owner has paid in person — the re-issue is a charge, not a lookup',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    // Never reached Stripe: attempt pending, no PI id, so the verify lane's
    // only move is the re-issue — the one that EXECUTES when there is nothing
    // to replay.
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    // The owner hears nothing and hands over cash at drop-off. This flips
    // `payment_expected`; its guard has never considered attempt rows.
    const flipped = await withActor('system:staff', (tx) =>
      invoicesRepository.markPayInPerson(tx, { id: invoiceId }),
    );
    assert.equal(flipped, 1);

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'skipped-not-chargeable');
    assert.equal(
      confirmCalls(stripe).length,
      1,
      'R3: a cash/check invoice is never auto-charged — not even by a "verify"',
    );
    assert.equal(
      (
        await db
          .select({ id: charges.id })
          .from(charges)
          .where(eq(charges.ownerId, FIXTURE_IDS.ownerId))
      ).length,
      0,
      'nobody paid twice',
    );
    const attempt = await readAttempt(invoiceId);
    assert.equal(attempt?.outcome, 'pending', 'the original is still unknown; the webhook owns it');
    await cleanup();
  },
);

test(
  'verify REFUSES to re-issue against a voided invoice',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    // The enrollment is withdrawn while the outcome is unknown.
    await withActor('system:staff', (tx) => invoicesRepository.markVoid(tx, { id: invoiceId }));

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'skipped-not-chargeable');
    assert.equal(confirmCalls(stripe).length, 1, 'no fresh charge for a debt that no longer exists');
    assert.equal((await readInvoice(invoiceId))?.status, 'void');
    await cleanup();
  },
);

test(
  'a transient 409 on the recorded key is STILL UNKNOWN, not a permanent park',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    // Stripe's OTHER `idempotency_error`: HTTP 409, "another request is
    // currently using this Idempotency Key". Two of our own overlapping ticks,
    // saying nothing whatever about our bookkeeping.
    stripe.setNextIntentThrowsTransport(
      new Stripe.errors.StripeIdempotencyError({
        type: 'idempotency_error',
        code: 'idempotency_error',
        statusCode: 409,
        message:
          'There is currently another in-progress request using this Idempotency Key.',
      } as never),
    );

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'still-unknown');

    const inv = await readInvoice(invoiceId);
    assert.notEqual(inv?.nextAttemptAt, null, 'a healthy invoice is NOT parked over a race');
    const attempt = await readAttempt(invoiceId);
    assert.equal(attempt?.outcome, 'pending', 'still unresolved, exactly as before the call');
    assert.equal(attempt?.reconcileReason, null, 'no human is needed for a concurrency blip');
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(
        db,
        `payment-unconfirmed:${invoiceId}`,
      ),
      undefined,
      'and the owner is told nothing, because nothing has changed',
    );
    await cleanup();
  },
);

test(
  'a key rejected for DIFFERENT params parks for a human and never mints a fresh key',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 12_000, purpose: 'group-class' });
    const stripe = makeStripeStub();
    // The request LANDED (Stripe holds the key with its params) and only the
    // response was lost.
    stripe.setNextIntentLandsThenThrowsTransport('succeeded');
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    // Corrupt the frozen params — the invariant violation this arm exists for.
    // (By construction unreachable: the row is the only source of these.)
    await db
      .update(invoiceChargeAttempts)
      .set({ amountCents: 999 })
      .where(eq(invoiceChargeAttempts.invoiceId, invoiceId));

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'parked-idempotency-conflict');

    const inv = await readInvoice(invoiceId);
    assert.equal(inv?.nextAttemptAt, null, 'parked');
    assert.equal(inv?.status, 'open', 'nothing was settled on a disagreement');
    assert.equal(inv?.autoChargeAttempts, 0, 'a disagreement is not a decline');
    const attempt = await readAttempt(invoiceId);
    assert.equal(
      attempt?.reconcileReason,
      'idempotency-conflict',
      'the fact a reconciling human most needs is on the row',
    );
    assert.equal(attempt?.outcome, 'pending', 'inventing a terminal outcome would be a lie');
    assert.equal(
      confirmCalls(stripe).length,
      2,
      'the rejected re-issue is the LAST call — a fresh key is how one debt becomes two charges',
    );
    assert.ok(await pushBody(`payment-unconfirmed:${invoiceId}`));
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Every push names WHEN the charge was tried (Allison, 2026-08-01).
// ──────────────────────────────────────────────────────────────────────────

test(
  'the unconfirmed park names the day the charge was TRIED, not the day we gave up',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    await backdateAttempt(invoiceId);

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'parked-unconfirmed');

    const body = (await pushBody(`payment-unconfirmed:${invoiceId}`)) ?? '';
    assert.match(body, /We started your \$45 payment/);
    assert.match(
      body,
      new RegExp(`on ${ATTEMPT_TRIED_ON},`),
      'the attempt row\'s own date — the park date is 20h+ later and would be a different day',
    );
    await cleanup();
  },
);

test(
  'the in-flight park names the day the payment STARTED, which is never the day the cap expires',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 20_000, purpose: 'board-train' });
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    await backdateAttempt(invoiceId);

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'parked-in-flight');
    const body = (await pushBody(`payment-unconfirmed:${invoiceId}`)) ?? '';
    assert.match(body, new RegExp(`started on ${ATTEMPT_TRIED_ON} and is still processing`));
    await cleanup();
  },
);

test(
  'the no-card park names the day the invoice fell DUE, in Chicago',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    await db
      .update(paymentMethods)
      .set({ expMonth: 1, expYear: 2020 })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    const stripe = makeStripeStub();
    try {
      await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
      const body = (await pushBody(`payment-failed:${invoiceId}`)) ?? '';
      // due_at is 2026-01-01T00:00:00Z — which is Dec 31 in Chicago, and the
      // reason this arm cannot be allowed to render "today" instead.
      assert.match(body, /was due Dec 31,/);
    } finally {
      await cleanup();
      await db
        .update(paymentMethods)
        .set({ expMonth: 12, expYear: 2030 })
        .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// The verify lane's known-dead arm: arbitration, R15, and the park it must keep.
// ──────────────────────────────────────────────────────────────────────────

test(
  'losing the resolve race costs NOTHING — one decline never consumes two rungs of the ladder',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    const attempt = await readAttempt(invoiceId);
    stripe.setIntentState(attempt!.stripePaymentIntentId!, 'requires_payment_method');

    // The webhook lands while our retrieve is in flight — the ONE await where a
    // concurrent write can beat us — and resolves the attempt itself.
    const racing = {
      ...stripe,
      async retrievePaymentIntent(id: string) {
        await withActor('system:stripe-webhook', (tx) =>
          invoiceChargeAttemptsRepository.resolve(tx, { id: attempt!.id, outcome: 'no-charge' }),
        );
        return stripe.retrievePaymentIntent(id);
      },
    };

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe: racing,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'lost-resolve-race');
    const inv = await readInvoice(invoiceId);
    assert.equal(
      inv?.autoChargeAttempts,
      0,
      'the winner owns the consequences; the loser must do nothing at all',
    );
    await cleanup();
  },
);

test(
  'a known-dead intent is CANCELLED before the invoice is freed for a fresh key (R15)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel(); // the charge lane's own cancel is refused
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    const attempt = await readAttempt(invoiceId);
    const piId = attempt!.stripePaymentIntentId!;
    // `requires_action` is the dangerous one: a LIVE, still-confirmable intent.
    stripe.setIntentState(piId, 'requires_action');

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'no-charge');
    const cancels = stripe.calls.filter(
      (c) => c.method === 'cancelPaymentIntent' && c.args.paymentIntentId === piId,
    );
    assert.equal(
      cancels.length,
      2,
      'the charge lane tried and was refused; the verify lane must try again before rotating the key',
    );
    await cleanup();
  },
);

test(
  'resolving a known-dead attempt on a PARKED invoice keeps the park and answers the owner',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    await backdateAttempt(invoiceId);

    // Pass 1: in flight past the cap → parked, owner told "still processing".
    const first = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(first.results[0]?.outcome, 'parked-in-flight');
    assert.equal((await readInvoice(invoiceId))?.nextAttemptAt, null);

    // The bank declines it a day later.
    const attempt = await readAttempt(invoiceId);
    stripe.setIntentState(attempt!.stripePaymentIntentId!, 'requires_payment_method', {
      failureCode: 'card_declined',
    });
    const second = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 40 * MINUTE),
    });
    assert.equal(second.results[0]?.outcome, 'no-charge');

    const inv = await readInvoice(invoiceId);
    assert.equal(
      inv?.nextAttemptAt,
      null,
      'an invoice a human was told to look at is never silently un-parked',
    );
    assert.equal(
      inv?.autoChargeAttempts,
      0,
      'and auto-charge does not resume against a card whose owner was just told "we will let you know"',
    );
    const body = (await pushBody(`payment-failed:${invoiceId}`)) ?? '';
    assert.match(body, /your card was declined/i, 'the now-known answer does reach the owner');
    assert.match(
      body,
      new RegExp(`on ${ATTEMPT_TRIED_ON} and`),
      'dated when it was tried, not when the answer arrived',
    );
    assert.ok(
      await pushBody(`payment-unconfirmed:${invoiceId}`),
      'and the earlier "still processing" push stands — two truths, two dedupe keys',
    );
    await cleanup();
  },
);

test(
  'the retrieve fork reads last_payment_error.code: an auth failure is not reported as a decline',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    // One short of the cap so the resolved failure parks and speaks.
    await db.update(invoices).set({ autoChargeAttempts: 3 }).where(eq(invoices.id, invoiceId));
    const attempt = await readAttempt(invoiceId);
    // The status alone says `requires_payment_method` — which reads "declined".
    // Only the CODE can say the card needed verification.
    stripe.setIntentState(attempt!.stripePaymentIntentId!, 'requires_payment_method', {
      failureCode: 'authentication_required',
    });

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'no-charge');
    const body = (await pushBody(`payment-failed:${invoiceId}`)) ?? '';
    assert.match(body, /needs verification we can't complete automatically/i);
    assert.doesNotMatch(body, /was declined/i, 'the status-default sentence would have been wrong');
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// The waiting arms — the two outcomes nothing used to execute.
// ──────────────────────────────────────────────────────────────────────────

test(
  'an intent still processing UNDER the cap is waited on, not acted on',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'still-processing');
    const inv = await readInvoice(invoiceId);
    assert.notEqual(inv?.nextAttemptAt, null, 'waiting is not parking');
    assert.equal(inv?.autoChargeAttempts, 0, 'and waiting is certainly not failing');
    assert.equal((await readAttempt(invoiceId))?.outcome, 'processing');
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(
        db,
        `payment-unconfirmed:${invoiceId}`,
      ),
      undefined,
      'nothing is said to the owner while the money is simply in flight',
    );
    await cleanup();
  },
);

test(
  'a re-issue that replays an IN-FLIGHT original records the id and keeps waiting',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    // It landed at Stripe as `processing`; only the response was lost.
    stripe.setNextIntentLandsThenThrowsTransport('processing');
    const now = new Date();
    const tick = await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    assert.equal(tick.results[0]?.outcome, 'unknown-outcome-pending');
    assert.equal((await readAttempt(invoiceId))?.stripePaymentIntentId, null);

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'reissued-in-flight');
    const attempt = await readAttempt(invoiceId);
    assert.equal(attempt?.outcome, 'processing');
    assert.ok(attempt?.stripePaymentIntentId, 'the replay taught us the id we never received');
    const inv = await readInvoice(invoiceId);
    assert.equal(inv?.autoChargeAttempts, 0);
    assert.notEqual(inv?.nextAttemptAt, null, 'in flight is not parked');
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// The park must not talk over an owner who already paid.
// ──────────────────────────────────────────────────────────────────────────

test(
  'an owner who paid during the doubt window is NOT told "we can\'t confirm your payment"',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 12_000, purpose: 'group-class' });
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    await backdateAttempt(invoiceId);

    // They pay it themselves and hold the receipt.
    const invoice = await invoicesRepository.findById(db, invoiceId);
    await withActor('system:stripe-webhook', (tx) =>
      settleInvoiceCharge(tx, {
        invoice: invoice!,
        paymentIntentId: `pi_test_manual_${randomUUID().slice(0, 8)}`,
        amountCents: 12_000,
        purpose: 'group-class',
        notifyOwner: true,
        now,
      }),
    );

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(
      verify.results[0]?.outcome,
      'skipped-not-chargeable',
      'round 3: the "does this invoice still want a card charge?" question is asked BEFORE the window arm, so a paid invoice never reaches the park at all',
    );
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(
        db,
        `payment-unconfirmed:${invoiceId}`,
      ),
      undefined,
      '"please don\'t pay it again" to someone holding a receipt is not a service',
    );
    assert.equal((await readInvoice(invoiceId))?.status, 'paid', 'their payment stands');
    assert.equal(
      (await readAttempt(invoiceId))?.reconcileReason,
      'key-window-expired',
      'the unresolved attempt still carries why automation stopped',
    );
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// The interlock firing is a REFUSAL, not an outage.
// ──────────────────────────────────────────────────────────────────────────

test(
  'a concurrent worker winning the mint race is a refusal — the tick carries on',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const stripe = makeStripeStub();
    const original = stripeCustomersRepository.findByOwner;
    // Land an unresolved attempt in the window between the charge lane's
    // refusal check and its INSERT — exactly what a second worker on the same
    // lease does. The partial unique index then refuses the mint.
    stripeCustomersRepository.findByOwner = async (runner, ownerId) => {
      await db.insert(invoiceChargeAttempts).values({
        invoiceId,
        attemptNo: 77,
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        stripePaymentMethodId: 'pm_fixture_test_visa',
        stripeCustomerId: FIXTURE_IDS.stripeCustomerId,
        amountCents: 12_000,
        idempotencyKey: `auto-charge:${invoiceId}:77`,
      });
      stripeCustomersRepository.findByOwner = original;
      return original(runner, ownerId);
    };

    try {
      const tick = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
      assert.equal(
        tick.results[0]?.outcome,
        'skipped-unresolved-attempt',
        'the interlock doing its job means "do not charge" — it is not an exception',
      );
      assert.equal(confirmCalls(stripe).length, 0, 'and above all: no second charge');
    } finally {
      stripeCustomersRepository.findByOwner = original;
      await cleanup();
    }
  },
);

test(
  'the scheduler survives a charge phase that throws — later phases still run',
  SKIP_WHEN_NO_DB,
  async () => {
    const original = invoicesRepository.leaseDueOpen;
    invoicesRepository.leaseDueOpen = async () => {
      throw new Error('stub: the charge phase exploded');
    };
    try {
      const result = await runSchedulerTickOnce({ expoPush: makeExpoPushStub() });
      assert.equal(result.invoiceAutoCharge.scanned, 0, 'the phase produced nothing');
      assert.ok(
        result.idempotencyKeysSwept >= 0,
        'and the phases AFTER it still ran — one throwing phase must not cost the whole tick',
      );
    } finally {
      invoicesRepository.leaseDueOpen = original;
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// "Do not charge twice" must never quietly become "do not charge" (round 3).
// ──────────────────────────────────────────────────────────────────────────

test(
  'a re-issue that EXECUTES and then DECLINES spends a dunning rung — it does not strand the invoice',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    // The create never reached Stripe, so there is nothing to replay and the
    // re-issue EXECUTES. That is the COMMON reading of a transport failure —
    // the design says so itself — and the card then declines for an ordinary,
    // temporary reason (insufficient funds, a travel block).
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });

    stripe.setNextIntentStatus('requires_payment_method');
    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    // Parking here was the defect: a fresh execution that CAPTURED NOTHING
    // carries no doubt about money, so treating it as one froze the invoice
    // open at rung zero — one blip plus one temporary decline and the card is
    // never asked again.
    assert.equal(
      verify.results[0]?.outcome,
      'no-charge',
      'a fresh execution that captured nothing simply IS attempt N happening',
    );
    const inv = await readInvoice(invoiceId);
    assert.equal(inv?.autoChargeAttempts, 1, 'the ladder advanced: a decline is a decline');
    assert.notEqual(inv?.nextAttemptAt, null, 'and the invoice is rescheduled, not parked');
    const attempt = await readAttempt(invoiceId);
    assert.equal(attempt?.outcome, 'no-charge');
    assert.equal(
      attempt?.reconcileReason,
      'fresh-execution',
      'the human trail survives even where no human is needed',
    );
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(
        db,
        `payment-unconfirmed:${invoiceId}`,
      ),
      undefined,
      'nothing is unconfirmed — Stripe told us the card said no',
    );

    // …and the ladder still leads somewhere: the next rung charges under a
    // FRESH key (the previous attempt is KNOWN-dead now) and settles.
    const second = await runInvoiceAutoChargeOnce({
      stripe,
      limit: 5,
      now: new Date(now.getTime() + 90 * MINUTE),
    });
    assert.equal(second.results[0]?.outcome, 'paid');
    const keys = confirmCalls(stripe).map((c) => c.idempotencyKey);
    assert.equal(keys.length, 3, 'the original, its re-issue, and the next rung');
    assert.equal(keys[0], keys[1], 'the unknown attempt kept its key');
    assert.notEqual(keys[2], keys[1], 'a known-dead one rotates it — the ladder is not deleted');
    assert.equal((await readInvoice(invoiceId))?.status, 'paid');
    await cleanup();
  },
);

test(
  'the key-window park asks FIRST whether the invoice still wants a card charge',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    const flipped = await withActor('system:staff', (tx) =>
      invoicesRepository.markPayInPerson(tx, { id: invoiceId }),
    );
    assert.equal(flipped, 1, 'the owner is bringing cash at drop-off');

    // Past the key window — the arm that parks. `parkForReconciliation` filters
    // only on `status='open'`, which an in-person invoice still is.
    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 21 * HOUR),
    });
    assert.equal(verify.results[0]?.outcome, 'skipped-not-chargeable');
    assert.equal(confirmCalls(stripe).length, 1, 'and nothing was re-issued either');
    const inv = await readInvoice(invoiceId);
    assert.notEqual(
      inv?.nextAttemptAt,
      null,
      'an in-person invoice is awaiting a drop-off payment, not stuck on a staff worklist',
    );
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(
        db,
        `payment-unconfirmed:${invoiceId}`,
      ),
      undefined,
      '"please don\'t pay it again" is the opposite of the advice this owner was given',
    );
    const attempt = await readAttempt(invoiceId);
    assert.equal(attempt?.outcome, 'pending', 'the original is still unknown; the webhook owns it');
    assert.equal(
      attempt?.reconcileReason,
      'key-window-expired',
      'the TRAIL is still stamped — automation really has stopped for this attempt. What the not-chargeable arm withholds is the PARK and the PUSH, not the record a reconciling human reads',
    );
    await cleanup();
  },
);

test(
  'the charge lane does not push a decline at an owner who paid during the Stripe round-trip',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    // One rung left, so the next known failure PARKS and speaks — the sentence
    // that must never reach someone holding a receipt.
    await db.update(invoices).set({ autoChargeAttempts: 3 }).where(eq(invoices.id, invoiceId));

    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('requires_payment_method');
    const confirm = stripe.createAndConfirmPaymentIntent.bind(stripe);
    stripe.createAndConfirmPaymentIntent = async (args, key) => {
      // The window the charge lane's pre-charge re-check cannot cover: the
      // owner pays it themselves WHILE we are inside the Stripe round-trip.
      const invoice = await invoicesRepository.findById(db, invoiceId);
      await withActor('system:stripe-webhook', (tx) =>
        settleInvoiceCharge(tx, {
          invoice: invoice!,
          paymentIntentId: `pi_test_manual_${randomUUID().slice(0, 8)}`,
          amountCents: 4500,
          purpose: 'payg',
          notifyOwner: false,
        }),
      );
      stripe.createAndConfirmPaymentIntent = confirm;
      return confirm(args, key);
    };

    const tick = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
    assert.equal(
      tick.results[0]?.outcome,
      'skipped-already-settled',
      'the record write is filtered on the invoice still being open, and says so',
    );
    const inv = await readInvoice(invoiceId);
    assert.equal(inv?.status, 'paid', 'their payment stands');
    assert.equal(inv?.autoChargeAttempts, 3, 'a settled invoice does not spend a dunning rung');
    assert.equal(
      await scheduledNotificationsRepository.findByDedupeKey(db, `payment-failed:${invoiceId}`),
      undefined,
      '"want to try a different form of payment?" to someone holding a receipt is not a service',
    );
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// R15 and the batch: one attempt's failure is one attempt's failure.
// ──────────────────────────────────────────────────────────────────────────

test(
  'the dead PaymentIntent is cancelled BEFORE the interlock opens',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel(); // Stripe refuses to stop it: the attempt stays in flight
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    const inFlight = await readAttempt(invoiceId);
    assert.ok(inFlight?.stripePaymentIntentId);
    // The bank declines it later; the retrieve arm will find it terminally dead.
    stripe.setIntentState(inFlight.stripePaymentIntentId, 'requires_payment_method', {
      failureCode: 'card_declined',
    });

    // `resolve` is what OPENS the interlock — the moment the attempt stops
    // being unresolved, the charge lane may mint attempt N+1 under a FRESH key.
    // So R15's cancel must already have happened, exactly as it does in the
    // charge lane (cancel, then resolve). Read the attempt's outcome at the
    // instant of the cancel and that ordering is observable.
    const seenAtCancel: (string | undefined)[] = [];
    const cancel = stripe.cancelPaymentIntent.bind(stripe);
    stripe.cancelPaymentIntent = async (id) => {
      seenAtCancel.push((await readAttempt(invoiceId))?.outcome);
      return cancel(id);
    };

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.results[0]?.outcome, 'no-charge');
    assert.equal(
      seenAtCancel.at(-1),
      'processing',
      'the attempt was still UNRESOLVED when the cancel went out — a live intent must not outlive the interlock that keeps a second key from existing',
    );
    assert.equal((await readAttempt(invoiceId))?.outcome, 'no-charge');
    await cleanup();
  },
);

test(
  'one attempt that throws does not cost the rest of the claimed batch',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const poisonedInvoice = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    const poisoned = await readAttempt(poisonedInvoice);

    const healthyInvoice = await seedDueInvoice({ amountCents: 7700, purpose: 'group-class' });
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    const healthy = await invoiceChargeAttemptsRepository.findAllForInvoice(db, healthyInvoice);
    assert.ok(poisoned?.stripePaymentIntentId && healthy[0]?.stripePaymentIntentId);
    stripe.setIntentState(healthy[0].stripePaymentIntentId, 'succeeded');

    // A synthetic thrower standing in for the real classes (a `charges`
    // unique-violation race, a DB blip mid-settle): a retrieved intent whose
    // amount Postgres refuses. The point under test is the BOUNDARY, not the
    // cause — before it, `claimUnresolvedForVerify` had already burned a verify
    // pass off every row in the batch, and since it orders `updated_at ASC` the
    // thrower re-poisoned every following batch too.
    const retrieve = stripe.retrievePaymentIntent.bind(stripe);
    stripe.retrievePaymentIntent = async (id) => {
      const intent = await retrieve(id);
      if (id !== poisoned.stripePaymentIntentId) return intent;
      return { ...intent, status: 'succeeded', amountCents: Number.NaN };
    };

    const verify = await runInvoiceAttemptVerifyOnce({
      stripe,
      now: new Date(now.getTime() + 20 * MINUTE),
    });
    assert.equal(verify.scanned, 2, 'both attempts were worked');
    const byInvoice = new Map(verify.results.map((r) => [r.invoiceId, r.outcome]));
    assert.equal(byInvoice.get(poisonedInvoice), 'errored', 'the thrower is isolated and logged');
    assert.equal(
      byInvoice.get(healthyInvoice),
      'settled',
      'and the attempt behind it is still resolved — money that moved lands on the books',
    );
    assert.equal((await readInvoice(healthyInvoice))?.status, 'paid');
    assert.equal(
      (await readAttempt(poisonedInvoice))?.outcome,
      'processing',
      'nothing was resolved for the one that threw; it is examined again next pass',
    );
    await cleanup();
  },
);

test(
  'losing the charges INSERT race is the flip arm, not an error',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('processing');
    stripe.throwOnCancel();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    const attempt = await readAttempt(invoiceId);
    assert.ok(attempt?.stripePaymentIntentId);
    stripe.setIntentState(attempt.stripePaymentIntentId, 'succeeded');

    // The race, reproduced by its POST-CONDITIONS rather than by timing: the
    // webhook's `charges` INSERT commits between this lane's "is it already on
    // the books?" read and its own INSERT, so the row exists AND our insert
    // raises 23505 on the unique `stripe_payment_intent_id`. Staged
    // deterministically because the timing window is sub-millisecond; what is
    // under test is the RESPONSE, which must be "the other path won", never a
    // throw out of the batch.
    const create = chargesRepository.create;
    chargesRepository.create = async (_tx, args) => {
      chargesRepository.create = create;
      await db.insert(charges).values({
        ownerId: args.ownerId,
        amountCents: args.amountCents,
        status: 'succeeded',
        purpose: args.purpose,
        stripePaymentIntentId: args.stripePaymentIntentId,
      });
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'charges_stripe_payment_intent_id_key',
      });
    };

    try {
      const verify = await runInvoiceAttemptVerifyOnce({
        stripe,
        now: new Date(now.getTime() + 20 * MINUTE),
      });
      assert.equal(
        verify.results[0]?.outcome,
        'settled',
        'the money IS on the books — that another path put it there is not an error',
      );
      assert.equal(
        (await readAttempt(invoiceId))?.outcome,
        'succeeded',
        'and the doubt is closed rather than left to churn',
      );
      const chargeRows = await db
        .select({ id: charges.id })
        .from(charges)
        .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
      assert.equal(chargeRows.length, 1, 'one charge for one payment');
    } finally {
      chargesRepository.create = create;
      await cleanup();
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// The refund that failed to fire is retried — "left for retry" made true.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stage the exact state a failed lost-race refund leaves behind: the invoice
 * settled by one path, a SECOND succeeded charge for the same debt, a 'pending'
 * `refunds` row for it, and a `createRefund` that threw — so nothing at Stripe
 * knows the money should come back. This is the production path verbatim
 * (`settleInvoiceCharge` + `fireDuplicateRefundPostCommit`), not a lookalike.
 */
async function stageFailedDuplicateRefund(
  invoiceId: string,
  amountCents: number,
): Promise<{ refundId: string; failedKey: string; stripe: StripeStub }> {
  const stripe = makeStripeStub();
  const settled = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
  assert.equal(settled.results[0]?.outcome, 'paid');

  const invoice = await invoicesRepository.findById(db, invoiceId);
  const duplicate = await withActor('system:stripe-webhook', (tx) =>
    settleInvoiceCharge(tx, {
      invoice: invoice!,
      paymentIntentId: `pi_test_dup_${randomUUID().slice(0, 8)}`,
      amountCents,
      purpose: 'group-class',
      notifyOwner: false,
    }),
  );
  assert.equal(duplicate.outcome, 'refunded');
  const pending = duplicate.outcome === 'refunded' ? duplicate.pendingStripeRefund : undefined;
  assert.ok(pending);

  stripe.throwOnRefund();
  await fireDuplicateRefundPostCommit({
    pending,
    stripe,
    log: { error: () => undefined },
    context: {},
  });
  const failed = stripe.calls.filter((c) => c.method === 'createRefund');
  assert.equal(failed.length, 1, 'the post-commit fire was attempted and threw');
  const [row] = await db.select().from(refunds).where(eq(refunds.id, pending.refundId));
  assert.equal(row?.status, 'pending');
  assert.equal(row?.stripeRefundId, null, 'nothing at Stripe knows about this refund yet');
  return { refundId: pending.refundId, failedKey: failed[0]!.idempotencyKey, stripe };
}

test(
  'a lost-race refund whose Stripe call failed is retried under the SAME key',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 12_000, purpose: 'group-class' });
    const { refundId, failedKey } = await stageFailedDuplicateRefund(invoiceId, 12_000);

    // Before this sweep existed nothing retried these rows — no worker imported
    // `refundsRepository`, and `charge.refund.updated` cannot arrive for a
    // refund that was never created. The owner stayed double-charged forever.
    const sweeper = makeStripeStub();
    const now = new Date(Date.now() + 10 * MINUTE);
    const tick = await runDuplicateRefundRetryOnce({ stripe: sweeper, now });
    assert.equal(tick.scanned, 1);
    assert.equal(tick.sent, 1);
    assert.equal(tick.abandoned, 0);

    const retried = sweeper.calls.filter((c) => c.method === 'createRefund');
    assert.equal(retried.length, 1);
    assert.equal(
      retried[0]?.idempotencyKey,
      failedKey,
      'the SAME key as the failed attempt — a retry that minted a new one could refund twice',
    );
    assert.equal(retried[0]?.idempotencyKey, `dup-settle-refund:${refundId}`);
    assert.equal(
      retried[0]?.method === 'createRefund' ? retried[0].args.amountCents : undefined,
      12_000,
      'the whole duplicate goes back',
    );

    const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId));
    assert.ok(row?.stripeRefundId, 'the re_* id is persisted so the webhook can match it');

    // And the row leaves the worklist: a sent refund is not swept again.
    const second = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: new Date(now.getTime() + 30 * MINUTE),
    });
    assert.equal(second.scanned, 0);
    assert.equal(sweeper.calls.filter((c) => c.method === 'createRefund').length, 1);
    await cleanup();
  },
);

test(
  'a refund past the idempotency-key window is abandoned LOUDLY, never re-fired',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 12_000, purpose: 'group-class' });
    const { refundId } = await stageFailedDuplicateRefund(invoiceId, 12_000);
    // Older than Stripe keeps a key: a same-key call is no longer guaranteed to
    // REPLAY, and sending a second refund is not the safe direction either.
    await db
      .update(refunds)
      .set({ createdAt: sql`now() - interval '30 hours'` })
      .where(eq(refunds.id, refundId));

    const errors: Record<string, unknown>[] = [];
    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: new Date(Date.now() + 10 * MINUTE),
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (obj) => errors.push(obj),
      },
    });
    assert.equal(tick.scanned, 0, 'past the window it is not retried');
    assert.equal(tick.abandoned, 1);
    assert.equal(
      sweeper.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'and nothing was sent to Stripe on a key it may have forgotten',
    );
    // Loud, and it stays loud: this is owed money no automatic path will return.
    const abandoned = errors.find((e) => e.abandonedCount === 1);
    assert.ok(abandoned, 'the sweep reports abandonment at ERROR level');
    assert.match(JSON.stringify(abandoned.refunds), new RegExp(refundId));
    await cleanup();
  },
);

test(
  'the sweep refuses refunds whose original key it cannot reproduce',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await seedDueInvoice({ amountCents: 12_000, purpose: 'group-class' });
    const stripe = makeStripeStub();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
    const [charge] = await db
      .select({ id: charges.id })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.ok(charge);

    // A cancel/withdraw refund: same shape, same "pending with no re_* id"
    // state — but its post-commit call was keyed on the CLIENT's request
    // idempotency key (`${idempotencyKey}:refund`), which nothing durable can
    // reconstruct. Re-firing it under a row-derived key would not replay that
    // request; it would send a SECOND refund. So the sweep must leave it alone.
    const [orphanKeyed] = await db
      .insert(refunds)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: charge.id,
        bookingId: null,
        amountCents: 5_000,
        reason: 'cancel',
      })
      .returning({ id: refunds.id });
    assert.ok(orphanKeyed);

    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: new Date(Date.now() + 10 * MINUTE),
    });
    assert.equal(tick.scanned, 0, 'not this sweep’s row to retry');
    assert.equal(
      sweeper.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'a retry under a key Stripe never saw is how one refund becomes two',
    );
    const [row] = await db.select().from(refunds).where(eq(refunds.id, orphanKeyed.id));
    assert.equal(row?.stripeRefundId, null, 'untouched');
    await cleanup();
  },
);

test(
  'the scheduler tick runs the refund retry sweep',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 12_000, purpose: 'group-class' });
    const { refundId } = await stageFailedDuplicateRefund(invoiceId, 12_000);

    const sweeper = makeStripeStub();
    const result = await runSchedulerTickOnce({
      expoPush: makeExpoPushStub(),
      stripe: sweeper,
      now: new Date(Date.now() + 10 * MINUTE),
    });
    assert.equal(
      result.duplicateRefundRetry.sent,
      1,
      'a phase nobody composed into the tick would be a phase that never runs',
    );
    const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId));
    assert.ok(row?.stripeRefundId);
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// KEYSTONE 2 — the webhook no longer drops an orphaned invoice charge.
// ──────────────────────────────────────────────────────────────────────────

function buildWebhookApp(): { app: ReturnType<typeof makeContractApp>['app']; stripe: StripeStub } {
  const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerStripeWebhookRoute(app, { stripe });
  return { app, stripe };
}

async function postWebhook(
  app: ReturnType<typeof makeContractApp>['app'],
): Promise<{ statusCode: number; outcome: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'stripe-signature': 't=1,v1=fake' },
    payload: { hello: 'world' },
  });
  return { statusCode: res.statusCode, outcome: (res.json() as { outcome: string }).outcome };
}

test(
  "KEYSTONE — a PARKED invoice's orphaned payment_intent.succeeded settles instead of being dropped",
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 12_000, purpose: 'group-class' });
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    // Past the key window → parked for a human, `next_attempt_at = NULL`. The
    // old comment claimed these "self-heal via the worker's next tick"; a
    // parked invoice can never be leased again, so nothing would have.
    await runInvoiceAttemptVerifyOnce({ stripe, now: new Date(now.getTime() + 21 * HOUR) });
    assert.equal((await readInvoice(invoiceId))?.nextAttemptAt, null, 'parked');

    const [attempt] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    const { app, stripe: webhookStripe } = buildWebhookApp();
    const orphanPi = `pi_test_orphan_${randomUUID().slice(0, 8)}`;
    webhookStripe.setNextEvent({
      id: `evt_test_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: orphanPi,
      amountCents: 12_000,
      metadata: {
        owner_id: FIXTURE_IDS.ownerId,
        invoice_id: invoiceId,
        purpose: 'group-class',
        auto_charge_attempt: String(attempt!.attemptNo),
      },
    });
    const res = await postWebhook(app);
    assert.equal(res.statusCode, 200);
    // Pre-fix this was `orphan-event` and the invoice stayed open forever.
    assert.equal(res.outcome, 'settled-orphaned-invoice-charge');

    const inv = await readInvoice(invoiceId);
    assert.equal(inv?.status, 'paid', 'money that moved is now on the books');
    assert.ok(inv?.paidChargeId);
    const chargeRows = await db
      .select({ pi: charges.stripePaymentIntentId })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.deepStrictEqual(
      chargeRows.map((r) => r.pi),
      [orphanPi],
    );
    const receipts = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, FIXTURE_IDS.ownerId),
          eq(notifications.type, 'payment-succeeded'),
        ),
      );
    assert.equal(receipts.length, 1, 'the owner learns the outcome they were promised');
    const [resolved] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    assert.equal(resolved?.outcome, 'succeeded', 'the doubt is closed on the books too');
    await cleanup();
  },
);

test(
  'an orphaned succeeded PI for an ALREADY-PAID invoice refunds itself — two charges, one refund, no human',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 12_000, purpose: 'group-class' });
    // The owner paid it manually while the auto-charge outcome was unknown.
    const stripe = makeStripeStub();
    const tick = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
    assert.equal(tick.results[0]?.outcome, 'paid');

    const { app, stripe: webhookStripe } = buildWebhookApp();
    const orphanPi = `pi_test_orphan_${randomUUID().slice(0, 8)}`;
    webhookStripe.setNextEvent({
      id: `evt_test_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: orphanPi,
      amountCents: 12_000,
      metadata: {
        owner_id: FIXTURE_IDS.ownerId,
        invoice_id: invoiceId,
        purpose: 'group-class',
      },
    });
    const res = await postWebhook(app);
    assert.equal(res.outcome, 'settled-orphaned-invoice-charge');

    const refundRows = await db
      .select({ amountCents: refunds.amountCents, status: refunds.status })
      .from(refunds)
      .where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(refundRows.length, 1, 'the duplicate is refunded automatically');
    assert.equal(refundRows[0]?.amountCents, 12_000);
    // And the RECEIVER fired the Stripe refund post-commit, not the handler.
    const refundCalls = webhookStripe.calls.filter((c) => c.method === 'createRefund');
    assert.equal(refundCalls.length, 1, 'the refund actually left the building');
    assert.equal(
      refundCalls[0]?.method === 'createRefund' ? refundCalls[0].args.paymentIntentId : undefined,
      orphanPi,
    );
    await cleanup();
  },
);

test(
  'an orphaned PI whose owner_id metadata does not match the invoice is refused',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice();
    const { app, stripe } = buildWebhookApp();
    stripe.setNextEvent({
      id: `evt_test_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.succeeded',
      paymentIntentId: `pi_test_orphan_${randomUUID().slice(0, 8)}`,
      amountCents: 12_000,
      metadata: {
        owner_id: FIXTURE_IDS.staffDonavanId, // not this invoice's owner
        invoice_id: invoiceId,
        purpose: 'group-class',
      },
    });
    const res = await postWebhook(app);
    assert.equal(res.outcome, 'orphan-event', 'metadata is input, not authority');
    assert.equal((await readInvoice(invoiceId))?.status, 'open', 'nothing settled');
    await cleanup();
  },
);

test(
  'a payment_failed webhook resolves the attempt that was in doubt, and tells a parked owner the answer',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 4500, purpose: 'payg' });
    const stripe = makeStripeStub();
    stripe.setNextIntentThrowsTransport();
    const now = new Date();
    await runInvoiceAutoChargeOnce({ stripe, limit: 5, now });
    await backdateAttempt(invoiceId);
    await runInvoiceAttemptVerifyOnce({ stripe, now: new Date(now.getTime() + 21 * HOUR) });
    const [attempt] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    assert.equal(attempt?.outcome, 'pending');

    const { app, stripe: webhookStripe } = buildWebhookApp();
    webhookStripe.setNextEvent({
      id: `evt_test_${randomUUID().slice(0, 8)}`,
      type: 'payment_intent.payment_failed',
      paymentIntentId: `pi_test_orphan_${randomUUID().slice(0, 8)}`,
      amountCents: 4500,
      metadata: {
        owner_id: FIXTURE_IDS.ownerId,
        invoice_id: invoiceId,
        purpose: 'payg',
        auto_charge_attempt: String(attempt!.attemptNo),
      },
    });
    const res = await postWebhook(app);
    assert.equal(res.outcome, 'resolved-orphaned-invoice-attempt');

    const [resolved] = await invoiceChargeAttemptsRepository.findAllForInvoice(db, invoiceId);
    assert.equal(resolved?.outcome, 'no-charge', 'the doubt is closed the moment Stripe answers');
    // The invoice is parked, so nothing automatic will ever touch it again —
    // this is the only chance to replace "we don't know" with the answer.
    const push = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-failed:${invoiceId}`,
    );
    assert.ok(push, 'the now-known answer reaches the owner');
    assert.match(push!.body, /didn't go through/i);
    assert.match(
      push!.body,
      new RegExp(`on ${ATTEMPT_TRIED_ON} and`),
      'dated when the charge was TRIED — a late webhook must not name its own arrival date',
    );
    await cleanup();
  },
);
