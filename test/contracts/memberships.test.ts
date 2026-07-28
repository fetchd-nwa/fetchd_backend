import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  charges,
  creditLedger,
  dogCompletedPrograms,
  invoices,
  memberships,
  notifications,
} from '../../src/db/schema/schema.js';
import {
  invoicesRepository,
  type InvoiceRow,
} from '../../src/db/repositories/invoicesRepository.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { addMonthsAnchored } from '../../src/lib/membershipBilling.js';
import { rollDueMemberships } from '../../src/lib/membershipRoll.js';
import { settleInvoiceCharge } from '../../src/lib/settleInvoiceCharge.js';
import { withActor } from '../../src/db/tx.js';
import { registerMembershipsRoute, type MembershipWire } from '../../src/routes/memberships.js';
import { registerStaffMembershipsRoute } from '../../src/routes/staffMemberships.js';
import { FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * §J.1 credit-package subscriptions:
 *   - POST /memberships — month-1 sync charge → active membership + a
 *     `membership-grant` lot expiring at the period's end (alumni → NULL)
 *   - non-succeeded month-1 intent → 422 + PI cancelled + NO membership
 *   - GET /memberships — owner list; DELETE — cancel (409 on re-cancel)
 *   - roll phase: advance period + card-backed invoice; pause skips;
 *     term exhaustion (billed-period COUNT) hard-stops
 *   - `settleInvoiceCharge` membership branch grants the month's lot
 *   - anchored month math: end-of-month starts never drift or over-bill
 */

registerFixtureHooks();

const WORKER_ACTOR = 'system:scheduler';

interface MembershipCreateResponse {
  membership: MembershipWire;
  charge_id: string;
  charge_status: string;
  stripe_payment_intent_id: string;
  credits_granted: number;
}

function membershipApp(
  opts: { stripe?: StripeStub; principal?: typeof FIXTURE_OWNER_PRINCIPAL } = {},
): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: StripeStub;
} {
  const { app, authenticate } = makeContractApp(opts.principal ?? FIXTURE_OWNER_PRINCIPAL);
  const stripe = opts.stripe ?? makeStripeStub();
  registerMembershipsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

function staffMembershipApp(): { app: ReturnType<typeof makeContractApp>['app'] } {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffMembershipsRoute(app, { authenticate, now: FIXTURE_NOW });
  return { app };
}

async function postMembership(
  app: ReturnType<typeof makeContractApp>['app'],
  overrides: Record<string, unknown> = {},
): Promise<MembershipCreateResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/memberships',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      dog_id: FIXTURE_IDS.dog1Id,
      package_key: FIXTURE_IDS.creditPackageSchool5Key,
      location: 'fayetteville',
      term_months: 3,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as MembershipCreateResponse;
}

/** FK-ordered §J cleanup: grant lots → membership invoices → charges → rows. */
async function cleanupMemberships(): Promise<void> {
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.ownerId, FIXTURE_IDS.ownerId),
        eq(notifications.type, 'membership-ended'),
      ),
    );
  await clearMembershipGrantLots();
  await db.delete(invoices).where(isNotNull(invoices.membershipId));
  await db.delete(charges).where(eq(charges.purpose, 'membership'));
  await db.delete(memberships).where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(dogCompletedPrograms).where(eq(dogCompletedPrograms.dogId, FIXTURE_IDS.dog1Id));
}

/** dog1's membership-grant lots, oldest first. */
async function membershipGrantLots(): Promise<{ expiresAt: string | null; delta: number }[]> {
  return db
    .select({ expiresAt: creditLedger.expiresAt, delta: creditLedger.delta })
    .from(creditLedger)
    .where(
      and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'membership-grant')),
    )
    .orderBy(creditLedger.createdAt, creditLedger.id);
}

/** Drop dog1's membership grants (e.g. so a settle's grant stands alone). */
async function clearMembershipGrantLots(): Promise<void> {
  await db
    .delete(creditLedger)
    .where(
      and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'membership-grant')),
    );
}

/** Drop dog2's membership grants — the shared cleanup is dog1-scoped, so the
 *  simultaneous-endings test (which subscribes dog2 too) clears these itself,
 *  BEFORE the FK-ordered teardown drops the referenced membership charges. */
async function clearDog2GrantLots(): Promise<void> {
  await db
    .delete(creditLedger)
    .where(
      and(eq(creditLedger.dogId, FIXTURE_IDS.dog2Id), eq(creditLedger.reason, 'membership-grant')),
    );
}

test('addMonthsAnchored — end-of-month starts re-snap to the anchor, never drift', () => {
  const jan31 = new Date('2026-01-31T17:00:00Z');
  const feb = addMonthsAnchored(jan31, 1, 31);
  assert.equal(feb.toISOString(), '2026-02-28T17:00:00.000Z', 'clamped to Feb 28');
  const mar = addMonthsAnchored(feb, 1, 31);
  assert.equal(mar.toISOString(), '2026-03-31T17:00:00.000Z', 're-anchors UP to the 31st');
  const apr = addMonthsAnchored(mar, 1, 31);
  assert.equal(apr.toISOString(), '2026-04-30T17:00:00.000Z');
  // Direct multi-month jump matches the chained boundaries' month count.
  assert.equal(addMonthsAnchored(jan31, 3, 31).toISOString(), '2026-04-30T17:00:00.000Z');
});

test(
  'POST /memberships — month-1 charges sync; grant lot expires at period end',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMemberships();
    const { app, stripe } = membershipApp();
    const body = await postMembership(app);

    assert.equal(body.charge_status, 'succeeded');
    assert.equal(body.credits_granted, 5, 'test-school-5 grants 5/month');
    const m = body.membership;
    assert.equal(m.status, 'active');
    assert.equal(m.term_months, 3);
    assert.equal(m.package_key, FIXTURE_IDS.creditPackageSchool5Key);
    assert.equal(m.current_period_start, FIXTURE_TODAY.toISOString());
    assert.equal(m.current_period_end, '2026-06-19T17:00:00.000Z', 'start + 1 anchored month');
    assert.equal(m.ends_at, '2026-08-19T17:00:00.000Z', 'start + term (informational)');
    assert.equal('paused_at' in m, false, 'omit-on-null');

    // One PI at the package price; the grant lot carries the period expiry.
    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 1);

    const lots = await membershipGrantLots();
    assert.equal(lots.length, 1);
    assert.equal(lots[0]!.delta, 5);
    assert.ok(
      lots[0]!.expiresAt?.startsWith('2026-06-19'),
      `lot expires at the period end (§J.1) — got ${lots[0]!.expiresAt}`,
    );

    await cleanupMemberships();
  },
);

test('POST /memberships — alumni dog grant never expires', SKIP_WHEN_NO_DB, async () => {
  await cleanupMemberships();
  await db
    .insert(dogCompletedPrograms)
    .values(CURRICULUM_PROGRAMS.map((program) => ({ dogId: FIXTURE_IDS.dog1Id, program })));

  const { app } = membershipApp();
  await postMembership(app);
  const lots = await membershipGrantLots();
  assert.equal(lots.length, 1);
  assert.equal(lots[0]!.expiresAt, null, '§J.3: alumni lots never expire');

  await cleanupMemberships();
});

test(
  'POST /memberships — non-succeeded intent: 422, PI cancelled, NO membership row',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMemberships();
    const { app, stripe } = membershipApp();
    stripe.setNextIntentStatus('requires_action');

    const res = await app.inject({
      method: 'POST',
      url: '/memberships',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        package_key: FIXTURE_IDS.creditPackageSchool5Key,
        location: 'fayetteville',
        term_months: 6,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(
      stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length,
      1,
      'the unsettleable PI is cancelled (best-effort)',
    );
    const rows = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(rows.length, 0, 'no half-created membership');
  },
);

test('GET /memberships — owner list; staff → 403', SKIP_WHEN_NO_DB, async () => {
  await cleanupMemberships();
  const { app } = membershipApp();
  await postMembership(app);

  const res = await app.inject({ method: 'GET', url: '/memberships' });
  assert.equal(res.statusCode, 200, res.body);
  const list = res.json() as MembershipWire[];
  assert.equal(list.length, 1);
  assert.equal(list[0]!.credits_per_month, 5);
  assert.equal(list[0]!.location, 'fayetteville');
  // §J.1 billing-card display: the list joins the pinned live card.
  assert.deepEqual(list[0]!.payment_method, { brand: 'visa', last4: '4242' });

  const staffRes = await membershipApp({ principal: FIXTURE_STAFF_PRINCIPAL as never }).app.inject({
    method: 'GET',
    url: '/memberships',
  });
  assert.equal(staffRes.statusCode, 403, staffRes.body);

  await cleanupMemberships();
});

test('DELETE /memberships/:id — cancel; re-cancel 409s', SKIP_WHEN_NO_DB, async () => {
  await cleanupMemberships();
  const { app } = membershipApp();
  const created = await postMembership(app);

  const res = await app.inject({
    method: 'DELETE',
    url: `/memberships/${created.membership.id}`,
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as MembershipWire).status, 'canceled');

  const again = await app.inject({
    method: 'DELETE',
    url: `/memberships/${created.membership.id}`,
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(again.statusCode, 409, 'already canceled — not active');

  await cleanupMemberships();
});

test(
  'roll — due membership advances its period + creates the card-backed invoice; paused rows skip',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMemberships();
    const { app } = membershipApp();
    const created = await postMembership(app);
    const membershipId = created.membership.id;

    // Fast-forward: the current period ended an hour ago.
    const now = new Date('2026-06-19T18:00:00Z');
    const result = await withActor(WORKER_ACTOR, (tx) => rollDueMemberships(tx, now));
    assert.equal(result.scanned, 1);
    assert.equal(result.rolled, 1);
    assert.equal(result.completed, 0);

    const [row] = await db
      .select({
        periodStart: memberships.currentPeriodStart,
        periodEnd: memberships.currentPeriodEnd,
        status: memberships.status,
      })
      .from(memberships)
      .where(eq(memberships.id, membershipId));
    assert.ok(row);
    assert.ok(row.periodStart?.startsWith('2026-06-19'), 'new start = old end');
    assert.ok(row.periodEnd?.startsWith('2026-07-19'), 'new end = next anchored boundary');
    assert.equal(row.status, 'active');

    const invoiceRows = await db
      .select({
        amountCents: invoices.amountCents,
        purpose: invoices.purpose,
        dogId: invoices.dogId,
        dueAt: invoices.dueAt,
        status: invoices.status,
      })
      .from(invoices)
      .where(eq(invoices.membershipId, membershipId));
    assert.equal(invoiceRows.length, 1, 'one invoice for the rolled month');
    const invoice = invoiceRows[0]!;
    assert.equal(invoice.purpose, 'membership');
    assert.equal(invoice.status, 'open');
    assert.equal(invoice.dogId, FIXTURE_IDS.dog1Id);
    assert.ok(invoice.dueAt.startsWith('2026-06-19'), 'due at the new period start');
    assert.ok(invoice.amountCents > 0, 'bills the pinned package price');

    // Pause → the next due roll skips it entirely.
    const pauseRes = await staffMembershipApp().app.inject({
      method: 'POST',
      url: `/staff/memberships/${membershipId}/pause`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(pauseRes.statusCode, 200, pauseRes.body);
    const pausedRoll = await withActor(WORKER_ACTOR, (tx) =>
      rollDueMemberships(tx, new Date('2026-07-19T18:00:00Z')),
    );
    assert.equal(pausedRoll.scanned, 0, '§J.1: pause = skip rolling');

    // Resume shifts the boundary by the pause gap — the paid remainder survives.
    const resumeRes = await staffMembershipApp().app.inject({
      method: 'POST',
      url: `/staff/memberships/${membershipId}/resume`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(resumeRes.statusCode, 200, resumeRes.body);

    await cleanupMemberships();
  },
);

test(
  'roll — term exhaustion hard-stops (billed-period COUNT, not dates)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMemberships();
    const { app } = membershipApp();
    const created = await postMembership(app); // term 3 ⇒ month-1 sync + 2 rolled invoices
    const membershipId = created.membership.id;

    // Simulate months 2 and 3 already billed AND settled. `status: 'paid'`
    // matters since the roll-while-parked ruling (2026-07-16): an OPEN
    // invoice now freezes the roll entirely (see membership-roll-parked
    // tests), so only settled months exercise the pure count-based stop.
    await db.insert(invoices).values(
      [1, 2].map(() => ({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 1000,
        purpose: 'membership' as const,
        status: 'paid' as const,
        paidAt: '2026-07-19T17:00:00Z', // DDL: paid implies paid_at
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        dueAt: '2026-07-19T17:00:00Z',
        membershipId,
        dogId: FIXTURE_IDS.dog1Id,
      })),
    );
    // Make the (notionally third) period due.
    await db
      .update(memberships)
      .set({ currentPeriodEnd: '2026-08-19T17:00:00Z' })
      .where(eq(memberships.id, membershipId));

    const result = await withActor(WORKER_ACTOR, (tx) =>
      rollDueMemberships(tx, new Date('2026-08-19T18:00:00Z')),
    );
    assert.equal(result.completed, 1, '1 sync + 2 invoices = 3 billed ⇒ HARD STOP');
    assert.equal(result.rolled, 0);

    const [row] = await db
      .select({ status: memberships.status })
      .from(memberships)
      .where(eq(memberships.id, membershipId));
    assert.equal(row?.status, 'completed');
    const invoiceCount = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.membershipId, membershipId));
    assert.equal(invoiceCount.length, 2, 'no 4th-month invoice was created');

    // §J.1: the hard stop keeps the subscribe page's promise — the owner is
    // told the subscription ended.
    const ended = await db
      .select({
        id: notifications.id,
        deepLinkPath: notifications.deepLinkPath,
        deepLinkKind: notifications.deepLinkKind,
        deepLinkId: notifications.deepLinkId,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, FIXTURE_IDS.ownerId),
          eq(notifications.type, 'membership-ended'),
        ),
      );
    assert.equal(ended.length, 1, 'one membership-ended feed notification');
    // Send-time routing (decision 4): a LONE ending for the owner deep-links to
    // that dog's subscriptions page, carrying ?highlight=<membershipId> so the
    // app one-shot-flashes the specific ended card (R4, 2026-07-28). The
    // structured ref carries the same membership id/kind.
    assert.equal(
      ended[0]?.deepLinkPath,
      `/dog-subscriptions/${FIXTURE_IDS.dog1Id}?highlight=${membershipId}`,
    );
    assert.equal(ended[0]?.deepLinkKind, 'membership');
    assert.equal(ended[0]?.deepLinkId, membershipId);

    await cleanupMemberships();
  },
);

test(
  'roll — simultaneous endings for one owner route to the account overview, not per-dog',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMemberships();
    // dog2's month-1 grant lot isn't covered by the dog1-scoped shared cleanup;
    // clear any leftover so the FK-ordered teardown can drop the membership charges.
    await clearDog2GrantLots();

    // Two memberships, same owner, DIFFERENT dogs (uniqueness is per dog+mode, so
    // two school subs on two dogs coexist). Both term-3, both about to hard-stop.
    const { app } = membershipApp();
    const m1 = (await postMembership(app)).membership; // dog1
    const m2 = (await postMembership(app, { dog_id: FIXTURE_IDS.dog2Id })).membership; // dog2

    // Bring each to the exhausting boundary: 1 sync + 2 settled invoices = 3 =
    // term, and the period is due (mirrors the single-completion hard-stop test).
    for (const m of [m1, m2]) {
      await db.insert(invoices).values(
        [1, 2].map(() => ({
          ownerId: FIXTURE_IDS.ownerId,
          amountCents: 1000,
          purpose: 'membership' as const,
          status: 'paid' as const,
          paidAt: '2026-07-19T17:00:00Z',
          paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
          dueAt: '2026-07-19T17:00:00Z',
          membershipId: m.id,
          dogId: m.dog_id,
        })),
      );
      await db
        .update(memberships)
        .set({ currentPeriodEnd: '2026-08-19T17:00:00Z' })
        .where(eq(memberships.id, m.id));
    }

    // ONE tick claims BOTH due memberships → both hard-stop simultaneously.
    const result = await withActor(WORKER_ACTOR, (tx) =>
      rollDueMemberships(tx, new Date('2026-08-19T18:00:00Z')),
    );
    assert.equal(result.completed, 2, 'both memberships hit the §J.1 hard stop this tick');
    assert.equal(result.rolled, 0);

    // Both membership-ended notifications target the OVERVIEW — the send-time
    // rule drops the dogId param when the owner has multiple simultaneous endings.
    const ended = await db
      .select({ deepLinkPath: notifications.deepLinkPath, deepLinkId: notifications.deepLinkId })
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, FIXTURE_IDS.ownerId),
          eq(notifications.type, 'membership-ended'),
        ),
      );
    assert.equal(ended.length, 2, 'one notification per completed membership (unchanged)');
    assert.ok(
      ended.every((n) => n.deepLinkPath === '/account/memberships'),
      `simultaneous endings → account overview, not per-dog — got ${JSON.stringify(
        ended.map((n) => n.deepLinkPath),
      )}`,
    );
    // The structured ref still points at each distinct membership id.
    assert.deepStrictEqual(
      [...ended.map((n) => n.deepLinkId)].sort(),
      [m1.id, m2.id].sort(),
    );

    await clearDog2GrantLots();
    await cleanupMemberships();
  },
);

test(
  'settleInvoiceCharge — membership branch grants the month lot at period-end expiry',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMemberships();
    const { app } = membershipApp();
    const created = await postMembership(app);
    const membershipId = created.membership.id;

    // Clear the month-1 grant so the settle's grant is the only lot left.
    await clearMembershipGrantLots();

    // The invoice bills the period [Jun 19, Jul 19) — due_at is the period
    // start the roll stamps.
    let invoice: InvoiceRow | undefined;
    await withActor(WORKER_ACTOR, async (tx) => {
      invoice = await invoicesRepository.createOpen(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 12500,
        purpose: 'membership',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        dueAt: '2026-06-19T17:00:00Z',
        dogId: FIXTURE_IDS.dog1Id,
        membershipId,
      });
    });
    assert.ok(invoice);

    const settle = await withActor(WORKER_ACTOR, (tx) =>
      settleInvoiceCharge(tx, {
        invoice: invoice!,
        paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        amountCents: 12500,
        purpose: 'membership',
        notifyOwner: true,
        now: new Date('2026-06-25T12:00:00Z'), // in-period settle
      }),
    );
    assert.equal(settle.outcome, 'settled');

    const lots = await membershipGrantLots();
    assert.equal(lots.length, 1, 'the winning settle granted exactly one lot');
    assert.equal(lots[0]!.delta, 5);
    assert.ok(
      lots[0]!.expiresAt?.startsWith('2026-07-19'),
      `lot expires at the BILLED period's end (due_at + 1 month) — got ${lots[0]!.expiresAt}`,
    );

    const [paid] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice!.id));
    assert.equal(paid?.status, 'paid');

    await cleanupMemberships();
  },
);

test(
  'settleInvoiceCharge — LATE settle of a parked month grants a fresh month, not dead credits',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMemberships();
    const { app } = membershipApp();
    const created = await postMembership(app);
    await clearMembershipGrantLots();

    let invoice: InvoiceRow | undefined;
    await withActor(WORKER_ACTOR, async (tx) => {
      invoice = await invoicesRepository.createOpen(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 12500,
        purpose: 'membership',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        dueAt: '2026-06-19T17:00:00Z', // billed period [Jun 19, Jul 19)
        dogId: FIXTURE_IDS.dog1Id,
        membershipId: created.membership.id,
      });
    });

    // Owner pays the parked invoice on Sep 1 — the billed period is long
    // over. §J late-settle floor: a full month of credits from settle time.
    const settle = await withActor(WORKER_ACTOR, (tx) =>
      settleInvoiceCharge(tx, {
        invoice: invoice!,
        paymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        amountCents: 12500,
        purpose: 'membership',
        notifyOwner: true,
        now: new Date('2026-09-01T12:00:00Z'),
      }),
    );
    assert.equal(settle.outcome, 'settled');
    const lots = await membershipGrantLots();
    assert.equal(lots.length, 1);
    assert.ok(
      lots[0]!.expiresAt?.startsWith('2026-10-01'),
      `late settle grants now + 1 month, never dead-at-birth — got ${lots[0]!.expiresAt}`,
    );

    await cleanupMemberships();
  },
);

test(
  'staff resume — the paid month lot expiry shifts with the period (the clock stops for credits too)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupMemberships();
    const { app } = membershipApp();
    const created = await postMembership(app); // month-1 lot expires 2026-06-19T17:00Z
    const membershipId = created.membership.id;

    // Pause May 20, resume May 22 — the clock stopped for 2 days.
    const pauseApp = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffMembershipsRoute(pauseApp.app, {
      authenticate: pauseApp.authenticate,
      now: () => new Date('2026-05-20T17:00:00Z'),
    });
    const resumeApp = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffMembershipsRoute(resumeApp.app, {
      authenticate: resumeApp.authenticate,
      now: () => new Date('2026-05-22T17:00:00Z'),
    });

    const pauseRes = await pauseApp.app.inject({
      method: 'POST',
      url: `/staff/memberships/${membershipId}/pause`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(pauseRes.statusCode, 200, pauseRes.body);
    const resumeRes = await resumeApp.app.inject({
      method: 'POST',
      url: `/staff/memberships/${membershipId}/resume`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(resumeRes.statusCode, 200, resumeRes.body);
    const resumed = resumeRes.json() as MembershipWire;
    assert.ok(
      resumed.current_period_end.startsWith('2026-06-21'),
      `period end shifted by the 2-day gap — got ${resumed.current_period_end}`,
    );

    const lots = await membershipGrantLots();
    assert.equal(lots.length, 1);
    assert.ok(
      lots[0]!.expiresAt?.startsWith('2026-06-21'),
      `the paid month's lot moved with the period — got ${lots[0]!.expiresAt}`,
    );

    await cleanupMemberships();
  },
);

// Belt-and-suspenders: leave no §J rows behind for later test files.
test('cleanup — memberships fixture state', SKIP_WHEN_NO_DB, async () => {
  await cleanupMemberships();
  const leftover = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(inArray(memberships.ownerId, [FIXTURE_IDS.ownerId]));
  assert.equal(leftover.length, 0);
});
