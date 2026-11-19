import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dogsRepository, type NewDogValues } from '../../src/db/repositories/dogsRepository.js';
import { dogCompletedPrograms, dogs } from '../../src/db/schema/schema.js';
import type { Tx } from '../../src/db/tx.js';
import type {
  CompletedProgramsWire,
  CurriculumProgram,
  DogWire,
} from '../../src/contracts/wire.js';
import { CURRICULUM_PROGRAMS } from '../../src/lib/alumni.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerStaffAlumniRoute } from '../../src/routes/staffAlumni.js';
import { FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * `DogWire.alumni_at` (wire 9.2.0-pre.2; plan one-off O-BUGS3, her #33: "the curriculum
 * progress should be all green and it should say: Alumni on [insert date]"; build DECISIONS
 * 702(1), 704, 705). The date is the fifth level's record date: the latest `completed_at`
 * among the dog's five live `dog_completed_programs` rows, sent only while `is_alumni` is
 * true and every level has a live record.
 *
 *   - five live records  → `alumni_at` = the latest `completed_at`, as an ISO-8601 instant
 *   - imported alumni (no level records), alumni with a level un-recorded since,
 *     a dog that is not alumni (with or without five records) → no `alumni_at` key
 *   - on every route that emits `DogWire`: `GET /dogs`, `GET /dogs/:id`, the `POST /dogs`
 *     201 and the `PATCH /dogs/:id` 200
 *   - a level un-recorded and recorded again moves the date to the new record
 *
 * The exact ISO form is asserted by regex because V8 parses Postgres's own text
 * (`2026-04-10 19:05:06.789+00`) without complaint; only the owner app's Hermes refuses it
 * (build DECISIONS 489), so a value-only check here would pass a wire her phone cannot read.
 *
 * No owner route makes a new dog alumni, so the POST 201 reaches each state by wrapping
 * `dogsRepository.create` for one request: the real insert runs, then the state's rows are
 * written on the SAME transaction, and the route's own re-read (`findById` on that tx) and
 * `toDogWire` build the response. Restored before the GET/PATCH calls.
 */

registerFixtureHooks();

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Five records dated out of level order and out of insert order: the latest is neither the
 * first inserted, nor the first level, nor the last level, and the earliest is not first
 * inserted either. So "the first row", "the last row inserted" and "the last level" all
 * give a wrong date.
 */
const FIVE_RECORDS: ReadonlyArray<{ program: CurriculumProgram; completedAt: string }> = [
  { program: 'cgc', completedAt: '2026-03-02T15:00:00.000Z' },
  { program: 'foundation', completedAt: '2026-01-05T15:00:00.000Z' },
  { program: 'house-manners', completedAt: '2026-04-10T19:05:06.789Z' },
  { program: 'advanced', completedAt: '2026-02-03T15:00:00.000Z' },
  { program: 'loose-leash', completedAt: '2026-03-20T15:00:00.000Z' },
];
const LATEST = '2026-04-10T19:05:06.789Z';

/** The level a staff member un-records in `unrecorded-since` (not the latest one). */
const UNRECORDED_LEVEL: CurriculumProgram = 'advanced';

type AlumniState =
  | 'five-live'
  | 'imported'
  | 'unrecorded-since'
  | 'not-alumni'
  | 'not-alumni-five-live';

const STATES: ReadonlyArray<{ state: AlumniState; isAlumni: boolean; alumniAt?: string }> = [
  { state: 'five-live', isAlumni: true, alumniAt: LATEST },
  // An imported alumni dog: `is_alumni` set, no level records. The app shows "Alumni" alone.
  { state: 'imported', isAlumni: true },
  // Alumni, then a level un-recorded (`is_alumni` is never cleared): four live records.
  { state: 'unrecorded-since', isAlumni: true },
  // A new dog: not alumni, no records.
  { state: 'not-alumni', isAlumni: false },
  // An operator's data edit cleared `is_alumni` with five live records left (no route
  // clears it; alumni-package-gate.test.ts plants the same). Not alumni ⇒ no date.
  { state: 'not-alumni-five-live', isAlumni: false },
];

type Runner = Tx | typeof db;

async function seedState(runner: Runner, dogId: string, state: AlumniState): Promise<void> {
  if (state === 'five-live' || state === 'imported' || state === 'unrecorded-since') {
    await runner.update(dogs).set({ isAlumni: true }).where(eq(dogs.id, dogId));
  }
  if (state === 'five-live' || state === 'unrecorded-since' || state === 'not-alumni-five-live') {
    await runner
      .insert(dogCompletedPrograms)
      .values(FIVE_RECORDS.map((r) => ({ dogId, program: r.program, completedAt: r.completedAt })));
  }
  if (state === 'unrecorded-since') {
    await runner
      .update(dogCompletedPrograms)
      .set({ expiredAt: '2026-05-01T15:00:00.000Z' })
      .where(
        and(
          eq(dogCompletedPrograms.dogId, dogId),
          eq(dogCompletedPrograms.program, UNRECORDED_LEVEL),
        ),
      );
  }
}

function ownerApp(): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

function staffApp(): ReturnType<typeof makeContractApp>['app'] {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffAlumniRoute(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

function assertAlumniAt(
  route: string,
  wire: DogWire,
  expected: { state: AlumniState; isAlumni: boolean; alumniAt?: string },
): void {
  const label = `${route}, ${expected.state}`;
  assert.equal(wire.is_alumni, expected.isAlumni, `${label}: precondition is_alumni`);
  if (expected.alumniAt === undefined) {
    assert.equal('alumni_at' in wire, false, `${label}: no alumni_at key (omit-on-null)`);
    return;
  }
  assert.equal(typeof wire.alumni_at, 'string', `${label}: alumni_at present`);
  assert.match(wire.alumni_at as string, ISO_INSTANT, `${label}: alumni_at is an ISO instant`);
  assert.equal(wire.alumni_at, expected.alumniAt, `${label}: the latest completed_at`);
}

async function getDog(
  app: ReturnType<typeof makeContractApp>['app'],
  dogId: string,
): Promise<{ one: DogWire; listed: DogWire }> {
  const oneRes = await app.inject({ method: 'GET', url: `/dogs/${dogId}` });
  assert.equal(oneRes.statusCode, 200, oneRes.body);
  const listRes = await app.inject({ method: 'GET', url: '/dogs' });
  assert.equal(listRes.statusCode, 200, listRes.body);
  const listed = (listRes.json() as DogWire[]).find((d) => d.id === dogId);
  assert.ok(listed !== undefined, `GET /dogs lists ${dogId}`);
  return { one: oneRes.json() as DogWire, listed };
}

test('the regex is the instrument: it refuses Postgres text and takes an ISO instant', () => {
  assert.doesNotMatch('2026-04-10 19:05:06.789+00', ISO_INSTANT);
  assert.doesNotMatch('2026-04-10 14:05:06.789-05', ISO_INSTANT);
  assert.doesNotMatch('2026-04-10T19:05:06Z', ISO_INSTANT);
  assert.match(LATEST, ISO_INSTANT);
});

for (const expected of STATES) {
  test(
    `alumni_at, ${expected.state}: POST /dogs 201, GET /dogs, GET /dogs/:id, PATCH /dogs/:id 200`,
    SKIP_WHEN_NO_DB,
    async (t) => {
      const app = ownerApp();

      // POST /dogs 201. Every state but a plain new dog is written on the POST's own
      // transaction, after the real insert, so the response is the route's re-read.
      const realCreate = dogsRepository.create;
      const create =
        expected.state === 'not-alumni'
          ? undefined
          : t.mock.method(
              dogsRepository,
              'create',
              async (tx: Tx, values: NewDogValues): ReturnType<typeof realCreate> => {
                const row = await realCreate(tx, values);
                await seedState(tx, row.id, expected.state);
                return row;
              },
            );
      const posted = await app.inject({
        method: 'POST',
        url: '/dogs',
        headers: { 'idempotency-key': `alumni-at-${randomUUID()}` },
        payload: {
          name: `Alumni at ${expected.state} ${randomUUID().slice(0, 8)}`,
          breed: 'Border Collie',
          birthdate: '2023-06-15',
        },
      });
      assert.equal(posted.statusCode, 201, posted.body);
      if (create !== undefined) {
        assert.equal(create.mock.callCount(), 1, 'the seeding create ran on the POST');
        create.mock.restore();
      }
      const created = posted.json() as DogWire;
      assertAlumniAt('POST /dogs 201', created, expected);

      const { one, listed } = await getDog(app, created.id);
      assertAlumniAt('GET /dogs/:id', one, expected);
      assertAlumniAt('GET /dogs', listed, expected);

      const patched = await app.inject({
        method: 'PATCH',
        url: `/dogs/${created.id}`,
        headers: { 'idempotency-key': `alumni-at-patch-${randomUUID()}` },
        payload: { special_notes: 'a saved edit keeps the date' },
      });
      assert.equal(patched.statusCode, 200, patched.body);
      const patchedWire = patched.json() as DogWire;
      assert.equal(patchedWire.special_notes, 'a saved edit keeps the date');
      assertAlumniAt('PATCH /dogs/:id 200', patchedWire, expected);
    },
  );
}

test(
  'alumni_at through the staff verbs: the fifth record dates it, an un-record drops it, a re-record later moves it',
  SKIP_WHEN_NO_DB,
  async () => {
    const owner = ownerApp();
    const staff = staffApp();

    const posted = await owner.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `alumni-at-${randomUUID()}` },
      payload: {
        name: `Alumni at staff ${randomUUID().slice(0, 8)}`,
        breed: 'Border Collie',
        birthdate: '2023-06-15',
      },
    });
    assert.equal(posted.statusCode, 201, posted.body);
    const dogId = (posted.json() as DogWire).id;
    const programsUrl = `/staff/dogs/${dogId}/completed-programs`;

    const record = async (program: CurriculumProgram): Promise<CompletedProgramsWire> => {
      const res = await staff.inject({
        method: 'POST',
        url: programsUrl,
        headers: { 'idempotency-key': randomUUID() },
        payload: { program },
      });
      assert.equal(res.statusCode, 201, res.body);
      return res.json() as CompletedProgramsWire;
    };
    const completedAtOf = (wire: CompletedProgramsWire, program: CurriculumProgram): string => {
      const entry = wire.completed_programs.find((p) => p.program === program);
      assert.ok(entry !== undefined, `${program} is live on the staff wire`);
      return entry.completed_at;
    };

    // Four levels: not alumni, no date.
    for (const program of CURRICULUM_PROGRAMS.slice(0, 4)) await record(program);
    let read = await getDog(owner, dogId);
    assert.equal(read.one.is_alumni, false);
    assert.equal('alumni_at' in read.one, false, 'four levels: no alumni_at');

    // The fifth makes her alumni, dated by that record.
    const fifthLevel = CURRICULUM_PROGRAMS[4];
    const fifth = await record(fifthLevel);
    assert.equal(fifth.is_alumni, true);
    const firstDate = completedAtOf(fifth, fifthLevel);
    const latestOfFive = [...fifth.completed_programs.map((p) => p.completed_at)].sort().at(-1);
    assert.equal(firstDate, latestOfFive, 'the fifth record is the latest of the five');
    read = await getDog(owner, dogId);
    for (const [route, wire] of [
      ['GET /dogs/:id', read.one],
      ['GET /dogs', read.listed],
    ] as const) {
      assert.match(wire.alumni_at ?? '<absent>', ISO_INSTANT, `${route}: ISO instant`);
      assert.equal(wire.alumni_at, firstDate, `${route}: the fifth level's record date`);
    }

    // Un-record a level that is not the latest: still alumni, no date.
    const relevel = CURRICULUM_PROGRAMS[1];
    const unrecorded = await staff.inject({
      method: 'DELETE',
      url: `${programsUrl}/${relevel}`,
      headers: { 'idempotency-key': randomUUID() },
    });
    assert.equal(unrecorded.statusCode, 200, unrecorded.body);
    read = await getDog(owner, dogId);
    assert.equal(read.one.is_alumni, true, 'alumni is never cleared');
    assert.equal('alumni_at' in read.one, false, 'GET /dogs/:id: a level un-recorded, no date');
    assert.equal('alumni_at' in read.listed, false, 'GET /dogs: a level un-recorded, no date');

    // Recorded again, later: the date moves to the new record, the latest now.
    const again = await record(relevel);
    const movedDate = completedAtOf(again, relevel);
    assert.ok(
      new Date(movedDate).getTime() > new Date(firstDate).getTime(),
      `the re-record (${movedDate}) is later than the first fifth (${firstDate})`,
    );
    read = await getDog(owner, dogId);
    for (const [route, wire] of [
      ['GET /dogs/:id', read.one],
      ['GET /dogs', read.listed],
    ] as const) {
      assert.match(wire.alumni_at ?? '<absent>', ISO_INSTANT, `${route}: ISO instant`);
      assert.equal(wire.alumni_at, movedDate, `${route}: moved to the re-record's date`);
    }
  },
);
