import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
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
  'GET /credit-packages byte-matches the §B CreditPackage wire shape (active=true filter, enum-order school before daycare)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/credit-packages?location=fayetteville' });
    if (res.statusCode !== 200) {
      throw new Error(`/credit-packages returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('credit-packages'));
  },
);

test(
  'GET /credit-packages as staff returns the same data (catalog endpoint)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/credit-packages?location=fayetteville' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), loadSnapshot('credit-packages'));
  },
);

test(
  'GET /credit-packages?location=bentonville returns the Bentonville catalog (per-location pricing Δ 2026-06-04)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/credit-packages?location=bentonville' });
    if (res.statusCode !== 200) {
      throw new Error(`/credit-packages returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('credit-packages-bentonville'));
  },
);

test(
  'GET /credit-packages without a location query returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/credit-packages' });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);
