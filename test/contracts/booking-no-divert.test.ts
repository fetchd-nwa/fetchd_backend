import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  bookings,
  creditLedger,
  dogCompletedPrograms,
  dogVaccines,
  dogs,
  invoices,
  paymentMethods,
  pendingRequestDogs,
  pendingRequests,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import {
  clearInvoiceChargeAttempts,
  futureWeekday,
  FIXTURE_IDS,
  FIXTURE_NOW,
  topUpCredits,
} from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
  registerRequestServicesOn,
} from './_harness.js';

/**
 * P12 B1 (wire 3.0.0; DOG-U08, R1): `POST /bookings` has one outcome. A
 * day-program booking books at once or is refused; nothing is parked for a
 * staff look, and every booking spends a credit.
 *
 * Why this stays in M1: a freshly seeded family's dogs have no attended day,
 * so the deleted divert would have parked each one's first booking and s02 and
 * s03 would fail.
 *
 * The dogs here have no attended day unless a test says so, which is the shape
 * that used to divert. `FIXTURE_NOW` is 2026-05-19, so an attended day on
 * 2026-01-19 is four months back, past the deleted three-month rule.
 */

// Registered BEFORE registerFixtureHooks so it runs ahead of teardownFixture:
// the fixture wipe deletes dogs by owner, and these dogs' ledger, booking and
// request rows hold no-action FKs against them.
const createdDogIds: string[] = [];
after(async () => {
  if (createdDogIds.length === 0) return;
  const dogIds = [...createdDogIds];
  const bookingIds = (
    await db.select({ id: bookings.id }).from(bookings).where(inArray(bookings.leadDogId, dogIds))
  ).map((r) => r.id);
  if (bookingIds.length > 0) {
    await db
      .delete(scheduledNotifications)
      .where(inArray(scheduledNotifications.bookingId, bookingIds));
    await clearInvoiceChargeAttempts();
    await db.delete(invoices).where(inArray(invoices.bookingId, bookingIds));
    await db.delete(creditLedger).where(inArray(creditLedger.bookingId, bookingIds));
  }
  await db.delete(scheduledNotifications).where(inArray(scheduledNotifications.dogId, dogIds));
  await db.delete(creditLedger).where(inArray(creditLedger.dogId, dogIds));
  await db.delete(pendingRequests).where(inArray(pendingRequests.leadDogId, dogIds)); // children CASCADE
  if (bookingIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.id, bookingIds)); // booking_dogs CASCADE
  }
  await db.delete(dogCompletedPrograms).where(inArray(dogCompletedPrograms.dogId, dogIds));
  await db.delete(dogVaccines).where(inArray(dogVaccines.dogId, dogIds));
  await db.delete(dogs).where(inArray(dogs.id, dogIds));
});

registerFixtureHooks();
registerRequestServicesOn();

function ownerApp(): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });
  registerRequestsRoute(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

/** Vaccines are checked by a trigger on the real clock, so the expiry is too. */
function farFutureExpiry(): string {
  return new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** A fixture-owned dog that passes every gate and has never attended a day. */
async function createTestDog(
  opts: {
    spayedNeutered?: boolean;
    evaluationStatus?: 'passed' | 'not-evaluated';
    vaccinated?: boolean;
    attendedAt?: string;
    alumni?: boolean;
  } = {},
): Promise<string> {
  const dogId = randomUUID();
  createdDogIds.push(dogId);
  await db.insert(dogs).values({
    id: dogId,
    ownerId: FIXTURE_IDS.ownerId,
    name: `No divert ${dogId.slice(0, 8)}`,
    breed: 'Test Breed',
    birthdate: '2023-01-01',
    evaluationStatus: opts.evaluationStatus ?? 'passed',
    spayedNeutered: opts.spayedNeutered ?? null,
  });
  if (opts.vaccinated !== false) {
    await db.insert(dogVaccines).values(
      [FIXTURE_IDS.requiredVaccineRabiesKey, FIXTURE_IDS.requiredVaccineBordetellaKey].map(
        (requirementKey) => ({
          dogId,
          name: requirementKey,
          requirementKey,
          expiresAt: farFutureExpiry(),
        }),
      ),
    );
  }
  if (opts.alumni === true) {
    await db.insert(dogCompletedPrograms).values(
      CURRICULUM_PROGRAMS.map((program) => ({
        dogId,
        program,
        completedByStaffId: FIXTURE_IDS.staffDonavanId,
      })),
    );
  }
  if (opts.attendedAt !== undefined) {
    const bookingId = randomUUID();
    await db.insert(bookings).values({
      id: bookingId,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: dogId,
      category: 'day-school',
      status: 'past',
      scheduledAt: opts.attendedAt,
      durationMinutes: 540,
      location: 'fayetteville',
    });
    await db.insert(bookingDogs).values({
      bookingId,
      dogId,
      isLead: true,
      attendance: 'attended',
      checkedInAt: opts.attendedAt,
    });
  }
  return dogId;
}

type App = ReturnType<typeof ownerApp>;

async function postBooking(
  app: App,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `no-divert-${randomUUID()}` },
    payload,
  });
  return { statusCode: res.statusCode, body: res.body, json: () => res.json() };
}

async function postRequest(
  app: App,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/requests',
    headers: { 'idempotency-key': `no-divert-req-${randomUUID()}` },
    payload,
  });
  return { statusCode: res.statusCode, body: res.body, json: () => res.json() };
}

async function debitsOf(dogId: string): Promise<number> {
  const rows = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.dogId, dogId), eq(creditLedger.reason, 'booking-debit')));
  return rows.length;
}

async function requestRowsOf(dogId: string): Promise<number> {
  const rows = await db
    .select({ id: pendingRequests.id })
    .from(pendingRequests)
    .where(eq(pendingRequests.leadDogId, dogId));
  return rows.length;
}

async function upcomingBookingsOf(dogId: string): Promise<{ id: string; scheduledAt: string }[]> {
  return db
    .select({ id: bookings.id, scheduledAt: bookings.scheduledAt })
    .from(bookings)
    .where(and(eq(bookings.leadDogId, dogId), eq(bookings.status, 'upcoming')));
}

/** The one outcome: 201, `BookingWire[]`, a debit per dog per date, no request. */
async function assertBookedAtOnce(
  res: Awaited<ReturnType<typeof postBooking>>,
  dogId: string,
  count = 1,
): Promise<void> {
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.ok(Array.isArray(body), `POST /bookings answers BookingWire[], got ${res.body}`);
  assert.equal(body.length, count);
  assert.equal(await debitsOf(dogId), count, 'a credit debited per booking');
  assert.equal(await requestRowsOf(dogId), 0, 'no pending_requests row');
}

// ── B1: the dogs that used to divert book at once ───────────────────────────

test(
  'a client dog with no attended day ever books at once: 201, credits debited, no pending_requests row',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);

    const res = await postBooking(ownerApp(), {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(20)],
      location: 'fayetteville',
    });
    await assertBookedAtOnce(res, dogId);
  },
);

test('a dog last attended four months ago books at once', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createTestDog({ attendedAt: '2026-01-19T14:00:00Z' });
  await topUpCredits(dogId, 'school', 5);

  const res = await postBooking(ownerApp(), {
    category: 'day-school',
    lead_dog_id: dogId,
    dates: [futureWeekday(21)],
    location: 'fayetteville',
  });
  await assertBookedAtOnce(res, dogId);
});

test('a dog with spayed_neutered = false books at once', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createTestDog({
    spayedNeutered: false,
    attendedAt: '2026-05-12T13:00:00Z',
  });
  await topUpCredits(dogId, 'school', 5);

  const res = await postBooking(ownerApp(), {
    category: 'day-school',
    lead_dog_id: dogId,
    dates: [futureWeekday(22)],
    location: 'fayetteville',
  });
  await assertBookedAtOnce(res, dogId);
});

test(
  'a dog with no attended day and spayed_neutered = false books at once',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog({ spayedNeutered: false });
    await topUpCredits(dogId, 'school', 5);

    const res = await postBooking(ownerApp(), {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(35)],
      location: 'fayetteville',
    });
    await assertBookedAtOnce(res, dogId);
  },
);

test('an alumni dog with no attended day books at once', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createTestDog({ alumni: true });
  await topUpCredits(dogId, 'school', 5);

  const res = await postBooking(ownerApp(), {
    category: 'day-school',
    lead_dog_id: dogId,
    dates: [futureWeekday(36)],
    location: 'fayetteville',
  });
  await assertBookedAtOnce(res, dogId);
});

test(
  'a second booking on another day books too: nothing about the first holds it back',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = ownerApp();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);

    for (const nth of [37, 38]) {
      const res = await postBooking(app, {
        category: 'day-school',
        lead_dog_id: dogId,
        dates: [futureWeekday(nth)],
        location: 'fayetteville',
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    assert.equal(await debitsOf(dogId), 2, 'a credit debited per booking');
    assert.equal(await requestRowsOf(dogId), 0, 'no pending_requests row');
  },
);

test(
  'day care: a dog with no attended day books at once, the same as day school',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'daycare', 5, 'bentonville');

    const res = await postBooking(ownerApp(), {
      category: 'day-care',
      lead_dog_id: dogId,
      dates: [futureWeekday(23)],
      location: 'bentonville',
    });
    await assertBookedAtOnce(res, dogId);
  },
);

test(
  'two dates: two bookings at the submitted days, two debits, a reminder per booking (moved from the approve conversion, which ran this same core)',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 10);
    const dates = [futureWeekday(24), futureWeekday(25)];

    const res = await postBooking(ownerApp(), {
      category: 'day-school',
      lead_dog_id: dogId,
      dates,
      location: 'fayetteville',
    });
    await assertBookedAtOnce(res, dogId, 2);

    const created = await upcomingBookingsOf(dogId);
    assert.deepEqual(created.map((b) => b.scheduledAt.slice(0, 10)).sort(), dates);
    const reminders = await db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(
        inArray(
          scheduledNotifications.bookingId,
          created.map((b) => b.id),
        ),
      );
    assert.equal(reminders.length, 2, 'a reminder per booking');
  },
);

test(
  'a roster of an attended dog and a dog with no attended day books whole: the booking carries every dog, each is debited, nothing is parked',
  SKIP_WHEN_NO_DB,
  async () => {
    const lead = await createTestDog({ attendedAt: '2026-05-12T13:00:00Z' });
    const never = await createTestDog({ spayedNeutered: true });
    await topUpCredits(lead, 'school', 5);
    await topUpCredits(never, 'school', 5);

    const res = await postBooking(ownerApp(), {
      category: 'day-school',
      lead_dog_id: lead,
      additional_dog_ids: [never],
      dates: [futureWeekday(26)],
      location: 'fayetteville',
    });
    await assertBookedAtOnce(res, lead);
    assert.equal(await debitsOf(never), 1, 'the additional dog is debited too');

    const [created] = await upcomingBookingsOf(lead);
    const roster = await db
      .select({ dogId: bookingDogs.dogId })
      .from(bookingDogs)
      .where(eq(bookingDogs.bookingId, created!.id));
    assert.deepEqual(roster.map((r) => r.dogId).sort(), [lead, never].sort());
  },
);

test(
  'PAYG: a dog with no attended day books at once on an open payg invoice with no debit (moved from the approve conversion)',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();

    const res = await postBooking(ownerApp(), {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(27)],
      location: 'fayetteville',
      payment: 'payg',
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await requestRowsOf(dogId), 0, 'no pending_requests row');
    assert.equal(await debitsOf(dogId), 0, 'PAYG debits no credit');

    const [created] = await upcomingBookingsOf(dogId);
    const rows = await db
      .select({ purpose: invoices.purpose, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.bookingId, created!.id));
    assert.deepEqual(rows, [{ purpose: 'payg', status: 'open' }]);
  },
);

test(
  'no credits: a dog with no attended day is refused 422 insufficient_credits, never parked as a request',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();

    const res = await postBooking(ownerApp(), {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(28)],
      location: 'fayetteville',
    });
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'insufficient_credits');
    assert.equal(await requestRowsOf(dogId), 0, 'no pending_requests row');
    assert.deepEqual(await upcomingBookingsOf(dogId), []);
  },
);

// ── B1: the preview is gone ─────────────────────────────────────────────────

test('POST /bookings/preview is 404', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createTestDog();
  const res = await ownerApp().inject({
    method: 'POST',
    url: '/bookings/preview',
    payload: { dog_ids: [dogId] },
  });
  assert.equal(res.statusCode, 404, res.body);
});

// ── B1: an open request is not a booking refusal ────────────────────────────

/**
 * `POST /requests` answers `already_requested` only for the residential kinds
 * (`routes/requests.ts`, its step 2b; `requests-mutations.test.ts` pins private
 * lessons stacking). So an open private lesson proves the booking, and a
 * board-and-train proves `already_requested`.
 */
test(
  'a dog with an open private-lesson request can still book day school',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = ownerApp();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);

    const lesson = await postRequest(app, {
      category: 'private-lesson',
      lead_dog_id: dogId,
      preferred_dates: ['2026-07-15T15:00:00Z'],
    });
    assert.equal(lesson.statusCode, 201, lesson.body);

    const res = await postBooking(app, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(29)],
      location: 'fayetteville',
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await debitsOf(dogId), 1, 'a credit debited');
    assert.equal(await requestRowsOf(dogId), 1, 'the lesson request stands, and only it');
  },
);

test(
  'POST /requests still answers already_requested for a second open board-and-train, and that dog can still book day school',
  SKIP_WHEN_NO_DB,
  async () => {
    const app = ownerApp();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);
    const stay = {
      category: 'board-and-train',
      lead_dog_id: dogId,
      preferred_dates: ['2026-07-15T15:00:00Z'],
      length_weeks: 2,
    };

    const first = await postRequest(app, stay);
    assert.equal(first.statusCode, 201, first.body);

    const second = await postRequest(app, stay);
    assert.equal(second.statusCode, 422, second.body);
    assert.equal((second.json() as { error: { code: string } }).error.code, 'already_requested');

    const booked = await postBooking(app, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(30)],
      location: 'fayetteville',
    });
    assert.equal(booked.statusCode, 201, booked.body);
  },
);

test(
  'a surviving open day-school request does not refuse a booking: already_requested is off POST /bookings',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);
    const [row] = await db
      .insert(pendingRequests)
      .values({ ownerId: FIXTURE_IDS.ownerId, leadDogId: dogId, category: 'day-school' })
      .returning({ id: pendingRequests.id });
    await db
      .insert(pendingRequestDogs)
      .values({ requestId: row!.id, dogId, isLead: true })
      .returning();

    const res = await postBooking(ownerApp(), {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(31)],
      location: 'fayetteville',
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await debitsOf(dogId), 1, 'a credit debited');
  },
);

// ── B1: the gates still refuse ──────────────────────────────────────────────
// The refusals ran on both the deleted lane and the booking path, so these
// pass before and after: they pin that deleting the lane took no gate with it.

test(
  'an unpaid owner gets 422 payment_required on a dog with no attended day',
  SKIP_WHEN_NO_DB,
  async () => {
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);
    await db
      .update(paymentMethods)
      .set({ expiredAt: sql`now()` })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    try {
      const res = await postBooking(ownerApp(), {
        category: 'day-school',
        lead_dog_id: dogId,
        dates: [futureWeekday(32)],
        location: 'fayetteville',
      });
      assert.equal(res.statusCode, 422, res.body);
      const body = res.json() as { error: { code: string; details: { kind: string } } };
      assert.equal(body.error.code, 'payment_required');
      assert.equal(body.error.details.kind, 'payment_required');
      assert.equal(await debitsOf(dogId), 0);
      assert.equal(await requestRowsOf(dogId), 0);
    } finally {
      await db
        .update(paymentMethods)
        .set({ expiredAt: null })
        .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    }
  },
);

test('an unevaluated dog gets 422 evaluation_required', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createTestDog({ evaluationStatus: 'not-evaluated' });
  await topUpCredits(dogId, 'school', 5);

  const res = await postBooking(ownerApp(), {
    category: 'day-school',
    lead_dog_id: dogId,
    dates: [futureWeekday(33)],
    location: 'fayetteville',
  });
  assert.equal(res.statusCode, 422, res.body);
  const body = res.json() as { error: { code: string; details: { kind: string } } };
  assert.equal(body.error.code, 'evaluation_required');
  assert.equal(body.error.details.kind, 'evaluation_required');
  assert.equal(await debitsOf(dogId), 0);
  assert.equal(await requestRowsOf(dogId), 0);
});

test('an unvaccinated dog gets 422 vaccine_missing', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createTestDog({ vaccinated: false });
  await topUpCredits(dogId, 'school', 5);

  const res = await postBooking(ownerApp(), {
    category: 'day-school',
    lead_dog_id: dogId,
    dates: [futureWeekday(34)],
    location: 'fayetteville',
  });
  assert.equal(res.statusCode, 422, res.body);
  const body = res.json() as { error: { code: string; details: { kind: string } } };
  assert.equal(body.error.code, 'vaccine_missing');
  assert.equal(body.error.details.kind, 'vaccine_missing');
  assert.equal(await debitsOf(dogId), 0);
  assert.equal(await requestRowsOf(dogId), 0);
});
