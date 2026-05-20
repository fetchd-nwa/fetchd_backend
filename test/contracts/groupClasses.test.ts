import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerGroupClassesRoute } from '../../src/routes/groupClasses.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test(
  'GET /group-classes returns the catalog in enum-natural order with price_per_dog_cents on the wire',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/group-classes' });
    if (res.statusCode !== 200) {
      throw new Error(`/group-classes returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('group-classes-list'));
  },
);

test(
  'GET /group-classes/:key returns a single class (age_range omitted when null)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/group-classes/manners-2' });
    if (res.statusCode !== 200) {
      throw new Error(`/group-classes/manners-2 returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('group-class-manners-2'));
  },
);

test(
  'GET /group-classes/<invalid enum> returns 400 bad_request (Zod rejects unknown key)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/group-classes/agility-1' });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'GET /group-classes/:key/cohorts returns the cohort list for manners-2 (single cohort, end_date set)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/group-classes/manners-2/cohorts' });
    if (res.statusCode !== 200) {
      throw new Error(`/group-classes/manners-2/cohorts returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('group-class-cohorts-manners-2'));
  },
);

test(
  'GET /group-classes/:key/cohorts returns [] for a class with no live cohorts (manners-1)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/group-classes/manners-1/cohorts' });
    if (res.statusCode !== 200) {
      throw new Error(`/group-classes/manners-1/cohorts returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), []);
  },
);

test('GET /cohorts/:id returns a single cohort with end_date set', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerGroupClassesRoute(app, { authenticate });

  const res = await app.inject({
    method: 'GET',
    url: `/cohorts/${FIXTURE_IDS.cohortMannersId}`,
  });
  if (res.statusCode !== 200) {
    throw new Error(`/cohorts/:id returned ${res.statusCode}: ${res.body}`);
  }
  assert.deepStrictEqual(res.json(), loadSnapshot('cohort-manners'));
});

test(
  'GET /cohorts/:id omits end_date when null (open-enrollment cohort)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/cohorts/${FIXTURE_IDS.cohortPuppyId}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/cohorts/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('cohort-puppy'));
  },
);

test('GET /cohorts/<unknown UUID> returns 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerGroupClassesRoute(app, { authenticate });

  const res = await app.inject({
    method: 'GET',
    url: '/cohorts/00000000-0000-4000-8000-000000000000',
  });
  assert.equal(res.statusCode, 404);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'not_found');
});

test(
  'GET /dogs/:id/group-eligibility?class=manners-2 — Waffles is eligible (she has manners-1; missing_prereq_options omitted)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/group-eligibility?class=manners-2`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/group-eligibility returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('eligibility-waffles-manners-2-eligible'));
  },
);

test(
  'GET /dogs/:id/group-eligibility?class=manners-2 — Lola is ineligible (no manners-1 completion; emits missing_prereq_options)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog2Id}/group-eligibility?class=manners-2`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/group-eligibility returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('eligibility-lola-manners-2-ineligible'));
  },
);

test(
  'GET /dogs/:id/group-eligibility?class=puppy — Lola is eligible (no prereqs at all)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog2Id}/group-eligibility?class=puppy`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/group-eligibility returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('eligibility-lola-puppy-no-prereqs'));
  },
);

test(
  'GET /dogs/:id/group-eligibility for an unknown dog returns 404 not_found',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/dogs/00000000-0000-4000-8000-000000000000/group-eligibility?class=manners-2',
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /dogs/:id/group-eligibility without a class query returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/group-eligibility`,
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'GET /dogs/:id/group-eligibility as a staff principal returns 404 not_found (no id enumeration)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerGroupClassesRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/group-eligibility?class=manners-2`,
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);
