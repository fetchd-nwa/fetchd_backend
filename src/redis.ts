import { Redis } from 'ioredis';
import { env } from './env.js';

/**
 * The single Redis client. Server-side only (cache + rate limit + sessions) —
 * complementary to the FE's TanStack Query cache, never a substitute for it.
 * `lazyConnect` keeps boot deterministic: the connection is established by the
 * first command (the `/health` ping), so a Redis outage surfaces as a failed
 * health check, not an unhandled connection error at import time.
 */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

// Without a listener, ioredis's client-level 'error' event is an unhandled
// EventEmitter error and crashes the process on a transient Redis blip. The
// `/health` probe is the single source of truth for Redis liveness, so a
// connection error here is deliberately absorbed at the client level rather
// than taking the API down — surfaced via the health check, not a crash.
redis.on('error', () => {});

export async function pingRedis(): Promise<void> {
  await redis.ping();
}

export async function closeRedis(): Promise<void> {
  redis.disconnect();
}
