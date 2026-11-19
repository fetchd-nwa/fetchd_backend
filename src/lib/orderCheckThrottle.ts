import type { FastifyBaseLogger } from 'fastify';
import { redis } from '../redis.js';
import { rateLimitedError } from './bookingErrors.js';

/**
 * The `POST /booking-orders/check` throttle (wire 9.1.0; designs/credits-joint-booking.md §3.2
 * "Throttle", Amendment A1; contract-notes mechanic 16). A fixed window per owner and clock
 * minute: the key is `throttle:order-check:<ownerId>:<epoch-minute>`, and the 61st check in
 * one minute is 429 `rate_limited`.
 *
 * The window is `SET <key> 0 EX 60 NX` then `INCR`, in ONE `MULTI`, so a key is never left
 * without its expiry and nothing needs Redis 7's `EXPIRE … NX`.
 *
 * It fails open: the check is advisory and the POST is the authority, so a limiter that
 * cannot answer lets the check through. "Cannot answer" includes a hang: the store's answer
 * is waited for at most {@link THROTTLE_BUDGET_MS}, and whichever way it fails the route logs
 * one line and goes on.
 */

export const CHECKS_PER_MINUTE = 60;

/** How long a check waits on the limiter before it fails open. */
export const THROTTLE_BUDGET_MS = 250;

/** Counts one hit on a key and answers the count, the window included. */
export interface CheckThrottleStore {
  hit(key: string): Promise<number>;
}

export const redisCheckThrottleStore: CheckThrottleStore = {
  async hit(key: string): Promise<number> {
    const replies = await redis.multi().set(key, '0', 'EX', 60, 'NX').incr(key).exec();
    if (replies === null) throw new Error('the throttle transaction was discarded');
    const [, incr] = replies;
    if (incr === undefined) throw new Error('the throttle transaction returned no INCR reply');
    const [err, count] = incr;
    if (err !== null) throw err;
    if (typeof count !== 'number') throw new Error(`INCR answered ${String(count)}`);
    return count;
  },
};

export function orderCheckThrottleKey(ownerId: string, now: Date): string {
  return `throttle:order-check:${ownerId}:${Math.floor(now.getTime() / 60_000)}`;
}

/**
 * Count this check, and throw 429 past the minute's budget. Any store error, or no answer
 * within the budget, is logged once and lets the check through.
 */
export async function assertCheckUnderThrottle(args: {
  store: CheckThrottleStore;
  ownerId: string;
  now: Date;
  log: FastifyBaseLogger;
}): Promise<void> {
  const key = orderCheckThrottleKey(args.ownerId, args.now);
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${THROTTLE_BUDGET_MS} ms`)),
      THROTTLE_BUDGET_MS,
    );
    timer.unref();
  });
  let count: number;
  try {
    count = await Promise.race([args.store.hit(key), budget]);
  } catch (err) {
    args.log.warn(
      { err, throttleKey: key },
      'order check throttle unavailable: the check runs unthrottled (fail open)',
    );
    return;
  } finally {
    clearTimeout(timer);
  }
  if (count > CHECKS_PER_MINUTE) throw rateLimitedError(CHECKS_PER_MINUTE);
}
