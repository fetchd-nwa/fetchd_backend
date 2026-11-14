import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * **The recording corrects the fake before the fake is trusted** (P22 brief, B-1 and the
 * Rules: "replay the recording through the fake and diff it first").
 *
 * `test/fixtures/stripe-refunds.json` is what Stripe test mode answered on 13 Nov 2026
 * (`npm run probe:stripe -- --refunds --record`, DECISIONS 300). Every fact below is read
 * from it, then produced again by driving the same sequence through `_stripeStub.ts`, and
 * the two are compared whole. A stub that answers differently from the recording is a
 * fake that lies; this file is red until it does not.
 *
 * Facts compared, by the recording's case letter: (a) a refund's reply status and the
 * replay header on a fresh reply; (d) a same-key re-send is the same refund, marked
 * replayed; (c) a refund above what the charge still holds is HTTP 400
 * `invalid_request_error` with NO `code`, one on a fully refunded charge carries
 * `charge_already_refunded`, and each refusal re-sent under its key replays, marked; (b) a
 * refund Stripe fails after it succeeded reads `failed` on retrieve and list, and the
 * charge's refundable amount comes back; (f) a refund created `pending` succeeds later;
 * (e) `refunds.list` carries `metadata.refund_id` on every refund and is complete.
 */

interface RecordedError {
  sdkErrorClass: string;
  type: string;
  code: string | null;
  statusCode: number;
  message: string;
  headers: { idempotentReplayed: string | null } | null;
}

const recording = JSON.parse(
  readFileSync(new URL('../fixtures/stripe-refunds.json', import.meta.url), 'utf8'),
) as {
  a: { createdStatus: string; refund: { amount: number }; intent: { amount: number }; headers: { idempotentReplayed: string | null } };
  d: { replayedSameObject: boolean; replayStatus: string; headers: { idempotentReplayed: string | null } };
  c: {
    intent: { amount: number };
    firstRefund: { amount: number; status: string };
    overPartial: { requestedCents: number; heldCents: number; first: { refused: RecordedError }; sameKeyAgain: { refused: RecordedError } };
    restRefund: { amount: number; status: string };
    afterFull: { requestedCents: number; first: { refused: RecordedError }; sameKeyAgain: { refused: RecordedError } };
  };
  b: {
    createdStatus: string;
    intent: { amount: number };
    refund: { amount: number };
    retrievedAfter: { status: string; metadata: Record<string, string> };
    chargeAfter: { amountRefunded: number; refunded: boolean };
  };
  f: { createdStatus: string; refund: { amount: number }; retrievedAfter: { status: string } };
  e: {
    complete: Record<string, boolean>;
    a: { status: string; metadata: Record<string, string> }[];
    b: { status: string; metadata: Record<string, string> }[];
    c: { status: string; metadata: Record<string, string> }[];
  };
};

/** Ids differ run to run; the sentence around them is the fact. */
const shape = (message: string): string =>
  message.replace(/\b(ch|pi|re)_[A-Za-z0-9_]+/g, '$1_X');

function errorFact(err: RecordedError): Record<string, unknown> {
  return {
    sdkErrorClass: err.sdkErrorClass,
    type: err.type,
    code: err.code,
    statusCode: err.statusCode,
    replayed: err.headers?.idempotentReplayed === 'true',
    message: shape(err.message),
  };
}

function thrownFact(err: unknown): Record<string, unknown> {
  const e = err as {
    constructor?: { name?: string };
    rawType?: string;
    code?: string;
    statusCode?: number;
    message?: string;
    headers?: Record<string, string>;
  };
  return {
    sdkErrorClass: e.constructor?.name ?? null,
    type: e.rawType ?? null,
    code: e.code ?? null,
    statusCode: e.statusCode ?? null,
    replayed: e.headers?.['idempotent-replayed'] === 'true',
    message: shape(e.message ?? ''),
  };
}

/** Run one stub step; a lever the stub does not have, or an answer it throws, is a fact too. */
async function attempt<T>(fn: () => Promise<T> | T): Promise<T | { missing: string } | { threw: Record<string, unknown> }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TypeError) return { missing: err.message };
    return { threw: thrownFact(err) };
  }
}

const params = (pi: string, amountCents: number, refundId: string) => ({
  paymentIntentId: pi,
  amountCents,
  reason: 'requested_by_customer',
  metadata: { refund_id: refundId },
});

function recordedFacts(): Record<string, unknown> {
  const r = recording;
  return {
    a: {
      createdStatus: r.a.createdStatus,
      freshReplayed: r.a.headers.idempotentReplayed === 'true',
    },
    d: { sameObject: r.d.replayedSameObject, status: r.d.replayStatus, replayed: r.d.headers.idempotentReplayed === 'true' },
    c: {
      first: r.c.firstRefund.status,
      overPartial: errorFact(r.c.overPartial.first.refused),
      overPartialAgain: errorFact(r.c.overPartial.sameKeyAgain.refused),
      rest: r.c.restRefund.status,
      afterFull: errorFact(r.c.afterFull.first.refused),
      afterFullAgain: errorFact(r.c.afterFull.sameKeyAgain.refused),
    },
    b: {
      createdStatus: r.b.createdStatus,
      retrievedAfter: r.b.retrievedAfter.status,
      retrievedCarriesRefundId: typeof r.b.retrievedAfter.metadata.refund_id === 'string',
      listed: r.e.b.map((x) => x.status),
      // `amount_refunded` 0 after the failure: the whole charge can be refunded again.
      refundableAfter: r.b.intent.amount - r.b.chargeAfter.amountRefunded,
    },
    f: { createdStatus: r.f.createdStatus, retrievedAfter: r.f.retrievedAfter.status },
    e: {
      everyRefundCarriesRefundId: [...r.e.a, ...r.e.b, ...r.e.c].every(
        (x) => typeof x.metadata.refund_id === 'string',
      ),
      complete: Object.values(r.e.complete).every(Boolean),
      cListed: r.e.c.map((x) => x.status),
    },
  };
}

async function stubFacts(stub: StripeStub): Promise<Record<string, unknown>> {
  const r = recording;
  const anyStub = stub as unknown as Record<string, (...args: unknown[]) => unknown>;

  // (a) and (d): a pm_card_visa refund, then the same key and params again.
  const piA = `pi_rec_a_${randomUUID().slice(0, 8)}`;
  stub.setRefundableBalance(piA, r.a.intent.amount);
  stub.setRefundReplyStatus(r.a.createdStatus as 'succeeded');
  const keyA = `rec-a-${randomUUID()}`;
  const idA = randomUUID();
  const freshA = await attempt(() => stub.createRefund(params(piA, r.a.refund.amount, idA) as never, keyA));
  const againA = await attempt(() => stub.createRefund(params(piA, r.a.refund.amount, idA) as never, keyA));
  const fa = freshA as { id?: string; status?: string; replayed?: boolean };
  const ga = againA as { id?: string; status?: string; replayed?: boolean };

  // (c): 2000 of 4500, then 3000 (more than the 2500 held), then the rest, then 100.
  const piC = `pi_rec_c_${randomUUID().slice(0, 8)}`;
  stub.setRefundableBalance(piC, r.c.intent.amount);
  const c1 = (await attempt(() =>
    stub.createRefund(params(piC, r.c.firstRefund.amount, randomUUID()) as never, `rec-c1-${randomUUID()}`),
  )) as { status?: string };
  const overKey = `rec-c-over-${randomUUID()}`;
  const overId = randomUUID();
  const over1 = await attempt(() => stub.createRefund(params(piC, r.c.overPartial.requestedCents, overId) as never, overKey));
  const over2 = await attempt(() => stub.createRefund(params(piC, r.c.overPartial.requestedCents, overId) as never, overKey));
  const rest = (await attempt(() =>
    stub.createRefund(params(piC, r.c.restRefund.amount, randomUUID()) as never, `rec-c2-${randomUUID()}`),
  )) as { status?: string };
  const fullKey = `rec-c-full-${randomUUID()}`;
  const fullId = randomUUID();
  const full1 = await attempt(() => stub.createRefund(params(piC, r.c.afterFull.requestedCents, fullId) as never, fullKey));
  const full2 = await attempt(() => stub.createRefund(params(piC, r.c.afterFull.requestedCents, fullId) as never, fullKey));
  const listC = (await attempt(() => anyStub.listRefundsForPaymentIntent!(piC))) as {
    refunds?: { status: string; metadataRefundId?: string }[];
    complete?: boolean;
  };

  // (b): the refund-failure card: succeeded at create, failed later.
  const piB = `pi_rec_b_${randomUUID().slice(0, 8)}`;
  stub.setRefundableBalance(piB, r.b.intent.amount);
  stub.setRefundReplyStatus(r.b.createdStatus as 'succeeded');
  const idB = randomUUID();
  const createdB = (await attempt(() =>
    stub.createRefund(params(piB, r.b.refund.amount, idB) as never, `rec-b-${randomUUID()}`),
  )) as { id?: string; status?: string };
  await attempt(() => anyStub.setRefundState!(createdB.id, 'failed'));
  const retrievedB = (await attempt(() => anyStub.retrieveRefund!(createdB.id))) as {
    status?: string;
    metadataRefundId?: string;
  };
  const listB = (await attempt(() => anyStub.listRefundsForPaymentIntent!(piB))) as {
    refunds?: { status: string; metadataRefundId?: string }[];
    complete?: boolean;
  };
  // What the charge can still have refunded: the most a fresh refund executes for.
  let refundableAfter = 0;
  for (const cents of [r.b.intent.amount, r.b.intent.amount - 1, 0]) {
    if (cents === 0) break;
    const tried = (await attempt(() =>
      stub.createRefund(params(piB, cents, randomUUID()) as never, `rec-b-probe-${randomUUID()}`),
    )) as { id?: string };
    if (typeof tried.id === 'string') {
      refundableAfter = cents;
      break;
    }
  }

  // (f): the asynchronous-success card: pending at create, succeeded later.
  const piF = `pi_rec_f_${randomUUID().slice(0, 8)}`;
  stub.setRefundableBalance(piF, r.f.refund.amount);
  stub.setRefundReplyStatus(r.f.createdStatus as 'pending');
  const createdF = (await attempt(() =>
    stub.createRefund(params(piF, r.f.refund.amount, randomUUID()) as never, `rec-f-${randomUUID()}`),
  )) as { id?: string; status?: string };
  await attempt(() => anyStub.setRefundState!(createdF.id, 'succeeded'));
  const retrievedF = (await attempt(() => anyStub.retrieveRefund!(createdF.id))) as { status?: string };

  const fact = (x: unknown) =>
    typeof x === 'object' && x !== null && 'threw' in x ? (x as { threw: unknown }).threw : x;
  return {
    a: { createdStatus: fa.status ?? fact(freshA), freshReplayed: fa.replayed === true },
    d: { sameObject: fa.id !== undefined && fa.id === ga.id, status: ga.status ?? fact(againA), replayed: ga.replayed === true },
    c: {
      first: c1.status ?? fact(c1),
      overPartial: fact(over1),
      overPartialAgain: fact(over2),
      rest: rest.status ?? fact(rest),
      afterFull: fact(full1),
      afterFullAgain: fact(full2),
    },
    b: {
      createdStatus: createdB.status ?? fact(createdB),
      retrievedAfter: retrievedB.status ?? fact(retrievedB),
      retrievedCarriesRefundId: retrievedB.metadataRefundId === idB,
      listed: listB.refunds?.map((x) => x.status) ?? fact(listB),
      refundableAfter,
    },
    f: { createdStatus: createdF.status ?? fact(createdF), retrievedAfter: retrievedF.status ?? fact(retrievedF) },
    e: {
      everyRefundCarriesRefundId:
        [...(listB.refunds ?? []), ...(listC.refunds ?? [])].length > 0 &&
        [...(listB.refunds ?? []), ...(listC.refunds ?? [])].every((x) => typeof x.metadataRefundId === 'string'),
      complete: listB.complete === true && listC.complete === true,
      cListed: listC.refunds?.map((x) => x.status) ?? fact(listC),
    },
  };
}

test('the stub answers every refund fact the Stripe recording holds, word for word', async () => {
  const expected = recordedFacts();
  const actual = await stubFacts(makeStripeStub());
  assert.deepEqual(actual, expected);
});
