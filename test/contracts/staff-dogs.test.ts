import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerStaffDogsRoute } from '../../src/routes/staffDogs.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day-19b contract test for the staff-portal dog directory:
 *   GET /staff/dogs — cross-owner name resolution + report-author dog picker
 *
 * The four staff verbs reference dogs by UUID with no names on the wire; this
 * directory resolves dog_id → name + owner. Cross-owner (`requireStaff`);
 * owner-owned live dogs only. Rows accumulate across the file run, so assert
 * the SPECIFIC fixture dog ids, never a total.
 */

registerFixtureHooks();

function staffDogsApp(
  principal = FIXTURE_STAFF_PRINCIPAL,
): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffDogsRoute(app, { authenticate });
  return app;
}

interface StaffDogWire {
  id: string;
  name: string;
  breed: string;
  owner_id: string;
  owner_name: string;
  profile_image_path?: string;
}

test(
  'GET /staff/dogs — staff sees cross-owner dogs with owner names resolved',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffDogsApp();
    const res = await app.inject({ method: 'GET', url: '/staff/dogs' });
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json() as StaffDogWire[];

    const waffles = rows.find((r) => r.id === FIXTURE_IDS.dog1Id);
    assert.ok(waffles, 'Waffles present in the directory');
    assert.equal(waffles.name, 'Waffles');
    assert.equal(waffles.breed, 'Labradoodle');
    assert.equal(waffles.owner_id, FIXTURE_IDS.ownerId, 'owner_id resolved');
    assert.equal(waffles.owner_name, 'Allison Fixture', 'owner_name resolved via join');
    assert.equal(
      waffles.profile_image_path,
      'dogs/waffles/waffles-pfp.jpg',
      'profile_image_path emitted when present',
    );

    const lola = rows.find((r) => r.id === FIXTURE_IDS.dog2Id);
    assert.ok(lola, 'Lola present in the directory');
    assert.equal(lola.name, 'Lola');
    assert.equal(
      lola.profile_image_path,
      undefined,
      'profile_image_path omitted when the dog has none',
    );
  },
);

test('GET /staff/dogs — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const app = staffDogsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({ method: 'GET', url: '/staff/dogs' });
  assert.equal(res.statusCode, 403, res.body);
});

// --- Day-19c: session-count (report author's auto visit number) -------------

test(
  'GET /staff/dogs/:id/session-count — counts past sessions in the category',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffDogsApp();
    // Waffles has exactly one PAST day-school booking (booking6); booking1 +
    // bookingDst are upcoming, booking9 is cancelled.
    const res = await app.inject({
      method: 'GET',
      url: `/staff/dogs/${FIXTURE_IDS.dog1Id}/session-count?category=day-school`,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { count: number }).count, 1);
  },
);

test(
  'GET /staff/dogs/:id/session-count — zero when no past sessions in the category',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffDogsApp();
    // Waffles' only private-lesson (booking3) is upcoming, not past.
    const res = await app.inject({
      method: 'GET',
      url: `/staff/dogs/${FIXTURE_IDS.dog1Id}/session-count?category=private-lesson`,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { count: number }).count, 0);
  },
);

test('GET /staff/dogs/:id/session-count — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const app = staffDogsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({
    method: 'GET',
    url: `/staff/dogs/${FIXTURE_IDS.dog1Id}/session-count?category=day-school`,
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('GET /staff/dogs/:id/session-count — unknown category → 400', SKIP_WHEN_NO_DB, async () => {
  const app = staffDogsApp();
  const res = await app.inject({
    method: 'GET',
    url: `/staff/dogs/${FIXTURE_IDS.dog1Id}/session-count?category=not-a-category`,
  });
  assert.equal(res.statusCode, 400, res.body);
});
