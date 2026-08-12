import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { charges, invoices } from '../../src/db/schema/schema.js';
import { registerStaffInvoicesRoute } from '../../src/routes/staffInvoices.js';
import { MAX_AUTO_CHARGE_ATTEMPTS } from '../../src/workers/invoiceAutoCharge.js';
import { clearInvoiceChargeAttempts, FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import type { Principal } from '../../src/auth/principal.js';

/**
 * Credit-expiry Phase-3 — `GET /staff/invoices?parked` (the parked-invoice
 * worklist). A parked invoice is `status='open'` with
 * `auto_charge_attempts >= MAX_AUTO_CHARGE_ATTEMPTS` (the worker exhausted its
 * retries + set `next_attempt_at = NULL`).
 *
 *   - returns ONLY parked invoices (not open-but-still-retrying, not paid/void)
 *   - owner principal → 403
 *   - `?parked` is required (unscoped list → 400)
 */

registerFixtureHooks();

function staffApp(principal: Principal = FIXTURE_STAFF_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffInvoicesRoute(app, { authenticate });
  return { app };
}

async function cleanup(): Promise<void> {
  await clearInvoiceChargeAttempts();
  await db.delete(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
}

/**
 * Seed an open invoice. `parked: true` models the worker's terminal state
 * (`next_attempt_at = NULL`, attempts at the cap); `parked: false` models a
 * still-retrying invoice (a future `next_attempt_at`, attempts below the cap).
 * The read keys on `next_attempt_at IS NULL`, so this is the real distinction.
 */
async function seedInvoice(args: { parked: boolean; amountCents?: number }): Promise<string> {
  const id = await db.transaction(async (tx) => {
    const row = await invoicesRepository.createOpen(tx, {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: args.amountCents ?? 15000,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: '2026-01-01T00:00:00Z',
      nextAttemptAt: '2026-01-01T00:00:00Z',
    });
    return row.id;
  });
  await db
    .update(invoices)
    .set({
      autoChargeAttempts: args.parked ? MAX_AUTO_CHARGE_ATTEMPTS : MAX_AUTO_CHARGE_ATTEMPTS - 1,
      // The park signal: the worker nulls next_attempt_at when it gives up.
      nextAttemptAt: args.parked ? null : '2026-02-01T00:00:00Z',
    })
    .where(eq(invoices.id, id));
  return id;
}

interface ParkedWire {
  id: string;
  owner_id: string;
  amount_cents: number;
  status: string;
  purpose: string;
  dog_id: string | null;
  due_at: string;
  auto_charge_attempts: number;
}

test(
  'GET /staff/invoices?parked — returns only parked invoices (attempts >= MAX)',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    const parkedId = await seedInvoice({ parked: true, amountCents: 30000 });
    // A still-retrying invoice (next_attempt_at set) must NOT appear.
    await seedInvoice({ parked: false });

    const { app } = staffApp();
    const res = await app.inject({ method: 'GET', url: '/staff/invoices?parked' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as ParkedWire[];
    assert.equal(body.length, 1, 'only the parked invoice');
    assert.equal(body[0]?.id, parkedId);
    assert.equal(body[0]?.status, 'open', 'parked stays open');
    assert.equal(body[0]?.auto_charge_attempts, MAX_AUTO_CHARGE_ATTEMPTS);
    assert.equal(body[0]?.amount_cents, 30000);
    assert.equal(body[0]?.purpose, 'board-train');
    await cleanup();
  },
);

test('GET /staff/invoices?parked — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({ method: 'GET', url: '/staff/invoices?parked' });
  assert.equal(res.statusCode, 403, res.body);
});

test('GET /staff/invoices — missing ?parked → 400', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const res = await app.inject({ method: 'GET', url: '/staff/invoices' });
  assert.equal(res.statusCode, 400, res.body);
});

test(
  'GET /staff/invoices?parked — a missing-card park (attempts < MAX, next_attempt_at NULL) STILL surfaces',
  SKIP_WHEN_NO_DB,
  async () => {
    await cleanup();
    // Model the pm-missing/customer-missing park: the worker gives up on the
    // FIRST attempt (no card to retry), so attempts=1 but next_attempt_at NULL.
    const id = await db.transaction(async (tx) => {
      const row = await invoicesRepository.createOpen(tx, {
        ownerId: FIXTURE_IDS.ownerId,
        amountCents: 8000,
        purpose: 'payg',
        paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
        dueAt: '2026-01-01T00:00:00Z',
        nextAttemptAt: '2026-01-01T00:00:00Z',
      });
      return row.id;
    });
    await db
      .update(invoices)
      .set({ autoChargeAttempts: 1, nextAttemptAt: null })
      .where(eq(invoices.id, id));

    const { app } = staffApp();
    const res = await app.inject({ method: 'GET', url: '/staff/invoices?parked' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as ParkedWire[];
    assert.equal(body.length, 1, 'the missing-card park is visible despite attempts < MAX');
    assert.equal(body[0]?.id, id);
    assert.equal(body[0]?.auto_charge_attempts, 1);
    await cleanup();
  },
);
