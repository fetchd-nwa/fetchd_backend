import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';
import { withActor } from '../../src/db/tx.js';
import { registerEventsRoute } from '../../src/routes/events.js';
import { registerHealthRoute } from '../../src/routes/health.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { poolReadGuardSeen, withPoolReadGuardPaused } from './_poolReadGuard.js';

/**
 * **The pool cannot deadlock on itself** (O-POOLFIX fix 2; r2 Fable M1 = Opus L3).
 *
 * A transaction body that awaited a read on the pool needed a second slot while its own was held, so ten such
 * bodies at once (the pool's size) each waited for a slot only another waiter could free. Executed at the production
 * entry: twelve parallel `DELETE /events/:id/rsvp` from one owner wedged the API for good before fix 1, and with
 * fix 1 stalled every route for 10 s, answered twelve 500s and sent twelve pages. Fix 2 keeps one slot that no
 * transaction may take (`tx.ts`), and moves the reads the seats found onto `tx`.
 *
 *   S1  twelve, then forty, concurrent un-RSVPs from one owner all answer 200, promptly.
 *   S2  ten transactions blocked on a lock: nine hold slots, the tenth waits for a TRANSACTION slot and rejects at
 *       the checkout timeout with the pool's own text; meanwhile `/health` answers 200 at once (on the base it waited
 *       the 10 s and answered 503); released, the nine commit.
 *   S3  twelve transaction bodies, each awaiting a read on the pool, all resolve: the bound protects a route no test
 *       drives (the read is planted on purpose, with the pool-read guard paused for it).
 *   S4  the pool-read guard is live: driving a route records a transaction opened by `src/`.
 */

registerFixtureHooks();

const ACTOR = 'system:pool-saturation-test';

/** Settles to the outcome rather than throwing, so one failure is reported with the rest. */
async function outcome<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function unRsvpBurst(
  n: number,
): Promise<{ statuses: number[]; bodies: unknown[]; slowestMs: number }> {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEventsRoute(app, { authenticate });
  await app.ready();
  try {
    const t0 = Date.now();
    const answers = await Promise.all(
      Array.from({ length: n }, () =>
        app
          .inject({
            method: 'DELETE',
            url: `/events/${FIXTURE_IDS.eventPublicPupsId}/rsvp`,
            headers: { 'idempotency-key': randomUUID() },
          })
          .then((res) => ({
            status: res.statusCode,
            body: res.json() as unknown,
            ms: Date.now() - t0,
          })),
      ),
    );
    return {
      statuses: answers.map((a) => a.status),
      bodies: answers.map((a) => a.body),
      slowestMs: Math.max(...answers.map((a) => a.ms)),
    };
  } finally {
    await app.close();
  }
}

for (const n of [12, 40]) {
  test(
    `S1: ${n} concurrent un-RSVPs from one owner all answer 200, promptly (the pool does not deadlock on itself)`,
    { ...SKIP_WHEN_NO_DB, timeout: 60_000 },
    async (t) => {
      const { statuses, bodies, slowestMs } = await unRsvpBurst(n);
      t.diagnostic(`statuses ${JSON.stringify(statuses)}; slowest ${slowestMs} ms`);
      assert.equal(pool.options.max, 10, 'precondition: the pool has its 10 slots');
      assert.deepEqual(
        statuses,
        Array.from({ length: n }, () => 200),
        `every un-RSVP answers 200 (got ${JSON.stringify(statuses)}, slowest ${slowestMs} ms; ${JSON.stringify(bodies.find((_, i) => statuses[i] !== 200))})`,
      );
      for (const body of bodies) assert.deepEqual(body, { ok: true });
      assert.ok(
        slowestMs < 5_000,
        `promptly, never at a checkout timeout (slowest ${slowestMs} ms)`,
      );
    },
  );
}

test(
  'S2: ten transactions blocked on a lock: nine hold slots, the tenth times out waiting for a slot, /health answers 200 at once, and the nine commit once released',
  { ...SKIP_WHEN_NO_DB, timeout: 60_000 },
  async (t) => {
    const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerHealthRoute(app);
    await app.ready();
    // The lock is held by a connection of its own, never one of the pool's.
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const key = 7_300_000_000 + Math.floor(Math.random() * 1_000_000);
    try {
      await admin.query('SELECT pg_advisory_lock($1)', [key]);
      const t0 = Date.now();
      const writes = Array.from({ length: 10 }, () =>
        outcome(
          withActor(ACTOR, async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
            return 'committed';
          }),
        ).then((o) => ({ ...o, ms: Date.now() - t0 })),
      );
      let waitingOnLock = 0;
      for (let i = 0; i < 250 && waitingOnLock < 9; i += 1) {
        const r = await admin.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`,
        );
        waitingOnLock = r.rows[0].n as number;
        if (waitingOnLock < 9) await new Promise((r2) => setTimeout(r2, 20));
      }
      await new Promise((r) => setTimeout(r, 200));
      const blockedNow = (
        await admin.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`,
        )
      ).rows[0].n as number;
      const h0 = Date.now();
      const health = await app.inject({ method: 'GET', url: '/health' });
      const healthMs = Date.now() - h0;
      t.diagnostic(
        `blocked on the lock: ${blockedNow}; pool total ${pool.totalCount} idle ${pool.idleCount} waiting ${pool.waitingCount}; /health ${health.statusCode} in ${healthMs} ms`,
      );
      assert.equal(
        blockedNow,
        9,
        'nine transactions hold slots, blocked on the lock: never all ten',
      );
      assert.equal(
        pool.waitingCount,
        0,
        'the tenth waits for a transaction slot, not in the pool’s queue',
      );
      assert.equal(
        health.statusCode,
        200,
        `/health answers 200 while the writes are blocked (got ${health.statusCode} after ${healthMs} ms)`,
      );
      assert.equal((health.json() as { checks: { db: string } }).checks.db, 'ok');
      assert.ok(healthMs < 2_000, `…at once, never at the checkout timeout (${healthMs} ms)`);
      // Hold the lock past the timeout: the waiter gives up with the pool's own words.
      await new Promise((r) => setTimeout(r, Math.max(0, 11_000 - (Date.now() - t0))));
      await admin.query('SELECT pg_advisory_unlock($1)', [key]);
      const results = await Promise.all(writes);
      t.diagnostic(`outcomes ${JSON.stringify(results)}`);
      const rejected = results.filter((r) => !r.ok);
      assert.equal(rejected.length, 1, 'exactly one transaction gave up');
      const [late] = rejected;
      assert.ok(late !== undefined && !late.ok);
      assert.equal(
        late.message,
        'timeout exceeded when trying to connect',
        'with the checkout timeout’s own text',
      );
      assert.ok(late.ms >= 9_500 && late.ms < 15_000, `at the 10 s bound (${late.ms} ms)`);
      assert.equal(
        results.filter((r) => r.ok && r.value === 'committed').length,
        9,
        'the nine commit once the lock goes',
      );
    } finally {
      await admin.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      await admin.end();
      await app.close();
    }
  },
);

test(
  'S3: twelve transaction bodies, each awaiting a read on the pool, all resolve (the bound covers a route no test drives)',
  { ...SKIP_WHEN_NO_DB, timeout: 60_000 },
  async (t) => {
    const t0 = Date.now();
    const results = await withPoolReadGuardPaused(() =>
      Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          outcome(
            withActor(ACTOR, async (tx) => {
              await tx.execute(sql`select pg_sleep(0.05)`);
              // The planted read: on the pool, while this transaction holds its slot.
              const r = await db.execute(sql`select ${i}::int as i`);
              return (r.rows[0] as { i: number }).i;
            }),
          ),
        ),
      ),
    );
    const ms = Date.now() - t0;
    t.diagnostic(`${JSON.stringify(results)} in ${ms} ms`);
    assert.deepEqual(
      results,
      Array.from({ length: 12 }, (_, i) => ({ ok: true, value: i })),
      'every body resolves with its own read',
    );
    assert.ok(ms < 5_000, `promptly, never at a checkout timeout (${ms} ms)`);
  },
);

test(
  'S4: the pool-read guard is live: a driven route’s transaction is classified as opened by src/',
  { ...SKIP_WHEN_NO_DB, timeout: 30_000 },
  async () => {
    const before = poolReadGuardSeen();
    const { statuses } = await unRsvpBurst(1);
    assert.deepEqual(statuses, [200]);
    const after = poolReadGuardSeen();
    assert.equal(
      after.srcTransactions - before.srcTransactions,
      1,
      'the route’s transaction was seen, and seen as src/’s',
    );
  },
);
