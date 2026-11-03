import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { Principal } from '../../src/auth/principal.js';
import type {
  GetStaffOwnersInvoicesResponse,
  GetStaffOwnersPaymentMethodsResponse,
  GetStaffOwnersPaymentsResponse,
  RefundStatus,
  StaffInvoiceWire,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { settingsRepository } from '../../src/db/repositories/settingsRepository.js';
import { charges, invoices, owners, refunds } from '../../src/db/schema/schema.js';
import { registerStaffInvoicesRoute } from '../../src/routes/staffInvoices.js';
import { registerStaffOwnersRoute } from '../../src/routes/staffOwners.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * STAFF-U13 — staff read a family's billing (P03, wire 2.0.0; design
 * §1.1:710-717, §2.10:4682-4697; 04- item 128: "Trainers CAN open invoices.
 * Trainers may NOT see payment history or cards on file").
 *
 *   GET /staff/owners/:id/invoices, GET /staff/invoices/:id   any staff role;
 *     `payments` present ([] included) only for a caller with refund_money
 *   GET /staff/owners/:id/payments, /payment-methods          owner, manager
 *
 * `refundable_cents` = the charge minus every refund whose status is not
 * `failed`, floored at 0 (wire contract notes J5).
 *
 * NOT carried here, because today's schema cannot: design §2.10:4695-4697's
 * "after a $285 check hand-back closed `withdrawn` it is unchanged and a fresh
 * $285 refund on the same charge is accepted". `withdrawn` is a value of
 * `refunds.resolved_outcome`, which M5.10 (design 6.0.0) adds; no column holds
 * it yet. That test lands with M5.10.
 */

registerFixtureHooks();

const OWNER = FIXTURE_IDS.ownerId;

function appAs(principal: Principal) {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffOwnersRoute(app, { authenticate });
  registerStaffInvoicesRoute(app, { authenticate });
  return app;
}

async function get(principal: Principal, url: string) {
  return appAs(principal).inject({ method: 'GET', url });
}

async function cleanup(): Promise<void> {
  await db.delete(invoices).where(eq(invoices.ownerId, OWNER));
  await db.delete(refunds).where(eq(refunds.ownerId, OWNER));
  await db.delete(charges).where(eq(charges.ownerId, OWNER));
}

interface Seeded {
  chargeId: string;
  paidInvoiceId: string;
  openInvoiceId: string;
}

/** A $60 board-and-train charge that settled a $60 invoice, a later open
 *  $15 invoice, and two charges that moved no money (failed, unpaid). */
async function seed(): Promise<Seeded> {
  const [charge] = await db
    .insert(charges)
    .values({
      ownerId: OWNER,
      amountCents: 6000,
      status: 'succeeded',
      purpose: 'board-train',
      dogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-10-01T15:00:00Z',
    })
    .returning({ id: charges.id });
  await db.insert(charges).values([
    { ownerId: OWNER, amountCents: 1000, status: 'failed', purpose: 'payg' },
    { ownerId: OWNER, amountCents: 2000, status: 'requires_payment', purpose: 'payg' },
  ]);
  const chargeId = (charge as { id: string }).id;
  const paid = await db.transaction((tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: OWNER,
      amountCents: 6000,
      purpose: 'board-train',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: '2026-10-01T00:00:00Z',
      dogId: FIXTURE_IDS.dog1Id,
    }),
  );
  await db.transaction((tx) =>
    invoicesRepository.markPaid(tx, { id: paid.id, paidChargeId: chargeId }),
  );
  await db
    .update(invoices)
    .set({ issuedAt: '2026-09-30T12:00:00Z' })
    .where(eq(invoices.id, paid.id));
  const open = await db.transaction((tx) =>
    invoicesRepository.createOpen(tx, {
      ownerId: OWNER,
      amountCents: 1500,
      purpose: 'payg',
      paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
      dueAt: '2026-11-15T00:00:00Z',
    }),
  );
  await db
    .update(invoices)
    .set({ issuedAt: '2026-10-20T12:00:00Z' })
    .where(eq(invoices.id, open.id));
  return { chargeId, paidInvoiceId: paid.id, openInvoiceId: open.id };
}

async function refund(chargeId: string, status: RefundStatus, amountCents = 4000, at?: string) {
  const [row] = await db
    .insert(refunds)
    .values({
      ownerId: OWNER,
      chargeId,
      amountCents,
      status,
      reason: 'cancel',
      ...(at === undefined ? {} : { createdAt: at }),
    })
    .returning({ id: refunds.id });
  return (row as { id: string }).id;
}

/** The trainer's refund_money is false only while the seeds hold; say so loudly. */
async function assertTrainerCannotRefund(): Promise<void> {
  const [lists, limit] = await Promise.all([
    settingsRepository.staff(),
    settingsRepository.refundAnyRoleLimitCents(),
  ]);
  assert.ok(
    !lists.refund_roles.includes('trainer') && limit === 0,
    `precondition: the seeded trainer may not refund (refund_roles ${lists.refund_roles.join(',')}, limit ${limit})`,
  );
}

beforeEach(cleanup);
afterEach(cleanup);

test(
  "a trainer opens a family's invoices: no payments, no refundable_cents, no last4",
  SKIP_WHEN_NO_DB,
  async () => {
    await assertTrainerCannotRefund();
    const { paidInvoiceId, openInvoiceId } = await seed();
    const list = await get(FIXTURE_STAFF_PRINCIPAL, `/staff/owners/${OWNER}/invoices`);
    assert.equal(list.statusCode, 200, list.body);
    const one = await get(FIXTURE_STAFF_PRINCIPAL, `/staff/invoices/${paidInvoiceId}`);
    assert.equal(one.statusCode, 200, one.body);
    for (const body of [list.body, one.body]) {
      for (const absent of ['payments', 'refundable_cents', 'last4', 'brand', 'payment_method']) {
        assert.ok(!body.includes(absent), `a trainer's read carries ${absent}: ${body}`);
      }
    }
    const rows = list.json<GetStaffOwnersInvoicesResponse>();
    assert.deepEqual(
      rows.map((r) => r.id),
      [openInvoiceId, paidInvoiceId],
      'newest first by issued_at',
    );
    const [open, paid] = rows as [StaffInvoiceWire, StaffInvoiceWire];
    assert.deepEqual(Object.keys(paid).sort(), [
      'amount_cents',
      'dog_id',
      'due_at',
      'id',
      'issued_at',
      'owner_id',
      'paid_at',
      'paid_cents',
      'purpose',
      'status',
    ]);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.purpose, 'board-train');
    assert.equal(paid.amount_cents, 6000);
    assert.equal(paid.paid_cents, 6000);
    assert.equal(paid.owner_id, OWNER);
    assert.equal(paid.dog_id, FIXTURE_IDS.dog1Id);
    assert.equal(paid.issued_at, '2026-09-30T12:00:00.000Z');
    assert.equal(paid.due_at, '2026-10-01T00:00:00.000Z');
    assert.deepEqual(Object.keys(open).sort(), [
      'amount_cents',
      'due_at',
      'id',
      'issued_at',
      'owner_id',
      'paid_cents',
      'purpose',
      'status',
    ]);
    assert.equal(open.paid_cents, 0, 'an open invoice has paid nothing');
    assert.deepEqual(one.json<StaffInvoiceWire>(), paid);
  },
);

test(
  'a manager and the owner role read payments: the settling charge on a paid invoice, [] on an open one',
  SKIP_WHEN_NO_DB,
  async () => {
    const { chargeId, paidInvoiceId, openInvoiceId } = await seed();
    for (const principal of [FIXTURE_MANAGER_PRINCIPAL, FIXTURE_OWNER_ROLE_PRINCIPAL]) {
      const list = await get(principal, `/staff/owners/${OWNER}/invoices`);
      assert.equal(list.statusCode, 200, list.body);
      const byId = new Map(list.json<GetStaffOwnersInvoicesResponse>().map((r) => [r.id, r]));
      assert.deepEqual(byId.get(paidInvoiceId)?.payments, [
        { payment_id: chargeId, paid_cents: 6000, refundable_cents: 6000 },
      ]);
      const open = byId.get(openInvoiceId) as StaffInvoiceWire;
      assert.ok(
        Object.hasOwn(open, 'payments'),
        'the key is absent: a manager would read as a trainer',
      );
      assert.deepEqual(open.payments, []);
      const one = await get(principal, `/staff/invoices/${openInvoiceId}`);
      assert.equal(one.statusCode, 200, one.body);
      assert.deepEqual(one.json<StaffInvoiceWire>().payments, []);
    }
  },
);

test(
  'refundable_cents is the charge minus every refund that is not failed, floored at 0 (J5)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { chargeId, paidInvoiceId } = await seed();
    const refundable = async () => {
      const res = await get(FIXTURE_MANAGER_PRINCIPAL, `/staff/invoices/${paidInvoiceId}`);
      assert.equal(res.statusCode, 200, res.body);
      const fromInvoice = res.json<StaffInvoiceWire>().payments?.[0]?.refundable_cents;
      const history = await get(FIXTURE_MANAGER_PRINCIPAL, `/staff/owners/${OWNER}/payments`);
      const fromHistory = history
        .json<GetStaffOwnersPaymentsResponse>()
        .find((p) => p.payment_id === chargeId)?.refundable_cents;
      assert.equal(fromHistory, fromInvoice, 'the two surfaces disagree on the cap');
      return fromInvoice;
    };
    // A $40 refund on the $60 charge, in each state whose money left or is leaving.
    for (const status of ['succeeded', 'pending', 'unroutable', 'resolved-external'] as const) {
      const id = await refund(chargeId, status);
      assert.equal(await refundable(), 2000, status);
      await db.delete(refunds).where(eq(refunds.id, id));
    }
    // A failed refund moved no money: the cap is unchanged.
    await refund(chargeId, 'failed');
    assert.equal(await refundable(), 6000, 'failed');
    // Two $40 refunds on a $60 charge: floored at 0, never negative.
    await refund(chargeId, 'succeeded');
    await refund(chargeId, 'succeeded');
    assert.equal(await refundable(), 0, 'floor');
  },
);

// P03 fix 1, item 12 (Fable nice N2; wire contract notes J3): `payments` follows
// the caller's `refund_money` capability, never the role. A trainer holds it
// while `pay.refund_any_role_limit_cents > 0`, or once `trainer` is on
// `staff.refund_role_list`; then he reads `payments` like a manager.
test(
  "J3's positive branch: a trainer who holds refund_money (by the limit, or by the list) reads payments",
  SKIP_WHEN_NO_DB,
  async () => {
    await assertTrainerCannotRefund();
    const { chargeId, paidInvoiceId, openInvoiceId } = await seed();
    const lists = await settingsRepository.staff();
    const limit = await settingsRepository.refundAnyRoleLimitCents();
    const restore = async () => {
      await db.execute(
        sql`UPDATE payment_settings SET value = ${JSON.stringify(limit)}::jsonb WHERE key = 'refund_any_role_limit_cents' AND scope = 'global'`,
      );
      await db.execute(
        sql`UPDATE staff_settings SET refund_roles = ${`{${lists.refund_roles.join(',')}}`}::staff_role[]`,
      );
    };
    const grants: Array<[string, () => Promise<void>]> = [
      [
        'a refund limit above 0',
        async () => {
          await db.execute(
            sql`UPDATE payment_settings SET value = '5000'::jsonb WHERE key = 'refund_any_role_limit_cents' AND scope = 'global'`,
          );
        },
      ],
      [
        'trainer on staff.refund_role_list',
        async () => {
          await db.execute(
            sql`UPDATE staff_settings SET refund_roles = '{owner,manager,trainer}'::staff_role[]`,
          );
        },
      ],
    ];
    try {
      for (const [how, grant] of grants) {
        await grant();
        const one = await get(FIXTURE_STAFF_PRINCIPAL, `/staff/invoices/${paidInvoiceId}`);
        assert.equal(one.statusCode, 200, one.body);
        assert.deepEqual(
          one.json<StaffInvoiceWire>().payments,
          [{ payment_id: chargeId, paid_cents: 6000, refundable_cents: 6000 }],
          `${how}: the trainer's invoice read has no payments`,
        );
        const list = await get(FIXTURE_STAFF_PRINCIPAL, `/staff/owners/${OWNER}/invoices`);
        const open = list
          .json<GetStaffOwnersInvoicesResponse>()
          .find((r) => r.id === openInvoiceId);
        assert.deepEqual(open?.payments, [], `${how}: the open invoice's [] is missing`);
        await restore();
      }
    } finally {
      await restore();
    }
    await assertTrainerCannotRefund();
  },
);

test(
  'the payment history (owner, manager): money that moved, newest first, each charge with its refunds oldest first and its invoice',
  SKIP_WHEN_NO_DB,
  async () => {
    const { chargeId, paidInvoiceId } = await seed();
    const [pack] = await db
      .insert(charges)
      .values({
        ownerId: OWNER,
        amountCents: 12000,
        status: 'refunded',
        purpose: 'package',
        createdAt: '2026-10-10T15:00:00Z',
      })
      .returning({ id: charges.id });
    const packId = (pack as { id: string }).id;
    const failedRefund = await refund(chargeId, 'failed', 4000, '2026-10-02T10:00:00Z');
    const goodRefund = await refund(chargeId, 'succeeded', 4000, '2026-10-03T10:00:00Z');
    for (const principal of [FIXTURE_MANAGER_PRINCIPAL, FIXTURE_OWNER_ROLE_PRINCIPAL]) {
      const res = await get(principal, `/staff/owners/${OWNER}/payments`);
      assert.equal(res.statusCode, 200, res.body);
      const rows = res.json<GetStaffOwnersPaymentsResponse>();
      assert.deepEqual(
        rows.map((r) => r.payment_id),
        [packId, chargeId],
        'only money that moved (succeeded, refunded), newest first',
      );
      const [packRow, row] = rows;
      assert.deepEqual(packRow, {
        payment_id: packId,
        paid_cents: 12000,
        refundable_cents: 12000,
        status: 'refunded',
        purpose: 'package',
        created_at: '2026-10-10T15:00:00.000Z',
        refunds: [],
      });
      assert.equal(row?.invoice_id, paidInvoiceId);
      assert.equal(row?.dog_id, FIXTURE_IDS.dog1Id);
      assert.equal(row?.refundable_cents, 2000, 'the failed refund does not count');
      assert.deepEqual(
        row?.refunds.map((r) => [r.id, r.status, r.amount_cents, r.reason]),
        [
          [failedRefund, 'failed', 4000, 'cancel'],
          [goodRefund, 'succeeded', 4000, 'cancel'],
        ],
      );
      assert.deepEqual(Object.keys(row?.refunds[0] ?? {}).sort(), [
        'amount_cents',
        'created_at',
        'id',
        'reason',
        'status',
      ]);
      assert.ok(!res.body.includes('last4') && !res.body.includes('brand'), res.body);
    }
  },
);

test(
  "the cards on file (owner, manager): the family's PaymentMethodWire list",
  SKIP_WHEN_NO_DB,
  async () => {
    for (const principal of [FIXTURE_MANAGER_PRINCIPAL, FIXTURE_OWNER_ROLE_PRINCIPAL]) {
      const res = await get(principal, `/staff/owners/${OWNER}/payment-methods`);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json<GetStaffOwnersPaymentMethodsResponse>(), [
        {
          id: FIXTURE_IDS.paymentMethod1Id,
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2030,
          cardholder_name: 'Allison Fixture',
          is_default: true,
        },
      ]);
    }
  },
);

test(
  'a trainer is 403 on the payment history and the cards before the id is read: malformed, unknown or real',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const path of ['payments', 'payment-methods']) {
      for (const id of ['not-a-uuid', randomUUID(), OWNER]) {
        const res = await get(FIXTURE_STAFF_PRINCIPAL, `/staff/owners/${id}/${path}`);
        assert.equal(res.statusCode, 403, `${path} ${id}: ${res.body}`);
        const { error } = res.json<{ error: { code: string; details?: unknown } }>();
        assert.equal(error.code, 'forbidden');
        assert.equal(error.details, undefined, 'the 403 must say nothing about the family');
      }
    }
  },
);

test(
  'route edges: owner principal 403, malformed id 400, unknown id 404, an expired family still resolves',
  SKIP_WHEN_NO_DB,
  async () => {
    const paths = (id: string) => [
      `/staff/owners/${id}/invoices`,
      `/staff/owners/${id}/payments`,
      `/staff/owners/${id}/payment-methods`,
      `/staff/invoices/${id}`,
    ];
    for (const url of paths(OWNER)) {
      const res = await get(FIXTURE_OWNER_PRINCIPAL, url);
      assert.equal(res.statusCode, 403, `${url}: ${res.body}`);
    }
    for (const url of paths('not-a-uuid')) {
      const res = await get(FIXTURE_MANAGER_PRINCIPAL, url);
      assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'bad_request');
    }
    for (const url of paths(randomUUID())) {
      const res = await get(FIXTURE_MANAGER_PRINCIPAL, url);
      assert.equal(res.statusCode, 404, `${url}: ${res.body}`);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'not_found');
    }
    const expired = randomUUID();
    await db.insert(owners).values({
      id: expired,
      supabaseUid: randomUUID(),
      name: 'Gone Family',
      email: 'gone@example.invalid',
      phone: '555-0199',
      location: 'fayetteville',
      expiredAt: '2026-10-01T00:00:00Z',
    });
    try {
      for (const url of paths(expired).slice(0, 3)) {
        const res = await get(FIXTURE_MANAGER_PRINCIPAL, url);
        assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
        assert.deepEqual(res.json(), []);
      }
    } finally {
      await db.delete(owners).where(eq(owners.id, expired));
    }
  },
);

test(
  'GET /staff/invoices keeps its ?parked contract beside /staff/invoices/:id',
  SKIP_WHEN_NO_DB,
  async () => {
    assert.equal((await get(FIXTURE_STAFF_PRINCIPAL, '/staff/invoices')).statusCode, 400);
    assert.equal((await get(FIXTURE_STAFF_PRINCIPAL, '/staff/invoices?parked')).statusCode, 200);
  },
);
