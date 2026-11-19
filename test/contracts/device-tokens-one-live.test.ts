import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import { deviceTokens, idempotencyKeys, owners } from '../../src/db/schema/schema.js';
import { isLiveTokenConflict } from '../../src/db/repositories/deviceTokensRepository.js';
import { registerDeviceTokensRoute } from '../../src/routes/device-tokens.js';
import type { Principal } from '../../src/auth/principal.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * One live device-token row per token (O-MSG-LIVE pass 2a; A2 OH1, LR2's server half,
 * LR3's route consequence, LR11; `PostDeviceTokensRequest`'s doc in wire.ts 9.2.0).
 *
 * The story: one phone (token T) is signed into by Allison's family (A), then by the
 * Hendersons (B). A reply to A must never reach that phone again, so B's registration
 * expires A's row. And when B signs in with push off, B's DELETE of T expires every live
 * row holding T, whoever's: holding the token string is holding the device.
 *
 * Runs on a database carrying `device_tokens_live_token_uidx` (rs3 M5.30; in this lane, the
 * test-only shim). The "0 pushes to T" half of OH1-a and LR2-b is the push's (pass 2).
 */

registerFixtureHooks();

const OWNER_A: Principal = FIXTURE_OWNER_PRINCIPAL;
const OWNER_B_ID = randomUUID();
const OWNER_B: Principal = { kind: 'owner', ownerId: OWNER_B_ID, supabaseUid: randomUUID() };

before(async () => {
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  await db.insert(owners).values({
    id: OWNER_B_ID,
    supabaseUid: randomUUID(),
    name: 'The Hendersons',
    email: `hendersons-${OWNER_B_ID}@example.test`,
    phone: '555-0142',
    location: 'bentonville',
  });
});

after(async () => {
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  await db.delete(deviceTokens).where(eq(deviceTokens.ownerId, OWNER_B_ID));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.ownerId, OWNER_B_ID));
  await db.delete(owners).where(eq(owners.id, OWNER_B_ID));
});

function appFor(principal: Principal): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(principal);
  registerDeviceTokensRoute(app, { authenticate });
  return app;
}

function freshToken(): string {
  return `ExponentPushToken[${randomUUID()}]`;
}

function register(principal: Principal, token: string): Promise<LightMyRequestResponse> {
  return appFor(principal).inject({
    method: 'POST',
    url: '/device-tokens',
    headers: { 'idempotency-key': `p2a-dt-${randomUUID()}` },
    payload: { token, platform: 'ios' },
  });
}

function unregister(principal: Principal, token: string): Promise<LightMyRequestResponse> {
  return appFor(principal).inject({
    method: 'DELETE',
    url: `/device-tokens/${encodeURIComponent(token)}`,
    headers: { 'idempotency-key': `p2a-dt-del-${randomUUID()}` },
  });
}

async function rowsFor(token: string): Promise<Array<{ ownerId: string; live: boolean }>> {
  const rows = await db
    .select({ ownerId: deviceTokens.ownerId, expiredAt: deviceTokens.expiredAt })
    .from(deviceTokens)
    .where(eq(deviceTokens.expoPushToken, token));
  return rows.map((r) => ({ ownerId: r.ownerId, live: r.expiredAt === null }));
}

async function liveOwners(token: string): Promise<string[]> {
  return (await rowsFor(token)).filter((r) => r.live).map((r) => r.ownerId);
}

async function cleanup(...tokens: string[]): Promise<void> {
  for (const token of tokens) {
    await db.delete(deviceTokens).where(eq(deviceTokens.expoPushToken, token));
  }
}

test(
  'OH1-a (row half): A registers T, then B registers T — A’s row is expired, B’s is the one live row, A’s other token is untouched',
  SKIP_WHEN_NO_DB,
  async () => {
    const T = freshToken();
    const U = freshToken(); // A's tablet: another device, must stay live
    try {
      assert.equal((await register(OWNER_A, T)).statusCode, 201);
      assert.equal((await register(OWNER_A, U)).statusCode, 201);

      const b = await register(OWNER_B, T);
      // LR4-a's probe reads this line: pre-unit code on the rs3 schema answers 500 here.
      assert.equal(b.statusCode, 201, `B's registration: ${b.statusCode} ${b.body}`);
      assert.equal((b.json() as { owner_id: string }).owner_id, OWNER_B_ID);

      assert.deepEqual(await liveOwners(T), [OWNER_B_ID], 'one live row for T, and it is B’s');
      const rows = await rowsFor(T);
      assert.equal(rows.length, 2, 'A’s row is kept (expired, not deleted)');
      assert.deepEqual(
        rows.find((r) => r.ownerId === FIXTURE_IDS.ownerId),
        { ownerId: FIXTURE_IDS.ownerId, live: false },
        'A’s row for T is expired',
      );
      assert.deepEqual(await liveOwners(U), [FIXTURE_IDS.ownerId], 'A’s other device stays live');
    } finally {
      await cleanup(T, U);
    }
  },
);

test(
  'OH1-a: B registering T again leaves B’s one row touched, not expired (only OTHER families are expired)',
  SKIP_WHEN_NO_DB,
  async () => {
    const T = freshToken();
    try {
      const first = await register(OWNER_B, T);
      const second = await register(OWNER_B, T);
      assert.equal(first.statusCode, 201);
      assert.equal(second.statusCode, 201);
      assert.equal((second.json() as { id: string }).id, (first.json() as { id: string }).id);
      assert.deepEqual(await liveOwners(T), [OWNER_B_ID]);
      assert.equal((await rowsFor(T)).length, 1);
    } finally {
      await cleanup(T);
    }
  },
);

test(
  'OH1-c: A and B register T concurrently on two real connections — both 201, one live row (B’s, the later commit)',
  SKIP_WHEN_NO_DB,
  async () => {
    // A deterministic race, not a timed one. A test-local AFTER INSERT trigger makes A's
    // transaction stop right after its insert (its row in the live-token index, uncommitted)
    // on an advisory lock this test holds. B then runs: its expire sees nothing (A's row is
    // not committed), and its insert waits on A's transaction. The test releases A; A
    // commits; B's insert is a 23505 on device_tokens_live_token_uidx inside an aborted
    // transaction. LR11: the route re-runs B's whole mutation once, outside it.
    const T = freshToken();
    const lockKey = randomInt(1, 2 ** 31 - 1);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const fn = `p2a_oh1c_barrier_${suffix}`;
    const trg = `p2a_oh1c_barrier_${suffix}`;
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    let locked = false;
    try {
      await admin.query(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
         BEGIN PERFORM pg_advisory_xact_lock(${lockKey}); RETURN NULL; END $f$`,
      );
      await admin.query(
        `CREATE TRIGGER ${trg} AFTER INSERT ON device_tokens FOR EACH ROW
         WHEN (NEW.owner_id = '${FIXTURE_IDS.ownerId}' AND NEW.expo_push_token = '${T}')
         EXECUTE FUNCTION ${fn}()`,
      );
      await admin.query('SELECT pg_advisory_lock($1)', [lockKey]);
      locked = true;

      const waiting = async (waitEvent: 'advisory' | 'transactionid', what: string): Promise<void> => {
        for (let i = 0; i < 200; i += 1) {
          const { rows } = await admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = $1`,
            [waitEvent],
          );
          if ((rows[0]?.n ?? 0) >= 1) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`timed out waiting for ${what}`);
      };

      const a = register(OWNER_A, T);
      await waiting('advisory', 'A to stop after its insert');
      const b = register(OWNER_B, T);
      await waiting('transactionid', 'B’s insert to wait on A’s transaction');
      await admin.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      locked = false;

      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(ra.statusCode, 201, `A: ${ra.statusCode} ${ra.body}`);
      assert.equal(rb.statusCode, 201, `B: ${rb.statusCode} ${rb.body}`);
      assert.deepEqual(await liveOwners(T), [OWNER_B_ID], 'one live row, B’s');
      assert.equal((await rowsFor(T)).length, 2, 'A’s row expired by B’s re-run, not lost');
    } finally {
      if (locked) await admin.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      await admin.query(`DROP TRIGGER IF EXISTS ${trg} ON device_tokens`);
      await admin.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      await admin.end();
      await cleanup(T);
    }
  },
);

test(
  'LR2-b (row half): A registers T, B (push off) DELETEs T — 204, and no live row holds T',
  SKIP_WHEN_NO_DB,
  async () => {
    const T = freshToken();
    try {
      assert.equal((await register(OWNER_A, T)).statusCode, 201);
      const del = await unregister(OWNER_B, T);
      assert.equal(del.statusCode, 204, `B's DELETE: ${del.statusCode} ${del.body}`);
      assert.equal(del.body, '', '204 carries no body');
      assert.deepEqual(await liveOwners(T), [], 'no live row for T');
      assert.deepEqual(await rowsFor(T), [{ ownerId: FIXTURE_IDS.ownerId, live: false }]);
    } finally {
      await cleanup(T);
    }
  },
);

test(
  'DELETE /device-tokens/:token — 404 when no live row holds the token (never held, or already expired)',
  SKIP_WHEN_NO_DB,
  async () => {
    const never = freshToken();
    const T = freshToken();
    try {
      const none = await unregister(OWNER_B, never);
      assert.equal(none.statusCode, 404);
      assert.equal((none.json() as { error: { code: string } }).error.code, 'not_found');

      assert.equal((await register(OWNER_A, T)).statusCode, 201);
      assert.equal((await unregister(OWNER_A, T)).statusCode, 204);
      const again = await unregister(OWNER_B, T); // a fresh key: not a replay
      assert.equal(again.statusCode, 404, 'every row for T is already expired');
    } finally {
      await cleanup(never, T);
    }
  },
);

test('LR11: the re-run keys on device_tokens_live_token_uidx alone, by constraint name', () => {
  assert.equal(isLiveTokenConflict({ code: '23505', constraint: 'device_tokens_live_token_uidx' }), true);
  // The per-owner index is the upsert's arbiter: a 23505 naming it is a different story.
  assert.equal(isLiveTokenConflict({ code: '23505', constraint: 'device_tokens_uidx' }), false);
  assert.equal(isLiveTokenConflict({ code: '23505', constraint: 'idempotency_keys_pkey' }), false);
  assert.equal(isLiveTokenConflict({ code: '23505' }), false, 'no constraint name, no re-run');
  assert.equal(isLiveTokenConflict({ code: '25P02', constraint: 'device_tokens_live_token_uidx' }), false);
  assert.equal(isLiveTokenConflict(new Error('device_tokens_live_token_uidx')), false);
  assert.equal(isLiveTokenConflict(null), false);
});
