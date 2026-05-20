import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

const NON_EXISTENT_BOOKING_ID = '77777777-7777-4777-8777-7777777777ff';

registerFixtureHooks();

test(
  'GET /bookings/:id byte-matches the §B wire shape (day-school, single dog, trainer set)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: `/bookings/${FIXTURE_IDS.booking1Id}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/bookings/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('bookings-by-id-day-school'));
  },
);

test(
  'GET /bookings/:id for a cancelled booking emits cancelled_at + cancel_forfeited',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: `/bookings/${FIXTURE_IDS.booking9Id}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/bookings/:id (cancelled) returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('bookings-by-id-cancelled'));
  },
);

test(
  'GET /bookings/:id returns 404 not_found for a non-existent booking id',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: `/bookings/${NON_EXISTENT_BOOKING_ID}`,
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /bookings/:id returns 400 bad_request for a malformed uuid',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/bookings/not-a-uuid' });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'GET /bookings/:id returns 404 for a staff principal (id leak protection)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Staff hitting an owner endpoint resolves to "not found" rather than
    // "forbidden" so a staff token can't enumerate owner booking ids.
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: `/bookings/${FIXTURE_IDS.booking1Id}`,
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);
