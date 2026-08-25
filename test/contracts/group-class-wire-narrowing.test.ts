import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROUP_CLASS_KEYS, LOCATIONS } from '../../src/contracts/wire.js';
import type {
  CohortWire,
  GroupClassEnrollmentType,
  GroupClassWire,
} from '../../src/contracts/wire.js';
import { registerGroupClassesRoute } from '../../src/routes/groupClasses.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

const ENROLLMENT_TYPES: readonly GroupClassEnrollmentType[] = ['open', 'cohort'];

test(
  'GET /group-classes — every emitted enrollment_type is a GroupClassEnrollmentType (wire 1.13.0 §14.2-B pin)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/group-classes' });
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json() as GroupClassWire[];
    assert.ok(rows.length > 0, 'the fixture catalog is non-empty');

    for (const row of rows) {
      assert.ok(
        ENROLLMENT_TYPES.includes(row.enrollment_type),
        `class ${row.key}: enrollment_type ${JSON.stringify(row.enrollment_type)} is outside 'open' | 'cohort'`,
      );
      assert.ok(GROUP_CLASS_KEYS.includes(row.key), `key ${row.key} is outside GROUP_CLASS_KEYS`);
    }

    const seen = new Set<string>(rows.map((r) => r.enrollment_type));
    assert.ok(seen.has('open'), "the catalog emits at least one 'open' class");
    assert.ok(seen.has('cohort'), "the catalog emits at least one 'cohort' class");
  },
);

test(
  'GET /cohorts/:id — class_key and location parse as GroupClassKey / LocationKey',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    for (const cohortId of [FIXTURE_IDS.cohortMannersId, FIXTURE_IDS.cohortPuppyId]) {
      const res = await app.inject({ method: 'GET', url: `/cohorts/${cohortId}` });
      assert.equal(res.statusCode, 200, res.body);
      const cohort = res.json() as CohortWire;
      assert.ok(
        GROUP_CLASS_KEYS.includes(cohort.class_key),
        `cohort ${cohortId}: class_key ${cohort.class_key} is outside GROUP_CLASS_KEYS`,
      );
      assert.ok(
        LOCATIONS.includes(cohort.location),
        `cohort ${cohortId}: location ${cohort.location} is outside LOCATIONS`,
      );
    }
  },
);
