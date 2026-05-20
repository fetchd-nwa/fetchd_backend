import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRatesRoute } from '../../src/routes/rates.js';
import { FIXTURE_NOW } from './_fixture.js';
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
  'GET /rates returns the location-specific row (Fayetteville beats null-location for day-school)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: '/rates?category=day-school&location=fayetteville',
    });
    if (res.statusCode !== 200) {
      throw new Error(`/rates returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('rates-day-school-fayetteville'));
  },
);

test(
  'GET /rates falls back to the null-location row when no location-specific row exists (Bentonville → null-location)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: '/rates?category=day-school&location=bentonville',
    });
    if (res.statusCode !== 200) {
      throw new Error(`/rates returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('rates-day-school-bentonville'));
  },
);

test(
  'GET /rates honors the effective-dated window (FIXTURE_NOW=2026-05-19 returns the current $45 day-care row, not the future $50)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: '/rates?category=day-care&location=fayetteville',
    });
    if (res.statusCode !== 200) {
      throw new Error(`/rates returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('rates-day-care-current'));
  },
);

test('GET /rates returns 404 when no rate matches the category', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

  const res = await app.inject({
    method: 'GET',
    url: '/rates?category=group-class&location=fayetteville',
  });
  assert.equal(res.statusCode, 404);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'not_found');
});

test('GET /rates as staff returns the same data (catalog endpoint)', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

  const res = await app.inject({
    method: 'GET',
    url: '/rates?category=day-school&location=fayetteville',
  });
  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), loadSnapshot('rates-day-school-fayetteville'));
});

test('GET /rates with bad enum returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

  const res = await app.inject({
    method: 'GET',
    url: '/rates?category=not-real&location=fayetteville',
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

test(
  'GET /rates: a CLOSED location-specific window falls back to the active null-location row (day-care @ bentonville: $40 expired → $45 null-loc wins)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

    // Bentonville-specific day-care row exists but its effective_to closed
    // 2026-04-01 (before FIXTURE_TODAY=2026-05-19) → the effective-date
    // filter drops it; the null-location $45 row is what surfaces.
    const res = await app.inject({
      method: 'GET',
      url: '/rates?category=day-care&location=bentonville',
    });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), loadSnapshot('rates-day-care-current'));
  },
);

test(
  'GET /rates: empty-string note is OMITTED from the wire (Day-4a optional-omit rule covers null AND empty)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

    // Boarding @ fayetteville has note='' in the fixture. Wire should
    // omit the key entirely (not emit `"note": ""`).
    const res = await app.inject({
      method: 'GET',
      url: '/rates?category=boarding&location=fayetteville',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.deepStrictEqual(body, {
      category: 'boarding',
      location: 'fayetteville',
      amount_cents: 8500,
      unit: 'per-night',
      effective_from: '2026-01-01',
    });
    // Belt-and-suspenders: confirm the key isn't present at all.
    assert.equal('note' in body, false);
  },
);
