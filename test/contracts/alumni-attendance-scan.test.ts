import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray, like } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  bookings,
  dogCompletedPrograms,
  dogs,
  notifications,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { CURRICULUM_PROGRAMS, previousChicagoMonthWindow } from '../../src/lib/alumni.js';
import { enqueueAlumniAttendanceFlags } from '../../src/lib/alumniAttendanceScan.js';
import { withActor } from '../../src/db/tx.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';

/**
 * §J.3 monthly alumni-attendance scan (`enqueueAlumniAttendanceFlags`).
 *
 * Invariants under test:
 *   - self-gates: any day but the 1st (Chicago) is a no-op (`ran: false`)
 *   - an alumni dog with <2 attended qualifying sessions in the closed month
 *     gets ONE `alumni-attendance` notification + the dogs flag stamped
 *   - a second tick the same month deduplicates (no re-enqueue, no re-stamp)
 *   - a staff clear mid-month is NOT re-flagged by a later same-month tick
 *     (the dedupe row doubles as the once-per-month guard)
 *   - >=2 attended qualifying sessions ⇒ no flag; non-qualifying categories
 *     (private lessons) don't count
 *   - `previousChicagoMonthWindow` uses CHICAGO month bounds (DST-correct)
 */

registerFixtureHooks();

const SCAN_ACTOR = 'system:scheduler';
// July 1 2026, 07:00 Chicago (CDT) — the 1st, mid-morning.
const FIRST_OF_JULY = new Date('2026-07-01T12:00:00Z');

async function makeDog1Alumni(): Promise<void> {
  await db.delete(dogCompletedPrograms).where(eq(dogCompletedPrograms.dogId, FIXTURE_IDS.dog1Id));
  await db
    .insert(dogCompletedPrograms)
    .values(CURRICULUM_PROGRAMS.map((program) => ({ dogId: FIXTURE_IDS.dog1Id, program })));
}

async function resetScanState(): Promise<void> {
  await db
    .update(scheduledNotifications)
    .set({ emittedNotificationId: null })
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(notifications).where(eq(notifications.ownerId, FIXTURE_IDS.ownerId));
  await db
    .delete(scheduledNotifications)
    .where(like(scheduledNotifications.dedupeKey, 'alumni-attendance:%'));
  await db
    .update(dogs)
    .set({ alumniAttendanceFlaggedAt: null })
    .where(eq(dogs.id, FIXTURE_IDS.dog1Id));
}

async function dog1Flag(): Promise<string | null> {
  const [row] = await db
    .select({ flaggedAt: dogs.alumniAttendanceFlaggedAt })
    .from(dogs)
    .where(eq(dogs.id, FIXTURE_IDS.dog1Id));
  return row?.flaggedAt ?? null;
}

async function seedAttendedBookings(
  category: 'day-school' | 'private-lesson',
  scheduledAtIsos: string[],
): Promise<string[]> {
  const ids = scheduledAtIsos.map(() => randomUUID());
  await db.insert(bookings).values(
    scheduledAtIsos.map((scheduledAt, i) => ({
      id: ids[i]!,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category,
      status: 'past' as const,
      scheduledAt,
      durationMinutes: 60,
      location: 'fayetteville' as const,
    })),
  );
  await db.insert(bookingDogs).values(
    ids.map((bookingId) => ({
      bookingId,
      dogId: FIXTURE_IDS.dog1Id,
      isLead: true,
      attendance: 'attended' as const,
    })),
  );
  return ids;
}

async function deleteBookings(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(bookings).where(inArray(bookings.id, ids)); // booking_dogs cascades
}

test('previousChicagoMonthWindow — Chicago month bounds, incl. the January wrap', () => {
  const july = previousChicagoMonthWindow(FIRST_OF_JULY);
  assert.equal(july.monthKey, '2026-06');
  // Chicago midnight in June/July is CDT (UTC-5).
  assert.equal(july.startUtc.toISOString(), '2026-06-01T05:00:00.000Z');
  assert.equal(july.endUtc.toISOString(), '2026-07-01T05:00:00.000Z');

  const january = previousChicagoMonthWindow(new Date('2026-01-01T12:00:00Z'));
  assert.equal(january.monthKey, '2025-12');
  // December midnights are CST (UTC-6).
  assert.equal(january.startUtc.toISOString(), '2025-12-01T06:00:00.000Z');
  assert.equal(january.endUtc.toISOString(), '2026-01-01T06:00:00.000Z');
});

test('scan — self-gates off the 1st (Chicago)', SKIP_WHEN_NO_DB, async () => {
  await makeDog1Alumni();
  await resetScanState();
  // July 15 — an alumni dog with zero attendance, but not the 1st.
  const result = await withActor(SCAN_ACTOR, (tx) =>
    enqueueAlumniAttendanceFlags(tx, new Date('2026-07-15T12:00:00Z')),
  );
  assert.deepEqual(result, { ran: false, scanned: 0, enqueued: 0, flagged: 0 });
  assert.equal(await dog1Flag(), null);
});

test(
  'scan — under-attended alumni dog: one notification + flag; same-month dedupe; staff clear not re-flagged',
  SKIP_WHEN_NO_DB,
  async () => {
    await makeDog1Alumni();
    await resetScanState();

    const first = await withActor(SCAN_ACTOR, (tx) =>
      enqueueAlumniAttendanceFlags(tx, FIRST_OF_JULY),
    );
    assert.equal(first.ran, true);
    assert.equal(first.scanned, 1, 'dog1 is the only alumni dog');
    assert.equal(first.enqueued, 1);
    assert.equal(first.flagged, 1);

    const flaggedAt = await dog1Flag();
    assert.ok(flaggedAt, 'flag stamped');

    const dedupeKey = `alumni-attendance:${FIXTURE_IDS.dog1Id}:2026-06`;
    const scheduled = await db
      .select({ type: scheduledNotifications.type, dogId: scheduledNotifications.dogId })
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, dedupeKey));
    assert.equal(scheduled.length, 1, 'exactly one scheduled row under the month key');
    assert.equal(scheduled[0]!.type, 'alumni-attendance');
    assert.equal(scheduled[0]!.dogId, FIXTURE_IDS.dog1Id);

    // Second tick, same month: dedupe blocks the enqueue AND the re-stamp.
    const second = await withActor(SCAN_ACTOR, (tx) =>
      enqueueAlumniAttendanceFlags(tx, FIRST_OF_JULY),
    );
    assert.equal(second.enqueued, 0, 'DEDUP: no second notification');
    assert.equal(second.flagged, 0);
    assert.equal(await dog1Flag(), flaggedAt, 'flag timestamp unchanged');

    // Staff clear mid-month → a later same-month tick must NOT re-flag
    // (the dedupe row is the once-per-month guard).
    await db
      .update(dogs)
      .set({ alumniAttendanceFlaggedAt: null })
      .where(eq(dogs.id, FIXTURE_IDS.dog1Id));
    const afterClear = await withActor(SCAN_ACTOR, (tx) =>
      enqueueAlumniAttendanceFlags(tx, FIRST_OF_JULY),
    );
    assert.equal(afterClear.enqueued, 0);
    assert.equal(afterClear.flagged, 0);
    assert.equal(await dog1Flag(), null, 'staff clear survives same-month re-scans');

    await resetScanState();
  },
);

test(
  'scan — 2 attended qualifying sessions keep the dog unflagged; private lessons do not count',
  SKIP_WHEN_NO_DB,
  async () => {
    await makeDog1Alumni();
    await resetScanState();

    // Two attended day-school sessions inside June (Chicago) + two attended
    // private lessons (non-qualifying — must not rescue attendance).
    const qualifying = await seedAttendedBookings('day-school', [
      '2026-06-10T13:00:00Z',
      '2026-06-17T13:00:00Z',
    ]);
    const nonQualifying = await seedAttendedBookings('private-lesson', [
      '2026-06-11T15:00:00Z',
      '2026-06-18T15:00:00Z',
    ]);

    const result = await withActor(SCAN_ACTOR, (tx) =>
      enqueueAlumniAttendanceFlags(tx, FIRST_OF_JULY),
    );
    assert.equal(result.scanned, 1);
    assert.equal(result.enqueued, 0, '2 qualifying attended ⇒ no notification');
    assert.equal(await dog1Flag(), null);

    // Drop one qualifying session → 1 attended ⇒ flagged (and the 2 private
    // lessons still don't count).
    await deleteBookings([qualifying[1]!]);
    await resetScanState(); // fresh month state (dedupe row from nothing — none yet)
    const under = await withActor(SCAN_ACTOR, (tx) =>
      enqueueAlumniAttendanceFlags(tx, FIRST_OF_JULY),
    );
    assert.equal(under.enqueued, 1, '1 qualifying + 2 private ⇒ under the floor');
    assert.equal(under.flagged, 1);

    await deleteBookings([qualifying[0]!, ...nonQualifying]);
    await resetScanState();
    await db.delete(dogCompletedPrograms).where(eq(dogCompletedPrograms.dogId, FIXTURE_IDS.dog1Id));
  },
);
