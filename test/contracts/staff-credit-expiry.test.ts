import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { charges, creditExpirySettings, creditLedger } from '../../src/db/schema/schema.js';
import { creditExpirySettingsRepository } from '../../src/db/repositories/creditExpirySettingsRepository.js';
import { DEFAULT_CREDIT_EXPIRY_MONTHS } from '../../src/lib/creditExpiry.js';
import { pgTimestampToIso } from '../../src/lib/pgTimestamp.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerStaffCreditExpiryRoute } from '../../src/routes/staffCreditExpiry.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import type { CreditExpirySettingWire } from '../../src/contracts/wire.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';

/**
 * Phase-2 credit-expiry settings tests (2026-06-20):
 *   - GET  /staff/credit-expiry-settings   list org-default + overrides
 *   - POST /staff/credit-expiry-settings   upsert one row by location
 *   - resolveExpiryWindowMonths fallback chain (override → org-default → 12)
 *   - the 3 grant sites stamp the RESOLVED window
 *   - NON-RETROACTIVE: a settings change never re-stamps an existing lot
 *   - single-credit pack still never-expires (covered in credit-expiry-lots.test)
 *
 * credit_expiry_settings ships with one seeded org-default row (NULL, 12, 60).
 * Each test resets to that seed first so override rows don't bleed between tests.
 */

registerFixtureHooks();

const SEEDED_WINDOW_MONTHS = 12;
const SEEDED_WARNING_LEAD_DAYS = 60;

/** Reset credit_expiry_settings to its seeded org-default — drop EVERY row
 * (org-default + overrides), reinsert the (NULL, 12, 60) seed, and null its
 * `updated_by` so the "seeded default" signal stays honest for GET tests. */
async function resetCreditExpirySettings(): Promise<void> {
  await db.delete(creditExpirySettings);
  await db.insert(creditExpirySettings).values({
    location: null,
    expiryWindowMonths: SEEDED_WINDOW_MONTHS,
    warningLeadDays: SEEDED_WARNING_LEAD_DAYS,
    updatedByStaffId: null,
  });
}

function staffApp(principal: Principal = FIXTURE_STAFF_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffCreditExpiryRoute(app, { authenticate });
  return { app };
}

function purchaseApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerCreditPackagesRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app };
}

async function cleanupChargesAndLedger(): Promise<void> {
  await db.delete(creditLedger).where(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

// Was a hand mirror of the route's private wire type; contract-owned since
// 1.13.0. (This file is type-erased at runtime — the alias documents intent,
// it does not check anything.)
type SettingWire = CreditExpirySettingWire;

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/credit-expiry-settings
// ──────────────────────────────────────────────────────────────────────────

test(
  'GET /staff/credit-expiry-settings — returns the seeded org-default (location null, 12mo, 60d)',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    const { app } = staffApp();
    const res = await app.inject({ method: 'GET', url: '/staff/credit-expiry-settings' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as SettingWire[];
    assert.equal(body.length, 1, 'only the seeded org-default after reset');
    const orgDefault = body[0]!;
    assert.equal(orgDefault.location, null, 'org-default row has null location');
    assert.equal(orgDefault.expiry_window_months, SEEDED_WINDOW_MONTHS);
    assert.equal(orgDefault.warning_lead_days, SEEDED_WARNING_LEAD_DAYS);
    assert.equal(orgDefault.updated_by_staff_id, null, 'seeded => updated_by null');
    assert.match(orgDefault.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  },
);

test('GET /staff/credit-expiry-settings — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({ method: 'GET', url: '/staff/credit-expiry-settings' });
  assert.equal(res.statusCode, 403, res.body);
});

test(
  'GET /staff/credit-expiry-settings — org-default sorts first, then overrides',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    const { app } = staffApp();
    const post = await app.inject({
      method: 'POST',
      url: '/staff/credit-expiry-settings',
      headers: { 'idempotency-key': `ces-${randomUUID()}` },
      payload: { location: 'fayetteville', expiry_window_months: 6, warning_lead_days: 14 },
    });
    assert.equal(post.statusCode, 200, post.body);

    const res = await app.inject({ method: 'GET', url: '/staff/credit-expiry-settings' });
    const body = res.json() as SettingWire[];
    assert.equal(body.length, 2);
    assert.equal(body[0]!.location, null, 'org-default first (NULLS FIRST)');
    assert.equal(body[1]!.location, 'fayetteville');
    assert.equal(body[1]!.expiry_window_months, 6);
    assert.equal(body[1]!.warning_lead_days, 14);
    assert.equal(body[1]!.updated_by_staff_id, FIXTURE_IDS.staffDonavanId);
    await resetCreditExpirySettings();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/credit-expiry-settings
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/credit-expiry-settings — upserts the org-default in place (no second NULL row)',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    const { app } = staffApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/credit-expiry-settings',
      headers: { 'idempotency-key': `ces-org-${randomUUID()}` },
      payload: { location: null, expiry_window_months: 18, warning_lead_days: 30 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as SettingWire;
    assert.equal(body.location, null);
    assert.equal(body.expiry_window_months, 18);
    assert.equal(body.warning_lead_days, 30);
    assert.equal(body.updated_by_staff_id, FIXTURE_IDS.staffDonavanId);

    // Exactly one org-default row still — the upsert updated, not inserted.
    const orgRows = await db.select().from(creditExpirySettings);
    const nullRows = orgRows.filter((r) => r.location === null);
    assert.equal(nullRows.length, 1, 'still exactly one org-default row');
    assert.equal(nullRows[0]!.expiryWindowMonths, 18);
    await resetCreditExpirySettings();
  },
);

test(
  'POST /staff/credit-expiry-settings — upserts a per-location override idempotently',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    const { app } = staffApp();
    // First write creates the row.
    const first = await app.inject({
      method: 'POST',
      url: '/staff/credit-expiry-settings',
      headers: { 'idempotency-key': `ces-loc1-${randomUUID()}` },
      payload: { location: 'bentonville', expiry_window_months: 9, warning_lead_days: 21 },
    });
    assert.equal(first.statusCode, 200, first.body);
    // Second write (different idempotency key) updates the same row.
    const second = await app.inject({
      method: 'POST',
      url: '/staff/credit-expiry-settings',
      headers: { 'idempotency-key': `ces-loc2-${randomUUID()}` },
      payload: { location: 'bentonville', expiry_window_months: 3, warning_lead_days: 7 },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((second.json() as SettingWire).expiry_window_months, 3);

    const benton = await db
      .select()
      .from(creditExpirySettings)
      .where(eq(creditExpirySettings.location, 'bentonville'));
    assert.equal(benton.length, 1, 'one bentonville row — upsert updated in place');
    assert.equal(benton[0]!.expiryWindowMonths, 3);
    await resetCreditExpirySettings();
  },
);

test('POST /staff/credit-expiry-settings — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({
    method: 'POST',
    url: '/staff/credit-expiry-settings',
    headers: { 'idempotency-key': `ces-403-${randomUUID()}` },
    payload: { location: null, expiry_window_months: 12, warning_lead_days: 60 },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test(
  'POST /staff/credit-expiry-settings — expiry_window_months <= 0 → 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/credit-expiry-settings',
      headers: { 'idempotency-key': `ces-w0-${randomUUID()}` },
      payload: { location: null, expiry_window_months: 0, warning_lead_days: 60 },
    });
    assert.equal(res.statusCode, 400, res.body);
  },
);

test(
  'POST /staff/credit-expiry-settings — warning_lead_days < 0 → 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/credit-expiry-settings',
      headers: { 'idempotency-key': `ces-lead-neg-${randomUUID()}` },
      payload: { location: 'fayetteville', expiry_window_months: 12, warning_lead_days: -1 },
    });
    assert.equal(res.statusCode, 400, res.body);
  },
);

test(
  'POST /staff/credit-expiry-settings — unknown location slug → 400',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/credit-expiry-settings',
      headers: { 'idempotency-key': `ces-loc-bad-${randomUUID()}` },
      payload: { location: 'springdale', expiry_window_months: 12, warning_lead_days: 60 },
    });
    assert.equal(res.statusCode, 400, res.body);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// resolveExpiryWindowMonths — fallback chain
// ──────────────────────────────────────────────────────────────────────────

test(
  'resolveExpiryWindowMonths — per-location override beats org-default beats code default',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    // Only the org-default exists → resolves to it.
    assert.equal(
      await creditExpirySettingsRepository.resolveExpiryWindowMonths('fayetteville'),
      SEEDED_WINDOW_MONTHS,
      'falls back to org-default when no override',
    );

    // Add a fayetteville override → that location resolves to the override, but
    // a location WITHOUT an override still resolves to the org-default.
    await db.transaction(async (tx) => {
      await creditExpirySettingsRepository.upsert(tx, {
        location: 'fayetteville',
        expiryWindowMonths: 4,
        warningLeadDays: 10,
        staffId: FIXTURE_IDS.staffDonavanId,
      });
    });
    assert.equal(
      await creditExpirySettingsRepository.resolveExpiryWindowMonths('fayetteville'),
      4,
      'override beats org-default for its own location',
    );
    assert.equal(
      await creditExpirySettingsRepository.resolveExpiryWindowMonths('bentonville'),
      SEEDED_WINDOW_MONTHS,
      'a location without an override still uses the org-default',
    );

    // Move the org-default to a value DISTINCT from the code default → proves
    // resolve reads the org-default ROW, not a baked-in constant that happens
    // to equal the seed (12 == DEFAULT_CREDIT_EXPIRY_MONTHS would hide that).
    const DISTINCT_ORG_DEFAULT_MONTHS = 18;
    await db.transaction(async (tx) => {
      await creditExpirySettingsRepository.upsert(tx, {
        location: null,
        expiryWindowMonths: DISTINCT_ORG_DEFAULT_MONTHS,
        warningLeadDays: SEEDED_WARNING_LEAD_DAYS,
        staffId: FIXTURE_IDS.staffDonavanId,
      });
    });
    assert.equal(
      await creditExpirySettingsRepository.resolveExpiryWindowMonths('bentonville'),
      DISTINCT_ORG_DEFAULT_MONTHS,
      'a location without an override reads the org-default ROW (18), not the code default',
    );

    // Delete EVERY row → only the code default can answer now. Asserting against
    // the imported constant (not a literal 12) pins the deepest fallback tier
    // unambiguously, distinct from any surviving DB row.
    await db.delete(creditExpirySettings);
    assert.equal(
      await creditExpirySettingsRepository.resolveExpiryWindowMonths('bentonville'),
      DEFAULT_CREDIT_EXPIRY_MONTHS,
      'code default (DEFAULT_CREDIT_EXPIRY_MONTHS) when neither override nor org-default exists',
    );
    await resetCreditExpirySettings();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Grant site stamps the resolved window + NON-RETROACTIVE
// ──────────────────────────────────────────────────────────────────────────

/** Read the expires_at (ISO or null) of the single purchase lot for dog1. */
async function purchaseLotExpiry(): Promise<string | null> {
  const [lot] = await db
    .select({ expiresAt: creditLedger.expiresAt })
    .from(creditLedger)
    .where(and(eq(creditLedger.dogId, FIXTURE_IDS.dog1Id), eq(creditLedger.reason, 'purchase')));
  // drizzle (mode: 'string') returns PG's raw timestamptz format; normalize to
  // ISO for a stable equality against the expected instant.
  return lot?.expiresAt == null ? null : pgTimestampToIso(lot.expiresAt);
}

async function purchaseSchool5(): Promise<void> {
  const { app } = purchaseApp();
  const res = await app.inject({
    method: 'POST',
    url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
    headers: { 'idempotency-key': `ces-buy-${randomUUID()}` },
    payload: {
      dog_id: FIXTURE_IDS.dog1Id,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as { charge_status: string }).charge_status, 'succeeded');
}

test(
  'purchase grant stamps the resolved window — org-default 12mo from FIXTURE_NOW',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    await cleanupChargesAndLedger();
    await purchaseSchool5();
    // FIXTURE_NOW = 2026-05-19T17:00:00Z + 12mo = 2027-05-19T17:00:00Z.
    assert.equal(await purchaseLotExpiry(), '2027-05-19T17:00:00.000Z');
    await cleanupChargesAndLedger();
  },
);

test(
  'purchase grant honors a per-location override — fayetteville 6mo window',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    await cleanupChargesAndLedger();
    // Staff sets a 6-month fayetteville override BEFORE the purchase.
    const { app: staff } = staffApp();
    await staff.inject({
      method: 'POST',
      url: '/staff/credit-expiry-settings',
      headers: { 'idempotency-key': `ces-set6-${randomUUID()}` },
      payload: { location: 'fayetteville', expiry_window_months: 6, warning_lead_days: 14 },
    });
    await purchaseSchool5();
    // FIXTURE_NOW + 6mo = 2026-11-19T17:00:00Z.
    assert.equal(await purchaseLotExpiry(), '2026-11-19T17:00:00.000Z');
    await cleanupChargesAndLedger();
    await resetCreditExpirySettings();
  },
);

test(
  'NON-RETROACTIVE — changing the window after purchase does NOT re-stamp the existing lot',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetCreditExpirySettings();
    await cleanupChargesAndLedger();
    // Buy at the org-default 12mo window.
    await purchaseSchool5();
    const stampedAtPurchase = await purchaseLotExpiry();
    assert.equal(stampedAtPurchase, '2027-05-19T17:00:00.000Z');

    // Staff later shortens the window to 1mo.
    const { app: staff } = staffApp();
    const patch = await staff.inject({
      method: 'POST',
      url: '/staff/credit-expiry-settings',
      headers: { 'idempotency-key': `ces-shrink-${randomUUID()}` },
      payload: { location: 'fayetteville', expiry_window_months: 1, warning_lead_days: 5 },
    });
    assert.equal(patch.statusCode, 200, patch.body);

    // The already-stamped lot is UNCHANGED — the policy change is future-only.
    assert.equal(
      await purchaseLotExpiry(),
      stampedAtPurchase,
      'existing lot keeps its purchase-time expiry',
    );
    await cleanupChargesAndLedger();
    await resetCreditExpirySettings();
  },
);
