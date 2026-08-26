import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { pagerHealth, type PagerHealth } from '../lib/observability.js';
import {
  readSchedulerHeartbeat,
  SCHEDULER_HEARTBEAT_KEY,
  type HeartbeatReading,
} from '../lib/schedulerHeartbeat.js';

/**
 * `GET /health/watchdog` `[public]` — **did the scheduler tick, and is the
 * pager alive?** (Day-20, D20-A2 §A2.3, extended by §A3.2.2 and §A3.4.3.)
 *
 * Allison's finding on 2026-08-24 was not "the cron is missing"; it was
 * *"production ticks have NEVER fired and nobody knew."* A cron that can stop
 * silently fixes the instance and leaves the class. Every way the tick can stop
 * — secret drift (the 401 never reaches the app), a changed Railway URL (a 404
 * the process never sees), a deactivated `cron.job` row, a dropped extension, a
 * paused project — produces zero alarms, because the alarm channel lives inside
 * a process nothing is calling. One level out, the same shape: after boot,
 * every transport failure is a stderr line read by nobody, and the boot smoke
 * proves the channel once, at setup, and never again.
 *
 * So this endpoint answers both, to an EXTERNAL monitor (5-minute interval,
 * free tier, alerting where Sentry alerts). That monitor is outside both this
 * process and Sentry, which makes it the one instrument that survives either
 * dying — the answer to "how would I find out this happened again?"
 *
 * **It deliberately does NOT ride `GET /health`.** `railway.json` points its
 * deploy healthcheck at `/health`; folding staleness in would make every fresh
 * deploy — which by definition has no recent tick — fail its own healthcheck
 * and roll itself back. Separate endpoint, separate status code, no
 * interaction. That is the trap that makes the obvious version of this fix
 * worse than nothing.
 *
 * Public and unauthenticated like `/health`, so a monitor needs no secret. The
 * body is a timestamp and a handful of counters — no ids, no money, no PII.
 * Listed in DATA-CONTRACT beside `/health`; `wire.ts` is NOT involved (no
 * client generates this, there is no wire shape).
 */

/**
 * Ten missed minutely ticks. Long enough to ride out a redeploy or a slow tick,
 * short enough that a dead scheduler is caught within one monitor interval of
 * the threshold rather than the next morning.
 */
export const SCHEDULER_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Consecutive failed sends that make the pager itself the incident. One
 * transient blip is not an outage; three in a row with nothing succeeding in
 * between means alarms are being written to stderr and nowhere else.
 */
export const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 3;

/**
 * Drops inside one `DROP_WINDOW_MS` (one hour) that make suppression itself the
 * incident (D20-A4 §A4.4.1). Reporting `dropped_alarms` and returning 200 was
 * reporting a number to an instrument that cannot read numbers: the only
 * consumer of this endpoint is a free uptime monitor watching a STATUS CODE, so
 * 75 dropped alarms read as `status=ok`.
 *
 * Why 200 and not 10. Under de-duplication a SINGLE persistent condition
 * alarming every minute legitimately drops about seven events per ten-minute
 * window — roughly 42 an hour — and that is the mechanism working exactly as
 * designed, not an outage. A threshold near that floor would 503 whenever one
 * worker had a bad hour, which would train the monitor's reader to ignore it,
 * which is worse than not having it. 200/hour is about five such conditions
 * running simultaneously, or one genuine flood; either is worth a look, and
 * neither is routine.
 */
export const MAX_RECENT_DROPPED_ALARMS = 200;

/**
 * How far a heartbeat may sit in the FUTURE before it is treated as a fault
 * rather than as noise. The writer and the reader are the same process family
 * on one clock, so a real negative reading means the clock moved — but an NTP
 * step of a second or two should not flap the alarm the uptime monitor watches.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 2_000;

interface WatchdogBody {
  status: 'ok' | 'down';
  time: string;
  /** ISO instant of the last tick that reached the completion log line. */
  last_tick_at: string | null;
  /** Seconds since that tick; `null` when there has never been one. Negative
   *  when the recorded instant is in the FUTURE, which is itself a reason. */
  staleness_s: number | null;
  stale_after_s: number;
  pager: PagerHealth;
  /** Empty on 200. On 503, every reason, so the alert says what broke. */
  reasons: string[];
}

export function registerHealthWatchdogRoute(app: FastifyInstance): void {
  app.get('/health/watchdog', async (_request, reply) => {
    const now = new Date();
    const pager = pagerHealth();
    const reasons: string[] = [];

    let reading: HeartbeatReading | null = null;
    try {
      reading = await readSchedulerHeartbeat();
    } catch {
      // A watchdog that answers 200 when it cannot see is the instrument
      // failure this endpoint exists to prevent. Fail closed.
      reasons.push('heartbeat unreadable (redis)');
    }

    const lastTickAt = reading !== null && reading.kind === 'recorded' ? reading.at : null;
    const stalenessMs = lastTickAt === null ? null : now.getTime() - lastTickAt.getTime();

    if (reading !== null && reading.kind === 'absent') {
      // Absent, not merely old: the key's TTL is 24h, so "no key" means either
      // the scheduler has never run in this deployment or it has been silent
      // for a day. Both are the reported condition, and the first one IS
      // Allison's finding.
      reasons.push('no scheduler tick has been recorded');
    } else if (reading !== null && reading.kind === 'unparseable') {
      // §A4.5 L3. Its own reason, because "never recorded" would send the
      // reader to pg_cron for a fault that lives in this key.
      reasons.push(
        `scheduler heartbeat value is unparseable (corrupt key ` +
          `${SCHEDULER_HEARTBEAT_KEY}): ${JSON.stringify(reading.raw.slice(0, 64))}`,
      );
    } else if (stalenessMs !== null && stalenessMs < -CLOCK_SKEW_TOLERANCE_MS) {
      // §A4.4.4. `staleness > threshold` is false for every negative number, so
      // a forward clock jump used to answer 200 and buy a DEAD scheduler
      // exactly that much silence, while reporting a negative age on the way.
      reasons.push(
        `scheduler heartbeat is dated ${Math.round(-stalenessMs / 1000)}s in the FUTURE — ` +
          `clock skew; staleness cannot be judged and a stopped scheduler would read healthy`,
      );
    } else if (stalenessMs !== null && stalenessMs > SCHEDULER_STALE_AFTER_MS) {
      reasons.push(
        `last scheduler tick was ${Math.round(stalenessMs / 1000)}s ago ` +
          `(threshold ${SCHEDULER_STALE_AFTER_MS / 1000}s)`,
      );
    }

    if (env.NODE_ENV === 'production' && !pager.installed) {
      // §A3.2.2: with no transport, `consecutive_transport_failures` stays 0
      // forever, so the counters alone would report a healthy pager on a
      // process that has none. `buildApp()` already refuses to start such a
      // process; this is the reading that stays true if that is ever loosened.
      reasons.push('no pager installed in production');
    }
    if (pager.consecutive_transport_failures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
      reasons.push(
        `pager has failed ${pager.consecutive_transport_failures} consecutive sends ` +
          `(threshold ${MAX_CONSECUTIVE_TRANSPORT_FAILURES})`,
      );
    }
    if (pager.dropped_alarms_recent >= MAX_RECENT_DROPPED_ALARMS) {
      reasons.push(
        `pager dropped ${pager.dropped_alarms_recent} alarms in the last ` +
          `${pager.drop_window_s / 60} minutes (threshold ${MAX_RECENT_DROPPED_ALARMS}) — ` +
          `the log remains the record for every one of them`,
      );
    }
    if (pager.catastrophic_ceiling_tripped_at !== null) {
      // §A4.1.4: a circuit breaker, not a budget. At that volume something is
      // badly wrong, and "the alarms went quiet" must never read as healthy.
      reasons.push(
        `pager circuit breaker tripped at ${pager.catastrophic_ceiling_tripped_at} — ` +
          `error-level events are being shed until the hour rolls`,
      );
    }

    const body: WatchdogBody = {
      status: reasons.length === 0 ? 'ok' : 'down',
      time: now.toISOString(),
      last_tick_at: lastTickAt === null ? null : lastTickAt.toISOString(),
      staleness_s: stalenessMs === null ? null : Math.round(stalenessMs / 1000),
      stale_after_s: SCHEDULER_STALE_AFTER_MS / 1000,
      pager,
      reasons,
    };
    return reply.code(reasons.length === 0 ? 200 : 503).send(body);
  });
}
