import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import {
  charges,
  cohorts,
  deviceTokens,
  invoices,
  notifications,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { pgTimestampToDate } from '../../src/lib/pgTimestamp.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * DECISIONS 162(a), Blocked #16: class `pay_later` stays until P29 and nothing bills it.
 * The arm mints an open invoice, the worker that used to charge it is gone with the
 * lane, and the owner pays through `POST /invoices/:id/pay`. This is the one test that
 * walks that whole journey, through a real scheduler tick, past the old due date and
 * past the old three-day overdue grace.
 */

registerFixtureHooks();

const COHORT_START = '2026-07-06T23:00:00Z';
const DAY_MS = 24 * 60 * 60 * 1000;

test(
  'a pay_later class invoice past due: a real tick leaves it open, unbilled and unmentioned, then she pays it',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohortId = randomUUID();
    await db.insert(cohorts).values({
      id: cohortId,
      classKey: 'puppy',
      location: 'fayetteville',
      startDate: COHORT_START,
      endDate: null,
      weeklyTime: '6:00 PM',
      weeks: 4,
      capacity: 6,
      filled: 0,
    });

    const stripe = makeStripeStub();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
    registerInvoicesRoute(app, { authenticate, stripe });

    const enrolled = await app.inject({
      method: 'POST',
      url: '/enrollments',
      headers: { 'idempotency-key': `pay-later-${randomUUID()}` },
      payload: {
        cohort_id: cohortId,
        dog_ids: [FIXTURE_IDS.dog1Id],
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        pay_later: true,
      },
    });
    assert.equal(enrolled.statusCode, 201, enrolled.body);

    const [invoice] = await db.select().from(invoices).where(eq(invoices.cohortId, cohortId));
    assert.ok(invoice !== undefined, 'the arm still mints an open invoice');
    assert.equal(invoice.status, 'open');
    const dueAt = new Date(invoice.dueAt);
    assert.equal(dueAt.getTime(), new Date(COHORT_START).getTime() - DAY_MS);

    // Five days past due: past the worker's due time and past the 3-day overdue grace.
    const expo = makeExpoPushStub();
    const stripeCallsBefore = stripe.calls.length;
    await runSchedulerTickOnce({
      stripe,
      expoPush: expo,
      now: new Date(dueAt.getTime() + 5 * DAY_MS),
    });

    assert.deepEqual(
      stripe.calls.slice(stripeCallsBefore).map((call) => call.method),
      [],
      'no Stripe call',
    );
    const [afterTick] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    assert.equal(afterTick?.status, 'open', 'still open');
    assert.equal(afterTick?.paidChargeId, null);
    const chargeRows = await db.select().from(charges).where(eq(charges.cohortId, cohortId));
    assert.deepEqual(chargeRows, [], 'no charge row');

    const queued = await db
      .select({ id: scheduledNotifications.id, type: scheduledNotifications.type })
      .from(scheduledNotifications)
      .where(
        or(
          eq(scheduledNotifications.deepLinkId, invoice.id),
          sql`${scheduledNotifications.dedupeKey} LIKE ${`%${invoice.id}%`}`,
        ),
      );
    assert.deepEqual(queued, [], 'no notification queued');
    const fed = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.deepLinkId, invoice.id));
    assert.deepEqual(fed, [], 'no notification delivered');

    const columns = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'invoices'
         AND column_name IN ('next_attempt_at', 'auto_charge_attempts')
    `);
    assert.deepEqual(columns.rows, [], 'no next_attempt_at left to read');

    // Then she pays it, on her own route, which stays.
    const paid = await app.inject({
      method: 'POST',
      url: `/invoices/${invoice.id}/pay`,
      headers: { 'idempotency-key': `pay-later-pay-${randomUUID()}` },
      payload: {},
    });
    assert.ok(paid.statusCode === 200 || paid.statusCode === 201, paid.body);

    const [settled] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    assert.equal(settled?.status, 'paid');
    assert.ok(settled?.paidChargeId !== null && settled?.paidChargeId !== undefined);
    const [charge] = await db
      .select()
      .from(charges)
      .where(and(eq(charges.id, settled.paidChargeId), eq(charges.status, 'succeeded')));
    assert.equal(charge?.purpose, 'group-class');
    assert.equal(charge?.amountCents, invoice.amountCents);
  },
);

/**
 * DECISIONS 167(a): *Pay later*, then *Cash*, leaves a `payment-due:<invoice>` row asking
 * her to bring the money. The withdraw voids that invoice and tells her she won't be
 * charged, so the row has to go with it: a push saying "Please bring $250.00" for a class
 * she left is false, and the invoice it links to is no longer on her ledger to correct it.
 * The four "Reminder: Group Class tomorrow" rows on this journey are BUG-9, P29's, and
 * this file says nothing about them.
 */
async function payLaterThenCash() {
  // A device, so what the tick pushes is read too, and not only what it files.
  await db.delete(deviceTokens).where(eq(deviceTokens.ownerId, FIXTURE_IDS.ownerId));
  await db.insert(deviceTokens).values({
    ownerId: FIXTURE_IDS.ownerId,
    expoPushToken: `ExponentPushToken[${randomUUID()}]`,
    platform: 'ios',
  });

  const cohortId = randomUUID();
  await db.insert(cohorts).values({
    id: cohortId,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate: COHORT_START,
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks: 4,
    capacity: 6,
    filled: 0,
  });

  const stripe = makeStripeStub();
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  registerInvoicesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });

  const enrolled = await app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `cash-${randomUUID()}` },
    payload: {
      cohort_id: cohortId,
      dog_ids: [FIXTURE_IDS.dog1Id],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: true,
    },
  });
  assert.equal(enrolled.statusCode, 201, enrolled.body);

  const [invoice] = await db.select().from(invoices).where(eq(invoices.cohortId, cohortId));
  assert.ok(invoice !== undefined, 'pay later mints an open invoice');

  const cash = await app.inject({
    method: 'POST',
    url: `/invoices/${invoice.id}/pay-in-person`,
    headers: { 'idempotency-key': `cash-pip-${randomUUID()}` },
    payload: {},
  });
  assert.equal(cash.statusCode, 204, cash.body);

  const reminder = await reminderFor(invoice.id);
  assert.equal(reminder.status, 'pending', 'Cash queued the reminder');
  return {
    app,
    stripe,
    cohortId,
    invoice,
    tickAt: new Date(pgTimestampToDate(reminder.scheduledFor).getTime() + 60_000),
  };
}

async function reminderFor(invoiceId: string) {
  const [row] = await db
    .select()
    .from(scheduledNotifications)
    .where(eq(scheduledNotifications.dedupeKey, `payment-due:${invoiceId}`));
  assert.ok(row !== undefined, `invoice ${invoiceId} has a payment-due row`);
  return row;
}

/** What a tick past the row's time told her about this invoice, feed and push. */
async function toldAbout(invoiceId: string, expo: ReturnType<typeof makeExpoPushStub>) {
  const feed = await db
    .select({ title: notifications.title, body: notifications.body })
    .from(notifications)
    .where(and(eq(notifications.deepLinkId, invoiceId), eq(notifications.type, 'payment-due')));
  const pushed = expo.calls
    .flatMap((call) => call.messages)
    .filter((message) => message.title === 'Payment due at drop-off');
  return { feed, pushed: pushed.length };
}

test(
  'a withdrawn class stops asking for money: pay later, Cash, withdraw, and a real tick past the reminder tells her nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, stripe, cohortId, invoice, tickAt } = await payLaterThenCash();

    // Another invoice of hers keeps its own reminder: the cancel is this invoice's alone.
    const other = await db.transaction((tx) =>
      invoicesRepository.createOpen(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 12_000,
        purpose: 'board-train',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        dueAt: new Date(new Date(COHORT_START).getTime() + 30 * DAY_MS).toISOString(),
        bookingId: null,
      }),
    );
    const otherCash = await app.inject({
      method: 'POST',
      url: `/invoices/${other.id}/pay-in-person`,
      headers: { 'idempotency-key': `cash-other-${randomUUID()}` },
      payload: {},
    });
    assert.equal(otherCash.statusCode, 204, otherCash.body);

    const withdrawn = await app.inject({
      method: 'POST',
      url: `/enrollments/${cohortId}/withdraw`,
      headers: { 'idempotency-key': `cash-withdraw-${randomUUID()}` },
      payload: { dog_id: FIXTURE_IDS.dog1Id },
    });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.equal(
      (withdrawn.json() as { money_outcome: string }).money_outcome,
      'voided',
      'she was told she will not be charged',
    );
    const [voided] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    assert.equal(voided?.status, 'void');

    const expo = makeExpoPushStub();
    await runSchedulerTickOnce({ stripe, expoPush: expo, now: tickAt });

    assert.deepEqual(await toldAbout(invoice.id, expo), { feed: [], pushed: 0 });
    assert.equal((await reminderFor(invoice.id)).status, 'cancelled');
    assert.equal((await reminderFor(other.id)).status, 'pending', 'the other invoice still asks');
  },
);

test(
  'the control: the same journey with no withdraw still sends the reminder on that tick',
  SKIP_WHEN_NO_DB,
  async () => {
    const { stripe, invoice, tickAt } = await payLaterThenCash();

    const expo = makeExpoPushStub();
    await runSchedulerTickOnce({ stripe, expoPush: expo, now: tickAt });

    const told = await toldAbout(invoice.id, expo);
    assert.equal(told.feed.length, 1, 'the reminder reached her feed');
    assert.equal(told.pushed, 1, 'and her phone');
    assert.equal(told.feed[0]?.title, 'Payment due at drop-off');
    assert.match(told.feed[0]?.body ?? '', /^Please bring \$/);
    assert.equal((await reminderFor(invoice.id)).status, 'sent');
  },
);
