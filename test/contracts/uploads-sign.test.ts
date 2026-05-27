import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerUploadsSignRoute } from '../../src/routes/uploadsSign.js';
import { FIXTURE_OWNER_PRINCIPAL, SKIP_WHEN_NO_DB, makeContractApp } from './_harness.js';
import { makeR2Stub } from './_r2Stub.js';

/**
 * Day-17 contract tests for POST /uploads/sign. The route is pure auth +
 * input validation + R2-seam delegation — no DB writes, no fixture
 * dependency. We DO use `SKIP_WHEN_NO_DB` since the auth plugin's error
 * mapper needs Redis up (the harness imports it).
 */

test(
  'POST /uploads/sign — valid image returns presigned PUT + server-generated key',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    const r2 = makeR2Stub();
    registerUploadsSignRoute(app, { authenticate, r2 });

    const res = await app.inject({
      method: 'POST',
      url: '/uploads/sign',
      payload: {
        purpose: 'dog-profile',
        content_type: 'image/jpeg',
        byte_size: 1024 * 100,
      },
    });

    assert.equal(res.statusCode, 200, `unexpected status: ${res.statusCode} ${res.body}`);
    const body = res.json() as {
      url: string;
      headers: Record<string, string>;
      key: string;
      expires_at: string;
    };

    // Server-generated key incorporates purpose + principal scope + uuid + extension.
    assert.match(body.key, /^dog-profile\/owner-[\w-]+\/[\w-]+\.jpg$/);
    // Returned URL is the stub's marker so callers know the seam was hit.
    assert.ok(body.url.startsWith('https://stub.r2.invalid/'), `unexpected url: ${body.url}`);
    assert.equal(body.headers['Content-Type'], 'image/jpeg');
    // expires_at is a parseable ISO instant in the future.
    assert.ok(new Date(body.expires_at).getTime() > Date.now());

    assert.equal(r2.calls.length, 1);
    assert.equal(r2.calls[0]!.method, 'signPutUrl');
    assert.equal(r2.calls[0]!.key, body.key);
  },
);

test(
  'POST /uploads/sign — owner-avatar / message-attachment / report-photo accept images',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerUploadsSignRoute(app, { authenticate, r2: makeR2Stub() });

    for (const purpose of ['owner-avatar', 'message-attachment', 'report-photo'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/uploads/sign',
        payload: { purpose, content_type: 'image/png', byte_size: 100 },
      });
      assert.equal(res.statusCode, 200, `purpose '${purpose}' should succeed: ${res.body}`);
      const body = res.json() as { key: string };
      assert.ok(body.key.startsWith(`${purpose}/`), `key prefix should match purpose '${purpose}'`);
    }
  },
);

test(
  'POST /uploads/sign — video content_type rejected for image purpose → 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerUploadsSignRoute(app, { authenticate, r2: makeR2Stub() });

    const res = await app.inject({
      method: 'POST',
      url: '/uploads/sign',
      payload: { purpose: 'dog-profile', content_type: 'video/mp4', byte_size: 100 },
    });
    assert.equal(res.statusCode, 400);
  },
);

test(
  'POST /uploads/sign — image content_type rejected for report-video → 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerUploadsSignRoute(app, { authenticate, r2: makeR2Stub() });

    const res = await app.inject({
      method: 'POST',
      url: '/uploads/sign',
      payload: { purpose: 'report-video', content_type: 'image/jpeg', byte_size: 100 },
    });
    assert.equal(res.statusCode, 400);
  },
);

test('POST /uploads/sign — byte_size over 25MB cap → 400', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerUploadsSignRoute(app, { authenticate, r2: makeR2Stub() });

  const res = await app.inject({
    method: 'POST',
    url: '/uploads/sign',
    payload: {
      purpose: 'dog-profile',
      content_type: 'image/jpeg',
      byte_size: 26 * 1024 * 1024,
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /uploads/sign — unknown purpose enum → 400', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerUploadsSignRoute(app, { authenticate, r2: makeR2Stub() });

  const res = await app.inject({
    method: 'POST',
    url: '/uploads/sign',
    payload: { purpose: 'banner-ad', content_type: 'image/jpeg', byte_size: 100 },
  });
  assert.equal(res.statusCode, 400);
});
