import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { FIXTURE_IDS } from './_fixture.js';
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
  'GET /requests returns both fixture requests, newest-submitted first (R1 multi-dog + R8 structured focus on the wire)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('requests-list'));
  },
);

test(
  'GET /requests?status=submitted filters down to the submitted fixture request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests?status=submitted' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests?status=submitted returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('requests-submitted'));
  },
);

test(
  'GET /requests?status=converted filters down to the converted fixture request (with approved_at + converted_booking_id, NO notes, focus emits {})',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests?status=converted' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests?status=converted returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('requests-converted'));
  },
);

test(
  'GET /requests?status=cancelled returns an empty array (no cancelled requests in fixture)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests?status=cancelled' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests?status=cancelled returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), []);
  },
);

test(
  'GET /requests/:id (submitted private-lesson, multi-dog) emits every optional key',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/requests/${FIXTURE_IDS.pendingRequest1Id}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/requests/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('request-1'));
  },
);

test(
  'GET /requests/:id (converted board-and-train, single-dog) emits length_weeks + approval keys + omits notes + emits focus:{}',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/requests/${FIXTURE_IDS.pendingRequest2Id}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/requests/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('request-2'));
  },
);

test(
  'GET /requests/:id for a non-existent request returns 404 not_found',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/requests/00000000-0000-4000-8000-000000000000',
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /requests as a staff principal returns an empty list (owner-only resource)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests' });
    if (res.statusCode !== 200) {
      throw new Error(`/requests (staff) returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), []);
  },
);

test(
  'GET /requests/:id as a staff principal returns 404 not_found (no id enumeration)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/requests/${FIXTURE_IDS.pendingRequest1Id}`,
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /requests?status=<invalid enum value> returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRequestsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/requests?status=draft' });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test('GET /requests/<malformed id> returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerRequestsRoute(app, { authenticate });

  const res = await app.inject({ method: 'GET', url: '/requests/not-a-uuid' });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});
