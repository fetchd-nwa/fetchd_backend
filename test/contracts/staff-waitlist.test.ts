import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  bookings,
  dayCapacity,
  scheduledNotifications,
  waitlistEntries,
  waitlistEntryDogs,
} from '../../src/db/schema/schema.js';
import { registerStaffWaitlistRoutes } from '../../src/routes/staffWaitlist.js';
import { FIXTURE_IDS, FIXTURE_NOW, futureWeekday } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Contract tests for the staff cap-override surface (Allison 2026-07-30
 * ruling 2):
 *   - GET  /staff/waitlist
 *   - POST /staff/waitlist/:id/offer
 *
 * The load-bearing assertion is the override itself: the target day is seeded
 * FULL (one opening, already taken by a real booking), and the offer still
 * succeeds. That is the difference between this verb and the automatic
 * promotion path, expressed as a test.
 *
 * FULL, not CLOSED (Δ 2026-07-31). The override skips the CAPACITY check and
 * nothing else, and `openings = 0` is not a capacity fact — it means the school
 * does not run that day. An offer there is one the owner can never accept: the
 * accept path books through `assertCapacityWithinLock`, which refuses a day
 * with no openings, so the only thing the offer would produce is a push
 * notification for a seat that does not exist. Both other waitlist surfaces
 * (`POST /waitlist`'s join check and `promoteForTarget`) already drew that
 * line; the override now draws it too, and the case below pins the 409.
 */

registerFixtureHooks();

const LOCATION = 'fayetteville';
const SESSION_DATE = futureWeekday(3);

/** Deterministic ids so teardown can drop exactly what a case seeded. */
const ENTRY_FIRST = '5e1f0000-0000-4000-8000-00000000a001';
const ENTRY_SECOND = '5e1f0000-0000-4000-8000-00000000a002';
const ENTRY_OTHER_DAY = '5e1f0000-0000-4000-8000-00000000a003';
const ENTRY_PAST = '5e1f0000-0000-4000-8000-00000000a004';
const SEEDED_ENTRY_IDS = [ENTRY_FIRST, ENTRY_SECOND, ENTRY_OTHER_DAY, ENTRY_PAST];

interface QueueWire {
  category: string;
  session_date?: string;
  location?: string;
  cohort_id?: string;
  entries: EntryWire[];
}

interface EntryWire {
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

function staffApp(principal = FIXTURE_STAFF_PRINCIPAL): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffWaitlistRoutes(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

/**
 * Seed one waiting entry with an explicit `created_at` so FIFO order is a
 * property of the fixture rather than of insert timing.
 */
async function seedEntry(args: {
  id: string;
  sessionDate: string;
  createdAt: string;
  dogIds: readonly string[];
}): Promise<void> {
  const [lead] = args.dogIds;
  if (lead === undefined) throw new Error('seedEntry needs at least one dog');
  await db.insert(waitlistEntries).values({
    id: args.id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: lead,
    category: 'day-school',
    status: 'waiting',
    sessionDate: args.sessionDate,
    location: LOCATION,
    mode: 'school',
    createdAt: args.createdAt,
  });
  await db.insert(waitlistEntryDogs).values(
    args.dogIds.map((dogId) => ({
      waitlistEntryId: args.id,
      dogId,
      isLead: dogId === lead,
    })),
  );
}

async function setOpenings(date: string, schoolOpenings: number): Promise<void> {
  await db
    .insert(dayCapacity)
    .values({ location: LOCATION, date, schoolOpenings, daycareOpenings: 0 })
    .onConflictDoUpdate({
      target: [dayCapacity.location, dayCapacity.date],
      set: { schoolOpenings, daycareOpenings: 0 },
    });
}

/** A day with ZERO openings — the school does not run at all. */
async function seedClosedDay(date: string): Promise<void> {
  await setOpenings(date, 0);
}

/** Bookings this file creates to consume seats; dropped by id on reset. */
const seededBookingIds: string[] = [];

/**
 * One opening, already taken by a real booking: the day is FULL, which is the
 * state an honest waitlist entry is actually created in (`POST /waitlist`
 * refuses to queue anyone for a day with seats left, or for a closed one).
 */
async function seedFullDay(date: string, dogId: string): Promise<void> {
  await setOpenings(date, 1);
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
  seededBookingIds.push(id);
}

async function resetWaitlist(): Promise<void> {
  await db.delete(waitlistEntryDogs).where(inArray(waitlistEntryDogs.waitlistEntryId, SEEDED_ENTRY_IDS));
  await db.delete(waitlistEntries).where(inArray(waitlistEntries.id, SEEDED_ENTRY_IDS));
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  if (seededBookingIds.length > 0) {
    await db.delete(bookingDogs).where(inArray(bookingDogs.bookingId, seededBookingIds));
    await db.delete(bookings).where(inArray(bookings.id, seededBookingIds));
    seededBookingIds.length = 0;
  }
}

async function seedTwoDeepQueue(): Promise<void> {
  await resetWaitlist();
  await seedFullDay(SESSION_DATE, FIXTURE_IDS.dog1Id);
  await seedEntry({
    id: ENTRY_FIRST,
    sessionDate: SESSION_DATE,
    createdAt: '2026-05-18T10:00:00Z',
    dogIds: [FIXTURE_IDS.dog1Id],
  });
  await seedEntry({
    id: ENTRY_SECOND,
    sessionDate: SESSION_DATE,
    createdAt: '2026-05-18T11:00:00Z',
    dogIds: [FIXTURE_IDS.dog2Id],
  });
}

function offer(
  app: ReturnType<typeof staffApp>,
  id: string,
  body: Record<string, unknown> = {},
): ReturnType<ReturnType<typeof staffApp>['inject']> {
  return app.inject({
    method: 'POST',
    url: `/staff/waitlist/${id}/offer`,
    headers: { 'idempotency-key': randomUUID() },
    payload: body,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// GET /staff/waitlist
// ──────────────────────────────────────────────────────────────────────────

test('GET /staff/waitlist — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const app = staffApp(FIXTURE_OWNER_PRINCIPAL);
  const res = await app.inject({ method: 'GET', url: '/staff/waitlist' });
  assert.equal(res.statusCode, 403, res.body);
});

test(
  'GET /staff/waitlist — groups by target, FIFO, 1-based positions',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedTwoDeepQueue();
    await seedEntry({
      id: ENTRY_OTHER_DAY,
      sessionDate: futureWeekday(4),
      createdAt: '2026-05-18T09:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });

    const res = await staffApp().inject({ method: 'GET', url: '/staff/waitlist' });
    assert.equal(res.statusCode, 200, res.body);
    const { queues } = res.json() as { queues: QueueWire[] };

    const target = queues.find((q) => q.session_date === SESSION_DATE);
    assert.ok(target !== undefined, `no queue for ${SESSION_DATE}: ${JSON.stringify(queues)}`);
    assert.equal(target.location, LOCATION);
    assert.equal(target.category, 'day-school');
    assert.deepEqual(
      target.entries.map((e) => [e.id, e.position]),
      [
        [ENTRY_FIRST, 1],
        [ENTRY_SECOND, 2],
      ],
      'FIFO by created_at, positions 1-based',
    );
    assert.deepEqual(target.entries[0]?.dog_ids, [FIXTURE_IDS.dog1Id]);
    assert.equal(target.entries[0]?.owner_id, FIXTURE_IDS.ownerId);

    // A different day is a different shortage — it must not share a queue.
    const otherDay = queues.find((q) => q.session_date === futureWeekday(4));
    assert.ok(otherDay !== undefined, 'the second day should be its own queue');
    assert.equal(otherDay.entries.length, 1);

    await resetWaitlist();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/waitlist/:id/offer
// ──────────────────────────────────────────────────────────────────────────

test('POST /staff/waitlist/:id/offer — owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  await seedTwoDeepQueue();
  const res = await offer(staffApp(FIXTURE_OWNER_PRINCIPAL), ENTRY_FIRST);
  assert.equal(res.statusCode, 403, res.body);
  await resetWaitlist();
});

test(
  'POST /staff/waitlist/:id/offer — overrides a FULL day and records the staff actor',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedTwoDeepQueue();

    // Skips the head of the line on purpose: staff chose entry #2. The day's
    // one seat is already booked, so nothing but the override could produce
    // this offer — the automatic pass sees zero free seats.
    const res = await offer(staffApp(), ENTRY_SECOND);
    assert.equal(res.statusCode, 200, res.body);
    const wire = res.json() as EntryWire;
    assert.equal(wire.id, ENTRY_SECOND);
    assert.equal(wire.status, 'offered');
    assert.equal(wire.offered_by_staff_id, FIXTURE_IDS.staffDonavanId);
    assert.equal(wire.position, 2, 'an offered entry keeps its place in line');
    assert.ok(wire.offer_expires_at !== undefined, 'an offer without a deadline deadlocks the queue');
    assert.equal(
      wire.offer_expires_at,
      new Date(FIXTURE_NOW().getTime() + 24 * 3_600_000).toISOString(),
      'default offer window is 24h from now',
    );

    const [row] = await db
      .select({
        status: waitlistEntries.status,
        offeredAt: waitlistEntries.offeredAt,
        offerExpiresAt: waitlistEntries.offerExpiresAt,
        offeredByStaffId: waitlistEntries.offeredByStaffId,
      })
      .from(waitlistEntries)
      .where(eq(waitlistEntries.id, ENTRY_SECOND));
    assert.equal(row?.status, 'offered');
    assert.equal(row?.offeredByStaffId, FIXTURE_IDS.staffDonavanId);
    assert.ok(row?.offeredAt !== null, 'schema CHECK requires offered_at on an offered row');
    assert.ok(row?.offerExpiresAt !== null, 'schema CHECK requires offer_expires_at');

    // The head of the queue is untouched — an override offers ONE entry.
    const [head] = await db
      .select({ status: waitlistEntries.status })
      .from(waitlistEntries)
      .where(eq(waitlistEntries.id, ENTRY_FIRST));
    assert.equal(head?.status, 'waiting');

    await resetWaitlist();
  },
);

test(
  'POST /staff/waitlist/:id/offer — enqueues the waitlist-spot-open notification',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedTwoDeepQueue();
    const res = await offer(staffApp(), ENTRY_FIRST);
    assert.equal(res.statusCode, 200, res.body);

    const queued = await db
      .select({
        type: scheduledNotifications.type,
        trigger: scheduledNotifications.trigger,
        dedupeKey: scheduledNotifications.dedupeKey,
        title: scheduledNotifications.title,
        body: scheduledNotifications.body,
        deepLinkPath: scheduledNotifications.deepLinkPath,
        deepLinkKind: scheduledNotifications.deepLinkKind,
        deepLinkId: scheduledNotifications.deepLinkId,
        dogId: scheduledNotifications.dogId,
      })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
    assert.equal(queued.length, 1, 'exactly one notification per offer');
    const note = queued[0];
    assert.equal(note?.type, 'waitlist-spot-open');
    assert.equal(note?.trigger, 'waitlist-staff-override', 'provenance: a human overrode the cap');
    assert.equal(note?.deepLinkKind, 'waitlist');
    assert.equal(note?.deepLinkId, ENTRY_FIRST);
    assert.equal(
      note?.deepLinkPath,
      `/waitlist/${ENTRY_FIRST}`,
      'deep-links at the OFFER, not a booking that does not exist yet',
    );
    assert.equal(note?.dogId, FIXTURE_IDS.dog1Id);
    assert.match(note?.body ?? '', /nothing is charged until you accept/i);
    assert.ok(
      (note?.dedupeKey ?? '').startsWith(`waitlist-spot-open:${ENTRY_FIRST}:`),
      `dedupe key should be per-offer, got ${String(note?.dedupeKey)}`,
    );

    await resetWaitlist();
  },
);

test('POST /staff/waitlist/:id/offer — honors offer_expires_in_hours', SKIP_WHEN_NO_DB, async () => {
  await seedTwoDeepQueue();
  const res = await offer(staffApp(), ENTRY_FIRST, { offer_expires_in_hours: 2 });
  assert.equal(res.statusCode, 200, res.body);
  const wire = res.json() as EntryWire;
  assert.equal(
    wire.offer_expires_at,
    new Date(FIXTURE_NOW().getTime() + 2 * 3_600_000).toISOString(),
  );
  await resetWaitlist();
});

test(
  'POST /staff/waitlist/:id/offer — clamps the deadline to the session start',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedTwoDeepQueue();
    // A week is far past drop-off on SESSION_DATE. An offer that outlived the
    // session could never be accepted and would hold the seat until then
    // instead of rolling to someone who could still use it — the same clamp
    // `promoteForTarget` applies.
    const res = await offer(staffApp(), ENTRY_FIRST, { offer_expires_in_hours: 168 });
    assert.equal(res.statusCode, 200, res.body);
    const wire = res.json() as EntryWire;
    assert.equal(
      wire.offer_expires_at,
      // 07:30 America/Chicago (CDT, UTC-5) = 12:30Z — the drop-off window's
      // opening, the earliest the seat could be used.
      `${SESSION_DATE}T12:30:00.000Z`,
    );
    await resetWaitlist();
  },
);

test(
  'POST /staff/waitlist/:id/offer — a CLOSED day → 409 (the cap override is not a closed-day override)',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedTwoDeepQueue();
    // Zero openings is not a capacity fact — the school does not run. Accepting
    // would have to book into a day with no seats at all, so the offer would be
    // a notification for something the owner can never take.
    await seedClosedDay(SESSION_DATE);

    const res = await offer(staffApp(), ENTRY_FIRST);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'conflict');

    const [row] = await db
      .select({ status: waitlistEntries.status })
      .from(waitlistEntries)
      .where(eq(waitlistEntries.id, ENTRY_FIRST));
    assert.equal(row?.status, 'waiting', 'the refused offer must not have moved the entry');
    await resetWaitlist();
  },
);

test('POST /staff/waitlist/:id/offer — unknown id → 404', SKIP_WHEN_NO_DB, async () => {
  const res = await offer(staffApp(), '5e1f0000-0000-4000-8000-0000000000ff');
  assert.equal(res.statusCode, 404, res.body);
});

test(
  'POST /staff/waitlist/:id/offer — an already-offered entry → 404',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedTwoDeepQueue();
    assert.equal((await offer(staffApp(), ENTRY_FIRST)).statusCode, 200);
    // A fresh Idempotency-Key, so this is a genuine second attempt rather than
    // a replay — the status guard, not the idempotency layer, must reject it.
    const second = await offer(staffApp(), ENTRY_FIRST);
    assert.equal(second.statusCode, 404, second.body);
    await resetWaitlist();
  },
);

test(
  'POST /staff/waitlist/:id/offer — a session that already passed → 409',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetWaitlist();
    await seedEntry({
      id: ENTRY_PAST,
      // FIXTURE_NOW is 2026-05-19; this day is behind it.
      sessionDate: '2026-05-11',
      createdAt: '2026-05-01T10:00:00Z',
      dogIds: [FIXTURE_IDS.dog1Id],
    });
    const res = await offer(staffApp(), ENTRY_PAST);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'conflict');
    await resetWaitlist();
  },
);

test(
  'POST /staff/waitlist/:id/offer — offer_expires_in_hours out of range → 400',
  SKIP_WHEN_NO_DB,
  async () => {
    await seedTwoDeepQueue();
    const res = await offer(staffApp(), ENTRY_FIRST, { offer_expires_in_hours: 0 });
    assert.equal(res.statusCode, 400, res.body);
    await resetWaitlist();
  },
);
