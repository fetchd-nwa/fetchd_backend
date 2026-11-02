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

/**
 * **How many scheduled notifications are PARKED right now** — the standing
 * signal (2026-09-03, `designs/phase-1-poison-row-isolation.md` A1.6).
 *
 * A parked row is a notification that will NEVER be delivered until a human
 * acts, and its only notice was one fire-and-forget page: the pager documents
 * that a send can be shed at the in-flight ceiling or lost to the transport,
 * and `scheduledParked` on the completion line is per-tick, so it reads 0 on
 * every tick after the one that parked. Miss that page and the row is invisible
 * until someone runs SQL — which is the same shape as the fault the heartbeat
 * above exists to catch, one level in.
 *
 * So the tick publishes the count and `GET /health/watchdog` turns it into a
 * standing 503. Redis and not a query, for the same reason as the heartbeat:
 * the watchdog is deliberately DB-FREE, so it can still answer when the
 * database is the thing that is broken.
 */
export const SCHEDULER_PARKED_TOTAL_KEY = 'scheduler:parked_total';

/**
 * 24h, matching {@link SCHEDULER_HEARTBEAT_TTL_S}. Long enough that a value
 * outlives any plausible gap between ticks, so a missing key means "no tick has
 * published one" rather than "the last one aged out" — and short enough that a
 * count from a dead deployment does not hold the watchdog red forever.
 */
export const SCHEDULER_PARKED_TOTAL_TTL_S = 24 * 60 * 60;

/**
 * Publish the parked-row count. Called from `routes/workersTick.ts` straight
 * after {@link recordSchedulerTick}, and — exactly like it — **never throws,
 * never rejects, and never hangs**: this is a signal ABOUT the tick and must
 * not become a way for the tick to fail or wedge. Same 1s race, both arms
 * resolving, warn on failure or timeout.
 *
 * The caller must not invent a number. A tick that could not COUNT passes
 * nothing here at all (the count is `null` in that case), leaving the previous
 * value to stand under its TTL: publishing 0 from a tick that never looked
 * would clear a true standing alarm.
 */
export async function recordParkedTotal(
  log: { warn(obj: Record<string, unknown>, msg?: string): void },
  parked: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const write = redis
      .setex(SCHEDULER_PARKED_TOTAL_KEY, SCHEDULER_PARKED_TOTAL_TTL_S, String(parked))
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
        'parked-notification count write failed — the tick is unaffected, but /health/watchdog will read stale',
      );
    } else if (outcome.kind === 'timeout') {
      log.warn(
        { timeoutMs: HEARTBEAT_WRITE_TIMEOUT_MS },
        'parked-notification count write timed out — the tick is unaffected and completed, but /health/watchdog will read stale',
      );
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'parked-notification count write failed — the tick is unaffected, but /health/watchdog will read stale',
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * What the parked-total key says — the same four states as
 * {@link HeartbeatReading}, and for the same reasons: only `recorded` is a
 * number anyone may act on, and each failure shape has to be distinguishable
 * from "there are no parked rows", which is the reading that means everything
 * is fine.
 */
export type ParkedTotalReading =
  | { kind: 'absent' }
  | { kind: 'unparseable'; raw: string }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'recorded'; n: number };

/**
 * The published parked-row count, as one of {@link ParkedTotalReading}'s four
 * states. **Never rejects and never hangs**, raced against
 * {@link HEARTBEAT_READ_TIMEOUT_MS} with both arms resolving — the D20-A5.2
 * shape, because a reachable-but-silent Redis left the watchdog running after
 * 45 seconds and a watchdog that hangs is worse than one that says it is blind.
 */
export async function readParkedTotal(): Promise<ParkedTotalReading> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const read = redis.get(SCHEDULER_PARKED_TOTAL_KEY).then(
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
    return interpretParkedTotal(outcome.raw);
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The raw value, as a reading. The writer writes `String(n)` for a
 * non-negative integer `n` and nothing else, so the reader accepts exactly that
 * and treats everything else as corruption — the `interpret` lesson above, in
 * its numeric form: `Number('')` is 0, `Number(' 7 ')` is 7 and `Number('1e3')`
 * is 1000, so a coerced parse would report a count this system never wrote and
 * (for `''`) would report the reassuring one.
 */
function interpretParkedTotal(raw: string | null): ParkedTotalReading {
  if (raw === null) return { kind: 'absent' };
  if (!/^\d+$/.test(raw)) return { kind: 'unparseable', raw };
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return { kind: 'unparseable', raw };
  return { kind: 'recorded', n };
}

/**
 * **Is the scheduled-notification QUEUE delivering?** — the freshness key
 * (2026-09-03, `designs/phase-1-poison-row-isolation.md` A2.1, ruled by Allison
 * ~14:45 CDT: *a queue that is not delivering must turn the uptime monitor red
 * after about ten minutes*).
 *
 * The heartbeat above answers "did the tick happen at all". It cannot answer
 * "did phase 1 deliver anything", and this cycle's own two fixes are what made
 * that gap load-bearing:
 *
 * - Before the phase-1 boundary, a throw inside phase 1 escaped to
 *   `POST /workers/tick`, the route answered 500, {@link recordSchedulerTick}
 *   was never reached, and the heartbeat went stale inside ten minutes. A
 *   whole-queue notification outage went RED here — by accident.
 * - The boundary removed that 500 deliberately: it also stopped phases 2-12,
 *   the four money phases included (the 2026-09-02 incident, 27 ticks).
 * - The systemic branch (A1.1) then removed the other path to a red: an
 *   all-fail batch parks nothing, so `scheduler:parked_total` stays 0 too.
 *
 * Net, without this key: a schema drift on `notifications`, a statement-timeout
 * episode or a bad deploy is PAGER-ONLY for as long as it lasts — on the one
 * instrument whose whole purpose is to survive Sentry dying.
 *
 * **A freshness key and not a consecutive-tick counter**, which is what the
 * attack lanes proposed: a counter needs a read-modify-write on Redis in the
 * tick's hot path and races two overlapping ticks. An instant plus a staleness
 * comparison is the shape the heartbeat above already proved in production
 * (`8f25c8f`: real DOWN 02:26:38, real UP 02:31:44 UTC), it is idempotent, and
 * two ticks writing it cannot corrupt each other.
 */
export const SCHEDULER_QUEUE_OK_KEY = 'scheduler:queue_ok_at';

/**
 * 24h, matching {@link SCHEDULER_HEARTBEAT_TTL_S} and
 * {@link SCHEDULER_PARKED_TOTAL_TTL_S}, and for the heartbeat's reason: a key
 * that expired at the staleness threshold would make "the queue stopped eleven
 * minutes ago" and "the queue stopped last week" the same reading, and only the
 * first of those can state a DURATION. Both are a 503 — since A3.1 an absent
 * key raises the watchdog's own reason rather than reading as health — but the
 * stale one names the number an operator acts on, so the TTL must stay far
 * longer than `SCHEDULER_STALE_AFTER_MS` or every outage collapses into the
 * vaguer sentence within one threshold. Pinned, with that ratio, in
 * `test/contracts/healthWatchdog.test.ts`; before A3.1, collapsing this
 * constant went further and made production GREEN one minute after it expired.
 *
 * What `absent` means here, stated because the code once assumed the opposite:
 * NOT "nothing has ticked in this deployment" — that is what an absent
 * {@link SCHEDULER_PARKED_TOTAL_KEY} means, because every tick that can count
 * rewrites it. This key is written only by a DELIVERING tick, so its absence
 * means "nothing healthy has happened since it last expired".
 */
export const SCHEDULER_QUEUE_OK_TTL_S = 24 * 60 * 60;

/**
 * Stamp "phase 1 delivered, at this instant". Called from
 * `routes/workersTick.ts` beside {@link recordSchedulerTick}, and **only when
 * `scheduledNotifications.queueOk` is true** — a tick that took the systemic
 * branch, or whose phase 1 threw at its boundary, deliberately leaves the
 * previous value to age out under its TTL. That ageing IS the signal, and
 * since A3.1 it does not end when the key expires: the reader raises its own
 * reason for an ABSENT key while the heartbeat says the scheduler is ticking,
 * so a write-only-on-health key cannot delete its own alarm at the 24h mark.
 *
 * Never throws, never rejects, **and never hangs** — the same 1s race with both
 * arms resolving as {@link recordSchedulerTick}, for the same reasons: a Redis
 * blip must not fail a tick that already moved money, a WEDGED Redis must not
 * stop it finishing (executed against a TCP blackhole, the tick route was still
 * running after 45 seconds), and an abandoned write that rejects LATER would be
 * an unhandled rejection, which with the Day-20 crash handlers installed takes
 * the process down. Failure is logged at `warn`, not `error`: an unreachable
 * Redis is already a `/health` 503 and must not also spend a page from the
 * money alarms' budget.
 */
export async function recordQueueOk(
  log: { warn(obj: Record<string, unknown>, msg?: string): void },
  now: Date = new Date(),
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const write = redis
      .setex(SCHEDULER_QUEUE_OK_KEY, SCHEDULER_QUEUE_OK_TTL_S, now.toISOString())
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
        'queue-delivering write failed — the tick is unaffected, but /health/watchdog will read stale',
      );
    } else if (outcome.kind === 'timeout') {
      log.warn(
        { timeoutMs: HEARTBEAT_WRITE_TIMEOUT_MS },
        'queue-delivering write timed out — the tick is unaffected and completed, but /health/watchdog will read stale',
      );
    }
  } catch (err) {
    // Belt and braces, as in the writer above: `setex` throwing SYNCHRONOUSLY
    // (a disconnected client can) would otherwise escape into the request path.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'queue-delivering write failed — the tick is unaffected, but /health/watchdog will read stale',
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The last instant phase 1 is known to have delivered, as one of
 * {@link HeartbeatReading}'s four states.
 *
 * It IS a {@link HeartbeatReading}: the value is an ISO instant written by
 * `Date.prototype.toISOString()` and nothing else, exactly like the heartbeat,
 * so {@link interpret} is reused rather than reimplemented. That is not
 * convenience — a second parser is a second place for `new Date('2026')` to
 * come back as a valid `recorded` reading, which is the fault §A4.5 L3 exists
 * to prevent and which this endpoint once reported as a 23-year-old tick.
 *
 * **Never rejects and never hangs**, raced against
 * {@link HEARTBEAT_READ_TIMEOUT_MS} with both arms resolving — a
 * reachable-but-silent Redis left the watchdog running after 45 seconds, and a
 * watchdog that hangs is worse than one that says it is blind.
 */
export async function readQueueOk(): Promise<HeartbeatReading> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const read = redis.get(SCHEDULER_QUEUE_OK_KEY).then(
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
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
