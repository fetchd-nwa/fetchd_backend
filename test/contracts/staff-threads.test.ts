import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  messages as messagesTable,
  notifications as notificationsTable,
  threads as threadsTable,
} from '../../src/db/schema/schema.js';
import { registerStaffThreadsRoute } from '../../src/routes/staffThreads.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day 19 contract tests for the staff-portal verb 3 (messaging reply):
 *   GET  /staff/threads               — cross-owner thread queue
 *   POST /staff/threads/:id/messages  — staff reply (sender_kind='staff')
 *
 * The reply is the first message-WRITE path: it INSERTs a staff message,
 * bumps the thread preview, and notifies the owner. The fixture seeds
 * thread1Id (fixture owner) with messages; tests reply into it and use
 * unique message text so the idempotency assertion can count its own rows.
 */

registerFixtureHooks();

function staffThreadsApp(
  principal = FIXTURE_STAFF_PRINCIPAL,
): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffThreadsRoute(app, { authenticate });
  return app;
}

function postReply(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  threadId: string;
  text: string;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: `/staff/threads/${opts.threadId}/messages`,
    headers,
    payload: { text: opts.text },
  });
}

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/threads
// ──────────────────────────────────────────────────────────────────────────

test(
  'GET /staff/threads — staff sees a thread with the §B wire shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = staffThreadsApp();
    const res = await app.inject({ method: 'GET', url: '/staff/threads' });
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json() as {
      id: string;
      participant: { id: string; name: string };
      unread_count: number;
      related_dog_ids: string[];
    }[];
    const mine = rows.find((r) => r.id === FIXTURE_IDS.thread1Id);
    assert.ok(mine, 'fixture thread present in the staff queue');
    assert.ok(mine.participant?.id, 'participant resolved');
    assert.ok(Array.isArray(mine.related_dog_ids), 'related_dog_ids emitted');
  },
);

test('GET /staff/threads — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const app = staffThreadsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({ method: 'GET', url: '/staff/threads' });
  assert.equal(res.statusCode, 403, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/threads/:id/messages
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/threads/:id/messages — staff reply lands + bumps + notifies owner',
  SKIP_WHEN_NO_DB,
  async () => {
    const text = `staff reply ${randomUUID()}`;
    const app = staffThreadsApp();
    const res = await postReply({
      app,
      threadId: FIXTURE_IDS.thread1Id,
      text,
      idempotencyKey: `sr-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      thread_id: string;
      sender_id: string;
      text: string;
      sender_name?: string;
    };
    assert.equal(body.thread_id, FIXTURE_IDS.thread1Id);
    assert.equal(body.sender_id, FIXTURE_IDS.staffDonavanId, 'sender is the acting staff');
    assert.equal(body.text, text);
    assert.ok(body.sender_name, 'staff sender_name resolved onto the wire');

    // Message row written sender_kind='staff'.
    const msgRows = await db
      .select({ senderKind: messagesTable.senderKind, senderStaffId: messagesTable.senderStaffId })
      .from(messagesTable)
      .where(and(eq(messagesTable.threadId, FIXTURE_IDS.thread1Id), eq(messagesTable.text, text)));
    assert.equal(msgRows.length, 1, 'exactly one message row inserted');
    assert.equal(msgRows[0]!.senderKind, 'staff');
    assert.equal(msgRows[0]!.senderStaffId, FIXTURE_IDS.staffDonavanId);

    // Thread preview bumped.
    const [thread] = await db
      .select({ lastMessage: threadsTable.lastMessage })
      .from(threadsTable)
      .where(eq(threadsTable.id, FIXTURE_IDS.thread1Id));
    assert.equal(thread?.lastMessage, text, 'last_message preview bumped');

    // Owner notified.
    const notes = await db
      .select({ type: notificationsTable.type, senderStaffId: notificationsTable.senderStaffId })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.ownerId, FIXTURE_IDS.ownerId),
          eq(notificationsTable.deepLinkPath, `/messages/${FIXTURE_IDS.thread1Id}`),
        ),
      );
    assert.ok(
      notes.some(
        (n) => n.type === 'message-received' && n.senderStaffId === FIXTURE_IDS.staffDonavanId,
      ),
      'message-received notification enqueued to the owner with the staff actor',
    );
  },
);

test('POST /staff/threads/:id/messages — unknown thread → 404', SKIP_WHEN_NO_DB, async () => {
  const app = staffThreadsApp();
  const res = await postReply({
    app,
    threadId: randomUUID(),
    text: 'into the void',
    idempotencyKey: `sr-404-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /staff/threads/:id/messages — empty text → 422', SKIP_WHEN_NO_DB, async () => {
  const app = staffThreadsApp();
  const res = await postReply({
    app,
    threadId: FIXTURE_IDS.thread1Id,
    text: '   ',
    idempotencyKey: `sr-empty-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 422, res.body);
});

test('POST /staff/threads/:id/messages — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const app = staffThreadsApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await postReply({
    app,
    threadId: FIXTURE_IDS.thread1Id,
    text: 'owner cannot use this',
    idempotencyKey: `sr-owner-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 403, res.body);
});

test(
  'POST /staff/threads/:id/messages — idempotency replay returns stored body, no double insert',
  SKIP_WHEN_NO_DB,
  async () => {
    const text = `idem reply ${randomUUID()}`;
    const app = staffThreadsApp();
    const key = `sr-idem-${randomUUID()}`;
    const first = await postReply({
      app,
      threadId: FIXTURE_IDS.thread1Id,
      text,
      idempotencyKey: key,
    });
    assert.equal(first.statusCode, 201, first.body);
    const replay = await postReply({
      app,
      threadId: FIXTURE_IDS.thread1Id,
      text,
      idempotencyKey: key,
    });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), first.json(), 'replay byte-identical');

    const msgRows = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(and(eq(messagesTable.threadId, FIXTURE_IDS.thread1Id), eq(messagesTable.text, text)));
    assert.equal(msgRows.length, 1, 'replay did not insert a second message');
  },
);
