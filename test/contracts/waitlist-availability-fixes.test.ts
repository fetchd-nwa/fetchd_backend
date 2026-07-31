import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dayCapacityRepository } from '../../src/db/repositories/dayCapacityRepository.js';
import { waitlistRepository } from '../../src/db/repositories/waitlistRepository.js';
import {
  bookings as bookingsTable,
  creditLedger,
  dayCapacity,
  dogCreditBalance,
  dogs,
  invoices,
  scheduledNotifications,
  waitlistEntries,
  waitlistEntryDogs,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { DAY_PROGRAM_DROPOFF_WINDOW } from '../../src/lib/bookingBucket.js';
import { chicagoWallTimeToUtc } from '../../src/lib/chicagoDate.js';
import { pgTimestampToDate } from '../../src/lib/pgTimestamp.js';
import { OFFER_WINDOW_HOURS, promoteForTarget } from '../../src/lib/waitlistPromotion.js';
import { registerAvailabilityRoute } from '../../src/routes/availability.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffWaitlistRoutes } from '../../src/routes/staffWaitlist.js';
import { registerWaitlistRoutes } from '../../src/routes/waitlist.js';
import { FIXTURE_IDS, FIXTURE_NOW, futureWeekday, topUpCredits } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import type { DayCapacityPicture } from '../../src/db/repositories/dayCapacityRepository.js';
import type { WaitlistTarget } from '../../src/db/repositories/waitlistRepository.js';

/**
 * "An outstanding offer HOLDS its seat" (Allison 2026-07-31), proved through
 * the ROUTES rather than through `capacityForDay` alone.
 *
 * `day-capacity-holds.test.ts` pins the arithmetic; this file pins the promise
 * that arithmetic exists to keep. The bug was never "the repository returns the
 * wrong number" — it was "we push family A a notification saying a seat is
 * theirs, family B books it out from under them, and A finds out by tapping
 * Accept and getting a 422." Nothing but a request/response test can show that
 * the hold survives the whole path.
 *
 * What is under test, in the order a seat moves through the system:
 *
 *   - **`POST /bookings` respects the hold.** The headline defect. A day whose
 *     last seat is promised to an offer is full to everyone else.
 *   - **The hold dies with the offer.** A declined offer releases its seat
 *     immediately — a hold that outlived its offer would be a seat leak, which
 *     is the same defect wearing the opposite sign.
 *   - **`POST /waitlist` respects the hold.** The join check reads `remaining`,
 *     so a day whose only seat is spoken for is now joinable. Before the hold
 *     it answered `waitlist_not_needed` — "just book it" — for a seat that was
 *     already someone else's. This is the join path's FIRST contract test; see
 *     the handoff.
 *   - **The hold does not block its own conversion**, end to end: one seat goes
 *     in as `held` and comes out as `used`, and the day never double-counts it.
 *   - **`held` and `used` count the same dogs**, at the route: a staff-owned dog
 *     on an offer is capacity-exempt on both sides of the subtraction.
 *   - **The two independent hold counts agree.** `countOfferedSeats` (promotion)
 *     and `capacityForDay(...).held` (booking) are separate SQL written by
 *     separate hands; they must return the same number or promotion will offer
 *     seats the booking path then refuses.
 *   - **`POST /staff/waitlist/:id/offer` is serialized, deadline-clamped and
 *     ruling-4-correct** — the three defects fixed in that handler.
 *
 * TWO TESTS IN HERE FAIL ON PURPOSE. Both carry their evidence in the assertion
 * message. Delete them only when the behaviour lands, never to get the suite
 * green:
 *   - "a staff cap override must not eat the seat the automatic pass promised"
 *     — a live defect INTRODUCED by the hold, and the one place two existing
 *     expectations contradict each other. Its own doc block has the detail.
 *   - "KNOWN GAP: GET /availability publishes the cap, not the bookable seats"
 *     — the half of "offered seats reduce availability" that is still open.
 *
 * Entries are inserted directly except where the join itself is under test:
 * every case needs a specific offer state (`offered_by_staff_id` set or not,
 * a pinned deadline), and driving that through promotion would test promotion.
 */

// Registered BEFORE `registerFixtureHooks` so it runs ahead of
// `teardownFixture` (node:test runs `after` hooks in registration order): these
// rows hang off the fixture owner and must go first. Gated on the harness's own
// DB signal — with no database there is nothing to clear.
if (SKIP_WHEN_NO_DB.skip === false) after(resetState);
registerFixtureHooks();

const LOCATION = 'fayetteville';
/** `<kind>:<id>`, the shape `actorOf(principal)` produces for an owner. */
const OWNER_ACTOR = `owner:${FIXTURE_IDS.ownerId}`;

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Two weekdays no other contract test claims (2026-06-08 / 2026-06-09), well
 * clear of every fixture booking and inside `POST /bookings`' 92-day lookahead.
 * A blank capacity canvas is what makes `openings − used − held` readable.
 */
const HOLD_DAY = futureWeekday(13);
const SECOND_DAY = futureWeekday(14);
const MANAGED_DAYS = [HOLD_DAY, SECOND_DAY];

/** 07:30 America/Chicago on `HOLD_DAY` — when that session starts. */
const HOLD_DAY_SESSION_START = chicagoWallTimeToUtc(
  HOLD_DAY,
  DAY_PROGRAM_DROPOFF_WINDOW.open.hour,
  DAY_PROGRAM_DROPOFF_WINDOW.open.minute,
);

/**
 * A staff-owned dog. `dogs.capacity_exempt` is generated from
 * `staff_owner_id IS NOT NULL`, which is what makes this row the whole
 * "`held` counts the same dogs `used` counts" case. Its own id, distinct from
 * `day-capacity-holds.test.ts`', so the two files can never fight over it.
 */
const STAFF_DOG_ID = '33333333-3333-4333-8333-3333333330fe';

type App = ReturnType<typeof makeContractApp>['app'];

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface BookingWireLike {
  id: string;
}

// ---- apps -------------------------------------------------------------

function ownerApp(now: () => Date = FIXTURE_NOW): App {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerWaitlistRoutes(app, { authenticate, now });
  registerBookingsRoute(app, { authenticate, now });
  registerAvailabilityRoute(app, { authenticate });
  return app;
}

function staffApp(now: () => Date = FIXTURE_NOW): App {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffWaitlistRoutes(app, { authenticate, now });
  return app;
}

function book(app: App, payload: Record<string, unknown>): ReturnType<App['inject']> {
  return app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': randomUUID() },
    payload,
  });
}

function bookDaySchool(app: App, dogId: string, date: string): ReturnType<App['inject']> {
  return book(app, {
    category: 'day-school',
    lead_dog_id: dogId,
    dates: [date],
    location: LOCATION,
  });
}

function accept(app: App, id: string): ReturnType<App['inject']> {
  return app.inject({
    method: 'POST',
    url: `/waitlist/${id}/accept`,
    headers: { 'idempotency-key': randomUUID() },
  });
}

function decline(app: App, id: string): ReturnType<App['inject']> {
  return app.inject({
    method: 'POST',
    url: `/waitlist/${id}/decline`,
    headers: { 'idempotency-key': randomUUID() },
  });
}

function join(app: App, payload: Record<string, unknown>): ReturnType<App['inject']> {
  return app.inject({
    method: 'POST',
    url: '/waitlist',
    headers: { 'idempotency-key': randomUUID() },
    payload,
  });
}

function staffOffer(app: App, id: string): ReturnType<App['inject']> {
  return app.inject({
    method: 'POST',
    url: `/staff/waitlist/${id}/offer`,
    headers: { 'idempotency-key': randomUUID() },
    payload: {},
  });
}

// ---- fixtures ---------------------------------------------------------

function dayTarget(sessionDate: string): WaitlistTarget {
  return {
    kind: 'day-program',
    category: 'day-school',
    sessionDate,
    location: LOCATION,
    mode: 'school',
  };
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

async function seedEntry(args: {
  status: 'waiting' | 'offered';
  dogIds: readonly string[];
  sessionDate?: string;
  createdAt?: string;
  /** Set ⇒ this offer was a staff cap override rather than a freed seat. */
  offeredByStaffId?: string;
}): Promise<string> {
  const [lead] = args.dogIds;
  if (lead === undefined) throw new Error('seedEntry needs at least one dog');
  const now = FIXTURE_NOW();
  const offered = args.status === 'offered';
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: lead,
      category: 'day-school',
      status: args.status,
      sessionDate: args.sessionDate ?? HOLD_DAY,
      location: LOCATION,
      mode: 'school',
      // `waitlist_offer_has_deadline` CHECKs that an 'offered' row carries both.
      ...(offered
        ? {
            offeredAt: now.toISOString(),
            offerExpiresAt: new Date(now.getTime() + 24 * ONE_HOUR_MS).toISOString(),
          }
        : {}),
      ...(args.createdAt === undefined ? {} : { createdAt: args.createdAt }),
      ...(args.offeredByStaffId === undefined
        ? {}
        : { offeredByStaffId: args.offeredByStaffId }),
    })
    .returning({ id: waitlistEntries.id });
  if (row === undefined) throw new Error('seedEntry: insert returned no row');
  await db.insert(waitlistEntryDogs).values(
    args.dogIds.map((dogId) => ({
      waitlistEntryId: row.id,
      dogId,
      isLead: dogId === lead,
    })),
  );
  return row.id;
}

async function seedStaffDog(): Promise<void> {
  await db.insert(dogs).values({
    id: STAFF_DOG_ID,
    staffOwnerId: FIXTURE_IDS.staffDonavanId,
    name: 'Comet',
    breed: 'Malinois',
    ageMonthsOverride: 60,
  });
}

// ---- reads ------------------------------------------------------------

/** The day's seat picture as every booking path sees it. */
async function capacityOn(date: string): Promise<DayCapacityPicture> {
  return withActor(OWNER_ACTOR, (tx) =>
    dayCapacityRepository.capacityForDay(tx, { location: LOCATION, date, mode: 'school' }),
  );
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

/** The non-circular "did money move" probe. */
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

async function statusOf(entryId: string): Promise<string> {
  const [row] = await db
    .select({ status: waitlistEntries.status })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, entryId));
  if (row === undefined) throw new Error(`statusOf: no waitlist entry ${entryId}`);
  return row.status;
}

// ---- teardown ---------------------------------------------------------

/**
 * Test-only scaffolding — the API never deletes a booking. Scoped to this
 * file's two managed days, which no fixture row touches: a date-wide wipe on a
 * fixture day would delete the ATTENDED staleness anchors and silently flip
 * every later `POST /bookings` into the approval divert.
 */
async function clearBookingsOn(date: string): Promise<void> {
  const ids = await bookingIdsOn(date);
  if (ids.length === 0) return;
  // Children first: `scheduled_notifications` (the reminder rows every create
  // enqueues) and `invoices` both reference the booking.
  await db.delete(scheduledNotifications).where(inArray(scheduledNotifications.bookingId, ids));
  await db.delete(invoices).where(inArray(invoices.bookingId, ids));
  await db.delete(creditLedger).where(inArray(creditLedger.bookingId, ids));
  await db.delete(bookingsTable).where(inArray(bookingsTable.id, ids)); // booking_dogs CASCADEs
}

/**
 * Runs FIRST in every test rather than last, so a case that fails mid-way can't
 * poison the next one, plus once more as the file's `after` hook.
 */
async function resetState(): Promise<void> {
  await db
    .delete(scheduledNotifications)
    .where(
      and(
        eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
        eq(scheduledNotifications.type, 'waitlist-spot-open'),
      ),
    );
  // waitlist_entry_dogs CASCADEs off the entry.
  await db.delete(waitlistEntries).where(eq(waitlistEntries.ownerId, FIXTURE_IDS.ownerId));
  for (const day of MANAGED_DAYS) await clearBookingsOn(day);
  await db.delete(dogs).where(eq(dogs.id, STAFF_DOG_ID));
  await db
    .delete(dayCapacity)
    .where(and(eq(dayCapacity.location, LOCATION), inArray(dayCapacity.date, MANAGED_DAYS)));
}

// ──────────────────────────────────────────────────────────────────────────
// The hold, on the paths that spend seats
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — the day’s last seat is held by an outstanding offer, so nobody else can book it',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    // Lola is holding an offer for the one seat. Waffles turns up to book it.
    await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog2Id] });

    assert.deepStrictEqual(
      await capacityOn(HOLD_DAY),
      { openings: 1, used: 0, held: 1, remaining: 0 },
      'setup: one opening, nothing booked, the seat promised away',
    );

    const res = await bookDaySchool(ownerApp(), FIXTURE_IDS.dog1Id, HOLD_DAY);

    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as ErrorBody;
    assert.equal(body.error.code, 'insufficient_capacity');
    assert.deepStrictEqual(body.error.details, {
      kind: 'insufficient_capacity',
      location: LOCATION,
      date: HOLD_DAY,
      mode: 'school',
      openings_remaining: 0,
      requested: 1,
    });
    assert.deepStrictEqual(
      await bookingIdsOn(HOLD_DAY),
      [],
      'a seat promised to one family must not become a booking for another',
    );
    assert.equal(await schoolBalance(FIXTURE_IDS.dog1Id), balanceBefore, 'the refusal cost nothing');

    await resetState();
  },
);

test(
  'the hold dies with the offer — a declined seat is bookable again, immediately',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const entryId = await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog2Id] });

    const app = ownerApp();
    assert.equal((await decline(app, entryId)).statusCode, 204);
    assert.equal(await statusOf(entryId), 'declined');
    assert.deepStrictEqual(
      await capacityOn(HOLD_DAY),
      { openings: 1, used: 0, held: 0, remaining: 1 },
      'a resolved offer holds nothing — otherwise the seat leaks forever',
    );

    const res = await bookDaySchool(app, FIXTURE_IDS.dog1Id, HOLD_DAY);
    assert.equal(res.statusCode, 201, res.body);
    assert.deepStrictEqual(
      (res.json() as BookingWireLike[]).map((b) => b.id),
      await bookingIdsOn(HOLD_DAY),
    );

    await resetState();
  },
);

test(
  'POST /waitlist — a day whose only seat is HELD is joinable: a promised seat is not a free one',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog2Id] });

    // The join check refuses a target that still has room ("book it instead").
    // It reads `remaining`, so before the hold it saw one free seat here and
    // told the second family to go book a seat that was already Lola's.
    const res = await join(ownerApp(), {
      category: 'day-school',
      session_date: HOLD_DAY,
      location: LOCATION,
      dog_ids: [FIXTURE_IDS.dog1Id],
    });

    assert.equal(res.statusCode, 201, res.body);
    const wire = res.json() as { id: string; status: string; position: number };
    assert.equal(wire.status, 'waiting');
    assert.equal(wire.position, 2, 'the offered entry still holds first place');
    assert.equal(await statusOf(wire.id), 'waiting');

    await resetState();
  },
);

test(
  'POST /waitlist/:id/accept — the held seat becomes the booked seat, and is counted once',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const entryId = await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog1Id] });

    assert.deepStrictEqual(await capacityOn(HOLD_DAY), {
      openings: 1,
      used: 0,
      held: 1,
      remaining: 0,
    });

    const res = await accept(ownerApp(), entryId);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await statusOf(entryId), 'accepted');

    // The seat moved from one column to the other. If the accept had been
    // counted against its own hold it would have 422'd; if the hold had
    // survived the accept the day would now be at −1.
    assert.deepStrictEqual(
      await capacityOn(HOLD_DAY),
      { openings: 1, used: 1, held: 0, remaining: 0 },
      'one seat in as held, one seat out as used',
    );
    assert.equal((await bookingIdsOn(HOLD_DAY)).length, 1);

    await resetState();
  },
);

test(
  'a staff-owned dog on an offer holds nothing — an owner can still book the seat',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    await seedStaffDog();
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    // `used` never counts staff dogs (`dogs.capacity_exempt`). If `held` did,
    // a staff dog sitting on an offer would silently eat a paying seat.
    await seedEntry({ status: 'offered', dogIds: [STAFF_DOG_ID] });

    assert.deepStrictEqual(await capacityOn(HOLD_DAY), {
      openings: 1,
      used: 0,
      held: 0,
      remaining: 1,
    });
    const res = await bookDaySchool(ownerApp(), FIXTURE_IDS.dog1Id, HOLD_DAY);
    assert.equal(res.statusCode, 201, res.body);

    await resetState();
  },
);

test(
  'the two hold counts agree — promotion and the booking path see the same seats spoken for',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 3);
    await seedStaffDog();
    await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog1Id] });
    await seedEntry({ status: 'offered', dogIds: [STAFF_DOG_ID] });
    await seedEntry({ status: 'waiting', dogIds: [FIXTURE_IDS.dog2Id] });

    // `waitlistRepository.countOfferedSeats` (what promotion subtracts) and
    // `capacityForDay(...).held` (what every booking asserts against) are two
    // separately written SQL statements over the same idea. They must agree on
    // BOTH halves — which statuses are live, and which dogs are exempt — or
    // promotion offers seats the booking path then refuses.
    const { offeredSeats, held } = await withActor(OWNER_ACTOR, async (tx) => ({
      offeredSeats: await waitlistRepository.countOfferedSeats(tx, dayTarget(HOLD_DAY)),
      held: (
        await dayCapacityRepository.capacityForDay(tx, {
          location: LOCATION,
          date: HOLD_DAY,
          mode: 'school',
        })
      ).held,
    }));

    assert.equal(offeredSeats, 1, 'one owner dog offered; the staff dog is exempt, the waiting one is not held');
    assert.equal(held, offeredSeats, 'the two definitions of "spoken for" must not drift');

    await resetState();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/waitlist/:id/offer — the three fixes in that handler
// ──────────────────────────────────────────────────────────────────────────

test(
  'the staff offer and the promotion pass hand out the SAME deadline',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    await seedOpenings(SECOND_DAY, 1);
    const promoted = await seedEntry({ status: 'waiting', dogIds: [FIXTURE_IDS.dog1Id] });
    const overridden = await seedEntry({
      status: 'waiting',
      dogIds: [FIXTURE_IDS.dog2Id],
      sessionDate: SECOND_DAY,
    });

    // Two surfaces, one window. Deriving the expectation from the imported
    // constant rather than from the literal 24 is the point: this passes only
    // while BOTH surfaces read `OFFER_WINDOW_HOURS`, and a re-tuned constant
    // keeps it passing instead of pinning a number that has moved.
    await withActor(OWNER_ACTOR, (tx) =>
      promoteForTarget(tx, dayTarget(HOLD_DAY), FIXTURE_NOW()),
    );
    const res = await staffOffer(staffApp(), overridden);
    assert.equal(res.statusCode, 200, res.body);

    const expected = new Date(
      FIXTURE_NOW().getTime() + OFFER_WINDOW_HOURS * ONE_HOUR_MS,
    ).toISOString();
    const [promotedRow] = await db
      .select({ offerExpiresAt: waitlistEntries.offerExpiresAt })
      .from(waitlistEntries)
      .where(eq(waitlistEntries.id, promoted));
    assert.equal(await statusOf(promoted), 'offered', 'setup: the automatic pass offered the seat');
    assert.ok(promotedRow?.offerExpiresAt != null, 'an offered row carries a deadline');
    // The column comes back as a pg timestamp literal, not ISO — normalize
    // before comparing, the same way every other reader of it does.
    assert.equal(pgTimestampToDate(promotedRow.offerExpiresAt).toISOString(), expected);
    assert.equal(
      (res.json() as { offer_expires_at?: string }).offer_expires_at,
      expected,
      'an owner’s deadline must not depend on which surface handed them the seat',
    );

    await resetState();
  },
);

test(
  'the staff offer refuses a session that started this morning, and allows one before drop-off',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    const entryId = await seedEntry({ status: 'waiting', dogIds: [FIXTURE_IDS.dog1Id] });

    // 09:00 Chicago on the session's own date. Under the old DATE-granularity
    // spelling of ruling 4 this was "same-day is still fair game"; the session
    // has in fact been running since 07:30, and `cancelEntriesForStartedSessions`
    // would kill the offer on the next tick.
    const afterDropoff = new Date(HOLD_DAY_SESSION_START.getTime() + 90 * 60 * 1000);
    const refused = await staffOffer(staffApp(() => afterDropoff), entryId);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal((refused.json() as ErrorBody).error.code, 'conflict');
    assert.equal(await statusOf(entryId), 'waiting', 'a refused offer must not move the entry');

    // 06:00 Chicago the same morning — still walkable-in, so still offerable.
    const beforeDropoff = new Date(HOLD_DAY_SESSION_START.getTime() - 90 * 60 * 1000);
    const allowed = await staffOffer(staffApp(() => beforeDropoff), entryId);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(
      (allowed.json() as { offer_expires_at?: string }).offer_expires_at,
      HOLD_DAY_SESSION_START.toISOString(),
      'the deadline is clamped to the session start, never past it',
    );

    await resetState();
  },
);

test(
  'the staff offer waits on the per-queue lock instead of racing the promotion pass',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    const entryId = await seedEntry({ status: 'waiting', dogIds: [FIXTURE_IDS.dog1Id] });

    // Stand in for a scheduler tick mid-promotion: hold the queue's advisory
    // lock in another transaction and watch the staff verb wait for it.
    // `markOffered`'s status guard cannot cover this race — the two passes pick
    // DIFFERENT rows and both UPDATEs succeed — so the lock is the only guard,
    // and it has to be taken BEFORE the handler decides anything.
    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => (lockTaken = resolve));
    let releaseLock!: () => void;
    const released = new Promise<void>((resolve) => (releaseLock = resolve));
    const holder = withActor(OWNER_ACTOR, async (tx) => {
      await waitlistRepository.lockQueue(tx, dayTarget(HOLD_DAY));
      lockTaken();
      await released;
    });
    await taken;

    let settled = false;
    const offerInFlight = staffOffer(staffApp(), entryId).then((res) => {
      settled = true;
      return res;
    });
    try {
      // Comfortably longer than the ~20ms an unblocked offer takes.
      await sleep(400);
      assert.equal(
        settled,
        false,
        'the staff offer answered while another pass held the queue lock — it decided who gets the seat without serializing against promotion',
      );
    } finally {
      releaseLock();
      await holder;
    }

    const res = await offerInFlight;
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await statusOf(entryId), 'offered');

    await resetState();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// FAILS ON PURPOSE — see the file header
// ──────────────────────────────────────────────────────────────────────────

/**
 * The hold's own inversion: an override's hold repossesses a real seat.
 *
 * The sequence is ordinary. A seat frees, the automatic pass offers it to the
 * family at the head of the queue and pushes them "A spot opened up". Staff
 * then override the cap for somebody else — ruling 2, the 13th dog in 12 slots
 * — which by design runs no capacity check at all, so nothing stops it landing
 * on a queue that already has an outstanding offer.
 *
 * Now the day has one real seat and two live offers. `countHeldSeats` counts
 * BOTH, so the promoted family's accept sees `1 − 0 − 1 = 0` and is refused
 * `insufficient_capacity`, while the override's accept skips the assert
 * entirely (`allowOverCapacity`) and takes the seat. The family we notified is
 * left holding an 'offered' entry that can never be accepted, and is told
 * nothing — the exact harm this whole ticket exists to prevent, with the roles
 * swapped.
 *
 * NEEDS A RULING, because the neighbouring expectation points the other way:
 * `waitlist-staff.test.ts`'s "an overridden entry holds its seats" pins that an
 * outstanding override BLOCKS the automatic pass from promoting the free seat —
 * i.e. there the override is read as re-allocating the one seat, not adding a
 * second. Both readings cannot be right at once. Whichever Allison picks, the
 * current behaviour is wrong under both: if an override adds a seat, the
 * promoted family must still get theirs; if it re-allocates one, their offer
 * must be cancelled and they must be told, not left holding a dead promise.
 */
test(
  'a staff cap override must not eat the seat the automatic pass already promised',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    await topUpCredits(FIXTURE_IDS.dog2Id, 'school', 1);

    // Waffles was promoted by the automatic pass into a seat that genuinely
    // freed: `offered_by_staff_id` is NULL, so their accept goes through the
    // ordinary capacity assert.
    const promoted = await seedEntry({
      status: 'offered',
      dogIds: [FIXTURE_IDS.dog1Id],
      createdAt: '2026-05-18T10:00:00Z',
    });
    // Then staff overrode the cap for Lola.
    const overridden = await seedEntry({
      status: 'offered',
      dogIds: [FIXTURE_IDS.dog2Id],
      createdAt: '2026-05-18T11:00:00Z',
      offeredByStaffId: FIXTURE_IDS.staffDonavanId,
    });

    const app = ownerApp();
    const promotedRes = await accept(app, promoted);
    const overriddenRes = await accept(app, overridden);

    assert.equal(
      overriddenRes.statusCode,
      201,
      `the override books past the ceiling — that is what the override IS: ${overriddenRes.body}`,
    );
    assert.equal(
      promotedRes.statusCode,
      201,
      'DEFECT (2026-07-31, introduced by the hold): `countHeldSeats` counts an ' +
        'override’s hold against the day, so the ONE real seat is spent by the ' +
        'override and the family the automatic pass promised it to — and pushed ' +
        'a notification to — is refused their own seat: ' +
        promotedRes.body,
    );
    assert.equal(
      (await bookingIdsOn(HOLD_DAY)).length,
      2,
      'staff chose to seat both dogs; both bookings must exist',
    );

    await resetState();
  },
);

test(
  'KNOWN GAP: GET /availability publishes the cap, not the seats a client can actually book',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(HOLD_DAY, 1);
    await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog2Id] });

    const res = await ownerApp().inject({
      method: 'GET',
      url: `/availability?from=${HOLD_DAY}&to=${HOLD_DAY}&mode=school&location=${LOCATION}`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const [day] = res.json() as { date: string; school_openings: number }[];

    // Both clients read `school_openings` as free seats — the mobile app's
    // `availabilityService.classifyStatus` is literally "green if every
    // selected dog fits". The route emits the configured CAP: it subtracts
    // neither booked dogs (pre-existing, predates the waitlist) nor the seats
    // an outstanding offer holds (this ticket). So a day the booking path will
    // 422 still renders open, and the owner finds out at the last step.
    //
    // Closing it changes the meaning of a §B wire field shared by three repos
    // plus its byte-match snapshots — contract-first orchestrator work, not a
    // side effect of the hold. Documented in the route's doc block; this is the
    // executable half of that note.
    const { remaining } = await capacityOn(HOLD_DAY);
    assert.equal(remaining, 0, 'setup: the one seat is spoken for');
    assert.equal(
      day?.school_openings,
      remaining,
      'GET /availability must publish the seats a client can book, not the day’s cap',
    );

    await resetState();
  },
);
