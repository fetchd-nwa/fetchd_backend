import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { scheduledNotificationsRepository } from '../../src/db/repositories/scheduledNotificationsRepository.js';
import {
  charges,
  deviceTokens,
  invoices,
  notificationDogs,
  notifications,
  paymentMethods,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import {
  MAX_AUTO_CHARGE_ATTEMPTS,
  runInvoiceAutoChargeOnce,
  scheduleNextAttempt,
} from '../../src/workers/invoiceAutoCharge.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';
import { makeExpoPushStub } from './_expoPushStub.js';

registerFixtureHooks();

async function seedDueInvoice(
  opts: {
    amountCents?: number;
    purpose?: 'board-train' | 'payg' | 'group-class';
    dogId?: string;
  } = {},
): Promise<string> {
  const row = await db.transaction(async (tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: opts.amountCents ?? 200_000,
      purpose: opts.purpose ?? 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dogId: opts.dogId ?? null,
      // dueAt + nextAttemptAt in the past so the worker scoops it.
      dueAt: '2026-01-01T00:00:00Z',
      nextAttemptAt: '2026-01-01T00:00:00Z',
    }),
  );
  return row.id;
}

/** Push a seeded invoice to one attempt short of the park cap, so the NEXT
 *  failed attempt parks it (`scheduleNextAttempt(MAX-1) === null`). */
async function setAttemptsToOneBeforePark(invoiceId: string): Promise<void> {
  await db
    .update(invoices)
    .set({ autoChargeAttempts: MAX_AUTO_CHARGE_ATTEMPTS - 1 })
    .where(eq(invoices.id, invoiceId));
}

async function seedDeviceToken(token: string): Promise<void> {
  await db.insert(deviceTokens).values({
    ownerId: FIXTURE_IDS.ownerId,
    expoPushToken: token,
    platform: 'ios',
  });
}

async function clearDeviceTokens(): Promise<void> {
  await db.delete(deviceTokens).where(eq(deviceTokens.ownerId, FIXTURE_IDS.ownerId));
}

async function cleanup(): Promise<void> {
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  // A parked invoice now enqueues a payment-failed `scheduled_notifications`
  // row (delivered + pushed by the scheduler); a successful auto-charge writes
  // a payment-succeeded feed row directly. Clear both so a re-run starts clean.
  // Break the scheduled-row -> notifications FK link before deleting feed rows,
  // then drop the scheduled rows themselves (their dedupe_key is invoice-stable,
  // so a stale row would block the next park enqueue).
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
        eq(scheduledNotifications.type, 'payment-failed'),
      ),
    );
}

/** Count the worker's payment-* feed rows for the fixture owner, by type. */
async function paymentNotifications(
  type: 'payment-succeeded' | 'payment-failed',
): Promise<
  {
    id: string;
    title: string;
    body: string;
    deepLinkPath: string | null;
    deepLinkKind: string | null;
    deepLinkId: string | null;
  }[]
> {
  return db
    .select({
      id: notifications.id,
      title: notifications.title,
      body: notifications.body,
      deepLinkPath: notifications.deepLinkPath,
      deepLinkKind: notifications.deepLinkKind,
      deepLinkId: notifications.deepLinkId,
    })
    .from(notifications)
    .where(and(eq(notifications.ownerId, FIXTURE_IDS.ownerId), eq(notifications.type, type)));
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

test(
  'runInvoiceAutoChargeOnce — a pay-in-person invoice past due is never leased or charged (R3)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // A due invoice (next_attempt_at in the past) the owner elected to pay in
    // person: flip payment_expected → 'in-person' via the real repository verb.
    const invoiceId = await seedDueInvoice();
    await db.transaction((tx) => invoicesRepository.markPayInPerson(tx, { id: invoiceId }));

    const stripe = makeStripeStub();
    const result = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });

    // The due-batch queries filter payment_expected='card', so the in-person
    // invoice is invisible to the worker — nothing scanned, nothing charged.
    assert.equal(result.scanned, 0, 'in-person invoice is excluded from the due batch');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent').length,
      0,
      'no card charge for a cash/check invoice',
    );

    const [inv] = await db
      .select({ status: invoices.status, paymentExpected: invoices.paymentExpected })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open', 'invoice untouched — still open, awaiting drop-off');
    assert.equal(inv?.paymentExpected, 'in-person');

    const chargeRows = await db
      .select({ id: charges.id })
      .from(charges)
      .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(chargeRows.length, 0, 'no charge row written');
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Part B (credit-expiry Phase 3) — auto-charge notifications.
//   - payment-succeeded on a successful auto-charge (a receipt)
//   - payment-failed ONLY when the invoice PARKS (terminal, MAX attempts)
//   - NO notification on an intermediate retry (the anti-spam invariant)
// ──────────────────────────────────────────────────────────────────────────

test(
  'auto-charge notify — SUCCESS emits exactly one payment-succeeded receipt linked to the dog',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // payg purpose + a dog so the receipt copy + notification_dogs link assert.
    const invoiceId = await seedDueInvoice({
      amountCents: 4500,
      purpose: 'payg',
      dogId: FIXTURE_IDS.dog1Id,
    });
    const stripe = makeStripeStub();

    const result = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
    assert.equal(result.results[0]?.outcome, 'paid');

    const succeeded = await paymentNotifications('payment-succeeded');
    assert.equal(succeeded.length, 1, 'exactly one receipt');
    assert.equal(succeeded[0]?.title, 'Payment received');
    assert.match(succeeded[0]!.body, /\$45 for your day program session/);
    assert.equal(succeeded[0]?.deepLinkPath, `/account/invoices?invoiceId=${invoiceId}`);
    assert.equal(succeeded[0]?.deepLinkKind, 'invoice');
    assert.equal(succeeded[0]?.deepLinkId, invoiceId);

    // No payment-failed on a clean success.
    assert.equal((await paymentNotifications('payment-failed')).length, 0);

    // payment-succeeded stays FEED-ONLY: written directly by settleInvoiceCharge,
    // never routed through the scheduled push queue (only payment-failed is).
    const scheduledRows = await db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
          inArray(scheduledNotifications.type, ['payment-failed', 'payment-succeeded']),
        ),
      );
    assert.equal(scheduledRows.length, 0, 'a receipt never enqueues a scheduled push');

    // notification_dogs denorm links the receipt to the billed dog.
    const dogLinks = await db
      .select({ dogId: notificationDogs.dogId })
      .from(notificationDogs)
      .where(eq(notificationDogs.notificationId, succeeded[0]!.id));
    assert.deepStrictEqual(
      dogLinks.map((r) => r.dogId),
      [FIXTURE_IDS.dog1Id],
    );
    await cleanup();
  },
);

test(
  'auto-charge notify — PARK enqueues a payment-failed scheduled push (not a direct feed row)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 12000, purpose: 'group-class' });
    // One attempt short of the cap, so this failed attempt parks the invoice.
    await setAttemptsToOneBeforePark(invoiceId);
    const stripe = makeStripeStub();
    // Non-settled status → recordFailed; at attempts=MAX-1, scheduleNextAttempt
    // returns null → PARK.
    stripe.setNextIntentStatus('requires_payment_method');

    const result = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
    assert.equal(result.results[0]?.outcome, 'failed-parked', 'terminal park at MAX attempts');

    const [inv] = await db
      .select({ status: invoices.status, nextAttemptAt: invoices.nextAttemptAt })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.status, 'open', 'parked invoices stay open for staff resolution');
    assert.equal(inv?.nextAttemptAt, null, 'parked (no further auto-attempt)');

    // The park now routes through the PUSH channel: a `scheduled_notifications`
    // row (delivered + pushed by the scheduler), NOT a direct feed insert.
    const scheduled = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-failed:${invoiceId}`,
    );
    assert.ok(scheduled, 'park enqueued a scheduled payment-failed row');
    assert.equal(scheduled?.type, 'payment-failed');
    assert.equal(scheduled?.trigger, 'payment-failed');
    assert.equal(scheduled?.status, 'pending', 'not yet delivered — awaits the scheduler tick');
    assert.equal(scheduled?.title, 'Payment failed');
    assert.match(scheduled!.body, /\$120 for your group class enrollment.*update your card/i);
    assert.equal(scheduled?.deepLinkPath, `/account/invoices?invoiceId=${invoiceId}`);
    assert.equal(scheduled?.deepLinkKind, 'invoice');
    assert.equal(scheduled?.deepLinkId, invoiceId);

    // No feed row landed in the worker tx — the scheduler inserts it on delivery.
    assert.equal(
      (await paymentNotifications('payment-failed')).length,
      0,
      'feed deferred to scheduler',
    );
    // A park is a failure, never a receipt.
    assert.equal((await paymentNotifications('payment-succeeded')).length, 0);
    await cleanup();
  },
);

test(
  'auto-charge notify — scheduler delivers the parked payment-failed (feed row + push dispatched)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    await clearDeviceTokens();
    await seedDeviceToken('ExponentPushToken[stub-park-device]');
    const invoiceId = await seedDueInvoice({
      amountCents: 12000,
      purpose: 'group-class',
      dogId: FIXTURE_IDS.dog1Id,
    });
    await setAttemptsToOneBeforePark(invoiceId);
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('requires_payment_method');

    // 1) Park enqueues the scheduled row.
    await runInvoiceAutoChargeOnce({ stripe, limit: 5 });

    // 2) Scheduler delivers it: INSERT the feed row + dispatch push from tokens.
    const expoPush = makeExpoPushStub();
    const tick = await runSchedulerTickOnce({ expoPush });

    assert.ok(tick.scheduledNotifications.sent >= 1, 'scheduler sent the parked payment-failed');

    const scheduled = await scheduledNotificationsRepository.findByDedupeKey(
      db,
      `payment-failed:${invoiceId}`,
    );
    assert.equal(scheduled?.status, 'sent', 'scheduled row marked sent');
    assert.ok(scheduled?.emittedNotificationId, 'linked to the delivered feed row');

    // Feed row now exists.
    const failed = await paymentNotifications('payment-failed');
    assert.equal(failed.length, 1, 'exactly one delivered feed row after the tick');
    assert.equal(failed[0]?.title, 'Payment failed');

    // notification_dogs denorm links the billed dog (the invoice carried dog1Id).
    const dogLinks = await db
      .select({ dogId: notificationDogs.dogId })
      .from(notificationDogs)
      .where(eq(notificationDogs.notificationId, failed[0]!.id));
    assert.deepStrictEqual(
      dogLinks.map((r) => r.dogId),
      [FIXTURE_IDS.dog1Id],
    );

    // Push was dispatched to the owner's live token.
    const parkPushes = expoPush.calls
      .flatMap((call) => call.messages)
      .filter((message) => message.data?.type === 'payment-failed');
    assert.equal(parkPushes.length, 1, 'one payment-failed push dispatched');
    assert.equal(parkPushes[0]?.to, 'ExponentPushToken[stub-park-device]');
    assert.equal(parkPushes[0]?.title, 'Payment failed');

    await clearDeviceTokens();
    await cleanup();
  },
);

test(
  'auto-charge notify — re-running the park path does NOT enqueue a second scheduled row (dedup)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice({ amountCents: 12000, purpose: 'group-class' });
    await setAttemptsToOneBeforePark(invoiceId);

    // First park enqueues the scheduled row.
    const firstStripe = makeStripeStub();
    firstStripe.setNextIntentStatus('requires_payment_method');
    await runInvoiceAutoChargeOnce({ stripe: firstStripe, limit: 5 });

    // Force the invoice back to a parkable state and re-run the park path. The
    // invoice-stable dedupe key (`payment-failed:<invoiceId>`) must make the
    // second enqueue an ON CONFLICT DO NOTHING no-op — one push per parked
    // invoice, ever.
    await db
      .update(invoices)
      .set({
        status: 'open',
        autoChargeAttempts: MAX_AUTO_CHARGE_ATTEMPTS - 1,
        nextAttemptAt: '2026-01-01T00:00:00Z',
      })
      .where(eq(invoices.id, invoiceId));
    const secondStripe = makeStripeStub();
    secondStripe.setNextIntentStatus('requires_payment_method');
    await runInvoiceAutoChargeOnce({ stripe: secondStripe, limit: 5 });

    const rows = await db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, `payment-failed:${invoiceId}`));
    assert.equal(rows.length, 1, 'exactly one scheduled row across two park attempts');
    await cleanup();
  },
);

test(
  'auto-charge notify — INTERMEDIATE retry emits NO notification (anti-spam invariant)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const invoiceId = await seedDueInvoice(); // attempts=0 → far from the park cap
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('requires_action'); // non-settled → retry scheduled

    const result = await runInvoiceAutoChargeOnce({ stripe, limit: 5 });
    assert.equal(
      result.results[0]?.outcome,
      'failed-retry-scheduled',
      'a retry is scheduled, not a park',
    );
    assert.notEqual(result.results[0]?.nextAttemptAt, null, 'next attempt is scheduled');

    const [inv] = await db
      .select({ autoChargeAttempts: invoices.autoChargeAttempts })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    assert.equal(inv?.autoChargeAttempts, 1, 'attempt counted');

    // THE INVARIANT: no notification of EITHER kind on a transient retry —
    // neither a delivered feed row nor an enqueued scheduled push.
    assert.equal((await paymentNotifications('payment-failed')).length, 0, 'no spam on retry');
    assert.equal((await paymentNotifications('payment-succeeded')).length, 0);
    const scheduledOnRetry = await db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
          eq(scheduledNotifications.type, 'payment-failed'),
        ),
      );
    assert.equal(scheduledOnRetry.length, 0, 'an intermediate retry enqueues no scheduled push');
    await cleanup();
  },
);
