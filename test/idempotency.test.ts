import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { AuthError } from '../src/auth/errors.js';
import { db } from '../src/db/client.js';
import { withIdempotency } from '../src/db/idempotency.js';
import {
  IDEMPOTENCY_KEY_MAX_LEN,
  hashRequestBody,
  requireIdempotencyKey,
} from '../src/db/mutation.js';
import { idempotencyKeys } from '../src/db/schema/schema.js';

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
    (e) => e instanceof AuthError && e.code === 'bad_request' && e.status === 400,
  );
});

test('requireIdempotencyKey rejects empty string as 400', () => {
  assert.throws(
    () => requireIdempotencyKey(''),
    (e) => e instanceof AuthError && e.code === 'bad_request',
  );
});

test('requireIdempotencyKey rejects over-length keys as 400', () => {
  assert.throws(
    () => requireIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX_LEN + 1)),
    (e) => e instanceof AuthError && e.code === 'bad_request' && /exceeds/.test(e.message),
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
          (e) => e instanceof AuthError && e.code === 'idempotency_mismatch' && e.status === 422,
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
          (e) => e instanceof AuthError && e.code === 'idempotency_mismatch',
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
          (e) => e instanceof AuthError && e.code === 'idempotency_inflight' && e.status === 409,
        );
        assert.equal(fnRan, false, 'fn must not run when an in-flight conflict is detected');

        throw new Rollback();
      }),
      Rollback,
    );
  },
);
