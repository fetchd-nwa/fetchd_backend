import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  bookings,
  creditLedger,
  dayCapacity,
  dogCompletedPrograms,
  dogVaccines,
  dogs,
  invoices,
  pendingRequestDogs,
  pendingRequests,
  requiredVaccines,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerStaffRequestsRoute } from '../../src/routes/staffRequests.js';
import { futureWeekday, FIXTURE_IDS, FIXTURE_NOW, topUpCredits } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Contract tests for the Shanthi-2026-07-14 rulings (DATA-CONTRACT
 * "Amendment 2026-07-14"):
 *
 *   1. **3-month re-evaluation staleness divert** — a dog NWA hasn't seen
 *      (last ATTENDED day-school/day-care session) in over 3 months books
 *      via the pending-request approval lane, not instantly. Alumni exempt.
 *      Attendance — not approval — is what freshens the dog.
 *   2. **Intact-dog divert** — `spayed_neutered = false` (any age) also
 *      parks the submission for staff eyes. NULL (unanswered) does not.
 *   3. **Approve conversion** — POST /staff/requests/:id/approve on a
 *      diverted day-program request runs the SAME creation core as
 *      POST /bookings: credits debit / PAYG invoice, capacity, reminders.
 *   4. **Puppy-class vaccine exemption** — a required_vaccines row listing
 *      a class key in `exempt_class_keys` is skipped for that cohort's
 *      group-class bookings (trigger floor + repo pre-check parity).
 *   5. **Spay/neuter profile surface** — POST/PATCH /dogs fields, the
 *      planned-date reminder lifecycle, and the pair-coherence 4xx.
 */

// Every dog this suite creates (plus everything hanging off it) is cleaned by
// the hook below. Registered BEFORE registerFixtureHooks so it runs ahead of
// teardownFixture — the fixture wipe deletes dogs by owner and would trip the
// no-action FKs (credit_ledger, bookings.lead_dog_id, pending_requests) our
// random dogs accumulate.
const createdDogIds: string[] = [];
after(async () => {
  if (createdDogIds.length === 0) return;
  const dogIds = [...createdDogIds];
  const bookingIdRows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(inArray(bookings.leadDogId, dogIds));
  const bookingIds = bookingIdRows.map((r) => r.id);
  if (bookingIds.length > 0) {
    await db
      .delete(scheduledNotifications)
      .where(inArray(scheduledNotifications.bookingId, bookingIds));
    await db.delete(invoices).where(inArray(invoices.bookingId, bookingIds));
    await db.delete(creditLedger).where(inArray(creditLedger.bookingId, bookingIds));
  }
  await db.delete(scheduledNotifications).where(inArray(scheduledNotifications.dogId, dogIds));
  await db.delete(creditLedger).where(inArray(creditLedger.dogId, dogIds));
  // Requests point at converted bookings (FK) — sever before the bookings go.
  await db.delete(pendingRequests).where(inArray(pendingRequests.leadDogId, dogIds)); // children CASCADE
  if (bookingIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.id, bookingIds)); // booking_dogs CASCADE
  }
  await db.delete(dogCompletedPrograms).where(inArray(dogCompletedPrograms.dogId, dogIds));
  await db.delete(dogVaccines).where(inArray(dogVaccines.dogId, dogIds));
  await db.delete(dogs).where(inArray(dogs.id, dogIds)); // notification_dogs CASCADE
});

registerFixtureHooks();

function buildApps(): {
  ownerApp: ReturnType<typeof makeContractApp>['app'];
  staffApp: ReturnType<typeof makeContractApp>['app'];
} {
  const owner = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(owner.app, { authenticate: owner.authenticate, now: FIXTURE_NOW });
  registerDogsRoute(owner.app, { authenticate: owner.authenticate, now: FIXTURE_NOW });
  const staff = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffRequestsRoute(staff.app, { authenticate: staff.authenticate });
  return { ownerApp: owner.app, staffApp: staff.app };
}

/**
 * A fresh fixture-owned dog. With no options it has NO attended day
 * programs → stale by definition (never seen). `freshAnchor` plants a
 * recently-attended day-school session; `alumni` grants all 5 curriculum
 * programs; `spayedNeutered` sets the profile answer (default NULL =
 * unanswered).
 */
async function createTestDog(
  opts: {
    spayedNeutered?: boolean;
    alumni?: boolean;
    freshAnchor?: boolean;
  } = {},
): Promise<string> {
  const dogId = randomUUID();
  createdDogIds.push(dogId);
  await db.insert(dogs).values({
    id: dogId,
    ownerId: FIXTURE_IDS.ownerId,
    name: `Divert ${dogId.slice(0, 8)}`,
    breed: 'Test Breed',
    birthdate: '2023-01-01',
    evaluationStatus: 'passed',
    spayedNeutered: opts.spayedNeutered ?? null,
  });
  // Satisfy the fixture's day-school vaccine gate (test-rabies +
  // test-bordetella) — these suites are about the DIVERT rules, and the
  // gates run first on both the divert and the instant path.
  await db.insert(dogVaccines).values([
    {
      dogId,
      name: 'Rabies',
      requirementKey: FIXTURE_IDS.requiredVaccineRabiesKey,
      expiresAt: '2027-01-01',
    },
    {
      dogId,
      name: 'Bordetella',
      requirementKey: FIXTURE_IDS.requiredVaccineBordetellaKey,
      expiresAt: '2027-01-01',
    },
  ]);
  if (opts.alumni === true) {
    await db.insert(dogCompletedPrograms).values(
      CURRICULUM_PROGRAMS.map((program) => ({
        dogId,
        program,
        completedByStaffId: FIXTURE_IDS.staffDonavanId,
      })),
    );
  }
  if (opts.freshAnchor === true) {
    const anchorId = randomUUID();
    await db.insert(bookings).values({
      id: anchorId,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: dogId,
      category: 'day-school',
      status: 'past',
      scheduledAt: '2026-05-12T13:00:00Z',
      durationMinutes: 540,
      location: 'fayetteville',
    });
    await db.insert(bookingDogs).values({
      bookingId: anchorId,
      dogId,
      isLead: true,
      attendance: 'attended',
      checkedInAt: '2026-05-12T13:05:00Z',
    });
  }
  return dogId;
}

async function postBooking(
  app: ReturnType<typeof makeContractApp>['app'],
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `divert-${randomUUID()}` },
    payload,
  });
  return { statusCode: res.statusCode, json: () => res.json() };
}

interface DivertedBody {
  diverted: boolean;
  divert_reasons: string[];
  request: {
    id: string;
    category: string;
    status: string;
    preferred_dates: string[];
    location?: string;
    payment?: string;
    divert_reasons?: string[];
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 1. The staleness divert
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — never-attended dog → 202 divert with reevaluation-stale, request row, NO booking/debit',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);

    const res = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(20)],
      location: 'fayetteville',
    });
    assert.equal(res.statusCode, 202);
    const body = res.json() as DivertedBody;
    assert.equal(body.diverted, true);
    assert.deepEqual(body.divert_reasons, ['reevaluation-stale']);
    assert.equal(body.request.category, 'day-school');
    assert.equal(body.request.status, 'submitted');
    assert.equal(body.request.location, 'fayetteville');
    assert.equal(body.request.payment, 'credits');
    assert.deepEqual(body.request.divert_reasons, ['reevaluation-stale']);
    assert.equal(body.request.preferred_dates.length, 1);

    // No booking, no debit — money moves only at the approve conversion.
    const bookingRows = await db.select().from(bookings).where(eq(bookings.leadDogId, dogId));
    assert.equal(bookingRows.length, 0);
    const debits = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.dogId, dogId), eq(creditLedger.reason, 'booking-debit')));
    assert.equal(debits.length, 0);
  },
);

test(
  'POST /bookings — dog attended a day program recently → 201 books instantly',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const dogId = await createTestDog({ freshAnchor: true });
    await topUpCredits(dogId, 'school', 5);

    const res = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(21)],
      location: 'fayetteville',
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
    assert.equal((res.json() as unknown[]).length, 1);
  },
);

test(
  'POST /bookings — stale but ALUMNI dog → 201 (super-alumni exemption)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const dogId = await createTestDog({ alumni: true });
    await topUpCredits(dogId, 'school', 5);

    const res = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(22)],
      location: 'fayetteville',
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
  },
);

test(
  'POST /bookings — fresh but INTACT dog → 202 with not-spayed-neutered; unanswered (NULL) does not divert',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const intact = await createTestDog({ freshAnchor: true, spayedNeutered: false });
    await topUpCredits(intact, 'school', 5);

    const diverted = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: intact,
      dates: [futureWeekday(23)],
      location: 'fayetteville',
    });
    assert.equal(diverted.statusCode, 202);
    assert.deepEqual((diverted.json() as DivertedBody).divert_reasons, ['not-spayed-neutered']);

    // NULL = unanswered — the fresh-anchor default dog books instantly
    // (covered above); belt: an explicit spayed dog books instantly too.
    const spayed = await createTestDog({ freshAnchor: true, spayedNeutered: true });
    await topUpCredits(spayed, 'school', 5);
    const booked = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: spayed,
      dates: [futureWeekday(24)],
      location: 'fayetteville',
    });
    assert.equal(booked.statusCode, 201, JSON.stringify(booked.json()));
  },
);

test(
  'POST /bookings — stale AND intact → both reasons on one diverted request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const dogId = await createTestDog({ spayedNeutered: false });
    await topUpCredits(dogId, 'school', 5);

    const res = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(25)],
      location: 'fayetteville',
    });
    assert.equal(res.statusCode, 202);
    const reasons = (res.json() as DivertedBody).divert_reasons;
    assert.deepEqual([...reasons].sort(), ['not-spayed-neutered', 'reevaluation-stale']);
  },
);

test(
  'POST /bookings — second divert while one is open → 422 already_requested',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);

    const first = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(26)],
      location: 'fayetteville',
    });
    assert.equal(first.statusCode, 202);

    const second = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(27)],
      location: 'fayetteville',
    });
    assert.equal(second.statusCode, 422);
    const err = second.json() as { error: { code: string } };
    assert.equal(err.error.code, 'already_requested');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 2. Approve conversion + the full freshen loop
// ──────────────────────────────────────────────────────────────────────────

test(
  'divert → staff approve → bookings created (credits debited, reminders enqueued, request converted) → attendance freshens the dog',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp, staffApp } = buildApps();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 10);

    // 1. Divert with TWO dates.
    const dates = [futureWeekday(30), futureWeekday(31)];
    const diverted = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates,
      location: 'fayetteville',
    });
    assert.equal(diverted.statusCode, 202);
    const requestId = (diverted.json() as DivertedBody).request.id;
    const preferredIsos = (diverted.json() as DivertedBody).request.preferred_dates;
    assert.equal(preferredIsos.length, 2);

    // 2. Approve — no body needed; the request carries everything.
    const approve = await staffApp.inject({
      method: 'POST',
      url: `/staff/requests/${requestId}/approve`,
      headers: { 'idempotency-key': `approve-${randomUUID()}` },
      payload: {},
    });
    assert.equal(approve.statusCode, 200, approve.body);
    const approved = approve.json() as {
      status: string;
      converted_booking_id?: string;
      divert_reasons?: string[];
    };
    assert.equal(approved.status, 'converted');
    assert.ok(approved.converted_booking_id !== undefined);
    assert.deepEqual(approved.divert_reasons, ['reevaluation-stale']);

    // 3. Bookings landed with EXACTLY the submitted session instants.
    const created = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.leadDogId, dogId), eq(bookings.category, 'day-school')));
    assert.equal(created.length, 2);
    const createdIsos = created.map((b) => new Date(b.scheduledAt).toISOString()).sort();
    assert.deepEqual(createdIsos, [...preferredIsos].sort());

    // Credits debited once per session; reminders enqueued per booking.
    const debits = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.dogId, dogId), eq(creditLedger.reason, 'booking-debit')));
    assert.equal(debits.length, 2);
    const reminders = await db
      .select()
      .from(scheduledNotifications)
      .where(
        inArray(
          scheduledNotifications.bookingId,
          created.map((b) => b.id),
        ),
      );
    assert.equal(reminders.length, 2);

    // 4. Approval alone does NOT freshen — a new POST still diverts (the
    //    converted request no longer blocks as duplicate).
    const stillStale = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(32)],
      location: 'fayetteville',
    });
    assert.equal(stillStale.statusCode, 202, JSON.stringify(stillStale.json()));

    // Clean up the open request so it can't trip the duplicate guard below.
    const openReq = (stillStale.json() as DivertedBody).request.id;
    await db
      .update(pendingRequests)
      .set({ status: 'cancelled' })
      .where(eq(pendingRequests.id, openReq));

    // 5. The dog ATTENDS the approved session → the clock resets → instant.
    const firstBooking = created[0]!;
    await db
      .update(bookingDogs)
      .set({ attendance: 'attended', checkedInAt: new Date().toISOString() })
      .where(and(eq(bookingDogs.bookingId, firstBooking.id), eq(bookingDogs.dogId, dogId)));

    const nowFresh = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(33)],
      location: 'fayetteville',
    });
    assert.equal(nowFresh.statusCode, 201, JSON.stringify(nowFresh.json()));
  },
);

test(
  'PAYG divert stores the card; approve creates the open payg invoice, no credit debit',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp, staffApp } = buildApps();
    const dogId = await createTestDog();

    const diverted = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(35)],
      location: 'fayetteville',
      payment: 'payg',
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
    });
    assert.equal(diverted.statusCode, 202, JSON.stringify(diverted.json()));
    const body = diverted.json() as DivertedBody;
    assert.equal(body.request.payment, 'payg');

    const approve = await staffApp.inject({
      method: 'POST',
      url: `/staff/requests/${body.request.id}/approve`,
      headers: { 'idempotency-key': `approve-payg-${randomUUID()}` },
      payload: {},
    });
    assert.equal(approve.statusCode, 200, approve.body);

    const created = await db.select().from(bookings).where(eq(bookings.leadDogId, dogId));
    assert.equal(created.length, 1);
    const invoiceRows = await db
      .select()
      .from(invoices)
      .where(eq(invoices.bookingId, created[0]!.id));
    assert.equal(invoiceRows.length, 1);
    assert.equal(invoiceRows[0]!.purpose, 'payg');
    assert.equal(invoiceRows[0]!.status, 'open');
    const debits = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.dogId, dogId), eq(creditLedger.reason, 'booking-debit')));
    assert.equal(debits.length, 0);
  },
);

test(
  'approve bounces with a typed 422 when the credits were spent between divert and approval; request stays submitted',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp, staffApp } = buildApps();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 1);

    const diverted = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(36)],
      location: 'fayetteville',
    });
    assert.equal(diverted.statusCode, 202);
    const requestId = (diverted.json() as DivertedBody).request.id;

    // The balance disappears before staff get to it.
    await db.delete(creditLedger).where(eq(creditLedger.dogId, dogId));

    const approve = await staffApp.inject({
      method: 'POST',
      url: `/staff/requests/${requestId}/approve`,
      headers: { 'idempotency-key': `approve-bounce-${randomUUID()}` },
      payload: {},
    });
    assert.equal(approve.statusCode, 422, approve.body);
    const err = approve.json() as { error: { code: string } };
    assert.equal(err.error.code, 'insufficient_credits');

    const [row] = await db
      .select({ status: pendingRequests.status })
      .from(pendingRequests)
      .where(eq(pendingRequests.id, requestId));
    assert.equal(row?.status, 'submitted');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 3. Puppy-class vaccine exemption
// ──────────────────────────────────────────────────────────────────────────

test(
  'vaccine gate — exempt_class_keys skips the requirement for that cohort (trigger floor), still gates other classes',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    // A rabies-style requirement gating group-class, with puppy exempt.
    // Delete-first: a prior crashed run can leave the PK row behind.
    await db.delete(requiredVaccines).where(eq(requiredVaccines.key, 'test-rabies-exempt'));
    await db.insert(requiredVaccines).values({
      key: 'test-rabies-exempt',
      label: 'Rabies (test)',
      gatesCategories: ['group-class'],
      exemptClassKeys: ['puppy'],
    });
    const dogId = await createTestDog({ freshAnchor: true });

    try {
      // Direct INSERT (the trigger floor). Puppy cohort → passes without
      // any rabies row on the dog.
      const puppyBookingId = randomUUID();
      await db.insert(bookings).values({
        id: puppyBookingId,
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: dogId,
        category: 'group-class',
        status: 'upcoming',
        scheduledAt: '2026-06-03T23:00:00Z',
        durationMinutes: 60,
        cohortId: FIXTURE_IDS.cohortPuppyId,
        location: 'fayetteville',
      });

      // Manners cohort → the same dog is blocked by the same requirement.
      await assert.rejects(
        db.insert(bookings).values({
          id: randomUUID(),
          ownerId: FIXTURE_IDS.ownerId,
          leadDogId: dogId,
          category: 'group-class',
          status: 'upcoming',
          scheduledAt: '2026-06-04T23:00:00Z',
          durationMinutes: 60,
          cohortId: FIXTURE_IDS.cohortMannersId,
          location: 'fayetteville',
        }),
        /vaccine gate/,
      );

      // And the exemption is CLASS-scoped, not category-wide: a day-school
      // requirement is untouched by exempt_class_keys (defensive: the
      // divert-fresh dog books day-school with no vaccine rows only while
      // no day-school-gating requirement exists — unchanged here).
      await db.delete(bookings).where(eq(bookings.id, puppyBookingId));
    } finally {
      await db.delete(requiredVaccines).where(eq(requiredVaccines.key, 'test-rabies-exempt'));
    }
    // Keep the linter honest that ownerApp is used in this suite's shape.
    void ownerApp;
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 4. Spay/neuter profile surface + planned-date reminder lifecycle
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /dogs — spay fields round-trip on the wire; planned date enqueues the reminder',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const res = await ownerApp.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `dog-spay-${randomUUID()}` },
      payload: {
        name: 'Spay Test',
        breed: 'Test Breed',
        birthdate: '2026-01-01',
        spayed_neutered: false,
        spay_neuter_planned_on: '2026-09-01',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const wire = res.json() as {
      id: string;
      spayed_neutered?: boolean;
      spay_neuter_planned_on?: string;
    };
    createdDogIds.push(wire.id);
    assert.equal(wire.spayed_neutered, false);
    assert.equal(wire.spay_neuter_planned_on, '2026-09-01');

    const [reminder] = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, `spay-neuter:${wire.id}:2026-09-01`));
    assert.ok(reminder, 'planned-date reminder enqueued');
    assert.equal(reminder!.type, 'spay-neuter-reminder');
    assert.equal(reminder!.status, 'pending');
  },
);

test(
  'PATCH /dogs/:id — moving the planned date cancels the old reminder and enqueues the new; answering "fixed" cancels + clears the date',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const create = await ownerApp.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `dog-spay2-${randomUUID()}` },
      payload: {
        name: 'Spay Move',
        breed: 'Test Breed',
        birthdate: '2026-01-01',
        spayed_neutered: false,
        spay_neuter_planned_on: '2026-08-01',
      },
    });
    const dogId = (create.json() as { id: string }).id;
    createdDogIds.push(dogId);

    // Move the date.
    const move = await ownerApp.inject({
      method: 'PATCH',
      url: `/dogs/${dogId}`,
      headers: { 'idempotency-key': `dog-spay3-${randomUUID()}` },
      payload: { spayed_neutered: false, spay_neuter_planned_on: '2026-10-01' },
    });
    assert.equal(move.statusCode, 200, move.body);

    const rows = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dogId, dogId));
    const byKey = new Map(rows.map((r) => [r.dedupeKey, r.status]));
    assert.equal(byKey.get(`spay-neuter:${dogId}:2026-08-01`), 'cancelled');
    assert.equal(byKey.get(`spay-neuter:${dogId}:2026-10-01`), 'pending');

    // Answer "fixed" — reminder cancelled, planned date cleared on the wire.
    const fixed = await ownerApp.inject({
      method: 'PATCH',
      url: `/dogs/${dogId}`,
      headers: { 'idempotency-key': `dog-spay4-${randomUUID()}` },
      payload: { spayed_neutered: true },
    });
    assert.equal(fixed.statusCode, 200, fixed.body);
    const wire = fixed.json() as { spayed_neutered?: boolean; spay_neuter_planned_on?: string };
    assert.equal(wire.spayed_neutered, true);
    assert.equal(wire.spay_neuter_planned_on, undefined);

    const after = await db
      .select()
      .from(scheduledNotifications)
      .where(
        and(eq(scheduledNotifications.dogId, dogId), eq(scheduledNotifications.status, 'pending')),
      );
    assert.equal(after.length, 0, 'no pending spay reminder survives "fixed"');
  },
);

test(
  'dogs spay-pair coherence — planned date without spayed_neutered:false → 422; revived reminder on A→B→A date dance',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const bad = await ownerApp.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `dog-spay5-${randomUUID()}` },
      payload: {
        name: 'Spay Bad',
        breed: 'Test Breed',
        birthdate: '2026-01-01',
        spay_neuter_planned_on: '2026-09-01',
      },
    });
    assert.equal(bad.statusCode, 422, bad.body);

    // A → B → A: the A-row is revived, not lost to the dedupe collision.
    const create = await ownerApp.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `dog-spay6-${randomUUID()}` },
      payload: {
        name: 'Spay Dance',
        breed: 'Test Breed',
        birthdate: '2026-01-01',
        spayed_neutered: false,
        spay_neuter_planned_on: '2026-08-01',
      },
    });
    const dogId = (create.json() as { id: string }).id;
    createdDogIds.push(dogId);
    const patch = (date: string) =>
      ownerApp.inject({
        method: 'PATCH',
        url: `/dogs/${dogId}`,
        headers: { 'idempotency-key': `dog-spay7-${randomUUID()}` },
        payload: { spayed_neutered: false, spay_neuter_planned_on: date },
      });
    await patch('2026-10-01');
    await patch('2026-08-01');

    const rows = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dogId, dogId));
    const byKey = new Map(rows.map((r) => [r.dedupeKey, r.status]));
    assert.equal(byKey.get(`spay-neuter:${dogId}:2026-08-01`), 'pending', 'A-row revived');
    assert.equal(byKey.get(`spay-neuter:${dogId}:2026-10-01`), 'cancelled');
  },
);

// Belt: intact-divert only reads EXPLICIT false — the repo-level fields
// lookup ignores unanswered dogs and staff dogs entirely (unit-ish check
// through the route: covered by the NULL-doesn't-divert arm above).
test(
  'divert ignores vaccines/display rows — a stale dog with vaccine records still diverts on staleness only',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const dogId = await createTestDog();
    await db.insert(dogVaccines).values({
      dogId,
      name: 'Rabies',
      expiresAt: '2027-01-01',
    });
    await topUpCredits(dogId, 'school', 5);
    const res = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [futureWeekday(40)],
      location: 'fayetteville',
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual((res.json() as DivertedBody).divert_reasons, ['reevaluation-stale']);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 5. Collisions between divert and approval + the double-submit race
// ──────────────────────────────────────────────────────────────────────────

test(
  'race: two concurrent submissions for the same stale dog → exactly one open request (advisory lock serializes the duplicate guard)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 10);

    const [a, b] = await Promise.all([
      postBooking(ownerApp, {
        category: 'day-school',
        lead_dog_id: dogId,
        dates: [futureWeekday(45)],
        location: 'fayetteville',
      }),
      postBooking(ownerApp, {
        category: 'day-school',
        lead_dog_id: dogId,
        dates: [futureWeekday(46)],
        location: 'fayetteville',
      }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [202, 422], `got ${statuses.join(',')}`);

    const open = await db
      .select()
      .from(pendingRequests)
      .where(and(eq(pendingRequests.leadDogId, dogId), eq(pendingRequests.status, 'submitted')));
    assert.equal(open.length, 1, 'exactly one open request survives the race');
  },
);

test(
  'collision: capacity fills between divert and approval → approve 422 insufficient_capacity; request stays submitted',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp, staffApp } = buildApps();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);
    const date = futureWeekday(47);

    const diverted = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [date],
      location: 'fayetteville',
    });
    assert.equal(diverted.statusCode, 202);
    const requestId = (diverted.json() as DivertedBody).request.id;

    // The day fills up before staff get to the queue.
    await db.insert(dayCapacity).values({
      location: 'fayetteville',
      date,
      schoolOpenings: 0,
      daycareOpenings: 0,
    });

    const approve = await staffApp.inject({
      method: 'POST',
      url: `/staff/requests/${requestId}/approve`,
      headers: { 'idempotency-key': `approve-cap-${randomUUID()}` },
      payload: {},
    });
    assert.equal(approve.statusCode, 422, approve.body);
    assert.equal(
      (approve.json() as { error: { code: string } }).error.code,
      'insufficient_capacity',
    );

    const [row] = await db
      .select({ status: pendingRequests.status })
      .from(pendingRequests)
      .where(eq(pendingRequests.id, requestId));
    assert.equal(row?.status, 'submitted');
  },
);

test(
  'collision: the dog gets a same-day booking between divert and approval → approve 422 already_booked; request stays submitted',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp, staffApp } = buildApps();
    const dogId = await createTestDog();
    await topUpCredits(dogId, 'school', 5);
    const date = futureWeekday(48);

    const diverted = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [date],
      location: 'fayetteville',
    });
    assert.equal(diverted.statusCode, 202);
    const requestId = (diverted.json() as DivertedBody).request.id;

    // Staff book the dog into the same day out-of-band before approving.
    const collidingId = randomUUID();
    await db.insert(bookings).values({
      id: collidingId,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: dogId,
      category: 'day-school',
      status: 'upcoming',
      scheduledAt: `${date}T13:00:00Z`,
      durationMinutes: 540,
      location: 'fayetteville',
    });
    await db.insert(bookingDogs).values({ bookingId: collidingId, dogId, isLead: true });

    const approve = await staffApp.inject({
      method: 'POST',
      url: `/staff/requests/${requestId}/approve`,
      headers: { 'idempotency-key': `approve-clash-${randomUUID()}` },
      payload: {},
    });
    assert.equal(approve.statusCode, 422, approve.body);
    assert.equal((approve.json() as { error: { code: string } }).error.code, 'already_booked');

    const [row] = await db
      .select({ status: pendingRequests.status })
      .from(pendingRequests)
      .where(eq(pendingRequests.id, requestId));
    assert.equal(row?.status, 'submitted');
  },
);

test(
  'POST /bookings — multi-dog roster: ONE stale dog diverts the WHOLE request (full roster on it, no bookings, no debits)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const freshLead = await createTestDog({ freshAnchor: true, spayedNeutered: true });
    const freshExtra = await createTestDog({ freshAnchor: true, spayedNeutered: true });
    const staleExtra = await createTestDog({ spayedNeutered: true }); // never attended
    await topUpCredits(freshLead, 'school', 5);
    await topUpCredits(freshExtra, 'school', 5);
    await topUpCredits(staleExtra, 'school', 5);

    const res = await postBooking(ownerApp, {
      category: 'day-school',
      lead_dog_id: freshLead,
      additional_dog_ids: [freshExtra, staleExtra],
      dates: [futureWeekday(20)],
      location: 'fayetteville',
    });
    assert.equal(res.statusCode, 202, JSON.stringify(res.json()));
    const body = res.json() as DivertedBody;
    assert.equal(body.diverted, true);
    assert.deepEqual(body.divert_reasons, ['reevaluation-stale']);

    // The request carries the FULL roster — the approve conversion books all
    // three together, never a partial split.
    const requestDogs = await db
      .select({ dogId: pendingRequestDogs.dogId })
      .from(pendingRequestDogs)
      .where(eq(pendingRequestDogs.requestId, body.request.id));
    assert.deepStrictEqual(
      requestDogs.map((r) => r.dogId).sort(),
      [freshLead, freshExtra, staleExtra].sort(),
      'lead + both additional dogs ride the pending request',
    );

    // Nothing booked, nothing debited — for ANY dog on the roster. (The
    // freshAnchor PAST sessions exist by construction; only an UPCOMING row
    // would mean the divert leaked a real booking.)
    const bookingRows = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          inArray(bookings.leadDogId, [freshLead, freshExtra, staleExtra]),
          eq(bookings.status, 'upcoming'),
        ),
      );
    assert.equal(bookingRows.length, 0, 'no upcoming booking for any roster dog');
    const debits = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(
        and(
          inArray(creditLedger.dogId, [freshLead, freshExtra, staleExtra]),
          eq(creditLedger.reason, 'booking-debit'),
        ),
      );
    assert.equal(debits.length, 0, 'no debit for any roster dog');
  },
);
