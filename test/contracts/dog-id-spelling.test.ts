import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  charges,
  cohorts,
  creditLedger,
  dogCompletedPrograms,
  eventRsvpDogs,
  invoices,
  memberships,
  notifications,
  pendingRequestDogs,
  refunds,
} from '../../src/db/schema/schema.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerEventsRoute } from '../../src/routes/events.js';
import { registerMembershipsRoute } from '../../src/routes/memberships.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { registerStaffAlumniRoute } from '../../src/routes/staffAlumni.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { clearInvoiceReferrers, FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
  registerRequestServicesOn,
} from './_harness.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * The rest of R14's class (P13 fix round 1, F4). Postgres reads a uuid in either
 * case, so a capitalised dog id is the same dog to every query, and a different
 * string to everything that compares strings: the `Set` behind a distinct check, a
 * primary key's second insert, an advisory lock's key, a cache key. `POST /bookings`
 * was closed in P13's item 0a. These are the other bodies that reach one of those.
 * Each normalises the id at its parse boundary, so nothing past the parse holds a
 * second spelling.
 *
 * Bodies that only hand the id to a query, the withdrawal, attendance and the report
 * among them, do not reach one, and were probed: `evidence/backend/fix1/`.
 */

registerFixtureHooks();
registerRequestServicesOn();

const createdDogIds: string[] = [];
const createdCohortIds: string[] = [];

afterEach(async () => {
  await clearMemberships();
  await removeDogs(createdDogIds.splice(0));
  if (createdCohortIds.length > 0) {
    await db.delete(cohorts).where(inArray(cohorts.id, createdCohortIds.splice(0)));
  }
});

/** A dog of the fixture owner whose id holds a letter. `dog1Id` is all digits. */
async function dogWithLetters(): Promise<{ lower: string; upper: string }> {
  const lower = await createBookableDog(createdDogIds);
  const upper = lower.toUpperCase();
  assert.notEqual(lower, upper, 'this id has no letter to capitalise');
  return { lower, upper };
}

function appWith(
  register: (
    app: FastifyInstance,
    authenticate: ReturnType<typeof makeContractApp>['authenticate'],
  ) => void,
): FastifyInstance {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  register(app, authenticate);
  return app;
}

function errorOf(res: { body: string }): { code: string; message: string } {
  return (JSON.parse(res.body) as { error: { code: string; message: string } }).error;
}

// ── POST /enrollments ────────────────────────────────────────────────────────

async function makeCohort(): Promise<string> {
  const id = randomUUID();
  createdCohortIds.push(id);
  await db.insert(cohorts).values({
    id,
    classKey: 'puppy',
    location: 'fayetteville',
    startDate: '2026-07-06',
    endDate: null,
    weeklyTime: '6:00 PM',
    weeks: 2,
    capacity: 6,
    filled: 0,
  });
  return id;
}

function enrollments(): { app: FastifyInstance; stripe: StripeStub } {
  const stripe = makeStripeStub();
  const app = appWith((a, authenticate) =>
    registerEnrollmentsRoute(a, { authenticate, stripe, now: FIXTURE_NOW }),
  );
  return { app, stripe };
}

function enroll(app: FastifyInstance, cohortId: string, dogIds: string[]) {
  return app.inject({
    method: 'POST',
    url: '/enrollments',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      cohort_id: cohortId,
      dog_ids: dogIds,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      pay_later: true,
    },
  });
}

test(
  'POST /enrollments: one dog twice in two cases is the distinct-dogs refusal, no seat taken',
  SKIP_WHEN_NO_DB,
  async () => {
    const { lower, upper } = await dogWithLetters();
    const cohortId = await makeCohort();
    const { app, stripe } = enrollments();

    const res = await enroll(app, cohortId, [lower, upper]);

    assert.equal(res.statusCode, 422, res.body);
    assert.equal(errorOf(res).code, 'invalid_payload');
    assert.match(errorOf(res).message, /distinct/);
    const [cohort] = await db
      .select({ filled: cohorts.filled })
      .from(cohorts)
      .where(eq(cohorts.id, cohortId));
    assert.equal(cohort?.filled, 0, 'no seat taken');
    const rows = await db.select().from(bookingDogs).where(eq(bookingDogs.dogId, lower));
    assert.equal(rows.length, 0);
    assert.equal(stripe.calls.length, 0);
  },
);

test(
  'POST /enrollments: one capitalised dog enrols, and the answer carries the id as stored',
  SKIP_WHEN_NO_DB,
  async () => {
    const { lower, upper } = await dogWithLetters();
    const cohortId = await makeCohort();
    const { app } = enrollments();

    const res = await enroll(app, cohortId, [upper]);

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Array<{ dog_id: string }>;
    assert.deepEqual([...new Set(body.map((b) => b.dog_id))], [lower]);
  },
);

// ── POST /requests ───────────────────────────────────────────────────────────

function postRequest(dogs: { lead: string; additional: string[] }) {
  const app = appWith((a, authenticate) =>
    registerRequestsRoute(a, { authenticate, now: FIXTURE_NOW }),
  );
  return app.inject({
    method: 'POST',
    url: '/requests',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      category: 'boarding',
      lead_dog_id: dogs.lead,
      additional_dog_ids: dogs.additional,
      preferred_dates: ['2026-07-15T15:00:00Z'],
    },
  });
}

async function requestRowsFor(dogId: string): Promise<number> {
  const rows = await db
    .select({ id: pendingRequestDogs.requestId })
    .from(pendingRequestDogs)
    .where(eq(pendingRequestDogs.dogId, dogId));
  return rows.length;
}

test(
  'POST /requests: the lead again in another case is the distinct-dogs refusal, not a 500',
  SKIP_WHEN_NO_DB,
  async () => {
    const { lower, upper } = await dogWithLetters();
    const res = await postRequest({ lead: lower, additional: [upper] });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(errorOf(res).code, 'invalid_payload');
    assert.match(errorOf(res).message, /distinct/);
    assert.equal(await requestRowsFor(lower), 0);
  },
);

test('POST /requests: the lead capitalised is the same refusal', SKIP_WHEN_NO_DB, async () => {
  const { lower, upper } = await dogWithLetters();
  const res = await postRequest({ lead: upper, additional: [lower] });
  assert.equal(res.statusCode, 422, res.body);
  assert.match(errorOf(res).message, /distinct/);
  assert.equal(await requestRowsFor(lower), 0);
});

test(
  'POST /requests: an additional dog twice in two cases is the same refusal',
  SKIP_WHEN_NO_DB,
  async () => {
    const lead = await dogWithLetters();
    const { lower, upper } = await dogWithLetters();
    const res = await postRequest({ lead: lead.lower, additional: [lower, upper] });
    assert.equal(res.statusCode, 422, res.body);
    assert.match(errorOf(res).message, /distinct/);
    assert.equal(await requestRowsFor(lead.lower), 0);
  },
);

// ── POST /events/:id/rsvp ────────────────────────────────────────────────────

test(
  'POST /events/:id/rsvp: one dog twice in two cases is its own 400, not a 500',
  SKIP_WHEN_NO_DB,
  async () => {
    const { lower, upper } = await dogWithLetters();
    const app = appWith((a, authenticate) => registerEventsRoute(a, { authenticate }));
    const res = await app.inject({
      method: 'POST',
      url: `/events/${FIXTURE_IDS.eventYappyHourId}/rsvp`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { dog_ids: [lower, upper] },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(errorOf(res).code, 'bad_request');
    assert.match(errorOf(res).message, /distinct/);
    const rows = await db.select().from(eventRsvpDogs).where(eq(eventRsvpDogs.dogId, lower));
    assert.equal(rows.length, 0);
  },
);

// ── POST /memberships: found by the probe, an advisory key built from the body ──

async function clearMemberships(): Promise<void> {
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.ownerId, FIXTURE_IDS.ownerId),
        eq(notifications.type, 'membership-ended'),
      ),
    );
  await db.delete(creditLedger).where(eq(creditLedger.reason, 'membership-grant'));
  await clearInvoiceReferrers();
  await db.delete(invoices).where(isNotNull(invoices.membershipId));
  const chargeIds = (
    await db.select({ id: charges.id }).from(charges).where(eq(charges.purpose, 'membership'))
  ).map((c) => c.id);
  if (chargeIds.length > 0) await db.delete(refunds).where(inArray(refunds.chargeId, chargeIds));
  await db.delete(charges).where(eq(charges.purpose, 'membership'));
  await db.delete(memberships).where(eq(memberships.ownerId, FIXTURE_IDS.ownerId));
}

function subscribe(app: FastifyInstance, dogId: string) {
  return app.inject({
    method: 'POST',
    url: '/memberships',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      dog_id: dogId,
      package_key: FIXTURE_IDS.creditPackageSchool10Key,
      location: 'fayetteville',
      term_months: 3,
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
    },
  });
}

test(
  'POST /memberships: a capitalised id takes the lowercase lock, so it queues behind it',
  { ...SKIP_WHEN_NO_DB, timeout: 20_000 },
  async () => {
    const { lower, upper } = await dogWithLetters();
    const app = appWith((a, authenticate) =>
      registerMembershipsRoute(a, { authenticate, stripe: makeStripeStub(), now: FIXTURE_NOW }),
    );
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `membership:${lower}:school`,
      ]);

      let settled = false;
      const pending = subscribe(app, upper).then((res) => {
        settled = true;
        return res;
      });
      const deadline = Date.now() + 2000;
      let queued = 0;
      while (Date.now() < deadline && !settled && queued === 0) {
        const waiting = await holder.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        queued = waiting.rows[0]?.n ?? 0;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await holder.query('COMMIT');

      assert.equal(queued, 1, 'the request queued on the lowercase key');
      assert.equal((await pending).statusCode, 201);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  },
);

test(
  'POST /memberships: two subscribes in two cases past the probe, and the loser is refunded',
  { ...SKIP_WHEN_NO_DB, timeout: 30_000 },
  async () => {
    const { lower, upper } = await dogWithLetters();
    const stub = makeStripeStub();
    // Both charges land before either write, the seconds-wide race the re-check under
    // the lock exists for.
    let arrived = 0;
    let bothCharged: () => void = () => undefined;
    const charged = new Promise<void>((resolve) => {
      bothCharged = resolve;
    });
    const stripe: StripeStub = {
      ...stub,
      async createAndConfirmPaymentIntent(args, key) {
        const intent = await stub.createAndConfirmPaymentIntent(args, key);
        arrived += 1;
        if (arrived === 2) bothCharged();
        await charged;
        return intent;
      },
    };
    const app = appWith((a, authenticate) =>
      registerMembershipsRoute(a, { authenticate, stripe, now: FIXTURE_NOW }),
    );

    const answers = await Promise.all([subscribe(app, lower), subscribe(app, upper)]);

    assert.deepEqual(
      answers.map((res) => res.statusCode),
      [201, 201],
      answers.map((res) => res.body).join(' | '),
    );
    const refunded = answers.filter(
      (res) => (res.json() as { charge_refunded: boolean }).charge_refunded,
    );
    assert.equal(refunded.length, 1, 'the owner is told which charge came back');
    assert.equal((await db.select().from(memberships)).length, 1);
    assert.equal((await db.select().from(refunds)).length, 1, 'the second charge has its refund');
  },
);

// ── POST /credit-packages/:key/purchase: a cache key built from the body ─────

test(
  'a purchase with a capitalised id wipes the lowercase credits cache: the next read is fresh',
  SKIP_WHEN_NO_DB,
  async () => {
    const { lower, upper } = await dogWithLetters();
    const app = appWith((a, authenticate) => {
      registerCreditsRoute(a, { authenticate });
      registerCreditPackagesRoute(a, { authenticate, stripe: makeStripeStub(), now: FIXTURE_NOW });
    });
    const schoolBalance = async (): Promise<number> => {
      const res = await app.inject({
        method: 'GET',
        url: `/dogs/${lower}/credits?location=fayetteville`,
      });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json() as { school: number }).school;
    };

    try {
      assert.equal(await schoolBalance(), 0, 'read once, so the balance is cached');

      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          dog_id: upper,
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 201, res.body);

      assert.equal(await schoolBalance(), 5, 'the purchase shows on the next read');
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.dogId, lower));
      await db.delete(charges).where(eq(charges.dogId, lower));
    }
  },
);

// ── Path params that reach a cache key (Fable probe F4; P14) ─────────────────

test(
  'GET /dogs/:id/credits: a capitalised read is fresh after a purchase',
  SKIP_WHEN_NO_DB,
  async () => {
    const { lower, upper } = await dogWithLetters();
    const app = appWith((a, authenticate) => {
      registerCreditsRoute(a, { authenticate });
      registerCreditPackagesRoute(a, { authenticate, stripe: makeStripeStub(), now: FIXTURE_NOW });
    });
    const read = async (id: string): Promise<{ dog_id: string; school: number }> => {
      const res = await app.inject({
        method: 'GET',
        url: `/dogs/${id}/credits?location=fayetteville`,
      });
      assert.equal(res.statusCode, 200, res.body);
      return res.json() as { dog_id: string; school: number };
    };

    try {
      assert.equal((await read(upper)).school, 0, 'read in capitals, so the balance is cached');

      const res = await app.inject({
        method: 'POST',
        url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool5Key}/purchase`,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          dog_id: lower,
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
          location: 'fayetteville',
        },
      });
      assert.equal(res.statusCode, 201, res.body);

      assert.equal((await read(lower)).school, 5, 'the lowercase read is fresh');
      const capitalised = await read(upper);
      assert.equal(capitalised.school, 5, 'and the capitalised read is the same read');
      assert.equal(capitalised.dog_id, lower, 'the wire holds one spelling');
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.dogId, lower));
      await db.delete(charges).where(eq(charges.dogId, lower));
    }
  },
);

test(
  'POST /staff/dogs/:dogId/completed-programs: a capitalised path wipes the lowercase credits cache',
  SKIP_WHEN_NO_DB,
  async () => {
    const { lower, upper } = await dogWithLetters();
    const reader = appWith((a, authenticate) => registerCreditsRoute(a, { authenticate }));
    const expiringLots = async (): Promise<number> => {
      const res = await reader.inject({
        method: 'GET',
        url: `/dogs/${lower}/credits?location=fayetteville`,
      });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json() as { expiring_lots: unknown[] }).expiring_lots.length;
    };
    const { app: staff, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffAlumniRoute(staff, { authenticate, now: FIXTURE_NOW });
    await db.insert(creditLedger).values({
      dogId: lower,
      mode: 'school',
      location: 'fayetteville',
      delta: 3,
      reason: 'purchase',
      expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    });

    try {
      assert.equal(await expiringLots(), 1, 'read once, so the expiring lot is cached');

      // The fifth program makes her an alumna, which clears every live expiry.
      for (const program of CURRICULUM_PROGRAMS) {
        const res = await staff.inject({
          method: 'POST',
          url: `/staff/dogs/${upper}/completed-programs`,
          headers: { 'idempotency-key': randomUUID() },
          payload: { program },
        });
        assert.equal(res.statusCode, 201, res.body);
      }

      assert.equal(await expiringLots(), 0, 'the cleared expiry shows on the next read');
    } finally {
      await db.delete(dogCompletedPrograms).where(eq(dogCompletedPrograms.dogId, lower));
    }
  },
);
