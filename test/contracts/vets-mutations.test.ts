import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { vets } from '../../src/db/schema/schema.js';
import { vetsRepository } from '../../src/db/repositories/vetsRepository.js';
import { registerVetsRoute } from '../../src/routes/vets.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day-9b contract tests for the first mutation surface: POST/PATCH/DELETE
 * /vets + GET /vets/:id. Exercises the full `withMutation` composition
 * end-to-end against real Postgres + Redis through the live Fastify
 * request lifecycle — only `authenticate` is stubbed (the JWKS path is
 * already covered by `auth.test.ts`).
 *
 * Coverage:
 *  - POST 201 + Vet wire shape; idempotency replay (same key+body); 422
 *    on key+body-hash mismatch; 400 on missing header; staff can also
 *    create; empty-string fields normalize to null (omitted on wire).
 *  - GET /vets/:id 200 + snapshot byte-match (fixture vet); 404 unknown;
 *    400 non-UUID.
 *  - PATCH staff 200 + updated; owner 403; clearing optional fields via
 *    null; empty-set body 400.
 *  - DELETE staff 204; owner 403; subsequent GET 404; conflict 409 when
 *    a live dog still names the vet as primary_vet_id; 404 unknown id;
 *    audit_log row records the soft-expire with the staff actor.
 */

registerFixtureHooks();

const POST_BASE = { name: 'Day-9b Test Vet', phone: '555-9001' };

async function createTestVet(opts: { name?: string } = {}): Promise<{
  app: ReturnType<typeof makeContractApp>['app'];
  id: string;
}> {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerVetsRoute(app, { authenticate });
  const res = await app.inject({
    method: 'POST',
    url: '/vets',
    headers: { 'idempotency-key': `setup-${randomUUID()}` },
    payload: { ...POST_BASE, name: opts.name ?? POST_BASE.name },
  });
  assert.equal(res.statusCode, 201, `setup POST failed: ${res.body}`);
  return { app, id: (res.json() as { id: string }).id };
}

test('POST /vets — owner creates returns 201 + Vet wire shape', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerVetsRoute(app, { authenticate });

  const res = await app.inject({
    method: 'POST',
    url: '/vets',
    headers: { 'idempotency-key': `post-create-${randomUUID()}` },
    payload: {
      name: '  Smith Animal Clinic  ',
      phone: '479-555-0200',
      email: 'hello@smithvet.example',
      address: '700 Smith St, Fayetteville, AR',
      notes: 'New owner-added clinic',
    },
  });

  assert.equal(res.statusCode, 201);
  const body = res.json() as {
    id: string;
    name: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
  };
  // UUID is server-generated; assert shape, not value.
  assert.match(body.id, /^[0-9a-f-]{36}$/);
  assert.equal(body.name, 'Smith Animal Clinic'); // server trims leading/trailing whitespace
  assert.equal(body.phone, '479-555-0200');
  assert.equal(body.email, 'hello@smithvet.example');
  assert.equal(body.address, '700 Smith St, Fayetteville, AR');
  assert.equal(body.notes, 'New owner-added clinic');

  // The row exists in DB with source='app' (owner-created, per §A amendment).
  const [row] = await db.select().from(vets).where(eq(vets.id, body.id)).limit(1);
  assert.ok(row);
  assert.equal(row.source, 'app');
  assert.equal(row.expiredAt, null);
});

test(
  'POST /vets — empty-string optional fields normalize to null (omitted from wire)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerVetsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'POST',
      url: '/vets',
      headers: { 'idempotency-key': `post-empties-${randomUUID()}` },
      payload: { name: 'Minimal Clinic', phone: '', email: '   ', address: null, notes: '' },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.name, 'Minimal Clinic');
    assert.equal('phone' in body, false, 'empty-string phone must not emit');
    assert.equal('email' in body, false, 'whitespace email must not emit');
    assert.equal('address' in body, false);
    assert.equal('notes' in body, false);
  },
);

test('POST /vets — missing Idempotency-Key returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerVetsRoute(app, { authenticate });

  const res = await app.inject({
    method: 'POST',
    url: '/vets',
    payload: { name: 'No Key Clinic' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'bad_request');
});

test(
  'POST /vets — replay with same key + same body returns the original response',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerVetsRoute(app, { authenticate });
    const idempotencyKey = `post-replay-${randomUUID()}`;
    // Run-unique name so a soft-expire-leaving accumulation from prior runs
    // (the contract DB is shared across `npm test` invocations; vets are
    // never hard-deleted by the API) can't collide with the count assertion.
    const uniqueName = `Replay Clinic ${randomUUID()}`;
    const payload = { name: uniqueName, phone: '111-222-3333' };

    const first = await app.inject({
      method: 'POST',
      url: '/vets',
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json() as { id: string };

    const replay = await app.inject({
      method: 'POST',
      url: '/vets',
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(replay.statusCode, 201);
    // Same id — proves the second call replayed the stored response rather
    // than re-INSERTing.
    assert.equal((replay.json() as { id: string }).id, firstBody.id);

    // Only one vet row should exist with this run-unique clinic name.
    const rows = await db.select().from(vets).where(eq(vets.name, uniqueName));
    assert.equal(rows.length, 1);
  },
);

test(
  'POST /vets — same key + different body returns 422 idempotency_mismatch',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerVetsRoute(app, { authenticate });
    const idempotencyKey = `post-mismatch-${randomUUID()}`;

    const first = await app.inject({
      method: 'POST',
      url: '/vets',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { name: 'Original Name' },
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: 'POST',
      url: '/vets',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { name: 'Different Name' },
    });
    assert.equal(second.statusCode, 422);
    assert.equal((second.json() as { error: { code: string } }).error.code, 'idempotency_mismatch');
  },
);

test(
  'POST /vets — staff can also create (route is [auth], not [staff]-only)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerVetsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'POST',
      url: '/vets',
      headers: { 'idempotency-key': `post-staff-${randomUUID()}` },
      payload: { name: 'Staff-Created Clinic' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal((res.json() as { name: string }).name, 'Staff-Created Clinic');
  },
);

test('POST /vets — missing name returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerVetsRoute(app, { authenticate });

  const res = await app.inject({
    method: 'POST',
    url: '/vets',
    headers: { 'idempotency-key': `post-noname-${randomUUID()}` },
    payload: { phone: '555-0000' },
  });
  assert.equal(res.statusCode, 400);
});

test(
  'GET /vets/:id — fixture vet returns 200 + Vet wire shape (snapshot byte-match)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerVetsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: `/vets/${FIXTURE_IDS.vetId}` });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), loadSnapshot('vet-by-id'));
  },
);

test('GET /vets/:id — unknown id returns 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerVetsRoute(app, { authenticate });

  const res = await app.inject({
    method: 'GET',
    url: '/vets/00000000-0000-4000-8000-000000000000',
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'not_found');
});

test('GET /vets/:id — non-UUID returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerVetsRoute(app, { authenticate });

  const res = await app.inject({ method: 'GET', url: '/vets/not-a-uuid' });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'bad_request');
});

test('PATCH /vets/:id — owner returns 403 forbidden ([staff]-only)', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerVetsRoute(app, { authenticate });

  const res = await app.inject({
    method: 'PATCH',
    url: `/vets/${FIXTURE_IDS.vetId}`,
    headers: { 'idempotency-key': `patch-owner-${randomUUID()}` },
    payload: { notes: 'should not stick' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'forbidden');
});

test(
  'PATCH /vets/:id — staff edits a posted vet; null clears optional fields',
  SKIP_WHEN_NO_DB,
  async () => {
    const { id } = await createTestVet({ name: `Patch Target ${randomUUID()}` });

    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerVetsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'PATCH',
      url: `/vets/${id}`,
      headers: { 'idempotency-key': `patch-staff-${randomUUID()}` },
      payload: { notes: 'updated by staff', phone: null },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.notes, 'updated by staff');
    assert.equal('phone' in body, false, 'null phone must clear and omit from wire');

    // audit_log captured the UPDATE under the staff actor.
    const log = await db.execute(
      sql`select op, actor from audit_log
          where table_name = 'vets' and row_pk = ${id}
          order by at desc limit 1`,
    );
    assert.ok(log.rows[0], 'PATCH must produce an audit_log row');
    assert.equal(String(log.rows[0].op), 'UPDATE');
    assert.equal(String(log.rows[0].actor), `staff:${FIXTURE_IDS.staffDonavanId}`);
  },
);

test(
  'PATCH /vets/:id — staff with empty body returns 400 (no updatable fields)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerVetsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'PATCH',
      url: `/vets/${FIXTURE_IDS.vetId}`,
      headers: { 'idempotency-key': `patch-empty-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  },
);

test('DELETE /vets/:id — owner returns 403 forbidden ([staff]-only)', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerVetsRoute(app, { authenticate });

  const res = await app.inject({
    method: 'DELETE',
    url: `/vets/${FIXTURE_IDS.vetId}`,
    headers: { 'idempotency-key': `del-owner-${randomUUID()}` },
  });
  assert.equal(res.statusCode, 403);
});

test(
  'DELETE /vets/:id — staff soft-expires an unreferenced vet; subsequent GET 404; audit_log records it',
  SKIP_WHEN_NO_DB,
  async () => {
    const { id } = await createTestVet({ name: `Delete Target ${randomUUID()}` });

    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerVetsRoute(app, { authenticate });

    const del = await app.inject({
      method: 'DELETE',
      url: `/vets/${id}`,
      headers: { 'idempotency-key': `del-staff-${randomUUID()}` },
    });
    assert.equal(del.statusCode, 204);
    assert.equal(del.body, '');

    // Row was soft-expired (NOT hard-deleted) — `expired_at` set, row still in DB.
    const [row] = await db.select().from(vets).where(eq(vets.id, id)).limit(1);
    assert.ok(row, 'DELETE must soft-expire, never hard-delete');
    assert.ok(row.expiredAt, 'expired_at must be set');

    // Subsequent GET returns 404 (live() filters soft-expired).
    const get = await app.inject({ method: 'GET', url: `/vets/${id}` });
    assert.equal(get.statusCode, 404);

    // audit_log captures the soft-expire under the staff actor.
    const log = await db.execute(
      sql`select op, actor from audit_log
          where table_name = 'vets' and row_pk = ${id}
          order by at desc limit 1`,
    );
    assert.ok(log.rows[0], 'DELETE must produce an audit_log row');
    assert.equal(String(log.rows[0].op), 'UPDATE');
    assert.equal(String(log.rows[0].actor), `staff:${FIXTURE_IDS.staffDonavanId}`);
  },
);

test(
  'DELETE /vets/:id — blocked with 409 conflict when a live dog references the vet',
  SKIP_WHEN_NO_DB,
  async () => {
    // The fixture vet is Waffles' primary_vet_id — must not soft-expire.
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerVetsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'DELETE',
      url: `/vets/${FIXTURE_IDS.vetId}`,
      headers: { 'idempotency-key': `del-conflict-${randomUUID()}` },
    });
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'conflict');

    // Vet still live — the conflict aborted the soft-expire txn.
    const [row] = await db.select().from(vets).where(eq(vets.id, FIXTURE_IDS.vetId)).limit(1);
    assert.ok(row);
    assert.equal(row.expiredAt, null);
  },
);

test('DELETE /vets/:id — non-existent id returns 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerVetsRoute(app, { authenticate });

  const res = await app.inject({
    method: 'DELETE',
    url: '/vets/00000000-0000-4000-8000-000000000000',
    headers: { 'idempotency-key': `del-missing-${randomUUID()}` },
  });
  assert.equal(res.statusCode, 404);
});

/**
 * Half-fix proof for the documented DELETE-vs-Day-9c-PATCH-/dogs race
 * (see `vetsRepository.findByIdForUpdate` doc + HANDOFF §4.4). Inside a
 * transaction that holds `FOR UPDATE` on a vet row, a concurrent
 * `SELECT ... FOR SHARE NOWAIT` from a second pool connection MUST fail
 * with Postgres' `55P03` (lock_not_available). That's the lock-semantics
 * proof the Day-9c PATCH /dogs `FOR SHARE` will rely on to serialize
 * against a concurrent DELETE.
 *
 * Two pool connections: Tx-A is `db.transaction(...)` (reserves one
 * connection); the inner `db.execute(...)` against the bare `db` pool
 * grabs a separate connection (Drizzle's `db` is the node-pg pool;
 * default pool size > 1). The `NOWAIT` clause makes the outer SELECT
 * fail immediately rather than wait, so the test is deterministic — no
 * timer races.
 */
class TxRollback extends Error {}

test(
  'vetsRepository.findByIdForUpdate holds FOR UPDATE; concurrent FOR SHARE NOWAIT fails with 55P03',
  SKIP_WHEN_NO_DB,
  async () => {
    const { id } = await createTestVet({ name: `Lock Test ${randomUUID()}` });

    let lockBlocked = false;
    let lockErrorCode: string | undefined;

    try {
      await db.transaction(async (txA) => {
        await txA.execute(sql`select set_config('app.actor', 'system:lock-test', true)`);
        const locked = await vetsRepository.findByIdForUpdate(id, txA);
        assert.ok(locked, 'findByIdForUpdate must return the live vet row');

        // Separate pool connection — db.execute(...) outside the txA
        // handle grabs a different pg connection from the pool.
        try {
          await db.execute(sql`select id from vets where id = ${id} for share nowait`);
        } catch (err) {
          lockBlocked = true;
          lockErrorCode = (err as { code?: string }).code;
        }

        // Rollback Tx-A — don't leave the vet row write-locked beyond
        // this test (also avoids any incidental writes).
        throw new TxRollback();
      });
    } catch (err) {
      if (!(err instanceof TxRollback)) throw err;
    }

    assert.equal(
      lockBlocked,
      true,
      'concurrent FOR SHARE NOWAIT must fail while FOR UPDATE is held',
    );
    assert.equal(
      lockErrorCode,
      '55P03',
      `expected lock_not_available (55P03), got: ${lockErrorCode}`,
    );
  },
);
