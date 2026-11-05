import { db } from '../db/client.js';
import { deviceTokensRepository } from '../db/repositories/deviceTokensRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import {
  scheduledNotificationsRepository,
  type ScheduledNotificationRow,
} from '../db/repositories/scheduledNotificationsRepository.js';
import { shouldSkipPush } from '../lib/pushPreferences.js';
import type { NotificationPushData } from '../contracts/wire.js';
import { IDEMPOTENCY_OPEN_CLAIM_MAX_DAYS, sweepExpiredIdempotencyKeys } from '../db/idempotency.js';
import {
  enqueueAlumniAttendanceFlags,
  type AlumniAttendanceScanResult,
} from '../lib/alumniAttendanceScan.js';
import { type EnqueueCreditExpiryWarningsResult } from '../lib/enqueueCreditExpiryWarnings.js';
import {
  enqueueInvoiceOverdueWarnings,
  type EnqueueInvoiceOverdueWarningsResult,
} from '../lib/enqueueInvoiceOverdueWarnings.js';
import {
  enqueueCardExpiryWarnings,
  type EnqueueCardExpiryWarningsResult,
} from '../lib/enqueueCardExpiryWarnings.js';
import { rollDueMemberships, type MembershipRollResult } from '../lib/membershipRoll.js';
import { withActor, type Tx } from '../db/tx.js';
import {
  defaultExpoPushClient,
  type ExpoPushClient,
  type ExpoPushMessage,
  type ExpoPushTicket,
} from '../lib/expoPush.js';
import type { R2Client } from '../lib/r2.js';
import { defaultStripeClient, type StripeClient } from '../lib/stripe.js';
import { runCaptureReconcilerOnce, type CaptureReconcilerTickResult } from './captureReconciler.js';
import { runInvoiceAutoChargeOnce, type InvoiceAutoChargeTickResult } from './invoiceAutoCharge.js';
import {
  runInvoiceAttemptVerifyOnce,
  type InvoiceAttemptVerifyTickResult,
} from './invoiceAttemptVerify.js';
import {
  runDuplicateRefundRetryOnce,
  type DuplicateRefundRetryTickResult,
} from './duplicateRefundRetry.js';
import { runOrderSweeperOnce, type OrderSweeperTickResult } from './orderSweeper.js';
import { runMediaDerivativesOnce, type MediaDerivativesTickResult } from './mediaDerivatives.js';

interface WorkerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Scheduler worker (Day 16). One-shot function — production drives it
 * via pg_cron + pg_net hitting `/workers/tick`; tests call it directly
 * with a fixed `now` for determinism.
 *
 * Phases per tick, composed in order:
 *
 *   1. **`scheduled_notifications` claim + deliver.** Claim due 'pending'
 *      rows under `FOR UPDATE SKIP LOCKED` so concurrent ticks don't
 *      double-process. For each row: INSERT a `notifications` feed
 *      entry, mark the schedule row `'sent'` + link via
 *      `emitted_notification_id`. Push attempts are queued in-memory
 *      and dispatched post-commit (best-effort; DB is source of truth).
 *      Each row delivers inside its own SAVEPOINT (2026-09-03), so a
 *      broken row fails alone and PARKS after `MAX_DELIVERY_ATTEMPTS`
 *      instead of rolling back every batch-mate on every tick forever.
 *
 *   2. **§J.1 membership roll.** Open each due subscription's next month
 *      (advance period + card-backed invoice) or hard-stop at term end.
 *      Before the charge pass so a rolled invoice charges this tick.
 *
 *   3a. **Invoice attempt verify** (2026-08-12,
 *      `designs/auto-charge-unknown-outcome.md`). Resolve every auto-charge
 *      attempt whose outcome is still unknown — retrieve the PaymentIntent
 *      when its id is known, re-issue the identical request under the SAME
 *      idempotency key when it isn't, park for a human past the window.
 *      Deliberately BEFORE the charge pass: the charge lane refuses to charge
 *      an invoice with an unresolved attempt, so resolving doubt first is what
 *      keeps that refusal from also meaning "and therefore never charged".
 *
 *   3a-ter. **Capture reconciler** (2026-08-20, wire 1.11.0). Finish
 *      collecting money we already HOLD. Manual capture on `POST /enrollments`
 *      leaves one new state behind — a dog enrolled with its authorization not
 *      yet captured — and this phase captures it, or raises the one alarm a
 *      human must see: an enrolled dog whose hold is GONE will never be
 *      charged. Before the charge pass for the same reason as its neighbours:
 *      resolve what is already in flight before starting anything new.
 *
 *   3a-quater. **Order sweeper** (P15, design §2.7:3953-3974). Take every order
 *      charge past its lease and settle it forward, or abandon it if no intent id
 *      was stored. It never tries a card. Before the charge pass for the same
 *      reason as its neighbours.
 *
 *   3a-bis. **Duplicate-refund retry** (2026-08-12). Re-fire lost-race refund
 *      rows still `pending` with no `stripe_refund_id`, under the SAME
 *      idempotency key the first attempt used. Before the charge pass for the
 *      same reason the verify lane is: money we already owe back outranks
 *      money we are about to ask for.
 *
 *   3b. **Invoice auto-charge.** Compose Day-15's
 *      `runInvoiceAutoChargeOnce` so one cron firing handles BOTH
 *      outbound notifications AND invoice dunning — fewer moving parts
 *      operationally.
 *
 *   4. **Media derivatives** (Day 17). Claim → sharp → settle per job.
 *
 *   5. **Credit-expiry warnings — retired at 2.0.0** (S01, design §2.1,
 *      r3-fable #2). The scan read `credit_expiry_settings.warning_lead_days`
 *      (60), a store no setting names from 2.0.0, so every one-month lot was
 *      inside its window the day it was bought. The phase no longer runs; its
 *      result stays `{scanned: 0, enqueued: 0}` so the tick log keeps its keys.
 *      CRED-U13 builds the real notice off `cred.expiry_warning_lead_days` at
 *      7.1.0; S25 (M4.07) removes the scan and its table.
 *
 *   6. **§J.3 alumni attendance** (monthly, self-gated on the 1st
 *      Chicago). Flag + notify alumni dogs under 2 attended qualifying
 *      sessions in the just-closed month.
 *
 *   7. **Overdue invoices.** Enqueue `invoice-overdue` for card-backed
 *      invoices still open past their grace window.
 *
 *   8. **Expiring default cards.** Enqueue `card-expiring` before the
 *      card that backs every auto-charge lapses, and once after.
 *
 *   9. **`idempotency_keys` TTL sweep.** Prune completed rows past the
 *      retry-safety window (24h) and open ones past 7 days: an open claim may
 *      be the only record of an order still processing, so it must outlive the
 *      window a completed one gets. One Postgres DELETE; runs on the pool runner
 *      outside any tx.
 *
 * Failures are logged-and-swallowed at each phase boundary — every phase since
 * 2026-09-03 (phase 1 was the lone exception, and that hole was the
 * 2026-09-02 production incident) — so a flaky Expo call can't block invoice
 * dunning, and a stuck dunning attempt can't block the TTL sweep. Returns a
 * per-phase result summary.
 *
 * The scheduler actor — `system:scheduler` — is distinct from the
 * Day-15 invoice worker's `system:stripe-webhook`. Different
 * principal-of-mutation = different audit-log lineage. The composed
 * invoice run inside this scheduler tick keeps its own actor (Day-15
 * decision), so audit trails remain readable.
 */

const SCHEDULER_ACTOR = 'system:scheduler';

/** Idempotency-key TTL window. 24h is comfortably longer than any
 *  client retry loop and short enough to keep the table small. */
const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Failed delivery attempts a `scheduled_notifications` row gets before it
 * PARKS — `failed_at` stamped, dropped from the claim, waiting on a human
 * (2026-09-03, `designs/phase-1-poison-row-isolation.md`).
 *
 * **3, ruled by Allison 2026-09-03; was 5 as the design default** ("lets just
 * have 3 retries and if after 3rd attempt…", that design's § Decisions,
 * question 1). At the minutely tick it is about three minutes of retries —
 * long enough to ride out a transient blip on ONE row, short enough that a
 * genuinely broken row reaches a human while it still matters instead of
 * raising a low-grade alarm forever. A DB-wide outage does not spend these
 * attempts at all: a batch that fails ENTIRELY is systemic and records nothing
 * (see the loop below). Exported because the retry budget is the contract the
 * parking tests assert against, not an implementation detail — and changing it
 * is a one-line change here.
 */
export const MAX_DELIVERY_ATTEMPTS = 3;

export interface SchedulerTickOpts {
  expoPush?: ExpoPushClient;
  /** R2 client for the media-derivatives phase (Day 17). */
  r2?: R2Client;
  /** Stripe client for the invoice auto-charge phase. Defaults to the
   *  production client inside `runInvoiceAutoChargeOnce`; the §J lifecycle
   *  integration test injects the stub to drive roll → charge → settle
   *  through one composed tick. */
  stripe?: StripeClient;
  /** Per-tick batch size for the scheduled_notifications scan. Default 50. */
  notificationsLimit?: number;
  /** Per-tick batch size for the invoice auto-charge scan. Default 50. */
  invoiceLimit?: number;
  /** Per-tick batch size for the media-derivatives scan. Default 5
   *  (sharp is CPU-bound; small batch keeps tick latency bounded). */
  mediaDerivativesLimit?: number;
  /** "Now" for the scans + sweep cutoff. Tests pin a fixed instant. */
  now?: Date;
  /** Logger — defaults to no-op so tests stay quiet. */
  log?: WorkerLogger;
}

export interface ScheduledNotificationsTickResult {
  scanned: number;
  sent: number;
  /** Rows whose delivery threw this tick — rolled back alone. An attempt was
   *  recorded for each UNLESS the whole batch failed (systemic; see the loop). */
  failed: number;
  /** Of those, the rows that hit `MAX_DELIVERY_ATTEMPTS` and PARKED this tick. */
  parked: number;
  /**
   * Rows parked RIGHT NOW, across the whole table — the standing signal (A1.6),
   * not a per-tick delta. `null` means this tick could not count them (phase 1
   * threw at its boundary, or the count query itself failed): "I did not look"
   * is not "there are none", and the difference decides whether
   * `POST /workers/tick` overwrites what `GET /health/watchdog` reads.
   */
  parkedTotal: number | null;
  /**
   * **Did the queue DELIVER this tick?** (A2.1, ruled by Allison 2026-09-03.)
   *
   * `true` when the phase ran to the end and did NOT take the systemic branch —
   * a delivering tick, a mixed or poison batch, and an EMPTY claim are all
   * `true`, because an idle queue is healthy and a poison row already has its
   * own parked signal. `false` for the systemic branch, and `false` in the
   * boundary's DEFAULT result, so a phase that THREW is a not-delivering phase
   * too. `POST /workers/tick` turns `true` into a Redis freshness stamp;
   * `GET /health/watchdog` turns a stale stamp into a 503.
   *
   * It exists because this cycle's own fixes closed the two accidental paths to
   * that 503: the phase-1 boundary replaced the 500 that starved the heartbeat,
   * and the systemic branch stopped an outage from parking anything.
   */
  queueOk: boolean;
  pushTicketsOk: number;
  pushTicketsError: number;
}

export interface SchedulerTickResult {
  scheduledNotifications: ScheduledNotificationsTickResult;
  membershipRoll: MembershipRollResult;
  invoiceOverdue: EnqueueInvoiceOverdueWarningsResult;
  cardExpiry: EnqueueCardExpiryWarningsResult;
  invoiceAttemptVerify: InvoiceAttemptVerifyTickResult;
  captureReconciler: CaptureReconcilerTickResult;
  orderSweeper: OrderSweeperTickResult;
  duplicateRefundRetry: DuplicateRefundRetryTickResult;
  invoiceAutoCharge: InvoiceAutoChargeTickResult;
  mediaDerivatives: MediaDerivativesTickResult;
  creditExpiryWarnings: EnqueueCreditExpiryWarningsResult;
  alumniAttendance: AlumniAttendanceScanResult;
  idempotencyKeysSwept: number;
}

const NOOP_LOG: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Run one scheduler tick. Safe to call concurrently — the
 * `FOR UPDATE SKIP LOCKED` claim ensures each scheduled row is processed
 * by exactly one worker; the invoice sub-tick inherits the same lock
 * discipline from Day-15.
 */
export async function runSchedulerTickOnce(
  opts: SchedulerTickOpts = {},
): Promise<SchedulerTickResult> {
  const expoPush = opts.expoPush ?? defaultExpoPushClient;
  const log = opts.log ?? NOOP_LOG;
  const now = opts.now ?? new Date();

  // Phase 1 — scheduled-notifications claim + deliver. Own log-and-swallow
  // boundary, like every sibling phase below. It was the ONLY phase without one
  // until 2026-09-03: on 2026-09-02 the first production tick hit a schema drift
  // here (`column "deep_link_kind" does not exist`), the throw escaped, the
  // route answered 500, and phases 2–12 — including the four money phases —
  // never ran, 27 ticks in a row. The comment at phase 3b below records the
  // previous time this exact class was found about a different phase.
  let notificationsResult: ScheduledNotificationsTickResult = {
    scanned: 0,
    sent: 0,
    failed: 0,
    parked: 0,
    // `null`, not 0 — a phase that threw did not count the parked rows, and
    // publishing 0 from here would clear the watchdog's standing parked-row
    // reason on exactly the tick that proved something is wrong.
    parkedTotal: null,
    // `false` for the same reason one line up, one question over (A2.1): a
    // phase that THREW delivered nothing, so the tick must not refresh
    // `scheduler:queue_ok_at`. Before the boundary above existed, this state
    // was a 500 that never reached `recordSchedulerTick` and went red on
    // heartbeat staleness by accident; the boundary is right and the red has
    // to come back on purpose.
    queueOk: false,
    pushTicketsOk: 0,
    pushTicketsError: 0,
  };
  try {
    notificationsResult = await runScheduledNotificationsTick(
      expoPush,
      log,
      opts.notificationsLimit,
      now,
    );
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'scheduled-notifications',
        err: err instanceof Error ? err.message : String(err),
      },
      'scheduled-notifications phase threw at the worker boundary; will retry next tick',
    );
  }

  // Phase 2 — §J.1 membership roll. Runs BEFORE the invoice auto-charge so a
  // freshly-rolled month's invoice (due_at = period start ≤ now) is scooped
  // by THIS tick's charge pass rather than waiting a full tick. Own tx, own
  // log-and-swallow boundary so a roll failure can't block dunning.
  let membershipRollResult: MembershipRollResult = { scanned: 0, rolled: 0, completed: 0 };
  try {
    membershipRollResult = await withActor(SCHEDULER_ACTOR, (tx) => rollDueMemberships(tx, now));
    log.info(
      {
        workerTick: 'scheduler',
        phase: 'membership-roll',
        scanned: membershipRollResult.scanned,
        rolled: membershipRollResult.rolled,
        completed: membershipRollResult.completed,
      },
      'membership roll complete',
    );
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'membership-roll',
        err: err instanceof Error ? err.message : String(err),
      },
      'membership-roll phase threw at the worker boundary; will retry next tick',
    );
  }

  // Phase 3a — resolve unknown auto-charge outcomes BEFORE charging anything.
  // Its own log-and-swallow boundary: a Stripe outage in the verify lane must
  // not stop the dunning ladder for every other invoice (the charge lane
  // refuses only the invoices that actually carry an unresolved attempt).
  let invoiceAttemptVerifyResult: InvoiceAttemptVerifyTickResult = { scanned: 0, results: [] };
  try {
    invoiceAttemptVerifyResult = await runInvoiceAttemptVerifyOnce({
      ...(opts.stripe !== undefined ? { stripe: opts.stripe } : {}),
      now,
      log,
    });
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'invoice-attempt-verify',
        err: err instanceof Error ? err.message : String(err),
      },
      'invoice-attempt-verify phase threw at the worker boundary; will retry next tick',
    );
  }

  // Phase 3a-ter — finish collecting money we already HOLD, before anything
  // else touches a card. Manual capture (wire 1.11.0) leaves exactly one new
  // state behind — a dog enrolled with its authorization not yet captured —
  // and this is the phase that closes it or names it. It runs before the
  // charge lane for the same reason the verify lane does: resolve what is
  // already in flight before starting anything new. Own log-and-swallow
  // boundary like every sibling.
  let captureReconcilerResult: CaptureReconcilerTickResult = {
    scanned: 0,
    captured: 0,
    lostHolds: 0,
    withdrawnReleased: 0,
    refundedPostWithdraw: 0,
    refundedSurplus: 0,
    settledInvoices: 0,
    abandoned: 0,
    abandonedTruncated: false,
    abandonedUncollected: 0,
    results: [],
  };
  try {
    captureReconcilerResult = await runCaptureReconcilerOnce({
      ...(opts.stripe !== undefined ? { stripe: opts.stripe } : {}),
      now,
      log,
    });
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'capture-reconciler',
        err: err instanceof Error ? err.message : String(err),
      },
      'capture-reconciler phase threw at the worker boundary; will retry next tick',
    );
  }

  // Phase 3a-quater — the order sweeper. Crash recovery, forward only, with its own
  // log-and-swallow boundary like every sibling.
  let orderSweeperResult: OrderSweeperTickResult = {
    scanned: 0,
    abandoned: 0,
    settled: 0,
    failed: 0,
    lateRefunded: 0,
    left: 0,
  };
  try {
    // `opts.now`, not the resolved `now`: in production nothing is injected, and a lease
    // is judged on Postgres's clock, never this process's.
    orderSweeperResult = await runOrderSweeperOnce({
      stripe: opts.stripe ?? defaultStripeClient,
      now: opts.now,
      log,
    });
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'order-sweeper',
        err: err instanceof Error ? err.message : String(err),
      },
      'order-sweeper phase threw at the worker boundary; will retry next tick',
    );
  }

  // Phase 3a-bis — send back the money we already know we owe, BEFORE charging
  // anyone anything new. These are `refunds` rows written 'pending' by a lost
  // settle race whose post-commit Stripe call failed; nothing retried them
  // until this phase existed, so each one was a permanent double charge. Own
  // log-and-swallow boundary like every sibling.
  let duplicateRefundRetryResult: DuplicateRefundRetryTickResult = {
    scanned: 0,
    sent: 0,
    abandoned: 0,
    abandonedTruncated: false,
    abandonedByClass: {
      'row-keyed': 0,
      'client-keyed': 0,
      'never-sent': 0,
      'stripe-failed': 0,
      covered: 0,
    },
    results: [],
  };
  try {
    duplicateRefundRetryResult = await runDuplicateRefundRetryOnce({
      ...(opts.stripe !== undefined ? { stripe: opts.stripe } : {}),
      now,
      log,
    });
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'duplicate-refund-retry',
        err: err instanceof Error ? err.message : String(err),
      },
      'duplicate-refund-retry phase threw at the worker boundary; will retry next tick',
    );
  }

  // Phase 3b — the charge lane. Its own log-and-swallow boundary, like every
  // sibling phase: it was the ONLY phase without one, and the thing most likely
  // to throw out of it is the DB interlock (`invoice_charge_attempts_unresolved_uq`)
  // doing its job. That would have cost the remaining leased invoices AND every
  // later phase — media derivatives, credit expiry, the idempotency sweep —
  // once a minute for as long as the condition held.
  let invoiceResult: InvoiceAutoChargeTickResult = { scanned: 0, results: [] };
  try {
    invoiceResult = await runInvoiceAutoChargeOnce({
      ...(opts.stripe !== undefined ? { stripe: opts.stripe } : {}),
      limit: opts.invoiceLimit,
      now,
      log,
    });
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'invoice-auto-charge',
        err: err instanceof Error ? err.message : String(err),
      },
      'invoice-auto-charge phase threw at the worker boundary; will retry next tick',
    );
  }

  // Phase 4 — media derivatives (Day 17). Each job runs claim → sharp →
  // settle independently; failures stay parked on the job row and don't
  // block the rest of the tick. The composed worker uses its own R2
  // client seam (defaults to the production client when not injected).
  let mediaDerivativesResult: MediaDerivativesTickResult;
  try {
    mediaDerivativesResult = await runMediaDerivativesOnce({
      r2: opts.r2,
      limit: opts.mediaDerivativesLimit,
      log,
    });
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'media-derivatives',
        err: err instanceof Error ? err.message : String(err),
      },
      'media-derivatives phase threw at the worker boundary; will retry next tick',
    );
    mediaDerivativesResult = { scanned: 0, results: [] };
  }

  // Phase 5 — credit-expiry warnings: RETIRED at 2.0.0 (S01; see the header).
  // `enqueueCreditExpiryWarnings` read the legacy 60-day lead, so it noticed a
  // one-month lot the day it was bought. Nothing calls it from here; the result
  // stays zero so `creditExpiryWarnings*` keep their place in the tick log.
  const creditExpiryWarningsResult: EnqueueCreditExpiryWarningsResult = {
    scanned: 0,
    enqueued: 0,
  };

  // Phase 6 — §J.3 alumni attendance (monthly). Self-gated on the 1st
  // (Chicago) inside the scan; every other day it returns `ran: false` at the
  // cost of one Intl format. Enqueues `alumni-attendance` notifications +
  // stamps `dogs.alumni_attendance_flagged_at` for alumni dogs that attended
  // <2 qualifying sessions in the just-closed month. Own tx, own
  // log-and-swallow boundary.
  let alumniAttendanceResult: AlumniAttendanceScanResult = {
    ran: false,
    scanned: 0,
    enqueued: 0,
    flagged: 0,
  };
  try {
    alumniAttendanceResult = await withActor(SCHEDULER_ACTOR, (tx) =>
      enqueueAlumniAttendanceFlags(tx, now),
    );
    if (alumniAttendanceResult.ran) {
      log.info(
        {
          workerTick: 'scheduler',
          phase: 'alumni-attendance',
          scanned: alumniAttendanceResult.scanned,
          enqueued: alumniAttendanceResult.enqueued,
          flagged: alumniAttendanceResult.flagged,
        },
        'alumni-attendance monthly scan complete',
      );
    }
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'alumni-attendance',
        err: err instanceof Error ? err.message : String(err),
      },
      'alumni-attendance phase threw at the worker boundary; will retry next tick',
    );
  }

  // Phase 7 — overdue invoices (Allison 2026-07-29). The safety net beneath the
  // auto-charge lane: a card-backed invoice still open past its grace window
  // that nothing else has told the owner about. Own tx, own log-and-swallow
  // boundary, same as every scan phase above.
  let invoiceOverdueResult: EnqueueInvoiceOverdueWarningsResult = { scanned: 0, enqueued: 0 };
  try {
    invoiceOverdueResult = await withActor(SCHEDULER_ACTOR, (tx) =>
      enqueueInvoiceOverdueWarnings(tx, now),
    );
    log.info(
      {
        workerTick: 'scheduler',
        phase: 'invoice-overdue',
        scanned: invoiceOverdueResult.scanned,
        enqueued: invoiceOverdueResult.enqueued,
      },
      'invoice-overdue scan complete',
    );
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'invoice-overdue',
        err: err instanceof Error ? err.message : String(err),
      },
      'invoice-overdue phase threw at the worker boundary; will retry next tick',
    );
  }

  // Phase 8 — expiring default cards (Allison 2026-07-29). Warns before the
  // card that backs every auto-charge lapses, and once more after it has.
  let cardExpiryResult: EnqueueCardExpiryWarningsResult = { scanned: 0, enqueued: 0 };
  try {
    cardExpiryResult = await withActor(SCHEDULER_ACTOR, (tx) => enqueueCardExpiryWarnings(tx, now));
    log.info(
      {
        workerTick: 'scheduler',
        phase: 'card-expiry',
        scanned: cardExpiryResult.scanned,
        enqueued: cardExpiryResult.enqueued,
      },
      'card-expiry scan complete',
    );
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'card-expiry',
        err: err instanceof Error ? err.message : String(err),
      },
      'card-expiry phase threw at the worker boundary; will retry next tick',
    );
  }

  const sweepCutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
  const openClaimCutoff = new Date(
    now.getTime() - IDEMPOTENCY_OPEN_CLAIM_MAX_DAYS * 24 * 60 * 60 * 1000,
  );
  let idempotencyKeysSwept = 0;
  try {
    idempotencyKeysSwept = await sweepExpiredIdempotencyKeys({
      completedBefore: sweepCutoff,
      openBefore: openClaimCutoff,
    });
    log.info(
      {
        workerTick: 'scheduler',
        sweptKeys: idempotencyKeysSwept,
        sweepCutoff: sweepCutoff.toISOString(),
      },
      'idempotency_keys TTL sweep',
    );
  } catch (err) {
    log.warn(
      { workerTick: 'scheduler', err: err instanceof Error ? err.message : String(err) },
      'idempotency_keys TTL sweep failed; will retry next tick',
    );
  }

  return {
    scheduledNotifications: notificationsResult,
    membershipRoll: membershipRollResult,
    invoiceAttemptVerify: invoiceAttemptVerifyResult,
    captureReconciler: captureReconcilerResult,
    orderSweeper: orderSweeperResult,
    duplicateRefundRetry: duplicateRefundRetryResult,
    invoiceAutoCharge: invoiceResult,
    mediaDerivatives: mediaDerivativesResult,
    creditExpiryWarnings: creditExpiryWarningsResult,
    alumniAttendance: alumniAttendanceResult,
    invoiceOverdue: invoiceOverdueResult,
    cardExpiry: cardExpiryResult,
    idempotencyKeysSwept,
  };
}

/**
 * Phase 1 — claim due scheduled rows, INSERT notifications + link, then
 * post-commit push attempt. The tx commit makes the in-app feed entries
 * permanent BEFORE we attempt push, which is the right invariant: the
 * owner is going to see the bell in-app even if Expo is having a bad
 * day. Push failure is observability, not correctness.
 *
 * **Per-row isolation (2026-09-03, `designs/phase-1-poison-row-isolation.md`).**
 * Each row is delivered inside its own SAVEPOINT, so one broken row rolls back
 * ALONE and its eleven batch-mates still commit and still reach their owners.
 * Before this, a single throw rolled back the whole claim — and since the claim
 * re-selects the same rows a minute later, nobody in that batch was ever
 * notified again.
 *
 * A SAVEPOINT and not a per-row transaction: the batch tx is what holds the
 * `FOR UPDATE SKIP LOCKED` claim, and a per-row transaction would release that
 * lock before delivery, letting a concurrent tick re-claim the row mid-flight.
 *
 * **Isolation is not blame.** A retry attempt is spent only on a row that failed
 * while its batch-mates succeeded; a batch of ≥ 2 that fails ENTIRELY is
 * systemic — a DB or deploy fault, not a poison row — and records nothing, so
 * the queue comes back on its own the moment the cause is fixed (A1.1).
 */
async function runScheduledNotificationsTick(
  expoPush: ExpoPushClient,
  log: WorkerLogger,
  limit: number | undefined,
  now: Date,
): Promise<ScheduledNotificationsTickResult> {
  // We collect outbound push messages inside the tx and dispatch after
  // commit. An owner with zero device_tokens still gets the in-app feed
  // entry — push is a notification *channel*, not the notification itself.
  const pendingPushes: ExpoPushMessage[] = [];
  let scanned = 0;
  let sent = 0;
  let failed = 0;
  let parked = 0;
  // A2.1. Set by the systemic branch alone; everything else that reaches the
  // end of `withActor` — a delivering batch, a mixed one, an empty claim — is a
  // queue that is DELIVERING. A throw out of `withActor` never gets here at
  // all: it propagates to the phase boundary, whose default result says
  // `queueOk: false` for exactly that case.
  let systemic = false;

  await withActor(SCHEDULER_ACTOR, async (tx) => {
    const batch = await scheduledNotificationsRepository.lockDueForSend(tx, {
      limit,
      now,
    });
    scanned = batch.length;
    log.info(
      { workerTick: 'scheduler', phase: 'scheduled-notifications', batchSize: batch.length },
      'scheduler tick claimed scheduled_notifications batch',
    );
    // Failures are COLLECTED here and adjudicated after the loop. Charging an
    // attempt at the moment of the throw cannot tell "this row is broken" from
    // "the database is broken", and the second one is a queue-wide outage: a
    // column drift one table over (the 2026-09-02 class, on `notifications` or
    // `owners` or `device_tokens` rather than on the claim projection) or a
    // three-minute statement-timeout episode fails EVERY claimed row every
    // tick, and three ticks later every due notification — reminders,
    // `payment-failed`, `invoice-overdue`, `card-expiring` — is parked, the
    // tick answers 200, and fixing the cause brings none of them back. Before
    // this phase learned to park, that same outage self-healed (A1.1).
    const failures: Array<{ row: ScheduledNotificationRow; message: string }> = [];
    for (const row of batch) {
      try {
        // Drizzle's node-postgres driver implements a nested `.transaction()`
        // as a real SAVEPOINT / ROLLBACK TO SAVEPOINT pair
        // (`drizzle-orm/node-postgres/session.js`) — the same mechanism
        // `routes/enrollments.ts`'s per-dog isolation rests on. That is what
        // makes "this row fails alone" true at the DB level rather than as a
        // wish, and it leaves the outer tx usable afterwards, so the failure
        // can be RECORDED rather than merely swallowed.
        //
        // Cost, measured rather than assumed: one cached subtransaction id per
        // row, whether it succeeds or fails (an aborted subtransaction releases
        // its xid). See the batch-limit comment in the repository.
        const outcome = await tx.transaction(async (sp) => {
          const inserted = await deliverOne(sp, row);
          const flipped = await scheduledNotificationsRepository.markSent(sp, {
            id: row.id,
            emittedNotificationId: inserted.notificationId,
          });
          if (flipped === 0) {
            // Defense-in-depth: a row claimed under SKIP LOCKED shouldn't
            // already be 'sent'. If it is, the INSERT above just created a
            // duplicate notifications row — log it for follow-up. Returned as
            // a normal (non-throwing) outcome so the savepoint RELEASEs: this
            // is not a delivery failure and must not spend a retry attempt.
            log.warn(
              { workerTick: 'scheduler', scheduledId: row.id },
              'scheduler: scheduled row flipped out from under us (duplicate notification possible)',
            );
            return { delivered: false as const, pushMessages: [] as ExpoPushMessage[] };
          }
          return { delivered: true as const, pushMessages: inserted.pushMessages };
        });
        if (!outcome.delivered) continue;
        sent += 1;
        pendingPushes.push(...outcome.pushMessages);
      } catch (err) {
        // The savepoint has already rolled back this row's writes and the batch
        // tx is usable again. Nothing is written yet — see the adjudication
        // below.
        failures.push({ row, message: err instanceof Error ? err.message : String(err) });
      }
    }

    failed = failures.length;
    if (failures.length === 0) return;

    // SYSTEMIC: every row in a batch of two or more failed. Nothing about this
    // batch says which row is at fault, so no row pays for it — the rows stay
    // pending and untouched, and the next tick retries all of them. One
    // phase-level alarm, with a CONSTANT sentence: the counts and the first
    // error text are templated INTO it, where the pager's digit-normalisation
    // collapses them to `N`.
    //
    // The merge object below therefore carries NOTHING that varies — no row
    // ids, and (since A2.2) not `batchSize` either. `identifyingExtra`
    // (`src/lib/observability.js`) renders every scalar in it UN-normalised, so
    // `batchSize` alone was enough to mint a fresh first-ever fingerprint on
    // every tick of one outage as the queue backed up behind it: executed twice
    // and independently, nine ticks with the batch growing 2 → 10 paged NINE
    // times, against three (`IDENTICAL_ALLOWANCE`, then suppressed) once the
    // count rides only the sentence. A continuing outage is one condition, and
    // until A2.2 this comment asserted that of code that did not do it.
    //
    // A batch of ONE that fails takes the poison path below. It is genuinely
    // ambiguous — one row and one failure look identical whether the row or the
    // database is broken — and treating it as systemic would mean a single
    // permanently-broken row could never park as long as it was alone in its
    // batch, which is the every-minute-forever alarm this design rejected. The
    // remedy if it WAS systemic is the bulk un-park verb in the migration file.
    if (failures.length === batch.length && batch.length >= 2) {
      systemic = true;
      log.error(
        {
          workerTick: 'scheduler',
          phase: 'scheduled-notifications',
        },
        `scheduled-notifications: every claimed row failed (${failures.length} of ${batch.length}) — ` +
          `treating as systemic, no attempts spent; will retry next tick: ${failures[0]?.message ?? ''}`,
      );
      return;
    }

    // POISON: this row failed while its batch-mates succeeded, so the attempt
    // is charged to it.
    for (const failure of failures) {
      // Its OWN savepoint (A1.5 as re-ruled). If this write throws — the
      // savepoint statement itself failing, leaving the connection in an
      // aborted transaction — the throw is allowed to ESCAPE to the phase
      // boundary, which is loud. There is deliberately no catch-and-continue
      // here: inside an already-aborted transaction every later statement is
      // 25P02 and the COMMIT degrades to a silent ROLLBACK, so the tick would
      // report "sent 11 / failed 1" and commit nothing at all, with no alarm.
      const attempt = await tx.transaction(async (sp) =>
        scheduledNotificationsRepository.recordAttemptFailure(sp, {
          id: failure.row.id,
          error: failure.message,
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        }),
      );
      if (attempt.outcome === 'gone') {
        // The row is not there to record against. Its own sentence rather than
        // a zeroth attempt, because nothing will retry a row that no longer
        // exists and a human reading "attempt 0 of 3" would wait for one.
        log.error(
          {
            workerTick: 'scheduler',
            phase: 'scheduled-notifications',
            scheduledId: failure.row.id,
            dedupeKey: failure.row.dedupeKey,
            err: failure.message,
          },
          'scheduled notification delivery failed and the row vanished under the claim lock — nothing was recorded',
        );
        continue;
      }
      if (attempt.parked) parked += 1;
      // The alarm. `scheduledId` + `dedupeKey` are the identifying scalars, so
      // the pager's fingerprints are scoped to THIS row (deliberate
      // over-uniqueness, D20-A4) rather than collapsing a broken row into the
      // noise of every other. The attempt COUNT is templated into the sentence,
      // never put in the merge object: every scalar in that object is
      // identifying and un-normalised (`observability.ts` `identifyingExtra`),
      // so `attempts: n` minted a fresh first-ever fingerprint on every retry,
      // while digits in the SENTENCE normalise to `N`. Two fingerprints per
      // row, then: the retry line, and the PARKED line — deliberately distinct
      // text because it is a different event (nobody is retrying this row
      // again) and must page on its own rather than dedupe into the line that
      // preceded it.
      log.error(
        {
          workerTick: 'scheduler',
          phase: 'scheduled-notifications',
          scheduledId: failure.row.id,
          dedupeKey: failure.row.dedupeKey,
          err: failure.message,
        },
        attempt.parked
          ? `scheduled notification PARKED after ${attempt.attempts} attempts — needs a human`
          : `scheduled notification delivery failed (attempt ${attempt.attempts} of ${MAX_DELIVERY_ATTEMPTS}); ` +
              `row left pending for the next tick`,
      );
    }
  });

  // The standing signal (A1.6), read ONCE per tick on the pool AFTER the batch
  // tx has committed — never inside it, where it would extend the window the
  // claim's row locks are held. Its own try/catch: a count that cannot be taken
  // must not discard the delivery results of a tick that already ran, and must
  // not be reported as zero.
  let parkedTotal: number | null = null;
  try {
    parkedTotal = await scheduledNotificationsRepository.countParked(db);
  } catch (err) {
    log.warn(
      {
        workerTick: 'scheduler',
        phase: 'scheduled-notifications',
        err: err instanceof Error ? err.message : String(err),
      },
      'could not count parked scheduled notifications; the standing parked-row signal is unchanged this tick',
    );
  }

  const { pushTicketsOk, pushTicketsError } = await dispatchPushes(expoPush, pendingPushes, log);

  return {
    scanned,
    sent,
    failed,
    parked,
    parkedTotal,
    queueOk: !systemic,
    pushTicketsOk,
    pushTicketsError,
  };
}

/**
 * Per-row: INSERT the notifications feed row (links the dog as
 * `notification_dogs` when set) — this ALWAYS happens; the in-app feed is the
 * source of truth. The PUSH channel is then gated by the owner's D3 preferences
 * (master switch + per-category mute), read in-tx for a snapshot consistent with
 * the feed INSERT: an owner who muted pushes — or this notification's category —
 * still gets the feed entry but zero push messages. Otherwise we look up the
 * owner's live push tokens and build one message per device. The tokens lookup
 * happens inside the tx — a snapshot at this moment; tokens registered between
 * commit and dispatch get the next push, not this one.
 */
async function deliverOne(
  tx: Tx,
  row: ScheduledNotificationRow,
): Promise<{ notificationId: string; pushMessages: ExpoPushMessage[] }> {
  const inserted = await notificationsRepository.enqueue(tx, {
    ownerId: row.ownerId,
    type: row.type,
    title: row.title,
    body: row.body,
    deepLinkPath: row.deepLinkPath,
    deepLinkKind: row.deepLinkKind,
    deepLinkId: row.deepLinkId,
    dogIds: row.dogId ? [row.dogId] : [],
  });

  // D3: the feed entry has landed; consult push preferences before fanning out.
  // Absent an explicit opt-out we send (jsonb defaults to '{}', so "no
  // preference" means "notify") — only an owner who turned pushes off or muted
  // this category gets zero messages.
  const prefs = await ownersRepository.findPushPrefs(tx, row.ownerId);
  if (prefs !== undefined && shouldSkipPush(row.type, prefs)) {
    return { notificationId: inserted.id, pushMessages: [] };
  }

  const tokens = await deviceTokensRepository.findLiveByOwner(tx, row.ownerId);
  const pushMessages: ExpoPushMessage[] = tokens.map((token) => {
    const data = {
      type: row.type,
      notification_id: inserted.id,
      ...(row.deepLinkPath ? { deep_link_path: row.deepLinkPath } : {}),
    } satisfies NotificationPushData;
    return {
      to: token.expoPushToken,
      title: row.title,
      body: row.body,
      sound: 'default',
      data,
    };
  });

  return { notificationId: inserted.id, pushMessages };
}

/**
 * Best-effort batch dispatch. A throw from `sendBatch` (transport
 * failure) downgrades to a warn log + counts the batch as all-errored.
 * Per-ticket errors are counted but don't bubble; DB is the source of
 * truth and the owner already has the in-app feed entry.
 */
async function dispatchPushes(
  expoPush: ExpoPushClient,
  messages: ExpoPushMessage[],
  log: WorkerLogger,
): Promise<{ pushTicketsOk: number; pushTicketsError: number }> {
  if (messages.length === 0) {
    return { pushTicketsOk: 0, pushTicketsError: 0 };
  }
  let tickets: ExpoPushTicket[];
  try {
    tickets = await expoPush.sendBatch(messages);
  } catch (err) {
    log.warn(
      {
        workerTick: 'scheduler',
        phase: 'push-dispatch',
        messageCount: messages.length,
        err: err instanceof Error ? err.message : String(err),
      },
      'scheduler push dispatch failed; in-app feed entries already landed',
    );
    return { pushTicketsOk: 0, pushTicketsError: messages.length };
  }
  let pushTicketsOk = 0;
  let pushTicketsError = 0;
  for (const ticket of tickets) {
    if (ticket.status === 'ok') {
      pushTicketsOk += 1;
    } else {
      pushTicketsError += 1;
      log.warn(
        {
          workerTick: 'scheduler',
          phase: 'push-ticket',
          ticketStatus: ticket.status,
          ticketMessage: ticket.message,
          ticketError: ticket.details?.error,
        },
        'scheduler: per-message push ticket error',
      );
    }
  }
  return { pushTicketsOk, pushTicketsError };
}
