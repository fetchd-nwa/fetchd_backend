import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerMediaRoute } from '../../src/routes/media.js';
import { registerMeRoute } from '../../src/routes/me.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeR2Stub, type R2Stub } from './_r2Stub.js';

/**
 * Contract tests for read-time profile/avatar image-URL resolution
 * (lib/profileImageUrls). A stored media-asset UUID resolves to a signed URL in
 * the dog/owner wire; a seed/bundled path passes through unchanged (so existing
 * byte-match snapshots stay green). The write guard rejects pointing an image
 * field at media that isn't the owner's own, expected-purpose asset.
 */

registerFixtureHooks();

async function createOwnerMedia(
  app: ReturnType<typeof makeContractApp>['app'],
  r2: R2Stub,
  payload: { purpose: string; dog_id?: string },
): Promise<string> {
  const key = `${payload.purpose}/owner-${FIXTURE_IDS.ownerId}/${randomUUID()}`;
  r2.seedObject({ key, contentType: 'image/jpeg', bytes: new Uint8Array(1024) });
  const res = await app.inject({
    method: 'POST',
    url: '/media',
    headers: { 'idempotency-key': `media-${randomUUID()}` },
    payload: { key, ...payload },
  });
  assert.equal(res.statusCode, 201, `media create failed: ${res.body}`);
  return (res.json() as { id: string }).id;
}

test(
  'PATCH /dogs + GET /dogs — uploaded dog photo resolves to a signed URL; seed path passes through',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = makeR2Stub();
    registerMediaRoute(app, { authenticate, r2 });
    registerDogsRoute(app, { authenticate, r2 });

    const mediaId = await createOwnerMedia(app, r2, {
      purpose: 'dog-profile',
      dog_id: FIXTURE_IDS.dog1Id,
    });

    const patch = await app.inject({
      method: 'PATCH',
      url: `/dogs/${FIXTURE_IDS.dog1Id}`,
      headers: { 'idempotency-key': `patch-${randomUUID()}` },
      payload: { profile_image_path: mediaId },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const patched = patch.json() as { profile_image_path: string };
    assert.ok(
      patched.profile_image_path.startsWith('https://stub.r2.invalid/'),
      `resolved url: ${patched.profile_image_path}`,
    );

    const list = await app.inject({ method: 'GET', url: '/dogs' });
    assert.equal(list.statusCode, 200);
    const dogs = list.json() as { id: string; profile_image_path: string }[];
    const dog1 = dogs.find((d) => d.id === FIXTURE_IDS.dog1Id);
    const dog2 = dogs.find((d) => d.id === FIXTURE_IDS.dog2Id);
    assert.ok(dog1!.profile_image_path.startsWith('https://stub.r2.invalid/'), 'dog1 signed');
    // dog2 has no image (NULL → '') — a non-UUID passes through untouched.
    assert.equal(dog2!.profile_image_path, '');
  },
);

test(
  'PATCH /dogs — pointing profile_image_path at non-dog-profile media → 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = makeR2Stub();
    registerMediaRoute(app, { authenticate, r2 });
    registerDogsRoute(app, { authenticate, r2 });

    const avatarId = await createOwnerMedia(app, r2, { purpose: 'owner-avatar' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/dogs/${FIXTURE_IDS.dog1Id}`,
      headers: { 'idempotency-key': `patch-${randomUUID()}` },
      payload: { profile_image_path: avatarId },
    });
    assert.equal(res.statusCode, 422, res.body);
  },
);

test(
  'PATCH /me + GET /me — uploaded avatar resolves to a signed URL',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = makeR2Stub();
    registerMediaRoute(app, { authenticate, r2 });
    registerMeRoute(app, { authenticate, r2 });

    const avatarId = await createOwnerMedia(app, r2, { purpose: 'owner-avatar' });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { 'idempotency-key': `patch-${randomUUID()}` },
      payload: { avatar_image_path: avatarId },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    assert.ok(
      (patch.json() as { avatar_image_path: string }).avatar_image_path.startsWith(
        'https://stub.r2.invalid/',
      ),
    );

    const me = await app.inject({ method: 'GET', url: '/me' });
    assert.equal(me.statusCode, 200);
    assert.ok(
      (me.json() as { avatar_image_path: string }).avatar_image_path.startsWith(
        'https://stub.r2.invalid/',
      ),
    );
  },
);
