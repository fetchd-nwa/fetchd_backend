import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  bookingDogs as bookingDogsTable,
  dayCapacity as dayCapacityTable,
} from '../../src/db/schema/schema.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { registerAvailabilityRoute } from '../../src/routes/availability.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

test(
  'GET /availability byte-matches the §B DayCapacity wire shape (default rule + sparse overrides)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    // 7-day window: Fri/Sat/Sun/Mon/Tue/Wed/Thu starting 2026-05-15. Hits
    // both override rows (Sun OPEN @ 2026-05-17, Tue CLOSED @ 2026-05-19)
    // plus the weekend-closed default (Sat 2026-05-16) and four weekday
    // defaults (Fri/Mon/Wed/Thu = 3/3).
    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-21&mode=school&location=fayetteville',
    });
    if (res.statusCode !== 200) {
      throw new Error(`/availability returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('availability-fayetteville'));
  },
);

test(
  'GET /availability for bentonville falls through to defaults (no override rows)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-17&mode=daycare&location=bentonville',
    });
    if (res.statusCode !== 200) {
      throw new Error(`/availability returned ${res.statusCode}: ${res.body}`);
    }
    assert.deepStrictEqual(res.json(), loadSnapshot('availability-bentonville'));
  },
);

test(
  'GET /availability as staff returns the same data (catalog endpoint, no owner scoping)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-21&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), loadSnapshot('availability-fayetteville'));
  },
);

test('GET /availability with missing params returns 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerAvailabilityRoute(app, { authenticate });

  const res = await app.inject({ method: 'GET', url: '/availability?from=2026-05-15' });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'bad_request');
});

test(
  'GET /availability with bad date format returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=05/15/2026&to=2026-05-21&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test(
  'GET /availability with invalid enum value returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-21&mode=school&location=nowhere',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

test('GET /availability with from > to returns 422 invalid_payload', SKIP_WHEN_NO_DB, async () => {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerAvailabilityRoute(app, { authenticate });

  const res = await app.inject({
    method: 'GET',
    url: '/availability?from=2026-05-21&to=2026-05-15&mode=school&location=fayetteville',
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'invalid_payload');
});

test(
  'GET /availability over the 92-date cap returns 422 invalid_payload',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    // 93-day window — one day past the cap.
    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-01&to=2026-08-01&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'invalid_payload');
  },
);

test(
  'GET /availability skips a soft-expired override (live() filter), falling back to the default rule',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    // 2026-05-22 (Fri) has an EXPIRED override (0/0). The route should
    // emit weekday defaults 3/3 because `live(dayCapacity)` drops the
    // expired row before the override map is built.
    //
    // The `*_remaining` half of this row is load-bearing too: fixture
    // booking9 is a fayetteville day-school on exactly this date whose
    // status is `cancelled`. `school_remaining: 3` is the pin that the
    // booked count carries `ne(bookings.status, 'cancelled')` — a cancelled
    // booking must not hold a seat. Drop that predicate and this reads 2.
    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-22&to=2026-05-22&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), [
      {
        location: 'fayetteville',
        date: '2026-05-22',
        school_openings: 3,
        daycare_openings: 3,
        school_remaining: 3,
        daycare_remaining: 3,
      },
    ]);
  },
);

test(
  'GET /availability with semantically-invalid YYYY-MM-DD (2026-13-40) returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-13-40&to=2026-05-21&mode=school&location=fayetteville',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

// Wire 1.13.0 §5.4 guard: `mode` is validated against the contract tuple
// BOOKING_MODES instead of a re-derivation of the booking_mode pgEnum. The
// suite pinned a bad `location` but never a bad `mode`, so nothing would have
// caught the swap widening or narrowing the accepted set. Both members are
// exercised as accepted above (mode=school, mode=daycare).
test(
  'GET /availability with a non-member mode returns 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    const res = await app.inject({
      method: 'GET',
      url: '/availability?from=2026-05-15&to=2026-05-21&mode=boarding&location=fayetteville',
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'bad_request');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// `*_remaining` — the §6-batch #3 option-C fields (wire 1.13.0 fix round).
//
// These two tests RETIRE the phase-3 debt item "the runtime test that would
// stop 'configured, not remaining' from silently becoming false" (digest
// rates-availability test/S) by superseding it: the route no longer emits
// configured-only, and what it emits instead is pinned here against seeded
// bookings rather than against prose.
//
// `*_openings` stays the CONFIGURED cap in both — the additive field is the
// only thing that moves, which is what makes the 1.13.0 bump minor.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Seed one day-program booking (with `dogIds` as its `booking_dogs` roster)
 * plus a `day_capacity` override, and return the cleanup thunk.
 *
 * The writes go straight at the tables rather than through `POST /bookings`
 * so the counted population is stated outright — this suite asserts the
 * COUNT, not the booking flow. `13:00Z` is 08:00 America/Chicago in June
 * (CDT, UTC-5), so the row's Chicago calendar bucket is unambiguously
 * `date`: the same `(scheduled_at AT TIME ZONE 'America/Chicago')::date`
 * encoding `assertCapacityWithinLock` counts against.
 */
/** Insert one day-program booking at an exact instant. Returns its id. */
async function insertBookingAt(opts: {
  scheduledAtIso: string;
  category: 'day-school' | 'day-care';
  dogIds: string[];
}): Promise<string> {
  const bookingId = randomUUID();
  await db.insert(bookingsTable).values({
    id: bookingId,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: opts.dogIds[0]!,
    category: opts.category,
    status: 'upcoming',
    scheduledAt: opts.scheduledAtIso,
    durationMinutes: 540,
    location: 'fayetteville',
  });
  await db.insert(bookingDogsTable).values(
    opts.dogIds.map((dogId, i) => ({ bookingId, dogId, isLead: i === 0 })),
  );
  return bookingId;
}

async function seedBookedDay(opts: {
  date: string;
  category: 'day-school' | 'day-care';
  dogIds: string[];
  openings: { school: number; daycare: number };
}): Promise<() => Promise<void>> {
  await db.insert(dayCapacityTable).values({
    location: 'fayetteville',
    date: opts.date,
    schoolOpenings: opts.openings.school,
    daycareOpenings: opts.openings.daycare,
  });
  const bookingId = await insertBookingAt({
    scheduledAtIso: `${opts.date}T13:00:00Z`,
    category: opts.category,
    dogIds: opts.dogIds,
  });
  // The override read is cached (`avail:{location}:*`, 5 min); the booked
  // count deliberately is not. Wipe the prefix anyway so nothing this file
  // read earlier can serve a pre-seed override row.
  await invalidatePattern('avail:fayetteville:*');

  return async () => {
    await db.delete(bookingDogsTable).where(eq(bookingDogsTable.bookingId, bookingId));
    await db.delete(bookingsTable).where(eq(bookingsTable.id, bookingId));
    await db
      .delete(dayCapacityTable)
      .where(
        and(eq(dayCapacityTable.location, 'fayetteville'), eq(dayCapacityTable.date, opts.date)),
      );
    await invalidatePattern('avail:fayetteville:*');
  };
}

test(
  'GET /availability — a FULL day emits remaining 0 while openings stays the configured cap',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    // 2026-06-03 (Wed) configured at 2/2, then filled with a two-dog
    // day-school booking. Two seats configured, two dogs booked.
    const cleanup = await seedBookedDay({
      date: '2026-06-03',
      category: 'day-school',
      dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
      openings: { school: 2, daycare: 2 },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/availability?from=2026-06-03&to=2026-06-03&mode=school&location=fayetteville',
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepStrictEqual(res.json(), [
        {
          location: 'fayetteville',
          date: '2026-06-03',
          // The cap the staff configured — unchanged by the bookings. This
          // is the field three repos already share; it does NOT become
          // "remaining" (that was option B, rejected).
          school_openings: 2,
          daycare_openings: 2,
          // 2 configured − 2 booked = 0. The owner's calendar can finally
          // render this day full instead of walking her to the 422.
          school_remaining: 0,
          // …and the daycare axis is untouched: a day-school booking eats a
          // school seat only. Counting by `mode` is the half a naive
          // "count bookings on this date" would get wrong.
          daycare_remaining: 2,
        },
      ]);
    } finally {
      await cleanup();
    }
  },
);

test(
  'GET /availability — booked ABOVE the configured cap floors remaining at 0, never negative',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    // The override-shrink case, which is reachable in production: two dogs
    // book a day-care day at the 3/3 default, then staff shrink the day to
    // ONE daycare seat. openings(1) − booked(2) = −1.
    //
    // The wire promises a floor at 0 and mobile's `classifyStatus` compares
    // remaining against the selected dog count — a negative would still be
    // "< dogCount" today, but it would leak a nonsense number to the client
    // and invert the moment anyone writes `remaining > 0 ? … : …` on a
    // signed value. `Math.max(0, …)` is also exactly what the 422's
    // `openings_remaining` detail already does — applied in
    // `dayCapacityRepository.assertCapacityWithinLock` (:313), which feeds
    // `insufficientCapacityError` (`lib/bookingErrors.ts:119`) — so the
    // advisory read and the authoritative error agree on "full".
    const cleanup = await seedBookedDay({
      date: '2026-06-04',
      category: 'day-care',
      dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
      openings: { school: 3, daycare: 1 },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/availability?from=2026-06-04&to=2026-06-04&mode=daycare&location=fayetteville',
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepStrictEqual(res.json(), [
        {
          location: 'fayetteville',
          date: '2026-06-04',
          school_openings: 3,
          daycare_openings: 1,
          school_remaining: 3,
          daycare_remaining: 0,
        },
      ]);
    } finally {
      await cleanup();
    }
  },
);

test(
  'GET /availability — the booked window splits on CHICAGO midnight, including a DST day',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerAvailabilityRoute(app, { authenticate });

    // Guards the fix-round-2 rewrite of the date predicate from a Chicago-date
    // cast on the column to a half-open `scheduled_at` range. The two select
    // identical rows only because Chicago midnight always exists — and on
    // 2026-11-01 (fall-back) that midnight is 05:00Z, NOT the 06:00Z a
    // fixed-offset shortcut would compute.
    //
    // Two bookings ONE HOUR apart straddle it:
    //   04:30Z = 2026-10-31 23:30 CDT → Chicago date 10-31, OUTSIDE the window
    //   05:30Z = 2026-11-01 00:30 CDT → Chicago date 11-01, INSIDE it
    // Only the second may consume a seat. Hard-code a UTC-6 lower bound and
    // the first one gets pulled in and this reads 1; drop the lower bound and
    // it reads 1 as well.
    const overrideDate = '2026-11-01';
    await db.insert(dayCapacityTable).values({
      location: 'fayetteville',
      date: overrideDate,
      schoolOpenings: 3,
      daycareOpenings: 3,
    });
    const beforeMidnight = await insertBookingAt({
      scheduledAtIso: '2026-11-01T04:30:00Z',
      category: 'day-school',
      dogIds: [FIXTURE_IDS.dog1Id],
    });
    const afterMidnight = await insertBookingAt({
      scheduledAtIso: '2026-11-01T05:30:00Z',
      category: 'day-school',
      dogIds: [FIXTURE_IDS.dog2Id],
    });
    await invalidatePattern('avail:fayetteville:*');
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/availability?from=2026-11-01&to=2026-11-01&mode=school&location=fayetteville',
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepStrictEqual(res.json(), [
        {
          location: 'fayetteville',
          date: '2026-11-01',
          school_openings: 3,
          daycare_openings: 3,
          // 3 configured − exactly ONE booked (the 00:30 CDT one).
          school_remaining: 2,
          daycare_remaining: 3,
        },
      ]);
    } finally {
      const ids = [beforeMidnight, afterMidnight];
      await db.delete(bookingDogsTable).where(inArray(bookingDogsTable.bookingId, ids));
      await db.delete(bookingsTable).where(inArray(bookingsTable.id, ids));
      await db
        .delete(dayCapacityTable)
        .where(
          and(eq(dayCapacityTable.location, 'fayetteville'), eq(dayCapacityTable.date, overrideDate)),
        );
      await invalidatePattern('avail:fayetteville:*');
    }
  },
);
