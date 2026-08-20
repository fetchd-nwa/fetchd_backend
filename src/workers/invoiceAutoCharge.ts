import { deepLinkToPath } from '../contracts/wire.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import {
  invoicesRepository,
  repointPaymentMethod,
  type InvoiceRow,
} from '../db/repositories/invoicesRepository.js';
import { invoiceChargeAttemptsRepository } from '../db/repositories/invoiceChargeAttemptsRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { stripeCustomersRepository } from '../db/repositories/stripeCustomersRepository.js';
import { withActor, type Tx } from '../db/tx.js';
import { invalidatePattern } from '../lib/cache.js';
import {
  autoChargeParkNotification,
  type AutoChargeParkArm,
} from '../lib/autoChargeNotificationCopy.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import { firePendingRefundPostCommit } from '../lib/pendingRefund.js';
import { settleInvoiceCharge } from '../lib/settleInvoiceCharge.js';
import {
  chargeBlockerForConfirm,
  defaultStripeClient,
  type StripeClient,
  type StripePaymentIntentResult,
} from '../lib/stripe.js';
import { db } from '../db/client.js';

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Invoice auto-charge worker (Day 15; lease refactor 2026-06-18; the
 * unknown-outcome protocol 2026-08-12,
 * `designs/auto-charge-unknown-outcome.md`). One-shot function — the Day-16
 * scheduler composes it into the recurring tick.
 *
 * **No Stripe call ever runs inside a DB transaction.** The tick is:
 *
 *   1. **Claim tx (short).** `leaseDueOpen` locks a batch of due open invoices
 *      (`FOR UPDATE SKIP LOCKED`) and pushes their `next_attempt_at` to a lease
 *      horizon, then commits.
 *   2. **Per invoice, OUTSIDE any tx:** refuse outright if an earlier attempt
 *      is still UNRESOLVED (below); otherwise read the bound card + Stripe
 *      customer, MINT the attempt row in a short tx, then confirm with THAT
 *      row's idempotency key and its frozen params.
 *   3. **Record tx (short).** Settle, or resolve the attempt as known-dead and
 *      advance the dunning ladder, or leave the doubt on the books.
 *
 * **The thing this worker gets right since 2026-08-12, and got wrong before.**
 * Stripe's idempotency key used to be `auto-charge:{id}:{auto_charge_attempts}`,
 * and the transport catch — the arm that exists *precisely because we do not
 * know whether money moved* — called `recordFailed`, which incremented that
 * counter, which MINTED A NEW KEY. So the next tick created a brand-new
 * PaymentIntent for a charge that may already have succeeded. The two jobs are
 * now split:
 *
 *   - `invoices.auto_charge_attempts` = the dunning ladder ONLY. It advances on
 *     a KNOWN-failed attempt (declined / authentication-required / a cancelled
 *     intent) and on the no-card / no-Stripe-customer parks.
 *   - `invoice_charge_attempts.attempt_no` = the Stripe key identity. It
 *     advances only when the previous attempt is known-dead. An unknown outcome
 *     keeps its key, so a re-issue replays the first outcome instead of
 *     charging again.
 *
 * Three rules follow, and they are the whole safety story:
 *
 *   - **Never charge while an attempt is unresolved.** The lane refuses, and a
 *     partial unique index (`invoice_charge_attempts_unresolved_uq`) makes the
 *     refusal survive a code regression.
 *   - **Never mint a key on "we don't know".** The transport catch records
 *     nothing, notifies nobody, and stops. The attempt row — written BEFORE the
 *     Stripe call — is the record that we don't know. `invoiceAttemptVerify.ts`
 *     owns it from there.
 *   - **Never say more than we know.** The park push is a taxonomy
 *     (`lib/autoChargeNotificationCopy.ts`), and the two arms covering money
 *     that may be in flight do not invite a retry.
 *
 * Crash safety: a worker that dies between the Stripe call and the record tx
 * leaves an attempt row at `pending` and the lease to expire. The re-lease
 * REFUSES to charge (there is an unresolved attempt) and the verify lane
 * resolves it under the SAME key — which is what the pre-2026-08-12 version of
 * this comment claimed was already true and wasn't.
 *
 * Returns a summary so the caller (CLI / test) can log a tick report.
 */

const WORKER_ACTOR = 'system:stripe-webhook';

/** Hard cap on dunning attempts before the invoice parks. Day-16 scheduler
 *  will tune from a config knob; today matches Stripe's smart-retry default. */
export const MAX_AUTO_CHARGE_ATTEMPTS = 4;

/** How long a claimed invoice is reserved (its `next_attempt_at` is pushed
 *  this far out) while the worker does the Stripe round-trip with no tx open.
 *  Comfortably longer than a Stripe call (~30s) so a healthy worker always
 *  records before the lease lapses; short enough that a crashed worker's
 *  invoices retry promptly. */
export const LEASE_MINUTES = 5;

/** Backoff schedule (in minutes) per attempt index — 1, 60, 24h, 72h.
 *  attempt 0 → next at +1m  (fast retry for transient blips)
 *  attempt 1 → next at +1h
 *  attempt 2 → next at +24h
 *  attempt 3 → next at +72h, then park */
const BACKOFF_MINUTES = [1, 60, 60 * 24, 60 * 72];

export interface InvoiceAutoChargeOpts {
  stripe?: StripeClient;
  /** Per-tick batch size. Default 50; tests pin to 1 for determinism. */
  limit?: number;
  /** "Now" for the cutoff scan + the backoff base. Tests pin a fixed instant. */
  now?: Date;
  /** Optional logger — defaults to a no-op so the CLI/test variants don't spam. */
  log?: WorkerLogger;
}

export interface InvoiceAutoChargeAttemptResult {
  invoiceId: string;
  outcome:
    | 'paid'
    | 'failed-retry-scheduled'
    | 'failed-parked'
    | 'skipped-pm-missing'
    | 'skipped-customer-missing'
    // The invoice was already settled (or voided) by a concurrent path. Either
    // the pre-charge re-check saw it, in which case no Stripe call was made; or
    // the record write's own `status='open'` filter did, in which case the card
    // was asked and said no but the debt was gone by the time we could write it
    // down — so no rung was spent and the owner was told nothing.
    | 'skipped-already-settled'
    // An earlier attempt's outcome is still unknown. Charging now could be the
    // second charge for one debt, so this lane refuses and the verify lane
    // owns the invoice until the doubt is resolved. No Stripe call was made.
    | 'skipped-unresolved-attempt'
    // The Stripe call left us not knowing whether money moved (transport). The
    // attempt row stays `pending` — that IS the record — and NOTHING here
    // counts it as a failure or rotates its key.
    | 'unknown-outcome-pending'
    // Stripe accepted it and the money is in flight; the cancel was refused, so
    // the intent may still settle. The ladder is untouched — nothing declined.
    | 'in-flight-pending';
  chargeId?: string;
  nextAttemptAt?: string | null;
  /** The `invoice_charge_attempts` row this outcome is about — the one this
   *  tick minted, or (on `skipped-unresolved-attempt`) the one it refused
   *  to charge past. */
  attemptId?: string;
}

export interface InvoiceAutoChargeTickResult {
  scanned: number;
  results: InvoiceAutoChargeAttemptResult[];
}

const NOOP_LOG: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Run one tick. Claims a batch in a short tx, then processes each invoice
 * with the Stripe call OUTSIDE any transaction. Safe to call concurrently —
 * `leaseDueOpen` uses `FOR UPDATE SKIP LOCKED` + a lease so each invoice is
 * owned by exactly one worker per lease window.
 */
export async function runInvoiceAutoChargeOnce(
  opts: InvoiceAutoChargeOpts = {},
): Promise<InvoiceAutoChargeTickResult> {
  const stripe = opts.stripe ?? defaultStripeClient;
  const log = opts.log ?? NOOP_LOG;
  const now = opts.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MINUTES * 60 * 1000);

  // Claim tx: lease the batch, release the row locks on commit.
  const leased = await withActor(WORKER_ACTOR, (tx) =>
    invoicesRepository.leaseDueOpen(tx, { limit: opts.limit, now, leaseUntil }),
  );
  log.info(
    { workerTick: 'invoice-auto-charge', batchSize: leased.length },
    'invoice auto-charge tick claimed batch',
  );

  // Process each leased invoice with no tx open across the Stripe call.
  const results: InvoiceAutoChargeAttemptResult[] = [];
  for (const invoice of leased) {
    results.push(await processOne(invoice, stripe, now, log));
  }
  return { scanned: results.length, results };
}

/**
 * Process one leased invoice: pool reads → attempt mint → Stripe (no tx) →
 * short record tx. Never holds a transaction open across the Stripe round-trip.
 */
async function processOne(
  invoice: InvoiceRow,
  stripe: StripeClient,
  now: Date,
  log: WorkerLogger,
): Promise<InvoiceAutoChargeAttemptResult> {
  // ── THE REFUSAL ────────────────────────────────────────────────────────────
  // An attempt whose outcome we never learned may already have taken the
  // owner's money. Minting a second attempt for the same debt is the double
  // charge, so this lane will not do it — it leaves the lease to lapse (at most
  // one skipped lease window per verify interval) and lets
  // `invoiceAttemptVerify` resolve the doubt. This check is the polite version;
  // the DB's partial unique index on (invoice_id) WHERE outcome IN
  // ('pending','processing') is the one that holds when the code is wrong.
  const unresolved = await invoiceChargeAttemptsRepository.findUnresolvedForInvoice(db, invoice.id);
  if (unresolved !== undefined) {
    log.warn(
      {
        invoiceId: invoice.id,
        attemptId: unresolved.id,
        attemptNo: unresolved.attemptNo,
        attemptOutcome: unresolved.outcome,
        paymentIntentId: unresolved.stripePaymentIntentId,
      },
      'invoice auto-charge: an earlier attempt is unresolved; refusing to charge until it resolves',
    );
    return {
      invoiceId: invoice.id,
      outcome: 'skipped-unresolved-attempt',
      attemptId: unresolved.id,
    };
  }

  // Pool reads — no tx needed; the lease already reserved the row.
  // Resolve the card to charge rather than blindly using the invoice's bound
  // one: if that card has passed its printed expiry, fall through to the next
  // live card in the owner's wallet order (Allison 2026-07-29). Charging a
  // calendar-dead card just burns a dunning attempt and ends in a decline.
  const pm = await paymentMethodsRepository.resolveChargeableForOwner(
    { ownerId: invoice.ownerId, preferredId: invoice.paymentMethodId },
    db,
  );
  if (pm === undefined) {
    log.warn(
      { invoiceId: invoice.id, paymentMethodId: invoice.paymentMethodId },
      'invoice auto-charge: no chargeable card on file; parking invoice',
    );
    // ZERO Stripe calls were made here, which is why this arm gets its own
    // sentence: the old copy told the owner "we tried your payment", which was
    // simply false. `at` is the DUE date for the same reason — nothing was
    // attempted, so "was due <today>" (the park date) would be a second false
    // sentence in the same push.
    const recorded = await recordKnownFailure({
      invoice,
      nextAttemptAt: null,
      now,
      at: pgTimestampToDate(invoice.dueAt),
      arm: 'no-card-on-file',
    });
    if (!recorded) return settledUnderUs(invoice, log, 'no-card-on-file');
    return { invoiceId: invoice.id, outcome: 'skipped-pm-missing', nextAttemptAt: null };
  }
  const didFallBack = pm.id !== invoice.paymentMethodId;
  if (didFallBack) {
    log.info(
      { invoiceId: invoice.id, boundPaymentMethodId: invoice.paymentMethodId, chargingId: pm.id },
      'invoice auto-charge: bound card is past expiry; falling back to the next card on file',
    );
  }

  const customer = await stripeCustomersRepository.findByOwner(db, invoice.ownerId);
  if (customer === undefined) {
    log.warn(
      { invoiceId: invoice.id, ownerId: invoice.ownerId },
      'invoice auto-charge: stripe_customers row missing; parking invoice',
    );
    const recorded = await recordKnownFailure({
      invoice,
      nextAttemptAt: null,
      now,
      // Zero Stripe calls here too — the due date, not the park date.
      at: pgTimestampToDate(invoice.dueAt),
      arm: 'stripe-customer-missing',
    });
    if (!recorded) return settledUnderUs(invoice, log, 'stripe-customer-missing');
    return { invoiceId: invoice.id, outcome: 'skipped-customer-missing', nextAttemptAt: null };
  }

  // Cheap pre-Stripe re-check: the lease scooped this row as open, but a
  // concurrent manual `POST /invoices/:id/pay` (or a webhook) may have settled
  // it during the lease window. Re-read and bail BEFORE charging to shrink the
  // double-charge window (mirrors the manual route's pre-Stripe `status ===
  // 'open'` guard). This is an optimization, NOT the guarantee: the conditional
  // `markPaid` claim in `settleInvoiceCharge` + the lost-race refund close the
  // residual window where both paths pass their re-check then both charge.
  const fresh = await invoicesRepository.findByIdForOwner(db, {
    id: invoice.id,
    ownerId: invoice.ownerId,
  });
  if (fresh === undefined || fresh.status !== 'open') {
    log.info(
      { invoiceId: invoice.id, status: fresh?.status ?? 'gone' },
      'invoice auto-charge: invoice no longer open at pre-charge re-check; skipping',
    );
    return { invoiceId: invoice.id, outcome: 'skipped-already-settled' };
  }

  // ── The attempt row, written BEFORE Stripe hears about it ──────────────────
  // Short tx of its own (R5). It carries the idempotency key this confirm must
  // use and the params a later re-issue must resend byte-for-byte; a process
  // that dies on the next line leaves `pending`, which is the honest state.
  //
  // The unique violation this can raise is the INTERLOCK DOING ITS JOB — a
  // concurrent worker won the lease race, or an unresolved attempt appeared
  // between the refusal check above and here. Both mean exactly "do not
  // charge", which is this lane's `skipped-unresolved-attempt` outcome, so it
  // is caught HERE rather than thrown out of the tick: `runSchedulerTickOnce`
  // would otherwise lose every remaining leased invoice AND the phases after it
  // (media derivatives, credit expiry, the idempotency sweep), every minute,
  // for as long as the condition held. Nothing else is swallowed.
  let attempt: Awaited<ReturnType<typeof invoiceChargeAttemptsRepository.mint>>;
  try {
    attempt = await withActor(WORKER_ACTOR, (tx) =>
      invoiceChargeAttemptsRepository.mint(tx, {
        invoiceId: invoice.id,
        autoChargeAttempts: invoice.autoChargeAttempts,
        paymentMethodId: pm.id,
        stripePaymentMethodId: pm.stripePaymentMethodId,
        stripeCustomerId: customer.stripeCustomerId,
        amountCents: invoice.amountCents,
      }),
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    log.warn(
      { invoiceId: invoice.id, constraint: uniqueViolationConstraint(err), err: errMsg(err) },
      'invoice auto-charge: attempt mint hit a unique violation (the DB interlock) — treating as an unresolved attempt and charging nothing',
    );
    return { invoiceId: invoice.id, outcome: 'skipped-unresolved-attempt' };
  }

  let intent: StripePaymentIntentResult;
  try {
    intent = await stripe.createAndConfirmPaymentIntent(
      {
        customerId: customer.stripeCustomerId,
        paymentMethodId: attempt.stripePaymentMethodId,
        amountCents: attempt.amountCents,
        currency: 'usd',
        metadata: {
          owner_id: invoice.ownerId,
          invoice_id: invoice.id,
          purpose: invoice.purpose,
          // The ATTEMPT number, not the ladder count. Metadata is part of the
          // idempotent request hash, so stamping the mutable counter here meant
          // that even a correct same-key retry would have been rejected by
          // Stripe — the key reuse this design depends on could not have
          // worked while this line read `invoice.autoChargeAttempts`.
          auto_charge_attempt: String(attempt.attemptNo),
        },
      },
      attempt.idempotencyKey,
    );
  } catch (err) {
    // ── THE ARM THIS WHOLE DESIGN EXISTS FOR ─────────────────────────────────
    // TRANSPORT errors only, since wire 1.9.0: connection / API / rate-limit /
    // auth / idempotency failures, where we DO NOT KNOW whether money moved. A
    // declined card never arrives here (the seam normalizes a thrown card error
    // into the returning fork's result).
    //
    // So: record nothing, notify nobody, rotate nothing, and STOP. The attempt
    // row stays `pending` and the verify lane resolves it under the SAME key.
    // The old code called `recordFailed` here, which advanced the ladder, which
    // rotated the idempotency key, which is how "we don't know" became "charge
    // them again".
    log.error(
      {
        invoiceId: invoice.id,
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        idempotencyKey: attempt.idempotencyKey,
        err: errMsg(err),
      },
      'invoice auto-charge: Stripe call failed with an UNKNOWN outcome (transport) — attempt left pending for the verify lane; ladder and key untouched',
    );
    return {
      invoiceId: invoice.id,
      outcome: 'unknown-outcome-pending',
      attemptId: attempt.id,
    };
  }

  // An id is knowledge: persist it before deciding anything, so that even if
  // this process dies on the next line the verify lane can RETRIEVE rather than
  // guess.
  await withActor(WORKER_ACTOR, (tx) =>
    invoiceChargeAttemptsRepository.recordPaymentIntentId(tx, {
      id: attempt.id,
      stripePaymentIntentId: intent.id,
    }),
  );

  if (intent.status === 'succeeded') {
    const settled = await settleAttempt({
      invoice,
      attemptId: attempt.id,
      paymentIntentId: intent.id,
      amountCents: intent.amountCents,
      stripe,
      log,
      now,
      ...(didFallBack ? { settledByPaymentMethodId: pm.id } : {}),
    });
    return {
      invoiceId: invoice.id,
      outcome: 'paid',
      chargeId: settled.chargeId,
      attemptId: attempt.id,
    };
  }

  // Non-settled. `chargeBlockerForConfirm` is the ONE derivation of what
  // stopped it — `processing` (money may be moving) vs a card-level dead end —
  // and it returns undefined only for `succeeded`, handled above.
  const blocker = chargeBlockerForConfirm(intent, log);

  // R15: cancel the unsettled PI so it can't later auto-succeed and
  // double-charge against a future attempt. Best-effort — and on the
  // `processing` arm its SUCCESS is load-bearing, not cosmetic: a PI Stripe
  // agreed to cancel is a PI that definitively took no money.
  let cancelled = false;
  try {
    await stripe.cancelPaymentIntent(intent.id);
    cancelled = true;
  } catch (err) {
    log.warn(
      { invoiceId: invoice.id, paymentIntentId: intent.id, err: errMsg(err) },
      'invoice auto-charge: could not cancel unsettled PaymentIntent (best-effort)',
    );
  }

  if (blocker === 'processing' && !cancelled) {
    // The money is in flight and Stripe would not stop it. NOTHING declined, so
    // the dunning ladder is not touched — counting this as a dunning failure is
    // how an in-flight payment used to end with the owner reading "it didn't go
    // through" and paying a second time. The verify lane owns it now.
    await withActor(WORKER_ACTOR, (tx) =>
      invoiceChargeAttemptsRepository.resolve(tx, {
        id: attempt.id,
        outcome: 'processing',
        stripePaymentIntentId: intent.id,
      }),
    );
    log.warn(
      {
        invoiceId: invoice.id,
        attemptId: attempt.id,
        paymentIntentId: intent.id,
        stripeIntentStatus: intent.status,
      },
      'invoice auto-charge: intent is still processing and could not be cancelled — ladder untouched, verify lane owns it',
    );
    return { invoiceId: invoice.id, outcome: 'in-flight-pending', attemptId: attempt.id };
  }

  // Known-dead: the card said no, or an in-flight intent was successfully
  // cancelled (money definitively stopped — strictly better than the old
  // behavior, which counted an uncancellable in-flight intent as a decline).
  await withActor(WORKER_ACTOR, (tx) =>
    invoiceChargeAttemptsRepository.resolve(tx, {
      id: attempt.id,
      outcome: 'no-charge',
      stripePaymentIntentId: intent.id,
    }),
  );
  const nextAttemptAt = scheduleNextAttempt(invoice.autoChargeAttempts, now);
  const recorded = await recordKnownFailure({
    invoice,
    nextAttemptAt,
    now,
    // The charge just happened, so here — and only here — the park date IS the
    // attempt date.
    at: now,
    arm: parkArmForBlocker(blocker),
  });
  // The attempt above is still correctly resolved `no-charge` — this card
  // really did say no, and that fact is not in doubt. What changed under us is
  // the DEBT: someone settled the invoice while we were mid-round-trip, so
  // there is no ladder left to advance and nothing true to tell the owner.
  if (!recorded) return settledUnderUs(invoice, log, parkArmForBlocker(blocker), attempt.id);
  return {
    invoiceId: invoice.id,
    outcome: nextAttemptAt === null ? 'failed-parked' : 'failed-retry-scheduled',
    nextAttemptAt,
    attemptId: attempt.id,
  };
}

/**
 * The invoice stopped being open while this tick worked it, so
 * `recordFailedAttempt`'s `status='open'` filter matched nothing: no rung was
 * spent and no push was enqueued. Report that rather than the outcome this arm
 * set out to produce — "failed-parked" about an invoice that is neither failed
 * nor parked is the class of lie the whole round is about.
 */
function settledUnderUs(
  invoice: InvoiceRow,
  log: WorkerLogger,
  arm: AutoChargeParkArm,
  attemptId?: string,
): InvoiceAutoChargeAttemptResult {
  log.info(
    { invoiceId: invoice.id, arm, ...(attemptId !== undefined ? { attemptId } : {}) },
    'invoice auto-charge: the invoice was settled or voided during this attempt; dunning ladder and park push withheld',
  );
  return {
    invoiceId: invoice.id,
    outcome: 'skipped-already-settled',
    ...(attemptId !== undefined ? { attemptId } : {}),
  };
}

/** A Postgres unique violation (SQLSTATE 23505), as `pg` surfaces it. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function uniqueViolationConstraint(err: unknown): string | undefined {
  const constraint = (err as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

/**
 * Which park sentence a known-dead attempt earns. `declined` and
 * `authentication_required` are the two the owner can act on differently, so
 * they get their own copy; anything else falls to the honest generic —
 * Allison's shipped 2026-08-01 sentence, which is exactly "it failed and we
 * can't tell you more".
 *
 * `processing` reaches here only when the cancel SUCCEEDED (an in-flight intent
 * we stopped), and the generic is right for it: nothing about the card was
 * wrong, and the money definitively did not move.
 */
export function parkArmForBlocker(
  blocker: ReturnType<typeof chargeBlockerForConfirm>,
): AutoChargeParkArm {
  switch (blocker) {
    case 'declined':
      return 'declined';
    case 'authentication_required':
      return 'authentication-required';
    default:
      return 'failed-unknown-reason';
  }
}

/**
 * Settle a SUCCEEDED attempt: one short tx via the shared `settleInvoiceCharge`
 * primitive (INSERT the charge + the atomic open→paid claim + the receipt), with
 * the attempt row resolved to `succeeded` in that SAME tx — so an attempt can
 * never read `pending` while its money is on the books, and a rolled-back settle
 * can never leave a resolved attempt behind.
 *
 * On a LOST settle race (a concurrent manual `/pay` flipped the invoice first)
 * the primitive wrote a 'pending' refund row for this duplicate charge and we
 * fire the Stripe refund POST-COMMIT — no Stripe call inside a tx, and a
 * refund-API failure leaves the 'pending' row for the webhook's race-recovery
 * rather than a silent double charge.
 *
 * Shared with `invoiceAttemptVerify`, which settles the same way when a
 * retrieve or a key replay reveals that the money moved after all — the late
 * settle is what makes the unconfirmed push's promise ("if it went through
 * you'll get a receipt") mechanically true.
 */
export async function settleAttempt(args: {
  invoice: InvoiceRow;
  /** The `invoice_charge_attempts` row to resolve, if one exists (pre-deploy
   *  orphans have none — the settle stands on its own). */
  attemptId?: string;
  paymentIntentId: string;
  amountCents: number;
  stripe: StripeClient;
  log: WorkerLogger;
  now: Date;
  /** Set when the charge fell back off the invoice's bound card — the invoice
   *  is rebound to it in the SAME tx so `settled_card` names what actually
   *  paid (see `repointPaymentMethod`). */
  settledByPaymentMethodId?: string;
}): Promise<{ chargeId: string; outcome: 'settled' | 'refunded' }> {
  const { invoice, stripe, log, now } = args;
  const result = await withActor(WORKER_ACTOR, async (tx) => {
    if (args.settledByPaymentMethodId !== undefined) {
      await repointPaymentMethod(tx, {
        id: invoice.id,
        paymentMethodId: args.settledByPaymentMethodId,
      });
    }
    const settled = await settleInvoiceCharge(tx, {
      invoice,
      paymentIntentId: args.paymentIntentId,
      amountCents: args.amountCents,
      purpose: invoice.purpose,
      notifyOwner: true,
      now,
    });
    if (args.attemptId !== undefined) {
      await invoiceChargeAttemptsRepository.resolve(tx, {
        id: args.attemptId,
        outcome: 'succeeded',
        stripePaymentIntentId: args.paymentIntentId,
      });
    }
    return settled;
  });

  if (result.outcome === 'refunded') {
    await firePendingRefundPostCommit({
      pending: result.pendingStripeRefund,
      stripe,
      log,
      // Shared by the charge lane and the verify lane, so the log names the
      // SETTLE PATH rather than one of its callers — a refund that failed
      // during a late verify settle must not read as an auto-charge refund.
      context: { invoiceId: invoice.id, settlePath: 'invoice-attempt-settle' },
    });
  } else if (invoice.purpose === 'membership' && invoice.dogId !== null) {
    // §J.1: the winning settle granted the month's credit lot inside the tx
    // — drop the per-dog credit cache (§3 map). Best-effort, post-commit,
    // mirroring the withMutation swallow-and-log policy: the cache self-heals
    // via TTL and the DB grant already landed.
    try {
      await invalidatePattern(`credits:${invoice.dogId}:*`);
    } catch (err) {
      log.warn(
        { invoiceId: invoice.id, dogId: invoice.dogId, err: errMsg(err) },
        'invoice auto-charge: membership-grant credits cache wipe failed (TTL self-heals)',
      );
    }
  }
  return { chargeId: result.chargeId, outcome: result.outcome };
}

/**
 * Short record tx for a KNOWN failure: increment the dunning ladder +
 * reschedule (or `null` to park). When the invoice PARKS (`nextAttemptAt ===
 * null` — the terminal state at MAX attempts, or a missing card/customer),
 * enqueue ONE push inside the SAME tx. NOTIFY-ON-PARK-ONLY is the anti-spam
 * invariant: an intermediate retry never notifies, so the owner hears once —
 * when there's nothing left to retry and they must act. Co-locating the enqueue
 * with the status flip means a notification is never emitted for an attempt
 * that rolls back.
 *
 * **Only KNOWN failures reach here** (2026-08-12). An unknown outcome must not
 * advance this counter, both because it isn't a decline and because the counter
 * used to be the Stripe key's suffix — see the module doc.
 *
 * **And only OPEN invoices** (round 3). `recordFailedAttempt` filters on
 * `status='open'` and its row count gates the push, so an invoice the owner
 * settled during the Stripe round-trip neither spends a dunning rung nor hears
 * "your card was declined — want to try a different form of payment?" while
 * they hold a receipt. Returns whether the failure was recorded, so the caller
 * can report what actually happened instead of what it set out to do.
 */
export async function recordKnownFailure(args: {
  invoice: InvoiceRow;
  nextAttemptAt: string | null;
  now: Date;
  /** The instant the SENTENCE is about — see {@link enqueueAutoChargeParkPush}.
   *  Never defaulted to `now`: on the verify lane the attempt being reported
   *  can be a day old, and on the zero-Stripe-call arms nothing was attempted
   *  at all. */
  at: Date;
  arm: AutoChargeParkArm;
}): Promise<boolean> {
  const { invoice, nextAttemptAt, now, at, arm } = args;
  return withActor(WORKER_ACTOR, async (tx) => {
    const recorded = await invoicesRepository.recordFailedAttempt(tx, {
      id: invoice.id,
      nextAttemptAt,
    });
    if (recorded === 0) return false; // no longer open — say nothing, count nothing
    if (nextAttemptAt !== null) return true; // retry scheduled — do NOT notify (anti-spam)
    await enqueueAutoChargeParkPush(tx, { invoice, arm, now, at });
    return true;
  });
}

/**
 * Enqueue the owner-facing park push for one arm of the taxonomy, inside the
 * caller's tx.
 *
 * A parked invoice is ACTION-REQUIRED (or, on the two unknown arms,
 * REASSURANCE-REQUIRED), so it goes out via the PUSH channel: a
 * `scheduled_notifications` row with `scheduled_for = now`, which the
 * scheduler's delivery phase turns into a feed row + an Expo push on its next
 * tick. The dedupe key (from the copy module — `payment-failed:<id>` or
 * `payment-unconfirmed:<id>`) is the "one push per invoice per class, ever"
 * floor. The two keys are distinct on purpose: an invoice can honestly say "we
 * don't know yet" and, later, "it failed", and each must be able to land once.
 *
 * No copy lives here. Every string comes from `autoChargeParkNotification` so
 * that shortening the wording later is a one-file edit.
 *
 * **`at` and `now` are two different instants and the caller must say which is
 * which** (2026-08-12). `now` is when the push goes out; `at` is what the
 * SENTENCE is about — when the charge was attempted, or when the invoice fell
 * due on the arms that attempted nothing. They coincide only in the charge
 * lane. This used to be hardcoded to `now`, so every verify-lane park named the
 * date the doubt EXPIRED rather than the date the charge was tried: the
 * in-flight arm fires at 24h and so said "started on <date>" always at least a
 * day late, the past-window arm was wrong whenever the window crossed a Chicago
 * midnight, and the no-card arm said "was due <today>" about an invoice that
 * fell due whenever it fell due. Allison's 2026-08-01 ruling was to name WHEN
 * it was tried; a date that is reliably wrong is not naming it.
 */
export async function enqueueAutoChargeParkPush(
  tx: Tx,
  args: { invoice: InvoiceRow; arm: AutoChargeParkArm; now: Date; at: Date },
): Promise<boolean> {
  const { invoice, arm, now, at } = args;
  const copy = autoChargeParkNotification(arm, {
    invoiceId: invoice.id,
    amountCents: invoice.amountCents,
    purpose: invoice.purpose,
    at,
  });
  const row = await scheduledNotificationsRepository.enqueueIdempotent(tx, {
    ownerId: invoice.ownerId,
    type: 'payment-failed',
    trigger: 'payment-failed',
    dedupeKey: copy.dedupeKey,
    scheduledFor: now, // immediate — delivered on the next scheduler tick
    title: copy.title,
    body: copy.body,
    // Wire 1.9.0 / 1.10.0: the tap opens the settle sheet under the SAME
    // framing this push just used. `payment-unconfirmed` must land on a surface
    // that refuses to invite a second payment.
    deepLinkPath: deepLinkToPath({
      kind: 'invoice',
      id: invoice.id,
      params: { reason: copy.reason },
    }),
    deepLinkKind: 'invoice',
    deepLinkId: invoice.id,
    dogId: invoice.dogId,
  });
  // `undefined` = ON CONFLICT fired: this invoice already carries a push of
  // this class. Reported so a caller can keep its log line honest about
  // whether anything new was said.
  return row !== undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compute the next attempt timestamp from the current attempt count.
 * Returns null when the next attempt would exceed MAX_AUTO_CHARGE_ATTEMPTS
 * (the "park" sentinel — caller surfaces a staff notification).
 *
 * `attempt` is the PRE-increment count (the value about to be bumped).
 * For attempt=0 (first failure), schedule the +1m retry; attempt=3
 * (fourth failure) → null because the bumped value 4 == MAX.
 */
export function scheduleNextAttempt(attempt: number, now: Date): string | null {
  const nextAttemptIndex = attempt + 1;
  if (nextAttemptIndex >= MAX_AUTO_CHARGE_ATTEMPTS) return null;
  const minutes = BACKOFF_MINUTES[attempt] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]!;
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

/** Convenience for CLI / test entrypoint that wants the pool runner. */
export const _exportedDbForTests = db;
