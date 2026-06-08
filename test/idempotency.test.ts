import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../src/lib/errors.js';
import { registerAuth } from '../src/auth/plugin.js';
import type { Principal } from '../src/auth/principal.js';
import { db } from '../src/db/client.js';
import { withIdempotency } from '../src/db/idempotency.js';
import {
  IDEMPOTENCY_KEY_MAX_LEN,
  hashRequestBody,
  requireIdempotencyKey,
} from '../src/db/mutation.js';
import { idempotencyKeys, owners } from '../src/db/schema/schema.js';
import { withActor } from '../src/db/tx.js';
import { closeRedis } from '../src/redis.js';
import { registerMeRoute } from '../src/routes/me.js';

// mutation.ts indirectly opens a redis socket (via lib/cache.ts) so this
// subprocess's event loop needs an explicit close to drain — see the matching
// hook in test/contracts/_harness.ts for the contract test files.
after(async () => {
  await closeRedis();
});

// --- hashRequestBody: canonical-JSON SHA so a key reused with the same logical
// body — even with reordered object keys — collides correctly, but any real
// payload change is detected as a mismatch. ---

test('hashRequestBody is stable across object-key reorderings', () => {
  const a = hashRequestBody({ a: 1, b: { x: 10, y: 20 }, c: [1, 2, 3] });
  const b = hashRequestBody({ c: [1, 2, 3], b: { y: 20, x: 10 }, a: 1 });
  assert.equal(a, b);
});

test('hashRequestBody distinguishes nested value differences', () => {
  const a = hashRequestBody({ a: 1, b: { x: 10 } });
  const b = hashRequestBody({ a: 1, b: { x: 11 } });
  assert.notEqual(a, b);
});

test('hashRequestBody distinguishes array element order', () => {
  // Arrays are positional: [1,2] !== [2,1]. (Object keys are unordered, arrays
  // are not. This is deliberate per JSON semantics.)
  const a = hashRequestBody({ items: [1, 2] });
  const b = hashRequestBody({ items: [2, 1] });
  assert.notEqual(a, b);
});

// --- requireIdempotencyKey: the header guard. Missing / empty / too-long →
// 400. Multi-value (a quirk of Node's IncomingHttpHeaders for some headers)
// resolves to the first value, consistent with Fastify's defaults. ---

test('requireIdempotencyKey accepts a non-empty string', () => {
  assert.equal(requireIdempotencyKey('idem-123'), 'idem-123');
});

test('requireIdempotencyKey rejects undefined as 400 bad_request', () => {
  assert.throws(
    () => requireIdempotencyKey(undefined),
    (e) => e instanceof ApiError && e.code === 'bad_request' && e.status === 400,
  );
});

test('requireIdempotencyKey rejects empty string as 400', () => {
  assert.throws(
    () => requireIdempotencyKey(''),
    (e) => e instanceof ApiError && e.code === 'bad_request',
  );
});

test('requireIdempotencyKey rejects over-length keys as 400', () => {
  assert.throws(
    () => requireIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX_LEN + 1)),
    (e) => e instanceof ApiError && e.code === 'bad_request' && /exceeds/.test(e.message),
  );
});

test('requireIdempotencyKey unwraps the first element of a multi-value header', () => {
  assert.equal(requireIdempotencyKey(['first-key', 'second-key']), 'first-key');
});

// --- withIdempotency: the wrapper's three states, all exercised against the
// real `idempotency_keys` table and rolled back via a sentinel (zero net
// writes). The first-arrival + replay path is Day 3 Exit check #2. DB-gated. ---

const dbConfigured = typeof process.env.DATABASE_URL === 'string';

test(
  'withIdempotency: first arrival runs fn, second arrival with same key replays without re-executing',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class Rollback extends Error {}
    const key = `test-${randomUUID()}`;
    const claim = {
      key,
      ownerId: null,
      endpoint: 'PATCH /me',
      requestHash: 'r1',
    };
    let fnCalls = 0;

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.actor', 'system:test', true)`);

        const first = await withIdempotency(tx, claim, async () => {
          fnCalls += 1;
          return { status: 200, body: { greeting: 'hello', n: 1 } };
        });
        assert.equal(first.replayed, false);
        assert.equal(first.status, 200);
        assert.deepEqual(first.body, { greeting: 'hello', n: 1 });
        assert.equal(fnCalls, 1);

        // Second call, same claim. The wrapper sees the completed row and
        // replays — fn must NOT run again (idempotency would be broken).
        const second = await withIdempotency(tx, claim, async () => {
          fnCalls += 1;
          return { status: 500, body: { greeting: 'WRONG' } };
        });
        assert.equal(second.replayed, true);
        assert.equal(second.status, 200);
        assert.deepEqual(second.body, { greeting: 'hello', n: 1 });
        assert.equal(fnCalls, 1, 'fn should not run on replay');

        // The stored response matches what the first call produced.
        const [row] = await tx
          .select()
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, key))
          .limit(1);
        assert.ok(row);
        assert.equal(row.responseStatus, 200);
        assert.deepEqual(row.responseBody, { greeting: 'hello', n: 1 });
        assert.ok(row.completedAt, 'completed_at must be set after success');
        assert.equal(row.endpoint, 'PATCH /me');
        assert.equal(row.requestHash, 'r1');

        throw new Rollback();
      }),
      Rollback,
    );
  },
);

test(
  'withIdempotency: a completed key reused with a different endpoint → 422 idempotency_mismatch',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class Rollback extends Error {}
    const key = `test-${randomUUID()}`;

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.actor', 'system:test', true)`);

        // First completion on endpoint A
        await withIdempotency(
          tx,
          { key, ownerId: null, endpoint: 'POST /a', requestHash: 'rh' },
          async () => ({ status: 200, body: { ok: 'a' } }),
        );

        // Same key, different endpoint → mismatch
        await assert.rejects(
          withIdempotency(
            tx,
            { key, ownerId: null, endpoint: 'POST /b', requestHash: 'rh' },
            async () => ({ status: 200, body: { ok: 'b' } }),
          ),
          (e) => e instanceof ApiError && e.code === 'idempotency_mismatch' && e.status === 422,
        );

        throw new Rollback();
      }),
      Rollback,
    );
  },
);

test(
  'withIdempotency: a completed key reused with a different request_hash → 422 idempotency_mismatch',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class Rollback extends Error {}
    const key = `test-${randomUUID()}`;

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.actor', 'system:test', true)`);

        await withIdempotency(
          tx,
          { key, ownerId: null, endpoint: 'POST /x', requestHash: 'hash-A' },
          async () => ({ status: 200, body: { ok: true } }),
        );

        await assert.rejects(
          withIdempotency(
            tx,
            { key, ownerId: null, endpoint: 'POST /x', requestHash: 'hash-B' },
            async () => ({ status: 200, body: { ok: true } }),
          ),
          (e) => e instanceof ApiError && e.code === 'idempotency_mismatch',
        );

        throw new Rollback();
      }),
      Rollback,
    );
  },
);

test(
  'withIdempotency: an in-flight key (existing row, completed_at NULL) → 409 idempotency_inflight',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class Rollback extends Error {}
    const key = `test-${randomUUID()}`;

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.actor', 'system:test', true)`);

        // Simulate another connection holding this key in-flight: insert the
        // row directly without `withIdempotency` so `completed_at` stays NULL.
        await tx.insert(idempotencyKeys).values({
          key,
          ownerId: null,
          endpoint: 'POST /me',
          requestHash: 'r',
        });

        // The wrapper's INSERT-on-conflict-do-nothing finds the row, falls
        // through to re-select, sees completed_at IS NULL, throws 409.
        let fnRan = false;
        await assert.rejects(
          withIdempotency(
            tx,
            { key, ownerId: null, endpoint: 'POST /me', requestHash: 'r' },
            async () => {
              fnRan = true;
              return { status: 200, body: {} };
            },
          ),
          (e) => e instanceof ApiError && e.code === 'idempotency_inflight' && e.status === 409,
        );
        assert.equal(fnRan, false, 'fn must not run when an in-flight conflict is detected');

        throw new Rollback();
      }),
      Rollback,
    );
  },
);

// --- Error-rollback property: when `fn` throws inside `withIdempotency`, the
// throw propagates out, the surrounding transaction aborts, and the
// `idempotency_keys` row that the wrapper INSERTed as part of its atomic claim
// rolls back with everything else. This is the "errors are retry-friendly"
// guarantee documented in `idempotency.ts` — a retry from the client sees a
// clean slate, not a poisoned in-flight key. The post-rollback SELECT runs on
// the live DB (the failed tx is gone), so its result reflects committed state
// only — zero net writes if the property holds. ---

test(
  'withIdempotency: when fn throws, the idempotency_keys row rolls back with the transaction',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class FnError extends Error {}
    const key = `test-rollback-${randomUUID()}`;

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.actor', 'system:test', true)`);
        await withIdempotency(
          tx,
          { key, ownerId: null, endpoint: 'POST /rollback-test', requestHash: 'h' },
          async () => {
            throw new FnError('simulated mutation failure');
          },
        );
        // unreachable — the throw above aborts the transaction.
      }),
      FnError,
    );

    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);
    assert.equal(
      row,
      undefined,
      'a thrown fn must roll the idempotency_keys INSERT back so a retry is unblocked',
    );
  },
);

// --- End-to-end "proves the wire": Fastify inject through PATCH /me. Exercises
// the full request path — header parsing → body validation → withMutation →
// audited DB write → response shape — that the unit tests don't reach. Cannot
// use the rollback-sentinel pattern: Fastify inject runs on a separate pool
// connection from any outer test transaction (uncommitted writes are
// invisible across connections), so the test owner is committed and torn down
// with a soft-expire — correct per the never-delete contract. The cleanup
// leaves 2 audit_log rows behind (the PATCH + the cleanup soft-expire),
// which is the designed behavior of audit_log (append-only historical record).
// The idempotency_keys row IS deletable (transport-layer, exempt from
// never-delete) and is cleaned up. ---

test(
  'PATCH /me end-to-end: Fastify inject → withMutation → audited write → response shape',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    const supabaseUid = randomUUID();
    const [created] = await db
      .insert(owners)
      .values({
        supabaseUid,
        name: 'E2E Test',
        email: `e2e-${supabaseUid}@example.com`,
        phone: '000',
        location: 'fayetteville',
      })
      .returning();
    assert.ok(created);

    const idemKey = `e2e-${randomUUID()}`;
    const principal: Principal = {
      kind: 'owner',
      ownerId: created.id,
      supabaseUid,
    };

    try {
      const app = Fastify();
      registerAuth(app);
      registerMeRoute(app, {
        authenticate: async (request) => {
          request.principal = principal;
        },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: { 'idempotency-key': idemKey },
        payload: { phone: '555-1234' },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        id: string;
        name: string;
        phone: string;
        email: string;
      };
      assert.equal(body.id, created.id);
      assert.equal(body.name, 'E2E Test');
      assert.equal(body.phone, '555-1234');

      const [idemRow] = await db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, idemKey))
        .limit(1);
      assert.ok(idemRow, 'idempotency_keys row must be persisted on success');
      assert.equal(idemRow.endpoint, 'PATCH /me');
      assert.equal(idemRow.responseStatus, 200);
      assert.equal(idemRow.ownerId, created.id);
      assert.ok(idemRow.completedAt, 'completedAt must be set after success');
      assert.equal((idemRow.responseBody as { phone: string }).phone, '555-1234');

      const log = await db.execute(
        sql`select op, actor from audit_log
            where table_name = 'owners' and row_pk = ${created.id}
            order by at desc limit 1`,
      );
      const auditRow = log.rows[0];
      assert.ok(auditRow, 'PATCH must produce an audit_log row');
      assert.equal(String(auditRow.op), 'UPDATE');
      assert.equal(String(auditRow.actor), `owner:${created.id}`);
    } finally {
      await withActor('system:e2e-cleanup', async (tx) => {
        await tx
          .update(owners)
          .set({ expiredAt: sql`now()` })
          .where(eq(owners.id, created.id));
      });
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, idemKey));
    }
  },
);
