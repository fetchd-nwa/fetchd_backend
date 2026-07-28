import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { charges, creditLedger, invoices } from '../../src/db/schema/schema.js';
import { registerInvoicesRoute } from '../../src/routes/invoices.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import type { LedgerEntryWire } from '../../src/lib/ledgerWire.js';
import type { Principal } from '../../src/auth/principal.js';

// GET /invoices — the owner billing ledger (charges + open invoices), Day-19d.
// Fixtures seed/teardown once; this file seeds its OWN ledger rows under the
// fixture owner (the base fixture seeds no charges/invoices) and cleans them up.

registerFixtureHooks();

const LEDGER = {
  chargePackageId: 'aaaa1111-0000-4000-8000-000000000001',
  chargePaygId: 'aaaa1111-0000-4000-8000-000000000002',
  chargeMembershipId: 'aaaa1111-0000-4000-8000-000000000003',
  chargeGroupRefundedId: 'aaaa1111-0000-4000-8000-000000000004',
  chargePendingId: 'aaaa1111-0000-4000-8000-000000000005',
  invoiceOpenId: 'aaaa2222-0000-4000-8000-000000000001',
  invoiceSettledId: 'aaaa2222-0000-4000-8000-000000000002',
} as const;

function buildApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL) {
  const { app, authenticate } = makeContractApp(principal);
  registerInvoicesRoute(app, { authenticate });
  return app;
}

async function seedLedger(): Promise<void> {
  await db.insert(charges).values([
    {
      id: LEDGER.chargePackageId,
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 40_500,
      status: 'succeeded',
      purpose: 'package',
      createdAt: '2026-04-01T15:00:00.000Z',
    },
    {
      id: LEDGER.chargePaygId,
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 9_000,
      status: 'succeeded',
      purpose: 'payg',
      bookingId: FIXTURE_IDS.booking1Id,
      createdAt: '2026-04-10T15:00:00.000Z',
    },
    {
      id: LEDGER.chargeMembershipId,
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 7_900,
      status: 'succeeded',
      purpose: 'membership',
      createdAt: '2026-04-15T15:00:00.000Z',
    },
    {
      id: LEDGER.chargeGroupRefundedId,
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 20_000,
      status: 'refunded',
      purpose: 'group-class',
      createdAt: '2026-04-05T15:00:00.000Z',
    },
    {
      // requires_payment is NOT a completed money event — must be excluded.
      id: LEDGER.chargePendingId,
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 5_000,
      status: 'requires_payment',
      purpose: 'payg',
      createdAt: '2026-04-20T15:00:00.000Z',
    },
  ]);
  await db.insert(creditLedger).values([
    {
      dogId: FIXTURE_IDS.dog1Id,
      mode: 'school',
      location: 'fayetteville',
      delta: 10,
      reason: 'purchase',
      chargeId: LEDGER.chargePackageId,
    },
  ]);
  await db.insert(invoices).values([
    {
      id: LEDGER.invoiceOpenId,
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 18_000,
      status: 'open',
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      issuedAt: '2026-04-18T15:00:00.000Z',
      dueAt: '2026-05-02T15:00:00.000Z',
    },
    {
      // Settled by the payg charge — its ledger entry must expose invoice_id
      // (payment notifications deep-link by INVOICE id; the paid row is
      // charge-keyed, so the back-reference is the client's match key).
      id: LEDGER.invoiceSettledId,
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 9_000,
      status: 'paid',
      purpose: 'payg',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      paidChargeId: LEDGER.chargePaygId,
      paidAt: '2026-04-10T15:00:00.000Z', // schema CHECK #7: paid implies paid_at
      issuedAt: '2026-04-10T14:00:00.000Z',
      dueAt: '2026-04-10T15:00:00.000Z',
    },
  ]);
}

async function cleanupLedger(): Promise<void> {
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(creditLedger).where(inArray(creditLedger.chargeId, [LEDGER.chargePackageId]));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

function byId(rows: LedgerEntryWire[]): Map<string, LedgerEntryWire> {
  return new Map(rows.map((r) => [r.id, r]));
}

test(
  'GET /invoices maps charges + open invoices to the ledger wire (kinds, statuses, purpose-derived category)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupLedger();
    await seedLedger();
    const res = await buildApp().inject({ method: 'GET', url: '/invoices' });
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json() as LedgerEntryWire[];
    const entries = byId(rows);

    // Pending (requires_payment) charge is not a ledger line.
    assert.equal(entries.has(LEDGER.chargePendingId), false);

    // Package charge → credit-pack with dog + mode from the credit_ledger grant.
    assert.deepEqual(entries.get(LEDGER.chargePackageId), {
      id: LEDGER.chargePackageId,
      kind: 'credit-pack',
      status: 'paid',
      amount_cents: 40_500,
      date: '2026-04-01T15:00:00.000Z',
      dog_id: FIXTURE_IDS.dog1Id,
      mode: 'school',
    });

    // Payg charge → category + dog resolved from the linked booking (day-school),
    // and invoice_id from the invoices.paid_charge_id back-reference.
    assert.deepEqual(entries.get(LEDGER.chargePaygId), {
      id: LEDGER.chargePaygId,
      kind: 'payg',
      status: 'paid',
      amount_cents: 9_000,
      date: '2026-04-10T15:00:00.000Z',
      dog_id: FIXTURE_IDS.dog1Id,
      category: 'day-school',
      invoice_id: LEDGER.invoiceSettledId,
    });

    // Membership charge → no dog, no category.
    assert.deepEqual(entries.get(LEDGER.chargeMembershipId), {
      id: LEDGER.chargeMembershipId,
      kind: 'membership',
      status: 'paid',
      amount_cents: 7_900,
      date: '2026-04-15T15:00:00.000Z',
    });

    // Refunded group-class charge with no booking → session, purpose-derived
    // category, no dog.
    assert.deepEqual(entries.get(LEDGER.chargeGroupRefundedId), {
      id: LEDGER.chargeGroupRefundedId,
      kind: 'session',
      status: 'refunded',
      amount_cents: 20_000,
      date: '2026-04-05T15:00:00.000Z',
      category: 'group-class',
    });

    // Open invoice (board-train, no booking) → session, open, purpose-derived
    // category, no dog, no payment chip.
    assert.deepEqual(entries.get(LEDGER.invoiceOpenId), {
      id: LEDGER.invoiceOpenId,
      kind: 'session',
      status: 'open',
      amount_cents: 18_000,
      date: '2026-04-18T15:00:00.000Z',
      category: 'board-and-train',
      // Open entries expose how the owner will settle (default 'card'); the
      // pay-in-person flow flips this so the app renders the row non-payable.
      payment_expected: 'card',
    });

    // Newest first across the seeded rows.
    const seededOrder = rows.filter((r) => r.id.startsWith('aaaa')).map((r) => r.date);
    const sorted = [...seededOrder].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(seededOrder, sorted);

    await cleanupLedger();
  },
);

test(
  'GET /invoices as a staff principal returns [] (owner-app endpoint)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanupLedger();
    await seedLedger();
    const res = await buildApp(FIXTURE_STAFF_PRINCIPAL).inject({ method: 'GET', url: '/invoices' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
    await cleanupLedger();
  },
);
