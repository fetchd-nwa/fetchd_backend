import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRequiredVaccinesRoute } from '../../src/routes/requiredVaccines.js';
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
