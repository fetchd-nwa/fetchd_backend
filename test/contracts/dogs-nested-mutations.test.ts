import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dogFeeding, dogMedications, dogVaccines } from '../../src/db/schema/schema.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day-9d contract tests for the nested-resource dog mutations:
 * POST/PATCH/DELETE /dogs/:id/vaccines + same on /medications +
 * PUT /dogs/:id/feeding.
 *
 * Coverage:
 *  - Vaccines: POST happy + new VaccineWire shape (id required,
 *    requirement_key? optional, omit-on-null); POST without
 *    requirement_key (wire omits); POST with non-live requirement_key
 *    → 422; POST replay; POST staff → 403; POST on unknown dog →
 *    404; POST missing Idempotency-Key → 400; PATCH happy + audit
 *    under owner actor; PATCH null clears requirement_key from wire;
 *    PATCH parent-child mismatch (vid belongs to a different dog) →
 *    404; PATCH bad requirement_key → 422; PATCH empty body → 400;
 *    DELETE happy + soft-expire + audit; DELETE staff → 403; DELETE
 *    parent-child mismatch → 404.
 *  - Medications: POST happy + MedicationWire; POST replay; POST
 *    staff → 403; POST on unknown dog → 404; PATCH happy + audit;
 *    PATCH parent-child mismatch → 404; PATCH empty body → 400;
 *    DELETE happy + soft-expire + audit.
 *  - Feeding (PUT): PUT creates a new feeding row for a dog with
 *    none (Lola); PUT replaces an existing feeding row (Waffles);
 *    PUT replay; PUT staff → 403; PUT on unknown dog → 404; PUT
 *    notes empty-string normalizes to null on wire; PUT missing
 *    required field → 400; **PUT RELINK round-trip** — soft-expire
 *    a feeding row directly in DB, PUT again, assert response
 *    carries the new values + DB row has `expired_at IS NULL` +
 *    audit_log captures the UPDATE.
 */

registerFixtureHooks();

function dogsOpts(authenticate: ReturnType<typeof makeContractApp>['authenticate']): {
  authenticate: typeof authenticate;
  now: typeof FIXTURE_NOW;
} {
  return { authenticate, now: FIXTURE_NOW };
}

function appAsOwner(): ReturnType<typeof makeContractApp> {
  const ctx = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(ctx.app, dogsOpts(ctx.authenticate));
  return ctx;
}

function appAsStaff(): ReturnType<typeof makeContractApp> {
  const ctx = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerDogsRoute(ctx.app, dogsOpts(ctx.authenticate));
  return ctx;
}

/** Create a fresh test dog so the test's lifecycle is self-contained. */
async function createTestDog(): Promise<string> {
  const { app } = appAsOwner();
  const res = await app.inject({
    method: 'POST',
    url: '/dogs',
    headers: { 'idempotency-key': `nested-setup-${randomUUID()}` },
    payload: { name: `Setup ${randomUUID()}`, breed: 'Mix', birthdate: '2024-01-01' },
  });
  assert.equal(res.statusCode, 201, `setup dog failed: ${res.body}`);
  return (res.json() as { id: string }).id;
}

// ──────────────────────────────────────────────────────────────────────────
// POST /dogs/:id/vaccines
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /dogs/:id/vaccines — owner creates returns 201 + new VaccineWire shape (id + requirement_key)',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    const { app } = appAsOwner();

    const res = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/vaccines`,
      headers: { 'idempotency-key': `vacc-post-${randomUUID()}` },
      payload: {
        name: 'Rabies',
        expires_at: '2027-09-01',
        requirement_key: FIXTURE_IDS.requiredVaccineRabiesKey,
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json() as {
      id: string;
      name: string;
      expires_at: string;
      requirement_key?: string;
    };
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.name, 'Rabies');
    assert.equal(body.expires_at, '2027-09-01');
    assert.equal(body.requirement_key, FIXTURE_IDS.requiredVaccineRabiesKey);

    const [row] = await db.select().from(dogVaccines).where(eq(dogVaccines.id, body.id)).limit(1);
    assert.ok(row);
    assert.equal(row.dogId, dogId);
    assert.equal(row.expiredAt, null);
  },
);

test(
  'POST /dogs/:id/vaccines — without requirement_key, wire omits the key (omit-on-null)',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    const { app } = appAsOwner();

    const res = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/vaccines`,
      headers: { 'idempotency-key': `vacc-noreq-${randomUUID()}` },
      payload: { name: 'Lyme', expires_at: '2027-01-01' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as Record<string, unknown>;
    assert.equal('requirement_key' in body, false, 'null requirement_key must omit from wire');
  },
);

test(
  'POST /dogs/:id/vaccines — non-live requirement_key returns 422 invalid_payload',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    const { app } = appAsOwner();

    const res = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/vaccines`,
      headers: { 'idempotency-key': `vacc-badreq-${randomUUID()}` },
      payload: { name: 'Test', expires_at: '2027-01-01', requirement_key: 'no-such-key' },
    });
    assert.equal(res.statusCode, 422);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_payload');
  },
);

test(
  'POST /dogs/:id/vaccines — replay with same key + body returns the original response',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    const { app } = appAsOwner();
    const idempotencyKey = `vacc-replay-${randomUUID()}`;
    const payload = { name: 'Bordetella', expires_at: '2026-10-01' };

    const first = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/vaccines`,
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(first.statusCode, 201);
    const firstId = (first.json() as { id: string }).id;

    const replay = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/vaccines`,
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(replay.statusCode, 201);
    assert.equal((replay.json() as { id: string }).id, firstId);
  },
);

test('POST /dogs/:id/vaccines — staff returns 403 forbidden', SKIP_WHEN_NO_DB, async () => {
  const { app } = appAsStaff();
  const res = await app.inject({
    method: 'POST',
    url: `/dogs/${FIXTURE_IDS.dog1Id}/vaccines`,
    headers: { 'idempotency-key': `vacc-staff-${randomUUID()}` },
    payload: { name: 'X', expires_at: '2027-01-01' },
  });
  assert.equal(res.statusCode, 403);
});

test('POST /dogs/:id/vaccines — unknown dog returns 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = appAsOwner();
  const res = await app.inject({
    method: 'POST',
    url: '/dogs/00000000-0000-4000-8000-000000000000/vaccines',
    headers: { 'idempotency-key': `vacc-nodog-${randomUUID()}` },
    payload: { name: 'X', expires_at: '2027-01-01' },
  });
  assert.equal(res.statusCode, 404);
});

test('POST /dogs/:id/vaccines — missing Idempotency-Key returns 400', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createTestDog();
  const { app } = appAsOwner();
  const res = await app.inject({
    method: 'POST',
    url: `/dogs/${dogId}/vaccines`,
    payload: { name: 'X', expires_at: '2027-01-01' },
  });
  assert.equal(res.statusCode, 400);
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /dogs/:id/vaccines/:vid
// ──────────────────────────────────────────────────────────────────────────

test(
  'PATCH /dogs/:id/vaccines/:vid — owner edits, audit_log captures UPDATE under owner actor',
  SKIP_WHEN_NO_DB,
  async () => {
    // Use the fixture's Waffles + vaccine1 (Rabies) so the audit row is on
    // a row we can identify cleanly. The test owns the cleanup via the
    // fixture re-seed.
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'PATCH',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/vaccines/${FIXTURE_IDS.vaccine1Id}`,
      headers: { 'idempotency-key': `vacc-patch-${randomUUID()}` },
      payload: { expires_at: '2028-01-01' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; expires_at: string };
    assert.equal(body.id, FIXTURE_IDS.vaccine1Id);
    assert.equal(body.expires_at, '2028-01-01');

    const log = await db.execute(
      sql`select op, actor from audit_log
          where table_name = 'dog_vaccines' and row_pk = ${FIXTURE_IDS.vaccine1Id}
          order by at desc limit 1`,
    );
    assert.ok(log.rows[0]);
    assert.equal(String(log.rows[0].op), 'UPDATE');
    assert.equal(String(log.rows[0].actor), `owner:${FIXTURE_IDS.ownerId}`);
  },
);

test(
  'PATCH /dogs/:id/vaccines/:vid — null requirement_key clears it from the wire',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'PATCH',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/vaccines/${FIXTURE_IDS.vaccine2Id}`,
      headers: { 'idempotency-key': `vacc-clearreq-${randomUUID()}` },
      payload: { requirement_key: null },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.equal('requirement_key' in body, false);
  },
);

test(
  'PATCH /dogs/:id/vaccines/:vid — vid belongs to a different dog returns 404',
  SKIP_WHEN_NO_DB,
  async () => {
    // vaccine3 belongs to Lola (dog2). PATCH-ing it via Waffles' dog id
    // must 404 — the parent-child guard rejects the mismatch.
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'PATCH',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/vaccines/${FIXTURE_IDS.vaccine3Id}`,
      headers: { 'idempotency-key': `vacc-parentmismatch-${randomUUID()}` },
      payload: { expires_at: '2028-01-01' },
    });
    assert.equal(res.statusCode, 404);
  },
);

test(
  'PATCH /dogs/:id/vaccines/:vid — bad requirement_key returns 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'PATCH',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/vaccines/${FIXTURE_IDS.vaccine1Id}`,
      headers: { 'idempotency-key': `vacc-patchbadreq-${randomUUID()}` },
      payload: { requirement_key: 'no-such-key' },
    });
    assert.equal(res.statusCode, 422);
  },
);

test('PATCH /dogs/:id/vaccines/:vid — empty body returns 400', SKIP_WHEN_NO_DB, async () => {
  const { app } = appAsOwner();
  const res = await app.inject({
    method: 'PATCH',
    url: `/dogs/${FIXTURE_IDS.dog1Id}/vaccines/${FIXTURE_IDS.vaccine1Id}`,
    headers: { 'idempotency-key': `vacc-empty-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

// ──────────────────────────────────────────────────────────────────────────
// DELETE /dogs/:id/vaccines/:vid
// ──────────────────────────────────────────────────────────────────────────

test(
  'DELETE /dogs/:id/vaccines/:vid — owner soft-expires + audit_log captures UPDATE',
  SKIP_WHEN_NO_DB,
  async () => {
    // Use a freshly-created vaccine so the test doesn't impact other tests
    // depending on fixture vaccines.
    const dogId = await createTestDog();
    const { app } = appAsOwner();
    const post = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/vaccines`,
      headers: { 'idempotency-key': `vacc-del-setup-${randomUUID()}` },
      payload: { name: 'DeleteMe', expires_at: '2027-01-01' },
    });
    assert.equal(post.statusCode, 201);
    const vid = (post.json() as { id: string }).id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/dogs/${dogId}/vaccines/${vid}`,
      headers: { 'idempotency-key': `vacc-del-${randomUUID()}` },
    });
    assert.equal(del.statusCode, 204);
    assert.equal(del.body, '');

    const [row] = await db.select().from(dogVaccines).where(eq(dogVaccines.id, vid)).limit(1);
    assert.ok(row, 'DELETE must soft-expire, never hard-delete');
    assert.ok(row.expiredAt);

    const log = await db.execute(
      sql`select op, actor from audit_log
          where table_name = 'dog_vaccines' and row_pk = ${vid}
          order by at desc limit 1`,
    );
    assert.ok(log.rows[0]);
    assert.equal(String(log.rows[0].op), 'UPDATE');
    assert.equal(String(log.rows[0].actor), `owner:${FIXTURE_IDS.ownerId}`);
  },
);

test('DELETE /dogs/:id/vaccines/:vid — staff returns 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = appAsStaff();
  const res = await app.inject({
    method: 'DELETE',
    url: `/dogs/${FIXTURE_IDS.dog1Id}/vaccines/${FIXTURE_IDS.vaccine1Id}`,
    headers: { 'idempotency-key': `vacc-del-staff-${randomUUID()}` },
  });
  assert.equal(res.statusCode, 403);
});

test(
  'DELETE /dogs/:id/vaccines/:vid — parent-child mismatch returns 404',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'DELETE',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/vaccines/${FIXTURE_IDS.vaccine3Id}`,
      headers: { 'idempotency-key': `vacc-del-mismatch-${randomUUID()}` },
    });
    assert.equal(res.statusCode, 404);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST/PATCH/DELETE /dogs/:id/medications
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /dogs/:id/medications — owner creates returns 201 + MedicationWire',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/medications`,
      headers: { 'idempotency-key': `med-post-${randomUUID()}` },
      payload: { name: 'Carprofen', dose: '50 mg', frequency: 'twice daily' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as { id: string; name: string; dose: string; frequency: string };
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.name, 'Carprofen');
    assert.equal(body.dose, '50 mg');
    assert.equal(body.frequency, 'twice daily');
  },
);

test(
  'POST /dogs/:id/medications — replay returns the original response',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    const { app } = appAsOwner();
    const idempotencyKey = `med-replay-${randomUUID()}`;
    const payload = { name: 'Trazodone', dose: '50 mg', frequency: 'as needed' };

    const first = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/medications`,
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(first.statusCode, 201);

    const replay = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/medications`,
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    assert.equal(replay.statusCode, 201);
    assert.deepStrictEqual(replay.json(), first.json());
  },
);

test('POST /dogs/:id/medications — staff returns 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = appAsStaff();
  const res = await app.inject({
    method: 'POST',
    url: `/dogs/${FIXTURE_IDS.dog1Id}/medications`,
    headers: { 'idempotency-key': `med-staff-${randomUUID()}` },
    payload: { name: 'X', dose: '1 mg', frequency: 'daily' },
  });
  assert.equal(res.statusCode, 403);
});

test('POST /dogs/:id/medications — unknown dog returns 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = appAsOwner();
  const res = await app.inject({
    method: 'POST',
    url: '/dogs/00000000-0000-4000-8000-000000000000/medications',
    headers: { 'idempotency-key': `med-nodog-${randomUUID()}` },
    payload: { name: 'X', dose: '1 mg', frequency: 'daily' },
  });
  assert.equal(res.statusCode, 404);
});

test(
  'PATCH /dogs/:id/medications/:mid — owner edits + audit captures UPDATE',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'PATCH',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/medications/${FIXTURE_IDS.medication1Id}`,
      headers: { 'idempotency-key': `med-patch-${randomUUID()}` },
      payload: { dose: '10 mg', frequency: 'three times daily' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { dose: string; frequency: string };
    assert.equal(body.dose, '10 mg');
    assert.equal(body.frequency, 'three times daily');

    const log = await db.execute(
      sql`select op, actor from audit_log
          where table_name = 'dog_medications' and row_pk = ${FIXTURE_IDS.medication1Id}
          order by at desc limit 1`,
    );
    assert.ok(log.rows[0]);
    assert.equal(String(log.rows[0].op), 'UPDATE');
    assert.equal(String(log.rows[0].actor), `owner:${FIXTURE_IDS.ownerId}`);
  },
);

test(
  'PATCH /dogs/:id/medications/:mid — parent-child mismatch returns 404',
  SKIP_WHEN_NO_DB,
  async () => {
    // Lola (dog2) doesn't own medication1Id (which is Waffles' Apoquel).
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'PATCH',
      url: `/dogs/${FIXTURE_IDS.dog2Id}/medications/${FIXTURE_IDS.medication1Id}`,
      headers: { 'idempotency-key': `med-mismatch-${randomUUID()}` },
      payload: { dose: '99 mg' },
    });
    assert.equal(res.statusCode, 404);
  },
);

test('PATCH /dogs/:id/medications/:mid — empty body returns 400', SKIP_WHEN_NO_DB, async () => {
  const { app } = appAsOwner();
  const res = await app.inject({
    method: 'PATCH',
    url: `/dogs/${FIXTURE_IDS.dog1Id}/medications/${FIXTURE_IDS.medication1Id}`,
    headers: { 'idempotency-key': `med-patchempty-${randomUUID()}` },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test(
  'DELETE /dogs/:id/medications/:mid — owner soft-expires + audit captures UPDATE',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    const { app } = appAsOwner();
    const post = await app.inject({
      method: 'POST',
      url: `/dogs/${dogId}/medications`,
      headers: { 'idempotency-key': `med-del-setup-${randomUUID()}` },
      payload: { name: 'DeleteMe', dose: '1 mg', frequency: 'once' },
    });
    assert.equal(post.statusCode, 201);
    const mid = (post.json() as { id: string }).id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/dogs/${dogId}/medications/${mid}`,
      headers: { 'idempotency-key': `med-del-${randomUUID()}` },
    });
    assert.equal(del.statusCode, 204);

    const [row] = await db.select().from(dogMedications).where(eq(dogMedications.id, mid)).limit(1);
    assert.ok(row);
    assert.ok(row.expiredAt);

    const log = await db.execute(
      sql`select op, actor from audit_log
          where table_name = 'dog_medications' and row_pk = ${mid}
          order by at desc limit 1`,
    );
    assert.ok(log.rows[0]);
    assert.equal(String(log.rows[0].op), 'UPDATE');
    assert.equal(String(log.rows[0].actor), `owner:${FIXTURE_IDS.ownerId}`);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// PUT /dogs/:id/feeding
// ──────────────────────────────────────────────────────────────────────────

test(
  'PUT /dogs/:id/feeding — creates a feeding row when none exists (Lola)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Lola starts with no feeding row in the fixture.
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'PUT',
      url: `/dogs/${FIXTURE_IDS.dog2Id}/feeding`,
      headers: { 'idempotency-key': `feed-create-${randomUUID()}` },
      payload: {
        brand: "Hill's Science Diet",
        amount: '1.5 cups',
        frequency: 'twice daily',
        notes: 'Add a splash of warm water.',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      brand: string;
      amount: string;
      frequency: string;
      notes: string | null;
    };
    assert.equal(body.brand, "Hill's Science Diet");
    assert.equal(body.amount, '1.5 cups');
    assert.equal(body.frequency, 'twice daily');
    assert.equal(body.notes, 'Add a splash of warm water.');

    const [row] = await db
      .select()
      .from(dogFeeding)
      .where(eq(dogFeeding.dogId, FIXTURE_IDS.dog2Id))
      .limit(1);
    assert.ok(row);
    assert.equal(row.expiredAt, null);
  },
);

test(
  'PUT /dogs/:id/feeding — replaces an existing feeding row (Waffles)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Waffles starts with a feeding row (Purina Pro Plan). PUT replaces it.
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'PUT',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/feeding`,
      headers: { 'idempotency-key': `feed-replace-${randomUUID()}` },
      payload: { brand: 'Acana', amount: '1 cup', frequency: 'twice daily' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { brand: string; notes: string | null };
    assert.equal(body.brand, 'Acana');
    assert.equal(body.notes, null, 'omitted notes must clear to null on PUT replace');
  },
);

test('PUT /dogs/:id/feeding — replay returns the original response', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createTestDog();
  const { app } = appAsOwner();
  const idempotencyKey = `feed-replay-${randomUUID()}`;
  const payload = { brand: 'Replay Brand', amount: '1 cup', frequency: 'daily' };

  const first = await app.inject({
    method: 'PUT',
    url: `/dogs/${dogId}/feeding`,
    headers: { 'idempotency-key': idempotencyKey },
    payload,
  });
  assert.equal(first.statusCode, 200);

  const replay = await app.inject({
    method: 'PUT',
    url: `/dogs/${dogId}/feeding`,
    headers: { 'idempotency-key': idempotencyKey },
    payload,
  });
  assert.equal(replay.statusCode, 200);
  assert.deepStrictEqual(replay.json(), first.json());
});

test('PUT /dogs/:id/feeding — staff returns 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = appAsStaff();
  const res = await app.inject({
    method: 'PUT',
    url: `/dogs/${FIXTURE_IDS.dog1Id}/feeding`,
    headers: { 'idempotency-key': `feed-staff-${randomUUID()}` },
    payload: { brand: 'X', amount: 'Y', frequency: 'Z' },
  });
  assert.equal(res.statusCode, 403);
});

test('PUT /dogs/:id/feeding — unknown dog returns 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = appAsOwner();
  const res = await app.inject({
    method: 'PUT',
    url: '/dogs/00000000-0000-4000-8000-000000000000/feeding',
    headers: { 'idempotency-key': `feed-nodog-${randomUUID()}` },
    payload: { brand: 'X', amount: 'Y', frequency: 'Z' },
  });
  assert.equal(res.statusCode, 404);
});

test(
  'PUT /dogs/:id/feeding — empty-string notes normalize to null on wire',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    const { app } = appAsOwner();
    const res = await app.inject({
      method: 'PUT',
      url: `/dogs/${dogId}/feeding`,
      headers: { 'idempotency-key': `feed-emptynotes-${randomUUID()}` },
      payload: { brand: 'Brand', amount: '1 cup', frequency: 'daily', notes: '   ' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { notes: string | null };
    assert.equal(body.notes, null);
  },
);

test('PUT /dogs/:id/feeding — missing required field returns 400', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createTestDog();
  const { app } = appAsOwner();
  const res = await app.inject({
    method: 'PUT',
    url: `/dogs/${dogId}/feeding`,
    headers: { 'idempotency-key': `feed-missing-${randomUUID()}` },
    payload: { brand: 'X', amount: 'Y' }, // frequency missing
  });
  assert.equal(res.statusCode, 400);
});

/**
 * The RELINK round-trip. Day-9d's `PUT /dogs/:id/feeding` is the second
 * canonical RELINK use case (Day-2's owner/staff provisioning was the
 * first). The proof: soft-expire a feeding row directly in DB, PUT
 * again, and assert the row's `expired_at` clears (the `...RELINK`
 * spread in `onConflictDoUpdate.set` did its job) + the response
 * carries the new values + audit_log captures the UPDATE.
 */
test(
  'PUT /dogs/:id/feeding — RELINK round-trip resurrects a soft-expired row',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    const { app } = appAsOwner();

    // 1. Create the feeding row via PUT.
    const create = await app.inject({
      method: 'PUT',
      url: `/dogs/${dogId}/feeding`,
      headers: { 'idempotency-key': `feed-relink-1-${randomUUID()}` },
      payload: { brand: 'Original', amount: '1 cup', frequency: 'daily' },
    });
    assert.equal(create.statusCode, 200);

    // 2. Soft-expire the row directly in DB (the API has no DELETE
    // /feeding; this simulates a future delete verb or a manual ops
    // intervention that left the row expired).
    await db
      .update(dogFeeding)
      .set({ expiredAt: sql`now()` })
      .where(eq(dogFeeding.dogId, dogId));
    const [expired] = await db
      .select()
      .from(dogFeeding)
      .where(eq(dogFeeding.dogId, dogId))
      .limit(1);
    assert.ok(expired);
    assert.ok(expired.expiredAt, 'pre-condition: row must be soft-expired');

    // 3. PUT again — the RELINK upsert clears expired_at and applies the
    // new values in one statement.
    const relink = await app.inject({
      method: 'PUT',
      url: `/dogs/${dogId}/feeding`,
      headers: { 'idempotency-key': `feed-relink-2-${randomUUID()}` },
      payload: { brand: 'Resurrected', amount: '2 cups', frequency: 'three times daily' },
    });
    assert.equal(relink.statusCode, 200);
    const body = relink.json() as { brand: string; amount: string; frequency: string };
    assert.equal(body.brand, 'Resurrected');
    assert.equal(body.amount, '2 cups');
    assert.equal(body.frequency, 'three times daily');

    // 4. Direct DB verification: expired_at cleared.
    const [resurrected] = await db
      .select()
      .from(dogFeeding)
      .where(and(eq(dogFeeding.dogId, dogId)))
      .limit(1);
    assert.ok(resurrected);
    assert.equal(
      resurrected.expiredAt,
      null,
      'RELINK must clear expired_at on the conflict UPDATE',
    );

    // 5. Audit_log captured the relink as an UPDATE.
    const log = await db.execute(
      sql`select op, actor from audit_log
          where table_name = 'dog_feeding' and row_pk::text = ${dogId}
          order by at desc limit 1`,
    );
    assert.ok(log.rows[0]);
    assert.equal(String(log.rows[0].op), 'UPDATE');
    assert.equal(String(log.rows[0].actor), `owner:${FIXTURE_IDS.ownerId}`);
  },
);
