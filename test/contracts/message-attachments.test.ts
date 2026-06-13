import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { registerMediaRoute } from '../../src/routes/media.js';
import { registerThreadsRoute } from '../../src/routes/threads.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeR2Stub, type R2Stub } from './_r2Stub.js';

/**
 * Contract tests for message attachments (post-Day-19e). Owners attach
 * photos/videos uploaded through the existing media pipeline; the message
 * send path links them and the message wire emits per-attachment signed URLs.
 *
 * Coverage:
 *  - send text + photo + video → 201, wire.attachments [image, video] w/ urls;
 *    GET /threads/:id/messages reflects them.
 *  - attachment-only message (no text) → 201, text=''.
 *  - cross-purpose media (dog-profile) → 422; non-existent media → 404;
 *    fully-empty send → 400.
 *  - a video message-attachment is stored kind='video' (the content-type fix).
 *
 * The R2 stub is injected into BOTH routes; DB writes are real.
 */

registerFixtureHooks();

/** Upload a media asset of the given purpose as the fixture owner; return its id. */
async function createOwnerMedia(
  app: ReturnType<typeof makeContractApp>['app'],
  r2: R2Stub,
  payload: { purpose: string; dog_id?: string },
  contentType: string,
): Promise<string> {
  const key = `${payload.purpose}/owner-${FIXTURE_IDS.ownerId}/${randomUUID()}`;
  r2.seedObject({ key, contentType, bytes: new Uint8Array(1024) });
  const res = await app.inject({
    method: 'POST',
    url: '/media',
    headers: { 'idempotency-key': `media-${randomUUID()}` },
    payload: { key, ...payload },
  });
  assert.equal(res.statusCode, 201, `media create failed: ${res.body}`);
  return (res.json() as { id: string }).id;
}

function appWithRoutes(): { app: ReturnType<typeof makeContractApp>['app']; r2: R2Stub } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const r2 = makeR2Stub();
  registerMediaRoute(app, { authenticate, r2 });
  registerThreadsRoute(app, { authenticate, r2 });
  return { app, r2 };
}

type MessageWireBody = {
  id: string;
  text: string;
  attachments?: {
    media_id: string;
    kind: 'image' | 'video';
    url: string;
    width: number | null;
    height: number | null;
    blurhash: string | null;
    duration_ms: number | null;
  }[];
};

test(
  'POST /threads/:id/messages — text + photo + video: 201 + signed attachment wire',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, r2 } = appWithRoutes();
    const photoId = await createOwnerMedia(
      app,
      r2,
      { purpose: 'message-attachment' },
      'image/jpeg',
    );
    const videoId = await createOwnerMedia(app, r2, { purpose: 'message-attachment' }, 'video/mp4');

    const res = await app.inject({
      method: 'POST',
      url: `/threads/${FIXTURE_IDS.thread1Id}/messages`,
      headers: { 'idempotency-key': `send-${randomUUID()}` },
      payload: { text: 'here you go', attachment_media_ids: [photoId, videoId] },
    });

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as MessageWireBody;
    assert.equal(body.text, 'here you go');
    assert.ok(body.attachments, 'attachments present');
    assert.equal(body.attachments!.length, 2);
    // Order preserved as sent.
    assert.deepEqual(
      body.attachments!.map((a) => a.media_id),
      [photoId, videoId],
    );
    assert.deepEqual(
      body.attachments!.map((a) => a.kind),
      ['image', 'video'],
    );
    for (const attachment of body.attachments!) {
      assert.ok(
        attachment.url.startsWith('https://stub.r2.invalid/'),
        `signed url: ${attachment.url}`,
      );
    }

    // The read endpoint reflects the same attachments.
    const list = await app.inject({
      method: 'GET',
      url: `/threads/${FIXTURE_IDS.thread1Id}/messages`,
    });
    assert.equal(list.statusCode, 200);
    const messages = list.json() as MessageWireBody[];
    const sent = messages.find((m) => m.id === body.id);
    assert.ok(sent, 'sent message is in the thread');
    assert.equal(sent!.attachments?.length, 2);
  },
);

test(
  'POST /threads/:id/messages — attachment-only (no text): 201 + text=""',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, r2 } = appWithRoutes();
    const photoId = await createOwnerMedia(app, r2, { purpose: 'message-attachment' }, 'image/png');

    const res = await app.inject({
      method: 'POST',
      url: `/threads/${FIXTURE_IDS.thread1Id}/messages`,
      headers: { 'idempotency-key': `send-${randomUUID()}` },
      payload: { attachment_media_ids: [photoId] },
    });

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as MessageWireBody;
    assert.equal(body.text, '');
    assert.equal(body.attachments?.length, 1);
  },
);

test('POST /threads/:id/messages — wrong-purpose media → 422', SKIP_WHEN_NO_DB, async () => {
  const { app, r2 } = appWithRoutes();
  // A dog-profile upload is the owner's, but it isn't message media.
  const dogProfileId = await createOwnerMedia(
    app,
    r2,
    { purpose: 'dog-profile', dog_id: FIXTURE_IDS.dog1Id },
    'image/jpeg',
  );

  const res = await app.inject({
    method: 'POST',
    url: `/threads/${FIXTURE_IDS.thread1Id}/messages`,
    headers: { 'idempotency-key': `send-${randomUUID()}` },
    payload: { text: 'nope', attachment_media_ids: [dogProfileId] },
  });
  assert.equal(res.statusCode, 422, res.body);
});

test('POST /threads/:id/messages — non-existent media → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = appWithRoutes();
  const res = await app.inject({
    method: 'POST',
    url: `/threads/${FIXTURE_IDS.thread1Id}/messages`,
    headers: { 'idempotency-key': `send-${randomUUID()}` },
    payload: { text: 'ghost', attachment_media_ids: [randomUUID()] },
  });
  assert.equal(res.statusCode, 404, res.body);
});

test(
  'POST /threads/:id/messages — empty (no text, no attachments) → 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = appWithRoutes();
    const res = await app.inject({
      method: 'POST',
      url: `/threads/${FIXTURE_IDS.thread1Id}/messages`,
      headers: { 'idempotency-key': `send-${randomUUID()}` },
      payload: {},
    });
    assert.equal(res.statusCode, 400, res.body);
  },
);
