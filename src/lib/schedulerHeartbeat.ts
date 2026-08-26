import { redis } from '../redis.js';

/**
 * **Did the scheduler tick at all?** — Day-20, D20-A2 §A2.3.
 *
 * Allison's 2026-08-24 finding was not "the cron is missing". It was
 * *"production ticks have NEVER fired and nobody knew."* Shipping a cron that
 * can stop silently fixes the instance and leaves the class: secret drift → the
 * 401 never reaches the app; a changed Railway URL → a 404 the process never
 * sees; a deactivated `cron.job` row, a dropped extension, a paused project —
 * every one of them produces exactly zero alarms, because the alarm channel
 * lives inside a process nothing is calling.
 *
 * So the tick writes a heartbeat and `GET /health/watchdog` reads it. The write
 * is the LAST thing the route does, and its failure is swallowed: a watchdog
 * that can fail the thing it watches is worse than no watchdog.
 *
 * Redis rather than a table: no DDL (this cycle permits none), and a key with a
 * TTL is the right shape for "the most recent instant, or nothing".
 */

/** Where the tick's timestamp lives. One key, one writer, one reader. */
export const SCHEDULER_HEARTBEAT_KEY = 'scheduler:last_tick_at';

/**
 * 24h. Long enough that "absent" is unambiguous — a key that expired at the
 * staleness threshold would make "the scheduler stopped an hour ago" and "the
 * scheduler stopped last week" the same reading, and the second one is worse.
 */
export const SCHEDULER_HEARTBEAT_TTL_S = 24 * 60 * 60;

/**
 * How long the tick will wait for the heartbeat write before abandoning it
 * (D20-A4 §A4.3). One second is far beyond a healthy local SETEX and far below
 * anything that matters to a minutely tick.
 *
 * Deliberately NOT `commandTimeout` on the shared client in `src/redis.ts`:
 * that would change behavior for every Redis consumer in the app — sessions,
 * the rate limiter, the cache — which is a blast radius this cycle has no
 * business taking for a heartbeat.
 */
export const HEARTBEAT_WRITE_TIMEOUT_MS = 1_000;

/**
 * Stamp "a tick ran, at this instant". Called from `routes/workersTick.ts`
 * immediately after the completion log line — a tick that RAN records it even
 * when individual phases errored, because phase failures raise their own
 * alarms and this key answers only "did the tick happen at all".
 *
 * Never throws, never rejects, **and never hangs**: a Redis blip must not fail
 * a tick that already moved money, and a WEDGED Redis must not stop it
 * finishing. A failed write is logged at warn — not error, because an
 * unreachable Redis is already a `/health` 503 and does not need to also spend
 * a page from the money alarms' budget.
 *
 * The timeout is the §A4.3 fix and it is not theoretical: the try/catch below
 * handles a REJECTION, and executed against a TCP blackhole (a socket that
 * accepts and never answers — a reachable but wedged Redis) **the tick route
 * never returned; it was still running after 45 seconds**, with cron stacking a
 * fresh tick on top of it every minute. Connection-REFUSED was always fine
 * (200 in 58 ms) because the socket dies; `maxRetriesPerRequest: 1` never trips
 * when the connection is up and simply silent. A watchdog that can WEDGE the
 * thing it watches fails this file's own opening claim.
 */
export async function recordSchedulerTick(
  log: { warn(obj: Record<string, unknown>, msg?: string): void },
  now: Date = new Date(),
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // The write's own outcome is folded into the race rather than left to
    // reject on its own: once the timeout wins, a LATER rejection from the
    // abandoned write would be an unhandled rejection — which, with the Day-20
    // crash handlers installed, takes the process down. Both arms resolve.
    const write = redis
      .setex(SCHEDULER_HEARTBEAT_KEY, SCHEDULER_HEARTBEAT_TTL_S, now.toISOString())
      .then(
        () => ({ kind: 'written' }) as const,
        (err: unknown) => ({ kind: 'failed', err }) as const,
      );
    const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), HEARTBEAT_WRITE_TIMEOUT_MS);
    });
    const outcome = await Promise.race([write, deadline]);
    if (outcome.kind === 'failed') {
      log.warn(
        { err: outcome.err instanceof Error ? outcome.err.message : String(outcome.err) },
        'scheduler heartbeat write failed — the tick is unaffected, but /health/watchdog will read stale',
      );
    } else if (outcome.kind === 'timeout') {
      log.warn(
        { timeoutMs: HEARTBEAT_WRITE_TIMEOUT_MS },
        'scheduler heartbeat write timed out — the tick is unaffected and completed, but /health/watchdog will read stale',
      );
    }
  } catch (err) {
    // Belt and braces: `setex` throwing SYNCHRONOUSLY (a disconnected client
    // can) would otherwise escape into the request path.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'scheduler heartbeat write failed — the tick is unaffected, but /health/watchdog will read stale',
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * What the heartbeat key says. Three states, not two (D20-A4 §A4.5 L3): the
 * previous version mapped an UNPARSEABLE value to `null`, which is a safe
 * direction and a false sentence — the watchdog then reported "no scheduler
 * tick has been recorded", sending whoever read it to pg_cron when the actual
 * fault is the key. A corrupted instrument must say it is corrupted.
 */
export type HeartbeatReading =
  | { kind: 'absent' }
  | { kind: 'unparseable'; raw: string }
  | { kind: 'recorded'; at: Date };

/**
 * The last recorded tick, as one of {@link HeartbeatReading}'s three states.
 *
 * Rejects if Redis is unreachable — deliberately. The watchdog's caller turns
 * that into a 503: "I cannot tell whether the scheduler is alive" is a
 * watchdog failure, and a watchdog that answers 200 when it cannot see is the
 * exact instrument failure this endpoint exists to prevent.
 */
export async function readSchedulerHeartbeat(): Promise<HeartbeatReading> {
  const raw = await redis.get(SCHEDULER_HEARTBEAT_KEY);
  if (raw === null) return { kind: 'absent' };
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? { kind: 'unparseable', raw } : { kind: 'recorded', at: parsed };
}
