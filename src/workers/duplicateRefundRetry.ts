import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { refundsRepository, type RefundRow } from '../db/repositories/refundsRepository.js';
import { withActor } from '../db/tx.js';
import { duplicateRefundIdempotencyKey } from '../lib/settleInvoiceCharge.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import type { WorkerLogger } from './invoiceAutoCharge.js';

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
 * double charge whose only trace was a log line. The webhook's invoice-orphan
 * arm, which settles PIs for invoices the owner may have paid manually, made
 * that path common rather than rare.
 *
 * What this phase does, per tick: claim `pending` refunds with no
 * `stripe_refund_id` that have rested a grace interval, and re-fire
 * `createRefund` **under the same idempotency key the first attempt used**
 * ({@link duplicateRefundIdempotencyKey}, keyed on our own refund-row uuid). If
 * the original call actually reached Stripe and only its response was lost, the
 * key replays that refund; if it never landed, this sends it. Exactly one
 * refund exists for one duplicate charge either way — the same "never mint a
 * new identity for a request whose outcome you don't know" rule the auto-charge
 * lane is built on, pointed the other way.
 *
 * **Both bounds are real and neither is silent.** A row stops being retried
 * once it is older than {@link DUPLICATE_REFUND_ABANDON_AFTER_HOURS}, because
 * past Stripe's ~24h key lifetime a same-key retry could execute a SECOND
 * refund instead of replaying the first — and sending an owner someone else's
 * money is not the safe direction either. Abandoned rows are then reported at
 * ERROR every tick, named individually: they are owed money that no automatic
 * path will return, and the one thing worse than a failed refund is a quietly
 * failed one.
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
  outcome:
    /** Stripe accepted it (or replayed the original) and the `re_*` id is on
     *  the row — the webhook can now match it deterministically. */
    | 'sent'
    /** The retry failed again. The row stays claimable next interval. */
    | 'still-failing'
    /** The refund's charge is missing or carries no PaymentIntent id, so there
     *  is nothing to refund AGAINST. Nothing sent; logged for a human. */
    | 'skipped-unreadable';
}

export interface DuplicateRefundRetryTickResult {
  scanned: number;
  sent: number;
  /** Rows past the retry window — owed money now waiting on a human. */
  abandoned: number;
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
  const windowFloor = new Date(now.getTime() - DUPLICATE_REFUND_ABANDON_AFTER_HOURS * 60 * 60 * 1000);

  const claimed = await withActor(WORKER_ACTOR, (tx) =>
    refundsRepository.claimStalePendingForRetry(tx, {
      staleBefore,
      mintedAfter: windowFloor,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    }),
  );

  const results: DuplicateRefundRetryResult[] = [];
  for (const refund of claimed) {
    // Per-row boundary, for the same reason the verify lane has one: one
    // refund's failure is one refund's failure, and this claim already spent
    // its interval.
    try {
      results.push(await retryOne(refund, stripe, log));
    } catch (err) {
      log.error(
        { refundId: refund.id, chargeId: refund.chargeId, err: errMsg(err) },
        'duplicate refund retry: working this refund threw; the rest of the batch carries on',
      );
      results.push({ refundId: refund.id, outcome: 'still-failing' });
    }
  }

  const abandoned = await refundsRepository.findAbandonedPending(db, { mintedBefore: windowFloor });
  if (abandoned.length > 0) {
    log.error(
      {
        workerTick: 'duplicate-refund-retry',
        abandonedCount: abandoned.length,
        refunds: abandoned.map((r) => ({
          refundId: r.id,
          ownerId: r.ownerId,
          chargeId: r.chargeId,
          amountCents: r.amountCents,
        })),
      },
      'duplicate refund retry: refunds past the idempotency-key window are still unsent — an owner is double-charged and no automatic path will fix it; refund by hand in the Stripe dashboard',
    );
  }

  const sent = results.filter((r) => r.outcome === 'sent').length;
  log.info(
    {
      workerTick: 'duplicate-refund-retry',
      batchSize: claimed.length,
      sent,
      abandoned: abandoned.length,
    },
    'duplicate refund retry sweep complete',
  );
  return { scanned: results.length, sent, abandoned: abandoned.length, results };
}

async function retryOne(
  refund: RefundRow,
  stripe: StripeClient,
  log: WorkerLogger,
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

  let stripeRefundId: string;
  try {
    const created = await stripe.createRefund(
      {
        paymentIntentId: charge.stripePaymentIntentId,
        amountCents: refund.amountCents,
        reason: 'requested_by_customer',
      },
      // THE SAME KEY the post-commit fire used. A retry is never a new refund.
      duplicateRefundIdempotencyKey(refund.id),
    );
    stripeRefundId = created.id;
  } catch (err) {
    log.error(
      {
        refundId: refund.id,
        chargeId: refund.chargeId,
        paymentIntentId: charge.stripePaymentIntentId,
        amountCents: refund.amountCents,
        err: errMsg(err),
      },
      'duplicate refund retry: re-fire failed; the row stays pending and is retried next interval',
    );
    return { refundId: refund.id, outcome: 'still-failing' };
  }

  // Persist the `re_*` so `charge.refund.updated` matches deterministically —
  // the same closing step the post-commit fire owes, and the thing that takes
  // this row off the worklist.
  await refundsRepository.markStripeId({ id: refund.id, stripeRefundId });
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
