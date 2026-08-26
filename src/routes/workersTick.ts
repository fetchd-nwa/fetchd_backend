import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { defaultExpoPushClient, type ExpoPushClient } from '../lib/expoPush.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';
import { recordSchedulerTick } from '../lib/schedulerHeartbeat.js';
import type { WorkerLogger } from '../workers/invoiceAutoCharge.js';
import { runSchedulerTickOnce, type SchedulerTickResult } from '../workers/scheduler.js';

/**
 * `POST /workers/tick` `[public, signed]` — production scheduler trigger.
 *
 * Production wiring: `pg_cron` runs a `SELECT net.http_post(...)` SQL on
 * a cadence (every minute by default), POSTing here with
 * `Authorization: Bearer <SCHEDULER_WEBHOOK_SECRET>`. The route's
 * constant-time compare on that header is the only gate — no JWT path,
 * no owner principal, no Supabase verify. Same shape as
 * `/auth/webhook` and `/webhooks/stripe`: a signed public endpoint.
 *
 * Body is intentionally empty (no JSON parser registered). The tick is
 * a heartbeat — no per-request payload to pass. Optional Day-20+
 * extension: a `tick_id` from pg_cron's `cron.job_run_details` for
 * observability tracing.
 *
 * Failures inside `runSchedulerTickOnce` are logged-and-swallowed at the
 * worker boundary; this route always returns 200 on a valid auth so a
 * partial failure doesn't trigger pg_cron's own retry loop (pg_cron's
 * retry isn't aware of per-phase semantics; the worker is).
 *
 * Day-20 (D20-A2 §A2.3): after the completion log line, the route stamps a
 * Redis heartbeat that `GET /health/watchdog` reads. A tick that RAN records
 * it even when phases errored — phase failures raise their own alarms; that
 * key answers only "did the tick happen at all", which is the question
 * production could not answer on 2026-08-24 and the reason nobody knew.
 */

export interface WorkersTickOpts {
  /** Override the Expo push client (contract tests inject the stub). */
  expoPush?: ExpoPushClient;
  /** Override the R2 client for the media-derivatives phase (Day 17). */
  r2?: R2Client;
  /**
   * Override the worker entrypoint. Contract tests inject a fake to assert
   * the route plumbs args/auth correctly without hitting the DB worker
   * surface (which has its own dedicated test file).
   *
   * `log` is part of this shape because the tick's ALARMS are carried by it and
   * nothing else — LOST HOLD, ABANDONED ENROLLMENT HOLDS, the two refund lines.
   * Omitting the field here is what made `scheduler.ts` resolve
   * `opts.log ?? NOOP_LOG` in production and discard every one of them while
   * money moved unattended (2026-08-24). It is REQUIRED, not optional, so that
   * deleting the call-site wire-up is a compile error rather than a silent
   * repeat of that regression.
   */
  runTick?: (opts: {
    expoPush?: ExpoPushClient;
    r2?: R2Client;
    log: WorkerLogger;
  }) => Promise<SchedulerTickResult>;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Buffer.from of equal-length strings → equal-length Buffers; unequal-
  // length comparison short-circuits to false at the length check below
  // so the caller never reaches the unsafe early-return path inside
  // timingSafeEqual itself.
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function registerWorkersTickRoute(app: FastifyInstance, opts: WorkersTickOpts = {}): void {
  const runTick =
    opts.runTick ??
    ((tickOpts: { expoPush?: ExpoPushClient; r2?: R2Client; log: WorkerLogger }) =>
      runSchedulerTickOnce(tickOpts));

  app.post('/workers/tick', async (request, reply) => {
    const auth = firstHeader(request.headers['authorization']);
    if (auth === undefined || !auth.startsWith('Bearer ')) {
      throw new ApiError('unauthenticated', 'missing or malformed Authorization header');
    }
    const token = auth.slice('Bearer '.length);
    if (!constantTimeEqual(token, env.SCHEDULER_WEBHOOK_SECRET)) {
      throw new ApiError('unauthenticated', 'invalid scheduler webhook secret');
    }

    const result = await runTick({
      expoPush: opts.expoPush ?? defaultExpoPushClient,
      r2: opts.r2 ?? defaultR2Client,
      // The request logger IS the tick's alarm channel: `request.log` already
      // structurally satisfies `WorkerLogger`, and it is the same destination
      // the "scheduler tick complete" line below lands in.
      log: request.log,
    });
    // EVERY phase's counters (D20-A3 §A3.4.1). This line is nominated by the
    // ops SQL, the design's proof plan, and Allison's runbook as THE authority
    // on whether a tick ran — all three called it "the same counters" as the
    // JSON body while it reported five of twelve phases, omitting
    // `captureReconciler` and `duplicateRefundRetry`: the two money phases
    // whose alarms this cycle exists to page on. (Pre-existing as
    // DISCREPANCIES NOTE-39; nominating the line as the authority made closing
    // it this cycle's job.) Additive only — every pre-existing key keeps its
    // name and meaning, so anything already reading them still works.
    //
    // "EVERY phase's counters" means every LEAF, not every phase (D20-A7.2).
    // All 11 phases were present while 7 leaves were not: both
    // `abandonedTruncated` flags and all 5 `abandonedByClass` members. Nothing
    // logged understated a total — `abandoned` is the true count — but this
    // line is the nominated authority, so a leaf missing from it is a leaf a
    // human reading the log cannot get to. Making the sentence true was the
    // ruling both times it came up; weakening it was not.
    request.log.info(
      {
        workerTick: 'scheduler',
        scheduledScanned: result.scheduledNotifications.scanned,
        scheduledSent: result.scheduledNotifications.sent,
        pushTicketsOk: result.scheduledNotifications.pushTicketsOk,
        pushTicketsError: result.scheduledNotifications.pushTicketsError,
        membershipRollScanned: result.membershipRoll.scanned,
        membershipRolled: result.membershipRoll.rolled,
        membershipCompleted: result.membershipRoll.completed,
        invoiceAttemptVerifyScanned: result.invoiceAttemptVerify.scanned,
        captureReconcilerScanned: result.captureReconciler.scanned,
        captureReconcilerCaptured: result.captureReconciler.captured,
        captureReconcilerLostHolds: result.captureReconciler.lostHolds,
        captureReconcilerWithdrawnReleased: result.captureReconciler.withdrawnReleased,
        captureReconcilerRefundedPostWithdraw: result.captureReconciler.refundedPostWithdraw,
        captureReconcilerRefundedSurplus: result.captureReconciler.refundedSurplus,
        captureReconcilerSettledInvoices: result.captureReconciler.settledInvoices,
        captureReconcilerAbandoned: result.captureReconciler.abandoned,
        captureReconcilerAbandonedUncollected: result.captureReconciler.abandonedUncollected,
        captureReconcilerAbandonedTruncated: result.captureReconciler.abandonedTruncated,
        duplicateRefundRetryScanned: result.duplicateRefundRetry.scanned,
        duplicateRefundRetrySent: result.duplicateRefundRetry.sent,
        duplicateRefundRetryAbandoned: result.duplicateRefundRetry.abandoned,
        duplicateRefundRetryAbandonedTruncated: result.duplicateRefundRetry.abandonedTruncated,
        // The abandoned rows split by what a human can DO about each. `abandoned`
        // above is the true total and never understates, so these add WHICH
        // remediation is owed, not how much — and the truncation flags say
        // whether the alarm beside them could name rows or only classes.
        duplicateRefundRetryAbandonedRowKeyed:
          result.duplicateRefundRetry.abandonedByClass['row-keyed'],
        duplicateRefundRetryAbandonedClientKeyed:
          result.duplicateRefundRetry.abandonedByClass['client-keyed'],
        duplicateRefundRetryAbandonedNeverSent:
          result.duplicateRefundRetry.abandonedByClass['never-sent'],
        duplicateRefundRetryAbandonedStripeFailed:
          result.duplicateRefundRetry.abandonedByClass['stripe-failed'],
        duplicateRefundRetryAbandonedCovered:
          result.duplicateRefundRetry.abandonedByClass.covered,
        invoicesScanned: result.invoiceAutoCharge.scanned,
        mediaDerivativesScanned: result.mediaDerivatives.scanned,
        creditExpiryWarningsScanned: result.creditExpiryWarnings.scanned,
        creditExpiryWarningsEnqueued: result.creditExpiryWarnings.enqueued,
        alumniAttendanceRan: result.alumniAttendance.ran,
        alumniAttendanceScanned: result.alumniAttendance.scanned,
        alumniAttendanceEnqueued: result.alumniAttendance.enqueued,
        alumniAttendanceFlagged: result.alumniAttendance.flagged,
        invoiceOverdueScanned: result.invoiceOverdue.scanned,
        invoiceOverdueEnqueued: result.invoiceOverdue.enqueued,
        cardExpiryScanned: result.cardExpiry.scanned,
        cardExpiryEnqueued: result.cardExpiry.enqueued,
        idempotencyKeysSwept: result.idempotencyKeysSwept,
      },
      'scheduler tick complete',
    );
    // The heartbeat the external monitor reads through `GET /health/watchdog`
    // (D20-A2 §A2.3). LAST, after the log line; it cannot fail the tick, and
    // since D20-A4 §A4.3 it cannot WEDGE it either — the write is raced against
    // a 1s timeout inside `recordSchedulerTick`, because a Redis that is
    // reachable but silent used to hold this await open indefinitely.
    await recordSchedulerTick(request.log);
    return reply.code(200).send(result);
  });
}
