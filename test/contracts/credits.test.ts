import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerCreditsRoute } from '../../src/routes/credits.js';
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
  'GET /dogs/:id/credits returns the §B Credits wire shape with the ledger SUM (Waffles: +5 -1 = 4 school)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog1Id}/credits` });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/credits returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('credits-waffles'));
  },
);

test(
  'GET /dogs/:id/credits emits the zero sentinel for a dog with no ledger rows (Lola)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog2Id}/credits` });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/credits returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('credits-lola'));
  },
);

test(
  'GET /dogs/:id/credits for a non-existent dog returns 404 not_found',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    // A well-formed UUID that doesn't exist in the fixture.
    const res = await app.inject({
      method: 'GET',
      url: '/dogs/00000000-0000-4000-8000-000000000000/credits',
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /dogs/:id/credits as a staff principal returns 404 not_found (no id enumeration)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog1Id}/credits` });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /dogs/:id/credits with a malformed id returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/dogs/not-a-uuid/credits' });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);
