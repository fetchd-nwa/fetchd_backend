import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerMeRoute } from '../../src/routes/me.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test('GET /me byte-matches the DATA-CONTRACT §B Owner wire shape', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerMeRoute(app, { authenticate });

  const res = await app.inject({ method: 'GET', url: '/me' });
  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), loadSnapshot('me'));
});
