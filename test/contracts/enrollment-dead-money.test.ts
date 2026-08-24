import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookingDogs as bookingDogsTable,
  bookings as bookingsTable,
  charges as chargesTable,
  cohorts as cohortsTable,
  invoices as invoicesTable,
  notifications as notificationsTable,
  refunds as refundsTable,
} from '../../src/db/schema/schema.js';
import { enrollmentsRepository } from '../../src/db/repositories/enrollmentsRepository.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { refundsRepository } from '../../src/db/repositories/refundsRepository.js';
import { withActor } from '../../src/db/tx.js';
import type { EnrollmentWithdrawResultWire } from '../../src/contracts/wire.js';
import { settleInvoiceCharge } from '../../src/lib/settleInvoiceCharge.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import {
  runCaptureReconcilerOnce,
  CAPTURE_GRACE_MINUTES,
} from '../../src/workers/captureReconciler.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * ADDENDUM 3 §A3.18 D1 — **dead money must file as dead.**
 *
 * The §A3.17 build resolved a group-class charge's anchor from the CURRENT
 * live set at settle time. But the webhook settle lane deliberately settles
 * VOIDED invoices (`stripeEventHandlers.ts:262-264` — the PI already
 * succeeded, the money MOVED, so the ledger row is written and the void arm
 * refunds it). So the ordinary sequence
 *
 *     pay-later enroll E1 → PI in flight → withdraw ('voided', "you were
 *     never charged") → re-enroll E2 → the settle lands minutes later
 *
 * stamped **E1's money with E2's anchor**, and every consumer downstream then
 * answered for the wrong enrollment: E2 read `payment_status: 'paid'` off E1's
 * charge; when the duplicate refund failed terminally the reopened remainder
 * made E2 look collected and the reconciler cancelled E2's live hold — R4-3's
 * terminal shape, resurrected; E2's own withdraw refunded E1's money and left
 * E2's hold standing.
 *
 * §A3.18.1's ruling: **the invoice learns its own enrollment at MINT time.**
 * Both group-class `createOpen` sites stamp the anchor, every invoice-lane
 * charge mint copies `invoice.booking_id`, and the settle-time resolver is
 * deleted. A late settle of E1's voided invoice then anchors to E1's
 * CANCELLED row — membership answers false-for-current, row-scoped liveness
 * answers dead, and no new rule is needed anywhere downstream.
 *
 * §A3.17's stated mitigation ("stamp NULL, the legacy rule covers it") was
 * executably refuted: a late settle POST-DATES the re-enrollment's birth, so
 * `created_at >= bornAt` files it under E2 by construction. The anchor
 * assertion below subsumes that counterfactual.
 *
 * Every test is marked RED FIRST or PIN against the gated 1218/1218 tree.
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

interface Injected {
  statusCode: number;
  json: () => unknown;
  body: string;
}

async function enroll(opts: {
  app: App;
  cohortId: string;
  payLater?: boolean;
  allowPartial?: boolean;
}): Promise<Injected> {
  return opts.app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': `dm-e-${randomUUID()}` },
    payload: {
      cohort_id: opts.cohortId,
      dog_ids: [FIXTURE_IDS.dog1Id],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: opts.payLater ?? false,
      ...(opts.allowPartial === false ? {} : { allow_partial: true }),
    },
  });
}

async function withdraw(opts: { app: App; cohortId: string }): Promise<Injected> {
  return opts.app.inject({
    method: 'POST',
    url: `/enrollments/${opts.cohortId}/withdraw`,
    headers: { 'idempotency-key': `dm-w-${randomUUID()}` },
    payload: { dog_id: FIXTURE_IDS.dog1Id },
  });
}

interface ChargeSnapshot {
  id: string;
  status: string;
  amountCents: number;
  pi: string | null;
  bookingId: string | null;
}

async function chargeRows(cohortId: string): Promise<ChargeSnapshot[]> {
  return db
    .select({
      id: chargesTable.id,
      status: chargesTable.status,
      amountCents: chargesTable.amountCents,
      pi: chargesTable.stripePaymentIntentId,
      bookingId: chargesTable.bookingId,
    })
    .from(chargesTable)
    .where(eq(chargesTable.cohortId, cohortId));
}

/** The dog's live (non-cancelled) sessions in this cohort, earliest first. */
async function liveSessionIds(cohortId: string): Promise<string[]> {
  const rows = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.cohortId, cohortId),
        eq(bookingsTable.leadDogId, FIXTURE_IDS.dog1Id),
        eq(bookingsTable.status, 'upcoming'),
      ),
    )
    .orderBy(asc(bookingsTable.scheduledAt));
  return rows.map((r) => r.id);
}

async function paymentStatusFor(cohortId: string): Promise<string | undefined> {
  const listed = await enrollmentsRepository.listForOwner(FIXTURE_IDS.ownerId);
  return listed.find((r) => r.cohortId === cohortId && r.dogId === FIXTURE_IDS.dog1Id)
    ?.paymentStatus;
}

async function refundRowsForCohort(
  cohortId: string,
): Promise<{ id: string; chargeId: string; amountCents: number; status: string }[]> {
  const out: { id: string; chargeId: string; amountCents: number; status: string }[] = [];
  for (const c of await chargeRows(cohortId)) {
    const rows = await db
      .select({
        id: refundsTable.id,
        chargeId: refundsTable.chargeId,
        amountCents: refundsTable.amountCents,
        status: refundsTable.status,
      })
      .from(refundsTable)
      .where(eq(refundsTable.chargeId, c.id));
    out.push(...rows);
  }
  return out;
}

async function cleanup(cohortId: string): Promise<void> {
  // FK order: refunds.charge_id → charges, and invoices.paid_charge_id →
  // charges, so a SETTLED invoice pins its charge. Invoices must go BEFORE
  // charges or the teardown raises 23503 and masks the assertion that mattered.
  for (const row of await chargeRows(cohortId)) {
    await db.delete(refundsTable).where(eq(refundsTable.chargeId, row.id));
  }
  await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohortId));
  await db.delete(chargesTable).where(eq(chargesTable.cohortId, cohortId));
}

const capturedIntentsSince = (stripe: Stub, mark: number): string[] =>
  stripe.calls
    .slice(mark)
    .filter((c) => c.method === 'capturePaymentIntent')
    .map((c) => (c as { args: { paymentIntentId: string } }).args.paymentIntentId);

function tickNow(): Date {
  return new Date(Date.now() + (CAPTURE_GRACE_MINUTES + 5) * 60 * 1000);
}

interface LateSettleWorld {
  /** E1's first session — cancelled by the withdraw. Where E1's money belongs. */
  e1Anchor: string;
  /** E2's first session — where the build wrongly filed E1's money. */
  e2Anchor: string;
  e2LiveIds: string[];
  invoiceId: string;
  /** The charge the late settle minted for E1's already-voided invoice. */
  lateChargeId: string;
  lateChargeBookingId: string | null;
  /** E2's live, uncaptured hold. */
  hold: ChargeSnapshot;
}

/**
 * The D1 world, staged through nothing but production verbs: pay-later enroll,
 * withdraw (voids the invoice), re-enroll pay-now with a failing capture, then
 * the webhook's late settle of the VOIDED invoice.
 *
 * `failDuplicateRefund` reproduces the R18/R19 producer (the bank terminally
 * refuses the void arm's refund), which is what reopens the remainder and turns
 * a mis-filed charge into "money in hand" for the wrong enrollment.
 */
async function buildLateSettleWorld(opts: {
  app: App;
  stripe: Stub;
  cohortId: string;
  failDuplicateRefund?: boolean;
}): Promise<LateSettleWorld> {
  // ── E1: pay-later. An open invoice, no charge row yet. Off-stage, the
  //    auto-charge worker has already confirmed a PI that is still settling.
  const e1 = await enroll({ app: opts.app, cohortId: opts.cohortId, payLater: true });
  assert.equal(e1.statusCode, 201, e1.body);
  const e1Anchor = (await liveSessionIds(opts.cohortId))[0]!;
  const [invoiceRow] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.cohortId, opts.cohortId));
  assert.ok(invoiceRow, 'the pay-later enroll wrote an open invoice');

  // ── The withdraw voids it and promises the owner they were never charged.
  const w = await withdraw({ app: opts.app, cohortId: opts.cohortId });
  assert.equal((w.json() as EnrollmentWithdrawResultWire).money_outcome, 'voided', w.body);

  // ── E2: pay-now, capture failing, so E2 rests on a live hold.
  opts.stripe.throwOnCapture(2);
  const e2 = await enroll({ app: opts.app, cohortId: opts.cohortId });
  assert.equal(e2.statusCode, 201, e2.body);
  const e2LiveIds = await liveSessionIds(opts.cohortId);
  assert.ok(e2LiveIds.length > 0, 'the dog IS enrolled again (E2)');
  const hold = (await chargeRows(opts.cohortId)).find(
    (r) => r.status === 'requires_payment' && r.pi !== null,
  );
  assert.ok(hold, 'E2 rests on a live hold');

  // ── The webhook lands: E1's voided invoice had a PI that succeeded. This IS
  //    `maybeSettleOrphanedInvoiceCharge`'s documented invoice-void arm, minus
  //    the webhook envelope. `markPaid` filters `status='open'`, so the void
  //    invoice yields flipped=0 → the lost-race arm mints the charge AND the
  //    full duplicate refund that returns the money.
  const settle = await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
    const invoice = await invoicesRepository.findById(tx, invoiceRow.id);
    assert.ok(invoice, 'invoice row exists');
    assert.equal(invoice.status, 'void', 'the withdraw voided it');
    return settleInvoiceCharge(tx, {
      invoice,
      paymentIntentId: `pi_late_${randomUUID().slice(0, 16)}`,
      amountCents: PRICE,
      purpose: 'group-class',
      notifyOwner: false,
    });
  });
  assert.equal(settle.outcome, 'refunded', 'void arm: lost race ⇒ duplicate refund minted');

  if (opts.failDuplicateRefund === true) {
    // R18/R19: the bank refuses it terminally. `sumNonFailedForCharge` drops
    // failed rows, so the remainder REOPENS — the ordinary producer that turns
    // a mis-filed charge into someone else's "money in hand".
    await db
      .update(refundsTable)
      .set({ status: 'failed' })
      .where(eq(refundsTable.chargeId, settle.chargeId));
  }

  const [late] = await db
    .select({ bookingId: chargesTable.bookingId })
    .from(chargesTable)
    .where(eq(chargesTable.id, settle.chargeId));

  return {
    e1Anchor,
    e2Anchor: e2LiveIds[0]!,
    e2LiveIds,
    invoiceId: invoiceRow.id,
    lateChargeId: settle.chargeId,
    lateChargeBookingId: late?.bookingId ?? null,
    hold,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 1 — the anchor itself, and the two consumers that read it
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.18-D1a (MISSTAMP/OP-1) a late settle of a VOIDED invoice anchors to E1’s cancelled row — never E2’s, never NULL — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: `lateChargeBookingId === e2Anchor` — the
    // settle-time resolver read the CURRENT live set, so the old enrollment's
    // money was filed under the new one. NULL is refuted too (§A3.18.9.1): a
    // late settle post-dates E2's birth, so the legacy time rule would claim
    // it for E2 by construction. Only the dead anchor is honest.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      const w = await buildLateSettleWorld({ app, stripe, cohortId: cohort.id });

      assert.equal(
        w.lateChargeBookingId,
        w.e1Anchor,
        'E1’s money carries E1’s anchor — the enrollment it was actually for',
      );
      assert.notEqual(w.lateChargeBookingId, w.e2Anchor);
      assert.notEqual(w.lateChargeBookingId, null, 'NULL would hand it to E2 via the time rule');
      assert.equal(
        w.e2LiveIds.includes(w.lateChargeBookingId as string),
        false,
        'the anchor is not in E2’s live set, so no membership branch can claim it',
      );

      // Consequence A: `payment_status` is EXISTS-based, not remainder-aware,
      // so a mis-filed succeeded row answered 'paid' for E2 even while its
      // duplicate refund was still pending. Mobile branches its withdraw-dialog
      // money sentence on this field.
      assert.equal(
        await paymentStatusFor(cohort.id),
        'pending',
        'E2 has an uncaptured hold and no money of its own — that is `pending`',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.18-D1b (MISSTAMP consequence B) the reconciler CAPTURES E2’s hold even when E1’s refund failed terminally — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: `'withdrawn-released'` — R4-3's terminal
    // shape, resurrected through the mis-stamp. The bank fails E1's duplicate
    // refund, the remainder reopens, the mis-filed charge answers "collected"
    // for E2, and the tick cancels the live authorization of an ENROLLED dog.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      const w = await buildLateSettleWorld({
        app,
        stripe,
        cohortId: cohort.id,
        failDuplicateRefund: true,
      });
      assert.equal(
        (await refundRowsForCohort(cohort.id)).filter((r) => r.status === 'failed').length,
        1,
        'the remainder really did reopen',
      );

      const mark = stripe.calls.length;
      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow() });
      assert.equal(
        tick.results.find((r) => r.chargeId === w.hold.id)?.outcome,
        'captured',
        'E2 is enrolled, the class is delivered, and E2 has paid nothing',
      );
      assert.deepEqual(capturedIntentsSince(stripe, mark), [w.hold.pi]);
      assert.equal((await liveSessionIds(cohort.id)).length, 4, 'the dog is still enrolled');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.18-D1c (OP-7) a capture that wins the release race cannot double-collect — E2 pays once — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: `'already-captured'` and 24000c held for one
    // 12000c class, with nothing refunded and nothing paged. The race lever is
    // armed to prove it is UNREACHABLE after the fix: owed=true means the tick
    // captures outright and never attempts the cancel that could lose.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      const w = await buildLateSettleWorld({
        app,
        stripe,
        cohortId: cohort.id,
        failDuplicateRefund: true,
      });
      stripe.captureBeforeCancel();

      const mark = stripe.calls.length;
      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow() });
      assert.equal(tick.results.find((r) => r.chargeId === w.hold.id)?.outcome, 'captured');
      assert.deepEqual(
        capturedIntentsSince(stripe, mark),
        [w.hold.pi],
        'exactly one capture, and it is E2’s own hold',
      );

      // E2's class is charged exactly once. E1's money is a separate, failed
      // refund on a DEAD-anchored charge — a named human obligation, not a
      // second collection quietly kept against E2's class.
      const rows = await chargeRows(cohort.id);
      const e2Charge = rows.find((r) => r.id === w.hold.id);
      assert.equal(e2Charge?.status, 'succeeded');
      assert.equal(e2Charge?.amountCents, PRICE);
      assert.equal(
        rows.filter((r) => r.status === 'succeeded' && r.bookingId === w.e2Anchor).length,
        1,
        'exactly ONE succeeded charge is filed against E2’s enrollment',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.18-D1d (OP-10) E2’s withdraw settles E2’s OWN hold and mints nothing against E1’s money — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: `'refunded'` off E1's mis-filed charge, while
    // E2's own live hold was neither mentioned nor cancelled.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      const w = await buildLateSettleWorld({
        app,
        stripe,
        cohortId: cohort.id,
        failDuplicateRefund: true,
      });
      const mintsBefore = (await refundRowsForCohort(cohort.id)).length;

      const res = await withdraw({ app, cohortId: cohort.id });
      const body = res.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'released', res.body);
      assert.equal(body.released_cents, PRICE, 'and it names E2’s own hold');
      assert.equal(body.refunded_cents, 0);
      assert.equal(
        (await refundRowsForCohort(cohort.id)).length,
        mintsBefore,
        'zero mints against E1’s money — that remainder is the stripe-failed human queue’s',
      );
      assert.equal(
        (await stripe.retrievePaymentIntent(w.hold.pi!)).status,
        'canceled',
        'E2’s hold is released, not left standing',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.18-D1e (R18/R19 tail) a terminally-failed duplicate refund stays E1’s, and surfaces as stripe-failed — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // The disposition §A3.17.3.4 already ruled, now reachable honestly: the
    // reopened remainder sits on a DEAD-anchored charge, is excluded from E2,
    // and pages a human recurringly through the abandon read's `stripe-failed`
    // class rather than being silently spent on E2's class.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      const baseline = await refundsRepository.findAbandonedPending(db, {
        mintedBefore: new Date(Date.now() + 60 * 1000),
      });
      const w = await buildLateSettleWorld({
        app,
        stripe,
        cohortId: cohort.id,
        failDuplicateRefund: true,
      });

      assert.equal(
        await paymentStatusFor(cohort.id),
        'pending',
        'a reopened remainder on E1’s charge is still not E2’s money',
      );
      assert.equal(w.lateChargeBookingId, w.e1Anchor);

      const after = await refundsRepository.findAbandonedPending(db, {
        mintedBefore: new Date(Date.now() + 60 * 1000),
      });
      assert.equal(
        after.totalByClass['stripe-failed'] - baseline.totalByClass['stripe-failed'],
        1,
        'the money that did not come back is named to a human, not buried',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// 2 — the stamp at the source: the invoice carries its OWN enrollment
// ══════════════════════════════════════════════════════════════════════════

test(
  '§A3.18-D1f a pay-later enroll stamps the invoice with its own enrollment’s anchor — both paths — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: `booking_id` was NULL on every group-class
    // invoice, which is exactly why the settle had to guess. The invoice is
    // minted inside the enroll tx/savepoint, lines below the booking loop, with
    // the anchor already in scope — the same fact §A3.17 used for charges.
    for (const allowPartial of [true, false]) {
      const cohort = await makeCohort();
      const { app } = enrollApp();
      try {
        const res = await enroll({ app, cohortId: cohort.id, payLater: true, allowPartial });
        assert.equal(res.statusCode, 201, res.body);
        const sessions = await liveSessionIds(cohort.id);
        assert.equal(sessions.length, 4);
        const [invoice] = await db
          .select({ bookingId: invoicesTable.bookingId })
          .from(invoicesTable)
          .where(eq(invoicesTable.cohortId, cohort.id));
        assert.equal(
          invoice?.bookingId,
          sessions[0],
          `allow_partial=${allowPartial}: the invoice knows its own first session`,
        );
      } finally {
        await cleanup(cohort.id);
        await db.delete(bookingsTable).where(eq(bookingsTable.cohortId, cohort.id));
      }
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════
// ADDENDUM 3 §A3.19 — the surplus is a STATE, and the healed premise had two
// open doors
// ══════════════════════════════════════════════════════════════════════════

/** A worker logger that keeps every level, so an arm's SILENCE is assertable. */
function workerLog(): {
  errors: { chargeId: unknown; msg: string }[];
  warns: { msg: string; obj: Record<string, unknown> }[];
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
} {
  const errors: { chargeId: unknown; msg: string }[] = [];
  const warns: { msg: string; obj: Record<string, unknown> }[] = [];
  return {
    errors,
    warns,
    log: {
      info: () => undefined,
      warn: (obj, msg) => warns.push({ msg: msg ?? '', obj: obj as Record<string, unknown> }),
      error: (obj, msg) =>
        errors.push({ chargeId: (obj as { chargeId?: unknown }).chargeId, msg: msg ?? '' }),
    },
  };
}

async function invoiceRowFor(
  cohortId: string,
): Promise<{ id: string; status: string; bookingId: string | null; paidChargeId: string | null }> {
  const [row] = await db
    .select({
      id: invoicesTable.id,
      status: invoicesTable.status,
      bookingId: invoicesTable.bookingId,
      paidChargeId: invoicesTable.paidChargeId,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.cohortId, cohortId));
  assert.ok(row, 'an invoice exists for this cohort');
  return row;
}

async function receiptCount(): Promise<number> {
  const rows = await db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.ownerId, FIXTURE_IDS.ownerId),
        eq(notificationsTable.type, 'payment-succeeded'),
      ),
    );
  return rows.length;
}

/**
 * The §A3.19.1 world: an OPEN invoice covering a LIVE enrollment, plus a
 * `requires_payment` group-class charge stamped with that invoice's anchor
 * whose PaymentIntent has since SUCCEEDED.
 *
 * The ordinary producer is the invoice pay route's async arm
 * (`invoices.ts` 3DS / `processing`): the intent survives its cancel attempt,
 * the charge row is written at `requires_payment` as audit trail, the invoice
 * is deliberately left open for the next attempt — and then the intent
 * succeeds anyway. The reconciler's lane-agnostic claim picks the row up.
 */
async function buildLateInvoicePaymentWorld(opts: {
  app: App;
  stripe: Stub;
  cohortId: string;
}): Promise<{ chargeId: string; pi: string; invoiceId: string; anchor: string }> {
  const e = await enroll({ app: opts.app, cohortId: opts.cohortId, payLater: true });
  assert.equal(e.statusCode, 201, e.body);
  const invoice = await invoiceRowFor(opts.cohortId);
  assert.ok(invoice.bookingId, 'D1: the invoice carries its own anchor');

  const pi = `pi_paynow_${randomUUID().slice(0, 12)}`;
  const chargeId = randomUUID();
  await db.insert(chargesTable).values({
    id: chargeId,
    ownerId: FIXTURE_IDS.ownerId,
    stripePaymentIntentId: pi,
    amountCents: PRICE,
    status: 'requires_payment',
    purpose: 'group-class',
    cohortId: opts.cohortId,
    dogId: FIXTURE_IDS.dog1Id,
    bookingId: invoice.bookingId,
    createdAt: sql`now() - interval '30 minutes'`,
    updatedAt: sql`now() - interval '30 minutes'`,
  });
  // The payment went through after all.
  opts.stripe.setIntentState(pi, 'succeeded');
  return { chargeId, pi, invoiceId: invoice.id, anchor: invoice.bookingId };
}

test(
  '§A3.19-F1a (r3 NEW-1b) money in hand for an OPEN invoice SETTLES it — it is the invoice’s own payment, arrived late — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: `'already-captured'` — the money was kept
    // silently, the covering invoice stayed OPEN (so `invoiceAutoCharge` would
    // collect the SAME class again at due_at), `payment_status` read `'paid'`
    // off money nothing had reconciled, and nothing paged.
    //
    // §A3.18.4 scoped the surplus arm to a PRODUCER ("the reconciler itself
    // decided not-owed and its release lost the race"), so the identical state
    // arriving through the succeeded-at-retrieve caller fell through to
    // `'already-captured'`. It is a STATE, and the disposition follows the
    // not-owed SOURCE: an open invoice means this money is not surplus at all.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const wl = workerLog();
    try {
      const w = await buildLateInvoicePaymentWorld({ app, stripe, cohortId: cohort.id });
      const receiptsBefore = await receiptCount();

      const tick = await runCaptureReconcilerOnce({ stripe, now: new Date(), log: wl.log });
      assert.equal(
        tick.results.find((r) => r.chargeId === w.chargeId)?.outcome,
        'settled-invoice',
        'the owner paid; that payment settles the thing it was for',
      );
      assert.equal(tick.settledInvoices, 1, 'and the tick counts it');

      const invoice = await invoiceRowFor(cohort.id);
      assert.equal(invoice.status, 'paid', 'the invoice is settled, not left for a second charge');
      assert.equal(invoice.paidChargeId, w.chargeId, 'and it names the charge that settled it');
      // Every invoice claim read filters `status = 'open'`, so a paid invoice is
      // invisible to `invoiceAutoCharge` — the second collection cannot happen.
      assert.equal(
        await receiptCount(),
        receiptsBefore + 1,
        'the owner gets the "Payment received" receipt the pay lane would have sent',
      );
      assert.equal(
        (await refundRowsForCohort(cohort.id)).length,
        0,
        'refund-then-recollect is the worst statement for a payment that went through',
      );
      assert.equal(await paymentStatusFor(cohort.id), 'paid', 'and now that is TRUE');
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.19-F1b (r4 NEW-1c) a withdraw AFTER that settle answers ‘refunded’, not "you were never charged" — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: `'voided'` — which renders "you were never
    // charged" — while 12000c sat `succeeded` with zero refunds. The withdraw's
    // priority order voided the still-open invoice and never reached the money.
    // Once F1 settles the invoice, `markVoid` counts 0 and the priority order
    // falls through to the succeeded arm, which returns the charge's remainder.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    try {
      const w = await buildLateInvoicePaymentWorld({ app, stripe, cohortId: cohort.id });
      await runCaptureReconcilerOnce({ stripe, now: new Date() });

      const res = await withdraw({ app, cohortId: cohort.id });
      const body = res.json() as EnrollmentWithdrawResultWire;
      assert.equal(body.money_outcome, 'refunded', res.body);
      assert.equal(body.refunded_cents, PRICE, 'the money that was actually taken comes back');
      const minted = (await refundRowsForCohort(cohort.id)).filter((r) => r.chargeId === w.chargeId);
      assert.equal(minted.length, 1);
      assert.equal(minted[0]?.amountCents, PRICE);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.19-F1c collected-elsewhere reaches ‘refunded-surplus’ from the SUCCEEDED-at-retrieve caller too — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree for THIS caller only: the race-loss caller
    // already paged `'refunded-surplus'` (round 2 verified it), but the
    // succeeded-at-retrieve caller passed `releaseLostToCapture: false` and
    // returned `'already-captured'` for the identical state.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const wl = workerLog();
    try {
      stripe.throwOnCapture(2);
      const res = await enroll({ app, cohortId: cohort.id });
      assert.equal(res.statusCode, 201, res.body);
      const hold = (await chargeRows(cohort.id)).find((r) => r.status === 'requires_payment');
      assert.ok(hold?.pi && hold.bookingId, 'a live hold, stamped with this enrollment’s anchor');

      // Collected elsewhere: a succeeded charge on this enrollment's OWN anchor
      // and no invoice — so `owed` is false with no invoice to settle.
      await db.insert(chargesTable).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        stripePaymentIntentId: `pi_elsewhere_${randomUUID().slice(0, 12)}`,
        amountCents: PRICE,
        status: 'succeeded',
        purpose: 'group-class',
        cohortId: cohort.id,
        dogId: FIXTURE_IDS.dog1Id,
        bookingId: hold.bookingId,
      });
      // SUCCEEDED at retrieve — no cancel is ever attempted, so this arrives
      // through the caller §A3.18 left scoped out.
      stripe.setIntentState(hold.pi, 'succeeded');

      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow(), log: wl.log });
      assert.equal(
        tick.results.find((r) => r.chargeId === hold.id)?.outcome,
        'refunded-surplus',
        'a true duplicate refunds itself whichever caller finds it',
      );
      assert.equal(tick.refundedSurplus, 1);
      const minted = (await refundRowsForCohort(cohort.id)).filter((r) => r.chargeId === hold.id);
      assert.equal(minted.length, 1);
      assert.equal(
        wl.errors.filter((e) => e.chargeId === hold.id).length,
        1,
        'unattended money movement is always paged, once',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.19-F2a (misstamp2 test 2) a PRE-DEPLOY invoice with a NULL anchor resolves its own enrollment by same-tx equality — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: the settle copied NULL, the charge was minted
    // NOW, and the legacy time rule (`created_at >= bornAt`) claimed it for E2
    // BY CONSTRUCTION — `'paid'` off dead money and E2's live hold cancelled.
    // The adjudicated-BLOCKER shape, alive for the pre-deploy invoice
    // population, which drains on `due_at` horizons measured in WEEKS.
    //
    // The invoice and its enrollment's bookings were written by ONE transaction
    // at one `now()`, so `bookings.created_at = invoices.issued_at` is an
    // identity witness — exact, in SQL, over rows of ANY status, which is what
    // lets it name E1's CANCELLED first session.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const wl = workerLog();
    try {
      const e1 = await enroll({ app, cohortId: cohort.id, payLater: true });
      assert.equal(e1.statusCode, 201, e1.body);
      const e1Anchor = (await liveSessionIds(cohort.id))[0]!;
      const invoice = await invoiceRowFor(cohort.id);
      // The pre-deploy row: minted before §A3.18 D1 existed, so no anchor.
      await db
        .update(invoicesTable)
        .set({ bookingId: null })
        .where(eq(invoicesTable.id, invoice.id));

      const w = await withdraw({ app, cohortId: cohort.id });
      assert.equal((w.json() as EnrollmentWithdrawResultWire).money_outcome, 'voided', w.body);
      stripe.throwOnCapture(2);
      const e2 = await enroll({ app, cohortId: cohort.id });
      assert.equal(e2.statusCode, 201, e2.body);
      const e2LiveIds = await liveSessionIds(cohort.id);
      const hold = (await chargeRows(cohort.id)).find(
        (r) => r.status === 'requires_payment' && r.pi !== null,
      );
      assert.ok(hold?.pi);

      const settle = await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
        const inv = await invoicesRepository.findById(tx, invoice.id);
        assert.ok(inv);
        assert.equal(inv.bookingId, null, 'the legacy invoice really has no anchor');
        return settleInvoiceCharge(tx, {
          invoice: inv,
          paymentIntentId: `pi_late_${randomUUID().slice(0, 12)}`,
          amountCents: PRICE,
          purpose: 'group-class',
          notifyOwner: false,
          log: wl.log,
        });
      });

      const [late] = await db
        .select({ bookingId: chargesTable.bookingId })
        .from(chargesTable)
        .where(eq(chargesTable.id, settle.chargeId));
      assert.equal(
        late?.bookingId,
        e1Anchor,
        'the fallback names E1’s own first session — cancelled, and exactly right',
      );
      assert.equal(e2LiveIds.includes(late!.bookingId as string), false);
      assert.ok(
        wl.warns.some((warn) => warn.obj.invoiceId === invoice.id),
        'every fallback firing is WARNed — expected during the drain, notable after',
      );

      // R18/R19: the bank refuses the duplicate refund, so the remainder
      // reopens — the producer that turns a mis-filed charge into "money in
      // hand" for the wrong enrollment.
      await db
        .update(refundsTable)
        .set({ status: 'failed' })
        .where(eq(refundsTable.chargeId, settle.chargeId));
      assert.equal(await paymentStatusFor(cohort.id), 'pending');
      const tick = await runCaptureReconcilerOnce({ stripe, now: tickNow() });
      assert.equal(
        tick.results.find((r) => r.chargeId === hold.id)?.outcome,
        'captured',
        'E2 is enrolled, delivered, and has paid nothing',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.19-F2b (r3 NEW-2b) a SET-NULL orphaned invoice resolves the SURVIVING siblings of its own enroll tx — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // RED against the gated tree: a silent NULL mint POST-deploy.
    // `invoices.booking_id` is ON DELETE SET NULL, so hard-deleting the anchor
    // row silently orphans the invoice — §A3.18.6's ops warning covered only
    // the charges-side FK, which THROWS (the loud direction), while the
    // invoices side is silent and is the one that re-opens a money defect.
    // An enrollment is `weeks` rows and only the anchor was deleted, so the
    // same-tx equality still has siblings to name.
    const cohort = await makeCohort();
    const { app, stripe } = enrollApp();
    const wl = workerLog();
    try {
      const e1 = await enroll({ app, cohortId: cohort.id, payLater: true });
      assert.equal(e1.statusCode, 201, e1.body);
      const e1Ids = await liveSessionIds(cohort.id);
      assert.equal(e1Ids.length, 4);
      const invoice = await invoiceRowFor(cohort.id);
      assert.equal(invoice.bookingId, e1Ids[0], 'D1: stamped at mint');

      const w = await withdraw({ app, cohortId: cohort.id });
      assert.equal(w.statusCode, 200, w.body);

      // An ops script hard-deletes just the withdrawn anchor row.
      await db.delete(bookingDogsTable).where(eq(bookingDogsTable.bookingId, e1Ids[0]!));
      await db.delete(bookingsTable).where(eq(bookingsTable.id, e1Ids[0]!));
      const orphaned = await invoiceRowFor(cohort.id);
      assert.equal(orphaned.bookingId, null, 'ON DELETE SET NULL fired, silently');

      stripe.throwOnCapture(2);
      const e2 = await enroll({ app, cohortId: cohort.id });
      assert.equal(e2.statusCode, 201, e2.body);
      const e2LiveIds = await liveSessionIds(cohort.id);

      const settle = await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
        const inv = await invoicesRepository.findById(tx, invoice.id);
        assert.ok(inv);
        return settleInvoiceCharge(tx, {
          invoice: inv,
          paymentIntentId: `pi_orphan_${randomUUID().slice(0, 12)}`,
          amountCents: PRICE,
          purpose: 'group-class',
          notifyOwner: false,
          log: wl.log,
        });
      });
      const [late] = await db
        .select({ bookingId: chargesTable.bookingId })
        .from(chargesTable)
        .where(eq(chargesTable.id, settle.chargeId));
      assert.notEqual(late?.bookingId, null, 'a surviving sibling is an honest anchor');
      assert.ok(
        e1Ids.slice(1).includes(late!.bookingId as string),
        'and it belongs to E1’s enrollment, not E2’s',
      );
      assert.equal(e2LiveIds.includes(late!.bookingId as string), false);
    } finally {
      await cleanup(cohort.id);
    }
  },
);

test(
  '§A3.19-F2c when same-tx equality finds NOTHING the mint is NULL and the WARN names the invoice — RED FIRST',
  SKIP_WHEN_NO_DB,
  async () => {
    // The fallback's failure arm is the loud tripwire, and the legacy time rule
    // stays as the net behind it. RED against the gated tree only in the WARN:
    // NULL was minted silently, with nothing to notice it by.
    const cohort = await makeCohort();
    const { app } = enrollApp();
    const wl = workerLog();
    try {
      const e1 = await enroll({ app, cohortId: cohort.id, payLater: true });
      assert.equal(e1.statusCode, 201, e1.body);
      const invoice = await invoiceRowFor(cohort.id);
      await db
        .update(invoicesTable)
        .set({ bookingId: null })
        .where(eq(invoicesTable.id, invoice.id));
      // Break the equality witness: the bookings no longer share the invoice's
      // transaction instant, so nothing can be proven about which enrollment
      // this money belongs to.
      await db
        .update(bookingsTable)
        .set({ createdAt: sql`${bookingsTable.createdAt} + interval '1 microsecond'` })
        .where(eq(bookingsTable.cohortId, cohort.id));

      const settle = await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
        const inv = await invoicesRepository.findById(tx, invoice.id);
        assert.ok(inv);
        return settleInvoiceCharge(tx, {
          invoice: inv,
          paymentIntentId: `pi_nowitness_${randomUUID().slice(0, 12)}`,
          amountCents: PRICE,
          purpose: 'group-class',
          notifyOwner: false,
          log: wl.log,
        });
      });
      const [late] = await db
        .select({ bookingId: chargesTable.bookingId })
        .from(chargesTable)
        .where(eq(chargesTable.id, settle.chargeId));
      assert.equal(late?.bookingId, null, 'nothing was proven, so nothing is claimed');
      assert.ok(
        wl.warns.some(
          (warn) => warn.obj.invoiceId === invoice.id && /anchor/i.test(warn.msg),
        ),
        'and a human can find it: the WARN names the invoice',
      );
    } finally {
      await cleanup(cohort.id);
    }
  },
);
