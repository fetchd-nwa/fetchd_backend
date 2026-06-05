import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  'GET /events byte-matches §B Event wire shape (4 events ASC by date, location nested, description + capacity optional-omit, spots_filled count)',
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

// --- POST/DELETE /events/:id/rsvp (Day-19e) -----------------------------
// Owner principal already owns dog1 + dog2; Yappy Hour (cap 20) has room. Each
// mutating test cleans up its own RSVP (the file teardown also wipes the
// owner's rsvps), and uses a fresh Idempotency-Key so re-runs never replay.

const UNOWNED_DOG_ID = '00000000-0000-4000-8000-0000000000dd';

function rsvpHeaders(): Record<string, string> {
  return { 'idempotency-key': randomUUID() };
}

async function spotsFor(app: ReturnType<typeof makeContractApp>['app'], eventId: string) {
  const res = await app.inject({ method: 'GET', url: `/events/${eventId}` });
  return (res.json() as { spots_filled: number }).spots_filled;
}

test(
  'POST /events/:id/rsvp signs up the owner dogs, bumps spots_filled, returns the RSVP wire',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'POST',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers: rsvpHeaders(),
      payload: { dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { event_id: string; dog_ids: string[] };
    assert.equal(body.event_id, FIXTURE_IDS.eventYappyHourId);
    assert.deepStrictEqual(
      [...body.dog_ids].sort(),
      [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id].sort(),
    );
    assert.equal(await spotsFor(app, FIXTURE_IDS.eventYappyHourId), 2);

    // cleanup
    await app.inject({
      method: 'DELETE',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers: rsvpHeaders(),
    });
    assert.equal(await spotsFor(app, FIXTURE_IDS.eventYappyHourId), 0);
  },
);

test(
  'POST /events/:id/rsvp replaces the dog set, re-adding a previously-live dog (event_rsvp_dogs PK case)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    await app.inject({
      method: 'POST',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers: rsvpHeaders(),
      payload: { dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id] },
    });
    // Replace with just dog1 — dog1 was already live; the soft-expire-and-recreate
    // path must not collide on the (rsvp_id, dog_id) PK.
    const res = await app.inject({
      method: 'POST',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers: rsvpHeaders(),
      payload: { dog_ids: [FIXTURE_IDS.dog1Id] },
    });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual((res.json() as { dog_ids: string[] }).dog_ids, [FIXTURE_IDS.dog1Id]);
    assert.equal(await spotsFor(app, FIXTURE_IDS.eventYappyHourId), 1);

    await app.inject({
      method: 'DELETE',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers: rsvpHeaders(),
    });
  },
);

test(
  'POST /events/:id/rsvp over the soft cap returns 422 event_full',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    // eventCapped has capacity 1; two dogs overflow it.
    const res = await app.inject({
      method: 'POST',
      url: `/events/${FIXTURE_IDS.eventCappedId}/rsvp`,
      headers: rsvpHeaders(),
      payload: { dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id] },
    });
    assert.equal(res.statusCode, 422);
    assert.equal((res.json() as { error?: { code?: string } }).error?.code, 'event_full');
    assert.equal(await spotsFor(app, FIXTURE_IDS.eventCappedId), 0);
  },
);

test('POST /events/:id/rsvp with a non-owned dog returns 404', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEventsRoute(app, { authenticate });
  const res = await app.inject({
    method: 'POST',
    url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
    headers: rsvpHeaders(),
    payload: { dog_ids: [UNOWNED_DOG_ID] },
  });
  assert.equal(res.statusCode, 404);
});

test('POST /events/:id/rsvp as a staff principal returns 403', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerEventsRoute(app, { authenticate });
  const res = await app.inject({
    method: 'POST',
    url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
    headers: rsvpHeaders(),
    payload: { dog_ids: [FIXTURE_IDS.dog1Id] },
  });
  assert.equal(res.statusCode, 403);
});

test(
  'DELETE /events/:id/rsvp is a no-op (200) when the owner has no RSVP',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'DELETE',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers: rsvpHeaders(),
    });
    assert.equal(res.statusCode, 200);
  },
);

test(
  'POST /events/:id/rsvp replayed under the same Idempotency-Key bumps spots only once',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerEventsRoute(app, { authenticate });
    const headers = { 'idempotency-key': randomUUID() };
    const payload = { dog_ids: [FIXTURE_IDS.dog1Id] };
    const first = await app.inject({
      method: 'POST',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers,
      payload,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepStrictEqual(first.json(), second.json());
    assert.equal(await spotsFor(app, FIXTURE_IDS.eventYappyHourId), 1);

    await app.inject({
      method: 'DELETE',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers: rsvpHeaders(),
    });
  },
);
