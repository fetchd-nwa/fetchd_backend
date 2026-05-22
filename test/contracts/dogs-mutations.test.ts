import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dogs } from '../../src/db/schema/schema.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerVetsRoute } from '../../src/routes/vets.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day-9c contract tests for dog mutations: POST/PATCH/DELETE /dogs +
 * GET /dogs/:id. Exercises the full `withMutation` composition end-to-end
 * against real Postgres + Redis through the live Fastify request
 * lifecycle.
 *
 * Coverage:
 *  - POST 201 + assembled Dog wire shape; idempotency replay (same
 *    key+body); 422 on key+body-hash mismatch; 400 on missing header;
 *    400 on missing required fields (name/breed, neither birthdate nor
 *    age_months_override); 403 when staff attempts to create; 422 when
 *    primary_vet_id refers to a non-live vet.
 *  - GET /dogs/:id 200 + snapshot byte-match (fixture Waffles); 404
 *    unknown id; 404 to staff (consistent with GET /dogs returning [] to
 *    staff); 400 non-UUID.
 *  - PATCH 200 + assembled wire shape after edit; 403 to staff; 404 for
 *    unknown id; 400 empty body; 422 when reassigning to a non-live vet;
 *    null primary_vet_id clears the FK (vet omitted from wire);
 *    idempotency replay; audit_log captures the UPDATE under owner actor.
 *  - DELETE 204 + soft-expire visible in DB; 403 to staff; 404 unknown
 *    id; subsequent GET 404; audit_log captures the soft-expire.
 *  - **Cross-route race** between DELETE /vets and PATCH /dogs that
 *    reassigns to the same vet: exactly one rejects (the
 *    `findByIdForShare`/`findByIdForUpdate` lock pair serializes them).
 */

registerFixtureHooks();

/**
 * The default options every Day-9c contract test wires onto the dogs
 * route — the fixture clock so `age_months` is deterministic for
 * snapshot byte-match.
 */
function dogsOpts(authenticate: ReturnType<typeof makeContractApp>['authenticate']): {
  authenticate: typeof authenticate;
  now: typeof FIXTURE_NOW;
} {
  return { authenticate, now: FIXTURE_NOW };
}

/** A valid POST /dogs body with the minimum required fields. */
function postBaseBody(): Record<string, unknown> {
  return {
    name: 'Test Dog',
    breed: 'Border Collie',
    birthdate: '2023-06-15',
  };
}

/**
 * Insert a vet directly so the test owns its lifecycle (POST/PATCH/DELETE
 * tests need a vet they can reassign to or delete without touching the
 * fixture vet, which Waffles already references). Random name dodges the
 * cross-`npm test`-run accumulation hazard.
 */
async function createTestVet(): Promise<string> {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerVetsRoute(app, { authenticate });
  const res = await app.inject({
    method: 'POST',
    url: '/vets',
    headers: { 'idempotency-key': `setup-vet-${randomUUID()}` },
    payload: { name: `Day-9c Vet ${randomUUID()}` },
  });
  assert.equal(res.statusCode, 201, `setup vet POST failed: ${res.body}`);
  return (res.json() as { id: string }).id;
}

/**
 * Insert a dog directly via POST so each test owns its lifecycle for
 * PATCH/DELETE flows.
 */
async function createTestDog(
  extra: Record<string, unknown> = {},
): Promise<{ app: ReturnType<typeof makeContractApp>['app']; id: string }> {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));
  const res = await app.inject({
    method: 'POST',
    url: '/dogs',
    headers: { 'idempotency-key': `setup-dog-${randomUUID()}` },
    payload: { ...postBaseBody(), name: `Setup Dog ${randomUUID()}`, ...extra },
  });
  assert.equal(res.statusCode, 201, `setup dog POST failed: ${res.body}`);
  return { app, id: (res.json() as { id: string }).id };
}

// ──────────────────────────────────────────────────────────────────────────
// POST /dogs
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /dogs — owner creates returns 201 + assembled Dog wire shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));

    const res = await app.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `post-create-${randomUUID()}` },
      payload: {
        name: '  Rusty  ',
        breed: 'Mutt',
        birthdate: '2024-01-15',
        special_notes: 'Loves squeaky toys',
        evaluation_status: 'pending',
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json() as {
      id: string;
      name: string;
      breed: string;
      age_months: number;
      profile_image_path: string;
      vaccines: unknown[];
      medications: unknown[];
      feeding: { brand: string; amount: string; frequency: string; notes: null };
      special_notes: string;
      evaluation_status: string;
      vet?: unknown;
      completed_class_keys?: unknown;
    };
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.name, 'Rusty'); // server trims
    assert.equal(body.breed, 'Mutt');
    assert.equal(body.profile_image_path, ''); // Day-17 not wired yet → ''
    assert.deepStrictEqual(body.vaccines, []);
    assert.deepStrictEqual(body.medications, []);
    // No dog_feeding row yet → wire emits the empty-defaults feeding sub-shape.
    assert.deepStrictEqual(body.feeding, {
      brand: '',
      amount: '',
      frequency: '',
      notes: null,
    });
    assert.equal(body.special_notes, 'Loves squeaky toys');
    assert.equal(body.evaluation_status, 'pending');
    // vet + completed_class_keys + evaluation_date omitted on a fresh dog.
    assert.equal('vet' in body, false);
    assert.equal('completed_class_keys' in body, false);

    const [row] = await db.select().from(dogs).where(eq(dogs.id, body.id)).limit(1);
    assert.ok(row);
    assert.equal(row.ownerId, FIXTURE_IDS.ownerId);
    assert.equal(row.source, 'app');
    assert.equal(row.expiredAt, null);
  },
);

test(
  'POST /dogs — replay with same key + same body returns the original response',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));
    const idempotencyKey = `post-replay-${randomUUID()}`;
    const uniqueName = `Replay Dog ${randomUUID()}`;
    const payload = { ...postBaseBody(), name: uniqueName };

    const first = await app.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json() as { id: string };

    const replay = await app.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(replay.statusCode, 201);
    assert.equal((replay.json() as { id: string }).id, firstBody.id);

    const rows = await db.select().from(dogs).where(eq(dogs.name, uniqueName));
    assert.equal(rows.length, 1);
  },
);

test(
  'POST /dogs — same key + different body returns 422 idempotency_mismatch',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));
    const idempotencyKey = `post-mismatch-${randomUUID()}`;

    const first = await app.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { ...postBaseBody(), name: 'Original' },
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { ...postBaseBody(), name: 'Different' },
    });
    assert.equal(second.statusCode, 422);
    assert.equal((second.json() as { error: { code: string } }).error.code, 'idempotency_mismatch');
  },
);

test(
  'POST /dogs — staff returns 403 forbidden (owner-only mutation)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));

    const res = await app.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `post-staff-${randomUUID()}` },
      payload: postBaseBody(),
    });
    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'forbidden');
  },
);

test('POST /dogs — missing Idempotency-Key returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({ method: 'POST', url: '/dogs', payload: postBaseBody() });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'bad_request');
});

test('POST /dogs — missing name returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({
    method: 'POST',
    url: '/dogs',
    headers: { 'idempotency-key': `post-noname-${randomUUID()}` },
    payload: { breed: 'Mutt', birthdate: '2024-01-15' },
  });
  assert.equal(res.statusCode, 400);
});

test(
  'POST /dogs — neither birthdate nor age_months_override returns 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));

    const res = await app.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `post-noage-${randomUUID()}` },
      payload: { name: 'No Age', breed: 'Mutt' },
    });
    assert.equal(res.statusCode, 400);
  },
);

test(
  'POST /dogs — primary_vet_id referring to a non-live vet returns 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));

    const res = await app.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `post-badvet-${randomUUID()}` },
      payload: { ...postBaseBody(), primary_vet_id: '00000000-0000-4000-8000-000000000000' },
    });
    assert.equal(res.statusCode, 422);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_payload');
  },
);

test('POST /dogs — accepts age_months_override instead of birthdate', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({
    method: 'POST',
    url: '/dogs',
    headers: { 'idempotency-key': `post-override-${randomUUID()}` },
    payload: { name: 'Senior', breed: 'Beagle', age_months_override: 120 },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { age_months: number };
  assert.equal(body.age_months, 120);
});

// ──────────────────────────────────────────────────────────────────────────
// GET /dogs/:id
// ──────────────────────────────────────────────────────────────────────────

test(
  'GET /dogs/:id — fixture Waffles returns 200 + snapshot byte-match',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));

    const res = await app.inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog1Id}` });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), loadSnapshot('dog-by-id'));
  },
);

test('GET /dogs/:id — unknown id returns 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({
    method: 'GET',
    url: '/dogs/00000000-0000-4000-8000-000000000000',
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'not_found');
});

test(
  'GET /dogs/:id — staff returns 404 (consistent with GET /dogs to staff)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));

    const res = await app.inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog1Id}` });
    assert.equal(res.statusCode, 404);
  },
);

test('GET /dogs/:id — non-UUID returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({ method: 'GET', url: '/dogs/not-a-uuid' });
  assert.equal(res.statusCode, 400);
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /dogs/:id
// ──────────────────────────────────────────────────────────────────────────

test(
  'PATCH /dogs/:id — owner edits own dog returns 200 + updated wire shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const { id } = await createTestDog();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));

    const res = await app.inject({
      method: 'PATCH',
      url: `/dogs/${id}`,
      headers: { 'idempotency-key': `patch-edit-${randomUUID()}` },
      payload: { breed: 'Australian Shepherd', special_notes: 'Updated notes' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { breed: string; special_notes: string };
    assert.equal(body.breed, 'Australian Shepherd');
    assert.equal(body.special_notes, 'Updated notes');

    // audit_log captures the UPDATE under the owner actor.
    const log = await db.execute(
      sql`select op, actor from audit_log
        where table_name = 'dogs' and row_pk = ${id}
        order by at desc limit 1`,
    );
    assert.ok(log.rows[0], 'PATCH must produce an audit_log row');
    assert.equal(String(log.rows[0].op), 'UPDATE');
    assert.equal(String(log.rows[0].actor), `owner:${FIXTURE_IDS.ownerId}`);
  },
);

test(
  'PATCH /dogs/:id — primary_vet_id null clears the FK (vet omitted from wire)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));

    // Waffles starts with primary_vet_id = fixture vet. Clear it.
    const res = await app.inject({
      method: 'PATCH',
      url: `/dogs/${FIXTURE_IDS.dog1Id}`,
      headers: { 'idempotency-key': `patch-clearvet-${randomUUID()}` },
      payload: { primary_vet_id: null },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.equal('vet' in body, false, 'null primary_vet_id must clear vet from wire');
  },
);

test('PATCH /dogs/:id — staff returns 403 forbidden', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({
    method: 'PATCH',
    url: `/dogs/${FIXTURE_IDS.dog1Id}`,
    headers: { 'idempotency-key': `patch-staff-${randomUUID()}` },
    payload: { breed: 'should not stick' },
  });
  assert.equal(res.statusCode, 403);
});

test('PATCH /dogs/:id — unknown id returns 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({
    method: 'PATCH',
    url: '/dogs/00000000-0000-4000-8000-000000000000',
    headers: { 'idempotency-key': `patch-miss-${randomUUID()}` },
    payload: { breed: 'whatever' },
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH /dogs/:id — empty body returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({
    method: 'PATCH',
    url: `/dogs/${FIXTURE_IDS.dog1Id}`,
    headers: { 'idempotency-key': `patch-empty-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH /dogs/:id — reassigning to a non-live vet returns 422', SKIP_WHEN_NO_DB, async () => {
  const { id } = await createTestDog();
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({
    method: 'PATCH',
    url: `/dogs/${id}`,
    headers: { 'idempotency-key': `patch-badvet-${randomUUID()}` },
    payload: { primary_vet_id: '00000000-0000-4000-8000-000000000000' },
  });
  assert.equal(res.statusCode, 422);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_payload');
});

test(
  'PATCH /dogs/:id — replay with same key + same body returns original response',
  SKIP_WHEN_NO_DB,
  async () => {
    const { id } = await createTestDog();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));
    const idempotencyKey = `patch-replay-${randomUUID()}`;
    const payload = { breed: 'Cattle Dog' };

    const first = await app.inject({
      method: 'PATCH',
      url: `/dogs/${id}`,
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(first.statusCode, 200);

    const replay = await app.inject({
      method: 'PATCH',
      url: `/dogs/${id}`,
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(replay.statusCode, 200);
    assert.deepStrictEqual(replay.json(), first.json());
  },
);

// ──────────────────────────────────────────────────────────────────────────
// DELETE /dogs/:id
// ──────────────────────────────────────────────────────────────────────────

test(
  'DELETE /dogs/:id — owner soft-expires; subsequent GET 404; audit_log records it',
  SKIP_WHEN_NO_DB,
  async () => {
    const { id } = await createTestDog();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, dogsOpts(authenticate));

    const del = await app.inject({
      method: 'DELETE',
      url: `/dogs/${id}`,
      headers: { 'idempotency-key': `del-${randomUUID()}` },
    });
    assert.equal(del.statusCode, 204);
    assert.equal(del.body, '');

    // Soft-expired (not hard-deleted) — row still in DB, expired_at set.
    const [row] = await db.select().from(dogs).where(eq(dogs.id, id)).limit(1);
    assert.ok(row, 'DELETE must soft-expire, never hard-delete');
    assert.ok(row.expiredAt, 'expired_at must be set');

    const get = await app.inject({ method: 'GET', url: `/dogs/${id}` });
    assert.equal(get.statusCode, 404);

    const log = await db.execute(
      sql`select op, actor from audit_log
        where table_name = 'dogs' and row_pk = ${id}
        order by at desc limit 1`,
    );
    assert.ok(log.rows[0], 'DELETE must produce an audit_log row');
    assert.equal(String(log.rows[0].op), 'UPDATE');
    assert.equal(String(log.rows[0].actor), `owner:${FIXTURE_IDS.ownerId}`);
  },
);

test('DELETE /dogs/:id — staff returns 403 forbidden', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({
    method: 'DELETE',
    url: `/dogs/${FIXTURE_IDS.dog1Id}`,
    headers: { 'idempotency-key': `del-staff-${randomUUID()}` },
  });
  assert.equal(res.statusCode, 403);
});

test('DELETE /dogs/:id — unknown id returns 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, dogsOpts(authenticate));

  const res = await app.inject({
    method: 'DELETE',
    url: '/dogs/00000000-0000-4000-8000-000000000000',
    headers: { 'idempotency-key': `del-miss-${randomUUID()}` },
  });
  assert.equal(res.statusCode, 404);
});

// ──────────────────────────────────────────────────────────────────────────
// Cross-route race: DELETE /vets/:id vs PATCH /dogs/:id { primary_vet_id }
// ──────────────────────────────────────────────────────────────────────────

/**
 * The closure proof for the DELETE-vs-PATCH-/dogs race. Day-9b shipped the
 * `FOR UPDATE` half on the vets side (`vetsRepository.findByIdForUpdate`);
 * Day-9c lands the matching `FOR SHARE` on the dogs side
 * (`vetsRepository.findByIdForShare`, called by PATCH/POST /dogs on the
 * reassign branch). Together they serialize: a concurrent DELETE /vets/:id
 * and PATCH /dogs/:id { primary_vet_id: <same vet> } MUST settle with
 * exactly one success and one rejection.
 *
 *   - DELETE wins first: PATCH's FOR SHARE blocks; DELETE commits the
 *     soft-expire; PATCH unblocks, FOR SHARE filter sees `live() = false`
 *     → undefined → 422 invalid_payload.
 *   - PATCH wins first: DELETE's FOR UPDATE blocks; PATCH commits with
 *     the new primary_vet_id; DELETE unblocks, `hasLiveDogReferences`
 *     returns true → 409 conflict.
 *
 * Either outcome is correct — the test asserts exactly one of the two
 * responses succeeded and the other carries one of the expected error
 * codes. Both routes run through the live Fastify pipeline against real
 * Postgres; the node-pg pool (default size 10) gives each app.inject the
 * separate connection it needs for the race to be real.
 */
test(
  'DELETE /vets vs PATCH /dogs { primary_vet_id } — exactly one rejects (FOR UPDATE × FOR SHARE serialize)',
  SKIP_WHEN_NO_DB,
  async () => {
    const vetId = await createTestVet();
    const { id: dogId } = await createTestDog();

    const ownerApp = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(ownerApp.app, dogsOpts(ownerApp.authenticate));

    const staffApp = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerVetsRoute(staffApp.app, { authenticate: staffApp.authenticate });

    const [patchSettled, deleteSettled] = await Promise.allSettled([
      ownerApp.app.inject({
        method: 'PATCH',
        url: `/dogs/${dogId}`,
        headers: { 'idempotency-key': `race-patch-${randomUUID()}` },
        payload: { primary_vet_id: vetId },
      }),
      staffApp.app.inject({
        method: 'DELETE',
        url: `/vets/${vetId}`,
        headers: { 'idempotency-key': `race-del-${randomUUID()}` },
      }),
    ]);

    assert.equal(patchSettled.status, 'fulfilled', 'PATCH inject must not throw');
    assert.equal(deleteSettled.status, 'fulfilled', 'DELETE inject must not throw');
    if (patchSettled.status !== 'fulfilled' || deleteSettled.status !== 'fulfilled') return;

    const patch = patchSettled.value;
    const del = deleteSettled.value;

    const patchOk = patch.statusCode === 200;
    const delOk = del.statusCode === 204;
    assert.equal(
      patchOk !== delOk,
      true,
      `expected exactly one success; got PATCH=${patch.statusCode} DELETE=${del.statusCode}`,
    );

    if (patchOk) {
      // PATCH won → DELETE blocked on hasLiveDogReferences → 409 conflict.
      assert.equal(del.statusCode, 409, `DELETE must 409 when PATCH wins; got ${del.body}`);
      assert.equal((del.json() as { error: { code: string } }).error.code, 'conflict');
    } else {
      // DELETE won → PATCH saw a soft-expired vet → 422 invalid_payload.
      assert.equal(patch.statusCode, 422, `PATCH must 422 when DELETE wins; got ${patch.body}`);
      assert.equal((patch.json() as { error: { code: string } }).error.code, 'invalid_payload');
    }
  },
);
