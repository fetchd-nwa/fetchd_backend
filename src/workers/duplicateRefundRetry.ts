import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import {
  refundsRepository,
  rekeyedAt,
  rekeyedRefundKey,
  type AbandonedRefundClass,
  type AbandonedRefundRow,
  type RefundRow,
} from '../db/repositories/refundsRepository.js';
import { withActor } from '../db/tx.js';
import { refundCreateParams, refuseRefundAtCreate } from '../lib/pendingRefund.js';
import { applyLiveRefund, mapStripeRefundStatus, type LiveRefundResult } from '../lib/refundApply.js';
import { duplicateRefundIdempotencyKey } from '../lib/settleInvoiceCharge.js';
import {
  defaultStripeClient,
  isStripeServerError,
  stripeErrorReplayed,
  stripeIdempotencyErrorKind,
  stripeRefundRefusal,
  type StripeClient,
} from '../lib/stripe.js';
import type { WorkerLogger } from './workerLogger.js';

/**
 * Duplicate-refund RETRY sweep (2026-08-12, round 3 of
 * `designs/auto-charge-unknown-outcome.md`). The missing second half of the
 * lost-race refund contract.
 *
 * `settleInvoiceCharge` never calls Stripe (R5), so on a LOST settle race it
 * writes the duplicate charge's refund row `'pending'` in-tx and hands the
 * caller a handle to fire post-commit. Every caller's failure branch said the
 * row was "left for retry" — and nothing retried it. No worker imported
 * `refundsRepository`, no scheduler phase existed, and `charge.refund.updated`
 * cannot arrive for a refund that was never created at Stripe. So one failed
 * `createRefund` — a rate limit, a 500, a lost connection — was a PERMANENT
 * double charge whose only trace was a log line.
 *
 * What this phase does, per tick: claim `pending` refunds with no
 * `stripe_refund_id` that have rested a grace interval, and re-fire
 * `createRefund` **under the same idempotency key the first attempt used**
 * ({@link duplicateRefundIdempotencyKey}, keyed on our own refund-row uuid). If
 * the original call actually reached Stripe and only its response was lost, the
 * key replays that refund; if it never landed, this sends it. Exactly one
 * refund exists for one duplicate charge either way: never mint a new identity
 * for a request whose outcome you don't know.
 *
 * **All three bounds are real and none is silent.** A row stops being retried
 * once it is older than {@link DUPLICATE_REFUND_ABANDON_AFTER_HOURS}, because
 * past Stripe's ~24h key lifetime a same-key retry could execute a SECOND
 * refund instead of replaying the first — and sending an owner someone else's
 * money is not the safe direction either. It is never retried at all if it
 * predates `REFUND_SWEEP_FLOOR`, because before that instant a
 * `duplicate-invoice-settle` row could have been keyed on the client's request
 * key rather than its own uuid, and re-firing one of those is a second full
 * refund. Everything the claim refuses reaches a human instead, through the
 * abandon report below.
 *
 * **The abandon report is a standing condition, and it is reported like one**
 * (round 4, 2026-08-13). It used to ERROR the whole worklist every tick with
 * one sentence — "refund by hand in the Stripe dashboard" — which at a
 * one-minute cadence buries the next real incident under thousands of repeats,
 * and which is not even a followable instruction for two of the three kinds of
 * row it returns. Now: one alarm per class, each true for its class
 * ({@link ABANDONED_CLASS_MESSAGE}), each row named at ERROR the first time
 * this process sees it and counted at INFO after
 * ({@link ALARMED_REFUND_IDS}): loud once, quiet after. They are still owed money that no automatic path will return, and
 * the one thing worse than a failed refund is a quietly failed one; a report
 * nobody can read is the quiet one.
 *
 * No DDL: `status`, `stripe_refund_id`, `created_at` and `updated_at` already
 * carry everything this needs.
 */

const WORKER_ACTOR = 'system:stripe-webhook';

/** How long a written-but-unsent refund rests before the first retry, and
 *  between retries. Short — this is money owed back — but long enough that a
 *  row the post-commit fire is still working on is never claimed under it. */
export const DUPLICATE_REFUND_RETRY_GRACE_MINUTES = 5;

/** Past this age the sweep stops retrying and starts shouting. Sits at Stripe's
 *  documented idempotency-key lifetime for the same reason
 *  `IDEMPOTENCY_KEY_SAFE_WINDOW_HOURS` sits under it: beyond the window a
 *  same-key call is no longer guaranteed to replay. **UNVERIFIED against live
 *  Stripe** — documented and stub-modelled, never measured here. */
export const DUPLICATE_REFUND_ABANDON_AFTER_HOURS = 24;

/**
 * P22 B-7(a): how long a `pending` refund Stripe holds rests between looks, and the
 * re-keyed rows' look-up cadence (B-7(b)). A worker cadence beside
 * {@link DUPLICATE_REFUND_RETRY_GRACE_MINUTES}, not a §3 setting (the brief's call): it
 * moves nothing by itself, it only decides how often Stripe is asked.
 */
export const REFUND_STATUS_POLL_MINUTES = 60;

/**
 * P22 B-7(b): Stripe keeps a key's answer at least this long after the create sent under
 * it, so a row with no refund at Stripe is moved `failed` only once this has passed since
 * its last send. The same 24 hours as {@link DUPLICATE_REFUND_ABANDON_AFTER_HOURS}, for the
 * same reason. **UNVERIFIED against live Stripe**, as that constant is.
 */
export const REFUND_KEY_WINDOW_HOURS = DUPLICATE_REFUND_ABANDON_AFTER_HOURS;

/** P22 B-7(b) 1: a key whose answer is a stored server error, said once per process. */
export const REFUND_KEY_STORED_ERROR_ALARM =
  "refund sweep: Stripe answers this refund's key with a stored server error (marked idempotent-replayed), so re-sending under it can never complete the refund and the sweep sends nothing more under it. The sweep looks the refund up in Stripe by its refund_id metadata; if Stripe holds none it sends it once under a fresh key; if that answers no refund either, the row waits on Stripe's answer in the refund report. Send nothing for it by hand. This line repeats once after each restart";

/** P22 B-7(b) 4: the end state's line. */
export const REFUND_UNSENT_PAST_WINDOW_ALARM =
  "refund sweep: Stripe holds no refund for this row 24 hours after its last send (a complete list of the PaymentIntent's refunds carries none naming it), so it is marked failed: no money went back to the family. Retry to card (POST /staff/refunds/:id/retry) and Returned (POST /staff/refunds/:id/resolve-external) are now open for it, and the payment's other refunds are no longer held behind it";

export interface DuplicateRefundRetryOpts {
  stripe?: StripeClient;
  /** Per-tick batch size. Default 25; tests pin small for determinism. */
  limit?: number;
  /** "Now" for the grace + abandon cutoffs. Tests pin an instant. */
  now?: Date;
  log?: WorkerLogger;
}

export interface DuplicateRefundRetryResult {
  refundId: string;
  outcome: /** Stripe accepted it (or replayed the original) and the `re_*` id is on
     *  the row — the webhook can now match it deterministically. */
    | 'sent'
    /** The retry failed again. The row stays claimable next interval. */
    | 'still-failing'
    /** The refund's charge is missing or carries no PaymentIntent id, so there
     *  is nothing to refund AGAINST. Nothing sent; logged for a human. */
    | 'skipped-unreadable'
    /** P22 B-7(c): Stripe refused the create; the row is `failed`, never re-fired. */
    | 'refused'
    /** P22 B-7(b): the look-up found Stripe's refund by its `metadata.refund_id`. */
    | 'looked-up'
    /** P22 B-7(b): no refund at Stripe yet, and no further send: the row waits on Stripe. */
    | 'awaiting-stripe';
}

export interface DuplicateRefundRetryTickResult {
  scanned: number;
  sent: number;
  /** P22 B-7(a): `pending` refunds Stripe holds, retrieved this tick. */
  polled: number;
  /** P22 B-7(b): rows looked up in Stripe by their `metadata.refund_id`. */
  lookedUp: number;
  /** P22 B-7(c): creates Stripe refused this tick, each row now `failed`. */
  refused: number;
  /** P22 B-7(b): rows moved `failed` because Stripe holds no refund for them past the window. */
  endedFailed: number;
  /** Rows past the retry window — owed money now waiting on a human. The TRUE
   *  count from an unbounded query, not the report page's length. */
  abandoned: number;
  /** True when the capped report page could not hold every abandoned row —
   *  the alarm then names buried classes by count instead of by row. */
  abandonedTruncated: boolean;
  /**
   * The same rows split by what a human can actually DO about each
   * ({@link AbandonedRefundClass}). Surfaced on the result, not only in the
   * log, so the split is assertable without scraping log text.
   */
  abandonedByClass: Record<AbandonedRefundClass, number>;
  results: DuplicateRefundRetryResult[];
}

const NOOP_LOG: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Run one sweep. Claims in a short tx (which also leases), then fires every
 * Stripe call OUTSIDE any transaction (R5).
 */
export async function runDuplicateRefundRetryOnce(
  opts: DuplicateRefundRetryOpts = {},
): Promise<DuplicateRefundRetryTickResult> {
  const stripe = opts.stripe ?? defaultStripeClient;
  const log = opts.log ?? NOOP_LOG;
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - DUPLICATE_REFUND_RETRY_GRACE_MINUTES * 60 * 1000);
  const windowFloor = new Date(
    now.getTime() - DUPLICATE_REFUND_ABANDON_AFTER_HOURS * 60 * 60 * 1000,
  );

  // Retire the rows that were never routable BEFORE anything else looks at the
  // table (design §4). These are pre-Stripe-wire seed-money refunds: the charge
  // behind them carries no PaymentIntent, so no sweep can send them and no
  // webhook can close them, and until now they sat 'pending' forever —
  // saturating an oldest-first report page and re-shouting on every restart.
  // The flip is TERMINAL and it is the memory: a restarted process does not
  // re-announce a row that is already 'unroutable'.
  // Own log-and-continue boundary, like every sibling phase. Unguarded, this
  // was the tick's FIRST statement, so one persistent throw here — a lock
  // timeout, a deadlock against a concurrent writer — took down the retry claim
  // AND both halves of the abandon report with it, via the scheduler's
  // per-phase catch. A cosmetic retirement pass must never be able to silence
  // the money-returning one.
  try {
    const flippedUnroutable = await withActor(WORKER_ACTOR, (tx) =>
      refundsRepository.markUnroutable(tx),
    );
    reportUnroutable(flippedUnroutable, log);
  } catch (err) {
    log.error(
      { workerTick: 'duplicate-refund-retry', phase: 'mark-unroutable', err: errMsg(err) },
      'duplicate refund retry: retiring unroutable refunds threw; the retry and abandon passes below still run',
    );
  }

  const claimed = await withActor(WORKER_ACTOR, (tx) =>
    refundsRepository.claimStalePendingForRetry(tx, {
      staleBefore,
      mintedAfter: windowFloor,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    }),
  );

  const results: DuplicateRefundRetryResult[] = [];
  for (const refund of claimed) {
    // Per-row boundary: one refund's failure is one refund's failure, and this claim already spent
    // its interval.
    try {
      results.push(await retryOne(refund, stripe, log, now));
    } catch (err) {
      log.error(
        { refundId: refund.id, chargeId: refund.chargeId, err: errMsg(err) },
        'duplicate refund retry: working this refund threw; the rest of the batch carries on',
      );
      results.push({ refundId: refund.id, outcome: 'still-failing' });
    }
  }

  // P22 B-7(a), the P15 note's row 15: refunds Stripe holds and no event has finished.
  let polled = 0;
  try {
    polled = await pollPendingWithStripeId(stripe, log, now, opts.limit);
  } catch (err) {
    log.error(
      { workerTick: 'duplicate-refund-retry', phase: 'poll', err: errMsg(err) },
      'refund sweep: the poll of pending refunds Stripe holds threw; the passes below still run',
    );
  }
  // P22 B-7(b): rows the sweep must ask Stripe about by `metadata.refund_id`.
  let lookUp = { lookedUp: 0, endedFailed: 0 };
  try {
    lookUp = await lookUpUnsent(stripe, log, now, opts.limit);
  } catch (err) {
    log.error(
      { workerTick: 'duplicate-refund-retry', phase: 'look-up', err: errMsg(err) },
      'refund sweep: the look-up of unsent refunds threw; the report below still runs',
    );
  }

  const { rows: abandoned, totalByClass } = await refundsRepository.findAbandonedPending(db, {
    mintedBefore: windowFloor,
  });
  const abandonedTotal = ABANDONED_CLASSES.reduce((sum, c) => sum + totalByClass[c], 0);
  // TRUNCATION is a claim about ACTIONABLE rows the page could not show
  // (MR-A2.5(d)5). `covered` rows are excluded from the page BY CONSTRUCTION
  // and need no action, so counting them here raised the flag on a report whose
  // hidden rows were all "nothing to do" — a truncation alarm that is false
  // exactly when it is loudest.
  const shoutingTotal = ABANDONED_CLASSES.filter((c) => !QUIET_CLASSES.has(c)).reduce(
    (sum, c) => sum + totalByClass[c],
    0,
  );
  const abandonedTruncated = shoutingTotal > abandoned.length;
  reportAbandoned(abandoned, totalByClass, log);

  const sent = results.filter((r) => r.outcome === 'sent').length;
  const refused = results.filter((r) => r.outcome === 'refused').length;
  const lookedUp =
    lookUp.lookedUp + results.filter((r) => r.outcome === 'looked-up').length;
  log.info(
    {
      workerTick: 'duplicate-refund-retry',
      batchSize: claimed.length,
      sent,
      polled,
      lookedUp,
      refused,
      endedFailed: lookUp.endedFailed,
      // The TRUE count, not the page length — the page caps at 20 oldest-first
      // and can be saturated by never-sent seed rows, which is exactly when the
      // number must not flatter.
      abandoned: abandonedTotal,
      abandonedTruncated,
    },
    'duplicate refund retry sweep complete',
  );
  return {
    scanned: results.length,
    sent,
    polled,
    lookedUp,
    refused,
    endedFailed: lookUp.endedFailed,
    abandoned: abandonedTotal,
    abandonedByClass: totalByClass,
    abandonedTruncated,
    results,
  };
}

async function retryOne(
  refund: RefundRow,
  stripe: StripeClient,
  log: WorkerLogger,
  now: Date,
): Promise<DuplicateRefundRetryResult> {
  // The refund row names the CHARGE; Stripe refunds against the PaymentIntent.
  const charge = await withActor(WORKER_ACTOR, (tx) =>
    chargesRepository.findById(tx, refund.chargeId),
  );
  if (charge?.stripePaymentIntentId == null) {
    log.error(
      { refundId: refund.id, chargeId: refund.chargeId, amountCents: refund.amountCents },
      'duplicate refund retry: the charge this refund reverses has no PaymentIntent id; cannot retry automatically',
    );
    return { refundId: refund.id, outcome: 'skipped-unreadable' };
  }

  // THE SAME KEY the post-commit fire used. A retry is never a new refund.
  // Stored on the row since 2026-08-19 — which is the only way this can be true
  // for the cancel / withdraw writers, whose keys were the
  // client's request key. The fallback covers rows minted by round-4-era code:
  // `duplicate-invoice-settle` above `REFUND_SWEEP_FLOOR`, whose key IS
  // derivable from the row. The claim admits nothing else, so a row that
  // reaches here with a NULL key is provably a legacy row-keyed one.
  const idempotencyKey = refund.stripeIdempotencyKey ?? duplicateRefundIdempotencyKey(refund.id);

  // P22 B-7(b) 1: this process already knows the key's answer is a stored server error, and
  // the look-up could not settle it then: no re-send under it, only the look-up again.
  if (STORED_ERROR_KEYS.has(idempotencyKey)) {
    return storedServerError(refund, charge.stripePaymentIntentId, idempotencyKey, stripe, log, now);
  }

  let stripeRefundId: string;
  let created: Awaited<ReturnType<StripeClient['createRefund']>>;
  try {
    created = await stripe.createRefund(
      // Built by the SAME constructor the post-commit fire uses. Same key with
      // drifted params is Stripe's `idempotency_error` — no money moves, but
      // the refund never lands either, so the two call sites cannot be allowed
      // to build this object independently.
      refundCreateParams({
        refundId: refund.id,
        paymentIntentId: charge.stripePaymentIntentId,
        amountCents: refund.amountCents,
      }),
      idempotencyKey,
    );
    stripeRefundId = created.id;
  } catch (err) {
    // Not every failure here means the same thing (`stripeIdempotencyErrorKind`).
    // The outcome is `still-failing` in every arm — the row stays claimable and
    // no money moved — but the SENTENCE differs, because one of these is a code
    // defect that will never fix itself and the others resolve on their own.
    const idempotencyKind = stripeIdempotencyErrorKind(err);
    const context = {
      refundId: refund.id,
      chargeId: refund.chargeId,
      paymentIntentId: charge.stripePaymentIntentId,
      amountCents: refund.amountCents,
      stripeIdempotencyKey: idempotencyKey,
      err: errMsg(err),
    };
    if (idempotencyKind === 'params-mismatch') {
      // Design §3 arm 4. Stripe holds this key against DIFFERENT parameters
      // than we just sent, which cannot happen from bad luck: the fire and this
      // retry build their params through one constructor, so this is a code
      // defect or a row rewritten underneath us. No money moved — Stripe
      // refuses the call outright — but retrying will fail identically every
      // interval until the abandon bound, so say so on the first sighting
      // instead of emitting the transient sentence 288 times.
      log.error(
        { ...context, idempotencyKind },
        'duplicate refund retry: Stripe rejected the retry because this key was first used with DIFFERENT parameters — no money moved, and no retry can fix it; the refund params drifted from what the original call sent, which is a code defect to fix, not a transient to wait out',
      );
    } else if (idempotencyKind === 'concurrent-request') {
      // Design §3 arm 3, now covered. The original post-commit call is STILL
      // RUNNING and owns this key; our claim's 5-minute grace simply lost to a
      // slow round-trip. Stripe is the arbiter and no interlock is needed on
      // our side — this is the system working, so it is not an ERROR.
      log.warn(
        { ...context, idempotencyKind },
        'duplicate refund retry: the original refund call is still in flight under this key (Stripe 409) — no second refund was created, and the next tick resolves it',
      );
    } else if (stripeRefundRefusal(err) !== undefined) {
      // P22 B-7(c): Stripe's definitive no (by status and type, never by code or text).
      await refuseRefundAtCreate({
        refundId: refund.id,
        paymentIntentId: charge.stripePaymentIntentId,
        stripeIdempotencyKey: idempotencyKey,
        refusal: stripeRefundRefusal(err)!,
        log,
        context: { workerTick: 'duplicate-refund-retry' },
        actor: WORKER_ACTOR,
      });
      return { refundId: refund.id, outcome: 'refused' };
    } else if (isStripeServerError(err) && stripeErrorReplayed(err) === true) {
      // P22 B-7(b): a 5xx Stripe REPLAYED is that key's permanent answer.
      return storedServerError(refund, charge.stripePaymentIntentId, idempotencyKey, stripe, log, now);
    } else {
      log.error(
        context,
        'duplicate refund retry: re-fire failed; the row stays pending and is retried next interval',
      );
    }
    return { refundId: refund.id, outcome: 'still-failing' };
  }

  // Persist the `re_*` so `charge.refund.updated` matches deterministically —
  // the same closing step the post-commit fire owes, and the thing that takes
  // this row off the worklist.
  await refundsRepository.markStripeId({ id: refund.id, stripeRefundId });
  await applyReply(refund, charge.stripePaymentIntentId, created, log);
  log.info(
    {
      refundId: refund.id,
      chargeId: refund.chargeId,
      stripeRefundId,
      amountCents: refund.amountCents,
    },
    'duplicate refund retry: a duplicate charge that would have stayed double-billed is on its way back',
  );
  return { refundId: refund.id, outcome: 'sent' };
}

/**
 * A create's reply status through the one apply function (P22, design.md:4215-4217), as
 * the post-commit fire does: a `pending` reply waits for the events and the poll.
 */
async function applyReply(
  refund: RefundRow,
  paymentIntentId: string,
  reply: Awaited<ReturnType<StripeClient['createRefund']>>,
  log: WorkerLogger,
): Promise<void> {
  if (mapStripeRefundStatus(reply.status) === undefined) return;
  await withActor(WORKER_ACTOR, (tx) =>
    applyLiveRefund(tx, {
      chargeId: refund.chargeId,
      live: {
        id: reply.id,
        status: reply.status,
        amountCents: reply.amountCents,
        paymentIntentId,
        metadataRefundId: refund.id,
      },
      log,
    }),
  );
}

/**
 * Keys this PROCESS has seen answer a stored server error (P22 B-7(b) 1; `ALARMED_REFUND_IDS`'
 * shape). Nothing is re-sent under one: its row goes to the look-up. Per-process, as that
 * set is, so a restart sends one more replay to learn the answer again (it moves no money:
 * the key replays its stored 500) and says the line once more.
 */
const STORED_ERROR_KEYS = new Set<string>();

/**
 * P22 B-7(b), 145(d), r2 N4: a create whose answer is a 5xx Stripe marks replayed. One
 * line the first time this process sees the key; then **the look-up first**: a refund at
 * Stripe carrying this row's id is this row's, its `re_` stored and its live status
 * applied, and nothing is created. With none, in a COMPLETE list, one create under a fresh
 * key derived from the row, written onto the row in a committed UPDATE before it is sent,
 * with the same params and metadata. A re-keyed row is never sent again: its row waits on
 * Stripe in the report and the hourly look-up ({@link lookUpUnsent}).
 */
async function storedServerError(
  refund: RefundRow,
  paymentIntentId: string,
  key: string,
  stripe: StripeClient,
  log: WorkerLogger,
  now: Date,
): Promise<DuplicateRefundRetryResult> {
  const context = {
    workerTick: 'duplicate-refund-retry',
    refundId: refund.id,
    chargeId: refund.chargeId,
    paymentIntentId,
    amountCents: refund.amountCents,
    stripeIdempotencyKey: key,
  };
  if (!STORED_ERROR_KEYS.has(key)) {
    STORED_ERROR_KEYS.add(key);
    log.error({ ...context, moneyEvent: 'refund-key-stored-error' }, REFUND_KEY_STORED_ERROR_ALARM);
  } else {
    log.info(
      { ...context, storedErrorKeys: STORED_ERROR_KEYS.size },
      'refund sweep: a refund whose key answers a stored server error is looked up again, not re-sent',
    );
  }
  const found = await lookUpByRefundId(refund, paymentIntentId, stripe, log);
  if (found === 'found') return { refundId: refund.id, outcome: 'looked-up' };
  if (found === 'unknown') return { refundId: refund.id, outcome: 'still-failing' };
  if (rekeyedAt(key) !== undefined) return { refundId: refund.id, outcome: 'awaiting-stripe' };

  const fresh = rekeyedRefundKey(refund.id, now);
  const written = await withActor(WORKER_ACTOR, (tx) =>
    refundsRepository.rekeyUnsentPending(tx, { id: refund.id, fromKey: key, toKey: fresh }),
  );
  if (!written) return { refundId: refund.id, outcome: 'still-failing' };
  let reply: Awaited<ReturnType<StripeClient['createRefund']>>;
  try {
    reply = await stripe.createRefund(
      refundCreateParams({ refundId: refund.id, paymentIntentId, amountCents: refund.amountCents }),
      fresh,
    );
  } catch (err) {
    const refusal =
      stripeIdempotencyErrorKind(err) === undefined ? stripeRefundRefusal(err) : undefined;
    if (refusal !== undefined) {
      await refuseRefundAtCreate({
        refundId: refund.id,
        paymentIntentId,
        stripeIdempotencyKey: fresh,
        refusal,
        log,
        context: { workerTick: 'duplicate-refund-retry' },
        actor: WORKER_ACTOR,
      });
      return { refundId: refund.id, outcome: 'refused' };
    }
    if (isStripeServerError(err) && stripeErrorReplayed(err) === true) STORED_ERROR_KEYS.add(fresh);
    log.warn(
      { ...context, freshKey: fresh, err: errMsg(err) },
      'refund sweep: the one send under the fresh key answered no refund; nothing more is sent, and the row waits on Stripe in the refund report',
    );
    return { refundId: refund.id, outcome: 'awaiting-stripe' };
  }
  await refundsRepository.markStripeId({ id: refund.id, stripeRefundId: reply.id });
  await applyReply(refund, paymentIntentId, reply, log);
  log.info(
    { ...context, freshKey: fresh, stripeRefundId: reply.id },
    'refund sweep: a refund whose first key answered a stored server error was sent once under a fresh key and Stripe holds it',
  );
  return { refundId: refund.id, outcome: 'sent' };
}

/**
 * The look-up by `metadata.refund_id` (P22 B-7(b) 2), with no transaction open. `found`:
 * Stripe's refund carrying this row's id at this row's amount, applied through the one
 * apply function (match step 2 stores its `re_`). `none`: a complete list holds none that
 * is this row's (one carrying its id at another amount is applied too, and recorded as a
 * refund of its own). `unknown`: the list errored or came back partial, which moves
 * nothing.
 */
async function lookUpByRefundId(
  refund: RefundRow,
  paymentIntentId: string,
  stripe: StripeClient,
  log: WorkerLogger,
): Promise<'found' | 'none' | 'unknown'> {
  let listed: Awaited<ReturnType<StripeClient['listRefundsForPaymentIntent']>>;
  try {
    listed = await stripe.listRefundsForPaymentIntent(paymentIntentId);
  } catch (err) {
    log.warn(
      { workerTick: 'duplicate-refund-retry', refundId: refund.id, paymentIntentId, err: errMsg(err) },
      'refund sweep: listing the PaymentIntent\'s refunds failed; nothing moves, and the next look asks again',
    );
    return 'unknown';
  }
  // Every refund carrying this row's id goes through the one apply function, and the row is
  // `found` only when the apply took one AS this row's: one at another amount is recorded
  // as a refund of its own (Opus r2 L2), and the row is still owed its own, so it goes on to
  // the fresh-key send or the end state as if that refund were not there.
  const carrying = listed.refunds.filter((r) => r.metadataRefundId === refund.id);
  if (carrying.length > 0) {
    const applied = await withActor(WORKER_ACTOR, async (tx) => {
      const each: LiveRefundResult[] = [];
      for (const live of carrying) {
        each.push(await applyLiveRefund(tx, { chargeId: refund.chargeId, live, log }));
      }
      return each;
    });
    if (applied.some((a) => a.refundId === refund.id)) return 'found';
  }
  return listed.complete ? 'none' : 'unknown';
}

/**
 * P22 B-7(a): retrieve each `pending` refund Stripe holds that no event has finished and
 * that nobody looked at for {@link REFUND_STATUS_POLL_MINUTES}, with no transaction open,
 * and apply its live status. **Never by the clock**: a refund Stripe still holds `pending`
 * stays `pending`, looked at again an hour on.
 */
async function pollPendingWithStripeId(
  stripe: StripeClient,
  log: WorkerLogger,
  now: Date,
  limit: number | undefined,
): Promise<number> {
  const lookedBefore = new Date(now.getTime() - REFUND_STATUS_POLL_MINUTES * 60 * 1000);
  const due = await withActor(WORKER_ACTOR, (tx) =>
    refundsRepository.claimPendingWithStripeIdForPoll(tx, {
      lookedBefore,
      ...(limit !== undefined ? { limit } : {}),
    }),
  );
  for (const row of due) {
    try {
      const live = await stripe.retrieveRefund(row.stripeRefundId!);
      await withActor(WORKER_ACTOR, (tx) =>
        applyLiveRefund(tx, { chargeId: row.chargeId, live, log }),
      );
    } catch (err) {
      log.warn(
        { workerTick: 'duplicate-refund-retry', refundId: row.id, err: errMsg(err) },
        'refund sweep: polling a pending refund failed; it is looked at again an hour on',
      );
    }
  }
  return due.length;
}

/**
 * P22 B-7(b) 4, the end state, with no new state. Two kinds of row are asked about by
 * `metadata.refund_id`: a re-keyed row (hourly; its key holds the instant of its one send)
 * and a staff row Stripe could not be reached for, past the retry window (once its last
 * send, its `updated_at`, is a key window old). A refund carrying the row's id is applied;
 * once the key window has passed and a COMPLETE list holds none, the row moves `pending →
 * failed` under the charge lock with one level-50 line, because Stripe holds nothing for
 * it. A look-up that errors or comes back partial moves nothing. This is not a move by the
 * clock: 146(c) protects a refund Stripe holds (a `re_`), and this row has none.
 */
async function lookUpUnsent(
  stripe: StripeClient,
  log: WorkerLogger,
  now: Date,
  limit: number | undefined,
): Promise<{ lookedUp: number; endedFailed: number }> {
  const windowMs = REFUND_KEY_WINDOW_HOURS * 60 * 60 * 1000;
  const rekeyed = await withActor(WORKER_ACTOR, (tx) =>
    refundsRepository.claimRekeyedForLookUp(tx, {
      lookedBefore: new Date(now.getTime() - REFUND_STATUS_POLL_MINUTES * 60 * 1000),
      ...(limit !== undefined ? { limit } : {}),
    }),
  );
  const unreached = await refundsRepository.findUnsentStaffPastWindow(db, {
    mintedBefore: new Date(now.getTime() - DUPLICATE_REFUND_ABANDON_AFTER_HOURS * 60 * 60 * 1000),
    sentBefore: new Date(now.getTime() - windowMs),
    ...(limit !== undefined ? { limit } : {}),
  });
  let lookedUp = 0;
  let endedFailed = 0;
  for (const row of [...rekeyed, ...unreached]) {
    try {
      const charge = await withActor(WORKER_ACTOR, (tx) => chargesRepository.findById(tx, row.chargeId));
      if (charge?.stripePaymentIntentId == null || row.stripeIdempotencyKey === null) continue;
      lookedUp += 1;
      const found = await lookUpByRefundId(row, charge.stripePaymentIntentId, stripe, log);
      if (found !== 'none') continue;
      const sentAt = rekeyedAt(row.stripeIdempotencyKey);
      const windowPassed =
        sentAt === undefined || now.getTime() >= sentAt.getTime() + windowMs;
      if (!windowPassed) continue;
      const key = row.stripeIdempotencyKey;
      const failed = await withActor(WORKER_ACTOR, async (tx) => {
        await chargesRepository.findByIdForUpdate(tx, row.chargeId);
        return refundsRepository.failUnsentPending(tx, { id: row.id, stripeIdempotencyKey: key });
      });
      if (!failed) continue;
      endedFailed += 1;
      log.error(
        {
          workerTick: 'duplicate-refund-retry',
          moneyEvent: 'refund-unsent-past-key-window',
          refundId: row.id,
          chargeId: row.chargeId,
          paymentIntentId: charge.stripePaymentIntentId,
          amountCents: row.amountCents,
          stripeIdempotencyKey: key,
        },
        REFUND_UNSENT_PAST_WINDOW_ALARM,
      );
    } catch (err) {
      log.error(
        { workerTick: 'duplicate-refund-retry', refundId: row.id, err: errMsg(err) },
        'refund sweep: looking up an unsent refund threw; it is looked at again on a later tick',
      );
    }
  }
  return { lookedUp, endedFailed };
}

/**
 * Refund ids this PROCESS has already shouted about. The abandon report is a
 * standing condition, not an event: the same rows are re-read every tick, and
 * at a one-minute cadence an unresolved row emits ~1,440 identical ERRORs a day
 * — so the first real incident after one arrives already buried. Loud once,
 * quiet after: ERROR the first time, INFO after.
 *
 * There is no durable row to key that "first time" on, and an acknowledgement
 * table is portal-surface work
 * that is deliberately not in this change. So the memory is per-process:
 * a restart re-shouts every outstanding row once, which is the right failure
 * mode — a fresh process SHOULD re-announce owed money, and nothing here can
 * make an unresolved refund silent forever. The count stays in every tick's
 * INFO summary either way, so the condition is never invisible.
 *
 * Bounded by the number of distinct refunds that ever go abandoned in one
 * process lifetime — a set the whole point of this worker is to keep near zero.
 *
 * **Keyed by class and row** (P22 B-7(e)): a row whose class changes is named again under
 * its new class, because the advice changed. A failed refund first told as "Retry to card
 * or Returned" becomes, once a dashboard refund lands, one whose exits both refuse it; the
 * row's earlier sentence is then false, and only its new one is true.
 */
const ALARMED_REFUND_IDS = new Set<string>();
const alarmKey = (row: AbandonedRefundRow): string => `${row.refundClass}:${row.id}`;

/**
 * Per class, the largest abandoned count this PROCESS has already announced.
 *
 * The companion to {@link ALARMED_REFUND_IDS} for the rows that never reach the
 * capped report page. Loud-once has to key on something, and a boolean "have I
 * mentioned this class" — what this replaced — is only correct while the class's
 * population is static. It is not: `stripe-failed` rows are terminal and
 * accumulate forever, and pending rows past the page cap arrive whenever money
 * fails to return. Keying on the COUNT means new owed money is always an ERROR
 * exactly once, and unchanged owed money stays an INFO.
 *
 * The mark is the last count this process ANNOUNCED for the class — not a
 * true high-water (final panel pass, 2026-08-20): the row-naming path
 * re-bases it to the current total, which can LOWER it after a shrink, so a
 * later regrowth re-alarms sooner than a never-decreasing mark would. The
 * one silence this leaves — the accepted residue — is a fully page-buried
 * class whose count shrinks (a human resolves rows) and regrows to at or
 * below the last announced level: genuinely NEW never-named rows arrive as
 * INFO only in that window. Resetting the mark on every decrease would
 * re-shout rows already announced, which is the flood this map exists to
 * prevent. Do not "fix" the re-basing to Math.max — it is the safer side.
 */
const ALARMED_BURIED_HIGH_WATER = new Map<AbandonedRefundClass, number>();

/**
 * One sentence per class, each of which is an instruction its class's reader
 * can actually follow. The single sentence this replaced ended "refund by hand
 * in the Stripe dashboard" for every row — impossible for `never-sent` (there
 * is no charge to refund) and actively dangerous for `client-keyed` (the
 * original refund may already exist under a key we cannot see).
 */
const ABANDONED_CLASS_MESSAGE: Record<AbandonedRefundClass, string> = {
  'row-keyed':
    'duplicate refund retry: refunds past the idempotency-key window are still unsent — an owner is owed this money and no automatic path will return it; refund by hand in the Stripe dashboard against the listed PaymentIntent, searching the listed idempotency key first in case a late retry did land',
  'client-keyed':
    'duplicate refund retry: refunds no sweep will ever retry are still unsent — their original Stripe key was the CLIENT request key and nothing durable can reproduce it; an owner is owed this money, so refund by hand against the listed PaymentIntent, but CHECK it for an existing refund first (a lost response rather than a lost request means the money already went back)',
  'never-sent':
    'duplicate refund retry: refund rows with no Stripe charge behind them are still pending — the charge carries no PaymentIntent (pre-Stripe-wire seed money), so there is nothing to refund in the dashboard and no automatic path applies; these record an intent to return money that never moved through Stripe and must be resolved out of band',
  'awaiting-stripe':
    "refund sweep: refunds waiting on Stripe's answer — each was sent and Stripe shows no refund for it yet, because its key answered a stored server error or Stripe could not be reached. The sweep looks each up in Stripe every hour by its refund_id metadata and records it the moment Stripe shows one; if Stripe still shows none 24 hours after the last send, the row is marked failed and Retry to card and Returned open for it. Send nothing for these by hand: a refund sent now could be a second one. This alarm repeats once per process restart",
  'stripe-failed':
    "refund sweep: refunds that did not reach the family — Stripe failed each after creating it, or refused it at create (a row with no stripeRefundId) — so no money went back on any of them. Each is the newest of its retry chain and fits what its payment still owes, so an owner or manager closes it with one of two exits: Retry to card (POST /staff/refunds/:id/retry) sends the row's amount to the card again under a fresh key, and Returned (POST /staff/refunds/:id/resolve-external) records money handed back outside the app, or, as withdrawn, that the family keeps the purchase. Each row's `seenOn` says where staff find it. CHECK the listed PaymentIntent for a refund someone already made by hand first (this alarm repeats once per process restart, so a colleague may already have acted), then follow each row's `instruction`: rows sharing a charge have had its capacity divided between them oldest-first, so obeying every row is safe individually and in total, and a row reading \"return NOTHING\" means exactly that",
  'failed-exceeds-owed':
    "refund sweep: failed refunds LARGER than what their payment still owes — other refunds on the payment (a dashboard refund, most often) have returned part of the money since, so Retry to card and Returned would each refuse the full row as over the cap. Each row's `instruction` names the figure the payment still owes (its `actionableCents`): send that as a new refund through Refund (POST /staff/refunds) with credits_to_remove 0 (the failed row's own credit removal, if any, stands). Once the payment owes nothing the failed row reads covered and needs nothing more. CHECK the listed PaymentIntent for a refund someone already made by hand first (this alarm repeats once per process restart)",
  // MR-A2.5(a): the previous text ended "resolve each with a note if you want
  // it off the books explicitly", which a human CANNOT obey — guard (b)
  // correctly refuses resolving any row on a fully-covered charge (its amount
  // necessarily exceeds a remainder of 0). An instruction nobody can follow is
  // worse than no instruction: it sends someone to try, fail, and distrust the
  // report. A covered row needs no action at all — the reclassification IS its
  // resolution.
  covered:
    'duplicate refund retry: refunds Stripe FAILED whose charge has no live remainder left — NO ACTION NEEDED on any of them. Two substates, both quiet for the same reason: covered by a COMPLETED return (an adopted dashboard refund, or a resolved-external attestation — the money is with the owner and this row is history), or covered by an IN-FLIGHT return (a re-mint the sweep still owns — the money has not moved yet, and acting now is the double-movement this class exists to prevent). Either way the row reclassified automatically and re-shouts on the next tick if the covering refund fails',
};

/**
 * Report order, and the order the totals are summed in. `never-sent` stays in
 * the list even though {@link refundsRepository.markUnroutable} should empty it
 * on the same tick: the flip is batched, so a large legacy backlog can leave
 * rows behind for a tick or two, and a class that silently vanished from the
 * sum would understate owed money at exactly the moment there is most of it.
 *
 * What buries the page is NOT a frozen set (corrected 2026-08-20). An earlier
 * version of this file said the only saturating class was `client-keyed`, which
 * is finite and cannot grow after deploy. `stripe-failed` broke that: those rows
 * are terminal, unbounded by age, and therefore always the oldest rows in the
 * result. {@link refundsRepository.findAbandonedPending} now orders the page by
 * ACTIONABILITY first — pending rows take the slots, failed rows fill the
 * remainder and can never evict one — and {@link ALARMED_BURIED_HIGH_WATER}
 * re-alarms when a class's buried count grows past the level this process
 * last announced. Saturation therefore cannot hide GROWTH in owed money; the
 * shrink-then-regrow window below the announced level is the one accepted
 * silence, documented at the map itself.
 */
/**
 * The query that LISTS a buried class, per class — because the saturation alarm
 * has no row detail to give and the query is the whole instruction.
 *
 * It is a map rather than one literal because the classes do not live in the
 * same rows (adversary panel, 2026-08-20): the three unsent classes are
 * `status='pending' AND stripe_refund_id IS NULL`, while `stripe-failed` rows
 * are `status='failed'` and carry a NON-NULL `stripe_refund_id` by
 * construction. The single pending-shaped literal this replaced returned ZERO
 * rows when the buried class was `stripe-failed` — an alarm naming a class and
 * then handing over a query that cannot find it.
 */
const ABANDONED_CLASS_QUERY: Record<AbandonedRefundClass, string> = {
  'awaiting-stripe':
    "SELECT * FROM refunds WHERE status='pending' AND stripe_refund_id IS NULL AND (stripe_idempotency_key LIKE 'refund-rekey:%' OR issued_by_staff_id IS NOT NULL) ORDER BY created_at DESC",
  'failed-exceeds-owed': "SELECT * FROM refunds WHERE status='failed' ORDER BY created_at DESC",
  'row-keyed':
    "SELECT * FROM refunds WHERE status='pending' AND stripe_refund_id IS NULL ORDER BY created_at DESC",
  'client-keyed':
    "SELECT * FROM refunds WHERE status='pending' AND stripe_refund_id IS NULL AND stripe_idempotency_key IS NULL ORDER BY created_at DESC",
  'never-sent':
    "SELECT * FROM refunds WHERE status='pending' AND stripe_refund_id IS NULL ORDER BY created_at DESC",
  'stripe-failed': "SELECT * FROM refunds WHERE status='failed' ORDER BY created_at DESC",
  covered: "SELECT * FROM refunds WHERE status='failed' ORDER BY created_at DESC",
};

const ABANDONED_CLASSES: readonly AbandonedRefundClass[] = [
  'row-keyed',
  'client-keyed',
  'never-sent',
  'awaiting-stripe',
  'stripe-failed',
  'failed-exceeds-owed',
  // MR-A1.5. Counted in the summary and INFO-logged, NEVER alarmed: see
  // `QUIET_CLASSES`.
  'covered',
];

/**
 * Classes that are reported but never ALARMED (MR-A1.5).
 *
 * `covered` is money that already went back — an adopted dashboard refund or a
 * `resolved-external` attestation meets the charge — so the `'failed'` row that
 * remains records an unsuccessful ATTEMPT at a debt that no longer exists.
 * Before this class existed, `totalByClass['stripe-failed']` could not reach
 * zero even after the return, so the round-6 alarm could never clear and the
 * page kept telling a human to send the money a second time.
 *
 * It is still COUNTED in every tick's summary and INFO line: the condition is
 * never invisible, it is merely not an emergency.
 */
const QUIET_CLASSES: ReadonlySet<AbandonedRefundClass> = new Set(['covered']);

/** Dollars, for a sentence a human reads rather than a field they parse. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The row's instruction IN WORDS (MR-A3.2 presentation rule).
 *
 * A fully-clipped row must never print a bare `$0`: on a worklist that reads as
 * a bug, and the reader resolves a bug by guessing — which on this page means
 * returning the row's own amount, the exact over-return the allocation exists
 * to prevent. So a zero says "return NOTHING on this row" and says why; a
 * partially-clipped row names both figures so the human can see the arithmetic
 * rather than having to trust it.
 */
function actionableInstruction(row: AbandonedRefundRow): string {
  if (row.refundClass === 'awaiting-stripe') {
    return "send nothing: the sweep is waiting on Stripe's answer for this refund";
  }
  if (row.refundClass === 'failed-exceeds-owed' && row.actionableCents > 0) {
    // Both figures in words (MR-A3.2), and the road that pays the smaller one (Fable M1).
    return `return ${dollars(row.actionableCents)} of this row's ${dollars(row.amountCents)} as a new refund through Refund, with no credits to remove — the payment owes no more than that, so Retry to card and Returned would refuse the row; this failed row then needs nothing more`;
  }
  const because =
    row.clipReason === 'allocated-to-older'
      ? 'it is allocated to an older row on the same charge'
      : 'the money is already returned, attested, or still owned by automation';
  if (row.actionableCents === 0) {
    return `return NOTHING on this row — ${because}`;
  }
  if (row.clipped) {
    return `return ${dollars(row.actionableCents)} of this row's ${dollars(row.amountCents)} — the rest is not available on this charge: ${because}`;
  }
  return `return ${dollars(row.actionableCents)}`;
}

/**
 * The ONE durable announcement for a refund that was owed with no route to send
 * it (design §4). Unlike {@link reportAbandoned}, this needs no per-process
 * memory: it fires on the tick that FLIPS the row, and a flipped row can never
 * be flipped again — the status transition is the "have I said this already".
 */
function reportUnroutable(flipped: AbandonedRefundRow[], log: WorkerLogger): void {
  if (flipped.length === 0) return;
  log.error(
    {
      workerTick: 'duplicate-refund-retry',
      refundClass: 'unroutable' as const,
      flippedCount: flipped.length,
      refunds: flipped.map((r) => ({
        refundId: r.id,
        ownerId: r.ownerId,
        chargeId: r.chargeId,
        amountCents: r.amountCents,
      })),
    },
    'duplicate refund retry: refunds with no Stripe route are now TERMINAL at "unroutable" — the charge behind each carries no PaymentIntent (pre-Stripe-wire money), so nothing here can ever send them; this is the one and only time each will be announced: a person hands the money back for each and records it with Returned (POST /staff/refunds/:id/resolve-external)',
  );
}

/**
 * Report the abandon worklist: split by class so each alarm is true, and once
 * per row per process so a standing condition cannot bury the next incident.
 */
function reportAbandoned(
  rows: AbandonedRefundRow[],
  totalByClass: Record<AbandonedRefundClass, number>,
  log: WorkerLogger,
): void {
  for (const refundClass of ABANDONED_CLASSES) {
    const inClass = rows.filter((r) => r.refundClass === refundClass);
    const total = totalByClass[refundClass];
    if (total === 0) continue;
    if (QUIET_CLASSES.has(refundClass)) {
      // Counted, never alarmed. `findAbandonedPending` also keeps these off the
      // named page, so `inClass` is empty by construction — the count is the
      // whole report, which is exactly right for money that is no longer owed.
      log.info(
        { workerTick: 'duplicate-refund-retry', refundClass, abandonedCount: total },
        ABANDONED_CLASS_MESSAGE[refundClass],
      );
      continue;
    }
    const unreported = inClass.filter((r) => !ALARMED_REFUND_IDS.has(alarmKey(r)));
    if (unreported.length === 0) {
      // Nothing NEW to name by row. Two very different situations reach here and
      // the difference is money (adversary round 3, 2026-08-20):
      //
      //   · the count is unchanged — a standing condition, correctly demoted to
      //     INFO so it cannot bury the next incident; or
      //   · the count GREW — new abandoned money arrived, but every row the page
      //     can show is one this process already named, so per-row loud-once has
      //     nothing left to say and the growth would pass in silence.
      //
      // The second case was real and provable: a saturating class made the page
      // permanently unavailable to newer rows, and the old boolean
      // `buried:<class>` sentinel fired ONCE PER PROCESS PER CLASS, so tick after
      // tick of genuinely new abandoned refunds produced zero ERRORs and only a
      // climbing INFO number nobody is watching. A high-water mark per class
      // fixes that without reopening the flood it replaced: one ERROR per
      // INCREASE, not one per tick.
      const seen = ALARMED_BURIED_HIGH_WATER.get(refundClass) ?? 0;
      if (total > seen) {
        ALARMED_BURIED_HIGH_WATER.set(refundClass, total);
        log.error(
          {
            workerTick: 'duplicate-refund-retry',
            refundClass,
            abandonedCount: total,
            previouslyAnnounced: seen,
            newlyAbandonedCount: total - seen,
          },
          `duplicate refund retry: ${total - seen} MORE abandoned ${refundClass} refund(s) since this process last said so (${total} total) — the report page cannot show them, so list them with: ${ABANDONED_CLASS_QUERY[refundClass]}`,
        );
        continue;
      }
      log.info(
        {
          workerTick: 'duplicate-refund-retry',
          refundClass,
          abandonedCount: total,
        },
        'duplicate refund retry: still-abandoned refunds at or below the count this process last alarmed — on-page rows were named individually; buried rows are carried by count',
      );
      continue;
    }
    for (const row of unreported) ALARMED_REFUND_IDS.add(alarmKey(row));
    // Naming rows by id also settles the count question for this class, so a
    // later pure-growth alarm measures from here rather than re-reporting these.
    ALARMED_BURIED_HIGH_WATER.set(refundClass, total);
    log.error(
      {
        workerTick: 'duplicate-refund-retry',
        refundClass,
        abandonedCount: total,
        newlyAbandonedCount: unreported.length,
        refunds: unreported.map((r) => ({
          refundId: r.id,
          ownerId: r.ownerId,
          chargeId: r.chargeId,
          amountCents: r.amountCents,
          // THE FIGURE TO RETURN (MR-A2.3, allocated MR-A3.2). Both inputs are
          // still reported as context, and `instruction` renders the figure in
          // words — because a bare `0` on a worklist reads as a typo, and a
          // human resolves a typo by guessing.
          actionableCents: r.actionableCents,
          clipped: r.clipped,
          clipReason: r.clipReason,
          instruction: actionableInstruction(r),
          remainingCents: r.remainingCents,
          seenOn: r.seenOn,
          paymentIntentId: r.stripePaymentIntentId,
          // The key the human is being told to search for. Stored on the row
          // for everything minted since 2026-08-19; derived for the legacy
          // `duplicate-invoice-settle` rows, which is the only other way a row
          // reaches this class.
          ...(refundClass === 'row-keyed'
            ? { idempotencyKey: r.stripeIdempotencyKey ?? duplicateRefundIdempotencyKey(r.id) }
            : {}),
          // A failed refund's identity IS the thing to look up: the dashboard
          // shows why it failed next to the charge it belongs to.
          ...(refundClass === 'stripe-failed' || refundClass === 'failed-exceeds-owed'
            ? { stripeRefundId: r.stripeRefundId }
            : {}),
        })),
      },
      ABANDONED_CLASS_MESSAGE[refundClass],
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
