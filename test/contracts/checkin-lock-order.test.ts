import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import type pg from 'pg';
import { pool } from '../../src/db/pool.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import { FIXTURE_STAFF_PRINCIPAL, SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { clearPlantedPools, plantLot } from './_poolFixture.js';
import { at, boardApp, createSession, makeClock, removeSessions, verb } from './_checkinFixture.js';

/**
 * The board's one new lock edge, on real connections (`db/locks.ts`): a verb takes the
 * booking row, then the dog row (`no key update`, the check-in's clock), then the pool.
 * Each test parks the real verb on one lock a third connection holds and proves, without
 * waiting, which lock the verb already holds. A statement trace cannot see this order.
 */

registerFixtureHooks();
const dogs: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  await removeSessions(sessions.splice(0));
  await clearPlantedPools();
});
after(async () => {
  await removeDogs(dogs);
});

const DAY = '2026-10-13';

async function hold(
  sql: string,
  params: unknown[],
): Promise<{ client: pg.PoolClient; pid: number }> {
  const client = await pool.connect();
  await client.query('BEGIN');
  const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  await client.query(sql, params);
  return { client, pid: rows[0]!.pid };
}

async function release(held: { client: pg.PoolClient }): Promise<void> {
  await held.client.query('ROLLBACK');
  held.client.release();
}

async function untilBlockedBy(pid: number): Promise<string> {
  for (let tries = 0; tries < 500; tries += 1) {
    const { rows } = await pool.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
      [pid],
    );
    if (rows[0] !== undefined) return rows[0].query;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`nobody queued behind backend ${pid}`);
}

/** Is this row lock free right now? Never waits. */
async function rowIsFree(sql: string, params: unknown[]): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql, params);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') return false;
    throw err;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test(
  "a check-in holds the booking row while it waits on the dog's row (booking before dog)",
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(dogs);
    const lotId = await plantLot({ credits: 2, expiresAt: at('2027-06-01', '12:00') });
    const { bookingId } = await createSession({
      dogIds: [dogId],
      date: DAY,
      lotId,
      ledger: sessions,
    });
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:35')));

    // The alumni record's lock on the dog, as `dogsRepository.lockForAlumniUpdate` takes it.
    const dogLock = await hold('SELECT 1 FROM dogs WHERE id = $1 FOR NO KEY UPDATE', [dogId]);
    const checkingIn = verb(app, { bookingId, dogId, verb: 'check-in' });
    try {
      const waiting = await untilBlockedBy(dogLock.pid);
      assert.match(waiting, /"dogs"/, 'the check-in waits on the dog row');
      assert.equal(
        await rowIsFree('SELECT 1 FROM bookings WHERE id = $1 FOR UPDATE NOWAIT', [bookingId]),
        false,
        'and already holds the booking row',
      );
    } finally {
      await release(dogLock);
    }
    assert.equal((await checkingIn).statusCode, 200);
  },
);

test(
  "a re-check-in owed a credit holds the dog's row while it waits on the pool (dog before pool)",
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createBookableDog(dogs);
    const lotId = await plantLot({ credits: 2, expiresAt: at('2027-06-01', '12:00') });
    const { bookingId } = await createSession({
      dogIds: [dogId],
      date: DAY,
      lotId,
      ledger: sessions,
    });
    const clock = makeClock(at(DAY, '07:35'));
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    assert.equal((await verb(app, { bookingId, dogId, verb: 'check-in' })).statusCode, 200);
    clock.set(at(DAY, '11:00'));
    const early = await verb(app, {
      bookingId,
      dogId,
      verb: 'check-out',
      body: { reissue_credit: true },
    });
    assert.equal(early.statusCode, 200, early.body);

    clock.set(at(DAY, '14:30'));
    const poolKey = `pool:${FIXTURE_IDS.ownerId}:bentonville:school:regular`;
    const poolLock = await hold('SELECT pg_advisory_xact_lock(hashtext($1))', [poolKey]);
    const back = verb(app, { bookingId, dogId, verb: 'check-in' });
    try {
      const waiting = await untilBlockedBy(poolLock.pid);
      assert.match(waiting, /pg_advisory_xact_lock/, 'the re-check-in waits on the pool');
      assert.equal(
        await rowIsFree('SELECT 1 FROM dogs WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [dogId]),
        false,
        "and already holds the dog's row",
      );
    } finally {
      await release(poolLock);
    }
    assert.equal((await back).statusCode, 200);
  },
);
