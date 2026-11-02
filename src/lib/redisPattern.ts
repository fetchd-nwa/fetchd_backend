import type { Redis } from 'ioredis';

const SCAN_BATCH = 200; // ioredis default; tune if pattern wipes get hot.

/**
 * Drop every key matching a Redis glob on `client`, by `SCAN` + batched
 * `UNLINK` — never `KEYS`, which blocks Redis.
 *
 * The client is a parameter so a process that must not load `env.ts` — the
 * migration runner, whose `--redis-url` names the target explicitly — clears
 * a cache with exactly the code the server uses (`lib/cache.ts`'s
 * `invalidatePattern` is this, on the server's client).
 */
export async function unlinkMatching(
  client: Pick<Redis, 'scan' | 'unlink'>,
  pattern: string,
): Promise<void> {
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);
    cursor = next;
    if (batch.length > 0) {
      await client.unlink(...batch);
    }
  } while (cursor !== '0');
}
