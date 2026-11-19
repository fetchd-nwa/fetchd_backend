import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { resolvePrincipal } from '../../src/auth/mirror.js';
import { makeAuthenticate, registerAuth } from '../../src/auth/plugin.js';
import { ApiError } from '../../src/lib/errors.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  SKIP_WHEN_NO_DB,
  readSchoolAccount,
  registerFixtureHooks,
  registerRequestServicesOn,
} from './_harness.js';
import * as rs from './_requestServices.js';

/**
 * S45, the school's system row (rs3 M5.26; design §2.9:4554, MSG-U03; plan P45 `red_first`):
 * *NWA School for Dogs* is the participant of every school thread and NEVER a principal, never
 * a trainer. Three auth layers, each its own test and each red on its own mutation (confirmed
 * landed):
 *   1. the lookup filter: `resolvePrincipal` never yields it, even if its uid were set and a
 *      valid JWT presented for it (the CHECK dropped in the test database to make that
 *      reachable): 403 `not_provisioned`;
 *   2. the CHECK: an UPDATE giving it a uid is 23514; without the CHECK the same UPDATE
 *      succeeds (the control, in the same rolled-back transaction);
 *   3. the dev bypass: `X-Dev-Principal: staff:<its id>:trainer` is 403 by a lookup of
 *      `is_system_account` (it used to build a principal with no read).
 * And D15 (A1): the P49 trainer reads, `findTrainer` and `listTrainers`, never return it, even
 * if it held a lesson price and Board & Train: a request naming it is refused exactly as an
 * unpriced staffer is, and `GET /trainers` never lists it.
 */

registerFixtureHooks();

const ADMIN_URL = process.env.DATABASE_URL;

async function withClient<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * The CHECK's definition and the system row's own columns, as the load left them. A test
 * that changes either (layer 1 drops the CHECK and sets a uid on the shared suite database,
 * because `resolvePrincipal` reads on the pool; D15 prices the row) restores them in
 * `finally`, and then asserts the restore against this reading (MB13 L4).
 */
async function schoolState(schoolId: string): Promise<unknown> {
  return withClient(async (client) => {
    const constraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
        WHERE conrelid = 'staff'::regclass AND conname = 'staff_system_account_uid_check'`,
    );
    const row = await client.query(
      `SELECT supabase_uid, lesson_price_cents, board_train_eligible, expired_at, is_system_account
         FROM staff WHERE id = $1`,
      [schoolId],
    );
    return { constraint: constraint.rows, row: row.rows };
  });
}

function whoamiApp(deps: Parameters<typeof makeAuthenticate>[0]) {
  const app = Fastify();
  registerAuth(app);
  app.get(
    '/whoami',
    { preHandler: [makeAuthenticate(deps)] },
    async (request) => request.principal,
  );
  return app;
}

describe('S45: the system row is never a principal (three layers, design §2.9:4554)', () => {
  test(
    'layer 1, the lookup filter: a verified JWT whose uid is the system row’s resolves to no principal (403 not_provisioned)',
    SKIP_WHEN_NO_DB,
    async () => {
      const school = await readSchoolAccount();
      const before = await schoolState(school.id);
      const uid = randomUUID();
      await withClient(async (client) => {
        // Make the case reachable: without the CHECK the system row can hold a uid.
        await client.query('ALTER TABLE staff DROP CONSTRAINT staff_system_account_uid_check');
        try {
          await client.query('UPDATE staff SET supabase_uid = $1 WHERE id = $2', [uid, school.id]);
          const app = whoamiApp({
            verify: async () => ({ sub: uid }),
            resolve: resolvePrincipal,
          });
          const res = await app.inject({
            method: 'GET',
            url: '/whoami',
            headers: { authorization: 'Bearer a-verified-token' },
          });
          assert.equal(res.statusCode, 403, res.body);
          assert.equal(res.json().error.code, 'not_provisioned');
        } finally {
          await client.query('UPDATE staff SET supabase_uid = NULL WHERE id = $1', [school.id]);
          await client.query(
            'ALTER TABLE staff ADD CONSTRAINT staff_system_account_uid_check CHECK (is_system_account = (supabase_uid IS NULL))',
          );
        }
      });
      assert.deepEqual(
        await schoolState(school.id),
        before,
        'the CHECK or the row was not restored',
      );
    },
  );

  test(
    'layer 2, the CHECK: giving the system row a uid is 23514; with the CHECK dropped the same UPDATE succeeds',
    SKIP_WHEN_NO_DB,
    async () => {
      const school = await readSchoolAccount();
      const before = await schoolState(school.id);
      await withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query('SAVEPOINT refused');
          await assert.rejects(
            client.query('UPDATE staff SET supabase_uid = gen_random_uuid() WHERE id = $1', [
              school.id,
            ]),
            (err: { code?: string; constraint?: string }) =>
              err.code === '23514' && err.constraint === 'staff_system_account_uid_check',
          );
          await client.query('ROLLBACK TO SAVEPOINT refused');
          // The control: the CHECK is what refused it.
          await client.query('ALTER TABLE staff DROP CONSTRAINT staff_system_account_uid_check');
          const updated = await client.query(
            'UPDATE staff SET supabase_uid = gen_random_uuid() WHERE id = $1',
            [school.id],
          );
          assert.equal(updated.rowCount, 1);
        } finally {
          await client.query('ROLLBACK');
        }
      });
      await withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await assert.rejects(
            client.query('UPDATE staff SET supabase_uid = NULL WHERE id = $1', [
              FIXTURE_IDS.staffDonavanId,
            ]),
            (err: { code?: string }) => err.code === '23514',
          );
        } finally {
          await client.query('ROLLBACK');
        }
      });
      assert.deepEqual(await schoolState(school.id), before, 'the rolled-back changes leaked');
    },
  );

  test(
    'layer 3, the dev bypass: X-Dev-Principal naming the system row is 403, in either spelling; a person row still constructs',
    SKIP_WHEN_NO_DB,
    async () => {
      const school = await readSchoolAccount();
      const app = whoamiApp({
        verify: async () => {
          throw new ApiError('unauthenticated', 'the JWT path must not run on the bypass');
        },
        resolve: async () => null,
        bypassEnabled: true,
      });
      for (const id of [school.id, school.id.toUpperCase()]) {
        const res = await app.inject({
          method: 'GET',
          url: '/whoami',
          headers: { 'x-dev-principal': `staff:${id}:trainer` },
        });
        assert.equal(res.statusCode, 403, `${id}: ${res.body}`);
        assert.equal(res.json().error.code, 'not_provisioned');
      }
      const person = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { 'x-dev-principal': `staff:${FIXTURE_IDS.staffAmberId}:manager` },
      });
      assert.equal(person.statusCode, 200, person.body);
      assert.equal(person.json().staffId, FIXTURE_IDS.staffAmberId);
    },
  );
});

describe('D15: the trainer reads never return the system row (A1 D15)', () => {
  registerRequestServicesOn();
  afterEach(rs.clearRequestServiceRows);

  /** Price the system row and make it Board & Train eligible, so only the filter keeps it out. */
  async function withPricedSchool(run: (schoolId: string) => Promise<void>): Promise<void> {
    const school = await readSchoolAccount();
    const before = await schoolState(school.id);
    await withClient((client) =>
      client.query(
        'UPDATE staff SET lesson_price_cents = 15000, board_train_eligible = true WHERE id = $1',
        [school.id],
      ),
    );
    try {
      await run(school.id);
    } finally {
      await withClient((client) =>
        client.query(
          'UPDATE staff SET lesson_price_cents = NULL, board_train_eligible = false WHERE id = $1',
          [school.id],
        ),
      );
    }
    assert.deepEqual(await schoolState(school.id), before, 'the system row was not restored');
  }

  test(
    'GET /trainers never lists it, even priced and Board & Train eligible',
    SKIP_WHEN_NO_DB,
    async () => {
      await withPricedSchool(async (schoolId) => {
        const res = await rs.ownerApp().inject({ method: 'GET', url: '/trainers' });
        assert.equal(res.statusCode, 200, res.body);
        const ids = (res.json() as Array<{ staff_id: string }>).map((t) => t.staff_id);
        assert.equal(ids.includes(schoolId), false, `GET /trainers listed the system row: ${ids}`);
        assert.ok(ids.includes(FIXTURE_IDS.staffRachelId), 'the control: Rachel is listed');
      });
    },
  );

  test(
    'a lesson request naming it as trainer is refused exactly as one naming an unpriced staffer',
    SKIP_WHEN_NO_DB,
    async () => {
      await withPricedSchool(async (schoolId) => {
        const lesson = {
          category: 'private-lesson',
          lead_dog_id: FIXTURE_IDS.dog1Id,
          preferred_dates: [...rs.LESSON_TIMES],
        };
        const unpriced = await rs.post(rs.ownerApp(), '/requests', {
          ...lesson,
          focus: { staff_preference: FIXTURE_IDS.staffAmberId },
        });
        const school = await rs.post(rs.ownerApp(), '/requests', {
          ...lesson,
          focus: { staff_preference: schoolId },
        });
        assert.equal(unpriced.statusCode, 422, unpriced.body);
        assert.equal(school.statusCode, 422, school.body);
        assert.equal(rs.errorCode(school), rs.errorCode(unpriced));
        assert.equal(rs.errorMessage(school), rs.errorMessage(unpriced));
      });
    },
  );

  test(
    'a staff approve naming it as the trainer is refused as an unpriced staffer is',
    SKIP_WHEN_NO_DB,
    async () => {
      await withPricedSchool(async (schoolId) => {
        const id = await rs.plantRequest({ category: 'private-lesson' });
        const unpriced = await rs.approveLesson(id, { trainer_staff_id: FIXTURE_IDS.staffAmberId });
        const school = await rs.approveLesson(id, { trainer_staff_id: schoolId });
        assert.notEqual(unpriced.statusCode, 200, unpriced.body);
        assert.equal(school.statusCode, unpriced.statusCode, school.body);
        assert.equal(rs.errorCode(school), rs.errorCode(unpriced));
        assert.equal(rs.errorMessage(school), rs.errorMessage(unpriced));
      });
    },
  );
});
