import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import {
  invoiceChargeAttemptsRepository,
  type InvoiceAttemptReconcileReason,
  type InvoiceChargeAttemptRow,
} from '../db/repositories/invoiceChargeAttemptsRepository.js';
import { invoicesRepository, type InvoiceRow } from '../db/repositories/invoicesRepository.js';
import { withActor } from '../db/tx.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import {
  chargeBlockerForConfirm,
  defaultStripeClient,
  stripeIdempotencyErrorKind,
  type StripeClient,
  type StripePaymentIntentResult,
} from '../lib/stripe.js';
import {
  enqueueAutoChargeParkPush,
  parkArmForBlocker,
  recordKnownFailure,
  scheduleNextAttempt,
  settleAttempt,
  type WorkerLogger,
} from './invoiceAutoCharge.js';

/**
 * Invoice attempt VERIFY lane (2026-08-12,
 * `designs/auto-charge-unknown-outcome.md`, Decision 3). The other half of the
 * unknown-outcome protocol, and the reason the charge lane is allowed to simply
 * STOP when it doesn't know what happened.
 *
 * The charge lane's job is to charge. This lane's job is to find out — for
 * every `invoice_charge_attempts` row still `pending` (we never learned an
 * outcome) or `processing` (Stripe has it and the money is in flight). It never
 * mints a new idempotency key, so nothing it does can create a second charge
 * for one debt:
 *
 *   - **PI id known** → RETRIEVE it. A GET moves no money and answers the
 *     question outright. Succeeded settles (through the same primitive and the
 *     same lost-race refund as every other settle path); terminally dead cancels
 *     the intent (R15 — the invoice is about to be freed for a fresh key) and
 *     then advances the dunning ladder with the honest push, unless the invoice
 *     is already parked, in which case it keeps the park and only speaks;
 *     still-processing waits. Every one of those follows `resolve()` RETURNING
 *     1: whoever ends an attempt owns what happens next, and the loser of that
 *     race does nothing at all.
 *   - **PI id unknown, inside the key window** → RE-ISSUE the identical confirm
 *     under the RECORDED key with the FROZEN params — but only while the
 *     invoice still WANTS a card charge, because a re-issue is not guaranteed
 *     to be a replay and an executing one moves real money (see the re-check in
 *     `verifyByReissue`). A replay settles or reports the original failure. An
 *     execution that CAPTURED is the case Stripe's idempotency layer was
 *     supposed to make impossible inside the window, so it is not settled here
 *     at all: it is parked for a human, because the benign reading (the first
 *     request never reached Stripe) and the expensive one (the key expired
 *     early and this is a SECOND charge) are indistinguishable from in here.
 *     An execution that ended DEAD captured nothing, so there is no duplicate
 *     to reconcile: it is this attempt's own known outcome and takes the
 *     ordinary ladder, with `reconcile_reason = 'fresh-execution'` left on the
 *     row as the trail.
 *   - **PI id unknown, past the key window** → the honest end of the automatic
 *     road. Park the invoice for a human, tell the owner we don't know yet and
 *     ask them NOT to pay again, and log the Stripe dashboard search. This arm
 *     overwhelmingly means the create never landed — but "overwhelmingly" is
 *     not "certainly", and on a money path the residue goes to a person rather
 *     than to a fresh key.
 *
 * **Both loops terminate.** The dunning ladder terminates at
 * `MAX_AUTO_CHARGE_ATTEMPTS` as before. This lane terminates because
 * `claimUnresolvedForVerify` bumps `verify_count` on every claim and refuses to
 * claim a row at or past {@link MAX_ATTEMPT_VERIFY_PASSES} — so one attempt is
 * examined at most that many times, ever, whatever else goes wrong. The
 * behavioral caps below (in-flight age, key window) end it far earlier, and
 * both of those exits park the invoice, which also stops the charge lane from
 * re-leasing it.
 *
 * Runs as a phase of the composed scheduler tick, under the same
 * `system:stripe-webhook` actor family as the charge lane (R37).
 */

const WORKER_ACTOR = 'system:stripe-webhook';

/** How long an unresolved attempt rests before this lane looks at it again.
 *  Short on purpose: key replay is only available for the ~24h Stripe keeps a
 *  key, so doubt must be worked on a cadence measured in minutes, never on the
 *  dunning ladder's 24h/72h rungs. */
export const ATTEMPT_VERIFY_INTERVAL_MINUTES = 10;

/** How long after an attempt was minted we still trust its idempotency key to
 *  REPLAY rather than execute fresh. Stripe documents ~24h; this is the margin
 *  under it. **UNVERIFIED against live Stripe** — documented, stub-modelled,
 *  and converted to a probe question, never measured here. */
export const IDEMPOTENCY_KEY_SAFE_WINDOW_HOURS = 20;

/** How long a `processing` intent may stay in flight before this lane stops
 *  waiting and tells the owner. Card payments resolve in seconds to minutes; a
 *  day of `processing` is an incident, and saying so beats retrying into it. */
export const IN_FLIGHT_PARK_AFTER_HOURS = 24;

/**
 * How far after its attempt row a PaymentIntent may have been created and still
 * be read as the ORIGINAL — the tolerance in {@link reissueLooksReplayed}.
 *
 * The attempt row is written immediately before the confirm, so an intent
 * Stripe created for that confirm carries a `created` within seconds of it
 * (`created` is second-granular, so it can even round a beat EARLIER). A
 * re-issue, by contrast, cannot happen until a full
 * {@link ATTEMPT_VERIFY_INTERVAL_MINUTES} has passed, so five minutes sits in
 * the gap between the two with room on both sides.
 */
export const FRESH_EXECUTION_GRACE_MINUTES = 5;

/** The hard termination bound — see `claimUnresolvedForVerify`. Comfortably
 *  past both behavioral caps at a 10-minute cadence (~33h), so it is the floor
 *  beneath them and not the usual exit. */
export const MAX_ATTEMPT_VERIFY_PASSES = 200;

const NOOP_LOG: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface InvoiceAttemptVerifyOpts {
  stripe?: StripeClient;
  /** Per-tick batch size. Default 25; tests pin small for determinism. */
  limit?: number;
  /** "Now" for the staleness cutoff + the window math. Tests pin an instant. */
  now?: Date;
  log?: WorkerLogger;
}

export interface InvoiceAttemptVerifyResult {
  attemptId: string;
  invoiceId: string;
  outcome: /** Retrieve/replay found the money — the invoice is settled (or the
     *  duplicate refunded, if another path won the race). */
    | 'settled'
    /** Terminally dead. The attempt is resolved and the ladder advanced. */
    | 'no-charge'
    /** Still in flight; asked again later. */
    | 'still-processing'
    /** The re-issue produced a live intent — recorded, still unresolved. */
    | 'reissued-in-flight'
    /** Still unknown after this pass (transport failed again, or Stripe said
     *  the key was busy in another in-flight request). */
    | 'still-unknown'
    /** The invoice stopped wanting a card charge while its outcome was unknown
     *  — paid, voided, or switched to pay-in-person. Nothing was re-issued and
     *  the attempt stays pending for the webhook. */
    | 'skipped-not-chargeable'
    /** In flight past the cap → parked for a human, owner told. */
    | 'parked-in-flight'
    /** Past the key window with no answer → parked for a human, owner told. */
    | 'parked-unconfirmed'
    /** Stripe rejected the recorded key with our frozen params — our records
     *  and Stripe's disagree. Parked; NEVER answered with a fresh key. */
    | 'parked-idempotency-conflict'
    /** The re-issue EXECUTED rather than replaying, so the 20h key-window
     *  assumption did not hold and a second charge may exist for this debt.
     *  Parked for a human instead of settled. */
    | 'parked-fresh-execution'
    /** A webhook (or another pass) resolved this attempt while we were asking
     *  Stripe. `resolve` is the arbiter and we lost, so nothing was done —
     *  above all the dunning ladder was NOT advanced a second time. */
    | 'lost-resolve-race'
    /** Working this attempt THREW. Logged at error level and isolated to this
     *  row; the batch carried on. Nothing was resolved, so the next pass
     *  re-examines it (within the verify-count bound). */
    | 'errored'
    /** The attempt's invoice or Stripe customer could not be read. Nothing
     *  done; logged for a human. */
    | 'skipped-unreadable';
}

export interface InvoiceAttemptVerifyTickResult {
  scanned: number;
  results: InvoiceAttemptVerifyResult[];
}

/**
 * Run one verify tick. Claims a batch in a short tx (which also leases it), then
 * works each attempt with every Stripe call OUTSIDE any transaction.
 */
export async function runInvoiceAttemptVerifyOnce(
  opts: InvoiceAttemptVerifyOpts = {},
): Promise<InvoiceAttemptVerifyTickResult> {
  const stripe = opts.stripe ?? defaultStripeClient;
  const log = opts.log ?? NOOP_LOG;
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - ATTEMPT_VERIFY_INTERVAL_MINUTES * 60 * 1000);

  const claimed = await withActor(WORKER_ACTOR, (tx) =>
    invoiceChargeAttemptsRepository.claimUnresolvedForVerify(tx, {
      staleBefore,
      maxVerifyCount: MAX_ATTEMPT_VERIFY_PASSES,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    }),
  );
  log.info(
    { workerTick: 'invoice-attempt-verify', batchSize: claimed.length },
    'invoice attempt verify tick claimed batch',
  );

  const results: InvoiceAttemptVerifyResult[] = [];
  for (const attempt of claimed) {
    // ── PER-ATTEMPT BOUNDARY (round 3) ──────────────────────────────────────
    // One attempt's failure is one attempt's failure. Without this, a single
    // thrower cost the whole claimed batch — and cost it PERMANENTLY, because
    // `claimUnresolvedForVerify` bumps `verify_count` for all 25 rows before
    // any of them is worked and orders by `updated_at ASC`, so the thrower
    // sorts to the front of the next batch and burns a pass off every row
    // behind it, forever. The scheduler's phase boundary would have logged one
    // line a minute and nothing would have moved.
    //
    // The bound is unchanged: this row's claim already spent its pass, so a
    // deterministic thrower still retires at MAX_ATTEMPT_VERIFY_PASSES.
    try {
      results.push(await verifyOne(attempt, stripe, now, log));
    } catch (err) {
      log.error(
        {
          attemptId: attempt.id,
          invoiceId: attempt.invoiceId,
          attemptNo: attempt.attemptNo,
          paymentIntentId: attempt.stripePaymentIntentId,
          verifyCount: attempt.verifyCount,
          err: errMsg(err),
        },
        'invoice attempt verify: working this attempt threw; the rest of the batch carries on',
      );
      results.push({ attemptId: attempt.id, invoiceId: attempt.invoiceId, outcome: 'errored' });
    }
  }
  return { scanned: results.length, results };
}

async function verifyOne(
  attempt: InvoiceChargeAttemptRow,
  stripe: StripeClient,
  now: Date,
  log: WorkerLogger,
): Promise<InvoiceAttemptVerifyResult> {
  const invoice = await invoicesRepository.findById(db, attempt.invoiceId);
  if (invoice === undefined) {
    // Structurally impossible (the FK is ON DELETE RESTRICT), so this is a
    // corrupt-state alarm, not a branch to recover from.
    log.error(
      { attemptId: attempt.id, invoiceId: attempt.invoiceId },
      'invoice attempt verify: attempt references an invoice that does not exist',
    );
    return { attemptId: attempt.id, invoiceId: attempt.invoiceId, outcome: 'skipped-unreadable' };
  }

  if (attempt.stripePaymentIntentId !== null) {
    return verifyByRetrieve(attempt, invoice, attempt.stripePaymentIntentId, stripe, now, log);
  }
  return verifyByReissue(attempt, invoice, stripe, now, log);
}

/**
 * The PI id is known, so ASK. `retrievePaymentIntent` is a GET: it cannot move
 * money, and it answers the question the charge lane couldn't.
 */
async function verifyByRetrieve(
  attempt: InvoiceChargeAttemptRow,
  invoice: InvoiceRow,
  paymentIntentId: string,
  stripe: StripeClient,
  now: Date,
  log: WorkerLogger,
): Promise<InvoiceAttemptVerifyResult> {
  let intent: StripePaymentIntentResult;
  try {
    intent = await stripe.retrievePaymentIntent(paymentIntentId);
  } catch (err) {
    // Couldn't reach Stripe. Change nothing — the attempt stays unresolved and
    // this lane asks again next interval. "We couldn't ask" is never evidence
    // about where the money is.
    log.warn(
      { attemptId: attempt.id, invoiceId: invoice.id, paymentIntentId, err: errMsg(err) },
      'invoice attempt verify: retrieve failed; leaving the attempt unresolved',
    );
    return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'still-unknown' };
  }
  return applyVerifiedIntent(attempt, invoice, intent, stripe, now, log, {
    inFlightOutcome: 'still-processing',
  });
}

/**
 * The PI id is unknown — the request left and nothing came back, so we do not
 * even know whether Stripe ever saw it.
 *
 * Inside the key window: RE-ISSUE the byte-identical request under the RECORDED
 * key. If Stripe executed it the first time, its idempotency layer replays that
 * outcome; if it never did, this simply *is* attempt N happening. Either way
 * exactly one charge can exist for this key, which is the whole reason the key
 * is not allowed to rotate on doubt.
 *
 * Past the window: refuse to re-issue (a key Stripe may have forgotten is a key
 * that could execute a SECOND time), park the invoice, and hand it to a human.
 */
async function verifyByReissue(
  attempt: InvoiceChargeAttemptRow,
  invoice: InvoiceRow,
  stripe: StripeClient,
  now: Date,
  log: WorkerLogger,
): Promise<InvoiceAttemptVerifyResult> {
  // ── THE RE-CHECK THE CHARGE LANE DOES AND THIS ONE USED TO SKIP ────────────
  // A re-issue is not always a replay: when the original request never reached
  // Stripe there is nothing to replay and this call EXECUTES, which means it
  // can charge a card for real. So it owes the same question the charge lane
  // asks before every confirm — does this invoice still want a card charge? —
  // against the row `verifyOne` just read.
  //
  // The reachable version: a transport failure leaves the attempt `pending`
  // with no PI id; the owner, hearing nothing, pays in person (whose guard does
  // not consider attempt rows) or the enrollment is withdrawn and the invoice
  // voided; ten minutes later this lane re-issues and mints a genuinely new
  // charge. On a still-open invoice the settle then WINS the `markPaid` claim,
  // so no refund arm fires: cash was handed over AND the card was charged. That
  // is R3 ("never auto-charge a cash/check invoice") and Decision 2 of the
  // design, which routes exactly these invoices to the webhook instead.
  //
  // **It runs BEFORE the key-window check** (round 3), not after. Past the
  // window that check PARKS the invoice, and `parkForReconciliation` filters
  // only on `status='open'` — which a cash/check invoice still is. So an owner
  // who was asked to bring cash at drop-off would be told "we can't confirm
  // your payment, please don't pay it again", the invoice would leave the
  // dunning schedule for a staff worklist, and the `payment-unconfirmed:<id>`
  // dedupe row would suppress the overdue net that is supposed to chase it.
  // "Does this invoice still want a card charge?" is a question every arm of
  // this function owes, not just the one that sends a request.
  //
  // Nothing is resolved here — we still do not know what the ORIGINAL request
  // did, and the attempt stays `pending` so the webhook can say.
  const ageMs = now.getTime() - pgTimestampToDate(attempt.createdAt).getTime();
  const pastKeyWindow = ageMs > IDEMPOTENCY_KEY_SAFE_WINDOW_HOURS * 60 * 60 * 1000;

  if (invoice.status !== 'open' || invoice.paymentExpected !== 'card') {
    // The trail is kept even here, and only the trail: past the window this
    // attempt has no automatic future either, and "why did automation stop?" is
    // exactly what someone reading the row later needs. It costs no park (the
    // invoice is not stuck — it is paid, voided, or awaiting cash) and no push.
    if (pastKeyWindow) {
      await withActor(WORKER_ACTOR, (tx) =>
        invoiceChargeAttemptsRepository.recordReconcileReason(tx, {
          id: attempt.id,
          reason: 'key-window-expired',
        }),
      );
    }
    log.warn(
      {
        attemptId: attempt.id,
        invoiceId: invoice.id,
        status: invoice.status,
        paymentExpected: invoice.paymentExpected,
        pastKeyWindow,
      },
      'invoice attempt verify: invoice no longer takes a card charge; refusing to re-issue (a re-issue can execute, not just replay)',
    );
    return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'skipped-not-chargeable' };
  }

  if (pastKeyWindow) {
    return parkForHuman(attempt, invoice, now, log, {
      arm: 'unconfirmed',
      outcome: 'parked-unconfirmed',
      reason: 'key-window-expired',
      message:
        'invoice attempt verify: unresolved past the idempotency-key window with no PaymentIntent id and no webhook — parked for human reconciliation; search Stripe by metadata invoice_id',
    });
  }

  let intent: StripePaymentIntentResult;
  try {
    intent = await stripe.createAndConfirmPaymentIntent(
      {
        // FROZEN PARAMS, the customer included (2026-08-12). Not re-resolved,
        // not re-read off the invoice or off `stripe_customers`: the recorded
        // ones, exactly. Stripe hashes the request body against the key, so
        // anything else here turns a safe replay into a rejected request — and
        // the 2026-07-29 expired-card fallback must not be able to change the
        // card under a live key.
        customerId: attempt.stripeCustomerId,
        paymentMethodId: attempt.stripePaymentMethodId,
        amountCents: attempt.amountCents,
        currency: 'usd',
        metadata: {
          owner_id: invoice.ownerId,
          invoice_id: invoice.id,
          purpose: invoice.purpose,
          auto_charge_attempt: String(attempt.attemptNo),
        },
      },
      attempt.idempotencyKey,
    );
  } catch (err) {
    const idempotencyKind = stripeIdempotencyErrorKind(err);
    if (idempotencyKind === 'concurrent-request') {
      // HTTP 409: "another request is currently using this Idempotency Key".
      // This says nothing about our bookkeeping — it is two of our own ticks
      // overlapping (pg_cron fires `POST /workers/tick` every minute with no
      // overlap guard, and a slow batch is re-claimed by the next one). The
      // outcome is still unknown, exactly as it was; parking a healthy invoice
      // forever over a concurrency blip is the heaviest possible answer to the
      // lightest possible signal.
      log.warn(
        { attemptId: attempt.id, invoiceId: invoice.id, err: errMsg(err) },
        'invoice attempt verify: the recorded key is busy in another in-flight request (409) — still unknown, asking again next interval',
      );
      return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'still-unknown' };
    }
    if (idempotencyKind === 'params-mismatch') {
      // Stripe says this key was used with DIFFERENT parameters than the ones
      // we just sent — our records and Stripe's disagree about what attempt N
      // was. The design makes this unreachable by construction (params are
      // frozen on the row), so reaching it is an invariant violation. The one
      // response that must never follow is a fresh key: that is how a double
      // charge gets manufactured out of a bookkeeping disagreement.
      return parkForHuman(attempt, invoice, now, log, {
        arm: 'unconfirmed',
        outcome: 'parked-idempotency-conflict',
        reason: 'idempotency-conflict',
        message:
          'invoice attempt verify: Stripe rejected the recorded idempotency key with our frozen params (idempotency_error) — INVARIANT VIOLATION; parked for human reconciliation, no new key minted',
        err,
      });
    }
    log.warn(
      { attemptId: attempt.id, invoiceId: invoice.id, err: errMsg(err) },
      'invoice attempt verify: same-key re-issue failed (transport); attempt stays pending',
    );
    return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'still-unknown' };
  }

  // An id is knowledge — persist it before deciding, so a crash on the next
  // line leaves the next pass able to RETRIEVE instead of re-issue.
  await withActor(WORKER_ACTOR, (tx) =>
    invoiceChargeAttemptsRepository.recordPaymentIntentId(tx, {
      id: attempt.id,
      stripePaymentIntentId: intent.id,
    }),
  );
  const withIntent = { ...attempt, stripePaymentIntentId: intent.id };

  // ── DID IT REPLAY, OR DID IT EXECUTE? ─────────────────────────────────────
  // The 20h window is this design's entire double-charge defence and it rests
  // on Stripe's DOCUMENTED ~24h key lifetime, which this project has never
  // measured. If that assumption is wrong, a re-issue executes a SECOND charge
  // for a debt that was already paid — and the old code could not have noticed,
  // because it treated "replayed the original" and "executed just now" as the
  // same event and settled either one.
  //
  // **Which of the two costs money is the whole question** (round 3). A fresh
  // execution that CAPTURED — `succeeded` — is the one case where THIS call
  // moved money and a duplicate is therefore possible, so it parks: the benign
  // reading (the original never reached Stripe) and the expensive one (the key
  // expired early and this is a second charge) are indistinguishable from here.
  // A fresh execution that ended DEAD captured nothing at all, and nothing is
  // the same nothing however many times it happens — so it is attempt N's own
  // known outcome and takes the ordinary ladder.
  //
  // Parking that arm too was a defect, and the expensive kind: `replayed` is
  // `false` for EVERY fresh execution (`stripe.replayedFromResponse`), and a
  // fresh execution is the common reading of a transport failure — so one blip
  // plus one temporary decline froze the invoice open at rung zero, with the
  // ladder unspent, the `payment-unconfirmed` dedupe row suppressing the
  // overdue net, and no automatic path left that could ever charge it. "Never
  // charged by accident" and "never not charged" are both Allison's ruling; an
  // arm that trades all of the second for none of the first fails it.
  //
  // The doubt about the ORIGINAL request is not dropped by either arm — it was
  // never this function's to resolve. The webhook's orphan arms own it, and the
  // reconcile reason below keeps the trail on the row either way.
  if (!reissueLooksReplayed(intent, attempt)) {
    if (intent.status === 'succeeded') {
      return parkForHuman(withIntent, invoice, now, log, {
        arm: 'unconfirmed',
        outcome: 'parked-fresh-execution',
        reason: 'fresh-execution',
        message:
          'invoice attempt verify: the same-key re-issue EXECUTED instead of replaying AND captured — the key-window assumption did not hold, so a second charge may exist for this invoice; parked for human reconciliation, nothing settled from this pass',
      });
    }
    // Terminally dead or still in flight: nothing was captured, so there is no
    // duplicate to reconcile. Stamp WHY this attempt is worth a second look
    // anyway — a re-issue that executed is evidence about the key window, and
    // that evidence must outlive this log line — then let the ordinary
    // machinery below do its ordinary job.
    await withActor(WORKER_ACTOR, (tx) =>
      invoiceChargeAttemptsRepository.recordReconcileReason(tx, {
        id: attempt.id,
        reason: 'fresh-execution',
      }),
    );
    log.warn(
      {
        attemptId: attempt.id,
        invoiceId: invoice.id,
        paymentIntentId: intent.id,
        stripeIntentStatus: intent.status,
      },
      "invoice attempt verify: the same-key re-issue EXECUTED instead of replaying, but captured nothing — resolving it as this attempt's own outcome",
    );
  }

  return applyVerifiedIntent(withIntent, invoice, intent, stripe, now, log, {
    inFlightOutcome: 'reissued-in-flight',
  });
}

/**
 * Did Stripe answer this re-issue from its idempotency record, or execute it?
 *
 * Two independent signals, checked in order of authority:
 *
 *   1. **The replay response header**, which Stripe sets on exactly this
 *      condition. When the seam could read it, it is the answer. Live Stripe
 *      sends it as `idempotent-replayed`, not the documented
 *      `Idempotency-Replayed` (measured 2026-08-13, round 4) — until then the
 *      seam read only the documented spellings, so signal 1 never fired and
 *      this function was in truth a one-signal heuristic. It answered the
 *      common case correctly, which is why nothing went red.
 *   2. **The intent's own `created`.** The attempt row is written immediately
 *      before the original confirm, so a replayed intent was created back then;
 *      one created a verify interval later was executed by THIS call. The
 *      {@link FRESH_EXECUTION_GRACE_MINUTES} tolerance covers the seconds
 *      between the row and the original request.
 *
 * With neither signal readable the answer is "no" — deliberately. This function
 * exists because the code could not tell the two apart, and an unreadable
 * answer is not the same as a reassuring one; the caller's response to "no" is
 * to fetch a human, which is the correct response to "we cannot tell".
 *
 * NOTE what this does NOT mean: a fresh execution is not proof of a double
 * charge. Its benign reading — the original never reached Stripe, so this call
 * IS attempt N happening — is the common one, and remains the design's intent.
 * But the two readings are indistinguishable from here and only one of them is
 * survivable, so this lane stops rather than guesses.
 */
export function reissueLooksReplayed(
  intent: StripePaymentIntentResult,
  attempt: Pick<InvoiceChargeAttemptRow, 'createdAt'>,
): boolean {
  if (intent.replayed !== undefined) return intent.replayed;
  if (intent.createdAt === undefined) return false;
  const graceMs = FRESH_EXECUTION_GRACE_MINUTES * 60 * 1000;
  return intent.createdAt.getTime() <= pgTimestampToDate(attempt.createdAt).getTime() + graceMs;
}

/**
 * The one place a verified intent's status becomes a decision — shared by the
 * retrieve arm and the re-issue arm so the two cannot drift.
 */
async function applyVerifiedIntent(
  attempt: InvoiceChargeAttemptRow,
  invoice: InvoiceRow,
  intent: StripePaymentIntentResult,
  stripe: StripeClient,
  now: Date,
  log: WorkerLogger,
  opts: { inFlightOutcome: 'still-processing' | 'reissued-in-flight' },
): Promise<InvoiceAttemptVerifyResult> {
  if (intent.status === 'succeeded') {
    // The webhook may already have settled this (it races us by design and
    // that is fine — whoever gets there first wins). If a charges row exists
    // for this PI, the money is on the books; just close the attempt.
    if (await closeIfAlreadyOnTheBooks(attempt, invoice, intent.id, log)) {
      return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'settled' };
    }
    // The money moved and nothing here knew. Settle it through the SAME
    // primitive as every other settle path, which means the owner gets the
    // receipt (the promise the unconfirmed push made) and, if they paid
    // manually in the meantime, the duplicate comes back automatically.
    let settled: Awaited<ReturnType<typeof settleAttempt>>;
    try {
      settled = await settleAttempt({
        invoice,
        attemptId: attempt.id,
        paymentIntentId: intent.id,
        amountCents: intent.amountCents,
        stripe,
        log,
        now,
      });
    } catch (err) {
      // The other half of the check above, for the window the check cannot
      // cover: the webhook's `charges` INSERT committed between our read and
      // ours. `charges.stripe_payment_intent_id` is UNIQUE, so the loser of
      // that race is a 23505 — which is the DB telling us the money IS on the
      // books, by the other path. That is the FLIP ARM, not an error: the
      // settle tx rolled back whole, so re-reading and closing the attempt is
      // the complete response. Anything else here throws out of the batch over
      // a race the design deliberately allows.
      if (!isUniqueViolation(err)) throw err;
      if (!(await closeIfAlreadyOnTheBooks(attempt, invoice, intent.id, log))) throw err;
      return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'settled' };
    }
    log.info(
      {
        attemptId: attempt.id,
        invoiceId: invoice.id,
        paymentIntentId: intent.id,
        settleOutcome: settled.outcome,
      },
      'invoice attempt verify: late settle of an attempt whose outcome was unknown',
    );
    return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'settled' };
  }

  const blocker = chargeBlockerForConfirm(intent, log);

  if (blocker === 'processing') {
    const ageMs = now.getTime() - pgTimestampToDate(attempt.createdAt).getTime();
    if (ageMs > IN_FLIGHT_PARK_AFTER_HOURS * 60 * 60 * 1000) {
      return parkForHuman(attempt, invoice, now, log, {
        arm: 'in-flight',
        outcome: 'parked-in-flight',
        reason: 'in-flight-cap',
        message:
          'invoice attempt verify: intent has been processing past the cap — parked for human reconciliation; owner told it is still in flight',
      });
    }
    await withActor(WORKER_ACTOR, (tx) =>
      invoiceChargeAttemptsRepository.resolve(tx, {
        id: attempt.id,
        outcome: 'processing',
        stripePaymentIntentId: intent.id,
      }),
    );
    return { attemptId: attempt.id, invoiceId: invoice.id, outcome: opts.inFlightOutcome };
  }

  // Terminally dead: the money definitively did not move on this attempt. Close
  // it and let the dunning ladder do its job — a fresh attempt (and a fresh
  // key) is CORRECT here, because we now know the previous one is dead. That
  // distinction — known-dead rotates, unknown never does — is the design.
  //
  // R15 FIRST, then the resolve (round 3 — the charge lane's order,
  // `invoiceAutoCharge.ts:424` before `:460`, and the two lanes must not
  // disagree about a money rule). Resolving is what OPENS the interlock: the
  // moment the attempt stops being unresolved, the charge lane may mint attempt
  // N+1 under a fresh key. The statuses that reach here include
  // `requires_action` / `requires_confirmation` — a live, still-confirmable
  // intent at Stripe — so cancelling after the interlock opens leaves a window
  // where a second key exists while the first intent could still settle.
  // Best-effort either way: a PI Stripe refuses to cancel is covered by the
  // key-scoped idempotency on the next attempt.
  try {
    await stripe.cancelPaymentIntent(intent.id);
  } catch (err) {
    log.warn(
      { attemptId: attempt.id, invoiceId: invoice.id, paymentIntentId: intent.id, err: errMsg(err) },
      'invoice attempt verify: could not cancel the dead PaymentIntent (best-effort)',
    );
  }

  // `resolve` is the RACE ARBITER (it filters on the row still being
  // unresolved), so its row count is the permission slip for everything below,
  // not a return value to discard. A webhook that resolved this attempt while
  // our retrieve was in flight has already ended it; advancing the ladder again
  // here would spend TWO of the four rungs on one decline and skip the +24h /
  // +72h retries that actually recover a temporarily-declined card — money that
  // would have been collected, quietly not collected.
  const resolved = await withActor(WORKER_ACTOR, (tx) =>
    invoiceChargeAttemptsRepository.resolve(tx, {
      id: attempt.id,
      outcome: 'no-charge',
      stripePaymentIntentId: intent.id,
    }),
  );
  if (resolved === 0) {
    log.info(
      { attemptId: attempt.id, invoiceId: invoice.id, paymentIntentId: intent.id },
      'invoice attempt verify: another path resolved this attempt first; ladder and notifications left to it',
    );
    return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'lost-resolve-race' };
  }

  // Re-read: the ladder count may have moved since this attempt was minted, and
  // the invoice may have been settled or voided while the outcome was unknown.
  const fresh = (await invoicesRepository.findById(db, invoice.id)) ?? invoice;
  if (fresh.status !== 'open') {
    log.info(
      { attemptId: attempt.id, invoiceId: invoice.id, status: fresh.status },
      'invoice attempt verify: attempt is dead and the invoice is no longer open; nothing to schedule',
    );
    return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'no-charge' };
  }
  // The date every sentence below is about: when this attempt was TRIED, which
  // on this lane can be a day before now.
  const attemptedAt = pgTimestampToDate(attempt.createdAt);
  if (fresh.nextAttemptAt === null) {
    // Already PARKED — by the in-flight or past-window arm, or at MAX attempts
    // — while its outcome was unknown. Scheduling a next attempt here would
    // silently un-park an invoice a human was told to look at and resume
    // auto-charging a card whose owner was just told "we'll let you know"; the
    // webhook's resolver has always got this right and this arm did not. Keep
    // the park, keep the ladder, and say the now-known answer once (the
    // `payment-failed:<id>` dedupe key is the "ever" in one push per invoice).
    //
    // **Gated on the WRITE, not on the re-read above** (round 4, 2026-08-13).
    // The `fresh.status !== 'open'` check is a read, and the manual-pay window
    // does not close while we hold it: an owner can settle this invoice in the
    // gap between that SELECT and this push, and then be told "your card was
    // declined — want to try a different form of payment?" while holding a
    // receipt. Every sibling arm gates its push on a row count from a write
    // filtered `status='open'` (`recordFailedAttempt` in `recordKnownFailure`
    // below, `parkForReconciliation` in `parkForHuman`); this one was the miss.
    // Re-parking an already-parked invoice is a no-op write —
    // `next_attempt_at` is already NULL — so it changes nothing and buys the
    // one thing a read cannot: the answer to "is this invoice still open?"
    // decided in the same statement that authorises the push.
    const { stillOpen, enqueued } = await withActor(WORKER_ACTOR, async (tx) => {
      const rows = await invoicesRepository.parkForReconciliation(tx, { id: fresh.id });
      if (rows === 0) return { stillOpen: false, enqueued: false };
      return {
        stillOpen: true,
        enqueued: await enqueueAutoChargeParkPush(tx, {
          invoice: fresh,
          arm: parkArmForBlocker(blocker),
          now,
          at: attemptedAt,
        }),
      };
    });
    if (!stillOpen) {
      log.info(
        { attemptId: attempt.id, invoiceId: invoice.id, paymentIntentId: intent.id, blocker },
        'invoice attempt verify: the invoice was settled or voided between the re-read and the push; the now-known failure was withheld from an owner who already paid',
      );
      return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'no-charge' };
    }
    log.info(
      { attemptId: attempt.id, invoiceId: invoice.id, paymentIntentId: intent.id, blocker, enqueued },
      'invoice attempt verify: attempt resolved as known-dead on an already-parked invoice; park kept, owner told the answer',
    );
    return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'no-charge' };
  }
  const nextAttemptAt = scheduleNextAttempt(fresh.autoChargeAttempts, now);
  // Its `status='open'` filter is the same guard as the re-read above, minus
  // the gap between them — and it is the one that actually holds, because it
  // runs in the write.
  const recorded = await recordKnownFailure({
    invoice: fresh,
    nextAttemptAt,
    now,
    at: attemptedAt,
    arm: parkArmForBlocker(blocker),
  });
  if (!recorded) {
    log.info(
      { attemptId: attempt.id, invoiceId: invoice.id, paymentIntentId: intent.id },
      'invoice attempt verify: the invoice was settled or voided between the re-read and the record write; ladder and push withheld',
    );
    return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'no-charge' };
  }
  log.info(
    {
      attemptId: attempt.id,
      invoiceId: invoice.id,
      paymentIntentId: intent.id,
      blocker,
      nextAttemptAt,
    },
    'invoice attempt verify: attempt resolved as known-dead; dunning ladder advanced',
  );
  return { attemptId: attempt.id, invoiceId: invoice.id, outcome: 'no-charge' };
}

/**
 * The end of the automatic road. Park the invoice (`next_attempt_at = NULL`, so
 * it stops being leased and surfaces on the staff worklist), stamp WHY on the
 * attempt row, and tell the owner the truth — WITHOUT advancing the dunning
 * ladder, because nothing failed.
 *
 * The attempt row is deliberately left unresolved: we still do not know what
 * happened to that money, and writing a terminal outcome would be inventing an
 * answer. It stops costing anything because `claimUnresolvedForVerify` will
 * stop claiming it (verify-count bound), and because a parked invoice can't be
 * leased by the charge lane. `reconcile_reason` is what makes the four park
 * arms tellable apart afterwards: in the invoice row they are identical, and
 * "Stripe rejected our own key" is not a fact that should live only in a log.
 *
 * **The push follows the PARK, not the call** (2026-08-12). `parkForReconciliation`
 * filters on `status = 'open'` and returns the row count, so zero means the
 * invoice was settled or voided while we were asking — and an owner who paid
 * manually during the doubt window must not then be told "we can't confirm your
 * payment, please don't pay it again" while holding a receipt.
 */
async function parkForHuman(
  attempt: InvoiceChargeAttemptRow,
  invoice: InvoiceRow,
  now: Date,
  log: WorkerLogger,
  opts: {
    arm: 'in-flight' | 'unconfirmed';
    outcome: InvoiceAttemptVerifyResult['outcome'];
    reason: InvoiceAttemptReconcileReason;
    message: string;
    err?: unknown;
  },
): Promise<InvoiceAttemptVerifyResult> {
  const { parked, enqueued } = await withActor(WORKER_ACTOR, async (tx) => {
    // Stamped even when the invoice has moved on: the attempt is still
    // unresolved, and why automation stopped is exactly what a human reading
    // this row later needs.
    await invoiceChargeAttemptsRepository.recordReconcileReason(tx, {
      id: attempt.id,
      reason: opts.reason,
    });
    const rows = await invoicesRepository.parkForReconciliation(tx, { id: invoice.id });
    if (rows === 0) return { parked: false, enqueued: false };
    return {
      parked: true,
      enqueued: await enqueueAutoChargeParkPush(tx, {
        invoice,
        arm: opts.arm,
        now,
        // The sentence is about when the charge was TRIED — the attempt row's
        // own birthday — not about when we gave up waiting for its answer.
        at: pgTimestampToDate(attempt.createdAt),
      }),
    };
  });
  const detail = {
    attemptId: attempt.id,
    invoiceId: invoice.id,
    attemptNo: attempt.attemptNo,
    idempotencyKey: attempt.idempotencyKey,
    paymentIntentId: attempt.stripePaymentIntentId,
    reconcileReason: opts.reason,
    stripeDashboardSearch: `metadata['invoice_id']:'${invoice.id}'`,
    ...(opts.err !== undefined ? { err: errMsg(opts.err) } : {}),
  };
  // Loud once, quiet after. The first pass to reach this arm is the incident;
  // later passes (until the verify-count bound retires the row) have nothing
  // new to report and must not bury the log.
  if (!parked) {
    log.warn(
      detail,
      'invoice attempt verify: the invoice is no longer open, so nothing was parked and the owner was told nothing — the attempt still carries its reconcile reason',
    );
  } else if (enqueued) {
    log.error(detail, opts.message);
  } else {
    log.info(detail, 'invoice attempt verify: already parked for human reconciliation');
  }
  return { attemptId: attempt.id, invoiceId: invoice.id, outcome: opts.outcome };
}

/**
 * "Is this PaymentIntent's money already recorded by another path?" — and if so,
 * close the attempt against it. Returns whether it was.
 *
 * Shared by the read that precedes the settle and the 23505 that can follow it,
 * because they are the same question asked either side of a race the design
 * allows on purpose (the webhook and this lane both settle orphans; whoever
 * gets there first wins). `resolve` filters on the row still being unresolved,
 * so a webhook that also closed the attempt makes this a no-op rather than a
 * double write.
 */
async function closeIfAlreadyOnTheBooks(
  attempt: InvoiceChargeAttemptRow,
  invoice: InvoiceRow,
  paymentIntentId: string,
  log: WorkerLogger,
): Promise<boolean> {
  const existing = await withActor(WORKER_ACTOR, (tx) =>
    chargesRepository.findByStripePaymentIntentId(tx, paymentIntentId),
  );
  if (existing === undefined) return false;
  await withActor(WORKER_ACTOR, (tx) =>
    invoiceChargeAttemptsRepository.resolve(tx, {
      id: attempt.id,
      outcome: 'succeeded',
      stripePaymentIntentId: paymentIntentId,
    }),
  );
  log.info(
    { attemptId: attempt.id, invoiceId: invoice.id, paymentIntentId, chargeId: existing.id },
    'invoice attempt verify: money already recorded by another path; attempt closed',
  );
  return true;
}

/** A Postgres unique violation (SQLSTATE 23505), as `pg` surfaces it. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
