import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/**
 * **CORS for the staff portal** (S01; design §2.10, design.md:4674-4677;
 * DECISIONS 49).
 *
 * The portal is served from its own origin and calls this API with a bearer
 * token in a header, so the browser preflights every PATCH and every request
 * that carries `Authorization` or `Idempotency-Key`. The API answers the
 * preflight for the origins in `PORTAL_ORIGIN` (comma-separated, never `*`),
 * for GET/POST/PATCH/PUT/DELETE and exactly the three request headers the
 * portal sends — and never with `Access-Control-Allow-Credentials`, because
 * nothing the portal sends is a cookie.
 *
 * The app under test is the real `buildApp()`, so the registration — not a
 * stand-in Fastify — is what is proven. `PORTAL_ORIGIN` is set before the
 * first import of `env.ts` (each test file runs in its own process).
 */

const PORTAL = 'https://portal.fetchd.test';
const PORTAL_PREVIEW = 'http://localhost:5173';
const STRANGER = 'https://evil.example.test';

process.env.PORTAL_ORIGIN = `${PORTAL},${PORTAL_PREVIEW}`;

let app: FastifyInstance;

before(async () => {
  const { buildApp } = await import('../src/server.js');
  app = buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

function preflight(origin: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/staff/rates',
    headers: {
      origin,
      'access-control-request-method': 'PATCH',
      'access-control-request-headers': 'authorization,idempotency-key,content-type',
    },
  });
}

test('OPTIONS from the portal origin → 204 with the allow headers, and no credentials flag', async () => {
  const res = await preflight(PORTAL);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], PORTAL);
  const methods = String(res.headers['access-control-allow-methods'])
    .split(',')
    .map((m) => m.trim());
  assert.deepEqual(methods.sort(), ['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
  const allowed = String(res.headers['access-control-allow-headers'])
    .split(',')
    .map((h) => h.trim().toLowerCase());
  assert.deepEqual(allowed.sort(), ['authorization', 'content-type', 'idempotency-key']);
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
});

test('every origin in the comma-separated list is allowed, each echoed alone', async () => {
  const res = await preflight(PORTAL_PREVIEW);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], PORTAL_PREVIEW);
});

test('OPTIONS from another origin → no Access-Control-Allow-Origin', async () => {
  const res = await preflight(STRANGER);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
});

test('the actual (non-preflight) response carries the allow header for the portal only', async () => {
  // No bearer: the auth guard answers 401, and the CORS header must ride the
  // refusal too, or the browser hides the 401 from the portal as a network error.
  const fromPortal = await app.inject({ method: 'GET', url: '/me', headers: { origin: PORTAL } });
  assert.equal(fromPortal.statusCode, 401);
  assert.equal(fromPortal.headers['access-control-allow-origin'], PORTAL);

  const fromStranger = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { origin: STRANGER },
  });
  assert.equal(fromStranger.headers['access-control-allow-origin'], undefined);
});

// ── The allow-list's boot contract ───────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  NODE_ENV: 'staging', // no .env files are loaded outside development/test
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://user:pass@db.invalid:5432/postgres',
  REDIS_URL: 'redis://redis.invalid:6379',
  SUPABASE_JWKS_URL: 'https://project.invalid/auth/v1/.well-known/jwks.json',
  SUPABASE_JWT_AUD: 'authenticated',
  SUPABASE_JWT_ISS: 'https://project.invalid/auth/v1',
  SUPABASE_AUTH_WEBHOOK_SECRET: 'whsec_placeholder',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
  SCHEDULER_WEBHOOK_SECRET: 'scheduler_placeholder',
  R2_ACCOUNT_ID: 'placeholder',
  R2_ACCESS_KEY_ID: 'placeholder',
  R2_SECRET_ACCESS_KEY: 'placeholder',
  R2_BUCKET: 'nwa-media-test',
};

function bootEnv(portalOrigin: string | undefined) {
  const env = {
    ...BASE_ENV,
    ...(portalOrigin === undefined ? {} : { PORTAL_ORIGIN: portalOrigin }),
  };
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      "const { env } = await import('./src/env.js'); process.stdout.write(JSON.stringify(env.PORTAL_ORIGIN));",
    ],
    { cwd: REPO_ROOT, env, encoding: 'utf-8' },
  );
}

test('control: a list of exact origins boots and parses to the list', () => {
  const boot = bootEnv(` ${PORTAL} , ${PORTAL_PREVIEW} `);
  assert.equal(boot.status, 0, boot.stderr);
  assert.deepEqual(JSON.parse(boot.stdout), [PORTAL, PORTAL_PREVIEW]);
});

test('unset PORTAL_ORIGIN boots with an empty allow-list (no cross-origin caller is allowed)', () => {
  const boot = bootEnv(undefined);
  assert.equal(boot.status, 0, boot.stderr);
  assert.deepEqual(JSON.parse(boot.stdout), []);
});

test("PORTAL_ORIGIN='*' refuses to boot", () => {
  const boot = bootEnv('*');
  assert.equal(boot.status, 1, boot.stdout);
  assert.match(boot.stderr, /PORTAL_ORIGIN/);
});

test('an entry that is not an exact origin (path, trailing slash) refuses to boot', () => {
  for (const bad of [`${PORTAL}/`, `${PORTAL}/app`, 'portal.fetchd.test']) {
    const boot = bootEnv(bad);
    assert.equal(boot.status, 1, `${bad} booted: ${boot.stdout}`);
    assert.match(boot.stderr, /PORTAL_ORIGIN/);
  }
});
