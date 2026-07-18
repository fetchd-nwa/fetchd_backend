import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  agreementDocuments,
  bookings as bookingsTable,
  bookingDogs as bookingDogsTable,
  charges as chargesTable,
  cohorts as cohortsTable,
  invoices as invoicesTable,
  paymentMethods,
  refunds as refundsTable,
  requiredVaccines,
} from '../../src/db/schema/schema.js';
import { and as andOp } from 'drizzle-orm';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import type { GroupClassKey } from '../../src/db/repositories/groupClassesRepository.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Day 11 contract tests for POST /enrollments — group-class cohort
 * enrollment. Exercises the full transactional path against real
 * Postgres through the live Fastify request lifecycle.
 *
 * Coverage (every Day-11 Exit-check branch):
 *   - Happy paths: single-dog → N bookings; multi-dog → N×weeks bookings.
 *   - Cohort capacity: filled+requested > capacity → 422 cohort_full.
 *   - R7 eligibility: dog missing OR-prereqs → 422 eligibility_missing
 *     with per-dog gap detail.
 *   - Gates (priority order, each surfaces structured `details`):
 *     payment → vaccine → agreement against 'group-class'.
 *   - Concurrency: cohort row lock serializes two concurrent
 *     enrollments racing on the same capacity-1 cohort.
 *   - Idempotency: replay returns stored body, no second filled bump.
 *   - Authorization: staff → 403; unknown dog → 404.
 *   - Soft-expired cohort → 404 (cohort doesn't exist for enrollment).
 *   - Schema floor: bookings.cohort_id is stamped + booking_dogs is
 *     single-dog per booking + bumpFilled honored.
 *
 * Cross-test state isolation:
 *   - Each test inserts its own cohort with a random UUID so filled
 *     bumps + booking inserts don't bleed across tests.
 *   - Gate-fail tests insert their breakage in try/finally so the
 *     fixture state stays clean for downstream tests in the file.
 */

registerFixtureHooks();

const SIX_WEEKS_OUT_UTC = '2026-07-06T23:00:00Z'; // ~6 weeks past FIXTURE_TODAY

/** Insert a fresh cohort and return its row data. Returns the id +
 * starting `filled` so the test can assert post-enrollment counts.
 * No cleanup — per-test rows accumulate in the shared test DB and
 * each run starts from the seedFixture reset. */
async function makeCohort(args: {
  classKey: GroupClassKey;
  capacity: number;
  filled?: number;
  startDate?: string;
  weeks?: number;
  location?: 'fayetteville' | 'bentonville';
}): Promise<{ id: string; filled: number; weeks: number }> {
  const id = randomUUID();
  const weeks = args.weeks ?? 4;
  const filled = args.filled ?? 0;
  await db.insert(cohortsTable).values({
    id,
    classKey: args.classKey,
    location: args.location ?? 'fayetteville',
    startDate: args.startDate ?? SIX_WEEKS_OUT_UTC,
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks,
    capacity: args.capacity,
    filled,
  });
  return { id, filled, weeks };
}

/** Build a Fastify app with the enrollments route registered. Injects a Stripe
 * stub (pay-now / withdraw refund) + FIXTURE_NOW (the withdraw pre-start guard). */
function enrollApp(principal = FIXTURE_OWNER_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
} {
  const { app, authenticate } = makeContractApp(principal);
  const stripe = makeStripeStub();
  registerEnrollmentsRoute(app, { authenticate, stripe, now: FIXTURE_NOW });
  return { app, stripe };
}

/**
 * Inject a POST /enrollments call. Defaults to a valid card + `pay_later: true`
 * so the structural assertions (bookings, capacity, gates, idempotency) don't
 * each have to thread Stripe; pay-now tests override `pay_later: false`.
 */
async function postEnrollment(opts: {
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
    url: '/enrollments',
    headers,
    payload: {
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: true,
      ...opts.payload,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Happy paths
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /enrollments — single-dog puppy cohort → 201 + BookingWire[weeks] + filled +1',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-1-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
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
    assert.equal(body.length, cohort.weeks, 'one booking per week');
    for (const wire of body) {
      assert.equal(wire.dog_id, FIXTURE_IDS.dog1Id);
      assert.equal(wire.category, 'group-class');
      assert.equal(wire.status, 'upcoming');
      assert.equal(wire.location, 'fayetteville');
      assert.equal(wire.additional_dog_ids, undefined, 'group-class bookings are single-dog');
    }

    // cohort.filled bumped by 1 atomically.
    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 1);

    // Each booking carries cohort_id + single booking_dogs row with is_lead=true.
    const ids = body.map((b) => b.id);
    const links = await db
      .select({
        bookingId: bookingDogsTable.bookingId,
        dogId: bookingDogsTable.dogId,
        isLead: bookingDogsTable.isLead,
      })
      .from(bookingDogsTable)
      .where(eq(bookingDogsTable.dogId, FIXTURE_IDS.dog1Id));
    const cohortLinks = links.filter((l) => ids.includes(l.bookingId));
    assert.equal(cohortLinks.length, cohort.weeks);
    for (const link of cohortLinks) {
      assert.equal(link.isLead, true);
    }
    const bookingsForCohort = await db
      .select({ cohortId: bookingsTable.cohortId, sessionReportId: bookingsTable.sessionReportId })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingsForCohort.length, cohort.weeks);
    for (const b of bookingsForCohort) {
      assert.equal(b.cohortId, cohort.id);
      assert.equal(b.sessionReportId, null, 'session_report_id is NULL at enrollment time');
    }
  },
);

test(
  'POST /enrollments — same dog already enrolled in the cohort → 422 already_enrolled (Day-19d guard)',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app } = enrollApp();
    const first = await postEnrollment({
      app,
      idempotencyKey: `enr-dup-1-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
    });
    assert.equal(first.statusCode, 201, first.body);

    const second = await postEnrollment({
      app,
      idempotencyKey: `enr-dup-2-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
    });
    assert.equal(second.statusCode, 422, second.body);
    const body = second.json() as {
      error: { code: string; details: { kind: string; cohort_id: string; dog_ids: string[] } };
    };
    assert.equal(body.error.code, 'already_enrolled');
    assert.equal(body.error.details.cohort_id, cohort.id);
    assert.deepEqual(body.error.details.dog_ids, [FIXTURE_IDS.dog1Id]);

    // The duplicate attempt did not bump filled past the first enrollment.
    const [row] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(row?.filled, 1, 'filled stays at 1 — the duplicate enroll was rejected');
  },
);

test(
  'POST /enrollments — multi-dog (2 dogs) → 2 × weeks bookings + filled +2',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-multi-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id] },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Array<{ id: string; dog_id: string; date: string }>;
    assert.equal(body.length, 2 * cohort.weeks, '|dog_ids| × weeks');

    const dogCounts = new Map<string, number>();
    for (const wire of body) {
      dogCounts.set(wire.dog_id, (dogCounts.get(wire.dog_id) ?? 0) + 1);
    }
    assert.equal(dogCounts.get(FIXTURE_IDS.dog1Id), cohort.weeks);
    assert.equal(dogCounts.get(FIXTURE_IDS.dog2Id), cohort.weeks);

    // Returned ASC by scheduled_at primary (route emits in
    // session-then-dog order; same scheduled_at across the 2 dogs of
    // a given week → adjacent in the response).
    const dates = body.map((w) => new Date(w.date).getTime());
    for (let i = 1; i < dates.length; i += 1) {
      assert.ok(dates[i - 1]! <= dates[i]!, 'BookingWire[] is ASC by date');
    }

    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 2);
  },
);

test(
  'POST /enrollments — weekly cadence preserves Chicago wall time across weeks',
  SKIP_WHEN_NO_DB,
  async () => {
    // 2026-07-06T23:00:00Z = 6 PM Chicago CDT (UTC-5). One week later
    // (2026-07-13) is still CDT → same wall, same UTC offset = same
    // UTC timestamp + 7d. Test confirms exactly 7-day UTC delta across
    // weeks during stable-DST periods.
    const cohort = await makeCohort({
      classKey: 'puppy',
      capacity: 6,
      filled: 0,
      weeks: 4,
      startDate: SIX_WEEKS_OUT_UTC,
    });
    const { app } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-cadence-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Array<{ id: string; date: string }>;
    assert.equal(body.length, 4);
    const ts = body.map((b) => new Date(b.date).getTime()).sort((a, b) => a - b);
    const ONE_WEEK_MS = 7 * 86_400_000;
    assert.equal(ts[1]! - ts[0]!, ONE_WEEK_MS, 'week 1 = week 0 + 7d (CDT stable)');
    assert.equal(ts[2]! - ts[1]!, ONE_WEEK_MS, 'week 2 = week 1 + 7d (CDT stable)');
    assert.equal(ts[3]! - ts[2]!, ONE_WEEK_MS, 'week 3 = week 2 + 7d (CDT stable)');
  },
);

test(
  'POST /enrollments — sets cancel_deadline_at = scheduled_at - 48h (group-class)',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 2 });
    const { app } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-cancel-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Array<{ id: string }>;
    const rows = await db
      .select({
        scheduledAt: bookingsTable.scheduledAt,
        cancelDeadlineAt: bookingsTable.cancelDeadlineAt,
      })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(rows.length, body.length);
    for (const row of rows) {
      const delta = new Date(row.scheduledAt).getTime() - new Date(row.cancelDeadlineAt!).getTime();
      assert.equal(delta, 48 * 60 * 60 * 1000, '48h window for group-class');
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Cohort capacity (filled + requested > capacity)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /enrollments — cohort full → 422 cohort_full with structured details',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 1, filled: 1 });
    const { app } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-full-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as {
      error: {
        code: string;
        details: {
          kind: string;
          cohort_id: string;
          capacity: number;
          filled: number;
          requested: number;
        };
      };
    };
    assert.equal(body.error.code, 'cohort_full');
    assert.equal(body.error.details.kind, 'cohort_full');
    assert.equal(body.error.details.cohort_id, cohort.id);
    assert.equal(body.error.details.capacity, 1);
    assert.equal(body.error.details.filled, 1);
    assert.equal(body.error.details.requested, 1);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// R7 eligibility (server-derived prereqs)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /enrollments — dog without prereqs → 422 eligibility_missing with per-dog gaps',
  SKIP_WHEN_NO_DB,
  async () => {
    // manners-2 has class_prereq_options=[manners-1]. Waffles has
    // manners-1 completed (fixture); Lola does not. Enrolling BOTH
    // surfaces Lola in the gap list.
    const cohort = await makeCohort({
      classKey: 'manners-2',
      capacity: 6,
      filled: 0,
      location: 'bentonville',
    });
    const { app } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-elig-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id] },
    });
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as {
      error: {
        code: string;
        details: {
          kind: string;
          gaps: { dog_id: string; missing_alternatives: string[] }[];
        };
      };
    };
    assert.equal(body.error.code, 'eligibility_missing');
    assert.equal(body.error.details.kind, 'eligibility_missing');
    assert.equal(body.error.details.gaps.length, 1, 'only Lola is missing prereqs');
    assert.equal(body.error.details.gaps[0]!.dog_id, FIXTURE_IDS.dog2Id);
    assert.deepEqual(body.error.details.gaps[0]!.missing_alternatives, ['manners-1']);

    // No bookings were inserted, no filled bump.
    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 0);
  },
);

test('POST /enrollments — dog WITH prereq passes eligibility → 201', SKIP_WHEN_NO_DB, async () => {
  const cohort = await makeCohort({
    classKey: 'manners-2',
    capacity: 6,
    filled: 0,
    location: 'bentonville',
  });
  const { app } = enrollApp();
  const res = await postEnrollment({
    app,
    idempotencyKey: `enr-elig-ok-${randomUUID()}`,
    payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] }, // Waffles has manners-1
  });
  assert.equal(res.statusCode, 201, res.body);
});

// ──────────────────────────────────────────────────────────────────────────
// Gate failures (payment → vaccine → agreement, same shape as Day 10)
// ──────────────────────────────────────────────────────────────────────────

test('POST /enrollments — payment gate → 422 payment_required', SKIP_WHEN_NO_DB, async () => {
  const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
  await db
    .update(paymentMethods)
    .set({ expiredAt: sql`now()` })
    .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
  try {
    const { app } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-paygate-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as { error: { code: string; details: { kind: string } } };
    assert.equal(body.error.code, 'payment_required');
    assert.equal(body.error.details.kind, 'payment_required');
  } finally {
    await db
      .update(paymentMethods)
      .set({ expiredAt: null })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
  }
});

test(
  'POST /enrollments — vaccine gate against group-class fires with structured details',
  SKIP_WHEN_NO_DB,
  async () => {
    // Inject a new required_vaccine that gates group-class but neither
    // dog has a satisfying dog_vaccines row for. Vaccine gate → 422.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
    const vaxKey = `test-gc-vax-${randomUUID().slice(0, 8)}`;
    await db.insert(requiredVaccines).values({
      key: vaxKey,
      label: 'Group-Class-Gating Test Vaccine',
      gatesCategories: ['group-class'],
    });
    try {
      const { app } = enrollApp();
      const res = await postEnrollment({
        app,
        idempotencyKey: `enr-vacgate-${randomUUID()}`,
        payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
      });
      assert.equal(res.statusCode, 422, res.body);
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
      const ours = body.error.details.missing.find(
        (m) => m.requirement_key === vaxKey && m.dog_id === FIXTURE_IDS.dog1Id,
      );
      assert.ok(ours, `missing[] should include ${vaxKey} for ${FIXTURE_IDS.dog1Id}`);
    } finally {
      await db.delete(requiredVaccines).where(eq(requiredVaccines.key, vaxKey));
    }
  },
);

test(
  'POST /enrollments — agreement gate against group-class fires with structured details',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
    const docKey = `test-gc-agreement-${randomUUID().slice(0, 8)}`;
    await db.insert(agreementDocuments).values({
      key: docKey,
      label: 'Group-Class Waiver (test)',
      currentVersion: 1,
      required: true,
      appliesTo: ['group-class'],
    });
    try {
      const { app } = enrollApp();
      const res = await postEnrollment({
        app,
        idempotencyKey: `enr-agrgate-${randomUUID()}`,
        payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
      });
      assert.equal(res.statusCode, 422, res.body);
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

// ──────────────────────────────────────────────────────────────────────────
// Concurrency (cohort row lock serializes)
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /enrollments — race on cohort: two concurrent enrollments serialize on row lock',
  SKIP_WHEN_NO_DB,
  async () => {
    // capacity=1 cohort. Two concurrent owner requests, one dog each.
    // The cohort row lock makes them serialize; the second sees
    // filled=1 (the first's bump) → 422 cohort_full.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 1, filled: 0 });
    const app1 = enrollApp().app;
    const app2 = enrollApp().app;
    const [a, b] = await Promise.all([
      postEnrollment({
        app: app1,
        idempotencyKey: `enr-race1-${randomUUID()}`,
        payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
      }),
      postEnrollment({
        app: app2,
        idempotencyKey: `enr-race2-${randomUUID()}`,
        payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog2Id] },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(codes, [201, 422], `expected [201, 422], got ${codes}`);

    // Filled bumped exactly once.
    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 1);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Idempotency
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /enrollments — idempotent replay returns identical body, no second filled bump',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app } = enrollApp();
    const key = `enr-idemp-${randomUUID()}`;
    const payload = { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] };
    const a = await postEnrollment({ app, idempotencyKey: key, payload });
    const b = await postEnrollment({ app, idempotencyKey: key, payload });
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.deepEqual(a.json(), b.json(), 'replay returns identical body');

    // Exactly ONE filled bump (idempotent replay didn't double-bump).
    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 1, 'replay must not double-bump filled');

    // Exactly `weeks` bookings (no second insertion pass).
    const created = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(created.length, cohort.weeks);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Authorization + 404 paths
// ──────────────────────────────────────────────────────────────────────────

test('POST /enrollments — staff principal → 403 forbidden', SKIP_WHEN_NO_DB, async () => {
  const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
  const { app } = enrollApp(FIXTURE_STAFF_PRINCIPAL);
  const res = await postEnrollment({
    app,
    idempotencyKey: `enr-staff-${randomUUID()}`,
    payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
  });
  assert.equal(res.statusCode, 403);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'forbidden');
});

test('POST /enrollments — unknown dog_id → 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
  const { app } = enrollApp();
  const fakeDogId = randomUUID();
  const res = await postEnrollment({
    app,
    idempotencyKey: `enr-unowned-${randomUUID()}`,
    payload: { cohort_id: cohort.id, dog_ids: [fakeDogId] },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'not_found');
});

test('POST /enrollments — unknown cohort_id → 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const { app } = enrollApp();
  const fakeCohort = randomUUID();
  const res = await postEnrollment({
    app,
    idempotencyKey: `enr-cohort-${randomUUID()}`,
    payload: { cohort_id: fakeCohort, dog_ids: [FIXTURE_IDS.dog1Id] },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'not_found');
});

test('POST /enrollments — soft-expired cohort → 404 not_found', SKIP_WHEN_NO_DB, async () => {
  const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
  // Soft-expire after creation. The schema's `live(cohorts)` is the
  // catalog-read filter; the route checks `expiredAt !== null` on the
  // locked row directly so soft-expired cohorts can't be enrolled.
  await db
    .update(cohortsTable)
    .set({ expiredAt: sql`now()` })
    .where(eq(cohortsTable.id, cohort.id));
  const { app } = enrollApp();
  const res = await postEnrollment({
    app,
    idempotencyKey: `enr-expired-${randomUUID()}`,
    payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'not_found');
});

// ──────────────────────────────────────────────────────────────────────────
// Body validation
// ──────────────────────────────────────────────────────────────────────────

test('POST /enrollments — missing Idempotency-Key → 400 bad_request', SKIP_WHEN_NO_DB, async () => {
  const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
  const { app } = enrollApp();
  const res = await postEnrollment({
    app,
    payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id] },
  });
  assert.equal(res.statusCode, 400);
});

test(
  'POST /enrollments — empty dog_ids → 400 bad_request (Zod min(1))',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
    const { app } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-empty-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [] },
    });
    assert.equal(res.statusCode, 400);
  },
);

test('POST /enrollments — duplicate dog_ids → 422 invalid_payload', SKIP_WHEN_NO_DB, async () => {
  const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
  const { app } = enrollApp();
  const res = await postEnrollment({
    app,
    idempotencyKey: `enr-dup-${randomUUID()}`,
    payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog1Id] },
  });
  assert.equal(res.statusCode, 422);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_payload');
});

// ──────────────────────────────────────────────────────────────────────────
// Payment (Δ 2026-06-09) — pay-now charge / pay-later invoice
// ──────────────────────────────────────────────────────────────────────────

const PUPPY_PRICE_PER_DOG_CENTS = 12_000; // fixture group_classes.puppy

async function postWithdraw(opts: {
  app: ReturnType<typeof makeContractApp>['app'];
  cohortId: string;
  dogId: string;
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
    url: `/enrollments/${opts.cohortId}/withdraw`,
    headers,
    payload: { dog_id: opts.dogId },
  });
}

test(
  'POST /enrollments — pay-now → succeeded group-class charge per dog (cohort_id + dog_id stamped)',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-paynow-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: false },
    });
    assert.equal(res.statusCode, 201, res.body);

    // One PaymentIntent confirmed for the one dog.
    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 1);

    const charge = await db
      .select()
      .from(chargesTable)
      .where(
        andOp(eq(chargesTable.cohortId, cohort.id), eq(chargesTable.dogId, FIXTURE_IDS.dog1Id)),
      );
    assert.equal(charge.length, 1, 'one charge for the (cohort, dog)');
    assert.equal(charge[0]!.status, 'succeeded');
    assert.equal(charge[0]!.purpose, 'group-class');
    assert.equal(charge[0]!.amountCents, PUPPY_PRICE_PER_DOG_CENTS);

    // No invoice on the pay-now path.
    const invs = await db.select().from(invoicesTable).where(eq(invoicesTable.cohortId, cohort.id));
    assert.equal(invs.length, 0);
  },
);

test(
  'POST /enrollments — pay-later → open group-class invoice due 24h before the first session (no Stripe call)',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({
      classKey: 'puppy',
      capacity: 6,
      filled: 0,
      weeks: 4,
      startDate: SIX_WEEKS_OUT_UTC,
    });
    const { app, stripe } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-paylater-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: true },
    });
    assert.equal(res.statusCode, 201, res.body);

    assert.equal(
      stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent').length,
      0,
      'pay-later does not call Stripe at enroll time',
    );

    const invs = await db
      .select()
      .from(invoicesTable)
      .where(
        andOp(eq(invoicesTable.cohortId, cohort.id), eq(invoicesTable.dogId, FIXTURE_IDS.dog1Id)),
      );
    assert.equal(invs.length, 1, 'one open invoice for the (cohort, dog)');
    assert.equal(invs[0]!.status, 'open');
    assert.equal(invs[0]!.purpose, 'group-class');
    assert.equal(invs[0]!.amountCents, PUPPY_PRICE_PER_DOG_CENTS);
    // due_at = first session (cohort start) − 24h. SIX_WEEKS_OUT − 24h.
    const expectedDue = new Date(new Date(SIX_WEEKS_OUT_UTC).getTime() - 24 * 60 * 60 * 1000);
    assert.equal(new Date(invs[0]!.dueAt).getTime(), expectedDue.getTime());
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Withdraw (Δ 2026-06-09) — refund (pay-now) / void (pay-later) / guards
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /enrollments/:cohortId/withdraw — pay-now → refund + filled−1 + bookings cancelled',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();
    await postEnrollment({
      app,
      idempotencyKey: `enr-wd-pay-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: false },
    });

    const res = await postWithdraw({
      app,
      cohortId: cohort.id,
      dogId: FIXTURE_IDS.dog1Id,
      idempotencyKey: `wd-pay-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { withdrawn: boolean; refunded_cents: number };
    assert.equal(body.withdrawn, true);
    assert.equal(body.refunded_cents, PUPPY_PRICE_PER_DOG_CENTS, 'full per-dog refund');

    // Stripe refund fired (post-commit) + a refunds row landed.
    assert.equal(stripe.calls.filter((c) => c.method === 'createRefund').length, 1);
    const refundRows = await db
      .select()
      .from(refundsTable)
      .where(eq(refundsTable.ownerId, FIXTURE_IDS.ownerId));
    assert.ok(refundRows.length >= 1);

    // Seat released + every weekly booking cancelled.
    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 0, 'filled decremented back to 0');
    const live = await db
      .select({ status: bookingsTable.status })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.ok(
      live.every((b) => b.status === 'cancelled'),
      'all weekly bookings cancelled',
    );

    // Cleanup the refunds/charges this test created so the shared owner state
    // stays clean for later files.
    await db.delete(refundsTable).where(eq(refundsTable.ownerId, FIXTURE_IDS.ownerId));
    await db.delete(chargesTable).where(eq(chargesTable.cohortId, cohort.id));
  },
);

test(
  'POST /enrollments/:cohortId/withdraw — pay-later (unpaid) → invoice voided, nothing charged',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();
    await postEnrollment({
      app,
      idempotencyKey: `enr-wd-later-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: true },
    });

    const res = await postWithdraw({
      app,
      cohortId: cohort.id,
      dogId: FIXTURE_IDS.dog1Id,
      idempotencyKey: `wd-later-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { refunded_cents: number };
    assert.equal(body.refunded_cents, 0, 'nothing was charged, so nothing refunded');
    assert.equal(stripe.calls.filter((c) => c.method === 'createRefund').length, 0);

    // Invoice voided → the auto-charge worker will never bill it.
    const invs = await db
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.cohortId, cohort.id));
    assert.equal(invs.length, 1);
    assert.equal(invs[0]!.status, 'void');

    const [updated] = await db
      .select({ filled: cohortsTable.filled })
      .from(cohortsTable)
      .where(eq(cohortsTable.id, cohort.id));
    assert.equal(updated?.filled, 0);

    await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohort.id));
  },
);

test(
  'POST /enrollments/:cohortId/withdraw — class already started → 409 conflict (no self-serve withdraw)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Cohort started a week before FIXTURE_NOW (2026-05-19). Enroll succeeds
    // (enroll has no started-guard); withdraw is blocked.
    const cohort = await makeCohort({
      classKey: 'puppy',
      capacity: 6,
      filled: 0,
      weeks: 4,
      startDate: '2026-05-12T23:00:00Z',
    });
    const { app } = enrollApp();
    await postEnrollment({
      app,
      idempotencyKey: `enr-wd-started-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: true },
    });

    const res = await postWithdraw({
      app,
      cohortId: cohort.id,
      dogId: FIXTURE_IDS.dog1Id,
      idempotencyKey: `wd-started-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'conflict');

    await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohort.id));
  },
);

test(
  'POST /enrollments/:cohortId/withdraw — dog not enrolled → 409 conflict',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0 });
    const { app } = enrollApp();
    const res = await postWithdraw({
      app,
      cohortId: cohort.id,
      dogId: FIXTURE_IDS.dog1Id,
      idempotencyKey: `wd-none-${randomUUID()}`,
    });
    assert.equal(res.statusCode, 409, res.body);
  },
);

test(
  'GET /enrollments — lists the owner current enrollments with payment_status + can_withdraw',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({
      classKey: 'puppy',
      capacity: 6,
      filled: 0,
      weeks: 4,
      startDate: SIX_WEEKS_OUT_UTC,
    });
    const { app } = enrollApp();
    await postEnrollment({
      app,
      idempotencyKey: `enr-get-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: true },
    });

    const res = await app.inject({ method: 'GET', url: '/enrollments' });
    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json() as Array<{
      cohort_id: string;
      dog_id: string;
      class_key: string;
      payment_status: string;
      can_withdraw: boolean;
    }>;
    const mine = rows.find((r) => r.cohort_id === cohort.id && r.dog_id === FIXTURE_IDS.dog1Id);
    assert.ok(mine, 'the new enrollment is listed');
    assert.equal(mine!.class_key, 'puppy');
    assert.equal(mine!.payment_status, 'pay-later');
    assert.equal(mine!.can_withdraw, true, 'future cohort → still withdrawable');

    await db.delete(invoicesTable).where(eq(invoicesTable.cohortId, cohort.id));
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Money is never stranded (Δ 2026-07-18) — pay-now captures the card BEFORE
// the enroll tx, so any post-charge failure must unwind the captured money.
// ──────────────────────────────────────────────────────────────────────────

test(
  'POST /enrollments — pay-now into a FULL cohort → 422 cohort_full AND every captured card is refunded (no stranded money, no bookings, no charge rows)',
  SKIP_WHEN_NO_DB,
  async () => {
    // capacity 1, two dogs → filled(0)+requested(2) > 1 → cohort_full IN the tx,
    // AFTER both cards already charged pre-tx. Both must be refunded.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 1, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-full-paynow-${randomUUID()}`,
      payload: {
        cohort_id: cohort.id,
        dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
        pay_later: false,
      },
    });
    assert.equal(res.statusCode, 422);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'cohort_full');

    // Both cards were charged pre-tx, then BOTH refunded when the tx rolled back.
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent').length,
      2,
      'both dogs charged pre-tx',
    );
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      2,
      'both captured charges refunded — money is not stranded',
    );

    // The tx rolled back cleanly: no bookings, no charge rows.
    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, 0, 'no bookings created');
    const chargeRows = await db
      .select({ id: chargesTable.id })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(chargeRows.length, 0, 'no charge rows (tx rolled back)');
  },
);

test(
  'POST /enrollments — pay-now intent that does NOT reach succeeded (off-session 3DS) → payment_required, dog NOT enrolled, intent cancelled (not charged)',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();
    // A stored-card off-session confirm that can't settle unattended.
    stripe.setNextIntentStatus('requires_action');
    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-unsettled-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: false },
    });
    assert.equal((res.json() as { error: { code: string } }).error.code, 'payment_required');

    // A non-succeeded intent never captured money → it's CANCELLED, not refunded,
    // and nothing is enrolled or recorded.
    assert.equal(stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length, 1);
    assert.equal(stripe.calls.filter((c) => c.method === 'createRefund').length, 0);
    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, 0, 'dog NOT enrolled on an unsettled charge');
    const chargeRows = await db
      .select({ id: chargesTable.id })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(chargeRows.length, 0, 'no charge row for a non-succeeded intent');
  },
);
