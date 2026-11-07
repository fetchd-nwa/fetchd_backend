import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { serviceRates } from '../../src/db/schema/schema.js';
import { registerRatesRoute } from '../../src/routes/rates.js';
import { EVALUATION_RATE_SEED_IDS, FIXTURE_NOW, resetServiceRates } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();
afterEach(resetServiceRates);

/**
 * A rate row this file plants: `service_rates` holds only each campus's evaluation row
 * since DAY-U23, and the fixture's teardown clears any other. The selection and the
 * mapper are category-blind, so they are proved on rows the test owns.
 */
async function plantRate(values: typeof serviceRates.$inferInsert): Promise<void> {
  await db.insert(serviceRates).values(values);
}

const FAYETTEVILLE_EVALUATION_ID = EVALUATION_RATE_SEED_IDS[0]!;
const BENTONVILLE_EVALUATION_ID = EVALUATION_RATE_SEED_IDS[1]!;

for (const category of ['day-school', 'day-care'] as const) {
  for (const location of ['fayetteville', 'bentonville'] as const) {
    test(
      `DAY-U23: GET /rates?category=${category} at ${location} is 404: a day's price is a catalog row`,
      SKIP_WHEN_NO_DB,
      async () => {
        const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
        registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

        const res = await app.inject({
          method: 'GET',
          url: `/rates?category=${category}&location=${location}`,
        });
        assert.equal(res.statusCode, 404, res.body);
        assert.equal(res.json().error.code, 'not_found');
      },
    );
  }
}

test(
  'GET /rates returns the location-specific row over a null-location row',
  SKIP_WHEN_NO_DB,
  async () => {
    await plantRate({
      category: 'evaluation',
      location: null,
      amountCents: 7000,
      unit: 'per-session',
      effectiveFrom: '2026-01-01',
    });
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: '/rates?category=evaluation&location=fayetteville',
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { location: string }).location, 'fayetteville');
    assert.equal((res.json() as { amount_cents: number }).amount_cents, 0);
  },
);

test(
  'GET /rates falls back to the null-location row when the campus row has closed, and the wire carries location null',
  SKIP_WHEN_NO_DB,
  async () => {
    await db
      .update(serviceRates)
      .set({ effectiveTo: '2026-04-01' })
      .where(eq(serviceRates.id, BENTONVILLE_EVALUATION_ID));
    await plantRate({
      category: 'evaluation',
      location: null,
      amountCents: 7000,
      unit: 'per-session',
      effectiveFrom: '2026-01-01',
    });
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: '/rates?category=evaluation&location=bentonville',
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepStrictEqual(res.json(), {
      category: 'evaluation',
      location: null,
      amount_cents: 7000,
      unit: 'per-session',
      effective_from: '2026-01-01',
    });
  },
);

test(
  'GET /rates honors the effective-dated window: FIXTURE_NOW reads the row open today, not the one scheduled after it',
  SKIP_WHEN_NO_DB,
  async () => {
    await db
      .update(serviceRates)
      .set({ effectiveTo: '2026-06-01' })
      .where(eq(serviceRates.id, FAYETTEVILLE_EVALUATION_ID));
    await plantRate({
      category: 'evaluation',
      location: 'fayetteville',
      amountCents: 5000,
      unit: 'per-session',
      effectiveFrom: '2026-06-01',
    });
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({
      method: 'GET',
      url: '/rates?category=evaluation&location=fayetteville',
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { amount_cents: number }).amount_cents, 0);
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
  const read = async (principal: Parameters<typeof makeContractApp>[0]) => {
    const { app, authenticate } = makeContractApp(principal);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });
    return app.inject({ method: 'GET', url: '/rates?category=evaluation&location=fayetteville' });
  };
  const staff = await read(FIXTURE_STAFF_PRINCIPAL);
  assert.equal(staff.statusCode, 200);
  assert.deepStrictEqual(staff.json(), (await read(FIXTURE_OWNER_PRINCIPAL)).json());
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
  'GET /rates: empty-string note is OMITTED from the wire (Day-4a optional-omit rule covers null AND empty)',
  SKIP_WHEN_NO_DB,
  async () => {
    await plantRate({
      category: 'boarding',
      location: 'fayetteville',
      amountCents: 8500,
      unit: 'per-night',
      effectiveFrom: '2026-01-01',
      note: '',
    });
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

    // Wire should omit the key entirely (not emit `"note": ""`).
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

// M3.05 (P12 B3): schema.sql seeds these two rows and the fixture keeps them,
// so an answer here is the volume's own row, not one a test planted.
for (const [location, display] of [
  ['fayetteville', 'Fayetteville'],
  ['bentonville', 'Bentonville'],
] as const) {
  test(
    `GET /rates?category=evaluation at ${location} answers amount_cents 0 from the volume's own row`,
    SKIP_WHEN_NO_DB,
    async () => {
      const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
      registerRatesRoute(app, { authenticate, now: FIXTURE_NOW });

      const res = await app.inject({
        method: 'GET',
        url: `/rates?category=evaluation&location=${location}`,
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepStrictEqual(res.json(), {
        category: 'evaluation',
        location,
        amount_cents: 0,
        unit: 'per-session',
        effective_from: '2025-01-01',
        note: `Evaluation rate, ${display}: free (M3.05 seed)`,
      });
    },
  );
}
