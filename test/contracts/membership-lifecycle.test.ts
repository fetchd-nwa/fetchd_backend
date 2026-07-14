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
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { registerMembershipsRoute } from '../../src/routes/memberships.js';
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
 * §J.1 END-TO-END lifecycle through the COMPOSED scheduler tick — every seam
 * is covered by its own contract test; this proves the assembled machine:
 *
 *   POST /memberships (term 3, month-1 sync grant)
 *   → tick @ period-1 end:  ROLL opens period 2 + card-backed invoice, and
 *     the SAME tick's auto-charge phase leases it, charges the stub, and
 *     `settleInvoiceCharge` grants month-2's lot at period-2's end
 *   → tick @ period-2 end:  same for month 3
 *   → tick @ period-3 end:  billed-period COUNT hits the term → HARD STOP
 *     ('completed', no 4th invoice, no 4th grant)
 *
 * Month math under test at the composed level: start 2026-05-19 →
 * boundaries 06-19 / 07-19 / 08-19 (per-start clamped month-adds).
 */

registerFixtureHooks();

async function cleanupLifecycle(): Promise<void> {
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
  await db.delete(invoices).where(isNotNull(invoices.membershipId));
  await db.delete(charges).where(eq(charges.purpose, 'membership'));
  await db.delete(memberships).where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
}

async function membershipGrantLots(): Promise<{ expiresAt: string | null }[]> {
  return db
    .select({ expiresAt: creditLedger.expiresAt })
    .from(creditLedger)
    .where(
      and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'membership-grant')),
    )
    .orderBy(creditLedger.createdAt, creditLedger.id);
}

test(
  '§J.1 lifecycle — 3-month subscription: 2 composed roll→charge→settle ticks, then the hard stop',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupLifecycle();
    const stripe = makeStripeStub();
    const expoPush = makeExpoPushStub();

    // Month 1 — POST /memberships charges synchronously at FIXTURE_NOW
    // (2026-05-19T17:00Z) and grants the first lot.
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerMembershipsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
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
    const membershipId = (post.json() as { membership: { id: string } }).membership.id;

    // Tick 1 — an hour past period-1's end. Roll opens period 2 + its
    // invoice (due at the new period start ≤ now), and the SAME tick's
    // auto-charge phase settles it: month-2's lot lands at period-2's end.
    const tick1 = await runSchedulerTickOnce({
      stripe,
      expoPush,
      now: new Date('2026-06-19T18:00:00Z'),
    });
    assert.equal(tick1.membershipRoll.rolled, 1, 'tick 1 rolled the due membership');
    assert.equal(tick1.membershipRoll.completed, 0);
    assert.equal(
      tick1.invoiceAutoCharge.results.filter((r) => r.outcome === 'paid').length,
      1,
      'the rolled invoice charged in the SAME tick',
    );
    let lots = await membershipGrantLots();
    assert.equal(lots.length, 2, 'month-1 sync grant + month-2 settle grant');
    assert.ok(lots[1]!.expiresAt?.startsWith('2026-07-19'), `month-2 lot → ${lots[1]!.expiresAt}`);

    // Tick 2 — period-2's end. Month 3 rolls, charges, grants.
    const tick2 = await runSchedulerTickOnce({
      stripe,
      expoPush,
      now: new Date('2026-07-19T18:00:00Z'),
    });
    assert.equal(tick2.membershipRoll.rolled, 1, 'tick 2 rolled month 3');
    assert.equal(tick2.invoiceAutoCharge.results.filter((r) => r.outcome === 'paid').length, 1);
    lots = await membershipGrantLots();
    assert.equal(lots.length, 3);
    assert.ok(lots[2]!.expiresAt?.startsWith('2026-08-19'), `month-3 lot → ${lots[2]!.expiresAt}`);

    // Tick 3 — period-3's end. 1 sync month + 2 invoices = 3 billed periods
    // = the term: HARD STOP. No 4th invoice, no 4th grant.
    const tick3 = await runSchedulerTickOnce({
      stripe,
      expoPush,
      now: new Date('2026-08-19T18:00:00Z'),
    });
    assert.equal(tick3.membershipRoll.completed, 1, 'tick 3 hit the §J.1 hard stop');
    assert.equal(tick3.membershipRoll.rolled, 0);

    const [row] = await db
      .select({ status: memberships.status })
      .from(memberships)
      .where(eq(memberships.id, membershipId));
    assert.equal(row?.status, 'completed');
    const ended = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, FIXTURE_IDS.ownerId),
          eq(notifications.type, 'membership-ended'),
        ),
      );
    assert.equal(ended.length, 1, 'the owner was told the subscription ended');
    const membershipInvoices = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.membershipId, membershipId));
    assert.equal(membershipInvoices.length, 2, 'exactly 2 rolled invoices for a 3-month term');
    assert.ok(
      membershipInvoices.every((i) => i.status === 'paid'),
      'both rolled invoices settled',
    );
    assert.equal((await membershipGrantLots()).length, 3, 'exactly 3 monthly grants — never a 4th');

    // A LATER tick stays quiet — completed memberships never roll again.
    const tick4 = await runSchedulerTickOnce({
      stripe,
      expoPush,
      now: new Date('2026-09-19T18:00:00Z'),
    });
    assert.equal(tick4.membershipRoll.scanned, 0, 'completed membership is invisible to the roll');

    await cleanupLifecycle();
  },
);
