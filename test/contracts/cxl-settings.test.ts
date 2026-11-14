import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../src/auth/principal.js';
import type {
  CancellationSettingsWire,
  PatchStaffSettingsCxlRequest,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';
import { dogs } from '../../src/db/schema/schema.js';
import { registerStaffSettingsRoute } from '../../src/routes/staffSettings.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearPlantedPools, plantLot } from './_poolFixture.js';
import {
  at,
  boardApp,
  createSession,
  makeClock,
  ownerDogCancel,
  refusal,
  removeSessions,
} from './_checkinFixture.js';

/**
 * CXL-U02 (P21; design §1.1:1050-1061, §2.7:4115-4126, §3.8:5848-5871; contract notes D4,
 * D5, D6, D7): `cxl` is the settings family's fifteenth domain, over M5.07's two tables, the
 * one domain on two. `GET /staff/settings/cxl` answers `CancellationSettingsWire {policies,
 * global}`: seven policy rows as M5.07 seeds them (boarding `unset`, NOT SEEDED) and the
 * singleton (`brief_must_say` 5's settlement, D6). Every key is stored only, a PATCH of it
 * 422 `setting_inert`, but `per_dog_cancel_enabled`: class `money` (§3.8:5866), so the owner
 * and a manager edit it and a trainer is refused, and off, the owner's one-dog cancel is
 * 409 `per_dog_cancel_off` (s11).
 */

registerFixtureHooks();
const createdDogs: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  await db.execute(sql`
    UPDATE cancellation_global_settings
       SET per_dog_cancel_enabled = true, updated_by_staff_id = NULL`);
  await removeSessions(sessions.splice(0));
  await clearPlantedPools();
});
after(async () => {
  await removeDogs(createdDogs);
});

const SHANTHI = FIXTURE_OWNER_ROLE_PRINCIPAL;
const AMBER = FIXTURE_MANAGER_PRINCIPAL;
const DONAVAN = FIXTURE_STAFF_PRINCIPAL;

function appAs(principal: Principal): FastifyInstance {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffSettingsRoute(app, { authenticate });
  return app;
}

function patchCxl(app: FastifyInstance, body: PatchStaffSettingsCxlRequest) {
  return app.inject({
    method: 'PATCH',
    url: '/staff/settings/cxl',
    headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

function cxlOf(res: { statusCode: number; body: string }): CancellationSettingsWire {
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as CancellationSettingsWire;
}

const SEEDED_NONE = {
  window_state: 'none',
  window_hours: null,
  forfeit_fraction: 0,
  no_show_forfeit_fraction: 0,
  flat_fee_cents: 0,
  unpaid_no_show_close_after_hours: 24,
  no_show_declare_mode: 'staff_only',
} as const;

describe('GET /staff/settings/cxl: the two tables as seeded (D4, D6)', () => {
  test(
    'seven policy rows, six none with zero fractions and fees, boarding unset and NOT SEEDED; the global row as seeded',
    SKIP_WHEN_NO_DB,
    async () => {
      const cxl = cxlOf(await appAs(DONAVAN).inject({ method: 'GET', url: '/staff/settings/cxl' }));
      const policies = [...cxl.policies].sort((a, b) => a.category.localeCompare(b.category));
      assert.deepEqual(
        policies.map(({ updated_at: _at, updated_by_staff_id: _by, ...row }) => row),
        [
          { category: 'board-and-train', ...SEEDED_NONE },
          {
            category: 'boarding',
            window_state: 'unset',
            window_hours: null,
            forfeit_fraction: null,
            no_show_forfeit_fraction: null,
            flat_fee_cents: null,
            unpaid_no_show_close_after_hours: 24,
            no_show_declare_mode: null,
          },
          { category: 'day-care', ...SEEDED_NONE },
          { category: 'day-school', ...SEEDED_NONE },
          { category: 'evaluation', ...SEEDED_NONE },
          { category: 'group-class', ...SEEDED_NONE },
          { category: 'private-lesson', ...SEEDED_NONE },
        ],
      );
      for (const row of cxl.policies) {
        assert.ok(!Number.isNaN(Date.parse(row.updated_at)), `${row.category} updated_at`);
        assert.equal(row.updated_by_staff_id, null);
      }
      const { updated_at: at, updated_by_staff_id: by, ...global } = cxl.global;
      assert.deepEqual(global, {
        per_dog_cancel_enabled: true,
        staff_entered_client_cancel_follows_owner_rules_enabled: true,
        staff_initiated_cancel_full_return_enabled: true,
        class_missed_meeting_money_return_mode: null,
        started_run_cancel_return_mode: null,
      });
      assert.ok(!Number.isNaN(Date.parse(at)));
      assert.equal(by, null);
    },
  );

  test('an owner (family) principal is 403', SKIP_WHEN_NO_DB, async () => {
    const res = await appAs(FIXTURE_OWNER_PRINCIPAL).inject({
      method: 'GET',
      url: '/staff/settings/cxl',
    });
    assert.equal(res.statusCode, 403, res.body);
  });
});

describe('PATCH /staff/settings/cxl: per_dog_cancel_enabled is the one live key, class money (D7)', () => {
  test(
    "the owner and a manager switch it off (200, stamped); then the owner's one-dog cancel → 409 per_dog_cancel_off",
    SKIP_WHEN_NO_DB,
    async () => {
      const byOwner = cxlOf(await patchCxl(appAs(SHANTHI), { per_dog_cancel_enabled: false }));
      assert.equal(byOwner.global.per_dog_cancel_enabled, false);
      assert.equal(byOwner.global.updated_by_staff_id, FIXTURE_IDS.staffShanthiId);
      assert.equal(byOwner.policies.length, 7, 'the response is the whole domain');

      const back = cxlOf(await patchCxl(appAs(AMBER), { per_dog_cancel_enabled: true }));
      assert.equal(back.global.per_dog_cancel_enabled, true);
      const byManager = cxlOf(await patchCxl(appAs(AMBER), { per_dog_cancel_enabled: false }));
      assert.equal(byManager.global.per_dog_cancel_enabled, false);
      assert.equal(byManager.global.updated_by_staff_id, FIXTURE_IDS.staffAmberId);

      const bao = await createBookableDog(createdDogs);
      const luna = await createBookableDog(createdDogs);
      await db.update(dogs).set({ name: 'Luna' }).where(eq(dogs.id, luna));
      const lot = await plantLot({ credits: 2, expiresAt: at('2027-06-01', '12:00') });
      const { bookingId } = await createSession({
        dogIds: [bao, luna],
        date: '2026-10-21',
        lotId: lot,
        ledger: sessions,
      });
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at('2026-10-21', '06:50')));
      refusal(await ownerDogCancel(owner, { bookingId, dogId: luna }), 409, 'per_dog_cancel_off');
    },
  );

  test('a trainer is refused 403 refused_keys, and nothing is written', SKIP_WHEN_NO_DB, async () => {
    const res = await patchCxl(appAs(DONAVAN), { per_dog_cancel_enabled: false });
    assert.equal(res.statusCode, 403, res.body);
    assert.deepEqual(res.json<{ error: { details: unknown } }>().error.details, {
      kind: 'refused_keys',
      refused_keys: ['per_dog_cancel_enabled'],
    });
    const cxl = cxlOf(await appAs(DONAVAN).inject({ method: 'GET', url: '/staff/settings/cxl' }));
    assert.equal(cxl.global.per_dog_cancel_enabled, true);
  });

  test(
    'the edit writes one audit row, naming the staffer, holding the value it replaced',
    SKIP_WHEN_NO_DB,
    async () => {
      const since = new Date().toISOString();
      cxlOf(await patchCxl(appAs(AMBER), { per_dog_cancel_enabled: false }));
      const { rows } = await pool.query<{ op: string; actor: string; before: { per_dog_cancel_enabled: boolean } }>(
        `SELECT op, actor, before FROM audit_log
          WHERE table_name = 'cancellation_global_settings' AND at >= $1`,
        [since],
      );
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0]?.op, 'UPDATE');
      assert.equal(rows[0]?.actor, `staff:${FIXTURE_IDS.staffAmberId}`);
      assert.equal(rows[0]?.before.per_dog_cancel_enabled, true);
    },
  );
});

describe('every other cxl key is stored only: 422 setting_inert (D5; §3.8)', () => {
  const INERT: ReadonlyArray<[keyof PatchStaffSettingsCxlRequest, PatchStaffSettingsCxlRequest]> = [
    ['window_state', { window_state: { 'day-school': 'hours' } }],
    ['window_hours', { window_hours: { 'day-school': 24 } }],
    ['forfeit_fraction', { forfeit_fraction: { 'day-school': 0.5 } }],
    ['no_show_forfeit_fraction', { no_show_forfeit_fraction: { 'day-care': 0.5 } }],
    ['flat_fee_cents', { flat_fee_cents: { boarding: 500 } }],
    ['unpaid_no_show_close_after_hours', { unpaid_no_show_close_after_hours: { evaluation: 12 } }],
    ['no_show_declare_mode', { no_show_declare_mode: { 'private-lesson': 'auto_after_hours' } }],
    [
      'staff_entered_client_cancel_follows_owner_rules_enabled',
      { staff_entered_client_cancel_follows_owner_rules_enabled: false },
    ],
    ['staff_initiated_cancel_full_return_enabled', { staff_initiated_cancel_full_return_enabled: false }],
    ['class_missed_meeting_money_return_mode', { class_missed_meeting_money_return_mode: 'refund' }],
    ['started_run_cancel_return_mode', { started_run_cancel_return_mode: 'refund' }],
  ];
  for (const [key, body] of INERT) {
    test(`${key} → 422 setting_inert, for the owner`, SKIP_WHEN_NO_DB, async () => {
      const res = await patchCxl(appAs(SHANTHI), body);
      assert.equal(res.statusCode, 422, res.body);
      assert.deepEqual(res.json<{ error: { code: string; details: unknown } }>().error, {
        code: 'setting_inert',
        message: `stored, not read in this release: ${key}`,
        details: { kind: 'setting_inert', inert_keys: [key] },
      });
    });
  }

  test(
    'a per-service key naming a category with no row, or a value of the wrong type, is 400',
    SKIP_WHEN_NO_DB,
    async () => {
      for (const body of [
        { flat_fee_cents: { walk_in: 0 } },
        { window_state: 'none' },
        { per_dog_cancel_enabled: 'no' },
      ]) {
        const res = await patchCxl(appAs(SHANTHI), body as PatchStaffSettingsCxlRequest);
        assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
      }
    },
  );
});
