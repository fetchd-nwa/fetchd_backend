import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { parseStep } from '../../src/db/migrate.js';
import { db } from '../../src/db/client.js';
import { bookingStatus, invoices, orders } from '../../src/db/schema/schema.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { clearOrderRows, seedOpenInvoice } from './_orderFixture.js';

/**
 * M3.02 and M3.03 (P15). The rehearsal proves the steps' DDL equals schema.sql; these
 * hold the parts of it a fingerprint cannot read as a rule.
 */

after(clearOrderRows);
registerFixtureHooks();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stepBytes = (name: string): Buffer =>
  fs.readFileSync(path.join(REPO_ROOT, 'migrations', 'lg3', name));

test('M3.02 parses as a step in one transaction', () => {
  const name = 'M3.02_orders.sql';
  const parsed = parseStep(name, stepBytes(name));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  assert.equal(parsed.step.stepId, 'M3.02');
  assert.equal(parsed.step.directives.has('no-transaction'), false);
});

test('M3.03 goes through the no-transaction header, and closes the group', () => {
  const name = 'M3.03_booking_status_payment_pending.sql';
  const parsed = parseStep(name, stepBytes(name));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  assert.equal(parsed.step.directives.has('no-transaction'), true);
  assert.match(stepBytes(name).toString('utf8'), /REVOKE ALL ON orders FROM anon, authenticated;/);
});

test("booking_status gains 'payment-pending' after 'cancelled'", () => {
  assert.deepEqual(bookingStatus.enumValues, ['upcoming', 'past', 'cancelled', 'payment-pending']);
});

test('invoices_order_id_uidx is plain: not partial', SKIP_WHEN_NO_DB, async () => {
  const rows = await db.execute(
    sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'invoices_order_id_uidx'`,
  );
  const def = (rows.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? '';
  assert.match(def, /UNIQUE INDEX invoices_order_id_uidx/);
  assert.doesNotMatch(def, /WHERE/, 'a partial index answers 42P10 to ON CONFLICT (order_id)');
});

test(
  'ON CONFLICT (order_id) infers it with no WHERE repeated, and NULLs never conflict',
  SKIP_WHEN_NO_DB,
  async () => {
    const orderId = randomUUID();
    await db.insert(orders).values({ id: orderId, ownerId: FIXTURE_IDS.ownerId });
    const row = {
      ownerId: FIXTURE_IDS.ownerId,
      amountCents: 6_000,
      purpose: 'package' as const,
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: '2099-01-01T00:00:00Z',
      orderId,
    };
    const first = await db
      .insert(invoices)
      .values(row)
      .onConflictDoNothing({ target: invoices.orderId })
      .returning({ id: invoices.id });
    assert.equal(first.length, 1);
    const second = await db
      .insert(invoices)
      .values(row)
      .onConflictDoNothing({ target: invoices.orderId })
      .returning({ id: invoices.id });
    assert.equal(second.length, 0, 'the second writer is a no-op, not 42P10');

    await seedOpenInvoice();
    await seedOpenInvoice();
    const withNoOrder = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(withNoOrder.length, 3, 'two invoices with no order sit under it');
    await clearOrderRows();
  },
);

test('one charge per order is a constraint, not a hope', SKIP_WHEN_NO_DB, async () => {
  const rows = await db.execute(
    sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'charges_order_id_uidx'`,
  );
  const def = (rows.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? '';
  assert.match(def, /UNIQUE INDEX charges_order_id_uidx/);
});
