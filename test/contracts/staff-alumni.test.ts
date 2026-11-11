import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  creditLedger,
  dogCompletedPrograms,
  notifications,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { returnDebitsToLots } from '../../src/lib/orderRows.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerStaffAlumniRoute } from '../../src/routes/staffAlumni.js';
import { runSchedulerTickOnce } from '../../src/workers/scheduler.js';
import { makeExpoPushStub } from './_expoPushStub.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import type { Principal } from '../../src/auth/principal.js';
import type { CompletedProgramsWire } from '../../src/contracts/wire.js';

/**
 * §J.3 staff alumni verbs and what alumni status does:
 *   - GET/POST/DELETE /staff/dogs/:dogId/completed-programs
 *   - recording the 5th program flips `is_alumni` on the §B dog wire
 *   - ALUM-U16 (wire 5.0.0-lg4.1): alumni credits expire like everyone's. No lot's
 *     expiry moves when a dog becomes alumni, a purchase takes the ordinary expiry at
 *     both grant sites, and a cancel follows the ordinary rule
 *   - ALUM-U01, a KEEP: one status, and no lapse. The third half, the exemption from
 *     the three-month clock, is `booking-no-divert.test.ts`'s
 *     'an alumni dog with no attended day books at once'
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

const PROGRAMS_URL = `/staff/dogs/${FIXTURE_IDS.dog1Id}/completed-programs`;

// The hand mirror is gone — 1.13.0 promoted the real shape (digest
// dogs-profile/S). Aliased so the 6 existing `as ProgramsWire` casts in this
// file keep reading naturally.
type ProgramsWire = CompletedProgramsWire;

async function resetAlumniState(): Promise<void> {
  await db.delete(dogCompletedPrograms).where(eq(dogCompletedPrograms.dogId, FIXTURE_IDS.dog1Id));
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
  },
);

// The dog-exists check used to live on a read of the attendance flag. With the flag
// gone this 404 is the only thing that says the route still looks for the dog.
test('GET completed-programs for a dog that does not exist: 404', SKIP_WHEN_NO_DB, async () => {
  const { app } = staffApp();
  const res = await app.inject({
    method: 'GET',
    url: `/staff/dogs/${randomUUID()}/completed-programs`,
  });
  assert.equal(res.statusCode, 404, res.body);
});

test(
  'recording all 5 programs: the wire flips at the 5th and no lot moves',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetAlumniState();
    const { app } = staffApp();

    // One LIVE expiring lot and one already-EXPIRED lot for dog1.
    const liveLotId = randomUUID();
    const expiredLotId = randomUUID();
    const past = '2026-01-01T00:00:00.000Z';
    const future = '2026-12-01T00:00:00.000Z';
    await db.insert(creditLedger).values([
      {
        id: liveLotId,
        ownerId: FIXTURE_IDS.ownerId,
        mode: 'school',
        location: 'fayetteville',
        delta: 3,
        reason: 'purchase',
        expiresAt: future,
      },
      {
        id: expiredLotId,
        ownerId: FIXTURE_IDS.ownerId,
        mode: 'school',
        location: 'fayetteville',
        delta: 3,
        reason: 'purchase',
        expiresAt: past,
      },
    ]);

    const expiryOf = async (id: string): Promise<string | null | undefined> => {
      const [row] = await db
        .select({ expiresAt: creditLedger.expiresAt })
        .from(creditLedger)
        .where(eq(creditLedger.id, id));
      return row?.expiresAt;
    };
    const liveBefore = await expiryOf(liveLotId);
    const expiredBefore = await expiryOf(expiredLotId);
    assert.ok(liveBefore !== null && liveBefore !== undefined);

    try {
      for (const program of CURRICULUM_PROGRAMS.slice(0, 4)) {
        const body = await recordProgram(app, program);
        assert.equal(body.is_alumni, false, `${program}: 4 or fewer ⇒ not alumni`);
      }

      // The 5th program makes the dog alumni and changes no lot's expiry (ALUM-U16).
      const fifth = await recordProgram(app, CURRICULUM_PROGRAMS[4]);
      assert.equal(fifth.is_alumni, true, 'all 5 ⇒ alumni');
      assert.equal(fifth.completed_programs.length, 5);
      assert.equal(await expiryOf(liveLotId), liveBefore, 'the live lot keeps its expiry');
      assert.equal(await expiryOf(expiredLotId), expiredBefore, 'the expired lot stays expired');

      // §B dog wire flips too.
      const dogRes = await ownerDogsApp().app.inject({
        method: 'GET',
        url: `/dogs/${FIXTURE_IDS.dog1Id}`,
      });
      assert.equal(dogRes.statusCode, 200, dogRes.body);
      assert.equal((dogRes.json() as { is_alumni: boolean }).is_alumni, true);

      // Re-recording an already-live program is an idempotent no-op: still 201, 5 rows.
      const repeat = await recordProgram(app, CURRICULUM_PROGRAMS[4]);
      assert.equal(repeat.completed_programs.length, 5);
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.id, liveLotId));
      await db.delete(creditLedger).where(eq(creditLedger.id, expiredLotId));
    }
  },
);

test(
  "a cancel returning a credit to an alumni dog's dead lot follows the ordinary rule",
  SKIP_WHEN_NO_DB,
  async () => {
    const staffRes = await staffApp().app.inject({ method: 'GET', url: PROGRAMS_URL });
    assert.equal((staffRes.json() as ProgramsWire).is_alumni, true, 'precondition: alumni');

    const bookingId = FIXTURE_IDS.booking2Id;
    const deadLotId = randomUUID();
    await db.insert(creditLedger).values({
      id: deadLotId,
      ownerId: FIXTURE_IDS.ownerId,
      mode: 'school',
      location: 'fayetteville',
      delta: 1,
      reason: 'purchase',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    await db.insert(creditLedger).values({
      ownerId: FIXTURE_IDS.ownerId,
      dogId: FIXTURE_IDS.dog1Id,
      mode: 'school',
      location: 'fayetteville',
      delta: -1,
      reason: 'booking-debit',
      bookingId,
      lotId: deadLotId,
    });

    try {
      await withActor('test:alumni-cancel', (tx) =>
        returnDebitsToLots(tx, { bookingIds: [bookingId], now: FIXTURE_NOW() }),
      );

      const [refund] = await db
        .select({ lotId: creditLedger.lotId, expiresAt: creditLedger.expiresAt })
        .from(creditLedger)
        .where(
          and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'settlement-return')),
        );
      assert.ok(refund !== undefined, 'the credit came back');
      assert.equal(refund.lotId, null, 'a fresh lot, the source being dead');
      assert.ok(refund.expiresAt !== null, "and it expires like anyone's");
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.bookingId, bookingId));
      await db.delete(creditLedger).where(eq(creditLedger.id, deadLotId));
    }
  },
);

test(
  'DELETE un-records a level, and the dog stays alumni; second DELETE 404s',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = staffApp();
    const target = CURRICULUM_PROGRAMS[2];
    const res = await app.inject({
      method: 'DELETE',
      url: `${PROGRAMS_URL}/${target}`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as ProgramsWire;
    assert.equal(body.is_alumni, true, 'alumni is stored and never cleared (M4.11)');
    assert.equal(body.completed_programs.length, 4);

    const again = await app.inject({
      method: 'DELETE',
      url: `${PROGRAMS_URL}/${target}`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(again.statusCode, 404, 'no live completion left to expire');

    await resetAlumniState();
  },
);

test(
  'completed_programs[].program is always a CURRICULUM_PROGRAMS member (wire narrowing pin)',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetAlumniState();
    const { app } = staffApp();
    for (const program of CURRICULUM_PROGRAMS) {
      await recordProgram(app, program);
    }
    const res = await app.inject({ method: 'GET', url: PROGRAMS_URL });
    assert.equal(res.statusCode, 200, res.body);
    const wire = res.json() as ProgramsWire;
    assert.equal(wire.completed_programs.length, CURRICULUM_PROGRAMS.length);
    for (const entry of wire.completed_programs) {
      assert.ok(
        (CURRICULUM_PROGRAMS as readonly string[]).includes(entry.program),
        `emitted program ${entry.program} is outside CurriculumProgram`,
      );
    }
  },
);

// ALUM-U01, a KEEP. dog1 holds all five from the test above.

test(
  'one alumni status: the dog wire and the staff wire carry one boolean',
  SKIP_WHEN_NO_DB,
  async () => {
    const staffRes = await staffApp().app.inject({ method: 'GET', url: PROGRAMS_URL });
    const staffBody = staffRes.json() as Record<string, unknown>;
    assert.equal(staffBody['is_alumni'], true, 'precondition: alumni');
    assert.deepEqual(
      Object.keys(staffBody).filter((key) => /alum|tier/i.test(key)),
      ['is_alumni'],
    );

    const dogRes = await ownerDogsApp().app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}`,
    });
    const dogBody = dogRes.json() as Record<string, unknown>;
    assert.equal(dogBody['is_alumni'], true);
    assert.deepEqual(
      Object.keys(dogBody).filter((key) => /alum|tier/i.test(key)),
      ['is_alumni'],
    );
  },
);

test(
  'no lapse: an alumni dog that attended nothing stays alumni through a tick on the first of the month',
  SKIP_WHEN_NO_DB,
  async () => {
    const firstOfJuneChicago = new Date('2026-06-01T17:00:00Z');
    await runSchedulerTickOnce({ expoPush: makeExpoPushStub(), now: firstOfJuneChicago });

    const staffRes = await staffApp().app.inject({ method: 'GET', url: PROGRAMS_URL });
    assert.equal((staffRes.json() as ProgramsWire).is_alumni, true, 'still alumni');
    const dogRes = await ownerDogsApp().app.inject({
      method: 'GET',
      url: `/dogs/${FIXTURE_IDS.dog1Id}`,
    });
    assert.equal((dogRes.json() as { is_alumni: boolean }).is_alumni, true, 'on the dog wire too');

    const queued = await db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(sql`${scheduledNotifications.type}::text = 'alumni-attendance'`);
    assert.deepEqual(queued, [], 'nobody is told their dog is slipping');
    const delivered = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(sql`${notifications.type}::text = 'alumni-attendance'`);
    assert.deepEqual(delivered, []);
  },
);
