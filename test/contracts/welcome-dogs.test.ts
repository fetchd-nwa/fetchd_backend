import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { owners } from '../../src/db/schema/schema.js';
import { registerWelcomeDogsRoute } from '../../src/routes/welcomeDogs.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeR2Stub } from './_r2Stub.js';

/**
 * `GET /welcome-dogs` `[public]` — the pre-login welcome gallery. Public (no
 * auth), opt-out by owner (`owners.show_dogs_on_welcome`, default true),
 * minimal-PII (id/name/photo only). The route ignores auth; the harness app
 * still needs a principal to construct, so we pass the fixture owner.
 */
registerFixtureHooks();

function buildApp() {
  const { app } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerWelcomeDogsRoute(app, { r2: makeR2Stub() });
  return app;
}

test(
  'GET /welcome-dogs — public, returns opted-in owners’ live dogs (id/name/photo only)',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = buildApp();
    // No auth header — the route is public.
    const res = await app.inject({ method: 'GET', url: '/welcome-dogs' });
    assert.equal(res.statusCode, 200, res.body);

    const body = res.json() as Array<Record<string, unknown>>;
    const waffles = body.find((d) => d.name === 'Waffles');
    assert.ok(waffles, 'fixture owner is opted in by default → their dogs appear');
    // Minimal-PII contract: exactly these three keys, nothing identifying.
    assert.deepEqual(Object.keys(waffles).sort(), ['id', 'name', 'photo']);
    assert.equal(typeof waffles.photo, 'string');
  },
);

test('GET /welcome-dogs — excludes an opted-out owner’s dogs', SKIP_WHEN_NO_DB, async () => {
  await db
    .update(owners)
    .set({ showDogsOnWelcome: false })
    .where(eq(owners.id, FIXTURE_IDS.ownerId));
  try {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/welcome-dogs' });
    assert.equal(res.statusCode, 200);
    const names = (res.json() as Array<{ name: string }>).map((d) => d.name);
    assert.ok(!names.includes('Waffles'), 'opted-out owner’s dogs are hidden');
    assert.ok(!names.includes('Lola'), 'opted-out owner’s dogs are hidden');
  } finally {
    // Restore the default so downstream tests in the file see the opted-in state.
    await db
      .update(owners)
      .set({ showDogsOnWelcome: true })
      .where(eq(owners.id, FIXTURE_IDS.ownerId));
  }
});
