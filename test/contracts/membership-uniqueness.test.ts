import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  charges,
  creditLedger,
  invoices,
  memberships,
  notifications,
  refunds,
} from '../../src/db/schema/schema.js';
import { membershipsRepository } from '../../src/db/repositories/membershipsRepository.js';
import { withActor } from '../../src/db/tx.js';
import { registerMembershipsRoute, type MembershipWire } from '../../src/routes/memberships.js';
import { FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * Membership uniqueness (Allison ruling 2026-07-16): one ACTIVE membership
 * per (dog, mode). Day-school + daycare may coexist on one dog; two of the
 * same mode may not — even across different packages of that mode.
 *
 * Three enforcement layers under test:
 *   1. the pre-Stripe probe — a friendly 409 BEFORE any money moves
 *   2. the advisory-locked in-tx re-check — a concurrent subscribe that
 *      slipped past the probe during the Stripe round-trip gets its
 *      duplicate charge refunded (settle-lost-race style) and receives the
 *      winner's membership with `charge_refunded: true`
 *   3. the partial unique index — the constraint floor beneath both
 */

registerFixtureHooks();

const WORKER_ACTOR = 'system:scheduler';

interface CreateResponse {
  membership: MembershipWire;
  charge_id: string;
  credits_granted: number;
  charge_refunded: boolean;
}

function membershipApp(stripe: StripeStub): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerMembershipsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return app;
}

async function subscribe(
  app: ReturnType<typeof makeContractApp>['app'],
  packageKey: string,
): Promise<{ statusCode: number; body: string; json: () => CreateResponse }> {
  const res = await app.inject({
    method: 'POST',
    url: '/memberships',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      dog_id: FIXTURE_IDS.dog1Id,
      package_key: packageKey,
      location: 'fayetteville',
      term_months: 3,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
    },
  });
  return {
    statusCode: res.statusCode,
    body: res.body,
    json: () => res.json() as CreateResponse,
  };
}

async function cleanupUniqueness(): Promise<void> {
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.ownerId, FIXTURE_IDS.ownerId),
        eq(notifications.type, 'membership-ended'),
      ),
    );
  await db
    .delete(creditLedger)
    .where(
      and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'membership-grant')),
    );
  await db.delete(invoices).where(isNotNull(invoices.membershipId));
  const membershipCharges = await db
    .select({ id: charges.id })
    .from(charges)
    .where(eq(charges.purpose, 'membership'));
  if (membershipCharges.length > 0) {
    await db.delete(refunds).where(
      inArray(
        refunds.chargeId,
        membershipCharges.map((c) => c.id),
      ),
    );
  }
  await db.delete(charges).where(eq(charges.purpose, 'membership'));
  await db.delete(memberships).where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
}

test(
  'uniqueness — a second same-mode subscribe 409s BEFORE any charge, even for a different package',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupUniqueness();
    const stripe = makeStripeStub();
    const app = membershipApp(stripe);

    const first = await subscribe(app, FIXTURE_IDS.creditPackageSchool10Key);
    assert.equal(first.statusCode, 201, first.body);

    const stripeCallsBefore = stripe.calls.length;
    const second = await subscribe(app, FIXTURE_IDS.creditPackageSchool5Key);
    assert.equal(second.statusCode, 409, second.body);
    assert.match(second.body, /already has an active school membership/);
    assert.equal(
      stripe.calls.length,
      stripeCallsBefore,
      'the 409 fired before Stripe — no money moved',
    );

    await cleanupUniqueness();
  },
);

test(
  'uniqueness — day-school and daycare memberships coexist on one dog',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupUniqueness();
    const app = membershipApp(makeStripeStub());

    const school = await subscribe(app, FIXTURE_IDS.creditPackageSchool10Key);
    assert.equal(school.statusCode, 201, school.body);
    const daycare = await subscribe(app, FIXTURE_IDS.creditPackageDaycare8Key);
    assert.equal(daycare.statusCode, 201, daycare.body);

    const active = await db
      .select({ mode: memberships.mode })
      .from(memberships)
      .where(and(eq(memberships.dogId, FIXTURE_IDS.dog1Id), eq(memberships.status, 'active')));
    assert.deepStrictEqual(active.map((m) => m.mode).sort(), ['daycare', 'school']);

    await cleanupUniqueness();
  },
);

test('uniqueness — a canceled membership frees the (dog, mode) slot', SKIP_WHEN_NO_DB, async () => {
  await cleanupUniqueness();
  const app = membershipApp(makeStripeStub());

  const first = await subscribe(app, FIXTURE_IDS.creditPackageSchool10Key);
  assert.equal(first.statusCode, 201, first.body);
  const cancel = await app.inject({
    method: 'DELETE',
    url: `/memberships/${first.json().membership.id}`,
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(cancel.statusCode, 200, cancel.body);

  const again = await subscribe(app, FIXTURE_IDS.creditPackageSchool5Key);
  assert.equal(again.statusCode, 201, 'canceled no longer blocks the slot');

  await cleanupUniqueness();
});

test(
  'uniqueness — a PAUSED membership still blocks (it is active and resumes into the slot)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupUniqueness();
    const app = membershipApp(makeStripeStub());

    const first = await subscribe(app, FIXTURE_IDS.creditPackageSchool10Key);
    assert.equal(first.statusCode, 201, first.body);
    await db
      .update(memberships)
      .set({ pausedAt: FIXTURE_TODAY.toISOString() })
      .where(eq(memberships.id, first.json().membership.id));

    const second = await subscribe(app, FIXTURE_IDS.creditPackageSchool5Key);
    assert.equal(second.statusCode, 409, 'paused = still active = still unique');

    await cleanupUniqueness();
  },
);

test(
  'uniqueness — a concurrent subscribe that wins during the Stripe round-trip gets the loser refunded',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupUniqueness();
    const base = makeStripeStub();
    // Deterministic race: the winner's membership lands DURING the loser's
    // Stripe call — after the route's pre-Stripe probe, before its tx.
    let winnerId: string | undefined;
    const stripe: StripeStub = {
      ...base,
      async createAndConfirmPaymentIntent(args, idempotencyKey) {
        if (winnerId === undefined) {
          await withActor(WORKER_ACTOR, async (tx) => {
            const winner = await membershipsRepository.createActive(tx, {
              ownerId: FIXTURE_IDS.ownerId,
              dogId: FIXTURE_IDS.dog1Id,
              mode: 'school',
              packageId: FIXTURE_IDS.creditPackageSchool5Id,
              termMonths: 3,
              paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
              startedAt: FIXTURE_TODAY,
              currentPeriodStart: FIXTURE_TODAY,
              currentPeriodEnd: new Date('2026-06-19T17:00:00Z'),
              endsAt: new Date('2026-08-19T17:00:00Z'),
            });
            winnerId = winner.id;
          });
        }
        return base.createAndConfirmPaymentIntent(args, idempotencyKey);
      },
    };
    const app = membershipApp(stripe);

    const loser = await subscribe(app, FIXTURE_IDS.creditPackageSchool10Key);
    assert.equal(loser.statusCode, 201, loser.body);
    const body = loser.json();
    assert.equal(body.charge_refunded, true, 'honest lost-race signal');
    assert.equal(body.credits_granted, 0, 'the duplicate never grants');
    assert.equal(body.membership.id, winnerId, 'the winner membership is returned');

    // Exactly one active (dog, school) membership survived the race.
    const active = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.dogId, FIXTURE_IDS.dog1Id),
          eq(memberships.mode, 'school'),
          eq(memberships.status, 'active'),
        ),
      );
    assert.deepStrictEqual(
      active.map((m) => m.id),
      [winnerId],
    );

    // The duplicate charge's refund row committed in-tx and the post-commit
    // Stripe refund stamped its re_* id.
    const [refund] = await db
      .select({ stripeRefundId: refunds.stripeRefundId, amountCents: refunds.amountCents })
      .from(refunds)
      .where(eq(refunds.chargeId, body.charge_id));
    assert.ok(refund, 'a refund row exists for the duplicate charge');
    assert.ok(refund.stripeRefundId?.startsWith('re_'), 'post-commit Stripe refund fired');
    assert.ok(
      base.calls.some((c) => c.method === 'createRefund'),
      'Stripe saw the refund call',
    );

    // No grant lot landed for the duplicate (the winner was inserted
    // directly, so zero membership-grant lots total).
    const lots = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.dogId, FIXTURE_IDS.dog1Id),
          eq(creditLedger.reason, 'membership-grant'),
        ),
      );
    assert.equal(lots.length, 0);

    await cleanupUniqueness();
  },
);

test(
  'uniqueness — the partial unique index is the floor: a second active (dog, mode) row is impossible',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupUniqueness();
    const insertActive = (): Promise<unknown> =>
      withActor(WORKER_ACTOR, (tx) =>
        membershipsRepository.createActive(tx, {
          ownerId: FIXTURE_IDS.ownerId,
          dogId: FIXTURE_IDS.dog1Id,
          mode: 'school',
          packageId: FIXTURE_IDS.creditPackageSchool5Id,
          termMonths: 3,
          paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
          startedAt: FIXTURE_TODAY,
          currentPeriodStart: FIXTURE_TODAY,
          currentPeriodEnd: new Date('2026-06-19T17:00:00Z'),
          endsAt: new Date('2026-08-19T17:00:00Z'),
        }),
      );

    await insertActive();
    await assert.rejects(insertActive(), (err: { code?: string }) => {
      assert.equal(err.code, '23505', 'unique_violation from the partial index');
      return true;
    });

    await cleanupUniqueness();
  },
);
