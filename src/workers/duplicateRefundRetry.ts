import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import {
  refundsRepository,
  type AbandonedRefundClass,
  type AbandonedRefundRow,
  type RefundRow,
} from '../db/repositories/refundsRepository.js';
import { withActor } from '../db/tx.js';
import { refundCreateParams } from '../lib/pendingRefund.js';
import { duplicateRefundIdempotencyKey } from '../lib/settleInvoiceCharge.js';
import {
  defaultStripeClient,
  stripeIdempotencyErrorKind,
  type StripeClient,
} from '../lib/stripe.js';
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
  outcome: /** Stripe accepted it (or replayed the original) and the `re_*` id is on
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
  const abandonedTotal = ABANDONED_CLASSES.reduce((sum, c) => sum + totalByClass[c], 0);
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

  // THE SAME KEY the post-commit fire used. A retry is never a new refund.
  // Stored on the row since 2026-08-19 — which is the only way this can be true
  // for the cancel / withdraw / membership writers, whose keys were the
  // client's request key. The fallback covers rows minted by round-4-era code:
  // `duplicate-invoice-settle` above `REFUND_SWEEP_FLOOR`, whose key IS
  // derivable from the row. The claim admits nothing else, so a row that
  // reaches here with a NULL key is provably a legacy row-keyed one.
  const idempotencyKey = refund.stripeIdempotencyKey ?? duplicateRefundIdempotencyKey(refund.id);

  let stripeRefundId: string;
  try {
    const created = await stripe.createRefund(
      // Built by the SAME constructor the post-commit fire uses. Same key with
      // drifted params is Stripe's `idempotency_error` — no money moves, but
      // the refund never lands either, so the two call sites cannot be allowed
      // to build this object independently.
      refundCreateParams({
        paymentIntentId: charge.stripePaymentIntentId,
        amountCents: refund.amountCents,
      }),
      idempotencyKey,
    );
    stripeRefundId = created.id;
  } catch (err) {
    // Not every failure here means the same thing, and the verify lane already
    // proved the distinction is worth drawing (`stripeIdempotencyErrorKind`).
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
    'duplicate refund retry: refunds past the idempotency-key window are still unsent — an owner is double-charged and no automatic path will fix it; refund by hand in the Stripe dashboard against the listed PaymentIntent, searching the listed idempotency key first in case a late retry did land',
  'client-keyed':
    'duplicate refund retry: refunds no sweep will ever retry are still unsent — their original Stripe key was the CLIENT request key and nothing durable can reproduce it; an owner is owed this money, so refund by hand against the listed PaymentIntent, but CHECK it for an existing refund first (a lost response rather than a lost request means the money already went back)',
  'never-sent':
    'duplicate refund retry: refund rows with no Stripe charge behind them are still pending — the charge carries no PaymentIntent (pre-Stripe-wire seed money), so there is nothing to refund in the dashboard and no automatic path applies; these record an intent to return money that never moved through Stripe and must be resolved out of band',
  'stripe-failed':
    'duplicate refund retry: Stripe reported these refunds FAILED after creating them — the money did NOT return to the owner and nothing retries them (the refund identity is spent); CHECK the listed PaymentIntent for an existing manual refund first (this alarm repeats per process restart, so a colleague may already have re-sent it), then issue a FRESH refund from the Stripe dashboard — safe because a failed refund drops out of the cumulative refundable cap and Stripe refuses over-refunding',
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
  'row-keyed':
    "SELECT * FROM refunds WHERE status='pending' AND stripe_refund_id IS NULL ORDER BY created_at DESC",
  'client-keyed':
    "SELECT * FROM refunds WHERE status='pending' AND stripe_refund_id IS NULL AND stripe_idempotency_key IS NULL ORDER BY created_at DESC",
  'never-sent':
    "SELECT * FROM refunds WHERE status='pending' AND stripe_refund_id IS NULL ORDER BY created_at DESC",
  'stripe-failed': "SELECT * FROM refunds WHERE status='failed' ORDER BY created_at DESC",
};

const ABANDONED_CLASSES: readonly AbandonedRefundClass[] = [
  'row-keyed',
  'client-keyed',
  'never-sent',
  'stripe-failed',
];

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
    'duplicate refund retry: refunds with no Stripe route are now TERMINAL at "unroutable" — the charge behind each carries no PaymentIntent (pre-Stripe-wire money), so nothing here can ever send them; this is the one and only time each will be announced, and the money must be returned out of band',
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
    const unreported = inClass.filter((r) => !ALARMED_REFUND_IDS.has(r.id));
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
    for (const row of unreported) ALARMED_REFUND_IDS.add(row.id);
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
          ...(refundClass === 'stripe-failed' ? { stripeRefundId: r.stripeRefundId } : {}),
        })),
      },
      ABANDONED_CLASS_MESSAGE[refundClass],
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
