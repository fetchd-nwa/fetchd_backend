import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dayCapacityRepository } from '../../src/db/repositories/dayCapacityRepository.js';
import { waitlistRepository } from '../../src/db/repositories/waitlistRepository.js';
import {
  bookings,
  charges,
  cohorts,
  creditLedger,
  dayCapacity,
  dogs,
  invoices,
  scheduledNotifications,
  waitlistEntries,
  waitlistEntryDogs,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { pgTimestampToDate } from '../../src/lib/pgTimestamp.js';
import { shouldSkipPush } from '../../src/lib/pushPreferences.js';
import {
  OFFER_WINDOW_HOURS,
  cancelEntriesForStartedSessions,
  promoteForTarget,
  sweepLapsedOffers,
} from '../../src/lib/waitlistPromotion.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { makeStripeStub } from './_stripeStub.js';
import type { WaitlistTarget } from '../../src/db/repositories/waitlistRepository.js';

/**
 * Waitlist promotion + the lapsed-offer sweep (Allison 2026-07-29/30).
 *
 * The rulings this file is the net for (2 — the staff cap override — belongs to
 * `routes/staffWaitlist.ts` and is covered there):
 *
 *   1. No money at join, and none at promotion either — a freed seat produces
 *      an OFFER. Nothing may be charged and nothing booked until ACCEPT.
 *   3. The queue is FIFO and the owner can see where they are, so a promotion
 *      that jumps the line is a broken promise, not a cosmetic bug.
 *   4. The entry dies when the session starts.
 *   5. The gates run at join and again at accept — deliberately NOT here.
 *
 * The failure modes that actually cost money or trust, and the tests for them:
 *
 *   - **One seat promised twice.** Two owners told "it's yours", one of them
 *     lied to at accept. Guarded by `countOfferedSeats` (an offered entry holds
 *     its seats) AND by the per-queue advisory lock (two concurrent ticks can't
 *     each spend the same seat). Both halves are tested, the second with two
 *     genuinely concurrent transactions.
 *   - **A seat sitting empty behind a head that doesn't fit.** A two-dog entry
 *     can't take one seat; strict FIFO would stall the whole queue on it.
 *   - **Promoting into a day that can't seat anyone.** `openings === 0` is
 *     CLOSED, not full; a started session is gone; a booked-out day is full.
 *   - **A queue deadlocked on an owner who never answers.** The sweep is the
 *     only thing that unsticks it, so its boundary (exactly on the deadline)
 *     and its refusal to double-resolve an answered offer both matter.
 *
 * Entries are inserted directly rather than through `POST /waitlist` so each
 * test pins `created_at` and drives FIFO order explicitly; the promotion module
 * is what's under test, not the join gates.
 *
 * ONE TEST IN HERE FAILS ON PURPOSE — the last one, "a seat freed by a
 * cancellation is offered to the next family in line". Every promotion rule
 * below is correct in isolation, but nothing in the running system calls
 * `promoteForTarget` when a seat frees, so no owner is ever organically
 * offered one. Its assertion message carries the detail. Delete it only when
 * the wiring lands, never to get the suite green.
 */

// Registered BEFORE `registerFixtureHooks` so it runs ahead of
// `teardownFixture` (node:test runs `after` hooks in registration order): this
// file's rows go before the fixture owner they hang off. Gated on the harness's
// own DB signal — with no database there is nothing to clear.
if (SKIP_WHEN_NO_DB.skip === false) after(clearWaitlistState);
registerFixtureHooks();

/** Same actor string the scheduler stamps, so the audit trail reads true. */
const SCHEDULER_ACTOR = 'system:scheduler';
/** `<kind>:<id>`, the shape `actorOf(principal)` produces for an owner. */
const OWNER_ACTOR = `owner:${FIXTURE_IDS.ownerId}`;

const ONE_HOUR_MS = 60 * 60 * 1000;
const OFFER_WINDOW_MS = OFFER_WINDOW_HOURS * ONE_HOUR_MS;

/** 10:00 CDT on the fixture's "today". Every date below is anchored to it. */
const NOW = new Date('2026-05-19T15:00:00Z');

/** Wednesday, eight days out, no fixture bookings — a blank capacity canvas. */
const OPEN_DAY = '2026-05-27';
/**
 * Wednesday, and the day fixture `booking1` puts Waffles in day school: the one
 * day here where `used` is non-zero for real. Its 07:30 CDT start is 21.5h
 * after NOW — inside the 24h offer window — so it is also where the deadline
 * clamp bites.
 */
const BOOKED_DAY = '2026-05-20';
const BOOKED_DAY_SESSION_START = new Date('2026-05-20T12:30:00Z');
/** Saturday, deliberately without an override → default rule → 0/0 → CLOSED. */
const WEEKEND_DAY = '2026-05-23';
/** NOW is 10:00 CDT on this date; drop-off opened at 07:30. Already running. */
const STARTED_DAY = '2026-05-19';
/** Wednesday after fall-back, so 07:30 America/Chicago is CST (UTC-6). */
const CST_DAY = '2026-11-04';
const CST_SESSION_START = new Date('2026-11-04T13:30:00Z');
const OPEN_DAY_SESSION_START = new Date('2026-05-27T12:30:00Z');

const MANAGED_DAYS = [OPEN_DAY, BOOKED_DAY, WEEKEND_DAY, STARTED_DAY, CST_DAY];

/**
 * Two more dogs for the fixture owner. The best-fit tests need a multi-dog
 * entry AND a separate one-dog entry behind it: reusing Waffles or Lola across
 * both would put one dog in two live places in the same queue, which
 * `POST /waitlist` refuses — a state the promotion code would never meet in
 * production is not worth asserting against.
 */
const EXTRA_DOG_IDS = {
  biscuit: '33333333-3333-4333-8333-333333333333',
  nacho: '33333333-3333-4333-8333-333333333334',
} as const;

const OWNER_DOG_IDS = [
  FIXTURE_IDS.dog1Id,
  FIXTURE_IDS.dog2Id,
  EXTRA_DOG_IDS.biscuit,
  EXTRA_DOG_IDS.nacho,
];

/** Cohorts this file creates; dropped by id so the fixture's two are untouched. */
const seededCohortIds: string[] = [];

function dayTarget(category: 'day-school' | 'day-care', sessionDate: string): WaitlistTarget {
  return {
    kind: 'day-program',
    category,
    sessionDate,
    location: 'fayetteville',
    mode: category === 'day-school' ? 'school' : 'daycare',
  };
}

function cohortTarget(cohortId: string): WaitlistTarget {
  return { kind: 'group-class', cohortId };
}

async function clearWaitlistState(): Promise<void> {
  // Offer notifications carry `dog_id`, so they must go before the dogs do.
  await db
    .delete(scheduledNotifications)
    .where(like(scheduledNotifications.dedupeKey, 'waitlist-spot-open:%'));
  await db.delete(waitlistEntries).where(eq(waitlistEntries.ownerId, FIXTURE_IDS.ownerId));
  if (seededCohortIds.length > 0) {
    await db.delete(cohorts).where(inArray(cohorts.id, seededCohortIds));
    seededCohortIds.length = 0;
  }
  await db
    .delete(dayCapacity)
    .where(and(eq(dayCapacity.location, 'fayetteville'), inArray(dayCapacity.date, MANAGED_DAYS)));
  await db.delete(dogs).where(inArray(dogs.id, [EXTRA_DOG_IDS.biscuit, EXTRA_DOG_IDS.nacho]));
}

/** A clean queue world: nothing left over, the two extra dogs back in place. */
async function resetQueues(): Promise<void> {
  await clearWaitlistState();
  await db.insert(dogs).values([
    {
      id: EXTRA_DOG_IDS.biscuit,
      ownerId: FIXTURE_IDS.ownerId,
      name: 'Biscuit',
      breed: 'Beagle',
      ageMonthsOverride: 30,
    },
    {
      id: EXTRA_DOG_IDS.nacho,
      ownerId: FIXTURE_IDS.ownerId,
      name: 'Nacho',
      breed: 'Corgi',
      ageMonthsOverride: 42,
    },
  ]);
}

async function seedOpenings(
  date: string,
  openings: { school?: number; daycare?: number },
): Promise<void> {
  await db.insert(dayCapacity).values({
    location: 'fayetteville',
    date,
    schoolOpenings: openings.school ?? 0,
    daycareOpenings: openings.daycare ?? 0,
  });
}

async function setOpenings(
  date: string,
  openings: { school?: number; daycare?: number },
): Promise<void> {
  await db
    .update(dayCapacity)
    .set({
      schoolOpenings: openings.school ?? 0,
      daycareOpenings: openings.daycare ?? 0,
    })
    .where(and(eq(dayCapacity.location, 'fayetteville'), eq(dayCapacity.date, date)));
}

async function seedCohort(args: {
  capacity: number;
  filled: number;
  startDate: string;
  expiredAt?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(cohorts).values({
    id,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate: args.startDate,
    weeklyTime: '10:00 AM',
    weeks: 4,
    capacity: args.capacity,
    filled: args.filled,
    ...(args.expiredAt !== undefined ? { expiredAt: args.expiredAt } : {}),
  });
  seededCohortIds.push(id);
  return id;
}

async function attachDogs(entryId: string, leadDogId: string, dogIds: string[]): Promise<void> {
  await db.insert(waitlistEntryDogs).values(
    dogIds.map((dogId) => ({
      waitlistEntryId: entryId,
      dogId,
      isLead: dogId === leadDogId,
    })),
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
      location: 'fayetteville',
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
  extraDogIds?: readonly string[];
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
  await attachDogs(row.id, args.leadDogId, [args.leadDogId, ...(args.extraDogIds ?? [])]);
  return row.id;
}

interface EntrySnapshot {
  status: string;
  offeredAt: string | null;
  offerExpiresAt: string | null;
  resolvedAt: string | null;
  bookingId: string | null;
  offeredByStaffId: string | null;
}

async function entryRow(entryId: string): Promise<EntrySnapshot> {
  const [row] = await db
    .select({
      status: waitlistEntries.status,
      offeredAt: waitlistEntries.offeredAt,
      offerExpiresAt: waitlistEntries.offerExpiresAt,
      resolvedAt: waitlistEntries.resolvedAt,
      bookingId: waitlistEntries.bookingId,
      offeredByStaffId: waitlistEntries.offeredByStaffId,
    })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, entryId));
  if (row === undefined) throw new Error(`entryRow: no waitlist entry ${entryId}`);
  return row;
}

async function statusOf(entryId: string): Promise<string> {
  return (await entryRow(entryId)).status;
}

interface OfferNotification {
  type: string;
  title: string;
  body: string;
  status: string;
  scheduledFor: string;
  deepLinkPath: string | null;
  deepLinkKind: string | null;
  deepLinkId: string | null;
  dogId: string | null;
  dedupeKey: string | null;
}

function selectOffers(): Promise<OfferNotification[]> {
  return db
    .select({
      type: scheduledNotifications.type,
      title: scheduledNotifications.title,
      body: scheduledNotifications.body,
      status: scheduledNotifications.status,
      scheduledFor: scheduledNotifications.scheduledFor,
      deepLinkPath: scheduledNotifications.deepLinkPath,
      deepLinkKind: scheduledNotifications.deepLinkKind,
      deepLinkId: scheduledNotifications.deepLinkId,
      dogId: scheduledNotifications.dogId,
      dedupeKey: scheduledNotifications.dedupeKey,
    })
    .from(scheduledNotifications)
    .where(like(scheduledNotifications.dedupeKey, 'waitlist-spot-open:%'));
}

async function offersFor(entryId: string): Promise<OfferNotification[]> {
  const rows = await selectOffers();
  return rows.filter((row) => row.deepLinkId === entryId);
}

function promote(
  target: WaitlistTarget,
  now: Date,
  opts: { offerWindowMs?: number } = {},
): Promise<{ seatsFree: number; offered: number }> {
  return withActor(SCHEDULER_ACTOR, (tx) => promoteForTarget(tx, target, now, opts));
}

function sweep(
  now: Date,
  opts: { offerWindowMs?: number } = {},
): Promise<{ lapsed: number; expired: number; promoted: number }> {
  return withActor(SCHEDULER_ACTOR, (tx) => sweepLapsedOffers(tx, now, opts));
}

function expireSessions(now: Date): Promise<{ scanned: number; cancelled: number }> {
  return withActor(SCHEDULER_ACTOR, (tx) => cancelEntriesForStartedSessions(tx, now));
}

// ── Seat accounting ─────────────────────────────────────────────────────────

test(
  'promotion — the head of the queue takes the free seat and only that owner is told',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1 });
    const head = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const behind = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const result = await promote(dayTarget('day-school', OPEN_DAY), NOW);

    assert.deepStrictEqual(result, { seatsFree: 1, offered: 1 });
    const offered = await entryRow(head);
    assert.equal(offered.status, 'offered');
    assert.equal(pgTimestampToDate(offered.offeredAt!).getTime(), NOW.getTime());
    assert.equal(
      pgTimestampToDate(offered.offerExpiresAt!).getTime(),
      NOW.getTime() + OFFER_WINDOW_MS,
      'the default 24h window applies when the session is further out than that',
    );
    assert.equal(
      offered.offeredByStaffId,
      null,
      'an organically freed seat is not a staff cap override (ruling 2 is a different lane)',
    );
    assert.equal(await statusOf(behind), 'waiting', 'FIFO — second in line stays second');

    const offers = await offersFor(head);
    assert.equal(offers.length, 1, 'exactly one notification per offer');
    assert.equal(offers[0]?.type, 'waitlist-spot-open');
    assert.equal(offers[0]?.status, 'pending', 'the scheduler delivers it on the next pass');
    assert.equal(offers[0]?.title, 'A spot opened up');
    assert.match(offers[0]!.body, /day school on May 27/);
    assert.match(offers[0]!.body, /Accept by/, 'the deadline is what makes the queue keep moving');
    assert.equal(offers[0]?.deepLinkPath, `/waitlist/${head}`);
    assert.equal(offers[0]?.deepLinkKind, 'waitlist');
    assert.equal(offers[0]?.deepLinkId, head);
    assert.equal(offers[0]?.dogId, FIXTURE_IDS.dog1Id);
    // Keyed on the OFFER (entry + the instant it was made), not the entry.
    assert.equal(offers[0]?.dedupeKey, `waitlist-spot-open:${head}:${NOW.toISOString()}`);
    assert.equal(pgTimestampToDate(offers[0]!.scheduledFor).getTime(), NOW.getTime());

    assert.equal(
      (await offersFor(behind)).length,
      0,
      'nobody but the offeree is told a seat is theirs',
    );
    await clearWaitlistState();
  },
);

test(
  'promotion — an outstanding offer holds its seat: the next pass promises nobody',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1 });
    const head = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const behind = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const first = await promote(dayTarget('day-school', OPEN_DAY), NOW);
    const second = await promote(dayTarget('day-school', OPEN_DAY), new Date(NOW.getTime() + 1000));

    assert.deepStrictEqual(first, { seatsFree: 1, offered: 1 });
    // The seat is spoken for until the offer is answered or lapses. Offering it
    // again is the double-promise the whole feature has to avoid.
    assert.deepStrictEqual(second, { seatsFree: 0, offered: 0 });
    assert.equal(await statusOf(head), 'offered');
    assert.equal(await statusOf(behind), 'waiting');
    assert.equal((await selectOffers()).length, 1, 'one seat produced exactly one notification');
    await clearWaitlistState();
  },
);

test(
  'promotion — two concurrent passes never promise the same seat twice',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1 });
    const head = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const behind = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    // Two scheduler ticks overlapping — the documented-safe concurrency the
    // per-queue advisory lock exists for. Without it both transactions read
    // "one seat free, nothing offered" and each offers it to a DIFFERENT entry,
    // which `markOffered`'s status guard cannot catch (both UPDATEs succeed).
    const target = dayTarget('day-school', OPEN_DAY);
    const [passA, passB] = await Promise.all([
      promote(target, NOW),
      promote(target, new Date(NOW.getTime() + 1000)),
    ]);

    assert.equal(passA.offered + passB.offered, 1, 'one free seat, one offer, across both passes');
    assert.equal(await statusOf(head), 'offered', 'the seat went to the front of the line');
    assert.equal(await statusOf(behind), 'waiting');
    assert.equal((await selectOffers()).length, 1, 'and exactly one owner was told');
    await clearWaitlistState();
  },
);

test(
  'promotion — a head that needs more seats than are free is skipped, not left blocking the queue',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1 });
    const twoDogHead = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      extraDogIds: [EXTRA_DOG_IDS.biscuit],
      createdAt: '2026-05-01T00:00:00Z',
    });
    const oneDogBehind = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const result = await promote(dayTarget('day-school', OPEN_DAY), NOW);

    assert.deepStrictEqual(result, { seatsFree: 1, offered: 1 });
    // Strict FIFO would leave the seat empty waiting for an entry that can
    // never shrink. The head keeps its place — it was skipped, not resolved.
    assert.equal(await statusOf(twoDogHead), 'waiting');
    assert.equal(await statusOf(oneDogBehind), 'offered');
    assert.equal((await offersFor(twoDogHead)).length, 0, 'a skip is not an offer');
    await clearWaitlistState();
  },
);

test(
  'promotion — two free seats go to the two-dog head, and the entry behind gets nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 2 });
    const twoDogHead = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      extraDogIds: [EXTRA_DOG_IDS.biscuit],
      createdAt: '2026-05-01T00:00:00Z',
    });
    const oneDogBehind = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const result = await promote(dayTarget('day-school', OPEN_DAY), NOW);

    // Both seats go to one entry: a multi-dog entry spends one seat per dog, so
    // the skip rule must not turn into "everyone gets an offer".
    assert.deepStrictEqual(result, { seatsFree: 2, offered: 1 });
    assert.equal(await statusOf(twoDogHead), 'offered');
    assert.equal(await statusOf(oneDogBehind), 'waiting');
    await clearWaitlistState();
  },
);

test(
  'promotion — a day whose openings are all booked promotes nobody until the cap rises',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    // Fixture `booking1` already puts Waffles in day school at fayetteville on
    // BOOKED_DAY, so `used` is 1 for real rather than by construction.
    await seedOpenings(BOOKED_DAY, { school: 1 });
    const entry = await seedDayEntry({
      sessionDate: BOOKED_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    const full = await promote(dayTarget('day-school', BOOKED_DAY), NOW);
    assert.deepStrictEqual(full, { seatsFree: 0, offered: 0 }, 'the one seat is already booked');
    assert.equal(await statusOf(entry), 'waiting');

    // Staff raise the cap (ruling 2's other half). The same pass now finds the
    // seat — proving promotion counts live bookings, not just waitlist rows.
    await setOpenings(BOOKED_DAY, { school: 2 });
    const raised = await promote(dayTarget('day-school', BOOKED_DAY), NOW);
    assert.deepStrictEqual(raised, { seatsFree: 1, offered: 1 });
    assert.equal(await statusOf(entry), 'offered');
    await clearWaitlistState();
  },
);

test(
  'promotion — openings === 0 is CLOSED, not full: neither a weekend nor an explicit 0 promotes anyone',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    // No override on a Saturday → the default rule's 0/0.
    const weekendEntry = await seedDayEntry({
      sessionDate: WEEKEND_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    // Staff explicitly closed a weekday.
    await seedOpenings(OPEN_DAY, { school: 0 });
    const closedWeekdayEntry = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    // A closed day can never free a seat, so an offer would be a promise the
    // school cannot keep — distinct from a full day, which one cancellation fixes.
    assert.deepStrictEqual(await promote(dayTarget('day-school', WEEKEND_DAY), NOW), {
      seatsFree: 0,
      offered: 0,
    });
    assert.deepStrictEqual(await promote(dayTarget('day-school', OPEN_DAY), NOW), {
      seatsFree: 0,
      offered: 0,
    });
    assert.equal(await statusOf(weekendEntry), 'waiting');
    assert.equal(await statusOf(closedWeekdayEntry), 'waiting');
    assert.equal((await selectOffers()).length, 0);
    await clearWaitlistState();
  },
);

test(
  'promotion — a session that has already started is never promoted into',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    // Seats to spare; the only thing wrong is that drop-off opened at 07:30 CDT
    // and NOW is 10:00 CDT the same day.
    await seedOpenings(STARTED_DAY, { school: 3 });
    const entry = await seedDayEntry({
      sessionDate: STARTED_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    const result = await promote(dayTarget('day-school', STARTED_DAY), NOW);

    assert.deepStrictEqual(result, { seatsFree: 0, offered: 0 });
    // Promotion refuses; killing the entry is the session-expiry phase's job.
    assert.equal(await statusOf(entry), 'waiting');
    await clearWaitlistState();
  },
);

test(
  'promotion — the offer deadline is clamped to the session start, never past it',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(BOOKED_DAY, { school: 3 });
    const entry = await seedDayEntry({
      sessionDate: BOOKED_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    await promote(dayTarget('day-school', BOOKED_DAY), NOW);

    const offered = await entryRow(entry);
    assert.equal(offered.status, 'offered');
    // An offer that outlives its session can never be accepted, and would hold
    // the seat right through drop-off instead of rolling to someone who could
    // still use it. 07:30 CDT on BOOKED_DAY is 21.5h out — inside the window.
    assert.ok(NOW.getTime() + OFFER_WINDOW_MS > BOOKED_DAY_SESSION_START.getTime());
    assert.equal(
      pgTimestampToDate(offered.offerExpiresAt!).getTime(),
      BOOKED_DAY_SESSION_START.getTime(),
    );
    await clearWaitlistState();
  },
);

test(
  'promotion — day-school and day-care on the same day are separate queues with separate seats',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1, daycare: 1 });
    const schoolEntry = await seedDayEntry({
      category: 'day-school',
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const daycareEntry = await seedDayEntry({
      category: 'day-care',
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    const school = await promote(dayTarget('day-school', OPEN_DAY), NOW);
    assert.deepStrictEqual(school, { seatsFree: 1, offered: 1 });
    assert.equal(await statusOf(schoolEntry), 'offered');
    assert.equal(
      await statusOf(daycareEntry),
      'waiting',
      'the day-care queue is a different shortage',
    );

    // The school offer must not have eaten the day-care seat: the two draw on
    // different `day_capacity` columns and different credit axes.
    const daycare = await promote(dayTarget('day-care', OPEN_DAY), NOW);
    assert.deepStrictEqual(daycare, { seatsFree: 1, offered: 1 });
    assert.equal(await statusOf(daycareEntry), 'offered');
    await clearWaitlistState();
  },
);

// ── Ruling 1: money moves at accept, nowhere else ───────────────────────────

/** Every place a charge, a credit debit or a booking could leak out of promotion. */
async function moneyAndBookingCounts(): Promise<{
  invoices: number;
  charges: number;
  creditLedger: number;
  bookings: number;
}> {
  const [invoiceRows, chargeRows, ledgerRows, bookingRows] = await Promise.all([
    db.select({ id: invoices.id }).from(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId)),
    db.select({ id: charges.id }).from(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId)),
    db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(inArray(creditLedger.dogId, OWNER_DOG_IDS)),
    db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ownerId, FIXTURE_IDS.ownerId)),
  ]);
  return {
    invoices: invoiceRows.length,
    charges: chargeRows.length,
    creditLedger: ledgerRows.length,
    bookings: bookingRows.length,
  };
}

test(
  'promotion — nothing is charged and nothing is booked when a seat is offered',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1 });
    const entry = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const before = await moneyAndBookingCounts();

    await promote(dayTarget('day-school', OPEN_DAY), NOW);

    assert.equal(await statusOf(entry), 'offered');
    // Allison ruling 1: an opened seat is an OFFER. Every one of these moves
    // only on accept, through the ordinary booking transaction.
    assert.deepStrictEqual(await moneyAndBookingCounts(), before);
    const offered = await entryRow(entry);
    assert.equal(offered.bookingId, null, 'no booking exists to point at yet');
    assert.equal(offered.resolvedAt, null, 'an offer is not a resolution');
    const offers = await offersFor(entry);
    assert.equal(
      offers[0]?.deepLinkKind,
      'waitlist',
      'the owner is sent to the offer, not to a booking that was never created',
    );
    await clearWaitlistState();
  },
);

// ── Group classes ───────────────────────────────────────────────────────────

test(
  'promotion — group class: capacity − filled is the seat count, with the same best-fit skip',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    const cohortId = await seedCohort({
      capacity: 3,
      filled: 2,
      startDate: '2026-06-10T15:00:00Z',
    });
    const twoDogHead = await seedCohortEntry({
      cohortId,
      leadDogId: FIXTURE_IDS.dog1Id,
      extraDogIds: [EXTRA_DOG_IDS.biscuit],
      createdAt: '2026-05-01T00:00:00Z',
    });
    const oneDogBehind = await seedCohortEntry({
      cohortId,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });

    const result = await promote(cohortTarget(cohortId), NOW);

    assert.deepStrictEqual(result, { seatsFree: 1, offered: 1 });
    assert.equal(await statusOf(twoDogHead), 'waiting');
    assert.equal(await statusOf(oneDogBehind), 'offered');
    const offers = await offersFor(oneDogBehind);
    assert.equal(offers.length, 1);
    assert.match(offers[0]!.body, /the class you were waiting for/);
    await clearWaitlistState();
  },
);

test(
  'promotion — a full, a soft-expired and an already-started cohort all promote nobody',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    const fullCohort = await seedCohort({
      capacity: 3,
      filled: 3,
      startDate: '2026-06-10T15:00:00Z',
    });
    const expiredCohort = await seedCohort({
      capacity: 3,
      filled: 0,
      startDate: '2026-06-10T15:00:00Z',
      expiredAt: '2026-05-01T00:00:00Z',
    });
    const startedCohort = await seedCohort({
      capacity: 3,
      filled: 0,
      startDate: '2026-05-18T15:00:00Z',
    });
    const entries = await Promise.all([
      seedCohortEntry({
        cohortId: fullCohort,
        leadDogId: FIXTURE_IDS.dog1Id,
        createdAt: '2026-05-01T00:00:00Z',
      }),
      seedCohortEntry({
        cohortId: expiredCohort,
        leadDogId: FIXTURE_IDS.dog1Id,
        createdAt: '2026-05-01T00:00:00Z',
      }),
      seedCohortEntry({
        cohortId: startedCohort,
        leadDogId: FIXTURE_IDS.dog1Id,
        createdAt: '2026-05-01T00:00:00Z',
      }),
    ]);

    for (const cohortId of [fullCohort, expiredCohort, startedCohort]) {
      assert.deepStrictEqual(
        await promote(cohortTarget(cohortId), NOW),
        { seatsFree: 0, offered: 0 },
        `cohort ${cohortId} must promote nobody`,
      );
    }
    for (const entryId of entries) {
      assert.equal(await statusOf(entryId), 'waiting');
    }
    assert.equal((await selectOffers()).length, 0);
    await clearWaitlistState();
  },
);

// ── The lapsed-offer sweep ──────────────────────────────────────────────────

test(
  'sweep — a lapsed offer expires and the seat rolls to the next in line in the same pass',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1 });
    const head = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const behind = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });
    await promote(dayTarget('day-school', OPEN_DAY), NOW, { offerWindowMs: ONE_HOUR_MS });
    assert.equal(await statusOf(head), 'offered');

    // One owner who never opens the app would otherwise stall the queue
    // forever: the seat is neither used nor offered to anyone else.
    const afterDeadline = new Date(NOW.getTime() + 2 * ONE_HOUR_MS);
    const result = await sweep(afterDeadline);

    assert.deepStrictEqual(result, { lapsed: 1, expired: 1, promoted: 1 });
    assert.equal(await statusOf(head), 'expired');
    const rolled = await entryRow(behind);
    assert.equal(rolled.status, 'offered');
    assert.equal(pgTimestampToDate(rolled.offeredAt!).getTime(), afterDeadline.getTime());
    const offers = await offersFor(behind);
    assert.equal(offers.length, 1, 'the new offeree is told');
    assert.equal(
      offers[0]?.dedupeKey,
      `waitlist-spot-open:${behind}:${afterDeadline.toISOString()}`,
    );
    assert.equal((await offersFor(head)).length, 1, 'the lapsed offer keeps its original notice');
    await clearWaitlistState();
  },
);

test(
  'sweep — an offer lapses on its deadline, not a millisecond before',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1 });
    const head = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    await promote(dayTarget('day-school', OPEN_DAY), NOW, { offerWindowMs: ONE_HOUR_MS });
    const deadline = new Date(NOW.getTime() + ONE_HOUR_MS);

    // Sweeping an offer that still has time on the clock would take a seat away
    // from an owner who is within their deadline.
    const early = await sweep(new Date(deadline.getTime() - 1));
    assert.deepStrictEqual(early, { lapsed: 0, expired: 0, promoted: 0 });
    assert.equal(await statusOf(head), 'offered');

    const onTime = await sweep(deadline);
    assert.equal(onTime.lapsed, 1);
    assert.equal(onTime.expired, 1);
    assert.equal(await statusOf(head), 'expired');
    await clearWaitlistState();
  },
);

test(
  'sweep — a seat taken while the offer sat is not handed out again',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    const cohortId = await seedCohort({
      capacity: 3,
      filled: 2,
      startDate: '2026-06-10T15:00:00Z',
    });
    const head = await seedCohortEntry({
      cohortId,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const behind = await seedCohortEntry({
      cohortId,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });
    await promote(cohortTarget(cohortId), NOW, { offerWindowMs: ONE_HOUR_MS });
    assert.equal(await statusOf(head), 'offered');

    // Somebody enrolled straight into the last seat while the offer sat.
    await db.update(cohorts).set({ filled: 3 }).where(eq(cohorts.id, cohortId));

    const result = await sweep(new Date(NOW.getTime() + 2 * ONE_HOUR_MS));

    // The offer still dies — it is past its deadline — but there is no seat
    // behind it any more, so nobody is promised one that no longer exists.
    assert.deepStrictEqual(result, { lapsed: 1, expired: 1, promoted: 0 });
    assert.equal(await statusOf(head), 'expired');
    assert.equal(await statusOf(behind), 'waiting');
    assert.equal((await offersFor(behind)).length, 0);
    await clearWaitlistState();
  },
);

test(
  'sweep — an answered offer is invisible to the sweep, and a second answer is refused',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1 });
    const head = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const behind = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-02T00:00:00Z',
    });
    await promote(dayTarget('day-school', OPEN_DAY), NOW, { offerWindowMs: ONE_HOUR_MS });

    const declinedAt = new Date(NOW.getTime() + 30 * 60 * 1000);
    const declined = await withActor(OWNER_ACTOR, (tx) =>
      waitlistRepository.resolve(tx, {
        id: head,
        from: 'offered',
        to: 'declined',
        resolvedAt: declinedAt,
      }),
    );
    assert.equal(declined, true);

    // The owner answered inside the window, so the sweep has no claim on the
    // entry — expiring it would overwrite a real decision with a cleanup one.
    const result = await sweep(new Date(NOW.getTime() + 2 * ONE_HOUR_MS));
    assert.deepStrictEqual(result, { lapsed: 0, expired: 0, promoted: 0 });
    const answered = await entryRow(head);
    assert.equal(answered.status, 'declined');
    assert.equal(pgTimestampToDate(answered.resolvedAt!).getTime(), declinedAt.getTime());

    // The conditional UPDATE is what makes a racing sweep harmless: the loser
    // of accept-vs-decline-vs-expire gets `false` and leaves the row alone.
    const second = await withActor(OWNER_ACTOR, (tx) =>
      waitlistRepository.resolve(tx, {
        id: head,
        from: 'offered',
        to: 'expired',
        resolvedAt: new Date(NOW.getTime() + 3 * ONE_HOUR_MS),
      }),
    );
    assert.equal(second, false, 'an entry can only be answered once');
    assert.equal((await entryRow(head)).status, 'declined');

    // The declined seat is genuinely free again — but only a promotion pass
    // hands it on, and today nothing calls one when an owner declines
    // (`routes/waitlist.ts` POST /waitlist/:id/decline carries the TODO).
    assert.equal(await statusOf(behind), 'waiting', 'the decline alone did not roll the seat');
    const rolled = await promote(
      dayTarget('day-school', OPEN_DAY),
      new Date(NOW.getTime() + 4 * ONE_HOUR_MS),
    );
    assert.deepStrictEqual(rolled, { seatsFree: 1, offered: 1 });
    assert.equal(await statusOf(behind), 'offered');
    await clearWaitlistState();
  },
);

// ── Ruling 4: the entry dies when the session starts ────────────────────────

test(
  'session expiry — 07:30 America/Chicago is the line, in CDT and in CST',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    const cdtEntry = await seedDayEntry({
      sessionDate: BOOKED_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    const cstEntry = await seedDayEntry({
      sessionDate: CST_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    // A waitlist row carries a DATE, so "the session started" is the drop-off
    // window opening — and the offset that resolves it differs by season. A
    // fixed UTC hour would kill CST entries an hour early every winter.
    await expireSessions(new Date(BOOKED_DAY_SESSION_START.getTime() - 1));
    assert.equal(await statusOf(cdtEntry), 'waiting', 'one millisecond before drop-off opens');

    await expireSessions(BOOKED_DAY_SESSION_START);
    assert.equal(await statusOf(cdtEntry), 'cancelled');
    assert.equal(await statusOf(cstEntry), 'waiting', 'November is months away and is CST besides');

    await expireSessions(new Date(CST_SESSION_START.getTime() - 1));
    assert.equal(await statusOf(cstEntry), 'waiting', '13:29:59Z is 07:29:59 CST');

    await expireSessions(CST_SESSION_START);
    assert.equal(await statusOf(cstEntry), 'cancelled');
    await clearWaitlistState();
  },
);

test(
  'session expiry — an unanswered OFFER dies with its session, and so does a started cohort queue',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    await seedOpenings(OPEN_DAY, { school: 1 });
    const offeredEntry = await seedDayEntry({
      sessionDate: OPEN_DAY,
      leadDogId: FIXTURE_IDS.dog1Id,
      createdAt: '2026-05-01T00:00:00Z',
    });
    await promote(dayTarget('day-school', OPEN_DAY), NOW);
    assert.equal(await statusOf(offeredEntry), 'offered');

    const startedCohort = await seedCohort({
      capacity: 3,
      filled: 1,
      startDate: '2026-05-18T15:00:00Z',
    });
    const cohortEntry = await seedCohortEntry({
      cohortId: startedCohort,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    // The cohort's real start instant is already behind NOW; the day-program
    // offer is still for a future session, so only one of them dies here.
    await expireSessions(NOW);
    assert.equal(await statusOf(cohortEntry), 'cancelled');
    assert.equal(await statusOf(offeredEntry), 'offered');

    // Once OPEN_DAY starts, an unanswered offer is as dead as a waiting entry —
    // it can't be accepted, and leaving it 'offered' would hold a seat that no
    // longer exists.
    await expireSessions(OPEN_DAY_SESSION_START);
    assert.equal(await statusOf(offeredEntry), 'cancelled');
    await clearWaitlistState();
  },
);

// ── The headline promise, end to end ────────────────────────────────────────

test(
  'scheduler tick — a seat freed by a cancellation is offered to the next family in line',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetQueues();
    // One opening on BOOKED_DAY, already taken by fixture `booking1`: the day is
    // genuinely full, which is the ONLY state `POST /waitlist` lets an owner
    // queue for ("seats free means book it, don't queue").
    await seedOpenings(BOOKED_DAY, { school: 1 });
    const entry = await seedDayEntry({
      sessionDate: BOOKED_DAY,
      leadDogId: FIXTURE_IDS.dog2Id,
      createdAt: '2026-05-01T00:00:00Z',
    });

    try {
      // The seat frees. This is the whole feature in one sentence — Allison
      // 2026-07-29: "if all spots are full people should be allowed to enter a
      // waitlist … and then you'd get a message saying you were accepted."
      await db
        .update(bookings)
        .set({ status: 'cancelled', cancelledAt: '2026-05-19T14:00:00Z' })
        .where(eq(bookings.id, FIXTURE_IDS.booking1Id));
      // Pre-condition, so a failure below can only mean "nothing promoted it"
      // and never "the seat was not actually free".
      const capacity = await withActor(SCHEDULER_ACTOR, (tx) =>
        dayCapacityRepository.capacityForDay(tx, {
          location: 'fayetteville',
          date: BOOKED_DAY,
          mode: 'school',
        }),
      );
      // `held` (Δ 2026-07-31): seats an outstanding offer is holding. Nothing is
      // offered on this day yet, so the freed seat is genuinely free.
      assert.deepStrictEqual(capacity, { openings: 1, used: 0, held: 0, remaining: 1 });

      await runSchedulerTickOnce({
        expoPush: makeExpoPushStub(),
        stripe: makeStripeStub(),
        now: NOW,
      });

      assert.equal(
        await statusOf(entry),
        'offered',
        'KNOWN GAP — this fails today. `promoteForTarget` is correct and takes ' +
          'its own queue lock, but NOTHING calls it when a seat frees: the ' +
          'scheduler only promotes queues that had an offer LAPSE (phase 10), ' +
          'and no offer can lapse until one has been made. Cancellation, ' +
          'enrollment withdrawal, a staff cap raise and POST /waitlist/:id/decline ' +
          '(TODO in routes/waitlist.ts) all free seats with no promotion behind them.',
      );
    } finally {
      await db
        .update(bookings)
        .set({ status: 'upcoming', cancelledAt: null })
        .where(eq(bookings.id, FIXTURE_IDS.booking1Id));
      await clearWaitlistState();
    }
  },
);

// ── Push routing ────────────────────────────────────────────────────────────

test('push — a waitlist offer is an urgent update, so muting that category silences it', () => {
  // The offer is on a clock and only the owner can act on it — the line
  // between 'urgent-updates' and 'booking-reminders'. Getting this wrong means
  // an owner who muted trip reminders silently loses their seat.
  assert.equal(
    shouldSkipPush('waitlist-spot-open', {
      pushNotificationsEnabled: true,
      pushNotificationCategories: { 'urgent-updates': false },
    }),
    true,
  );
  assert.equal(
    shouldSkipPush('waitlist-spot-open', {
      pushNotificationsEnabled: true,
      pushNotificationCategories: { 'booking-reminders': false },
    }),
    false,
    'muting reminders must not swallow a seat offer',
  );
  assert.equal(
    shouldSkipPush('waitlist-spot-open', {
      pushNotificationsEnabled: false,
      pushNotificationCategories: {},
    }),
    true,
  );
});
