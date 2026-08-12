import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  charges,
  creditLedger,
  invoices,
  memberships,
  notifications,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { membershipsRepository } from '../../src/db/repositories/membershipsRepository.js';
import { settleInvoiceCharge } from '../../src/lib/settleInvoiceCharge.js';
import { withActor } from '../../src/db/tx.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { registerMembershipsRoute } from '../../src/routes/memberships.js';
import { clearInvoiceChargeAttempts, FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Roll-while-parked ruling (2026-07-16), end-to-end through the COMPOSED
 * scheduler tick:
 *
 *   - an OPEN membership invoice (here: parked after a decline) makes the
 *     roll skip the membership entirely — an unpaid month never stacks debt
 *     by opening the next one
 *   - a LATE settle of that invoice grants the floor month AND re-aligns the
 *     membership clock onto it (`alignPeriodAfterLateSettle`), so the next
 *     ticks never catch-up-bill the frozen gap
 *   - billing then resumes at the aligned boundary, and the COUNT-based term
 *     stop still bills exactly `term_months` periods
 *   - the align verb never moves a canceled membership's frozen clock (the
 *     grant still lands — the owner paid)
 *
 * Timeline under test: start 2026-05-19 → period-2 invoice parks → frozen
 * through 07-19 → paid 09-01 → aligned period [09-01, 10-01) → month 3 bills
 * 10-01 → hard stop 11-01.
 */

registerFixtureHooks();

const WORKER_ACTOR = 'system:scheduler';

async function cleanupParkedRoll(): Promise<void> {
  await db
    .update(scheduledNotifications)
    .set({ emittedNotificationId: null })
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(notifications).where(eq(notifications.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(creditLedger)
    .where(
      and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'membership-grant')),
    );
  await clearInvoiceChargeAttempts();
  await db.delete(invoices).where(isNotNull(invoices.membershipId));
  await db.delete(charges).where(eq(charges.purpose, 'membership'));
  await db.delete(memberships).where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
}

async function postThreeMonthMembership(): Promise<string> {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerMembershipsRoute(app, { authenticate, stripe: makeStripeStub(), now: FIXTURE_NOW });
  const post = await app.inject({
    method: 'POST',
    url: '/memberships',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      dog_id: FIXTURE_IDS.dog1Id,
      package_key: FIXTURE_IDS.creditPackageSchool5Key,
      location: 'fayetteville',
      term_months: 3,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
    },
  });
  assert.equal(post.statusCode, 201, post.body);
  return (post.json() as { membership: { id: string } }).membership.id;
}

async function membershipClock(
  membershipId: string,
): Promise<{ status: string; cps: string | null; cpe: string | null; endsAt: string | null }> {
  const [row] = await db
    .select({
      status: memberships.status,
      cps: memberships.currentPeriodStart,
      cpe: memberships.currentPeriodEnd,
      endsAt: memberships.endsAt,
    })
    .from(memberships)
    .where(eq(memberships.id, membershipId));
  assert.ok(row, `membership ${membershipId} exists`);
  return row;
}

test(
  'roll-while-parked — an open invoice freezes the roll; a late settle re-aligns the clock and billing resumes',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupParkedRoll();
    const stripe = makeStripeStub();
    const expoPush = makeExpoPushStub();
    const membershipId = await postThreeMonthMembership();

    // Tick 1 — an hour past period-1's end. The roll opens period 2 + its
    // invoice; the SAME tick's charge attempt DECLINES (one-shot stub).
    stripe.setNextIntentStatus('requires_payment_method');
    const tick1 = await runSchedulerTickOnce({
      stripe,
      expoPush,
      now: new Date('2026-06-19T18:00:00Z'),
    });
    assert.equal(tick1.membershipRoll.rolled, 1, 'tick 1 rolled month 2');
    assert.equal(
      tick1.invoiceAutoCharge.results.filter((r) => r.outcome === 'paid').length,
      0,
      'the declined invoice did not settle',
    );

    // Park it the way the worker eventually would (dunning exhausted).
    const parked = await db
      .update(invoices)
      .set({ autoChargeAttempts: 4, nextAttemptAt: null })
      .where(and(eq(invoices.membershipId, membershipId), eq(invoices.status, 'open')))
      .returning({ id: invoices.id });
    assert.equal(parked.length, 1, 'exactly one open month-2 invoice to park');

    // Tick 2 — period-2's end. Un-fixed, the roll would open month 3 here
    // and stack a second unpaid invoice. The ruling: invisible to the roll.
    const tick2 = await runSchedulerTickOnce({
      stripe,
      expoPush,
      now: new Date('2026-07-19T18:00:00Z'),
    });
    assert.equal(tick2.membershipRoll.scanned, 0, 'parked invoice → membership skipped');
    const invoiceCount = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.membershipId, membershipId));
    assert.equal(invoiceCount.length, 1, 'no new invoice while parked — debt never stacks');

    // Sep 1 — the owner finally pays (the settle primitive the manual
    // POST /invoices/:id/pay route calls, with the clock pinned).
    const open = await invoicesRepository.findOpenByOwner(db, FIXTURE_IDS.ownerId);
    const parkedInvoice = open.find((i) => i.membershipId === membershipId);
    assert.ok(parkedInvoice, 'the parked invoice is still open');
    const settle = await withActor(WORKER_ACTOR, (tx) =>
      settleInvoiceCharge(tx, {
        invoice: parkedInvoice,
        paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        amountCents: parkedInvoice.amountCents,
        purpose: 'membership',
        notifyOwner: false,
        now: new Date('2026-09-01T12:00:00Z'),
      }),
    );
    assert.equal(settle.outcome, 'settled');

    // The clock re-aligned onto the granted floor month [Sep 1, Oct 1) and
    // ends_at shifted by the same delta (Jul 19 17:00 → Oct 1 12:00 =
    // +73d19h, so Aug 19 17:00 → Nov 1 12:00).
    const aligned = await membershipClock(membershipId);
    assert.ok(
      aligned.cps?.startsWith('2026-09-01'),
      `period start re-aligned — got ${aligned.cps}`,
    );
    assert.ok(aligned.cpe?.startsWith('2026-10-01'), `period end re-aligned — got ${aligned.cpe}`);
    assert.ok(aligned.endsAt?.startsWith('2026-11-01'), `ends_at shifted — got ${aligned.endsAt}`);

    // Tick 3 — the day after payment. NOTHING is due: the frozen gap
    // (Jul 19 → Sep 1) is never catch-up-billed.
    const tick3 = await runSchedulerTickOnce({
      stripe,
      expoPush,
      now: new Date('2026-09-02T12:00:00Z'),
    });
    assert.equal(tick3.membershipRoll.scanned, 0, 'no catch-up roll over the parked gap');

    // Tick 4 — the aligned boundary. Month 3 bills + settles normally.
    const tick4 = await runSchedulerTickOnce({
      stripe,
      expoPush,
      now: new Date('2026-10-01T13:00:00Z'),
    });
    assert.equal(tick4.membershipRoll.rolled, 1, 'billing resumed at the aligned boundary');
    assert.equal(
      tick4.invoiceAutoCharge.results.filter((r) => r.outcome === 'paid').length,
      1,
      'month 3 charged in the same tick',
    );

    // Tick 5 — 1 sync month + 2 invoices = 3 billed periods = the term:
    // the COUNT-based hard stop is unchanged by the park.
    const tick5 = await runSchedulerTickOnce({
      stripe,
      expoPush,
      now: new Date('2026-11-01T13:00:00Z'),
    });
    assert.equal(tick5.membershipRoll.completed, 1, 'hard stop after exactly 3 billed periods');
    assert.equal(tick5.membershipRoll.rolled, 0, 'never a 4th invoice');

    await cleanupParkedRoll();
  },
);

test(
  "roll-while-parked — a late settle grants the paid month but never moves a canceled membership's frozen clock",
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupParkedRoll();
    const membershipId = await postThreeMonthMembership();

    await withActor(WORKER_ACTOR, async (tx) => {
      const canceled = await membershipsRepository.cancel(tx, {
        id: membershipId,
        ownerId: FIXTURE_IDS.ownerId,
      });
      assert.equal(canceled, 1);
    });

    // A month-2 invoice left over from before the cancel, parked, paid late.
    const invoice = await withActor(WORKER_ACTOR, (tx) =>
      invoicesRepository.createOpen(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 12500,
        purpose: 'membership',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        dueAt: '2026-06-19T17:00:00Z',
        dogId: FIXTURE_IDS.dog1Id,
        membershipId,
      }),
    );
    const settle = await withActor(WORKER_ACTOR, (tx) =>
      settleInvoiceCharge(tx, {
        invoice,
        paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        amountCents: 12500,
        purpose: 'membership',
        notifyOwner: false,
        now: new Date('2026-09-01T12:00:00Z'),
      }),
    );
    assert.equal(settle.outcome, 'settled');

    // The owner paid → the floor month's credits land regardless of status.
    const lots = await db
      .select({ expiresAt: creditLedger.expiresAt })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.dogId, FIXTURE_IDS.dog1Id),
          eq(creditLedger.reason, 'membership-grant'),
        ),
      );
    assert.ok(
      lots.some((l) => l.expiresAt?.startsWith('2026-10-01')),
      'late-settle floor grant landed',
    );

    // But the canceled clock stayed frozen — align self-filters to active.
    const clock = await membershipClock(membershipId);
    assert.equal(clock.status, 'canceled');
    assert.ok(
      clock.cpe?.startsWith('2026-06-19'),
      `canceled membership's period end untouched — got ${clock.cpe}`,
    );

    await cleanupParkedRoll();
  },
);
