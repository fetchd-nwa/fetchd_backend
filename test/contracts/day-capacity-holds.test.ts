import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dayCapacityRepository } from '../../src/db/repositories/dayCapacityRepository.js';
import { dayCapacity, dogs, waitlistEntries, waitlistEntryDogs } from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { ApiError } from '../../src/lib/errors.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import type { WaitlistStatus } from '../../src/db/repositories/waitlistRepository.js';

/**
 * An outstanding waitlist offer HOLDS its seat (Allison 2026-07-31).
 *
 * Before this, the hold lived only inside the waitlist's own arithmetic
 * (`waitlistRepository.countOfferedSeats`, read by promotion).
 * `dayCapacityRepository.capacityForDay` — which every day-program booking path
 * asserts against — counted booked dogs and knew nothing about
 * `waitlist_entries`. So the moment a seat was offered to family A with a 24h
 * deadline, family B could book it, and family A tapped Accept and got a 422
 * for a seat we had pushed them a notification about.
 *
 * What this file is the net for, in the order the money gets lost:
 *
 *   - **The hold is real on the booking path.** A held seat is subtracted from
 *     `remaining`, so `assertCapacityWithinLock` refuses family B — with the
 *     unchanged `insufficient_capacity` code and details shape.
 *   - **The hold releases at exactly the right moments and no others.** A
 *     'waiting' entry holds nothing (it was never promised anything); a
 *     resolved entry holds nothing (the offer is over, whichever way it went).
 *   - **The hold does not block its own conversion.** Accept books BEFORE it
 *     flips the entry to 'accepted', so for the length of that transaction the
 *     same seat is both held and being booked. `convertingWaitlistEntryId` is
 *     what stops the accepting owner being refused their own seat — the exact
 *     inversion of the bug being fixed, so it gets its own test.
 *   - **`held` and `used` count the same dogs.** `used` exempts staff-owned
 *     dogs; if `held` didn't, a staff dog on an offer would silently eat a
 *     paying customer's seat.
 *   - **The hold is scoped to one queue.** A different day, mode or location is
 *     a different thing there is a shortage of.
 *
 * Entries are inserted directly rather than through `POST /waitlist`: the join
 * gates are not under test here, the capacity arithmetic is.
 */

// Registered BEFORE `registerFixtureHooks` so it runs ahead of
// `teardownFixture` (node:test runs `after` hooks in registration order): this
// file's rows hang off the fixture owner and must go first.
if (SKIP_WHEN_NO_DB.skip === false) after(clearHoldState);
registerFixtureHooks();

/** `<kind>:<id>`, the shape `actorOf(principal)` produces for an owner. */
const OWNER_ACTOR = `owner:${FIXTURE_IDS.ownerId}`;

/** Thursday, well clear of every fixture booking — a blank capacity canvas. */
const TEST_DAY = '2026-05-28';
/** The next day, for the "a hold is scoped to its own queue" case. */
const OTHER_DAY = '2026-05-29';
const MANAGED_DAYS = [TEST_DAY, OTHER_DAY];

/**
 * A staff-owned dog. `dogs.capacity_exempt` is generated from
 * `staff_owner_id IS NOT NULL`, so this row is the whole "held and used count
 * the same population" test.
 */
const STAFF_DOG_ID = '33333333-3333-4333-8333-3333333330ff';

const seededEntryIds: string[] = [];

async function clearHoldState(): Promise<void> {
  if (seededEntryIds.length > 0) {
    await db.delete(waitlistEntries).where(inArray(waitlistEntries.id, seededEntryIds));
    seededEntryIds.length = 0;
  }
  await db.delete(dogs).where(eq(dogs.id, STAFF_DOG_ID));
  await db
    .delete(dayCapacity)
    .where(and(eq(dayCapacity.location, 'fayetteville'), inArray(dayCapacity.date, MANAGED_DAYS)));
}

/** A clean world: no leftover entries, the staff dog back in place, days sized. */
async function resetDays(openings: { school: number; daycare?: number }): Promise<void> {
  await clearHoldState();
  await db.insert(dogs).values({
    id: STAFF_DOG_ID,
    staffOwnerId: FIXTURE_IDS.staffDonavanId,
    name: 'Ranger',
    breed: 'Malinois',
    ageMonthsOverride: 60,
  });
  await db.insert(dayCapacity).values(
    MANAGED_DAYS.map((date) => ({
      location: 'fayetteville' as const,
      date,
      schoolOpenings: openings.school,
      daycareOpenings: openings.daycare ?? openings.school,
    })),
  );
}

async function seedEntry(args: {
  status: WaitlistStatus;
  sessionDate?: string;
  mode?: 'school' | 'daycare';
  dogIds: readonly string[];
}): Promise<string> {
  const mode = args.mode ?? 'school';
  const leadDogId = args.dogIds[0];
  if (leadDogId === undefined) throw new Error('seedEntry: dogIds must not be empty');
  const offered = args.status === 'offered';
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId,
      category: mode === 'school' ? 'day-school' : 'day-care',
      status: args.status,
      sessionDate: args.sessionDate ?? TEST_DAY,
      location: 'fayetteville',
      mode,
      // `waitlist_offer_has_deadline` CHECKs that an 'offered' row carries both.
      ...(offered
        ? {
            offeredAt: '2026-05-19T15:00:00Z',
            offerExpiresAt: '2026-05-20T15:00:00Z',
          }
        : {}),
      // `waitlist_accepted_has_booking`: 'accepted' implies the booking it
      // became. Any live booking satisfies it — this file never reads it back.
      ...(args.status === 'accepted' ? { bookingId: FIXTURE_IDS.booking1Id } : {}),
    })
    .returning({ id: waitlistEntries.id });
  if (row === undefined) throw new Error('seedEntry: insert returned no row');
  seededEntryIds.push(row.id);
  await db.insert(waitlistEntryDogs).values(
    args.dogIds.map((dogId) => ({
      waitlistEntryId: row.id,
      dogId,
      isLead: dogId === leadDogId,
    })),
  );
  return row.id;
}

/** `capacityForDay` for the school queue on `TEST_DAY`, read inside a real tx. */
async function schoolCapacity(
  convertingWaitlistEntryId?: string,
): Promise<{ openings: number; used: number; held: number; remaining: number }> {
  return withActor(OWNER_ACTOR, (tx) =>
    dayCapacityRepository.capacityForDay(tx, {
      location: 'fayetteville',
      date: TEST_DAY,
      mode: 'school',
      ...(convertingWaitlistEntryId === undefined ? {} : { convertingWaitlistEntryId }),
    }),
  );
}

test(
  'an outstanding offer holds its seats: capacityForDay reports them as held and subtracts them',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDays({ school: 3 });
    await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id] });

    const capacity = await schoolCapacity();
    assert.deepStrictEqual(capacity, { openings: 3, used: 0, held: 2, remaining: 1 });
  },
);

test('a waiting entry holds nothing — it was never promised a seat', SKIP_WHEN_NO_DB, async () => {
  await resetDays({ school: 3 });
  await seedEntry({ status: 'waiting', dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id] });

  const capacity = await schoolCapacity();
  assert.deepStrictEqual(capacity, { openings: 3, used: 0, held: 0, remaining: 3 });
});

test('a resolved entry releases its hold, whichever way it went', SKIP_WHEN_NO_DB, async () => {
  for (const status of ['accepted', 'declined', 'expired', 'cancelled'] as const) {
    await resetDays({ school: 3 });
    await seedEntry({ status, dogIds: [FIXTURE_IDS.dog1Id] });

    const capacity = await schoolCapacity();
    assert.deepStrictEqual(
      capacity,
      { openings: 3, used: 0, held: 0, remaining: 3 },
      `a '${status}' entry must not hold a seat`,
    );
  }
});

test(
  'the last seat being held is insufficient_capacity for anyone else, with the unchanged details shape',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDays({ school: 1 });
    await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog1Id] });

    const thrown = await withActor(OWNER_ACTOR, (tx) =>
      dayCapacityRepository
        .assertCapacityWithinLock(tx, {
          location: 'fayetteville',
          date: TEST_DAY,
          mode: 'school',
          requestedCount: 1,
        })
        .then(
          () => undefined,
          (err: unknown) => err,
        ),
    );

    assert.ok(
      thrown instanceof ApiError,
      'booking the one seat an outstanding offer is holding must be refused',
    );
    assert.equal(thrown.code, 'insufficient_capacity');
    assert.deepStrictEqual(thrown.details, {
      kind: 'insufficient_capacity',
      location: 'fayetteville',
      date: TEST_DAY,
      mode: 'school',
      openings_remaining: 0,
      requested: 1,
    });
  },
);

test(
  'a conversion is not blocked by the hold its own offer placed',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDays({ school: 1 });
    const entryId = await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog1Id] });

    // Everyone else sees a full day...
    assert.deepStrictEqual(await schoolCapacity(), {
      openings: 1,
      used: 0,
      held: 1,
      remaining: 0,
    });
    // ...but the transaction turning THAT offer into a booking sees its seat.
    assert.deepStrictEqual(await schoolCapacity(entryId), {
      openings: 1,
      used: 0,
      held: 0,
      remaining: 1,
    });

    // And the assertion the accept path runs passes for the one dog it books.
    await withActor(OWNER_ACTOR, (tx) =>
      dayCapacityRepository.assertCapacityWithinLock(tx, {
        location: 'fayetteville',
        date: TEST_DAY,
        mode: 'school',
        requestedCount: 1,
        convertingWaitlistEntryId: entryId,
      }),
    );
  },
);

test(
  'converting one offer does not release anyone ELSE’s hold',
  SKIP_WHEN_NO_DB,
  async () => {
    // A seat promised to another family is not one this booking may spend. The
    // over-promised case (two offers, one seat — what a staff cap override
    // deliberately creates) is handled by `allowOverCapacity` in
    // `createDayProgramBookings`, not by loosening this count.
    await resetDays({ school: 2 });
    const mine = await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog1Id] });
    await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog2Id] });

    assert.deepStrictEqual(await schoolCapacity(mine), {
      openings: 2,
      used: 0,
      held: 1,
      remaining: 1,
    });
  },
);

test(
  'a staff-owned dog on an offer holds nothing — held counts the same dogs used does',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDays({ school: 3 });
    await seedEntry({ status: 'offered', dogIds: [STAFF_DOG_ID] });

    const capacity = await schoolCapacity();
    assert.deepStrictEqual(capacity, { openings: 3, used: 0, held: 0, remaining: 3 });
  },
);

test('a hold is scoped to its own queue — date and mode both matter', SKIP_WHEN_NO_DB, async () => {
  await resetDays({ school: 3, daycare: 3 });
  await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog1Id], sessionDate: OTHER_DAY });
  await seedEntry({ status: 'offered', dogIds: [FIXTURE_IDS.dog2Id], mode: 'daycare' });

  const capacity = await schoolCapacity();
  assert.deepStrictEqual(capacity, { openings: 3, used: 0, held: 0, remaining: 3 });
});
