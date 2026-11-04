import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dogs } from '../../src/db/schema/schema.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerStaffDogsRoute } from '../../src/routes/staffDogs.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * P12 B4 (wire 3.0.0; M2.16): `DogWire.last_seen_on` is sent from the column
 * and omitted while it is NULL. Nothing stamps it yet, so these tests write the
 * column by hand. `StaffDogWire` is a separate interface and does not carry it
 * (contract notes Y11).
 */

registerFixtureHooks();

async function setLastSeen(value: string | null): Promise<void> {
  await db.update(dogs).set({ lastSeenOn: value }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
}

function ownerApp(): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

async function dogFromList(): Promise<Record<string, unknown>> {
  const res = await ownerApp().inject({ method: 'GET', url: '/dogs' });
  assert.equal(res.statusCode, 200, res.body);
  const rows = res.json() as Record<string, unknown>[];
  const dog = rows.find((d) => d.id === FIXTURE_IDS.dog1Id);
  assert.ok(dog, 'GET /dogs lists the fixture dog');
  return dog;
}

async function dogById(): Promise<Record<string, unknown>> {
  const res = await ownerApp().inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog1Id}` });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Record<string, unknown>;
}

test('a NULL last_seen_on is omitted on GET /dogs and GET /dogs/:id', SKIP_WHEN_NO_DB, async () => {
  await setLastSeen(null);
  assert.equal('last_seen_on' in (await dogFromList()), false, 'GET /dogs');
  assert.equal('last_seen_on' in (await dogById()), false, 'GET /dogs/:id');
});

test(
  'a set last_seen_on reads YYYY-MM-DD on GET /dogs and GET /dogs/:id',
  SKIP_WHEN_NO_DB,
  async () => {
    await setLastSeen('2026-05-12');
    try {
      assert.equal((await dogFromList()).last_seen_on, '2026-05-12', 'GET /dogs');
      assert.equal((await dogById()).last_seen_on, '2026-05-12', 'GET /dogs/:id');
    } finally {
      await setLastSeen(null);
    }
  },
);

test('StaffDogWire does not carry last_seen_on', SKIP_WHEN_NO_DB, async () => {
  await setLastSeen('2026-05-12');
  try {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffDogsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/staff/dogs' });
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json() as Record<string, unknown>[];
    const dog = rows.find((d) => d.id === FIXTURE_IDS.dog1Id);
    assert.ok(dog, 'GET /staff/dogs lists the fixture dog');
    assert.equal('last_seen_on' in dog, false);
  } finally {
    await setLastSeen(null);
  }
});
