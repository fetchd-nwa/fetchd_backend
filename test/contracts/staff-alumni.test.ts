import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { charges, creditLedger, dogCompletedPrograms, dogs } from '../../src/db/schema/schema.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerStaffAlumniRoute } from '../../src/routes/staffAlumni.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';
import type { Principal } from '../../src/auth/principal.js';

/**
 * §J.3 staff alumni verbs + the derived-alumni effects:
 *   - GET/POST/DELETE /staff/dogs/:dogId/completed-programs
 *   - POST /staff/dogs/:dogId/clear-alumni-flag
 *   - recording the 5th program flips `is_alumni` on the §B dog wire AND
 *     clears `expires_at` on the dog's LIVE lots (expired lots stay dead)
 *   - a purchase AFTER becoming alumni grants a never-expiring lot
 *   - un-recording (DELETE) flips the wire back and does NOT re-stamp lots
 */

registerFixtureHooks();

function staffApp(principal: Principal = FIXTURE_STAFF_PRINCIPAL): {
  app: ReturnType<typeof makeContractApp>['app'];
} {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffAlumniRoute(app, { authenticate, now: FIXTURE_NOW });
  return { app };
}

function ownerDogsApp(): { app: ReturnType<typeof makeContractApp>['app'] } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, { authenticate, now: FIXTURE_NOW });
  return { app };
}

function purchaseApp(): { app: ReturnType<typeof makeContractApp>['app'] } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerCreditPackagesRoute(app, { authenticate, stripe: makeStripeStub(), now: FIXTURE_NOW });
  return { app };
}

const PROGRAMS_URL = `/staff/dogs/${FIXTURE_IDS.dog1Id}/completed-programs`;

interface ProgramsWire {
  dog_id: string;
  is_alumni: boolean;
  completed_programs: { program: string; completed_at: string }[];
  alumni_attendance_flagged_at?: string;
}

async function resetAlumniState(): Promise<void> {
  await db.delete(dogCompletedPrograms).where(eq(dogCompletedPrograms.dogId, FIXTURE_IDS.dog1Id));
  await db
    .update(dogs)
    .set({ alumniAttendanceFlaggedAt: null })
    .where(eq(dogs.id, FIXTURE_IDS.dog1Id));
}

async function recordProgram(
  app: ReturnType<typeof makeContractApp>['app'],
  program: string,
): Promise<ProgramsWire> {
  const res = await app.inject({
    method: 'POST',
    url: PROGRAMS_URL,
    headers: { 'idempotency-key': randomUUID() },
    payload: { program },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as ProgramsWire;
}

test(
  'GET completed-programs — empty record, not alumni; owner → 403',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetAlumniState();
    const { app } = staffApp();
    const res = await app.inject({ method: 'GET', url: PROGRAMS_URL });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as ProgramsWire;
    assert.equal(body.dog_id, FIXTURE_IDS.dog1Id);
    assert.equal(body.is_alumni, false);
    assert.deepEqual(body.completed_programs, []);
    assert.equal('alumni_attendance_flagged_at' in body, false, 'omit-on-null');

    const ownerRes = await staffApp(FIXTURE_OWNER_PRINCIPAL).app.inject({
      method: 'GET',
      url: PROGRAMS_URL,
    });
    assert.equal(ownerRes.statusCode, 403, ownerRes.body);

    const unknownRes = await app.inject({
      method: 'GET',
      url: `/staff/dogs/${randomUUID()}/completed-programs`,
    });
    assert.equal(unknownRes.statusCode, 404, unknownRes.body);
  },
);

test(
  'recording all 5 programs — wire flips at the 5th, live lots clear, expired lots stay dead',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetAlumniState();
    const { app } = staffApp();

    // Seed one LIVE expiring lot + one already-EXPIRED lot for dog1.
    const liveLotId = randomUUID();
    const expiredLotId = randomUUID();
    const past = '2026-01-01T00:00:00.000Z';
    const future = '2026-12-01T00:00:00.000Z';
    await db.insert(creditLedger).values([
      {
        id: liveLotId,
        dogId: FIXTURE_IDS.dog1Id,
        mode: 'school',
        location: 'fayetteville',
        delta: 3,
        reason: 'purchase',
        expiresAt: future,
      },
      {
        id: expiredLotId,
        dogId: FIXTURE_IDS.dog1Id,
        mode: 'school',
        location: 'fayetteville',
        delta: 3,
        reason: 'purchase',
        expiresAt: past,
      },
    ]);

    // First 4 programs: not yet alumni, lots untouched.
    for (const program of CURRICULUM_PROGRAMS.slice(0, 4)) {
      const body = await recordProgram(app, program);
      assert.equal(body.is_alumni, false, `${program}: 4 or fewer ⇒ not alumni`);
    }
    const [liveBefore] = await db
      .select({ expiresAt: creditLedger.expiresAt })
      .from(creditLedger)
      .where(eq(creditLedger.id, liveLotId));
    assert.ok(liveBefore?.expiresAt, 'live lot still expiring before the 5th program');

    // The 5th program is the became-alumni moment.
    const fifth = await recordProgram(app, CURRICULUM_PROGRAMS[4]);
    assert.equal(fifth.is_alumni, true, 'all 5 ⇒ alumni');
    assert.equal(fifth.completed_programs.length, 5);

    const [liveAfter] = await db
      .select({ expiresAt: creditLedger.expiresAt })
      .from(creditLedger)
      .where(eq(creditLedger.id, liveLotId));
    assert.equal(liveAfter?.expiresAt, null, 'live lot cleared to never-expire');
    const [expiredAfter] = await db
      .select({ expiresAt: creditLedger.expiresAt })
      .from(creditLedger)
      .where(eq(creditLedger.id, expiredLotId));
    assert.ok(expiredAfter?.expiresAt, 'already-expired lot stays dead');

    // §B dog wire flips too.
    const dogRes = await ownerDogsApp().app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}`,
    });
    assert.equal(dogRes.statusCode, 200, dogRes.body);
    const dogWire = dogRes.json() as { is_alumni: boolean };
    assert.equal(dogWire.is_alumni, true);

    // Re-recording an already-live program is an idempotent no-op (still 201,
    // still 5 rows, and NOT a second became-alumni lot clear).
    const repeat = await recordProgram(app, CURRICULUM_PROGRAMS[4]);
    assert.equal(repeat.completed_programs.length, 5);

    await db.delete(creditLedger).where(eq(creditLedger.id, liveLotId));
    await db.delete(creditLedger).where(eq(creditLedger.id, expiredLotId));
  },
);

test(
  'purchase AFTER alumni — multi-credit lot grants with NULL expiry',
  SKIP_WHEN_NO_DB,
  async () => {
    // dog1 is alumni from the prior test's records (same-file serial order);
    // re-assert rather than assume.
    const staffRes = await staffApp().app.inject({ method: 'GET', url: PROGRAMS_URL });
    assert.equal((staffRes.json() as ProgramsWire).is_alumni, true, 'precondition: alumni');

    const res = await purchaseApp().app.inject({
      method: 'POST',
      url: `/credit-packages/${FIXTURE_IDS.creditPackageSchool10Key}/purchase`,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        dog_id: FIXTURE_IDS.dog1Id,
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        location: 'fayetteville',
      },
    });
    assert.equal(res.statusCode, 201, res.body);

    const lots = await db
      .select({ expiresAt: creditLedger.expiresAt })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.dogId, FIXTURE_IDS.dog1Id),
          eq(creditLedger.reason, 'purchase'),
          eq(creditLedger.delta, 10),
        ),
      );
    assert.equal(lots.length, 1, 'exactly one 10-credit lot');
    assert.equal(lots[0]!.expiresAt, null, 'alumni purchase never expires (§J.3)');

    // Cleanup this purchase so later files see the seeded ledger only.
    await db
      .delete(creditLedger)
      .where(
        and(
          eq(creditLedger.dogId, FIXTURE_IDS.dog1Id),
          eq(creditLedger.delta, 10),
          isNull(creditLedger.expiresAt),
        ),
      );
    await db.delete(charges).where(eq(charges.purpose, 'package'));
  },
);

test('DELETE un-records — wire flips back, second DELETE 404s', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const target = CURRICULUM_PROGRAMS[2];
  const res = await app.inject({
    method: 'DELETE',
    url: `${PROGRAMS_URL}/${target}`,
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as ProgramsWire;
  assert.equal(body.is_alumni, false, 'dropping to 4 live rows un-derives alumni');
  assert.equal(body.completed_programs.length, 4);

  const again = await app.inject({
    method: 'DELETE',
    url: `${PROGRAMS_URL}/${target}`,
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(again.statusCode, 404, 'no live completion left to expire');

  await resetAlumniState();
});

test('clear-alumni-flag — clears, surfaces on the wire, idempotent', SKIP_WHEN_NO_DB, async () => {
  await resetAlumniState();
  await db
    .update(dogs)
    .set({ alumniAttendanceFlaggedAt: '2026-05-01T12:00:00.000Z' })
    .where(eq(dogs.id, FIXTURE_IDS.dog1Id));

  const { app } = staffApp();
  const before = await app.inject({ method: 'GET', url: PROGRAMS_URL });
  assert.equal(
    (before.json() as ProgramsWire).alumni_attendance_flagged_at,
    '2026-05-01T12:00:00.000Z',
  );

  const res = await app.inject({
    method: 'POST',
    url: `/staff/dogs/${FIXTURE_IDS.dog1Id}/clear-alumni-flag`,
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as ProgramsWire;
  assert.equal('alumni_attendance_flagged_at' in body, false, 'flag cleared');

  // Clearing an already-clear flag stays 200 (idempotent staff verb).
  const again = await app.inject({
    method: 'POST',
    url: `/staff/dogs/${FIXTURE_IDS.dog1Id}/clear-alumni-flag`,
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(again.statusCode, 200, again.body);
});
