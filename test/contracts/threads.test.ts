import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerThreadsRoute } from '../../src/routes/threads.js';
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

// --- GET /threads -------------------------------------------------------

test(
  'GET /threads byte-matches §B Thread wire shape (2 threads, unread_count derived, DESC by last_message_at)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerThreadsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/threads' });
    if (res.statusCode !== 200) {
      throw new Error(`/threads returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('threads-list'));
  },
);

test('GET /threads as a staff principal returns []', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerThreadsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/threads' });
  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), []);
});

// --- GET /threads/:id --------------------------------------------------

test(
  'GET /threads/:id (thread1) byte-matches §B Thread (with thread_dogs + unread_count=2)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerThreadsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/threads/${FIXTURE_IDS.thread1Id}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/threads/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('thread-sessions'));
  },
);

test(
  'GET /threads/:id (thread2) byte-matches §B Thread (empty related_dog_ids + unread_count=0)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerThreadsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/threads/${FIXTURE_IDS.thread2Id}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/threads/:id returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('thread-billing'));
  },
);

test(
  'GET /threads/:id for a staff principal returns 404 (no enumeration)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerThreadsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/threads/${FIXTURE_IDS.thread1Id}`,
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test('GET /threads/:id for an unknown id returns 404', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerThreadsRoute(app, { authenticate });
  const res = await app.inject({
    method: 'GET',
    url: '/threads/00000000-0000-4000-8000-000000000099',
  });
  assert.equal(res.statusCode, 404);
});

test('GET /threads/not-a-uuid returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerThreadsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/threads/not-a-uuid' });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

// --- GET /threads/:id/messages -----------------------------------------

test(
  'GET /threads/:id/messages (thread1) byte-matches §B Message wire (polymorphic sender flatten, ASC by sent_at)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerThreadsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/threads/${FIXTURE_IDS.thread1Id}/messages`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/threads/:id/messages returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('messages-sessions'));
  },
);

test(
  'GET /threads/:id/messages (thread2) byte-matches §B Message wire (all read)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerThreadsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/threads/${FIXTURE_IDS.thread2Id}/messages`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/threads/:id/messages returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('messages-billing'));
  },
);

test(
  'GET /threads/:id/messages for staff principal returns 404 (ownership gate)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerThreadsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/threads/${FIXTURE_IDS.thread1Id}/messages`,
    });
    assert.equal(res.statusCode, 404);
  },
);

test(
  'GET /threads/unknown-id/messages returns 404 (same response as not-yours)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerThreadsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: '/threads/00000000-0000-4000-8000-000000000099/messages',
    });
    assert.equal(res.statusCode, 404);
  },
);
