import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and as andOp, desc as descOp, eq, ne } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  charges as chargesTable,
  cohorts as cohortsTable,
  idempotencyKeys,
  invoices as invoicesTable,
  refunds as refundsTable,
} from '../../src/db/schema/schema.js';
import type { EnrollmentWithdrawResultWire } from '../../src/contracts/wire.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import type { StripeClient, StripePaymentIntentResult } from '../../src/lib/stripe.js';
import { runCaptureReconcilerOnce } from '../../src/workers/captureReconciler.js';
import { runDuplicateRefundRetryOnce } from '../../src/workers/duplicateRefundRetry.js';
import { bookingsRepository } from '../../src/db/repositories/bookingsRepository.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import { enrollmentIdentityOf } from '../../src/lib/enrollmentIdentity.js';
import { withActor } from '../../src/db/tx.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
  type LogCapture,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Withdraw under MANUAL CAPTURE, and the reconciler's capture precondition —
 * `designs/partial-success-enrollment.md` ADDENDUM 3 (§A3.9 test plan, plus the
 * §A3.13 `retry_of` deltas).
 *
 * **The blocker this file exists for**, proven end-to-end on :5433 before a
 * line of it was written (`probe-withdraw-capture.mjs`): withdrawing while a
 * hold was still waiting to be captured released nothing and stopped nothing,
 * so the next reconciler tick captured 12000c for a dog with ZERO live
 * bookings — reported as an ordinary `'captured'`, raising no alarm, with no
 * verb able to recover it. The owner had been told `refunded_cents: 0`: true
 * about the refund, silent about the money that was about to move.
 *
 * Every test below is written against the two questions that matter on a money
 * path: what was the owner TOLD, and what was Stripe actually ASKED to do.
 */

registerFixtureHooks();

const SIX_WEEKS_OUT_UTC = '2026-07-06T23:00:00Z';
const PUPPY_PRICE_PER_DOG_CENTS = 12_000;

async function makeCohort(): Promise<{ id: string }> {
  const id = randomUUID();
  await db.insert(cohortsTable).values({
    id,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate: SIX_WEEKS_OUT_UTC,
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks: 4,
    capacity: 6,
    filled: 0,
  });
  return { id };
}

/**
 * The enrollments app, its stub, and a memo of every intent the stub ever
 * ANSWERED WITH — keyed by the confirm's idempotency key, plus the set of
 * intents Stripe actually EXECUTED a create for.
 *
 * The executed set is the instrument behind §A3.13's negative assertion: "the
 * retry adopted the original hold" is only worth something if the same run
 * proves NO SECOND INTENT WAS MINTED, and `stripe.calls` cannot show that — it
 * counts attempts, and a replay is an attempt.
 */
function trackedApp(capture?: LogCapture): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
  intentIdByKey: Map<string, string>;
  executedIntentIds: Set<string>;
  wrap(overrides: Partial<StripeClient>): void;
  /**
   * Mount the invoice routes on the SAME app and the SAME stub.
   *
   * Only §A3.19-B needs them, and it needs the REAL producer: the pay route's
   * async arm (`invoices.ts:304-316`) is the one path in this system that
   * leaves an invoice-lane group-class charge resting at `'requires_payment'`
   * with a live PaymentIntent behind an invoice that is still open. Staging
   * that row by hand would be a test asserting against a state I invented.
   */
  mountInvoicesRoute(): void;
} {
  const stripe = makeStripeStub();
  const intentIdByKey = new Map<string, string>();
  const executedIntentIds = new Set<string>();
  const overrides: Partial<StripeClient> = {};
  const tracking: StripeClient = {
    ...stripe,
    async createAndConfirmPaymentIntent(args, idempotencyKey) {
      if (overrides.createAndConfirmPaymentIntent !== undefined) {
        return overrides.createAndConfirmPaymentIntent(args, idempotencyKey);
      }
      const result = await stripe.createAndConfirmPaymentIntent(args, idempotencyKey);
      intentIdByKey.set(idempotencyKey, result.id);
      // `replayed === false` is Stripe's own word for "this request EXECUTED",
      // modelled by the stub since 2026-08-12. Anything else is a replay and
      // mints nothing.
      if (result.replayed === false) executedIntentIds.add(result.id);
      return result;
    },
    async retrievePaymentIntent(id): Promise<StripePaymentIntentResult> {
      if (overrides.retrievePaymentIntent !== undefined) {
        return overrides.retrievePaymentIntent(id);
      }
      return stripe.retrievePaymentIntent(id);
    },
  };
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  registerEnrollmentsRoute(app, { authenticate, stripe: tracking, now: FIXTURE_NOW });
  return {
    app,
    stripe,
    intentIdByKey,
    executedIntentIds,
    wrap(next) {
      Object.assign(overrides, next);
    },
    mountInvoicesRoute() {
      registerInvoicesRoute(app, { authenticate, stripe: tracking, now: FIXTURE_NOW });
    },
  };
}

async function enroll(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  cohortId: string;
  dogIds: string[];
  key: string;
  payLater?: boolean;
  retryOf?: string;
}): Promise<{ statusCode: number; json: () => unknown; body: string }> {
  return opts.app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': opts.key },
    payload: {
      cohort_id: opts.cohortId,
      dog_ids: opts.dogIds,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: opts.payLater ?? false,
      allow_partial: true,
      ...(opts.retryOf !== undefined ? { retry_of: opts.retryOf } : {}),
    },
  });
}

async function withdraw(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  cohortId: string;
  dogId: string;
  key: string;
}): Promise<{ statusCode: number; json: () => unknown; body: string }> {
  return opts.app.inject({
    method: 'POST',
    url: `/enrollments/${opts.cohortId}/withdraw`,
    headers: { 'idempotency-key': opts.key },
    payload: { dog_id: opts.dogId },
  });
}

type Stub = ReturnType<typeof makeStripeStub>;
const countCalls = (stripe: Stub, method: string): number =>
  stripe.calls.filter((c) => c.method === method).length;
const refundKeys = (stripe: Stub): (string | null)[] =>
  stripe.calls.filter((c) => c.method === 'createRefund').map((c) => c.idempotencyKey);

interface DogResult {
  dog_id: string;
  enrolled: boolean;
  reason?: string;
  payment_state?: string;
  charge_blocker?: string;
  verify_key?: string;
}
interface Envelope {
  results: DogResult[];
  total_captured_cents: number;
}

async function chargeRow(cohortId: string): Promise<{
  id: string;
  status: string;
  amountCents: number;
  paymentIntentId: string | null;
}> {
  const rows = await db
    .select({
      id: chargesTable.id,
      status: chargesTable.status,
      amountCents: chargesTable.amountCents,
      paymentIntentId: chargesTable.stripePaymentIntentId,
    })
    .from(chargesTable)
    .where(eq(chargesTable.cohortId, cohortId));
  assert.equal(rows.length, 1, 'expected exactly one charge row for this cohort');
  return rows[0]!;
}

async function refundRows(
  cohortId: string,
): Promise<
  {
    id: string;
    chargeId: string;
    amountCents: number;
    status: string;
    stripeIdempotencyKey: string | null;
    stripeRefundId: string | null;
  }[]
> {
  const charges = await db
    .select({ id: chargesTable.id })
    .from(chargesTable)
    .where(eq(chargesTable.cohortId, cohortId));
  const out = [];
  for (const charge of charges) {
    const rows = await db
      .select({
        id: refundsTable.id,
        chargeId: refundsTable.chargeId,
        amountCents: refundsTable.amountCents,
        status: refundsTable.status,
        stripeIdempotencyKey: refundsTable.stripeIdempotencyKey,
        stripeRefundId: refundsTable.stripeRefundId,
      })
      .from(refundsTable)
      .where(eq(refundsTable.chargeId, charge.id));
    out.push(...rows);
  }
  return out;
}

async function liveBookingCount(cohortId: string): Promise<number> {
  const rows = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(andOp(eq(bookingsTable.cohortId, cohortId), ne(bookingsTable.status, 'cancelled')));
  return rows.length;
}

/**
 * Drop everything a test wrote for its cohort. Called from a `finally` so a
 * FAILING test cannot leave a `'requires_payment'` row behind for the next
 * test's reconciler tick to claim — the shared fixture owner is the same owner
 * in every test in this file.
 */
async function cleanup(cohortId: string): Promise<void> {
  const rows = await db
    .select({ id: chargesTable.id })
    .from(chargesTable)
    .where(eq(chargesTable.cohortId, cohortId));
  for (const row of rows) {
    await db.delete(refundsTable).where(eq(refundsTable.chargeId, row.id));
  }
  // Release the settle back-reference FIRST. A test that let an invoice reach
  // `paid` leaves `invoices.paid_charge_id` pointing at a row this function is
  // about to delete, and that FK has no ON DELETE — so without this the
  // teardown raises 23503 and REPLACES the real assertion failure with a
  // plumbing one. (Cost us a masked red once; both attack lanes hit it too.)
  await db
    .update(invoicesTable)
    .set({ paidChargeId: null })
    .where(eq(invoicesTable.cohortId, cohortId));
  await db.delete(chargesTable).where(eq(chargesTable.cohortId, cohortId));
  await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohortId));
}

/** Enroll pay-now with BOTH capture attempts failing: the dog is enrolled, the
 *  hold is live, the row rests at `'requires_payment'` and the dog is reported
 *  `pending`. This is the exact state the round-3 blocker lived in. */
async function enrollWithLiveHold(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: Stub;
  cohortId: string;
  key: string;
}): Promise<{ id: string; paymentIntentId: string }> {
  opts.stripe.throwOnCapture(2);
  const res = await enroll({
    app: opts.app,
    cohortId: opts.cohortId,
    dogIds: [FIXTURE_IDS.dog1Id],
    key: opts.key,
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as Envelope).results[0]?.payment_state, 'pending');
  const row = await chargeRow(opts.cohortId);
  assert.equal(row.status, 'requires_payment', 'the hold is live and uncaptured');
  assert.ok(row.paymentIntentId);
  return { id: row.id, paymentIntentId: row.paymentIntentId };
}

// ──────────────────────────────────────────────────────────────────────────
// Group 0 — the stub's own honesty about cancel (§A3.9 preamble)
// ──────────────────────────────────────────────────────────────────────────

test('stub — cancel RELEASES a hold, and Stripe refuses every other state', async () => {
  const stripe = makeStripeStub();
  const mint = async (key: string): Promise<string> => {
    const held = await stripe.createAndConfirmPaymentIntent(
      {
        customerId: 'cus_x',
        paymentMethodId: 'pm_x',
        amountCents: 1_000,
        currency: 'usd',
        metadata: {},
        captureMethod: 'manual',
      },
      key,
    );
    return held.id;
  };

  const held = await mint('k-cancel-1');
  await stripe.cancelPaymentIntent(held);
  assert.equal((await stripe.retrievePaymentIntent(held)).status, 'canceled');

  // Already cancelled — Stripe refuses. This one matters: two callers now read
  // a cancel's throw as evidence about who won a race.
  await assert.rejects(() => stripe.cancelPaymentIntent(held), /unexpected state/i);

  const captured = await mint('k-cancel-2');
  await stripe.capturePaymentIntent(captured, 'k-cancel-2:capture');
  await assert.rejects(
    () => stripe.cancelPaymentIntent(captured),
    /unexpected state/i,
    'cancelling captured money would be a refund by another name',
  );

  const settling = await mint('k-cancel-3');
  stripe.setIntentState(settling, 'processing');
  await assert.rejects(
    () => stripe.cancelPaymentIntent(settling),
    /unexpected state/i,
    'processing is precisely the status Stripe will not cancel',
  );
});

test('stub — captureBeforeCancel() stages the race: the cancel finds it captured', async () => {
  const stripe = makeStripeStub();
  const held = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 1_000,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'k-race-1',
  );
  // The caller's retrieve still sees a live hold — which is the whole point:
  // only the cancel may discover otherwise.
  assert.equal((await stripe.retrievePaymentIntent(held.id)).status, 'requires_capture');
  stripe.captureBeforeCancel();
  await assert.rejects(() => stripe.cancelPaymentIntent(held.id), /unexpected state/i);
  assert.equal(
    (await stripe.retrievePaymentIntent(held.id)).status,
    'succeeded',
    'the capture won, and the re-retrieve is how a caller finds out',
  );
  // Single-shot, like every other lever.
  const other = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 1_000,
      currency: 'usd',
      metadata: {},
      captureMethod: 'manual',
    },
    'k-race-2',
  );
  await stripe.cancelPaymentIntent(other.id);
  assert.equal((await stripe.retrievePaymentIntent(other.id)).status, 'canceled');
});

test('stub — a retrieved intent reports the metadata its create sent', async () => {
  const stripe = makeStripeStub();
  const held = await stripe.createAndConfirmPaymentIntent(
    {
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      amountCents: 1_000,
      currency: 'usd',
      metadata: { owner_id: 'owner-1', purpose: 'group-class' },
      captureMethod: 'manual',
    },
    'k-meta-1',
  );
  const live = await stripe.retrievePaymentIntent(held.id);
  assert.equal(
    live.metadata?.owner_id,
    'owner-1',
    'the retry_of adopt arm asserts owner_id off exactly this read',
  );
});

// ──────────────────────────────────────────────────────────────────────────
// §A3.9.1 — the round-3 probe, as a pinned contract test
// ──────────────────────────────────────────────────────────────────────────

test(
  '§A3.9.1 withdraw during the capture-pending window RELEASES the hold, and the reconciler captures nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1..3 build, and the cornerstone of this round: the
    // withdraw returned `refunded_cents: 0` with the hold still live, and the
    // next tick captured 12000c for a dog with no bookings.
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const row = await enrollWithLiveHold({
        app,
        stripe,
        cohortId: cohort.id,
        key: `wc1-${randomUUID()}`,
      });
      const capturesBefore = countCalls(stripe, 'capturePaymentIntent');

      const res = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `wc1w-${randomUUID()}`,
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.withdrawn, true);
      assert.equal(body.money_outcome, 'released', 'the owner is told the hold was released');
      assert.equal(body.refunded_cents, 0, 'nothing was ever captured, so nothing is refunded');
      assert.equal(body.released_cents, PUPPY_PRICE_PER_DOG_CENTS);

      // Stripe's own truth, not ours.
      assert.equal(
        (await stripe.retrievePaymentIntent(row.paymentIntentId)).status,
        'canceled',
        'the withdraw cancelled the authorization',
      );
      assert.equal(
        (await chargeRow(cohort.id)).status,
        'failed',
        'canceled → failed, the established mapping (no DDL)',
      );
      assert.equal(countCalls(stripe, 'createRefund'), 0, 'a release is not a refund');

      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.equal(
        countCalls(stripe, 'capturePaymentIntent'),
        capturesBefore,
        'NOT ONE capture call after the withdraw — this is the blocker',
      );
      assert.equal(
        tick.results.find((r) => r.chargeId === row.id),
        undefined,
        'the flipped row is not even in the worklist any more',
      );
      assert.equal(tick.captured, 0);
      assert.equal(tick.lostHolds, 0, 'a released hold on a withdrawn dog is not an incident');
      assert.equal(await liveBookingCount(cohort.id), 0, 'and the dog really is withdrawn');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// §A3.9.2 / §A3.9.3 — the race, both directions
// ──────────────────────────────────────────────────────────────────────────

test(
  '§A3.9.2 the cancel LOSES the race: the capture won, so the withdraw refunds and says so',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    const withdrawKey = `wc2w-${randomUUID()}`;
    try {
      const row = await enrollWithLiveHold({
        app,
        stripe,
        cohortId: cohort.id,
        key: `wc2-${randomUUID()}`,
      });

      // A capture lands between the withdraw's retrieve and its cancel.
      stripe.captureBeforeCancel();
      const res = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: withdrawKey,
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded', 'the money moved, so the owner is told refunded');
      assert.equal(body.refunded_cents, PUPPY_PRICE_PER_DOG_CENTS);
      assert.equal(body.released_cents, undefined, 'nothing was released — it was captured');

      // EXACTLY ONE of {cancel, capture} took effect. The intent has one
      // terminal state and the response describes that one.
      assert.equal(countCalls(stripe, 'cancelPaymentIntent'), 1, 'the cancel was attempted');
      assert.equal(
        (await stripe.retrievePaymentIntent(row.paymentIntentId)).status,
        'succeeded',
        'and it did not take effect: the capture is the terminal state',
      );
      assert.equal(
        (await chargeRow(cohort.id)).status,
        'succeeded',
        'the row follows the Stripe truth that won',
      );

      // The refund rides the client-keyed recovery machinery, under the
      // withdraw key's own spelling.
      const refunds = await refundRows(cohort.id);
      assert.equal(refunds.length, 1);
      assert.equal(refunds[0]!.amountCents, PUPPY_PRICE_PER_DOG_CENTS);
      assert.equal(refunds[0]!.stripeIdempotencyKey, `${withdrawKey}:refund`);
      assert.deepEqual(refundKeys(stripe), [`${withdrawKey}:refund`], 'fired once, under the stored key');
      assert.equal(stripe.executedRefunds().length, 1, 'exactly one refund EXISTS for this money');
      assert.equal(await liveBookingCount(cohort.id), 0);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.9.3 the capture finished and only our flip was lost: withdraw refunds, capped by the refunds already on the charge (R9)',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    const withdrawKey = `wc3w-${randomUUID()}`;
    try {
      const row = await enrollWithLiveHold({
        app,
        stripe,
        cohortId: cohort.id,
        key: `wc3-${randomUUID()}`,
      });
      // The capture landed at Stripe; our row flip did not. The row still says
      // `'requires_payment'` and it is WRONG — which is exactly why the pre-tx
      // retrieve, not the row, decides what happened to the money.
      stripe.setIntentState(row.paymentIntentId, 'succeeded');
      // A partial refund already exists against this charge (R9's cap is about
      // the CHARGE's remaining balance, not the request's wishes).
      await db.insert(refundsTable).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: row.id,
        bookingId: null,
        amountCents: 5_000,
        reason: 'goodwill',
        stripeIdempotencyKey: null,
      });

      const res = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: withdrawKey,
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded');
      assert.equal(
        body.refunded_cents,
        PUPPY_PRICE_PER_DOG_CENTS - 5_000,
        'the refund is capped at what the charge still holds',
      );
      assert.equal((await chargeRow(cohort.id)).status, 'succeeded', 'the row now tells the truth');
      assert.equal(countCalls(stripe, 'cancelPaymentIntent'), 0, 'captured money is never cancelled');
      const fired = stripe.calls.filter((c) => c.method === 'createRefund');
      assert.equal(fired.length, 1);
      assert.equal(
        (fired[0] as { args: { amountCents: number } }).args.amountCents,
        PUPPY_PRICE_PER_DOG_CENTS - 5_000,
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// §A3.9.4 — the reconciler's capture precondition
// ──────────────────────────────────────────────────────────────────────────

test(
  '§A3.9.4 reconciler — a capturable hold that nobody owes is RELEASED, never captured',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the round-1..3 build: the `requires_capture` arm captured
    // without ever asking whether the enrollment still existed. This is the
    // probe's step 3 isolated — and the defence-in-depth for any withdraw path
    // ADDENDUM 3 missed, which is why the bookings are cancelled HERE without
    // going through the withdraw verb at all.
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const row = await enrollWithLiveHold({
        app,
        stripe,
        cohortId: cohort.id,
        key: `wc4-${randomUUID()}`,
      });
      await db
        .update(bookingsTable)
        .set({ status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: 'owner' })
        .where(eq(bookingsTable.cohortId, cohort.id));

      const capturesBefore = countCalls(stripe, 'capturePaymentIntent');
      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.equal(
        countCalls(stripe, 'capturePaymentIntent'),
        capturesBefore,
        'nothing owes this money, so nothing captures it',
      );
      assert.equal(
        tick.results.find((r) => r.chargeId === row.id)?.outcome,
        'withdrawn-released',
      );
      assert.equal(tick.withdrawnReleased, 1);
      assert.equal(tick.captured, 0);
      assert.equal(tick.lostHolds, 0);
      assert.equal((await chargeRow(cohort.id)).status, 'failed');
      assert.equal((await stripe.retrievePaymentIntent(row.paymentIntentId)).status, 'canceled');
      assert.equal(countCalls(stripe, 'createRefund'), 0, 'a released hold has nothing to refund');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.9.4 reconciler — the OWED control: a live enrollment still captures, exactly as round 2',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const row = await enrollWithLiveHold({
        app,
        stripe,
        cohortId: cohort.id,
        key: `wc4b-${randomUUID()}`,
      });
      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.equal(tick.results.find((r) => r.chargeId === row.id)?.outcome, 'captured');
      assert.equal(tick.withdrawnReleased, 0);
      assert.equal((await chargeRow(cohort.id)).status, 'succeeded');
      assert.equal(
        (await stripe.retrievePaymentIntent(row.paymentIntentId)).status,
        'succeeded',
        'the money moved for a dog that IS enrolled',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// §A3.9.5 — `release_pending`, end to end
// ──────────────────────────────────────────────────────────────────────────

test(
  '§A3.9.5 a payment still SETTLING withdraws as release_pending, and the reconciler releases it',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const row = await enrollWithLiveHold({
        app,
        stripe,
        cohortId: cohort.id,
        key: `wc5-${randomUUID()}`,
      });
      stripe.setIntentState(row.paymentIntentId, 'processing');

      const res = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `wc5w-${randomUUID()}`,
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'release_pending');
      assert.equal(body.refunded_cents, 0);
      assert.equal(body.released_cents, PUPPY_PRICE_PER_DOG_CENTS);
      assert.equal(
        countCalls(stripe, 'cancelPaymentIntent'),
        0,
        'Stripe refuses to cancel a processing intent, so we do not ask',
      );
      assert.equal(
        (await chargeRow(cohort.id)).status,
        'requires_payment',
        'the row stays claimable ON PURPOSE — the reconciler is the executor of this promise',
      );
      assert.equal(await liveBookingCount(cohort.id), 0, 'the dog is withdrawn either way');

      // It settles the way a manual-capture intent settles: to a hold.
      stripe.setIntentState(row.paymentIntentId, 'requires_capture');
      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.equal(
        tick.results.find((r) => r.chargeId === row.id)?.outcome,
        'withdrawn-released',
        'the promise is kept: released, not captured',
      );
      assert.equal((await chargeRow(cohort.id)).status, 'failed');
      assert.equal((await stripe.retrievePaymentIntent(row.paymentIntentId)).status, 'canceled');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.9.5 …and when the settling payment turns out to have been a CAPTURE, the reconciler refunds it unattended',
  SKIP_WHEN_NO_DB,
  async () => {
    // Allison's Q-B ruling (2026-08-21): YES, the unattended refund ships. This
    // is the arm that makes the `release_pending` sentence true in the other
    // direction.
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const row = await enrollWithLiveHold({
        app,
        stripe,
        cohortId: cohort.id,
        key: `wc6-${randomUUID()}`,
      });
      stripe.setIntentState(row.paymentIntentId, 'processing');
      const res = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `wc6w-${randomUUID()}`,
      });
      assert.equal((res.json() as EnrollmentWithdrawResultWire).money_outcome, 'release_pending');

      // It settles the OTHER way: the capture had already been in flight.
      stripe.setIntentState(row.paymentIntentId, 'succeeded');
      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.equal(
        tick.results.find((r) => r.chargeId === row.id)?.outcome,
        'refunded-post-withdraw',
      );
      assert.equal(tick.refundedPostWithdraw, 1);
      assert.equal((await chargeRow(cohort.id)).status, 'succeeded', 'the ledger is honest first');

      const refunds = await refundRows(cohort.id);
      assert.equal(refunds.length, 1);
      assert.equal(refunds[0]!.amountCents, PUPPY_PRICE_PER_DOG_CENTS, 'full amount, R9-capped');
      assert.equal(
        refunds[0]!.stripeIdempotencyKey,
        `withdraw-refund:${refunds[0]!.id}`,
        'the key is derived from OUR row — the client key is long gone by reconciler time',
      );
      assert.ok(refunds[0]!.stripeRefundId, 'and it fired immediately');
      assert.deepEqual(refundKeys(stripe), [`withdraw-refund:${refunds[0]!.id}`]);

      // A second tick must not return the money twice: the row is flipped, and
      // even if it were re-claimed the R9 cap makes the arm a no-op.
      const again = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 11 * 60 * 1000),
      });
      assert.equal(again.refundedPostWithdraw, 0);
      assert.equal(stripe.executedRefunds().length, 1, 'exactly one refund exists for this money');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.9.5 a post-withdraw refund whose response is LOST is re-fired by the sweep under the SAME stored key',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const row = await enrollWithLiveHold({
        app,
        stripe,
        cohortId: cohort.id,
        key: `wc7-${randomUUID()}`,
      });
      await db
        .update(bookingsTable)
        .set({ status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: 'owner' })
        .where(eq(bookingsTable.cohortId, cohort.id));
      stripe.setIntentState(row.paymentIntentId, 'succeeded');

      // The refund REACHES Stripe and the response is lost. R35: the pending
      // row is the commitment, and it keeps its key.
      stripe.refundLandsThenThrows();
      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.equal(
        tick.results.find((r) => r.chargeId === row.id)?.outcome,
        'refunded-post-withdraw',
      );
      const minted = await refundRows(cohort.id);
      assert.equal(minted.length, 1);
      assert.equal(minted[0]!.status, 'pending');
      assert.equal(minted[0]!.stripeRefundId, null, 'we never learned the re_* id');
      const storedKey = minted[0]!.stripeIdempotencyKey;
      assert.equal(storedKey, `withdraw-refund:${minted[0]!.id}`);

      const swept = await runDuplicateRefundRetryOnce({
        stripe,
        now: new Date(Date.now() + 20 * 60 * 1000),
      });
      assert.equal(
        swept.results.find((r) => r.refundId === minted[0]!.id)?.outcome,
        'sent',
        'the sweep finished what the lost response started',
      );
      assert.deepEqual(
        refundKeys(stripe),
        [storedKey, storedKey],
        'SAME key both times — which is why the second call replays instead of refunding again',
      );
      assert.equal(
        stripe.executedRefunds().length,
        1,
        'one refund EXISTS for this money, not two',
      );
      const healed = await refundRows(cohort.id);
      assert.ok(healed[0]!.stripeRefundId, 'and the re_* id is on the row now');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// §A3.9.6 / §A3.9.7 / §A3.9.8 — replay, the existing arms, the NULL-PI interim
// ──────────────────────────────────────────────────────────────────────────

test(
  '§A3.9.6 a same-key withdraw retry replays the stored answer with ZERO Stripe traffic',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    const key = `wc8w-${randomUUID()}`;
    try {
      await enrollWithLiveHold({ app, stripe, cohortId: cohort.id, key: `wc8-${randomUUID()}` });

      const first = await withdraw({ app, cohortId: cohort.id, dogId: FIXTURE_IDS.dog1Id, key });
      assert.equal(first.statusCode, 200, first.body);
      const callsAfterFirst = stripe.calls.length;

      const replay = await withdraw({ app, cohortId: cohort.id, dogId: FIXTURE_IDS.dog1Id, key });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), first.json(), 'same key, same money sentence');
      assert.equal(
        stripe.calls.length,
        callsAfterFirst,
        'the peek answered it — a replayed withdraw must not re-enter the settle phase',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.9.7 the pay-later arm still VOIDS, and now says so',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const res = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc9-${randomUUID()}`,
        payLater: true,
      });
      assert.equal(res.statusCode, 201, res.body);

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `wc9w-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'voided');
      assert.equal(body.refunded_cents, 0);
      assert.equal(body.released_cents, undefined, 'nothing was held, so nothing is released');
      assert.equal(stripe.calls.length, 0, 'a pay-later withdraw never touches Stripe');
      const invs = await db
        .select({ status: invoicesTable.status })
        .from(invoicesTable)
        .where(eq(invoicesTable.cohortId, cohort.id));
      assert.deepEqual(
        invs.map((i) => i.status),
        ['void'],
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// A1 (2026-08-24) — Q18-B, amended: the void arm discriminates AT STRIPE.
//
// The two rows the invoice lane can leave behind are byte-identical in the
// database — `requires_payment` + a PI, minted by one arm
// (`invoices.ts:304-316`) after one best-effort cancel (`:239-248`). A DECLINE's
// cancel lands (dead money, "never charged" is TRUE); a `processing` one's is
// refused (live money, "never charged" would be a LIE). Only Stripe knows
// which, so only Stripe may decide the sentence — and the DB read gates the
// call, so a withdraw with no pay attempt still touches Stripe zero times.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pay-later enroll — the open invoice, and no charge row at all yet.
 */
async function enrollPayLater(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  cohortId: string;
}): Promise<string> {
  const enrolled = await enroll({
    app: opts.app,
    cohortId: opts.cohortId,
    dogIds: [FIXTURE_IDS.dog1Id],
    key: `a1e-${randomUUID()}`,
    payLater: true,
  });
  assert.equal(enrolled.statusCode, 201, enrolled.body);
  const [invoice] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.cohortId, opts.cohortId));
  assert.ok(invoice, 'the pay-later enrollment minted its open invoice');
  return invoice.id;
}

/**
 * ONE in-app pay attempt that does not settle, leaving a `requires_payment`
 * charge row carrying a PaymentIntent.
 *
 * This route is the ONLY producer of such a row (§A1.3 — the auto-charge
 * worker's in-flight arm resolves an ATTEMPT row and mints no charge), and it
 * has **no guard against re-attempting while a prior PI is still processing**,
 * which is why calling this twice is ordinary use rather than a contrivance
 * (§A2.1).
 *
 * `intentStatus` picks which of the two byte-identical rows this is. Nothing
 * is levered: the stub REFUSES to cancel a `processing` intent exactly as
 * Stripe does, so a processing attempt's row is live because of what it is,
 * not because a test told the cancel to fail.
 */
async function payAttempt(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: Stub;
  cohortId: string;
  invoiceId: string;
  intentStatus: 'requires_payment_method' | 'processing';
}): Promise<{ chargeId: string; paymentIntentId: string }> {
  opts.stripe.setNextIntentStatus(opts.intentStatus);
  const paid = await opts.app.inject({
    method: 'POST',
    url: `/invoices/${opts.invoiceId}/pay`,
    headers: { 'idempotency-key': `a1p-${randomUUID()}` },
    payload: {},
  });
  assert.equal(paid.statusCode, 201, paid.body);
  const body = paid.json() as { charge_id: string; stripe_payment_intent_id: string };
  const [stillOpen] = await db
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, opts.invoiceId));
  assert.equal(stillOpen?.status, 'open', 'nothing settled, so the debt stands');
  return { chargeId: body.charge_id, paymentIntentId: body.stripe_payment_intent_id };
}

/** Pay-later enroll + exactly one unsettled pay attempt. */
async function payLaterWithOneAttempt(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: Stub;
  cohortId: string;
  intentStatus: 'requires_payment_method' | 'processing';
}): Promise<{ invoiceId: string; chargeId: string; paymentIntentId: string }> {
  const invoiceId = await enrollPayLater({ app: opts.app, cohortId: opts.cohortId });
  const attempt = await payAttempt({ ...opts, invoiceId });
  const row = await chargeRow(opts.cohortId);
  assert.equal(row.status, 'requires_payment', 'the invoice-lane charge row rests unsettled');
  assert.ok(row.paymentIntentId);
  return { invoiceId, ...attempt };
}

async function invoiceStatus(invoiceId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId));
  return row?.status;
}

/** Every charge row for a cohort, newest first — the order the settle walks. */
async function chargeRowsNewestFirst(cohortId: string): Promise<
  { id: string; status: string; amountCents: number; paymentIntentId: string | null }[]
> {
  return db
    .select({
      id: chargesTable.id,
      status: chargesTable.status,
      amountCents: chargesTable.amountCents,
      paymentIntentId: chargesTable.stripePaymentIntentId,
    })
    .from(chargesTable)
    .where(eq(chargesTable.cohortId, cohortId))
    .orderBy(descOp(chargesTable.createdAt));
}

test(
  'A1/1 a DECLINED pay attempt (intent dead) withdraws as voided — "never charged" is the truth here',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the first Q18-B build, which answered `'release_pending'`
    // with `released_cents: 12000` — inventing a hold over money that was
    // never held, on what is the MORE COMMON path. The probe that found it is
    // this test (`probe-declined-attempt.log`, promoted per §A1.5/1).
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute } = trackedApp();
    mountInvoicesRoute();
    try {
      const staged = await payLaterWithOneAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        intentStatus: 'requires_payment_method',
      });
      assert.equal(
        (await stripe.retrievePaymentIntent(staged.paymentIntentId)).status,
        'canceled',
        'the route cancelled the declined intent: this money is DEAD, not in flight',
      );

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a1w1-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;

      // THE PIN.
      assert.equal(body.money_outcome, 'voided');
      assert.equal(body.refunded_cents, 0);
      assert.equal(
        body.released_cents,
        undefined,
        'NOT `released`: a declined automatic-capture intent held nothing, and naming a released hold would invent one',
      );

      assert.equal(await invoiceStatus(staged.invoiceId), 'void');
      assert.equal(
        (await chargeRow(cohort.id)).status,
        'failed',
        'canceled → failed, the established mapping — and it retires the reconciler rescan for this row',
      );
      assert.equal(countCalls(stripe, 'createRefund'), 0, 'nothing moved, so nothing returns');
      assert.equal(await liveBookingCount(cohort.id), 0);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  'A1/2 a PROCESSING pay attempt (intent live) still withdraws as release_pending — the original Q18-B case',
  SKIP_WHEN_NO_DB,
  async () => {
    // Preserved through the amendment: this is now the ONLY state that says
    // `release_pending`. `'voided'` here would be the falsehood Q18-B exists
    // to remove — the PI may still settle, and the reconciler would then
    // refund a charge the owner was told never happened.
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute } = trackedApp();
    mountInvoicesRoute();
    try {
      const staged = await payLaterWithOneAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        intentStatus: 'processing',
      });
      assert.equal(
        (await stripe.retrievePaymentIntent(staged.paymentIntentId)).status,
        'processing',
        'the money really is still in motion at Stripe',
      );

      const cancelsBefore = countCalls(stripe, 'cancelPaymentIntent');
      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a1w2-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'release_pending');
      // AMENDED by A2.3: `released_cents` is defined as AUTHORIZED-HOLD cents
      // (`wire.ts:875-877`), and an automatic-capture invoice-lane intent
      // authorized nothing — emitting the class price here invented a hold,
      // the exact thing A1/1 refuses one case earlier. Omitted, not zeroed.
      assert.equal(
        'released_cents' in body,
        false,
        'no hold ever existed on this lane, so no hold figure is emitted',
      );
      assert.equal(body.refunded_cents, 0, 'nothing was captured, so nothing is refunded yet');

      assert.equal(await invoiceStatus(staged.invoiceId), 'void', 'the debt is still cancelled');
      assert.equal(
        (await chargeRow(cohort.id)).status,
        'requires_payment',
        'the row stays claimable ON PURPOSE — the reconciler is the executor of this promise',
      );
      assert.equal(
        countCalls(stripe, 'cancelPaymentIntent'),
        cancelsBefore,
        'Stripe refuses to cancel a processing intent, so we do not ask',
      );
      assert.equal((await refundRows(cohort.id)).length, 0, 'and nothing was minted');
      assert.equal(await liveBookingCount(cohort.id), 0, 'the dog is withdrawn either way');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  'A1/3 the capture WON the race behind an open invoice: the withdraw refunds in full and says so',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED first. The bank cleared the in-flight payment between the pay
    // attempt and the withdraw. The invoice is still open (no webhook has
    // landed), so the void arm owns this — and answering `'voided'` here would
    // tell an owner whose card WAS charged that they never were.
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute } = trackedApp();
    mountInvoicesRoute();
    const withdrawKey = `a1w3-${randomUUID()}`;
    try {
      const staged = await payLaterWithOneAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        intentStatus: 'processing',
      });
      stripe.setIntentState(staged.paymentIntentId, 'succeeded');

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: withdrawKey,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded');
      assert.equal(body.refunded_cents, PUPPY_PRICE_PER_DOG_CENTS, 'the full remainder, R9-capped');
      assert.equal(body.released_cents, undefined, 'nothing was released — it was captured');

      assert.equal(await invoiceStatus(staged.invoiceId), 'void');
      assert.equal(
        (await chargeRow(cohort.id)).status,
        'succeeded',
        'the ledger is honest first: the money DID move',
      );
      const refunds = await refundRows(cohort.id);
      assert.equal(refunds.length, 1);
      assert.equal(refunds[0]!.amountCents, PUPPY_PRICE_PER_DOG_CENTS);
      // AMENDED by A2.1/5: the invoice lane can now mint for SEVERAL rows in
      // one request, so its key is per-charge — unique across rows, still
      // deterministic per request. The pay-now lane keeps the landed
      // `${K}:refund` spelling (at most one mint there, §A3.14).
      const invoiceLaneKey = `${withdrawKey}:refund:${staged.chargeId}`;
      assert.equal(refunds[0]!.stripeIdempotencyKey, invoiceLaneKey);
      assert.deepEqual(refundKeys(stripe), [invoiceLaneKey], 'fired once, under the stored key');
      assert.equal(stripe.executedRefunds().length, 1, 'exactly one refund EXISTS for this money');
      assert.equal(await liveBookingCount(cohort.id), 0);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  'A1/4 THE COST CLAIM: a pay-later withdraw with NO attempt touches Stripe zero times',
  SKIP_WHEN_NO_DB,
  async () => {
    // This is the assertion the whole amendment is gated on. A1.1 extends the
    // pre-tx settle into the invoice lane, and the rejection it overturns
    // ("Stripe traffic on every open-invoice withdraw") was wrong ONLY because
    // the DB read gates the call. If that gate ever regresses, every pay-later
    // withdraw — the bulk of them — starts paying a Stripe round-trip and
    // inherits a Stripe outage as a failure mode. Green before and after the
    // amendment, by design; it is a preservation pin, not a red-first one.
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute } = trackedApp();
    mountInvoicesRoute();
    try {
      const enrolled = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `a1e4-${randomUUID()}`,
        payLater: true,
      });
      assert.equal(enrolled.statusCode, 201, enrolled.body);
      assert.equal(stripe.calls.length, 0, 'a pay-later ENROLL never touches Stripe either');

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a1w4-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'voided', 'never attempted ⇒ never charged');
      assert.equal(body.refunded_cents, 0);
      assert.equal(body.released_cents, undefined);
      assert.equal(
        stripe.calls.length,
        0,
        'ZERO Stripe calls: the no-pending-row DB read is what gates the settle, and it must keep gating it',
      );
      const [inv] = await db
        .select({ status: invoicesTable.status })
        .from(invoicesTable)
        .where(eq(invoicesTable.cohortId, cohort.id));
      assert.equal(inv?.status, 'void');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  'A1/5 Stripe unreadable ⇒ the withdraw ABORTS and NOTHING changed',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED first: before A1 the invoice lane never consulted Stripe, so a dead
    // retrieve could not stop anything and the withdraw answered 200.
    //
    // §A3.2's "no uncertains" applied to ourselves: a withdraw either
    // completes with a definite money statement or does not complete. The
    // named cost (A1.6) is that a Stripe outage now blocks the pay-ATTEMPTED
    // subset of pay-later withdraws — the same posture every pay-now withdraw
    // already has. What must NOT happen is a half-withdraw, or an idempotency
    // record that would replay this failure forever.
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute, wrap } = trackedApp();
    mountInvoicesRoute();
    const withdrawKey = `a1w5-${randomUUID()}`;
    try {
      const staged = await payLaterWithOneAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        intentStatus: 'processing',
      });
      const bookingsBefore = await liveBookingCount(cohort.id);
      assert.ok(bookingsBefore > 0);

      wrap({
        retrievePaymentIntent: () => {
          throw new Error('stripe is unreachable');
        },
      });
      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: withdrawKey,
      });
      assert.notEqual(out.statusCode, 200, `the withdraw must not answer OK: ${out.body}`);

      // Nothing moved: the dog is still enrolled, the debt still stands, the
      // charge row is untouched.
      assert.equal(await liveBookingCount(cohort.id), bookingsBefore, 'the dog is STILL enrolled');
      assert.equal(await invoiceStatus(staged.invoiceId), 'open', 'the invoice was never voided');
      assert.equal((await chargeRow(cohort.id)).status, 'requires_payment');
      assert.equal((await refundRows(cohort.id)).length, 0);

      // And the failure did not fossilize: a retry must be able to re-enter,
      // not replay a 500 forever.
      const stored = await db
        .select({ key: idempotencyKeys.key })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, withdrawKey));
      assert.equal(stored.length, 0, 'no idempotency record persisted for an aborted withdraw');

      // The owner's retry heals it, exactly as §A3.2 promises.
      wrap({ retrievePaymentIntent: undefined });
      const retry = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a1w5r-${randomUUID()}`,
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(
        (retry.json() as EnrollmentWithdrawResultWire).money_outcome,
        'release_pending',
        'and the retry gives the definite answer the first attempt could not',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// A2 (2026-08-24, fix round 2) — resolve EVERY pending row; per-lane truth on
// every arm.
//
// A1 sampled ONE pending row, newest first. The pay route has no guard against
// re-attempting while a prior PI is processing, so N-row states are ordinary
// use — and the newest row is not reliably the live one. Sampling the dead
// newest row and answering "you were never charged" over an older live PI is
// the same falsehood A1 was written to remove, one layer down (§A2.1).
// ──────────────────────────────────────────────────────────────────────────

test(
  'A2/1 THE HIGH: dead NEWEST attempt + live OLDER attempt ⇒ release_pending, never "never charged"',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the A1 build, which sampled only the newest row: it settled
    // the dead decline, answered `'voided'`, and never looked at the older
    // processing PI — money genuinely in motion. Promoted from the Fable
    // lane's PROBE A (`attack-fable-mini/probe-a1-attack.test.ts`).
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute } = trackedApp();
    mountInvoicesRoute();
    try {
      const invoiceId = await enrollPayLater({ app, cohortId: cohort.id });
      // Attempt 1: the bank sits on it. LIVE.
      const live = await payAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        invoiceId,
        intentStatus: 'processing',
      });
      // Attempt 2: the owner retries and is declined; the route's cancel
      // lands. DEAD, and NEWER.
      const dead = await payAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        invoiceId,
        intentStatus: 'requires_payment_method',
      });
      assert.equal(
        (await stripe.retrievePaymentIntent(dead.paymentIntentId)).status,
        'canceled',
        'the NEWEST attempt is dead',
      );
      assert.equal(
        (await stripe.retrievePaymentIntent(live.paymentIntentId)).status,
        'processing',
        'the OLDER attempt is live — money genuinely in motion at Stripe',
      );

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a2w1-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;

      // THE PIN.
      assert.equal(body.money_outcome, 'release_pending');
      assert.equal('released_cents' in body, false, 'A2.3: no hold existed on this lane');
      assert.equal(body.refunded_cents, 0);

      // Per-row actions, not one sampled row: the dead one is retired, the
      // live one is left for the reconciler that will finish it.
      const rows = await chargeRowsNewestFirst(cohort.id);
      assert.equal(rows.length, 2);
      assert.equal(rows.find((r) => r.id === dead.chargeId)?.status, 'failed');
      assert.equal(
        rows.find((r) => r.id === live.chargeId)?.status,
        'requires_payment',
        'the live row stays claimable ON PURPOSE',
      );
      assert.equal(await invoiceStatus(invoiceId), 'void');
      assert.equal(await liveBookingCount(cohort.id), 0);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  'A2/2 a CAPTURE among the attempts outranks everything: refunded, with the sum actually minted',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED first. Precedence is refunded > release_pending > released (A2.1/4):
    // moved money outranks every other sentence, and `refunded_cents` is the
    // sum this request actually put on its way back.
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute } = trackedApp();
    mountInvoicesRoute();
    const withdrawKey = `a2w2-${randomUUID()}`;
    try {
      const invoiceId = await enrollPayLater({ app, cohortId: cohort.id });
      const captured = await payAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        invoiceId,
        intentStatus: 'processing',
      });
      const live = await payAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        invoiceId,
        intentStatus: 'processing',
      });
      // The FIRST attempt's bank clears it — the money moved. The second is
      // still in flight.
      stripe.setIntentState(captured.paymentIntentId, 'succeeded');

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: withdrawKey,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded', 'a capture outranks the settling sibling');
      assert.equal(
        body.refunded_cents,
        PUPPY_PRICE_PER_DOG_CENTS,
        'Σ minted this request — one captured row, refunded in full',
      );
      assert.equal('released_cents' in body, false);

      const rows = await chargeRowsNewestFirst(cohort.id);
      assert.equal(rows.find((r) => r.id === captured.chargeId)?.status, 'succeeded');
      assert.equal(
        rows.find((r) => r.id === live.chargeId)?.status,
        'requires_payment',
        'the still-settling sibling is left to the reconciler (disclosed mixed-state silence, A2.1)',
      );
      const refunds = await refundRows(cohort.id);
      assert.equal(refunds.length, 1);
      assert.equal(refunds[0]!.chargeId, captured.chargeId, 'minted against the row that moved');
      assert.equal(
        refunds[0]!.stripeIdempotencyKey,
        `${withdrawKey}:refund:${captured.chargeId}`,
        'per-charge key: unique across rows, deterministic per request (A2.1/5)',
      );
      assert.equal(await invoiceStatus(invoiceId), 'void');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  'A2/3 THE COST BOUND: N pending rows cost exactly N retrieves, and no attempt costs zero',
  SKIP_WHEN_NO_DB,
  async () => {
    // A1 claimed "one retrieve"; that was only true of single-row states. The
    // honest bound is ≤1 retrieve + ≤1 cancel PER PENDING ROW (§A2.1 cost
    // restatement), and the no-attempt path — the bulk of pay-later withdraws
    // — must still touch Stripe zero times. Both halves pinned here because
    // the second is what licenses the whole amendment.
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute } = trackedApp();
    mountInvoicesRoute();
    try {
      const invoiceId = await enrollPayLater({ app, cohortId: cohort.id });
      await payAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        invoiceId,
        intentStatus: 'processing',
      });
      await payAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        invoiceId,
        intentStatus: 'processing',
      });
      assert.equal((await chargeRowsNewestFirst(cohort.id)).length, 2);

      const retrievesBefore = countCalls(stripe, 'retrievePaymentIntent');
      const cancelsBefore = countCalls(stripe, 'cancelPaymentIntent');
      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a2w3-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      assert.equal(
        countCalls(stripe, 'retrievePaymentIntent') - retrievesBefore,
        2,
        'exactly one retrieve per pending row — no re-walking, no N²',
      );
      assert.equal(
        countCalls(stripe, 'cancelPaymentIntent') - cancelsBefore,
        0,
        'cancels only on CANCELLABLE rows; both of these are processing, which Stripe refuses',
      );
    } finally {
      await cleanup(cohort.id);
    }

    // The other half: a withdraw with no pay attempt at all.
    const quiet = await makeCohort();
    const { app: app2, stripe: stripe2, mountInvoicesRoute: mount2 } = trackedApp();
    mount2();
    try {
      await enrollPayLater({ app: app2, cohortId: quiet.id });
      const out = await withdraw({
        app: app2,
        cohortId: quiet.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a2w3b-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      assert.equal((out.json() as EnrollmentWithdrawResultWire).money_outcome, 'voided');
      assert.equal(stripe2.calls.length, 0, 'ZERO Stripe calls — the DB read still gates everything');
    } finally {
      await cleanup(quiet.id);
    }
  },
);

test(
  'A2/4 fall-through, invoice lane, invoice VOID ⇒ voided — never "the hold has been released"',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED first. Promoted from the Fable lane's PROBE B. When the invoice stops
    // being open between the pre-tx read and the in-tx `markVoid`, A1 routed an
    // invoice-lane verdict into the pay-now fall-through, which renders
    // `'released'` — "the $X hold on your card has been released" — for an
    // automatic-capture intent that never held anything. The void arm refuses
    // that exact word for that exact row; the fall-through did not (§A2.2).
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute, wrap } = trackedApp();
    mountInvoicesRoute();
    try {
      const staged = await payLaterWithOneAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        intentStatus: 'requires_payment_method',
      });
      // The pre-tx retrieve is the seam that runs in exactly that window.
      wrap({
        retrievePaymentIntent: async (id) => {
          await db
            .update(invoicesTable)
            .set({ status: 'void' })
            .where(eq(invoicesTable.id, staged.invoiceId));
          return stripe.retrievePaymentIntent(id);
        },
      });

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a2w4-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'voided', 'cancelled, never charged — and no hold invented');
      assert.equal('released_cents' in body, false);
      assert.equal(body.refunded_cents, 0);
      assert.equal(
        (await chargeRow(cohort.id)).status,
        'failed',
        'the dead row is still retired on this arm',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  'A2/5 fall-through, invoice lane, invoice SETTLED by a covered charge ⇒ none',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED first. The Opus lane's CASE E: the invoice is settled in the pre-tx
    // window by a charge whose refunds already cover it, so §A3.15's skip rule
    // passes over it and the fall-through reaches the verdict arms — where A1
    // answered `'released'` + 12000c for a declined automatic-capture row.
    //
    // `'none'` — "There's no charge on file to return." — is the truthful
    // answer in these covered-settler leftovers: the ordinary covered settler
    // is intercepted before this point by `findUnsettledSucceededCharge`,
    // which answers `'refunded'` with real money (§A2.2).
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute, wrap } = trackedApp();
    mountInvoicesRoute();
    try {
      const staged = await payLaterWithOneAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        intentStatus: 'requires_payment_method',
      });
      let fired = false;
      wrap({
        retrievePaymentIntent: async (id) => {
          if (!fired) {
            fired = true;
            // A real settle lands: a NEW charge pays the invoice, and that
            // charge is already fully refunded out of band.
            const settler = randomUUID();
            await db.insert(chargesTable).values({
              id: settler,
              ownerId: FIXTURE_IDS.ownerId,
              stripePaymentIntentId: `pi_settler_${randomUUID().slice(0, 8)}`,
              amountCents: PUPPY_PRICE_PER_DOG_CENTS,
              status: 'succeeded',
              purpose: 'group-class',
              cohortId: cohort.id,
              dogId: FIXTURE_IDS.dog1Id,
            });
            await db.insert(refundsTable).values({
              id: randomUUID(),
              ownerId: FIXTURE_IDS.ownerId,
              chargeId: settler,
              bookingId: null,
              amountCents: PUPPY_PRICE_PER_DOG_CENTS,
              reason: 'cancel',
              stripeIdempotencyKey: null,
            });
            await db
              .update(invoicesTable)
              .set({
                status: 'paid',
                paidChargeId: settler,
                paidAt: '2026-06-01T00:00:00.000Z',
              })
              .where(eq(invoicesTable.id, staged.invoiceId));
          }
          return stripe.retrievePaymentIntent(id);
        },
      });

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a2w5-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'none', 'nothing of this enrollment’s is left to return');
      assert.equal('released_cents' in body, false, 'and above all: no invented hold');
      assert.equal(body.refunded_cents, 0);
      assert.equal(
        (await chargeRowsNewestFirst(cohort.id)).find((r) => r.id === staged.chargeId)?.status,
        'failed',
        'the dead row is retired on this arm too',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  'A2/6 a pay attempt landing AFTER the pre-tx pass raises the floor to release_pending',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED first (§A2.6a). The pre-tx settle resolves what it can SEE; a tap
    // landing between that pass and the in-tx void leaves a live PI the
    // request never examined, and `'voided'` over it is the same falsehood
    // again. Ruled fix: after the void and the per-row actions, re-read the
    // pending set IN-TX (DB only — R5 intact), subtract the ids this request
    // already settled, and let a non-empty remainder raise the sentence floor.
    //
    // The seam is the pre-tx retrieve: it runs after the pending set was read
    // and before the transaction opens.
    const cohort = await makeCohort();
    const { app, stripe, mountInvoicesRoute, wrap } = trackedApp();
    mountInvoicesRoute();
    try {
      const staged = await payLaterWithOneAttempt({
        app,
        stripe,
        cohortId: cohort.id,
        intentStatus: 'requires_payment_method',
      });
      const [anchored] = await db
        .select({ bookingId: invoicesTable.bookingId })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, staged.invoiceId));
      assert.ok(anchored?.bookingId, 'the invoice carries its enrollment anchor (§A3.18 D1)');

      let fired = false;
      wrap({
        retrievePaymentIntent: async (id) => {
          if (!fired) {
            fired = true;
            // A second tap lands, minting a live row this request's pre-tx
            // pass has already walked past.
            await db.insert(chargesTable).values({
              id: randomUUID(),
              ownerId: FIXTURE_IDS.ownerId,
              stripePaymentIntentId: `pi_late_${randomUUID().slice(0, 8)}`,
              amountCents: PUPPY_PRICE_PER_DOG_CENTS,
              status: 'requires_payment',
              purpose: 'group-class',
              bookingId: anchored.bookingId,
              cohortId: cohort.id,
              dogId: FIXTURE_IDS.dog1Id,
            });
          }
          return stripe.retrievePaymentIntent(id);
        },
      });

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `a2w6-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(
        body.money_outcome,
        'release_pending',
        'a pending row visible at COMMIT time must never be spoken over as "never charged"',
      );
      assert.equal('released_cents' in body, false);
      assert.equal(await invoiceStatus(staged.invoiceId), 'void');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.9.7 the ordinary paid arm still REFUNDS, and now says so',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    const withdrawKey = `wc10w-${randomUUID()}`;
    try {
      const res = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc10-${randomUUID()}`,
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal((await chargeRow(cohort.id)).status, 'succeeded', 'captured at enroll time');

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: withdrawKey,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded');
      assert.equal(body.refunded_cents, PUPPY_PRICE_PER_DOG_CENTS);
      assert.equal(body.released_cents, undefined);
      assert.deepEqual(refundKeys(stripe), [`${withdrawKey}:refund`]);
      assert.equal(countCalls(stripe, 'cancelPaymentIntent'), 0);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.15/1 a paid enrollment with NO PaymentIntent owes a MANUAL refund — and says so, loudly and truthfully',
  SKIP_WHEN_NO_DB,
  async () => {
    // AMENDS §A3.9 test 8, which pinned `'none'`. R4-1 finding 1: `'none'`
    // renders "There's no charge on file to return." — affirmatively FALSE to
    // an owner who IS owed money, and the one sentence in this build that
    // would make them stop pursuing it. The money handling is unchanged (the
    // queued unroutable design still owns the mint); only the SENTENCE is.
    const cohort = await makeCohort();
    const capture = makeLogCapture();
    const { app, stripe } = trackedApp(capture);
    try {
      const res = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc11-${randomUUID()}`,
        payLater: true,
      });
      assert.equal(res.statusCode, 201, res.body);
      // Pre-Stripe-wire money: the class was paid on a charge with no route home.
      await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohort.id));
      await db.insert(chargesTable).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        stripePaymentIntentId: null,
        amountCents: PUPPY_PRICE_PER_DOG_CENTS,
        status: 'succeeded',
        purpose: 'group-class',
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
      });

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `wc11w-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refund_manual', 'a refund IS owed — by hand');
      assert.equal(
        body.owed_cents,
        PUPPY_PRICE_PER_DOG_CENTS,
        'the R9 remainder, computed for the sentence',
      );
      assert.equal(body.refunded_cents, 0, 'nothing was minted — refunded_cents keeps its invariant');
      assert.equal(countCalls(stripe, 'createRefund'), 0, 'there is nowhere to send it');
      const noMint = await refundRows(cohort.id);
      assert.equal(noMint.length, 0, 'the queued unroutable design owns the mint, not this arm');

      const alarms = capture.lines.filter(
        (line) =>
          line.level === 50 && String(line.msg).includes('no PaymentIntent'),
      );
      assert.equal(alarms.length, 1, 'said once, at ERROR, naming the money');
      assert.equal(alarms[0]!.amountCents, PUPPY_PRICE_PER_DOG_CENTS);
      assert.equal(alarms[0]!.ownerId, FIXTURE_IDS.ownerId);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// §A3.15/2 — an already-settled charge is not this withdraw's business
// ──────────────────────────────────────────────────────────────────────────

test(
  '§A3.15/2 THE SHADOW: a re-enrolled dog’s withdraw settles the LIVE hold, not the old fully-refunded charge',
  SKIP_WHEN_NO_DB,
  async () => {
    // R4-1 finding 2, the live path. Withdraw #1's charge stays
    // `status='succeeded'` until the `charge.refund.updated` webhook flips it
    // (R9's flip rule) — and THAT LAG IS THE SHADOW WINDOW. A re-enroll inside
    // it puts a live hold on the card while the old, fully-refunded charge
    // still looks "paid" to any read that stops at `status='succeeded'`.
    //
    // RED against the pre-fix build: withdraw #2 matched the OLD charge,
    // computed maxRefund = 0, minted nothing — and announced `'refunded'` with
    // `refunded_cents: 0` ("Your $0.00 refund is on its way") while never
    // mentioning the live hold it had just walked past.
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const first = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc23-${randomUUID()}`,
      });
      assert.equal(first.statusCode, 201, first.body);
      const oldCharge = await chargeRow(cohort.id);
      assert.equal(oldCharge.status, 'succeeded');

      const w1 = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `wc23w1-${randomUUID()}`,
      });
      assert.equal((w1.json() as EnrollmentWithdrawResultWire).money_outcome, 'refunded');
      const refundsAfterFirst = await refundRows(cohort.id);
      assert.equal(refundsAfterFirst.length, 1);
      // No webhook has fired, so the charge is STILL 'succeeded' — the shadow.
      assert.equal(
        (await chargeRow(cohort.id)).status,
        'succeeded',
        'the flip waits on charge.refund.updated; this lag is the window',
      );

      // The owner changes their mind. Both capture attempts fail, so the new
      // enrollment rests on a LIVE hold.
      stripe.throwOnCapture(2);
      const second = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc23e2-${randomUUID()}`,
      });
      assert.equal(second.statusCode, 201, second.body);
      const rows = await db
        .select({
          id: chargesTable.id,
          status: chargesTable.status,
          pi: chargesTable.stripePaymentIntentId,
        })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      assert.equal(rows.length, 2, 'old settled charge + the new live hold');
      const newCharge = rows.find((r) => r.id !== oldCharge.id);
      assert.ok(newCharge?.pi);
      assert.equal(newCharge.status, 'requires_payment');
      const refundCallsBefore = countCalls(stripe, 'createRefund');

      const w2 = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `wc23w2-${randomUUID()}`,
      });
      assert.equal(w2.statusCode, 200, w2.body);
      const body = w2.json() as EnrollmentWithdrawResultWire;
      assert.equal(
        body.money_outcome,
        'released',
        'the settled charge is skipped; the LIVE hold is what this withdraw is about',
      );
      assert.equal(body.released_cents, PUPPY_PRICE_PER_DOG_CENTS);
      assert.equal(body.refunded_cents, 0);

      // The live hold is actually released, and the old money is untouched.
      assert.equal(
        (await stripe.retrievePaymentIntent(newCharge.pi)).status,
        'canceled',
        'the new hold is cancelled at Stripe, not silently left to the reconciler',
      );
      const after = await db
        .select({ id: chargesTable.id, status: chargesTable.status })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      assert.equal(after.find((r) => r.id === newCharge.id)?.status, 'failed');
      assert.equal(
        after.find((r) => r.id === oldCharge.id)?.status,
        'succeeded',
        'the old charge is left exactly as the webhook will find it',
      );
      assert.equal(
        countCalls(stripe, 'createRefund'),
        refundCallsBefore,
        'ZERO new refund mints — there was nothing left to return',
      );
      assert.equal((await refundRows(cohort.id)).length, 1, 'still the one refund from withdraw #1');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.15/2 the DIRECT route: a fully-refunded charge with no live hold answers `none`, and mints nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    // The latent half of finding 2, without the re-enroll. `'none'` is TRUE
    // here — nothing is left to return — where `'refunded'` with 0 was not.
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const res = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc24-${randomUUID()}`,
      });
      assert.equal(res.statusCode, 201, res.body);
      const row = await chargeRow(cohort.id);
      // Out-of-band: this charge has already been fully refunded.
      await db.insert(refundsTable).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: row.id,
        bookingId: null,
        amountCents: PUPPY_PRICE_PER_DOG_CENTS,
        reason: 'goodwill',
        stripeIdempotencyKey: null,
      });

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `wc24w-${randomUUID()}`,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'none');
      assert.equal(body.refunded_cents, 0);
      assert.equal(body.released_cents, undefined);
      assert.equal(countCalls(stripe, 'createRefund'), 0);
      assert.equal(
        (await refundRows(cohort.id)).length,
        1,
        'the pre-existing refund only — this withdraw minted nothing',
      );
      assert.equal(await liveBookingCount(cohort.id), 0, 'and the dog is still withdrawn');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.15/2 the BOUNDARY: partial coverage is NOT already-settled — the remainder still refunds',
  SKIP_WHEN_NO_DB,
  async () => {
    // R9 undisturbed. The skip rule must fire on "covered", never on "touched".
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    const withdrawKey = `wc25w-${randomUUID()}`;
    try {
      const res = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc25-${randomUUID()}`,
      });
      assert.equal(res.statusCode, 201, res.body);
      const row = await chargeRow(cohort.id);
      await db.insert(refundsTable).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: row.id,
        bookingId: null,
        amountCents: 5_000,
        reason: 'goodwill',
        stripeIdempotencyKey: null,
      });

      const out = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: withdrawKey,
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded');
      assert.equal(body.refunded_cents, PUPPY_PRICE_PER_DOG_CENTS - 5_000);
      assert.deepEqual(refundKeys(stripe), [`${withdrawKey}:refund`]);
      const minted = (await refundRows(cohort.id)).filter((r) => r.amountCents === 7_000);
      assert.equal(minted.length, 1, 'the remainder was really minted');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// §A3.16 — ONE succeeded-class read, consumed everywhere
// ──────────────────────────────────────────────────────────────────────────

/** A reconciler logger that keeps what it was told, so an alarm can be
 *  asserted as the product behavior it is. */
function tickLog(): {
  lines: { level: 'info' | 'warn' | 'error'; obj: Record<string, unknown>; msg: string }[];
  log: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
  };
} {
  const lines: { level: 'info' | 'warn' | 'error'; obj: Record<string, unknown>; msg: string }[] =
    [];
  return {
    lines,
    log: {
      info: (obj, msg = '') => lines.push({ level: 'info', obj, msg }),
      warn: (obj, msg = '') => lines.push({ level: 'warn', obj, msg }),
      error: (obj, msg = '') => lines.push({ level: 'error', obj, msg }),
    },
  };
}

/** Put a (cohort, dog) into the shadow state: an old succeeded charge whose
 *  refunds fully cover it, still resting at `'succeeded'` because the
 *  `charge.refund.updated` webhook has not landed. Returns the old charge. */
async function intoShadow(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  cohortId: string;
  key: string;
}): Promise<{ id: string; bookings: { id: string; createdAt: string }[] }> {
  const first = await enroll({
    app: opts.app,
    cohortId: opts.cohortId,
    dogIds: [FIXTURE_IDS.dog1Id],
    key: `${opts.key}-e`,
  });
  assert.equal(first.statusCode, 201, first.body);
  const old = await chargeRow(opts.cohortId);
  assert.equal(old.status, 'succeeded');
  // The live set BEFORE the withdraw cancels it — this enrollment's identity
  // (§A3.17), which the covered charge below is a member of. Returned so a
  // caller can ask the money read the question it actually means: "is THIS
  // enrollment's money still in hand?", not "does this dog have an enrollment".
  const bookings = await withActor(`owner:${FIXTURE_IDS.ownerId}`, (tx) =>
    bookingsRepository.findLiveBookingsForCohortDog(tx, opts.cohortId, FIXTURE_IDS.dog1Id),
  );
  const w = await withdraw({
    app: opts.app,
    cohortId: opts.cohortId,
    dogId: FIXTURE_IDS.dog1Id,
    key: `${opts.key}-w`,
  });
  assert.equal((w.json() as EnrollmentWithdrawResultWire).money_outcome, 'refunded');
  assert.equal(
    (await chargeRow(opts.cohortId)).status,
    'succeeded',
    'the webhook has not fired: the covered charge still reads succeeded',
  );
  return { id: old.id, bookings };
}

test(
  '§A3.16/2 PROBE1 — two succeeded charges: the withdraw refunds the NEW one, not "nothing on file"',
  SKIP_WHEN_NO_DB,
  async () => {
    // Measured RED by the R4-2 probe: the raw read is `.limit(1)` with NO
    // ORDER BY, so it returned the OLD fully-covered row, §A3.15's skip
    // skipped it, the priority order fell through to `'none'` — and an owner
    // owed 12000c read "There's no charge on file to return."
    //
    // That is §A3.15 Finding 1's own ruling violated by its sibling repair.
    const cohort = await makeCohort();
    const { app } = trackedApp();
    try {
      const old = await intoShadow({ app, cohortId: cohort.id, key: `wc26-${randomUUID()}` });

      // An ORDINARY re-enroll inside the lag window — capture SUCCEEDS, so the
      // (cohort, dog) now carries TWO succeeded charges.
      const second = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc26e2-${randomUUID()}`,
      });
      assert.equal(second.statusCode, 201, second.body);
      const rows = await db
        .select({ id: chargesTable.id, status: chargesTable.status })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      assert.equal(rows.length, 2);
      const newCharge = rows.find((r) => r.id !== old.id);
      assert.ok(newCharge);
      assert.equal(newCharge.status, 'succeeded', 'the new enrollment really was captured');

      const mintsBefore = (await refundRows(cohort.id)).length;
      const w2 = await withdraw({
        app,
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        key: `wc26w2-${randomUUID()}`,
      });
      assert.equal(w2.statusCode, 200, w2.body);
      const body = w2.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded', 'the owner IS owed the new enrollment’s money');
      assert.equal(body.refunded_cents, PUPPY_PRICE_PER_DOG_CENTS);

      const mints = await refundRows(cohort.id);
      assert.equal(mints.length, mintsBefore + 1, 'exactly one new mint');
      const fresh = mints.filter((r) => r.chargeId === newCharge.id);
      assert.equal(fresh.length, 1, 'and it is against the NEW charge');
      assert.equal(fresh[0]!.amountCents, PUPPY_PRICE_PER_DOG_CENTS);
      assert.equal(
        mints.filter((r) => r.chargeId === old.id).length,
        1,
        'the old charge keeps its single original refund — untouched',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.16/1 PROBE3 — an enrolled dog’s live hold is CAPTURED, not released, when the only "paid" charge is fully refunded',
  SKIP_WHEN_NO_DB,
  async () => {
    // The HIGH finding, measured. Round 4 promoted the owed predicate from
    // "should we page a human" to "may we cancel this authorization" — and the
    // predicate was still reading the RAW succeeded charge. In the shadow it
    // answered "already collected", so the tick CANCELLED a live hold for a
    // dog with four live bookings, collected nothing, and raised no alarm
    // (`captured: 0` alarms nothing).
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      await intoShadow({ app, cohortId: cohort.id, key: `wc27-${randomUUID()}` });

      // Re-enroll with capture failing: the dog IS enrolled and its money is
      // sitting in a live authorization.
      stripe.throwOnCapture(2);
      const second = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc27e2-${randomUUID()}`,
      });
      assert.equal(second.statusCode, 201, second.body);
      const rows = await db
        .select({
          id: chargesTable.id,
          status: chargesTable.status,
          pi: chargesTable.stripePaymentIntentId,
        })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      const hold = rows.find((r) => r.status === 'requires_payment');
      assert.ok(hold?.pi);
      assert.ok(await liveBookingCount(cohort.id), 'the dog is enrolled');

      const cancelsBefore = countCalls(stripe, 'cancelPaymentIntent');
      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.equal(
        tick.results.find((r) => r.chargeId === hold.id)?.outcome,
        'captured',
        'this enrollment is genuinely unpaid — the hold is money we are owed',
      );
      assert.equal(tick.captured, 1);
      assert.equal(tick.withdrawnReleased, 0);
      assert.equal(
        countCalls(stripe, 'cancelPaymentIntent'),
        cancelsBefore,
        'and NOTHING was cancelled',
      );
      assert.equal(
        (await stripe.retrievePaymentIntent(hold.pi)).status,
        'succeeded',
        'the money moved for the class being delivered',
      );
      const after = await db
        .select({ id: chargesTable.id, status: chargesTable.status })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      assert.equal(after.find((r) => r.id === hold.id)?.status, 'succeeded');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.16 PROBE4 — the unified read is the predicate: a fully-covered charge is NOT money in hand',
  SKIP_WHEN_NO_DB,
  async () => {
    // PROBE4 adapted: the raw read no longer exists to compare against, so the
    // unified read's own answer is the pin. `undefined` here is what makes
    // `enrollmentStillOwesMoney` say TRUE — one function, so the withdraw's
    // question and the reconciler's can never drift apart again.
    //
    // Asked with the identity of the enrollment that OWNS the covered charge
    // (§A3.17 made the identity a required argument). That is deliberate and it
    // is what keeps this test about COVERAGE: asking with the current — absent
    // — enrollment would answer `undefined` for membership reasons and this
    // assertion would pass without measuring the remainder rule at all.
    const cohort = await makeCohort();
    const { app } = trackedApp();
    try {
      const shadow = await intoShadow({ app, cohortId: cohort.id, key: `wc28-${randomUUID()}` });
      const answer = await withActor(`owner:${FIXTURE_IDS.ownerId}`, (tx) =>
        chargesRepository.findUnsettledSucceededCharge(tx, {
          cohortId: cohort.id,
          dogId: FIXTURE_IDS.dog1Id,
          enrollment: enrollmentIdentityOf(shadow.bookings),
        }),
      );
      assert.equal(
        answer,
        undefined,
        'every succeeded charge here is fully refunded — nothing is collected',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.16 the ORDERING: newest-first — an old covered charge never hides the current enrollment’s money',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app } = trackedApp();
    try {
      const old = await intoShadow({ app, cohortId: cohort.id, key: `wc29-${randomUUID()}` });
      const second = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc29e2-${randomUUID()}`,
      });
      assert.equal(second.statusCode, 201, second.body);
      const rows = await db
        .select({ id: chargesTable.id })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      const newCharge = rows.find((r) => r.id !== old.id);

      // Asked as the withdraw asks it: with the CURRENT enrollment's identity
      // (§A3.17). Both rules point the same way here — the new charge is the
      // newest AND the only member — which is the point: enrollment-scoping did
      // not disturb §A3.16's ordering rule, it made it unnecessary to lean on.
      const picked = await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) =>
        chargesRepository.findUnsettledSucceededCharge(tx, {
          cohortId: cohort.id,
          dogId: FIXTURE_IDS.dog1Id,
          enrollment: enrollmentIdentityOf(
            await bookingsRepository.findLiveBookingsForCohortDog(
              tx,
              cohort.id,
              FIXTURE_IDS.dog1Id,
            ),
          ),
        }),
      );
      assert.equal(
        picked?.id,
        newCharge?.id,
        'the CURRENT enrollment’s charge — under no-proration a withdraw returns this class’s money',
      );
      assert.equal(picked?.remainingCents, PUPPY_PRICE_PER_DOG_CENTS);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.16 R6 walk — LOST HOLD now PAGES for a fully-covered enrollment whose hold is gone',
  SKIP_WHEN_NO_DB,
  async () => {
    // The alarm form of Finding 1. A dog is enrolled, its authorization is
    // cancelled, and the only "paid" charge was fully refunded: nothing will
    // ever pay for a class being delivered. Silent before; truthful now.
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      await intoShadow({ app, cohortId: cohort.id, key: `wc30-${randomUUID()}` });
      stripe.throwOnCapture(2);
      const second = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc30e2-${randomUUID()}`,
      });
      assert.equal(second.statusCode, 201, second.body);
      const rows = await db
        .select({
          id: chargesTable.id,
          status: chargesTable.status,
          pi: chargesTable.stripePaymentIntentId,
        })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      const hold = rows.find((r) => r.status === 'requires_payment');
      assert.ok(hold?.pi);
      // The hold is gone — expired, or released by something else.
      await stripe.cancelPaymentIntent(hold.pi);

      const recorder = tickLog();
      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
        log: recorder.log,
      });
      assert.equal(tick.results.find((r) => r.chargeId === hold.id)?.outcome, 'lost-hold');
      assert.equal(tick.lostHolds, 1);
      const paged = recorder.lines.filter(
        (l) => l.level === 'error' && l.msg.includes('LOST HOLD'),
      );
      assert.equal(paged.length, 1, 'a human is called, once');
      assert.equal(paged[0]!.obj.chargeId, hold.id);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.16 R6 walk — the BOUNDARY holds: partial coverage still reads as collected, and stays quiet',
  SKIP_WHEN_NO_DB,
  async () => {
    // The boundary that moves is exactly and only the FULLY-covered class. A
    // charge with a remainder is money in hand, so a cancelled hold beside it
    // is not an incident — unchanged, and pinned so the flip cannot widen.
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      const first = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc31-${randomUUID()}`,
      });
      assert.equal(first.statusCode, 201, first.body);
      const paid = await chargeRow(cohort.id);
      // A PARTIAL out-of-band refund: this charge still holds money.
      await db.insert(refundsTable).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: paid.id,
        bookingId: null,
        amountCents: 5_000,
        reason: 'goodwill',
        stripeIdempotencyKey: null,
      });
      // A dead hold row beside it, for the same (cohort, dog).
      const deadIntent = await stripe.createAndConfirmPaymentIntent(
        {
          customerId: 'cus_x',
          paymentMethodId: 'pm_x',
          amountCents: PUPPY_PRICE_PER_DOG_CENTS,
          currency: 'usd',
          metadata: {},
          captureMethod: 'manual',
        },
        `wc31-dead-${randomUUID()}`,
      );
      await stripe.cancelPaymentIntent(deadIntent.id);
      const deadRowId = randomUUID();
      await db.insert(chargesTable).values({
        id: deadRowId,
        ownerId: FIXTURE_IDS.ownerId,
        stripePaymentIntentId: deadIntent.id,
        amountCents: PUPPY_PRICE_PER_DOG_CENTS,
        status: 'requires_payment',
        purpose: 'group-class',
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });

      const recorder = tickLog();
      const tick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
        log: recorder.log,
      });
      assert.equal(
        tick.results.find((r) => r.chargeId === deadRowId)?.outcome,
        'released',
        'money IS in hand on the partially-refunded charge — not an incident',
      );
      assert.equal(tick.lostHolds, 0);
      assert.equal(
        recorder.lines.filter((l) => l.level === 'error' && l.msg.includes('LOST HOLD')).length,
        0,
        'and nobody is paged',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.16 R6 walk — the abandon split: a fully-covered enrolled dog counts as UNCOLLECTED; a withdrawn one stays bookkeeping',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      await intoShadow({ app, cohortId: cohort.id, key: `wc32-${randomUUID()}` });
      stripe.throwOnCapture(2);
      const second = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc32e2-${randomUUID()}`,
      });
      assert.equal(second.statusCode, 201, second.body);
      const rows = await db
        .select({ id: chargesTable.id, status: chargesTable.status })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      const hold = rows.find((r) => r.status === 'requires_payment');
      assert.ok(hold);
      // Age it past the 24h abandon floor: this phase has given up on it.
      const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      await db
        .update(chargesTable)
        .set({ createdAt: old })
        .where(eq(chargesTable.id, hold.id));

      const enrolledTick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 10 * 60 * 1000),
        log: tickLog().log,
      });
      assert.ok(enrolledTick.abandoned >= 1, 'the row is abandoned');
      assert.ok(
        enrolledTick.abandonedUncollected >= 1,
        'and it is MONEY — a class being delivered that nothing will pay for',
      );

      // Now the dog withdraws. The same row becomes bookkeeping.
      await db
        .update(bookingsTable)
        .set({ status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: 'owner' })
        .where(eq(bookingsTable.cohortId, cohort.id));
      const withdrawnTick = await runCaptureReconcilerOnce({
        stripe,
        now: new Date(Date.now() + 11 * 60 * 1000),
        log: tickLog().log,
      });
      assert.equal(
        withdrawnTick.abandonedUncollected,
        0,
        'nothing is owed for a class we are not delivering',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// §A3.13 — `retry_of`: re-verify before minting
// ──────────────────────────────────────────────────────────────────────────

test(
  '§A3.13 retry_of — the original SETTLED to a hold: the retry adopts it and captures it, minting ZERO new intents',
  SKIP_WHEN_NO_DB,
  async () => {
    // The negative assertion is the point. "The retry adopted the original" is
    // only worth something beside "and no second hold was minted" — the whole
    // hazard ruling 2 opens is two live authorizations on one card.
    const cohort = await makeCohort();
    const { app, stripe, intentIdByKey, executedIntentIds } = trackedApp();
    const firstKey = `wc12-${randomUUID()}`;
    try {
      // Attempt 1: the card is still verifying.
      stripe.setNextIntentStatus('processing');
      const first = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: firstKey,
      });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal((first.json() as Envelope).results[0]?.reason, 'charge_unverified');
      assert.equal(executedIntentIds.size, 1, 'one intent so far');
      const originalIntent = intentIdByKey.get(`${firstKey}:dog:${FIXTURE_IDS.dog1Id}`);
      assert.ok(originalIntent);

      // The verification settles the way a manual-capture confirm settles.
      stripe.setIntentState(originalIntent, 'requires_capture');

      const retry = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc12r-${randomUUID()}`,
        retryOf: firstKey,
      });
      assert.equal(retry.statusCode, 201, retry.body);
      const envelope = retry.json() as Envelope;
      assert.equal(envelope.results[0]?.enrolled, true);
      assert.equal(envelope.results[0]?.payment_state, 'paid');
      assert.equal(envelope.total_captured_cents, PUPPY_PRICE_PER_DOG_CENTS);

      assert.equal(
        executedIntentIds.size,
        1,
        'ZERO new intents: the owner had one hold and it is the one that was charged',
      );
      const captures = stripe.calls.filter((c) => c.method === 'capturePaymentIntent');
      assert.equal(captures.length, 1, 'captured exactly once');
      assert.equal(
        (captures[0] as { args: { paymentIntentId: string } }).args.paymentIntentId,
        originalIntent,
        'and it captured THE ORIGINAL hold',
      );
      const row = await chargeRow(cohort.id);
      assert.equal(row.status, 'succeeded');
      assert.equal(row.paymentIntentId, originalIntent);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.13 retry_of — the original is STILL processing: charge_unverified again, and nothing is minted',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe, executedIntentIds } = trackedApp();
    const firstKey = `wc13-${randomUUID()}`;
    try {
      stripe.setNextIntentStatus('processing');
      const first = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: firstKey,
      });
      assert.equal((first.json() as Envelope).results[0]?.reason, 'charge_unverified');
      assert.equal(executedIntentIds.size, 1);

      const retry = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc13r-${randomUUID()}`,
        retryOf: firstKey,
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal((retry.json() as Envelope).results[0]?.reason, 'charge_unverified');
      assert.equal(
        executedIntentIds.size,
        1,
        'a second hold while the first still verifies is the exact hazard this arm exists to stop',
      );
      assert.equal(countCalls(stripe, 'cancelPaymentIntent'), 0, 'and processing is never cancelled');
      const rows = await db
        .select({ id: chargesTable.id })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      assert.equal(rows.length, 0, 'no charge row for a dog that never enrolled');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.13 retry_of — the original is TERMINAL: the retry mints fresh under its OWN key',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe, intentIdByKey, executedIntentIds } = trackedApp();
    const firstKey = `wc14-${randomUUID()}`;
    const retryKey = `wc14r-${randomUUID()}`;
    try {
      // A blockerless `charge_failed`: the hold was found cancelled. Its intent
      // is terminal by construction, which is why this arm converges on today's
      // behavior.
      stripe.setNextIntentStatus('canceled');
      const first = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: firstKey,
      });
      assert.equal((first.json() as Envelope).results[0]?.reason, 'charge_failed');
      assert.equal((first.json() as Envelope).results[0]?.charge_blocker, undefined);
      const originalIntent = intentIdByKey.get(`${firstKey}:dog:${FIXTURE_IDS.dog1Id}`);
      assert.ok(originalIntent);

      const retry = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: retryKey,
        retryOf: firstKey,
      });
      assert.equal(retry.statusCode, 201, retry.body);
      assert.equal((retry.json() as Envelope).results[0]?.enrolled, true);
      assert.equal(executedIntentIds.size, 2, 'a dead attempt is replaced, not adopted');
      const fresh = intentIdByKey.get(`${retryKey}:dog:${FIXTURE_IDS.dog1Id}`);
      assert.ok(fresh);
      assert.notEqual(fresh, originalIntent, 'and the new hold is minted under the RETRY key');
      assert.equal((await chargeRow(cohort.id)).paymentIntentId, fresh);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.13 retry_of — the original already SUCCEEDED: §4 row 3 stands, and it is never captured twice',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe, intentIdByKey, executedIntentIds } = trackedApp();
    const firstKey = `wc15-${randomUUID()}`;
    try {
      stripe.setNextIntentStatus('processing');
      await enroll({ app, cohortId: cohort.id, dogIds: [FIXTURE_IDS.dog1Id], key: firstKey });
      const originalIntent = intentIdByKey.get(`${firstKey}:dog:${FIXTURE_IDS.dog1Id}`);
      assert.ok(originalIntent);
      stripe.setIntentState(originalIntent, 'succeeded');

      const retry = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc15r-${randomUUID()}`,
        retryOf: firstKey,
      });
      assert.equal(retry.statusCode, 201, retry.body);
      assert.equal((retry.json() as Envelope).results[0]?.payment_state, 'paid');
      assert.equal(executedIntentIds.size, 1, 'no second intent for money that already moved');
      assert.equal(
        countCalls(stripe, 'capturePaymentIntent'),
        0,
        'this key’s logical work already captured — capturing again would be a second charge',
      );
      assert.equal(countCalls(stripe, 'cancelPaymentIntent'), 0, 'and cancelling it would be a refund');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.13 retry_of — a FORGED key naming another owner’s attempt is refused by Stripe, and nothing is enrolled or charged',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe, executedIntentIds } = trackedApp();
    const foreignKey = `wc16-foreign-${randomUUID()}`;
    try {
      // Another owner's attempt, already recorded at Stripe under that key —
      // different customer, different card.
      await stripe.createAndConfirmPaymentIntent(
        {
          customerId: 'cus_someone_else',
          paymentMethodId: 'pm_someone_else',
          amountCents: PUPPY_PRICE_PER_DOG_CENTS,
          currency: 'usd',
          metadata: { owner_id: 'some-other-owner', purpose: 'group-class' },
          captureMethod: 'manual',
        },
        `${foreignKey}:dog:${FIXTURE_IDS.dog1Id}`,
      );
      const callsBefore = stripe.calls.length;

      const forged = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc16r-${randomUUID()}`,
        retryOf: foreignKey,
      });
      // A MAPPED 4xx, not a fall-through 500. `retry_of` is a client-supplied
      // idempotency key, and Stripe's same-key-different-params answer is the
      // same failure this API already has a code for — at Stripe's key store
      // instead of ours. A 500 would say "we broke", when what happened is
      // "you sent a key that isn't yours".
      assert.equal(forged.statusCode, 422, forged.body);
      assert.equal(
        (forged.json() as { error: { code: string } }).error.code,
        'idempotency_mismatch',
      );
      // Stripe's params-mismatch is the primary defence: same key, OUR customer
      // and card, so the parameters cannot match and no money moves.
      assert.equal(
        countCalls(stripe, 'capturePaymentIntent'),
        0,
        'nothing captured',
      );
      assert.equal(stripe.executedRefunds().length, 0);
      assert.equal(
        executedIntentIds.size,
        0,
        'and the forger did not mint anything of their own either',
      );
      assert.equal(
        stripe.calls.length,
        callsBefore + 1,
        'exactly one Stripe call: the refused confirm',
      );
      const rows = await db
        .select({ id: chargesTable.id })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      assert.equal(rows.length, 0);
      assert.equal(await liveBookingCount(cohort.id), 0, 'nobody was enrolled on somebody else’s money');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.13 retry_of — a CONCURRENT request on the same key is 409, not 422: nothing is wrong with the bookkeeping',
  SKIP_WHEN_NO_DB,
  async () => {
    // Stripe spends ONE error type on two conditions that could not be further
    // apart (`stripeIdempotencyErrorKind`, earned 2026-08-12). Reading them as
    // one would tell an owner their retry was malformed when in fact two of
    // their own taps raced — and the honest answer to a race is "ask again".
    const cohort = await makeCohort();
    const { app, wrap } = trackedApp();
    try {
      wrap({
        async createAndConfirmPaymentIntent() {
          throw new Stripe.errors.StripeIdempotencyError({
            type: 'idempotency_error',
            code: 'idempotency_key_in_use',
            message: 'There is currently another in-progress request using this Idempotent Key.',
            statusCode: 409,
          } as never);
        },
      });

      const raced = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc22r-${randomUUID()}`,
        retryOf: `wc22-${randomUUID()}`,
      });
      assert.equal(raced.statusCode, 409, raced.body);
      assert.equal(
        (raced.json() as { error: { code: string } }).error.code,
        'idempotency_inflight',
        'the other request owns the outcome; this one lost the race and says so',
      );
      const rows = await db
        .select({ id: chargesTable.id })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      assert.equal(rows.length, 0, 'and nothing was written behind either answer');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.13 retry_of — the belt-and-braces owner_id assertion refuses an intent that is not ours',
  SKIP_WHEN_NO_DB,
  async () => {
    // Stripe's params-mismatch already refuses a forged key (test above), so
    // this arm is only reachable if Stripe ever answered with an intent that is
    // not the one we asked for. That is exactly when a belt-and-braces check
    // earns its keep, and an untested guard is a guess — so the retrieve is
    // wrapped to answer with a FOREIGN owner_id.
    const cohort = await makeCohort();
    const { app, stripe, intentIdByKey, wrap } = trackedApp();
    const firstKey = `wc17-${randomUUID()}`;
    try {
      stripe.setNextIntentStatus('processing');
      await enroll({ app, cohortId: cohort.id, dogIds: [FIXTURE_IDS.dog1Id], key: firstKey });
      const originalIntent = intentIdByKey.get(`${firstKey}:dog:${FIXTURE_IDS.dog1Id}`);
      assert.ok(originalIntent);
      stripe.setIntentState(originalIntent, 'requires_capture');

      wrap({
        async retrievePaymentIntent(id) {
          const live = await stripe.retrievePaymentIntent(id);
          return { ...live, metadata: { ...live.metadata, owner_id: 'not-this-owner' } };
        },
      });

      const retry = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc17r-${randomUUID()}`,
        retryOf: firstKey,
      });
      assert.equal(retry.statusCode, 422, retry.body);
      assert.equal((retry.json() as { error: { code: string } }).error.code, 'invalid_payload');
      assert.equal(
        countCalls(stripe, 'capturePaymentIntent'),
        0,
        'an unproven intent is never captured',
      );
      const rows = await db
        .select({ id: chargesTable.id })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      assert.equal(rows.length, 0);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// §A3.14 — `verify_key`: the server names the live attempt
// ──────────────────────────────────────────────────────────────────────────

test(
  '§A3.14 verify_key names THIS request’s key when the mint happened here, and the carried key when a re-verify found it still processing',
  SKIP_WHEN_NO_DB,
  async () => {
    // The two values are the whole rule. A client cannot tell these two
    // `charge_unverified` rows apart — they are byte-identical but for this
    // field — and echoing the wrong one re-verifies a DEAD intent while a live
    // one sits beside it.
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    const firstKey = `wc19-${randomUUID()}`;
    const retryKey = `wc19r-${randomUUID()}`;
    try {
      stripe.setNextIntentStatus('processing');
      const first = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: firstKey,
      });
      const firstRow = (first.json() as Envelope).results[0];
      assert.equal(firstRow?.reason, 'charge_unverified');
      assert.equal(
        firstRow?.verify_key,
        firstKey,
        'the mint happened HERE, so this request’s key names the live intent',
      );

      // Attempt 2 echoes it, finds the intent still processing, and mints
      // nothing — so the key that names the live intent is STILL the first one.
      const second = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: retryKey,
        retryOf: firstRow!.verify_key,
      });
      const secondRow = (second.json() as Envelope).results[0];
      assert.equal(secondRow?.reason, 'charge_unverified');
      assert.equal(
        secondRow?.verify_key,
        firstKey,
        'CARRIED, not this request’s key — this request minted nothing to name',
      );
      assert.notEqual(secondRow?.verify_key, retryKey);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.14 the CHAIN: once a retry mints a fresh intent, verify_key names THAT one — and the next attempt re-verifies it, not the dead original',
  SKIP_WHEN_NO_DB,
  async () => {
    // This is the §A3.13 flaw, walked. A chain that always names the FIRST
    // attempt would re-verify K0's dead intent here and mint a THIRD hold
    // beside K1's live one: two live authorizations on one card.
    const cohort = await makeCohort();
    const { app, stripe, intentIdByKey, executedIntentIds } = trackedApp();
    const k0 = `wc20-a-${randomUUID()}`;
    const k1 = `wc20-b-${randomUUID()}`;
    const k2 = `wc20-c-${randomUUID()}`;
    try {
      // K0: processing, then it resolves TERMINAL between attempts.
      stripe.setNextIntentStatus('processing');
      const a0 = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: k0,
      });
      assert.equal((a0.json() as Envelope).results[0]?.verify_key, k0);
      const original = intentIdByKey.get(`${k0}:dog:${FIXTURE_IDS.dog1Id}`);
      assert.ok(original);
      stripe.setIntentState(original, 'canceled');

      // K1: re-verifies K0, finds it terminal, mints ONE fresh intent — whose
      // own confirm then rests at `processing`.
      stripe.setNextIntentStatus('processing');
      const a1 = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: k1,
        retryOf: k0,
      });
      const row1 = (a1.json() as Envelope).results[0];
      assert.equal(row1?.reason, 'charge_unverified');
      assert.equal(
        row1?.verify_key,
        k1,
        'the live intent is the one THIS attempt minted, so it is the one named',
      );
      assert.equal(executedIntentIds.size, 2, 'K0’s and K1’s — one live, one dead');
      const minted = intentIdByKey.get(`${k1}:dog:${FIXTURE_IDS.dog1Id}`);
      assert.ok(minted);
      assert.notEqual(minted, original);

      // K2 echoes verify_key (= K1) and must re-verify K1's LIVE intent.
      const confirmsBefore = stripe.calls.filter(
        (c) => c.method === 'createAndConfirmPaymentIntent',
      ).length;
      const a2 = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: k2,
        retryOf: row1!.verify_key,
      });
      assert.equal((a2.json() as Envelope).results[0]?.reason, 'charge_unverified');
      const confirmKeys = stripe.calls
        .filter((c) => c.method === 'createAndConfirmPaymentIntent')
        .slice(confirmsBefore)
        .map((c) => c.idempotencyKey);
      assert.deepEqual(
        confirmKeys,
        [`${k1}:dog:${FIXTURE_IDS.dog1Id}`],
        'it re-verified K1’s intent, and asked Stripe nothing else',
      );
      assert.equal(
        executedIntentIds.size,
        2,
        'NO third intent: at most one live hold per dog is the invariant',
      );

      // And when K1's intent finally dies, exactly one fresh mint follows.
      stripe.setIntentState(minted, 'canceled');
      const a3 = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc20-d-${randomUUID()}`,
        retryOf: k1,
      });
      assert.equal(a3.statusCode, 201, a3.body);
      assert.equal((a3.json() as Envelope).results[0]?.enrolled, true);
      assert.equal(executedIntentIds.size, 3, 'exactly one fresh mint, once the live one was dead');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.14 verify_key is present on charge_unverified and on NOTHING else',
  SKIP_WHEN_NO_DB,
  async () => {
    // The absence half. Every other refusal leaves nothing live to re-verify,
    // and a client that echoed a key on one of them would re-confirm under a
    // key whose intent is dead — minting beside nothing, but for no reason.
    const cohort = await makeCohort();
    const { app, stripe } = trackedApp();
    try {
      // A decline: `charge_failed` + blocker, nothing held.
      stripe.setNextIntentThrowsCardError('requires_payment_method');
      const declined = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc21-${randomUUID()}`,
      });
      const declinedRow = (declined.json() as Envelope).results[0];
      assert.equal(declinedRow?.reason, 'charge_failed');
      assert.equal(declinedRow?.charge_blocker, 'declined');
      assert.equal(declinedRow?.verify_key, undefined, 'a decline holds nothing');

      // A blockerless charge_failed: the hold was found already cancelled.
      stripe.setNextIntentStatus('canceled');
      const blockerless = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc21b-${randomUUID()}`,
      });
      const blockerlessRow = (blockerless.json() as Envelope).results[0];
      assert.equal(blockerlessRow?.reason, 'charge_failed');
      assert.equal(blockerlessRow?.charge_blocker, undefined);
      assert.equal(
        blockerlessRow?.verify_key,
        undefined,
        'a terminal intent is not something to re-verify — the fresh mint IS the repair',
      );

      // And an ENROLLED dog carries none either.
      const enrolled = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key: `wc21c-${randomUUID()}`,
      });
      assert.equal(enrolled.statusCode, 201, enrolled.body);
      const enrolledRow = (enrolled.json() as Envelope).results[0];
      assert.equal(enrolledRow?.enrolled, true);
      assert.equal(enrolledRow?.verify_key, undefined);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.13 retry_of — an ABSENT retry_of hashes exactly as a pre-1.12.0 body; a PRESENT one is a different request',
  SKIP_WHEN_NO_DB,
  async () => {
    // The degrade pin. If omitting the field changed the body hash, every
    // Idempotency-Key in flight at the moment 1.12.0 landed would change
    // meaning — and a retry would be answered as a new mutation.
    const cohort = await makeCohort();
    const { app } = trackedApp();
    const key = `wc18-${randomUUID()}`;
    try {
      const first = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key,
      });
      assert.equal(first.statusCode, 201, first.body);

      const replay = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key,
      });
      assert.equal(replay.statusCode, 201, replay.body);
      assert.deepEqual(
        replay.json(),
        first.json(),
        'the same body without retry_of still hashes to the same request',
      );

      const withField = await enroll({
        app,
        cohortId: cohort.id,
        dogIds: [FIXTURE_IDS.dog1Id],
        key,
        retryOf: `some-other-key-${randomUUID()}`,
      });
      assert.equal(withField.statusCode, 422, withField.body);
      assert.equal(
        (withField.json() as { error: { code: string } }).error.code,
        'idempotency_mismatch',
        'because retry_of IS part of the body, and a body that carries it is a different mutation',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);
