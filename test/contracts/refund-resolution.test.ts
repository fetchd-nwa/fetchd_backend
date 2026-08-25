import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { charges, refunds } from '../../src/db/schema/schema.js';
import {
  refundsRepository,
  type RefundStatus,
} from '../../src/db/repositories/refundsRepository.js';
import { withActor } from '../../src/db/tx.js';
import type { StripeWebhookEvent } from '../../src/lib/stripe.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { dispatchStripeEvent } from '../../src/webhooks/stripeEventHandlers.js';
import { runDuplicateRefundRetryOnce } from '../../src/workers/duplicateRefundRetry.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * `designs/money-residue.md` §4 — out-of-band refund resolution, backend half.
 *
 * THE DEFECT. Two refund classes were terminal with NO exit, ever.
 *
 *   · `'failed'` — Stripe created the refund and then failed it (a closed card
 *     account, R18/R19). The row shouts on the abandon report FOREVER, unbounded
 *     by age, and — the money half — its amount drops back OUT of the cumulative
 *     cap (`ne('failed')`), so a future automatic leg can re-mint what a human
 *     already returned by hand. Double refund, one forgotten flip away.
 *   · `'unroutable'` — terminal at birth, announced once, and with no way to
 *     record the promise "a human will return this" as KEPT.
 *
 * And the most likely resolution mechanism was itself broken: a staff dashboard
 * refund fires `charge.refund.updated` with a `re_*` we never minted, and the
 * handler's not-found arm threw `WebhookRetryError` → 500 → Stripe redelivered
 * for days while the returned money never reached the ledger or the cap.
 *
 * THE FIX: a new terminal status `'resolved-external'` written by ONE staff-only
 * verb from exactly `'failed'`/`'unroutable'` with a required note, and a
 * conservative webhook ADOPTION arm that records dashboard-issued refunds so the
 * cap closes automatically — independent of whether the human remembers to flip
 * anything.
 *
 * NOTE what is deliberately NOT here: the staff HTTP route. Its wire is DEFINED
 * in the design (§4.6) and built by the portal wave behind the Shanthi gate;
 * interim resolution is ops-mediated SQL that must mirror the verb's WHERE
 * guard, and the verb existing (tested) is what makes the eventual build thin.
 */

registerFixtureHooks();

const WORKER_ACTOR = 'system:scheduler';

function webhookApp(stripe: StripeStub): ReturnType<typeof makeContractApp>['app'] {
  const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerStripeWebhookRoute(app, { stripe });
  return app;
}

async function cleanup(): Promise<void> {
  await db.delete(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

/** A succeeded charge with a PaymentIntent, plus an optional refund row. */
async function seedCharge(opts: {
  amountCents?: number;
  withPaymentIntent?: boolean;
}): Promise<{ chargeId: string; amountCents: number; paymentIntentId: string | null }> {
  const amountCents = opts.amountCents ?? 10_000;
  const chargeId = randomUUID();
  const paymentIntentId =
    opts.withPaymentIntent === false ? null : `pi_test_res_${randomUUID().slice(0, 8)}`;
  await db.insert(charges).values({
    id: chargeId,
    ownerId: FIXTURE_IDS.ownerId,
    amountCents,
    status: 'succeeded',
    purpose: 'payg',
    stripePaymentIntentId: paymentIntentId,
  });
  return { chargeId, amountCents, paymentIntentId };
}

async function seedRefund(opts: {
  chargeId: string;
  amountCents: number;
  status: RefundStatus;
  stripeRefundId?: string | null;
  stripeIdempotencyKey?: string | null;
  reason?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(refunds).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    chargeId: opts.chargeId,
    bookingId: null,
    amountCents: opts.amountCents,
    status: opts.status,
    reason: opts.reason ?? 'cancel',
    stripeRefundId: opts.stripeRefundId ?? null,
    stripeIdempotencyKey: opts.stripeIdempotencyKey ?? null,
  });
  return id;
}

async function readRefund(id: string): Promise<{
  status: string;
  resolutionNote: string | null;
  resolvedByStaffId: string | null;
  resolvedAt: string | null;
  amountCents: number;
  stripeRefundId: string | null;
  stripeIdempotencyKey: string | null;
  reason: string | null;
  updatedAt: string;
}> {
  const [row] = await db
    .select({
      status: refunds.status,
      resolutionNote: refunds.resolutionNote,
      resolvedByStaffId: refunds.resolvedByStaffId,
      resolvedAt: refunds.resolvedAt,
      amountCents: refunds.amountCents,
      stripeRefundId: refunds.stripeRefundId,
      stripeIdempotencyKey: refunds.stripeIdempotencyKey,
      reason: refunds.reason,
      updatedAt: refunds.updatedAt,
    })
    .from(refunds)
    .where(eq(refunds.id, id));
  assert.ok(row, `refund ${id} not found`);
  return row;
}

async function chargeStatus(chargeId: string): Promise<string> {
  const [row] = await db
    .select({ status: charges.status })
    .from(charges)
    .where(eq(charges.id, chargeId));
  assert.ok(row);
  return row.status;
}

const resolve = (id: string, note: string, staffId?: string): Promise<number> =>
  withActor(`staff:${staffId ?? 'interim-ops'}`, (tx) =>
    refundsRepository.markResolvedExternal(tx, {
      id,
      note,
      ...(staffId !== undefined ? { staffId } : {}),
    }),
  );

const nonFailedSum = (chargeId: string): Promise<number> =>
  withActor(WORKER_ACTOR, (tx) => refundsRepository.sumNonFailedForCharge(tx, chargeId));

const mintProbe = (chargeId: string): ReturnType<typeof refundsRepository.mintCappedPendingRefund> =>
  withActor(WORKER_ACTOR, (tx) =>
    refundsRepository.mintCappedPendingRefund(tx, {
      chargeId,
      ownerId: FIXTURE_IDS.ownerId,
      bookingId: null,
      reason: 'cancel',
      stripeIdempotencyKey: () => `probe-${randomUUID()}`,
    }),
  );

function refundEvent(opts: {
  refundId: string;
  paymentIntentId: string | null;
  amountCents: number;
  status: 'succeeded' | 'failed';
}): StripeWebhookEvent {
  return {
    id: `evt_test_${randomUUID().slice(0, 8)}`,
    type: 'charge.refund.updated',
    refundId: opts.refundId,
    paymentIntentId: opts.paymentIntentId,
    amountCents: opts.amountCents,
    status: opts.status,
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

// ── 1. the verb ───────────────────────────────────────────────────────────

test(
  '1.3 verb — a stripe-failed refund resolves to `resolved-external` with the human`s evidence stored',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, amountCents } = await seedCharge({});
    const refundId = await seedRefund({
      chargeId,
      amountCents,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
      stripeIdempotencyKey: `k-${randomUUID()}`,
    });
    const before = await readRefund(refundId);

    const count = await resolve(refundId, 'dashboard re_1abc, 2026-08-24');
    assert.equal(count, 1, 'RED before 1.3: the enum value and the verb do not exist');

    const after = await readRefund(refundId);
    assert.equal(after.status, 'resolved-external');
    assert.equal(after.resolutionNote, 'dashboard re_1abc, 2026-08-24');
    assert.ok(after.updatedAt > before.updatedAt, '`updated_at` advanced — WHEN, without a column');
    assert.equal(after.amountCents, amountCents, 'information-preserving');
    assert.equal(after.stripeRefundId, before.stripeRefundId, 'the failed identity is not erased');

    await cleanup();
  },
);

// ── 2. the guards ─────────────────────────────────────────────────────────

test(
  '1.3 guards — only `failed` and `unroutable` may resolve, and only with a note',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId } = await seedCharge({ amountCents: 12_000 });
    const pending = await seedRefund({ chargeId, amountCents: 3_000, status: 'pending' });
    const succeeded = await seedRefund({
      chargeId,
      amountCents: 3_000,
      status: 'succeeded',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });

    assert.equal(await resolve(pending, 'nope'), 0, 'a pending refund is still in flight');
    assert.equal(await readRefund(pending).then((r) => r.status), 'pending', 'untouched');
    assert.equal(await resolve(succeeded, 'nope'), 0, 'succeeded money already returned OUR way');
    assert.equal(await readRefund(succeeded).then((r) => r.status), 'succeeded', 'untouched');

    // An `'unroutable'` row on its OWN charge — the same charge above carries a
    // `'pending'` refund, and MR-A1.2(iii)(a) refuses to resolve anything while
    // an automatic refund is in flight (pinned separately in
    // `refund-cap-serialization.test.ts` §MR-A1.2b).
    const clean = await seedCharge({ amountCents: 3_000 });
    const unroutable = await seedRefund({
      chargeId: clean.chargeId,
      amountCents: 3_000,
      status: 'unroutable',
    });
    assert.equal(await resolve(unroutable, 'check #1042'), 1, 'unroutable IS resolvable');
    assert.equal(await readRefund(unroutable).then((r) => r.status), 'resolved-external');

    // A resolution with no evidence is not a resolution.
    const another = await seedCharge({ amountCents: 3_000 });
    const second = await seedRefund({
      chargeId: another.chargeId,
      amountCents: 3_000,
      status: 'unroutable',
    });
    await assert.rejects(
      () => resolve(second, '   '),
      /note/i,
      'the note is the attestation — an empty one is refused at the verb',
    );
    assert.equal(await readRefund(second).then((r) => r.status), 'unroutable');

    // And a resolved row cannot be resolved twice — the guard re-asserts at
    // write time, exactly like `markUnroutable`'s.
    assert.equal(await resolve(unroutable, 'again'), 0);

    await cleanup();
  },
);

// ── 3. the cap closes ─────────────────────────────────────────────────────

test(
  '1.3 cap — a resolved row BLOCKS further mints; before the resolve the same charge still mints',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // Two identically-staged charges. The twin is the mutation-landed proof
    // that the door really is open before the resolve — asserting only "closed
    // after" would pass just as well if the door had never been open.
    const subject = await seedCharge({ amountCents: 10_000 });
    const twin = await seedCharge({ amountCents: 10_000 });
    const failedOnSubject = await seedRefund({
      chargeId: subject.chargeId,
      amountCents: 10_000,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });
    await seedRefund({
      chargeId: twin.chargeId,
      amountCents: 10_000,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });

    assert.equal(await nonFailedSum(subject.chargeId), 0, 'a failed refund drops out of the cap');
    const openDoor = await mintProbe(twin.chargeId);
    assert.equal(openDoor.kind, 'minted', 'the remainder really is reopened by a failed refund');

    assert.equal(await resolve(failedOnSubject, 'dashboard re_9zzz'), 1);
    assert.equal(
      await nonFailedSum(subject.chargeId),
      10_000,
      '`resolved-external` counts in `ne(failed)` — returned money blocks future mints',
    );
    const closedDoor = await mintProbe(subject.chargeId);
    assert.equal(
      closedDoor.kind,
      'nothing-to-refund',
      'no automatic leg can re-mint money a human has already returned',
    );

    await cleanup();
  },
);

// ── 4. the ledger finishes the story ──────────────────────────────────────

test(
  '1.3 ledger — a resolve that COVERS the charge flips it `refunded`; a partial one does not',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const partialCharge = await seedCharge({ amountCents: 10_000 });
    const partial = await seedRefund({
      chargeId: partialCharge.chargeId,
      amountCents: 4_000,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });
    assert.equal(await resolve(partial, 'part of it, by check'), 1);
    assert.equal(
      await chargeStatus(partialCharge.chargeId),
      'succeeded',
      'a partial return leaves the charge paid — the owner ledger stays true',
    );

    const fullCharge = await seedCharge({ amountCents: 10_000 });
    const full = await seedRefund({
      chargeId: fullCharge.chargeId,
      amountCents: 10_000,
      status: 'unroutable',
    });
    assert.equal(await resolve(full, 'cash, receipt in the drawer'), 1);
    assert.equal(
      await chargeStatus(fullCharge.chargeId),
      'refunded',
      'the out-of-band mirror of the webhook`s cumulative rule',
    );

    await cleanup();
  },
);

// ── 5. the report gets its exit ───────────────────────────────────────────

test(
  '1.3 report — resolving a stripe-failed row drops it off the abandon page AND out of the count',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, amountCents } = await seedCharge({});
    const refundId = await seedRefund({
      chargeId,
      amountCents,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });

    const before = await refundsRepository.findAbandonedPending(db, {
      mintedBefore: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.equal(before.totalByClass['stripe-failed'], 1);
    assert.ok(before.rows.some((r) => r.id === refundId), 'on the page today, forever');

    assert.equal(await resolve(refundId, 'returned by check #1042'), 1);

    const after = await refundsRepository.findAbandonedPending(db, {
      mintedBefore: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.equal(
      after.totalByClass['stripe-failed'],
      0,
      'the alarm can finally CLEAR — that is the whole point of an exit state',
    );
    assert.equal(after.rows.filter((r) => r.id === refundId).length, 0);

    await cleanup();
  },
);

// ── 6. the webhook guard ──────────────────────────────────────────────────

test(
  '1.3 webhook guard — a stale terminal event never overwrites a human`s attestation',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, amountCents, paymentIntentId } = await seedCharge({});
    const stripeRefundId = `re_test_${randomUUID().slice(0, 8)}`;
    const refundId = await seedRefund({
      chargeId,
      amountCents,
      status: 'failed',
      stripeRefundId,
    });
    assert.equal(await resolve(refundId, 'dashboard re_1abc'), 1);

    const stripe = makeStripeStub();
    const result = await postEvent(
      webhookApp(stripe),
      stripe,
      refundEvent({ refundId: stripeRefundId, paymentIntentId, amountCents, status: 'failed' }),
    );
    assert.equal(result.statusCode, 200, 'a stale delivery is not an error');
    const row = await readRefund(refundId);
    assert.equal(row.status, 'resolved-external', 'RED before 1.3: flipped back to `failed`');
    assert.equal(row.resolutionNote, 'dashboard re_1abc');

    await cleanup();
  },
);

// ── 7. the adoption arm ───────────────────────────────────────────────────

test(
  '1.3 adoption — a dashboard refund we never minted becomes a row, and closes the cap automatically',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, amountCents, paymentIntentId } = await seedCharge({ amountCents: 8_000 });
    const dashboardRefundId = `re_test_dash_${randomUUID().slice(0, 8)}`;

    const stripe = makeStripeStub();
    const result = await postEvent(
      webhookApp(stripe),
      stripe,
      refundEvent({
        refundId: dashboardRefundId,
        paymentIntentId,
        amountCents,
        status: 'succeeded',
      }),
    );
    assert.equal(result.statusCode, 200, 'RED before 1.3: WebhookRetryError → 500 for days');
    assert.equal(result.outcome, 'adopted-out-of-band-refund');

    const rows = await db.select().from(refunds).where(eq(refunds.chargeId, chargeId));
    assert.equal(rows.length, 1, 'the staff`s refund is now a record');
    assert.equal(rows[0]!.status, 'succeeded');
    assert.equal(rows[0]!.amountCents, amountCents);
    assert.equal(rows[0]!.stripeRefundId, dashboardRefundId, 'matched by id from here on');
    assert.equal(rows[0]!.reason, 'out-of-band');
    assert.equal(
      rows[0]!.stripeIdempotencyKey,
      null,
      'nothing will ever fire it — the refund already exists AT Stripe',
    );
    assert.equal(
      await chargeStatus(chargeId),
      'refunded',
      'the existing cumulative flip tail runs, so the owner ledger tells the finished story',
    );
    assert.equal(
      (await mintProbe(chargeId)).kind,
      'nothing-to-refund',
      'the cap closed WITHOUT anybody remembering to flip anything',
    );

    await cleanup();
  },
);

// ── 8. the adoption refusals (keep-pins) ──────────────────────────────────

test(
  '1.3 adoption refusals — never adopt over an in-flight refund, or onto an unknown charge',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, amountCents, paymentIntentId } = await seedCharge({ amountCents: 8_000 });
    // A pending refund of a DIFFERENT amount is still in flight on this charge.
    await seedRefund({
      chargeId,
      amountCents: 2_000,
      status: 'pending',
      stripeIdempotencyKey: `k-${randomUUID()}`,
    });

    const stripe = makeStripeStub();
    const app = webhookApp(stripe);
    const blocked = await postEvent(
      app,
      stripe,
      refundEvent({
        refundId: `re_test_dash_${randomUUID().slice(0, 8)}`,
        paymentIntentId,
        amountCents,
        status: 'succeeded',
      }),
    );
    assert.equal(blocked.statusCode, 500, 'conservative: retry, never double-record one movement');
    assert.equal(
      (await db.select().from(refunds).where(eq(refunds.chargeId, chargeId))).length,
      1,
      'no row was adopted over the in-flight one',
    );

    // No charge behind the PaymentIntent at all → unchanged retry behavior (an
    // unknown PI may be an orphan-arm insert racing this delivery).
    const unknown = await postEvent(
      app,
      stripe,
      refundEvent({
        refundId: `re_test_dash_${randomUUID().slice(0, 8)}`,
        paymentIntentId: `pi_test_nobody_${randomUUID().slice(0, 8)}`,
        amountCents: 500,
        status: 'succeeded',
      }),
    );
    assert.equal(unknown.statusCode, 500);

    // A FAILED dashboard refund adopts honestly and joins the report class: a
    // human tried, Stripe failed it again, the owner is still owed.
    await cleanup();
    const second = await seedCharge({ amountCents: 6_000 });
    const failedResult = await postEvent(
      app,
      stripe,
      refundEvent({
        refundId: `re_test_dash_${randomUUID().slice(0, 8)}`,
        paymentIntentId: second.paymentIntentId,
        amountCents: 6_000,
        status: 'failed',
      }),
    );
    assert.equal(failedResult.outcome, 'adopted-out-of-band-refund');
    const adopted = await db.select().from(refunds).where(eq(refunds.chargeId, second.chargeId));
    assert.equal(adopted[0]!.status, 'failed');
    assert.equal(await chargeStatus(second.chargeId), 'succeeded', 'no flip on a failed refund');
    const report = await refundsRepository.findAbandonedPending(db, {
      mintedBefore: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.equal(report.totalByClass['stripe-failed'], 1, 'still owed, and still shouted about');

    await cleanup();
  },
);

// ── 9. sweep / flip indifference (keep-pins) ──────────────────────────────

test(
  '1.3 indifference — resolved and adopted rows are claimed by no sweep and flipped by no batch',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const routable = await seedCharge({ amountCents: 7_000 });
    const seed = await seedCharge({ amountCents: 5_000, withPaymentIntent: false });

    const resolvedRow = await seedRefund({
      chargeId: routable.chargeId,
      amountCents: 7_000,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });
    assert.equal(await resolve(resolvedRow, 'returned in cash'), 1);

    // A `resolved-external` row on a NULL-PI charge is the shape `markUnroutable`
    // would flip if it read status carelessly.
    const resolvedSeedRow = await seedRefund({
      chargeId: seed.chargeId,
      amountCents: 5_000,
      status: 'unroutable',
    });
    assert.equal(await resolve(resolvedSeedRow, 'store credit, agreed with the owner'), 1);

    // Old enough for every window, so "not claimed" cannot be an age artifact.
    await db
      .update(refunds)
      .set({ createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString() })
      .where(eq(refunds.chargeId, routable.chargeId));

    const sweeper = makeStripeStub();
    const tick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.equal(tick.scanned, 0, 'the claim reads `status=pending`');
    assert.equal(sweeper.calls.filter((c) => c.method === 'createRefund').length, 0);
    assert.equal(tick.abandonedByClass['stripe-failed'], 0);

    const flipped = await withActor(WORKER_ACTOR, (tx) => refundsRepository.markUnroutable(tx));
    assert.equal(
      flipped.filter((r) => r.id === resolvedSeedRow).length,
      0,
      'a human`s attestation is never overwritten by a batch',
    );
    assert.equal(await readRefund(resolvedSeedRow).then((r) => r.status), 'resolved-external');

    // And an adopted row is equally inert.
    const adoptedCharge = await seedCharge({ amountCents: 3_000 });
    const stripe = makeStripeStub();
    await postEvent(
      webhookApp(stripe),
      stripe,
      refundEvent({
        refundId: `re_test_dash_${randomUUID().slice(0, 8)}`,
        paymentIntentId: adoptedCharge.paymentIntentId,
        amountCents: 3_000,
        status: 'succeeded',
      }),
    );
    await db
      .update(refunds)
      .set({ createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString() })
      .where(eq(refunds.chargeId, adoptedCharge.chargeId));
    const secondTick = await runDuplicateRefundRetryOnce({
      stripe: sweeper,
      now: new Date(Date.now() + 20 * 60 * 1000),
    });
    assert.equal(secondTick.scanned, 0, 'an adopted row is terminal and carries no key to re-fire');
    assert.equal(sweeper.calls.filter((c) => c.method === 'createRefund').length, 0);

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A1.1 — attribution. §4.8.5 is REVERSED.
//
// The design rested on "the audit log + `updated_at` already carry WHO and
// WHEN". The same schema file excludes `refunds` from the audit trigger BY
// NAME, and the Opus lane executed it: `markResolvedExternal` under `withActor`
// writes ZERO `audit_log` rows. §4.7 calls a wrong resolution "the one
// dangerous verb"; the absent mitigation was the one that identifies the
// attester. Two nullable columns now carry it.
// ──────────────────────────────────────────────────────────────────────────

test(
  'MR-A1.1 — resolving stamps WHO and WHEN on the row itself',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, amountCents } = await seedCharge({});
    const refundId = await seedRefund({
      chargeId,
      amountCents,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });

    const before = new Date(Date.now() - 1000);
    assert.equal(
      await resolve(refundId, 'dashboard re_1abc', FIXTURE_IDS.staffDonavanId),
      1,
    );

    const row = await readRefund(refundId);
    assert.equal(
      row.resolvedByStaffId,
      FIXTURE_IDS.staffDonavanId,
      'RED before MR-A1.1: the column does not exist and NOTHING anywhere records WHO',
    );
    assert.ok(row.resolvedAt, 'and WHEN is a first-class fact, not a touch column');
    assert.ok(
      new Date(row.resolvedAt!).getTime() >= before.getTime(),
      '`resolved_at` is stamped at the resolution, not inherited',
    );
    assert.equal(row.resolutionNote, 'dashboard re_1abc');

    await cleanup();
  },
);

test(
  'MR-A1.1 — the interim-ops arc (no staff principal yet) leaves the FK NULL but still stamps WHEN + the note',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, amountCents } = await seedCharge({});
    const refundId = await seedRefund({ chargeId, amountCents, status: 'unroutable' });

    assert.equal(await resolve(refundId, 'check #1042 — mailed by Shanthi 2026-08-24'), 1);
    const row = await readRefund(refundId);
    assert.equal(
      row.resolvedByStaffId,
      null,
      'NULL means "resolved before the portal route existed" — the note names the human by convention',
    );
    assert.ok(row.resolvedAt, 'WHEN is stamped regardless');
    assert.match(row.resolutionNote ?? '', /Shanthi/);

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A1.5 — the alarm nets against RETURNED COVERAGE
// ──────────────────────────────────────────────────────────────────────────

test(
  'MR-A1.5 — adopting a dashboard refund over an existing `failed` row takes that row OUT of the shouting class',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, amountCents, paymentIntentId } = await seedCharge({ amountCents: 10_000 });
    // Our automatic refund was created at Stripe and FAILED (closed card).
    const failedId = await seedRefund({
      chargeId,
      amountCents: 10_000,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });
    const before = await refundsRepository.findAbandonedPending(db, {
      mintedBefore: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.equal(before.totalByClass['stripe-failed'], 1, 'staged: money still owed, loudly');

    // Staff refunded it from the dashboard instead. The moment Stripe confirms,
    // the money is back — and the failed row must stop inviting a SECOND one.
    const stripe = makeStripeStub();
    const result = await postEvent(
      webhookApp(stripe),
      stripe,
      refundEvent({
        refundId: `re_test_dash_${randomUUID().slice(0, 8)}`,
        paymentIntentId,
        amountCents,
        status: 'succeeded',
      }),
    );
    assert.equal(result.outcome, 'adopted-out-of-band-refund');

    const after = await refundsRepository.findAbandonedPending(db, {
      mintedBefore: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.equal(
      after.totalByClass['stripe-failed'],
      0,
      'RED today: still 1 — the report shouts "issue a FRESH refund" over money already returned',
    );
    assert.equal(after.totalByClass.covered, 1, 'it reports under the quiet `covered` class');
    assert.equal(
      after.rows.filter((r) => r.id === failedId && r.refundClass === 'stripe-failed').length,
      0,
      'and it is off the named page',
    );

    await cleanup();
  },
);

test(
  'MR-A1.5 — PARTIAL coverage keeps the row shouting, and the report line names the LIVE remainder',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId } = await seedCharge({ amountCents: 10_000 });
    const failedId = await seedRefund({
      chargeId,
      amountCents: 10_000,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });
    // 4000c came back some other way; 6000c is still owed.
    await seedRefund({
      chargeId,
      amountCents: 4_000,
      status: 'succeeded',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });

    const report = await refundsRepository.findAbandonedPending(db, {
      mintedBefore: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.equal(report.totalByClass['stripe-failed'], 1, 'still owed');
    const row = report.rows.find((r) => r.id === failedId);
    assert.ok(row);
    assert.equal(
      row!.remainingCents,
      6_000,
      'RED today: the row carries no remainder at all, so the human returns 10000c — the row`s figure, not the debt',
    );

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A1.6.3 (Fable F3) — one definition of "covered", all three tails
// ──────────────────────────────────────────────────────────────────────────

test(
  'MR-A1.6.3 — resolve 6000c THEN adopt 4000c on a 10000c charge leaves the charge `refunded`',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, paymentIntentId } = await seedCharge({ amountCents: 10_000 });
    const failedId = await seedRefund({
      chargeId,
      amountCents: 6_000,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });
    assert.equal(await resolve(failedId, 'check #1042'), 1);
    assert.equal(await chargeStatus(chargeId), 'succeeded', 'partial so far');

    const stripe = makeStripeStub();
    const result = await postEvent(
      webhookApp(stripe),
      stripe,
      refundEvent({
        refundId: `re_test_dash_${randomUUID().slice(0, 8)}`,
        paymentIntentId,
        amountCents: 4_000,
        status: 'succeeded',
      }),
    );
    assert.equal(result.outcome, 'adopted-out-of-band-refund');
    assert.equal(
      await chargeStatus(chargeId),
      'refunded',
      'RED today: the adoption tail counts only `succeeded`, so a fully returned charge reads `succeeded` in the owner ledger',
    );

    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A2.4 — the failed→succeeded flip: FLIP AND ALARM, never refuse
//
// `markStatus` in the succeeded branch flips a refund row to the event's mapped
// status with no prior-status guard, and `failed → succeeded` is a
// cap-ENTERING write — under the charge lock since MR-A1.2, but coverage-blind.
// The Opus lane staged 16000c on a 10000c charge.
//
// The ruling is to RECORD, not refuse: the event is signature-verified Stripe
// truth, so if Stripe says the refund succeeded the money LEFT, and recording
// 10000c returned when 16000c left is the exact false ledger this design exists
// to kill. Refusing also protects nothing — the cap is already fully covered by
// the re-mint before the late event arrives. The excess sits with the OWNER, so
// there is nothing to self-correct server-side: **the alarm IS the remedy.**
// ──────────────────────────────────────────────────────────────────────────

test(
  'MR-A2.4 — a late failed→succeeded flip over a fully-covered charge is RECORDED and pages loudly',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, paymentIntentId } = await seedCharge({ amountCents: 10_000 });
    // Our first refund was created at Stripe and FAILED, which reopened the
    // remainder…
    const failedStripeId = `re_test_${randomUUID().slice(0, 8)}`;
    const failedId = await seedRefund({
      chargeId,
      amountCents: 10_000,
      status: 'failed',
      stripeRefundId: failedStripeId,
    });
    // …and the automatic machinery correctly spent that remainder on a re-mint.
    const reMint = await mintProbe(chargeId);
    assert.equal(reMint.kind, 'minted', 'staged: the reopened remainder was re-minted');
    await db
      .update(refunds)
      .set({ status: 'succeeded' })
      .where(
        and(
          eq(refunds.chargeId, chargeId),
          eq(refunds.id, reMint.kind === 'minted' ? reMint.refundId : ''),
        ),
      );

    // Now Stripe re-reports the FIRST refund as succeeded. 20000c has left for a
    // 10000c charge.
    const capture = makeLogCapture();
    const stripe = makeStripeStub();
    const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
    registerStripeWebhookRoute(app, { stripe });
    const result = await postEvent(
      app,
      stripe,
      refundEvent({
        refundId: failedStripeId,
        paymentIntentId,
        amountCents: 10_000,
        status: 'succeeded',
      }),
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.outcome, 'flipped-refund-succeeded');

    const flipped = await readRefund(failedId);
    assert.equal(flipped.status, 'succeeded', 'Stripe truth is RECORDED — a false ledger is worse');

    const alarm = capture.lines.find(
      (line) => line.level === 50 && line.moneyEvent === 'refund-coverage-surplus',
    );
    assert.ok(
      alarm,
      'RED today: 20000c returned on a 10000c charge and NOBODY is told — the alarm IS the remedy here',
    );
    assert.equal(alarm!.chargeId, chargeId);
    assert.equal(alarm!.chargeAmountCents, 10_000);
    assert.equal(alarm!.returnedCents, 20_000);
    assert.equal(alarm!.surplusCents, 10_000, 'the delta a human has to chase');
    assert.ok(Array.isArray(alarm!.refunds), 'the contributing rows are named');

    assert.equal(
      await chargeStatus(chargeId),
      'refunded',
      'the charge still flips — the >= rule anticipated exactly this',
    );
    assert.equal(
      (await mintProbe(chargeId)).kind,
      'nothing-to-refund',
      'and no further automatic mint is possible',
    );

    await cleanup();
  },
);

test(
  'MR-A2.4 — an ordinary succeeded flip that lands EXACTLY on the charge raises no surplus alarm',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, paymentIntentId, amountCents } = await seedCharge({ amountCents: 10_000 });
    const stripeRefundId = `re_test_${randomUUID().slice(0, 8)}`;
    await seedRefund({ chargeId, amountCents, status: 'pending', stripeRefundId });

    const capture = makeLogCapture();
    const stripe = makeStripeStub();
    const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
    registerStripeWebhookRoute(app, { stripe });
    await postEvent(
      app,
      stripe,
      refundEvent({ refundId: stripeRefundId, paymentIntentId, amountCents, status: 'succeeded' }),
    );

    assert.equal(await chargeStatus(chargeId), 'refunded');
    assert.equal(
      capture.lines.filter((l) => l.moneyEvent === 'refund-coverage-surplus').length,
      0,
      'the guard is for SURPLUS, not for the ordinary full refund',
    );
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A3.3 — the ADOPTION tail gets the identical surplus alarm
//
// MR-A2.4's check + ERROR was added to the ordinary flip tail and NOT to the
// adoption tail, so an adopt that pushes returned coverage past the charge was
// SILENT. The Fable lane executed it with no Stripe anomaly at all
// (resolve-then-dashboard-refund): 20000c returned on a 10000c charge, zero
// alarm lines, the resolved row off the abandon report, and the charge reading
// a truthful `'refunded'` — no worklist, no report, no reconciliation would
// ever surface it.
// ──────────────────────────────────────────────────────────────────────────

test(
  'MR-A3.3 — resolve-then-adopt past the charge total raises the SAME surplus ERROR the flip tail raises',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, paymentIntentId } = await seedCharge({ amountCents: 9_900 });
    const failedId = await seedRefund({
      chargeId,
      amountCents: 6_000,
      status: 'failed',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });
    assert.equal(await resolve(failedId, 'returned by check #1042'), 1, 'staged: 6000c attested');

    // Then a staff dashboard refund for the FULL charge is adopted: 15900c has
    // now gone back on a 9900c charge.
    const capture = makeLogCapture();
    const stripe = makeStripeStub();
    const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
    registerStripeWebhookRoute(app, { stripe });
    const result = await postEvent(
      app,
      stripe,
      refundEvent({
        refundId: `re_test_dash_${randomUUID().slice(0, 8)}`,
        paymentIntentId,
        amountCents: 9_900,
        status: 'succeeded',
      }),
    );
    assert.equal(result.outcome, 'adopted-out-of-band-refund');

    const alarm = capture.lines.find(
      (line) => line.level === 50 && line.moneyEvent === 'refund-coverage-surplus',
    );
    assert.ok(
      alarm,
      'RED (probe-adopt-surplus-silent executed): the adoption tail flips the charge and stays SILENT',
    );
    assert.equal(alarm!.chargeId, chargeId);
    assert.equal(alarm!.chargeAmountCents, 9_900);
    assert.equal(alarm!.returnedCents, 15_900);
    assert.equal(alarm!.surplusCents, 6_000, 'the delta a human has to chase');
    // A3.5(b): the narrative must name WHICH rows compose the surplus.
    const rows = alarm!.refunds as { status?: string; amountCents?: number }[];
    assert.equal(rows.length, 2, 'both contributing rows are named');
    assert.deepStrictEqual(
      rows.map((r) => r.status).sort(),
      ['resolved-external', 'succeeded'],
      'each row carries its status, so the ERROR says how the money left',
    );

    assert.equal(await chargeStatus(chargeId), 'refunded');
    await cleanup();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// MR-A3.4 — one movement, one alarm
//
// The early return fired only when `backfillStripeId === undefined`, so a
// delivery entering via the RACE-RECOVERY match skipped it even when the locked
// re-read showed the row already at the target status with its `re_*` already
// backfilled by a concurrent delivery — re-running the flip and the surplus
// check. The Opus lane executed two identical ERRORs for one movement of money.
// ──────────────────────────────────────────────────────────────────────────

test(
  'MR-A3.4 — two race-recovery deliveries for one refund: one flip, one backfill, exactly ONE surplus ERROR',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const { chargeId, paymentIntentId } = await seedCharge({ amountCents: 10_000 });
    // OUR pending row with NO `re_*`: BOTH deliveries match it by
    // (charge, amount, pending, id IS NULL) and both therefore set
    // `backfillStripeId` — which is the only reason the second one skipped the
    // no-op early return.
    await seedRefund({ chargeId, amountCents: 10_000, status: 'pending' });
    // Coverage that already meets the charge, so any re-entry surfaces a
    // surplus — the thing being counted.
    await seedRefund({
      chargeId,
      amountCents: 10_000,
      status: 'succeeded',
      stripeRefundId: `re_test_${randomUUID().slice(0, 8)}`,
    });

    // Hold the charge lock so both deliveries complete their UNLOCKED match
    // before either can take it, then serialize behind it — the executed
    // interleave, not a sequential approximation of it.
    let releaseLock: () => void = () => undefined;
    const released = new Promise<void>((r) => {
      releaseLock = r;
    });
    let lockHeld: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      lockHeld = r;
    });
    const holder = withActor('system:test-hold', async (tx) => {
      await tx.execute(sql`SELECT id FROM charges WHERE id = ${chargeId} FOR UPDATE`);
      lockHeld();
      await released;
    });
    await held;

    const capture = makeLogCapture();
    const log = {
      warn: (obj: Record<string, unknown>, msg?: string) =>
        capture.lines.push({ ...obj, msg, level: 40 }),
      error: (obj: Record<string, unknown>, msg?: string) =>
        capture.lines.push({ ...obj, msg, level: 50 }),
    };
    const stripe = makeStripeStub();
    const deliver = (re: string): Promise<{ outcome: string }> =>
      dispatchStripeEvent(
        refundEvent({
          refundId: re,
          paymentIntentId,
          amountCents: 10_000,
          status: 'succeeded',
        }) as StripeWebhookEvent & { type: 'charge.refund.updated' },
        { stripe, log },
      );

    const first = deliver(`re_test_a_${randomUUID().slice(0, 8)}`);
    await new Promise((r) => setTimeout(r, 40));
    const second = deliver(`re_test_b_${randomUUID().slice(0, 8)}`);
    await new Promise((r) => setTimeout(r, 250));
    releaseLock();
    await holder;
    await Promise.all([first, second]);

    const alarms = capture.lines.filter(
      (line) => line.level === 50 && line.moneyEvent === 'refund-coverage-surplus',
    );
    assert.equal(
      alarms.length,
      1,
      `RED (R4-D executed): ${alarms.length} identical ERRORs for one movement of money — the second delivery IS a no-op`,
    );

    const rows = await db
      .select({ id: refunds.id, status: refunds.status, stripeRefundId: refunds.stripeRefundId })
      .from(refunds)
      .where(eq(refunds.chargeId, chargeId));
    assert.equal(rows.length, 2, 'no delivery may create a row');
    assert.equal(
      rows.filter((r) => r.stripeRefundId !== null).length,
      2,
      'the pending row was backfilled exactly once, by exactly one delivery',
    );
    await cleanup();
  },
);
