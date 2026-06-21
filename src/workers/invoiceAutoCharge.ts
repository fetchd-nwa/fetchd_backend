import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { invoicesRepository, type InvoiceRow } from '../db/repositories/invoicesRepository.js';
import type { ChargePurpose } from '../db/repositories/chargesRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { stripeCustomersRepository } from '../db/repositories/stripeCustomersRepository.js';
import { withActor } from '../db/tx.js';
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
    | 'skipped-customer-missing';
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
  const pm = await paymentMethodsRepository.findLiveByIdForOwner(db, {
    id: invoice.paymentMethodId,
    ownerId: invoice.ownerId,
  });
  if (pm === undefined) {
    log.warn(
      { invoiceId: invoice.id, paymentMethodId: invoice.paymentMethodId },
      'invoice auto-charge: payment method missing; parking invoice',
    );
    await recordFailed(invoice, null);
    return { invoiceId: invoice.id, outcome: 'skipped-pm-missing', nextAttemptAt: null };
  }

  const customer = await stripeCustomersRepository.findByOwner(db, invoice.ownerId);
  if (customer === undefined) {
    log.warn(
      { invoiceId: invoice.id, ownerId: invoice.ownerId },
      'invoice auto-charge: stripe_customers row missing; parking invoice',
    );
    await recordFailed(invoice, null);
    return { invoiceId: invoice.id, outcome: 'skipped-customer-missing', nextAttemptAt: null };
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
    await recordFailed(invoice, nextAttemptAt);
    return {
      invoiceId: invoice.id,
      outcome: nextAttemptAt === null ? 'failed-parked' : 'failed-retry-scheduled',
      nextAttemptAt,
    };
  }

  const chargeStatus = stripeIntentStatusToChargeStatus(intent.status);

  if (chargeStatus === 'succeeded') {
    const chargeId = await recordPaid(invoice, intent.id);
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
  await recordFailed(invoice, nextAttemptAt);
  return {
    invoiceId: invoice.id,
    outcome: nextAttemptAt === null ? 'failed-parked' : 'failed-retry-scheduled',
    nextAttemptAt,
  };
}

/**
 * Short record tx: a succeeded charge + flip the invoice paid + emit the
 * `payment-succeeded` receipt notification, all atomically. The notification
 * INSERT lives INSIDE this tx so a charge that rolls back never leaves a
 * "we charged you" receipt behind (transaction-boundary invariant).
 */
async function recordPaid(invoice: InvoiceRow, paymentIntentId: string): Promise<string> {
  return withActor(WORKER_ACTOR, async (tx) => {
    const charge = await chargesRepository.create(tx, {
      ownerId: invoice.ownerId,
      amountCents: invoice.amountCents,
      status: 'succeeded',
      purpose: invoice.purpose,
      stripePaymentIntentId: paymentIntentId,
      bookingId: invoice.bookingId,
      // Carry the enrollment identity so a group-class withdraw after the
      // auto-charge can still find + refund this dog's payment.
      cohortId: invoice.cohortId,
      dogId: invoice.dogId,
    });
    await invoicesRepository.markPaid(tx, { id: invoice.id, paidChargeId: charge.id });
    await notificationsRepository.enqueue(tx, {
      ownerId: invoice.ownerId,
      type: 'payment-succeeded',
      title: 'Payment received',
      body: `We charged your card ${formatDollars(invoice.amountCents)} for your ${purposeLabel(
        invoice.purpose,
      )}.`,
      deepLinkPath: '/account/billing',
      dogIds: invoice.dogId ? [invoice.dogId] : [],
    });
    return charge.id;
  });
}

/**
 * Short record tx: increment attempts + reschedule (or `null` to park). When
 * the invoice PARKS (`nextAttemptAt === null` — the terminal state at MAX
 * attempts, or a missing card/customer), emit ONE `payment-failed`
 * notification inside the SAME tx. NOTIFY-ON-PARK-ONLY is the anti-spam
 * invariant: an intermediate retry (a non-null `nextAttemptAt`) never notifies,
 * so the owner hears once — when there's nothing left to retry and they must
 * act — not on every transient decline. Co-locating the INSERT with the
 * status flip means a notification is never emitted for an attempt that rolls
 * back.
 */
async function recordFailed(invoice: InvoiceRow, nextAttemptAt: string | null): Promise<void> {
  await withActor(WORKER_ACTOR, async (tx) => {
    await invoicesRepository.recordFailedAttempt(tx, { id: invoice.id, nextAttemptAt });
    if (nextAttemptAt !== null) return; // retry scheduled — do NOT notify (anti-spam)
    await notificationsRepository.enqueue(tx, {
      ownerId: invoice.ownerId,
      type: 'payment-failed',
      title: 'Payment failed',
      body: `We couldn't process your payment of ${formatDollars(
        invoice.amountCents,
      )} for your ${purposeLabel(invoice.purpose)}. Please update your card.`,
      deepLinkPath: '/account/billing',
      dogIds: invoice.dogId ? [invoice.dogId] : [],
    });
  });
}

/** Whole-dollar-aware USD formatter for receipt copy. Stripe amounts are cents;
 *  `$120` reads better than `$120.00` for round amounts, but cents show when
 *  present. */
function formatDollars(amountCents: number): string {
  const dollars = amountCents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toString() : dollars.toFixed(2)}`;
}

/**
 * Human label for the thing being charged, varied by `charge_purpose`, for the
 * receipt + failure copy. Day-program (`payg`), `board-train`, and
 * `group-class` are the auto-charged invoice purposes today; `package` /
 * `membership` are covered for totality (an invoice can carry any purpose).
 */
function purposeLabel(purpose: ChargePurpose): string {
  switch (purpose) {
    case 'payg':
      return 'day program session';
    case 'board-train':
      return 'Board & Train program';
    case 'group-class':
      return 'group class enrollment';
    case 'package':
      return 'credit package';
    case 'membership':
      return 'membership';
  }
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
