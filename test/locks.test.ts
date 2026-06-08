import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { db } from '../src/db/client.js';
import { lockCohort, lockDayCapacity, withDogModeLock } from '../src/db/locks.js';
import { pool } from '../src/db/pool.js';

const dbConfigured = typeof process.env.DATABASE_URL === 'string';

// Probe the advisory-lock state from a SEPARATE connection: open a fresh
// transaction, attempt a non-blocking acquire with `pg_try_advisory_xact_lock`,
// roll it back unconditionally. Returns true iff the probe could have
// acquired the lock — i.e. nobody else is holding it right now.
async function probeAdvisoryLock(probe: PoolClient, key: string): Promise<boolean> {
  await probe.query('BEGIN');
  try {
    const result = await probe.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
      [key],
    );
    return result.rows[0]?.acquired ?? false;
  } finally {
    await probe.query('ROLLBACK');
  }
}

// Day 3b Exit check #3: two concurrent transactions on the same `(dog, mode)`
// serialize on `withDogModeLock`. Proven with a separate pool client probing
// the lock via `pg_try_advisory_xact_lock` (returns immediately rather than
// blocking — so we can assert true/false instead of timing out).

test(
  'withDogModeLock holds a per-(dog, mode, location) advisory lock for the duration of the transaction',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    const dogId = randomUUID();
    const probe = await pool.connect();

    try {
      // Before the inner transaction starts, the lock must be free.
      assert.equal(
        await probeAdvisoryLock(probe, `${dogId}:school:fayetteville`),
        true,
        'lock should be free before any acquirer runs',
      );

      let lockObservedHeld = false;
      await db.transaction(async (tx) => {
        await withDogModeLock(tx, dogId, 'school', 'fayetteville', async () => {
          // While `fn` runs under the lock, the probe must NOT be able to
          // acquire the same key.
          lockObservedHeld =
            (await probeAdvisoryLock(probe, `${dogId}:school:fayetteville`)) === false;
        });
      });

      assert.equal(
        lockObservedHeld,
        true,
        'probe must observe withDogModeLock holding the advisory lock',
      );

      // After the outer transaction commits, the lock auto-releases. Note
      // there's no explicit `pg_advisory_unlock` in the implementation —
      // `_xact_` means the lifetime is bound to the transaction.
      assert.equal(
        await probeAdvisoryLock(probe, `${dogId}:school:fayetteville`),
        true,
        'lock should auto-release on transaction commit',
      );
    } finally {
      probe.release();
    }
  },
);

test(
  'withDogModeLock: different (dog, mode, location) triples do NOT serialize (lock is per triple, not global)',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    const dogA = randomUUID();
    const dogB = randomUUID();
    const probe = await pool.connect();

    try {
      await db.transaction(async (tx) => {
        await withDogModeLock(tx, dogA, 'school', 'fayetteville', async () => {
          // Same dog, same mode, same location → blocked (the only colliding key).
          assert.equal(
            await probeAdvisoryLock(probe, `${dogA}:school:fayetteville`),
            false,
            'same (dog, mode, location) must be blocked',
          );

          // Same dog, different mode → independent. A dog being booked into
          // school doesn't block a separate daycare booking for the same dog.
          assert.equal(
            await probeAdvisoryLock(probe, `${dogA}:daycare:fayetteville`),
            true,
            'same dog but different mode must NOT block',
          );

          // Same dog + mode but DIFFERENT location → independent (Δ 2026-06-04).
          // Credits are per-location, so a Fayetteville booking must not block a
          // Bentonville one for the same dog + mode.
          assert.equal(
            await probeAdvisoryLock(probe, `${dogA}:school:bentonville`),
            true,
            'same dog + mode but different location must NOT block',
          );

          // Different dog, same mode → independent. Two dogs booking school
          // at the same time must serialize per-dog, not globally.
          assert.equal(
            await probeAdvisoryLock(probe, `${dogB}:school:fayetteville`),
            true,
            'different dog must NOT block',
          );
        });
      });
    } finally {
      probe.release();
    }
  },
);

// lockCohort / lockDayCapacity are typed wrappers around SELECT ... FOR
// UPDATE — Postgres provides the locking semantic; these tests prove the
// wrappers return the right shape (smoke), not that Postgres locks
// correctly (that's Postgres's job, tested by Postgres).

test(
  'lockCohort returns undefined for a non-existent cohort id',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class Rollback extends Error {}
    await assert.rejects(
      db.transaction(async (tx) => {
        const row = await lockCohort(tx, randomUUID());
        assert.equal(row, undefined);
        throw new Rollback();
      }),
      Rollback,
    );
  },
);

test(
  'lockDayCapacity returns undefined when no override row exists for (location, date)',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class Rollback extends Error {}
    await assert.rejects(
      db.transaction(async (tx) => {
        // A date deliberately far in the future — guaranteed no override row.
        const row = await lockDayCapacity(tx, 'fayetteville', '2099-12-31');
        assert.equal(row, undefined);
        throw new Rollback();
      }),
      Rollback,
    );
  },
);
