import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  bookingDogs as bookingDogsTable,
  dogs as dogsTable,
  pendingRequestDogs as pendingRequestDogsTable,
  pendingRequestPreferredDates as pendingRequestPreferredDatesTable,
  pendingRequests as pendingRequestsTable,
  paymentMethods,
} from '../../src/db/schema/schema.js';
import { gateTriggerErrorToApiError } from '../../src/lib/bookingErrors.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { registerStaffRequestsRoute } from '../../src/routes/staffRequests.js';
import type { Principal } from '../../src/auth/principal.js';
import { FIXTURE_IDS, FIXTURE_NOW, FIXTURE_TODAY, topUpCredits } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Day-12b contract tests for the evaluation gate — the 4th BOOKING GATE
 * (DATA-CONTRACT §A Amendment 2026-05-23, §H "Booking gates").
 *
 * Coverage matrix:
 *   - Pre-check (API) — Day-10 POST /bookings + Day-12 POST /requests +
 *     POST /staff/requests/:id/approve.
 *   - Bypass arms — categories not in the gate set (PL at submission +
 *     approve, group-class enrollment) succeed with an un-passed dog.
 *   - Trigger floor — direct DB INSERT into bookings raises
 *     check_violation with the documented 'evaluation gate:' prefix;
 *     staff-owned dogs + 'evaluation' category bypass the floor.
 *   - Gate priority — payment failure surfaces BEFORE evaluation so
 *     a multi-gap user fixes the most-fundamental issue first.
 *   - Trigger-fallback mapping — `gateTriggerErrorToApiError` produces
 *     the typed `evaluation_required` code for the race window.
 *
 * Lola's fixture status was bumped to 'passed' at Day-12b to keep the
 * pre-existing day-care/boarding booking seeds + tests passing under
 * the new trigger. Tests in this file that need a non-passed dog flip
 * her status inline (with `finally` restore) — same shape as the
 * vaccine-gate test soft-expires + restores her Rabies record.
 */

registerFixtureHooks();

const FIXTURE_TODAY_MS = FIXTURE_TODAY.getTime();
const ONE_DAY_MS = 86_400_000;

// Real "now" for the requests routes (which use Date.now() for date
// validation, not the FIXTURE_NOW factory) — pick preferred_dates well
// in the future of any real run, well within the 92-day cap.
const PREFERRED_1 = '2026-07-15T15:00:00Z';
const PREFERRED_2 = '2026-07-22T15:00:00Z';
const APPROVE_SCHEDULED_AT = '2026-07-20T15:00:00Z';
const APPROVE_PICKUP_AT = '2026-07-23T17:00:00Z';

/** YYYY-MM-DD `daysAhead` from FIXTURE_TODAY (UTC date label). Mirrors
 * the helper in booking-create.test.ts — the bookings route uses
 * FIXTURE_NOW so future-date validation is against the fixture clock. */
function futureDate(daysAhead: number): string {
  const ms = FIXTURE_TODAY_MS + daysAhead * ONE_DAY_MS;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD for the `nth` weekday strictly after FIXTURE_TODAY (default
 * day_capacity for weekends is {school:0, daycare:0}). */
function futureWeekday(nth: number): string {
  let count = 0;
  let offset = 1;
  for (;;) {
    const ms = FIXTURE_TODAY_MS + offset * ONE_DAY_MS;
    const d = new Date(ms);
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

/** Flip a dog's evaluation_status for the duration of `body`, restoring
 * in finally so cross-test state stays clean. Mirrors the vaccine-gate
 * test's expire+restore pattern. */
async function withDogEvalStatus(
  dogId: string,
  status: 'not-evaluated' | 'pending' | 'failed',
  body: () => Promise<void>,
): Promise<void> {
  const [prior] = await db
    .select({ s: dogsTable.evaluationStatus })
    .from(dogsTable)
    .where(eq(dogsTable.id, dogId));
  await db.update(dogsTable).set({ evaluationStatus: status }).where(eq(dogsTable.id, dogId));
  try {
    await body();
  } finally {
    if (prior !== undefined) {
      await db.update(dogsTable).set({ evaluationStatus: prior.s }).where(eq(dogsTable.id, dogId));
    }
  }
}

/** Apps with the relevant routes mounted for this test file. */
function bookingApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL) {
  const { app, authenticate } = makeContractApp(principal);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });
  return { app };
}

function requestsApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL) {
  const { app, authenticate } = makeContractApp(principal);
  registerRequestsRoute(app, { authenticate });
  registerStaffRequestsRoute(app, { authenticate });
  return { app };
}

function enrollmentApp(principal: Principal = FIXTURE_OWNER_PRINCIPAL) {
  const { app, authenticate } = makeContractApp(principal);
  registerEnrollmentsRoute(app, { authenticate });
  return { app };
}

/** Submit a pending request via the route (so the test exercises the
 * full POST /requests path including the new eval pre-check for
 * B&T/boarding). Returns the request id on 2xx. */
async function postRequest(opts: {
  app: ReturnType<typeof requestsApp>['app'];
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof requestsApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: '/requests',
    headers,
    payload: opts.payload,
  });
}

async function approveRequest(opts: {
  app: ReturnType<typeof requestsApp>['app'];
  id: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): ReturnType<ReturnType<typeof requestsApp>['app']['inject']> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  return opts.app.inject({
    method: 'POST',
    url: `/staff/requests/${opts.id}/approve`,
    headers,
    payload: opts.payload,
  });
}

/** Direct DB seed of a `submitted` pending_request — used by tests that
 * exercise the staff approve verb's gate. Skips the POST /requests
 * pre-check so a request with a not-passed lead can land for the
 * mid-flight race scenarios. */
async function seedSubmittedRequest(args: {
  category: 'private-lesson' | 'board-and-train' | 'boarding';
  leadDogId?: string;
  additionalDogIds?: string[];
  lengthWeeks?: number;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(pendingRequestsTable).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: args.leadDogId ?? FIXTURE_IDS.dog1Id,
    category: args.category,
    status: 'submitted',
    lengthWeeks: args.lengthWeeks ?? null,
  });
  const dogRows = [{ requestId: id, dogId: args.leadDogId ?? FIXTURE_IDS.dog1Id, isLead: true }];
  for (const dogId of args.additionalDogIds ?? []) {
    dogRows.push({ requestId: id, dogId, isLead: false });
  }
  await db.insert(pendingRequestDogsTable).values(dogRows);
  await db.insert(pendingRequestPreferredDatesTable).values([
    { requestId: id, ordinal: 1, preferredAt: PREFERRED_1 },
    { requestId: id, ordinal: 2, preferredAt: PREFERRED_2 },
  ]);
  return id;
}

// ──────────────────────────────────────────────────────────────────────────
// POST /bookings — pre-check fires for gated categories
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /bookings — day-school with un-passed lead dog → 422 evaluation_required + structured per-dog missing[]',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog2Id, 'school', 1);
    await withDogEvalStatus(FIXTURE_IDS.dog2Id, 'not-evaluated', async () => {
      const { app } = bookingApp();
      const res = await app.inject({
        method: 'POST',
        url: '/bookings',
        headers: { 'idempotency-key': `eval-day-school-${randomUUID()}` },
        payload: {
          category: 'day-school',
          lead_dog_id: FIXTURE_IDS.dog2Id,
          dates: [futureWeekday(5)],
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 422, res.body);
      const body = res.json() as {
        error: {
          code: string;
          details: {
            kind: string;
            missing: { dog_id: string; evaluation_status: string }[];
          };
        };
      };
      assert.equal(body.error.code, 'evaluation_required');
      assert.equal(body.error.details.kind, 'evaluation_required');
      assert.equal(body.error.details.missing.length, 1);
      assert.equal(body.error.details.missing[0]!.dog_id, FIXTURE_IDS.dog2Id);
      assert.equal(body.error.details.missing[0]!.evaluation_status, 'not-evaluated');
    });
  },
);

test(
  'POST /bookings — multi-dog day-care surfaces only the un-passed dogs in missing[]',
  SKIP_WHEN_NO_DB,
  async () => {
    await topUpCredits(FIXTURE_IDS.dog1Id, 'daycare', 1);
    await topUpCredits(FIXTURE_IDS.dog2Id, 'daycare', 1);
    // Waffles stays 'passed'; flip Lola to 'failed' to also exercise the
    // 'failed' arm of the evaluation_status union.
    await withDogEvalStatus(FIXTURE_IDS.dog2Id, 'failed', async () => {
      const { app } = bookingApp();
      const res = await app.inject({
        method: 'POST',
        url: '/bookings',
        headers: { 'idempotency-key': `eval-day-care-multi-${randomUUID()}` },
        payload: {
          category: 'day-care',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          additional_dog_ids: [FIXTURE_IDS.dog2Id],
          dates: [futureWeekday(6)],
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 422, res.body);
      const body = res.json() as {
        error: {
          code: string;
          details: {
            kind: string;
            missing: { dog_id: string; evaluation_status: string }[];
          };
        };
      };
      assert.equal(body.error.code, 'evaluation_required');
      assert.equal(body.error.details.missing.length, 1, 'only Lola is un-passed');
      assert.equal(body.error.details.missing[0]!.dog_id, FIXTURE_IDS.dog2Id);
      assert.equal(body.error.details.missing[0]!.evaluation_status, 'failed');
    });
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /requests — eval pre-check at the request boundary (B&T + boarding)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /requests — board-and-train with un-passed lead → 422 evaluation_required',
  SKIP_WHEN_NO_DB,
  async () => {
    await withDogEvalStatus(FIXTURE_IDS.dog1Id, 'not-evaluated', async () => {
      const { app } = requestsApp();
      const res = await postRequest({
        app,
        idempotencyKey: `eval-bt-${randomUUID()}`,
        payload: {
          category: 'board-and-train',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          preferred_dates: [PREFERRED_1, PREFERRED_2],
          length_weeks: 2,
        },
      });
      assert.equal(res.statusCode, 422, res.body);
      const body = res.json() as {
        error: {
          code: string;
          details: {
            kind: string;
            missing: { dog_id: string; evaluation_status: string }[];
          };
        };
      };
      assert.equal(body.error.code, 'evaluation_required');
      assert.equal(body.error.details.kind, 'evaluation_required');
      assert.equal(body.error.details.missing.length, 1);
      assert.equal(body.error.details.missing[0]!.dog_id, FIXTURE_IDS.dog1Id);
      assert.equal(body.error.details.missing[0]!.evaluation_status, 'not-evaluated');
    });
  },
);

test(
  'POST /requests — boarding with un-passed lead → 422 evaluation_required (pending status)',
  SKIP_WHEN_NO_DB,
  async () => {
    await withDogEvalStatus(FIXTURE_IDS.dog1Id, 'pending', async () => {
      const { app } = requestsApp();
      const res = await postRequest({
        app,
        idempotencyKey: `eval-boarding-${randomUUID()}`,
        payload: {
          category: 'boarding',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          preferred_dates: [PREFERRED_1, PREFERRED_2],
        },
      });
      assert.equal(res.statusCode, 422, res.body);
      const body = res.json() as {
        error: {
          code: string;
          details: { kind: string; missing: { evaluation_status: string }[] };
        };
      };
      assert.equal(body.error.code, 'evaluation_required');
      assert.equal(body.error.details.missing[0]!.evaluation_status, 'pending');
    });
  },
);

test(
  'POST /requests — private-lesson with un-passed lead → 201 (PL is not eval-gated at submission)',
  SKIP_WHEN_NO_DB,
  async () => {
    await withDogEvalStatus(FIXTURE_IDS.dog1Id, 'not-evaluated', async () => {
      const { app } = requestsApp();
      const res = await postRequest({
        app,
        idempotencyKey: `eval-pl-bypass-${randomUUID()}`,
        payload: {
          category: 'private-lesson',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          preferred_dates: [PREFERRED_1, PREFERRED_2],
        },
      });
      assert.equal(res.statusCode, 201, res.body);
    });
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /staff/requests/:id/approve — gate fires for boarding mid-flight race
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /staff/requests/:id/approve — boarding race: lead flipped to un-passed between submit + approve → 422 evaluation_required',
  SKIP_WHEN_NO_DB,
  async () => {
    // Seed a boarding request directly (bypassing POST /requests so a
    // race-shaped state can be set up: request was submitted while
    // lead was passed; mid-flight the lead's eval flipped).
    const requestId = await seedSubmittedRequest({ category: 'boarding' });
    await withDogEvalStatus(FIXTURE_IDS.dog1Id, 'failed', async () => {
      const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
      const res = await approveRequest({
        app,
        id: requestId,
        idempotencyKey: `eval-approve-boarding-${randomUUID()}`,
        payload: {
          scheduled_at: APPROVE_SCHEDULED_AT,
          pickup_at: APPROVE_PICKUP_AT,
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 422, res.body);
      const body = res.json() as {
        error: {
          code: string;
          details: { kind: string; missing: { evaluation_status: string }[] };
        };
      };
      assert.equal(body.error.code, 'evaluation_required');
      assert.equal(body.error.details.missing[0]!.evaluation_status, 'failed');
    });
  },
);

test(
  'POST /staff/requests/:id/approve — private-lesson with un-passed lead → 200 (PL is not eval-gated)',
  SKIP_WHEN_NO_DB,
  async () => {
    const requestId = await seedSubmittedRequest({ category: 'private-lesson' });
    await withDogEvalStatus(FIXTURE_IDS.dog1Id, 'not-evaluated', async () => {
      const { app } = requestsApp(FIXTURE_STAFF_PRINCIPAL);
      const res = await approveRequest({
        app,
        id: requestId,
        idempotencyKey: `eval-approve-pl-bypass-${randomUUID()}`,
        payload: {
          scheduled_at: APPROVE_SCHEDULED_AT,
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 200, res.body);
    });
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /enrollments — group-class is NOT eval-gated (R7 prereq system instead)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /enrollments — group-class with un-passed dog → 201 (group-class uses R7 prereqs, not eval)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Use the puppy cohort from the fixture (no prereqs, capacity 6, filled 1).
    await withDogEvalStatus(FIXTURE_IDS.dog2Id, 'not-evaluated', async () => {
      const { app } = enrollmentApp();
      const res = await app.inject({
        method: 'POST',
        url: '/enrollments',
        headers: { 'idempotency-key': `eval-enrollment-bypass-${randomUUID()}` },
        payload: {
          cohort_id: FIXTURE_IDS.cohortPuppyId,
          dog_ids: [FIXTURE_IDS.dog2Id],
        },
      });
      assert.equal(res.statusCode, 201, res.body);
    });
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Gate priority — payment surfaces BEFORE evaluation
// ──────────────────────────────────────────────────────────────────────────

test(
  'gate priority — owner has no card AND lead un-passed → 422 payment_required (payment beats evaluation)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Stack TWO gate failures: card expired + dog un-passed. The
    // priority-ordered pre-check must report payment first.
    await topUpCredits(FIXTURE_IDS.dog2Id, 'school', 1);
    await db
      .update(paymentMethods)
      .set({ expiredAt: sql`now()` })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    try {
      await withDogEvalStatus(FIXTURE_IDS.dog2Id, 'not-evaluated', async () => {
        const { app } = bookingApp();
        const res = await app.inject({
          method: 'POST',
          url: '/bookings',
          headers: { 'idempotency-key': `eval-priority-${randomUUID()}` },
          payload: {
            category: 'day-school',
            lead_dog_id: FIXTURE_IDS.dog2Id,
            dates: [futureWeekday(7)],
            location: 'fayetteville',
          },
        });
        assert.equal(res.statusCode, 422, res.body);
        const body = res.json() as { error: { code: string } };
        assert.equal(
          body.error.code,
          'payment_required',
          'payment gate must fire before evaluation gate per the priority order',
        );
      });
    } finally {
      await db
        .update(paymentMethods)
        .set({ expiredAt: null })
        .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Schema trigger floor — direct DB INSERT exercises bookings_eval_gate_check
// ──────────────────────────────────────────────────────────────────────────

test(
  'schema trigger — direct INSERT day-school with un-passed lead → check_violation with `evaluation gate:` prefix',
  SKIP_WHEN_NO_DB,
  async () => {
    await withDogEvalStatus(FIXTURE_IDS.dog2Id, 'not-evaluated', async () => {
      const bookingId = randomUUID();
      await assert.rejects(
        db.insert(bookingsTable).values({
          id: bookingId,
          ownerId: FIXTURE_IDS.ownerId,
          leadDogId: FIXTURE_IDS.dog2Id,
          category: 'day-school',
          status: 'upcoming',
          scheduledAt: futureDate(8) + 'T13:00:00Z',
          durationMinutes: 540,
          location: 'fayetteville',
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /evaluation gate:/);
          return true;
        },
      );
    });
  },
);

test(
  "schema trigger — 'evaluation' category bypasses the gate (chicken-and-egg)",
  SKIP_WHEN_NO_DB,
  async () => {
    await withDogEvalStatus(FIXTURE_IDS.dog2Id, 'not-evaluated', async () => {
      // The booking that records the evaluation can't require an
      // evaluation to exist first. Trigger must let this INSERT through.
      const bookingId = randomUUID();
      await db.insert(bookingsTable).values({
        id: bookingId,
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: FIXTURE_IDS.dog2Id,
        category: 'evaluation',
        status: 'upcoming',
        scheduledAt: futureDate(9) + 'T13:00:00Z',
        durationMinutes: 60,
        location: 'fayetteville',
      });
      await db.insert(bookingDogsTable).values({
        bookingId,
        dogId: FIXTURE_IDS.dog2Id,
        isLead: true,
      });
      // Cleanup so subsequent tests don't see this booking.
      await db.delete(bookingDogsTable).where(eq(bookingDogsTable.bookingId, bookingId));
      await db.delete(bookingsTable).where(eq(bookingsTable.id, bookingId));
    });
  },
);

test(
  'schema trigger — staff-owned dog bypasses the gate (uniform exemption)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Insert a transient staff-owned dog with evaluation_status='not-
    // evaluated'. The trigger's staff-exemption branch must let an
    // INSERT with this dog as lead through, even on a gated category.
    const staffDogId = randomUUID();
    await db.insert(dogsTable).values({
      id: staffDogId,
      ownerId: null,
      staffOwnerId: FIXTURE_IDS.staffDonavanId,
      name: 'Staff Test Dog',
      breed: 'Test',
      birthdate: '2020-01-01',
      specialNotes: '',
      evaluationStatus: 'not-evaluated',
      profileImagePath: null,
    });
    const bookingId = randomUUID();
    try {
      await db.insert(bookingsTable).values({
        id: bookingId,
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: staffDogId,
        category: 'day-school',
        status: 'upcoming',
        scheduledAt: futureDate(10) + 'T13:00:00Z',
        durationMinutes: 540,
        location: 'fayetteville',
      });
    } finally {
      await db.delete(bookingsTable).where(eq(bookingsTable.id, bookingId));
      await db.delete(dogsTable).where(eq(dogsTable.id, staffDogId));
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Trigger-fallback mapping — gateTriggerErrorToApiError
// ──────────────────────────────────────────────────────────────────────────

test('gateTriggerErrorToApiError — maps eval-gate check_violation to typed evaluation_required', () => {
  const pgError = {
    code: '23514',
    message:
      'evaluation gate: lead dog 11111111-1111-4111-8111-111111111111 must have evaluation_status = passed (category day-school)',
  };
  const mapped = gateTriggerErrorToApiError(pgError);
  assert.ok(mapped, 'expected a mapped ApiError');
  assert.equal(mapped.code, 'evaluation_required');
  assert.equal(mapped.status, 422);
  assert.equal(mapped.details?.kind, 'evaluation_required');
});
