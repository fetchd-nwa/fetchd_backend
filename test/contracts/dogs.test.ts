import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test(
  'GET /dogs byte-matches the DATA-CONTRACT §B Dog wire shape (vet?, age_months, vaccines, medications, feeding, completed_class_keys)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerDogsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/dogs' });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('dogs'));
  },
);
