import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerEventsRoute } from '../../src/routes/events.js';
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

// --- GET /events --------------------------------------------------------

test(
  'GET /events byte-matches §B Event wire shape (3 events ASC by date, location nested, description optional-omit)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/events' });
    if (res.statusCode !== 200) {
      throw new Error(`/events returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('events-list'));
  },
);

test('GET /events as a staff principal returns the same catalog', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerEventsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/events' });
  assert.equal(res.statusCode, 200);
  // Same catalog — events are shared across all principals. Owner-scoping
  // only lives on RSVPs.
  assert.deepStrictEqual(res.json(), loadSnapshot('events-list'));
});

// --- GET /events/:id ----------------------------------------------------

test(
  'GET /events/:id (Public Pups: recurring + description) byte-matches §B Event',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/events/${FIXTURE_IDS.eventPublicPupsId}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/events/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('event-public-pups'));
  },
);

test(
  'GET /events/:id (Yappy Hour: one-off, null description omitted) byte-matches §B Event',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/events/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('event-yappy-hour'));
  },
);

test('GET /events/:id for an unknown id returns 404', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEventsRoute(app, { authenticate });
  const res = await app.inject({
    method: 'GET',
    url: '/events/00000000-0000-4000-8000-000000000099',
  });
  assert.equal(res.statusCode, 404);
});

test('GET /events/not-a-uuid returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEventsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/events/not-a-uuid' });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

// --- GET /events/rsvps --------------------------------------------------

test(
  'GET /events/rsvps byte-matches §B EventRsvp wire shape (one RSVP, two dogs)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/events/rsvps' });
    if (res.statusCode !== 200) {
      throw new Error(`/events/rsvps returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('event-rsvps'));
  },
);

test(
  'GET /events/rsvps as a staff principal returns [] (rsvps are owner-only)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/events/rsvps' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), []);
  },
);
