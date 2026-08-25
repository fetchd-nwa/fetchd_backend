import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  charges,
  creditLedger,
  invoices,
  memberships,
  notifications,
  refunds,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import {
  chargesRepository,
  type ChargeRow,
} from '../../src/db/repositories/chargesRepository.js';
import { membershipsRepository } from '../../src/db/repositories/membershipsRepository.js';
import { refundsRepository } from '../../src/db/repositories/refundsRepository.js';
import { withActor } from '../../src/db/tx.js';
import { registerMembershipsRoute } from '../../src/routes/memberships.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import type {
  StripePaymentIntentResult,
  StripeWebhookEvent,
} from '../../src/lib/stripe.js';
import { clearInvoiceChargeAttempts, FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
  type LogCapture,
} from './_harness.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * `designs/money-residue.md` §2 — the memberships month-1 orphan.
 *
 * THE DEFECT. `POST /memberships` requires a synchronously-succeeding charge
 * (the ruled §J.1 v1 constraint). The non-succeeded arm cancelled the
 * PaymentIntent BEST-EFFORT and 422'd — and `processing` is the one status
 * Stripe refuses to cancel. So: confirm returns `processing`, the cancel
 * throws, the catch swallows it, the owner is told "try a different card",
 * **no `charges` row is written at all**, and hours later the PI settles
 * `succeeded`. The webhook then finds no charge row, the invoice arm passes,
 * the package reconstruct deliberately skips `purpose: 'membership'`, and the
 * event is dropped as `orphan-event`. Money captured at Stripe; no membership,
 * no credits, no charge row, no refund, no notification, no record anywhere.
 *
 * THE INVARIANT these pins exist for: *a membership month-1 charge row never
 * commits `'succeeded'` without either its membership or its refund row in the
 * same transaction.* The cancel arm RECORDS the un-cancellable `processing`
 * intent before it 402s; the webhook gains flip + orphan arms whose disposition
 * is REFUND, never reconstruct (§J.1 v1 stance applied to the async tail); and
 * every route retry path serializes on the charge row's lock.
 */

registerFixtureHooks();

const WORKER_ACTOR = 'system:scheduler';

interface CreateResponse {
  membership: { id: string; dog_id: string };
  charge_id: string;
  credits_granted: number;
  charge_refunded: boolean;
}

function membershipApp(stripe: StripeStub): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerMembershipsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return app;
}

function webhookApp(stripe: StripeStub, capture?: LogCapture): ReturnType<typeof makeContractApp>['app'] {
  const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  registerStripeWebhookRoute(app, { stripe });
  return app;
}

async function subscribe(
  app: ReturnType<typeof makeContractApp>['app'],
  idempotencyKey: string,
): Promise<{ statusCode: number; body: string; json: () => CreateResponse }> {
  const res = await app.inject({
    method: 'POST',
    url: '/memberships',
    headers: { 'idempotency-key': idempotencyKey },
    payload: {
      dog_id: FIXTURE_IDS.dog1Id,
      package_key: FIXTURE_IDS.creditPackageSchool10Key,
      location: 'fayetteville',
      term_months: 3,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
    },
  });
  return { statusCode: res.statusCode, body: res.body, json: () => res.json() as CreateResponse };
}

/**
 * Stripe's SAME-KEY RETRY, modelled honestly (MR-A1.3).
 *
 * A same-key confirm **replays the ORIGINAL response snapshot, not current
 * state** — this repo's own documented premise (`enrollmentPartial.ts:343-344`).
 * The retired `sameIntentStub` manufactured a same-key confirm answering
 * `succeeded`, a shape Stripe never produces on replay, and every arc built on
 * it was therefore unreachable in production. What DOES carry current truth is
 * the RETRIEVE inside `cancelAndConfirm` — which only runs when the replayed
 * snapshot is CANCELLABLE and the cancel is refused.
 *
 * So this stub takes both halves separately:
 *   - `replaySnapshot` — what the confirm answers (the original response);
 *   - `liveStatus` — what a retrieve sees NOW (Stripe's real state).
 *
 * `cancelPaymentIntent` always throws, because every arc this models has an
 * intent Stripe refuses to cancel (it has moved on to `processing` or
 * `succeeded`).
 */
function replayStub(
  base: StripeStub,
  opts: {
    paymentIntentId: string;
    amountCents: number;
    replaySnapshot: StripePaymentIntentResult['status'];
    liveStatus?: StripePaymentIntentResult['status'];
    /** Runs inside the confirm — the seconds-wide window a concurrent writer
     *  lands in (the uniqueness lost-race shape). */
    duringConfirm?: () => Promise<void>;
  },
): StripeStub {
  return {
    ...base,
    async createAndConfirmPaymentIntent(args, idempotencyKey): Promise<StripePaymentIntentResult> {
      base.calls.push({ method: 'createAndConfirmPaymentIntent', args, idempotencyKey });
      if (opts.duringConfirm !== undefined) await opts.duringConfirm();
      return {
        id: opts.paymentIntentId,
        status: opts.replaySnapshot,
        clientSecret: opts.replaySnapshot === 'succeeded' ? null : 'cs_replayed',
        amountCents: opts.amountCents,
        createdAt: new Date(),
        replayed: true,
      };
    },
    async cancelPaymentIntent(paymentIntentId): Promise<void> {
      base.calls.push({
        method: 'cancelPaymentIntent',
        args: { paymentIntentId },
        idempotencyKey: null,
      });
      throw new Error('stub: Stripe refuses to cancel this PaymentIntent');
    },
    async retrievePaymentIntent(paymentIntentId): Promise<StripePaymentIntentResult> {
      base.calls.push({
        method: 'retrievePaymentIntent',
        args: { paymentIntentId },
        idempotencyKey: null,
      });
      return {
        id: paymentIntentId,
        status: opts.liveStatus ?? opts.replaySnapshot,
        clientSecret: null,
        amountCents: opts.amountCents,
        createdAt: new Date(),
      };
    },
  };
}

function evtId(): string {
  return `evt_test_${randomUUID().slice(0, 8)}`;
}

/** The metadata `POST /memberships` stamps on a month-1 PaymentIntent. */
function monthOneMetadata(extra: Record<string, string> = {}): Record<string, string> {
  return {
    owner_id: FIXTURE_IDS.ownerId,
    dog_id: FIXTURE_IDS.dog1Id,
    purpose: 'membership',
    package_id: FIXTURE_IDS.creditPackageSchool5Id,
    package_key: FIXTURE_IDS.creditPackageSchool5Key,
    term_months: '3',
    credits: '5',
    mode: 'school',
    location: 'fayetteville',
    ...extra,
  };
}

function succeededEvent(paymentIntentId: string, amountCents: number, metadata: Record<string, string>): StripeWebhookEvent {
  return {
    id: evtId(),
    type: 'payment_intent.succeeded',
    paymentIntentId,
    amountCents,
    metadata,
  };
}

async function postEvent(
  app: ReturnType<typeof makeContractApp>['app'],
  stripe: StripeStub,
  event: StripeWebhookEvent,
): Promise<{ statusCode: number; outcome?: string }> {
  stripe.setNextEvent(event);
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'stripe-signature': 't=1,v1=fake' },
    payload: { id: event.id, type: event.type },
  });
  const body =
    res.statusCode === 200 ? (res.json() as { outcome: string }) : { outcome: undefined };
  return { statusCode: res.statusCode, outcome: body.outcome };
}

async function membershipCharges(): Promise<
  { id: string; status: string; dogId: string | null; amountCents: number; piId: string | null }[]
> {
  return db
    .select({
      id: charges.id,
      status: charges.status,
      dogId: charges.dogId,
      amountCents: charges.amountCents,
      piId: charges.stripePaymentIntentId,
    })
    .from(charges)
    .where(and(eq(charges.ownerId, FIXTURE_IDS.ownerId), eq(charges.purpose, 'membership')));
}

async function refundsForOwner(): Promise<
  {
    id: string;
    chargeId: string;
    amountCents: number;
    status: string;
    reason: string | null;
    key: string | null;
    stripeRefundId: string | null;
  }[]
> {
  return db
    .select({
      id: refunds.id,
      chargeId: refunds.chargeId,
      amountCents: refunds.amountCents,
      status: refunds.status,
      reason: refunds.reason,
      key: refunds.stripeIdempotencyKey,
      stripeRefundId: refunds.stripeRefundId,
    })
    .from(refunds)
    .where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
}

async function orphanPushes(): Promise<
  {
    dedupeKey: string;
    title: string;
    body: string;
    dogId: string | null;
    deepLinkId: string | null;
  }[]
> {
  return db
    .select({
      dedupeKey: scheduledNotifications.dedupeKey,
      title: scheduledNotifications.title,
      body: scheduledNotifications.body,
      dogId: scheduledNotifications.dogId,
      deepLinkId: scheduledNotifications.deepLinkId,
    })
    .from(scheduledNotifications)
    .where(eq(scheduledNotifications.trigger, 'membership-orphan-refund'));
}

async function cleanup(): Promise<void> {
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.ownerId, FIXTURE_IDS.ownerId),
        inArray(notifications.type, ['membership-ended', 'payment-failed', 'payment-succeeded']),
      ),
    );
  await clearInvoiceChargeAttempts();
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(creditLedger)
    .where(
      and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'membership-grant')),
    );
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(memberships).where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
}

/**
 * Drive the route to the RECORDED-PROCESSING arm: the confirm rests at
 * `processing`, which Stripe refuses to cancel, so the request must commit a
 * `'requires_payment'` membership charge row BEFORE it answers the owner.
 */
async function recordProcessingAttempt(
  stripe: StripeStub,
  idempotencyKey: string,
): Promise<{ statusCode: number; body: string }> {
  const app = membershipApp(stripe);
  stripe.setNextIntentStatus('processing');
  const res = await subscribe(app, idempotencyKey);
  return { statusCode: res.statusCode, body: res.body };
}

// ── 1. the orphan settle: a month-1 PI that settles with nothing behind it ──

test(
  'month-1 orphan — a succeeded membership PI with NO charge row is recorded and REFUNDED, never reconstructed',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const app = webhookApp(stripe);
    const piId = `pi_test_m1orphan_${randomUUID().slice(0, 8)}`;

    const result = await postEvent(app, stripe, succeededEvent(piId, 12_000, monthOneMetadata()));
    assert.equal(result.statusCode, 200);
    assert.equal(
      result.outcome,
      'refunded-orphaned-membership-charge',
      'the drop this arm closes: today this is `orphan-event` and NOTHING is written',
    );

    const chargeRows = await membershipCharges();
    assert.equal(chargeRows.length, 1, 'the money is ON RECORD');
    assert.equal(chargeRows[0]!.status, 'succeeded');
    assert.equal(chargeRows[0]!.dogId, FIXTURE_IDS.dog1Id, 'the dog the metadata named');
    assert.equal(chargeRows[0]!.amountCents, 12_000);

    const refundRows = await refundsForOwner();
    assert.equal(refundRows.length, 1, 'exactly one refund for the orphaned charge');
    assert.equal(refundRows[0]!.chargeId, chargeRows[0]!.id);
    assert.equal(refundRows[0]!.amountCents, 12_000, 'the whole charge comes back');
    assert.equal(refundRows[0]!.status, 'pending');
    assert.equal(
      refundRows[0]!.key,
      `membership-orphan-refund:${refundRows[0]!.id}`,
      'ROW-DERIVED key, stored in the minting tx — sweep lane 1 by construction',
    );

    // No membership was reconstructed — the ruled §J.1 v1 stance.
    const membershipRows = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(membershipRows.length, 0, 'REFUND, never reconstruct');
    const lots = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.dogId, FIXTURE_IDS.dog1Id),
          eq(creditLedger.reason, 'membership-grant'),
        ),
      );
    assert.equal(lots.length, 0, 'no windowed lot with no membership behind it');

    // The owner push, once per charge, ever.
    const pushes = await orphanPushes();
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]!.dedupeKey, `membership-orphan-refund:${chargeRows[0]!.id}`);

    // The post-commit fire sent byte-exact params under the STORED key.
    const refundCalls = stripe.calls.filter((c) => c.method === 'createRefund');
    assert.equal(refundCalls.length, 1, 'the receiver fired the handle post-commit');
    assert.deepStrictEqual(refundCalls[0]!.args, {
      paymentIntentId: piId,
      amountCents: 12_000,
      reason: 'requested_by_customer',
    });
    assert.equal(refundCalls[0]!.idempotencyKey, `membership-orphan-refund:${refundRows[0]!.id}`);
    assert.ok(
      (await refundsForOwner())[0]!.stripeRefundId?.startsWith('re_'),
      'the re_* landed on the row so charge.refund.updated matches deterministically',
    );

    await cleanup();
  },
);

// ── 2. the recorded-processing arm ────────────────────────────────────────

test(
  'month-1 — a `processing` confirm is RECORDED at requires_payment before the 402',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const res = await recordProcessingAttempt(stripe, randomUUID());

    const chargeRows = await membershipCharges();
    assert.equal(
      chargeRows.length,
      1,
      'RED today: the throw never reaches withMutation, so NOTHING is written and the money is invisible',
    );
    assert.equal(chargeRows[0]!.status, 'requires_payment');
    assert.equal(chargeRows[0]!.dogId, FIXTURE_IDS.dog1Id);
    assert.ok(chargeRows[0]!.piId?.startsWith('pi_'), 'the PaymentIntent is on the row');

    assert.equal(res.statusCode, 402, res.body);
    const err = (JSON.parse(res.body) as { error: { code: string; details: { charge_blocker: string } } })
      .error;
    assert.equal(err.code, 'payment_failed');
    assert.equal(err.details.charge_blocker, 'processing', 'money in flight — never "try again"');

    assert.equal(
      stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length,
      0,
      'Stripe refuses to cancel a processing intent — do not pretend to try',
    );

    const membershipRows = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(membershipRows.length, 0);

    await cleanup();
  },
);

// ── 3. the flip arm ───────────────────────────────────────────────────────

test(
  'month-1 — a recorded `requires_payment` row whose PI succeeds is flipped AND refunded, loudly',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    await recordProcessingAttempt(stripe, randomUUID());
    const [recorded] = await membershipCharges();
    assert.ok(recorded, 'staged: a recorded-processing membership charge');
    const piId = recorded.piId!;

    const capture = makeLogCapture();
    const app = webhookApp(stripe, capture);
    const result = await postEvent(
      app,
      stripe,
      succeededEvent(piId, recorded.amountCents, monthOneMetadata()),
    );
    assert.equal(
      result.outcome,
      'refunded-orphaned-membership-charge',
      'RED today: `flipped-charge-succeeded` — the row says paid and the money is KEPT',
    );

    const after = await membershipCharges();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.status, 'succeeded');

    const refundRows = await refundsForOwner();
    assert.equal(refundRows.length, 1);
    assert.equal(refundRows[0]!.amountCents, recorded.amountCents);
    assert.equal(refundRows[0]!.key, `membership-orphan-refund:${refundRows[0]!.id}`);

    const pushes = await orphanPushes();
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]!.title, 'Subscription payment returned');

    // Unattended money movement always pages (the Q-B posture).
    const alarm = capture.lines.find(
      (line) => line.level === 50 && line.moneyEvent === 'membership-orphan-refund',
    );
    assert.ok(alarm, 'the mint is announced at ERROR, naming owner/charge/amount/refund');
    assert.equal(alarm!.ownerId, FIXTURE_IDS.ownerId);
    assert.equal(alarm!.chargeId, recorded.id);
    assert.equal(alarm!.amountCents, recorded.amountCents);
    assert.equal(alarm!.refundId, refundRows[0]!.id);

    await cleanup();
  },
);

// ── 4. the renewal guard (keep-pin) ───────────────────────────────────────

test(
  'month-1 — a membership RENEWAL charge (invoice_id metadata) keeps today`s flip and mints NO refund',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const app = webhookApp(stripe);
    const piId = `pi_test_renewal_${randomUUID().slice(0, 8)}`;
    const invoiceId = randomUUID();

    // The invoice pay route's async arm writes exactly this shape.
    await withActor(WORKER_ACTOR, async (tx) => {
      await tx.insert(charges).values({
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 9_900,
        currency: 'usd',
        status: 'requires_payment',
        purpose: 'membership',
        stripePaymentIntentId: piId,
        dogId: FIXTURE_IDS.dog1Id,
      });
    });

    const result = await postEvent(
      app,
      stripe,
      succeededEvent(piId, 9_900, monthOneMetadata({ invoice_id: invoiceId })),
    );
    assert.equal(
      result.outcome,
      'flipped-charge-succeeded',
      'the §A3.19 webhook-flip door stays exactly as queued — neither widened nor claimed fixed',
    );
    const after = await membershipCharges();
    assert.equal(after[0]!.status, 'succeeded');
    assert.equal((await refundsForOwner()).length, 0, 'a RENEWAL is not an orphan');
    assert.equal((await orphanPushes()).length, 0);

    await cleanup();
  },
);

// ── 5. the retry arcs, as Stripe actually replays them (MR-A1.3) ──────────
//
// The retired staging manufactured a same-key confirm answering `succeeded`.
// Stripe replays the ORIGINAL snapshot, so that shape never occurs and every
// arc built on it was unreachable in production. Three real arcs replace it.

test(
  'month-1 (5a) — the REAL adopt door: a replayed CANCELLABLE snapshot forces the cancel, and the live retrieve says captured',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const base = makeStripeStub();
    const key = randomUUID();
    const piId = `pi_test_3ds_${randomUUID().slice(0, 8)}`;
    const amountCents = 45_000;

    // Attempt 1: confirm rests at `requires_action`; our cancel is refused
    // because the owner completed the 3DS sheet in parallel, so the live
    // retrieve reads `processing` → the recorded-processing arm + 402.
    const first = await subscribe(
      membershipApp(
        replayStub(base, {
          paymentIntentId: piId,
          amountCents,
          replaySnapshot: 'requires_action',
          liveStatus: 'processing',
        }),
      ),
      key,
    );
    assert.equal(first.statusCode, 402, first.body);
    const [recorded] = await membershipCharges();
    assert.ok(recorded, 'staged: the un-cancellable intent is on record');
    assert.equal(recorded.status, 'requires_payment');

    // Attempt 2, SAME key: Stripe replays the cancellable snapshot, the route
    // re-enters cancelAndConfirm, and THAT retrieve carries current truth.
    const second = await subscribe(
      membershipApp(
        replayStub(base, {
          paymentIntentId: piId,
          amountCents,
          replaySnapshot: 'requires_action',
          liveStatus: 'succeeded',
        }),
      ),
      key,
    );
    assert.equal(second.statusCode, 201, second.body);
    const body = second.json();
    assert.equal(body.charge_refunded, false);
    assert.ok(body.credits_granted > 0, 'the owner asked to subscribe and paid — complete it');

    const after = await membershipCharges();
    assert.equal(after.length, 1, 'the recorded row was ADOPTED, not duplicated');
    assert.equal(after[0]!.id, recorded.id);
    assert.equal(after[0]!.status, 'succeeded');
    assert.equal(body.charge_id, recorded.id);
    assert.equal((await refundsForOwner()).length, 0, 'this money bought a membership');

    const membershipRows = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.ownerId, FIXTURE_IDS.ownerId), eq(memberships.status, 'active')));
    assert.equal(membershipRows.length, 1);

    await cleanup();
  },
);

test(
  'month-1 (5b) — P4-B1 promoted: a replayed `processing` AFTER the webhook returned the money answers 409, not "try a different card"',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const key = randomUUID();
    await recordProcessingAttempt(stripe, key);
    const [recorded] = await membershipCharges();
    assert.ok(recorded);

    // The webhook adjudicates: row 'succeeded', refund on its way back.
    const hookResult = await postEvent(
      webhookApp(stripe),
      stripe,
      succeededEvent(recorded.piId!, recorded.amountCents, monthOneMetadata()),
    );
    assert.equal(hookResult.outcome, 'refunded-orphaned-membership-charge');

    // The owner taps again on the SAME key. Stripe replays `processing` — the
    // original snapshot — so nothing here re-touches Stripe. Only the row knows
    // the money is on its way back, which is why arm (a) must read it.
    const res = await subscribe(
      membershipApp(
        replayStub(stripe, {
          paymentIntentId: recorded.piId!,
          amountCents: recorded.amountCents,
          replaySnapshot: 'processing',
        }),
      ),
      key,
    );
    assert.equal(
      res.statusCode,
      409,
      `RED (P4-B1 executed): 402 "try a different card" over money already being returned — ${res.body}`,
    );
    assert.match(
      res.body,
      /didn't complete in time and has been returned to your card/,
      'one sentence, one meaning — the same string arm (b) throws',
    );

    const membershipRows = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(membershipRows.length, 0, 'no membership on money that came back');
    assert.equal((await membershipCharges()).length, 1, 'no new rows');
    assert.equal((await refundsForOwner()).length, 1, 'still exactly one refund');

    await cleanup();
  },
);

test(
  'month-1 (5c) — a replayed `processing` while the money is GENUINELY in flight still answers 402',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const key = randomUUID();
    await recordProcessingAttempt(stripe, key);
    const [recorded] = await membershipCharges();
    assert.ok(recorded);

    const res = await subscribe(
      membershipApp(
        replayStub(stripe, {
          paymentIntentId: recorded.piId!,
          amountCents: recorded.amountCents,
          replaySnapshot: 'processing',
        }),
      ),
      key,
    );
    assert.equal(res.statusCode, 402, res.body);
    const err = (JSON.parse(res.body) as { error: { details: { charge_blocker: string } } }).error;
    assert.equal(err.details.charge_blocker, 'processing', 'still in flight — never "try again"');
    assert.equal((await membershipCharges()).length, 1, 'the idempotent record no-ops');
    assert.equal((await refundsForOwner()).length, 0);

    await cleanup();
  },
);

// ── 6. the 409 is the SAME sentence from either arm ───────────────────────

test(
  'month-1 (6) — arm (a) and arm (b) answer the returned-money case with one string',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const key = randomUUID();
    await recordProcessingAttempt(stripe, key);
    const [recorded] = await membershipCharges();
    assert.ok(recorded);
    await postEvent(
      webhookApp(stripe),
      stripe,
      succeededEvent(recorded.piId!, recorded.amountCents, monthOneMetadata()),
    );

    // Arm (a): the replayed `processing` read-back.
    const viaArmA = await subscribe(
      membershipApp(
        replayStub(stripe, {
          paymentIntentId: recorded.piId!,
          amountCents: recorded.amountCents,
          replaySnapshot: 'processing',
        }),
      ),
      key,
    );
    // Arm (b): the replayed CANCELLABLE snapshot falls through to the success
    // path, whose locked read finds the same terminal row.
    const viaArmB = await subscribe(
      membershipApp(
        replayStub(stripe, {
          paymentIntentId: recorded.piId!,
          amountCents: recorded.amountCents,
          replaySnapshot: 'requires_action',
          liveStatus: 'succeeded',
        }),
      ),
      `${key}-b`,
    );

    assert.equal(viaArmA.statusCode, 409, viaArmA.body);
    assert.equal(viaArmB.statusCode, 409, viaArmB.body);
    const msgA = (JSON.parse(viaArmA.body) as { error: { message: string } }).error.message;
    const msgB = (JSON.parse(viaArmB.body) as { error: { message: string } }).error.message;
    assert.equal(msgA, msgB, 'one string, one meaning');

    assert.equal((await refundsForOwner()).length, 1, 'and neither arm minted anything new');
    await cleanup();
  },
);

// ── 7. lost-race + recorded row compose ───────────────────────────────────

test(
  'month-1 — a recorded row on the uniqueness lost-race branch flips instead of crashing',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const key = randomUUID();
    await recordProcessingAttempt(stripe, key);
    const [recorded] = await membershipCharges();
    assert.ok(recorded);

    // A concurrent subscribe wins the (dog, mode) slot DURING the retry's
    // Stripe round-trip — after the pre-Stripe probe, before the transaction.
    // That window is the only way to reach the in-tx lost-race branch; a winner
    // planted earlier is caught by the probe and 409s before any money moves.
    let winnerId: string | undefined;
    const retryStub = replayStub(stripe, {
      paymentIntentId: recorded.piId!,
      amountCents: recorded.amountCents,
      // The real adopt door (MR-A1.3): a replayed CANCELLABLE snapshot whose
      // live retrieve says the capture won.
      replaySnapshot: 'requires_action',
      liveStatus: 'succeeded',
      duringConfirm: async () => {
        if (winnerId !== undefined) return;
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
      },
    });
    const res = await subscribe(membershipApp(retryStub), key);
    assert.equal(res.statusCode, 201, `RED today: unique-violation 500 — ${res.body}`);
    const body = res.json();
    assert.equal(body.charge_refunded, true);
    assert.equal(body.credits_granted, 0);
    assert.equal(body.membership.id, winnerId);
    assert.equal(body.charge_id, recorded.id, 'the recorded row IS the duplicate charge');

    const after = await membershipCharges();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.status, 'succeeded');
    const refundRows = await refundsForOwner();
    assert.equal(refundRows.length, 1);
    assert.equal(refundRows[0]!.reason, 'duplicate-membership-subscribe');

    await cleanup();
  },
);

// ── 8. captured-during-cancel ─────────────────────────────────────────────

test(
  'month-1 — a capture that beats our cancel completes the subscribe instead of orphaning it',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    stripe.setNextIntentStatus('requires_action');
    stripe.captureBeforeCancel();

    const res = await subscribe(membershipApp(stripe), randomUUID());
    assert.equal(res.statusCode, 201, `RED today: 402 + a silent orphan — ${res.body}`);
    assert.ok(res.json().credits_granted > 0);

    const chargeRows = await membershipCharges();
    assert.equal(chargeRows.length, 1);
    assert.equal(chargeRows[0]!.status, 'succeeded');
    assert.equal((await refundsForOwner()).length, 0, 'the owner asked to subscribe and paid');

    const membershipRows = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.ownerId, FIXTURE_IDS.ownerId), eq(memberships.status, 'active')));
    assert.equal(membershipRows.length, 1);

    await cleanup();
  },
);

// ── 9. payment_failed on the recorded row (keep-pin) ──────────────────────

test(
  'month-1 — payment_failed on a recorded row flips `failed`, pushes nothing, moves no credits',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    await recordProcessingAttempt(stripe, randomUUID());
    const [recorded] = await membershipCharges();
    assert.ok(recorded);

    const result = await postEvent(webhookApp(stripe), stripe, {
      id: evtId(),
      type: 'payment_intent.payment_failed',
      paymentIntentId: recorded.piId!,
      amountCents: recorded.amountCents,
      metadata: monthOneMetadata(),
    });
    assert.equal(result.outcome, 'flipped-charge-failed');

    const after = await membershipCharges();
    assert.equal(after[0]!.status, 'failed');
    assert.equal((await refundsForOwner()).length, 0, 'nothing was captured — nothing to return');
    assert.equal(
      (await orphanPushes()).length,
      0,
      'the owner already got the synchronous 402 answer',
    );
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

    await cleanup();
  },
);

// ── 11. push idempotence / a second event on the same PI ──────────────────

test(
  'month-1 — a second succeeded event on the same PI is a no-op: one charge, one refund, one push',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const app = webhookApp(stripe);
    const piId = `pi_test_m1twice_${randomUUID().slice(0, 8)}`;

    const first = await postEvent(app, stripe, succeededEvent(piId, 12_000, monthOneMetadata()));
    assert.equal(first.outcome, 'refunded-orphaned-membership-charge');

    // A DIFFERENT event id on the same PI — the stripe_events dedupe does not
    // short-circuit it, so the arm's own re-check is what has to hold.
    const second = await postEvent(app, stripe, succeededEvent(piId, 12_000, monthOneMetadata()));
    assert.equal(second.statusCode, 200);
    assert.equal(second.outcome, 'charge-already-terminal');

    assert.equal((await membershipCharges()).length, 1, 'still exactly one charge');
    assert.equal((await refundsForOwner()).length, 1, 'still exactly one refund');
    assert.equal((await orphanPushes()).length, 1, 'one push per charge, ever');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      1,
      'and exactly one Stripe refund attempt',
    );

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A1.4 — the flip arm demands POSITIVE month-1 evidence
//
// The gate was `purpose='membership'` + `invoice_id` ABSENT: negative evidence
// over a third-party-mutable input. Executed by the Opus lane (P1-E3): a
// renewal-shaped charge whose succeeded event arrives with an EMPTY metadata
// bag took the month-1 adjudication — an unattended 9900c refund of money a
// renewal invoice is owed, the invoice left open for a second collection, and
// zero pushes (the push keys `dog_id` off the same absent metadata).
// ──────────────────────────────────────────────────────────────────────────

/** A renewal-shaped charge: `purpose='membership'` at `'requires_payment'`,
 *  exactly what the invoice pay route's async arm writes. */
async function seedRenewalCharge(piId: string, amountCents = 9_900): Promise<void> {
  await withActor(WORKER_ACTOR, async (tx) => {
    await tx.insert(charges).values({
      ownerId: FIXTURE_IDS.ownerId,
      amountCents,
      currency: 'usd',
      status: 'requires_payment',
      purpose: 'membership',
      stripePaymentIntentId: piId,
      dogId: FIXTURE_IDS.dog1Id,
    });
  });
}

test(
  'MR-A1.4 — an EMPTY metadata bag on a renewal-shaped charge degrades to the GENERIC flip, never an unattended refund',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const app = webhookApp(stripe);
    const piId = `pi_test_emptymeta_${randomUUID().slice(0, 8)}`;
    await seedRenewalCharge(piId);

    const result = await postEvent(app, stripe, succeededEvent(piId, 9_900, {}));
    assert.equal(
      result.outcome,
      'flipped-charge-succeeded',
      'RED (P1-E3 executed): `refunded-orphaned-membership-charge` — 9900c refunded unattended on NEGATIVE evidence',
    );
    assert.equal((await refundsForOwner()).length, 0, 'the invoice machinery still owns this money');
    assert.equal((await membershipCharges())[0]!.status, 'succeeded', 'recorded, as it always was');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'and nothing left the account',
    );

    await cleanup();
  },
);

test(
  'MR-A1.4 — `invoice_id: ""` reads as absent, and the package_key leg is what refuses it',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const app = webhookApp(stripe);
    const piId = `pi_test_emptyinv_${randomUUID().slice(0, 8)}`;
    await seedRenewalCharge(piId);

    // P1-E2: `metadataString` treats '' as missing, so the old gate PASSED on a
    // bag an attacker (or a Stripe dashboard edit) merely emptied one field of.
    // Under the fingerprint gate the missing `package_key` refuses it anyway —
    // as long as the bag carries no month-1 stamp.
    const result = await postEvent(
      app,
      stripe,
      succeededEvent(piId, 9_900, { invoice_id: '', owner_id: FIXTURE_IDS.ownerId }),
    );
    assert.equal(result.outcome, 'flipped-charge-succeeded');
    assert.equal((await refundsForOwner()).length, 0);

    await cleanup();
  },
);

test(
  'MR-A1.4 — the push`s dog_id comes off the LOCKED ROW, not the event metadata',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const key = randomUUID();
    await recordProcessingAttempt(stripe, key);
    const [recorded] = await membershipCharges();
    assert.ok(recorded);
    assert.equal(recorded.dogId, FIXTURE_IDS.dog1Id, 'arm (a) recorded the dog');

    // A month-1 fingerprint with `dog_id` STRIPPED from the event. The old push
    // keyed off metadata and would land nowhere; the row knows.
    const withoutDog = { ...monthOneMetadata() };
    delete withoutDog.dog_id;
    const result = await postEvent(
      webhookApp(stripe),
      stripe,
      succeededEvent(recorded.piId!, recorded.amountCents, withoutDog),
    );
    assert.equal(result.outcome, 'refunded-orphaned-membership-charge');

    const pushes = await orphanPushes();
    assert.equal(pushes.length, 1, 'RED today: 0 — the push keyed off the absent metadata');
    assert.equal(pushes[0]!.dogId, FIXTURE_IDS.dog1Id, 'from the row');
    assert.equal(pushes[0]!.deepLinkId, FIXTURE_IDS.dog1Id, 'and the deep link opens the right dog');

    await cleanup();
  },
);

test(
  'MR-A1.4 — a month-1 charge whose PI predates the package_key stamp degrades conservatively (keep-pin)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const app = webhookApp(stripe);
    const piId = `pi_test_nostamp_${randomUUID().slice(0, 8)}`;
    await seedRenewalCharge(piId, 12_000);

    // No such row exists — this branch is deploy-fresh — but the conservative
    // fallback is the DELIBERATE choice and is pinned so nobody "fixes" it into
    // an unattended refund on partial evidence.
    const withoutStamp = { ...monthOneMetadata() };
    delete withoutStamp.package_key;
    const result = await postEvent(app, stripe, succeededEvent(piId, 12_000, withoutStamp));
    assert.equal(result.outcome, 'flipped-charge-succeeded');
    assert.equal((await refundsForOwner()).length, 0, 'recorded money, no unattended movement');

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A1.6.2 — the honest outcome literal
// ──────────────────────────────────────────────────────────────────────────

test(
  'MR-A1.6.2 — an orphan whose money is already fully covered reports `membership-orphan-already-covered`',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const key = randomUUID();
    await recordProcessingAttempt(stripe, key);
    const [recorded] = await membershipCharges();
    assert.ok(recorded);

    // Somebody already spoke for this money (a staff dashboard refund adopted,
    // or a hand-written row). The arm must not claim it refunded anything.
    await withActor(WORKER_ACTOR, async (tx) => {
      await tx.insert(refunds).values({
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: recorded.id,
        bookingId: null,
        amountCents: recorded.amountCents,
        status: 'unroutable',
        reason: 'cancel',
        stripeIdempotencyKey: null,
      });
    });

    const result = await postEvent(
      webhookApp(stripe),
      stripe,
      succeededEvent(recorded.piId!, recorded.amountCents, monthOneMetadata()),
    );
    assert.equal(
      result.outcome,
      'membership-orphan-already-covered',
      'RED today: `refunded-orphaned-membership-charge` — it refunded nothing',
    );
    assert.equal((await refundsForOwner()).length, 1, 'no second row');
    assert.equal((await membershipCharges())[0]!.status, 'succeeded', 'the invariant still holds');

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A1.6.4 (Fable F6) — the route-create loser is MAPPED, not a 500
// ──────────────────────────────────────────────────────────────────────────

test(
  'MR-A1.6.4 — the webhook winning the gap between the locked read and the INSERT yields a definite answer, not a 500',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const app = membershipApp(stripe);

    // The gap is real but sub-millisecond: the locked read of a row that does
    // not exist locks NOTHING, so a webhook orphan-insert can land between it
    // and this request's INSERT. Staged by wrapping the repo verb — the same
    // technique the refund-retry suite uses on `markUnroutable`.
    const realInsert = chargesRepository.insertIfAbsentByPaymentIntent.bind(chargesRepository);
    const realCreate = chargesRepository.create.bind(chargesRepository);
    let planted = false;
    const plantCompetingRow = async (piId: string, amountCents: number): Promise<void> => {
      if (planted) return;
      planted = true;
      await withActor('system:stripe-webhook', async (tx) => {
        const inserted = await realInsert(tx, {
          ownerId: FIXTURE_IDS.ownerId,
          amountCents,
          status: 'succeeded',
          purpose: 'membership',
          stripePaymentIntentId: piId,
          dogId: FIXTURE_IDS.dog1Id,
        });
        await tx.insert(refunds).values({
          ownerId: FIXTURE_IDS.ownerId,
          chargeId: inserted.charge.id,
          bookingId: null,
          amountCents,
          status: 'pending',
          reason: 'membership-month1-orphan',
          stripeIdempotencyKey: `membership-orphan-refund:${randomUUID()}`,
        });
      });
    };
    chargesRepository.insertIfAbsentByPaymentIntent = async (tx, args) => {
      await plantCompetingRow(args.stripePaymentIntentId, args.amountCents);
      return realInsert(tx, args);
    };
    chargesRepository.create = async (tx, args) => {
      await plantCompetingRow(args.stripePaymentIntentId, args.amountCents);
      return realCreate(tx, args);
    };

    try {
      const res = await subscribe(app, randomUUID());
      assert.equal(
        res.statusCode,
        409,
        `RED today: a transient unique-violation 500 — ${res.body.slice(0, 200)}`,
      );
      assert.match(res.body, /returned to your card/, 'the mapped answer, in-request');
      assert.equal((await membershipCharges()).length, 1, 'exactly one row per PaymentIntent');
      const membershipRows = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
      assert.equal(membershipRows.length, 0);
    } finally {
      chargesRepository.insertIfAbsentByPaymentIntent = realInsert;
      chargesRepository.create = realCreate;
    }

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A2.1 — the loser fall-through RE-LOCKS before it re-dispatches
//
// MR-A1.6.4's fall-through dispatched from `insertIfAbsentByPaymentIntent`'s
// conflict fallback, which is a PLAIN read (no FOR UPDATE). The Fable lane
// executed the consequence: the webhook's locked flip+mint commits inside the
// loser's read→dispatch window, the route then adopts the STALE
// `'requires_payment'` answer and grants — **membership AND refund both stand,
// and the school eats one month's fee.** §2.2's own sentence ("whoever flips it
// terminal adjudicates UNDER THE CHARGE ROW'S LOCK") was right; A1.6.4's text
// omitted the lock and the build followed the text.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Drive the real route into its INSERT-loser fall-through, with a webhook
 * adjudication committed inside the read→dispatch window.
 *
 * The window is sub-millisecond in production, so it is staged by wrapping the
 * repo verb — the technique the refund-retry suite uses on `markUnroutable`.
 * The first call plants the competing `'requires_payment'` row (so the INSERT
 * conflicts and the fallback read answers "adoptable"), then runs the webhook's
 * own flip+mint writes in their own committed transaction, exactly where the
 * loser sits between reading and acting.
 */
async function subscribeIntoLoserWindow(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  key: string;
  /** Receives the row exactly as the conflict fallback returned it — the STALE
   *  view the pre-MR-A2.1 code dispatched from. The mutation test answers the
   *  re-lock with it, which is what restores the old behaviour faithfully. */
  onStaleRow?: (row: ChargeRow) => void;
}): Promise<{ statusCode: number; body: string }> {
  const realInsert = chargesRepository.insertIfAbsentByPaymentIntent.bind(chargesRepository);
  let staged = false;
  chargesRepository.insertIfAbsentByPaymentIntent = async (tx, args) => {
    if (staged) return realInsert(tx, args);
    staged = true;
    // 1. The competing row, committed BEFORE this insert — so it conflicts and
    //    the repo's plain fallback read returns `'requires_payment'`.
    await withActor('system:stripe-webhook', async (planted) => {
      await realInsert(planted, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: args.amountCents,
        status: 'requires_payment',
        purpose: 'membership',
        stripePaymentIntentId: args.stripePaymentIntentId,
        dogId: FIXTURE_IDS.dog1Id,
      });
    });
    const result = await realInsert(tx, args);
    opts.onStaleRow?.(result.charge);
    // 2. THE WINDOW. The webhook's month-1 adjudication — lock, flip, mint —
    //    committing while the route sits between its read and its write.
    await withActor('system:stripe-webhook', async (hook) => {
      const locked = await chargesRepository.findByStripePaymentIntentIdForUpdate(
        hook,
        args.stripePaymentIntentId,
      );
      if (locked === undefined || locked.status !== 'requires_payment') return;
      await chargesRepository.markStatus(hook, { id: locked.id, status: 'succeeded' });
      await refundsRepository.mintCappedPendingRefund(hook, {
        chargeId: locked.id,
        ownerId: locked.ownerId,
        bookingId: null,
        reason: 'membership-month1-orphan',
        stripeIdempotencyKey: (refundId) => `membership-orphan-refund:${refundId}`,
      });
    });
    return result;
  };
  try {
    const res = await subscribe(opts.app, opts.key);
    return { statusCode: res.statusCode, body: res.body };
  } finally {
    chargesRepository.insertIfAbsentByPaymentIntent = realInsert;
  }
}

/** The end state the month-1 invariant forbids: a membership AND a refund for
 *  the same money. Exactly one of the two may exist. */
async function membershipAndRefundCoexist(): Promise<{
  memberships: number;
  refunds: number;
  both: boolean;
}> {
  const membershipRows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
  const refundRows = await refundsForOwner();
  return {
    memberships: membershipRows.length,
    refunds: refundRows.length,
    both: membershipRows.length > 0 && refundRows.length > 0,
  };
}

test(
  'MR-A2.1 — a webhook adjudication inside the loser`s window is SEEN: 409, never membership-and-refund',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const res = await subscribeIntoLoserWindow({
      app: membershipApp(stripe),
      key: randomUUID(),
    });

    const state = await membershipAndRefundCoexist();
    assert.equal(
      state.both,
      false,
      `RED (Fable F-P1B-1 executed): membership AND refund both stand — the school eats one month's fee ` +
        `(memberships=${state.memberships}, refunds=${state.refunds})`,
    );
    assert.equal(res.statusCode, 409, `the loser must answer from the LOCKED row — ${res.body}`);
    assert.match(res.body, /returned to your card/);
    assert.equal(state.memberships, 0, 'no membership on money that is going back');
    assert.equal(state.refunds, 1, 'exactly one refund, minted by the webhook');

    await cleanup();
  },
);

test(
  'MR-A2.1 — mutation proof: without the re-lock the coexistence comes straight back',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // The instrument has to be shown to FAIL. `findByStripePaymentIntentIdForUpdate`
    // is downgraded to the PLAIN read for the fall-through's re-lock — exactly
    // the code MR-A2.1 replaced — and the same staging must then reproduce the
    // executed defect. Restored in `finally`, and the restoration is asserted.
    const realLockedRead = chargesRepository.findByStripePaymentIntentIdForUpdate.bind(
      chargesRepository,
    );
    let staleRow: ChargeRow | undefined;
    chargesRepository.findByStripePaymentIntentIdForUpdate = async (tx, piId) => {
      // Once the conflict fallback has produced its row, answer the
      // fall-through's re-lock WITH THAT ROW — which is precisely what the
      // pre-MR-A2.1 code did (it dispatched from the fallback and never read
      // again). Arm (b)'s own earlier locked read is untouched.
      if (staleRow !== undefined) return staleRow;
      return realLockedRead(tx, piId);
    };
    try {
      const stripe = makeStripeStub();
      const res = await subscribeIntoLoserWindow({
        app: membershipApp(stripe),
        key: randomUUID(),
        onStaleRow: (row) => {
          staleRow = row;
        },
      });
      const state = await membershipAndRefundCoexist();
      assert.equal(
        state.both,
        true,
        `the mutation must reproduce the defect, or this test proves nothing about the fix ` +
          `(http=${res.statusCode}, memberships=${state.memberships}, refunds=${state.refunds})`,
      );
    } finally {
      chargesRepository.findByStripePaymentIntentIdForUpdate = realLockedRead;
    }
    assert.equal(
      chargesRepository.findByStripePaymentIntentIdForUpdate,
      realLockedRead,
      'the real locked read is restored',
    );
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A2.2 — "did the webhook adjudicate?" counts refund ROWS, not the
// non-failed sum.
//
// Both dispatch sites answered with `sumNonFailedForCharge > 0`, which EXCLUDES
// `'failed'`. A month-1 orphan whose refund Stripe FAILED — exactly the R18/R19
// class the abandon report exists for — read as "no refund at all" and took the
// invariant throw: a 500 with no idempotency record, so every retry re-500s
// forever while an operator chases corruption that does not exist. Executed on
// both arms (Opus Q4-D and Q7-b).
// ──────────────────────────────────────────────────────────────────────────

/** A month-1 charge that settled, was adjudicated, and whose refund Stripe then
 *  FAILED — the state both dispatch sites used to read as "never adjudicated". */
async function stageFailedOrphanRefund(
  stripe: StripeStub,
  key: string,
): Promise<{ chargeId: string; piId: string; amountCents: number }> {
  await recordProcessingAttempt(stripe, key);
  const [recorded] = await membershipCharges();
  assert.ok(recorded, 'staged: a recorded-processing membership charge');
  await postEvent(
    webhookApp(stripe),
    stripe,
    succeededEvent(recorded.piId!, recorded.amountCents, monthOneMetadata()),
  );
  // Stripe created the refund and then failed it (a closed card account).
  await db
    .update(refunds)
    .set({ status: 'failed', stripeRefundId: `re_test_${randomUUID().slice(0, 8)}` })
    .where(eq(refunds.chargeId, recorded.id));
  const rows = await refundsForOwner();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'failed', 'staged: the orphan refund FAILED at Stripe');
  return { chargeId: recorded.id, piId: recorded.piId!, amountCents: recorded.amountCents };
}

test(
  'MR-A2.2 — arm (a): a replayed retry over a FAILED orphan refund answers 409, not a permanent 500',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const key = randomUUID();
    const staged = await stageFailedOrphanRefund(stripe, key);

    const res = await subscribe(
      membershipApp(
        replayStub(stripe, {
          paymentIntentId: staged.piId,
          amountCents: staged.amountCents,
          replaySnapshot: 'processing',
        }),
      ),
      key,
    );
    assert.equal(
      res.statusCode,
      409,
      `RED (Q7-b executed): 500 "month-1 invariant broken" — a failed refund IS an adjudication — ${res.body}`,
    );
    assert.match(res.body, /returned to your card/);
    assert.equal((await refundsForOwner()).length, 1, 'no second refund');
    const membershipRows = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(membershipRows.length, 0);

    await cleanup();
  },
);

test(
  'MR-A2.2 — arm (b): the locked-read dispatch over a FAILED orphan refund answers 409 too',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const staged = await stageFailedOrphanRefund(stripe, randomUUID());

    // A fresh request whose confirm replays the SAME succeeded PaymentIntent —
    // the sync-success-crash arc, whose replay really does answer `succeeded`.
    // It reaches arm (b)'s locked read, which finds the terminal row.
    const res = await subscribe(
      membershipApp(
        replayStub(stripe, {
          paymentIntentId: staged.piId,
          amountCents: staged.amountCents,
          replaySnapshot: 'succeeded',
        }),
      ),
      randomUUID(),
    );
    assert.equal(
      res.statusCode,
      409,
      `RED (Q4-D executed): 500 internal — the same conflated predicate, one arm over — ${res.body}`,
    );
    assert.match(res.body, /returned to your card/);
    assert.equal((await refundsForOwner()).length, 1);

    await cleanup();
  },
);

test(
  'MR-A2.2 — the invariant throw SURVIVES for the genuinely broken state: terminal charge, ZERO refund rows',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const key = randomUUID();
    await recordProcessingAttempt(stripe, key);
    const [recorded] = await membershipCharges();
    assert.ok(recorded);
    // Terminal with NOTHING behind it — no membership, no refund of any status.
    // This is corruption, and it must stay loud rather than degrade to a polite
    // answer that hides it.
    await withActor(WORKER_ACTOR, (tx) =>
      chargesRepository.markStatus(tx, { id: recorded.id, status: 'succeeded' }),
    );
    assert.equal((await refundsForOwner()).length, 0, 'staged: zero refund rows');

    const res = await subscribe(
      membershipApp(
        replayStub(stripe, {
          paymentIntentId: recorded.piId!,
          amountCents: recorded.amountCents,
          replaySnapshot: 'processing',
        }),
      ),
      key,
    );
    assert.equal(res.statusCode, 500, 'a broken invariant is not a 409');

    await cleanup();
  },
);

test(
  'MR-A2.2 — and resolving the failed row keeps the answer 409 (the executed companion pin)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const stripe = makeStripeStub();
    const key = randomUUID();
    const staged = await stageFailedOrphanRefund(stripe, key);
    const [row] = await refundsForOwner();
    const count = await withActor('staff:donavan', (tx) =>
      refundsRepository.markResolvedExternal(tx, {
        id: row!.id,
        note: 'returned by check #1042',
        staffId: FIXTURE_IDS.staffDonavanId,
      }),
    );
    assert.equal(count, 1, 'staged: the human attested the return');

    const res = await subscribe(
      membershipApp(
        replayStub(stripe, {
          paymentIntentId: staged.piId,
          amountCents: staged.amountCents,
          replaySnapshot: 'processing',
        }),
      ),
      key,
    );
    assert.equal(res.statusCode, 409, res.body);
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A3.1 — the last uncapped cap-entering write
//
// The duplicate-subscribe winner branch called `createPending` RAW at
// `intent.amountCents`. The charge LOCK was held (via `resolveChargeRow`) — the
// AMOUNT was unguarded, and MR-A1.2(i)'s inventory listed the site as compliant
// on the lock and missed the cap. The Opus lane executed it: a charge already
// carrying an adopted 4000c dashboard refund → the lost-race mints 9900c →
// 13900c of non-failed refunds on a 9900c charge, and the post-commit fire
// sends it.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stage the executed R2-C shape: a recorded month-1 charge that already carries
 * an adopted dashboard refund, then a subscribe whose confirm replays the same
 * PaymentIntent as `succeeded` while a concurrent winner membership lands
 * inside the Stripe round-trip.
 */
async function lostRaceOverExistingRefund(opts: {
  chargeCents: number;
  adoptedCents: number;
}): Promise<{
  statusCode: number;
  body: string;
  chargeId: string;
  stripe: StripeStub;
  winnerId: string | undefined;
}> {
  const stripe = makeStripeStub();
  await recordProcessingAttempt(stripe, randomUUID());
  const [recorded] = await membershipCharges();
  assert.ok(recorded, 'staged: a recorded-processing month-1 charge');
  await db
    .update(charges)
    .set({ amountCents: opts.chargeCents })
    .where(eq(charges.id, recorded.id));

  // A staff dashboard PARTIAL refund, adopted against the not-yet-terminal
  // month-1 charge (the adoption arm does not gate on charge status).
  const adoption = await postEvent(webhookApp(stripe), stripe, {
    id: `evt_test_${randomUUID().slice(0, 8)}`,
    type: 'charge.refund.updated',
    refundId: `re_test_dash_${randomUUID().slice(0, 8)}`,
    paymentIntentId: recorded.piId!,
    amountCents: opts.adoptedCents,
    status: 'succeeded',
  });
  assert.equal(adoption.outcome, 'adopted-out-of-band-refund', 'staged: the dashboard refund');

  let winnerId: string | undefined;
  const res = await subscribe(
    membershipApp(
      replayStub(stripe, {
        paymentIntentId: recorded.piId!,
        amountCents: opts.chargeCents,
        replaySnapshot: 'succeeded',
        // The winner lands after the pre-Stripe probe, inside the round-trip —
        // the only window that reaches the in-tx lost-race branch.
        duringConfirm: async () => {
          if (winnerId !== undefined) return;
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
        },
      }),
    ),
    randomUUID(),
  );
  return { statusCode: res.statusCode, body: res.body, chargeId: recorded.id, stripe, winnerId };
}

const nonFailedFor = (chargeId: string): Promise<number> =>
  withActor(WORKER_ACTOR, (tx) => refundsRepository.sumNonFailedForCharge(tx, chargeId));

test(
  'MR-A3.1 — the lost-race mint is CAPPED: 4000c already returned means it mints the 5900c remainder, not 9900c',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const out = await lostRaceOverExistingRefund({ chargeCents: 9_900, adoptedCents: 4_000 });
    assert.equal(out.statusCode, 201, out.body);
    const body = JSON.parse(out.body) as CreateResponse;
    assert.equal(body.charge_refunded, true);
    assert.equal(body.credits_granted, 0);
    assert.equal(body.membership.id, out.winnerId, 'the winner membership is returned');

    const nonFailed = await nonFailedFor(out.chargeId);
    assert.equal(
      nonFailed,
      9_900,
      `RED (R2-C executed): 13900c of non-failed refunds on a 9900c charge — the only cap-entering write outside a capped verb`,
    );

    const minted = (await refundsForOwner()).filter(
      (r) => r.reason === 'duplicate-membership-subscribe',
    );
    assert.equal(minted.length, 1);
    assert.equal(minted[0]!.amountCents, 5_900, 'the refund that MOVES is the remainder');

    const fires = out.stripe.calls.filter((c) => c.method === 'createRefund');
    assert.equal(fires.length, 1, 'exactly one post-commit fire');
    assert.equal(
      fires[0]!.method === 'createRefund' ? fires[0]!.args.amountCents : undefined,
      5_900,
      'and it carries the capped figure, not the intent amount',
    );

    await cleanup();
  },
);

test(
  'MR-A3.1 — full prior coverage: 201 winner + charge_refunded, NO mint, NO fire, one WARN',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const capture = makeLogCapture();
    const stripe = makeStripeStub();
    await recordProcessingAttempt(stripe, randomUUID());
    const [recorded] = await membershipCharges();
    assert.ok(recorded);
    await db.update(charges).set({ amountCents: 9_900 }).where(eq(charges.id, recorded.id));
    // FULL prior coverage that leaves the charge non-terminal: an automatic
    // refund already in flight for the whole amount. (A *succeeded* adoption
    // would also flip the charge `'refunded'`, and the route would then answer
    // the 409 from its locked read long before the lost-race branch — a
    // different arm, already pinned.)
    await withActor(WORKER_ACTOR, async (tx) => {
      await tx.insert(refunds).values({
        ownerId: FIXTURE_IDS.ownerId,
        chargeId: recorded.id,
        bookingId: null,
        amountCents: 9_900,
        status: 'pending',
        reason: 'membership-month1-orphan',
        stripeIdempotencyKey: `membership-orphan-refund:${randomUUID()}`,
      });
    });
    const firesBefore = stripe.calls.filter((c) => c.method === 'createRefund').length;

    let winnerId: string | undefined;
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
    registerMembershipsRoute(app, {
      authenticate,
      now: FIXTURE_NOW,
      stripe: replayStub(stripe, {
        paymentIntentId: recorded.piId!,
        amountCents: 9_900,
        replaySnapshot: 'succeeded',
        duringConfirm: async () => {
          if (winnerId !== undefined) return;
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
        },
      }),
    });
    const res = await subscribe(app, randomUUID());

    // NOT the 409: the winner membership EXISTS and the dog IS subscribed, so
    // "start again" would be false. `charge_refunded: true` stays true in
    // substance — full prior coverage means this charge's return is already
    // recorded, and the owner's card nets one charge.
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().charge_refunded, true);
    assert.equal(res.json().membership.id, winnerId);

    const dupRows = (await refundsForOwner()).filter(
      (r) => r.reason === 'duplicate-membership-subscribe',
    );
    assert.equal(dupRows.length, 0, 'RED today: a raw 9900c row on a fully-covered charge');
    assert.equal(await nonFailedFor(recorded.id), 9_900, 'the cap is untouched');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      firesBefore,
      'and nothing was fired',
    );

    const warn = capture.lines.find(
      (line) => line.level === 40 && line.moneyEvent === 'duplicate-subscribe-already-covered',
    );
    assert.ok(warn, 'the no-silent rule applies even when the cap did its job');
    assert.equal(warn!.chargeId, recorded.id);
    assert.equal(warn!.ownerId, FIXTURE_IDS.ownerId);

    await cleanup();
  },
);

test(
  'MR-A3.1 — mutation proof: an uncapped mint at the intent amount reproduces 13900c',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // Restore the pre-A3.1 behaviour AT THE CALL SITE: the helper is replaced
    // by one that ignores the cap and mints the charge's full amount, which is
    // exactly what `createPending(intent.amountCents)` did.
    const realMint = refundsRepository.mintCappedPendingRefund.bind(refundsRepository);
    refundsRepository.mintCappedPendingRefund = async (tx, args) => {
      if (args.reason !== 'duplicate-membership-subscribe') return realMint(tx, args);
      const [charge] = await db
        .select({ amountCents: charges.amountCents, pi: charges.stripePaymentIntentId })
        .from(charges)
        .where(eq(charges.id, args.chargeId));
      const key = args.stripeIdempotencyKey('ignored');
      const row = await refundsRepository.createPending(tx, {
        ownerId: args.ownerId,
        chargeId: args.chargeId,
        bookingId: null,
        amountCents: charge!.amountCents,
        reason: args.reason ?? null,
        stripeIdempotencyKey: key,
      });
      return {
        kind: 'minted',
        refundId: row.id,
        amountCents: charge!.amountCents,
        stripeIdempotencyKey: key,
        paymentIntentId: charge!.pi as string,
      };
    };
    try {
      const out = await lostRaceOverExistingRefund({ chargeCents: 9_900, adoptedCents: 4_000 });
      assert.equal(out.statusCode, 201, out.body);
      assert.equal(
        await nonFailedFor(out.chargeId),
        13_900,
        'the mutation must reproduce the executed over-mint, or this proves nothing',
      );
    } finally {
      refundsRepository.mintCappedPendingRefund = realMint;
    }
    assert.equal(
      refundsRepository.mintCappedPendingRefund,
      realMint,
      'the real capped helper is restored',
    );
    await cleanup();
  },
);
