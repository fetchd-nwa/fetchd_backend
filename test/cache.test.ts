import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import { z } from 'zod';
import { invalidate, invalidatePattern, readThrough } from '../src/lib/cache.js';
import { closeRedis, redis } from '../src/redis.js';

/**
 * Day-8 cache.ts integration tests against the real `fetchd-redis`. Each
 * test owns a unique key prefix (a random UUID per file run) so test runs
 * don't collide with dev data or with each other in CI. The `beforeEach`
 * wipes leftovers from the run-scoped prefix; `after` disconnects the
 * client so the process exits cleanly.
 *
 * Tests cover the four real outcomes:
 *   1. cold read → queryFn runs → result cached + returned
 *   2. warm read → queryFn NOT re-run, cached value returned
 *   3. invalidate → next read misses + re-queries
 *   4. trust-boundary fault (corrupt JSON, stale schema) → treated as miss
 */

const RUN_PREFIX = `test:cache:${randomUUID()}`;
const k = (suffix: string): string => `${RUN_PREFIX}:${suffix}`;
const VALUE_SCHEMA = z.object({ count: z.number(), label: z.string() });

beforeEach(async () => {
  await invalidatePattern(`${RUN_PREFIX}:*`);
});

after(async () => {
  await invalidatePattern(`${RUN_PREFIX}:*`);
  // Node 25's `--test-isolation=process` default spawns one subprocess per
  // test file; each gets its own `redis` singleton. `closeRedis()` here lets
  // THIS subprocess's event loop drain so node:test can exit cleanly — it
  // can't affect the other test files' subprocesses since they have their
  // own module-scoped client.
  await closeRedis();
});

test('readThrough: cold read calls queryFn and caches the result', async () => {
  const key = k('cold');
  let queryCount = 0;
  const queryFn = async () => {
    queryCount++;
    return { count: 7, label: 'first' };
  };
  const value = await readThrough(key, 60, VALUE_SCHEMA, queryFn);
  assert.deepEqual(value, { count: 7, label: 'first' });
  assert.equal(queryCount, 1);

  const raw = await redis.get(key);
  assert.equal(raw, JSON.stringify({ count: 7, label: 'first' }));
});

test('readThrough: warm read returns cached value without invoking queryFn', async () => {
  const key = k('warm');
  let queryCount = 0;
  const queryFn = async () => {
    queryCount++;
    return { count: 1, label: 'fresh' };
  };
  await readThrough(key, 60, VALUE_SCHEMA, queryFn);
  const second = await readThrough(key, 60, VALUE_SCHEMA, queryFn);

  assert.deepEqual(second, { count: 1, label: 'fresh' });
  assert.equal(queryCount, 1, 'queryFn must run exactly once across two reads');
});

test('readThrough: queryFn errors propagate and no key is written', async () => {
  const key = k('error');
  const boom = new Error('db down');
  await assert.rejects(
    readThrough(key, 60, VALUE_SCHEMA, async () => {
      throw boom;
    }),
    boom,
  );
  const raw = await redis.get(key);
  assert.equal(raw, null, 'must not cache when queryFn throws');
});

test('readThrough: corrupted JSON in cache is dropped and re-queried', async () => {
  const key = k('corrupt');
  await redis.set(key, '{not valid json'); // hand-written garbage
  let queryRan = false;
  const value = await readThrough(key, 60, VALUE_SCHEMA, async () => {
    queryRan = true;
    return { count: 2, label: 'recovered' };
  });
  assert.equal(queryRan, true);
  assert.deepEqual(value, { count: 2, label: 'recovered' });
  const raw = await redis.get(key);
  assert.equal(raw, JSON.stringify({ count: 2, label: 'recovered' }));
});

test('readThrough: stale-schema cached value is treated as miss and overwritten', async () => {
  const key = k('stale-shape');
  // A prior deploy's shape — valid JSON but doesn't match VALUE_SCHEMA.
  await redis.set(key, JSON.stringify({ count: 'seven', oldField: true }));
  let queryRan = false;
  const value = await readThrough(key, 60, VALUE_SCHEMA, async () => {
    queryRan = true;
    return { count: 9, label: 'current-shape' };
  });
  assert.equal(queryRan, true, 'stale shape must trigger re-query, not be returned');
  assert.deepEqual(value, { count: 9, label: 'current-shape' });
});

test('readThrough: queryFn returning undefined is NOT cached (next call re-queries)', async () => {
  const key = k('undef');
  const OPTIONAL_SCHEMA = VALUE_SCHEMA.optional();
  let queryCount = 0;
  const queryFn = async () => {
    queryCount++;
    return undefined;
  };
  const first = await readThrough(key, 60, OPTIONAL_SCHEMA, queryFn);
  assert.equal(first, undefined);
  assert.equal(await redis.exists(key), 0, 'undefined result must not be cached');

  const second = await readThrough(key, 60, OPTIONAL_SCHEMA, queryFn);
  assert.equal(second, undefined);
  assert.equal(queryCount, 2, 'next call must re-query (cache was skipped)');
});

test('readThrough: queryFn returning null is NOT cached (next call re-queries)', async () => {
  const key = k('nullish');
  const NULLABLE_SCHEMA = VALUE_SCHEMA.nullable();
  let queryCount = 0;
  const queryFn = async () => {
    queryCount++;
    return null;
  };
  await readThrough(key, 60, NULLABLE_SCHEMA, queryFn);
  await readThrough(key, 60, NULLABLE_SCHEMA, queryFn);
  assert.equal(await redis.exists(key), 0);
  assert.equal(queryCount, 2);
});

test('readThrough: applies the TTL via SETEX so the key expires server-side', async () => {
  const key = k('ttl');
  await readThrough(key, 120, VALUE_SCHEMA, async () => ({ count: 3, label: 'ttl' }));
  const ttl = await redis.ttl(key);
  assert.ok(ttl > 0 && ttl <= 120, `TTL must be set and <= 120s, got ${ttl}`);
});

test('invalidate: drops listed keys; subsequent readThrough re-queries', async () => {
  const key = k('inv');
  let queryCount = 0;
  const queryFn = async () => {
    queryCount++;
    return { count: queryCount, label: `run-${queryCount}` };
  };
  const first = await readThrough(key, 60, VALUE_SCHEMA, queryFn);
  assert.deepEqual(first, { count: 1, label: 'run-1' });

  await invalidate([key]);
  assert.equal(await redis.get(key), null);

  const second = await readThrough(key, 60, VALUE_SCHEMA, queryFn);
  assert.deepEqual(second, { count: 2, label: 'run-2' });
  assert.equal(queryCount, 2);
});

test('invalidate: empty list is a no-op (no error, no Redis round-trip surprise)', async () => {
  await invalidate([]);
  // Reaching here without throwing is the assertion. A bad implementation
  // (`UNLINK` with zero args) would throw `ERR wrong number of arguments`.
  assert.ok(true);
});

test('invalidatePattern: drops every matching key, leaves others alone', async () => {
  const matchA = k('avail:fayetteville:2026-05-21:2026-05-28');
  const matchB = k('avail:fayetteville:2026-05-29:2026-06-05');
  const noMatch = k('avail:bentonville:2026-05-21:2026-05-28');

  await Promise.all([
    redis.set(matchA, JSON.stringify({ count: 1, label: 'a' })),
    redis.set(matchB, JSON.stringify({ count: 2, label: 'b' })),
    redis.set(noMatch, JSON.stringify({ count: 3, label: 'c' })),
  ]);

  await invalidatePattern(k('avail:fayetteville:*'));

  assert.equal(await redis.get(matchA), null);
  assert.equal(await redis.get(matchB), null);
  assert.equal(await redis.get(noMatch), JSON.stringify({ count: 3, label: 'c' }));
});

test('invalidatePattern: pattern matching nothing is a clean no-op', async () => {
  await invalidatePattern(k('does-not-exist:*'));
  assert.ok(true);
});
