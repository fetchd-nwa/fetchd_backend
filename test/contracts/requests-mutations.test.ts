import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  bookingDogs as bookingDogsTable,
  dogs as dogsTable,
  notificationDogs as notificationDogsTable,
  notifications as notificationsTable,
  owners as ownersTable,
  pendingRequestDogs as pendingRequestDogsTable,
  pendingRequestPreferredDates as pendingRequestPreferredDatesTable,
  pendingRequests as pendingRequestsTable,
} from '../../src/db/schema/schema.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { registerStaffRequestsRoute } from '../../src/routes/staffRequests.js';
import type { Principal } from '../../src/auth/principal.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day 12 contract tests for the request-and-approval surface
 * (DATA-CONTRACT §C.1 Model 3). Covers:
 *
 *   - Owner side (`routes/requests.ts`):
 *     - POST /requests (PL / B&T / boarding bodies)
 *     - PATCH /requests/:id (preferred_dates / notes / focus / length_weeks)
 *     - POST /requests/:id/cancel (owner self-withdrawal)
 *
 *   - Staff side (`routes/staffRequests.ts` — portal verb 1):
 *     - POST /staff/requests/:id/approve (PL/boarding → converted + booking
 *       + notification; B&T → approved-awaiting-payment, no booking yet)
 *     - POST /staff/requests/:id/deny (staff cancellation, distinguished
 *       from owner self-cancel by `approved_by_staff_id`)
 *
 * Each test creates its own pending_request rows (via direct INSERT or
 * via the POST endpoint) so cross-test bleed-through is avoided. The
 * fixture's teardown wipes by owner_id, catching everything by the end
 * of the file.
 */

registerFixtureHooks();

// Real "now" is ~2026-05-24 per the system clock; pick preferred_dates
// safely in the future of any real run (well within the 92-day cap).
const PREFERRED_1 = '2026-07-15T15:00:00Z';
const PREFERRED_2 = '2026-07-22T15:00:00Z';
const PREFERRED_3 = '2026-07-29T15:00:00Z';
const APPROVE_SCHEDULED_AT = '2026-07-20T15:00:00Z';
const APPROVE_PICKUP_AT = '2026-07-23T17:00:00Z';

/** Build a Fastify app with both Day-12 routes mounted. */
function requestsApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerRequestsRoute(app, { authenticate });
  registerStaffRequestsRoute(app, { authenticate });
  return { app };
}

/** Inject a POST /requests call with sensible defaults. */
async function postRequest(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: '/requests',
    headers,
    payload: opts.payload,
  });
}

async function patchRequest(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  id: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'PATCH',
    url: `/requests/${opts.id}`,
    headers,
    payload: opts.payload,
  });
}

async function cancelRequest(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  id: string;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: `/requests/${opts.id}/cancel`,
    headers,
    payload: {},
  });
}

async function approveRequest(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  id: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: `/staff/requests/${opts.id}/approve`,
    headers,
    payload: opts.payload,
  });
}

async function denyRequest(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  id: string;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: `/staff/requests/${opts.id}/deny`,
    headers,
    payload: {},
  });
}

/**
 * Direct DB insertion of a `submitted` pending_request. Used by tests
 * that exercise the staff approve verb — bypasses POST /requests so the
 * test isn't coupled to the submission validator. Returns the inserted
 * id.
 */
async function seedSubmittedRequest(args: {
  category: 'private-lesson' | 'board-and-train' | 'boarding';
  additionalDogIds?: string[];
  lengthWeeks?: number;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(pendingRequestsTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: FIXTURE_IDS.dog1Id,
    category: args.category,
    status: 'submitted',
    lengthWeeks: args.lengthWeeks ?? null,
  });
  const dogRows = [{ requestId: id, dogId: FIXTURE_IDS.dog1Id, isLead: true }];
  for (const dogId of args.additionalDogIds ?? []) {
    dogRows.push({ requestId: id, dogId, isLead: false });
  }
  await db.insert(pendingRequestDogsTable).values(dogRows);
  await db.insert(pendingRequestPreferredDatesTable).values([
    { requestId: id, ordinal: 1, preferredAt: PREFERRED_1 },
    { requestId: id, ordinal: 2, preferredAt: PREFERRED_2 },
  ]);
  return id;
}

/** Soft-expire only the OPEN (submitted/approved/awaiting-payment) requests
 * these dogs are on, so the Day-19d duplicate guard doesn't trip a fresh
 * same-category submit against fixture-seeded requests. Leaves converted /
 * cancelled requests intact (they don't trip the guard and other tests depend
 * on them). Test-only isolation (mirrors the booking tests' clear helpers). */
async function clearOpenRequestsForDogs(dogIds: string[]): Promise<void> {
  const idRows = await db
    .select({ requestId: pendingRequestDogsTable.requestId })
    .from(pendingRequestDogsTable)
    .where(inArray(pendingRequestDogsTable.dogId, dogIds));
  const ids = [...new Set(idRows.map((r) => r.requestId))];
  if (ids.length === 0) return;
  await db
    .update(pendingRequestsTable)
    .set({ expiredAt: new Date().toISOString() })
    .where(
      and(
        inArray(pendingRequestsTable.id, ids),
        inArray(pendingRequestsTable.status, [
          'submitted',
          'approved',
          'approved-awaiting-payment',
        ]),
      ),
    );
}

// ──────────────────────────────────────────────────────────────────────────
// POST /requests (owner-side submission)
// ──────────────────────────────────────────────────────────────────────────

test('POST /requests — private-lesson multi-dog → 201 + wire shape', SKIP_WHEN_NO_DB, async () => {
  await clearOpenRequestsForDogs([FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id]);
  const { app } = requestsApp();
  const res = await postRequest({
    app,
    idempotencyKey: `pr-pl-${randomUUID()}`,
    payload: {
      category: 'private-lesson',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      additional_dog_ids: [FIXTURE_IDS.dog2Id],
      preferred_dates: [PREFERRED_1, PREFERRED_2, PREFERRED_3],
      notes: { per_dog: 'Waffles needs leash polish', joint: 'walk best together' },
      focus: { staff_preference: 'rachel', descriptor_keys: ['nervous', 'reactive-on-leash'] },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as {
    id: string;
    dog_id: string;
    additional_dog_ids?: string[];
    category: string;
    status: string;
    preferred_dates: string[];
    notes?: { per_dog?: string; joint?: string };
    focus: { staff_preference?: string; descriptor_keys?: string[] };
  };
  assert.equal(body.category, 'private-lesson');
  assert.equal(body.status, 'submitted');
  assert.equal(body.dog_id, FIXTURE_IDS.dog1Id);
  assert.deepEqual(body.additional_dog_ids, [FIXTURE_IDS.dog2Id]);
  assert.equal(body.preferred_dates.length, 3);
  assert.equal(body.notes?.per_dog, 'Waffles needs leash polish');
  assert.equal(body.notes?.joint, 'walk best together');
  assert.equal(body.focus.staff_preference, 'rachel');
  assert.deepEqual(body.focus.descriptor_keys, ['nervous', 'reactive-on-leash']);
});

test(
  'POST /requests — dog with an open same-category request → 422 already_requested (Day-19d guard)',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearOpenRequestsForDogs([FIXTURE_IDS.dog1Id]);
    const { app } = requestsApp();
    const first = await postRequest({
      app,
      idempotencyKey: `pr-dup-1-${randomUUID()}`,
      payload: {
        category: 'private-lesson',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        preferred_dates: [PREFERRED_1, PREFERRED_2],
      },
    });
    assert.equal(first.statusCode, 201, first.body);

    const second = await postRequest({
      app,
      idempotencyKey: `pr-dup-2-${randomUUID()}`,
      payload: {
        category: 'private-lesson',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        preferred_dates: [PREFERRED_3],
      },
    });
    assert.equal(second.statusCode, 422, second.body);
    const dup = second.json() as {
      error: { code: string; details: { kind: string; category: string; dog_ids: string[] } };
    };
    assert.equal(dup.error.code, 'already_requested');
    assert.equal(dup.error.details.category, 'private-lesson');
    assert.deepEqual(dup.error.details.dog_ids, [FIXTURE_IDS.dog1Id]);

    // Clean up so a later private-lesson test for this dog isn't tripped.
    await clearOpenRequestsForDogs([FIXTURE_IDS.dog1Id]);
  },
);

test('POST /requests — board-and-train single-dog → 201', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp();
  const res = await postRequest({
    app,
    idempotencyKey: `pr-bnt-${randomUUID()}`,
    payload: {
      category: 'board-and-train',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      preferred_dates: [PREFERRED_1, PREFERRED_2],
      length_weeks: 2,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as {
    category: string;
    length_weeks?: number;
    additional_dog_ids?: string[];
  };
  assert.equal(body.category, 'board-and-train');
  assert.equal(body.length_weeks, 2);
  assert.equal(body.additional_dog_ids, undefined, 'B&T is single-dog — no additional_dog_ids');
});

test('POST /requests — boarding → 201', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp();
  const res = await postRequest({
    app,
    idempotencyKey: `pr-boarding-${randomUUID()}`,
    payload: {
      category: 'boarding',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      preferred_dates: [PREFERRED_1, PREFERRED_2],
      notes: { per_dog: '5-night stay' },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { category: string; length_weeks?: number };
  assert.equal(body.category, 'boarding');
  assert.equal(body.length_weeks, undefined);
});

test(
  'POST /requests — B&T with additional_dog_ids → 422 (single-dog only)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = requestsApp();
    const res = await postRequest({
      app,
      idempotencyKey: `pr-bnt-multi-${randomUUID()}`,
      payload: {
        category: 'board-and-train',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        additional_dog_ids: [FIXTURE_IDS.dog2Id],
        preferred_dates: [PREFERRED_1],
        length_weeks: 2,
      },
    });
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_payload');
  },
);

test('POST /requests — B&T without length_weeks → 422 (required)', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp();
  const res = await postRequest({
    app,
    idempotencyKey: `pr-bnt-nolen-${randomUUID()}`,
    payload: {
      category: 'board-and-train',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      preferred_dates: [PREFERRED_1],
    },
  });
  assert.equal(res.statusCode, 422, res.body);
});

test('POST /requests — PL with length_weeks → 422 (B&T-only field)', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp();
  const res = await postRequest({
    app,
    idempotencyKey: `pr-pl-withlen-${randomUUID()}`,
    payload: {
      category: 'private-lesson',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      preferred_dates: [PREFERRED_1],
      length_weeks: 2,
    },
  });
  assert.equal(res.statusCode, 422, res.body);
});

test('POST /requests — dog not owned by principal → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp();
  const otherDogId = randomUUID();
  const res = await postRequest({
    app,
    idempotencyKey: `pr-baddog-${randomUUID()}`,
    payload: {
      category: 'private-lesson',
      lead_dog_id: otherDogId,
      preferred_dates: [PREFERRED_1],
    },
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /requests — staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await postRequest({
    app,
    idempotencyKey: `pr-staff-${randomUUID()}`,
    payload: {
      category: 'private-lesson',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      preferred_dates: [PREFERRED_1],
    },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('POST /requests — missing Idempotency-Key → 400', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp();
  const res = await postRequest({
    app,
    payload: {
      category: 'private-lesson',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      preferred_dates: [PREFERRED_1],
    },
  });
  assert.equal(res.statusCode, 400, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /requests/:id (owner-side edit)
// ──────────────────────────────────────────────────────────────────────────

test('PATCH /requests/:id — edit preferred_dates → 200', SKIP_WHEN_NO_DB, async () => {
  const id = await seedSubmittedRequest({ category: 'private-lesson' });
  const { app } = requestsApp();
  const res = await patchRequest({
    app,
    id,
    idempotencyKey: `pr-patch-${randomUUID()}`,
    payload: { preferred_dates: [PREFERRED_2, PREFERRED_3] },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { preferred_dates: string[] };
  assert.equal(body.preferred_dates.length, 2);
});

test('PATCH /requests/:id — change category → 422 (identity locked)', SKIP_WHEN_NO_DB, async () => {
  const id = await seedSubmittedRequest({ category: 'private-lesson' });
  const { app } = requestsApp();
  const res = await patchRequest({
    app,
    id,
    idempotencyKey: `pr-patch-cat-${randomUUID()}`,
    payload: { category: 'boarding' },
  });
  assert.equal(res.statusCode, 422, res.body);
  const body = res.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'invalid_payload');
  assert.ok(body.error.message.includes('category'));
});

test(
  'PATCH /requests/:id — patch a converted request → 409 conflict',
  SKIP_WHEN_NO_DB,
  async () => {
    // The fixture's pendingRequest2 has status='converted' — perfect for this test.
    const { app } = requestsApp();
    const res = await patchRequest({
      app,
      id: FIXTURE_IDS.pendingRequest2Id,
      idempotencyKey: `pr-patch-conv-${randomUUID()}`,
      payload: { length_weeks: 3 },
    });
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'conflict');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /requests/:id/cancel (owner-side withdrawal)
// ──────────────────────────────────────────────────────────────────────────

test('POST /requests/:id/cancel — happy → status=cancelled', SKIP_WHEN_NO_DB, async () => {
  const id = await seedSubmittedRequest({ category: 'private-lesson' });
  const { app } = requestsApp();
  const res = await cancelRequest({
    app,
    id,
    idempotencyKey: `pr-cancel-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { status: string };
  assert.equal(body.status, 'cancelled');

  // approved_by_staff_id stays NULL (owner self-cancel, not staff deny)
  const [row] = await db
    .select({ approvedByStaffId: pendingRequestsTable.approvedByStaffId })
    .from(pendingRequestsTable)
    .where(eq(pendingRequestsTable.id, id));
  assert.equal(row?.approvedByStaffId, null);
});

test('POST /requests/:id/cancel — already-converted → 409 conflict', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp();
  const res = await cancelRequest({
    app,
    id: FIXTURE_IDS.pendingRequest2Id, // status='converted'
    idempotencyKey: `pr-cancel-conv-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 409, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/requests/:id/approve (portal verb 1)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/requests/:id/approve — PL happy: converted + booking + notification',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedSubmittedRequest({ category: 'private-lesson' });
    const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await approveRequest({
      app,
      id,
      idempotencyKey: `pr-approve-pl-${randomUUID()}`,
      payload: { scheduled_at: APPROVE_SCHEDULED_AT, location: 'fayetteville' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      id: string;
      status: string;
      approved_at?: string;
      converted_booking_id?: string;
    };
    assert.equal(body.status, 'converted');
    assert.ok(body.approved_at, 'approved_at stamped');
    assert.ok(body.converted_booking_id, 'converted_booking_id set');

    // Booking row exists with the right shape.
    const [booking] = await db
      .select({
        id: bookingsTable.id,
        category: bookingsTable.category,
        leadDogId: bookingsTable.leadDogId,
        location: bookingsTable.location,
        scheduledAt: bookingsTable.scheduledAt,
      })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, body.converted_booking_id!));
    assert.ok(booking, 'booking row created');
    assert.equal(booking?.category, 'private-lesson');
    assert.equal(booking?.leadDogId, FIXTURE_IDS.dog1Id);
    assert.equal(booking?.location, 'fayetteville');

    // booking_dogs has the lead row.
    const links = await db
      .select({ dogId: bookingDogsTable.dogId, isLead: bookingDogsTable.isLead })
      .from(bookingDogsTable)
      .where(eq(bookingDogsTable.bookingId, body.converted_booking_id!));
    assert.equal(links.length, 1);
    assert.equal(links[0]?.isLead, true);

    // Notification was enqueued.
    const notifs = await db
      .select({
        id: notificationsTable.id,
        type: notificationsTable.type,
        deepLinkPath: notificationsTable.deepLinkPath,
      })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.ownerId, FIXTURE_IDS.ownerId),
          eq(notificationsTable.type, 'booking-confirmed'),
          eq(notificationsTable.deepLinkPath, `/bookings/${body.converted_booking_id!}`),
        ),
      );
    assert.equal(notifs.length, 1, 'one booking-confirmed notification enqueued');

    // pending_requests.approved_by_staff_id stamped with the staff actor.
    const [pr] = await db
      .select({ approvedByStaffId: pendingRequestsTable.approvedByStaffId })
      .from(pendingRequestsTable)
      .where(eq(pendingRequestsTable.id, id));
    assert.equal(pr?.approvedByStaffId, FIXTURE_IDS.staffDonavanId);
  },
);

test(
  'POST /staff/requests/:id/approve — B&T two-step: parks at approved-awaiting-payment',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedSubmittedRequest({ category: 'board-and-train', lengthWeeks: 2 });
    const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await approveRequest({
      app,
      id,
      idempotencyKey: `pr-approve-bnt-${randomUUID()}`,
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      status: string;
      approved_at?: string;
      converted_booking_id?: string;
    };
    assert.equal(body.status, 'approved-awaiting-payment');
    assert.ok(body.approved_at, 'approved_at stamped');
    assert.equal(body.converted_booking_id, undefined, 'no booking insert at this step');

    // Confirm DB state directly: approved_by_staff_id is set; no
    // booking exists for this request.
    const [pr] = await db
      .select({
        status: pendingRequestsTable.status,
        approvedByStaffId: pendingRequestsTable.approvedByStaffId,
        convertedBookingId: pendingRequestsTable.convertedBookingId,
      })
      .from(pendingRequestsTable)
      .where(eq(pendingRequestsTable.id, id));
    assert.equal(pr?.status, 'approved-awaiting-payment');
    assert.equal(pr?.approvedByStaffId, FIXTURE_IDS.staffDonavanId);
    assert.equal(pr?.convertedBookingId, null);
  },
);

test(
  'POST /staff/requests/:id/approve — boarding happy: dropoff_at + pickup_at on booking',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedSubmittedRequest({ category: 'boarding' });
    const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await approveRequest({
      app,
      id,
      idempotencyKey: `pr-approve-boarding-${randomUUID()}`,
      payload: {
        scheduled_at: APPROVE_SCHEDULED_AT,
        pickup_at: APPROVE_PICKUP_AT,
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { converted_booking_id?: string };
    assert.ok(body.converted_booking_id);
    const [booking] = await db
      .select({
        dropoffAt: bookingsTable.dropoffAt,
        pickupAt: bookingsTable.pickupAt,
        category: bookingsTable.category,
      })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, body.converted_booking_id!));
    assert.equal(booking?.category, 'boarding');
    assert.ok(booking?.dropoffAt, 'dropoff_at set');
    assert.ok(booking?.pickupAt, 'pickup_at set');
  },
);

test(
  'POST /staff/requests/:id/approve — already-converted → 409 conflict',
  SKIP_WHEN_NO_DB,
  async () => {
    // The fixture's pendingRequest2 is already 'converted'.
    const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await approveRequest({
      app,
      id: FIXTURE_IDS.pendingRequest2Id,
      idempotencyKey: `pr-approve-conv-${randomUUID()}`,
      payload: { scheduled_at: APPROVE_SCHEDULED_AT, location: 'fayetteville' },
    });
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'conflict');
  },
);

test('POST /staff/requests/:id/approve — unknown id → 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await approveRequest({
    app,
    id: randomUUID(),
    idempotencyKey: `pr-approve-404-${randomUUID()}`,
    payload: { scheduled_at: APPROVE_SCHEDULED_AT, location: 'fayetteville' },
  });
  assert.equal(res.statusCode, 404, res.body);
});

test('POST /staff/requests/:id/approve — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const id = await seedSubmittedRequest({ category: 'private-lesson' });
  const { app } = requestsApp(); // owner
  const res = await approveRequest({
    app,
    id,
    idempotencyKey: `pr-approve-owner-${randomUUID()}`,
    payload: { scheduled_at: APPROVE_SCHEDULED_AT, location: 'fayetteville' },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test(
  'POST /staff/requests/:id/approve — idempotency replay returns stored body',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedSubmittedRequest({ category: 'private-lesson' });
    const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const key = `pr-approve-idem-${randomUUID()}`;
    const payload = { scheduled_at: APPROVE_SCHEDULED_AT, location: 'fayetteville' };
    const first = await approveRequest({ app, id, idempotencyKey: key, payload });
    assert.equal(first.statusCode, 200, first.body);
    const replay = await approveRequest({ app, id, idempotencyKey: key, payload });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json(), 'replay body byte-identical');

    // The replay returned the SAME converted_booking_id as the first
    // call (per the idempotency contract). Confirm exactly one booking
    // row exists for that id — replay didn't insert a second one.
    const firstBody = first.json() as { converted_booking_id?: string };
    assert.ok(firstBody.converted_booking_id, 'first call returned a booking id');
    const matching = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, firstBody.converted_booking_id!));
    assert.equal(matching.length, 1, 'exactly one booking row for the converted id');

    // Also confirm pending_requests is in the converted terminal
    // state — replay didn't re-run the txn (the markConverted state
    // change would have raised a 409 the second time if the body had
    // actually executed against the row).
    const [pr] = await db
      .select({
        status: pendingRequestsTable.status,
        convertedBookingId: pendingRequestsTable.convertedBookingId,
      })
      .from(pendingRequestsTable)
      .where(eq(pendingRequestsTable.id, id));
    assert.equal(pr?.status, 'converted');
    assert.equal(pr?.convertedBookingId, firstBody.converted_booking_id);
  },
);

test(
  'POST /staff/requests/:id/approve — race: two concurrent approves → exactly one converts',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedSubmittedRequest({ category: 'private-lesson' });
    const { app: app1 } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const { app: app2 } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const payload = { scheduled_at: APPROVE_SCHEDULED_AT, location: 'fayetteville' };
    const [resA, resB] = await Promise.all([
      approveRequest({
        app: app1,
        id,
        idempotencyKey: `pr-race-a-${randomUUID()}`,
        payload,
      }),
      approveRequest({
        app: app2,
        id,
        idempotencyKey: `pr-race-b-${randomUUID()}`,
        payload,
      }),
    ]);
    const codes = [resA.statusCode, resB.statusCode].sort();
    assert.deepEqual(
      codes,
      [200, 409],
      `expected exactly one 200 and one 409, got ${codes.join(', ')}`,
    );

    // Exactly one booking exists for this request.
    const [pr] = await db
      .select({
        status: pendingRequestsTable.status,
        convertedBookingId: pendingRequestsTable.convertedBookingId,
      })
      .from(pendingRequestsTable)
      .where(eq(pendingRequestsTable.id, id));
    assert.equal(pr?.status, 'converted');
    assert.ok(pr?.convertedBookingId);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/requests/:id/deny (portal verb 1 — denial)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/requests/:id/deny — happy: status=cancelled + approvedByStaffId stamped',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedSubmittedRequest({ category: 'private-lesson' });
    const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await denyRequest({
      app,
      id,
      idempotencyKey: `pr-deny-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { status: string };
    assert.equal(body.status, 'cancelled');
    const [pr] = await db
      .select({ approvedByStaffId: pendingRequestsTable.approvedByStaffId })
      .from(pendingRequestsTable)
      .where(eq(pendingRequestsTable.id, id));
    assert.equal(
      pr?.approvedByStaffId,
      FIXTURE_IDS.staffDonavanId,
      'staff actor stamped to discriminate from owner self-cancel',
    );
  },
);

test('POST /staff/requests/:id/deny — already-converted → 409', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await denyRequest({
    app,
    id: FIXTURE_IDS.pendingRequest2Id,
    idempotencyKey: `pr-deny-conv-${randomUUID()}`,
  });
  assert.equal(res.statusCode, 409, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/requests?status= (portal verb 1 — the triage queue read)
// ──────────────────────────────────────────────────────────────────────────

/** Inject a staff queue read; status omitted → all live. */
async function getStaffRequests(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  status?: string;
}): ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> {
  const url =
    opts.status !== undefined ? `/staff/requests?status=${opts.status}` : '/staff/requests';
  return opts.app.inject({ method: 'GET', url });
}

/**
 * Seed a single fixture-owner request with an explicit status (and
 * optionally submitted_at, for ordering assertions). Sibling of
 * `seedSubmittedRequest` — kept separate because that one's name promises
 * 'submitted' and the queue tests need other terminal states too.
 */
async function seedRequestRow(args: { status: string; submittedAt?: string }): Promise<string> {
  const id = randomUUID();
  await db.insert(pendingRequestsTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: FIXTURE_IDS.dog1Id,
    category: 'private-lesson',
    status: args.status as 'submitted',
    ...(args.submittedAt !== undefined ? { submittedAt: args.submittedAt } : {}),
  });
  await db
    .insert(pendingRequestDogsTable)
    .values([{ requestId: id, dogId: FIXTURE_IDS.dog1Id, isLead: true }]);
  await db
    .insert(pendingRequestPreferredDatesTable)
    .values([{ requestId: id, ordinal: 1, preferredAt: PREFERRED_1 }]);
  return id;
}

test(
  'GET /staff/requests?status=submitted — staff sees a submitted request with the §B wire shape',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await seedSubmittedRequest({ category: 'private-lesson' });
    const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await getStaffRequests({ app, status: 'submitted' });
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json() as {
      id: string;
      category: string;
      status: string;
      dog_id: string;
      preferred_dates: string[];
    }[];
    const mine = rows.find((r) => r.id === id);
    assert.ok(mine, 'seeded submitted request is present in the staff queue');
    assert.equal(mine.category, 'private-lesson');
    assert.equal(mine.status, 'submitted');
    assert.equal(mine.dog_id, FIXTURE_IDS.dog1Id);
    assert.ok(mine.preferred_dates.length >= 1, 'preferred_dates denormalized onto the wire');
  },
);

test(
  'GET /staff/requests?status=submitted — excludes non-submitted rows',
  SKIP_WHEN_NO_DB,
  async () => {
    const submittedId = await seedRequestRow({ status: 'submitted' });
    const convertedId = await seedRequestRow({ status: 'converted' });
    const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await getStaffRequests({ app, status: 'submitted' });
    assert.equal(res.statusCode, 200, res.body);
    const ids = (res.json() as { id: string }[]).map((r) => r.id);
    assert.ok(ids.includes(submittedId), 'submitted request present');
    assert.ok(!ids.includes(convertedId), 'converted request filtered out by status=submitted');
  },
);

test(
  'GET /staff/requests — no status filter returns all live states',
  SKIP_WHEN_NO_DB,
  async () => {
    const submittedId = await seedRequestRow({ status: 'submitted' });
    const convertedId = await seedRequestRow({ status: 'converted' });
    const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
    const res = await getStaffRequests({ app });
    assert.equal(res.statusCode, 200, res.body);
    const ids = (res.json() as { id: string }[]).map((r) => r.id);
    assert.ok(ids.includes(submittedId), 'submitted present without a filter');
    assert.ok(ids.includes(convertedId), 'converted present without a filter');
  },
);

test('GET /staff/requests — newest submitted_at first', SKIP_WHEN_NO_DB, async () => {
  const olderId = await seedRequestRow({
    status: 'submitted',
    submittedAt: '2026-05-01T12:00:00Z',
  });
  const newerId = await seedRequestRow({
    status: 'submitted',
    submittedAt: '2026-05-02T12:00:00Z',
  });
  const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await getStaffRequests({ app, status: 'submitted' });
  assert.equal(res.statusCode, 200, res.body);
  const ids = (res.json() as { id: string }[]).map((r) => r.id);
  assert.ok(ids.indexOf(newerId) < ids.indexOf(olderId), 'newer request sorts ahead of older');
});

test('GET /staff/requests — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const { app } = requestsApp(); // owner
  const res = await getStaffRequests({ app, status: 'submitted' });
  assert.equal(res.statusCode, 403, res.body);
});

test(
  "GET /staff/requests — cross-owner: staff sees a different owner's request",
  SKIP_WHEN_NO_DB,
  async () => {
    const owner2Id = randomUUID();
    const dog2bId = randomUUID();
    const requestId = randomUUID();
    try {
      await db.insert(ownersTable).values({
        id: owner2Id,
        supabaseUid: randomUUID(),
        name: 'Second Owner',
        email: `owner2-${owner2Id}@example.com`,
        phone: '555-0003',
        location: 'fayetteville',
        avatarImagePath: '',
        emergencyName: 'EC',
        emergencyRelationship: 'friend',
        emergencyPhone: '555-0004',
        pushNotificationsEnabled: true,
        pushNotificationCategories: { booking: true, message: true },
        emailNotificationsEnabled: true,
        emailNotificationCategories: { booking: true, message: true },
      });
      await db.insert(dogsTable).values({
        id: dog2bId,
        ownerId: owner2Id,
        name: 'Cross Dog',
        breed: 'Mixed',
        birthdate: '2022-01-01',
        specialNotes: '',
        evaluationStatus: 'passed',
        evaluationDate: '2024-01-01T15:00:00Z',
        profileImagePath: null,
      });
      await db.insert(pendingRequestsTable).values({
        id: requestId,
        ownerId: owner2Id,
        leadDogId: dog2bId,
        category: 'private-lesson',
        status: 'submitted',
      });
      await db
        .insert(pendingRequestDogsTable)
        .values([{ requestId, dogId: dog2bId, isLead: true }]);
      await db
        .insert(pendingRequestPreferredDatesTable)
        .values([{ requestId, ordinal: 1, preferredAt: PREFERRED_1 }]);

      const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
      const res = await getStaffRequests({ app, status: 'submitted' });
      assert.equal(res.statusCode, 200, res.body);
      const ids = (res.json() as { id: string }[]).map((r) => r.id);
      assert.ok(ids.includes(requestId), 'staff queue spans owners (cross-owner read)');
    } finally {
      // Teardown wipes by the fixture owner only — clean up owner2's rows
      // here (reverse FK order) so they don't bleed into later tests.
      await db
        .delete(pendingRequestPreferredDatesTable)
        .where(eq(pendingRequestPreferredDatesTable.requestId, requestId));
      await db
        .delete(pendingRequestDogsTable)
        .where(eq(pendingRequestDogsTable.requestId, requestId));
      await db.delete(pendingRequestsTable).where(eq(pendingRequestsTable.id, requestId));
      await db.delete(dogsTable).where(eq(dogsTable.id, dog2bId));
      await db.delete(ownersTable).where(eq(ownersTable.id, owner2Id));
    }
  },
);

// Suppress unused-import lint warnings — these tables are referenced
// by the schema helpers but not directly by the assertions above.
void notificationDogsTable;
void pendingRequestPreferredDatesTable;
void inArray;
