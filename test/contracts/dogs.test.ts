import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { FIXTURE_IDS, FIXTURE_NOW, seedFixture, teardownFixture } from './_fixture.js';
import { loadSnapshot, makeContractApp } from './_harness.js';

const dbConfigured = typeof process.env.DATABASE_URL === 'string';

before(async () => {
  if (dbConfigured) await seedFixture();
});

after(async () => {
  if (dbConfigured) await teardownFixture();
});

test(
  'GET /dogs byte-matches the DATA-CONTRACT §B Dog wire shape (vet?, age_months, vaccines, medications, feeding, completed_class_keys)',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    const { app, authenticate } = makeContractApp({
      kind: 'owner',
      ownerId: FIXTURE_IDS.ownerId,
      supabaseUid: FIXTURE_IDS.ownerSupabaseUid,
    });
    registerDogsRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/dogs' });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs returned ${res.statusCode}: ${res.body}`);
    }

    const actual = res.json();
    const expected = loadSnapshot('dogs');
    assert.deepStrictEqual(actual, expected);
  },
);
