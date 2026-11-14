/**
 * The `--refunds` mode of `scripts/probe-stripe-thrown-confirm.ts` (P22 brief B-1;
 * DECISIONS 279(e); design.md:4218-4220). Not a script of its own: the probe's `main()`
 * runs it, after its `sk_test_` gate, as
 *
 *     npm run probe:stripe -- --refunds --record   # run once, write the fixture
 *     npm run probe:stripe -- --refunds            # run again, compare to the fixture
 *     npm run probe:stripe -- --refunds --dry-run  # print the plan; no Stripe call at all
 *
 * In the probe's own shape: it talks to the REAL Stripe API in TEST MODE ONLY, it reports
 * rather than asserts, and `--record` writes `test/fixtures/stripe-refunds.json`, which the
 * suite's Stripe stub replays (P22 B-6 and B-7 model `retrieveRefund`,
 * `listRefundsForPaymentIntent` and the four refund events from it, `metadata` included).
 * Nothing in `npm run gate` calls Stripe: the suite proves conformance to the RECORDING,
 * and only a run of this mode re-verifies the recording.
 *
 * WHAT IS IN QUESTION. P22 builds staff refunds on five things read from Stripe's docs and
 * never run here:
 *
 *   (a) which of `charge.refund.updated`, `refund.created`, `refund.updated`,
 *       `refund.failed` and `charge.refunded` the account generates for a refund, and what
 *       each carries (its object's id and status). B-6 parses all four arms whatever this
 *       says, so enabling one later needs no deploy; this decides which the webhook
 *       endpoint must have enabled (Blocked #4);
 *   (b) the one backwards edge, `succeeded → failed`, as Stripe sends it: Stripe's
 *       asynchronous refund-failure card (4000 0000 0000 5126, `pm_card_refundFail`;
 *       docs.stripe.com/testing, "Simulate an asynchronous refund", read 2026-11-13: "its
 *       status begins as `succeeded`. After a few minutes, its status transitions to
 *       `failed` and sends a `refund.failed` event");
 *   (c) what `refunds.create` answers for more than a partly refunded PaymentIntent still
 *       holds, and for any amount on a fully refunded one: each error's `type`, `code` and
 *       HTTP status (P22 `plan_added` [2]: "Whether real Stripe sends that code is
 *       unproven");
 *   (d) whether the SDK exposes Stripe's replay header (`idempotent-replayed`, the spelling
 *       measured on 2026-08-13 for `paymentIntents.create`; see `REPLAYED_HEADER_NAMES` in
 *       `src/lib/stripe.ts`) on a same-key, same-params `refunds.create`. A stored 5xx
 *       cannot be produced on demand in test mode, so B-7(b) assumes no more than this
 *       records. **One addition beyond the brief's letter, for B-7(b)'s stop condition**
 *       ("if the SDK exposes it on a reply but not on an error, stop and report"): each of
 *       (c)'s two refusals is re-sent once under its own key, so the recording also says
 *       whether a replayed ERROR carries the header. Those re-sends create nothing;
 *   (e) `refunds.list({payment_intent})` for each intent, with each refund's `metadata`:
 *       P22 matches a retrieved refund to its row by `metadata.refund_id` (B-6 step 2) and
 *       looks a lost create up the same way (B-7(b) 2), so whether Stripe echoes it back is
 *       load-bearing;
 *   (f) added at the orchestrator's word after go 1's report: a refund that is `pending` and
 *       later succeeds, as B-7(a)'s look-up meets it (a `pending` row holding a `re_` and no
 *       terminal event). Stripe's asynchronous-success card (4000 0000 0000 7726,
 *       `pm_card_pendingRefund`; docs.stripe.com/testing, "Simulate an asynchronous refund",
 *       read 2026-11-13: "its status begins as `pending`. Some time later, its status
 *       transitions to `succeeded` and sends a `refund.updated` event"). It records the
 *       refund as created, its status every 15 s inside (b)'s wait (one shared wait, not a
 *       second), the refund retrieved at the end, and every event naming it: the five types
 *       above and whatever else `events.list` returns for it, with `previous_attributes`.
 *
 * THE CALL SHAPE. Every create is production's: `refundCreateParams`'
 * (`src/lib/pendingRefund.ts`) `payment_intent`, `amount` and `reason:
 * 'requested_by_customer'`, through `refunds.create` with an idempotency key, plus the
 * `metadata: {refund_id}` that B-7(b) 2 adds to that one constructor from P22 on. It is
 * built here rather than imported, as the older refund questions (P1-P3) build theirs:
 * importing `pendingRefund.ts` would pull the database pool into a Stripe probe. Once
 * B-7(b) 2 lands, this must stay byte-equal to it.
 *
 * WHAT A RUN CREATES IN THE TEST ACCOUNT (nothing in live mode: the probe's gate refuses
 * any key that does not start `sk_test_` before the first call):
 *   - one throwaway customer, deleted at the end (which detaches its three cards);
 *   - three attached cards, `pm_card_visa`, `pm_card_refundFail` and `pm_card_pendingRefund`;
 *   - four PaymentIntents of $45.00 each, confirmed off-session: A and C on the visa, F on
 *     the refund-failure card, P on the asynchronous-success card;
 *   - five refunds: A1 $20.00 on A; C1 $20.00 and C2 $25.00 on C (C is then fully
 *     refunded); F1 $45.00 on F, which Stripe fails a few minutes later; P1 $45.00 on P,
 *     `pending` until Stripe succeeds it. A1 is re-sent once under its own key (a replay, no
 *     new refund);
 *   - four refused creates, which create no refund: $30.00 on C after C1 ($25.00 left),
 *     $1.00 on C after C2, each re-sent once under its own key;
 *   - the events Stripe generates for all of it. No webhook endpoint is needed or touched:
 *     events are read back by `events.list`.
 * In money: $180.00 charged and $110.00 refunded on test cards (once P1 succeeds); F's
 * $45.00 stays charged because its refund fails. It runs for up to about 13 minutes: one
 * wait, read every 15 s and capped at 10 minutes, until F1 reads `failed` and P1 has left
 * `pending`, then up to 2 more for the events to settle.
 *
 * SAFETY. Never prints the key or any part of it. Prints only ids, amounts, statuses,
 * codes and header names. Every client secret and receipt URL is scrubbed from the
 * recording at any depth: a committed fixture is a published file.
 *
 * Exits 0 when it ran and (without `--record`) matched the fixture; non-zero when it could
 * not run, when a refund Stripe should have refused moved money, or when live Stripe has
 * drifted from the recording. A green exit means "we now know", not "everything is fine".
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

export const REFUNDS_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'stripe-refunds.json',
);

/** The five event types B-1 names, in its order. */
export const REFUND_EVENT_TYPES = [
  'charge.refund.updated',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.refunded',
] as const;

const CARD_OK = 'pm_card_visa';
/** 4000 0000 0000 5126: the refund begins `succeeded` and fails a few minutes later. */
const CARD_REFUND_FAILS = 'pm_card_refundFail';
/** 4000 0000 0000 7726: the refund begins `pending` and succeeds some time later. */
const CARD_REFUND_PENDS = 'pm_card_pendingRefund';

/** Which case an event or a list belongs to. */
type Scenario = 'a' | 'b' | 'c' | 'f';
const SCENARIOS: readonly Scenario[] = ['a', 'b', 'c', 'f'];
const FIVE_TYPES: ReadonlySet<string> = new Set<string>(REFUND_EVENT_TYPES);
/** The cap on the one read of every event type since the start, for (f). */
const ALL_TYPES_READ_CAP = 1000;

const CHARGE_CENTS = 4500;
/** (a)'s refund, and (c)'s first: a partial refund, as a staff refund usually is. */
const PARTIAL_CENTS = 2000;
/** (c): what C still holds after its first refund; its second refund takes exactly this. */
const REST_CENTS = CHARGE_CENTS - PARTIAL_CENTS;
/** (c): more than C still holds. */
const OVER_CENTS = 3000;
/** (c): any amount on a fully refunded intent. */
const AFTER_FULL_CENTS = 100;

const FAIL_POLL_MS = 15_000;
const FAIL_WAIT_MAX_MS = 10 * 60_000;
const EVENTS_POLL_MS = 10_000;
const EVENTS_SETTLE_MIN_MS = 30_000;
const EVENTS_WAIT_MAX_MS = 2 * 60_000;
/** Stripe and this machine may disagree about the time: read events from a little before. */
const EVENTS_CLOCK_SLACK_S = 120;

// ── What the recording holds ──────────────────────────────────────────────

/** The response headers the SDK handed back, as far as replay detection reads them. */
export interface HeaderReading {
  /** Every header name, lower-cased and sorted. */
  names: string[];
  /** `idempotent-replayed`, the measured spelling; `null` when absent. */
  idempotentReplayed: string | null;
  /** `idempotency-replayed`, the documented spelling; `null` when absent. */
  idempotencyReplayed: string | null;
  originalRequestPresent: boolean;
  /** On a replay: whether `original-request` names the first response's request id. */
  originalRequestIsFirst: boolean | null;
}

/** One refused create, as the SDK raised it. */
export interface RecordedRefundError {
  /** The SDK's class, e.g. `StripeInvalidRequestError`. */
  sdkErrorClass: string;
  /** `err.rawType`: the wire's `type`, e.g. `invalid_request_error`. */
  type: string | null;
  code: string | null;
  statusCode: number | null;
  message: string | null;
  /** `null` when the error carried no headers. */
  headers: HeaderReading | null;
}

/** A create Stripe should refuse: its answer, and the same request again under its key. */
export interface RefusalCase {
  requestedCents: number;
  /** What the intent still held when it was asked. */
  heldCents: number;
  first: { refused: RecordedRefundError } | { created: unknown };
  sameKeyAgain: { refused: RecordedRefundError } | { created: unknown };
}

export interface RecordedEvent {
  type: string;
  id: string;
  created: number;
  /** `data.object.object`: `refund` or `charge`. */
  objectType: string;
  objectId: string;
  /** A refund's `status`; a charge's `refunded`, `partially-refunded` or `not-refunded`. */
  status: string | null;
  amountRefunded: number | null;
  metadata: Record<string, string> | null;
  previousAttributes: unknown;
  /** `data.object`, scrubbed. */
  object: unknown;
}

export interface IntentSummary {
  id: string;
  amount: number;
  status: string;
  latestCharge: string | null;
}

export interface ListedRefund {
  id: string;
  amount: number;
  status: string | null;
  metadata: Record<string, string> | null;
  /** The refund object as `refunds.list` returned it, scrubbed. */
  raw: unknown;
}

export interface RefundsRecording {
  recordedAt: string;
  stripeSdkVersion: string;
  /** The API version Stripe answered with (`lastResponse.apiVersion`). */
  apiVersion: string | null;
  note: string;
  eventTypesAsked: string[];
  /** A type whose `events.list` Stripe refused (one this API version does not know); the
   *  read of every type, for (f), is `(all types)`. */
  eventListErrors: { type: string; error: RecordedRefundError }[];
  /** The read of every type, for (f), stopped at its cap: (f)'s events may be incomplete. */
  allTypesReadCapped: boolean;
  a: {
    intent: IntentSummary;
    /** The create's reply, scrubbed. */
    refund: unknown;
    createdStatus: string | null;
    headers: HeaderReading;
    events: RecordedEvent[];
  };
  b: {
    intent: IntentSummary;
    refund: unknown;
    createdStatus: string | null;
    /** Each status the retrieve read, when it first read it, from the create. */
    timeline: { afterMs: number; status: string | null; failureReason: string | null }[];
    failedWithinWait: boolean;
    /** The refund retrieved after the wait, scrubbed. */
    retrievedAfter: unknown;
    /** F's charge read after the wait: does a failed refund give the money back to it? */
    chargeAfter: { amountRefunded: number; refunded: boolean } | null;
    events: RecordedEvent[];
  };
  c: {
    intent: IntentSummary;
    firstRefund: unknown;
    overPartial: RefusalCase;
    restRefund: unknown;
    afterFull: RefusalCase;
    events: RecordedEvent[];
  };
  d: {
    replayedSameObject: boolean;
    replayStatus: string | null;
    headers: HeaderReading;
  };
  f: {
    intent: IntentSummary;
    /** The create's reply, scrubbed: expected `pending`. */
    refund: unknown;
    createdStatus: string | null;
    /** Each status the retrieve read, when it first read it, from the create. */
    timeline: { afterMs: number; status: string | null; failureReason: string | null }[];
    /** P1 left `pending` within the shared wait. */
    settledWithinWait: boolean;
    /** The refund retrieved at the end, scrubbed. */
    retrievedAfter: unknown;
    /** Every event naming P1 or P's charge, of ANY type `events.list` returned. */
    events: RecordedEvent[];
  };
  e: {
    a: ListedRefund[];
    b: ListedRefund[];
    c: ListedRefund[];
    /** `has_more` was false on each list: the list is complete. */
    complete: { a: boolean; b: boolean; c: boolean };
  };
}

// ── Scrubbing ─────────────────────────────────────────────────────────────

const SCRUBBED = '<scrubbed by probe --refunds --record>';
/** `<intent id>_secret_<random>`, wherever it sits in a string. */
const CLIENT_SECRET_IN_VALUE = /\b(pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9-]+/g;
/** Never in a response; scrubbed anyway, since a committed file is a published file. */
const API_KEY_IN_VALUE = /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g;
const SCRUBBED_KEYS = new Set(['client_secret', 'receipt_url']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Deep copy with every client secret, key-shaped string and receipt URL replaced. */
export function scrubRefundRecording(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(CLIENT_SECRET_IN_VALUE, SCRUBBED).replace(API_KEY_IN_VALUE, SCRUBBED);
  }
  if (Array.isArray(value)) return value.map(scrubRefundRecording);
  if (!isRecord(value)) return value;
  // `Object.create(null)`: an arbitrary Stripe key such as `__proto__` is copied, never
  // written onto a prototype (the probe's `scrubSecrets` has the same guard).
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(value)) {
    out[k] = SCRUBBED_KEYS.has(k) && typeof v === 'string' ? SCRUBBED : scrubRefundRecording(v);
  }
  return { ...out };
}

// ── Reading what Stripe answered ──────────────────────────────────────────

function readHeaders(
  headers: Record<string, unknown> | undefined,
  firstRequestId?: string,
): HeaderReading | null {
  if (headers === undefined) return null;
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = (name: string): string | null => {
    const v = lower.get(name);
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    return null;
  };
  const original = text('original-request');
  return {
    names: [...lower.keys()].sort(),
    idempotentReplayed: text('idempotent-replayed'),
    idempotencyReplayed: text('idempotency-replayed'),
    originalRequestPresent: original !== null,
    originalRequestIsFirst:
      firstRequestId === undefined || original === null ? null : original === firstRequestId,
  };
}

function responseOf(object: unknown): Stripe.Response<unknown>['lastResponse'] | undefined {
  if (!isRecord(object) || !isRecord(object.lastResponse)) return undefined;
  return object.lastResponse as Stripe.Response<unknown>['lastResponse'];
}

function errorOf(err: unknown): RecordedRefundError {
  const e = isRecord(err) ? err : {};
  return {
    sdkErrorClass: err instanceof Error ? err.constructor.name : typeof err,
    type: typeof e.rawType === 'string' ? e.rawType : null,
    code: typeof e.code === 'string' ? e.code : null,
    statusCode: typeof e.statusCode === 'number' ? e.statusCode : null,
    message: typeof e.message === 'string' ? (scrubRefundRecording(e.message) as string) : null,
    headers: readHeaders(isRecord(e.headers) ? e.headers : undefined),
  };
}

function describeError(e: RecordedRefundError): string {
  return (
    `THREW ${e.sdkErrorClass} type=${e.type ?? '(none)'} code=${e.code ?? '(none)'} ` +
    `http=${e.statusCode ?? '(none)'} idempotent-replayed=${e.headers?.idempotentReplayed ?? '(absent)'}`
  );
}

function summary(intent: Stripe.PaymentIntent): IntentSummary {
  const charge = intent.latest_charge;
  return {
    id: intent.id,
    amount: intent.amount,
    status: intent.status,
    latestCharge: charge === null ? null : typeof charge === 'string' ? charge : charge.id,
  };
}

// ── The calls ─────────────────────────────────────────────────────────────

/** The production refund call shape (see the header), with P22's `metadata.refund_id`. */
function refundParams(paymentIntentId: string, amountCents: number, refundId: string) {
  return {
    payment_intent: paymentIntentId,
    amount: amountCents,
    reason: 'requested_by_customer' as const,
    metadata: { refund_id: refundId },
  } satisfies Stripe.RefundCreateParams;
}

/** A key in the shape production sends: the request's key plus `:refund`. */
function refundKey(): string {
  return `probe-refunds:${randomUUID()}:refund`;
}

async function attach(stripe: Stripe, token: string, customerId: string): Promise<string> {
  const pm = await stripe.paymentMethods.attach(token, { customer: customerId });
  console.log(`  attach ${token}: ok`);
  return pm.id;
}

async function chargeOffSession(
  stripe: Stripe,
  label: string,
  customerId: string,
  paymentMethodId: string,
): Promise<Stripe.PaymentIntent> {
  const intent = await stripe.paymentIntents.create(
    {
      amount: CHARGE_CENTS,
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: true,
      off_session: true,
      metadata: { purpose: 'probe-stripe-refunds' },
    },
    { idempotencyKey: `probe-refunds:${randomUUID()}:charge` },
  );
  console.log(`  ${label}: charged ${intent.id} ${CHARGE_CENTS} cents, status=${intent.status}`);
  if (intent.status !== 'succeeded') {
    throw new Error(`${label}: the charge rested at ${intent.status}; nothing to refund`);
  }
  return intent;
}

async function createRefund(
  stripe: Stripe,
  label: string,
  args: { intentId: string; amountCents: number; key: string; refundId: string },
): Promise<Stripe.Response<Stripe.Refund>> {
  const refund = await stripe.refunds.create(
    refundParams(args.intentId, args.amountCents, args.refundId),
    { idempotencyKey: args.key },
  );
  console.log(
    `  ${label}: refund ${refund.id} ${refund.amount} cents, status=${refund.status ?? '(none)'}`,
  );
  return refund;
}

/** A create Stripe should refuse, then the same request under the same key. */
async function refusal(
  stripe: Stripe,
  label: string,
  args: { intentId: string; amountCents: number; heldCents: number },
): Promise<RefusalCase> {
  const key = refundKey();
  const refundId = randomUUID();
  const attempt = async (which: string): Promise<RefusalCase['first']> => {
    try {
      const created = await stripe.refunds.create(
        refundParams(args.intentId, args.amountCents, refundId),
        { idempotencyKey: key },
      );
      console.log(
        `  ${label} ${which}: *** CREATED ${created.id} status=${created.status ?? '(none)'}: ` +
          'MONEY MOVED that Stripe should have refused ***',
      );
      process.exitCode = 1;
      return { created: scrubRefundRecording(created) };
    } catch (err) {
      const refused = errorOf(err);
      console.log(`  ${label} ${which}: ${describeError(refused)}`);
      return { refused };
    }
  };
  const first = await attempt('first');
  const sameKeyAgain = await attempt('same key again');
  return { requestedCents: args.amountCents, heldCents: args.heldCents, first, sameKeyAgain };
}

type Timeline = RefundsRecording['b']['timeline'];

/** One refund's watch inside the shared wait: each status when first read. */
interface Watched {
  label: string;
  refund: Stripe.Refund;
  timeline: Timeline;
  last: Stripe.Refund;
  /** Whether this refund is still waiting on Stripe. */
  waiting: (r: Stripe.Refund) => boolean;
}

function watch(
  label: string,
  refund: Stripe.Refund,
  waiting: (r: Stripe.Refund) => boolean,
): Watched {
  return {
    label,
    refund,
    timeline: [{ afterMs: 0, status: refund.status, failureReason: refund.failure_reason ?? null }],
    last: refund,
    waiting,
  };
}

/**
 * THE one wait (b) and (f) share: every `FAIL_POLL_MS`, each refund still waiting is
 * retrieved, until none is or `FAIL_WAIT_MAX_MS` has passed. F1 waits until it reads
 * `failed`; P1 until it leaves `pending`.
 */
async function pollShared(stripe: Stripe, watched: Watched[], startedAt: number): Promise<void> {
  console.log(
    `  waiting up to ${FAIL_WAIT_MAX_MS / 60_000} min, reading every ${FAIL_POLL_MS / 1000} s: ` +
      watched.map((w) => `${w.label} ${w.refund.id}`).join(', '),
  );
  while (watched.some((w) => w.waiting(w.last)) && Date.now() - startedAt < FAIL_WAIT_MAX_MS) {
    await new Promise((resolve) => setTimeout(resolve, FAIL_POLL_MS));
    for (const w of watched) {
      if (!w.waiting(w.last)) continue;
      w.last = await stripe.refunds.retrieve(w.refund.id);
      const prior = w.timeline[w.timeline.length - 1];
      if (prior === undefined || prior.status !== w.last.status) {
        const afterMs = Date.now() - startedAt;
        w.timeline.push({
          afterMs,
          status: w.last.status,
          failureReason: w.last.failure_reason ?? null,
        });
        console.log(
          `  ${w.label} ${w.refund.id} reads ${w.last.status ?? '(none)'} after ` +
            `${Math.round(afterMs / 1000)} s` +
            `${w.last.failure_reason ? ` failure_reason=${w.last.failure_reason}` : ''}`,
        );
      }
    }
  }
}

function chargeStatusOf(charge: Record<string, unknown>): string {
  if (charge.refunded === true) return 'refunded';
  return typeof charge.amount_refunded === 'number' && charge.amount_refunded > 0
    ? 'partially-refunded'
    : 'not-refunded';
}

/**
 * Every event naming one of these refunds or intents, read back until two reads agree (and
 * at least `EVENTS_SETTLE_MIN_MS` has passed) or the wait runs out: (a) to (c) keep the
 * five types; (f) keeps every type `events.list` returns for it.
 */
async function collectEvents(
  stripe: Stripe,
  since: number,
  scenarioOf: (object: Record<string, unknown>) => Scenario | undefined,
): Promise<{
  byScenario: Record<Scenario, RecordedEvent[]>;
  listErrors: { type: string; error: RecordedRefundError }[];
  allTypesReadCapped: boolean;
}> {
  const started = Date.now();
  // One list per type, so a type this API version does not know is recorded as that list's
  // refusal instead of stopping the read of the other four; then one read of every type,
  // for (f).
  const listErrors = new Map<string, RecordedRefundError>();
  let allTypesReadCapped = false;
  const keeps = (e: Stripe.Event): boolean => {
    if (!isRecord(e.data.object)) return false;
    const scenario = scenarioOf(e.data.object);
    return scenario !== undefined && (scenario === 'f' || FIVE_TYPES.has(e.type));
  };
  const read = async () => {
    const byId = new Map<string, Stripe.Event>();
    for (const type of REFUND_EVENT_TYPES) {
      try {
        const page = await stripe.events
          .list({ type, created: { gte: since }, limit: 100 })
          .autoPagingToArray({ limit: 1000 });
        for (const e of page) byId.set(e.id, e);
        listErrors.delete(type);
      } catch (err) {
        listErrors.set(type, errorOf(err));
      }
    }
    try {
      const every = await stripe.events
        .list({ created: { gte: since }, limit: 100 })
        .autoPagingToArray({ limit: ALL_TYPES_READ_CAP });
      allTypesReadCapped = every.length >= ALL_TYPES_READ_CAP;
      for (const e of every) byId.set(e.id, e);
      listErrors.delete('(all types)');
    } catch (err) {
      listErrors.set('(all types)', errorOf(err));
    }
    return [...byId.values()].filter(keeps);
  };
  let mine = await read();
  let previous = -1;
  while (Date.now() - started < EVENTS_WAIT_MAX_MS) {
    if (mine.length === previous && Date.now() - started >= EVENTS_SETTLE_MIN_MS) break;
    previous = mine.length;
    await new Promise((resolve) => setTimeout(resolve, EVENTS_POLL_MS));
    mine = await read();
  }
  console.log(
    `  events: ${mine.length} of the five types name this run's objects ` +
      `(read for ${Math.round((Date.now() - started) / 1000)} s)`,
  );
  if (allTypesReadCapped) {
    console.log(
      `  *** the read of every type stopped at ${ALL_TYPES_READ_CAP}: (f)'s events may be incomplete ***`,
    );
  }
  const out: Record<Scenario, RecordedEvent[]> = { a: [], b: [], c: [], f: [] };
  for (const event of [...mine].sort((x, y) => x.created - y.created || x.id.localeCompare(y.id))) {
    const object = event.data.object as unknown as Record<string, unknown>;
    const scenario = scenarioOf(object);
    if (scenario === undefined || (scenario !== 'f' && !FIVE_TYPES.has(event.type))) continue;
    const objectType = typeof object.object === 'string' ? object.object : '(none)';
    const recorded: RecordedEvent = {
      type: event.type,
      id: event.id,
      created: event.created,
      objectType,
      objectId: typeof object.id === 'string' ? object.id : '(none)',
      status:
        objectType === 'charge'
          ? chargeStatusOf(object)
          : typeof object.status === 'string'
            ? object.status
            : null,
      amountRefunded: typeof object.amount_refunded === 'number' ? object.amount_refunded : null,
      metadata: isRecord(object.metadata) ? (object.metadata as Record<string, string>) : null,
      previousAttributes: scrubRefundRecording(event.data.previous_attributes ?? null),
      object: scrubRefundRecording(object),
    };
    out[scenario].push(recorded);
    console.log(
      `  (${scenario}) ${recorded.type} ${recorded.id}: ${recorded.objectType} ` +
        `${recorded.objectId} status=${recorded.status ?? '(none)'}` +
        `${recorded.metadata?.refund_id ? ' metadata.refund_id present' : ''}`,
    );
  }
  for (const [type, error] of listErrors) {
    console.log(`  events.list type=${type}: ${describeError(error)}`);
  }
  return {
    byScenario: out,
    listErrors: [...listErrors].map(([type, error]) => ({ type, error })),
    allTypesReadCapped,
  };
}

async function listRefunds(
  stripe: Stripe,
  label: string,
  intentId: string,
): Promise<{ refunds: ListedRefund[]; complete: boolean }> {
  const page = await stripe.refunds.list({ payment_intent: intentId, limit: 100 });
  const refunds = page.data.map((r) => ({
    id: r.id,
    amount: r.amount,
    status: r.status,
    metadata: isRecord(r.metadata) ? (r.metadata as Record<string, string>) : null,
    raw: scrubRefundRecording(r),
  }));
  console.log(
    `  (e) ${label} refunds.list(${intentId}): ` +
      `${refunds.map((r) => `${r.id} ${r.amount} ${r.status ?? '(none)'} refund_id=${r.metadata?.refund_id ? 'present' : 'ABSENT'}`).join('; ') || '(none)'}` +
      `${page.has_more ? ' (has_more: INCOMPLETE)' : ''}`,
  );
  return { refunds, complete: !page.has_more };
}

// ── Record, or compare ────────────────────────────────────────────────────

function readRefundsFixture(): RefundsRecording | undefined {
  if (!fs.existsSync(REFUNDS_FIXTURE_PATH)) return undefined;
  return JSON.parse(fs.readFileSync(REFUNDS_FIXTURE_PATH, 'utf-8')) as RefundsRecording;
}

function refusalSignature(c: RefusalCase): unknown {
  const side = (s: RefusalCase['first']) =>
    'refused' in s
      ? {
          type: s.refused.type,
          code: s.refused.code,
          http: s.refused.statusCode,
          replayed: s.refused.headers?.idempotentReplayed ?? null,
        }
      : 'CREATED';
  return { first: side(c.first), sameKeyAgain: side(c.sameKeyAgain) };
}

/**
 * The stable slice of a recording: what must not change between runs. Ids, times and
 * customers differ every run and are left out, so the alarm rings for meaning, not noise.
 */
export function refundsSignature(r: RefundsRecording): string {
  const events = (list: RecordedEvent[]) =>
    [...new Set(list.map((e) => `${e.type}:${e.objectType}:${e.status ?? '-'}`))].sort();
  const listed = (list: ListedRefund[]) =>
    list
      .map((x) => `${x.status ?? '-'}:${x.metadata?.refund_id ? 'refund_id' : 'no-refund_id'}`)
      .sort();
  return JSON.stringify({
    eventListErrors: r.eventListErrors.map((x) => `${x.type}:${x.error.code ?? '-'}`).sort(),
    a: {
      created: r.a.createdStatus,
      replayHeaderOnFresh: r.a.headers.idempotentReplayed,
      events: events(r.a.events),
    },
    b: {
      created: r.b.createdStatus,
      statuses: r.b.timeline.map((t) => t.status),
      failedWithinWait: r.b.failedWithinWait,
      chargeAfter: r.b.chargeAfter,
      events: events(r.b.events),
    },
    c: {
      overPartial: refusalSignature(r.c.overPartial),
      afterFull: refusalSignature(r.c.afterFull),
      events: events(r.c.events),
    },
    d: {
      sameObject: r.d.replayedSameObject,
      replayed: r.d.headers.idempotentReplayed,
      originalRequestIsFirst: r.d.headers.originalRequestIsFirst,
    },
    f: {
      created: r.f.createdStatus,
      statuses: r.f.timeline.map((t) => t.status),
      settledWithinWait: r.f.settledWithinWait,
      events: events(r.f.events),
    },
    e: { a: listed(r.e.a), b: listed(r.e.b), c: listed(r.e.c), complete: r.e.complete },
  });
}

// ── The run ───────────────────────────────────────────────────────────────

/** The run itself. The caller has already refused any key that is not `sk_test_`. */
export async function runRefundsProbe(stripe: Stripe, opts: { record: boolean }): Promise<void> {
  const since = Math.floor(Date.now() / 1000) - EVENTS_CLOCK_SLACK_S;
  const committed = readRefundsFixture();
  console.log('probe:stripe --refunds: live Stripe, TEST MODE (P22 B-1)');
  console.log(`  stripe sdk: ${Stripe.PACKAGE_VERSION}`);
  console.log(
    `  fixture:    ${committed === undefined ? 'ABSENT' : `recorded ${committed.recordedAt}`}` +
      `${opts.record ? '  (--record: this run will REWRITE it)' : ''}`,
  );

  const customer = await stripe.customers.create({
    name: 'P22 refund probe',
    metadata: { purpose: 'probe-stripe-refunds', delete_me: 'true' },
  });
  console.log(`  throwaway customer: ${customer.id}`);

  let recording: RefundsRecording | undefined;
  try {
    const visa = await attach(stripe, CARD_OK, customer.id);
    const refundFails = await attach(stripe, CARD_REFUND_FAILS, customer.id);
    const refundPends = await attach(stripe, CARD_REFUND_PENDS, customer.id);

    // (b) first: its failure takes minutes, so (a), (c), (d) run while it waits.
    console.log('── (b) the refund-failure card ──');
    const intentF = await chargeOffSession(stripe, '(b) F', customer.id, refundFails);
    const refundF = await createRefund(stripe, '(b) F1', {
      intentId: intentF.id,
      amountCents: CHARGE_CENTS,
      key: refundKey(),
      refundId: randomUUID(),
    });
    // The shared wait's clock starts at F1's create: (f) and (b) are read inside one wait.
    const waitStartedAt = Date.now();

    console.log('── (f) the asynchronous-success card ──');
    const intentP = await chargeOffSession(stripe, '(f) P', customer.id, refundPends);
    const refundP = await createRefund(stripe, '(f) P1', {
      intentId: intentP.id,
      amountCents: CHARGE_CENTS,
      key: refundKey(),
      refundId: randomUUID(),
    });

    console.log('── (a) a refund on pm_card_visa, and (d) its same-key replay ──');
    const intentA = await chargeOffSession(stripe, '(a) A', customer.id, visa);
    const keyA1 = refundKey();
    const refundIdA1 = randomUUID();
    const refundA = await createRefund(stripe, '(a) A1', {
      intentId: intentA.id,
      amountCents: PARTIAL_CENTS,
      key: keyA1,
      refundId: refundIdA1,
    });
    const freshResponse = responseOf(refundA);
    const freshHeaders = readHeaders(freshResponse?.headers);
    console.log(
      `  (a) A1 fresh reply: idempotent-replayed=${freshHeaders?.idempotentReplayed ?? '(absent)'} ` +
        `original-request=${freshHeaders?.originalRequestPresent ? 'present' : 'absent'}`,
    );
    const replayA = await createRefund(stripe, '(d) A1 again, same key and params', {
      intentId: intentA.id,
      amountCents: PARTIAL_CENTS,
      key: keyA1,
      refundId: refundIdA1,
    });
    const replayHeaders = readHeaders(responseOf(replayA)?.headers, freshResponse?.requestId);
    const sameObject = replayA.id === refundA.id;
    console.log(
      `  (d) replay: ${sameObject ? 'the SAME refund' : `*** A DIFFERENT refund ${replayA.id} ***`} ` +
        `idempotent-replayed=${replayHeaders?.idempotentReplayed ?? '(absent)'} ` +
        `original-request names the first: ${replayHeaders?.originalRequestIsFirst ?? '(n/a)'}`,
    );
    if (!sameObject) process.exitCode = 1;

    console.log('── (c) refunds Stripe should refuse ──');
    const intentC = await chargeOffSession(stripe, '(c) C', customer.id, visa);
    const refundC1 = await createRefund(stripe, '(c) C1', {
      intentId: intentC.id,
      amountCents: PARTIAL_CENTS,
      key: refundKey(),
      refundId: randomUUID(),
    });
    const overPartial = await refusal(stripe, `(c) ${OVER_CENTS} on C holding ${REST_CENTS}`, {
      intentId: intentC.id,
      amountCents: OVER_CENTS,
      heldCents: REST_CENTS,
    });
    const refundC2 = await createRefund(stripe, '(c) C2, the rest', {
      intentId: intentC.id,
      amountCents: REST_CENTS,
      key: refundKey(),
      refundId: randomUUID(),
    });
    const afterFull = await refusal(stripe, `(c) ${AFTER_FULL_CENTS} on C fully refunded`, {
      intentId: intentC.id,
      amountCents: AFTER_FULL_CENTS,
      heldCents: 0,
    });

    console.log('── (b) the backwards edge and (f) the pending refund, one wait ──');
    const watchF = watch('(b) F1', refundF, (r) => r.status !== 'failed');
    const watchP = watch('(f) P1', refundP, (r) => r.status === 'pending');
    await pollShared(stripe, [watchF, watchP], waitStartedAt);
    const failed = watchF.last.status === 'failed';
    if (!failed) {
      console.log(
        `  (b) *** ${refundF.id} did not read failed within the wait ***: recorded as it is`,
      );
    }
    // One read at the end, whatever the wait saw: "the refund retrieved at the end".
    const finalP = await stripe.refunds.retrieve(refundP.id);
    const settled = finalP.status !== 'pending';
    console.log(
      `  (f) P1 at the end: status=${finalP.status ?? '(none)'}` +
        `${settled ? '' : ' *** still pending after the wait ***: recorded as it is'}`,
    );
    const chargeId = summary(intentF).latestCharge;
    const chargeF = chargeId === null ? null : await stripe.charges.retrieve(chargeId);
    if (chargeF !== null) {
      console.log(
        `  (b) F's charge after: amount_refunded=${chargeF.amount_refunded} refunded=${chargeF.refunded}`,
      );
    }

    console.log('── the events the account generated ──');
    const refundScenario = new Map<string, Scenario>([
      [refundA.id, 'a'],
      [refundF.id, 'b'],
      [refundC1.id, 'c'],
      [refundC2.id, 'c'],
      [refundP.id, 'f'],
    ]);
    const intentScenario = new Map<string, Scenario>([
      [intentA.id, 'a'],
      [intentF.id, 'b'],
      [intentC.id, 'c'],
      [intentP.id, 'f'],
    ]);
    const collected = await collectEvents(stripe, since, (object) => {
      if (object.object === 'refund' && typeof object.id === 'string') {
        return refundScenario.get(object.id);
      }
      if (object.object === 'charge' && typeof object.payment_intent === 'string') {
        return intentScenario.get(object.payment_intent);
      }
      return undefined;
    });
    const events = collected.byScenario;
    const fOnly = [...new Set(events.f.map((e) => e.type))].filter((t) => !FIVE_TYPES.has(t));
    console.log(
      `  (f) types beyond the five naming P1 or P's charge: ${fOnly.join(', ') || '(none)'}`,
    );
    for (const type of REFUND_EVENT_TYPES) {
      const seen = SCENARIOS.filter((s) => events[s].some((e) => e.type === type));
      console.log(
        `  ${type}: ${seen.length === 0 ? 'NOT generated' : `generated for (${seen.join(', ')})`}`,
      );
    }

    console.log('── (e) refunds.list per intent ──');
    const listA = await listRefunds(stripe, '(a)', intentA.id);
    const listB = await listRefunds(stripe, '(b)', intentF.id);
    const listC = await listRefunds(stripe, '(c)', intentC.id);

    recording = {
      recordedAt: new Date().toISOString(),
      stripeSdkVersion: Stripe.PACKAGE_VERSION,
      apiVersion: freshResponse?.apiVersion ?? null,
      note:
        'Machine-recorded by `npm run probe:stripe -- --refunds --record` from LIVE Stripe test ' +
        'mode (P22 brief B-1). Never hand-edit: no human chose its contents. Client secrets and ' +
        'receipt URLs are scrubbed at every depth. Re-record with the same command.',
      eventTypesAsked: [...REFUND_EVENT_TYPES],
      eventListErrors: collected.listErrors,
      allTypesReadCapped: collected.allTypesReadCapped,
      a: {
        intent: summary(intentA),
        refund: scrubRefundRecording(refundA),
        createdStatus: refundA.status,
        headers: freshHeaders ?? {
          names: [],
          idempotentReplayed: null,
          idempotencyReplayed: null,
          originalRequestPresent: false,
          originalRequestIsFirst: null,
        },
        events: events.a,
      },
      b: {
        intent: summary(intentF),
        refund: scrubRefundRecording(refundF),
        createdStatus: refundF.status,
        timeline: watchF.timeline,
        failedWithinWait: failed,
        retrievedAfter: scrubRefundRecording(watchF.last),
        chargeAfter:
          chargeF === null
            ? null
            : { amountRefunded: chargeF.amount_refunded, refunded: chargeF.refunded },
        events: events.b,
      },
      c: {
        intent: summary(intentC),
        firstRefund: scrubRefundRecording(refundC1),
        overPartial,
        restRefund: scrubRefundRecording(refundC2),
        afterFull,
        events: events.c,
      },
      d: {
        replayedSameObject: sameObject,
        replayStatus: replayA.status,
        headers: replayHeaders ?? {
          names: [],
          idempotentReplayed: null,
          idempotencyReplayed: null,
          originalRequestPresent: false,
          originalRequestIsFirst: null,
        },
      },
      f: {
        intent: summary(intentP),
        refund: scrubRefundRecording(refundP),
        createdStatus: refundP.status,
        timeline: watchP.timeline,
        settledWithinWait: watchP.last.status !== 'pending',
        retrievedAfter: scrubRefundRecording(finalP),
        events: events.f,
      },
      e: {
        a: listA.refunds,
        b: listB.refunds,
        c: listC.refunds,
        complete: { a: listA.complete, b: listB.complete, c: listC.complete },
      },
    };
  } catch (err) {
    // A step that should not fail did: say which code, never a raw dump.
    const e = errorOf(err);
    console.log(`  *** the run stopped: ${describeError(e)} ${e.message ?? ''} ***`);
    process.exitCode = 1;
  } finally {
    await stripe.customers.del(customer.id).then(
      () => console.log(`  cleaned up customer ${customer.id} (detaches its cards)`),
      (err: unknown) => {
        console.log(`  customer cleanup: ${describeError(errorOf(err))}`);
        process.exitCode = 1;
      },
    );
  }

  if (recording === undefined) {
    console.log('Nothing recorded: the run did not complete. The fixture is untouched.');
    return;
  }
  if (opts.record) {
    fs.mkdirSync(path.dirname(REFUNDS_FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(REFUNDS_FIXTURE_PATH, `${JSON.stringify(recording, null, 2)}\n`, 'utf-8');
    console.log(`--record: wrote ${REFUNDS_FIXTURE_PATH}`);
    return;
  }
  if (committed === undefined) {
    console.log(
      `NO FIXTURE at ${REFUNDS_FIXTURE_PATH}: run \`npm run probe:stripe -- --refunds --record\`.`,
    );
    process.exitCode = 1;
    return;
  }
  const live = refundsSignature(recording);
  const fixed = refundsSignature(committed);
  if (live === fixed) {
    console.log('fixture OK: live Stripe matches the recording.');
    return;
  }
  console.log('DRIFT: live Stripe no longer matches the recording the suite replays.');
  console.log(`  recorded: ${fixed}`);
  console.log(`  live:     ${live}`);
  process.exitCode = 1;
}

// ── --dry-run: the plan, and no call ──────────────────────────────────────

/**
 * `--refunds --dry-run`: prints every call a run would make and checks the scrubber on a
 * synthetic object. It builds no Stripe client and makes no network call. It says what the
 * probe's key gate would do with the configured key, never the key.
 */
export function printRefundsDryRun(args: { keyPassesTestModeGate: boolean }): void {
  console.log('probe:stripe --refunds --dry-run: NO Stripe call is made');
  console.log(
    `  key gate: a run would ${args.keyPassesTestModeGate ? 'PROCEED (the key starts sk_test_)' : 'REFUSE before any call (the key does not start sk_test_)'}`,
  );
  console.log(`  fixture: ${REFUNDS_FIXTURE_PATH} (written only with --record)`);
  const plan = [
    'customers.create (throwaway; deleted at the end, detaching its cards)',
    `paymentMethods.attach ${CARD_OK}, ${CARD_REFUND_FAILS}, ${CARD_REFUND_PENDS}`,
    `(b) paymentIntents.create F ${CHARGE_CENTS} on ${CARD_REFUND_FAILS}, confirm off_session`,
    `(b) refunds.create F1 ${CHARGE_CENTS} {payment_intent, amount, reason: requested_by_customer, metadata: {refund_id}}`,
    `(f) paymentIntents.create P ${CHARGE_CENTS} on ${CARD_REFUND_PENDS}; refunds.create P1 ${CHARGE_CENTS} (expected pending)`,
    `(a) paymentIntents.create A ${CHARGE_CENTS} on ${CARD_OK}; refunds.create A1 ${PARTIAL_CENTS}`,
    '(d) refunds.create A1 again: the same key and params; reads the replay header',
    `(c) paymentIntents.create C ${CHARGE_CENTS}; refunds.create C1 ${PARTIAL_CENTS}`,
    `(c) refunds.create ${OVER_CENTS} on C holding ${REST_CENTS} (expected refused), then the same key again`,
    `(c) refunds.create C2 ${REST_CENTS} (C fully refunded)`,
    `(c) refunds.create ${AFTER_FULL_CENTS} on C (expected refused), then the same key again`,
    `(b)+(f) ONE wait from F1's create: refunds.retrieve every ${FAIL_POLL_MS / 1000} s, up to ${FAIL_WAIT_MAX_MS / 60_000} min, F1 until failed and P1 until not pending; charges.retrieve F's charge; refunds.retrieve P1 once at the end`,
    `events.list once per type (${REFUND_EVENT_TYPES.join(', ')}) and once for every type (cap ${ALL_TYPES_READ_CAP}, for (f)), since start − ${EVENTS_CLOCK_SLACK_S} s, until two reads agree (≥ ${EVENTS_SETTLE_MIN_MS / 1000} s, ≤ ${EVENTS_WAIT_MAX_MS / 1000} s)`,
    '(e) refunds.list({payment_intent}) for A, F and C',
  ];
  for (const [i, step] of plan.entries()) console.log(`  ${i + 1}. ${step}`);

  // The scrubber, on a synthetic object shaped like what a run records.
  const synthetic = {
    id: 're_synthetic',
    receipt_url: 'https://pay.stripe.com/receipts/synthetic',
    nested: [{ client_secret: 'pi_123_secret_abc' }, 'note pi_456_secret_def-0 and sk_test_abc'],
    metadata: { refund_id: '00000000-0000-4000-8000-000000000000' },
  };
  const scrubbed = JSON.stringify(scrubRefundRecording(synthetic));
  const leaked = ['pay.stripe.com', '_secret_', 'sk_test_'].filter((s) => scrubbed.includes(s));
  const kept = scrubbed.includes('re_synthetic') && scrubbed.includes('refund_id');
  console.log(
    `  scrubber: ${leaked.length === 0 && kept ? 'PASS' : `FAIL (leaked ${leaked.join(', ') || 'nothing'}; ids kept ${kept})`} ${scrubbed}`,
  );
  if (leaked.length > 0 || !kept) process.exitCode = 1;
}
