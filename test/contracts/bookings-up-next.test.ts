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
  'GET /bookings/up-next returns the most-imminent upcoming booking (sorted ASC, LIMIT 1)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/bookings/up-next' });
    if (res.statusCode !== 200) {
      throw new Error(`/bookings/up-next returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('bookings-up-next'));
  },
);

test(
  'GET /bookings/up-next returns null when the owner has no upcoming bookings (staff principal)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Staff principals mirror the empty-list semantics of /bookings —
    // singular variant returns `null` to match the FE's UpNextSummary | null.
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/bookings/up-next' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json(), null);
  },
);
