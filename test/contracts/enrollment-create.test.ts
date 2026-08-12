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
  idempotencyKeys as idempotencyKeysTable,
  invoices as invoicesTable,
  paymentMethods,
  refunds as refundsTable,
  requiredVaccines,
} from '../../src/db/schema/schema.js';
import { and as andOp } from 'drizzle-orm';
import { hashRequestBody } from '../../src/db/mutation.js';
import { withActor } from '../../src/db/tx.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import type { GroupClassKey } from '../../src/db/repositories/groupClassesRepository.js';
import type { StripeClient, StripePaymentIntentResult } from '../../src/lib/stripe.js';
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
    // Wire 1.9.0: `payment_failed` (402), NOT `payment_required` (422). Mobile's
    // booking gate maps `payment_required` to the buy-credits "payment required"
    // modal, so this decline used to tell the owner they needed to pay rather
    // than that their card didn't go through — a live category error.
    assert.equal(res.statusCode, 402, res.body);
    const enrollErr = (
      res.json() as { error: { code: string; details: { charge_blocker: string } } }
    ).error;
    assert.equal(enrollErr.code, 'payment_failed');
    assert.equal(enrollErr.details.charge_blocker, 'authentication_required');

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

test(
  'POST /enrollments — a THROWN card decline refuses identically to a returned one (wire 1.9.0)',
  SKIP_WHEN_NO_DB,
  async () => {
    // Stripe reports a declined stored card either by returning a non-succeeded
    // intent or by throwing a card error. Before 1.9.0 the thrown fork blew past
    // this refusal into `chargeEachDogNow`'s unwind + a 500; now both forks
    // reach the same 402 with the same blocker, and no dog is enrolled either
    // way.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();
    stripe.setNextIntentThrowsCardError('requires_payment_method');

    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-thrown-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: false },
    });

    assert.equal(res.statusCode, 402, res.body);
    const body = res.json() as {
      error: { code: string; details: { charge_blocker: string } };
    };
    assert.equal(body.error.code, 'payment_failed');
    assert.equal(body.error.details.charge_blocker, 'declined');
    assert.equal(stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length, 1);
    assert.equal(stripe.calls.filter((c) => c.method === 'createRefund').length, 0);
    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, 0, 'dog NOT enrolled on a thrown decline either');
    const chargeRows = await db
      .select({ id: chargesTable.id })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(chargeRows.length, 0, 'no charge row for a non-succeeded intent');
  },
);

test(
  'POST /enrollments — a RECORDED 3DS failure refuses with authentication_required, not declined',
  SKIP_WHEN_NO_DB,
  async () => {
    // Driven by the error live Stripe ACTUALLY threw for a 3DS card off-session
    // (`test/fixtures/stripe-thrown-confirm.json`), not a hand-built one. Its
    // attached intent rests at `requires_payment_method` — the same status a
    // plain decline rests at — so before 2026-08-11 this route told an owner
    // whose card needed verification to try a different card. The recorded
    // decline is asserted alongside it so the fix cannot invert the bug.
    for (const [scenario, expected] of [
      ['authentication-required', 'authentication_required'],
      ['saved-card-declined', 'declined'],
    ] as const) {
      const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
      const { app, stripe } = enrollApp();
      stripe.setNextIntentThrowsRecorded(scenario);

      const res = await postEnrollment({
        app,
        idempotencyKey: `enr-rec-${scenario}-${randomUUID()}`,
        payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: false },
      });

      assert.equal(res.statusCode, 402, `${scenario}: ${res.body}`);
      const body = res.json() as { error: { code: string; details: { charge_blocker: string } } };
      assert.equal(body.error.code, 'payment_failed');
      assert.equal(body.error.details.charge_blocker, expected);
      // The unwind is unchanged by which sentence the owner reads.
      assert.equal(stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length, 1);
      assert.equal(stripe.calls.filter((c) => c.method === 'createRefund').length, 0);
      const bookingRows = await db
        .select({ id: bookingsTable.id })
        .from(bookingsTable)
        .where(eq(bookingsTable.cohortId, cohort.id));
      assert.equal(bookingRows.length, 0, `${scenario}: no dog enrolled`);
      const chargeRows = await db
        .select({ id: chargesTable.id })
        .from(chargesTable)
        .where(eq(chargesTable.cohortId, cohort.id));
      assert.equal(chargeRows.length, 0, `${scenario}: no charge row`);
    }
  },
);

test(
  'POST /enrollments — one dog declined + one dog PROCESSING reports processing, not declined',
  SKIP_WHEN_NO_DB,
  async () => {
    // The double-charge path. A multi-dog enroll charges one intent per dog and
    // can report only ONE blocker; picking it by position (first sorted dog id)
    // rather than by hazard is how the `processing` shield gets thrown away.
    //
    // Concretely: dog1 declines, dog2 comes back `processing`. Report
    // `declined` and mobile renders "try a different card" → the owner picks a
    // different card → the card is part of mobile's idempotency-key signature →
    // a FRESH key → dog2 is charged again, while the first `processing` intent
    // (the one kind our unwind cannot cancel) settles anyway. Two charges.
    //
    // dog1Id sorts before dog2Id, so the queue below puts the decline FIRST —
    // exactly the order in which first-match aggregation reports the wrong one.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();
    stripe.queueIntentOutcomes([
      { kind: 'recorded', scenario: 'saved-card-declined' },
      { kind: 'status', status: 'processing' },
    ]);

    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-mixed-${randomUUID()}`,
      payload: {
        cohort_id: cohort.id,
        dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
        pay_later: false,
      },
    });

    assert.equal(res.statusCode, 402, res.body);
    const body = res.json() as { error: { code: string; details: { charge_blocker: string } } };
    assert.equal(body.error.code, 'payment_failed');
    assert.equal(
      body.error.details.charge_blocker,
      'processing',
      'the in-flight dog outranks the declined one — "try a different card" here is a double charge',
    );

    // Both dogs were charged, both intents unwound, nothing enrolled.
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent').length,
      2,
      'one intent per dog',
    );
    assert.equal(stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length, 2);
    assert.equal(stripe.calls.filter((c) => c.method === 'createRefund').length, 0);
    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, 0, 'no dog enrolled');
    const chargeRows = await db
      .select({ id: chargesTable.id })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(chargeRows.length, 0, 'no charge row');
  },
);

test(
  'POST /enrollments — a mixed decline set with NO processing dog still reports the first dog',
  SKIP_WHEN_NO_DB,
  async () => {
    // The tie half of the hazard rule: `declined` and `authentication_required`
    // rank equal (both send the owner to the card picker), so the earliest dog
    // in the stable sorted order keeps the slot and the response is unchanged
    // from what it always was. Pins that the ranking did not quietly become a
    // preference between the two copy arms.
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();
    stripe.queueIntentOutcomes([
      { kind: 'recorded', scenario: 'authentication-required' },
      { kind: 'recorded', scenario: 'saved-card-declined' },
    ]);

    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-mixed-tie-${randomUUID()}`,
      payload: {
        cohort_id: cohort.id,
        dog_ids: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
        pay_later: false,
      },
    });

    assert.equal(res.statusCode, 402, res.body);
    const body = res.json() as { error: { details: { charge_blocker: string } } };
    assert.equal(body.error.details.charge_blocker, 'authentication_required', 'first dog wins ties');
    assert.equal(stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length, 2);
  },
);

test(
  'POST /enrollments — a Stripe TRANSPORT error is not relabelled a decline',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();
    stripe.setNextIntentThrowsTransport();

    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-transport-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: false },
    });

    // "We could not reach Stripe" is not "your card was declined": a 402 here
    // would send the owner hunting for a different card during an outage.
    assert.notEqual(res.statusCode, 402);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'internal');
    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, 0);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Losing the idempotency claim race must NOT unwind the winner's money
//
// Two requests, ONE Idempotency-Key. The pay-now capture happens pre-tx under
// `<key>:dog:<dogId>`, so Stripe's own idempotency hands the second request the
// FIRST one's already-captured PaymentIntent. If the second then unwinds on its
// way out, it refunds a charge the first is about to enroll against: the owner
// is charged, enrolled, AND refunded.
//
// What the harness can and cannot drive, measured rather than assumed:
//   - `withIdempotency`'s claim is `INSERT ... ON CONFLICT (key) DO NOTHING`
//     inside the SAME transaction as the work. A second same-key request's
//     INSERT therefore BLOCKS on the first's uncommitted row (verified against
//     the test Postgres: the second statement waits indefinitely rather than
//     returning zero rows) and resolves as a REPLAY once the first commits —
//     the first test below asserts exactly that end state.
//   - `idempotency_inflight` needs an observable claim row that is COMMITTED
//     with `completed_at IS NULL`, which no single-transaction writer can leave
//     behind. So the second test commits that row directly — the same
//     "simulate another connection holding this key in-flight" device
//     `test/idempotency.test.ts` uses — and then lets the holder finish for
//     real through the route. The 409, the capture, the refund decision and the
//     committed money are all the real code paths; only the in-flight WINDOW is
//     placed by hand.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Enrollments app whose Stripe seam behaves like the real one on idempotency:
 * the same `idempotency_key` returns the SAME PaymentIntent instead of minting
 * a second one. Without this a stub makes two same-key requests look like two
 * separate captures, which is precisely the confusion the bug lives in. Returns
 * the memo so a test can assert "the intent the loser held IS the winner's".
 */
function enrollAppWithStripeIdempotency(): {
  app: ReturnType<typeof makeContractApp>['app'];
  stripe: ReturnType<typeof makeStripeStub>;
  intentByKey: Map<string, StripePaymentIntentResult>;
} {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  const intentByKey = new Map<string, StripePaymentIntentResult>();
  const stripeWithIdempotency: StripeClient = {
    ...stripe,
    async createAndConfirmPaymentIntent(args, idempotencyKey) {
      const replayed = intentByKey.get(idempotencyKey);
      if (replayed !== undefined) {
        // Record the attempt so the test still sees both requests asking, then
        // hand back the intent Stripe already created for this key.
        stripe.calls.push({ method: 'createAndConfirmPaymentIntent', args, idempotencyKey });
        return replayed;
      }
      const created = await stripe.createAndConfirmPaymentIntent(args, idempotencyKey);
      intentByKey.set(idempotencyKey, created);
      return created;
    },
  };
  registerEnrollmentsRoute(app, {
    authenticate,
    stripe: stripeWithIdempotency,
    now: FIXTURE_NOW,
  });
  return { app, stripe, intentByKey };
}

/** Commit a claim row for `key` with `completed_at IS NULL` — the state a
 *  request that owns the key and is still executing would present if its claim
 *  were visible to others. */
async function seedInflightClaim(key: string, requestHash: string): Promise<void> {
  await withActor(`owner:${FIXTURE_IDS.ownerId}`, async (tx) => {
    await tx.insert(idempotencyKeysTable).values({
      key,
      ownerId: FIXTURE_IDS.ownerId,
      endpoint: 'POST /enrollments',
      requestHash,
    });
  });
}

test(
  'POST /enrollments — two CONCURRENT pay-now requests with the SAME Idempotency-Key: one enrolls, the other replays it, and the shared PaymentIntent is never refunded',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollAppWithStripeIdempotency();
    const key = `enr-samekey-race-${randomUUID()}`;
    const payload = { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: false };

    const [a, b] = await Promise.all([
      postEnrollment({ app, idempotencyKey: key, payload }),
      postEnrollment({ app, idempotencyKey: key, payload }),
    ]);

    // Neither is an error: the loser's claim INSERT waits on the winner's
    // uncommitted row and resolves as a replay of the stored 201.
    assert.equal(a.statusCode, 201, a.body);
    assert.equal(b.statusCode, 201, b.body);
    assert.deepEqual(a.json(), b.json(), 'the loser replayed the winner’s response');

    // Both asked Stripe under the same per-dog key, so there is ONE intent.
    const piCalls = stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent');
    assert.equal(piCalls.length, 2, 'both requests reached the pre-tx capture');
    assert.deepEqual(
      [...new Set(piCalls.map((c) => c.idempotencyKey))],
      [`${key}:dog:${FIXTURE_IDS.dog1Id}`],
      'one Stripe idempotency key → one PaymentIntent',
    );

    // The money invariant: charged once, enrolled, nothing given back.
    const chargeRows = await db
      .select({ status: chargesTable.status })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(chargeRows.length, 1, 'exactly one charges row');
    assert.equal(chargeRows[0]!.status, 'succeeded');
    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, cohort.weeks, 'the enrollment exists (one booking per week)');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'granted and NOT refunded',
    );
    assert.equal(stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length, 0);
  },
);

test(
  'POST /enrollments — pay-now request that LOSES the claim race → 409 idempotency_inflight, and the in-flight request’s captured PaymentIntent is left alone (granted, not refunded)',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe, intentByKey } = enrollAppWithStripeIdempotency();
    const key = `enr-inflight-${randomUUID()}`;
    const payload = {
      cohort_id: cohort.id,
      dog_ids: [FIXTURE_IDS.dog1Id],
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: false,
    };
    // The request that owns the key is mid-transaction: claimed, not completed.
    await seedInflightClaim(key, hashRequestBody(payload));

    // ── The loser arrives. It captures (Stripe returns the in-flight
    //    request's intent for this key), then loses the claim. ──
    const loser = await postEnrollment({ app, idempotencyKey: key, payload });
    assert.equal(loser.statusCode, 409, loser.body);
    assert.equal(
      (loser.json() as { error: { code: string } }).error.code,
      'idempotency_inflight',
      'the loser must surface the 409, not a refund’s own failure',
    );
    const sharedIntentId = intentByKey.get(`${key}:dog:${FIXTURE_IDS.dog1Id}`)?.id;
    assert.ok(sharedIntentId, 'the loser did capture — that is why the unwind was tempting');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'the loser must NOT refund a PaymentIntent it does not own',
    );
    assert.equal(
      stripe.calls.filter((c) => c.method === 'cancelPaymentIntent').length,
      0,
      'and must not cancel it either',
    );

    // ── The in-flight request now finishes: its claim resolves and its
    //    transaction commits the enrollment against that same intent. ──
    await db.delete(idempotencyKeysTable).where(eq(idempotencyKeysTable.key, key));
    const winner = await postEnrollment({ app, idempotencyKey: key, payload });
    assert.equal(winner.statusCode, 201, winner.body);

    const chargeRows = await db
      .select({ status: chargesTable.status, intentId: chargesTable.stripePaymentIntentId })
      .from(chargesTable)
      .where(eq(chargesTable.cohortId, cohort.id));
    assert.equal(chargeRows.length, 1, 'exactly one charges row');
    assert.equal(chargeRows[0]!.status, 'succeeded');
    assert.equal(
      chargeRows[0]!.intentId,
      sharedIntentId,
      'the committed charge IS the intent the loser was holding — refunding it would have undone this money',
    );
    const bookingRows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.cohortId, cohort.id));
    assert.equal(bookingRows.length, cohort.weeks, 'the enrollment exists (one booking per week)');
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      0,
      'no refund was ever issued: the owner is charged once, enrolled, and keeps neither half of a granted-and-refunded booking',
    );
  },
);

test(
  'POST /enrollments — the inflight exclusion did not widen: a NON-inflight in-tx failure after capture (already_enrolled) still refunds',
  SKIP_WHEN_NO_DB,
  async () => {
    const cohort = await makeCohort({ classKey: 'puppy', capacity: 6, filled: 0, weeks: 4 });
    const { app, stripe } = enrollApp();

    // Enroll the dog pay-later first (no Stripe call), so the second enroll
    // trips the in-tx duplicate guard AFTER its card is already captured.
    const first = await postEnrollment({
      app,
      idempotencyKey: `enr-dup-seed-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: true },
    });
    assert.equal(first.statusCode, 201, first.body);

    const res = await postEnrollment({
      app,
      idempotencyKey: `enr-dup-paynow-${randomUUID()}`,
      payload: { cohort_id: cohort.id, dog_ids: [FIXTURE_IDS.dog1Id], pay_later: false },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'already_enrolled');

    assert.equal(
      stripe.calls.filter((c) => c.method === 'createAndConfirmPaymentIntent').length,
      1,
      'the card was captured pre-tx',
    );
    assert.equal(
      stripe.calls.filter((c) => c.method === 'createRefund').length,
      1,
      'every error that is NOT idempotency_inflight still unwinds',
    );
  },
);
