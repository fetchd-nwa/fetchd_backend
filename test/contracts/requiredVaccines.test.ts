import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { bookings, dogs, requiredVaccines } from '../../src/db/schema/schema.js';
import { registerRequiredVaccinesRoute } from '../../src/routes/requiredVaccines.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test(
  'GET /required-vaccines byte-matches the DATA-CONTRACT §C catalog shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequiredVaccinesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/required-vaccines' });
    if (res.statusCode !== 200) {
      throw new Error(`/required-vaccines returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('required-vaccines'));
  },
);

test(
  'GET /required-vaccines emits exempt_class_keys, including a non-empty list',
  SKIP_WHEN_NO_DB,
  async () => {
    // Delete-first: a prior crashed run can leave the PK row behind.
    await db.delete(requiredVaccines).where(eq(requiredVaccines.key, 'test-rabies-exempt'));
    await db.insert(requiredVaccines).values({
      key: 'test-rabies-exempt',
      label: 'Rabies (exempt-arm fixture)',
      gatesCategories: ['group-class'],
      exemptClassKeys: ['puppy'],
    });
    try {
      const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
      registerRequiredVaccinesRoute(app, { authenticate });

      const res = await app.inject({ method: 'GET', url: '/required-vaccines' });
      assert.equal(res.statusCode, 200, res.body);
      const rows = res.json() as {
        key: string;
        exempt_class_keys: string[];
      }[];
      // Every row carries the key — it is NOT NULL DEFAULT '{}' on the wire.
      for (const row of rows) {
        assert.ok(Array.isArray(row.exempt_class_keys), `${row.key} missing exempt_class_keys`);
      }
      const exempt = rows.find((r) => r.key === 'test-rabies-exempt');
      assert.deepStrictEqual(exempt?.exempt_class_keys, ['puppy']);
    } finally {
      await db.delete(requiredVaccines).where(eq(requiredVaccines.key, 'test-rabies-exempt'));
    }
  },
);

// Moved from booking-approval-divert.test.ts when that suite was deleted (P12
// B5): the exemption has nothing to do with the deleted lane.
test(
  'vaccine gate — exempt_class_keys skips the requirement for that cohort (trigger floor), still gates other classes',
  SKIP_WHEN_NO_DB,
  async () => {
    // A rabies-style requirement gating group-class, with puppy exempt.
    // Delete-first: a prior crashed run can leave the PK row behind.
    await db.delete(requiredVaccines).where(eq(requiredVaccines.key, 'test-rabies-exempt'));
    await db.insert(requiredVaccines).values({
      key: 'test-rabies-exempt',
      label: 'Rabies (test)',
      gatesCategories: ['group-class'],
      exemptClassKeys: ['puppy'],
    });
    const dogId = randomUUID();
    await db.insert(dogs).values({
      id: dogId,
      ownerId: FIXTURE_IDS.ownerId,
      name: `Exempt ${dogId.slice(0, 8)}`,
      breed: 'Test Breed',
      birthdate: '2023-01-01',
      evaluationStatus: 'passed',
    });

    try {
      // Direct INSERT (the trigger floor). Puppy cohort → passes without
      // any rabies row on the dog.
      await db.insert(bookings).values({
        id: randomUUID(),
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: dogId,
        category: 'group-class',
        status: 'upcoming',
        scheduledAt: '2026-06-03T23:00:00Z',
        durationMinutes: 60,
        cohortId: FIXTURE_IDS.cohortPuppyId,
        location: 'fayetteville',
      });

      // Manners cohort → the same dog is blocked by the same requirement.
      await assert.rejects(
        db.insert(bookings).values({
          id: randomUUID(),
          ownerId: FIXTURE_IDS.ownerId,
          leadDogId: dogId,
          category: 'group-class',
          status: 'upcoming',
          scheduledAt: '2026-06-04T23:00:00Z',
          durationMinutes: 60,
          cohortId: FIXTURE_IDS.cohortMannersId,
          location: 'fayetteville',
        }),
        /vaccine gate/,
      );
    } finally {
      await db.delete(bookings).where(eq(bookings.leadDogId, dogId));
      await db.delete(dogs).where(eq(dogs.id, dogId));
      await db.delete(requiredVaccines).where(eq(requiredVaccines.key, 'test-rabies-exempt'));
    }
  },
);
