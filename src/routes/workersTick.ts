import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { defaultExpoPushClient, type ExpoPushClient } from '../lib/expoPush.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';
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
   */
  runTick?: (opts: { expoPush?: ExpoPushClient; r2?: R2Client }) => Promise<SchedulerTickResult>;
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
    ((tickOpts: { expoPush?: ExpoPushClient; r2?: R2Client }) => runSchedulerTickOnce(tickOpts));

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
    });
    request.log.info(
      {
        workerTick: 'scheduler',
        scheduledScanned: result.scheduledNotifications.scanned,
        scheduledSent: result.scheduledNotifications.sent,
        pushTicketsOk: result.scheduledNotifications.pushTicketsOk,
        pushTicketsError: result.scheduledNotifications.pushTicketsError,
        invoicesScanned: result.invoiceAutoCharge.scanned,
        mediaDerivativesScanned: result.mediaDerivatives.scanned,
        idempotencyKeysSwept: result.idempotencyKeysSwept,
      },
      'scheduler tick complete',
    );
    return reply.code(200).send(result);
  });
}
