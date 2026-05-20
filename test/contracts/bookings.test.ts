import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { FIXTURE_NOW } from './_fixture.js';
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
  'GET /bookings?view=upcoming byte-matches the §B wire shape (multi-dog, boarding w/ + w/o pickup_at, trainer resolution, location, DST CST coverage)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/bookings?view=upcoming' });
    if (res.statusCode !== 200) {
      throw new Error(`/bookings?view=upcoming returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('bookings-upcoming'));
  },
);

test(
  'GET /bookings?view=past byte-matches the §B wire shape (sorted DESC by scheduled_at)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/bookings?view=past' });
    if (res.statusCode !== 200) {
      throw new Error(`/bookings?view=past returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('bookings-past'));
  },
);

test('GET /bookings?view=invalid returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

  const res = await app.inject({ method: 'GET', url: '/bookings?view=not-a-view' });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

test('GET /bookings (no view param) returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

  const res = await app.inject({ method: 'GET', url: '/bookings' });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

test(
  'GET /bookings as a staff principal returns [] (owner app endpoints; portal uses /staff/bookings)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/bookings?view=upcoming' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), []);
  },
);
