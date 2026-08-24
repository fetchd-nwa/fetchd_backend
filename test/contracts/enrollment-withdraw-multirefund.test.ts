/**
 * The multi-refund post-commit loop — TWO captures settled in ONE withdraw,
 * the state §A2.1 built the `pendingStripeRefunds` LIST for. Promoted from
 * the 2026-08-24 final adversary round's PROBE C (Fable lane), per the
 * probes-promote-to-contract-tests rule.
 *
 * Two pay attempts both processing, both banks clear them, invoice still
 * open. The withdraw must:
 *   - answer `'refunded'` with refunded_cents = Σ minted (2 × price),
 *   - mint TWO pending refund rows, each under its own per-charge key
 *     `${K}:refund:${chargeId}`,
 *   - fire BOTH post-commit; and when the FIRST fire fails, the second must
 *     still fire (the helper logs-and-swallows per refund),
 *   - leave the failed row pending under its STORED key so the sweep re-fires
 *     it — completion is owned by `duplicateRefundRetry`, and the re-fire must
 *     use the SAME key (a replay, never a second refund).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  charges as chargesTable,
  cohorts as cohortsTable,
  invoices as invoicesTable,
  refunds as refundsTable,
} from '../../src/db/schema/schema.js';
import type { EnrollmentWithdrawResultWire } from '../../src/contracts/wire.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { runDuplicateRefundRetryOnce } from '../../src/workers/duplicateRefundRetry.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

registerFixtureHooks();

const SIX_WEEKS_OUT_UTC = '2026-07-06T23:00:00Z';
const PRICE = 12_000;

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

function probeApp() {
  const stripe = makeStripeStub();
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  registerInvoicesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

async function cleanup(cohortId: string): Promise<void> {
  const rows = await db
    .select({ id: chargesTable.id })
    .from(chargesTable)
    .where(eq(chargesTable.cohortId, cohortId));
  for (const row of rows) {
    await db.delete(refundsTable).where(eq(refundsTable.chargeId, row.id));
  }
  await db
    .update(invoicesTable)
    .set({ paidChargeId: null })
    .where(eq(invoicesTable.cohortId, cohortId));
  await db.delete(chargesTable).where(eq(chargesTable.cohortId, cohortId));
  await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohortId));
}

async function enrollPayLater(
  app: ReturnType<typeof makeContractApp>['app'],
  cohortId: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `pce-${randomUUID()}` },
    payload: {
      cohort_id: cohortId,
      dog_ids: [FIXTURE_IDS.dog1Id],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: true,
      allow_partial: true,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const [invoice] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.cohortId, cohortId));
  assert.ok(invoice, 'pay-later enroll minted its invoice');
  return invoice.id;
}

async function payAttemptProcessing(
  app: ReturnType<typeof makeContractApp>['app'],
  stripe: ReturnType<typeof makeStripeStub>,
  invoiceId: string,
): Promise<{ chargeId: string; paymentIntentId: string }> {
  stripe.setNextIntentStatus('processing');
  const res = await app.inject({
    method: 'POST',
    url: `/invoices/${invoiceId}/pay`,
    headers: { 'idempotency-key': `pcp-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { charge_id: string; stripe_payment_intent_id: string };
  return { chargeId: body.charge_id, paymentIntentId: body.stripe_payment_intent_id };
}

test(
  'PROBE C: two captures, first post-commit fire FAILS — the sibling still fires and the sweep completes the failed one under its stored key',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort();
    const { app, stripe } = probeApp();
    const withdrawKey = `pcw-${randomUUID()}`;
    try {
      const invoiceId = await enrollPayLater(app, cohort.id);
      const first = await payAttemptProcessing(app, stripe, invoiceId);
      const second = await payAttemptProcessing(app, stripe, invoiceId);

      // Both banks clear the in-flight payments: the owner paid TWICE for one
      // seat, and the invoice is still open (no webhook has landed).
      stripe.setIntentState(first.paymentIntentId, 'succeeded');
      stripe.setIntentState(second.paymentIntentId, 'succeeded');

      // The partial-loop-failure lever: the FIRST post-commit createRefund
      // rejects before reaching Stripe; the sibling's must not be swallowed
      // with it.
      stripe.throwOnRefund();

      const out = await app.inject({
        method: 'POST',
        url: `/enrollments/${cohort.id}/withdraw`,
        headers: { 'idempotency-key': withdrawKey },
        payload: { dog_id: FIXTURE_IDS.dog1Id },
      });
      assert.equal(out.statusCode, 200, out.body);
      const body = out.json() as EnrollmentWithdrawResultWire;

      // Σ minted this request — BOTH captures owed back (§A2.1/4).
      assert.equal(body.money_outcome, 'refunded');
      assert.equal(
        body.refunded_cents,
        2 * PRICE,
        `refunded_cents must be the SUM over every capture this request minted for, got ${body.refunded_cents}`,
      );

      // Two pending rows, each under its own deterministic per-charge key.
      const refundRows = await db
        .select({
          id: refundsTable.id,
          chargeId: refundsTable.chargeId,
          amountCents: refundsTable.amountCents,
          status: refundsTable.status,
          stripeIdempotencyKey: refundsTable.stripeIdempotencyKey,
          stripeRefundId: refundsTable.stripeRefundId,
        })
        .from(refundsTable)
        .then((rows) => rows.filter((r) => [first.chargeId, second.chargeId].includes(r.chargeId)));
      assert.equal(refundRows.length, 2, 'one refund row per captured charge');
      for (const row of refundRows) {
        assert.equal(row.amountCents, PRICE);
        assert.equal(
          row.stripeIdempotencyKey,
          `${withdrawKey}:refund:${row.chargeId}`,
          'per-charge key, stored in-row in-tx (R35/§A2.1-5)',
        );
      }

      // Partial loop failure: the first fire threw (swallowed+logged), the
      // second still fired. Exactly ONE refund exists at Stripe right now.
      const attempts = stripe.calls.filter((c) => c.method === 'createRefund');
      assert.equal(attempts.length, 2, 'BOTH fires were attempted — one failing must not swallow its sibling');
      assert.equal(stripe.executedRefunds().length, 1, 'the failed fire reached nothing; the sibling landed');

      const landed = refundRows.filter((r) => r.stripeRefundId !== null);
      const stranded = refundRows.filter((r) => r.stripeRefundId === null);
      assert.equal(landed.length, 1, 'the sibling that fired has its re_* persisted');
      assert.equal(stranded.length, 1, 'the failed one stays pending with no re_*');
      assert.equal(stranded[0]!.status, 'pending', 'R35: the pending row IS the commitment');

      // Completion is owned by the sweep: past the grace window it claims the
      // stranded row and re-fires it under the SAME stored key.
      const swept = await runDuplicateRefundRetryOnce({
        stripe,
        now: new Date(Date.now() + 20 * 60 * 1000),
      });
      assert.equal(
        swept.results.find((r) => r.refundId === stranded[0]!.id)?.outcome,
        'sent',
        `the sweep completed the stranded refund: ${JSON.stringify(swept.results)}`,
      );

      const executed = stripe.executedRefunds();
      assert.equal(executed.length, 2, 'after the sweep, exactly TWO refunds exist — one per capture, never a third');
      const refire = stripe.calls.filter((c) => c.method === 'createRefund').at(-1)!;
      assert.equal(
        refire.idempotencyKey,
        stranded[0]!.stripeIdempotencyKey,
        'the sweep re-fired under the row\'s STORED key — a replay, not a new refund',
      );

      const [healed] = await db
        .select({ stripeRefundId: refundsTable.stripeRefundId, status: refundsTable.status })
        .from(refundsTable)
        .where(eq(refundsTable.chargeId, stranded[0]!.chargeId));
      assert.ok(healed?.stripeRefundId, 'the healed row now carries its re_*');

      // Total money on its way back: exactly 2 × price. No charge was minted
      // against twice (R9 cap held per charge under its lock).
      const totalBack = refundRows.reduce((sum, r) => sum + r.amountCents, 0);
      assert.equal(totalBack, 2 * PRICE);
    } finally {
      await cleanup(cohort.id);
    }
  },
);
