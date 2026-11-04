import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings,
  charges,
  creditLedger,
  dogs,
  invoices,
  notifications,
  pendingRequestDogs,
  pendingRequestPreferredDates,
  pendingRequests,
} from '../../src/db/schema/schema.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { registerStaffRequestsRoute } from '../../src/routes/staffRequests.js';
import { FIXTURE_IDS, FIXTURE_NOW, topUpCredits } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * P12 B2 (wire 3.0.0; PAY-U19, DECISIONS 118(a); PAY-16): staff approval moves
 * no money. The day-program arm of `POST /staff/requests/:id/approve` is gone,
 * and only the private-lesson, boarding and board-and-train arms remain
 * (`requests-mutations.test.ts` pins those three). A `day-school` or `day-care`
 * row can only predate M2.17; it answers 409 `conflict`, books nothing, moves
 * nothing, stays `submitted`, and can still be denied. Falling through to the
 * private-lesson arm would book with no credit and no charge, so every refusal
 * here is also tried with a body that arm would accept.
 */

registerFixtureHooks();

const ANY_ARM_WOULD_ACCEPT = {
  scheduled_at: '2026-07-20T15:00:00Z',
  location: 'fayetteville',
} as const;

function staffApp(): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_ROLE_PRINCIPAL);
  registerStaffRequestsRoute(app, { authenticate });
  return app;
}

function ownerApp(): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerRequestsRoute(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

type PlantedCategory = 'day-school' | 'day-care' | 'group-class' | 'evaluation';

/** A `submitted` row POST /requests cannot make: planted, as only an old row can be. */
async function plantRequest(category: PlantedCategory): Promise<string> {
  const id = randomUUID();
  await db.insert(pendingRequests).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: FIXTURE_IDS.dog1Id,
    category,
    status: 'submitted',
  });
  await db
    .insert(pendingRequestDogs)
    .values({ requestId: id, dogId: FIXTURE_IDS.dog1Id, isLead: true });
  await db
    .insert(pendingRequestPreferredDates)
    .values({ requestId: id, ordinal: 1, preferredAt: '2026-07-15T14:00:00Z' });
  return id;
}

/** Every row that would show money or a booking moved for the fixture owner. */
async function ownerRowCounts(): Promise<Record<string, number>> {
  const ownerId = FIXTURE_IDS.ownerId;
  const ownerDogs = db.select({ id: dogs.id }).from(dogs).where(eq(dogs.ownerId, ownerId));
  const [bookingRows, ledgerRows, invoiceRows, chargeRows, notificationRows] = await Promise.all([
    db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ownerId, ownerId)),
    db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(inArray(creditLedger.dogId, ownerDogs)),
    db.select({ id: invoices.id }).from(invoices).where(eq(invoices.ownerId, ownerId)),
    db.select({ id: charges.id }).from(charges).where(eq(charges.ownerId, ownerId)),
    db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.ownerId, ownerId)),
  ]);
  return {
    bookings: bookingRows.length,
    credit_ledger: ledgerRows.length,
    invoices: invoiceRows.length,
    charges: chargeRows.length,
    notifications: notificationRows.length,
  };
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: pendingRequests.status })
    .from(pendingRequests)
    .where(eq(pendingRequests.id, id));
  return row?.status;
}

function approve(id: string, payload: Record<string, unknown>, key = `approve-${randomUUID()}`) {
  return staffApp().inject({
    method: 'POST',
    url: `/staff/requests/${id}/approve`,
    headers: { 'idempotency-key': key },
    payload,
  });
}

function deny(id: string) {
  return staffApp().inject({
    method: 'POST',
    url: `/staff/requests/${id}/deny`,
    headers: { 'idempotency-key': `deny-${randomUUID()}` },
    payload: {},
  });
}

async function assertRefused(id: string, payload: Record<string, unknown>): Promise<void> {
  const before = await ownerRowCounts();
  const res = await approve(id, payload);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'conflict');
  assert.deepEqual(await ownerRowCounts(), before, 'a refused approve moved something');
  assert.equal(await statusOf(id), 'submitted', 'the row stays submitted');
}

for (const category of ['day-school', 'day-care'] as const) {
  test(
    `a submitted ${category} row: Shanthi's approve is 409 and moves nothing; deny is 200`,
    SKIP_WHEN_NO_DB,
    async () => {
      // Credits on hand: the deleted arm would have debited these.
      await topUpCredits(FIXTURE_IDS.dog1Id, category === 'day-school' ? 'school' : 'daycare', 5);
      const id = await plantRequest(category);

      await assertRefused(id, {});
      await assertRefused(id, ANY_ARM_WOULD_ACCEPT);

      const denied = await deny(id);
      assert.equal(denied.statusCode, 200, denied.body);
      const body = denied.json() as { status: string; approved_by_staff_id?: string };
      assert.equal(body.status, 'cancelled');
      assert.equal(body.approved_by_staff_id, FIXTURE_IDS.staffShanthiId);
    },
  );
}

for (const category of ['group-class', 'evaluation'] as const) {
  test(
    `a submitted ${category} row, the arm's type narrowed: refused the same way, never booked`,
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await plantRequest(category);
      await assertRefused(id, {});
      await assertRefused(id, ANY_ARM_WOULD_ACCEPT);
    },
  );
}

test(
  'a refused approve holds its idempotency key to nothing: the same key answers 409 again and the row can still be denied',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await plantRequest('day-school');
    const key = `approve-replay-${randomUUID()}`;
    const first = await approve(id, {}, key);
    const second = await approve(id, {}, key);
    assert.equal(first.statusCode, 409, first.body);
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(await statusOf(id), 'submitted');
    assert.equal((await deny(id)).statusCode, 200);
  },
);

// ── PendingRequestWire lost location, payment and divert_reasons ────────────

const PENDING_REQUEST_WIRE_KEYS = new Set([
  'id',
  'dog_id',
  'additional_dog_ids',
  'category',
  'submitted_at',
  'preferred_dates',
  'notes',
  'focus',
  'status',
  'length_weeks',
  'lesson_setting',
  'approved_at',
  'approved_by_staff_id',
  'converted_booking_id',
]);

function strayKeys(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap(Object.keys))].filter((k) => !PENDING_REQUEST_WIRE_KEYS.has(k));
}

test(
  'GET /requests and GET /staff/requests send no key outside PendingRequestWire, on a surviving day-program row too',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await plantRequest('day-school');

    const mine = await ownerApp().inject({ method: 'GET', url: '/requests' });
    assert.equal(mine.statusCode, 200, mine.body);
    const owned = mine.json() as Record<string, unknown>[];
    assert.ok(
      owned.some((r) => r.id === id),
      'the surviving row still reads',
    );
    assert.deepEqual(strayKeys(owned), []);

    const queue = await staffApp().inject({ method: 'GET', url: '/staff/requests' });
    assert.equal(queue.statusCode, 200, queue.body);
    const all = queue.json() as Record<string, unknown>[];
    assert.ok(
      all.some((r) => r.id === id),
      'the surviving row still reads',
    );
    assert.deepEqual(strayKeys(all), []);
  },
);
