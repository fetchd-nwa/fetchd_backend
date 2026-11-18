import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../src/auth/principal.js';
import type {
  BookingWire,
  PendingRequestWire,
  PostRequestsConfirmResponse,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import {
  agreementDocuments,
  bookings,
  dogVaccines,
  idempotencyKeys,
  owners,
  pendingRequests,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { buildApp } from '../../src/server.js';
import { FIXTURE_IDS, setRequestServicesOffered } from './_fixture.js';
import {
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  registerFixtureHooks,
} from './_harness.js';
import { waitForBlockedBackends } from './_poolFixture.js';
import {
  BT_PICKUP,
  BT_STARTS,
  B_AND_T_PRICE_CENTS,
  approveBoardTrain,
  approveLesson,
  clearRequestServiceRows,
  confirm,
  deny,
  errorCode,
  errorMessage,
  holdRequestLock,
  moneyRows,
  ownerApp,
  plantRequest,
  requestRow,
  testBookings,
  trapDefaultStripe,
  withStaff,
  withdraw,
  withoutCard,
} from './_requestServices.js';

/**
 * Plan unit P49, contract item A2 (wire 9.0.0; design request-services-v1 §2.2, §3.2):
 * `POST /requests/:id/confirm`, the family's **Yes, book it** to a Board & Train staff
 * approved. Her yes books it, and it moves $0: no Stripe call, no order, no invoice, no
 * charge (Shanthi #6.4: "Board and train is not paid for until the service is over"). It
 * replaces `POST /requests/:id/confirm-payment` (A1, BUG-6), which now answers 404.
 *
 * Refusals, in the contract's order: 404, then 409 on state, then 409 once the approved
 * drop-off has passed, then 409 when the approved trainer is no longer live or eligible
 * (DECISIONS 466), then the 422 gates.
 */

registerFixtureHooks();
afterEach(clearRequestServiceRows);

/** A Board & Train for Waffles that Shanthi approved with Rachel, waiting on the yes. */
async function approvedBoardTrain(): Promise<string> {
  const id = await plantRequest({ category: 'board-and-train' });
  const res = await approveBoardTrain(id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as PendingRequestWire).status, 'approved-awaiting-payment');
  return id;
}

function yes(res: { statusCode: number; body: string }): PostRequestsConfirmResponse {
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as PostRequestsConfirmResponse;
}

function refused(res: { statusCode: number; body: string }, status: number, code: string): void {
  assert.equal(res.statusCode, status, res.body);
  assert.equal(errorCode(res), code, res.body);
}

test(
  'a yes moves $0 and makes 0 Stripe calls, and books the stay at the approved dates, trainer and quote',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await approvedBoardTrain();
    const before = await moneyRows();
    const trap = trapDefaultStripe();
    let body: PostRequestsConfirmResponse;
    try {
      body = yes(await confirm(id));
    } finally {
      trap.restore();
    }
    assert.deepEqual(trap.calls, [], 'the yes reached Stripe');
    assert.deepEqual(await moneyRows(), before, 'the yes wrote a charge, an invoice or a ledger row');

    const booking: BookingWire = body.booking;
    assert.equal(booking.category, 'board-and-train');
    assert.equal(booking.status, 'upcoming');
    assert.equal(booking.date, BT_STARTS[0]);
    assert.equal(booking.dropoff_at, BT_STARTS[0]);
    assert.equal(booking.pickup_at, BT_PICKUP);
    assert.equal(booking.trainer, 'Rachel');
    assert.equal(booking.quoted_price_cents, B_AND_T_PRICE_CENTS);
    assert.equal(booking.location, 'fayetteville', "her home campus (owners.location)");
    assert.equal(booking.can_cancel, true, 'cancellable until the drop-off');

    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    assert.equal(row?.trainerStaffId, FIXTURE_IDS.staffRachelId);
    assert.equal(row?.quotedPriceCents, B_AND_T_PRICE_CENTS);
    assert.equal(row?.orderId, null, 'no order');
  },
);

test(
  'the converted request keeps the approver and the four approved fields; the stay has its reminder',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await approvedBoardTrain();
    const body = yes(await confirm(id));
    const request = body.request;
    assert.equal(request.status, 'converted');
    assert.equal(request.converted_booking_id, body.booking.id);
    assert.equal(request.approved_by_staff_id, FIXTURE_IDS.staffShanthiId, 'the approver, never ""');
    assert.deepEqual(request.approved_trainer, {
      staff_id: FIXTURE_IDS.staffRachelId,
      name: 'Rachel',
    });
    assert.equal(request.approved_dropoff_at, BT_STARTS[0]);
    assert.equal(request.approved_pickup_at, BT_PICKUP);
    assert.equal(request.approved_price_cents, B_AND_T_PRICE_CENTS);

    const reminders = await db
      .select({ type: scheduledNotifications.type })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.bookingId, body.booking.id));
    assert.ok(
      reminders.some((r) => r.type === 'booking-reminder'),
      `the stay's reminder is queued: ${JSON.stringify(reminders)}`,
    );
  },
);

test('no card on file → 422 payment_required, and the request stays waiting', SKIP_WHEN_NO_DB, async () => {
  const id = await approvedBoardTrain();
  await withoutCard(async () => {
    const res = await confirm(id);
    refused(res, 422, 'payment_required');
    // The pre-check's details (Fable b1 L4(d)).
    assert.deepEqual((JSON.parse(res.body) as { error: { details?: unknown } }).error.details, {
      kind: 'payment_required',
    });
  });
  assert.equal((await requestRow(id))?.status, 'approved-awaiting-payment');
  assert.equal((await testBookings()).length, 0);
});

// Fable b1 L4(d): the yes's other two gates. Each asserts the pre-check's structured
// `missing[]`, which the trigger floor under it cannot produce (it answers `missing: []`).
test(
  "a required vaccine lapsed → 422 vaccine_missing naming Waffles' rabies, and the request stays waiting with 0 bookings",
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await approvedBoardTrain();
    await db
      .update(dogVaccines)
      .set({ expiredAt: sql`now()` })
      .where(eq(dogVaccines.id, FIXTURE_IDS.vaccine1Id));
    try {
      const res = await confirm(id);
      refused(res, 422, 'vaccine_missing');
      const details = (
        JSON.parse(res.body) as {
          error: { details: { kind: string; missing: { dog_id: string; requirement_key: string }[] } };
        }
      ).error.details;
      assert.equal(details.kind, 'vaccine_missing');
      assert.ok(
        details.missing.some(
          (m) => m.dog_id === FIXTURE_IDS.dog1Id && m.requirement_key === FIXTURE_IDS.requiredVaccineRabiesKey,
        ),
        res.body,
      );
    } finally {
      await db
        .update(dogVaccines)
        .set({ expiredAt: null })
        .where(eq(dogVaccines.id, FIXTURE_IDS.vaccine1Id));
    }
    assert.equal((await requestRow(id))?.status, 'approved-awaiting-payment');
    assert.equal((await testBookings()).length, 0);
  },
);

test(
  'a required agreement unsigned → 422 agreement_unsigned naming it, and the request stays waiting with 0 bookings',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await approvedBoardTrain();
    const docKey = `p49-bt-extra-${randomUUID().slice(0, 8)}`;
    await db.insert(agreementDocuments).values({
      key: docKey,
      label: 'Board & Train Extra Waiver (test)',
      currentVersion: 1,
      required: true,
      appliesTo: ['board-and-train'],
    });
    try {
      const res = await confirm(id);
      refused(res, 422, 'agreement_unsigned');
      const details = (
        JSON.parse(res.body) as { error: { details: { kind: string; missing: { document_key: string }[] } } }
      ).error.details;
      assert.equal(details.kind, 'agreement_unsigned');
      assert.ok(
        details.missing.some((m) => m.document_key === docKey),
        res.body,
      );
    } finally {
      await db.delete(agreementDocuments).where(eq(agreementDocuments.key, docKey));
    }
    assert.equal((await requestRow(id))?.status, 'approved-awaiting-payment');
    assert.equal((await testBookings()).length, 0);
  },
);

test(
  'a yes at the approved drop-off or after it → 409, and the request stays waiting',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await approvedBoardTrain();
    const atDropoff = ownerApp(() => new Date(BT_STARTS[0]));
    refused(await confirm(id, { app: atDropoff }), 409, 'conflict');
    const after = ownerApp(() => new Date('2026-06-09T00:00:00.000Z'));
    refused(await confirm(id, { app: after }), 409, 'conflict');
    assert.equal((await requestRow(id))?.status, 'approved-awaiting-payment');
    assert.equal((await testBookings()).length, 0);
  },
);

test(
  'the refusal order: a passed drop-off answers 409 before the card gate would 422',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await approvedBoardTrain();
    await withoutCard(async () => {
      refused(
        await confirm(id, { app: ownerApp(() => new Date('2026-06-09T00:00:00.000Z')) }),
        409,
        'conflict',
      );
    });
  },
);

test('a yes on a request still submitted → 409', SKIP_WHEN_NO_DB, async () => {
  const id = await plantRequest({ category: 'board-and-train' });
  refused(await confirm(id), 409, 'conflict');
  assert.equal((await testBookings()).length, 0);
});

test('a yes on another family\'s request → 404, and nothing is written', SKIP_WHEN_NO_DB, async () => {
  const id = await approvedBoardTrain();
  const otherOwnerId = randomUUID();
  await db.insert(owners).values({
    id: otherOwnerId,
    supabaseUid: randomUUID(),
    name: 'Someone Else',
    email: `someone-else-${otherOwnerId}@example.test`,
    phone: '555-0100',
    location: 'bentonville',
  });
  try {
    const other: Principal = { kind: 'owner', ownerId: otherOwnerId, supabaseUid: randomUUID() };
    refused(await confirm(id, { app: ownerApp(undefined, other) }), 404, 'not_found');
  } finally {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.ownerId, otherOwnerId));
    await db.delete(owners).where(eq(owners.id, otherOwnerId));
  }
  assert.equal((await requestRow(id))?.status, 'approved-awaiting-payment');
  assert.equal((await testBookings()).length, 0);
});

test("another family's Withdraw and edit → 404, and the request is unchanged", SKIP_WHEN_NO_DB, async () => {
  const id = await plantRequest({ category: 'board-and-train' });
  const otherOwnerId = randomUUID();
  await db.insert(owners).values({
    id: otherOwnerId,
    supabaseUid: randomUUID(),
    name: 'Someone Else',
    email: `someone-else-${otherOwnerId}@example.test`,
    phone: '555-0100',
    location: 'bentonville',
  });
  try {
    const other: Principal = { kind: 'owner', ownerId: otherOwnerId, supabaseUid: randomUUID() };
    const theirs = ownerApp(undefined, other);
    const gone = await withdraw(id, theirs);
    assert.equal(gone.statusCode, 404, gone.body);
    assert.equal(errorCode(gone), 'not_found');
    const edit = await theirs.inject({
      method: 'PATCH',
      url: `/requests/${id}`,
      headers: { 'idempotency-key': `p49-${randomUUID()}` },
      payload: { preferred_dates: [BT_STARTS[1]] },
    });
    assert.equal(edit.statusCode, 404, edit.body);
    assert.equal(errorCode(edit), 'not_found');
  } finally {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.ownerId, otherOwnerId));
    await db.delete(owners).where(eq(owners.id, otherOwnerId));
  }
  assert.equal((await requestRow(id))?.status, 'submitted');
});

// Fable b1 L4(a): the builder's gap 4, pinned.
test('the yes keeps approved_at as staff stamped it', SKIP_WHEN_NO_DB, async () => {
  const id = await plantRequest({ category: 'board-and-train' });
  const waiting = (await approveBoardTrain(id)).json() as PendingRequestWire;
  await new Promise((r) => setTimeout(r, 25));
  const body = yes(await confirm(id));
  assert.equal(body.request.approved_at, waiting.approved_at);
});

// Fable b1 N2: an old-flow row (approved before 9.0.0, no approved fields) is answered in words
// that name the road that works: the approve answers 409 on it, Take back does not.
test(
  'an old-flow waiting row with no approved fields → 409: the school takes it back, and she sends it again',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await plantRequest({ category: 'board-and-train' });
    await db
      .update(pendingRequests)
      .set({ status: 'approved-awaiting-payment' })
      .where(eq(pendingRequests.id, id));
    const res = await confirm(id);
    refused(res, 409, 'conflict');
    assert.equal(
      errorMessage(res),
      `pending request ${id} was approved without dates, a trainer and a price; the school takes it back, and you send it again`,
    );
    assert.equal((await testBookings()).length, 0);
  },
);

test('an unknown request id → 404', SKIP_WHEN_NO_DB, async () => {
  refused(await confirm(randomUUID()), 404, 'not_found');
});

test('a staff principal → 403', SKIP_WHEN_NO_DB, async () => {
  const id = await approvedBoardTrain();
  refused(await confirm(id, { app: ownerApp(undefined, FIXTURE_STAFF_PRINCIPAL) }), 403, 'forbidden');
});

test('a body carrying any key → 400 bad_request (the body is .strict() and empty)', SKIP_WHEN_NO_DB, async () => {
  const id = await approvedBoardTrain();
  refused(await confirm(id, { payload: { pickup_at: BT_PICKUP } }), 400, 'bad_request');
  assert.equal((await requestRow(id))?.status, 'approved-awaiting-payment');
});

test('the same key replayed → the same body; a second yes under a new key → 409', SKIP_WHEN_NO_DB, async () => {
  const id = await approvedBoardTrain();
  const key = `p49-yes-${randomUUID()}`;
  const first = await confirm(id, { key });
  const replay = await confirm(id, { key });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), first.json());
  refused(await confirm(id), 409, 'conflict');
  assert.equal((await testBookings()).length, 1, 'one stay');
});

for (const [label, set] of [
  ['expired', { expiredAt: '2026-05-18T12:00:00.000Z' }],
  ['no longer Board & Train eligible', { boardTrainEligible: false }],
] as const) {
  test(
    `the approved trainer ${label} before the yes → 409, 0 bookings, and the request stays waiting (DECISIONS 466)`,
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await approvedBoardTrain();
      await withStaff(FIXTURE_IDS.staffRachelId, set, async () => {
        refused(await confirm(id), 409, 'conflict');
        // The trainer 409 comes before the card gate.
        await withoutCard(async () => {
          refused(await confirm(id), 409, 'conflict');
        });
        // The screen the 409 is read from still names her (Opus b1 F6, X19).
        const list = await ownerApp().inject({ method: 'GET', url: '/requests' });
        assert.equal(list.statusCode, 200, list.body);
        const mine = (list.json() as PendingRequestWire[]).find((r) => r.id === id);
        assert.deepEqual(mine?.approved_trainer, {
          staff_id: FIXTURE_IDS.staffRachelId,
          name: 'Rachel',
        });
      });
      assert.equal((await requestRow(id))?.status, 'approved-awaiting-payment');
      assert.equal((await testBookings()).length, 0);
    },
  );
}

test(
  'Board & Train switched off after the approval: her yes still books (DECISIONS 463(3))',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = await approvedBoardTrain();
    await setRequestServicesOffered(false, { services: ['board-and-train'] });
    const body = yes(await confirm(id));
    assert.equal(body.booking.category, 'board-and-train');
    assert.equal(body.request.status, 'converted');
  },
);

describe('a yes racing her Withdraw, on two real connections', () => {
  for (const order of ['yes first', 'withdraw first'] as const) {
    test(
      `${order}: exactly one wins; either the stay is booked and converted, or the request is cancelled with 0 bookings`,
      SKIP_WHEN_NO_DB,
      async () => {
        const id = await approvedBoardTrain();
        const held = await holdRequestLock(id);
        const fired: Promise<{ statusCode: number; body: string }>[] = [];
        try {
          const first = order === 'yes first' ? () => confirm(id) : () => withdraw(id);
          const second = order === 'yes first' ? () => withdraw(id) : () => confirm(id);
          fired.push(first());
          await waitForBlockedBackends(1);
          fired.push(second());
          await waitForBlockedBackends(2);
          await held.release();
          const answers = await Promise.all(fired);
          const codes = answers.map((a) => a.statusCode).sort();
          assert.deepEqual(codes, [200, 409], answers.map((a) => a.body).join('\n'));
        } finally {
          await held.release();
          await Promise.allSettled(fired);
        }
        const row = await requestRow(id);
        const stays = await testBookings();
        if (order === 'yes first') {
          assert.equal(row?.status, 'converted');
          assert.equal(stays.length, 1);
        } else {
          assert.equal(row?.status, 'cancelled');
          assert.equal(stays.length, 0);
        }
      },
    );
  }
});

// Opus b1 F5: a Take back racing the yes, both orders (A13's "one winner").
describe('a yes racing a Take back, on two real connections', () => {
  for (const order of ['yes first', 'take back first'] as const) {
    test(
      `${order}: exactly one wins; either the stay is booked and converted, or the request is cancelled with 0 bookings`,
      SKIP_WHEN_NO_DB,
      async () => {
        const id = await approvedBoardTrain();
        const held = await holdRequestLock(id);
        const fired: Promise<{ statusCode: number; body: string }>[] = [];
        try {
          const first = order === 'yes first' ? () => confirm(id) : () => deny(id);
          const second = order === 'yes first' ? () => deny(id) : () => confirm(id);
          fired.push(first());
          await waitForBlockedBackends(1);
          fired.push(second());
          await waitForBlockedBackends(2);
          await held.release();
          const answers = await Promise.all(fired);
          const codes = answers.map((a) => a.statusCode).sort();
          assert.deepEqual(codes, [200, 409], answers.map((a) => a.body).join('\n'));
        } finally {
          await held.release();
          await Promise.allSettled(fired);
        }
        const row = await requestRow(id);
        const stays = await testBookings();
        if (order === 'yes first') {
          assert.equal(row?.status, 'converted');
          assert.equal(stays.length, 1);
        } else {
          assert.equal(row?.status, 'cancelled');
          assert.equal(stays.length, 0);
        }
      },
    );
  }
});

describe('the removed route, on the real server', () => {
  let app: FastifyInstance;
  before(async () => {
    app = buildApp();
    await app.ready();
  });
  after(async () => {
    await app.close();
  });

  test('POST /requests/:id/confirm-payment → 404 (A1); POST /requests/:id/confirm is registered (401 unauthenticated)', async () => {
    const gone = await app.inject({
      method: 'POST',
      url: `/requests/${FIXTURE_IDS.pendingRequest2Id}/confirm-payment`,
      payload: {},
    });
    assert.equal(gone.statusCode, 404, gone.body);
    const held = await app.inject({
      method: 'POST',
      url: `/requests/${FIXTURE_IDS.pendingRequest2Id}/confirm`,
      payload: {},
    });
    assert.equal(held.statusCode, 401, held.body);
  });
});

// Fable b1 L1 = Opus b1 F2 (A8, wire.ts BookingWire.trainer): a lesson's or a Board & Train's
// trainer is a fact of the booking, and stays on the family's card after she leaves.
test("an expired trainer stays on the family's lesson and Board & Train card (A8)", SKIP_WHEN_NO_DB, async () => {
  const lessonRequest = await plantRequest({ category: 'private-lesson' });
  assert.equal((await approveLesson(lessonRequest)).statusCode, 200);
  const lesson = (await testBookings()).find((b) => b.category === 'private-lesson');
  assert.ok(lesson !== undefined);
  const stay = yes(await confirm(await approvedBoardTrain())).booking;
  await withStaff(FIXTURE_IDS.staffRachelId, { expiredAt: '2026-05-18T12:00:00.000Z' }, async () => {
    for (const bookingId of [lesson.id, stay.id]) {
      const res = await ownerApp().inject({ method: 'GET', url: `/bookings/${bookingId}` });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((res.json() as BookingWire).trainer, 'Rachel', res.body);
    }
  });
});

test('a Board & Train booking the yes made is the one the request points at', SKIP_WHEN_NO_DB, async () => {
  const id = await approvedBoardTrain();
  const body = yes(await confirm(id));
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.ownerId, FIXTURE_IDS.ownerId), eq(bookings.category, 'board-and-train')));
  assert.ok(rows.some((r) => r.id === body.booking.id));
  assert.equal((await requestRow(id))?.convertedBookingId, body.booking.id);
});
