import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  generateSecret,
  type JWK,
} from 'jose';
import { env } from '../src/env.js';
import { AuthError } from '../src/auth/errors.js';
import { makeVerifyAccessToken } from '../src/auth/jwks.js';
import { makeAuthenticate, registerAuth, requireStaff } from '../src/auth/plugin.js';
import type { Principal } from '../src/auth/principal.js';
import { withActor } from '../src/db/tx.js';
import { sql } from 'drizzle-orm';

// --- JWKS verifier: a local key set stands in for Supabase's remote JWKS, so
// these run with zero live infra. Tokens are minted with the env's iss/aud so
// the assertions hold regardless of the concrete configured values. ---

const KID = 'test-key-1';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
const localJwks = createLocalJWKSet({ keys: [jwk] });
const verify = makeVerifyAccessToken(localJwks);

function sign(claims: { sub?: string; aud?: string; iss?: string; expSeconds?: number }) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(claims.sub ?? 'user-uuid-1')
    .setAudience(claims.aud ?? env.SUPABASE_JWT_AUD)
    .setIssuer(claims.iss ?? env.SUPABASE_JWT_ISS)
    .setIssuedAt(now)
    .setExpirationTime(claims.expSeconds ?? now + 300)
    .sign(privateKey);
}

test('verifies a well-formed Supabase token and extracts sub', async () => {
  const token = await sign({ sub: 'abc-123' });
  assert.deepEqual(await verify(token), { sub: 'abc-123' });
});

test('rejects an expired token', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign({ expSeconds: now - 60 });
  await assert.rejects(verify(token), (e) => e instanceof AuthError && e.status === 401);
});

test('rejects a wrong-audience token', async () => {
  const token = await sign({ aud: 'not-this-api' });
  await assert.rejects(
    verify(token),
    (e) => e instanceof AuthError && e.code === 'unauthenticated',
  );
});

test('rejects a wrong-issuer token', async () => {
  const token = await sign({ iss: 'https://evil.example.com/auth/v1' });
  await assert.rejects(verify(token), (e) => e instanceof AuthError);
});

test('rejects an HS256 token (algorithm-confusion defense)', async () => {
  const secret = await generateSecret('HS256');
  const now = Math.floor(Date.now() / 1000);
  const hsToken = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('attacker')
    .setAudience(env.SUPABASE_JWT_AUD)
    .setIssuer(env.SUPABASE_JWT_ISS)
    .setExpirationTime(now + 300)
    .sign(secret);
  await assert.rejects(verify(hsToken), (e) => e instanceof AuthError);
});

// --- Route guards: deps are injected, so the staff/owner gate is proven with
// no live Supabase project and no DB. ---

const OWNER: Principal = { kind: 'owner', ownerId: 'o-1', supabaseUid: 'u-owner' };
const STAFF: Principal = { kind: 'staff', staffId: 's-1', role: 'trainer', supabaseUid: 'u-staff' };

function staffGuardedApp(resolved: Principal | null) {
  const app = Fastify();
  registerAuth(app);
  const authenticate = makeAuthenticate({
    verify: async () => ({ sub: 'ignored' }),
    resolve: async () => resolved,
  });
  app.get('/staff/ping', { preHandler: [authenticate, requireStaff] }, async () => ({ ok: true }));
  return app;
}

const BEARER = { authorization: 'Bearer any-token' };

test('a [staff] route 403s an owner', async () => {
  const res = await staffGuardedApp(OWNER).inject({
    method: 'GET',
    url: '/staff/ping',
    headers: BEARER,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'forbidden');
});

test('a [staff] route admits a staff principal', async () => {
  const res = await staffGuardedApp(STAFF).inject({
    method: 'GET',
    url: '/staff/ping',
    headers: BEARER,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test('a verified-but-unprovisioned token is 403 not_provisioned', async () => {
  const res = await staffGuardedApp(null).inject({
    method: 'GET',
    url: '/staff/ping',
    headers: BEARER,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'not_provisioned');
});

test('a missing Authorization header is 401', async () => {
  const res = await staffGuardedApp(OWNER).inject({ method: 'GET', url: '/staff/ping' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'unauthenticated');
});

// --- app.actor primitive: requires a real DB. Skipped when DATABASE_URL is
// absent (keeps the CI `check` job, which has no DB, green). The round-trip is
// fully rolled back via a sentinel throw — zero writes to the live database. ---

const dbConfigured = typeof process.env.DATABASE_URL === 'string';

test(
  'withActor stamps app.actor transaction-locally',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    class Rollback extends Error {}
    let seen: string | null = null;
    await assert.rejects(
      withActor('owner:test-actor', async (tx) => {
        const r = await tx.execute(sql`select current_setting('app.actor', true) as a`);
        const a = r.rows[0]?.a;
        seen = typeof a === 'string' ? a : null;
        throw new Rollback();
      }),
      Rollback,
    );
    assert.equal(seen, 'owner:test-actor');
  },
);
