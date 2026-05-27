import { deviceTokensRepository } from '../db/repositories/deviceTokensRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import {
  scheduledNotificationsRepository,
  type ScheduledNotificationRow,
} from '../db/repositories/scheduledNotificationsRepository.js';
import { sweepExpiredIdempotencyKeys } from '../db/idempotency.js';
import { withActor, type Tx } from '../db/tx.js';
import {
  defaultExpoPushClient,
  type ExpoPushClient,
  type ExpoPushMessage,
  type ExpoPushTicket,
} from '../lib/expoPush.js';
import { runInvoiceAutoChargeOnce, type InvoiceAutoChargeTickResult } from './invoiceAutoCharge.js';

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
 * Three phases per tick, composed in order:
 *
 *   1. **`scheduled_notifications` claim + deliver.** Claim due 'pending'
 *      rows under `FOR UPDATE SKIP LOCKED` so concurrent ticks don't
 *      double-process. For each row: INSERT a `notifications` feed
 *      entry, mark the schedule row `'sent'` + link via
 *      `emitted_notification_id`. Push attempts are queued in-memory
 *      and dispatched post-commit (best-effort; DB is source of truth).
 *
 *   2. **Invoice auto-charge.** Compose Day-15's
 *      `runInvoiceAutoChargeOnce` so one cron firing handles BOTH
 *      outbound notifications AND invoice dunning — fewer moving parts
 *      operationally.
 *
 *   3. **`idempotency_keys` TTL sweep.** Prune rows older than the
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
  /** Per-tick batch size for the scheduled_notifications scan. Default 50. */
  notificationsLimit?: number;
  /** Per-tick batch size for the invoice auto-charge scan. Default 50. */
  invoiceLimit?: number;
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
  invoiceAutoCharge: InvoiceAutoChargeTickResult;
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

  const invoiceResult = await runInvoiceAutoChargeOnce({
    limit: opts.invoiceLimit,
    now,
    log,
  });

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
    invoiceAutoCharge: invoiceResult,
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
 * Per-row: INSERT the notifications row (links the dog as `notification_dogs`
 * when set), look up the owner's live push tokens, and build outbound
 * push messages. The tokens lookup happens inside the tx — the result
 * is a snapshot at this moment; tokens registered between commit and
 * dispatch don't get this push (they'll get the next one).
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
    dogIds: row.dogId ? [row.dogId] : [],
  });

  const tokens = await deviceTokensRepository.findLiveByOwner(tx, row.ownerId);
  const pushMessages: ExpoPushMessage[] = tokens.map((token) => ({
    to: token.expoPushToken,
    title: row.title,
    body: row.body,
    sound: 'default',
    data: {
      type: row.type,
      ...(row.deepLinkPath ? { deep_link_path: row.deepLinkPath } : {}),
      notification_id: inserted.id,
    },
  }));

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
