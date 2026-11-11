import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CreditPackageWire } from '../../src/contracts/wire.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { CATALOG_SEED_KEYS, FIXTURE_NOW } from './_fixture.js';
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
  'GET /credit-packages byte-matches the §B CreditPackage wire shape (effective-window filter, enum-order school before daycare); the fixture household has no alumni dog, so its alumni row reads withheld (5.0.0)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/credit-packages?location=fayetteville' });
    if (res.statusCode !== 200) {
      throw new Error(`/credit-packages returned ${res.statusCode}: ${res.body}`);
    }
    // The snapshot is the shared rows, which staff read bare (below); an owner's read adds
    // `withheld_reason` per row (ALUM-U11), and nothing else moves.
    const bare = loadSnapshot('credit-packages') as CreditPackageWire[];
    assert.deepStrictEqual(
      res.json(),
      bare.map((row) => (row.tier === 'alumni' ? { ...row, withheld_reason: 'alumni-only' } : row)),
    );
  },
);

test(
  'GET /credit-packages as staff returns the same data (catalog endpoint)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/credit-packages?location=fayetteville' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), loadSnapshot('credit-packages'));
  },
);

test(
  'GET /credit-packages?location=bentonville returns the Bentonville catalog (per-location pricing Δ 2026-06-04)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/credit-packages?location=bentonville' });
    if (res.statusCode !== 200) {
      throw new Error(`/credit-packages returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('credit-packages-bentonville'));
  },
);

test(
  'CRED-U07: the two campuses list the ten seeded rows, every one complete and buyable',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });

    const rows: CreditPackageWire[] = [];
    for (const location of ['fayetteville', 'bentonville']) {
      const res = await app.inject({
        method: 'GET',
        url: `/credit-packages?location=${location}`,
      });
      assert.equal(res.statusCode, 200, res.body);
      rows.push(...(res.json() as CreditPackageWire[]));
    }
    const seeded = rows.filter((r) => CATALOG_SEED_KEYS.includes(r.key));
    assert.equal(seeded.length, 10);
    assert.deepEqual(new Set(seeded.map((r) => r.expiry_months)), new Set([1]));
    assert.deepEqual(
      seeded.filter((r) => r.single_day).map((r) => [r.key, r.price_cents, r.credits]),
      [
        ['single-day-school-fayetteville', 6000, 1],
        ['single-day-school-bentonville', 6000, 1],
        ['single-day-daycare-bentonville', 3500, 1],
      ],
    );
    assert.deepEqual(
      seeded.filter((r) => r.tier === 'alumni').map((r) => [r.key, r.location, r.mode]),
      [['school-alumni-10-fayetteville', 'fayetteville', 'school']],
    );
    assert.equal(
      rows.some((r) => r.mode === 'daycare' && r.location === 'fayetteville'),
      false,
      'no daycare pack sells at Fayetteville',
    );
  },
);

test(
  'GET /credit-packages without a location query returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/credit-packages' });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'GET /credit-packages honors the effective-dated window (Δ 2026-06-08): test-school-5 @ FIXTURE_NOW returns the current $250 price — exactly one row for the key, not the superseded $220 or future $280 window',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditPackagesRoute(app, { authenticate, now: FIXTURE_NOW });

    const res = await app.inject({ method: 'GET', url: '/credit-packages?location=fayetteville' });
    assert.equal(res.statusCode, 200);
    const rows = res.json() as { key: string; price_cents: number }[];

    const school5 = rows.filter((r) => r.key === 'test-school-5');
    assert.equal(school5.length, 1, 'exactly one live window per key');
    assert.equal(
      school5[0]!.price_cents,
      25_000,
      'the current window, not 22000 (past) or 28000 (future)',
    );
  },
);
