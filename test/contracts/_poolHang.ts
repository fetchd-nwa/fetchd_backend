import assert from 'node:assert/strict';
import pg from 'pg';
import { pool } from '../../src/db/pool.js';
import { TRANSACTION_SLOTS } from '../../src/db/tx.js';

/**
 * A pooled read inside a transaction (O-MSG-LIVE pass 2 fix 1, M1): a request whose transaction
 * holds one pooled connection and then reads on the POOL needs a second. Before O-POOLFIX the pool
 * was 10 with no connect timeout, so ten such requests at once held all ten and each waited for an
 * eleventh: the whole API hung, and nothing logged. O-POOLFIX bounds it: a checkout waits at most
 * 10 s (`src/db/pool.ts`), and transactions together hold at most `max − 1` slots (`src/db/tx.ts`,
 * `TRANSACTION_SLOTS`), so a pooled read always finds the slot no transaction may take. That read
 * is still wrong (outside its transaction's snapshot and locks, and a second connection); the
 * pool-read guard every `registerFixtureHooks()` file installs is what fails it now.
 *
 * These helpers make the requests provably overlap and keep a red run from hanging the suite:
 *   · `overlapAll` holds a lock on a connection OUTSIDE the pool until every request that CAN hold
 *     a transaction slot is blocked on it inside its transaction (`max − 1` of them at most; the
 *     rest wait in `tx.ts`'s slot queue, first come first served), releases it, and times the
 *     release to the last answer on the database clock;
 *   · `forceEndPool`, for a file's first `after` hook (registered BEFORE the fixture's, whose
 *     teardown reads on the pool): terminates, from outside, every connection the pool holds and
 *     lets its queue through, so every stuck request fails and settles and the pool works again.
 */

/** How long the requests may take to reach the held lock (polled every 20 ms). */
const REACH_LOCK_TRIES = 750;

/**
 * How many transactions can hold a pool slot at once: `src/db/tx.ts`'s `TRANSACTION_SLOTS` itself
 * (O-POOLFIX fix 2 commit A; imported, not copied, since O-POOLFIX-B, so a moved bound moves this
 * too). Only that many of a burst can reach a lock inside their transactions; the others queue for
 * a slot until one is released.
 */
export function transactionSlots(): number {
  return TRANSACTION_SLOTS;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PoolHangKit {
  /** Every request `overlapAll` started, while a red run may leave them stuck. */
  readonly inFlight: Array<Promise<unknown>>;
  /** True from the first request until every one answered: the after hook then force-ends. */
  mayBeStuck(): boolean;
  overlapAll<T>(
    lockSql: string,
    params: unknown[],
    count: number,
    fire: () => Array<Promise<T>>,
  ): Promise<{ results: T[]; seconds: number }>;
  /** For the file's first `after` hook: force-end the pool if stuck, then close the side connections. */
  release(label: string): Promise<void>;
}

export function makePoolHangKit(): PoolHangKit {
  const inFlight: Array<Promise<unknown>> = [];
  const sides: pg.Client[] = [];
  let stuck = false;

  async function sideClient(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    sides.push(client);
    await client.connect();
    return client;
  }

  async function waitForLockWaiters(watcher: pg.Client, count: number): Promise<void> {
    for (let tries = 0; tries < REACH_LOCK_TRIES; tries += 1) {
      // A connection of its own, outside any transaction: each query reads a fresh snapshot.
      const { rows } = await watcher.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if ((rows[0]?.n ?? 0) >= count) return;
      await sleep(20);
    }
    assert.fail(`fewer than ${count} requests reached the held lock`);
  }

  async function forceEndPool(label: string): Promise<void> {
    const clients =
      (pool as unknown as { _clients?: Array<{ processID?: number | null }> })._clients ?? [];
    const pids = clients
      .map((c) => c.processID)
      .filter((pid): pid is number => typeof pid === 'number');
    const side = await sideClient();
    const { rows } = await side.query<{ n: number }>(
      `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE pid = ANY($1::int[])`,
      [pids],
    );
    // A request whose transaction waits in the pool's QUEUE (not on a query) is not woken by its
    // connection dying: the dead client stays checked out and the full pool never serves the
    // queue. So open room, and run one query: pg-pool serves its queue on a release, each waiter
    // then gets a fresh connection, and its request fails on its dead transaction and settles.
    const internals = pool as unknown as { options: { max: number } };
    const max = internals.options.max;
    internals.options.max = max * 2;
    await Promise.race([pool.query('SELECT 1').catch(() => undefined), sleep(5000)]);
    process.stderr.write(
      `[${label}] force-ended the pool: ${rows[0]?.n ?? 0} of ${pids.length} connections terminated\n`,
    );
    await Promise.race([Promise.allSettled(inFlight), sleep(15_000)]);
    internals.options.max = max;
  }

  return {
    inFlight,
    mayBeStuck: () => stuck,
    async overlapAll(lockSql, params, count, fire) {
      const holder = await sideClient();
      const watcher = await sideClient();
      await holder.query('BEGIN');
      await holder.query(lockSql, params);
      stuck = true;
      const pending = fire();
      inFlight.push(...pending);
      await waitForLockWaiters(watcher, Math.min(count, transactionSlots()));
      const { rows: released } = await watcher.query<{ at: string }>(
        'SELECT clock_timestamp()::text AS at',
      );
      await holder.query('ROLLBACK');
      const results = await Promise.all(pending);
      const { rows: took } = await watcher.query<{ seconds: number }>(
        'SELECT extract(epoch FROM clock_timestamp() - $1::timestamptz)::float8 AS seconds',
        [released[0]?.at],
      );
      stuck = false;
      return { results, seconds: took[0]?.seconds ?? Number.POSITIVE_INFINITY };
    },
    async release(label) {
      if (stuck) await forceEndPool(label);
      for (const client of sides.splice(0)) await client.end().catch(() => undefined);
    },
  };
}
