import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray, like, notInArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  bookings,
  cohorts,
  creditLedger,
  dayCapacity,
  idempotencyKeys,
  invoices,
  scheduledNotifications,
  waitlistEntries,
  waitlistEntryDogs,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import {
  cancelEntriesForStartedSessions,
  promoteForTarget,
  sweepLapsedOffers,
} from '../../src/lib/waitlistPromotion.js';
import { registerStaffWaitlistRoutes } from '../../src/routes/staffWaitlist.js';
import { registerWaitlistRoutes } from '../../src/routes/waitlist.js';
import type { WaitlistTarget } from '../../src/db/repositories/waitlistRepository.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { FIXTURE_IDS, FIXTURE_TODAY, futureWeekday } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * The staff cap override (Allison 2026-07-30 ruling 2), tested for what happens
 * to the seat it hands out rather than for the row it writes —
 * `staff-waitlist.test.ts` covers the verb's own shape (403s, wire fields,
 * validation, the CLOSED-day write). This file is the surrounding blast radius:
 *
 *   - money (ruling 1): nothing may be booked or charged at OFFER time, and the
 *     accept is the ONLY place either happens;
 *   - one seat, one promise: an override racing itself, or racing the automatic
 *     promotion pass, must never hand the same entry two offers;
 *   - an entry that needs more seats than are free must be all-or-nothing;
 *   - a lapsed offer must be unacceptable and must roll to the next in line;
 *   - the override and the ruling-4 "the entry dies when the session starts"
 *     sweep must agree about which sessions can still be offered.
 *
 * The override is only worth anything if the owner can ACT on it, so most cases
 * here drive the whole arc: staff offers → owner accepts (or can't). Two of them
 * fail today; both failures are reported in the handoff rather than softened
 * into assertions of the current behaviour.
 */

registerFixtureHooks();

const LOCATION = 'fayetteville';
const MODE = 'school';

/** FIXTURE_TODAY is 2026-05-19T17:00:00Z = 12:00 CDT — this calendar day. */
const TODAY_CHICAGO = '2026-05-19';

/** Weekdays past the sibling file's (3)/(4) so the two suites never share a day. */
const OPEN_DAY = futureWeekday(6);
const FULL_DAY = futureWeekday(7);
const PAIR_DAY = futureWeekday(8);

const ENTRY_A = '0ffe0000-0000-4000-8000-00000000a001';
const ENTRY_B = '0ffe0000-0000-4000-8000-00000000a002';
const ENTRY_C = '0ffe0000-0000-4000-8000-00000000a003';
const COHORT_ID = '0ffe0000-0000-4000-8000-00000000c001';

const HOUR_MS = 60 * 60 * 1000;

/** Every booking the fixture seeds — anything else on the owner is ours to drop. */
const FIXTURE_BOOKING_IDS = [
  FIXTURE_IDS.booking1Id,
  FIXTURE_IDS.booking2Id,
  FIXTURE_IDS.booking3Id,
  FIXTURE_IDS.booking4Id,
  FIXTURE_IDS.booking5Id,
  FIXTURE_IDS.booking6Id,
  FIXTURE_IDS.booking7Id,
  FIXTURE_IDS.booking8Id,
  FIXTURE_IDS.booking9Id,
  FIXTURE_IDS.bookingDstId,
  FIXTURE_IDS.bookingDog2PastCareId,
];

interface StaffEntryWire {
  id: string;
  owner_id: string;
  category: string;
  status: string;
  dog_ids: string[];
  position: number;
  offer_expires_at?: string;
  offered_by_staff_id?: string;
  created_at: string;
}

interface StaffQueueWire {
  category: string;
  session_date?: string;
  location?: string;
  cohort_id?: string;
  entries: StaffEntryWire[];
}

interface OwnerEntryWire {
  id: string;
  status: string;
  position: number;
  session_date?: string;
}

/** The slice of `BookingWire` these cases assert on. */
interface CreatedBookingWire {
  id: string;
  category: string;
  dog_id: string;
  additional_dog_ids?: string[];
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

// ---- apps -------------------------------------------------------------

function clockAt(instant: Date): () => Date {
  return () => instant;
}

function staffApp(now: Date = FIXTURE_TODAY): FastifyInstance {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffWaitlistRoutes(app, { authenticate, now: clockAt(now) });
  return app;
}

function ownerApp(now: Date = FIXTURE_TODAY): FastifyInstance {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerWaitlistRoutes(app, { authenticate, now: clockAt(now) });
  return app;
}

function mutate(app: FastifyInstance, url: string, payload: InjectOptions['payload'] = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'idempotency-key': randomUUID() },
    payload,
  });
}

function offer(app: FastifyInstance, entryId: string, body: Record<string, unknown> = {}) {
  return mutate(app, `/staff/waitlist/${entryId}/offer`, body);
}

function accept(app: FastifyInstance, entryId: string, body: Record<string, unknown> = {}) {
  return mutate(app, `/waitlist/${entryId}/accept`, body);
}

// ---- fixtures ---------------------------------------------------------

function dayTarget(sessionDate: string): WaitlistTarget {
  return { kind: 'day-program', category: 'day-school', sessionDate, location: LOCATION, mode: MODE };
}

/** One entry with a pinned `created_at`, so FIFO order is stated, not timed. */
async function seedDayEntry(args: {
  id: string;
  sessionDate: string;
  createdAt: string;
  dogIds: readonly string[];
  status?: 'waiting' | 'cancelled';
}): Promise<void> {
  const [lead] = args.dogIds;
  if (lead === undefined) throw new Error('seedDayEntry needs at least one dog');
  await db.insert(waitlistEntries).values({
    id: args.id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: lead,
    category: 'day-school',
    status: args.status ?? 'waiting',
    sessionDate: args.sessionDate,
    location: LOCATION,
    mode: MODE,
    createdAt: args.createdAt,
    ...(args.status === 'cancelled' ? { resolvedAt: '2026-05-18T12:00:00Z' } : {}),
  });
  await db.insert(waitlistEntryDogs).values(
    args.dogIds.map((dogId) => ({ waitlistEntryId: args.id, dogId, isLead: dogId === lead })),
  );
}

async function seedCohortEntry(args: { id: string; createdAt: string; dogId: string }): Promise<void> {
  await db.insert(cohorts).values({
    id: COHORT_ID,
    classKey: 'puppy',
    location: LOCATION,
    startDate: '2026-06-15T15:00:00Z',
    weeklyTime: '10:00 AM',
    weeks: 4,
    capacity: 1,
    filled: 1,
  });
  await db.insert(waitlistEntries).values({
    id: args.id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: args.dogId,
    category: 'group-class',
    status: 'waiting',
    cohortId: COHORT_ID,
    createdAt: args.createdAt,
  });
  await db
    .insert(waitlistEntryDogs)
    .values({ waitlistEntryId: args.id, dogId: args.dogId, isLead: true });
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

/**
 * Consume the day's only seat with a real booking, so the day is FULL rather
 * than CLOSED — the state an honest waitlist entry is actually created in
 * (`POST /waitlist` refuses to queue anyone for a closed day).
 */
async function seedSeatTakenBy(dogId: string, date: string): Promise<void> {
  const id = randomUUID();
  await db.insert(bookings).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: dogId,
    category: 'day-school',
    status: 'upcoming',
    // 13:00Z = 08:00 CDT — inside the drop-off window, and the same Chicago
    // calendar day the capacity count buckets on.
    scheduledAt: `${date}T13:00:00Z`,
    durationMinutes: 540,
    location: LOCATION,
  });
  await db.insert(bookingDogs).values({ bookingId: id, dogId, isLead: true });
}

// ---- reads ------------------------------------------------------------

async function readEntry(id: string): Promise<
  | {
      status: string;
      offeredAt: string | null;
      offerExpiresAt: string | null;
      offeredByStaffId: string | null;
      bookingId: string | null;
    }
  | undefined
> {
  const [row] = await db
    .select({
      status: waitlistEntries.status,
      offeredAt: waitlistEntries.offeredAt,
      offerExpiresAt: waitlistEntries.offerExpiresAt,
      offeredByStaffId: waitlistEntries.offeredByStaffId,
      bookingId: waitlistEntries.bookingId,
    })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, id));
  return row;
}

async function spotOpenNotifications(): Promise<{ dedupeKey: string | null; trigger: string | null; body: string }[]> {
  return db
    .select({
      dedupeKey: scheduledNotifications.dedupeKey,
      trigger: scheduledNotifications.trigger,
      body: scheduledNotifications.body,
    })
    .from(scheduledNotifications)
    .where(
      and(
        eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId),
        like(scheduledNotifications.dedupeKey, 'waitlist-spot-open:%'),
      ),
    );
}

/** The owner's bookings on one Chicago day, with their roster. */
async function bookingsOn(date: string): Promise<{ id: string; dogIds: string[] }[]> {
  const rows = await db
    .select({ id: bookings.id, scheduledAt: bookings.scheduledAt })
    .from(bookings)
    .where(
      and(eq(bookings.ownerId, FIXTURE_IDS.ownerId), notInArray(bookings.id, FIXTURE_BOOKING_IDS)),
    );
  // The seeded competing booking and any accept-created one both land at the
  // same Chicago date; matching on the ISO prefix is enough because every
  // booking this file creates is stamped mid-morning CDT.
  const onDay = rows.filter((row) => row.scheduledAt.startsWith(date));
  const out: { id: string; dogIds: string[] }[] = [];
  for (const row of onDay) {
    const dogs = await db
      .select({ dogId: bookingDogs.dogId })
      .from(bookingDogs)
      .where(eq(bookingDogs.bookingId, row.id));
    out.push({ id: row.id, dogIds: dogs.map((d) => d.dogId).sort() });
  }
  return out;
}

interface MoneyCounts {
  bookings: number;
  invoices: number;
  ledgerRows: number;
}

/** Every place money or a seat could have moved for the fixture owner. */
async function moneySnapshot(): Promise<MoneyCounts> {
  const [bookingRows, invoiceRows, ledgerRows] = await Promise.all([
    db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ownerId, FIXTURE_IDS.ownerId)),
    db.select({ id: invoices.id }).from(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId)),
    db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(inArray(creditLedger.dogId, [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id])),
  ]);
  return {
    bookings: bookingRows.length,
    invoices: invoiceRows.length,
    ledgerRows: ledgerRows.length,
  };
}

// ---- lifecycle --------------------------------------------------------

/**
 * Drop everything a case can create, in FK order.
 *
 * Waitlist rows go FIRST and that ordering is load-bearing: an 'accepted' entry
 * points at the booking it became, `waitlist_entries.booking_id` is
 * ON DELETE SET NULL, and `waitlist_accepted_has_booking` re-checks on that
 * UPDATE — deleting the bookings first fails the CHECK and takes the whole
 * file's teardown with it.
 */
async function reset(): Promise<void> {
  await db.delete(waitlistEntries).where(eq(waitlistEntries.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(cohorts).where(eq(cohorts.id, COHORT_ID));
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));

  const ours = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(eq(bookings.ownerId, FIXTURE_IDS.ownerId), notInArray(bookings.id, FIXTURE_BOOKING_IDS)),
    );
  if (ours.length > 0) {
    const ids = ours.map((row) => row.id);
    await db.delete(creditLedger).where(inArray(creditLedger.bookingId, ids));
    await db.delete(invoices).where(inArray(invoices.bookingId, ids));
    await db.delete(bookings).where(inArray(bookings.id, ids));
  }

  await db
    .delete(dayCapacity)
    .where(
      and(
        eq(dayCapacity.location, LOCATION),
        inArray(dayCapacity.date, [OPEN_DAY, FULL_DAY, PAIR_DAY]),
      ),
    );
  await db
    .delete(idempotencyKeys)
    .where(
      inArray(idempotencyKeys.endpoint, [
        'POST /staff/waitlist/:id/offer',
        'POST /waitlist/:id/accept',
      ]),
    );
}

/**
 * Run a case against a clean waitlist and leave the DB clean even when it
 * fails — a case that throws mid-arc can otherwise leave an 'accepted' entry
 * behind, which FK-blocks `teardownFixture`'s bookings delete for the whole
 * file (and, since this suite shares a DB, for the next file to re-seed).
 */
function waitlistCase(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    await reset();
    try {
      await fn();
    } finally {
      await reset();
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────
// The queue view staff decide from
// ──────────────────────────────────────────────────────────────────────────

test(
  'GET /staff/waitlist — an offer holds its place, resolved entries are gone, and the owner sees the same positions',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(OPEN_DAY, 1);
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: OPEN_DAY,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });
    await seedDayEntry({
      id: ENTRY_B,
      sessionDate: OPEN_DAY,
      createdAt: '2026-05-18T11:00:00Z',
      dogIds: [FIXTURE_IDS.dog2Id],
    });
    // A dog that already left the queue. Resolved rows must never show up: an
    // entry staff can't act on in a list whose only verb is "offer" is a 404
    // waiting to happen.
    await seedDayEntry({
      id: ENTRY_C,
      sessionDate: OPEN_DAY,
      createdAt: '2026-05-18T09:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'cancelled',
    });

    assert.equal((await offer(staffApp(), ENTRY_A)).statusCode, 200);

    const res = await staffApp().inject({ method: 'GET', url: '/staff/waitlist' });
    assert.equal(res.statusCode, 200, res.body);
    const { queues } = res.json() as { queues: StaffQueueWire[] };
    const queue = queues.find((q) => q.session_date === OPEN_DAY);
    assert.ok(queue !== undefined, `no queue for ${OPEN_DAY}: ${JSON.stringify(queues)}`);
    assert.deepEqual(
      queue.entries.map((e) => [e.id, e.status, e.position]),
      [
        [ENTRY_A, 'offered', 1],
        [ENTRY_B, 'waiting', 2],
      ],
      'the offered entry keeps position 1 — everyone behind must not appear to move up',
    );

    // The two surfaces read the same queue. If they disagreed, staff would be
    // offering seats to a line the owner sees in a different order.
    const ownerRes = await ownerApp().inject({ method: 'GET', url: '/waitlist' });
    assert.equal(ownerRes.statusCode, 200, ownerRes.body);
    const { items } = ownerRes.json() as { items: OwnerEntryWire[] };
    const ownerPositions = new Map(items.map((item) => [item.id, item.position]));
    for (const entry of queue.entries) {
      assert.equal(
        ownerPositions.get(entry.id),
        entry.position,
        `staff and owner disagree about the position of ${entry.id}`,
      );
    }
    assert.equal(ownerPositions.has(ENTRY_C), false, 'a cancelled entry is not live for anyone');
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// Ruling 1 — no money at the offer
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/waitlist/:id/offer — books nothing and charges nothing (ruling 1)',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(FULL_DAY, 1);
    await seedSeatTakenBy(FIXTURE_IDS.dog2Id, FULL_DAY);
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: FULL_DAY,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });

    const before = await moneySnapshot();
    const res = await offer(staffApp(), ENTRY_A);
    assert.equal(res.statusCode, 200, res.body);
    const after = await moneySnapshot();

    assert.deepEqual(
      after,
      before,
      'an offer is an invitation, not a transaction — no booking, no invoice, no credit movement',
    );
    const entry = await readEntry(ENTRY_A);
    assert.equal(entry?.status, 'offered');
    assert.equal(entry?.bookingId, null, 'nothing is booked until the owner accepts');
    assert.equal(entry?.offeredByStaffId, FIXTURE_IDS.staffDonavanId);

    // The one side effect that IS allowed: telling the owner.
    const notes = await spotOpenNotifications();
    assert.equal(notes.length, 1, 'exactly one spot-open notification per offer');
    assert.match(
      notes[0]?.body ?? '',
      /nothing is charged until you accept/i,
      'the copy has to say the money part out loud — an owner who thinks they were billed calls the front desk',
    );
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// The seat the override promised
// ──────────────────────────────────────────────────────────────────────────

test(
  'staff override → owner accept, on a day with a free seat: the booking and the charge happen HERE',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    // A seat freed after this dog queued. Staff hand it over by name instead of
    // waiting for the scheduler tick — the ordinary override.
    await seedOpenings(OPEN_DAY, 1);
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: OPEN_DAY,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });

    assert.equal((await offer(staffApp(), ENTRY_A)).statusCode, 200);
    const afterOffer = await moneySnapshot();

    const res = await accept(ownerApp(), ENTRY_A);
    assert.equal(res.statusCode, 201, res.body);
    const created = res.json() as CreatedBookingWire[];
    assert.equal(created.length, 1);
    assert.equal(created[0]?.dog_id, FIXTURE_IDS.dog1Id);
    assert.equal(created[0]?.additional_dog_ids, undefined, 'a one-dog entry books one dog');

    const afterAccept = await moneySnapshot();
    assert.equal(afterAccept.bookings, afterOffer.bookings + 1, 'accept is what books the seat');
    assert.equal(
      afterAccept.ledgerRows,
      afterOffer.ledgerRows + 1,
      'accept is what spends the credit — exactly one debit, for the one dog',
    );

    const entry = await readEntry(ENTRY_A);
    assert.equal(entry?.status, 'accepted');
    assert.equal(entry?.bookingId, created[0]?.id, 'the entry records the booking it became');
  }),
);

test(
  'staff override → owner accept, on a FULL day: the overridden seat must be claimable (ruling 2)',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    // The day is FULL, not closed: one opening, already taken. This is the only
    // state a waitlist entry can honestly exist in, and it is exactly the state
    // ruling 2 is about — "staff can override the cap".
    await seedOpenings(FULL_DAY, 1);
    await seedSeatTakenBy(FIXTURE_IDS.dog2Id, FULL_DAY);
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: FULL_DAY,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });

    const offered = await offer(staffApp(), ENTRY_A);
    assert.equal(offered.statusCode, 200, offered.body);

    const res = await accept(ownerApp(), ENTRY_A);
    assert.equal(
      res.statusCode,
      201,
      'ruling 2 says staff can exceed the cap, and ruling 1 puts the booking at ACCEPT — so the ' +
        'seat an override promised has to be claimable. It is not: `createDayProgramBookings` ' +
        're-runs `dayCapacityRepository.assertCapacityWithinLock`, nothing tells it this entry ' +
        'was a staff override, and there is no staff verb that raises `day_capacity` either. The ' +
        'override therefore only ever produces a push notification for a seat that cannot be ' +
        `taken. Response: ${res.body}`,
    );

    const created = res.json() as CreatedBookingWire[];
    assert.equal(created.length, 1, 'the override books one dog past the cap');
    assert.equal((await readEntry(ENTRY_A))?.status, 'accepted');
  }),
);

test(
  'staff override → owner accept, when the entry needs more seats than are free: all-or-nothing',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    // Two dogs on one entry, one seat free. Whatever the capacity ruling turns
    // out to be, the outcome that must NEVER happen is half of it: one dog
    // booked, one dog dropped, the entry resolved.
    await seedOpenings(PAIR_DAY, 1);
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: PAIR_DAY,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
    });

    assert.equal((await offer(staffApp(), ENTRY_A)).statusCode, 200);
    const beforeAccept = await moneySnapshot();

    const res = await accept(ownerApp(), ENTRY_A);
    const booked = await bookingsOn(PAIR_DAY);
    const afterAccept = await moneySnapshot();

    if (res.statusCode === 201) {
      assert.equal(booked.length, 1, 'one entry, one booking');
      assert.deepEqual(
        booked[0]?.dogIds,
        [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id].sort(),
        'both dogs on the entry are on the booking',
      );
      assert.equal(afterAccept.ledgerRows, beforeAccept.ledgerRows + 2, 'one debit per dog');
      assert.equal((await readEntry(ENTRY_A))?.status, 'accepted');
      return;
    }

    assert.equal(booked.length, 0, `a refused accept must leave no booking behind: ${res.body}`);
    assert.deepEqual(afterAccept, beforeAccept, 'a refused accept must move no money');
    assert.equal(
      (await readEntry(ENTRY_A))?.status,
      'offered',
      'a refused accept must not burn the offer — the owner has to be able to retry',
    );
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// One seat, one promise
// ──────────────────────────────────────────────────────────────────────────

test(
  'two staff offering the same entry at once — exactly one offer, exactly one notification',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(FULL_DAY, 1);
    await seedSeatTakenBy(FIXTURE_IDS.dog2Id, FULL_DAY);
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: FULL_DAY,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });

    // Two front-desk clicks, distinct Idempotency-Keys — genuinely two
    // requests, so it is `markOffered`'s status guard being tested and not the
    // idempotency layer.
    const app = staffApp();
    const [first, second] = await Promise.all([offer(app, ENTRY_A), offer(app, ENTRY_A)]);
    assert.deepEqual(
      [first.statusCode, second.statusCode].sort(),
      [200, 404],
      `one must win and one must lose: ${first.body} / ${second.body}`,
    );

    const notes = await spotOpenNotifications();
    assert.equal(notes.length, 1, 'the owner is told once — two pushes for one seat is a lie twice');
  }),
);

test(
  'an entry the automatic pass already offered cannot be re-offered by staff',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(OPEN_DAY, 1);
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: OPEN_DAY,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });

    // The scheduler got there first.
    const promoted = await withActor('system:scheduler', (tx) =>
      promoteForTarget(tx, dayTarget(OPEN_DAY), FIXTURE_TODAY),
    );
    assert.equal(promoted.offered, 1);

    const res = await offer(staffApp(), ENTRY_A);
    assert.equal(res.statusCode, 404, `already offered — nothing for staff to do: ${res.body}`);

    const entry = await readEntry(ENTRY_A);
    assert.equal(entry?.status, 'offered');
    assert.equal(
      entry?.offeredByStaffId,
      null,
      'a rejected override must not restamp provenance — this seat freed on its own',
    );
    const notes = await spotOpenNotifications();
    assert.equal(notes.length, 1, 'one offer, one notification');
    assert.equal(notes[0]?.trigger, 'waitlist-promotion');
  }),
);

test(
  'an overridden entry holds its seats — the automatic pass cannot re-promise them',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    // One free seat, two in line. Staff hand it to the SECOND entry (the
    // override's whole point is that it is not FIFO).
    await seedOpenings(OPEN_DAY, 1);
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: OPEN_DAY,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });
    await seedDayEntry({
      id: ENTRY_B,
      sessionDate: OPEN_DAY,
      createdAt: '2026-05-18T11:00:00Z',
      dogIds: [FIXTURE_IDS.dog2Id],
    });

    assert.equal((await offer(staffApp(), ENTRY_B)).statusCode, 200);

    const result = await withActor('system:scheduler', (tx) =>
      promoteForTarget(tx, dayTarget(OPEN_DAY), FIXTURE_TODAY),
    );
    assert.equal(
      result.offered,
      0,
      'the outstanding override is holding the seat — promoting on top of it would promise one seat to two owners',
    );
    assert.equal((await readEntry(ENTRY_A))?.status, 'waiting');
    assert.equal((await spotOpenNotifications()).length, 1);
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// Deadlines
// ──────────────────────────────────────────────────────────────────────────

test(
  'a lapsed staff offer cannot be accepted, and the sweep rolls the seat to the next in line',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedOpenings(OPEN_DAY, 1);
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: OPEN_DAY,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });
    await seedDayEntry({
      id: ENTRY_B,
      sessionDate: OPEN_DAY,
      createdAt: '2026-05-18T11:00:00Z',
      dogIds: [FIXTURE_IDS.dog2Id],
    });

    assert.equal(
      (await offer(staffApp(), ENTRY_A, { offer_expires_in_hours: 1 })).statusCode,
      200,
    );
    const beforeLapse = await moneySnapshot();

    const later = new Date(FIXTURE_TODAY.getTime() + 2 * HOUR_MS);
    const late = await accept(ownerApp(later), ENTRY_A);
    assert.equal(late.statusCode, 409, `the deadline passed — the seat is not theirs: ${late.body}`);
    assert.equal((late.json() as ErrorEnvelope).error.code, 'conflict');
    assert.deepEqual(await moneySnapshot(), beforeLapse, 'a refused accept charges nothing');

    const swept = await withActor('system:scheduler', (tx) => sweepLapsedOffers(tx, later));
    assert.equal(swept.expired, 1);
    assert.equal((await readEntry(ENTRY_A))?.status, 'expired');
    assert.equal(
      (await readEntry(ENTRY_B))?.status,
      'offered',
      'the seat an unanswered override was holding must roll on, not stall the queue',
    );
    assert.equal((await spotOpenNotifications()).length, 2, 'the second owner is told too');
  }),
);

test(
  'the override and the ruling-4 sweep must agree about a session that has already started',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    // Today's session: drop-off opened at 07:30 Chicago, the clock says 12:00.
    // The route allows it ("walking a dog in this morning"); the ruling-4 sweep
    // kills any live entry whose session has begun. Both cannot be right, and
    // the offer is the loser — staff push a seat, the next tick cancels it out
    // from under the owner. Either the override refuses the entry, or the entry
    // it produces survives the sweep.
    await seedDayEntry({
      id: ENTRY_A,
      sessionDate: TODAY_CHICAGO,
      createdAt: '2026-05-18T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });

    const res = await offer(staffApp(), ENTRY_A);
    if (res.statusCode !== 200) {
      assert.equal(
        res.statusCode,
        409,
        `refusing a started session is a conflict, not ${res.statusCode}: ${res.body}`,
      );
      return;
    }

    await withActor('system:scheduler', (tx) => cancelEntriesForStartedSessions(tx, FIXTURE_TODAY));
    assert.equal(
      (await readEntry(ENTRY_A))?.status,
      'offered',
      'the override accepted this entry, so the ruling-4 sweep must not immediately cancel the ' +
        'offer it just made — `routes/staffWaitlist.ts` only rejects session_date < today, while ' +
        '`waitlistPromotion.cancelEntriesForStartedSessions` (and `promoteForTarget`) treat the ' +
        '07:30 drop-off opening as the cut-off. One of the two has to move.',
    );
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// Group classes
// ──────────────────────────────────────────────────────────────────────────

test(
  'a group-class queue groups by cohort, and the offer it hands out is one the app cannot accept yet',
  SKIP_WHEN_NO_DB,
  waitlistCase(async () => {
    await seedCohortEntry({
      id: ENTRY_A,
      createdAt: '2026-05-18T10:00:00Z',
      dogId: FIXTURE_IDS.dog1Id,
    });

    const listed = await staffApp().inject({ method: 'GET', url: '/staff/waitlist' });
    assert.equal(listed.statusCode, 200, listed.body);
    const { queues } = listed.json() as { queues: StaffQueueWire[] };
    const queue = queues.find((q) => q.cohort_id === COHORT_ID);
    assert.ok(queue !== undefined, `no cohort queue: ${JSON.stringify(queues)}`);
    assert.equal(queue.category, 'group-class');
    assert.equal(queue.session_date, undefined, 'a cohort queue is keyed by cohort, not by date');
    assert.deepEqual(
      queue.entries.map((e) => [e.id, e.position]),
      [[ENTRY_A, 1]],
    );

    const res = await offer(staffApp(), ENTRY_A);
    assert.equal(res.statusCode, 200, res.body);
    assert.match(
      (await spotOpenNotifications())[0]?.body ?? '',
      /group class/i,
      'the copy names what opened up',
    );

    // Pinned deliberately: the owner route cannot turn a cohort offer into an
    // enrollment yet (`routes/waitlist.ts` TODO(waitlist-group-class)), so this
    // override is a dead end that reaches the owner as a push. When that TODO
    // lands this assertion flips to 201 — and someone re-reads the staff side.
    const accepted = await accept(ownerApp(), ENTRY_A);
    assert.equal(accepted.statusCode, 409, accepted.body);
    assert.match((accepted.json() as ErrorEnvelope).error.message, /group-class/i);
    assert.equal(
      (await readEntry(ENTRY_A))?.status,
      'offered',
      'the refused accept leaves the offer standing',
    );
  }),
);
