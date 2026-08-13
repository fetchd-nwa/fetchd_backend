import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import {
  refundsRepository,
  type AbandonedRefundClass,
  type AbandonedRefundRow,
  type RefundRow,
} from '../db/repositories/refundsRepository.js';
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
 * ({@link ALARMED_REFUND_IDS}) — the verify lane's loud-once/quiet-after
 * posture. They are still owed money that no automatic path will return, and
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

  const { rows: abandoned, totalByClass } = await refundsRepository.findAbandonedPending(db, {
    mintedBefore: windowFloor,
  });
  const abandonedTotal =
    totalByClass['row-keyed'] + totalByClass['client-keyed'] + totalByClass['never-sent'];
  reportAbandoned(abandoned, totalByClass, log);

  const sent = results.filter((r) => r.outcome === 'sent').length;
  log.info(
    {
      workerTick: 'duplicate-refund-retry',
      batchSize: claimed.length,
      sent,
      // The TRUE count, not the page length — the page caps at 20 oldest-first
      // and can be saturated by never-sent seed rows, which is exactly when the
      // number must not flatter.
      abandoned: abandonedTotal,
      abandonedTruncated: abandonedTotal > abandoned.length,
    },
    'duplicate refund retry sweep complete',
  );
  return {
    scanned: results.length,
    sent,
    abandoned: abandonedTotal,
    abandonedByClass: totalByClass,
    abandonedTruncated: abandonedTotal > abandoned.length,
    results,
  };
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

/**
 * Refund ids this PROCESS has already shouted about. The abandon report is a
 * standing condition, not an event: the same rows are re-read every tick, and
 * at a one-minute cadence an unresolved row emits ~1,440 identical ERRORs a day
 * — so the first real incident after one arrives already buried. Loud once,
 * quiet after, exactly as the verify lane's park arm does it
 * (`invoiceAttemptVerify.ts` `parkForHuman` — ERROR the first time, INFO after).
 *
 * That lane gets to key its "first time" on a durable row (the push dedupe
 * key); this one has none, and an acknowledgement table is portal-surface work
 * that is deliberately not in this change. So the memory is per-process:
 * a restart re-shouts every outstanding row once, which is the right failure
 * mode — a fresh process SHOULD re-announce owed money, and nothing here can
 * make an unresolved refund silent forever. The count stays in every tick's
 * INFO summary either way, so the condition is never invisible.
 *
 * Bounded by the number of distinct refunds that ever go abandoned in one
 * process lifetime — a set the whole point of this worker is to keep near zero.
 */
const ALARMED_REFUND_IDS = new Set<string>();

/**
 * One sentence per class, each of which is an instruction its class's reader
 * can actually follow. The single sentence this replaced ended "refund by hand
 * in the Stripe dashboard" for every row — impossible for `never-sent` (there
 * is no charge to refund) and actively dangerous for `client-keyed` (the
 * original refund may already exist under a key we cannot see).
 */
const ABANDONED_CLASS_MESSAGE: Record<AbandonedRefundClass, string> = {
  'row-keyed':
    'duplicate refund retry: refunds past the idempotency-key window are still unsent — an owner is double-charged and no automatic path will fix it; refund by hand in the Stripe dashboard against the listed PaymentIntent, searching the listed idempotency key first in case a late retry did land',
  'client-keyed':
    'duplicate refund retry: refunds no sweep will ever retry are still unsent — their original Stripe key was the CLIENT request key and nothing durable can reproduce it; an owner is owed this money, so refund by hand against the listed PaymentIntent, but CHECK it for an existing refund first (a lost response rather than a lost request means the money already went back)',
  'never-sent':
    'duplicate refund retry: refund rows with no Stripe charge behind them are still pending — the charge carries no PaymentIntent (pre-Stripe-wire seed money), so there is nothing to refund in the dashboard and no automatic path applies; these record an intent to return money that never moved through Stripe and must be resolved out of band',
};

const ABANDONED_CLASSES: readonly AbandonedRefundClass[] = [
  'row-keyed',
  'client-keyed',
  'never-sent',
];

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
    if (inClass.length === 0) {
      // Nonzero TOTAL with zero page presence: the oldest-first page is
      // saturated by older rows of other classes (in practice: never-sent seed
      // rows, which have no resolution path in this change). Without this arm,
      // exactly the row this worker exists to surface — a newer row-keyed
      // double charge — was never returned, never named, never counted (2026-08-13
      // verify panel). No row detail is available here by construction, so the
      // instruction is the query, and loud-once keys on a class sentinel.
      const sentinel = `buried:${refundClass}`;
      if (ALARMED_REFUND_IDS.has(sentinel)) {
        log.info(
          { workerTick: 'duplicate-refund-retry', refundClass, abandonedCount: total },
          'duplicate refund retry: abandoned refunds of this class remain outside the report page, already announced by this process',
        );
      } else {
        ALARMED_REFUND_IDS.add(sentinel);
        log.error(
          { workerTick: 'duplicate-refund-retry', refundClass, abandonedCount: total },
          `duplicate refund retry: ${total} abandoned ${refundClass} refund(s) exist but the report page is saturated by older rows — list them with: SELECT * FROM refunds WHERE status='pending' AND stripe_refund_id IS NULL ORDER BY created_at DESC`,
        );
      }
      continue;
    }
    const unreported = inClass.filter((r) => !ALARMED_REFUND_IDS.has(r.id));
    if (unreported.length === 0) {
      log.info(
        {
          workerTick: 'duplicate-refund-retry',
          refundClass,
          abandonedCount: total,
        },
        'duplicate refund retry: still-abandoned refunds, every one already reported by this process',
      );
      continue;
    }
    for (const row of unreported) ALARMED_REFUND_IDS.add(row.id);
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
          paymentIntentId: r.stripePaymentIntentId,
          ...(refundClass === 'row-keyed'
            ? { idempotencyKey: duplicateRefundIdempotencyKey(r.id) }
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
