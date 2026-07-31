import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dayCapacityRepository } from '../../src/db/repositories/dayCapacityRepository.js';
import { waitlistRepository } from '../../src/db/repositories/waitlistRepository.js';
import {
  bookingDogs,
  bookings,
  cohorts,
  dayCapacity,
  dogVaccines,
  dogs,
  invoices,
  requiredVaccines,
  scheduledNotifications,
  waitlistEntries,
  waitlistEntryDogs,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { chicagoWallTimeToUtc } from '../../src/lib/chicagoDate.js';
import { pgTimestampToDate } from '../../src/lib/pgTimestamp.js';
import { promoteForTarget, promoteFreedSeat } from '../../src/lib/waitlistPromotion.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { FIXTURE_IDS, FIXTURE_NOW, futureWeekday } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';
import type { WaitlistTarget } from '../../src/db/repositories/waitlistRepository.js';
import type { FastifyInstance } from 'fastify';

/**
 * Regression net for the 2026-07-31 waitlist promotion work: the WIRING (a
 * freed seat actually reaches a queue), GATE-AWARE PROMOTION (Allison rulings 6
 * and 7), and the seat arithmetic the two of them share.
 *
 * `waitlist-promotion.test.ts` is the promotion algebra in isolation — it calls
 * `promoteForTarget` directly and asserts who gets the seat. This file is the
 * defects that survived that coverage, each one something an owner would feel:
 *
 *   A. **Nothing called promotion when a seat freed.** Every rule in the
 *      sibling file was correct and unreachable: a cancelled day-program
 *      booking and a cohort withdrawal offered the seat to nobody, so a queue
 *      that had never been promoted was never promoted at all. The first four
 *      tests drive the two real verbs — `POST /bookings/:id/cancel` and
 *      `POST /enrollments/:cohortId/withdraw` — end to end.
 *   A'. **Promotion must never be able to fail the mutation that freed the
 *      seat.** The canceller and the next family in line are different people;
 *      a stranger's missing evaluation may not roll back a cancellation and its
 *      refund. Two halves: the ordinary gate failure, and the SAVEPOINT
 *      boundary under an arbitrary blow-up.
 *   B. **Gates were not re-run at promotion (R6/R7).** A seat offered to a
 *      family who would be refused at accept holds a real seat hostage for 24h.
 *      Covered: the flag, the queue order it drives, the un-demotion when the
 *      problem is fixed, and the group-class class-key exemption.
 *   C. **`capacitySeats − held` was computed over two different dog
 *      populations, and `held` was then subtracted twice.** Either way a seat
 *      that exists is never offered to anybody.
 *   D. **An offer could expire before its own push went out.**
 *
 * Entries are inserted directly (not through `POST /waitlist`) for the same
 * reason the sibling file does it: `created_at` has to be pinned to make FIFO
 * and the R7 demotion observable. The verbs under test here are the ones that
 * FREE a seat, not the one that joins a queue.
 */

// Registered BEFORE `registerFixtureHooks` so it runs ahead of
// `teardownFixture` (node:test runs `after` hooks in registration order):
// this file's rows hang off the fixture owner and its dogs.
if (SKIP_WHEN_NO_DB.skip === false) after(clearOwnState);
registerFixtureHooks();

/** `<kind>:<id>`, the shape `actorOf(principal)` produces for an owner. */
const OWNER_ACTOR = `owner:${FIXTURE_IDS.ownerId}`;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The floor `promoteForTarget` clamps its offer window to
 * (`MIN_OFFER_WINDOW_MINUTES`, private to that module). Spelled out here rather
 * than imported so the test states the CONTRACT — "an offer is at least a
 * quarter of an hour of real chance" — instead of restating the implementation.
 */
const MIN_OFFER_WINDOW_MINUTES = 15;

/** 10:00 CDT on the fixture's "today"; every fixture-anchored date is after it. */
const NOW = new Date('2026-05-19T15:00:00Z');

const LOCATION = 'fayetteville';

/**
 * Weekdays past every other waitlist suite's (the sibling files reach (8)) so
 * two files can never seed the same `day_capacity` row.
 */
const GATE_FALLTHROUGH_DAY = futureWeekday(12);
const QUEUE_ORDER_DAY = futureWeekday(13);
const UNBLOCK_DAY = futureWeekday(14);
const BLOCKED_SINCE_DAY = futureWeekday(15);
const HELD_POPULATION_DAY = futureWeekday(16);
const HELD_ONCE_DAY = futureWeekday(17);
const OFFER_FLOOR_DAY = futureWeekday(18);
/** Two unrelated days the SAVEPOINT test writes to, before and after promotion. */
const BOUNDARY_DAY_BEFORE = futureWeekday(19);
const BOUNDARY_DAY_AFTER = futureWeekday(20);

/**
 * The cancel path takes no injectable clock — `cancelBookingInTx` promotes with
 * `new Date()`, consistent with the credit-back branch above it. So a test that
 * drives a real cancel has to anchor its session on the REAL calendar or
 * promotion refuses it as a session that already started. Same reason
 * `booking-cancel.test.ts` anchors its dates on real `now()`.
 */
const CANCEL_DAY = realFutureWeekday(0);
const CANCEL_GATE_DAY = realFutureWeekday(1);
const CANCEL_MODE_DAY = realFutureWeekday(2);

const MANAGED_DAYS = [
  GATE_FALLTHROUGH_DAY,
  QUEUE_ORDER_DAY,
  UNBLOCK_DAY,
  BLOCKED_SINCE_DAY,
  HELD_POPULATION_DAY,
  HELD_ONCE_DAY,
  OFFER_FLOOR_DAY,
  BOUNDARY_DAY_BEFORE,
  BOUNDARY_DAY_AFTER,
  CANCEL_DAY,
  CANCEL_GATE_DAY,
  CANCEL_MODE_DAY,
];

/**
 * A dog of the fixture owner's that fails a booking gate: no evaluation and no
 * vaccines. Its entries are the ones R6 must refuse to hand a seat to. Kept
 * apart from Waffles and Lola (both fully gated) so a test can put a passing
 * and a failing family in the same queue.
 */
const BLOCKED_DOG_ID = '33333333-3333-4333-8333-3333333390a1';
/**
 * A staff-owned dog. `dogs.capacity_exempt` is `staff_owner_id IS NOT NULL`, so
 * this dog occupies no seat in either of the two counts promotion subtracts.
 */
const STAFF_DOG_ID = '33333333-3333-4333-8333-3333333390a2';

/** A vaccine requirement that gates GROUP CLASS, exempting puppy classes. */
const GROUP_CLASS_REQUIREMENT_KEY = 'test-groupclass-shot';

/** Cohorts and bookings this file creates; dropped by id so the fixture's survive. */
const seededCohortIds: string[] = [];
const seededBookingIds: string[] = [];

// ── seeding + teardown ──────────────────────────────────────────────────────

/**
 * YYYY-MM-DD for the `nth` weekday strictly after the REAL today — the
 * fixture's `futureWeekday` anchored on `Date.now()` instead of FIXTURE_TODAY.
 * See `CANCEL_DAY` for why the cancel path needs it.
 */
function realFutureWeekday(nth: number): string {
  let count = 0;
  let offset = 1;
  for (;;) {
    const d = new Date(Date.now() + offset * DAY_MS);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      if (count === nth) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }
      count += 1;
    }
    offset += 1;
  }
}

function dayTarget(category: 'day-school' | 'day-care', sessionDate: string): WaitlistTarget {
  return {
    kind: 'day-program',
    category,
    sessionDate,
    location: LOCATION,
    mode: category === 'day-school' ? 'school' : 'daycare',
  };
}

/** 07:30 America/Chicago on that date — when a day-program session starts. */
function sessionStartOf(sessionDate: string): Date {
  return chicagoWallTimeToUtc(sessionDate, 7, 30);
}

async function clearOwnState(): Promise<void> {
  // Offer notifications carry `dog_id`, so they must go before the dogs do.
  await db
    .delete(scheduledNotifications)
    .where(like(scheduledNotifications.dedupeKey, 'waitlist-spot-open:%'));
  await db.delete(waitlistEntries).where(eq(waitlistEntries.ownerId, FIXTURE_IDS.ownerId));
  if (seededBookingIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.id, seededBookingIds));
    seededBookingIds.length = 0;
  }
  if (seededCohortIds.length > 0) {
    // Enrollment writes an invoice and the weekly bookings against the cohort;
    // both reference it, so both drop first.
    await db.delete(invoices).where(inArray(invoices.cohortId, seededCohortIds));
    await db.delete(bookings).where(inArray(bookings.cohortId, seededCohortIds));
    await db.delete(cohorts).where(inArray(cohorts.id, seededCohortIds));
    seededCohortIds.length = 0;
  }
  await db
    .delete(dayCapacity)
    .where(and(eq(dayCapacity.location, LOCATION), inArray(dayCapacity.date, MANAGED_DAYS)));
  // `dog_vaccines` cascade with the dog.
  await db.delete(dogs).where(inArray(dogs.id, [BLOCKED_DOG_ID, STAFF_DOG_ID]));
  await db.delete(requiredVaccines).where(eq(requiredVaccines.key, GROUP_CLASS_REQUIREMENT_KEY));
}

/** A clean world: nothing left over, the two extra dogs back in their start state. */
async function resetWorld(): Promise<void> {
  await clearOwnState();
  await db.insert(dogs).values([
    {
      id: BLOCKED_DOG_ID,
      ownerId: FIXTURE_IDS.ownerId,
      name: 'Pepper',
      breed: 'Aussie',
      ageMonthsOverride: 20,
      // Both gate failures are available on this dog: 'not-evaluated' fails
      // first (gate order is payment → evaluation → vaccine → agreement), and
      // with no `dog_vaccines` rows the vaccine gate fails once evaluation is
      // fixed. That is what makes the "reason is refreshed" case reachable.
      evaluationStatus: 'not-evaluated',
    },
    {
      id: STAFF_DOG_ID,
      staffOwnerId: FIXTURE_IDS.staffDonavanId,
      name: 'Ranger',
      breed: 'Malinois',
      ageMonthsOverride: 60,
      evaluationStatus: 'passed',
    },
  ]);
}

/** Give a dog everything the day-program gates ask for, as an owner would. */
async function passEveryGate(dogId: string): Promise<void> {
  await db
    .update(dogs)
    .set({ evaluationStatus: 'passed', evaluationDate: '2026-05-10T15:00:00Z' })
    .where(eq(dogs.id, dogId));
  // The vaccine gate compares against Chicago TODAY on the real clock, so the
  // expiry is far out rather than anchored on FIXTURE_TODAY.
  await db.insert(dogVaccines).values([
    {
      dogId,
      name: 'Rabies',
      requirementKey: FIXTURE_IDS.requiredVaccineRabiesKey,
      expiresAt: '2029-12-31',
    },
    {
      dogId,
      name: 'Bordetella',
      requirementKey: FIXTURE_IDS.requiredVaccineBordetellaKey,
      expiresAt: '2029-12-31',
    },
  ]);
}

async function seedOpenings(
  date: string,
  openings: { school?: number; daycare?: number },
): Promise<void> {
  await db.insert(dayCapacity).values({
    location: LOCATION,
    date,
    schoolOpenings: openings.school ?? 0,
    daycareOpenings: openings.daycare ?? 0,
  });
}

async function seedCohort(args: {
  classKey: 'puppy' | 'manners-1';
  capacity: number;
  filled?: number;
  startDate?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(cohorts).values({
    id,
    classKey: args.classKey,
    location: LOCATION,
    startDate: args.startDate ?? '2026-07-06T23:00:00Z',
    weeklyTime: '6:00 PM',
    weeks: 4,
    capacity: args.capacity,
    filled: args.filled ?? 0,
  });
  seededCohortIds.push(id);
  return id;
}

async function attachDogs(entryId: string, leadDogId: string, dogIds: string[]): Promise<void> {
  await db
    .insert(waitlistEntryDogs)
    .values(
      dogIds.map((dogId) => ({ waitlistEntryId: entryId, dogId, isLead: dogId === leadDogId })),
    );
}

/** One waiting day-program entry with a pinned `created_at` — FIFO made explicit. */
async function seedDayEntry(args: {
  category?: 'day-school' | 'day-care';
  sessionDate: string;
  leadDogId: string;
  extraDogIds?: readonly string[];
  createdAt: string;
}): Promise<string> {
  const category = args.category ?? 'day-school';
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: args.leadDogId,
      category,
      sessionDate: args.sessionDate,
      location: LOCATION,
      mode: category === 'day-school' ? 'school' : 'daycare',
      createdAt: args.createdAt,
    })
    .returning({ id: waitlistEntries.id });
  if (row === undefined) throw new Error('seedDayEntry: insert returned no row');
  await attachDogs(row.id, args.leadDogId, [args.leadDogId, ...(args.extraDogIds ?? [])]);
  return row.id;
}

async function seedCohortEntry(args: {
  cohortId: string;
  leadDogId: string;
  createdAt: string;
}): Promise<string> {
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: args.leadDogId,
      category: 'group-class',
      cohortId: args.cohortId,
      createdAt: args.createdAt,
    })
    .returning({ id: waitlistEntries.id });
  if (row === undefined) throw new Error('seedCohortEntry: insert returned no row');
  await attachDogs(row.id, args.leadDogId, [args.leadDogId]);
  return row.id;
}

/** Hand-seed one upcoming day-program booking at 07:30 Chicago on `sessionDate`. */
async function seedDayBooking(args: {
  category: 'day-school' | 'day-care';
  sessionDate: string;
  leadDogId: string;
}): Promise<string> {
  const id = randomUUID();
  const scheduledAt = sessionStartOf(args.sessionDate);
  await db.insert(bookings).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: args.leadDogId,
    category: args.category,
    status: 'upcoming',
    scheduledAt: scheduledAt.toISOString(),
    // 48h before drop-off — the ordinary window, so the cancel is not a
    // forfeit. Neither branch changes what promotion does; a within-window
    // cancel is simply the realistic one.
    cancelDeadlineAt: new Date(scheduledAt.getTime() - 2 * DAY_MS).toISOString(),
    location: LOCATION,
  });
  await db.insert(bookingDogs).values({ bookingId: id, dogId: args.leadDogId, isLead: true });
  seededBookingIds.push(id);
  return id;
}

interface EntrySnapshot {
  status: string;
  offeredAt: string | null;
  offerExpiresAt: string | null;
  gateBlockedAt: string | null;
  gateBlockedReason: string | null;
}

async function entryRow(entryId: string): Promise<EntrySnapshot> {
  const [row] = await db
    .select({
      status: waitlistEntries.status,
      offeredAt: waitlistEntries.offeredAt,
      offerExpiresAt: waitlistEntries.offerExpiresAt,
      gateBlockedAt: waitlistEntries.gateBlockedAt,
      gateBlockedReason: waitlistEntries.gateBlockedReason,
    })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, entryId));
  if (row === undefined) throw new Error(`entryRow: no waitlist entry ${entryId}`);
  return row;
}

async function statusOf(entryId: string): Promise<string> {
  return (await entryRow(entryId)).status;
}

/** Every 'a spot opened up' notification currently enqueued. */
function selectOffers(): Promise<{ deepLinkId: string | null }[]> {
  return db
    .select({ deepLinkId: scheduledNotifications.deepLinkId })
    .from(scheduledNotifications)
    .where(like(scheduledNotifications.dedupeKey, 'waitlist-spot-open:%'));
}

async function offerCountFor(entryId: string): Promise<number> {
  return (await selectOffers()).filter((row) => row.deepLinkId === entryId).length;
}

function promote(
  target: WaitlistTarget,
  now: Date,
): Promise<{ seatsFree: number; offered: number }> {
  return withActor(OWNER_ACTOR, (tx) => promoteForTarget(tx, target, now));
}

function capacityOf(
  date: string,
  mode: 'school' | 'daycare',
): Promise<{
  openings: number;
  used: number;
  held: number;
  remaining: number;
}> {
  return withActor(OWNER_ACTOR, (tx) =>
    dayCapacityRepository.capacityForDay(tx, { location: LOCATION, date, mode }),
  );
}

function cancelApp(): FastifyInstance {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW, stripe: makeStripeStub() });
  return app;
}

function enrollApp(): FastifyInstance {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerEnrollmentsRoute(app, { authenticate, stripe: makeStripeStub(), now: FIXTURE_NOW });
  return app;
}

function postCancel(
  app: FastifyInstance,
  bookingId: string,
): ReturnType<FastifyInstance['inject']> {
  return app.inject({
    method: 'POST',
    url: `/bookings/${bookingId}/cancel`,
    headers: { 'idempotency-key': `wpf-cancel-${randomUUID()}` },
    payload: {},
  });
}

/**
 * Capture what the code under test writes to stderr while `fn` runs.
 *
 * `promoteFreedSeat`'s contract is that a failed promotion is LOUD and
 * non-propagating — the same channel `db/mutation.ts` uses for its post-commit
 * failures. Swallowing it silently would hide a queue that has stopped moving,
 * so "it was reported" is part of the behaviour and has to be observed.
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  // `write` is overloaded (string | Uint8Array, optional encoding, optional
  // callback) and a recording stub cannot spell every overload; the cast
  // re-attaches the original signature to a function that is call-compatible
  // with all of them and is restored in the `finally` below.
  process.stderr.write = ((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

// ── A. The wiring: a freed seat reaches the queue ───────────────────────────

test(
  'cancel — the seat a cancelled day-school booking frees is offered to the next family in line',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    // One opening, taken by the booking below: the day is genuinely full, which
    // is the only state `POST /waitlist` lets an owner queue for.
    await seedOpenings(CANCEL_DAY, { school: 1 });
    const bookingId = await seedDayBooking({
      category: 'day-school',
      sessionDate: CANCEL_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
    });
    const head = await seedDayEntry({
      sessionDate: CANCEL_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    // Pre-condition, so a failure below can only mean "nothing promoted it" and
    // never "the seat was never taken in the first place".
    assert.deepStrictEqual(await capacityOf(CANCEL_DAY, 'school'), {
      openings: 1,
      used: 1,
      held: 0,
      remaining: 0,
    });

    const res = await postCancel(cancelApp(), bookingId);
    assert.equal(res.statusCode, 200, res.body);

    // THE headline promise — Allison 2026-07-29: "if all spots are full people
    // should be allowed to enter a waitlist … and then you'd get a message
    // saying you were accepted."
    const offered = await entryRow(head);
    assert.equal(
      offered.status,
      'offered',
      'the cancel freed a seat and nothing rolled it to the queue',
    );
    assert.equal(await offerCountFor(head), 1, 'exactly one notification per offer');

    // The offer commits with the cancel, so the seat it promises is the seat
    // the cancel released — and it holds that seat against the booking path
    // instead of leaving it bookable by someone else.
    assert.deepStrictEqual(await capacityOf(CANCEL_DAY, 'school'), {
      openings: 1,
      used: 0,
      held: 1,
      remaining: 0,
    });

    const offeredAtMs = pgTimestampToDate(offered.offeredAt!).getTime();
    const expiresAtMs = pgTimestampToDate(offered.offerExpiresAt!).getTime();
    // The exact instants can't be pinned (the cancel path has no injectable
    // clock), but both invariants can: a real chance to answer, and never
    // outliving the session the seat is for.
    assert.ok(
      expiresAtMs - offeredAtMs >= MIN_OFFER_WINDOW_MINUTES * MINUTE_MS,
      'an offer shorter than the floor is not a chance to answer',
    );
    assert.ok(expiresAtMs <= sessionStartOf(CANCEL_DAY).getTime(), 'never outlives its session');
    await clearOwnState();
  },
);

test(
  'cancel — a gate-blocked head is flagged and skipped, and its gate failure never fails the cancel',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    await seedOpenings(CANCEL_GATE_DAY, { school: 1 });
    const bookingId = await seedDayBooking({
      category: 'day-school',
      sessionDate: CANCEL_GATE_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
    });
    const blockedHead = await seedDayEntry({
      sessionDate: CANCEL_GATE_DAY,
      leadDogId: BLOCKED_DOG_ID,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const eligible = await seedDayEntry({
      sessionDate: CANCEL_GATE_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const res = await postCancel(cancelApp(), bookingId);
    // The canceller and the head of the queue are different people. Uncaught,
    // Pepper's missing evaluation would reach Waffles' owner as a 422 about a
    // dog they don't own, and would take the cancellation down with it.
    assert.equal(
      res.statusCode,
      200,
      `a queue's gate failure must not fail the cancel: ${res.body}`,
    );

    const blocked = await entryRow(blockedHead);
    assert.equal(blocked.status, 'waiting', 'a gate failure is not a resolution');
    assert.equal(blocked.gateBlockedReason, 'evaluation_required');
    assert.notEqual(blocked.gateBlockedAt, null, 'staff need to know since when');
    assert.equal(await offerCountFor(blockedHead), 0, 'a flag is not an offer');

    assert.equal(
      await statusOf(eligible),
      'offered',
      'R6: the seat passes to the next ELIGIBLE entry on the same pass, not to a human',
    );
    assert.equal(await offerCountFor(eligible), 1);
    await clearOwnState();
  },
);

test(
  'cancel — a day-care cancel promotes the day-care queue, not day school on the same date',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    // Both modes open. Day school has a free seat the whole time and must stay
    // untouched: one cancelled day-care booking frees one day-care seat.
    await seedOpenings(CANCEL_MODE_DAY, { school: 1, daycare: 1 });
    const bookingId = await seedDayBooking({
      category: 'day-care',
      sessionDate: CANCEL_MODE_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
    });
    const daycareEntry = await seedDayEntry({
      category: 'day-care',
      sessionDate: CANCEL_MODE_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const schoolEntry = await seedDayEntry({
      category: 'day-school',
      sessionDate: CANCEL_MODE_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    const res = await postCancel(cancelApp(), bookingId);
    assert.equal(res.statusCode, 200, res.body);

    assert.equal(await statusOf(daycareEntry), 'offered');
    assert.equal(
      await statusOf(schoolEntry),
      'waiting',
      'day school and day care are separate shortages drawing on different openings',
    );
    assert.equal((await selectOffers()).length, 1);
    await clearOwnState();
  },
);

test(
  'withdraw — the cohort seat a withdrawal frees is offered to the queue head',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    const cohortId = await seedCohort({ classKey: 'puppy', capacity: 1, filled: 0 });
    const app = enrollApp();
    const enrolled = await app.inject({
      method: 'POST',
      url: '/enrollments',
      headers: { 'idempotency-key': `wpf-enroll-${randomUUID()}` },
      payload: {
        cohort_id: cohortId,
        dog_ids: [FIXTURE_IDS.dog1Id],
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        pay_later: true,
      },
    });
    assert.equal(enrolled.statusCode, 201, enrolled.body);

    // The class is now full — the only state that produces a queue.
    const head = await seedCohortEntry({
      cohortId,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/enrollments/${cohortId}/withdraw`,
      headers: { 'idempotency-key': `wpf-withdraw-${randomUUID()}` },
      payload: { dog_id: FIXTURE_IDS.dog1Id },
    });
    assert.equal(res.statusCode, 200, res.body);

    const [cohortAfter] = await db
      .select({ filled: cohorts.filled })
      .from(cohorts)
      .where(eq(cohorts.id, cohortId));
    assert.equal(cohortAfter?.filled, 0, 'the seat was released');
    const offered = await entryRow(head);
    assert.equal(offered.status, 'offered', 'and rolled to the queue in the same transaction');
    assert.equal(await offerCountFor(head), 1);
    assert.equal(
      pgTimestampToDate(offered.offeredAt!).getTime(),
      FIXTURE_NOW().getTime(),
      'the withdraw route has an injectable clock and promotion runs on that same one',
    );
    await clearOwnState();
  },
);

test(
  'promoteFreedSeat — a promotion that blows up is contained by its SAVEPOINT and reported, not swallowed',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();

    // A target the DATABASE rejects (`cohort_id` is a uuid column), so the
    // failure is an arbitrary non-`ApiError` blow-up mid-promotion — precisely
    // the case a bare try/catch could not survive, because inside a transaction
    // a failed statement poisons every statement after it.
    const brokenTarget: WaitlistTarget = { kind: 'group-class', cohortId: 'not-a-uuid' };
    let result: { seatsFree: number; offered: number } | undefined;

    const stderr = await captureStderr(async () => {
      await withActor(OWNER_ACTOR, async (tx) => {
        // A write the caller made BEFORE promotion — the cancel's own refund
        // row, in the real thing.
        await tx.insert(dayCapacity).values({
          location: LOCATION,
          date: BOUNDARY_DAY_BEFORE,
          schoolOpenings: 1,
          daycareOpenings: 0,
        });

        result = await promoteFreedSeat(tx, brokenTarget, NOW);

        // …and a write AFTER it. Behind a bare catch this INSERT would fail
        // with "current transaction is aborted".
        await tx.insert(dayCapacity).values({
          location: LOCATION,
          date: BOUNDARY_DAY_AFTER,
          schoolOpenings: 2,
          daycareOpenings: 0,
        });
      });
    });

    assert.deepStrictEqual(
      result,
      { seatsFree: 0, offered: 0 },
      'a failed promotion offers nobody and claims nothing is free',
    );
    const survived = await db
      .select({ date: dayCapacity.date })
      .from(dayCapacity)
      .where(and(eq(dayCapacity.location, LOCATION), inArray(dayCapacity.date, MANAGED_DAYS)));
    assert.deepStrictEqual(
      survived.map((r) => r.date).sort(),
      [BOUNDARY_DAY_AFTER, BOUNDARY_DAY_BEFORE].sort(),
      "both of the caller's writes committed — the waitlist never gets a veto over the mutation that fed it",
    );
    // Loud, not silent: a queue that has stopped moving must leave a trace.
    assert.match(stderr, /\[waitlistPromotion\]/);
    assert.match(stderr, /the seat is free but nobody was offered it/);
    await clearOwnState();
  },
);

// ── B. Rulings 6 + 7: the gates decide who is next ──────────────────────────

test(
  'R6 — a failing gate flags the entry and the seat falls through to the next eligible one, same pass',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    await seedOpenings(GATE_FALLTHROUGH_DAY, { school: 1 });
    const blockedHead = await seedDayEntry({
      sessionDate: GATE_FALLTHROUGH_DAY,
      leadDogId: BLOCKED_DOG_ID,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const eligible = await seedDayEntry({
      sessionDate: GATE_FALLTHROUGH_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const result = await promote(dayTarget('day-school', GATE_FALLTHROUGH_DAY), NOW);

    // ONE pass — not "flag it and wait for a human to look at the queue".
    // Allison 2026-07-31: the seat "passes immediately to the next ELIGIBLE
    // entry". A seat held for 24h by a family who would be refused at accept is
    // the failure this ruling exists to prevent.
    assert.deepStrictEqual(result, { seatsFree: 1, offered: 1 });
    const blocked = await entryRow(blockedHead);
    assert.equal(blocked.status, 'waiting');
    assert.equal(blocked.gateBlockedReason, 'evaluation_required');
    assert.equal(blocked.offeredAt, null, 'flagged, never offered');
    assert.equal(await statusOf(eligible), 'offered');
    assert.equal(await offerCountFor(blockedHead), 0);
    assert.equal(await offerCountFor(eligible), 1);
    await clearOwnState();
  },
);

test(
  'R7 — a gate-blocked entry sorts below a later joiner in the queue, the position and the owner list',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    const first = await seedDayEntry({
      sessionDate: QUEUE_ORDER_DAY,
      leadDogId: BLOCKED_DOG_ID,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const later = await seedDayEntry({
      sessionDate: QUEUE_ORDER_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const target = dayTarget('day-school', QUEUE_ORDER_DAY);
    const beforeBlock = await withActor(OWNER_ACTOR, (tx) =>
      waitlistRepository.findWaitingQueue(tx, target),
    );
    assert.deepStrictEqual(
      beforeBlock.map((e) => e.id),
      [first, later],
      'plain FIFO while nobody is blocked',
    );

    await withActor(OWNER_ACTOR, (tx) =>
      waitlistRepository.markGateBlocked(tx, {
        id: first,
        blockedAt: NOW,
        reason: 'vaccine_missing',
      }),
    );

    // "If there's someone who passes all gates, they get moved to the top."
    const afterBlock = await withActor(OWNER_ACTOR, (tx) =>
      waitlistRepository.findWaitingQueue(tx, target),
    );
    assert.deepStrictEqual(
      afterBlock.map((e) => e.id),
      [later, first],
    );

    // R3 — the owner sees their position. A blocked entry still showing its old
    // place would be telling that family they are next when they are not.
    assert.equal(await waitlistRepository.positionOf(db, later), 1);
    assert.equal(await waitlistRepository.positionOf(db, first), 2);
    const live = await waitlistRepository.findLiveForOwner(db, FIXTURE_IDS.ownerId);
    assert.deepStrictEqual(
      live.map((e) => e.id),
      [later, first],
    );
    await clearOwnState();
  },
);

test(
  'R7 — clearing the block restores the original place: the demotion lasts exactly as long as the problem',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    await seedOpenings(UNBLOCK_DAY, { school: 1 });
    const fixedUp = await seedDayEntry({
      sessionDate: UNBLOCK_DAY,
      leadDogId: BLOCKED_DOG_ID,
      createdAt: '2026-05-01T00:00:00Z',
    });

    // Pass 1: nobody else is waiting, so the seat simply stays free.
    const firstPass = await promote(dayTarget('day-school', UNBLOCK_DAY), NOW);
    assert.deepStrictEqual(firstPass, { seatsFree: 1, offered: 0 });
    assert.equal((await entryRow(fixedUp)).gateBlockedReason, 'evaluation_required');

    // A later family joins while the first is stuck…
    const laterJoiner = await seedDayEntry({
      sessionDate: UNBLOCK_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-05T00:00:00Z',
    });
    // …and then the first family fixes their problem. Nothing tells the system
    // that happened, which is exactly why promotion has to re-check the flagged
    // entries before it hands the next seat out.
    await passEveryGate(BLOCKED_DOG_ID);

    const secondPass = await promote(
      dayTarget('day-school', UNBLOCK_DAY),
      new Date(NOW.getTime() + HOUR_MS),
    );

    assert.deepStrictEqual(secondPass, { seatsFree: 1, offered: 1 });
    const restored = await entryRow(fixedUp);
    assert.equal(
      restored.status,
      'offered',
      'the un-demoted entry takes the next seat AHEAD of the family that joined after it',
    );
    assert.equal(restored.gateBlockedAt, null, 'both columns clear together (the DDL pairs them)');
    assert.equal(restored.gateBlockedReason, null);
    assert.equal(
      await statusOf(laterJoiner),
      'waiting',
      'without the re-check a fixed entry would sit behind every later joiner indefinitely',
    );
    await clearOwnState();
  },
);

test(
  'R6 — gate_blocked_at answers "blocked since when"; the reason is refreshed when the gate changes',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    await seedOpenings(BLOCKED_SINCE_DAY, { school: 1 });
    const stuck = await seedDayEntry({
      sessionDate: BLOCKED_SINCE_DAY,
      leadDogId: BLOCKED_DOG_ID,
      createdAt: '2026-05-01T00:00:00Z',
    });

    await promote(dayTarget('day-school', BLOCKED_SINCE_DAY), NOW);
    const firstFlag = await entryRow(stuck);
    assert.equal(firstFlag.gateBlockedReason, 'evaluation_required');
    const blockedSinceMs = pgTimestampToDate(firstFlag.gateBlockedAt!).getTime();
    assert.equal(blockedSinceMs, NOW.getTime());

    // The evaluation lands, but the dog still has no vaccines: a NEW problem.
    await db
      .update(dogs)
      .set({ evaluationStatus: 'passed', evaluationDate: '2026-05-10T15:00:00Z' })
      .where(eq(dogs.id, BLOCKED_DOG_ID));

    await promote(dayTarget('day-school', BLOCKED_SINCE_DAY), new Date(NOW.getTime() + 3 * DAY_MS));

    const secondFlag = await entryRow(stuck);
    assert.equal(
      pgTimestampToDate(secondFlag.gateBlockedAt!).getTime(),
      blockedSinceMs,
      'restamping would erase "this family has been stuck for three days", which is what makes a staff queue actionable',
    );
    assert.equal(
      secondFlag.gateBlockedReason,
      'vaccine_missing',
      'stale copy would send staff chasing a problem the owner already solved',
    );
    assert.equal(secondFlag.status, 'waiting');
    await clearOwnState();
  },
);

test(
  'R6 — the cohort class key reaches the gate re-check, so an exempt class is not blocked on a shot it never needed',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    // Shanthi 2026-07-14: puppy classes don't require the full vaccine set.
    await db.insert(requiredVaccines).values({
      key: GROUP_CLASS_REQUIREMENT_KEY,
      label: 'Group-class shot (fixture)',
      gatesCategories: ['group-class'],
      exemptClassKeys: ['puppy'],
    });

    const puppyCohort = await seedCohort({ classKey: 'puppy', capacity: 1, filled: 0 });
    const mannersCohort = await seedCohort({ classKey: 'manners-1', capacity: 1, filled: 0 });
    const puppyEntry = await seedCohortEntry({
      cohortId: puppyCohort,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const mannersEntry = await seedCohortEntry({
      cohortId: mannersCohort,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    // Neither dog has this shot; only the cohort's class key tells the two
    // cases apart. Drop it on the way into the gate re-check and every puppy
    // queue in the school is blocked on a requirement that class is exempt
    // from — nobody is ever offered a seat, and staff get a worklist of
    // families with nothing wrong with them.
    assert.deepStrictEqual(await promote({ kind: 'group-class', cohortId: puppyCohort }, NOW), {
      seatsFree: 1,
      offered: 1,
    });
    const puppy = await entryRow(puppyEntry);
    assert.equal(puppy.status, 'offered');
    assert.equal(puppy.gateBlockedAt, null);

    assert.deepStrictEqual(await promote({ kind: 'group-class', cohortId: mannersCohort }, NOW), {
      seatsFree: 1,
      offered: 0,
    });
    const manners = await entryRow(mannersEntry);
    assert.equal(manners.status, 'waiting');
    assert.equal(
      manners.gateBlockedReason,
      'vaccine_missing',
      'a class the exemption does not cover still blocks — the key is read, not ignored',
    );
    await clearOwnState();
  },
);

// ── C. The seat arithmetic promotion and the booking path share ─────────────

test(
  'held seats — promotion and the day-capacity count agree on which dogs are holding one',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    await seedOpenings(HELD_POPULATION_DAY, { school: 2 });
    // The gate re-check runs over every dog on the entry and does NOT exempt
    // staff dogs (it relies on the owner scoping its callers apply), so give
    // the staff dog its shots — the subject here is the seat COUNT, not the
    // gates, and a gate failure would mask it.
    await passEveryGate(STAFF_DOG_ID);
    const holder = await seedDayEntry({
      sessionDate: HELD_POPULATION_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      // A staff-owned dog on the entry. `dogs.capacity_exempt` keeps it out of
      // the day's `used` and `held`; counting it on the promotion side and not
      // the capacity side makes `capacitySeats − held` a subtraction across two
      // different populations, and the mismatch silently eats a real seat.
      // No owner-facing route can produce this row today (`POST /waitlist`
      // narrows to the principal's own dogs) — the invariant is that the two
      // counters cannot disagree, whatever produces the row.
      extraDogIds: [STAFF_DOG_ID],
      createdAt: '2026-05-01T00:00:00Z',
    });
    const behind = await seedDayEntry({
      sessionDate: HELD_POPULATION_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const target = dayTarget('day-school', HELD_POPULATION_DAY);
    // The head is a two-dog entry, so it spends both seats on the first pass.
    assert.deepStrictEqual(await promote(target, NOW), { seatsFree: 2, offered: 1 });
    assert.equal(await statusOf(holder), 'offered');
    assert.equal(await statusOf(behind), 'waiting');

    const held = await withActor(OWNER_ACTOR, (tx) =>
      waitlistRepository.countOfferedSeats(tx, target),
    );
    const picture = await capacityOf(HELD_POPULATION_DAY, 'school');
    assert.equal(
      held,
      picture.held,
      'promotion and the booking path must count the same dogs, or one of them spends seats the other never gave it',
    );
    assert.equal(held, 1, 'one owner dog on offer; the staff dog is capacity-exempt on both sides');

    // And the consequence: the seat the staff dog does NOT occupy is still
    // there to be offered to the family behind.
    assert.deepStrictEqual(await promote(target, new Date(NOW.getTime() + HOUR_MS)), {
      seatsFree: 1,
      offered: 1,
    });
    assert.equal(await statusOf(behind), 'offered');
    await clearOwnState();
  },
);

test(
  'held seats — an outstanding offer is subtracted from the free-seat count exactly once',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    await seedOpenings(HELD_ONCE_DAY, { school: 2 });
    const first = await seedDayEntry({
      sessionDate: HELD_ONCE_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    assert.deepStrictEqual(await promote(dayTarget('day-school', HELD_ONCE_DAY), NOW), {
      seatsFree: 2,
      offered: 1,
    });
    assert.equal(await statusOf(first), 'offered');

    // Second seat, second family. Two openings minus one held seat is ONE free
    // seat — net the hold out twice (once inside `capacityForDay.remaining`,
    // once again in promotion) and this family is never offered the seat that
    // is sitting there empty.
    const second = await seedDayEntry({
      sessionDate: HELD_ONCE_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });
    const secondPass = await promote(
      dayTarget('day-school', HELD_ONCE_DAY),
      new Date(NOW.getTime() + HOUR_MS),
    );

    assert.deepStrictEqual(secondPass, { seatsFree: 1, offered: 1 });
    assert.equal(await statusOf(second), 'offered');
    assert.equal(await statusOf(first), 'offered', 'and the first offer is untouched');
    await clearOwnState();
  },
);

// ── D. An offer has to be a real chance ─────────────────────────────────────

test(
  'offer window — too close to drop-off, the seat stays free and unoffered rather than expiring unheard',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWorld();
    await seedOpenings(OFFER_FLOOR_DAY, { school: 1 });
    const entry = await seedDayEntry({
      sessionDate: OFFER_FLOOR_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const target = dayTarget('day-school', OFFER_FLOOR_DAY);
    const sessionStart = sessionStartOf(OFFER_FLOOR_DAY);

    // 10 minutes before drop-off. The push is not sent inline — it is enqueued
    // and delivered by the NEXT scheduler tick — so an offer this short expires
    // before the owner is ever told they had it, and burns the seat for
    // everyone behind them.
    assert.deepStrictEqual(
      await promote(target, new Date(sessionStart.getTime() - 10 * MINUTE_MS)),
      { seatsFree: 1, offered: 0 },
      'honest: the seat IS free — it is the OFFER that is not worth making',
    );
    assert.equal(await statusOf(entry), 'waiting');
    assert.equal((await selectOffers()).length, 0, 'nobody is told about a seat they cannot claim');

    // 20 minutes out clears the floor, and the deadline still cannot outlive
    // the session.
    assert.deepStrictEqual(
      await promote(target, new Date(sessionStart.getTime() - 20 * MINUTE_MS)),
      { seatsFree: 1, offered: 1 },
    );
    const offered = await entryRow(entry);
    assert.equal(offered.status, 'offered');
    assert.equal(pgTimestampToDate(offered.offerExpiresAt!).getTime(), sessionStart.getTime());
    assert.equal(await offerCountFor(entry), 1);
    await clearOwnState();
  },
);
