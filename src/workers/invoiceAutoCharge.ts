import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { invoicesRepository, type InvoiceRow } from '../db/repositories/invoicesRepository.js';
import { paymentMethodsRepository } from '../db/repositories/paymentMethodsRepository.js';
import { stripeCustomersRepository } from '../db/repositories/stripeCustomersRepository.js';
import { withActor, type Tx } from '../db/tx.js';
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
 * Invoice auto-charge worker (Day 15). One-shot function — Day 16
 * (`scheduled_notifications` scheduler) wires the recurring trigger;
 * today this runs from a CLI or test harness on demand.
 *
 * Per-invoice lifecycle (one tx per invoice, claimed via FOR UPDATE
 * SKIP LOCKED so concurrent workers don't double-charge):
 *
 *   1. `lockDueOpenForUpdate` — claims a batch of open invoices whose
 *      `next_attempt_at <= now()`. Lock held until the tx commits.
 *   2. For each invoice:
 *      a. Look up the owner's Stripe customer + the bound payment_method.
 *      b. Call `stripe.createAndConfirmPaymentIntent` (idempotency-keyed
 *         on `auto-charge:{invoice.id}:{attempts}` so a retry of the
 *         same attempt re-uses the same PI; a fresh attempt mints a
 *         new one).
 *      c. SUCCEEDED: INSERT charges row + `markPaid` flips the invoice.
 *      d. REQUIRES_PAYMENT (3DS / processing): INSERT charges row at
 *         requires_payment, leave the invoice 'open'; the Day-15
 *         webhook flips charge on terminal event but does NOT today
 *         re-settle the invoice (known caveat — same as POST /pay).
 *      e. FAILED / other terminal failures: increment
 *         `auto_charge_attempts`, set `next_attempt_at = now() +
 *         backoff(attempts)`. After MAX_ATTEMPTS, park the invoice
 *         (`next_attempt_at = null`) — staff notification surface
 *         lands at Day-16 / Day-19.
 *
 * The `withActor` per-invoice tx attributes writes under
 * `system:stripe-webhook` (same actor as the webhook handlers; the
 * webhook + worker both reconcile Stripe-side state).
 *
 * Returns a summary so the caller (CLI / test) can log a tick report.
 */

const WORKER_ACTOR = 'system:stripe-webhook';

/** Hard cap on dunning attempts before the invoice parks. Day-16 scheduler
 *  will tune from a config knob; today matches Stripe's smart-retry default. */
export const MAX_AUTO_CHARGE_ATTEMPTS = 4;

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
    | 'requires-action'
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
 * Run one tick. Returns the per-invoice outcomes for the batch. Safe to
 * call concurrently — the `FOR UPDATE SKIP LOCKED` scan ensures each
 * invoice is claimed by exactly one worker at a time.
 */
export async function runInvoiceAutoChargeOnce(
  opts: InvoiceAutoChargeOpts = {},
): Promise<InvoiceAutoChargeTickResult> {
  const stripe = opts.stripe ?? defaultStripeClient;
  const log = opts.log ?? NOOP_LOG;
  const now = opts.now ?? new Date();

  const results: InvoiceAutoChargeAttemptResult[] = [];

  // The tx wraps the entire batch — FOR UPDATE SKIP LOCKED locks the
  // claimed rows for this connection until commit. Each invoice's
  // processing happens inside the same tx (sequential per worker); a
  // second worker tick selects the next batch (skipping the locked
  // rows). For batches large enough to make Stripe latency dominate,
  // Day-16 will switch to one-tx-per-invoice; today the simpler shape
  // is enough.
  await withActor(WORKER_ACTOR, async (tx) => {
    const batch = await invoicesRepository.lockDueOpenForUpdate(tx, {
      limit: opts.limit,
      now,
    });
    log.info(
      { workerTick: 'invoice-auto-charge', batchSize: batch.length },
      'invoice auto-charge tick claimed batch',
    );

    for (const invoice of batch) {
      const result = await processOne(tx, invoice, stripe, now, log);
      results.push(result);
    }
  });

  return { scanned: results.length, results };
}

/**
 * Single-invoice processing inside the worker tx. Encapsulates the
 * Stripe call + the charges/invoice writes + the dunning math.
 *
 * Stripe call is awaited inside the tx — that breaks the "Stripe calls
 * pre-tx OR post-tx" rule, but the worker context is different: the
 * lock is held precisely to prevent concurrent attempts, and the
 * invoice id is the unit of work. The duration the tx stays open is
 * bounded by Stripe's own timeout (~30s); during that window the row
 * is locked for this connection only. Day-16 may revisit if connection
 * pressure becomes an issue.
 */
async function processOne(
  tx: Tx,
  invoice: InvoiceRow,
  stripe: StripeClient,
  now: Date,
  log: WorkerLogger,
): Promise<InvoiceAutoChargeAttemptResult> {
  const pm = await paymentMethodsRepository.findLiveByIdForOwner(tx, {
    id: invoice.paymentMethodId,
    ownerId: invoice.ownerId,
  });
  if (pm === undefined) {
    // Card was deleted between issue + auto-charge. Park the invoice.
    log.warn(
      { invoiceId: invoice.id, paymentMethodId: invoice.paymentMethodId },
      'invoice auto-charge: payment method missing; parking invoice',
    );
    await invoicesRepository.recordFailedAttempt(tx, {
      id: invoice.id,
      nextAttemptAt: null,
    });
    return { invoiceId: invoice.id, outcome: 'skipped-pm-missing', nextAttemptAt: null };
  }

  const customer = await stripeCustomersRepository.findByOwner(tx, invoice.ownerId);
  if (customer === undefined) {
    log.warn(
      { invoiceId: invoice.id, ownerId: invoice.ownerId },
      'invoice auto-charge: stripe_customers row missing; parking invoice',
    );
    await invoicesRepository.recordFailedAttempt(tx, {
      id: invoice.id,
      nextAttemptAt: null,
    });
    return { invoiceId: invoice.id, outcome: 'skipped-customer-missing', nextAttemptAt: null };
  }

  // Idempotency-keyed on the attempt index so a retry of THIS attempt
  // re-uses Stripe's cached PI; a fresh attempt (after a retry was
  // scheduled) mints a new one.
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
    // Stripe-side rejection (card declined, etc). Schedule retry / park.
    log.warn(
      { invoiceId: invoice.id, err: err instanceof Error ? err.message : String(err) },
      'invoice auto-charge: Stripe call failed',
    );
    const nextAttemptAt = scheduleNextAttempt(invoice.autoChargeAttempts, now);
    await invoicesRepository.recordFailedAttempt(tx, {
      id: invoice.id,
      nextAttemptAt,
    });
    return {
      invoiceId: invoice.id,
      outcome: nextAttemptAt === null ? 'failed-parked' : 'failed-retry-scheduled',
      nextAttemptAt,
    };
  }

  const chargeStatus = stripeIntentStatusToChargeStatus(intent.status);

  const charge = await chargesRepository.create(tx, {
    ownerId: invoice.ownerId,
    amountCents: intent.amountCents,
    status: chargeStatus,
    purpose: invoice.purpose,
    stripePaymentIntentId: intent.id,
    bookingId: invoice.bookingId,
  });

  if (chargeStatus === 'succeeded') {
    await invoicesRepository.markPaid(tx, { id: invoice.id, paidChargeId: charge.id });
    return { invoiceId: invoice.id, outcome: 'paid', chargeId: charge.id };
  }

  // Async/3DS path: leave invoice open, charge at requires_payment;
  // the webhook flips the charge on terminal event. Increment attempts
  // so a stuck async PI eventually exhausts retries — Day-16 may want
  // to distinguish "async pending" from "failed" but the simple
  // semantic is enough today.
  const nextAttemptAt = scheduleNextAttempt(invoice.autoChargeAttempts, now);
  await invoicesRepository.recordFailedAttempt(tx, {
    id: invoice.id,
    nextAttemptAt,
  });
  return {
    invoiceId: invoice.id,
    outcome: 'requires-action',
    chargeId: charge.id,
    nextAttemptAt,
  };
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
