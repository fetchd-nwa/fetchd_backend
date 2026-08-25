import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  agreementDocuments,
  bookings as bookingsTable,
  bookingDogs as bookingDogsTable,
  creditLedger,
  dayCapacity,
  dogVaccines as dogVaccinesTable,
  paymentMethods,
  pendingRequests,
} from '../../src/db/schema/schema.js';
import { redis } from '../../src/redis.js';
import { chicagoWallTimeToUtc } from '../../src/lib/chicagoDate.js';
import { POST_BOOKINGS_ERROR_DETAIL_KINDS } from '../../src/contracts/wire.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import {
  futureWeekday,
  FIXTURE_IDS,
  FIXTURE_NOW,
  FIXTURE_TODAY,
  topUpCredits,
} from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day 10 contract tests for POST /bookings — day-program creation
 * (day-school / day-care). Exercises the full transactional bookSession
 * path end-to-end against real Postgres + Redis through the live Fastify
 * request lifecycle.
 *
 * Coverage (every Day-10 Exit-check branch):
 *   - Happy paths: single-dog/single-date, multi-dog, multi-date, both
 *     modes (school + daycare).
 *   - Gates: payment / vaccine / agreement / insufficient_credits /
 *     insufficient_capacity — each surfaces structured `details` per
 *     the §A amendment. Trigger fallback also tested.
 *   - Concurrency: race on (dog, mode) serializes via advisory lock;
 *     race on (location, date) serializes via capacity advisory lock.
 *   - Idempotency: replay returns stored response (same ids, no second
 *     debit); same key + different body returns 422 idempotency_mismatch.
 *   - Cache invalidation: pre-warmed `avail:{location}:*` keys are wiped
 *     post-commit on the non-replay path.
 *   - Authorization: staff principal → 403; ownership gate → 404.
 *   - Body validation: dates empty / too many / duplicates / past /
 *     beyond-lookahead / dropoff_time out-of-window / lead+additional
 *     id collision / missing Idempotency-Key.
 *
 * Cross-test state isolation: each test uses unique future dates derived
 * from FIXTURE_TODAY + an offset, plus its own credit top-ups, so prior
 * tests' bookings + debits don't bleed into capacity / balance
 * assertions later in the file.
 */

registerFixtureHooks();

const FIXTURE_TODAY_MS = FIXTURE_TODAY.getTime();
const ONE_DAY_MS = 86_400_000;

/** YYYY-MM-DD `daysAhead` from FIXTURE_TODAY (in UTC — dates are
 * timezone-independent labels). NOTE: weekday-only via `futureWeekday`
 * is what most tests want — default `day_capacity` for weekends is
 * `{school:0, daycare:0}` (closed), so booking on a Saturday/Sunday
 * without an explicit override 422s on insufficient_capacity. */
function futureDate(daysAhead: number): string {
  const ms = FIXTURE_TODAY_MS + daysAhead * ONE_DAY_MS;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Wipe every `credit_ledger` row for a fixture dog so a test starts
 * from a known balance of zero. Append-only-by-design — the route never
 * deletes ledger rows in normal flow — but this hard-DELETE is test-only
 * scaffolding to isolate concurrency tests from credit accumulation
 * across prior tests in the same file. */
async function clearCreditLedger(dogId: string): Promise<void> {
  await db.delete(creditLedger).where(eq(creditLedger.dogId, dogId));
}

/** Hard-delete every booking this dog is on (lead or additional) plus its
 * credit-ledger debits + roster rows. Test-only scaffolding (the route never
 * deletes bookings) so a test that books a given (dog, day) isn't tripped by
 * the Day-19d duplicate guard against a booking an EARLIER test left on the
 * same day. Same isolation rationale as `clearCreditLedger`. */
async function clearDogBookings(dogId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const idRows = await tx
      .select({ bookingId: bookingDogsTable.bookingId })
      .from(bookingDogsTable)
      .where(eq(bookingDogsTable.dogId, dogId));
    const ids = idRows.map((r) => r.bookingId);
    if (ids.length === 0) return;
    // Detach any pending_request that converted into one of these bookings —
    // its converted_booking_id FK would otherwise block the delete. (An
    // earlier request→approve→convert test can leave such a row.)
    await tx
      .update(pendingRequests)
      .set({ convertedBookingId: null })
      .where(inArray(pendingRequests.convertedBookingId, ids));
    await tx.delete(creditLedger).where(inArray(creditLedger.bookingId, ids));
    await tx.delete(bookingDogsTable).where(inArray(bookingDogsTable.bookingId, ids));
    await tx.delete(bookingsTable).where(inArray(bookingsTable.id, ids));

    // Δ 2026-07-14: the wipe just deleted the dog's ATTENDED staleness anchor
    // (fixture booking6 / bookingDog2PastCareId), which would flip the next
    // POST /bookings into the approval divert (202) instead of booking (201).
    // Re-plant a fresh anchor so this helper keeps meaning "isolate bookings",
    // not "make the dog stale" — the divert suite builds stale dogs its own way.
    const anchorId = randomUUID();
    await tx.insert(bookingsTable).values({
      id: anchorId,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: dogId,
      category: 'day-school',
      status: 'past',
      scheduledAt: '2026-05-12T13:00:00Z',
      durationMinutes: 540,
      location: 'fayetteville',
    });
    await tx.insert(bookingDogsTable).values({
      bookingId: anchorId,
      dogId,
      isLead: true,
      attendance: 'attended',
      checkedInAt: '2026-05-12T13:05:00Z',
    });
  });
}

/** Build a Fastify app with the bookings route registered + the
 * deterministic fixture clock so date validation uses the FIXTURE_TODAY
 * "today." */
function bookingApp(principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });
  return { app };
}

/** Inject a POST /bookings call with sensible defaults; tests override
 * `payload` / `idempotencyKey` / `principal` to exercise branches. */
async function postBooking(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<
  ReturnType<ReturnType<typeof makeContractApp>['app']['inject']> extends Promise<infer R>
    ? R
    : never
> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: '/bookings',
    headers,
    payload: opts.payload,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Happy paths
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — single-dog single-date day-school → 201 + BookingWire[1] + credit debit',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 5);
    const { app } = bookingApp();
    // futureDate(41)=06-29, a weekday no other test books dog1 into and clear of
    // every fixture session — the time-overlap guard rejects a day program that
    // shares a day (in time) with any existing timed session for the dog.
    const date = futureDate(41);
    const res = await postBooking({
      app,
      idempotencyKey: `bk-1-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as Array<{
      id: string;
      dog_id: string;
      category: string;
      status: string;
      date: string;
      location: string;
      additional_dog_ids?: string[];
    }>;
    assert.equal(body.length, 1);
    assert.equal(body[0]!.dog_id, FIXTURE_IDS.dog1Id);
    assert.equal(body[0]!.category, 'day-school');
    assert.equal(body[0]!.status, 'upcoming');
    assert.equal(body[0]!.location, 'fayetteville');
    assert.equal(body[0]!.additional_dog_ids, undefined, 'no additional dogs');

    // A credit-ledger debit row exists referencing the new booking.
    const debits = await db
      .select({ delta: creditLedger.delta, reason: creditLedger.reason })
      .from(creditLedger)
      .where(
        and(eq(creditLedger.bookingId, body[0]!.id), eq(creditLedger.dogId, FIXTURE_IDS.dog1Id)),
      );
    assert.equal(debits.length, 1, 'exactly one debit per booking per dog');
    assert.equal(debits[0]!.delta, -1);
    assert.equal(debits[0]!.reason, 'booking-debit');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Day-19d duplicate guard
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — same dog + category + day already booked → 422 already_booked with conflict detail',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 5);
    const { app } = bookingApp();
    const date = futureWeekday(25);
    const first = await postBooking({
      app,
      idempotencyKey: `bk-dup-1-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(first.statusCode, 201, first.body);

    const second = await postBooking({
      app,
      idempotencyKey: `bk-dup-2-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(second.statusCode, 422, second.body);
    const body = second.json() as {
      error: {
        code: string;
        details: {
          kind: string;
          conflicts: Array<{ dog_id: string; category: string; date: string }>;
        };
      };
    };
    assert.equal(body.error.code, 'already_booked');
    assert.deepEqual(body.error.details.conflicts, [
      { dog_id: FIXTURE_IDS.dog1Id, category: 'day-school', date },
    ]);
  },
);

test(
  'POST /bookings — a CANCELLED booking on that day does NOT block re-booking',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 5);
    const { app } = bookingApp();
    const date = futureWeekday(26);
    const first = await postBooking({
      app,
      idempotencyKey: `bk-rb-1-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(first.statusCode, 201, first.body);
    const firstId = (first.json() as Array<{ id: string }>)[0]!.id;

    // Cancel it directly (test scaffolding) — a cancelled day frees the slot.
    await db
      .update(bookingsTable)
      .set({ status: 'cancelled' })
      .where(eq(bookingsTable.id, firstId));

    const second = await postBooking({
      app,
      idempotencyKey: `bk-rb-2-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(second.statusCode, 201, second.body);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Time-overlap guard (booking-overlap) — cross-category conflicts by TIME,
// not merely same-day; residential stays excluded (a boarding dog attends
// day school).
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — day program overlapping an existing timed session (cross-category) → 422 already_booked naming the existing session',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 5);
    const { app } = bookingApp();
    // Fixture booking3 is a live private lesson for dog1 on 05-26. A day
    // school there occupies 07:30–17:30, so it overlaps that session in TIME
    // even though it's a different category — the guard must reject it.
    const date = futureDate(7); // 2026-05-26 (weekday)
    const res = await postBooking({
      app,
      idempotencyKey: `bk-overlap-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as {
      error: {
        code: string;
        details: { conflicts: Array<{ dog_id: string; category: string; date: string }> };
      };
    };
    assert.equal(body.error.code, 'already_booked');
    assert.deepEqual(body.error.details.conflicts, [
      { dog_id: FIXTURE_IDS.dog1Id, category: 'private-lesson', date },
    ]);
  },
);

test(
  'POST /bookings — day school DURING an existing boarding stay → 422 (residential conflicts)',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 5);
    const { app } = bookingApp();
    // Fixture booking4 boards dog1 06-15 → 06-20. A day school inside the stay
    // conflicts — a boarding dog is on-site all day, so it can't also attend
    // day school (locked rule 2026-07-09, mirrors the FE engine).
    const date = futureDate(31); // 2026-06-19 (Fri, inside the boarding stay)
    const res = await postBooking({
      app,
      idempotencyKey: `bk-board-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as {
      error: { code: string; details: { conflicts: Array<{ category: string; date: string }> } };
    };
    assert.equal(body.error.code, 'already_booked');
    assert.deepEqual(body.error.details.conflicts, [
      { dog_id: FIXTURE_IDS.dog1Id, category: 'boarding', date },
    ]);
  },
);

test(
  'POST /bookings — day care on a day the dog already has day school → 422 (day programs conflict)',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 5);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'daycare', 5);
    const { app } = bookingApp();
    const date = futureDate(44); // 2026-07-02 (Thu), clear of fixtures + other tests
    const school = await postBooking({
      app,
      idempotencyKey: `bk-sc-1-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(school.statusCode, 201, school.body);

    // Day care the same day — both day programs occupy 07:00–17:00, so the dog
    // can't be in both (day-school ↔ day-care conflict).
    const care = await postBooking({
      app,
      idempotencyKey: `bk-sc-2-${randomUUID()}`,
      payload: {
        category: 'day-care',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(care.statusCode, 422, care.body);
    const body = care.json() as {
      error: { code: string; details: { conflicts: Array<{ category: string; date: string }> } };
    };
    assert.equal(body.error.code, 'already_booked');
    assert.deepEqual(body.error.details.conflicts, [
      { dog_id: FIXTURE_IDS.dog1Id, category: 'day-school', date },
    ]);
  },
);

test(
  'POST /bookings — a private lesson OUTSIDE the day-program window (6pm) does NOT conflict',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 5);
    const { app } = bookingApp();
    const date = futureDate(34); // 2026-06-22 (Mon), clear of fixtures
    // Seed a 6pm private for dog1 (no owner route creates privates). Its
    // window [18:00, 19:00] is after the day-program pick-up close (17:30),
    // so a day school that day overlaps in the SAME DAY but not in TIME.
    const privateId = randomUUID();
    await db.insert(bookingsTable).values({
      id: privateId,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'private-lesson',
      status: 'upcoming',
      scheduledAt: chicagoWallTimeToUtc(date, 18, 0).toISOString(),
      durationMinutes: 60,
      trainerStaffId: FIXTURE_IDS.staffRachelId,
      location: null,
    });
    await db
      .insert(bookingDogsTable)
      .values({ bookingId: privateId, dogId: FIXTURE_IDS.dog1Id, isLead: true });

    const res = await postBooking({
      app,
      idempotencyKey: `bk-6pm-ok-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
  },
);

test(
  'POST /bookings — multi-dog day-care → additional_dog_ids + 2 debits per booking',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'daycare', 3);
    await topUpCredits(FIXTURE_IDS.dog2Id, 'daycare', 3);
    const { app } = bookingApp();
    const date = futureDate(8);
    const res = await postBooking({
      app,
      idempotencyKey: `bk-multi-${randomUUID()}`,
      payload: {
        category: 'day-care',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        additional_dog_ids: [FIXTURE_IDS.dog2Id],
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Array<{ id: string; dog_id: string; additional_dog_ids?: string[] }>;
    assert.equal(body.length, 1);
    assert.deepEqual(body[0]!.additional_dog_ids, [FIXTURE_IDS.dog2Id]);

    const debits = await db
      .select({ dogId: creditLedger.dogId })
      .from(creditLedger)
      .where(eq(creditLedger.bookingId, body[0]!.id));
    const dogIds = debits.map((d) => d.dogId).sort();
    assert.deepEqual(dogIds, [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id].sort());
  },
);

test(
  'POST /bookings — multi-date day-school → BookingWire[N] (one per date) + N debits per dog',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 5);
    const { app } = bookingApp();
    // Three weekdays (Mon–Wed, 3/3 capacity) well clear of every fixture
    // session + other tests' dog1 bookings — the time-overlap guard rejects a
    // day program that shares a day with any existing session for the dog.
    const dates = [futureDate(48), futureDate(49), futureDate(50)];
    const res = await postBooking({
      app,
      idempotencyKey: `bk-multidate-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates,
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Array<{ id: string; date: string }>;
    assert.equal(body.length, 3);
    // Returned ASC by scheduled_at (route sorts dates ASC before insert).
    const returnedDates = body.map((b) => b.date.slice(0, 10));
    assert.deepEqual(returnedDates, [...dates].sort());

    // Three debits for dog1 across the three booking ids.
    const bookingIds = body.map((b) => b.id);
    const debits = await db
      .select({ delta: creditLedger.delta })
      .from(creditLedger)
      .where(
        and(
          inArray(creditLedger.bookingId, bookingIds),
          eq(creditLedger.dogId, FIXTURE_IDS.dog1Id),
        ),
      );
    assert.equal(debits.length, 3);
    for (const d of debits) assert.equal(d.delta, -1);
  },
);

test(
  'POST /bookings — stamps cancel_deadline_at from active cancel_window_settings policy (seeded 48h flat)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Day 13 moved the active policy to the cancel_window_settings DB
    // table, seeded at 48h flat across all categories. The route reads
    // it via cancelWindowSettingsRepository.resolveHoursFor() at booking
    // creation and stamps the resolved deadline on the row. A test that
    // tunes the policy then booked would see its tuned value land here.
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const { app } = bookingApp();
    const date = futureDate(14);
    const res = await postBooking({
      app,
      idempotencyKey: `bk-cancel-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        dropoff_time: '08:00',
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Array<{ id: string }>;
    const [row] = await db
      .select({
        scheduledAt: bookingsTable.scheduledAt,
        cancelDeadlineAt: bookingsTable.cancelDeadlineAt,
      })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, body[0]!.id));
    assert.ok(row);
    const delta = new Date(row.scheduledAt).getTime() - new Date(row.cancelDeadlineAt!).getTime();
    assert.equal(delta, 48 * 60 * 60 * 1000);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Body validation
// ──────────────────────────────────────────────────────────────────────────

test('POST /bookings — missing Idempotency-Key → 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const { app } = bookingApp();
  const res = await postBooking({
    app,
    payload: {
      category: 'day-school',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      dates: [futureDate(20)],
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'bad_request');
});

test('POST /bookings — empty dates[] → 400 bad_request (Zod min(1))', SKIP_WHEN_NO_DB, async () => {
  const { app } = bookingApp();
  const res = await postBooking({
    app,
    idempotencyKey: `bk-empty-${randomUUID()}`,
    payload: {
      category: 'day-school',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      dates: [],
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /bookings — dates[] > 30 → 400 bad_request (Zod max cap)', SKIP_WHEN_NO_DB, async () => {
  const { app } = bookingApp();
  const dates = Array.from({ length: 31 }, (_, i) => futureDate(i + 30));
  const res = await postBooking({
    app,
    idempotencyKey: `bk-toomany-${randomUUID()}`,
    payload: {
      category: 'day-school',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      dates,
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /bookings — duplicate dates → 422 invalid_payload', SKIP_WHEN_NO_DB, async () => {
  await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 5);
  const { app } = bookingApp();
  const date = futureDate(15);
  const res = await postBooking({
    app,
    idempotencyKey: `bk-dup-${randomUUID()}`,
    payload: {
      category: 'day-school',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      dates: [date, date],
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 422);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_payload');
});

test('POST /bookings — past date → 422 invalid_payload', SKIP_WHEN_NO_DB, async () => {
  await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
  const { app } = bookingApp();
  const res = await postBooking({
    app,
    idempotencyKey: `bk-past-${randomUUID()}`,
    payload: {
      category: 'day-school',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      dates: [futureDate(-7)],
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 422);
  assert.match((res.json() as { error: { message: string } }).error.message, /in the past/);
});

test(
  'POST /bookings — date beyond 92-day lookahead → 422 invalid_payload',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `bk-far-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [futureDate(120)],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 422);
    assert.match((res.json() as { error: { message: string } }).error.message, /lookahead/);
  },
);

test(
  'POST /bookings — lead_dog_id in additional_dog_ids → 422 invalid_payload',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `bk-leadcol-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        additional_dog_ids: [FIXTURE_IDS.dog1Id],
        dates: [futureDate(16)],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 422);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_payload');
  },
);

test(
  'POST /bookings — dropoff_time outside window (06:30) → 400 bad_request',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `bk-dropoff-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [futureDate(17)],
        dropoff_time: '06:30',
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(
      (res.json() as { error: { message: string } }).error.message,
      /dropoff_time must be within/,
    );
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Authorization
// ──────────────────────────────────────────────────────────────────────────

test('POST /bookings — staff principal → 403 forbidden', SKIP_WHEN_NO_DB, async () => {
  const { app } = bookingApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await postBooking({
    app,
    idempotencyKey: `bk-staff-${randomUUID()}`,
    payload: {
      category: 'day-school',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      dates: [futureDate(18)],
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'forbidden');
});

test('POST /bookings — unknown dog_id (not owned) → 404 not_found', SKIP_WHEN_NO_DB, async () => {
  await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
  const { app } = bookingApp();
  const fakeDogId = randomUUID();
  const res = await postBooking({
    app,
    idempotencyKey: `bk-unowned-${randomUUID()}`,
    payload: {
      category: 'day-school',
      lead_dog_id: fakeDogId,
      dates: [futureDate(19)],
      location: 'fayetteville',
    },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'not_found');
});

// ──────────────────────────────────────────────────────────────────────────
// Gate failures (each produces a typed code + structured `details`)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — payment gate fires when owner has no live card → 422 payment_required',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    // Soft-expire the fixture card.
    await db
      .update(paymentMethods)
      .set({ expiredAt: sql`now()` })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    try {
      const { app } = bookingApp();
      const res = await postBooking({
        app,
        idempotencyKey: `bk-paygate-${randomUUID()}`,
        payload: {
          category: 'day-school',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          dates: [futureDate(21)],
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 422);
      const body = res.json() as { error: { code: string; details: { kind: string } } };
      assert.equal(body.error.code, 'payment_required');
      assert.equal(body.error.details.kind, 'payment_required');
    } finally {
      // Restore — subsequent tests need the card.
      await db
        .update(paymentMethods)
        .set({ expiredAt: null })
        .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    }
  },
);

test(
  'POST /bookings — vaccine gate fires with structured per-dog missing[]',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    // Soft-expire Waffles' Rabies (vaccine1).
    await db
      .update(dogVaccinesTable)
      .set({ expiredAt: sql`now()` })
      .where(eq(dogVaccinesTable.id, FIXTURE_IDS.vaccine1Id));
    try {
      const { app } = bookingApp();
      const res = await postBooking({
        app,
        idempotencyKey: `bk-vacgate-${randomUUID()}`,
        payload: {
          category: 'day-school',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          dates: [futureDate(22)],
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 422);
      const body = res.json() as {
        error: {
          code: string;
          details: {
            kind: string;
            missing: { dog_id: string; requirement_key: string; label: string }[];
          };
        };
      };
      assert.equal(body.error.code, 'vaccine_missing');
      assert.equal(body.error.details.kind, 'vaccine_missing');
      assert.ok(body.error.details.missing.length >= 1, 'at least one missing entry');
      const rabies = body.error.details.missing.find(
        (m) =>
          m.requirement_key === FIXTURE_IDS.requiredVaccineRabiesKey &&
          m.dog_id === FIXTURE_IDS.dog1Id,
      );
      assert.ok(rabies, 'rabies should be in missing[]');
    } finally {
      await db
        .update(dogVaccinesTable)
        .set({ expiredAt: null })
        .where(eq(dogVaccinesTable.id, FIXTURE_IDS.vaccine1Id));
    }
  },
);

test(
  'POST /bookings — agreement gate fires with structured missing[]',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    // Add a NEW required agreement that applies to day-school and isn't
    // signed by the owner.
    const docKey = `test-day10-school-extra-${randomUUID().slice(0, 8)}`;
    await db.insert(agreementDocuments).values({
      key: docKey,
      label: 'Day School Extra Waiver (test)',
      currentVersion: 1,
      required: true,
      appliesTo: ['day-school'],
    });
    try {
      const { app } = bookingApp();
      const res = await postBooking({
        app,
        idempotencyKey: `bk-agrgate-${randomUUID()}`,
        payload: {
          category: 'day-school',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          dates: [futureDate(23)],
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 422);
      const body = res.json() as {
        error: {
          code: string;
          details: { kind: string; missing: { document_key: string; label: string }[] };
        };
      };
      assert.equal(body.error.code, 'agreement_unsigned');
      assert.equal(body.error.details.kind, 'agreement_unsigned');
      const ours = body.error.details.missing.find((m) => m.document_key === docKey);
      assert.ok(ours, `missing[] should include ${docKey}`);
    } finally {
      await db.delete(agreementDocuments).where(eq(agreementDocuments.key, docKey));
    }
  },
);

test(
  'POST /bookings — insufficient credits → 422 insufficient_credits with per-dog gap',
  SKIP_WHEN_NO_DB,
  async () => {
    // Lola has 0 school credits and we don't top up.
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `bk-credits-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog2Id,
        dates: [futureDate(24)],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as {
      error: {
        code: string;
        details: {
          kind: string;
          gaps: { dog_id: string; mode: string; balance: number; required: number }[];
        };
      };
    };
    assert.equal(body.error.code, 'insufficient_credits');
    assert.equal(body.error.details.kind, 'insufficient_credits');
    // §3.5 alias pin: the emitted arm must be a member of THIS endpoint's
    // declared 422 vocabulary (`PostBookingsErrorDetails`, runtime twin
    // POST_BOOKINGS_ERROR_DETAIL_KINDS). Asserted at runtime, not by tsc —
    // backend `test/` is type-ERASED (rulebook §14.5).
    assert.ok(
      (POST_BOOKINGS_ERROR_DETAIL_KINDS as readonly string[]).includes(body.error.details.kind),
      `${body.error.details.kind} is not an arm of PostBookingsErrorDetails`,
    );
    assert.equal(body.error.details.gaps.length, 1);
    assert.equal(body.error.details.gaps[0]!.dog_id, FIXTURE_IDS.dog2Id);
    assert.equal(body.error.details.gaps[0]!.mode, 'school');
    assert.equal(body.error.details.gaps[0]!.required, 1);
    assert.equal(body.error.details.gaps[0]!.balance, 0);
  },
);

test(
  'POST /bookings — insufficient capacity (override = 0) → 422 insufficient_capacity',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const date = futureDate(25);
    // Override day_capacity to 0 for school at fayetteville on this date.
    await db.insert(dayCapacity).values({
      location: 'fayetteville',
      date,
      schoolOpenings: 0,
      daycareOpenings: 3,
    });
    try {
      const { app } = bookingApp();
      const res = await postBooking({
        app,
        idempotencyKey: `bk-cap-${randomUUID()}`,
        payload: {
          category: 'day-school',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          dates: [date],
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 422);
      const body = res.json() as {
        error: {
          code: string;
          details: { kind: string; location: string; date: string; mode: string };
        };
      };
      assert.equal(body.error.code, 'insufficient_capacity');
      assert.equal(body.error.details.kind, 'insufficient_capacity');
      assert.equal(body.error.details.location, 'fayetteville');
      assert.equal(body.error.details.date, date);
      assert.equal(body.error.details.mode, 'school');
    } finally {
      await db
        .delete(dayCapacity)
        .where(and(eq(dayCapacity.location, 'fayetteville'), eq(dayCapacity.date, date)));
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Idempotency
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — idempotent replay returns identical body, no second debit',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const { app } = bookingApp();
    // futureWeekday(18)=06-15 fell inside the fixture boarding stay (06-15→20),
    // which now conflicts; use a clean weekday clear of every fixture session.
    const date = futureDate(55);
    const key = `bk-idemp-${randomUUID()}`;
    const payload = {
      category: 'day-school',
      lead_dog_id: FIXTURE_IDS.dog1Id,
      dates: [date],
      location: 'fayetteville',
    };
    const a = await postBooking({ app, idempotencyKey: key, payload });
    const b = await postBooking({ app, idempotencyKey: key, payload });
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.deepEqual(a.json(), b.json(), 'replay returns identical body');
    // Exactly ONE debit row (idempotent replay didn't double-debit).
    const bookingId = (a.json() as Array<{ id: string }>)[0]!.id;
    const debits = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.bookingId, bookingId));
    assert.equal(debits.length, 1, 'replay must not double-debit');
  },
);

test(
  'POST /bookings — same key + different body → 422 idempotency_mismatch',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearDogBookings(FIXTURE_IDS.dog1Id);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const { app } = bookingApp();
    const key = `bk-mismatch-${randomUUID()}`;
    const date = futureDate(27);
    const a = await postBooking({
      app,
      idempotencyKey: key,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [date],
        location: 'fayetteville',
      },
    });
    assert.equal(a.statusCode, 201);
    const b = await postBooking({
      app,
      idempotencyKey: key,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [futureDate(28)], // different date → different hash
        location: 'fayetteville',
      },
    });
    assert.equal(b.statusCode, 422);
    assert.equal((b.json() as { error: { code: string } }).error.code, 'idempotency_mismatch');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Concurrency (advisory locks)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — race on (dog, mode): two concurrent requests for same dog serialize',
  SKIP_WHEN_NO_DB,
  async () => {
    // Clean Waffles' credit ledger first so the balance is EXACTLY 1 after
    // top-up — prior tests in this file accumulated debits and purchases
    // and the assertion needs a known-bounded starting balance to prove
    // that the second racing request observes the first's debit. Hard-
    // DELETE is test-only scaffolding (the route never deletes ledger rows
    // in normal flow).
    await clearCreditLedger(FIXTURE_IDS.dog1Id);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const app1 = bookingApp().app;
    const app2 = bookingApp().app;
    const date1 = futureWeekday(20);
    const date2 = futureWeekday(21);
    const [a, b] = await Promise.all([
      postBooking({
        app: app1,
        idempotencyKey: `bk-race1-${randomUUID()}`,
        payload: {
          category: 'day-school',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          dates: [date1],
          location: 'fayetteville',
        },
      }),
      postBooking({
        app: app2,
        idempotencyKey: `bk-race2-${randomUUID()}`,
        payload: {
          category: 'day-school',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          dates: [date2],
          location: 'fayetteville',
        },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    // Exactly one 201, one 422. (Lock makes them serialize; the second sees
    // the first's debit and 422s on insufficient_credits.)
    assert.deepEqual(codes, [201, 422], `expected [201, 422], got ${codes}`);
  },
);

test(
  'POST /bookings — race on (location, date): two concurrent requests for same bucket serialize via capacity',
  SKIP_WHEN_NO_DB,
  async () => {
    // Top up enough for both dogs to book the same date. Override day_capacity
    // to 1 so only ONE dog can fit — the other 422s on insufficient_capacity.
    await clearDogBookings(FIXTURE_IDS.dog1Id);
    await clearDogBookings(FIXTURE_IDS.dog2Id);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    await topUpCredits(FIXTURE_IDS.dog2Id, 'school', 1);
    const date = futureDate(37);
    await db.insert(dayCapacity).values({
      location: 'fayetteville',
      date,
      schoolOpenings: 1,
      daycareOpenings: 3,
    });
    try {
      const app1 = bookingApp().app;
      const app2 = bookingApp().app;
      const [a, b] = await Promise.all([
        postBooking({
          app: app1,
          idempotencyKey: `bk-caprace1-${randomUUID()}`,
          payload: {
            category: 'day-school',
            lead_dog_id: FIXTURE_IDS.dog1Id,
            dates: [date],
            location: 'fayetteville',
          },
        }),
        postBooking({
          app: app2,
          idempotencyKey: `bk-caprace2-${randomUUID()}`,
          payload: {
            category: 'day-school',
            lead_dog_id: FIXTURE_IDS.dog2Id,
            dates: [date],
            location: 'fayetteville',
          },
        }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      assert.deepEqual(codes, [201, 422], `expected [201, 422], got ${codes}`);
    } finally {
      await db
        .delete(dayCapacity)
        .where(and(eq(dayCapacity.location, 'fayetteville'), eq(dayCapacity.date, date)));
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Cache invalidation
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — wipes avail:{location}:* cache pattern post-commit',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    // Pre-warm a key matching avail:fayetteville:*
    const warmKey = `avail:fayetteville:cache-test-${randomUUID()}`;
    await redis.set(
      warmKey,
      JSON.stringify([{ date: '2026-06-15', school_openings: 3, daycare_openings: 3 }]),
    );
    const existsBefore = await redis.exists(warmKey);
    assert.equal(existsBefore, 1, 'pre-warm key should exist before POST');

    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `bk-cache-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog1Id,
        dates: [futureDate(38)],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 201);

    const existsAfter = await redis.exists(warmKey);
    assert.equal(existsAfter, 0, 'avail:fayetteville:* key should be wiped post-commit');
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Wire shape — booking_dogs link integrity
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — booking_dogs link rows match the request (is_lead exactly on lead_dog_id)',
  SKIP_WHEN_NO_DB,
  async () => {
    await clearDogBookings(FIXTURE_IDS.dog1Id);
    await clearDogBookings(FIXTURE_IDS.dog2Id);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    await topUpCredits(FIXTURE_IDS.dog2Id, 'school', 1);
    const { app } = bookingApp();
    const res = await postBooking({
      app,
      idempotencyKey: `bk-dogslink-${randomUUID()}`,
      payload: {
        category: 'day-school',
        lead_dog_id: FIXTURE_IDS.dog2Id, // Lola is lead this time
        additional_dog_ids: [FIXTURE_IDS.dog1Id],
        dates: [futureWeekday(25)],
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Array<{ id: string }>;
    const links = await db
      .select({ dogId: bookingDogsTable.dogId, isLead: bookingDogsTable.isLead })
      .from(bookingDogsTable)
      .where(eq(bookingDogsTable.bookingId, body[0]!.id));
    const lead = links.find((l) => l.isLead);
    const additional = links.filter((l) => !l.isLead);
    assert.equal(lead?.dogId, FIXTURE_IDS.dog2Id);
    assert.equal(additional.length, 1);
    assert.equal(additional[0]!.dogId, FIXTURE_IDS.dog1Id);
  },
);
