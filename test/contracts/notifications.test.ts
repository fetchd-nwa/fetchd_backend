import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerNotificationsRoute } from '../../src/routes/notifications.js';
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

// --- GET /notifications (default limit, no cursor) ----------------------

test(
  'GET /notifications (no params) byte-matches §B Notification list — 5 rows DESC by received_at, no next_cursor, no dog/sender/link omission branches all covered',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/notifications' });
    if (res.statusCode !== 200) {
      throw new Error(`/notifications returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('notifications-list'));
  },
);

test('GET /notifications as a staff principal returns empty items', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerNotificationsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/notifications' });
  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { items: [] });
});

// --- GET /notifications?limit=3 (page 1) --------------------------------

test(
  'GET /notifications?limit=3 returns first 3 items + base64url next_cursor anchored to the 3rd row',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/notifications?limit=3' });
    if (res.statusCode !== 200) {
      throw new Error(`/notifications?limit=3 returned ${res.statusCode}: ${res.body}`);
    }
    const body = res.json() as { items: unknown[]; next_cursor?: string };
    assert.deepStrictEqual(body.items, loadSnapshot('notifications-page-1'));
    // Cursor present + decodes to the 3rd row's anchor (semantic check —
    // the encoded string is implementation detail, the *contents* are the
    // contract).
    assert.equal(typeof body.next_cursor, 'string');
    const decoded = JSON.parse(
      Buffer.from(body.next_cursor as string, 'base64url').toString('utf-8'),
    ) as { r: string; i: string };
    assert.equal(decoded.r, '2026-05-18T15:00:00.000Z');
    assert.equal(decoded.i, FIXTURE_IDS.notification3Id);
  },
);

// --- GET /notifications?cursor=<page1> (page 2) -------------------------

test(
  'GET /notifications?cursor=<page1>&limit=3 returns the remaining 2 items, no next_cursor',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });
    // Compute the page-1 cursor by fetching it (round-trip verification).
    const page1 = await app.inject({ method: 'GET', url: '/notifications?limit=3' });
    const cursor = (page1.json() as { next_cursor: string }).next_cursor;

    const res = await app.inject({
      method: 'GET',
      url: `/notifications?cursor=${encodeURIComponent(cursor)}&limit=3`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/notifications page-2 returned ${res.statusCode}: ${res.body}`);
    }
    const body = res.json() as { items: unknown[]; next_cursor?: string };
    assert.deepStrictEqual(body.items, loadSnapshot('notifications-page-2'));
    assert.equal(body.next_cursor, undefined);
  },
);

// --- GET /notifications?cursor=<malformed> ------------------------------

test(
  'GET /notifications?cursor=<garbage> returns 400 bad_request (not silent fallback)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });
    // base64url-encoded `{}` decodes cleanly but fails the Zod schema.
    const malformed = Buffer.from('{}', 'utf-8').toString('base64url');
    const res = await app.inject({
      method: 'GET',
      url: `/notifications?cursor=${encodeURIComponent(malformed)}`,
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test('GET /notifications?limit=0 returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerNotificationsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/notifications?limit=0' });
  assert.equal(res.statusCode, 400);
});

test('GET /notifications?limit=999 returns 400 bad_request (cap)', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerNotificationsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/notifications?limit=999' });
  assert.equal(res.statusCode, 400);
});

// --- GET /notifications/unread-count ------------------------------------

test(
  'GET /notifications/unread-count returns { unread_count: 2 } for the fixture owner',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/notifications/unread-count' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { unread_count: 2 });
  },
);

test(
  'GET /notifications/unread-count returns { unread_count: 0 } for staff',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: '/notifications/unread-count' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { unread_count: 0 });
  },
);
