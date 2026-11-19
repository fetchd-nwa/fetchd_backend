import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import type { Principal } from '../../src/auth/principal.js';
import { db } from '../../src/db/client.js';
import { registerStaffThreadsRoute } from '../../src/routes/staffThreads.js';
import { registerThreadsRoute } from '../../src/routes/threads.js';
import type { ExpoPushClient } from '../../src/lib/expoPush.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  makeContractApp,
  type LogCapture,
} from './_harness.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { waitForBlockedBackends } from './_poolFixture.js';
import { makeR2Stub, type R2Stub } from './_r2Stub.js';

/**
 * What the messaging suites share (plan unit P45 with O-MSG-LIVE, backend pass 1): the two
 * route families on one stubbed R2, the four sends, a staff upload planted as pass 2's arm
 * will stamp it, a lock held on a second real connection so two requests provably overlap,
 * and the cleanup of what the tests create in the fixture family.
 */

export type AnyApp = FastifyInstance;

export function ownerApp(
  principal: Principal = FIXTURE_OWNER_PRINCIPAL,
  r2: R2Stub = makeR2Stub(),
  capture?: LogCapture,
) {
  const { app, authenticate } = makeContractApp(principal, capture);
  registerThreadsRoute(app, { authenticate, r2 });
  return app;
}

/**
 * The staff routes. The direct push (pass 2, `lib/messageNotice.ts`) always goes to an Expo stub
 * here, never to Expo itself: a test that needs to see the pushes passes its own stub.
 */
export function staffApp(
  principal: Principal = FIXTURE_STAFF_PRINCIPAL,
  r2: R2Stub = makeR2Stub(),
  expoPush: ExpoPushClient = makeExpoPushStub(),
  capture?: LogCapture,
) {
  const { app, authenticate } = makeContractApp(principal, capture);
  registerStaffThreadsRoute(app, { authenticate, r2, expoPush });
  return app;
}

export function postJson(
  app: AnyApp,
  url: string,
  payload: unknown,
  key: string = `msg-${randomUUID()}`,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'idempotency-key': key },
    payload: payload as object,
  });
}

export function startThread(app: AnyApp, payload: Record<string, unknown>, key?: string) {
  return postJson(app, '/threads', payload, key);
}

export function ownerSend(
  app: AnyApp,
  threadId: string,
  payload: Record<string, unknown>,
  key?: string,
) {
  return postJson(app, `/threads/${threadId}/messages`, payload, key);
}

export function staffReply(
  app: AnyApp,
  threadId: string,
  payload: Record<string, unknown>,
  key?: string,
) {
  return postJson(app, `/staff/threads/${threadId}/messages`, payload, key);
}

/** `POST /staff/threads` (S46): a staffer starts, or continues, her conversation with a family. */
export function staffStart(app: AnyApp, payload: Record<string, unknown>, key?: string) {
  return postJson(app, '/staff/threads', payload, key);
}

/** `POST /staff/threads/:id/read` (S46): the family messages the portal rendered. */
export function staffRead(app: AnyApp, threadId: string, messageIds: string[], key?: string) {
  return postJson(app, `/staff/threads/${threadId}/read`, { message_ids: messageIds }, key);
}

/** `POST /threads/:id/read` (W5): no body (as the 9.1.0 app sends it), or `{up_to_seq}`. */
export function ownerRead(
  app: AnyApp,
  threadId: string,
  body?: Record<string, unknown>,
  key: string = `read-${randomUUID()}`,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/threads/${threadId}/read`,
    headers: { 'idempotency-key': key },
    ...(body !== undefined ? { payload: body } : {}),
  });
}

export async function getJson<T>(app: AnyApp, url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url });
  if (res.statusCode !== 200) throw new Error(`GET ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

/** Live messages in a thread, straight from the table (the count a test trusts). */
export async function messageRows(
  threadId: string,
): Promise<
  Array<{ id: string; text: string; thread_seq: number; client_message_id: string | null }>
> {
  const { rows } = await db.execute<{
    id: string;
    text: string;
    thread_seq: number;
    client_message_id: string | null;
  }>(
    sql`SELECT id::text, text, thread_seq, client_message_id::text FROM messages
         WHERE thread_id = ${threadId} AND expired_at IS NULL ORDER BY thread_seq`,
  );
  return rows;
}

/**
 * A media row a STAFFER uploaded for this family (`created_by = 'staff'`, purpose
 * `message-attachment`, stamped with the family's owner id): the shape pass 2's upload arm
 * writes. Planted directly because that arm is not pass 1's.
 */
export async function plantStaffMedia(ownerId: string = FIXTURE_IDS.ownerId): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO media_assets (id, owner_id, kind, purpose, object_key, content_type, bytes, created_by)
    VALUES (${id}, ${ownerId}, 'image', 'message-attachment', ${`message-attachment/staff/${id}`},
            'image/jpeg', 1024, 'staff')`);
  return id;
}

/** A family's own upload, planted the way `POST /media` stores it. */
export async function plantOwnerMedia(ownerId: string = FIXTURE_IDS.ownerId): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO media_assets (id, owner_id, kind, purpose, object_key, content_type, bytes, created_by)
    VALUES (${id}, ${ownerId}, 'image', 'message-attachment', ${`message-attachment/owner-${ownerId}/${id}`},
            'image/jpeg', 1024, 'owner')`);
  return id;
}

/**
 * Hold `sqlText`'s lock on a connection of its own while `fire()` starts `waiters` requests,
 * wait until every one of them is blocked on it, then release: the requests provably overlap
 * (both are past their lookups and inside their transactions) on real pooled connections.
 */
export async function overlapping<T>(
  lockSql: string,
  params: unknown[],
  waiters: number,
  fire: () => Promise<T>[],
): Promise<T[]> {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(lockSql, params);
    const pending = fire();
    await waitForBlockedBackends(waiters);
    await holder.query('ROLLBACK');
    return await Promise.all(pending);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
}

/** The fixture family's school threads (their messages cascade), and the media tests planted. */
export async function removeSchoolThreads(ownerId: string = FIXTURE_IDS.ownerId): Promise<void> {
  await db.execute(sql`DELETE FROM threads WHERE owner_id = ${ownerId} AND addressed_to_school`);
}

export async function removePlantedMedia(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(
    sql`DELETE FROM message_attachments WHERE media_asset_id = ANY(${sql.param(ids)}::uuid[])`,
  );
  await db.execute(sql`DELETE FROM media_assets WHERE id = ANY(${sql.param(ids)}::uuid[])`);
}

/** A message the test sends into a fixture thread, removed afterwards (the fixture keeps its seven). */
export async function removeMessagesExcept(
  threadId: string,
  keep: readonly string[],
): Promise<void> {
  await db.execute(
    sql`DELETE FROM messages WHERE thread_id = ${threadId} AND NOT (id = ANY(${sql.param([...keep])}::uuid[]))`,
  );
}

/**
 * What a staff message to a PLANTED family leaves that names a fixture staffer: the staff messages
 * in her threads, her feed rows (`notifications.sender_staff_id`) and the threads a staffer started
 * with her. Removed after each
 * test, because the fixture's teardown deletes its staff before a file's own `after` removes the
 * planted families.
 */
export async function removePlantedStaffTraces(): Promise<void> {
  await db.execute(sql`
    DELETE FROM messages m USING threads t
     WHERE t.id = m.thread_id AND t.owner_id <> ${FIXTURE_IDS.ownerId} AND m.sender_kind = 'staff'`);
  await db.execute(sql`
    DELETE FROM notifications WHERE owner_id <> ${FIXTURE_IDS.ownerId} AND sender_staff_id IS NOT NULL`);
  await db.execute(sql`
    DELETE FROM threads WHERE owner_id <> ${FIXTURE_IDS.ownerId} AND NOT addressed_to_school`);
}
