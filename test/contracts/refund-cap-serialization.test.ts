import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  charges as chargesTable,
  cohorts as cohortsTable,
  invoices as invoicesTable,
  refunds as refundsTable,
} from '../../src/db/schema/schema.js';
import { refundsRepository } from '../../src/db/repositories/refundsRepository.js';
import { withActor } from '../../src/db/tx.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { runCaptureReconcilerOnce } from '../../src/workers/captureReconciler.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * ADDENDUM 3 §A3.18 D2 — **the R9 cap is a read-modify-write, and it needs the
 * row lock.**
 *
 * OP-9 executed it: two genuinely overlapping transactions — the API withdraw's
 * refund leg and the scheduler's `settlePostWithdrawRefund` — both read
 * `sumNonFailed = 0` for the same charge and both committed a full 12000c
 * pending refund against a 12000c charge, under DISTINCT
 * `withdraw-refund:<uuid>` keys. Two different keys means Stripe replays
 * neither: it would execute BOTH.
 *
 * What already held, so the rule is scoped honestly: pending rows DO count
 * against the cap, so any SEQUENTIAL second minter computes 0 (OP-3, pinned
 * below), and the worklist lease serializes tick-vs-tick (OP-12, pinned below).
 * The open producer was cross-process API-vs-worker overlap, which §A3.17's
 * walk item 6 made more reachable by widening `settlePostWithdrawRefund`.
 *
 * The rule: **no R9 computation without the charge row locked, in the same
 * transaction as the `createPending`** — `SELECT … FOR UPDATE` immediately
 * before the sum. The second minter blocks until the first commits, re-reads
 * the sum INCLUDING the winner's pending row, and computes 0. R5 is preserved:
 * the lock lives only inside the pending-mint transaction and Stripe still
 * fires post-commit. Shape: ONE shared helper
 * ({@link refundsRepository.mintCappedPendingRefund}) at every mint leg, so the
 * lock cannot be forgotten at the next one.
 */

registerFixtureHooks();

const SIX_WEEKS_OUT_UTC = '2026-07-06T23:00:00Z';
const PRICE = 12_000;

type Stub = ReturnType<typeof makeStripeStub>;
type App = ReturnType<typeof makeContractApp>['app'];

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

function enrollApp(): { app: App; stripe: Stub } {
  const stripe = makeStripeStub();
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

async function enroll(opts: { app: App; cohortId: string }): Promise<{
  statusCode: number;
  body: string;
}> {
  return opts.app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `rcs-${randomUUID()}` },
    payload: {
      cohort_id: opts.cohortId,
      dog_ids: [FIXTURE_IDS.dog1Id],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: false,
      allow_partial: true,
    },
  });
}

async function chargeRows(cohortId: string): Promise<
  { id: string; status: string; amountCents: number; pi: string | null }[]
> {
  return db
    .select({
      id: chargesTable.id,
      status: chargesTable.status,
      amountCents: chargesTable.amountCents,
      pi: chargesTable.stripePaymentIntentId,
    })
    .from(chargesTable)
    .where(eq(chargesTable.cohortId, cohortId));
}

async function refundsFor(
  chargeId: string,
): Promise<{ id: string; amountCents: number; status: string; key: string | null }[]> {
  return db
    .select({
      id: refundsTable.id,
      amountCents: refundsTable.amountCents,
      status: refundsTable.status,
      key: refundsTable.stripeIdempotencyKey,
    })
    .from(refundsTable)
    .where(eq(refundsTable.chargeId, chargeId));
}

async function cleanup(cohortId: string): Promise<void> {
  for (const row of await chargeRows(cohortId)) {
    await db.delete(refundsTable).where(eq(refundsTable.chargeId, row.id));
  }
  await db.delete(chargesTable).where(eq(chargesTable.cohortId, cohortId));
  await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohortId));
}

/**
 * A two-arrival rendezvous. Both transactions must be OPEN, on their own pooled
 * connections, before either one reaches the mint — otherwise the test proves
 * only that sequential mints are capped, which was never in doubt (OP-3).
 *
 * **The timeout REJECTS; it does not resolve (§A3.19 R2).** The first version
 * raced the gate against a 5s `setTimeout` that RESOLVED it, so a run where the
 * two transactions never actually overlapped — a one-connection pool, a
 * serialized driver, a future `withActor` that queues — degraded silently to
 * sequential and still PASSED, reporting an overlap proof it had not performed.
 * An overlap proof that can pass sequentially proves nothing. Now the degrade
 * is a FAILURE with the arrival count in the message, and the hardening itself
 * was verified by forcing the degrade and watching this fail.
 */
function makeBarrier(timeoutMs = 5000): {
  arrive: (tag: string) => Promise<void>;
  arrived: () => number;
} {
  let count = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    arrived: () => count,
    arrive: async (tag: string) => {
      count += 1;
      if (count === 2) open();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `barrier timed out after ${timeoutMs}ms with ${count}/2 arrived ` +
                  `(waiter '${tag}'): the two transactions did NOT overlap, so this ` +
                  `run proves nothing about serialization — failing rather than ` +
                  `passing a degraded proof`,
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      });
      try {
        await Promise.race([gate, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// OP-9 promoted — the overlap that produced a real double refund
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.18-D2a (OP-9) two OVERLAPPING mints against one charge produce exactly ONE refund, capped — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED-FIRST NOTE: this test drives the shared helper, which is the
    // deliverable. Its red was proven by MUTATION — the helper's lock removed,
    // leaving the sequence the tree shipped (sum → cap → createPending) — which
    // reproduces OP-9 exactly: both transactions read 0, both commit 12000c,
    // total 24000c against a 12000c charge, under two different Stripe keys.
    const cohort = await makeCohort();
    const { app } = enrollApp();
    try {
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const charge = (await chargeRows(cohort.id)).find((r) => r.status === 'succeeded');
      assert.ok(charge, 'the enroll captured a succeeded charge');

      const barrier = makeBarrier();
      const mint = (tag: string) =>
        withActor('system:scheduler', async (tx) => {
          // Force the transaction OPEN on its own connection before the
          // rendezvous, so the two really do overlap rather than queue.
          await tx.execute(sql`SELECT 1`);
          await barrier.arrive(tag);
          return refundsRepository.mintCappedPendingRefund(tx, {
            chargeId: charge.id,
            ownerId: FIXTURE_IDS.ownerId,
            bookingId: null,
            reason: 'cancel',
            stripeIdempotencyKey: (refundId) => `withdraw-refund:${refundId}`,
          });
        });

      const [a, b] = await Promise.all([mint('A'), mint('B')]);
      assert.equal(barrier.arrived(), 2, 'the two transactions genuinely overlapped');

      const minted = [a, b].filter((r) => r.kind === 'minted');
      const empty = [a, b].filter((r) => r.kind === 'nothing-to-refund');
      assert.equal(minted.length, 1, 'exactly one transaction may commit a refund');
      assert.equal(empty.length, 1, 'the loser blocked, re-read the sum, and computed 0');

      const rows = await refundsFor(charge.id);
      assert.equal(rows.length, 1, 'exactly ONE refund row exists');
      assert.equal(
        rows.reduce((sum, r) => sum + r.amountCents, 0),
        charge.amountCents,
        'and the total returned never exceeds the charge (R9)',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.18-D2b (OP-3) the SEQUENTIAL cap still holds: a pending row counts against the next minter — PIN',
  SKIP_WHEN_NO_DB,
  async () => {
    // This always held and must keep holding — it is the half of R9 the lock
    // does not change. Pinned so a future edit to the helper cannot quietly
    // start ignoring pending rows (R35: a commitment to return money is money
    // already spoken for).
    const cohort = await makeCohort();
    const { app } = enrollApp();
    try {
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const charge = (await chargeRows(cohort.id)).find((r) => r.status === 'succeeded');
      assert.ok(charge);

      const once = () =>
        withActor('system:scheduler', (tx) =>
          refundsRepository.mintCappedPendingRefund(tx, {
            chargeId: charge.id,
            ownerId: FIXTURE_IDS.ownerId,
            bookingId: null,
            reason: 'cancel',
            stripeIdempotencyKey: (refundId) => `withdraw-refund:${refundId}`,
          }),
        );

      const first = await once();
      assert.equal(first.kind, 'minted');
      assert.equal(first.kind === 'minted' ? first.amountCents : 0, PRICE);
      const second = await once();
      assert.equal(second.kind, 'nothing-to-refund', 'the pending row already spoke for it');
      assert.equal((await refundsFor(charge.id)).length, 1);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.18-D2c (OP-12) two concurrent reconciler ticks never double-refund one dead-enrollment hold — PIN',
  SKIP_WHEN_NO_DB,
  async () => {
    // The worklist lease already made this safe (OP-12 measured the second tick
    // scanning 0 rows). Re-pinned because the lease is the OTHER half of the
    // serialization story, and D2's lock must not be read as replacing it.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      stripe.throwOnCapture(2);
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const hold = (await chargeRows(cohort.id)).find((r) => r.status === 'requires_payment');
      assert.ok(hold?.pi);

      // The enrollment is GONE, the charge row survives, and Stripe's truth is
      // that the capture completed — the race the post-withdraw refund exists
      // for.
      await db
        .update(bookingsTable)
        .set({ status: 'cancelled' })
        .where(eq(bookingsTable.cohortId, cohort.id));
      stripe.setIntentState(hold.pi, 'succeeded');
      await db
        .update(chargesTable)
        .set({
          createdAt: sql`now() - interval '30 minutes'`,
          updatedAt: sql`now() - interval '30 minutes'`,
        })
        .where(eq(chargesTable.id, hold.id));

      const now = new Date();
      await Promise.all([
        runCaptureReconcilerOnce({ stripe, now }),
        runCaptureReconcilerOnce({ stripe, now }),
      ]);

      const rows = await refundsFor(hold.id);
      assert.ok(rows.length <= 1, `at most one refund row, got ${rows.length}`);
      assert.ok(
        rows.reduce((sum, r) => sum + r.amountCents, 0) <= hold.amountCents,
        'the total returned never exceeds the charge',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.18-D2d the helper refuses a charge with no PaymentIntent instead of minting an unsendable row — PIN',
  SKIP_WHEN_NO_DB,
  async () => {
    // Pre-Stripe-wire seed money: the obligation is real but there is nothing at
    // Stripe to reverse. The helper reports it rather than writing a 'pending'
    // row no sweep could ever send — the distinction `createUnroutable` exists
    // for, and the reason the helper returns the cap alongside the refusal.
    const cohort = await makeCohort();
    try {
      const chargeId = randomUUID();
      await db.insert(chargesTable).values({
        id: chargeId,
        ownerId: FIXTURE_IDS.ownerId,
        stripePaymentIntentId: null,
        amountCents: PRICE,
        status: 'succeeded',
        purpose: 'group-class',
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
      });

      const result = await withActor('system:scheduler', (tx) =>
        refundsRepository.mintCappedPendingRefund(tx, {
          chargeId,
          ownerId: FIXTURE_IDS.ownerId,
          bookingId: null,
          reason: 'cancel',
          stripeIdempotencyKey: (refundId) => `withdraw-refund:${refundId}`,
        }),
      );
      assert.equal(result.kind, 'no-payment-intent');
      assert.equal(result.kind === 'no-payment-intent' ? result.amountCents : 0, PRICE);
      assert.equal((await refundsFor(chargeId)).length, 0, 'and it minted nothing');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// MR-A1.2 — the invariant WIDENS: every cap-ENTERING write takes the charge
// lock, and one global lock order (charges → refunds) makes that safe.
//
// The Fable attack lane executed the hole D2 left open
// (`attack-fable-p1/probe-resolve-vs-mint.{ts,log}`): `markResolvedExternal`
// moves a row INTO `sumNonFailedForCharge` (`failed → resolved-external`) with
// NO charge lock and NO coverage guard. Interleaved with a still-open
// `mintCappedPendingRefund`, both commit: **16000c of non-failed refunds on a
// 10000c charge**, and `claimStalePendingForRetry` CLAIMED the over-minted
// pending row — the sweep would fire it. Stripe cannot bound this: the
// resolved-external 6000c moved OUTSIDE Stripe (a check), so Stripe would
// happily send the full 10000c. Money leaves twice.
// ══════════════════════════════════════════════════════════════════════════

/** A standalone succeeded charge (no cohort), the probe's shape. */
async function seedPlainCharge(amountCents: number): Promise<{ id: string; pi: string }> {
  const id = randomUUID();
  const pi = `pi_test_mra1_${randomUUID().slice(0, 8)}`;
  await db.insert(chargesTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentIntentId: pi,
    amountCents,
    status: 'succeeded',
    purpose: 'package',
  });
  return { id, pi };
}

async function seedFailedRefund(chargeId: string, amountCents: number): Promise<string> {
  const id = randomUUID();
  await db.insert(refundsTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    chargeId,
    bookingId: null,
    amountCents,
    status: 'failed',
    reason: 'cancel',
    stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    stripeIdempotencyKey: null,
  });
  return id;
}

async function dropCharge(chargeId: string): Promise<void> {
  await db.delete(refundsTable).where(eq(refundsTable.chargeId, chargeId));
  await db.delete(chargesTable).where(eq(chargesTable.id, chargeId));
}

test(
  '§MR-A1.2a (Fable probe promoted) a resolve OVERLAPPING an open mint can never push non-failed past the charge',
  SKIP_WHEN_NO_DB,
  async () => {
    const charge = await seedPlainCharge(10_000);
    const failedId = await seedFailedRefund(charge.id, 6_000);
    try {
      const barrier = makeBarrier();
      // Tx A — the automatic leg (the withdraw route's tx): mint early, then
      // hold the tx open exactly as a real route tx does for many more
      // statements.
      const mintTx = withActor('system:scheduler', async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await barrier.arrive('mint');
        return refundsRepository.mintCappedPendingRefund(tx, {
          chargeId: charge.id,
          ownerId: FIXTURE_IDS.ownerId,
          bookingId: null,
          reason: 'cancel',
          stripeIdempotencyKey: (refundId) => `withdraw-refund:${refundId}`,
        });
      });
      // Tx B — the staff resolve, landing inside A's window.
      const resolveTx = withActor('staff:probe-resolver', async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await barrier.arrive('resolve');
        return refundsRepository.markResolvedExternal(tx, {
          id: failedId,
          note: 'returned by check #1042',
        });
      });

      const [mint, resolvedCount] = await Promise.all([mintTx, resolveTx]);
      assert.equal(barrier.arrived(), 2, 'the two transactions genuinely overlapped');

      const rows = await refundsFor(charge.id);
      const nonFailed = rows
        .filter((r) => r.status !== 'failed')
        .reduce((sum, r) => sum + r.amountCents, 0);
      assert.ok(
        nonFailed <= 10_000,
        `RED (executed): non-failed summed ${nonFailed} on a 10000c charge — money would leave twice ` +
          `(mint=${JSON.stringify(mint)}, resolvedCount=${resolvedCount})`,
      );

      // And whichever order won, the outcome is COHERENT: either the resolve
      // landed first and the mint capped itself to the live remainder, or the
      // mint landed first and the resolve REFUSED (a refund is in flight).
      if (resolvedCount === 1) {
        assert.ok(
          mint.kind !== 'minted' || mint.amountCents <= 4_000,
          'a mint behind a committed resolve sees the resolved row in the cap',
        );
      } else {
        assert.equal(mint.kind, 'minted', 'the mint won, so the resolve must be the refuser');
        assert.equal(resolvedCount, 0, 'and it refuses rather than stacking on an in-flight refund');
      }

      // The over-minted row is what the sweep would have fired.
      const claimable = rows.filter((r) => r.status === 'pending');
      assert.ok(
        claimable.reduce((s, r) => s + r.amountCents, 0) <= 10_000,
        'no pending row exceeds what the charge can still return',
      );
    } finally {
      await dropCharge(charge.id);
    }
  },
);

test(
  '§MR-A1.2b the verb REFUSES while an automatic refund is in flight (guard a)',
  SKIP_WHEN_NO_DB,
  async () => {
    const charge = await seedPlainCharge(10_000);
    const failedId = await seedFailedRefund(charge.id, 6_000);
    try {
      const minted = await withActor('system:scheduler', (tx) =>
        refundsRepository.mintCappedPendingRefund(tx, {
          chargeId: charge.id,
          ownerId: FIXTURE_IDS.ownerId,
          bookingId: null,
          reason: 'cancel',
          stripeIdempotencyKey: (refundId) => `withdraw-refund:${refundId}`,
        }),
      );
      assert.equal(minted.kind, 'minted', 'staged: a pending refund is in flight');

      const count = await withActor('staff:resolver', (tx) =>
        refundsRepository.markResolvedExternal(tx, { id: failedId, note: 'check #1042' }),
      );
      assert.equal(
        count,
        0,
        'RED today: 1 — resolving under an in-flight refund is exactly the executed interleave',
      );
      const rows = await refundsFor(charge.id);
      assert.equal(
        rows.find((r) => r.id === failedId)?.status,
        'failed',
        'untouched — let the automatic refund settle first',
      );
    } finally {
      await dropCharge(charge.id);
    }
  },
);

test(
  '§MR-A1.2c the verb REFUSES to attest more money than the charge is owed (guard b)',
  SKIP_WHEN_NO_DB,
  async () => {
    const charge = await seedPlainCharge(10_000);
    // 6000c already came back through Stripe; the live remainder is 4000c.
    await db.insert(refundsTable).values({
      ownerId: FIXTURE_IDS.ownerId,
      chargeId: charge.id,
      bookingId: null,
      amountCents: 6_000,
      status: 'succeeded',
      reason: 'cancel',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
      stripeIdempotencyKey: null,
    });
    const oversizedFailed = await seedFailedRefund(charge.id, 6_000);
    try {
      const count = await withActor('staff:resolver', (tx) =>
        refundsRepository.markResolvedExternal(tx, {
          id: oversizedFailed,
          note: 'attesting 6000c against a 4000c remainder',
        }),
      );
      assert.equal(count, 0, 'RED today: 1 — non-failed would sum to 12000c on a 10000c charge');
      assert.equal(
        (await refundsFor(charge.id)).find((r) => r.id === oversizedFailed)?.status,
        'failed',
        'it stays on the worklist, which now shows the LIVE remainder',
      );
    } finally {
      await dropCharge(charge.id);
    }
  },
);

test(
  '§MR-A1.2d the ADOPTION insert is a cap-entering write and takes the charge lock too',
  SKIP_WHEN_NO_DB,
  async () => {
    const charge = await seedPlainCharge(10_000);
    try {
      const barrier = makeBarrier();
      const mintTx = withActor('system:scheduler', async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await barrier.arrive('mint');
        return refundsRepository.mintCappedPendingRefund(tx, {
          chargeId: charge.id,
          ownerId: FIXTURE_IDS.ownerId,
          bookingId: null,
          reason: 'cancel',
          stripeIdempotencyKey: (refundId) => `withdraw-refund:${refundId}`,
        });
      });
      const adoptTx = withActor('system:stripe-webhook', async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await barrier.arrive('adopt');
        return refundsRepository.adoptExternalRefundCapped(tx, {
          chargeId: charge.id,
          ownerId: FIXTURE_IDS.ownerId,
          amountCents: 10_000,
          status: 'succeeded',
          stripeRefundId: `re_test_dash_${randomUUID().slice(0, 8)}`,
        });
      });

      // Settle BOTH before asserting: a rejection from either one must not let
      // the teardown race a still-open transaction into an FK error that
      // replaces the real failure with a plumbing one.
      const [mintOutcome, adoptOutcome] = await Promise.allSettled([mintTx, adoptTx]);
      if (mintOutcome.status === 'rejected') throw mintOutcome.reason as Error;
      if (adoptOutcome.status === 'rejected') throw adoptOutcome.reason as Error;
      const mint = mintOutcome.value;
      const adopted = adoptOutcome.value;
      assert.equal(barrier.arrived(), 2, 'the two transactions genuinely overlapped');
      const rows = await refundsFor(charge.id);
      const nonFailed = rows
        .filter((r) => r.status !== 'failed')
        .reduce((sum, r) => sum + r.amountCents, 0);
      assert.ok(
        nonFailed <= 10_000,
        `non-failed summed ${nonFailed} on a 10000c charge (mint=${mint.kind}, adopt=${adopted.kind})`,
      );
      // Exactly one of the two writers may commit a cap-entering row here: the
      // adoption records money that ALREADY moved at Stripe, so if it wins the
      // mint must cap to 0; if the mint wins the adoption refuses in-flight.
      assert.equal(
        [mint.kind === 'minted', adopted.kind === 'adopted'].filter(Boolean).length,
        1,
        'exactly one cap-entering writer commits',
      );
    } finally {
      await dropCharge(charge.id);
    }
  },
);
