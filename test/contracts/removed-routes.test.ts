import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../../src/db/client.js';
import { invoices } from '../../src/db/schema/schema.js';
import { registerStaffInvoicesRoute } from '../../src/routes/staffInvoices.js';
import { buildApp } from '../../src/server.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Wire 5.0.0-lg4.1 (P17; CRED-U29, PAY-U15, ALUM-U17): the routes that left. The app
 * under test is the real `buildApp()`, so what is proven is the registration, not a
 * stand-in: an unauthenticated request to a registered route is a 401, and to a route
 * that is gone a 404, which is why none of these needs a principal to go red.
 */

registerFixtureHooks();

let app: FastifyInstance;

before(async () => {
  app = buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

const ANY_ID = '99999999-9999-4999-8999-999999999999';

const REMOVED: ReadonlyArray<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }> = [
  { method: 'POST', url: '/memberships' },
  { method: 'GET', url: '/memberships' },
  { method: 'DELETE', url: `/memberships/${ANY_ID}` },
  { method: 'POST', url: `/staff/memberships/${ANY_ID}/pause` },
  { method: 'POST', url: `/staff/memberships/${ANY_ID}/resume` },
  { method: 'GET', url: '/staff/invoices?parked' },
  { method: 'POST', url: `/staff/dogs/${ANY_ID}/clear-alumni-flag` },
  // 6.0.0-lg5.1 (P20; DAY-U29, M5.12): the overwritable attendance verb, replaced by the
  // board's append-only log.
  { method: 'POST', url: `/staff/bookings/${ANY_ID}/attendance` },
  // 6.0.0-lg5.2 (P21; CXL-U02, M5.08): the cancel window and its table, replaced by the
  // stored-only `cxl` settings domain (`GET/PATCH /staff/settings/cxl`).
  { method: 'GET', url: '/staff/cancel-window' },
  { method: 'PATCH', url: '/staff/cancel-window/day-school' },
];

for (const { method, url } of REMOVED) {
  test(`${method} ${url} answers 404`, async () => {
    const res = await app.inject({ method, url });
    assert.equal(res.statusCode, 404, res.body);
  });
}

// The control: this server answers 401 for a route it does hold, so the 404s above
// are about those paths and not about a server that answers everything with one.
for (const { method, url } of [
  { method: 'GET', url: `/staff/invoices/${ANY_ID}` },
  { method: 'POST', url: `/invoices/${ANY_ID}/pay` },
  { method: 'GET', url: `/staff/dogs/${ANY_ID}/completed-programs` },
  { method: 'POST', url: `/staff/bookings/${ANY_ID}/dogs/${ANY_ID}/check-in` },
  { method: 'GET', url: '/staff/checkin-board?location=bentonville&date=2026-10-13' },
  { method: 'GET', url: '/staff/settings/cxl' },
] as const) {
  test(`${method} ${url} is still registered`, async () => {
    const res = await app.inject({ method, url });
    assert.equal(res.statusCode, 401, res.body);
  });
}

test('GET /staff/invoices/:id still answers 200', SKIP_WHEN_NO_DB, async () => {
  const invoiceId = randomUUID();
  await db.insert(invoices).values({
    id: invoiceId,
    ownerId: FIXTURE_IDS.ownerId,
    amountCents: 2500,
    purpose: 'group-class',
    paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
    dueAt: '2026-06-01T17:00:00.000Z',
  });
  try {
    const { app: staffApp, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffInvoicesRoute(staffApp, { authenticate });
    const res = await staffApp.inject({ method: 'GET', url: `/staff/invoices/${invoiceId}` });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { id: string }).id, invoiceId);
  } finally {
    await db.delete(invoices).where(eq(invoices.id, invoiceId));
  }
});
