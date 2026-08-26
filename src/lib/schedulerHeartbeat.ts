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
 * How long `GET /health/watchdog` will wait to READ the heartbeat before
 * answering "I cannot see" (D20-A5.2). The writer got this race in §A4.3 and
 * the reader — sixty lines below it — did not: executed against the same TCP
 * blackhole, **the watchdog never answered; still nothing after 45 seconds**,
 * and `app.close()` never returned either. A watchdog that hangs is worse than
 * one that says it is blind, because a monitor watching a status code cannot
 * tell a hang from a slow network and the alert never fires.
 *
 * One second, matching the writer: far beyond a healthy local GET, far below
 * anything a 5-minute monitor interval cares about.
 */
export const HEARTBEAT_READ_TIMEOUT_MS = 1_000;

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
 * What the heartbeat key says. FOUR states, and each one exists because the
 * state below it used to masquerade as a different fault:
 *
 * - `unparseable` (D20-A4 §A4.5 L3) — the previous version mapped a corrupted
 *   value to `null`, a safe direction and a false sentence: the watchdog then
 *   reported "no scheduler tick has been recorded", sending whoever read it to
 *   pg_cron when the fault lives in this key.
 * - `unreadable` (D20-A5.2) — "I cannot see the key" is not "the scheduler is
 *   dead", and until this existed the reader had no way to say the difference:
 *   a rejection became a 503 whose reason blamed Redis in passing, and a HANG
 *   became no answer at all.
 */
export type HeartbeatReading =
  | { kind: 'absent' }
  | { kind: 'unparseable'; raw: string }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'recorded'; at: Date };

/**
 * The last recorded tick, as one of {@link HeartbeatReading}'s four states.
 *
 * **Never rejects and never hangs** (D20-A5.2). It used to reject on an
 * unreachable Redis, deliberately, so the caller could turn that into a 503 —
 * but rejection is only the polite failure. A Redis that is REACHABLE and
 * silent produced no rejection and no answer: the same TCP blackhole §A4.3
 * fixed in the writer left this reader running after 45 seconds, and the
 * watchdog that exists to notice silence was itself silent. So the read is
 * raced against {@link HEARTBEAT_READ_TIMEOUT_MS} and both failure shapes come
 * back as `unreadable`, which the route turns into a 503 that says exactly
 * that.
 *
 * Both arms of the race resolve, as in `recordSchedulerTick`: once the timeout
 * wins, a LATER rejection from the abandoned read would be an unhandled
 * rejection, which with the Day-20 crash handlers installed takes the process
 * down — the watchdog killing the thing it watches.
 */
export async function readSchedulerHeartbeat(): Promise<HeartbeatReading> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const read = redis.get(SCHEDULER_HEARTBEAT_KEY).then(
      (raw: string | null) => ({ kind: 'read', raw }) as const,
      (err: unknown) => ({ kind: 'failed', err }) as const,
    );
    const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), HEARTBEAT_READ_TIMEOUT_MS);
    });
    const outcome = await Promise.race([read, deadline]);
    if (outcome.kind === 'timeout') {
      return {
        kind: 'unreadable',
        reason: `redis did not answer within ${HEARTBEAT_READ_TIMEOUT_MS}ms (reachable but silent)`,
      };
    }
    if (outcome.kind === 'failed') {
      return {
        kind: 'unreadable',
        reason: outcome.err instanceof Error ? outcome.err.message : String(outcome.err),
      };
    }
    return interpret(outcome.raw);
  } catch (err) {
    // Belt and braces, as in the writer: `get` throwing SYNCHRONOUSLY (a
    // disconnected client can) would otherwise escape into the request path.
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The raw value, as a reading. The writer writes `Date.prototype.toISOString()`
 * and nothing else, so the reader requires exactly that shape and treats every
 * other string as corruption (D20-A5.5 G).
 *
 * `new Date(raw)` alone was too permissive to be an instrument. JS date parsing
 * accepts `'2026'`, `'0'`, `'1'` and `'December 17, 1995'`, so a corrupted key
 * came back as a valid `recorded` reading and the watchdog reported *"last
 * scheduler tick was 20544230s ago"* — a 23-year-old tick, stated as fact,
 * pointing whoever read it at pg_cron for a fault that lives in this key.
 * Round-tripping through `toISOString()` is exact: only what the writer could
 * have written survives it.
 */
function interpret(raw: string | null): HeartbeatReading {
  if (raw === null) return { kind: 'absent' };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== raw) {
    return { kind: 'unparseable', raw };
  }
  return { kind: 'recorded', at: parsed };
}
