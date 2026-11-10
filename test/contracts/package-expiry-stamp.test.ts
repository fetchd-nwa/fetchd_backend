import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { creditLedger, orders } from '../../src/db/schema/schema.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerStaffCreditPackagesRoute } from '../../src/routes/staffCreditPackages.js';
import { CATALOG_SEED_KEYS, FIXTURE_IDS, FIXTURE_NOW, resetCatalogSeed } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * What a purchase of a seeded row stamps on its lot: the row's `expiry_months`, whole
 * Chicago months, on every row, the single-day and alumni rows included (design
 * §2.4:2885-2889, CRED-U07, CRED-U08).
 *
 * The stub's intents are created at FIXTURE_NOW, so the anchor is one instant whether
 * the route's clock or Stripe's `created` (design §2.4:3003) stamps the lot.
 */

registerFixtureHooks();
afterEach(resetCatalogSeed);

// 12:00 CDT Tue 19 May 2026, and the same wall clock one and three months on.
const ONE_MONTH_ON = '2026-06-19T17:00:00.000Z';
const THREE_MONTHS_ON = '2026-08-19T17:00:00.000Z';

function buildApp() {
  const owner = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  stripe.setIntentsCreatedAt(FIXTURE_NOW());
  registerCreditPackagesRoute(owner.app, {
    authenticate: owner.authenticate,
    stripe,
    now: FIXTURE_NOW,
  });
  const staff = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
  registerStaffCreditPackagesRoute(staff.app, {
    authenticate: staff.authenticate,
    now: FIXTURE_NOW,
  });
  return { owner: owner.app, staff: staff.app };
}

/** Buys one `key` and answers the `expires_at` of the lot it wrote, then clears it. */
async function stampOf(app: ReturnType<typeof buildApp>['owner'], key: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/credit-packages/${key}/purchase`,
    headers: { 'idempotency-key': `stamp-${randomUUID()}` },
    payload: { payment_method_id: FIXTURE_IDS.paymentMethod1Id },
  });
  assert.equal(res.statusCode, 201, res.body);
  const chargeId = (res.json() as { charge_id: string }).charge_id;
  try {
    const [lot] = await db
      .select({ expiresAt: creditLedger.expiresAt })
      .from(creditLedger)
      .where(eq(creditLedger.chargeId, chargeId));
    assert.ok(lot, 'the purchase wrote a lot');
    return lot.expiresAt === null ? 'never' : new Date(lot.expiresAt).toISOString();
  } finally {
    await db.delete(creditLedger).where(eq(creditLedger.chargeId, chargeId));
    await clearOrderRows();
    await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
  }
}

for (const key of CATALOG_SEED_KEYS) {
  test(`CRED-U07: buying ${key} stamps its lot one Chicago month on`, SKIP_WHEN_NO_DB, async () => {
    const { owner } = buildApp();
    assert.equal(await stampOf(owner, key), ONE_MONTH_ON);
  });
}

test(
  'CRED-U08: a purchase after an expiry_months edit stamps the edited months',
  SKIP_WHEN_NO_DB,
  async () => {
    const { owner, staff } = buildApp();
    const edit = await staff.inject({
      method: 'PATCH',
      url: '/staff/credit-packages/school-alumni-10-fayetteville',
      headers: { 'idempotency-key': `stamp-edit-${randomUUID()}` },
      payload: { expiry_months: 3 },
    });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(await stampOf(owner, 'school-alumni-10-fayetteville'), THREE_MONTHS_ON);
  },
);

test(
  'CRED-U08: a purchase after a same-day correction stamps the corrected months',
  SKIP_WHEN_NO_DB,
  async () => {
    const { owner, staff } = buildApp();
    for (const expiry_months of [6, 3]) {
      const edit = await staff.inject({
        method: 'PATCH',
        url: '/staff/credit-packages/single-day-school-bentonville',
        headers: { 'idempotency-key': `stamp-fix-${randomUUID()}` },
        payload: { expiry_months },
      });
      assert.equal(edit.statusCode, 200, edit.body);
    }
    assert.equal(await stampOf(owner, 'single-day-school-bentonville'), THREE_MONTHS_ON);
  },
);
