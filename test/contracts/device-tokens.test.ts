import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { deviceTokens } from '../../src/db/schema/schema.js';
import { registerDeviceTokensRoute } from '../../src/routes/device-tokens.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import type { Principal } from '../../src/auth/principal.js';

/**
 * Day-18c contract tests for the device-token registration surface:
 *   - POST /device-tokens — UPSERT by (owner, expo_push_token). Idempotent
 *     at the DB layer (re-register touches the live row, never duplicates)
 *     AND at the request layer (replay returns the stored 201).
 *   - DELETE /device-tokens/:token — soft-expire by token; 204 on success,
 *     404 for missing / not-yours.
 *
 * Both verbs are owner-scoped — staff principals get 403. The fixture seeds
 * no device_tokens rows, so each test mints a unique token and cleans up
 * after itself (rows also cascade on the owner teardown between files).
 */

registerFixtureHooks();

function buildApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerDeviceTokensRoute(app, { authenticate });
  return { app };
}

function freshToken(): string {
  return `ExponentPushToken[${randomUUID()}]`;
}

async function liveRowCount(token: string): Promise<number> {
  const rows = await db
    .select({ id: deviceTokens.id })
    .from(deviceTokens)
    .where(
      and(
        eq(deviceTokens.ownerId, FIXTURE_IDS.ownerId),
        eq(deviceTokens.expoPushToken, token),
        isNull(deviceTokens.expiredAt),
      ),
    );
  return rows.length;
}

async function cleanup(token: string): Promise<void> {
  await db.delete(deviceTokens).where(eq(deviceTokens.expoPushToken, token));
}

// ──────────────────────────────────────────────────────────────────────────
// POST /device-tokens
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /device-tokens — registers a live token + returns the wire shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const token = freshToken();
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/device-tokens',
      headers: { 'idempotency-key': `dt-${randomUUID()}` },
      payload: { token, platform: 'ios' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as {
      id: string;
      owner_id: string;
      token: string;
      platform: string;
      registered_at: string;
    };
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.owner_id, FIXTURE_IDS.ownerId);
    assert.equal(body.token, token);
    assert.equal(body.platform, 'ios');
    // registered_at is an ISO-8601 instant (created_at → wire rename).
    assert.equal(new Date(body.registered_at).toISOString(), body.registered_at);
    assert.equal(await liveRowCount(token), 1);
    await cleanup(token);
  },
);

test(
  'POST /device-tokens — re-register (different key, same token) upserts to ONE live row',
  SKIP_WHEN_NO_DB,
  async () => {
    const token = freshToken();
    const { app } = buildApp();
    const first = await app.inject({
      method: 'POST',
      url: '/device-tokens',
      headers: { 'idempotency-key': `dt-a-${randomUUID()}` },
      payload: { token, platform: 'ios' },
    });
    assert.equal(first.statusCode, 201);
    // A genuinely distinct request (new key) with the same token must not
    // create a duplicate live row — the partial-unique upsert collapses it.
    const second = await app.inject({
      method: 'POST',
      url: '/device-tokens',
      headers: { 'idempotency-key': `dt-b-${randomUUID()}` },
      payload: { token, platform: 'android' },
    });
    assert.equal(second.statusCode, 201);
    assert.equal(await liveRowCount(token), 1, 'still exactly one live row after re-register');
    // created_at preserved across the re-touch; platform updated in place.
    assert.equal(
      (second.json() as { id: string }).id,
      (first.json() as { id: string }).id,
      'same row id (touched, not replaced)',
    );
    assert.equal((second.json() as { platform: string }).platform, 'android');
    assert.equal(
      (second.json() as { registered_at: string }).registered_at,
      (first.json() as { registered_at: string }).registered_at,
      'registered_at unchanged on re-touch',
    );
    await cleanup(token);
  },
);

test(
  'POST /device-tokens — re-register AFTER revoke inserts a fresh live row',
  SKIP_WHEN_NO_DB,
  async () => {
    // The partial-unique index is partial (WHERE expired_at IS NULL) precisely
    // so a device that revokes then re-grants push gets a new live row rather
    // than colliding with its own tombstone. This proves that path.
    const token = freshToken();
    const { app } = buildApp();
    const first = await app.inject({
      method: 'POST',
      url: '/device-tokens',
      headers: { 'idempotency-key': `dt-rr-1-${randomUUID()}` },
      payload: { token, platform: 'ios' },
    });
    assert.equal(first.statusCode, 201);
    const firstId = (first.json() as { id: string }).id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/device-tokens/${encodeURIComponent(token)}`,
      headers: { 'idempotency-key': `dt-rr-del-${randomUUID()}` },
    });
    assert.equal(del.statusCode, 204);
    assert.equal(await liveRowCount(token), 0, 'no live row after revoke');

    const second = await app.inject({
      method: 'POST',
      url: '/device-tokens',
      headers: { 'idempotency-key': `dt-rr-2-${randomUUID()}` },
      payload: { token, platform: 'ios' },
    });
    assert.equal(second.statusCode, 201);
    const secondId = (second.json() as { id: string }).id;
    assert.notEqual(secondId, firstId, 'a fresh row, not the revoked tombstone');
    assert.equal(await liveRowCount(token), 1, 'exactly one live row again');
    await cleanup(token);
  },
);

test(
  'POST /device-tokens — replay with same key returns identical body, no new row',
  SKIP_WHEN_NO_DB,
  async () => {
    const token = freshToken();
    const { app } = buildApp();
    const key = `dt-replay-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/device-tokens',
      headers: { 'idempotency-key': key },
      payload: { token, platform: 'ios' },
    });
    assert.equal(first.statusCode, 201);
    const replay = await app.inject({
      method: 'POST',
      url: '/device-tokens',
      headers: { 'idempotency-key': key },
      payload: { token, platform: 'ios' },
    });
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), first.json());
    assert.equal(await liveRowCount(token), 1);
    await cleanup(token);
  },
);

test('POST /device-tokens — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await app.inject({
    method: 'POST',
    url: '/device-tokens',
    headers: { 'idempotency-key': `dt-staff-${randomUUID()}` },
    payload: { token: freshToken(), platform: 'ios' },
  });
  assert.equal(res.statusCode, 403);
});

test('POST /device-tokens — missing Idempotency-Key → 400', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/device-tokens',
    payload: { token: freshToken(), platform: 'ios' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /device-tokens — invalid platform → 400', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/device-tokens',
    headers: { 'idempotency-key': `dt-bad-${randomUUID()}` },
    payload: { token: freshToken(), platform: 'web' },
  });
  assert.equal(res.statusCode, 400);
});

// ──────────────────────────────────────────────────────────────────────────
// DELETE /device-tokens/:token
// ──────────────────────────────────────────────────────────────────────────

async function seedLiveToken(token: string): Promise<void> {
  await db.insert(deviceTokens).values({
    ownerId: FIXTURE_IDS.ownerId,
    expoPushToken: token,
    platform: 'ios',
  });
}

test(
  'DELETE /device-tokens/:token — soft-expires the live row → 204',
  SKIP_WHEN_NO_DB,
  async () => {
    const token = freshToken();
    await seedLiveToken(token);
    const { app } = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/device-tokens/${encodeURIComponent(token)}`,
      headers: { 'idempotency-key': `dt-del-${randomUUID()}` },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(await liveRowCount(token), 0, 'no live row remains');
    const [row] = await db
      .select({ expiredAt: deviceTokens.expiredAt })
      .from(deviceTokens)
      .where(eq(deviceTokens.expoPushToken, token));
    assert.ok(row?.expiredAt !== null && row?.expiredAt !== undefined, 'expired_at stamped');
    await cleanup(token);
  },
);

test('DELETE /device-tokens/:token — unknown token → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp();
  const res = await app.inject({
    method: 'DELETE',
    url: `/device-tokens/${encodeURIComponent(freshToken())}`,
    headers: { 'idempotency-key': `dt-del-404-${randomUUID()}` },
  });
  assert.equal(res.statusCode, 404);
});

test('DELETE /device-tokens/:token — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = buildApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await app.inject({
    method: 'DELETE',
    url: `/device-tokens/${encodeURIComponent(freshToken())}`,
    headers: { 'idempotency-key': `dt-del-403-${randomUUID()}` },
  });
  assert.equal(res.statusCode, 403);
});

test('DELETE /device-tokens/:token — replay with same key stays 204', SKIP_WHEN_NO_DB, async () => {
  const token = freshToken();
  await seedLiveToken(token);
  const { app } = buildApp();
  const key = `dt-del-replay-${randomUUID()}`;
  const first = await app.inject({
    method: 'DELETE',
    url: `/device-tokens/${encodeURIComponent(token)}`,
    headers: { 'idempotency-key': key },
  });
  assert.equal(first.statusCode, 204);
  const replay = await app.inject({
    method: 'DELETE',
    url: `/device-tokens/${encodeURIComponent(token)}`,
    headers: { 'idempotency-key': key },
  });
  assert.equal(replay.statusCode, 204, 'replay returns the stored 204, not a fresh 404');
  await cleanup(token);
});
