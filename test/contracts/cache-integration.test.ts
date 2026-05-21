import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  announcementsCacheKey,
  announcementsRepository,
} from '../../src/db/repositories/announcementsRepository.js';
import {
  dayCapacityCacheKey,
  dayCapacityRepository,
} from '../../src/db/repositories/dayCapacityRepository.js';
import {
  GROUP_CLASSES_CATALOG_KEY,
  groupClassesRepository,
} from '../../src/db/repositories/groupClassesRepository.js';
import { announcements, dayCapacity } from '../../src/db/schema/schema.js';
import { hashRequestBody, withMutation } from '../../src/db/mutation.js';
import { invalidate, invalidatePattern } from '../../src/lib/cache.js';
import { redis } from '../../src/redis.js';
import { registerAnnouncementsRoute } from '../../src/routes/announcements.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day-8 read-through integration. The `cache.test.ts` unit tests prove
 * the `readThrough`/`invalidate`/`invalidatePattern` mechanics; the tests
 * here prove the **end-to-end** behavior wired into a real repo + route +
 * Postgres seam: the SECOND call returns a value from Redis even when
 * the DB row has changed under it, and `cache.invalidate` is the only
 * thing that lets the changed row be observed.
 *
 * Each test mutates a fixture row and restores it before exit so the
 * snapshot tests in `announcements.test.ts` see clean state. The test
 * file's `before(seedFixture)` also re-seeds + flushes the cache for
 * subsequent files, so the restore is belt-and-suspenders, not load-
 * bearing for cross-file isolation.
 */

registerFixtureHooks();

test(
  'announcements read-through: second call serves the cached value even after the DB row mutates',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAnnouncementsRoute(app, { authenticate });

    // 1. Cold call — populates `ann:all` from the fixture.
    const cold = await app.inject({ method: 'GET', url: '/announcements' });
    assert.equal(cold.statusCode, 200);
    const coldBody = cold.json() as { id: string; title: string }[];
    const fixtureTitle = coldBody.find((a) => a.id === FIXTURE_IDS.announcement1Id)?.title;
    assert.equal(fixtureTitle, 'Meet our new trainer Fed', 'fixture data sanity check');
    assert.equal(await redis.exists(announcementsCacheKey(null)), 1, 'cold call must seed cache');

    // 2. Mutate the DB row UNDER the cache. The cache key is untouched
    //    so the next read should still see the old value.
    const corruptedTitle = 'CORRUPTED — should never reach the wire while cache is warm';
    try {
      await db
        .update(announcements)
        .set({ title: corruptedTitle })
        .where(eq(announcements.id, FIXTURE_IDS.announcement1Id));

      // 3. Warm call — must return the original (cached) title, NOT
      //    the corrupted DB value. This is the load-bearing assertion:
      //    the cache served, the DB was not re-queried.
      const warm = await app.inject({ method: 'GET', url: '/announcements' });
      assert.equal(warm.statusCode, 200);
      const warmBody = warm.json() as { id: string; title: string }[];
      const warmTitle = warmBody.find((a) => a.id === FIXTURE_IDS.announcement1Id)?.title;
      assert.equal(
        warmTitle,
        'Meet our new trainer Fed',
        'warm read must serve the cached value, not the freshly-mutated DB row',
      );

      // 4. Invalidate the key — Day-9+ mutations will do this via the
      //    `withMutation` `keysToInvalidate` callback. After this, the next
      //    read MUST hit the DB again.
      await invalidate([announcementsCacheKey(null)]);
      assert.equal(
        await redis.exists(announcementsCacheKey(null)),
        0,
        'invalidate must drop the key',
      );

      // 5. Post-invalidate call — cache miss → DB re-queried → corrupted
      //    title surfaces. The full read-through round trip is exercised.
      const fresh = await app.inject({ method: 'GET', url: '/announcements' });
      assert.equal(fresh.statusCode, 200);
      const freshBody = fresh.json() as { id: string; title: string }[];
      const freshTitle = freshBody.find((a) => a.id === FIXTURE_IDS.announcement1Id)?.title;
      assert.equal(
        freshTitle,
        corruptedTitle,
        'after invalidate, the next read must re-query the DB and see the new value',
      );
    } finally {
      // Restore so the snapshot tests in announcements.test.ts see the
      // original fixture data even if their seedFixture is skipped for
      // any reason. Always-on cleanup, regardless of assertion outcome.
      await db
        .update(announcements)
        .set({ title: 'Meet our new trainer Fed' })
        .where(eq(announcements.id, FIXTURE_IDS.announcement1Id));
      await invalidatePattern('ann:*');
    }
  },
);

test(
  'group classes read-through: same cache hit / invalidate semantics on a stable catalog read',
  SKIP_WHEN_NO_DB,
  async () => {
    // Cold call — `findAll` caches under `groupclasses:catalog`.
    const first = await groupClassesRepository.findAll();
    assert.ok(first.length > 0, 'group classes fixture must seed at least one row');
    assert.equal(await redis.exists(GROUP_CLASSES_CATALOG_KEY), 1);

    // Warm call returns the same shape directly (already cached).
    const second = await groupClassesRepository.findAll();
    assert.deepStrictEqual(second, first);

    // Invalidate drops the key; the next call re-queries.
    await invalidate([GROUP_CLASSES_CATALOG_KEY]);
    assert.equal(await redis.exists(GROUP_CLASSES_CATALOG_KEY), 0);

    const third = await groupClassesRepository.findAll();
    assert.deepStrictEqual(third, first, 're-query result matches original (fixture unchanged)');
    assert.equal(
      await redis.exists(GROUP_CLASSES_CATALOG_KEY),
      1,
      're-query must repopulate cache',
    );
  },
);

test(
  'day-capacity read-through: range cache serves the cached value across DB mutation; pattern-wipe drops every range under a location prefix',
  SKIP_WHEN_NO_DB,
  async () => {
    const location = 'fayetteville';
    const from = '2026-05-17';
    const to = '2026-05-19';
    const rangeKey = dayCapacityCacheKey(location, from, to);

    // The two live fixture overrides in this range: 2026-05-17 (school 2,
    // daycare 1) and 2026-05-19 (both zero). The 2026-05-22 row is
    // soft-expired so it is NOT in the result regardless of caching.

    // 1. Cold call seeds `avail:fayetteville:2026-05-17:2026-05-19`.
    const cold = await dayCapacityRepository.findOverridesInRange(location, from, to);
    assert.equal(cold.length, 2, 'two live overrides in this range');
    const cold17 = cold.find((r) => r.date === '2026-05-17');
    assert.equal(cold17?.school_openings, 2, 'fixture sanity check');
    assert.equal(await redis.exists(rangeKey), 1, 'cold call must seed cache');

    // 2. Mutate the underlying row UNDER the warm cache.
    const corruptedOpenings = 99;
    try {
      await db
        .update(dayCapacity)
        .set({ schoolOpenings: corruptedOpenings })
        .where(eq(dayCapacity.location, location));

      // 3. Warm call — cached pre-mutation values must serve.
      const warm = await dayCapacityRepository.findOverridesInRange(location, from, to);
      const warm17 = warm.find((r) => r.date === '2026-05-17');
      assert.equal(
        warm17?.school_openings,
        2,
        'warm read must serve the cached value, not the freshly-mutated DB row',
      );

      // 4. Seed a SECOND range cache so we can prove the pattern wipe
      //    catches both — this mirrors the Day-9 day_capacity write idiom
      //    `invalidatePattern('avail:{location}:*')`.
      const secondFrom = '2026-05-19';
      const secondTo = '2026-05-21';
      const secondRangeKey = dayCapacityCacheKey(location, secondFrom, secondTo);
      await dayCapacityRepository.findOverridesInRange(location, secondFrom, secondTo);
      assert.equal(await redis.exists(secondRangeKey), 1);

      // 5. Pattern wipe — both keys drop.
      await invalidatePattern(`avail:${location}:*`);
      assert.equal(await redis.exists(rangeKey), 0, 'pattern wipe must drop the first range');
      assert.equal(
        await redis.exists(secondRangeKey),
        0,
        'pattern wipe must drop the second range',
      );

      // 6. Post-wipe call — cache miss → DB re-queried → mutated value
      //    surfaces. Confirms the cache was the only thing hiding it.
      const fresh = await dayCapacityRepository.findOverridesInRange(location, from, to);
      const fresh17 = fresh.find((r) => r.date === '2026-05-17');
      assert.equal(
        fresh17?.school_openings,
        corruptedOpenings,
        'after pattern wipe, the next read must re-query the DB and see the new value',
      );
    } finally {
      // Restore each fixture row precisely (the bulk-by-location UPDATE
      // above mutated all three — the two live + the soft-expired one).
      // Belt-and-suspenders for tests in this file; the file-level
      // `seedFixture` re-seeds the next file anyway.
      await db
        .update(dayCapacity)
        .set({ schoolOpenings: 2 })
        .where(and(eq(dayCapacity.location, location), eq(dayCapacity.date, '2026-05-17')));
      await db
        .update(dayCapacity)
        .set({ schoolOpenings: 0 })
        .where(and(eq(dayCapacity.location, location), eq(dayCapacity.date, '2026-05-19')));
      await db
        .update(dayCapacity)
        .set({ schoolOpenings: 0 })
        .where(and(eq(dayCapacity.location, location), eq(dayCapacity.date, '2026-05-22')));
      await invalidatePattern(`avail:${location}:*`);
    }
  },
);

// --- Synthetic mutation test: withMutation post-commit invalidate ---------
//
// Day-9 mutations will compose:
//   await withMutation({ ..., keysToInvalidate: (body) => ['ann:all'] }, async (tx) => {
//     ... actual write ...
//     return { status: 200, body };
//   });
//
// This test exercises the wiring without a real mutation route — it
// builds the smallest possible withMutation call that asserts:
//   1. keysToInvalidate fires for NEW outcomes
//   2. keysToInvalidate does NOT fire for REPLAYED outcomes
//   3. The keys are actually dropped from Redis after keysToInvalidate runs
//
// Each call uses a fresh `Idempotency-Key` so the first run is `new`.
// The second uses the SAME key + same hash → idempotency replays the
// stored response → invalidate must be skipped.

test(
  'withMutation: keysToInvalidate fires post-commit for new outcomes, skipped on replay',
  SKIP_WHEN_NO_DB,
  async () => {
    const key = 'test:withmutation:synthetic';
    const idempotencyKey = randomUUID();
    const requestHash = hashRequestBody({ probe: 'day-8' });

    // Seed a value under the cache key so we can prove it's dropped.
    await redis.set(key, JSON.stringify({ payload: 'will-be-dropped' }), 'EX', 60);
    assert.equal(await redis.exists(key), 1);

    let invalidateRunCount = 0;
    const params = {
      principal: FIXTURE_OWNER_PRINCIPAL,
      idempotencyKey,
      endpoint: 'POST /test/day-8-synthetic',
      requestHash,
      keysToInvalidate: (body: { ok: true }) => {
        invalidateRunCount++;
        assert.deepStrictEqual(body, { ok: true }, 'callback receives the response body');
        return [key];
      },
    } as const;

    // First call — `new` outcome. keysToInvalidate must fire; key drops.
    const first = await withMutation(params, async () => {
      return { status: 200, body: { ok: true } as const };
    });
    assert.equal(first.replayed, false);
    assert.equal(invalidateRunCount, 1, 'keysToInvalidate must run exactly once on new outcome');
    assert.equal(
      await redis.exists(key),
      0,
      'keysToInvalidate must drop the cache key post-commit',
    );

    // Seed the key again to prove the replay path does NOT touch it.
    await redis.set(key, JSON.stringify({ payload: 'must-survive-replay' }), 'EX', 60);

    // Second call — same Idempotency-Key + same hash → replayed.
    const second = await withMutation(params, async () => {
      throw new Error('fn must not be called on replay');
    });
    assert.equal(second.replayed, true);
    assert.equal(invalidateRunCount, 1, 'keysToInvalidate must NOT fire on replay');
    assert.equal(
      await redis.get(key),
      JSON.stringify({ payload: 'must-survive-replay' }),
      'replay must leave the cache untouched',
    );

    // Clean up.
    await invalidate([key]);
  },
);

test(
  'withMutation: a throwing keysToInvalidate does NOT fail the mutation (committed → success returned)',
  SKIP_WHEN_NO_DB,
  async () => {
    const idempotencyKey = randomUUID();
    const requestHash = hashRequestBody({ probe: 'day-8-invalidate-throws' });

    // Redirect stderr to capture the operator-visible log line. The
    // logger seam Day-20 wires will replace this with a Sentry-routed
    // call; the test stays a regression net regardless.
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as typeof process.stderr.write;

    try {
      const outcome = await withMutation(
        {
          principal: FIXTURE_OWNER_PRINCIPAL,
          idempotencyKey,
          endpoint: 'POST /test/day-8-invalidate-throws',
          requestHash,
          keysToInvalidate: () => {
            throw new Error('synthetic redis blip');
          },
        },
        async () => ({ status: 201, body: { committed: true } as const }),
      );

      assert.equal(outcome.replayed, false);
      assert.equal(outcome.status, 201, 'committed mutation must return its real status');
      assert.deepStrictEqual(outcome.body, { committed: true });
    } finally {
      process.stderr.write = originalWrite;
    }

    const log = captured.join('');
    assert.ok(
      log.includes('post-commit invalidate failed') && log.includes('synthetic redis blip'),
      `operator log must surface the failure and error message; got: ${log}`,
    );
  },
);

// --- Trust-boundary regression: stale-schema cached row is treated as miss

test(
  'announcements read-through: stale-shape cached value is dropped and re-queried',
  SKIP_WHEN_NO_DB,
  async () => {
    // Plant a cached value with a missing required field. The schema is
    // strict — Zod rejects, cache.ts drops the key, queryFn re-queries.
    await redis.set(
      announcementsCacheKey(null),
      JSON.stringify([{ id: 'not-a-uuid', completelyWrong: true }]),
      'EX',
      60,
    );

    const result = await announcementsRepository.findLive(null);
    assert.ok(Array.isArray(result));
    assert.ok(result.length > 0, 'stale cache must trigger re-query, not return the bad shape');
    assert.ok(
      result.every((r) => typeof r.id === 'string' && r.id.length === 36),
      'every returned row must have a real UUID id (fixture shape)',
    );
  },
);
