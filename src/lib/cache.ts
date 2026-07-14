import type { ZodType } from 'zod';
import { redis } from '../redis.js';

/**
 * Day-8 Redis read-through + invalidation. The server-side cache for
 * expensive, cross-user, read-mostly reads (BACKEND-ARCHITECTURE §3).
 * Repository methods opt in by calling `readThrough(...)` directly — the
 * repo stays the single data-access seam, but a hot read serves from Redis
 * without round-tripping Postgres.
 *
 * Trust boundary: cached JSON is **validated** against a Zod schema on
 * read. A deploy that ships a repo-shape change leaves the old shape in
 * Redis until TTL — without the validator the stale row would silently
 * feed through. The validator catches the mismatch, treats it as a miss,
 * re-queries, and overwrites. The cost is one Zod parse per cache hit;
 * the alternative is data-shape drift across a deploy boundary.
 *
 * Invalidation pairs with mutations. `withMutation`'s optional `invalidate`
 * callback fires post-commit on new (non-replay) outcomes and hands the
 * keys to `invalidate(...)` here. Day-9+ mutations supply the keys; the
 * cache module doesn't know about business semantics.
 *
 * Day-8 invalidation map (mirror of BACKEND-ARCHITECTURE §3, narrowed
 * to the entries actually wired today). When in doubt, **pattern-wipe**
 * a prefix — coarse-but-safe beats forgetting a per-location key.
 *
 * | Cached entity              | Key shape                                | Invalidating mutation (Day#)     | Idiom                                                       |
 * |----------------------------|------------------------------------------|----------------------------------|-------------------------------------------------------------|
 * | Announcements feed         | `ann:{location\|all}`                    | publish / soft-expire (Day 12+)  | `invalidatePattern('ann:*')` (one row can be in 2+ caches)  |
 * | Group-class catalog list   | `groupclasses:catalog`                   | catalog edit (Day 19 portal)     | `invalidatePattern('groupclasses:*')` (also drops per-key)  |
 * | Group-class by key         | `groupclasses:byKey:{classKey}`          | catalog edit (Day 19 portal)     | (covered by `groupclasses:*` wipe above)                    |
 * | Group-class prereqs        | `groupclasses:prereqs:{classKey}`        | prereq-options edit (Day 19)     | (covered by `groupclasses:*` wipe above)                    |
 * | Availability range         | `avail:{location}:{from}:{to}`           | `day_capacity` write (Day 9+)    | `invalidatePattern('avail:{location}:*')` (single date hits many ranges) |
 * | Credit-packages catalog    | `creditpackages:{location}:{today}`      | reprice (staff portal, ext repo) | daily key + 5-min TTL; portal should `invalidatePattern('creditpackages:{location}:*')` on reprice |
 * | Credit balance (display)   | `credits:{dogId}:{ownerId}:balance:{loc}`| `credit_ledger` write            | `invalidatePattern('credits:{dogId}:*')` — purchase (sync+webhook), booking debit, cancel credit-refund, payment_failed reversal |
 * | Credit expiring-lots       | `credits:{dogId}:lots:{location}`        | `credit_ledger` write            | (covered by the `credits:{dogId}:*` wipe above)             |
 *
 * Adding a new cached entity? Three rules: (1) every key has an entity
 * prefix; (2) every mutation that touches the underlying table updates
 * its row in this table; (3) prefer pattern-wipes on the entity prefix
 * unless invalidation truly is one-key-precise.
 */

const SCAN_BATCH = 200; // ioredis default; tune if pattern wipes get hot.

/**
 * One cache hit (the JSON round-trip succeeded and validate() passed) or a
 * miss (no key, or stale shape we discarded). Internal — `readThrough`
 * collapses this to a single typed value.
 */
type Lookup<T> = { hit: true; value: T } | { hit: false };

async function lookup<T>(key: string, schema: ZodType<T>): Promise<Lookup<T>> {
  const raw = await redis.get(key);
  if (raw === null) return { hit: false };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    // Corrupted JSON in Redis (manually written, partial write, encoding
    // glitch). Drop it — the read-through path will overwrite.
    await redis.unlink(key);
    return { hit: false };
  }
  const validated = schema.safeParse(parsedJson);
  if (!validated.success) {
    // Stale shape from a prior deploy. Drop + treat as miss so the fresh
    // queryFn() result overwrites with the current shape.
    await redis.unlink(key);
    return { hit: false };
  }
  return { hit: true, value: validated.data };
}

/**
 * Read-through cache. Returns the cached value if present + valid;
 * otherwise runs `queryFn`, stores the result with `ttlSec` TTL, and
 * returns it.
 *
 * `schema` validates the JSON-round-tripped value. Pick a schema that
 * matches the **post-JSON** shape — `Date` becomes ISO string, `undefined`
 * is dropped from objects, etc. For repo rows this is usually trivial
 * (the rows are already plain objects of strings/numbers).
 *
 * Optional results: a `queryFn` that resolves to `undefined` or `null` is
 * **not** cached (Redis can't round-trip `undefined`, and a `null` sentinel
 * would force every caller to disambiguate "no row" from "cache miss"
 * downstream). The next call simply re-queries. The schema must permit
 * `undefined`/`null` for the type to flow through.
 *
 * TTLs are mandatory — never cache forever. The cache is a hot-path
 * optimization, not a source of truth.
 */
export async function readThrough<T>(
  key: string,
  ttlSec: number,
  schema: ZodType<T>,
  queryFn: () => Promise<T>,
): Promise<T> {
  const cached = await lookup(key, schema);
  if (cached.hit) return cached.value;
  const fresh = await queryFn();
  if (fresh !== undefined && fresh !== null) {
    await redis.set(key, JSON.stringify(fresh), 'EX', ttlSec);
  }
  return fresh;
}

/**
 * Drop a list of cache keys. No-op when `keys` is empty (saves a pipeline
 * round-trip). Uses `UNLINK` rather than `DEL` so a multi-key wipe doesn't
 * block the Redis event loop — the free happens async server-side.
 */
export async function invalidate(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await redis.unlink(...keys);
}

/**
 * Drop every key matching a glob pattern (e.g. `'avail:fayetteville:*'`).
 * Uses `SCAN` + batched `UNLINK` — never `KEYS`, which blocks Redis. The
 * pattern syntax is Redis-glob (`*`, `?`, `[abc]`); callers should anchor
 * with an entity prefix so a wildcard wipe can't accidentally drop the
 * wrong namespace.
 *
 * Per-entity-id invalidation is the load-bearing case (`ann:fayetteville`
 * — pass to `invalidate([key])`); pattern wipes are escape hatches for
 * range caches where a single write affects many keys (a `day_capacity`
 * override write touches every range that spans that date).
 */
export async function invalidatePattern(pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);
    cursor = next;
    if (batch.length > 0) {
      await redis.unlink(...batch);
    }
  } while (cursor !== '0');
}
