import { deviceTokensRepository } from '../db/repositories/deviceTokensRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { ownersRepository } from '../db/repositories/ownersRepository.js';
import {
  scheduledNotificationsRepository,
  type ScheduledNotificationRow,
} from '../db/repositories/scheduledNotificationsRepository.js';
import { shouldSkipPush } from '../lib/pushPreferences.js';
import type { NotificationPushData } from '../contracts/wire.js';
import { sweepExpiredIdempotencyKeys } from '../db/idempotency.js';
import {
  enqueueAlumniAttendanceFlags,
  type AlumniAttendanceScanResult,
} from '../lib/alumniAttendanceScan.js';
import {
  enqueueCreditExpiryWarnings,
  type EnqueueCreditExpiryWarningsResult,
} from '../lib/enqueueCreditExpiryWarnings.js';
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
import type { StripeClient } from '../lib/stripe.js';
import { runInvoiceAutoChargeOnce, type InvoiceAutoChargeTickResult } from './invoiceAutoCharge.js';
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
 *
 *   2. **§J.1 membership roll.** Open each due subscription's next month
 *      (advance period + card-backed invoice) or hard-stop at term end.
 *      Before the charge pass so a rolled invoice charges this tick.
 *
 *   3. **Invoice auto-charge.** Compose Day-15's
 *      `runInvoiceAutoChargeOnce` so one cron firing handles BOTH
 *      outbound notifications AND invoice dunning — fewer moving parts
 *      operationally.
 *
 *   4. **Media derivatives** (Day 17). Claim → sharp → settle per job.
 *
 *   5. **Credit-expiry warnings** (credit-expiry Phase 3). Enqueue
 *      `credits-expiring` per lot inside its location's warning window.
 *
 *   6. **§J.3 alumni attendance** (monthly, self-gated on the 1st
 *      Chicago). Flag + notify alumni dogs under 2 attended qualifying
 *      sessions in the just-closed month.
 *
 *   7. **`idempotency_keys` TTL sweep.** Prune rows older than the
 *      retry-safety window (24h default) per schema.sql lines ~918-920.
 *      One Postgres DELETE; runs on the pool runner outside any tx.
 *
 * Failures are logged-and-swallowed at each phase boundary so a flaky
 * Expo call can't block invoice dunning, and a stuck dunning attempt
 * can't block the TTL sweep. Returns a per-phase result summary.
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
  pushTicketsOk: number;
  pushTicketsError: number;
}

export interface SchedulerTickResult {
  scheduledNotifications: ScheduledNotificationsTickResult;
  membershipRoll: MembershipRollResult;
  invoiceOverdue: EnqueueInvoiceOverdueWarningsResult;
  cardExpiry: EnqueueCardExpiryWarningsResult;
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

  const notificationsResult = await runScheduledNotificationsTick(
    expoPush,
    log,
    opts.notificationsLimit,
    now,
  );

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

  const invoiceResult = await runInvoiceAutoChargeOnce({
    ...(opts.stripe !== undefined ? { stripe: opts.stripe } : {}),
    limit: opts.invoiceLimit,
    now,
    log,
  });

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

  // Phase 5 — credit-expiry warnings (credit-expiry lane, its Phase 3). Scan live,
  // non-exhausted credit lots within their location's warning window and
  // enqueue a `credits-expiring` scheduled notification per lot (dedup-keyed
  // on the lot id so a lot is warned exactly once across ticks). The enqueued
  // rows are delivered by THIS tick's Phase-1 delivery on the NEXT tick
  // (scheduled_for = now; the claim happens before this phase runs). Own tx,
  // own log-and-swallow boundary so a scan failure can't block the TTL sweep.
  let creditExpiryWarningsResult: EnqueueCreditExpiryWarningsResult = { scanned: 0, enqueued: 0 };
  try {
    creditExpiryWarningsResult = await withActor(SCHEDULER_ACTOR, (tx) =>
      enqueueCreditExpiryWarnings(tx, now),
    );
    log.info(
      {
        workerTick: 'scheduler',
        phase: 'credit-expiry-warnings',
        scanned: creditExpiryWarningsResult.scanned,
        enqueued: creditExpiryWarningsResult.enqueued,
      },
      'credit-expiry-warnings scan complete',
    );
  } catch (err) {
    log.error(
      {
        workerTick: 'scheduler',
        phase: 'credit-expiry-warnings',
        err: err instanceof Error ? err.message : String(err),
      },
      'credit-expiry-warnings phase threw at the worker boundary; will retry next tick',
    );
  }

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
    cardExpiryResult = await withActor(SCHEDULER_ACTOR, (tx) =>
      enqueueCardExpiryWarnings(tx, now),
    );
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
  let idempotencyKeysSwept = 0;
  try {
    idempotencyKeysSwept = await sweepExpiredIdempotencyKeys({ olderThan: sweepCutoff });
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
    for (const row of batch) {
      const inserted = await deliverOne(tx, row);
      const flipped = await scheduledNotificationsRepository.markSent(tx, {
        id: row.id,
        emittedNotificationId: inserted.notificationId,
      });
      if (flipped === 0) {
        // Defense-in-depth: a row claimed under SKIP LOCKED shouldn't
        // already be 'sent'. If it is, the INSERT above just created a
        // duplicate notifications row — log it for follow-up.
        log.warn(
          { workerTick: 'scheduler', scheduledId: row.id },
          'scheduler: scheduled row flipped out from under us (duplicate notification possible)',
        );
        continue;
      }
      sent += 1;
      pendingPushes.push(...inserted.pushMessages);
    }
  });

  const { pushTicketsOk, pushTicketsError } = await dispatchPushes(expoPush, pendingPushes, log);

  return { scanned, sent, pushTicketsOk, pushTicketsError };
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
