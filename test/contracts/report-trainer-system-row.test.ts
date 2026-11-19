import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { inArray, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { pendingRequests, reports } from '../../src/db/schema/schema.js';
import { staffRepository } from '../../src/db/repositories/staffRepository.js';
import { registerReportsRoute } from '../../src/routes/reports.js';
import { registerStaffRequestsRoute } from '../../src/routes/staffRequests.js';
import { registerStaffReportsRoute } from '../../src/routes/staffReports.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  readSchoolAccount,
  registerFixtureHooks,
} from './_harness.js';
import { plantRequest } from './_requestServices.js';

/**
 * The school's system row is never served as a person (S45, design §2.9:4554: "never a principal,
 * never on a roster, pick list or responder choice"; `livePrincipal()` is the default staff read;
 * pass-1 audits, Fable M3 and the Opus seat's M1). Two serving reads named it:
 *   · `staffRepository.findNamesByIds`, behind a report's `trainer` (and a booking's): a report
 *     whose `trainer_staff_id` is the system row showed the family *NWA School for Dogs*;
 *   · `staffRepository.findAnyNamesByIds`, behind the staff queue's `preferred_trainer`: a
 *     request whose `staff_preference` is the system row's id was shown as asking for it.
 * Both now read the system row exactly as a staff id that names nobody: no name. The expired
 * staffer stays resolved where history wants her (`findAnyNamesByIds`). The one read that still
 * resolves the system row is `findParticipantsByIds`: it is a school thread's participant.
 *
 * And the write (orchestrator ruling MB32): `POST /staff/reports` refuses a `trainer_staff_id`
 * that names no staff row, or names the system row, with 422 `invalid_payload` before anything
 * is written (it was a 23503 and a 500 that paged, or a report signed by the school). A departed
 * staffer is still accepted, as before: a report written about her session stays true.
 */

registerFixtureHooks();

const reportIds: string[] = [];
const requestIds: string[] = [];
const expiredStaffIds: string[] = [];

after(async () => {
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  if (reportIds.length > 0) {
    await db.execute(
      sql`DELETE FROM notifications WHERE deep_link_kind = 'report' AND deep_link_id = ANY(${sql.param(reportIds)}::uuid[])`,
    );
    await db.delete(reports).where(inArray(reports.id, reportIds));
  }
  if (requestIds.length > 0) {
    await db.delete(pendingRequests).where(inArray(pendingRequests.id, requestIds));
  }
  if (expiredStaffIds.length > 0) {
    await db.execute(sql`DELETE FROM staff WHERE id = ANY(${sql.param(expiredStaffIds)}::uuid[])`);
  }
});

/** A staffer who has left (`--expire`): her row stays, so history can still name her. */
async function plantExpiredStaffer(): Promise<string> {
  const id = randomUUID();
  expiredStaffIds.push(id);
  await db.execute(sql`
    INSERT INTO staff (id, supabase_uid, name, role, home_locations, expired_at)
    VALUES (${id}, ${randomUUID()}, 'Gone Trainer', 'trainer', '{fayetteville}', now())`);
  return id;
}

const REPORT_EXCERPT = 'Steady on the mat today.';

/** `POST /staff/reports` naming `trainer`, with every log line the route writes captured. */
async function postReport(trainer: string) {
  const capture = makeLogCapture();
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL, capture);
  registerStaffReportsRoute(app, { authenticate });
  const res = await app.inject({
    method: 'POST',
    url: '/staff/reports',
    headers: { 'idempotency-key': `a4-${randomUUID()}` },
    payload: {
      dog_id: FIXTURE_IDS.dog1Id,
      date: '2026-05-20T15:00:00Z',
      category: 'group-class',
      program: 'foundation',
      excerpt: REPORT_EXCERPT,
      full_text: 'Waffles held a down-stay through two distractions.',
      trainer_staff_id: trainer,
    },
  });
  const pagerLines = capture.lines.filter((line) => Number(line['level'] ?? 0) >= 50).length;
  return { res, pagerLines };
}

/** A report as the portal authors it, naming `trainer` (201). */
async function authorReport(trainer: string): Promise<string> {
  const { res } = await postReport(trainer);
  assert.equal(res.statusCode, 201, res.body);
  const { id } = res.json() as { id: string };
  reportIds.push(id);
  return id;
}

/** A report row written before the trainer check (an old dev row, or an import): planted. */
async function plantReport(trainer: string): Promise<string> {
  const id = randomUUID();
  reportIds.push(id);
  await db.execute(sql`
    INSERT INTO reports (id, dog_id, date, trainer_staff_id, category, program, excerpt, full_text)
    VALUES (${id}, ${FIXTURE_IDS.dog1Id}, '2026-05-20T15:00:00Z', ${trainer}, 'group-class',
            'foundation', ${REPORT_EXCERPT}, 'Planted before the trainer check.')`);
  return id;
}

/** What `POST /staff/reports` has written for this test's reports: rows and feed entries. */
async function writtenCounts(): Promise<{ reports: number; notices: number }> {
  const { rows } = await db.execute<{ reports: number; notices: number }>(sql`
    SELECT (SELECT count(*)::int FROM reports WHERE dog_id = ${FIXTURE_IDS.dog1Id}) AS reports,
           (SELECT count(*)::int FROM notifications
             WHERE owner_id = ${FIXTURE_IDS.ownerId} AND type = 'report-published') AS notices`);
  return rows[0] as { reports: number; notices: number };
}

/** The family's `GET /reports/:id`, and staff's: the `trainer` each is shown. */
async function trainersShown(reportId: string): Promise<{ family: unknown; staff: unknown }> {
  const read = async (principal: typeof FIXTURE_OWNER_PRINCIPAL): Promise<unknown> => {
    const { app, authenticate } = makeContractApp(principal);
    registerReportsRoute(app, { authenticate });
    const res = await app.inject({ method: 'GET', url: `/reports/${reportId}` });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Record<string, unknown>;
    return 'trainer' in body ? body['trainer'] : '(absent)';
  };
  return {
    family: await read(FIXTURE_OWNER_PRINCIPAL),
    staff: await read(FIXTURE_STAFF_PRINCIPAL),
  };
}

/** The staff queue's `preferred_trainer` for one request. */
async function preferredTrainerShown(requestId: string): Promise<unknown> {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_ROLE_PRINCIPAL);
  registerStaffRequestsRoute(app, { authenticate, now: FIXTURE_NOW });
  const res = await app.inject({ method: 'GET', url: '/staff/requests?status=submitted' });
  assert.equal(res.statusCode, 200, res.body);
  const row = (res.json() as Array<{ id: string; preferred_trainer?: unknown }>).find(
    (r) => r.id === requestId,
  );
  assert.ok(row, `request ${requestId} is in the queue`);
  return 'preferred_trainer' in row ? row.preferred_trainer : '(absent)';
}

test(
  'A4 (findNamesByIds): a report naming the system row as its trainer shows no trainer, to the family and to staff, exactly as one naming a departed staffer',
  SKIP_WHEN_NO_DB,
  async () => {
    const school = await readSchoolAccount();
    const live = await trainersShown(await authorReport(FIXTURE_IDS.staffRachelId));
    assert.deepEqual(live, { family: 'Rachel', staff: 'Rachel' }, 'a live trainer is named');
    const departed = await trainersShown(await authorReport(await plantExpiredStaffer()));
    const system = await trainersShown(await plantReport(school.id));
    assert.deepEqual(
      system,
      { family: '(absent)', staff: '(absent)' },
      'the school is never a trainer',
    );
    assert.deepEqual(system, departed);
  },
);

test(
  'A4 (findAnyNamesByIds): a request preferring the system row shows no preferred trainer, exactly as one preferring an id that names nobody; a departed staffer is still named',
  SKIP_WHEN_NO_DB,
  async () => {
    const school = await readSchoolAccount();
    const gone = await plantExpiredStaffer();
    const asks = async (staffPreference: string): Promise<unknown> => {
      const id = await plantRequest({ category: 'boarding', staffPreference });
      requestIds.push(id);
      return preferredTrainerShown(id);
    };
    assert.deepEqual(await asks(gone), { staff_id: gone, name: 'Gone Trainer' }, 'history kept');
    const nobody = await asks(randomUUID());
    assert.equal(nobody, '(absent)');
    assert.equal(await asks(school.id), nobody, 'the school is never a preferred trainer');
  },
);

test(
  'A4 (the two reads): neither names the system row; findAnyNamesByIds still resolves an expired staffer and findNamesByIds still does not',
  SKIP_WHEN_NO_DB,
  async () => {
    const school = await readSchoolAccount();
    const gone = await plantExpiredStaffer();
    const live = await staffRepository.findNamesByIds([school.id, FIXTURE_IDS.staffRachelId, gone]);
    assert.deepEqual(
      live.map((r) => r.id),
      [FIXTURE_IDS.staffRachelId],
      'findNamesByIds: live persons only',
    );
    const any = await staffRepository.findAnyNamesByIds([
      school.id,
      gone,
      FIXTURE_IDS.staffRachelId,
    ]);
    assert.equal(any.has(school.id), false, 'findAnyNamesByIds never names the system row');
    assert.equal(any.get(gone), 'Gone Trainer');
    assert.equal(any.get(FIXTURE_IDS.staffRachelId), 'Rachel');
    // The one exception stays: a school thread's participant is the system row.
    const [participant] = await staffRepository.findParticipantsByIds([school.id]);
    assert.equal(participant?.isSchool, true);
  },
);

test(
  'A4 (the write, MB32): a trainer_staff_id naming no staff row is 422 invalid_payload, nothing written and nothing paged (it was a 23503 and a 500 at level 50)',
  SKIP_WHEN_NO_DB,
  async () => {
    const before = await writtenCounts();
    const { res, pagerLines } = await postReport(randomUUID());
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_payload');
    assert.equal(pagerLines, 0, 'nothing at the pager’s level');
    assert.deepEqual(await writtenCounts(), before, 'no report row, no feed entry');
  },
);

test(
  'A4 (the write, MB32): the system row as trainer_staff_id is refused exactly as an id naming no staff row; a departed staffer is still accepted',
  SKIP_WHEN_NO_DB,
  async () => {
    const school = await readSchoolAccount();
    const before = await writtenCounts();
    const unknown = await postReport(randomUUID());
    const system = await postReport(school.id);
    assert.equal(system.res.statusCode, 422, system.res.body);
    assert.deepEqual(system.res.json(), unknown.res.json(), 'the same refusal, the same body');
    assert.equal(system.pagerLines, 0);
    assert.deepEqual(await writtenCounts(), before, 'no report row, no feed entry');
    // A report about a session with a staffer who has since left stays writable (unchanged).
    await authorReport(await plantExpiredStaffer());
  },
);
