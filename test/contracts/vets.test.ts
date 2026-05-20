import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerVetsRoute } from '../../src/routes/vets.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test(
  'GET /vets?q=banfield byte-matches the DATA-CONTRACT §B Vet wire shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerVetsRoute(app, { authenticate });

    // Case-insensitive substring on `vets.name` — fixture row is
    // "Banfield — Fayetteville". The seed catalog may add more rows over
    // time, but the `q` filter is narrow enough to isolate the fixture.
    const res = await app.inject({ method: 'GET', url: '/vets?q=banfield' });
    if (res.statusCode !== 200) {
      throw new Error(`/vets returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('vets'));
  },
);
