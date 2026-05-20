import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { registerVetsRoute } from '../../src/routes/vets.js';
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
  'GET /vets?q=banfield byte-matches the DATA-CONTRACT §B Vet wire shape',
  { skip: dbConfigured ? false : 'DATABASE_URL not set' },
  async () => {
    const { app, authenticate } = makeContractApp({
      kind: 'owner',
      ownerId: FIXTURE_IDS.ownerId,
      supabaseUid: FIXTURE_IDS.ownerSupabaseUid,
    });
    registerVetsRoute(app, { authenticate });

    // Case-insensitive substring on `vets.name` — fixture row is
    // "Banfield — Fayetteville". The seed catalog may add more rows over
    // time, but the `q` filter is narrow enough to isolate the fixture.
    const res = await app.inject({ method: 'GET', url: '/vets?q=banfield' });
    if (res.statusCode !== 200) {
      throw new Error(`/vets returned ${res.statusCode}: ${res.body}`);
    }

    const actual = res.json();
    const expected = loadSnapshot('vets');
    assert.deepStrictEqual(actual, expected);
  },
);
