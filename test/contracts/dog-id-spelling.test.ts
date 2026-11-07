import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  cohorts,
  creditLedger,
  dogCompletedPrograms,
  eventRsvpDogs,
  pendingRequestDogs,
} from '../../src/db/schema/schema.js';
import { registerEnrollmentsRoute } from '../../src/routes/enrollments.js';
import { registerEventsRoute } from '../../src/routes/events.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { registerStaffAlumniRoute } from '../../src/routes/staffAlumni.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
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

// ── POST /credit-packages/:key/purchase: a cache key built from the body ─────

// ── Path params that reach a cache key (Fable probe F4; P14) ─────────────────

test(
  'POST /staff/dogs/:dogId/completed-programs: a capitalised path records the lowercase dog and moves no lot',
  SKIP_WHEN_NO_DB,
  async () => {
    const { lower, upper } = await dogWithLetters();
    const { app: staff, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerStaffAlumniRoute(staff, { authenticate, now: FIXTURE_NOW });
    const expiresAt = new Date(Date.now() + 60 * 86_400_000).toISOString();
    const [lot] = await db
      .insert(creditLedger)
      .values({
        ownerId: FIXTURE_IDS.ownerId,
        mode: 'school',
        location: 'fayetteville',
        delta: 3,
        reason: 'purchase',
        expiresAt,
      })
      .returning({ id: creditLedger.id });
    const stampOf = async (): Promise<number> => {
      const [row] = await db
        .select({ expiresAt: creditLedger.expiresAt })
        .from(creditLedger)
        .where(eq(creditLedger.id, lot?.id as string));
      return new Date(row?.expiresAt as string).getTime();
    };

    try {
      // The fifth program makes her an alumna, and her credits expire like anyone's.
      for (const program of CURRICULUM_PROGRAMS) {
        const res = await staff.inject({
          method: 'POST',
          url: `/staff/dogs/${upper}/completed-programs`,
          headers: { 'idempotency-key': randomUUID() },
          payload: { program },
        });
        assert.equal(res.statusCode, 201, res.body);
      }

      const recorded = await db
        .select({ program: dogCompletedPrograms.program })
        .from(dogCompletedPrograms)
        .where(eq(dogCompletedPrograms.dogId, lower));
      assert.equal(recorded.length, CURRICULUM_PROGRAMS.length, 'on the lowercase dog');
      assert.equal(await stampOf(), new Date(expiresAt).getTime(), 'the lot still expires');
    } finally {
      await db.delete(dogCompletedPrograms).where(eq(dogCompletedPrograms.dogId, lower));
      await db.delete(creditLedger).where(eq(creditLedger.id, lot?.id as string));
    }
  },
);
