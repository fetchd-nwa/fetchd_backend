import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { notifications, owners } from '../../src/db/schema/schema.js';
import { registerNotificationsRoute } from '../../src/routes/notifications.js';
import { FIXTURE_IDS, seedFixture } from './_fixture.js';
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

// --- POST /notifications/:id/read + read-all + DELETE (mutations) --------
// These mutate the fixture's read_at / dismissed_at, so each one re-seeds a
// clean fixture up front (fresh { unread_count: 2, 5 live rows }) and asserts
// against that known baseline — the mutations are order-independent rather
// than chained. Fresh Idempotency-Key per call except where a replay is under
// test.

test(
  'marking one notification read returns 204, decrements the unread count, and keeps the row in the feed flagged is_read',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedFixture();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });

    const before = await app.inject({ method: 'GET', url: '/notifications/unread-count' });
    assert.equal((before.json() as { unread_count: number }).unread_count, 2);

    // notification5 is unread in the fixture.
    const key = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: `/notifications/${FIXTURE_IDS.notification5Id}/read`,
      headers: { 'idempotency-key': key },
    });
    assert.equal(res.statusCode, 204);

    const afterCount = await app.inject({ method: 'GET', url: '/notifications/unread-count' });
    assert.equal((afterCount.json() as { unread_count: number }).unread_count, 1);

    // Read is not dismiss: the row still shows in the feed, now flagged read.
    const feed = await app.inject({ method: 'GET', url: '/notifications' });
    const items = (feed.json() as { items: { id: string; is_read: boolean }[] }).items;
    const row = items.find((n) => n.id === FIXTURE_IDS.notification5Id);
    assert.ok(row, 'a read notification must still appear in the feed');
    assert.equal(row.is_read, true);

    // Replaying with the same Idempotency-Key returns 204 and leaves the count.
    const replay = await app.inject({
      method: 'POST',
      url: `/notifications/${FIXTURE_IDS.notification5Id}/read`,
      headers: { 'idempotency-key': key },
    });
    assert.equal(replay.statusCode, 204);
    const replayCount = await app.inject({ method: 'GET', url: '/notifications/unread-count' });
    assert.equal((replayCount.json() as { unread_count: number }).unread_count, 1);
  },
);

test(
  'marking all notifications read returns 204 and drops the unread count to zero',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedFixture();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(res.statusCode, 204);

    const count = await app.inject({ method: 'GET', url: '/notifications/unread-count' });
    assert.equal((count.json() as { unread_count: number }).unread_count, 0);
  },
);

test(
  'dismissing a notification returns 204, removes it from the feed and the unread count, while a read notification still shows (read != dismiss)',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedFixture();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });

    // notification5 is unread; notification4 is already read in the fixture.
    const res = await app.inject({
      method: 'DELETE',
      url: `/notifications/${FIXTURE_IDS.notification5Id}`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(res.statusCode, 204);

    // Dismissing an unread row drops it from the unread count.
    const count = await app.inject({ method: 'GET', url: '/notifications/unread-count' });
    assert.equal((count.json() as { unread_count: number }).unread_count, 1);

    // Dismiss removes it from the feed; the read notification4 still shows.
    const feed = await app.inject({ method: 'GET', url: '/notifications' });
    const items = (feed.json() as { items: { id: string }[] }).items;
    const ids = items.map((n) => n.id);
    assert.equal(items.length, 4);
    assert.ok(
      !ids.includes(FIXTURE_IDS.notification5Id),
      'a dismissed row must not appear in the feed',
    );
    assert.ok(
      ids.includes(FIXTURE_IDS.notification4Id),
      'a read (but not dismissed) row must still appear',
    );
  },
);

test(
  'dismiss is a soft tombstone — the row is retained in the database with dismissed_at set',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedFixture();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'DELETE',
      url: `/notifications/${FIXTURE_IDS.notification1Id}`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(res.statusCode, 204);

    const rows = await db
      .select({ id: notifications.id, dismissedAt: notifications.dismissedAt })
      .from(notifications)
      .where(eq(notifications.id, FIXTURE_IDS.notification1Id));
    assert.equal(rows.length, 1, 'a dismissed row must be retained (soft tombstone, not deleted)');
    assert.notEqual(rows[0]?.dismissedAt, null);
  },
);

test(
  'a staff principal cannot mark an owner notification read or dismiss it (404, no enumeration)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });

    const read = await app.inject({
      method: 'POST',
      url: `/notifications/${FIXTURE_IDS.notification5Id}/read`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(read.statusCode, 404);

    const dismiss = await app.inject({
      method: 'DELETE',
      url: `/notifications/${FIXTURE_IDS.notification5Id}`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(dismiss.statusCode, 404);
  },
);

test(
  'marking read or dismissing an unknown notification id returns 404',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedFixture();
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerNotificationsRoute(app, { authenticate });
    const unknownId = '00000000-0000-4000-8000-000000000099';

    const read = await app.inject({
      method: 'POST',
      url: `/notifications/${unknownId}/read`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(read.statusCode, 404);

    const dismiss = await app.inject({
      method: 'DELETE',
      url: `/notifications/${unknownId}`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(dismiss.statusCode, 404);
  },
);

test(
  "a different real owner cannot mark read or dismiss the fixture owner's notification (404, owner_id scopes the WHERE) and mutates nothing",
  SKIP_WHEN_NO_DB,
  async () => {
    await seedFixture();
    // A *real* second owner (row in `owners`) that is NOT the fixture owner.
    // It must exist: the mutation writes an idempotency_keys row FK-bound to
    // owners before the repository runs, so a phantom owner id would 500 at
    // the FK rather than exercise the ownership WHERE. With a real owner the
    // request reaches markReadForOwner/dismissForOwner and gets 0 rows
    // *only because* owner_id is in the WHERE — this is the case that would
    // pass (204, real owner's count decremented) if owner isolation were
    // dropped. The mutation throws not_found and rolls back, so no
    // idempotency_keys row survives to reference this owner.
    const foreignOwner = {
      kind: 'owner' as const,
      ownerId: randomUUID(),
      supabaseUid: randomUUID(),
    };
    await db.insert(owners).values({
      id: foreignOwner.ownerId,
      supabaseUid: foreignOwner.supabaseUid,
      name: 'Foreign Owner',
      email: `foreign-${foreignOwner.ownerId}@example.com`,
      phone: '555-9999',
      location: 'fayetteville',
      avatarImagePath: '',
      emergencyName: 'Foreign Contact',
      emergencyRelationship: 'friend',
      emergencyPhone: '555-9998',
      pushNotificationsEnabled: true,
      pushNotificationCategories: { booking: true, message: true },
      emailNotificationsEnabled: true,
      emailNotificationCategories: { booking: true, message: true },
    });

    try {
      const { app, authenticate } = makeContractApp(foreignOwner);
      registerNotificationsRoute(app, { authenticate });

      // notification5 belongs to the fixture owner, not the foreign owner.
      const read = await app.inject({
        method: 'POST',
        url: `/notifications/${FIXTURE_IDS.notification5Id}/read`,
        headers: { 'idempotency-key': randomUUID() },
      });
      assert.equal(read.statusCode, 404);

      const dismiss = await app.inject({
        method: 'DELETE',
        url: `/notifications/${FIXTURE_IDS.notification5Id}`,
        headers: { 'idempotency-key': randomUUID() },
      });
      assert.equal(dismiss.statusCode, 404);

      // The real owner's feed is untouched: unread count is still 2 (the
      // foreign owner marked nothing read and dismissed nothing).
      const { app: ownerApp, authenticate: ownerAuth } =
        makeContractApp(FIXTURE_OWNER_PRINCIPAL);
      registerNotificationsRoute(ownerApp, { authenticate: ownerAuth });
      const count = await ownerApp.inject({ method: 'GET', url: '/notifications/unread-count' });
      assert.equal((count.json() as { unread_count: number }).unread_count, 2);
    } finally {
      // Not a fixture row — teardownFixture won't remove it. The rolled-back
      // mutations left no idempotency_keys rows referencing this owner, so a
      // plain delete is FK-safe.
      await db.delete(owners).where(eq(owners.id, foreignOwner.ownerId));
    }
  },
);
