import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { registerMeRoute } from '../../src/routes/me.js';
import { FIXTURE_IDS, seedFixture, teardownFixture } from './_fixture.js';
import { loadSnapshot, makeContractApp } from './_harness.js';

const dbConfigured = typeof process.env.DATABASE_URL === 'string';

before(async () => {
  if (dbConfigured) await seedFixture();
});

after(async () => {
  if (dbConfigured) await teardownFixture();
});

test(
  'GET /me byte-matches the DATA-CONTRACT §B Owner wire shape',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    const { app, authenticate } = makeContractApp({
      kind: 'owner',
      ownerId: FIXTURE_IDS.ownerId,
      supabaseUid: FIXTURE_IDS.ownerSupabaseUid,
    });
    registerMeRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/me' });
    assert.equal(res.statusCode, 200);

    const actual = res.json();
    const expected = loadSnapshot('me');
    assert.deepStrictEqual(actual, expected);
  },
);
