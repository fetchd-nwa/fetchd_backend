import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import { refundsRepository } from '../../src/db/repositories/refundsRepository.js';
import { refunds, stripeEvents } from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import {
  appOf,
  chargeStatusOf,
  clearRefundWorld,
  codeOf,
  created,
  deliver,
  jitter,
  lotP,
  lotS,
  plantCharge,
  plantRefundRow,
  postRefund,
  refundRows,
  refundableOf,
  resolveExternal,
  retry,
  rowOf,
  unspent,
  world,
  type World,
} from './_refundWorld.js';
import { signedChargeRefundedEvent, signedRefundEvent } from './_signedEvents.js';
import { FIXTURE_IDS } from './_fixture.js';
import { runDuplicateRefundRetryOnce } from '../../src/workers/duplicateRefundRetry.js';
import type { WorkerLogger } from '../../src/workers/workerLogger.js';

const OWNER_ID = FIXTURE_IDS.ownerId;

/** The sweep's logger, keeping what it was told. */
function sweepRecording(): WorkerLogger & { lines: { level: string; obj: Record<string, unknown>; msg: string }[] } {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const push = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    lines.push({ level, obj, msg: msg ?? '' });
  };
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

/**
 * P22 B-6: a refund's live status — four events and one backwards edge (design
 * §2.7:4215-4228; `brief_must_say` 2; `plan_added` [1]). Every event here is signed bytes
 * delivered through `POST /webhooks/stripe` and projected by the production
 * `constructWebhookEvent`; no handler is called directly. The stub answers as the Stripe
 * recording does (`stripe-stub-recording.test.ts`): the backwards edge arrives as
 * `refund.failed` and `charge.refund.updated`, never as `refund.updated`; `charge.refunded`
 * fires at creation while the refund is still `pending`.
 */

registerFixtureHooks();

const extraCharges: string[] = [];
afterEach(async () => {
  await clearRefundWorld(extraCharges.splice(0));
});

const M6_SENTENCE =
  'Stripe reports this refund succeeded and the app holds it failed; do not retry it.';

/** Shanthi's refund through the route; the stub replies `status` to the create. */
async function staffRefund(
  w: World,
  chargeId: string,
  amountCents: number,
  credits: number,
  reply: 'pending' | 'succeeded' | 'failed' = 'pending',
): Promise<{ id: string; re: string | null }> {
  w.stripe.setRefundReplyStatus(reply);
  const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
  const wire = created(
    await postRefund(app, { payment_id: chargeId, amount_cents: amountCents, credits_to_remove: credits }),
  );
  return { id: wire.id, re: (await rowOf(wire.id)).stripeRefundId };
}

const level50 = (lines: Record<string, unknown>[]) => lines.filter((l) => l.level === 50);

const TWO_REFUNDS_ONE_ROW =
  "TWO STRIPE REFUNDS NAME ONE REFUND ROW — this Stripe refund (secondStripeRefundId) carries row refundId in its metadata.refund_id, and that row already holds another Stripe refund (rowStripeRefundId; the row reads rowStatus). It was recorded as a refund of its own (adoptedRefundId, reading secondStatus here), so the payment's cap counts its money. One refund decision now has at least two refunds at Stripe: check both in Stripe, on paymentIntentId, before anyone sends or retries another refund on this payment, the row's own Retry to card included";

describe('B-6 a refund\'s live status: four events and one backwards edge', () => {
  test(
    "s17's $60.00 on S succeeds at the create's reply; Wed 28 Oct `refund.failed` reads failed → the row failed, S's charge succeeded with $60.00 refundable, S still empty, and Retry to card mints",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const refund = await staffRefund(w, s.chargeId, 6000, 1, 'succeeded');
      assert.equal((await rowOf(refund.id)).status, 'succeeded');
      assert.equal(await chargeStatusOf(s.chargeId), 'refunded');
      assert.ok(refund.re, 'the reply stored its re_');

      w.stripe.setRefundState(refund.re, 'failed');
      const res = await deliver(
        app,
        signedRefundEvent({
          type: 'refund.failed',
          refundId: refund.re,
          paymentIntentId: s.paymentIntentId,
          amountCents: 6000,
          status: 'failed',
          refundRowId: refund.id,
        }),
      );
      assert.equal((await rowOf(refund.id)).status, 'failed', 'the one backwards edge');
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(await chargeStatusOf(s.chargeId), 'succeeded', 'a refunded charge is recomputed');
      assert.equal(await refundableOf(app, s.chargeId), 6000, 'the cap reopens');
      assert.equal(await unspent(s.lotId), 0, 'the removed credit stays removed: the money is still owed');

      w.stripe.setRefundReplyStatus('succeeded');
      const r1 = created(await retry(app, refund.id));
      assert.equal(r1.retry_of_refund_id, refund.id);
    },
  );

  test(
    'an event whose own payload says succeeded while the retrieve says failed → failed',
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const refund = await staffRefund(w, s.chargeId, 6000, 0);
      w.stripe.setRefundState(refund.re!, 'failed');
      await deliver(
        app,
        signedRefundEvent({
          type: 'charge.refund.updated',
          refundId: refund.re!,
          paymentIntentId: s.paymentIntentId,
          amountCents: 6000,
          status: 'succeeded',
          refundRowId: refund.id,
        }),
      );
      assert.equal((await rowOf(refund.id)).status, 'failed', 'the live status, never the event\'s');
      assert.equal(await chargeStatusOf(s.chargeId), 'succeeded');
    },
  );

  test(
    "the recording's (b) replayed through the route in recorded order, then with the two succeeded updates after refund.failed → failed both times, the charge succeeded",
    SKIP_WHEN_NO_DB,
    async () => {
      for (const order of ['recorded', 'succeeded-updates-last'] as const) {
        const w = world();
        const s = await lotS(w.stripe);
        const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
        const refund = await staffRefund(w, s.chargeId, 6000, 0, 'succeeded');
        const ev = (type: 'charge.refund.updated' | 'refund.updated' | 'refund.failed', status: string) =>
          signedRefundEvent({
            type,
            refundId: refund.re!,
            paymentIntentId: s.paymentIntentId,
            amountCents: 6000,
            status,
            refundRowId: refund.id,
          });
        const charged = signedChargeRefundedEvent({
          paymentIntentId: s.paymentIntentId,
          amountCents: 6000,
          amountRefundedCents: 6000,
        });
        const succeededUpdates = [ev('charge.refund.updated', 'succeeded'), ev('refund.updated', 'succeeded')];
        const failure = [ev('refund.failed', 'failed'), ev('charge.refund.updated', 'failed')];
        if (order === 'recorded') {
          for (const e of [charged, ...succeededUpdates]) assert.equal((await deliver(app, e)).statusCode, 200);
          assert.equal((await rowOf(refund.id)).status, 'succeeded', 'Stripe still reads succeeded');
          w.stripe.setRefundState(refund.re!, 'failed');
          for (const e of failure) await deliver(app, e);
        } else {
          w.stripe.setRefundState(refund.re!, 'failed');
          for (const e of [charged, ...failure, ...succeededUpdates]) await deliver(app, e);
        }
        assert.equal((await rowOf(refund.id)).status, 'failed', `${order}: failed`);
        assert.equal(await chargeStatusOf(s.chargeId), 'succeeded', `${order}: the charge succeeded`);
        assert.equal(await refundableOf(app, s.chargeId), 6000, `${order}: the cap reopened`);
        await clearRefundWorld();
      }
    },
  );

  test(
    "a row held failed, then an event whose retrieve reads succeeded → the row stays failed, nothing is written, and the webhook route's logger carries one level-50 line (M6)",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const refund = await staffRefund(w, s.chargeId, 6000, 0, 'failed');
      const before = await rowOf(refund.id);
      assert.equal(before.status, 'failed');
      w.stripe.setRefundState(refund.re!, 'succeeded');
      const res = await deliver(
        app,
        signedRefundEvent({
          type: 'charge.refund.updated',
          refundId: refund.re!,
          paymentIntentId: s.paymentIntentId,
          amountCents: 6000,
          status: 'succeeded',
          refundRowId: refund.id,
        }),
      );
      const after = await rowOf(refund.id);
      assert.equal(after.status, 'failed', 'the machine refuses the write');
      assert.equal(after.updatedAt, before.updatedAt, 'nothing is written');
      assert.equal(await chargeStatusOf(s.chargeId), 'succeeded');
      const lines = level50(capture.lines).filter((l) => l.msg === M6_SENTENCE);
      assert.equal(lines.length, 1, JSON.stringify(level50(capture.lines)));
      assert.equal(lines[0]!.refundId, refund.id);
      assert.equal(res.statusCode, 200, res.body);
    },
  );

  test(
    'the stale order (Fable r2 R5): a delivery retrieves succeeded, waits while refund.failed applies, and arrives holding succeeded against a row now failed → no M6 line',
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const refund = await staffRefund(w, s.chargeId, 6000, 0, 'succeeded');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const isHeld = new Promise<void>((resolve) => (reached = resolve));
      w.stripe.afterNextRefundRetrieve(async () => {
        reached();
        await gate;
      });
      const stale = deliver(
        app,
        signedRefundEvent({
          type: 'refund.updated',
          refundId: refund.re!,
          paymentIntentId: s.paymentIntentId,
          amountCents: 6000,
          status: 'succeeded',
          refundRowId: refund.id,
        }),
      );
      await Promise.race([
        isHeld,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('the delivery never retrieved the refund')), 5000),
        ),
      ]);
      w.stripe.setRefundState(refund.re!, 'failed');
      await deliver(
        app,
        signedRefundEvent({
          type: 'refund.failed',
          refundId: refund.re!,
          paymentIntentId: s.paymentIntentId,
          amountCents: 6000,
          status: 'failed',
          refundRowId: refund.id,
        }),
      );
      assert.equal((await rowOf(refund.id)).status, 'failed');
      release();
      assert.equal((await stale).statusCode, 200);
      assert.equal((await rowOf(refund.id)).status, 'failed');
      assert.equal(
        level50(capture.lines).filter((l) => l.msg === M6_SENTENCE).length,
        0,
        'the second retrieve reads failed, so no line',
      );
    },
  );

  test(
    'any event on a resolved-external row → no-op (a pin: the return already exists)',
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const refund = await staffRefund(w, s.chargeId, 6000, 0, 'failed');
      const closed = await resolveExternal(app, refund.id, {
        note: 'cash at the desk',
        outcome: 'returned',
        instrument: 'cash',
      });
      assert.equal(closed.statusCode, 200, closed.body);
      for (const status of ['succeeded', 'failed'] as const) {
        w.stripe.setRefundState(refund.re!, status);
        const res = await deliver(
          app,
          signedRefundEvent({
            type: 'charge.refund.updated',
            refundId: refund.re!,
            paymentIntentId: s.paymentIntentId,
            amountCents: 6000,
            status,
            refundRowId: refund.id,
          }),
        );
        assert.equal((await rowOf(refund.id)).status, 'resolved-external', `after ${status}`);
        assert.equal(res.statusCode, 200, 'a no-op, not a refusal deeper down');
        assert.deepEqual(level50(capture.lines), [], 'and nothing said about it');
      }
    },
  );

  test('`charge.refunded` for a PaymentIntent with two refunds → each applied once', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const p = await lotP(w.stripe);
    const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
    const a = await staffRefund(w, p.chargeId, 11400, 0);
    const b = await staffRefund(w, p.chargeId, 5700, 0);
    w.stripe.setRefundState(a.re!, 'succeeded');
    w.stripe.setRefundState(b.re!, 'succeeded');
    const event = () =>
      signedChargeRefundedEvent({ paymentIntentId: p.paymentIntentId, amountCents: 45600, amountRefundedCents: 17100 });
    assert.equal((await deliver(app, event())).statusCode, 200);
    const first = await refundRows(p.chargeId);
    assert.deepEqual(
      first.map((r) => r.status),
      ['succeeded', 'succeeded'],
    );
    await deliver(app, event());
    const second = await refundRows(p.chargeId);
    assert.deepEqual(
      second.map((r) => r.updatedAt),
      first.map((r) => r.updatedAt),
      'a second delivery writes nothing',
    );
    assert.equal(await refundableOf(app, p.chargeId), 45600 - 17100);
    assert.equal(await chargeStatusOf(p.chargeId), 'succeeded');
  });

  test(
    "`charge.refunded` delivered while its one refund lists pending (the recording's (f)) → the row stays pending with its re_ now stored, the charge stays succeeded, the history does not read refunded",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      // The create reached Stripe and its reply was lost: Stripe holds the refund, pending;
      // the row has no re_ yet.
      w.stripe.refundLandsThenThrows();
      const wire = created(await postRefund(app, { payment_id: s.chargeId, amount_cents: 6000, credits_to_remove: 0 }));
      assert.equal((await rowOf(wire.id)).stripeRefundId, null);
      await deliver(
        app,
        signedChargeRefundedEvent({ paymentIntentId: s.paymentIntentId, amountCents: 6000, amountRefundedCents: 6000 }),
      );
      const row = await rowOf(wire.id);
      assert.ok(row.stripeRefundId?.startsWith('re_'), 'matched by its metadata.refund_id, its re_ stored');
      assert.equal(row.status, 'pending', 'nothing is marked from charge.refunded itself');
      assert.equal(await chargeStatusOf(s.chargeId), 'succeeded');
      const history = (await (await import('./_refundWorld.js')).payments(app)).find(
        (h) => h.payment_id === s.chargeId,
      )!;
      assert.equal(history.status, 'succeeded', "Tomi's payment does not read refunded");
    },
  );

  test(
    "Sat 31 Oct Shanthi refunds $57.00 from the Stripe dashboard → adopted succeeded, money only, P's credits unchanged, refundable down 5700 (a pin)",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const re = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 5700, status: 'succeeded' });
      const res = await deliver(
        app,
        signedRefundEvent({
          type: 'charge.refund.updated',
          refundId: re,
          paymentIntentId: p.paymentIntentId,
          amountCents: 5700,
          status: 'succeeded',
        }),
      );
      const rows = await refundRows(p.chargeId);
      assert.equal(rows.length, 1, res.body);
      assert.equal(rows[0]!.status, 'succeeded');
      assert.equal(rows[0]!.stripeRefundId, re);
      assert.equal(rows[0]!.reason, 'out-of-band');
      assert.equal(await unspent(p.lotId), 8, "a dashboard refund removes no credits");
      assert.equal(await refundableOf(app, p.chargeId), 45600 - 5700);
    },
  );

  test(
    'a dashboard refund over the cap (planted) → recorded, one refund-coverage-surplus line; over the cap through a pending refund alone → recorded, one over-cap line',
    SKIP_WHEN_NO_DB,
    async () => {
      // Planted by SQL: a succeeded $420.00 and a pending $10.00 (Stripe holds it) on P.
      const w = world();
      const p = await lotP(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      await plantRefundRow({ chargeId: p.chargeId, amountCents: 42000, status: 'succeeded', stripeRefundId: `re_planted_${randomUUID()}` });
      const pendingRe = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 1000, status: 'pending' });
      await plantRefundRow({ chargeId: p.chargeId, amountCents: 1000, status: 'pending', stripeRefundId: pendingRe });
      const re = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 5700, status: 'succeeded' });
      const res = await deliver(
        app,
        signedRefundEvent({ type: 'refund.updated', refundId: re, paymentIntentId: p.paymentIntentId, amountCents: 5700, status: 'succeeded' }),
      );
      assert.equal((await refundRows(p.chargeId)).filter((r) => r.stripeRefundId === re).length, 1, `recorded: ${res.body}`);
      const lines = level50(capture.lines);
      assert.equal(lines.filter((l) => l.moneyEvent === 'refund-coverage-surplus').length, 1, JSON.stringify(lines));
      assert.equal(lines.length, 1, 'one line for one movement');

      // A second payment: only a pending $400.00 makes the $57.00 too large.
      const q = await plantCharge(w.stripe, { amountCents: 45600 });
      extraCharges.push(q.chargeId);
      const qPending = w.stripe.plantRefund({ paymentIntentId: q.paymentIntentId, amountCents: 40000, status: 'pending' });
      await plantRefundRow({ chargeId: q.chargeId, amountCents: 40000, status: 'pending', stripeRefundId: qPending });
      const qDash = w.stripe.plantRefund({ paymentIntentId: q.paymentIntentId, amountCents: 5700, status: 'succeeded' });
      capture.lines.length = 0;
      await deliver(
        app,
        signedRefundEvent({ type: 'refund.updated', refundId: qDash, paymentIntentId: q.paymentIntentId, amountCents: 5700, status: 'succeeded' }),
      );
      assert.equal((await refundRows(q.chargeId)).filter((r) => r.stripeRefundId === qDash).length, 1);
      const over = level50(capture.lines);
      assert.equal(over.length, 1, JSON.stringify(over));
      assert.equal(over[0]!.moneyEvent, 'refund-adopted-over-cap');
    },
  );

  test(
    "a $57.00 dashboard refund first seen pending (the recording's (f)) → adopted pending, refundable down 5700 at once; Returned on a failed row then answers in-flight, and once its refund.updated reads succeeded, over_cap; one row",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const app = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      // Planted by SQL: a failed $400.00 staff refund on P that removed nothing.
      const failed = await plantRefundRow({
        chargeId: p.chargeId,
        amountCents: 40000,
        status: 'failed',
        stripeRefundId: `re_planted_${randomUUID()}`,
        issuedByStaffId: FIXTURE_IDS.staffShanthiId,
      });
      const re = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 5700, status: 'pending' });
      await deliver(
        app,
        signedChargeRefundedEvent({ paymentIntentId: p.paymentIntentId, amountCents: 45600, amountRefundedCents: 5700 }),
      );
      const adopted = (await refundRows(p.chargeId)).filter((r) => r.stripeRefundId === re);
      assert.equal(adopted.length, 1, 'adopted on its first sighting');
      assert.equal(adopted[0]!.status, 'pending');
      assert.equal(await refundableOf(app, p.chargeId), 45600 - 5700, 'it counts in the cap at once');
      codeOf(await resolveExternal(app, failed, { note: 'cash', outcome: 'returned', instrument: 'cash' }), 409, 'refund_in_flight');

      w.stripe.setRefundState(re, 'succeeded');
      await deliver(
        app,
        signedRefundEvent({ type: 'refund.updated', refundId: re, paymentIntentId: p.paymentIntentId, amountCents: 5700, status: 'succeeded' }),
      );
      const after = (await refundRows(p.chargeId)).filter((r) => r.stripeRefundId === re);
      assert.equal(after.length, 1, 'one row');
      assert.equal(after[0]!.status, 'succeeded');
      codeOf(await resolveExternal(app, failed, { note: 'cash', outcome: 'returned', instrument: 'cash' }), 422, 'over_cap');
    },
  );

  test(
    "a dashboard refund beside a pending staff refund (Fable H2) → adopted on its first delivery, refundable 34200 → 28500, the $114.00 row untouched",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const staff = await staffRefund(w, p.chargeId, 11400, 0);
      assert.ok(staff.re);
      const before = await rowOf(staff.id);
      assert.equal(await refundableOf(app, p.chargeId), 34200);
      const re = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 5700, status: 'succeeded' });
      const res = await deliver(
        app,
        signedRefundEvent({ type: 'charge.refund.updated', refundId: re, paymentIntentId: p.paymentIntentId, amountCents: 5700, status: 'succeeded' }),
      );
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await refundRows(p.chargeId)).filter((r) => r.stripeRefundId === re).length, 1);
      assert.equal(await refundableOf(app, p.chargeId), 28500);
      const after = await rowOf(staff.id);
      assert.equal(after.status, 'pending');
      assert.equal(after.updatedAt, before.updatedAt, 'the staff row untouched');
    },
  );

  test(
    "two pending staff refunds of one amount (Fable H3): the older's event, its retrieve failed and its metadata the older row's → the older failed, the newer untouched",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      w.stripe.refundLandsThenThrows();
      const older = created(await postRefund(app, { payment_id: p.chargeId, amount_cents: 5700, credits_to_remove: 0 }));
      w.stripe.refundLandsThenThrows();
      const newer = created(await postRefund(app, { payment_id: p.chargeId, amount_cents: 5700, credits_to_remove: 0 }));
      assert.equal((await rowOf(older.id)).stripeRefundId, null);
      assert.equal((await rowOf(newer.id)).stripeRefundId, null);
      // Stripe executed the older create first.
      const olderRe = w.stripe.executedRefunds()[0]!.id;
      w.stripe.setRefundState(olderRe, 'failed');
      await deliver(
        app,
        signedRefundEvent({ type: 'charge.refund.updated', refundId: olderRe, paymentIntentId: p.paymentIntentId, amountCents: 5700, status: 'failed', refundRowId: older.id }),
      );
      const o = await rowOf(older.id);
      assert.equal(o.status, 'failed');
      assert.equal(o.stripeRefundId, olderRe);
      const n = await rowOf(newer.id);
      assert.equal(n.status, 'pending');
      assert.equal(n.stripeRefundId, null);
      assert.equal((await refundRows(p.chargeId)).length, 2, 'nothing adopted beside them');
    },
  );

  test(
    'the backwards edge on a retry (Fable L6): O failed, retried to R1; R1 succeeded, then failed; Shanthi retries R1 → R2; O answers refund_superseded at every step; money moves once per row that succeeded',
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const o = await staffRefund(w, p.chargeId, 11400, 0, 'failed');
      const oSuperseded = async () => {
        codeOf(await retry(app, o.id), 409, 'refund_superseded');
        codeOf(await resolveExternal(app, o.id, { note: 'n', outcome: 'withdrawn' }), 409, 'refund_superseded');
      };
      w.stripe.setRefundReplyStatus('succeeded');
      const r1 = created(await retry(app, o.id));
      const r1Re = (await rowOf(r1.id)).stripeRefundId!;
      assert.equal((await rowOf(r1.id)).status, 'succeeded');
      await oSuperseded();
      w.stripe.setRefundState(r1Re, 'failed');
      await deliver(
        app,
        signedRefundEvent({ type: 'refund.failed', refundId: r1Re, paymentIntentId: p.paymentIntentId, amountCents: 11400, status: 'failed', refundRowId: r1.id }),
      );
      assert.equal((await rowOf(r1.id)).status, 'failed');
      assert.equal(await refundableOf(app, p.chargeId), 45600, 'the cap reopened');
      await oSuperseded();
      w.stripe.setRefundReplyStatus('succeeded');
      const r2 = created(await retry(app, r1.id));
      assert.equal(r2.retry_of_refund_id, r1.id);
      await oSuperseded();
      const held = w.stripe.refundObjects().filter((r) => r.paymentIntentId === p.paymentIntentId);
      assert.deepEqual(
        held.map((r) => r.status),
        ['failed', 'failed', 'succeeded'],
        'O failed at Stripe, R1 succeeded then failed, R2 succeeded: $114.00 back once',
      );
      assert.equal(await refundableOf(app, p.chargeId), 34200);
    },
  );

  test(
    'a retry racing the backwards edge on its own predecessor (Fable M5): two connections, both orders, natural timing and 6 ms jitter, 40 rounds each',
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      w.stripe.setRefundReplyStatus('pending');
      const counts: Record<string, number> = {};
      for (const order of ['edge-first', 'retry-first'] as const) {
        for (const timing of ['natural', 'jitter'] as const) {
          for (let round = 0; round < 40; round += 1) {
            const c = await plantCharge(w.stripe, { amountCents: 11400 });
            extraCharges.push(c.chargeId);
            const r1 = await plantRefundRow({
              chargeId: c.chargeId,
              amountCents: 11400,
              status: 'pending',
              issuedByStaffId: FIXTURE_IDS.staffShanthiId,
              stripeIdempotencyKey: `race-${randomUUID()}`,
            });
            const re = w.stripe.plantRefund({ paymentIntentId: c.paymentIntentId, amountCents: 11400, status: 'succeeded', metadata: { refund_id: r1 } });
            await db.update(refunds).set({ status: 'succeeded', stripeRefundId: re }).where(eq(refunds.id, r1));
            w.stripe.setRefundState(re, 'failed');
            const edge = async () => {
              if (timing === 'jitter') await jitter();
              return deliver(
                app,
                signedRefundEvent({ type: 'refund.failed', refundId: re, paymentIntentId: c.paymentIntentId, amountCents: 11400, status: 'failed', refundRowId: r1 }),
              );
            };
            const retryIt = async () => {
              if (timing === 'jitter') await jitter();
              return retry(app, r1);
            };
            const [e, r] =
              order === 'edge-first'
                ? await Promise.all([edge(), retryIt()])
                : await Promise.all([retryIt(), edge()]).then(([a, b]) => [b, a] as const);
            assert.equal(e.statusCode, 200, e.body);
            const rows = await refundRows(c.chargeId);
            const head = rows.find((x) => x.id === r1)!;
            assert.equal(head.status, 'failed', 'the edge always lands');
            const successors = rows.filter((x) => x.retryOfRefundId === r1);
            assert.ok(successors.length <= 1, 'at most one successor');
            if (r.statusCode === 201) {
              assert.equal(successors.length, 1);
            } else {
              codeOf(r, 409, 'conflict');
              assert.equal(successors.length, 0);
            }
            const k = `${order}/${timing}/${r.statusCode}`;
            counts[k] = (counts[k] ?? 0) + 1;
          }
        }
      }
      console.log(`# race counts ${JSON.stringify(counts)}`);
    },
  );

  test(
    'redispatchUnfinishedEvent re-runs a refund.failed whose first delivery died before markProcessed',
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const s = await lotS(w.stripe);
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const refund = await staffRefund(w, s.chargeId, 6000, 0, 'succeeded');
      w.stripe.setRefundState(refund.re!, 'failed');
      const event = signedRefundEvent({
        type: 'refund.failed',
        refundId: refund.re!,
        paymentIntentId: s.paymentIntentId,
        amountCents: 6000,
        status: 'failed',
        refundRowId: refund.id,
      });
      // Planted by SQL: the first delivery's claim, unfinished (processed_at NULL).
      await db.insert(stripeEvents).values({ eventId: event.id, eventType: 'refund.failed' });
      const res = await deliver(app, event);
      assert.equal((await rowOf(refund.id)).status, 'failed');
      assert.equal(res.statusCode, 200);
      await db.delete(stripeEvents).where(eq(stripeEvents.eventId, event.id));
    },
  );
});

describe('B-6 the machine: the two markStatus writers refuse every other backwards write', () => {
  test('refundsRepository.markStatus: succeeded → failed is the one backwards edge; every other is refused', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const c = await plantCharge(w.stripe, { amountCents: 6000 });
    extraCharges.push(c.chargeId);
    const write = async (from: string, to: 'pending' | 'succeeded' | 'failed') => {
      const id = await plantRefundRow({ chargeId: c.chargeId, amountCents: 100, status: from as 'pending' });
      try {
        await withActor('system:test', (tx) => refundsRepository.markStatus(tx, { id, status: to }));
        return (await rowOf(id)).status;
      } catch {
        return `refused:${(await rowOf(id)).status}`;
      }
    };
    assert.equal(await write('pending', 'succeeded'), 'succeeded');
    assert.equal(await write('pending', 'failed'), 'failed');
    assert.equal(await write('succeeded', 'failed'), 'failed');
    assert.equal(await write('failed', 'succeeded'), 'refused:failed');
    assert.equal(await write('succeeded', 'pending'), 'refused:succeeded');
    assert.equal(await write('failed', 'pending'), 'refused:failed');
    assert.equal(await write('resolved-external', 'failed'), 'refused:resolved-external');
    assert.equal(await write('unroutable', 'succeeded'), 'refused:unroutable');
  });

  test('chargesRepository.markStatus refuses a backwards write; refunded → succeeded only through the edge', SKIP_WHEN_NO_DB, async () => {
    const w = world();
    const write = async (from: 'succeeded' | 'refunded' | 'failed', to: 'succeeded' | 'failed' | 'refunded' | 'requires_payment') => {
      const c = await plantCharge(w.stripe, { amountCents: 6000, status: from });
      extraCharges.push(c.chargeId);
      try {
        await withActor('system:test', (tx) => chargesRepository.markStatus(tx, { id: c.chargeId, status: to }));
        return await chargeStatusOf(c.chargeId);
      } catch {
        return `refused:${await chargeStatusOf(c.chargeId)}`;
      }
    };
    assert.equal(await write('succeeded', 'refunded'), 'refunded');
    assert.equal(await write('failed', 'succeeded'), 'succeeded', 'a PaymentIntent Stripe later succeeds (the off-engine arm)');
    assert.equal(await write('failed', 'refunded'), 'refunded', 'a late success refunded in full');
    assert.equal(await write('succeeded', 'failed'), 'refused:succeeded');
    assert.equal(await write('refunded', 'failed'), 'refused:refunded');
    assert.equal(await write('refunded', 'succeeded'), 'refused:refunded');
    assert.equal(await write('succeeded', 'requires_payment'), 'refused:succeeded');
    // Idempotent writes at the same status stay allowed.
    assert.equal(await write('succeeded', 'succeeded'), 'succeeded');
    void sql;
  });
});

describe("a second Stripe refund naming a row that already holds another re_ is money of its own (Opus r1 L2)", () => {
  test(
    "Shanthi's $300.00 R succeeds with re_1; a second $300.00 at Stripe carrying R's id lands as refund.updated → its own out-of-band row, R keeps re_1, refundable 15600 → 0, and the surplus is said once over three deliveries (a pin: Mβ)",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const r = await staffRefund(w, p.chargeId, 30000, 0, 'succeeded');
      assert.ok(r.re, "R's re_1 is stored");
      assert.equal(await refundableOf(app, p.chargeId), 15600);
      // Planted at the stub's Stripe, which does not bound it: real Stripe would refuse
      // $300.00 on a payment holding $156.00, but a hand-attested return it never saw can
      // put the cap over just the same. The case below with $114.00 is one Stripe accepts.
      const second = w.stripe.plantRefund({
        paymentIntentId: p.paymentIntentId,
        amountCents: 30000,
        status: 'succeeded',
        metadata: { refund_id: r.id },
      });
      const ev = (type: 'charge.refund.updated' | 'refund.updated') =>
        signedRefundEvent({ type, refundId: second, paymentIntentId: p.paymentIntentId, amountCents: 30000, status: 'succeeded', refundRowId: r.id });
      for (const e of [
        ev('refund.updated'),
        ev('charge.refund.updated'),
        signedChargeRefundedEvent({ paymentIntentId: p.paymentIntentId, amountCents: 45600, amountRefundedCents: 45600 }),
      ]) {
        const res = await deliver(app, e);
        assert.equal(res.statusCode, 200, res.body);
      }
      const rows = await refundRows(p.chargeId);
      assert.equal(rows.length, 2, 'the second Stripe refund is a row of its own');
      const own = rows.find((x) => x.stripeRefundId === second);
      assert.ok(own, 'recorded under its own re_');
      assert.equal(own.reason, 'out-of-band');
      assert.equal(own.status, 'succeeded');
      const held = await rowOf(r.id);
      assert.equal(held.stripeRefundId, r.re, 'R keeps re_1');
      assert.equal(held.status, 'succeeded');
      assert.equal(await refundableOf(app, p.chargeId), 0, 'the cap counts both: nothing more can go back');
      assert.equal(await chargeStatusOf(p.chargeId), 'refunded');
      const lines = level50(capture.lines);
      const surplus = lines.filter((l) => l.moneyEvent === 'refund-coverage-surplus');
      assert.equal(surplus.length, 1, JSON.stringify(lines));
      assert.equal(surplus[0]!.stripeRefundId, second, 'the line names the movement that crossed the line');
      assert.equal(surplus[0]!.surplusCents, 60000 - 45600);
      const second2 = lines.filter((l) => l.msg === TWO_REFUNDS_ONE_ROW);
      assert.equal(second2.length, 1, `the second refund for one row is said once: ${JSON.stringify(lines)}`);
      assert.equal(lines.length, 2, 'the surplus, and the two refunds for one row: two facts, one line each');
    },
  );

  test(
    "within what Stripe still holds: $114.00 R with re_1, then a second $114.00 at Stripe carrying R's id → its own row, R keeps re_1, refundable 34200 → 22800 (a pin: Mβ)",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const r = await staffRefund(w, p.chargeId, 11400, 0, 'succeeded');
      assert.equal(await refundableOf(app, p.chargeId), 34200);
      const second = w.stripe.plantRefund({
        paymentIntentId: p.paymentIntentId,
        amountCents: 11400,
        status: 'succeeded',
        metadata: { refund_id: r.id },
      });
      const updated = signedRefundEvent({ type: 'refund.updated', refundId: second, paymentIntentId: p.paymentIntentId, amountCents: 11400, status: 'succeeded', refundRowId: r.id });
      const res = await deliver(app, updated);
      assert.equal(res.statusCode, 200, res.body);
      const rows = await refundRows(p.chargeId);
      assert.equal(rows.length, 2);
      assert.equal((await rowOf(r.id)).stripeRefundId, r.re, 'R keeps re_1');
      assert.equal(await refundableOf(app, p.chargeId), 22800, 'the cap counts the money Stripe returned twice');

      // Told once, through the webhook route's own logger, with what a person needs.
      const said = level50(capture.lines).filter((l) => l.msg === TWO_REFUNDS_ONE_ROW);
      assert.equal(said.length, 1, JSON.stringify(level50(capture.lines)));
      const adopted = rows.find((x) => x.stripeRefundId === second)!;
      assert.deepEqual(
        {
          moneyEvent: said[0]!.moneyEvent,
          refundId: said[0]!.refundId,
          rowStripeRefundId: said[0]!.rowStripeRefundId,
          rowStatus: said[0]!.rowStatus,
          rowAmountCents: said[0]!.rowAmountCents,
          adoptedRefundId: said[0]!.adoptedRefundId,
          secondStripeRefundId: said[0]!.secondStripeRefundId,
          secondAmountCents: said[0]!.secondAmountCents,
          secondStatus: said[0]!.secondStatus,
          paymentIntentId: said[0]!.paymentIntentId,
          chargeId: said[0]!.chargeId,
        },
        {
          moneyEvent: 'refund-second-stripe-refund-for-row',
          refundId: r.id,
          rowStripeRefundId: r.re,
          rowStatus: 'succeeded',
          rowAmountCents: 11400,
          adoptedRefundId: adopted.id,
          secondStripeRefundId: second,
          secondAmountCents: 11400,
          secondStatus: 'succeeded',
          paymentIntentId: p.paymentIntentId,
          chargeId: p.chargeId,
        },
      );

      // Never twice: the redelivery, the other refund event and charge.refunded all find
      // the adopted row by its re_, so none reaches the adoption again.
      for (const e of [
        updated,
        signedRefundEvent({ type: 'charge.refund.updated', refundId: second, paymentIntentId: p.paymentIntentId, amountCents: 11400, status: 'succeeded', refundRowId: r.id }),
        signedChargeRefundedEvent({ paymentIntentId: p.paymentIntentId, amountCents: 45600, amountRefundedCents: 22800 }),
      ]) {
        const again = await deliver(app, e);
        assert.equal(again.statusCode, 200, again.body);
      }
      assert.equal(level50(capture.lines).filter((l) => l.msg === TWO_REFUNDS_ONE_ROW).length, 1, 'said once');
      assert.equal(level50(capture.lines).length, 1, 'and nothing else said');
      assert.equal((await refundRows(p.chargeId)).length, 2);
    },
  );

  test(
    "first seen pending, then succeeded: the second $114.00 is said once, at its first sighting, reading pending; its succeeded update says nothing more",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const r = await staffRefund(w, p.chargeId, 11400, 0, 'succeeded');
      const second = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 11400, status: 'pending', metadata: { refund_id: r.id } });
      const ev = (status: string) =>
        signedRefundEvent({ type: 'refund.updated', refundId: second, paymentIntentId: p.paymentIntentId, amountCents: 11400, status, refundRowId: r.id });
      assert.equal((await deliver(app, ev('pending'))).statusCode, 200);
      assert.equal(await refundableOf(app, p.chargeId), 22800, 'a pending refund counts in the cap at once');
      const first = level50(capture.lines).filter((l) => l.msg === TWO_REFUNDS_ONE_ROW);
      assert.equal(first.length, 1);
      assert.equal(first[0]!.secondStatus, 'pending');
      w.stripe.setRefundState(second, 'succeeded');
      assert.equal((await deliver(app, ev('succeeded'))).statusCode, 200);
      assert.equal(
        (await refundRows(p.chargeId)).find((x) => x.stripeRefundId === second)!.status,
        'succeeded',
      );
      assert.equal(level50(capture.lines).filter((l) => l.msg === TWO_REFUNDS_ONE_ROW).length, 1, 'said once');
    },
  );

  test(
    "R's own refund failed (R reads failed, Retry to card open) and a second $114.00 carrying R's id succeeded → one line reading rowStatus failed; a second refund Stripe has already failed at its first sighting is recorded failed and says nothing (it returns no money and the cap does not count it)",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const r = await staffRefund(w, p.chargeId, 11400, 0, 'failed');
      assert.equal((await rowOf(r.id)).status, 'failed');
      const second = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 11400, status: 'succeeded', metadata: { refund_id: r.id } });
      assert.equal(
        (await deliver(app, signedRefundEvent({ type: 'refund.updated', refundId: second, paymentIntentId: p.paymentIntentId, amountCents: 11400, status: 'succeeded', refundRowId: r.id }))).statusCode,
        200,
      );
      const said = level50(capture.lines).filter((l) => l.msg === TWO_REFUNDS_ONE_ROW);
      assert.equal(said.length, 1);
      assert.equal(said[0]!.rowStatus, 'failed');
      assert.equal(said[0]!.refundId, r.id);
      assert.equal(await refundableOf(app, p.chargeId), 34200, "R failed leaves the cap; the second refund's money counts");

      // A second refund already failed at Stripe when first seen.
      const s = await lotS(w.stripe);
      const rs = await staffRefund(w, s.chargeId, 6000, 0, 'succeeded');
      const dead = w.stripe.plantRefund({ paymentIntentId: s.paymentIntentId, amountCents: 6000, status: 'failed', metadata: { refund_id: rs.id } });
      capture.lines.length = 0;
      assert.equal(
        (await deliver(app, signedRefundEvent({ type: 'refund.failed', refundId: dead, paymentIntentId: s.paymentIntentId, amountCents: 6000, status: 'failed', refundRowId: rs.id }))).statusCode,
        200,
      );
      const recorded = (await refundRows(s.chargeId)).find((x) => x.stripeRefundId === dead);
      assert.equal(recorded?.status, 'failed', 'recorded, failed');
      assert.deepEqual(level50(capture.lines), [], 'no money moved, so nothing is said');
    },
  );
});

const NOT_ITS_AMOUNT =
  "A STRIPE REFUND NAMES A REFUND ROW BUT NOT ITS AMOUNT — this Stripe refund (stripeRefundId, for stripeRefundAmountCents) carries row refundId in its metadata.refund_id, but that row is for rowAmountCents, and every refund this app sends for a row carries that row's own amount, so it was not sent for that row and was not written onto it. It was recorded as a refund of its own (adoptedRefundId, reading adoptedStatus here), so the payment's cap counts its money, and the row was left as it reads (rowStatus; its own Stripe refund rowStripeRefundId, null while it has none). Check in Stripe, on paymentIntentId, who made this refund and what each refund on this payment is for, before anyone sends, retries or records another refund on this payment, the row's own Retry to card included";

/** The fields a person reads off the line, in one object. */
const notItsAmountFields = (l: Record<string, unknown>) => ({
  moneyEvent: l.moneyEvent,
  refundId: l.refundId,
  rowAmountCents: l.rowAmountCents,
  rowStatus: l.rowStatus,
  rowStripeRefundId: l.rowStripeRefundId,
  adoptedRefundId: l.adoptedRefundId,
  stripeRefundId: l.stripeRefundId,
  stripeRefundAmountCents: l.stripeRefundAmountCents,
  adoptedStatus: l.adoptedStatus,
  paymentIntentId: l.paymentIntentId,
  chargeId: l.chargeId,
  ownerId: l.ownerId,
});

describe("a Stripe refund whose metadata names a row but not its amount is a refund of its own (Opus r2 L2)", () => {
  test(
    "p10 B: Shanthi's $114.00 refund with 2 credits commits and its create never reaches Stripe; a $10.00 Stripe refund carrying that row's id lands as refund.updated → its own out-of-band row at $10.00, the row still $114.00 pending with no re_, refundable 34200 → 33200, the 2 credits stay off, one level-50 line naming both amounts; a redelivery, charge.refund.updated and charge.refunded say nothing more; the sweep then sends the row's own $114.00 under its key",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      // The create never reaches Stripe: the row is pending with no re_, nothing at Stripe.
      w.stripe.throwOnRefund();
      const wire = created(await postRefund(app, { payment_id: p.chargeId, amount_cents: 11400, credits_to_remove: 2 }));
      const r = await rowOf(wire.id);
      assert.deepEqual([r.amountCents, r.status, r.stripeRefundId], [11400, 'pending', null]);
      assert.equal(w.stripe.refundObjects().length, 0, 'Stripe holds nothing for it');
      assert.equal(await unspent(p.lotId), 6, 'the 2 credits came off at the commit');
      assert.equal(await refundableOf(app, p.chargeId), 34200);
      capture.lines.length = 0;

      const forged = w.stripe.plantRefund({
        paymentIntentId: p.paymentIntentId,
        amountCents: 1000,
        status: 'succeeded',
        metadata: { refund_id: wire.id },
      });
      const updated = signedRefundEvent({ type: 'refund.updated', refundId: forged, paymentIntentId: p.paymentIntentId, amountCents: 1000, status: 'succeeded', refundRowId: wire.id });
      const res = await deliver(app, updated);
      assert.equal(res.statusCode, 200, res.body);
      const held = await rowOf(wire.id);
      assert.deepEqual(
        [held.amountCents, held.status, held.stripeRefundId],
        [11400, 'pending', null],
        'the $114.00 row is not the $10.00 refund: its status and re_ are untouched',
      );
      assert.equal(held.updatedAt, r.updatedAt, 'nothing was written onto the row');
      assert.equal(res.outcome, 'adopted-out-of-band-refund');
      const rows = await refundRows(p.chargeId);
      assert.equal(rows.length, 2, 'the $10.00 refund is a row of its own');
      const own = rows.find((x) => x.stripeRefundId === forged);
      assert.ok(own, 'recorded under its own re_');
      assert.deepEqual([own.amountCents, own.status, own.reason], [1000, 'succeeded', 'out-of-band']);
      assert.equal(
        await refundableOf(app, p.chargeId),
        33200,
        'the cap counts the $114.00 still to be sent and the $10.00 that went back',
      );
      assert.equal(await unspent(p.lotId), 6, "the 2 credits stay off: Shanthi's decision stands");

      // Said once, through the webhook route's own logger.
      const said = level50(capture.lines);
      assert.equal(said.length, 1, JSON.stringify(said));
      assert.equal(said[0]!.msg, NOT_ITS_AMOUNT);
      assert.deepEqual(notItsAmountFields(said[0]!), {
        moneyEvent: 'refund-metadata-names-row-other-amount',
        refundId: wire.id,
        rowAmountCents: 11400,
        rowStatus: 'pending',
        rowStripeRefundId: null,
        adoptedRefundId: own.id,
        stripeRefundId: forged,
        stripeRefundAmountCents: 1000,
        adoptedStatus: 'succeeded',
        paymentIntentId: p.paymentIntentId,
        chargeId: p.chargeId,
        ownerId: OWNER_ID,
      });

      // Never twice: every later event finds the adopted row by its re_.
      for (const e of [
        updated,
        signedRefundEvent({ type: 'charge.refund.updated', refundId: forged, paymentIntentId: p.paymentIntentId, amountCents: 1000, status: 'succeeded', refundRowId: wire.id }),
        signedChargeRefundedEvent({ paymentIntentId: p.paymentIntentId, amountCents: 45600, amountRefundedCents: 1000 }),
      ]) {
        const again = await deliver(app, e);
        assert.equal(again.statusCode, 200, again.body);
      }
      assert.equal(level50(capture.lines).length, 1, 'said once, and nothing else said');
      assert.equal((await refundRows(p.chargeId)).length, 2);
      assert.deepEqual(
        [(await rowOf(wire.id)).status, (await rowOf(wire.id)).stripeRefundId],
        ['pending', null],
      );

      // The sweep, past its five-minute rest: the row's own $114.00 goes under its stored key.
      const sweepLog = sweepRecording();
      await runDuplicateRefundRetryOnce({ stripe: w.stripe, now: new Date(Date.now() + 6 * 60 * 1000), log: sweepLog });
      const sent = await rowOf(wire.id);
      assert.ok(sent.stripeRefundId?.startsWith('re_') && sent.stripeRefundId !== forged, 'its own refund at Stripe');
      assert.deepEqual(
        w.stripe.refundObjects().filter((x) => x.paymentIntentId === p.paymentIntentId).map((x) => x.amountCents).sort((a, b) => a - b),
        [1000, 11400],
        'Stripe holds the $10.00 and the row\'s own $114.00',
      );
      assert.equal(await refundableOf(app, p.chargeId), 33200);
      assert.equal(
        sweepLog.lines.filter((l) => l.obj.moneyEvent === 'refund-metadata-names-row-other-amount').length,
        0,
        'the sweep says nothing more about it',
      );
    },
  );

  test(
    "charge.refunded listing the row's own $114.00 (its reply lost) and a $10.00 carrying the same row's id, in either order → the row holds its own re_, the $10.00 is its own row, refundable 33200, one line each time",
    SKIP_WHEN_NO_DB,
    async () => {
      for (const order of ['the $10.00 listed first', "the row's own listed first"] as const) {
        const w = world();
        const p = await lotP(w.stripe);
        const capture = makeLogCapture();
        const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
        w.stripe.setRefundReplyStatus('succeeded');
        let forged = '';
        if (order === "the row's own listed first") {
          // Stripe lists newest first: the $10.00 is made before the row's own lands.
          w.stripe.beforeNextRefundCreate(async (args) => {
            forged = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 1000, status: 'succeeded', metadata: { refund_id: args.metadata!.refund_id! } });
          });
        }
        w.stripe.refundLandsThenThrows();
        const wire = created(await postRefund(app, { payment_id: p.chargeId, amount_cents: 11400, credits_to_remove: 2 }));
        assert.equal((await rowOf(wire.id)).stripeRefundId, null, `${order}: the reply was lost`);
        if (order === 'the $10.00 listed first') {
          forged = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 1000, status: 'succeeded', metadata: { refund_id: wire.id } });
        }
        const ownRe = w.stripe.refundObjects().find((x) => x.paymentIntentId === p.paymentIntentId && x.amountCents === 11400)!.id;
        capture.lines.length = 0;
        const res = await deliver(app, signedChargeRefundedEvent({ paymentIntentId: p.paymentIntentId, amountCents: 45600, amountRefundedCents: 12400 }));
        assert.equal(res.statusCode, 200, `${order}: ${res.body}`);
        const row = await rowOf(wire.id);
        assert.deepEqual([row.stripeRefundId, row.status, row.amountCents], [ownRe, 'succeeded', 11400], `${order}: the row holds its own refund`);
        const rows = await refundRows(p.chargeId);
        assert.equal(rows.length, 2, order);
        const own = rows.find((x) => x.stripeRefundId === forged);
        assert.deepEqual([own?.amountCents, own?.status, own?.reason], [1000, 'succeeded', 'out-of-band'], order);
        assert.equal(await refundableOf(app, p.chargeId), 33200, order);
        const said = level50(capture.lines);
        assert.equal(said.length, 1, `${order}: ${JSON.stringify(said)}`);
        assert.equal(said[0]!.msg, NOT_ITS_AMOUNT, order);
        assert.equal(said[0]!.refundId, wire.id);
        assert.equal(said[0]!.stripeRefundId, forged);
        assert.equal(said[0]!.rowAmountCents, 11400);
        assert.equal(said[0]!.stripeRefundAmountCents, 1000);
        // Which of the two was applied first decides only whether the row held its re_ yet.
        assert.equal(said[0]!.rowStripeRefundId, order === 'the $10.00 listed first' ? null : ownRe, order);
        await clearRefundWorld();
      }
    },
  );

  test(
    "first seen pending, then succeeded: the $10.00 is said once, at its first sighting, reading pending; one Stripe has already failed at its first sighting is recorded failed, the row untouched, and nothing said (it returns no money and the cap does not count it)",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      w.stripe.throwOnRefund();
      const wire = created(await postRefund(app, { payment_id: p.chargeId, amount_cents: 11400, credits_to_remove: 0 }));
      capture.lines.length = 0;
      const later = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 1000, status: 'pending', metadata: { refund_id: wire.id } });
      const ev = (status: string) =>
        signedRefundEvent({ type: 'refund.updated', refundId: later, paymentIntentId: p.paymentIntentId, amountCents: 1000, status, refundRowId: wire.id });
      assert.equal((await deliver(app, ev('pending'))).statusCode, 200);
      assert.equal(await refundableOf(app, p.chargeId), 33200, 'a pending refund counts in the cap at once');
      const first = level50(capture.lines).filter((l) => l.msg === NOT_ITS_AMOUNT);
      assert.equal(first.length, 1, JSON.stringify(level50(capture.lines)));
      assert.equal(first[0]!.adoptedStatus, 'pending');
      w.stripe.setRefundState(later, 'succeeded');
      assert.equal((await deliver(app, ev('succeeded'))).statusCode, 200);
      assert.equal((await refundRows(p.chargeId)).find((x) => x.stripeRefundId === later)?.status, 'succeeded');
      assert.equal(level50(capture.lines).length, 1, 'said once');
      assert.deepEqual([(await rowOf(wire.id)).status, (await rowOf(wire.id)).stripeRefundId], ['pending', null]);

      // Already failed at Stripe when first seen.
      const s = await lotS(w.stripe);
      w.stripe.throwOnRefund();
      const rs = created(await postRefund(app, { payment_id: s.chargeId, amount_cents: 6000, credits_to_remove: 0 }));
      const rsBefore = await rowOf(rs.id);
      const dead = w.stripe.plantRefund({ paymentIntentId: s.paymentIntentId, amountCents: 2000, status: 'failed', metadata: { refund_id: rs.id } });
      capture.lines.length = 0;
      assert.equal(
        (await deliver(app, signedRefundEvent({ type: 'refund.failed', refundId: dead, paymentIntentId: s.paymentIntentId, amountCents: 2000, status: 'failed', refundRowId: rs.id }))).statusCode,
        200,
      );
      const rsAfter = await rowOf(rs.id);
      assert.deepEqual(
        [rsAfter.status, rsAfter.stripeRefundId, rsAfter.updatedAt],
        ['pending', null, rsBefore.updatedAt],
        'a failed $20.00 refund does not fail the $60.00 row it names',
      );
      assert.equal((await refundRows(s.chargeId)).find((x) => x.stripeRefundId === dead)?.status, 'failed', 'recorded, failed');
      assert.equal(await refundableOf(app, s.chargeId), 0, 'the row still counts; the failed refund does not');
      assert.deepEqual(level50(capture.lines), [], 'no money moved, so nothing is said');
    },
  );

  test(
    "the row already holds its own refund: $114.00 R succeeded with re_1, then a $10.00 carrying R's id → its own row, R keeps re_1, refundable 34200 → 33200, and the amount line, not the two-refunds line: one line",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const p = await lotP(w.stripe);
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const r = await staffRefund(w, p.chargeId, 11400, 0, 'succeeded');
      assert.ok(r.re);
      assert.equal(await refundableOf(app, p.chargeId), 34200);
      const other = w.stripe.plantRefund({ paymentIntentId: p.paymentIntentId, amountCents: 1000, status: 'succeeded', metadata: { refund_id: r.id } });
      const res = await deliver(app, signedRefundEvent({ type: 'refund.updated', refundId: other, paymentIntentId: p.paymentIntentId, amountCents: 1000, status: 'succeeded', refundRowId: r.id }));
      assert.equal(res.statusCode, 200, res.body);
      const held = await rowOf(r.id);
      assert.deepEqual([held.stripeRefundId, held.status, held.amountCents], [r.re, 'succeeded', 11400], 'R keeps re_1');
      const own = (await refundRows(p.chargeId)).find((x) => x.stripeRefundId === other);
      assert.deepEqual([own?.amountCents, own?.status, own?.reason], [1000, 'succeeded', 'out-of-band']);
      assert.equal(await refundableOf(app, p.chargeId), 33200);
      const said = level50(capture.lines);
      assert.equal(said.length, 1, JSON.stringify(said));
      assert.equal(said[0]!.msg, NOT_ITS_AMOUNT);
      assert.deepEqual(notItsAmountFields(said[0]!), {
        moneyEvent: 'refund-metadata-names-row-other-amount',
        refundId: r.id,
        rowAmountCents: 11400,
        rowStatus: 'succeeded',
        rowStripeRefundId: r.re,
        adoptedRefundId: own!.id,
        stripeRefundId: other,
        stripeRefundAmountCents: 1000,
        adoptedStatus: 'succeeded',
        paymentIntentId: p.paymentIntentId,
        chargeId: p.chargeId,
        ownerId: OWNER_ID,
      });
      assert.equal(capture.lines.filter((l) => l.msg === TWO_REFUNDS_ONE_ROW).length, 0, 'it is not a second refund for R');
    },
  );
});

describe('a refund event on a payment no charge here records (Opus r1 L3)', () => {
  const NOT_OURS =
    "REFUND ON A PAYMENT NOT RECORDED HERE — no charge names this PaymentIntent and no refund in stripeRefundIds names a refund here by metadata.refund_id, so no charge or refund row was written and the event is answered 200, not retried. It can be a refund on a payment taken in Stripe itself (a payment link or invoice), by another environment on the same Stripe account, or by a B&T confirm-payment whose charge row was never written (its unwind refund). If this PaymentIntent should be one of this app's charges, look it up in charges and in Stripe before recording anything";
  const events: string[] = [];
  afterEach(async () => {
    for (const id of events.splice(0)) await db.delete(stripeEvents).where(eq(stripeEvents.eventId, id));
  });
  const foreignPi = () => `pi_test_p22fix1_${randomUUID().replace(/-/g, '')}`;
  const tableCounts = async () => {
    const { rows } = await db.execute(
      sql`SELECT (SELECT count(*)::int FROM refunds) AS refunds, (SELECT count(*)::int FROM charges) AS charges`,
    );
    return rows[0] as { refunds: number; charges: number };
  };
  const claimOf = async (eventId: string) =>
    (await db.select().from(stripeEvents).where(eq(stripeEvents.eventId, eventId)))[0];

  test(
    "a $57.00 refund made in Stripe on a payment another environment took: refund.updated, charge.refund.updated, charge.refunded and, once Stripe fails it, refund.failed each answer 200 orphan-event and write nothing, with one warn line each naming the PaymentIntent and the event and no level-50 line; a redelivery answers duplicate and says nothing more",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const pi = foreignPi();
      w.stripe.setRefundableBalance(pi, 45600);
      const re = w.stripe.plantRefund({ paymentIntentId: pi, amountCents: 5700, status: 'succeeded' });
      const before = await tableCounts();
      const ev = (type: 'charge.refund.updated' | 'refund.updated' | 'refund.failed', status: string) =>
        signedRefundEvent({ type, refundId: re, paymentIntentId: pi, amountCents: 5700, status });
      const delivered: { id: string; type: string }[] = [];
      const send = async (e: ReturnType<typeof ev>, type: string) => {
        events.push(e.id);
        delivered.push({ id: e.id, type });
        const res = await deliver(app, e);
        assert.equal(res.statusCode, 200, `${type}: ${res.body}`);
        assert.equal(res.outcome, 'orphan-event', type);
        assert.ok((await claimOf(e.id))?.processedAt, `${type}: the claim is finished, so no unfinished-claim alarm names it`);
      };
      const first = ev('refund.updated', 'succeeded');
      await send(first, 'refund.updated');
      await send(ev('charge.refund.updated', 'succeeded'), 'charge.refund.updated');
      await send(
        signedChargeRefundedEvent({ paymentIntentId: pi, amountCents: 45600, amountRefundedCents: 5700 }),
        'charge.refunded',
      );
      w.stripe.setRefundState(re, 'failed');
      await send(ev('refund.failed', 'failed'), 'refund.failed');

      assert.deepEqual(await tableCounts(), before, 'no charge or refund row was written');
      assert.equal(
        (await db.select().from(refunds).where(eq(refunds.stripeRefundId, re))).length,
        0,
        'the refund is recorded nowhere',
      );
      assert.deepEqual(level50(capture.lines), [], 'nothing pages');
      const warned = capture.lines.filter((l) => l.level === 40 && l.msg === NOT_OURS);
      assert.deepEqual(
        warned.map((l) => [l.stripeEventId, l.stripeEventType, l.paymentIntentId]),
        delivered.map((d) => [d.id, d.type, pi]),
        'one warn line per event, naming the event and the PaymentIntent',
      );
      assert.ok(warned.every((l) => JSON.stringify(l.stripeRefundIds) === JSON.stringify([re])));

      const again = await deliver(app, first);
      assert.equal(again.statusCode, 200);
      assert.equal(again.outcome, 'duplicate');
      assert.equal(
        capture.lines.filter((l) => l.level === 40 && l.msg === NOT_OURS).length,
        delivered.length,
        'a redelivery says nothing more',
      );
    },
  );

  test(
    "the other environment's refund carries its own row's id in metadata.refund_id, a uuid that is no row here → the same: 200 orphan-event, nothing written, one warn line",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      const pi = foreignPi();
      w.stripe.setRefundableBalance(pi, 11400);
      const elsewhere = randomUUID();
      const re = w.stripe.plantRefund({ paymentIntentId: pi, amountCents: 11400, status: 'pending', metadata: { refund_id: elsewhere } });
      const before = await tableCounts();
      const e = signedRefundEvent({ type: 'refund.updated', refundId: re, paymentIntentId: pi, amountCents: 11400, status: 'pending', refundRowId: elsewhere });
      events.push(e.id);
      const res = await deliver(app, e);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.outcome, 'orphan-event');
      assert.deepEqual(await tableCounts(), before);
      assert.deepEqual(level50(capture.lines), []);
      const warned = capture.lines.filter((l) => l.level === 40 && l.msg === NOT_OURS);
      assert.equal(warned.length, 1);
      assert.equal(warned[0]!.paymentIntentId, pi);
      assert.equal(warned[0]!.stripeEventId, e.id);
    },
  );

  test(
    "a refund naming one of OUR rows by metadata.refund_id, on a PaymentIntent no charge here records → a real inconsistency: 500 and one level-50 line on every delivery, the claim released, nothing written; and charge.refunded whose list of the PaymentIntent's refunds comes back incomplete → 500, since it cannot say none is ours (a pin)",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const capture = makeLogCapture();
      const app = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture);
      // Planted by SQL: our row R, pending with no re_, on a charge whose PaymentIntent is
      // not the one Stripe's refund names.
      const c = await plantCharge(w.stripe, { amountCents: 45600 });
      extraCharges.push(c.chargeId);
      const r = await plantRefundRow({ chargeId: c.chargeId, amountCents: 5700, status: 'pending', stripeIdempotencyKey: `p22fix1-${randomUUID()}` });
      const rBefore = await rowOf(r);
      const pi = foreignPi();
      w.stripe.setRefundableBalance(pi, 45600);
      const re = w.stripe.plantRefund({ paymentIntentId: pi, amountCents: 5700, status: 'succeeded', metadata: { refund_id: r } });
      const before = await tableCounts();
      const refused = async (e: { id: string; payload: string; signature: string }, what: string) => {
        const lines = level50(capture.lines).length;
        const res = await deliver(app, e);
        assert.equal(res.statusCode, 500, `${what}: ${res.body}`);
        assert.equal(await claimOf(e.id), undefined, `${what}: the claim is released, so Stripe's redelivery re-enters`);
        const said = level50(capture.lines).slice(lines);
        assert.equal(said.length, 1, `${what}: one level-50 line: ${JSON.stringify(said)}`);
        assert.equal(said[0]!.msg, 'unhandled error');
        return (said[0]!.err as { message: string }).message;
      };
      const updated = signedRefundEvent({ type: 'refund.updated', refundId: re, paymentIntentId: pi, amountCents: 5700, status: 'succeeded', refundRowId: r });
      const m1 = await refused(updated, 'refund.updated');
      assert.ok(m1.includes(r) && m1.includes(pi), m1);
      // Opus r2 N2: the metadata names a row here; nothing says the refund is ours.
      assert.equal(
        m1,
        `refund.updated for ${re} names refund ${r} here by metadata.refund_id, but no charge here records PaymentIntent ${pi}: a refund whose metadata names a row here, on a payment no charge here records, is an inconsistency, so the event is refused and Stripe will redeliver it. Look ${pi} up in Stripe and in charges, and compare it with refund ${r}'s own charge, before recording anything`,
      );
      assert.equal(await refused(updated, 'its redelivery'), m1, 'the redelivery says the same');
      const m2 = await refused(
        signedChargeRefundedEvent({ paymentIntentId: pi, amountCents: 45600, amountRefundedCents: 5700 }),
        'charge.refunded',
      );
      assert.ok(m2.includes(r) && m2.includes(pi), m2);
      assert.equal(
        m2,
        `charge.refunded for ${pi}: Stripe lists ${re}, which names refund ${r} here by metadata.refund_id, but no charge here records this PaymentIntent: a refund whose metadata names a row here, on a payment no charge here records, is an inconsistency, so the event is refused and Stripe will redeliver it. Look ${pi} up in Stripe and in charges, and compare it with refund ${r}'s own charge, before recording anything`,
      );
      for (const m of [m1, m2]) assert.doesNotMatch(m, /of ours/, 'a forged metadata is not a refund of ours');
      assert.deepEqual(await tableCounts(), before, 'nothing written');
      const rAfter = await rowOf(r);
      assert.equal(rAfter.status, 'pending');
      assert.equal(rAfter.stripeRefundId, null);
      assert.equal(rAfter.updatedAt, rBefore.updatedAt, 'R untouched');
      assert.deepEqual(
        capture.lines.filter((l) => l.level === 40 && l.msg === NOT_OURS),
        [],
        'never said to be not ours',
      );

      // A foreign PaymentIntent whose refund list comes back incomplete: the refunds it
      // did not list could name one of ours, so it is not called a stranger.
      const other = foreignPi();
      w.stripe.setRefundableBalance(other, 45600);
      w.stripe.plantRefund({ paymentIntentId: other, amountCents: 5700, status: 'succeeded' });
      w.stripe.plantRefund({ paymentIntentId: other, amountCents: 5700, status: 'succeeded' });
      w.stripe.nextRefundListIncomplete();
      const m3 = await refused(
        signedChargeRefundedEvent({ paymentIntentId: other, amountCents: 45600, amountRefundedCents: 11400 }),
        'charge.refunded, list incomplete',
      );
      assert.ok(m3.includes(other), m3);
      assert.deepEqual(await tableCounts(), before);
    },
  );
});
