import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerPaymentMethodsRoute } from '../../src/routes/paymentMethods.js';
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
  'GET /payment-methods byte-matches §B PaymentMethod — single default visa, scalar exp_month/exp_year',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerPaymentMethodsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/payment-methods' });
    if (res.statusCode !== 200) {
      throw new Error(`/payment-methods returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('payment-methods-list'));
  },
);

test('GET /payment-methods as staff returns []', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerPaymentMethodsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/payment-methods' });
  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), []);
});
