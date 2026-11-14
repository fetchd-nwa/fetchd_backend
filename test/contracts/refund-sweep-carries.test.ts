import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { refundsRepository } from '../../src/db/repositories/refundsRepository.js';
import { charges, refunds, stripeEvents } from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { firePendingRefundPostCommit } from '../../src/lib/pendingRefund.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { registerStaffRefundsRoute } from '../../src/routes/staffRefunds.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { runCaptureReconcilerOnce } from '../../src/workers/captureReconciler.js';
import { runDuplicateRefundRetryOnce } from '../../src/workers/duplicateRefundRetry.js';
import { runOrderSweeperOnce } from '../../src/workers/orderSweeper.js';
import type { WorkerLogger } from '../../src/workers/workerLogger.js';
import { makeClock } from './_checkinFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { QUIET_LOG, clearOrderRows, seedInvoiceOrder, seedOpenInvoice } from './_orderFixture.js';
import {
  appOf,
  chargeStatusOf,
  clearRefundWorld,
  codeOf,
  created,
  deliver,
  jitter,
  lotS,
  payments,
  plantCharge,
  plantRefundRow,
  postRefund,
  refundRows,
  refundableOf,
  retry,
  rowOf,
  world,
  type World,
} from './_refundWorld.js';
import {
  signedChargeRefundedEvent,
  signedIntentEvent,
  signedRefundEvent,
  verifyingSignatures,
} from './_signedEvents.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * P22 B-7: the refund sweep's carries (`plan_added` [0], [1], [2]; `brief_must_say` 1, 2;
 * `designs/p15-engine-recovery.md`'s state table rows 14-16). (a) a `pending` refund with
 * a stored `re_` and no terminal event is polled, never moved by the clock; (b) a stored
 * 5xx is the key's permanent answer: one line, a look-up by `metadata.refund_id`, at most
 * one create under a fresh key, and an end state once Stripe's key window has passed;
 * (c) a create Stripe refuses (400 `invalid_request_error`, with or without a code) is
 * `failed` at once and never re-fired; (d) a late success mints one refund per obligation;
 * (e) the abandon report follows D2.
 */

registerFixtureHooks();

const extraCharges: string[] = [];
afterEach(async () => {
  await db.delete(stripeEvents).where(like(stripeEvents.eventId, 'evt_test_%'));
  await clearRefundWorld(extraCharges.splice(0));
});
after(async () => {
  await clearOrderRows();
});

const MIN = 60 * 1000;
const at = (minutesFromNow: number): Date => new Date(Date.now() + minutesFromNow * MIN);

/** A worker logger that keeps what it was told. */
function recording(): WorkerLogger & { lines: { level: string; obj: Record<string, unknown>; msg: string }[] } {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const push = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    lines.push({ level, obj, msg: msg ?? '' });
  };
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

function sweep(w: World, now: Date, log: WorkerLogger = QUIET_LOG) {
  return runDuplicateRefundRetryOnce({ stripe: w.stripe, now, log });
}

/** Planted by SQL: the row was minted `minutes` ago (`refunds_touch` rewrites `updated_at`
 *  on every UPDATE, so a look's age is set by the sweep's injected clock instead). */
async function mintedAgo(refundId: string, minutes: number): Promise<void> {
  await db
    .update(refunds)
    .set({ createdAt: sql`now() - make_interval(mins => ${minutes})` })
    .where(eq(refunds.id, refundId));
}

const calls = (stripe: StripeStub, method: string) => stripe.calls.filter((c) => c.method === method);
const createsUnder = (stripe: StripeStub, predicate: (key: string) => boolean) =>
  stripe.calls.filter((c) => c.method === 'createRefund' && predicate(c.idempotencyKey as string));

async function shanthiRefunds(w: World, chargeId: string, amountCents: number) {
  const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
  const wire = created(await postRefund(app, { payment_id: chargeId, amount_cents: amountCents, credits_to_remove: 0 }));
  return { app, id: wire.id, row: await rowOf(wire.id) };
}

// ── (a) row 15: a pending refund with a stored re_ and no terminal event ────────

describe('B-7(a) a pending refund with a stored re_ and no terminal event', () => {
  test('the retrieve reads succeeded → succeeded at the next look', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const s = await lotS(w.stripe);
    const { id, row } = await shanthiRefunds(w, s.chargeId, 6000);
    assert.ok(row.stripeRefundId);
    w.stripe.setRefundState(row.stripeRefundId, 'succeeded');
    await sweep(w, at(61));
    assert.equal((await rowOf(id)).status, 'succeeded');
    assert.equal(await chargeStatusOf(s.chargeId), 'refunded');
  });

  test('the retrieve reads pending → unchanged, and looked at again an hour on', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const s = await lotS(w.stripe);
    const { id } = await shanthiRefunds(w, s.chargeId, 6000);
    // The clock is the sweep's: a look 61 minutes on, then 30 minutes after that look, then
    // 61 minutes after it (each relative to the look the lease recorded).
    await sweep(w, at(61));
    assert.equal((await rowOf(id)).status, 'pending');
    assert.equal(calls(w.stripe, 'retrieveRefund').length, 1);
    await sweep(w, at(30));
    assert.equal(calls(w.stripe, 'retrieveRefund').length, 1, 'not again within the hour');
    await sweep(w, at(61));
    assert.equal(calls(w.stripe, 'retrieveRefund').length, 2, 'looked at again an hour on');
  });

  test('a row looked at 59 minutes ago → not retrieved', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const s = await lotS(w.stripe);
    await shanthiRefunds(w, s.chargeId, 6000);
    await sweep(w, at(59));
    assert.equal(calls(w.stripe, 'retrieveRefund').length, 0);
  });

  test('it never moves a row by the clock: a refund pending 31 days that Stripe still holds pending stays pending', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const s = await lotS(w.stripe);
    const { id } = await shanthiRefunds(w, s.chargeId, 6000);
    await mintedAgo(id, 31 * 24 * 60);
    await sweep(w, at(61));
    assert.equal(calls(w.stripe, 'retrieveRefund').length, 1, 'it was looked at');
    assert.equal((await rowOf(id)).status, 'pending');
  });
});

// ── (b) the stored 500 ─────────────────────────────────────────────────────────

describe('B-7(b) a stored 5xx is the key\'s permanent answer', () => {
  test(
    'three ticks: one line naming the row, the PaymentIntent and the key; no re-fire under that key after the replay; one create under a fresh key',
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      w.stripe.refundStoresServerError(2);
      const { id, row } = await shanthiRefunds(w, s.chargeId, 6000);
      assert.equal(row.stripeRefundId, null, 'the first fire answered 500');
      const key = row.stripeIdempotencyKey!;
      const log = recording();
      for (const minutes of [6, 12, 18]) await sweep(w, at(minutes), log);
      assert.equal(createsUnder(w.stripe, (k) => k === key).length, 2, 'the fire and one re-fire, never one per tick');
      const stored = log.lines.filter((l) => l.level === 'error' && l.obj.moneyEvent === 'refund-key-stored-error');
      assert.equal(stored.length, 1, JSON.stringify(log.lines.filter((l) => l.level === 'error')));
      assert.equal(stored[0]!.obj.refundId, id);
      assert.equal(stored[0]!.obj.paymentIntentId, s.paymentIntentId);
      assert.equal(stored[0]!.obj.stripeIdempotencyKey, key);
      assert.equal(createsUnder(w.stripe, (k) => k.startsWith('refund-rekey:')).length, 1, 'no third create');
      assert.equal((await rowOf(id)).status, 'pending');
    },
  );

  test("a Stripe refund carrying the row's id → adopted by the look-up, no create", SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const s = await lotS(w.stripe);
    w.stripe.refundStoresServerError(1);
    const { id } = await shanthiRefunds(w, s.chargeId, 6000);
    const re = w.stripe.plantRefund({ paymentIntentId: s.paymentIntentId, amountCents: 6000, status: 'succeeded', metadata: { refund_id: id } });
    await sweep(w, at(6));
    const row = await rowOf(id);
    assert.equal(row.stripeRefundId, re);
    assert.equal(row.status, 'succeeded');
    assert.equal(createsUnder(w.stripe, (k) => k.startsWith('refund-rekey:')).length, 0);
  });

  test('none → one create under a fresh key derived from the row, written onto the row before it is sent', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const s = await lotS(w.stripe);
    w.stripe.refundStoresServerError(1);
    const { id, row } = await shanthiRefunds(w, s.chargeId, 6000);
    let keyOnRowAtCall: string | null = null;
    let keySent = '';
    w.stripe.beforeNextRefundCreate(async (_args, key) => {
      keySent = key;
      keyOnRowAtCall = (await rowOf(id)).stripeIdempotencyKey;
    });
    await sweep(w, at(6));
    assert.notEqual(keySent, row.stripeIdempotencyKey, 'a fresh key');
    assert.ok(keySent.startsWith(`refund-rekey:${id}:`), keySent);
    assert.equal(keyOnRowAtCall, keySent, 'the key was on the row before the call');
    assert.ok((await rowOf(id)).stripeRefundId, 'and the refund is on its way');
  });

  test('a 5xx under the fresh key → no third create; the row joins the report at once, in its own class', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const s = await lotS(w.stripe);
    w.stripe.refundStoresServerError(2);
    const { id } = await shanthiRefunds(w, s.chargeId, 6000);
    const log = recording();
    const tick = await sweep(w, at(6), log);
    assert.equal(tick.abandonedByClass['awaiting-stripe'], 1);
    const said = log.lines.filter((l) => l.level === 'error' && l.obj.refundClass === 'awaiting-stripe');
    assert.equal(said.length, 1);
    assert.ok((said[0]!.obj.refunds as { refundId: string }[]).some((r) => r.refundId === id));
    assert.match(said[0]!.msg, /waiting on Stripe/);
    assert.match(said[0]!.msg, /Send nothing for these by hand/);
  });

  test(
    'the end state: at 23 h 59 min with an empty list still pending; at 24 h failed, one line, and Retry to card mints; a list that errors moves nothing',
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      w.stripe.refundStoresServerError(2);
      const { app, id } = await shanthiRefunds(w, s.chargeId, 6000);
      const t = at(6);
      await sweep(w, t);
      const log = recording();
      await sweep(w, new Date(t.getTime() + (24 * 60 - 1) * MIN), log);
      assert.equal((await rowOf(id)).status, 'pending', '23 h 59 min');
      w.stripe.throwOnNextRefundList();
      await sweep(w, new Date(t.getTime() + 24 * 60 * MIN + 2 * 60 * MIN), log);
      assert.equal((await rowOf(id)).status, 'pending', 'a list that errors moves nothing');
      await sweep(w, new Date(t.getTime() + 24 * 60 * MIN + 4 * 60 * MIN), log);
      assert.equal((await rowOf(id)).status, 'failed', 'past the window, Stripe holds nothing for it');
      const ended = log.lines.filter((l) => l.level === 'error' && l.obj.moneyEvent === 'refund-unsent-past-key-window');
      assert.equal(ended.length, 1);
      assert.equal(ended[0]!.obj.refundId, id);
      w.stripe.setRefundReplyStatus('succeeded');
      const r1 = created(await retry(app, id));
      assert.equal(r1.retry_of_refund_id, id);
    },
  );

  test("at 24 h with a Stripe refund carrying its id → that refund's re_ and live status, never failed", SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const s = await lotS(w.stripe);
    w.stripe.refundStoresServerError(2);
    const { id } = await shanthiRefunds(w, s.chargeId, 6000);
    const t = at(6);
    await sweep(w, t);
    const re = w.stripe.plantRefund({ paymentIntentId: s.paymentIntentId, amountCents: 6000, status: 'pending', metadata: { refund_id: id } });
    await sweep(w, new Date(t.getTime() + 24 * 60 * MIN + 61 * MIN));
    const row = await rowOf(id);
    assert.equal(row.stripeRefundId, re);
    assert.equal(row.status, 'pending', "its live status: Stripe's refund is pending");
  });

  test('a staff row Stripe could not be reached for, 24 hours after its last send → the same end state; 23 h 59 min after → unchanged', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const s = await lotS(w.stripe);
    // Planted by SQL: Shanthi's $60.00 refund, every send lost, out of the retry window.
    const unreached = (lastSendMinutesAgo: number) =>
      plantRefundRow({
        chargeId: s.chargeId,
        amountCents: 3000,
        status: 'pending',
        issuedByStaffId: FIXTURE_IDS.staffShanthiId,
        stripeIdempotencyKey: `p22g2-unreached-${randomUUID()}:refund`,
        createdAt: at(-25 * 60),
        updatedAt: at(-lastSendMinutesAgo),
      });
    const early = await unreached(24 * 60 - 1);
    const reached = await unreached(24 * 60 + 1);
    const log = recording();
    await sweep(w, at(0), log);
    assert.equal((await rowOf(early)).status, 'pending', '23 h 59 min after its last send');
    assert.equal((await rowOf(reached)).status, 'failed');
    assert.equal(log.lines.filter((l) => l.obj.moneyEvent === 'refund-unsent-past-key-window').length, 1);
  });
});

describe("the sweep's look-up: a Stripe refund carrying the row's id at another amount is not the row's (Opus r2 L2)", () => {
  const NOT_ITS_AMOUNT_EVENT = 'refund-metadata-names-row-other-amount';

  test(
    "a stored 5xx, and a $10.00 Stripe refund carrying the $30.00 row's id → the look-up records the $10.00 as its own row and says so once; none at Stripe is the row's, so one create under a fresh key sends the row's own $30.00; the next tick sends and says nothing more",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      w.stripe.refundStoresServerError(1);
      const { app, id } = await shanthiRefunds(w, s.chargeId, 3000);
      const forged = w.stripe.plantRefund({ paymentIntentId: s.paymentIntentId, amountCents: 1000, status: 'succeeded', metadata: { refund_id: id } });
      const log = recording();
      await sweep(w, at(6), log);
      const row = await rowOf(id);
      assert.notEqual(row.stripeRefundId, forged, "the $10.00 is not the $30.00 row's refund");
      assert.ok(row.stripeRefundId?.startsWith('re_'), "the row's own refund is at Stripe");
      assert.deepEqual([row.amountCents, row.status], [3000, 'pending']);
      assert.equal(createsUnder(w.stripe, (k) => k.startsWith('refund-rekey:')).length, 1, 'sent once under a fresh key');
      const own = (await refundRows(s.chargeId)).find((x) => x.stripeRefundId === forged);
      assert.deepEqual([own?.amountCents, own?.status, own?.reason], [1000, 'succeeded', 'out-of-band']);
      const said = () => log.lines.filter((l) => l.level === 'error' && l.obj.moneyEvent === NOT_ITS_AMOUNT_EVENT);
      assert.equal(said().length, 1, JSON.stringify(log.lines.filter((l) => l.level === 'error')));
      assert.deepEqual(
        [said()[0]!.obj.refundId, said()[0]!.obj.stripeRefundId, said()[0]!.obj.rowAmountCents, said()[0]!.obj.stripeRefundAmountCents],
        [id, forged, 3000, 1000],
      );
      assert.equal(await refundableOf(app, s.chargeId), 6000 - 3000 - 1000, 'the cap counts both');
      await sweep(w, at(12), log);
      assert.equal(createsUnder(w.stripe, (k) => k.startsWith('refund-rekey:')).length, 1, 'no second create');
      assert.equal(said().length, 1, 'said once');
    },
  );

  test(
    "a staff row Stripe could not be reached for, 24 hours after its last send, whose PaymentIntent holds a $10.00 refund carrying its id → the $10.00 is its own row, said once; none at Stripe is the row's, so it ends failed with its own line",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      // Planted by SQL: Shanthi's $30.00 refund, every send lost, out of the retry window.
      const id = await plantRefundRow({
        chargeId: s.chargeId,
        amountCents: 3000,
        status: 'pending',
        issuedByStaffId: FIXTURE_IDS.staffShanthiId,
        stripeIdempotencyKey: `p22fix2-unreached-${randomUUID()}:refund`,
        createdAt: at(-25 * 60),
        updatedAt: at(-(24 * 60 + 1)),
      });
      const forged = w.stripe.plantRefund({ paymentIntentId: s.paymentIntentId, amountCents: 1000, status: 'succeeded', metadata: { refund_id: id } });
      const log = recording();
      await sweep(w, at(0), log);
      const row = await rowOf(id);
      assert.deepEqual([row.status, row.stripeRefundId], ['failed', null], 'Stripe holds nothing for the $30.00 row');
      const own = (await refundRows(s.chargeId)).find((x) => x.stripeRefundId === forged);
      assert.deepEqual([own?.amountCents, own?.status, own?.reason], [1000, 'succeeded', 'out-of-band']);
      const errors = log.lines.filter((l) => l.level === 'error');
      assert.equal(errors.filter((l) => l.obj.moneyEvent === NOT_ITS_AMOUNT_EVENT && l.obj.refundId === id).length, 1, JSON.stringify(errors));
      assert.equal(errors.filter((l) => l.obj.moneyEvent === 'refund-unsent-past-key-window' && l.obj.refundId === id).length, 1);
      await sweep(w, at(61), log);
      assert.equal(log.lines.filter((l) => l.obj.moneyEvent === NOT_ITS_AMOUNT_EVENT).length, 1, 'said once');
    },
  );

  test(
    "a re-keyed row whose one send landed and whose reply was lost, then a $10.00 carrying its id made after it (Stripe lists newest first) → the hourly look-up applies both: the row holds its own $30.00 re_, the $10.00 is its own row, said once; never ended failed",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      w.stripe.refundStoresServerError(1);
      const { id } = await shanthiRefunds(w, s.chargeId, 3000);
      // The look-up finds nothing, so one send under a fresh key: it lands, its reply is lost.
      w.stripe.refundLandsThenThrows();
      const t0 = at(6);
      await sweep(w, t0);
      const rekeyed = await rowOf(id);
      assert.ok(rekeyed.stripeIdempotencyKey?.startsWith(`refund-rekey:${id}:`), 're-keyed');
      assert.equal(rekeyed.stripeRefundId, null, 'its reply was lost');
      const ownRe = w.stripe.refundObjects().find((x) => x.paymentIntentId === s.paymentIntentId && x.amountCents === 3000)!.id;
      const forged = w.stripe.plantRefund({ paymentIntentId: s.paymentIntentId, amountCents: 1000, status: 'succeeded', metadata: { refund_id: id } });
      assert.equal(
        (await w.stripe.listRefundsForPaymentIntent(s.paymentIntentId)).refunds[0]!.id,
        forged,
        'the $10.00 is listed first',
      );
      const log = recording();
      await sweep(w, new Date(t0.getTime() + 61 * MIN), log);
      const row = await rowOf(id);
      assert.deepEqual([row.stripeRefundId, row.amountCents], [ownRe, 3000], 'the row holds its own refund');
      const own = (await refundRows(s.chargeId)).find((x) => x.stripeRefundId === forged);
      assert.deepEqual([own?.amountCents, own?.status, own?.reason], [1000, 'succeeded', 'out-of-band']);
      assert.equal(log.lines.filter((l) => l.obj.moneyEvent === NOT_ITS_AMOUNT_EVENT).length, 1);
      // Past the key window the row is not ended failed: Stripe holds its refund.
      await sweep(w, new Date(t0.getTime() + 25 * 60 * MIN), log);
      assert.notEqual((await rowOf(id)).status, 'failed');
      assert.equal(log.lines.filter((l) => l.obj.moneyEvent === 'refund-unsent-past-key-window').length, 0);
    },
  );
});

// ── (c) a definitive refusal ──────────────────────────────────────────────────

/** The class withdraw's money-back mint, as `enrollments.ts:562` writes it, then its fire. */
async function withdrawMintsAndFires(
  w: World,
  chargeId: string,
  paymentIntentId: string,
  log: WorkerLogger = QUIET_LOG,
) {
  const minted = await withActor('system:test', (tx) =>
    refundsRepository.mintCappedPendingRefund(tx, {
      chargeId,
      ownerId: FIXTURE_IDS.ownerId,
      bookingId: null,
      reason: 'cancel',
      stripeIdempotencyKey: (refundId) => `withdraw-refund:${refundId}`,
    }),
  );
  assert.equal(minted.kind, 'minted');
  if (minted.kind !== 'minted') throw new Error('unreachable');
  return {
    refundId: minted.refundId,
    fire: () =>
      firePendingRefundPostCommit({
        pending: {
          refundId: minted.refundId,
          paymentIntentId,
          amountCents: minted.amountCents,
          stripeIdempotencyKey: minted.stripeIdempotencyKey,
        },
        stripe: w.stripe,
        log,
        context: { test: 'b7c' },
      }),
  };
}

describe('B-7(c) a create Stripe refuses is failed at once and never re-fired', () => {
  test(
    "Fable's lane: $120.00 class charge, $40.00 from the dashboard, the withdraw's $120.00 refused → failed at the first refusal, the $40.00 adopted, $80.00 owed and named, Shanthi's $80.00 closes it",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const c = await plantCharge(w.stripe, { amountCents: 12000, purpose: 'group-class' });
      const dash = w.stripe.plantRefund({ paymentIntentId: c.paymentIntentId, amountCents: 4000, status: 'succeeded' });
      const log = recording();
      const { refundId, fire } = await withdrawMintsAndFires(w, c.chargeId, c.paymentIntentId, log);
      await fire();
      assert.equal((await rowOf(refundId)).status, 'failed', 'failed at the first refusal');
      const refused = log.lines.filter((l) => l.level === 'error' && l.obj.moneyEvent === 'refund-refused-at-create');
      assert.equal(refused.length, 1, JSON.stringify(log.lines));
      assert.equal(refused[0]!.obj.refundId, refundId);
      assert.equal(refused[0]!.obj.paymentIntentId, c.paymentIntentId);
      assert.equal(refused[0]!.obj.stripeCode, null, 'the recording: an over-refund carries no code');
      assert.match(String(refused[0]!.obj.stripeMessage), /greater than unrefunded amount/);

      await sweep(w, at(6));
      assert.equal(createsUnder(w.stripe, () => true).length, 1, 'never re-fired');

      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      await deliver(app, signedRefundEvent({ type: 'charge.refund.updated', refundId: dash, paymentIntentId: c.paymentIntentId, amountCents: 4000, status: 'succeeded' }));
      const cap = await withActor('system:test', (tx) => refundsRepository.capRemainingForCharge(tx, { id: c.chargeId, amountCents: 12000 }));
      assert.equal(cap, 8000);
      const reportLog = recording();
      const tick = await sweep(w, at(12), reportLog);
      assert.equal(tick.abandonedByClass['failed-exceeds-owed'], 1);
      const said = reportLog.lines.find((l) => l.level === 'error' && l.obj.refundClass === 'failed-exceeds-owed');
      assert.ok(said, JSON.stringify(reportLog.lines.filter((l) => l.level === 'error')));
      const named = (said.obj.refunds as { refundId: string; actionableCents: number; instruction: string }[]).find((r) => r.refundId === refundId)!;
      assert.equal(named.actionableCents, 8000);
      assert.match(named.instruction, /\$80\.00/);
      assert.match(said.msg, /POST \/staff\/refunds\b/);
      assert.doesNotMatch(said.msg, /\/retry|resolve-external/, 'it never sends a person to the exits that refuse');

      w.stripe.setRefundReplyStatus('succeeded');
      created(await postRefund(app, { payment_id: c.chargeId, amount_cents: 8000, credits_to_remove: 0 }));
      const after = await sweep(w, at(18));
      assert.equal(after.abandonedByClass['failed-exceeds-owed'], 0);
      assert.equal(after.abandonedByClass.covered, 1, 'the failed row reads covered and needs nothing more');
    },
  );

  test('a fully refunded charge: charge_already_refunded is a refusal too', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const c = await plantCharge(w.stripe, { amountCents: 12000, purpose: 'group-class' });
    w.stripe.plantRefund({ paymentIntentId: c.paymentIntentId, amountCents: 12000, status: 'succeeded' });
    const log = recording();
    const { refundId, fire } = await withdrawMintsAndFires(w, c.chargeId, c.paymentIntentId, log);
    await fire();
    assert.equal((await rowOf(refundId)).status, 'failed');
    assert.equal(log.lines.find((l) => l.obj.moneyEvent === 'refund-refused-at-create')?.obj.stripeCode, 'charge_already_refunded');
  });

  test(
    'the refusal racing the dashboard refund\'s delivery: two connections, both orders, natural timing and 6 ms jitter, 40 rounds each',
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const counts: Record<string, number> = {};
      for (const order of ['refusal-first', 'delivery-first'] as const) {
        for (const timing of ['natural', 'jitter'] as const) {
          for (let round = 0; round < 40; round += 1) {
            const c = await plantCharge(w.stripe, { amountCents: 12000, purpose: 'group-class' });
            extraCharges.push(c.chargeId);
            const dash = w.stripe.plantRefund({ paymentIntentId: c.paymentIntentId, amountCents: 4000, status: 'succeeded' });
            const { refundId, fire } = await withdrawMintsAndFires(w, c.chargeId, c.paymentIntentId);
            const refusal = async () => {
              if (timing === 'jitter') await jitter();
              await fire();
            };
            const delivery = async () => {
              if (timing === 'jitter') await jitter();
              return deliver(app, signedRefundEvent({ type: 'charge.refund.updated', refundId: dash, paymentIntentId: c.paymentIntentId, amountCents: 4000, status: 'succeeded' }));
            };
            const [d] =
              order === 'refusal-first'
                ? await Promise.all([refusal(), delivery()]).then(([, b]) => [b] as const)
                : await Promise.all([delivery(), refusal()]);
            assert.equal(d.statusCode, 200, d.body);
            const rows = await refundRows(c.chargeId);
            assert.equal(rows.find((r) => r.id === refundId)!.status, 'failed');
            assert.equal(rows.filter((r) => r.stripeRefundId === dash).length, 1, 'the $40.00 recorded once');
            const cap = await withActor('system:test', (tx) => refundsRepository.capRemainingForCharge(tx, { id: c.chargeId, amountCents: 12000 }));
            assert.equal(cap, 8000);
            counts[`${order}/${timing}`] = (counts[`${order}/${timing}`] ?? 0) + 1;
          }
        }
      }
      console.log(`# refusal race rounds ${JSON.stringify(counts)}`);
    },
  );
});

// ── (d) the second mint does not stand ────────────────────────────────────────

const T0 = new Date('2026-05-19T17:50:00Z');

async function lateSuccessWorld() {
  const stripe = verifyingSignatures(makeStripeStub());
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffOrdersRoute(app, { authenticate, stripe, now: () => T0 });
  registerStripeWebhookRoute(app, { stripe });
  const shanthi = makeContractApp(FIXTURE_OWNER_ROLE_PRINCIPAL);
  registerStaffRefundsRoute(shanthi.app, { authenticate: shanthi.authenticate, stripe });
  const invoiceId = await seedOpenInvoice();
  const seeded = await seedInvoiceOrder(stripe, {
    invoiceId,
    now: T0,
    intentStatus: 'processing',
    attemptingUntil: new Date(T0.getTime() + 150_000),
  });
  const cancelled = await app.inject({
    method: 'POST',
    url: `/staff/orders/${seeded.orderId}/cancel`,
    headers: { 'idempotency-key': `p22g2-cancel-${randomUUID()}` },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  stripe.setIntentState(seeded.intentId!, 'succeeded');
  return { stripe, app, shanthi: shanthi.app, seeded, intentId: seeded.intentId! };
}

async function failAtStripe(world: Awaited<ReturnType<typeof lateSuccessWorld>>, refundId: string): Promise<void> {
  const row = await rowOf(refundId);
  world.stripe.setRefundState(row.stripeRefundId!, 'failed');
  const res = await deliver(
    world.app,
    signedRefundEvent({ type: 'refund.failed', refundId: row.stripeRefundId!, paymentIntentId: world.intentId, amountCents: row.amountCents, status: 'failed', refundRowId: refundId }),
  );
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await rowOf(refundId)).status, 'failed');
}

describe('B-7(d) a late success mints one refund per obligation', () => {
  test(
    'p37: the watch mints A, Stripe fails A, the late first delivery of payment_intent.succeeded arrives → no second row; A is on the report; Retry of A mints R1',
    SKIP_WHEN_NO_DB,
    async () => {
      const world = await lateSuccessWorld();
      await runOrderSweeperOnce({ stripe: world.stripe, now: new Date(T0.getTime() + 60_000), log: QUIET_LOG });
      const [a] = await refundRows(world.seeded.chargeId);
      assert.ok(a, 'the watch minted A');
      await failAtStripe(world, a.id);
      const late = await deliver(world.app, signedIntentEvent({ type: 'payment_intent.succeeded', intentId: world.intentId, amountCents: 8500, metadata: {} }));
      assert.equal(late.statusCode, 200, late.body);
      assert.equal((await refundRows(world.seeded.chargeId)).length, 1, 'no second row for one obligation');
      const report = await runDuplicateRefundRetryOnce({ stripe: world.stripe, log: QUIET_LOG });
      assert.ok(report.abandonedByClass['stripe-failed'] >= 1, 'A is on the report: a person is told');
      world.stripe.setRefundReplyStatus('pending');
      const r1 = created(await retry(world.shanthi, a.id));
      assert.equal(r1.retry_of_refund_id, a.id);
    },
  );

  test(
    'the redelivery: the first delivery mints A and dies before markProcessed; A fails; the re-dispatch mints no second row',
    SKIP_WHEN_NO_DB,
    async () => {
      const world = await lateSuccessWorld();
      const event = signedIntentEvent({ type: 'payment_intent.succeeded', intentId: world.intentId, amountCents: 8500, metadata: {} });
      assert.equal((await deliver(world.app, event)).statusCode, 200);
      const [a] = await refundRows(world.seeded.chargeId);
      assert.ok(a);
      // Planted by SQL: the first delivery died between its commit and markProcessed.
      await db.update(stripeEvents).set({ processedAt: null }).where(eq(stripeEvents.eventId, event.id));
      await failAtStripe(world, a.id);
      const again = await deliver(world.app, event);
      assert.equal(again.statusCode, 200, again.body);
      assert.equal((await refundRows(world.seeded.chargeId)).length, 1, 'the second mint does not stand');
      void charges;
    },
  );
});

// ── the backwards edge on a late success (Opus r1 L1, Fable r1 N2) ─────────────

describe('the backwards edge on a late success: the charge is never accepted, so it goes back to failed', () => {
  /** The staff routes, the family's payment history and the real webhook route, on the late-success world's stub. */
  const staffOf = (stripe: StripeStub) => appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, { stripe, clock: makeClock(new Date()) });

  test(
    "Opus r1 L1: the watch's refund A succeeds, then Stripe fails it as the recording sends it → the charge reads failed, the payment is on no history, and Retry to card pays $85.00 once (a pin: Mα)",
    SKIP_WHEN_NO_DB,
    async () => {
      const ls = await lateSuccessWorld();
      const chargeId = ls.seeded.chargeId;
      await runOrderSweeperOnce({ stripe: ls.stripe, now: new Date(T0.getTime() + 60_000), log: QUIET_LOG });
      const [a] = await refundRows(chargeId);
      assert.ok(a, 'the watch minted A');
      assert.equal(a.reason, 'late-success-refund');
      assert.equal(a.status, 'pending');
      const re = a.stripeRefundId;
      assert.ok(re, "A's create stored its re_");
      assert.equal(await chargeStatusOf(chargeId), 'failed', 'held failed: the app never accepted this payment');
      const staff = staffOf(ls.stripe);
      const ev = (type: 'charge.refund.updated' | 'refund.updated' | 'refund.failed', status: string) =>
        signedRefundEvent({ type, refundId: re, paymentIntentId: ls.intentId, amountCents: 8500, status, refundRowId: a.id });

      // The recording's (f) then (b): `charge.refunded` while A is pending, the two succeeded
      // updates, then the failure as `refund.failed` and `charge.refund.updated`.
      const charged = signedChargeRefundedEvent({ paymentIntentId: ls.intentId, amountCents: 8500, amountRefundedCents: 8500 });
      assert.equal((await deliver(staff, charged)).statusCode, 200);
      assert.equal((await rowOf(a.id)).status, 'pending', 'nothing is marked from charge.refunded itself');
      ls.stripe.setRefundState(re, 'succeeded');
      for (const e of [ev('charge.refund.updated', 'succeeded'), ev('refund.updated', 'succeeded')]) {
        const res = await deliver(staff, e);
        assert.equal(res.statusCode, 200, res.body);
      }
      assert.equal((await rowOf(a.id)).status, 'succeeded');
      assert.equal(await chargeStatusOf(chargeId), 'refunded', 'the money went back: refunded');

      ls.stripe.setRefundState(re, 'failed');
      for (const e of [ev('refund.failed', 'failed'), ev('charge.refund.updated', 'failed')]) {
        const res = await deliver(staff, e);
        assert.equal(res.statusCode, 200, res.body);
      }
      assert.equal((await rowOf(a.id)).status, 'failed', 'the one backwards edge');
      assert.equal(
        await chargeStatusOf(chargeId),
        'failed',
        'a charge the app never accepted goes back to failed, never to succeeded: it must not read as paid',
      );
      assert.equal(
        (await payments(staff)).some((p) => p.payment_id === chargeId),
        false,
        "the payment is on no history, so it offers no Refund beside A's Retry to card",
      );

      ls.stripe.setRefundReplyStatus('succeeded');
      const r1 = created(await retry(staff, a.id));
      assert.equal(r1.retry_of_refund_id, a.id);
      assert.equal(await chargeStatusOf(chargeId), 'refunded');
      const held = ls.stripe.refundObjects().filter((r) => r.paymentIntentId === ls.intentId);
      assert.deepEqual(
        held.map((r) => [r.status, r.amountCents]),
        [
          ['failed', 8500],
          ['succeeded', 8500],
        ],
        'Stripe holds A failed and R1 succeeded: $85.00 back once',
      );
    },
  );

  test(
    "Fable r1 N2: a charge carrying the engine's late-success refund is never accepted — a late or redelivered payment_intent.succeeded, the sweeper and the capture reconciler leave it failed; Refund answers 404 while it is held failed and over_cap once A has returned the money (a pin: Mγ, Mδ)",
    SKIP_WHEN_NO_DB,
    async () => {
      const ls = await lateSuccessWorld();
      const chargeId = ls.seeded.chargeId;
      const intentSucceeded = () =>
        signedIntentEvent({ type: 'payment_intent.succeeded', intentId: ls.intentId, amountCents: 8500, metadata: {} });
      await runOrderSweeperOnce({ stripe: ls.stripe, now: new Date(T0.getTime() + 60_000), log: QUIET_LOG });
      const [a] = await refundRows(chargeId);
      assert.ok(a?.stripeRefundId, 'the watch minted A and sent it');
      assert.equal(a.reason, 'late-success-refund');
      const staff = staffOf(ls.stripe);

      const late = await deliver(staff, intentSucceeded());
      assert.equal(late.statusCode, 200, late.body);
      assert.equal(await chargeStatusOf(chargeId), 'failed', 'a late payment_intent.succeeded does not accept it');
      await runOrderSweeperOnce({ stripe: ls.stripe, now: new Date(T0.getTime() + 3_600_000), log: QUIET_LOG });
      await runCaptureReconcilerOnce({ stripe: ls.stripe, now: new Date(Date.now() + 2 * 86_400_000), log: QUIET_LOG });
      assert.equal(await chargeStatusOf(chargeId), 'failed', 'nor does a tick of the sweeper or the capture reconciler');
      codeOf(
        await postRefund(staff, { payment_id: chargeId, amount_cents: 100, credits_to_remove: 0 }),
        404,
        'not_found',
      );
      assert.equal((await refundRows(chargeId)).length, 1, 'Refund wrote nothing on a charge held failed');

      ls.stripe.setRefundState(a.stripeRefundId, 'succeeded');
      const res = await deliver(
        staff,
        signedRefundEvent({ type: 'refund.updated', refundId: a.stripeRefundId, paymentIntentId: ls.intentId, amountCents: 8500, status: 'succeeded', refundRowId: a.id }),
      );
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(await chargeStatusOf(chargeId), 'refunded');
      const again = await deliver(staff, intentSucceeded());
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(await chargeStatusOf(chargeId), 'refunded', 'a second late success leaves it refunded, never succeeded');
      codeOf(
        await postRefund(staff, { payment_id: chargeId, amount_cents: 100, credits_to_remove: 0 }),
        422,
        'over_cap',
      );
      assert.equal((await refundRows(chargeId)).length, 1, 'no staff refund stands beside A');
    },
  );

  test(
    "Fable r1 N2, the road that reaches it: Shanthi refunds Tomi's paid $60.00 typing the reason late-success-refund (the word the payment history shows on the engine's own row); Stripe succeeds it, then fails it as the recording sends it → the charge reads succeeded again with $60.00 refundable on the history, and Retry to card mints: a staff row's free text never makes a payment the app accepted read as one it never did",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      w.stripe.setRefundReplyStatus('succeeded');
      const wire = created(
        await postRefund(app, { payment_id: s.chargeId, amount_cents: 6000, credits_to_remove: 0, reason: 'late-success-refund' }),
      );
      const row = await rowOf(wire.id);
      assert.equal(row.reason, 'late-success-refund', "the staff's words are stored as typed");
      assert.ok(row.issuedByStaffId, 'issued by Shanthi');
      assert.ok(row.stripeRefundId);
      assert.equal(await chargeStatusOf(s.chargeId), 'refunded');
      w.stripe.setRefundState(row.stripeRefundId, 'failed');
      for (const type of ['refund.failed', 'charge.refund.updated'] as const) {
        const res = await deliver(
          app,
          signedRefundEvent({ type, refundId: row.stripeRefundId, paymentIntentId: s.paymentIntentId, amountCents: 6000, status: 'failed', refundRowId: wire.id }),
        );
        assert.equal(res.statusCode, 200, res.body);
      }
      assert.equal((await rowOf(wire.id)).status, 'failed', 'the backwards edge');
      assert.equal(
        await chargeStatusOf(s.chargeId),
        'succeeded',
        'the app accepted this payment: the edge puts it back to succeeded, never failed',
      );
      assert.equal(await refundableOf(app, s.chargeId), 6000, 'on the history, its $60.00 owed');
      w.stripe.setRefundReplyStatus('succeeded');
      const r1 = created(await retry(app, wire.id));
      assert.equal(r1.retry_of_refund_id, wire.id);
    },
  );
});

// ── (e) the abandon classifier follows D2 ─────────────────────────────────────

describe('B-7(e) the abandon classifier follows D2', () => {
  test('O failed with R1 pending → O covered; R1 failed → R1 owed, O covered; both exits named by route', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const c = await plantCharge(w.stripe, { amountCents: 11400 });
    // Planted by SQL: Shanthi's O failed, Amber's retry R1 waiting on Stripe.
    const o = await plantRefundRow({ chargeId: c.chargeId, amountCents: 11400, status: 'failed', stripeRefundId: `re_p22g2_${randomUUID()}`, issuedByStaffId: FIXTURE_IDS.staffShanthiId });
    const r1Re = w.stripe.plantRefund({ paymentIntentId: c.paymentIntentId, amountCents: 11400, status: 'pending' });
    const r1 = await plantRefundRow({ chargeId: c.chargeId, amountCents: 11400, status: 'pending', stripeRefundId: r1Re, issuedByStaffId: FIXTURE_IDS.staffAmberId, retryOf: o });
    const first = await sweep(w, at(0));
    assert.equal(first.abandonedByClass.covered, 1, 'O is covered by R1');
    assert.equal(first.abandonedByClass['stripe-failed'], 0);
    await db.update(refunds).set({ status: 'failed' }).where(eq(refunds.id, r1));
    const log = recording();
    const second = await sweep(w, at(0), log);
    assert.equal(second.abandonedByClass['stripe-failed'], 1, 'R1, the head, is owed');
    assert.equal(second.abandonedByClass.covered, 1, 'O, superseded, is covered');
    const said = log.lines.find((l) => l.level === 'error' && l.obj.refundClass === 'stripe-failed')!;
    const named = said.obj.refunds as { refundId: string; actionableCents: number; seenOn: string }[];
    assert.deepEqual(named.map((r) => r.refundId), [r1]);
    assert.equal(named[0]!.actionableCents, 11400);
    assert.match(named[0]!.seenOn, /payment history/);
    assert.match(said.msg, /POST \/staff\/refunds\/:id\/retry/);
    assert.match(said.msg, /POST \/staff\/refunds\/:id\/resolve-external/);
    assert.doesNotMatch(said.msg, /nothing retries them/);
  });

  test('a failed refund on a charge held failed (the late-success lane) is seen on no portal screen until End of day', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const c = await plantCharge(w.stripe, { amountCents: 8500, status: 'failed' });
    await plantRefundRow({ chargeId: c.chargeId, amountCents: 8500, status: 'failed', stripeRefundId: `re_p22g2_${randomUUID()}`, reason: 'late-success-refund', stripeIdempotencyKey: `late-success-refund:${randomUUID()}` });
    const log = recording();
    await sweep(w, at(0), log);
    const said = log.lines.find((l) => l.level === 'error' && l.obj.refundClass === 'stripe-failed')!;
    const named = (said.obj.refunds as { chargeId: string; seenOn: string }[]).find((r) => r.chargeId === c.chargeId)!;
    assert.match(named.seenOn, /no portal screen/);
  });

  test("a staff retry is refused 422 over_cap on a failed head larger than what is owed; the report sends her to Refund instead", SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const c = await plantCharge(w.stripe, { amountCents: 12000, purpose: 'group-class' });
    await plantRefundRow({ chargeId: c.chargeId, amountCents: 4000, status: 'succeeded', stripeRefundId: `re_p22g2_${randomUUID()}`, reason: 'out-of-band' });
    const head = await plantRefundRow({ chargeId: c.chargeId, amountCents: 12000, status: 'failed', reason: 'cancel', stripeIdempotencyKey: `withdraw-refund:${randomUUID()}` });
    const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
    codeOf(await retry(app, head), 422, 'over_cap');
    const tick = await sweep(w, at(0));
    assert.equal(tick.abandonedByClass['failed-exceeds-owed'], 1);
  });
});
