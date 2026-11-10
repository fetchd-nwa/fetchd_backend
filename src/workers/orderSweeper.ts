import { db } from '../db/client.js';
import { IDEMPOTENCY_OPEN_CLAIM_MAX_DAYS } from '../db/idempotency.js';
import { chargesRepository, type EngineChargeRow } from '../db/repositories/chargesRepository.js';
import { withActor } from '../db/tx.js';
import { askWhatWon } from '../lib/cancelOrder.js';
import {
  blockerOfIntent,
  failChargeInTx,
  finishEngineAct,
  readEngineBudget,
  settleChargeInTx,
  type EngineBudget,
} from '../lib/confirmCharge.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
import {
  stripeErrorCode,
  type StripeClient,
  type StripePaymentIntentResult,
} from '../lib/stripe.js';
import type { WorkerLogger } from './workerLogger.js';

/**
 * The order sweeper (design §2.7:3953-3974, as `designs/p15-engine-recovery.md` revises
 * it; PAY-U05): crash recovery, **forward only**, on two arms. Each takes its rows by a
 * conditional UPDATE committed before any Stripe call, so overlapping ticks cannot share
 * one, and acts on the row that UPDATE returned, never on the worklist's read.
 *
 * **Past the lease.** A `requires_payment` charge the request has lost. The claim writes
 * `next_sweep_at` and never `attempting_until`, which is the request's alone, so a lease
 * once lost stays lost and the row's intent id cannot change after the claim commits.
 *
 *   (a) **No intent id stored.** No card was tried: the engine's split create leaves
 *       at most an unconfirmed intent, which cannot charge. The order is abandoned:
 *       cancelled, its seats freed, its debits returned, the claim completed with the
 *       402 `{outcome: 'abandoned', attempts: 0}`, and the owner told, since nobody's
 *       request is on a screen by now. No Stripe call at all.
 *   (b) **An intent id stored.** Retrieved: `succeeded` runs the settle; `processing`
 *       and `requires_capture` wait for the next look; `canceled` takes the failure
 *       policy. `requires_payment_method`, `requires_action` and `requires_confirmation`
 *       are **cancelled before anything says "failed"**: "you weren't charged" is a fact
 *       Stripe just confirmed, not a reading of a status.
 *
 * **The watch.** A `failed` charge whose intent can still move, because the caller could
 * not say it was dead. It ends only when Stripe says `succeeded` or `canceled`, however
 * long that takes: no clock ends it, because a clock is how a late success goes
 * unrefunded. A `succeeded` mints the capped refund and closes the watch in one
 * transaction, so a redelivery, a second tick and a refund Stripe later fails all find
 * nothing more to do.
 *
 * **The sweeper never tries a card.** Its verbs are retrieve and cancel, and a cancel can
 * only stop money.
 *
 * **A refused cancel is ordinary.** Stripe holds an object lock while a confirm runs, so
 * a cancel that meets one answers 429 `lock_timeout`: nothing is written, and the next
 * look reads what the confirm did.
 */

const WORKER_ACTOR = 'system:scheduler';

/** Per-arm batch, per tick. Each row costs a few Stripe calls at most. */
const DEFAULT_LIMIT = 25;

const WATCH_AGE_ALARM_MS = IDEMPOTENCY_OPEN_CLAIM_MAX_DAYS * 24 * 60 * 60 * 1000;

const WATCH_AGE_ALARM =
  'a failed charge is still watched a week after it was created: Stripe has said nothing final about its intent, so the sweeper keeps looking and a person should check it';
const WATCH_NO_INTENT_ALARM =
  'a watched charge has no intent id, which nothing should write: its watch is closed, so a person must check that nothing is owed';
const WATCH_INTENT_MISSING_ALARM =
  'Stripe has no such intent for a watched charge: its watch is closed, so a person must check that nothing is owed';

/** Loud once per charge per process, then quiet: the sweeper keeps looking regardless. */
const ALARMED_WATCH_IDS = new Set<string>();

export interface OrderSweeperTickResult {
  /** Charges this tick claimed, on either arm. */
  scanned: number;
  abandoned: number;
  settled: number;
  failed: number;
  /** Late successes the watch found: one capped refund minted for each. */
  lateRefunded: number;
  /** Nothing final yet, or unreadable: the next look asks again. */
  left: number;
}

export interface OrderSweeperOpts {
  stripe: StripeClient;
  /** A test's clock. Production passes nothing: a lease is judged on Postgres's `now()`. */
  now?: Date;
  log: WorkerLogger;
  limit?: number;
}

type Swept = 'abandoned' | 'settled' | 'failed' | 'lateRefunded' | 'left';

async function settleFromStripe(
  charge: EngineChargeRow,
  live: StripePaymentIntentResult,
  opts: OrderSweeperOpts,
): Promise<Swept> {
  const { stripe, log } = opts;
  const act = await withActor(WORKER_ACTOR, (tx) =>
    settleChargeInTx(tx, {
      chargeId: charge.id,
      live,
      receiptTrigger: 'settle',
      log,
      now: opts.now ?? new Date(),
    }),
  );
  await finishEngineAct(act, {
    stripe,
    log,
    context: { chargeId: charge.id, orderId: charge.orderId, settlePath: 'order-sweeper' },
  });
  switch (act.outcome) {
    case 'late-refund':
      return 'lateRefunded';
    case 'no-op':
      return 'left';
    case 'failed':
    case 'lost-race':
    case 'settled':
      return 'settled';
  }
}

/**
 * A dead intent ends the order. `live` is the read before any cancel, because a card's
 * answer comes from `last_payment_error` and never from `canceled`. Nobody's request is
 * on a screen for this one: a push is the only way she hears, and a 402 replay is there
 * if she re-sends.
 */
async function failOnDeadIntent(
  charge: EngineChargeRow,
  live: StripePaymentIntentResult,
  opts: OrderSweeperOpts,
): Promise<Swept> {
  const { log } = opts;
  const blocker = blockerOfIntent(live, log);
  const act = await withActor(WORKER_ACTOR, (tx) =>
    failChargeInTx(tx, {
      chargeId: charge.id,
      blocker,
      lastError: live.failureCode ?? null,
      notice: 'charge-failed',
      intentDead: true,
      log,
      now: opts.now ?? new Date(),
    }),
  );
  await finishEngineAct(act, {
    stripe: opts.stripe,
    log,
    context: { chargeId: charge.id, orderId: charge.orderId, settlePath: 'order-sweeper' },
  });
  return act.outcome === 'no-op' ? 'left' : 'failed';
}

/** One charge past its lease, as its claim returned it. */
async function sweepPastLease(
  charge: EngineChargeRow,
  budget: EngineBudget,
  opts: OrderSweeperOpts,
): Promise<Swept> {
  const { stripe, log } = opts;
  const paymentIntentId = charge.stripePaymentIntentId;

  if (paymentIntentId === null) {
    const act = await withActor(WORKER_ACTOR, (tx) =>
      failChargeInTx(tx, {
        chargeId: charge.id,
        blocker: undefined,
        lastError: null,
        notice: 'charge-failed',
        log,
        now: opts.now ?? new Date(),
      }),
    );
    await finishEngineAct(act, {
      stripe,
      log,
      context: { chargeId: charge.id, orderId: charge.orderId, settlePath: 'order-sweeper' },
    });
    return act.outcome === 'no-op' ? 'left' : 'abandoned';
  }

  const live = await stripe.retrievePaymentIntent(paymentIntentId, budget.call);
  switch (live.status) {
    case 'succeeded':
      return settleFromStripe(charge, live, opts);
    case 'processing':
    case 'requires_capture':
      return 'left';
    case 'canceled':
      return failOnDeadIntent(charge, live, opts);
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method': {
      const won = await askWhatWon({ charge, stripe, budget });
      switch (won.kind) {
        case 'canceled':
          return failOnDeadIntent(charge, live, opts);
        case 'succeeded':
          return settleFromStripe(charge, won.live, opts);
        case 'processing':
          return 'left';
        case 'no-intent':
          log.error(
            { workerTick: 'order-sweeper', chargeId: charge.id, orderId: charge.orderId },
            'askWhatWon found no intent on a charge that named one',
          );
          return 'left';
      }
    }
  }
}

function alarmOnAWeekOfWatching(charge: EngineChargeRow, opts: OrderSweeperOpts): void {
  const nowMs = (opts.now ?? new Date()).getTime();
  if (nowMs - pgTimestampToDate(charge.createdAt).getTime() < WATCH_AGE_ALARM_MS) return;
  if (ALARMED_WATCH_IDS.has(charge.id)) return;
  ALARMED_WATCH_IDS.add(charge.id);
  opts.log.error(
    { workerTick: 'order-sweeper', chargeId: charge.id, orderId: charge.orderId },
    WATCH_AGE_ALARM,
  );
}

/** The next look at a watched charge. The claim already set when that is. */
async function lookAtWatched(
  charge: EngineChargeRow,
  budget: EngineBudget,
  opts: OrderSweeperOpts,
): Promise<Swept> {
  const { stripe, log } = opts;
  const context = { workerTick: 'order-sweeper', chargeId: charge.id, orderId: charge.orderId };
  const paymentIntentId = charge.stripePaymentIntentId;
  if (paymentIntentId === null) {
    log.error(context, WATCH_NO_INTENT_ALARM);
    await chargesRepository.closeWatch(db, { id: charge.id });
    return 'left';
  }

  alarmOnAWeekOfWatching(charge, opts);

  let live: StripePaymentIntentResult;
  try {
    live = await stripe.retrievePaymentIntent(paymentIntentId, budget.call);
  } catch (err) {
    if (stripeErrorCode(err) !== 'resource_missing') throw err;
    log.error({ ...context, paymentIntentId }, WATCH_INTENT_MISSING_ALARM);
    await chargesRepository.closeWatch(db, { id: charge.id });
    return 'left';
  }

  switch (live.status) {
    case 'succeeded':
      return settleFromStripe(charge, live, opts);
    case 'canceled':
      await chargesRepository.closeWatch(db, { id: charge.id });
      return 'left';
    case 'processing':
    case 'requires_capture':
      return 'left';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method': {
      const won = await askWhatWon({ charge, stripe, budget });
      switch (won.kind) {
        case 'canceled':
          await chargesRepository.closeWatch(db, { id: charge.id });
          return 'left';
        case 'succeeded':
          return settleFromStripe(charge, won.live, opts);
        case 'processing':
        case 'no-intent':
          return 'left';
      }
    }
  }
}

/** One row's failure stays that row's: the next look asks again. */
function logLookFailed(charge: EngineChargeRow, err: unknown, log: WorkerLogger): void {
  const code = stripeErrorCode(err);
  const context = {
    workerTick: 'order-sweeper',
    chargeId: charge.id,
    orderId: charge.orderId,
    ...(code !== undefined ? { code } : {}),
    err: err instanceof Error ? err.message : String(err),
  };
  if (code === 'lock_timeout') {
    log.warn(context, 'a cancel met a confirm holding the intent; the next look reads what it did');
    return;
  }
  log.error(context, 'order sweeper could not move a charge; the next look asks again');
}

/**
 * One sweep. Never holds a transaction across a Stripe call: each claim commits first,
 * and every act opens its own transaction under the charge lock and the state guard.
 */
export async function runOrderSweeperOnce(opts: OrderSweeperOpts): Promise<OrderSweeperTickResult> {
  const { now: at, log } = opts;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const budget = await readEngineBudget();
  const result: OrderSweeperTickResult = {
    scanned: 0,
    abandoned: 0,
    settled: 0,
    failed: 0,
    lateRefunded: 0,
    left: 0,
  };

  const look = async (
    claimed: EngineChargeRow | undefined,
    arm: typeof sweepPastLease,
  ): Promise<void> => {
    if (claimed === undefined) return;
    result.scanned += 1;
    try {
      result[await arm(claimed, budget, opts)] += 1;
    } catch (err) {
      result.left += 1;
      logLookFailed(claimed, err, log);
    }
  };

  const { sweepClaimMs } = budget;
  for (const row of await chargesRepository.findPastLease(db, { at, limit })) {
    const claimed = await chargesRepository.claimPastLease(db, {
      id: row.id,
      at,
      sweepClaimMs,
    });
    await look(claimed, sweepPastLease);
  }
  for (const row of await chargesRepository.findWatched(db, { at, limit })) {
    const claimed = await chargesRepository.claimWatched(db, { id: row.id, at, sweepClaimMs });
    await look(claimed, lookAtWatched);
  }

  log.info({ workerTick: 'order-sweeper', ...result }, 'order sweeper tick');
  return result;
}
