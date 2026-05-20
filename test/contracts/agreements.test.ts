import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { registerAgreementsRoute } from '../../src/routes/agreements.js';
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
  'GET /agreements byte-matches the catalog + signed-current-version derivation shape',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    const { app, authenticate } = makeContractApp({
      kind: 'owner',
      ownerId: FIXTURE_IDS.ownerId,
      supabaseUid: FIXTURE_IDS.ownerSupabaseUid,
    });
    registerAgreementsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/agreements' });
    if (res.statusCode !== 200) {
      throw new Error(`/agreements returned ${res.statusCode}: ${res.body}`);
    }

    const actual = res.json();
    const expected = loadSnapshot('agreements');
    assert.deepStrictEqual(actual, expected);
  },
);
