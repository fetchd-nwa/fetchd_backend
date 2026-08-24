import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray, sql, sql as sqlRaw } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  bookingDogs as bookingDogsTable,
  charges,
  cohorts as cohortsTable,
  creditLedger,
  invoices,
  memberships,
  notifications,
  refunds,
} from '../../src/db/schema/schema.js';
import { membershipsRepository } from '../../src/db/repositories/membershipsRepository.js';
import {
  REFUND_SWEEP_FLOOR,
  refundsRepository,
} from '../../src/db/repositories/refundsRepository.js';
import { withActor } from '../../src/db/tx.js';
import {
  IDEMPOTENCY_KEY_MAX_LEN,
  STRIPE_DERIVED_KEY_SUFFIXES,
  STRIPE_IDEMPOTENCY_KEY_MAX_LEN,
  requireIdempotencyKey,
} from '../../src/db/mutation.js';
import { cancelBookingInTx } from '../../src/lib/cancelBookingService.js';
import { refundCreateParams } from '../../src/lib/pendingRefund.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerMembershipsRoute } from '../../src/routes/memberships.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { runDuplicateRefundRetryOnce } from '../../src/workers/duplicateRefundRetry.js';
import { clearInvoiceChargeAttempts, FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * `designs/client-keyed-refund-recovery.md` — the money owed back that nothing
 * retried.
 *
 * THE DEFECT. Four writers mint a `'pending'` refunds row inside a transaction
 * and fire the Stripe `createRefund` after commit. Three of them — booking
 * cancel (owner and staff), group-class withdraw, and the membership subscribe
 * lost-race — keyed that call on the CLIENT's request `Idempotency-Key`, a
 * string that exists only inside that request's closure. So when the
 * post-commit call failed (a rate limit, a 500, a dropped connection) the row
 * sat `'pending'` forever: the retry sweep could not re-fire it, because
 * re-firing under a key Stripe has never seen is not a replay — it is a SECOND
 * full refund of somebody's money — and a webhook cannot arrive for a refund
 * that was never created. The owner's money simply never came back, and the
 * only trace was one log line.
 *
 * THE FIX these pins exist for: the exact key is written onto the row in the
 * same transaction that mints it (`refunds.stripe_idempotency_key`), so the
 * sweep can send precisely what the first attempt sent. Every test below either
 * proves a refund comes BACK that previously would not have, or proves the
 * sweep still refuses a row whose key it cannot know.
 *
 * WALL-CLOCK DISCIPLINE (the fixture-clock class has bitten six times). The
 * `refunds_touch` trigger overwrites `updated_at` with REAL `now()` on ANY
 * update, so pinning `updated_at` through the ORM is a silent no-op. Every test
 * that needs a CLAIMABLE row therefore anchors `created_at` to real now minus
 * minutes and runs the sweep with an injected clock minutes AHEAD of the wall —
 * the pattern the two wall-anchored tests in
 * `invoice-attempt-unknown-outcome.test.ts` established.
 */

registerFixtureHooks();

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const ONE_HOUR_MS = HOUR;
const FIXTURE_NOW_MS = FIXTURE_TODAY.getTime();
const SIX_WEEKS_OUT_UTC = '2026-07-06T23:00:00Z';

/**
 * An instant a few minutes ahead of the wall clock. The claim's staleness bound
 * reads the trigger-stamped `updated_at`, which is real `now()`; anything at or
 * behind the wall would leave a freshly minted row un-claimable and the test
 * would pass for the wrong reason.
 */
function sweepNow(): Date {
  return new Date(Date.now() + 10 * MINUTE);
}

/** Make a just-minted refund row old enough to clear the 5-minute grace. */
async function ageIntoTheClaimWindow(refundId: string): Promise<void> {
  await db
    .update(refunds)
    .set({ createdAt: new Date(Date.now() - 10 * MINUTE).toISOString() })
    .where(eq(refunds.id, refundId));
}

async function cleanup(): Promise<void> {
  await clearInvoiceChargeAttempts();
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(creditLedger)
    .where(
      and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'membership-grant')),
    );
  await db.delete(memberships).where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.ownerId, FIXTURE_IDS.ownerId),
        inArray(notifications.type, ['booking-cancelled', 'membership-ended', 'payment-succeeded']),
      ),
    );
}

function collectLogs() {
  const errors: { obj: Record<string, unknown>; msg?: string }[] = [];
  const infos: { obj: Record<string, unknown>; msg?: string }[] = [];
  // Warns are captured, not swallowed: the round-2 adversary proved the 409
  // arm's warn could be deleted with the suite staying green because this
  // helper dropped them (2026-08-20).
  const warns: { obj: Record<string, unknown>; msg?: string }[] = [];
  return {
    errors,
    infos,
    warns,
    log: {
      info: (obj: Record<string, unknown>, msg?: string) => infos.push({ obj, msg }),
      warn: (obj: Record<string, unknown>, msg?: string) => warns.push({ obj, msg }),
      error: (obj: Record<string, unknown>, msg?: string) => errors.push({ obj, msg }),
    },
    error: (refundClass: string) => errors.find((e) => e.obj.refundClass === refundClass),
  };
}

async function readRefund(id: string) {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, id));
  return row;
}

/** The one refund row this owner has, for tests that mint exactly one. */
async function theOnlyRefund() {
  const rows = await db.select().from(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  assert.equal(rows.length, 1, `expected exactly one refunds row, saw ${rows.length}`);
  return rows[0]!;
}

// ── writer seams ──────────────────────────────────────────────────────────

function cancelApp(stripe: StripeStub) {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW, stripe });
  return app;
}

function staffCancelApp(stripe: StripeStub) {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffBookingsRoute(app, { authenticate, now: FIXTURE_NOW, stripe });
  return app;
}

/**
 * A money-paid booking inside its cancel window, with a succeeded charge behind
 * it. `withPaymentIntent: false` is the pre-Stripe-wire seed shape that mints
 * an `'unroutable'` refund instead of a `'pending'` one.
 */
async function seedMoneyPaidBooking(
  opts: { amountCents?: number; withPaymentIntent?: boolean } = {},
): Promise<{
  bookingId: string;
  chargeId: string;
  amountCents: number;
  paymentIntentId: string | null;
}> {
  const amountCents = opts.amountCents ?? 9_500;
  const bookingId = randomUUID();
  await db.insert(bookingsTable).values({
    id: bookingId,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: FIXTURE_IDS.dog1Id,
    category: 'private-lesson',
    status: 'upcoming',
    scheduledAt: new Date(FIXTURE_NOW_MS + 96 * ONE_HOUR_MS).toISOString(),
    cancelDeadlineAt: new Date(FIXTURE_NOW_MS + 48 * ONE_HOUR_MS).toISOString(),
    location: null,
  });
  await db.insert(bookingDogsTable).values({ bookingId, dogId: FIXTURE_IDS.dog1Id, isLead: true });
  const chargeId = randomUUID();
  const paymentIntentId =
    opts.withPaymentIntent === false ? null : `pi_test_${randomUUID().slice(0, 8)}`;
  await db.insert(charges).values({
    id: chargeId,
    ownerId: FIXTURE_IDS.ownerId,
    bookingId,
    amountCents,
    status: 'succeeded',
    purpose: 'payg',
    stripePaymentIntentId: paymentIntentId,
  });
  return { bookingId, chargeId, amountCents, paymentIntentId };
}

/**
 * Tell every stub that will touch this PaymentIntent how much of it is actually
 * refundable — i.e. arm the stub's cumulative cap.
 *
 * Necessary because the cap is only enforced for a PI the stub KNOWS
 * (`_stripeStub.ts`: `declaredRefundable ?? intents.get(pi)?.amountCents`, and
 * an unknown cap is deliberately not enforced). Every charge in this file is
 * hand-seeded straight into Postgres with a literal `pi_test_*` id the stub
 * never minted, so without this the cap was silently absent on every sweep path
 * and "an over-refund goes structurally red" held only in one hand-armed unit
 * test (adversary round 3, 2026-08-20).
 *
 * Armed on BOTH the route's stub and the sweeper's where a test uses two: they
 * model independent Stripe views, and the one that must refuse an over-refund
 * is whichever actually executes.
 */
function armRefundCap(
  paymentIntentId: string | null,
  amountCents: number,
  ...stubs: readonly StripeStub[]
): void {
  assert.ok(paymentIntentId, 'armRefundCap needs a PaymentIntent — seed one with a PI');
  for (const stub of stubs) stub.setRefundableBalance(paymentIntentId, amountCents);
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Each writer × recovery — the money comes back
// ──────────────────────────────────────────────────────────────────────────

test(
  'owner cancel: a money-back refund whose Stripe call fails is retried under the EXACT key the row stored',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents, paymentIntentId } = await seedMoneyPaidBooking();
    const stripe = makeStripeStub();
    // The failure this whole design exists for: the post-commit call throws,
    // so nothing at Stripe knows about the refund and — before the stored key —
    // nothing anywhere could ever try again.
    stripe.throwOnRefund();
    const requestKey = `cancel-${randomUUID()}`;
    const res = await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': requestKey },
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await theOnlyRefund();
    assert.equal(row.status, 'pending');
    assert.equal(row.stripeRefundId, null, 'nothing at Stripe knows about this refund');
    assert.equal(
      row.stripeIdempotencyKey,
      `${requestKey}:refund`,
      'the row carries the CLIENT-derived key its own fire used — the entire point',
    );

    await ageIntoTheClaimWindow(row.id);
    const sweeper = makeStripeStub();
    armRefundCap(paymentIntentId, amountCents, stripe, sweeper);
    const tick = await runDuplicateRefundRetryOnce({ stripe: sweeper, now: sweepNow() });
    assert.equal(tick.scanned, 1, 'a class of row the sweep could not previously touch');
    assert.equal(tick.sent, 1);

    const retried = sweeper.calls.filter((c) => c.method === 'createRefund');
    assert.equal(retried.length, 1);
    assert.equal(
      retried[0]?.idempotencyKey,
      `${requestKey}:refund`,
      'the SAME key the route used — a different one would refund the owner twice',
    );
    assert.equal(
      retried[0]?.method === 'createRefund' ? retried[0].args.amountCents : undefined,
      amountCents,
    );
    assert.ok((await readRefund(row.id))?.stripeRefundId, 'the re_* id closes the row');

    // And it leaves the worklist for good.
    const second = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: new Date(sweepNow().getTime() + HOUR),
    });
    assert.equal(second.scanned, 0);
    assert.equal(sweeper.calls.filter((c) => c.method === 'createRefund').length, 1);
    await cleanup();
  },
);

test(
  'staff cancel: the cross-owner cancel stores its key too — one transaction, one contract',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents, paymentIntentId } = await seedMoneyPaidBooking({
      amountCents: 7_700,
    });
    const stripe = makeStripeStub();
    stripe.throwOnRefund();
    const requestKey = `staff-cancel-${randomUUID()}`;
    const res = await staffCancelApp(stripe).inject({
      method: 'POST',
      url: `/staff/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': requestKey },
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await theOnlyRefund();
    assert.equal(row.stripeIdempotencyKey, `${requestKey}:refund`);
    await ageIntoTheClaimWindow(row.id);

    const sweeper = makeStripeStub();
    armRefundCap(paymentIntentId, amountCents, stripe, sweeper);
    const tick = await runDuplicateRefundRetryOnce({ stripe: sweeper, now: sweepNow() });
    assert.equal(tick.sent, 1);
    assert.equal(
      sweeper.calls.find((c) => c.method === 'createRefund')?.idempotencyKey,
      `${requestKey}:refund`,
    );
    await cleanup();
  },
);

test(
  'membership lost-race: the duplicate charge comes back even when the post-commit refund fails',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const base = makeStripeStub();
    // Deterministic race: the winner's membership lands DURING the loser's
    // Stripe call — after the route's pre-Stripe probe, before its tx.
    let winnerId: string | undefined;
    const racing: StripeStub = {
      ...base,
      async createAndConfirmPaymentIntent(args, idempotencyKey) {
        if (winnerId === undefined) {
          await withActor('system:scheduler', async (tx) => {
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
    base.throwOnRefund();

    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerMembershipsRoute(app, { authenticate, stripe: racing, now: FIXTURE_NOW });
    const requestKey = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/memberships',
      headers: { 'idempotency-key': requestKey },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        package_key: FIXTURE_IDS.creditPackageSchool10Key,
        location: 'fayetteville',
        term_months: 3,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((res.json() as { charge_refunded: boolean }).charge_refunded, true);

    const row = await theOnlyRefund();
    assert.equal(row.status, 'pending');
    assert.equal(row.stripeRefundId, null, 'the post-commit refund threw');
    assert.equal(
      row.stripeIdempotencyKey,
      `${requestKey}:dup-subscribe-refund`,
      'this writer keeps its own key spelling — storage does not re-key anyone',
    );

    await ageIntoTheClaimWindow(row.id);
    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({ stripe: sweeper, now: sweepNow() });
    assert.equal(tick.sent, 1, 'an owner double-charged for a membership gets it back');
    assert.equal(
      sweeper.calls.find((c) => c.method === 'createRefund')?.idempotencyKey,
      `${requestKey}:dup-subscribe-refund`,
    );
    await cleanup();
  },
);

test(
  'group-class withdraw: a failed refund is retried under the stored key',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const cohortId = randomUUID();
    await db.insert(cohortsTable).values({
      id: cohortId,
      classKey: 'puppy',
      location: 'fayetteville',
      startDate: SIX_WEEKS_OUT_UTC,
      endDate: null,
      weeklyTime: '6:00 PM',
      weeks: 4,
      capacity: 6,
      filled: 0,
    });
    const stripe = makeStripeStub();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });

    const enrolled = await app.inject({
      method: 'POST',
      url: '/enrollments',
      headers: { 'idempotency-key': `enr-${randomUUID()}` },
      payload: {
        cohort_id: cohortId,
        dog_ids: [FIXTURE_IDS.dog1Id],
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        pay_later: false,
      },
    });
    assert.equal(enrolled.statusCode, 201, enrolled.body);

    stripe.throwOnRefund();
    const requestKey = `wd-${randomUUID()}`;
    const res = await app.inject({
      method: 'POST',
      url: `/enrollments/${cohortId}/withdraw`,
      headers: { 'idempotency-key': requestKey },
      payload: { dog_id: FIXTURE_IDS.dog1Id },
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await theOnlyRefund();
    assert.equal(row.status, 'pending');
    assert.equal(row.stripeRefundId, null);
    assert.equal(row.stripeIdempotencyKey, `${requestKey}:refund`);

    await ageIntoTheClaimWindow(row.id);
    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({ stripe: sweeper, now: sweepNow() });
    assert.equal(tick.sent, 1);
    assert.equal(
      sweeper.calls.find((c) => c.method === 'createRefund')?.idempotencyKey,
      `${requestKey}:refund`,
    );
    // `cleanup()` FIRST: since §A3.17 a group-class charge carries its
    // enrollment's anchor in `charges.booking_id`, and that FK has no
    // `ON DELETE`, so dropping the bookings while their charge is still on
    // disk raises 23503. Same order the fixture teardown already uses
    // (`_fixture.ts` — charges, then bookings).
    await cleanup();
    await db.delete(bookingsTable).where(eq(bookingsTable.cohortId, cohortId));
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 2. THE money assertion — a retry REPLAYS, it never executes a second refund
// ──────────────────────────────────────────────────────────────────────────

test(
  'lost response, not lost request: the retry replays the ORIGINAL refund and Stripe executes exactly one',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents, paymentIntentId } = await seedMoneyPaidBooking({
      amountCents: 6_400,
    });
    const stripe = makeStripeStub();
    // THE case the same-key rule exists for: the refund LANDED at Stripe and
    // only the response was lost. Our row still says 'pending', so the sweep
    // will try again — and if it tried under a fresh key, the owner would be
    // paid back twice out of the school's pocket.
    stripe.refundLandsThenThrows();
    // Armed to EXACTLY the charge amount, which is what makes the assertion
    // below load-bearing: if the sweep executed a second refund instead of
    // replaying the first, it would exceed this cap and Stripe would refuse it.
    // The test then reds on the refusal as well as on the count.
    armRefundCap(paymentIntentId, amountCents, stripe);
    const requestKey = `replay-${randomUUID()}`;
    const res = await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': requestKey },
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await theOnlyRefund();
    assert.equal(row.stripeRefundId, null, 'we never learned the id');
    const landed = stripe.executedRefunds();
    assert.equal(landed.length, 1, 'Stripe holds one refund for this money');
    await ageIntoTheClaimWindow(row.id);

    // The sweep runs against the SAME Stripe (same idempotency memory) — the
    // whole assertion is meaningless against a fresh stub.
    const tick = await runDuplicateRefundRetryOnce({ stripe, now: sweepNow() });
    assert.equal(tick.sent, 1);
    assert.equal(
      stripe.executedRefunds().length,
      1,
      'STILL one refund: the retry replayed rather than executing a second',
    );
    assert.equal(
      (await readRefund(row.id))?.stripeRefundId,
      landed[0]?.id,
      'and the row closes on the id of the refund that actually exists',
    );
    assert.equal(
      stripe.executedRefunds()[0]?.amountCents,
      amountCents,
      'the owner is made whole exactly once',
    );
    await cleanup();
  },
);

test(
  'a MIS-SPELLED retry key is not a replay — the stub refuses to hide a second refund',
  SKIP_WHEN_NO_DB,
  async () => {
    // The mutation guard for the test above, run as a test rather than left as
    // a claim in a hand-back: if the sweep sent a key one character different,
    // Stripe executes a SECOND refund. This asserts the stub can SEE that,
    // which is the only reason the replay assertion above means anything.
    const stripe = makeStripeStub();
    // Capped at 2x on purpose. This test's whole point is that a drifted key
    // EXECUTES A SECOND REFUND, so it must be allowed to — capping at 1x would
    // make it red on the cap and stop demonstrating the thing it exists to
    // demonstrate. The explicit 2x states that the doubling is expected here and
    // nowhere else (adversary round 3, 2026-08-20).
    stripe.setRefundableBalance('pi_test_probe', 10_000);
    const params = refundCreateParams({ paymentIntentId: 'pi_test_probe', amountCents: 5_000 });
    const first = await stripe.createRefund(params, 'the-key');
    const replayed = await stripe.createRefund(params, 'the-key');
    assert.equal(replayed.id, first.id, 'same key + same params → the same refund object');
    const different = await stripe.createRefund(params, 'the-keyX');
    assert.notEqual(different.id, first.id, 'one character of drift is a SECOND refund');
    assert.equal(stripe.executedRefunds().length, 2, 'and the stub counts both');
  },
);

test(
  'same key, drifted params is an idempotency_error — no money moves, loudly',
  SKIP_WHEN_NO_DB,
  async () => {
    const stripe = makeStripeStub();
    await stripe.createRefund(
      refundCreateParams({ paymentIntentId: 'pi_test_drift', amountCents: 5_000 }),
      'drift-key',
    );
    await assert.rejects(
      () =>
        stripe.createRefund(
          refundCreateParams({ paymentIntentId: 'pi_test_drift', amountCents: 4_000 }),
          'drift-key',
        ),
      /idempotent/i,
      'Stripe refuses a key reused with different parameters — 400, nothing moves',
    );
    assert.equal(stripe.executedRefunds().length, 1);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 3. The params byte-equality pin (arm 4's regression guard)
// ──────────────────────────────────────────────────────────────────────────

test(
  'the post-commit fire and the sweep retry send byte-identical params for the same row',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents, paymentIntentId } = await seedMoneyPaidBooking({
      amountCents: 8_800,
    });
    const stripe = makeStripeStub();
    stripe.throwOnRefund();
    const requestKey = `params-${randomUUID()}`;
    await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': requestKey },
      payload: {},
    });
    const fired = stripe.calls.find((c) => c.method === 'createRefund');
    assert.ok(fired, 'the route attempted the refund');

    const row = await theOnlyRefund();
    await ageIntoTheClaimWindow(row.id);
    const sweeper = makeStripeStub();
    armRefundCap(paymentIntentId, amountCents, stripe, sweeper);
    await runDuplicateRefundRetryOnce({ stripe: sweeper, now: sweepNow() });
    const retried = sweeper.calls.find((c) => c.method === 'createRefund');
    assert.ok(retried);

    // Byte-equal, not merely equivalent: a same-key call whose params differ in
    // ANY field is an `idempotency_error` at Stripe, so the refund would never
    // land at all. One shared constructor is what makes this true; this pin is
    // what watches the constructor.
    assert.deepEqual(retried.args, fired.args);
    assert.equal(JSON.stringify(retried.args), JSON.stringify(fired.args));
    assert.equal(retried.idempotencyKey, fired.idempotencyKey);
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 4. NULL-key rows stay untouchable — the widened claim must not resurrect F1
// ──────────────────────────────────────────────────────────────────────────

test(
  'a row with NO stored key is never claimed, however ordinary it looks',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId } = await seedMoneyPaidBooking({ amountCents: 5_100 });
    const stripe = makeStripeStub();
    stripe.throwOnRefund();
    await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': `nullkey-${randomUUID()}` },
      payload: {},
    });
    const row = await theOnlyRefund();
    await ageIntoTheClaimWindow(row.id);
    // Forge what a PRE-2026-08-19 row looks like on disk. This is the shape the
    // sweep must never touch: `reason='cancel'`, real PaymentIntent, fresh, and
    // no way on earth to know what key its first attempt used.
    await db.update(refunds).set({ stripeIdempotencyKey: null }).where(eq(refunds.id, row.id));
    assert.equal((await readRefund(row.id))?.stripeIdempotencyKey, null, 'the mutation LANDED');

    const logs = collectLogs();
    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: sweepNow(),
      log: logs.log,
    });
    assert.equal(tick.scanned, 0, 'not this sweep’s row to key');
    assert.equal(
      sweeper.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'a retry under a key Stripe never saw is how one refund becomes two',
    );
    assert.equal((await readRefund(row.id))?.stripeRefundId, null, 'untouched');
    await cleanup();
  },
);

test(
  'the stored-key lane does not smuggle a pre-floor duplicate-invoice-settle row into the claim',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // Round 4's floor exists because `reason` alone cannot say who keyed a row.
    // The new OR-lane must not reopen that: a row below the floor with no
    // stored key stays unclaimable, and the control on the other side of the
    // same call proves the query is not simply inert.
    const [charge] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 5_000,
        status: 'succeeded',
        purpose: 'group-class',
        stripePaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: charges.id });
    const mint = async (createdAt: Date, key: string | null): Promise<string> => {
      const [row] = await db
        .insert(refunds)
        .values({
          ownerId: FIXTURE_IDS.ownerId,
          chargeId: charge!.id,
          bookingId: null,
          amountCents: 5_000,
          reason: 'duplicate-invoice-settle',
          stripeIdempotencyKey: key,
        })
        .returning({ id: refunds.id });
      await db
        .update(refunds)
        .set({ createdAt: createdAt.toISOString() })
        .where(eq(refunds.id, row!.id));
      return row!.id;
    };
    // Derived from the constant, never a literal: round 4's own rule is that
    // this floor MUST be advanced if the branch does not deploy on its date, and
    // a hardcoded copy would red this suite the day someone follows that rule.
    const FLOOR_MS = REFUND_SWEEP_FLOOR.getTime();
    const preFloorNoKey = await mint(new Date(FLOOR_MS - 12 * HOUR), null);
    const postFloorNoKey = await mint(new Date(FLOOR_MS + 1 * HOUR), null);

    const claimed = await withActor('system:stripe-webhook', (tx) =>
      refundsRepository.claimStalePendingForRetry(tx, {
        staleBefore: new Date(Date.now() + HOUR),
        // Deliberately wide: with the abandon bound opened past the floor, the
        // FLOOR is the only thing that can exclude either row.
        mintedAfter: new Date(FLOOR_MS - 24 * HOUR),
      }),
    );
    assert.deepEqual(
      claimed.map((r) => r.id),
      [postFloorNoKey],
      'the legacy lane keeps round 4’s floor, verbatim',
    );
    assert.equal(
      claimed.some((r) => r.id === preFloorNoKey),
      false,
    );
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 5. 'unroutable' — money owed with no route, said once instead of forever
// ──────────────────────────────────────────────────────────────────────────

test(
  'a cancel against a charge with no PaymentIntent mints a TERMINAL row, not a worklist entry',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents } = await seedMoneyPaidBooking({
      amountCents: 4_200,
      withPaymentIntent: false,
    });
    const stripe = makeStripeStub();
    const res = await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': `unroutable-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await theOnlyRefund();
    assert.equal(row.status, 'unroutable', 'terminal at mint — there is nothing to send');
    assert.equal(row.amountCents, amountCents, 'the obligation is still RECORDED, not skipped');
    assert.equal(row.stripeIdempotencyKey, null, 'there is no Stripe call to key');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'and nothing was sent to Stripe for a charge Stripe never had',
    );

    // It counts toward the cumulative cap: nothing may double-mint against it.
    const summed = await withActor('system:scheduler', (tx) =>
      refundsRepository.sumNonFailedForCharge(tx, row.chargeId),
    );
    assert.equal(summed, amountCents, 'an unroutable refund still occupies the charge');

    // And it is invisible to every automatic worklist, forever.
    const logs = collectLogs();
    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: sweepNow(),
      log: logs.log,
    });
    assert.equal(tick.scanned, 0);
    assert.equal(tick.abandoned, 0, 'it is not owed-money-with-a-route, so it is not reported');
    assert.equal(logs.errors.length, 0, 'and it is not re-shouted on a later tick');
    await cleanup();
  },
);

test(
  'a legacy never-sent pending row is flipped terminal ONCE, and the report stops carrying it forever',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // The seed-era shape F3 was about: 'pending', never sent, and behind it a
    // charge with no PaymentIntent. Before the flip these sat on the report on
    // every tick of every process, forever, under an instruction — "refund it
    // in the dashboard" — that no human could follow.
    const [charge] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 3_300,
        status: 'succeeded',
        purpose: 'payg',
        stripePaymentIntentId: null,
      })
      .returning({ id: charges.id });
    const [legacy] = await db
      .insert(refunds)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: charge!.id,
        bookingId: null,
        amountCents: 3_300,
        reason: 'cancel',
        stripeIdempotencyKey: null,
      })
      .returning({ id: refunds.id });

    const logs = collectLogs();
    const sweeper = makeStripeStub();
    const first = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: sweepNow(),
      log: logs.log,
    });
    assert.equal(first.abandonedByClass['never-sent'], 0, 'flipped before the report reads it');
    assert.equal((await readRefund(legacy!.id))?.status, 'unroutable');
    const announced = logs.error('unroutable');
    assert.ok(announced, 'the flip is announced at ERROR — this is owed money');
    assert.match(JSON.stringify(announced.obj.refunds), new RegExp(legacy!.id));

    // The flip IS the memory: a second tick — and, unlike `ALARMED_REFUND_IDS`,
    // a whole new process — says nothing.
    const secondLogs = collectLogs();
    const second = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: new Date(sweepNow().getTime() + HOUR),
      log: secondLogs.log,
    });
    assert.equal(second.abandoned, 0);
    assert.equal(secondLogs.errors.length, 0, 'said once, not on every tick until someone acts');
    assert.equal(
      sweeper.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'and no tick ever tried to send it',
    );
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 6. The abandon bound — 24h stops the retry, and hands over the key
// ──────────────────────────────────────────────────────────────────────────

test(
  'a stored-key row past the 24h window is NOT retried, and the report hands the human its exact key',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId } = await seedMoneyPaidBooking({ amountCents: 11_000 });
    const stripe = makeStripeStub();
    stripe.throwOnRefund();
    const requestKey = `aged-${randomUUID()}`;
    await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': requestKey },
      payload: {},
    });
    const row = await theOnlyRefund();
    // Older than Stripe keeps a key: a same-key call is no longer guaranteed to
    // REPLAY, and a fresh execution would be a second refund of real money.
    await db
      .update(refunds)
      .set({ createdAt: sql`now() - interval '30 hours'` })
      .where(eq(refunds.id, row.id));

    const logs = collectLogs();
    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: sweepNow(),
      log: logs.log,
    });
    assert.equal(tick.scanned, 0, 'past the window the sweep stops');
    assert.equal(
      sweeper.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'on a key Stripe may have forgotten, silence is the safe direction',
    );
    assert.equal(tick.abandoned, 1);
    assert.equal(
      tick.abandonedByClass['row-keyed'],
      1,
      'a stored key makes this row-keyed: the human can look it up',
    );
    const alarm = logs.error('row-keyed');
    assert.ok(alarm);
    assert.match(
      JSON.stringify(alarm.obj.refunds),
      new RegExp(`${requestKey}:refund`),
      'the STORED key is printed — not a key derived from the row, which would be a lie',
    );
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 7. The last unwatched class: a refund Stripe created and then FAILED
// ──────────────────────────────────────────────────────────────────────────

test(
  'a refund Stripe failed after creating it is reported once per process — money that did not return',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const [charge] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 2_500,
        status: 'succeeded',
        purpose: 'payg',
        stripePaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: charges.id });
    // What the webhook leaves behind (R18/R19): the refund WAS created, Stripe
    // then failed it — a closed card account — and the row left every worklist.
    // The money never returned and nothing anywhere said so again.
    const failedRefundId = `re_test_${randomUUID().slice(0, 8)}`;
    const [row] = await db
      .insert(refunds)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: charge!.id,
        bookingId: null,
        amountCents: 2_500,
        reason: 'cancel',
        status: 'failed',
        stripeRefundId: failedRefundId,
        stripeIdempotencyKey: `some-key:refund`,
      })
      .returning({ id: refunds.id });

    const logs = collectLogs();
    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: sweepNow(),
      log: logs.log,
    });
    assert.equal(tick.scanned, 0, 'a failed refund is never retried — its identity is spent');
    assert.equal(tick.abandonedByClass['stripe-failed'], 1);
    const alarm = logs.error('stripe-failed');
    assert.ok(alarm, 'the class with no surface at all now has one');
    assert.match(JSON.stringify(alarm.obj.refunds), new RegExp(row!.id));
    assert.match(JSON.stringify(alarm.obj.refunds), new RegExp(failedRefundId));
    assert.match(alarm.msg ?? '', /did NOT return/);
    assert.match(alarm.msg ?? '', /fresh refund/i, 'and the instruction is one a human can run');

    // A fresh dashboard refund is SAFE because a failed row drops out of the cap.
    const summed = await withActor('system:scheduler', (tx) =>
      refundsRepository.sumNonFailedForCharge(tx, charge!.id),
    );
    assert.equal(summed, 0, 'the failed amount frees its headroom again');

    // Loud once, counted after — a standing condition must not bury the next one.
    const second = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: new Date(sweepNow().getTime() + HOUR),
      log: logs.log,
    });
    assert.equal(second.abandonedByClass['stripe-failed'], 1, 'still true');
    assert.equal(logs.errors.length, 1, 'and not shouted twice');
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 8. The over-refund backstop (arms 5 and 7) — structurally red, not silent
// ──────────────────────────────────────────────────────────────────────────

test(
  'refunding past a charge’s balance is refused by Stripe — an over-refund cannot pass unnoticed',
  SKIP_WHEN_NO_DB,
  async () => {
    // Arm 7 of the design's failure enumeration: somebody already refunded this
    // charge out of band. A retry then exceeds the refundable balance, Stripe
    // 400s, NO money moves, and the row lands on the abandon report for a human
    // who will find the dashboard refund. Modelled here because a stub that
    // said "yes" to every refund would let a genuine over-refund test green.
    const stripe = makeStripeStub();
    const pi = 'pi_test_capped';
    stripe.setRefundableBalance(pi, 5_000);
    await stripe.createRefund(
      refundCreateParams({ paymentIntentId: pi, amountCents: 5_000 }),
      'k1',
    );
    await assert.rejects(
      () =>
        stripe.createRefund(refundCreateParams({ paymentIntentId: pi, amountCents: 5_000 }), 'k2'),
      (err: unknown) => (err as { code?: string }).code === 'charge_already_refunded',
      'a second full refund of a fully-refunded charge is refused',
    );
    assert.equal(stripe.executedRefunds().length, 1, 'and the money moved exactly once');
  },
);

// A read the suite would otherwise not exercise: `unroutable` rows are not
// reachable by the webhook's race-recovery lookup, which is what keeps the
// terminal status terminal.
test(
  'the webhook’s unmatched-pending lookup cannot pick up an unroutable row',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents } = await seedMoneyPaidBooking({
      amountCents: 4_800,
      withPaymentIntent: false,
    });
    await cancelApp(makeStripeStub()).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': `wh-${randomUUID()}` },
      payload: {},
    });
    const row = await theOnlyRefund();
    assert.equal(row.status, 'unroutable');
    const found = await withActor('system:stripe-webhook', (tx) =>
      refundsRepository.findUnmatchedPendingForCharge(tx, {
        chargeId: row.chargeId,
        amountCents,
      }),
    );
    assert.equal(found, undefined, 'terminal means terminal — no webhook can reopen it');
    await cleanup();
  },
);

// Guard against an accidental widening: nothing outside the two lanes may be
// claimed, and `isNotNull` on a column full of NULLs is exactly the kind of
// predicate that silently matches everything if it is ever inverted.
test(
  'the claim returns the stored key on the row it hands the worker',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId } = await seedMoneyPaidBooking({ amountCents: 6_100 });
    const stripe = makeStripeStub();
    stripe.throwOnRefund();
    const requestKey = `proj-${randomUUID()}`;
    await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': requestKey },
      payload: {},
    });
    const row = await theOnlyRefund();
    await ageIntoTheClaimWindow(row.id);
    const claimed = await withActor('system:stripe-webhook', (tx) =>
      refundsRepository.claimStalePendingForRetry(tx, {
        staleBefore: new Date(Date.now() + HOUR),
        mintedAfter: new Date(Date.now() - 24 * HOUR),
      }),
    );
    assert.equal(claimed.length, 1);
    assert.equal(
      claimed[0]?.stripeIdempotencyKey,
      `${requestKey}:refund`,
      'the worker reads the key off the claimed row, never off a reconstruction',
    );
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Adversary round 1 (2026-08-20) — the findings, each pinned
// ──────────────────────────────────────────────────────────────────────────

test(
  'F1: the unroutable mint announces itself INSIDE the transaction, not from the post-commit seam',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents } = await seedMoneyPaidBooking({
      amountCents: 3_900,
      withPaymentIntent: false,
    });
    // Drive the SERVICE directly, inside a transaction that is still open. An
    // announcement made from `withMutation.postCommit` cannot appear here — and
    // that is the whole finding: `postCommit` is skipped outright on an
    // idempotent replay, so the crash-then-replay arc (client never sees the
    // response, retries the same key) lost this line permanently, on a row that
    // is terminal and therefore appears in NO worklist ever.
    const errors: { obj: Record<string, unknown>; msg?: string }[] = [];
    const captured = await withActor('system:scheduler', async (tx) => {
      const result = await cancelBookingInTx(tx, {
        id: bookingId,
        requireOwnerId: FIXTURE_IDS.ownerId,
        cancelledBy: 'owner',
        now: FIXTURE_TODAY,
        stripeIdempotencyKey: `intx-${randomUUID()}:refund`,
        log: { error: (obj, msg) => errors.push({ obj, msg }) },
      });
      // Asserted while the tx is STILL OPEN: the announcement has already
      // happened by the time the service returns.
      assert.equal(errors.length, 1, 'announced during the service call itself');
      return result;
    });
    assert.ok(captured.unroutableRefund, 'the mint is still reported to the caller');
    const alarm = errors[0]!;
    assert.equal(alarm.obj.amountCents, amountCents);
    assert.equal(alarm.obj.ownerId, FIXTURE_IDS.ownerId);
    assert.match(alarm.msg ?? '', /no Stripe route/i);
    assert.doesNotMatch(
      alarm.msg ?? '',
      /refund by hand in the .*dashboard/i,
      'still never an instruction a human cannot follow',
    );

    // And the row really is invisible to every worklist — which is why losing
    // the line above was permanent rather than merely late.
    const row = await theOnlyRefund();
    assert.equal(row.status, 'unroutable');
    const tick = await runDuplicateRefundRetryOnce({
      stripe: makeStripeStub(),
      now: sweepNow(),
    });
    assert.equal(tick.abandoned, 0);
    assert.deepEqual(tick.abandonedByClass, {
      'row-keyed': 0,
      'client-keyed': 0,
      'never-sent': 0,
      'stripe-failed': 0,
    });
    await cleanup();
  },
);

test(
  'F1: the route path announces it exactly once, and a replay does not double-announce',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId } = await seedMoneyPaidBooking({
      amountCents: 4_100,
      withPaymentIntent: false,
    });
    const key = `replay-unroutable-${randomUUID()}`;
    const app = cancelApp(makeStripeStub());
    const first = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': key },
      payload: {},
    });
    assert.equal(first.statusCode, 200, first.body);
    // Same key again: `withMutation` replays the stored response and the
    // transaction body never runs, so no second row and no second announcement.
    const replay = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': key },
      payload: {},
    });
    assert.equal(replay.statusCode, 200, replay.body);
    const rows = await db.select().from(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(rows.length, 1, 'one mint, one row');
    assert.equal(rows[0]?.status, 'unroutable');
    await cleanup();
  },
);

test(
  'F2: the buried-class alarm hands over SQL that actually finds that class',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // Saturate the oldest-first page with client-keyed rows so the newer
    // stripe-failed class is buried and reported by COUNT with a query instead
    // of by row. The query it prints must find the buried rows; the single
    // pending-shaped literal this replaced returned zero for stripe-failed,
    // whose rows are status='failed' with a NON-NULL stripe_refund_id.
    const [charge] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 5_000,
        status: 'succeeded',
        purpose: 'payg',
        stripePaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: charges.id });
    for (let i = 0; i < 20; i += 1) {
      const [old] = await db
        .insert(refunds)
        .values({
          ownerId: FIXTURE_IDS.ownerId,
          chargeId: charge!.id,
          bookingId: null,
          amountCents: 100,
          reason: 'cancel',
          stripeIdempotencyKey: null,
        })
        .returning({ id: refunds.id });
      await db
        .update(refunds)
        .set({ createdAt: new Date(Date.now() - (200 - i) * 24 * HOUR).toISOString() })
        .where(eq(refunds.id, old!.id));
    }
    // Thirty, not one. The buried alarm is now growth-keyed per process
    // ({@link ALARMED_BURIED_HIGH_WATER}), and an earlier test in this file
    // already announced `stripe-failed` at a small count — so a single row here
    // would sit under that high-water mark and correctly stay an INFO. Planting
    // a count no earlier test could have reached keeps this test about the
    // QUERY, which is what it exists to check, instead of about alarm memory.
    let failedRefundId = '';
    for (let i = 0; i < 30; i += 1) {
      const id = `re_test_${randomUUID().slice(0, 8)}`;
      if (i === 0) failedRefundId = id;
      await db.insert(refunds).values({
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: charge!.id,
        bookingId: null,
        amountCents: 2_500,
        reason: 'cancel',
        status: 'failed',
        stripeRefundId: id,
        stripeIdempotencyKey: 'k:refund',
      });
    }

    const logs = collectLogs();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: makeStripeStub(),
      now: sweepNow(),
      log: logs.log,
    });
    assert.equal(tick.abandonedByClass['client-keyed'], 20);
    assert.equal(tick.abandonedByClass['stripe-failed'], 30);
    assert.equal(tick.abandonedTruncated, true, 'the page could not hold them all');

    const buried = logs.error('stripe-failed');
    assert.ok(buried, 'the buried class is named even with zero page presence');
    assert.match(buried.msg ?? '', /the report page cannot show them/i);
    // THE assertion: extract the SQL the operator is told to run, run it, and
    // require that it returns the row the alarm is about.
    const sql = /list them with: (SELECT .*)$/.exec(buried.msg ?? '')?.[1];
    assert.ok(sql, 'the alarm carries a query');
    const found = await db.execute(sqlRaw.raw(sql));
    const returned = (found as unknown as { rows?: { stripe_refund_id: string | null }[] }).rows;
    assert.ok(Array.isArray(returned), 'the printed query executed and returned rows');
    const ids = returned.map((r) => r.stripe_refund_id);
    assert.ok(
      ids.includes(failedRefundId),
      `the printed query must FIND the buried class it names; it returned ${ids.length} row(s)`,
    );
    await cleanup();
  },
);

test(
  'F4: markUnroutable refuses a row that carries a stored key — a Stripe call was aimed at it',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // Corrupt-ish shape on purpose: NULL-PI charge, but a writer recorded a key.
    // Flipping it terminal would delete it from the sweep's stored-key lane
    // forever and silently strand a refund something was about to send.
    const [charge] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 6_000,
        status: 'succeeded',
        purpose: 'payg',
        stripePaymentIntentId: null,
      })
      .returning({ id: charges.id });
    const [keyed] = await db
      .insert(refunds)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: charge!.id,
        bookingId: null,
        amountCents: 6_000,
        reason: 'cancel',
        stripeIdempotencyKey: 'someone-aimed-a-call:refund',
      })
      .returning({ id: refunds.id });
    // The control, so this cannot pass by the flip simply being inert.
    const [unkeyed] = await db
      .insert(refunds)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: charge!.id,
        bookingId: null,
        amountCents: 1_000,
        reason: 'cancel',
        stripeIdempotencyKey: null,
      })
      .returning({ id: refunds.id });

    const flipped = await withActor('system:scheduler', (tx) =>
      refundsRepository.markUnroutable(tx),
    );
    assert.deepEqual(
      flipped.map((r) => r.id),
      [unkeyed!.id],
      'only the row nothing could ever send is retired',
    );
    assert.equal(
      (await readRefund(keyed!.id))?.status,
      'pending',
      'a stored key keeps the row in the retry lane',
    );
    assert.equal((await readRefund(unkeyed!.id))?.status, 'unroutable');
    await cleanup();
  },
);

test('F5: a client key long enough to overflow Stripe’s 255 is refused at the door', () => {
  // The cap is 255 minus the longest suffix this API appends, computed from the
  // suffix list itself. Both sides of the boundary, so neither an off-by-one nor
  // a silently-widened cap can pass.
  const longest = Math.max(...STRIPE_DERIVED_KEY_SUFFIXES.map((x) => x.length));
  assert.equal(
    IDEMPOTENCY_KEY_MAX_LEN + longest,
    STRIPE_IDEMPOTENCY_KEY_MAX_LEN,
    'the cap must leave exactly enough room for the longest derived key',
  );
  const atLimit = 'k'.repeat(IDEMPOTENCY_KEY_MAX_LEN);
  assert.equal(requireIdempotencyKey(atLimit), atLimit, 'the boundary itself is accepted');
  // And what it buys: every suffix still fits inside Stripe's own limit.
  for (const suffix of STRIPE_DERIVED_KEY_SUFFIXES) {
    assert.ok(
      `${atLimit}${suffix}`.length <= STRIPE_IDEMPOTENCY_KEY_MAX_LEN,
      `a max-length client key plus '${suffix}' must still be a key Stripe accepts`,
    );
  }
  assert.throws(
    () => requireIdempotencyKey('k'.repeat(IDEMPOTENCY_KEY_MAX_LEN + 1)),
    /exceeds/,
    'one character over is refused — before it can be stored as an unsendable refund key',
  );
});

test(
  'F7: a 409 idempotency_key_in_use is the original call still running — not a failure to shout about',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents, paymentIntentId } = await seedMoneyPaidBooking({
      amountCents: 7_300,
    });
    const stripe = makeStripeStub();
    stripe.throwOnRefund();
    const requestKey = `inflight-${randomUUID()}`;
    await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': requestKey },
      payload: {},
    });
    const row = await theOnlyRefund();
    await ageIntoTheClaimWindow(row.id);

    // Design §3 arm 3: the sweep fires while the ORIGINAL post-commit call is
    // still in flight, because a slow Stripe round-trip outlasted the grace.
    const sweeper = makeStripeStub();
    armRefundCap(paymentIntentId, amountCents, stripe, sweeper);
    sweeper.refundConcurrentKeyInUse();
    const logs = collectLogs();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: sweepNow(),
      log: logs.log,
    });
    assert.equal(tick.scanned, 1);
    assert.equal(tick.sent, 0);
    assert.equal(tick.results[0]?.outcome, 'still-failing');
    assert.equal(sweeper.executedRefunds().length, 0, 'no second refund was created');
    assert.equal((await readRefund(row.id))?.status, 'pending', 'the row stays claimable');
    assert.equal((await readRefund(row.id))?.stripeRefundId, null);
    assert.equal(
      logs.errors.length,
      0,
      'Stripe arbitrating a race is the system working — not an ERROR',
    );
    // …but it is not SILENT either: exactly one warn names the in-flight
    // condition, so deleting the arm cannot pass this suite (round-2 pin).
    const inFlightWarns = logs.warns.filter((w) => w.msg?.includes('still in flight'));
    assert.equal(inFlightWarns.length, 1, 'the 409 arm warns exactly once');
    assert.equal(inFlightWarns[0]?.obj.idempotencyKind, 'concurrent-request');

    // The next tick resolves it, which is the whole reason this is not an alarm.
    const later = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: new Date(sweepNow().getTime() + HOUR),
    });
    assert.equal(later.sent, 1);
    assert.equal(
      sweeper.calls.find((c) => c.method === 'createRefund')?.idempotencyKey,
      `${requestKey}:refund`,
    );
    await cleanup();
  },
);

test(
  'F8: params drift is reported as the code defect it is, not as a transient to wait out',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents, paymentIntentId } = await seedMoneyPaidBooking({
      amountCents: 8_200,
    });
    const stripe = makeStripeStub();
    armRefundCap(paymentIntentId, amountCents, stripe);
    const requestKey = `drift-${randomUUID()}`;
    // The refund LANDS at Stripe under this key with these params...
    stripe.refundLandsThenThrows();
    await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': requestKey },
      payload: {},
    });
    const row = await theOnlyRefund();
    await ageIntoTheClaimWindow(row.id);
    // ...and then the row's amount is rewritten underneath us, so the sweep
    // rebuilds DIFFERENT params for the same key. Stripe refuses: no money
    // moves, and no number of retries will ever change that.
    await db.update(refunds).set({ amountCents: 8_201 }).where(eq(refunds.id, row.id));
    assert.equal((await readRefund(row.id))?.amountCents, 8_201, 'the mutation LANDED');

    const logs = collectLogs();
    const tick = await runDuplicateRefundRetryOnce({
      stripe,
      now: sweepNow(),
      log: logs.log,
    });
    assert.equal(tick.results[0]?.outcome, 'still-failing');
    assert.equal(stripe.executedRefunds().length, 1, 'still exactly one refund at Stripe');
    const alarm = logs.errors.find((e) => e.obj.idempotencyKind === 'params-mismatch');
    assert.ok(alarm, 'the permanent condition is classified, not lumped in with rate limits');
    assert.match(alarm.msg ?? '', /DIFFERENT parameters/);
    assert.match(alarm.msg ?? '', /code defect to fix, not a transient/);
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Adversary round 3 (2026-08-20) — the saturation the previous round created
// ──────────────────────────────────────────────────────────────────────────

/** A terminal `'failed'` refund: permanent, unbounded by age, always oldest. */
async function seedFailedRefund(chargeId: string, ageDays: number): Promise<string> {
  const [row] = await db
    .insert(refunds)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      chargeId,
      bookingId: null,
      amountCents: 100,
      reason: 'cancel',
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
      stripeIdempotencyKey: 'k:refund',
    })
    .returning({ id: refunds.id });
  await db
    .update(refunds)
    .set({ createdAt: new Date(Date.now() - ageDays * 24 * HOUR).toISOString() })
    .where(eq(refunds.id, row!.id));
  return row!.id;
}

/** An abandoned, actionable, stored-key PENDING refund — the kind a human can fix. */
async function seedAbandonedRowKeyed(chargeId: string, key: string): Promise<string> {
  const [row] = await db
    .insert(refunds)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      chargeId,
      bookingId: null,
      amountCents: 4_400,
      reason: 'cancel',
      stripeIdempotencyKey: key,
    })
    .returning({ id: refunds.id });
  await db
    .update(refunds)
    .set({ createdAt: sql`now() - interval '30 hours'` })
    .where(eq(refunds.id, row!.id));
  return row!.id;
}

test(
  'R4-1: a wall of terminal stripe-failed rows cannot evict actionable pending money from the named page',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const [charge] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 50_000,
        status: 'succeeded',
        purpose: 'payg',
        stripePaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: charges.id });
    // 25 > the page cap of 20, and every one of them is older than anything a
    // real incident will produce, because they never age out.
    for (let i = 0; i < 25; i += 1) await seedFailedRefund(charge!.id, 300 - i);

    const key = `buried-${randomUUID()}:refund`;
    const fresh = await seedAbandonedRowKeyed(charge!.id, key);

    const logs = collectLogs();
    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: sweepNow(),
      log: logs.log,
    });
    assert.equal(tick.abandonedByClass['stripe-failed'], 25, 'the counts stay unbounded and true');
    assert.equal(tick.abandonedByClass['row-keyed'], 1);

    // THE assertion. Ordered by `created_at` alone, all 20 slots belong to the
    // failed wall forever and this row is never ERROR-named at all.
    const alarm = logs.error('row-keyed');
    assert.ok(alarm, 'a brand-new abandoned refund is still named at ERROR under a failed wall');
    assert.match(JSON.stringify(alarm.obj.refunds), new RegExp(fresh));
    assert.match(
      JSON.stringify(alarm.obj.refunds),
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'and its stored key is printed, so the human can search Stripe for it',
    );
    assert.equal(
      sweeper.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'reporting it never sends it',
    );
    await cleanup();
  },
);

test(
  'R4-1: buried owed money that GROWS re-alarms every time, instead of once per process',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const [charge] = await db
      .insert(charges)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 50_000,
        status: 'succeeded',
        purpose: 'payg',
        stripePaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: charges.id });
    for (let i = 0; i < 25; i += 1) await seedFailedRefund(charge!.id, 300 - i);

    const logs = collectLogs();
    const sweeper = makeStripeStub();
    const runTick = (offsetHours: number) =>
      runDuplicateRefundRetryOnce({
        stripe: sweeper,
        now: new Date(sweepNow().getTime() + offsetHours * HOUR),
        log: logs.log,
      });

    // Tick 1 — the wall is announced once.
    const t1 = await runTick(0);
    assert.equal(t1.abandonedByClass['stripe-failed'], 25);
    const afterFirst = logs.errors.filter((e) => e.obj.refundClass === 'stripe-failed').length;
    assert.equal(afterFirst, 1, 'the standing condition is announced');

    // Tick 2 — NEW owed money arrives. The old boolean sentinel had already
    // fired for this class, so this tick emitted no ERROR at all and the growth
    // showed up only as a bigger number on an INFO line (panel probe, :5433).
    await seedFailedRefund(charge!.id, 1);
    const t2 = await runTick(1);
    assert.equal(t2.abandonedByClass['stripe-failed'], 26);
    const afterSecond = logs.errors.filter((e) => e.obj.refundClass === 'stripe-failed').length;
    assert.equal(afterSecond, 2, 'new owed money is a NEW alarm');

    // Tick 3 — more new money, another alarm. Growth is always loud.
    await seedFailedRefund(charge!.id, 1);
    const t3 = await runTick(2);
    assert.equal(t3.abandonedByClass['stripe-failed'], 27);
    const afterThird = logs.errors.filter((e) => e.obj.refundClass === 'stripe-failed').length;
    assert.equal(afterThird, 3);
    const growth = logs.errors.filter((e) => e.obj.refundClass === 'stripe-failed').at(-1)!;
    assert.equal(growth.obj.newlyAbandonedCount, 1);
    assert.equal(growth.obj.previouslyAnnounced, 26);
    assert.match(growth.msg ?? '', /MORE abandoned/);

    // Tick 4 — NOTHING new. Still bounded: an unchanged condition stays INFO,
    // which is the flood this loud-once machinery exists to prevent.
    const t4 = await runTick(3);
    assert.equal(t4.abandonedByClass['stripe-failed'], 27);
    assert.equal(
      logs.errors.filter((e) => e.obj.refundClass === 'stripe-failed').length,
      3,
      'an unchanged standing condition never re-shouts',
    );
    assert.ok(
      logs.infos.some((i) => i.obj.refundClass === 'stripe-failed' && i.obj.abandonedCount === 27),
      'but it is still counted on every tick',
    );
    await cleanup();
  },
);

test(
  'R4-3: a throwing unroutable pass does not take the retry or the report down with it',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { bookingId, amountCents, paymentIntentId } = await seedMoneyPaidBooking({
      amountCents: 5_600,
    });
    const stripe = makeStripeStub();
    stripe.throwOnRefund();
    const requestKey = `guard-${randomUUID()}`;
    await cancelApp(stripe).inject({
      method: 'POST',
      url: `/bookings/${bookingId}/cancel`,
      headers: { 'idempotency-key': requestKey },
      payload: {},
    });
    const row = await theOnlyRefund();
    await ageIntoTheClaimWindow(row.id);

    // Break the tick's FIRST statement. Unguarded, this threw straight out of
    // the worker and the scheduler's per-phase catch swallowed the whole tick —
    // so a cosmetic retirement pass could silence the money-returning one.
    const realMarkUnroutable = refundsRepository.markUnroutable;
    refundsRepository.markUnroutable = async () => {
      throw new Error('stub: markUnroutable exploded');
    };
    const logs = collectLogs();
    const sweeper = makeStripeStub();
    armRefundCap(paymentIntentId, amountCents, stripe, sweeper);
    try {
      const tick = await runDuplicateRefundRetryOnce({
        stripe: sweeper,
        now: sweepNow(),
        log: logs.log,
      });
      assert.equal(tick.sent, 1, 'the refund still goes back');
      assert.ok(
        logs.errors.some((e) => e.obj.phase === 'mark-unroutable'),
        'and the failure of the cosmetic pass is reported, not hidden',
      );
    } finally {
      refundsRepository.markUnroutable = realMarkUnroutable;
    }
    assert.equal(
      typeof refundsRepository.markUnroutable,
      'function',
      'the real implementation is restored',
    );
    await cleanup();
  },
);
