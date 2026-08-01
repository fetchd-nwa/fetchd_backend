import { deepLinkToPath } from '../contracts/wire.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import {
  invoicesRepository,
  repointPaymentMethod,
  type InvoiceRow,
} from '../db/repositories/invoicesRepository.js';
import { chicagoShortDate } from '../lib/chicagoDate.js';
import { formatDollars, purposeLabel } from '../lib/invoiceReceiptCopy.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { stripeCustomersRepository } from '../db/repositories/stripeCustomersRepository.js';
import { withActor } from '../db/tx.js';
import { invalidatePattern } from '../lib/cache.js';
import { settleInvoiceCharge, type PendingDuplicateRefund } from '../lib/settleInvoiceCharge.js';
import {
  defaultStripeClient,
  stripeIntentStatusToChargeStatus,
  type StripeClient,
  type StripePaymentIntentResult,
} from '../lib/stripe.js';
import { db } from '../db/client.js';

interface WorkerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Invoice auto-charge worker (Day 15; lease refactor 2026-06-18). One-shot
 * function — Day 16 (`scheduled_notifications` scheduler) wires the recurring
 * trigger; today this runs from a CLI or test harness on demand.
 *
 * **No Stripe call ever runs inside a DB transaction.** The tick is:
 *
 *   1. **Claim tx (short).** `leaseDueOpen` locks a batch of due open invoices
 *      (`FOR UPDATE SKIP LOCKED`) and pushes their `next_attempt_at` to a lease
 *      horizon, then commits. The row locks are released immediately; the lease
 *      keeps other workers from re-scooping the batch.
 *   2. **Per invoice, OUTSIDE any tx:** read the bound card + Stripe customer
 *      (pool reads), then `createAndConfirmPaymentIntent` (idempotency-keyed on
 *      `auto-charge:{id}:{attempts}` so a retry of the same attempt re-uses the
 *      same PI; a fresh attempt mints a new one).
 *   3. **Record tx (short).**
 *      - SUCCEEDED → INSERT `charges` + `markPaid`, atomically.
 *      - Stripe threw (decline) → `recordFailedAttempt` (backoff, or park at
 *        `MAX_ATTEMPTS`).
 *      - Returned a NON-settled status (requires_action / processing /
 *        requires_payment_method) → **cancel the PI** (best-effort) so it can't
 *        later auto-succeed and double-charge against the next retry's fresh
 *        PI, then `recordFailedAttempt`.
 *
 * Crash safety: a worker that dies between the Stripe call and the record tx
 * leaves the lease to expire; the re-lease re-attempts with the SAME
 * attempt-keyed idempotency, so Stripe returns the same PI — no double charge.
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
    // The pre-charge re-check found the invoice already settled (or voided) by
    // a concurrent path during the lease window — no Stripe call was made.
    | 'skipped-already-settled';
  chargeId?: string;
  nextAttemptAt?: string | null;
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
 * Process one leased invoice: pool reads → Stripe (no tx) → short record tx.
 * Never holds a transaction open across the Stripe round-trip.
 */
async function processOne(
  invoice: InvoiceRow,
  stripe: StripeClient,
  now: Date,
  log: WorkerLogger,
): Promise<InvoiceAutoChargeAttemptResult> {
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
    await recordFailed(invoice, null, now);
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
    await recordFailed(invoice, null, now);
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

  // Idempotency-keyed on the attempt index so a retry of THIS attempt (incl.
  // a crash-recovery re-lease) re-uses the same PI; a fresh attempt mints one.
  const attemptKey = `auto-charge:${invoice.id}:${invoice.autoChargeAttempts}`;
  let intent: StripePaymentIntentResult;
  try {
    intent = await stripe.createAndConfirmPaymentIntent(
      {
        customerId: customer.stripeCustomerId,
        paymentMethodId: pm.stripePaymentMethodId,
        amountCents: invoice.amountCents,
        currency: 'usd',
        metadata: {
          owner_id: invoice.ownerId,
          invoice_id: invoice.id,
          purpose: invoice.purpose,
          auto_charge_attempt: String(invoice.autoChargeAttempts),
        },
      },
      attemptKey,
    );
  } catch (err) {
    // Stripe-side rejection (card declined, etc) — terminal failed PI.
    log.warn(
      { invoiceId: invoice.id, err: err instanceof Error ? err.message : String(err) },
      'invoice auto-charge: Stripe call failed',
    );
    const nextAttemptAt = scheduleNextAttempt(invoice.autoChargeAttempts, now);
    await recordFailed(invoice, nextAttemptAt, now);
    return {
      invoiceId: invoice.id,
      outcome: nextAttemptAt === null ? 'failed-parked' : 'failed-retry-scheduled',
      nextAttemptAt,
    };
  }

  const chargeStatus = stripeIntentStatusToChargeStatus(intent.status);

  if (chargeStatus === 'succeeded') {
    const chargeId = await recordPaid(
      invoice,
      intent.id,
      intent.amountCents,
      stripe,
      log,
      now,
      ...(didFallBack ? [pm.id] : []),
    );
    return { invoiceId: invoice.id, outcome: 'paid', chargeId };
  }

  // Non-settled status (requires_action / processing / requires_payment_method).
  // Cancel the PI so it can't later auto-succeed and double-charge against the
  // next retry's fresh PI, then record a failed attempt (counts toward park).
  // Best-effort: a PI Stripe won't let us cancel is covered by the attempt-
  // keyed idempotency on the next retry.
  try {
    await stripe.cancelPaymentIntent(intent.id);
  } catch (err) {
    log.warn(
      { invoiceId: invoice.id, paymentIntentId: intent.id, err: errMsg(err) },
      'invoice auto-charge: could not cancel unsettled PaymentIntent (best-effort)',
    );
  }
  const nextAttemptAt = scheduleNextAttempt(invoice.autoChargeAttempts, now);
  await recordFailed(invoice, nextAttemptAt, now);
  return {
    invoiceId: invoice.id,
    outcome: nextAttemptAt === null ? 'failed-parked' : 'failed-retry-scheduled',
    nextAttemptAt,
  };
}

/**
 * Short record tx via the shared `settleInvoiceCharge` primitive: INSERT the
 * succeeded charge + conditionally `markPaid` (the atomic open->paid claim) +
 * (on win) emit the `payment-succeeded` receipt, all atomically. The
 * notification INSERT lives INSIDE the tx so a charge that rolls back never
 * leaves a "we charged you" receipt behind (transaction-boundary invariant).
 *
 * Returns the `charges` row id either way (the worker's contract). On a LOST
 * settle race (a concurrent manual `/pay` flipped the invoice first), the
 * primitive wrote a 'pending' refund row for this duplicate charge and we fire
 * the Stripe refund POST-COMMIT here -- the worker owns its own short tx, so
 * this mirrors the cancel route's `withMutation.postCommit` refund firing:
 * no Stripe call inside a tx, and a refund-API failure leaves the 'pending'
 * row for the webhook's race-recovery / admin retry (logged, never swallowed
 * silently into a paid-but-unrefunded double charge).
 */
async function recordPaid(
  invoice: InvoiceRow,
  paymentIntentId: string,
  amountCents: number,
  stripe: StripeClient,
  log: WorkerLogger,
  now: Date,
  /** Set when the charge fell back off the invoice's bound card — the invoice
   *  is rebound to it in the SAME tx so `settled_card` names what actually
   *  paid (see `repointPaymentMethod`). */
  settledByPaymentMethodId?: string,
): Promise<string> {
  const result = await withActor(WORKER_ACTOR, async (tx) => {
    if (settledByPaymentMethodId !== undefined) {
      await repointPaymentMethod(tx, { id: invoice.id, paymentMethodId: settledByPaymentMethodId });
    }
    return settleInvoiceCharge(tx, {
      invoice,
      paymentIntentId,
      amountCents,
      purpose: invoice.purpose,
      notifyOwner: true,
      now,
    });
  });

  if (result.outcome === 'refunded') {
    await fireDuplicateRefund(invoice.id, result.pendingStripeRefund, stripe, log);
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
  return result.chargeId;
}

/**
 * Post-commit Stripe refund for a lost-race duplicate charge (mirrors the
 * cancel route's postCommit). Fires `stripe.createRefund` against the
 * duplicate PI then persists the `re_*` id so the `charge.refund.updated`
 * webhook matches deterministically. A failure here is LOGGED and the
 * 'pending' refund row remains for retry/visibility -- never swallowed into a
 * silent double charge.
 */
async function fireDuplicateRefund(
  invoiceId: string,
  pending: PendingDuplicateRefund | undefined,
  stripe: StripeClient,
  log: WorkerLogger,
): Promise<void> {
  if (pending === undefined) return; // defensive zero-refund case: nothing to send back
  try {
    const refund = await stripe.createRefund(
      {
        paymentIntentId: pending.paymentIntentId,
        amountCents: pending.amountCents,
        reason: 'requested_by_customer',
      },
      `dup-settle-refund:${pending.refundId}`,
    );
    await refundsRepository.markStripeId({ id: pending.refundId, stripeRefundId: refund.id });
  } catch (err) {
    log.error(
      {
        invoiceId,
        refundId: pending.refundId,
        paymentIntentId: pending.paymentIntentId,
        err: errMsg(err),
      },
      'invoice auto-charge: lost-race duplicate refund failed to fire; pending row left for retry',
    );
  }
}

/**
 * Short record tx: increment attempts + reschedule (or `null` to park). When
 * the invoice PARKS (`nextAttemptAt === null` — the terminal state at MAX
 * attempts, or a missing card/customer), enqueue ONE `payment-failed`
 * notification inside the SAME tx. NOTIFY-ON-PARK-ONLY is the anti-spam
 * invariant: an intermediate retry (a non-null `nextAttemptAt`) never notifies,
 * so the owner hears once — when there's nothing left to retry and they must
 * act — not on every transient decline. Co-locating the enqueue with the status
 * flip means a notification is never emitted for an attempt that rolls back.
 *
 * A parked invoice is ACTION-REQUIRED (the owner must fix their card), so it
 * goes out via the PUSH channel: instead of a direct feed insert, we enqueue a
 * `scheduled_notifications` row with `scheduled_for = now`. The scheduler's
 * delivery phase (`deliverOne`) then INSERTs the feed `notifications` row AND
 * dispatches Expo push from the owner's live tokens on its next tick — feed +
 * push, delivered together. The trade vs. the old direct insert: the feed entry
 * now lands on the next scheduler tick rather than instantly in this worker tx.
 * `dedupe_key = payment-failed:<invoiceId>` (the `scheduled_notifications.
 * dedupe_key` UNIQUE) makes it one push per parked invoice, ever.
 */
async function recordFailed(
  invoice: InvoiceRow,
  nextAttemptAt: string | null,
  now: Date,
): Promise<void> {
  await withActor(WORKER_ACTOR, async (tx) => {
    await invoicesRepository.recordFailedAttempt(tx, { id: invoice.id, nextAttemptAt });
    if (nextAttemptAt !== null) return; // retry scheduled — do NOT notify (anti-spam)
    await scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: invoice.ownerId,
      type: 'payment-failed',
      trigger: 'payment-failed',
      dedupeKey: `payment-failed:${invoice.id}`,
      scheduledFor: now, // immediate — delivered on the next scheduler tick
      title: 'Payment failed',
      // Allison 2026-08-01: name WHEN it was tried, then offer a way out rather
      // than an instruction. "Please update your card" assumed the card was the
      // problem and offered exactly one fix; an owner whose card is fine but
      // declined has nothing to do with that sentence. Both real options are
      // named because both work on the invoice this links to — the settle sheet
      // takes another card OR flags it pay-in-person (cash/check at drop-off).
      body:
        `We tried your ${formatDollars(invoice.amountCents)} payment for ` +
        `${purposeLabel(invoice.purpose)} on ${chicagoShortDate(now)} and it didn't go through. ` +
        `Want to try a different form of payment? You can use another card, or pay ` +
        `in person with cash or check.`,
      deepLinkPath: deepLinkToPath({ kind: 'invoice', id: invoice.id }),
      deepLinkKind: 'invoice',
      deepLinkId: invoice.id,
      dogId: invoice.dogId,
    });
  });
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
