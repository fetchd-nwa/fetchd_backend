import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

const NON_EXISTENT_DOG_ID = '33333333-3333-4333-8333-3333333333ff';

registerFixtureHooks();

test(
  'GET /dogs/:id/bookings?view=upcoming returns Waffles bookings where she is LEAD or ADDITIONAL',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/bookings?view=upcoming`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/bookings returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('dog-bookings-waffles-upcoming'));
  },
);

test(
  'GET /dogs/:id/bookings?view=upcoming returns Lola bookings including the multi-dog row where she is additional',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog2Id}/bookings?view=upcoming`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/bookings returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('dog-bookings-lola-upcoming'));
  },
);

test(
  'GET /dogs/:id/bookings?view=past returns past bookings for the dog',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/bookings?view=past`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/bookings returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('dog-bookings-waffles-past'));
  },
);

test(
  'GET /dogs/:id/bookings for a non-existent dog returns [] (same response as "no bookings", no id-leak)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${NON_EXISTENT_DOG_ID}/bookings?view=upcoming`,
    });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), []);
  },
);

test('GET /dogs/:id/bookings?view=invalid returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

  const res = await app.inject({
    method: 'GET',
    url: `/dogs/${FIXTURE_IDS.dog1Id}/bookings?view=nope`,
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});
