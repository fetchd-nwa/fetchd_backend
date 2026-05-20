import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerAgreementsRoute } from '../../src/routes/agreements.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test(
  'GET /agreements byte-matches the catalog + signed-current-version derivation shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAgreementsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/agreements' });
    if (res.statusCode !== 200) {
      throw new Error(`/agreements returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('agreements'));
  },
);
