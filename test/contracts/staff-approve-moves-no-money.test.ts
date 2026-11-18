import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings,
  charges,
  creditLedger,
  dogs,
  invoices,
  notifications,
  owners,
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
  registerRequestServicesOn,
} from './_harness.js';
import * as rs from './_requestServices.js';

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
  registerStaffRequestsRoute(app, { authenticate, now: FIXTURE_NOW });
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
  // 9.0.0 (A6): a Board & Train's approved fields.
  'approved_trainer',
  'approved_dropoff_at',
  'approved_pickup_at',
  'approved_price_cents',
]);

/** 9.0.0 (A7): the staff queue's row is `PendingRequestWire` plus three keys. */
const STAFF_REQUEST_WIRE_KEYS = new Set([
  ...PENDING_REQUEST_WIRE_KEYS,
  'owner',
  'dogs',
  'preferred_trainer',
]);

function strayKeys(rows: Record<string, unknown>[], allowed = PENDING_REQUEST_WIRE_KEYS): string[] {
  return [...new Set(rows.flatMap(Object.keys))].filter((k) => !allowed.has(k));
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
    assert.deepEqual(strayKeys(all, STAFF_REQUEST_WIRE_KEYS), []);
  },
);

// ── P49 (wire 9.0.0; design request-services-v1 §2.2 A3, A7, A13) ────────────
//
// Nothing is booked until staff approve (her 413, 414): a lesson when staff confirm one of
// her times, a Board & Train when staff approve dates and a trainer and the family says yes.
// No arm moves money. The fixture's trainers: Rachel 15000 + B&T, Shanthi 20000 + B&T,
// Donavan and Amber neither.

registerRequestServicesOn();
afterEach(rs.clearRequestServiceRows);

/** The approve answered 422 `invalid_payload` and wrote nothing. */
async function refusedInvalid(
  res: { statusCode: number; body: string },
  id: string,
  status: string = 'submitted',
): Promise<void> {
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(rs.errorCode(res), 'invalid_payload', res.body);
  assert.equal(await statusOf(id), status, 'the row moved');
  assert.equal((await rs.testBookings()).length, 0, 'a booking was written');
}

async function noticesFor(deepLinkId: string) {
  return db
    .select({
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      deepLinkPath: notifications.deepLinkPath,
      deepLinkKind: notifications.deepLinkKind,
      deepLinkId: notifications.deepLinkId,
    })
    .from(notifications)
    .where(eq(notifications.deepLinkId, deepLinkId));
}

describe('the lesson arm: staff confirm one of her times, and that books it', () => {
  test(
    'Amber confirms Sat 6 Jun 10:00 with Rachel: the booking stores the trainer, the length and the quote 15000; $0 and no Stripe call',
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await rs.plantRequest({
        category: 'private-lesson',
        dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
        staffPreference: FIXTURE_IDS.staffRachelId,
      });
      const before = await rs.moneyRows();
      const trap = rs.trapDefaultStripe();
      let res;
      try {
        res = await rs.approveLesson(
          id,
          { duration_minutes: 45 },
          { app: rs.staffApp(undefined, rs.AMBER) },
        );
      } finally {
        trap.restore();
      }
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(trap.calls, []);
      assert.deepEqual(await rs.moneyRows(), before, 'the approve moved money');
      const wire = res.json() as { status: string; converted_booking_id?: string };
      assert.equal(wire.status, 'converted');
      const [booking] = await rs.testBookings();
      assert.ok(booking !== undefined && booking.id === wire.converted_booking_id);
      assert.equal(booking.category, 'private-lesson');
      assert.equal(booking.trainerStaffId, FIXTURE_IDS.staffRachelId);
      assert.equal(booking.durationMinutes, 45);
      assert.equal(booking.quotedPriceCents, 15000);
      assert.equal(booking.location, 'fayetteville');
      assert.equal(booking.orderId, null);
      const notices = await noticesFor(booking.id);
      assert.deepEqual(
        notices.map((n) => [n.type, n.body]),
        [['booking-confirmed', 'Booked: Sat 6 Jun 10:00 with Rachel, $150, paid after.']],
      );
    },
  );

  test('duration_minutes omitted → 60; outside 15..240 or not whole → 400', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'private-lesson' });
    for (const duration_minutes of [14, 241, 45.5]) {
      const bad = await rs.approveLesson(id, { duration_minutes });
      assert.equal(bad.statusCode, 400, bad.body);
      assert.equal(rs.errorCode(bad), 'bad_request');
    }
    const res = await rs.approveLesson(id);
    assert.equal(res.statusCode, 200, res.body);
    const [booking] = await rs.testBookings();
    assert.equal(booking?.durationMinutes, 60);
  });

  test('a time not among hers → 422, nothing booked', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'private-lesson' });
    await refusedInvalid(await rs.approveLesson(id, { scheduled_at: '2026-06-06T16:00:00.000Z' }), id);
  });

  test(
    'a time among hers that has already passed → 422, and no booking exists (DECISIONS 463(1))',
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await rs.plantRequest({
        category: 'private-lesson',
        preferredDates: [rs.PAST_TIME, rs.LESSON_TIMES[0]],
      });
      await refusedInvalid(await rs.approveLesson(id, { scheduled_at: rs.PAST_TIME }), id);
      // At the instant itself is "at or before now" too.
      const atNow = rs.staffApp(() => new Date(rs.LESSON_TIMES[0]));
      await refusedInvalid(await rs.approveLesson(id, {}, { app: atNow }), id);
    },
  );

  test('a trainer she did not name → 422', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({
      category: 'private-lesson',
      staffPreference: FIXTURE_IDS.staffRachelId,
    });
    await refusedInvalid(
      await rs.approveLesson(id, { trainer_staff_id: FIXTURE_IDS.staffShanthiId }),
      id,
    );
  });

  test('an unpriced trainer → 422; no trainer → 422', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'private-lesson', staffPreference: 'any' });
    await refusedInvalid(
      await rs.approveLesson(id, { trainer_staff_id: FIXTURE_IDS.staffDonavanId }),
      id,
    );
    await refusedInvalid(
      await rs.approve(id, { scheduled_at: rs.LESSON_TIMES[0], location: 'fayetteville' }),
      id,
    );
  });

  test('a named trainer since expired → 422: staff ask her to edit the request', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({
      category: 'private-lesson',
      staffPreference: FIXTURE_IDS.staffRachelId,
    });
    await rs.withStaff(FIXTURE_IDS.staffRachelId, { expiredAt: '2026-05-18T12:00:00.000Z' }, async () => {
      await refusedInvalid(await rs.approveLesson(id), id);
      // Fable b1 L4(b): she still binds once expired (PL-08: her price is per trainer).
      await refusedInvalid(await rs.approveLesson(id, { trainer_staff_id: FIXTURE_IDS.staffShanthiId }), id);
    });
  });

  // Fable b1 N1: when the trainer she named no longer serves, the sentence to the approver with
  // anyone else says so, and does not tell them to approve with her.
  for (const [arm, set, takes] of [
    ['private-lesson', { lessonPriceCents: null }, 'lessons'],
    ['private-lesson', { expiredAt: '2026-05-18T12:00:00.000Z' }, 'lessons'],
    ['board-and-train', { boardTrainEligible: false }, 'Board & Train'],
  ] as const) {
    test(`N1: a ${arm} naming Rachel, who no longer serves (${Object.keys(set)[0]}), approved with Shanthi → 422: ask them to edit, or deny`, SKIP_WHEN_NO_DB, async () => {
      const id = await rs.plantRequest({ category: arm, staffPreference: FIXTURE_IDS.staffRachelId });
      await rs.withStaff(FIXTURE_IDS.staffRachelId, set, async () => {
        const res =
          arm === 'private-lesson'
            ? await rs.approveLesson(id, { trainer_staff_id: FIXTURE_IDS.staffShanthiId })
            : await rs.approveBoardTrain(id, { trainer_staff_id: FIXTURE_IDS.staffShanthiId });
        await refusedInvalid(res, id);
        assert.equal(
          rs.errorMessage(res),
          `this family asked for Rachel, who no longer takes ${takes}: ask them to edit the request, or deny it`,
        );
      });
    });
  }

  test('a named trainer who still serves, passed over → 422: approve with her, or ask them to edit', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'private-lesson', staffPreference: FIXTURE_IDS.staffRachelId });
    const res = await rs.approveLesson(id, { trainer_staff_id: FIXTURE_IDS.staffShanthiId });
    await refusedInvalid(res, id);
    assert.equal(
      rs.errorMessage(res),
      'this family asked for Rachel: approve with Rachel, or ask them to edit the request',
    );
  });

  for (const preference of ['any', null] as const) {
    test(
      `"anyone" (${String(preference)}) confirmed with Shanthi → quote 20000, and the notice names $200`,
      SKIP_WHEN_NO_DB,
      async () => {
        const id = await rs.plantRequest({ category: 'private-lesson', staffPreference: preference });
        const res = await rs.approveLesson(id, { trainer_staff_id: FIXTURE_IDS.staffShanthiId });
        assert.equal(res.statusCode, 200, res.body);
        const [booking] = await rs.testBookings();
        assert.equal(booking?.quotedPriceCents, 20000);
        assert.equal(booking?.trainerStaffId, FIXTURE_IDS.staffShanthiId);
        const [notice] = await noticesFor(booking?.id as string);
        assert.equal(notice?.body, 'Booked: Sat 6 Jun 10:00 with Shanthi, $200, paid after.');
      },
    );
  }

  test('a lesson refuses dropoff_at and pickup_at → 422', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'private-lesson' });
    await refusedInvalid(await rs.approveLesson(id, { dropoff_at: rs.LESSON_TIMES[0] }), id);
    await refusedInvalid(await rs.approveLesson(id, { pickup_at: rs.LESSON_TIMES[1] }), id);
  });
});

describe('GET /staff/requests: the names the portal prints (A7)', () => {
  type Row = Record<string, unknown> & {
    id: string;
    owner: { id: string; name: string; location?: string };
    dogs: { id: string; name: string }[];
    preferred_trainer?: { staff_id: string; name: string };
  };
  async function queue(): Promise<Row[]> {
    const res = await rs.staffApp().inject({ method: 'GET', url: '/staff/requests' });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as Row[];
  }

  test(
    'rows carry owner (with her home campus), dogs lead first, and preferred_trainer: present for an expired staffer, absent for a slug',
    SKIP_WHEN_NO_DB,
    async () => {
      const named = await rs.plantRequest({
        category: 'private-lesson',
        dogIds: [FIXTURE_IDS.dog2Id, FIXTURE_IDS.dog1Id],
        staffPreference: FIXTURE_IDS.staffRachelId,
      });
      const rows = await queue();
      const row = rows.find((r) => r.id === named);
      assert.ok(row !== undefined);
      assert.deepEqual(row.owner, {
        id: FIXTURE_IDS.ownerId,
        name: 'Allison Fixture',
        location: 'fayetteville',
      });
      assert.deepEqual(row.dogs, [
        { id: FIXTURE_IDS.dog2Id, name: 'Lola' },
        { id: FIXTURE_IDS.dog1Id, name: 'Waffles' },
      ]);
      assert.deepEqual(row.preferred_trainer, { staff_id: FIXTURE_IDS.staffRachelId, name: 'Rachel' });

      // The fixture's request1 names the old slug 'rachel': no staff row, no key.
      const slug = rows.find((r) => r.id === FIXTURE_IDS.pendingRequest1Id);
      assert.ok(slug !== undefined);
      assert.equal('preferred_trainer' in slug, false);

      await rs.withStaff(FIXTURE_IDS.staffRachelId, { expiredAt: '2026-05-18T12:00:00.000Z' }, async () => {
        const again = (await queue()).find((r) => r.id === named);
        assert.deepEqual(again?.preferred_trainer, {
          staff_id: FIXTURE_IDS.staffRachelId,
          name: 'Rachel',
        });
      });
    },
  );

  test('a family with no home campus: owner.location is absent', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'private-lesson' });
    await db.update(owners).set({ location: null }).where(eq(owners.id, FIXTURE_IDS.ownerId));
    try {
      const row = (await queue()).find((r) => r.id === id);
      assert.ok(row !== undefined);
      assert.deepEqual(row.owner, { id: FIXTURE_IDS.ownerId, name: 'Allison Fixture' });
    } finally {
      await db
        .update(owners)
        .set({ location: 'fayetteville' })
        .where(eq(owners.id, FIXTURE_IDS.ownerId));
    }
  });
});

describe('the Board & Train arm: staff approve dates and a trainer; nothing is booked', () => {
  test(
    'Shanthi approves Mon 1 Jun – Sun 14 Jun with Rachel: the four fields stored, parked, request-approved queued; $0 and no Stripe call',
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await rs.plantRequest({ category: 'board-and-train' });
      const before = await rs.moneyRows();
      const trap = rs.trapDefaultStripe();
      let res;
      try {
        res = await rs.approveBoardTrain(id);
      } finally {
        trap.restore();
      }
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(trap.calls, []);
      assert.deepEqual(await rs.moneyRows(), before);
      assert.equal((await rs.testBookings()).length, 0, 'nothing is booked before her yes');
      const wire = res.json() as Record<string, unknown>;
      assert.equal(wire.status, 'approved-awaiting-payment');
      assert.deepEqual(wire.approved_trainer, { staff_id: FIXTURE_IDS.staffRachelId, name: 'Rachel' });
      assert.equal(wire.approved_dropoff_at, rs.BT_STARTS[0]);
      assert.equal(wire.approved_pickup_at, rs.BT_PICKUP);
      assert.equal(wire.approved_price_cents, rs.B_AND_T_PRICE_CENTS);
      assert.equal(wire.approved_by_staff_id, FIXTURE_IDS.staffShanthiId);

      const row = await rs.requestRow(id);
      assert.equal(row?.approvedTrainerStaffId, FIXTURE_IDS.staffRachelId);
      assert.equal(row?.approvedPriceCents, rs.B_AND_T_PRICE_CENTS);

      assert.deepEqual(await noticesFor(id), [
        {
          type: 'request-approved',
          title: 'Board & Train approved',
          body: 'Rachel can take Waffles Mon 1 Jun – Sun 14 Jun. Tap to confirm.',
          deepLinkPath: `/request-detail/boardtrain?id=${id}`,
          deepLinkKind: 'request',
          deepLinkId: id,
        },
      ]);
    },
  );

  test('no dates → 422; a drop-off not among her starts → 422; a pick-up not after it → 422', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'board-and-train' });
    await refusedInvalid(
      await rs.approve(id, { trainer_staff_id: FIXTURE_IDS.staffRachelId }),
      id,
    );
    await refusedInvalid(
      await rs.approveBoardTrain(id, { dropoff_at: '2026-06-09T13:00:00.000Z' }),
      id,
    );
    await refusedInvalid(await rs.approveBoardTrain(id, { pickup_at: rs.BT_STARTS[0] }), id);
    await refusedInvalid(await rs.approveBoardTrain(id, { pickup_at: undefined }), id);
  });

  test('a drop-off among her starts that has passed → 422', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({
      category: 'board-and-train',
      preferredDates: [rs.PAST_TIME, rs.BT_STARTS[0]],
    });
    await refusedInvalid(await rs.approveBoardTrain(id, { dropoff_at: rs.PAST_TIME }), id);
  });

  test('an ineligible trainer → 422; one she did not name → 422; none → 422', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({
      category: 'board-and-train',
      staffPreference: FIXTURE_IDS.staffRachelId,
    });
    await refusedInvalid(
      await rs.approveBoardTrain(id, { trainer_staff_id: FIXTURE_IDS.staffDonavanId }),
      id,
    );
    await refusedInvalid(
      await rs.approveBoardTrain(id, { trainer_staff_id: FIXTURE_IDS.staffShanthiId }),
      id,
    );
    await refusedInvalid(await rs.approveBoardTrain(id, { trainer_staff_id: undefined }), id);
  });

  for (const key of ['scheduled_at', 'location', 'duration_minutes', 'notes'] as const) {
    test(`a Board & Train approve refuses ${key} → 422`, SKIP_WHEN_NO_DB, async () => {
      const id = await rs.plantRequest({ category: 'board-and-train' });
      const value =
        key === 'scheduled_at'
          ? rs.BT_STARTS[0]
          : key === 'location'
            ? 'fayetteville'
            : key === 'duration_minutes'
              ? 60
              : 'bring the crate';
      await refusedInvalid(await rs.approveBoardTrain(id, { [key]: value }), id);
    });
  }
});

describe('old rows (dev only)', () => {
  test('a slug preference approves as "anyone", on a lesson and on a Board & Train', SKIP_WHEN_NO_DB, async () => {
    // The fixture's request1: a lesson naming 'rachel', times 5, 12 and 19 Jun.
    const lesson = await rs.approve(FIXTURE_IDS.pendingRequest1Id, {
      scheduled_at: '2026-06-05T15:00:00.000Z',
      location: 'fayetteville',
      trainer_staff_id: FIXTURE_IDS.staffShanthiId,
    });
    assert.equal(lesson.statusCode, 200, lesson.body);
    const bt = await rs.plantRequest({ category: 'board-and-train', staffPreference: 'rachel' });
    const res = await rs.approveBoardTrain(bt, { trainer_staff_id: FIXTURE_IDS.staffShanthiId });
    assert.equal(res.statusCode, 200, res.body);
    // Put request1 back as the fixture seeded it for the suites after this one.
    await db
      .update(pendingRequests)
      .set({ status: 'submitted', approvedAt: null, approvedByStaffId: null, convertedBookingId: null })
      .where(eq(pendingRequests.id, FIXTURE_IDS.pendingRequest1Id));
  });

  test('a Board & Train asking for 3 weeks → 422 in words', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'board-and-train', lengthWeeks: 3 });
    const res = await rs.approveBoardTrain(id);
    await refusedInvalid(res, id);
    assert.equal(
      rs.errorMessage(res),
      'This request asks for 3 weeks; only the two-week program has a price. Ask the family to edit it.',
    );
  });
});

describe('Take back: the deny of a Board & Train waiting on her yes (A13)', () => {
  test(
    'cancelled with 0 bookings and its approved fields kept; a yes after it → 409; a new Board & Train for the dog is then accepted',
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await rs.plantRequest({ category: 'board-and-train' });
      assert.equal((await rs.approveBoardTrain(id)).statusCode, 200);
      const taken = await rs.deny(id, rs.staffApp(undefined, rs.AMBER));
      assert.equal(taken.statusCode, 200, taken.body);
      const wire = taken.json() as Record<string, unknown>;
      assert.equal(wire.status, 'cancelled');
      assert.equal(wire.approved_by_staff_id, FIXTURE_IDS.staffAmberId, "the denier's id");
      assert.equal(wire.approved_dropoff_at, rs.BT_STARTS[0], 'the approved fields are kept');
      assert.equal(wire.approved_price_cents, rs.B_AND_T_PRICE_CENTS);
      assert.equal((await rs.testBookings()).length, 0);

      const late = await rs.confirm(id);
      assert.equal(late.statusCode, 409, late.body);
      assert.equal((await rs.testBookings()).length, 0);

      const again = await rs.post(rs.ownerApp(), '/requests', {
        category: 'board-and-train',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        preferred_dates: [rs.BT_STARTS[1]],
        length_weeks: 2,
      });
      assert.equal(again.statusCode, 201, again.body);
    },
  );

  test('a deny of a converted request is still 409', SKIP_WHEN_NO_DB, async () => {
    const id = await rs.plantRequest({ category: 'board-and-train' });
    assert.equal((await rs.approveBoardTrain(id)).statusCode, 200);
    assert.equal((await rs.confirm(id)).statusCode, 200);
    const res = await rs.deny(id);
    assert.equal(res.statusCode, 409, res.body);
  });
});

test('boarding is unchanged and refuses the three new keys → 422', SKIP_WHEN_NO_DB, async () => {
  const id = await rs.plantRequest({ category: 'boarding', preferredDates: [rs.BT_STARTS[0]] });
  const base = { scheduled_at: rs.BT_STARTS[0], pickup_at: rs.BT_PICKUP, location: 'fayetteville' };
  for (const extra of [
    { trainer_staff_id: FIXTURE_IDS.staffRachelId },
    { dropoff_at: rs.BT_STARTS[0] },
    { duration_minutes: 60 },
  ]) {
    await refusedInvalid(await rs.approve(id, { ...base, ...extra }), id);
  }
  const ok = await rs.approve(id, base);
  assert.equal(ok.statusCode, 200, ok.body);
});
