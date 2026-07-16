import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { creditExpirySettings } from '../../src/db/schema/schema.js';
import { creditExpirySettingsRepository } from '../../src/db/repositories/creditExpirySettingsRepository.js';
import { withActor } from '../../src/db/tx.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test(
  'GET /dogs/:id/credits returns the §B Credits wire shape with the ledger SUM (Waffles: +5 -1 = 4 school)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/credits?location=fayetteville`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/credits returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('credits-waffles'));
  },
);

test(
  'GET /dogs/:id/credits is location-scoped — Waffles at Bentonville is a different balance (Δ 2026-06-04)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/credits?location=bentonville`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/credits returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('credits-waffles-bentonville'));
  },
);

test(
  'GET /dogs/:id/credits without a location query returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: `/dogs/${FIXTURE_IDS.dog1Id}/credits` });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'GET /dogs/:id/credits emits the zero sentinel for a dog with no ledger rows (Lola)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog2Id}/credits?location=fayetteville`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`/dogs/:id/credits returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('credits-lola'));
  },
);

test(
  'GET /dogs/:id/credits for a non-existent dog returns 404 not_found',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    // A well-formed UUID that doesn't exist in the fixture.
    const res = await app.inject({
      method: 'GET',
      url: '/dogs/00000000-0000-4000-8000-000000000000/credits?location=fayetteville',
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /dogs/:id/credits as a staff principal returns 404 not_found (no id enumeration)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}/credits?location=fayetteville`,
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'not_found');
  },
);

test(
  'GET /dogs/:id/credits with a malformed id returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/dogs/not-a-uuid/credits' });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'GET /dogs/:id/credits carries the staff-tuned warning lead for its location (Δ 2026-07-16)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });

    await withActor('system:scheduler', (tx) =>
      creditExpirySettingsRepository.upsert(tx, {
        location: 'fayetteville',
        expiryWindowMonths: 12,
        warningLeadDays: 14,
        staffId: FIXTURE_IDS.staffDonavanId,
      }),
    );
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/dogs/${FIXTURE_IDS.dog1Id}/credits?location=fayetteville`,
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as { warning_lead_days: number };
      assert.equal(body.warning_lead_days, 14, 'per-location override rides the credits wire');
    } finally {
      await db
        .delete(creditExpirySettings)
        .where(eq(creditExpirySettings.location, 'fayetteville'));
    }
  },
);
