import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dayCapacityRepository } from '../../src/db/repositories/dayCapacityRepository.js';
import { waitlistRepository } from '../../src/db/repositories/waitlistRepository.js';
import {
  bookings as bookingsTable,
  charges,
  cohorts,
  creditLedger,
  dayCapacity,
  dogCreditBalance,
  dogVaccines,
  dogs,
  idempotencyKeys,
  invoices,
  pendingRequests,
  pendingRequestDogs,
  scheduledNotifications,
  waitlistEntries,
  waitlistEntryDogs,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { redis } from '../../src/redis.js';
import { registerStaffWaitlistRoutes } from '../../src/routes/staffWaitlist.js';
import { registerWaitlistRoutes } from '../../src/routes/waitlist.js';
import { FIXTURE_IDS, FIXTURE_NOW, futureWeekday, topUpCredits } from './_fixture.js';
import { makeStripeStub } from './_stripeStub.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Regression tests for the four accept-path defects fixed 2026-07-31, plus the
 * past-session guard that shipped with them. Each section below names the
 * defect it exists to keep dead:
 *
 *   (A) **Accept bypassed the approval divert.** POST /bookings parks a roster
 *       that trips a Shanthi-2026-07-14 rule as a `pending_requests` row for
 *       staff; accept booked it instantly, so the waitlist was the way around
 *       the review. Accept must now answer 202 `DivertedBookingWire` on the
 *       same rules, resolve the entry, and give the held seat back.
 *   (B) **A staff cap override could never become a booking.** Ruling 2 lets
 *       staff exceed the cap, and `waitlist_entries.offered_by_staff_id`
 *       records that they did — but accept still asserted capacity, so the
 *       owner got a push saying "a spot opened up" and a 422 when they took it.
 *       The override must skip the CAPACITY ceiling and nothing else.
 *   (C) **A group-class accept was an unconditional 409.** The enrollment
 *       sequence lived inline in POST /enrollments; accept now runs the same
 *       extracted `lib/createCohortEnrollment` core, money and all.
 *   (D) **DELETE /waitlist/:id discarded `waitlistRepository.resolve`'s
 *       boolean** and always replied 204 — telling an owner who had just
 *       accepted that they had left the queue, while they held a fresh booking
 *       and a charged card.
 *
 *   (+) The **past-session guard** compared calendar DATES, so an offer could
 *       be accepted at 4pm into a session that started at half past seven.
 *
 * Every refusal asserts three things, not one: the status, that nothing was
 * created, and that the OFFER SURVIVED — a refusal that consumed the offer
 * would burn the owner's seat on a fixable problem.
 *
 * Entries are inserted directly rather than through POST /waitlist so each case
 * pins the offer's deadline, its FIFO place and its staff-override provenance
 * instead of inheriting them from a join it isn't testing. The one exception is
 * the end-to-end override case, which goes through POST /staff/waitlist/:id/offer
 * precisely because the column's WRITER is what it is testing.
 */

// Backstop sweep: `waitlistCase` already resets on both sides of every case,
// but `day_capacity` and `cohorts` are keyed by neither owner nor test file, so
// a case that dies outside the wrapper (an import-time throw, a killed run)
// would leave rows a later file reads. Registered BEFORE `registerFixtureHooks`
// so it runs ahead of `teardownFixture`.
after(async () => {
  // `SKIP_WHEN_NO_DB.skip === false` is the harness's "there is a database";
  // without one every case skipped and there is nothing to sweep.
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  await resetState();
});

registerFixtureHooks();

/** Reads and the competing-resolve probe below; satisfies `withActor`. */
const TEST_ACTOR = 'system:test-waitlist-accept-fixes';

const LOCATION = 'fayetteville';

/**
 * Three weekdays clear of every fixture booking AND of every other waitlist
 * suite's days (`waitlist-offer` 05-27, `waitlist-promotion` 05-20/23/27,
 * `waitlist-staff` 05-28/29/06-01, `staff-waitlist` 05-25/26,
 * `day-capacity-holds` 05-28/29). Sharing a day across files is invisible until
 * `npm test` runs them in one process against one database.
 *
 * At FIXTURE_TODAY (2026-05-19) these are 2026-06-02 / 06-03 / 06-04 — all CDT,
 * so the 07:30 America/Chicago drop-off window opens at 12:30Z.
 */
const FULL_DAY = futureWeekday(9);
const DIVERT_DAY = futureWeekday(10);
const GUARD_DAY = futureWeekday(11);
const TEST_DAYS = [FULL_DAY, DIVERT_DAY, GUARD_DAY];

/** The instant a day program starts: 07:30 America/Chicago, CDT in June. */
const SESSION_START_UTC_TIME = 'T12:30:00.000Z';

const ONE_HOUR_MS = 3_600_000;
const SIX_WEEKS_OUT_UTC = '2026-07-06T23:00:00Z';
/** `group_classes.puppy.price_per_dog_cents` in the fixture. */
const PUPPY_PRICE_PER_DOG_CENTS = 12_000;

/** Cohorts this file created, so `resetState` can drop them and their children. */
const seededCohortIds: string[] = [];

type App = ReturnType<typeof makeContractApp>['app'];

interface BookingWireLike {
  id: string;
  dog_id: string;
  category: string;
  status: string;
  date: string;
  location?: string;
}

interface RequestWireLike {
  id: string;
  dog_id: string;
  additional_dog_ids?: string[];
  category: string;
  status: string;
  location?: string;
  payment?: string;
  preferred_dates: string[];
  divert_reasons?: string[];
}

interface DivertedWireLike {
  diverted: true;
  divert_reasons: string[];
  request: RequestWireLike;
}

interface ErrorBody {
  error: { code: string; message: string };
}

/**
 * The owner app. `now` is injectable per case because two of the fixes are
 * about WHEN accept is called: the offer deadline and the 07:30 session start.
 */
function ownerApp(now: () => Date = FIXTURE_NOW): App {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerWaitlistRoutes(app, { authenticate, now });
  return app;
}

/** The owner app with the Stripe seam stubbed — only a group-class accept
 *  touches it (group-class is money-paid, charged before the enroll tx). */
function ownerAppWithStripe(): { app: App; stripe: ReturnType<typeof makeStripeStub> } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerWaitlistRoutes(app, { authenticate, now: FIXTURE_NOW, stripe });
  return { app, stripe };
}

/** The staff app, for the one case that makes its override the real way. */
function staffApp(): App {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffWaitlistRoutes(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

function accept(
  app: App,
  id: string,
  opts: { body?: Record<string, unknown>; key?: string } = {},
): ReturnType<App['inject']> {
  return app.inject({
    method: 'POST',
    url: `/waitlist/${id}/accept`,
    headers: { 'idempotency-key': opts.key ?? randomUUID() },
    ...(opts.body === undefined ? {} : { payload: opts.body }),
  });
}

/** DELETE /waitlist/:id — "leave the queue". */
function leave(app: App, id: string, key = randomUUID()): ReturnType<App['inject']> {
  return app.inject({
    method: 'DELETE',
    url: `/waitlist/${id}`,
    headers: { 'idempotency-key': key },
  });
}

function staffOffer(app: App, id: string): ReturnType<App['inject']> {
  return app.inject({
    method: 'POST',
    url: `/staff/waitlist/${id}/offer`,
    headers: { 'idempotency-key': randomUUID() },
  });
}

/** A day-program entry in whatever lifecycle state the case needs. */
async function seedDayEntry(args: {
  dogIds: readonly string[];
  status: 'waiting' | 'offered';
  sessionDate: string;
  /** Offered entries only; defaults to a live 24h deadline from FIXTURE_NOW. */
  offerExpiresAt?: Date;
  /** Set ⇒ this offer was a staff cap override (ruling 2). */
  offeredByStaffId?: string;
}): Promise<string> {
  const [lead] = args.dogIds;
  if (lead === undefined) throw new Error('seedDayEntry needs at least one dog');
  const now = FIXTURE_NOW();
  const offered = args.status === 'offered';
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: lead,
      category: 'day-school',
      status: args.status,
      sessionDate: args.sessionDate,
      location: LOCATION,
      mode: 'school',
      ...(offered
        ? {
            offeredAt: now.toISOString(),
            offerExpiresAt: (
              args.offerExpiresAt ?? new Date(now.getTime() + 24 * ONE_HOUR_MS)
            ).toISOString(),
          }
        : {}),
      ...(args.offeredByStaffId === undefined ? {} : { offeredByStaffId: args.offeredByStaffId }),
    })
    .returning({ id: waitlistEntries.id });
  if (row === undefined) throw new Error('seedDayEntry: insert returned no row');
  await db.insert(waitlistEntryDogs).values(
    args.dogIds.map((dogId) => ({
      waitlistEntryId: row.id,
      dogId,
      isLead: dogId === lead,
    })),
  );
  return row.id;
}

async function seedCohortEntry(args: {
  cohortId: string;
  dogIds: readonly string[];
  offeredByStaffId?: string;
}): Promise<string> {
  const [lead] = args.dogIds;
  if (lead === undefined) throw new Error('seedCohortEntry needs at least one dog');
  const now = FIXTURE_NOW();
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: lead,
      category: 'group-class',
      status: 'offered',
      cohortId: args.cohortId,
      offeredAt: now.toISOString(),
      offerExpiresAt: new Date(now.getTime() + 24 * ONE_HOUR_MS).toISOString(),
      ...(args.offeredByStaffId === undefined ? {} : { offeredByStaffId: args.offeredByStaffId }),
    })
    .returning({ id: waitlistEntries.id });
  if (row === undefined) throw new Error('seedCohortEntry: insert returned no row');
  await db.insert(waitlistEntryDogs).values(
    args.dogIds.map((dogId) => ({
      waitlistEntryId: row.id,
      dogId,
      isLead: dogId === lead,
    })),
  );
  return row.id;
}

/** A cohort of this file's own, tracked for teardown. */
async function makeCohort(args: {
  capacity: number;
  filled: number;
  weeks?: number;
}): Promise<{ id: string; weeks: number }> {
  const id = randomUUID();
  const weeks = args.weeks ?? 2;
  await db.insert(cohorts).values({
    id,
    classKey: 'puppy',
    location: LOCATION,
    startDate: SIX_WEEKS_OUT_UTC,
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks,
    capacity: args.capacity,
    filled: args.filled,
  });
  seededCohortIds.push(id);
  return { id, weeks };
}

async function seedOpenings(date: string, schoolOpenings: number): Promise<void> {
  await db
    .insert(dayCapacity)
    .values({ location: LOCATION, date, schoolOpenings, daycareOpenings: 0 })
    .onConflictDoUpdate({
      target: [dayCapacity.location, dayCapacity.date],
      set: { schoolOpenings, daycareOpenings: 0 },
    });
}

interface EntryState {
  status: string;
  bookingId: string | null;
  resolvedAt: string | null;
  offeredByStaffId: string | null;
}

async function entryState(id: string): Promise<EntryState> {
  const [row] = await db
    .select({
      status: waitlistEntries.status,
      bookingId: waitlistEntries.bookingId,
      resolvedAt: waitlistEntries.resolvedAt,
      offeredByStaffId: waitlistEntries.offeredByStaffId,
    })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, id));
  if (row === undefined) throw new Error(`entryState: no waitlist entry ${id}`);
  return row;
}

/** Every booking the fixture owner holds on `date` (Chicago calendar bucket). */
async function bookingIdsOn(date: string): Promise<string[]> {
  const rows = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.ownerId, FIXTURE_IDS.ownerId),
        sql`(${bookingsTable.scheduledAt} AT TIME ZONE 'America/Chicago')::date = ${date}::date`,
      ),
    );
  return rows.map((r) => r.id);
}

async function bookingIdsInCohort(cohortId: string): Promise<string[]> {
  const rows = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(eq(bookingsTable.cohortId, cohortId));
  return rows.map((r) => r.id);
}

/** The dog's live school balance here — the non-circular "did money move" probe. */
async function schoolBalance(dogId: string): Promise<number> {
  const [row] = await db
    .select({ balance: dogCreditBalance.balance })
    .from(dogCreditBalance)
    .where(
      and(
        eq(dogCreditBalance.dogId, dogId),
        eq(dogCreditBalance.mode, 'school'),
        eq(dogCreditBalance.location, LOCATION),
      ),
    );
  return row?.balance ?? 0;
}

/** The day-program requests this owner has open — the divert's output. */
async function dayProgramRequests(): Promise<
  { id: string; category: string; location: string | null; payment: string | null }[]
> {
  return db
    .select({
      id: pendingRequests.id,
      category: pendingRequests.category,
      location: pendingRequests.location,
      payment: pendingRequests.payment,
    })
    .from(pendingRequests)
    .where(
      and(
        eq(pendingRequests.ownerId, FIXTURE_IDS.ownerId),
        inArray(pendingRequests.category, ['day-school', 'day-care']),
      ),
    );
}

async function cohortFilled(cohortId: string): Promise<number> {
  const [row] = await db
    .select({ filled: cohorts.filled })
    .from(cohorts)
    .where(eq(cohorts.id, cohortId));
  if (row === undefined) throw new Error(`cohortFilled: no cohort ${cohortId}`);
  return row.filled;
}

/** The day's capacity picture, as the booking path computes it. */
async function capacityOn(date: string): Promise<{ openings: number; used: number; held: number }> {
  return withActor(TEST_ACTOR, (tx) =>
    dayCapacityRepository.capacityForDay(tx, { location: LOCATION, date, mode: 'school' }),
  );
}

/** Test-only scaffolding — the API never deletes a booking. */
async function clearBookings(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Children first: these FKs are plain references, so they block the delete.
  await db.delete(scheduledNotifications).where(inArray(scheduledNotifications.bookingId, ids));
  await db.delete(invoices).where(inArray(invoices.bookingId, ids));
  await db.delete(charges).where(inArray(charges.bookingId, ids));
  await db.delete(creditLedger).where(inArray(creditLedger.bookingId, ids));
  await db.delete(bookingsTable).where(inArray(bookingsTable.id, ids)); // booking_dogs CASCADEs
}

/**
 * Drop everything a case in this file can create, in FK-safe order. Deliberately
 * NARROW: it deletes bookings by id (this file's days and this file's cohorts)
 * rather than by owner, because the fixture's own past day programs are the
 * staleness anchors the approval divert reads — sweeping them would make every
 * dog `reevaluation-stale` and quietly change what the (A) cases prove.
 */
async function resetState(): Promise<void> {
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  // Waitlist rows first: `booking_id` is ON DELETE SET NULL, but clearing the
  // pointer before the bookings keeps the order obvious.
  await db.delete(waitlistEntries).where(eq(waitlistEntries.ownerId, FIXTURE_IDS.ownerId));
  // Only the day-program categories: the fixture's own private-lesson and
  // board-and-train requests belong to other suites.
  await db
    .delete(pendingRequests)
    .where(
      and(
        eq(pendingRequests.ownerId, FIXTURE_IDS.ownerId),
        inArray(pendingRequests.category, ['day-school', 'day-care']),
      ),
    );
  for (const day of TEST_DAYS) await clearBookings(await bookingIdsOn(day));
  for (const cohortId of seededCohortIds) {
    await db.delete(invoices).where(eq(invoices.cohortId, cohortId));
    await db.delete(charges).where(eq(charges.cohortId, cohortId));
    await clearBookings(await bookingIdsInCohort(cohortId));
  }
  if (seededCohortIds.length > 0) {
    await db.delete(cohorts).where(inArray(cohorts.id, seededCohortIds));
    seededCohortIds.length = 0;
  }
  await db
    .delete(dayCapacity)
    .where(and(eq(dayCapacity.location, LOCATION), inArray(dayCapacity.date, TEST_DAYS)));
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.ownerId, FIXTURE_IDS.ownerId),
        inArray(idempotencyKeys.endpoint, ['POST /waitlist/:id/accept', 'DELETE /waitlist/:id']),
      ),
    );
  // The staff override's key rides on a STAFF principal, which doesn't fit the
  // `owner_id` FK — so `teardownFixture`'s owner cascade never reaches it and
  // this is the only sweep it gets. Same delete `waitlist-staff.test.ts` does.
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        isNull(idempotencyKeys.ownerId),
        eq(idempotencyKeys.endpoint, 'POST /staff/waitlist/:id/offer'),
      ),
    );
}

/**
 * Run a case against a clean slate and leave one behind even when it fails. A
 * case that throws mid-arc otherwise strands an 'accepted' entry, which
 * FK-blocks `teardownFixture`'s bookings delete for the whole file — and, since
 * the suite shares one database, for the next file's re-seed.
 */
function waitlistCase(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    await resetState();
    try {
      await fn();
    } finally {
      await resetState();
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────
// (A) The approval divert — accept is not a way around staff review
// ──────────────────────────────────────────────────────────────────────────

test(
  '(A) accept — a roster that trips an approval rule is PARKED for staff (202), not booked',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(DIVERT_DAY, 2);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    // The owner answered "no" to the spay/neuter question — Shanthi 2026-07-14
    // rule 2, which diverts at any age.
    await db.update(dogs).set({ spayedNeutered: false }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: DIVERT_DAY,
    });

    try {
      const res = await accept(ownerApp(), entryId, { body: { notes: 'blue leash please' } });
      assert.equal(res.statusCode, 202, res.body);
      const body = res.json() as DivertedWireLike;
      assert.equal(body.diverted, true);
      assert.deepStrictEqual(body.divert_reasons, ['not-spayed-neutered']);
      assert.equal(body.request.category, 'day-school');
      assert.equal(body.request.status, 'submitted');
      assert.equal(body.request.location, LOCATION);
      assert.equal(body.request.payment, 'credits');
      assert.deepStrictEqual(
        body.request.preferred_dates,
        [`${DIVERT_DAY}${SESSION_START_UTC_TIME}`],
        'the exact session instant rides in preferred_dates — approve books it verbatim',
      );

      const requests = await dayProgramRequests();
      assert.equal(requests.length, 1, 'exactly one request was filed');
      assert.equal(requests[0]?.id, body.request.id);
      const roster = await db
        .select({ dogId: pendingRequestDogs.dogId, isLead: pendingRequestDogs.isLead })
        .from(pendingRequestDogs)
        .where(eq(pendingRequestDogs.requestId, body.request.id));
      assert.deepStrictEqual(roster, [{ dogId: FIXTURE_IDS.dog1Id, isLead: true }]);

      assert.equal((await bookingIdsOn(DIVERT_DAY)).length, 0, 'a parked roster is not a booking');
      assert.equal(
        await schoolBalance(FIXTURE_IDS.dog1Id),
        balanceBefore,
        'nothing is owed while staff review',
      );

      // The offer is CONSUMED — leaving it 'offered' would let the deadline
      // lapse into a re-offer of a seat this request is already spoken for.
      const entry = await entryState(entryId);
      assert.equal(entry.status, 'cancelled');
      assert.equal(entry.bookingId, null, 'no booking exists to point at');
      assert.notEqual(entry.resolvedAt, null);
    } finally {
      await db.update(dogs).set({ spayedNeutered: null }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    }
  }),
);

test(
  '(A) accept — a staff cap override does NOT suppress the divert',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(DIVERT_DAY, 2);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    await db.update(dogs).set({ spayedNeutered: false }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    // Offering a seat says "there is room", not "I have looked at this dog".
    // The staff verb that overrides the divert is POST /staff/requests/:id/approve.
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: DIVERT_DAY,
      offeredByStaffId: FIXTURE_IDS.staffDonavanId,
    });

    try {
      const res = await accept(ownerApp(), entryId);
      assert.equal(res.statusCode, 202, res.body);
      assert.equal((await bookingIdsOn(DIVERT_DAY)).length, 0);
      assert.equal((await dayProgramRequests()).length, 1, 'the override still lands in the queue');
      assert.equal((await entryState(entryId)).status, 'cancelled');
    } finally {
      await db.update(dogs).set({ spayedNeutered: null }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    }
  }),
);

test(
  '(A) accept — the divert releases the held seat and wipes the location availability cache',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(DIVERT_DAY, 2);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    await db.update(dogs).set({ spayedNeutered: false }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: DIVERT_DAY,
    });

    try {
      const before = await capacityOn(DIVERT_DAY);
      assert.equal(before.held, 1, 'an outstanding offer holds its seat');
      assert.equal(before.used, 0);

      // A range cache spanning the day. `avail:*` is a computed view of
      // remaining seats, so releasing a hold makes it stale exactly as booking
      // one does — and the divert used to leave it in place.
      const cacheKey = `avail:${LOCATION}:${DIVERT_DAY}:${DIVERT_DAY}`;
      await redis.set(cacheKey, '[]');

      assert.equal((await accept(ownerApp(), entryId)).statusCode, 202);

      const afterPicture = await capacityOn(DIVERT_DAY);
      assert.equal(afterPicture.held, 0, 'the parked roster gives the seat back to the queue');
      assert.equal(afterPicture.used, 0, 'and it did not spend one either');
      assert.equal(await redis.exists(cacheKey), 0, 'the stale availability range was wiped');
    } finally {
      await db.update(dogs).set({ spayedNeutered: null }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    }
  }),
);

test(
  '(A) accept — replaying a diverted accept returns the stored 202 and files ONE request',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(DIVERT_DAY, 2);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    await db.update(dogs).set({ spayedNeutered: false }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: DIVERT_DAY,
    });

    try {
      // The pre-transaction read that routes day-program vs cohort must not
      // assert 'offered': a replay arrives with the entry already resolved, and
      // 404-ing it would refuse a retry the idempotency layer can answer.
      const key = `wl-divert-${randomUUID()}`;
      const app = ownerApp();
      const first = await accept(app, entryId, { key });
      const second = await accept(app, entryId, { key });

      assert.equal(first.statusCode, 202, first.body);
      assert.equal(second.statusCode, 202, second.body);
      assert.deepStrictEqual(second.json(), first.json(), 'byte-for-byte the stored response');
      assert.equal(
        (await dayProgramRequests()).length,
        1,
        'a retry must not file a second request',
      );
    } finally {
      await db.update(dogs).set({ spayedNeutered: null }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    }
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// (B) Ruling 2 — a staff cap override can actually be taken
// ──────────────────────────────────────────────────────────────────────────

/**
 * A day that is genuinely FULL but not CLOSED: one seat, already promised to
 * another family's outstanding offer. That is the only state a waitlist entry
 * can exist in, and the exact state ruling 2 is about.
 */
async function seedFullDayWithRivalHold(): Promise<void> {
  await seedOpenings(FULL_DAY, 1);
  await seedDayEntry({
    dogIds: [FIXTURE_IDS.dog2Id],
    status: 'offered',
    sessionDate: FULL_DAY,
  });
}

test(
  '(B) accept — the SAME full day: no override → 422, staff override → 201',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedFullDayWithRivalHold();
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 2);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: FULL_DAY,
    });

    // Control: the seat this offer would take belongs to somebody else.
    const withoutOverride = await accept(ownerApp(), entryId);
    assert.equal(withoutOverride.statusCode, 422, withoutOverride.body);
    assert.equal((withoutOverride.json() as ErrorBody).error.code, 'insufficient_capacity');
    assert.equal((await bookingIdsOn(FULL_DAY)).length, 0);
    assert.equal((await entryState(entryId)).status, 'offered', 'the refusal rolled back');

    // Exactly ONE column changes: the provenance stamp
    // POST /staff/waitlist/:id/offer writes when a human decides to exceed the
    // cap. Nothing else about the day, the dog or the request differs.
    await db
      .update(waitlistEntries)
      .set({ offeredByStaffId: FIXTURE_IDS.staffDonavanId })
      .where(eq(waitlistEntries.id, entryId));

    const withOverride = await accept(ownerApp(), entryId);
    assert.equal(withOverride.statusCode, 201, withOverride.body);
    const wires = withOverride.json() as BookingWireLike[];
    assert.equal(wires.length, 1);
    assert.equal(wires[0]?.date, `${FULL_DAY}${SESSION_START_UTC_TIME}`);

    const entry = await entryState(entryId);
    assert.equal(entry.status, 'accepted');
    assert.equal(entry.bookingId, wires[0]?.id);
    assert.equal(
      await schoolBalance(FIXTURE_IDS.dog1Id),
      balanceBefore - 1,
      'an override still pays for the seat on the ordinary rules',
    );
  }),
);

test(
  '(B) accept — an override skips CAPACITY and nothing else: a lapsed vaccine still blocks it',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedFullDayWithRivalHold();
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: FULL_DAY,
      offeredByStaffId: FIXTURE_IDS.staffDonavanId,
    });
    await db
      .update(dogVaccines)
      .set({ expiredAt: sql`now()` })
      .where(eq(dogVaccines.id, FIXTURE_IDS.vaccine1Id));

    try {
      // An override is a decision to exceed the CAP. It is not a decision to
      // walk an unvaccinated dog into the building.
      const res = await accept(ownerApp(), entryId);
      assert.equal(res.statusCode, 422, res.body);
      assert.equal((res.json() as ErrorBody).error.code, 'vaccine_missing');
      assert.equal((await bookingIdsOn(FULL_DAY)).length, 0);
      assert.equal(
        (await entryState(entryId)).status,
        'offered',
        'a fixable blocker must not burn the offer',
      );
    } finally {
      await db
        .update(dogVaccines)
        .set({ expiredAt: null })
        .where(eq(dogVaccines.id, FIXTURE_IDS.vaccine1Id));
    }
  }),
);

test(
  '(B) accept — the override cannot be asked for from the request body',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedFullDayWithRivalHold();
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: FULL_DAY,
    });

    // The accept body is `.strict()`, so an owner who guesses the internal
    // argument name is refused AT THE PARSE BOUNDARY rather than quietly
    // ignored — the difference between "no field parses this" and "no field
    // parses this TODAY" is one careless `.passthrough()`. 400 because the
    // payload is structurally wrong, not semantically unusable.
    const res = await accept(ownerApp(), entryId, { body: { allow_over_capacity: true } });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as ErrorBody).error.code, 'bad_request');
    assert.match((res.json() as ErrorBody).error.message, /allow_over_capacity/);
    assert.equal((await bookingIdsOn(FULL_DAY)).length, 0);
    assert.equal((await entryState(entryId)).status, 'offered');
  }),
);

test(
  '(B) staff offer → owner accept — the override travels end-to-end through offered_by_staff_id',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedFullDayWithRivalHold();
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'waiting',
      sessionDate: FULL_DAY,
    });

    // The whole ruling-2 journey, through the real writer: staff hand out a
    // seat the day does not have, and the owner takes it.
    const offered = await staffOffer(staffApp(), entryId);
    assert.equal(offered.statusCode, 200, offered.body);
    assert.equal(
      (await entryState(entryId)).offeredByStaffId,
      FIXTURE_IDS.staffDonavanId,
      'the offer records who decided to exceed the cap',
    );

    const accepted = await accept(ownerApp(), entryId);
    assert.equal(
      accepted.statusCode,
      201,
      `an overridden offer must be takeable, got ${accepted.body}`,
    );
    assert.equal((await bookingIdsOn(FULL_DAY)).length, 1);
    assert.equal((await entryState(entryId)).status, 'accepted');
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// (C) Group class — accept enrolls through the shared cohort core
// ──────────────────────────────────────────────────────────────────────────

test(
  '(C) accept — pay-now group class: one intent per dog, weeks × dogs bookings, filled bumped',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    const cohort = await makeCohort({ capacity: 6, filled: 0, weeks: 2 });
    const entryId = await seedCohortEntry({
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
    });
    const { app, stripe } = ownerAppWithStripe();

    const res = await accept(app, entryId, {
      body: { payment_method_id: FIXTURE_IDS.paymentMethod1Id, pay_later: false },
    });
    assert.equal(res.statusCode, 201, res.body);
    const wires = res.json() as BookingWireLike[];
    assert.equal(wires.length, 2 * cohort.weeks, '|dogs| × weeks, exactly as POST /enrollments');
    for (const wire of wires) assert.equal(wire.category, 'group-class');

    // Money moved through the SAME pre-transaction charge loop POST /enrollments
    // runs: one PaymentIntent per dog, so a single dog can be refunded later.
    const intents = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(intents.length, 2, 'one intent per dog');
    for (const call of intents) assert.equal(call.args.amountCents, PUPPY_PRICE_PER_DOG_CENTS);

    const chargeRows = await db
      .select({ status: charges.status, purpose: charges.purpose, dogId: charges.dogId })
      .from(charges)
      .where(eq(charges.cohortId, cohort.id));
    assert.equal(chargeRows.length, 2);
    for (const row of chargeRows) {
      assert.equal(row.status, 'succeeded');
      assert.equal(row.purpose, 'group-class');
    }
    assert.deepStrictEqual(
      chargeRows.map((r) => r.dogId).sort(),
      [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id].sort(),
      'the charge is per (cohort, dog)',
    );
    assert.equal(
      (await db.select().from(invoices).where(eq(invoices.cohortId, cohort.id))).length,
      0,
      'pay-now raises no invoice',
    );

    assert.equal(await cohortFilled(cohort.id), 2, 'the cohort seats are spent');
    const entry = await entryState(entryId);
    assert.equal(entry.status, 'accepted');
    assert.equal(entry.bookingId, wires[0]?.id, 'the entry points at the first weekly session');
  }),
);

test(
  '(C) accept — a FULL cohort refuses and refunds the money already captured',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    const cohort = await makeCohort({ capacity: 1, filled: 1, weeks: 2 });
    const entryId = await seedCohortEntry({ cohortId: cohort.id, dogIds: [FIXTURE_IDS.dog1Id] });
    const { app, stripe } = ownerAppWithStripe();

    // The card is charged BEFORE the transaction (a long Stripe call must not
    // pin one open), so the shared core's capacity refusal has to unwind it.
    const res = await accept(app, entryId, {
      body: { payment_method_id: FIXTURE_IDS.paymentMethod1Id, pay_later: false },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as ErrorBody).error.code, 'cohort_full');

    const refunds = stripe.calls.filter((c) => c.method === 'createRefund');
    assert.equal(refunds.length, 1, 'captured money is refunded, not stranded');
    assert.equal(refunds[0]?.args.amountCents, PUPPY_PRICE_PER_DOG_CENTS);

    assert.equal(await cohortFilled(cohort.id), 1, 'no seat was taken');
    assert.equal((await bookingIdsInCohort(cohort.id)).length, 0);
    assert.equal(
      (await db.select().from(charges).where(eq(charges.cohortId, cohort.id))).length,
      0,
      'the rolled-back transaction wrote no charge row',
    );
    assert.equal((await entryState(entryId)).status, 'offered', 'the owner keeps their place');
  }),
);

test(
  '(C) accept — a card that never reaches succeeded enrolls nobody and cancels the intent',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    const cohort = await makeCohort({ capacity: 6, filled: 0, weeks: 2 });
    const entryId = await seedCohortEntry({ cohortId: cohort.id, dogIds: [FIXTURE_IDS.dog1Id] });
    const { app, stripe } = ownerAppWithStripe();
    // Off-session 3DS: the intent confirms but parks at requires_action.
    stripe.setNextIntentStatus('requires_action');

    const res = await accept(app, entryId, {
      body: { payment_method_id: FIXTURE_IDS.paymentMethod1Id, pay_later: false },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as ErrorBody).error.code, 'payment_required');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length,
      1,
      'an unsettled intent is cancelled so it cannot later auto-succeed',
    );
    assert.equal(await cohortFilled(cohort.id), 0);
    assert.equal((await bookingIdsInCohort(cohort.id)).length, 0);
    assert.equal((await entryState(entryId)).status, 'offered');
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// (+) The past-session guard — the 07:30 instant, not the calendar date
// ──────────────────────────────────────────────────────────────────────────

test(
  '(+) accept — 4pm on the session’s OWN day is refused: the session started at 07:30',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(GUARD_DAY, 2);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    // 21:00Z = 16:00 America/Chicago on the session's own date. A staff
    // cap-override stamps `now + window` with no clamp, so a LIVE deadline on a
    // started session is reachable — the date-vs-date comparison this replaced
    // saw "same calendar day" and let the owner in eight hours late.
    const fourPmChicago = new Date(`${GUARD_DAY}T21:00:00Z`);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: GUARD_DAY,
      offerExpiresAt: new Date(fourPmChicago.getTime() + 2 * ONE_HOUR_MS),
    });

    const res = await accept(
      ownerApp(() => fourPmChicago),
      entryId,
    );
    assert.equal(res.statusCode, 409, res.body);
    assert.match((res.json() as ErrorBody).error.message, /already passed/i);
    assert.equal(
      (await bookingIdsOn(GUARD_DAY)).length,
      0,
      'never book into a session in progress',
    );
    assert.equal(await schoolBalance(FIXTURE_IDS.dog1Id), balanceBefore);
    assert.equal((await entryState(entryId)).status, 'offered');
  }),
);

test(
  '(+) accept — 6am on the same day still books: the guard is the start, not "today is too late"',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(GUARD_DAY, 2);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    // 11:00Z = 06:00 America/Chicago — ninety minutes before drop-off opens.
    const sixAmChicago = new Date(`${GUARD_DAY}T11:00:00Z`);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: GUARD_DAY,
      offerExpiresAt: new Date(sixAmChicago.getTime() + ONE_HOUR_MS),
    });

    const res = await accept(
      ownerApp(() => sixAmChicago),
      entryId,
    );
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(
      (res.json() as BookingWireLike[])[0]?.date,
      `${GUARD_DAY}${SESSION_START_UTC_TIME}`,
      'a same-day accept books the same 07:30 session',
    );
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// (D) DELETE /waitlist/:id — the boolean `resolve` returns is load-bearing
// ──────────────────────────────────────────────────────────────────────────

test(
  '(D) DELETE — a live entry still leaves the queue: 204, resolved, nothing else touched',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(FULL_DAY, 1);
    const waiting = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'waiting',
      sessionDate: FULL_DAY,
    });
    const offered = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog2Id],
      status: 'offered',
      sessionDate: FULL_DAY,
    });
    const app = ownerApp();

    const leftWaiting = await leave(app, waiting);
    assert.equal(leftWaiting.statusCode, 204, leftWaiting.body);
    assert.equal(leftWaiting.body, '', 'a terminal resolve returns no envelope');
    assert.equal((await entryState(waiting)).status, 'cancelled');
    assert.notEqual((await entryState(waiting)).resolvedAt, null);

    // An offered entry can be abandoned too — the conflict branch below is
    // about a LOST RACE, not about refusing to leave a queue you were offered.
    const leftOffered = await leave(app, offered);
    assert.equal(leftOffered.statusCode, 204, leftOffered.body);
    assert.equal((await entryState(offered)).status, 'cancelled');
    assert.equal((await bookingIdsOn(FULL_DAY)).length, 0);
  }),
);

test(
  '(D) DELETE — losing the race to a concurrent resolve answers 409, never a lying 204',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(FULL_DAY, 1);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: FULL_DAY,
    });

    // The interleaving the fix is about, forced rather than hoped for. A
    // competing transaction resolves the entry and HOLDS the row lock; the
    // DELETE's read still sees 'offered' (READ COMMITTED snapshot), so its
    // conditional UPDATE blocks and then re-evaluates against the winner's
    // committed status and matches nothing.
    let releaseWinner = (): void => {};
    const winnerMayCommit = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const winner = withActor(TEST_ACTOR, async (tx) => {
      const resolved = await waitlistRepository.resolve(tx, {
        id: entryId,
        from: 'offered',
        to: 'declined',
        resolvedAt: FIXTURE_NOW(),
      });
      assert.equal(resolved, true, 'the competing resolve is the winner by construction');
      await winnerMayCommit;
    });

    const deleting = leave(ownerApp(), entryId);
    await waitUntilSomeoneIsBlockedOnALock();
    releaseWinner();
    await winner;

    const res = await deleting;
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as ErrorBody).error.code, 'conflict');
    assert.match((res.json() as ErrorBody).error.message, /already resolved/i);
    assert.equal(
      (await entryState(entryId)).status,
      'declined',
      'the loser must not overwrite the winner',
    );
  }),
);

test(
  '(D) DELETE racing the owner’s own accept — never 204 while a booking exists',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(FULL_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: FULL_DAY,
    });

    // Two taps on two devices. Whichever lands first, the OTHER one must not
    // report success — a 204 here told an owner they had left the queue while
    // they were in fact holding a fresh booking and a charged card.
    const app = ownerApp();
    const [acceptRes, deleteRes] = await Promise.all([accept(app, entryId), leave(app, entryId)]);

    const winners = [acceptRes, deleteRes].filter((r) => r.statusCode < 300);
    assert.equal(
      winners.length,
      1,
      `exactly one resolution may win, got accept=${acceptRes.statusCode} delete=${deleteRes.statusCode}`,
    );

    const entry = await entryState(entryId);
    const bookings = await bookingIdsOn(FULL_DAY);
    if (acceptRes.statusCode === 201) {
      assert.equal(entry.status, 'accepted');
      assert.deepStrictEqual(bookings, [entry.bookingId]);
      assert.ok(
        deleteRes.statusCode === 409 || deleteRes.statusCode === 404,
        `the losing DELETE must refuse, got ${deleteRes.statusCode}: ${deleteRes.body}`,
      );
      assert.equal(await schoolBalance(FIXTURE_IDS.dog1Id), balanceBefore - 1);
    } else {
      assert.equal(entry.status, 'cancelled');
      assert.equal(entry.bookingId, null);
      assert.equal(bookings.length, 0, 'a losing accept must not leave a booking behind');
      assert.equal(
        await schoolBalance(FIXTURE_IDS.dog1Id),
        balanceBefore,
        'a rolled-back accept must not spend a credit',
      );
    }
  }),
);

/**
 * Block until some backend session is waiting on a lock, or give up. The
 * DELETE under test is the only thing that can be waiting: nothing else in this
 * file's case is contending, and `pg_stat_activity` is scoped to this database.
 *
 * A fixed sleep would be a coin flip dressed up as a test — too short and the
 * DELETE's SELECT has not run yet (it would see the committed resolve and 404
 * down a different branch), too long and the suite pays for it every run.
 */
async function waitUntilSomeoneIsBlockedOnALock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const blocked = await db.execute(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and pid <> pg_backend_pid()`,
    );
    // Raw SQL boundary: the SELECT projects exactly one integer column.
    if (Number(blocked.rows[0]?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the DELETE to block on the entry row lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ──────────────────────────────────────────────────────────────────────────
// KNOWN GAP — fails on purpose. See the handoff.
// ──────────────────────────────────────────────────────────────────────────

test(
  '(B) accept — KNOWN GAP: ruling 2 cannot be honoured for a GROUP CLASS',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    const cohort = await makeCohort({ capacity: 1, filled: 1, weeks: 2 });
    const entryId = await seedCohortEntry({
      cohortId: cohort.id,
      dogIds: [FIXTURE_IDS.dog1Id],
      offeredByStaffId: FIXTURE_IDS.staffDonavanId,
    });
    const { app } = ownerAppWithStripe();

    // Ruling 2 says staff can override the cap. For a day program they can —
    // `day_capacity` has no DB-side ceiling, so the API owns the decision. For a
    // cohort they cannot: `cohorts` carries `CHECK (filled <= capacity)`, so no
    // API flag can push `filled` past it and skipping the route-level check
    // would only turn a typed 422 into a constraint violation. Today staff must
    // raise `cohorts.capacity` instead.
    //
    // This assertion is the reminder. Honouring ruling 2 for group classes needs
    // that CHECK changed in `.claude/backend/schema.sql` (and then
    // `src/db/schema/schema.ts`) — Allison's call, not an agent's.
    const res = await accept(app, entryId, {
      body: { payment_method_id: FIXTURE_IDS.paymentMethod1Id, pay_later: true },
    });
    assert.equal(
      res.statusCode,
      201,
      `ruling 2 says a staff override books; a cohort override still answers ${res.body}`,
    );
  }),
);

// A field the (B) cases lean on: the accept path can only read
// `offered_by_staff_id` if the repository projects it. It was added mid-flight
// by the fix agent and the file was being edited concurrently, so assert the
// two lines are still there rather than discovering their loss as a mysterious
// 422 in the override cases above.
test(
  '(B) waitlistRepository projects offered_by_staff_id — the column accept reads',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: FULL_DAY,
      offeredByStaffId: FIXTURE_IDS.staffDonavanId,
    });
    const entry = await withActor(TEST_ACTOR, (tx) =>
      waitlistRepository.findByIdForOwner(tx, { id: entryId, ownerId: FIXTURE_IDS.ownerId }),
    );
    assert.equal(
      entry?.offeredByStaffId,
      FIXTURE_IDS.staffDonavanId,
      'ENTRY_PROJECTION must expose offered_by_staff_id or every override 422s',
    );
    // Guards the negative too: a promoted (non-override) offer must read NULL,
    // or every accept would silently book past the cap.
    const promoted = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog2Id],
      status: 'offered',
      sessionDate: FULL_DAY,
    });
    const promotedEntry = await withActor(TEST_ACTOR, (tx) =>
      waitlistRepository.findByIdForOwner(tx, { id: promoted, ownerId: FIXTURE_IDS.ownerId }),
    );
    assert.equal(
      promotedEntry?.offeredByStaffId,
      null,
      'a promoted offer is NOT an override — reading it as one would book past every cap',
    );
  }),
);
