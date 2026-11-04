import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../src/auth/principal.js';
import type {
  OwnerSettingsWire,
  PaymentSettingWire,
  SettingsWireByDomain,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';
import { registerSettingsRoute } from '../../src/routes/settings.js';
import {
  SETTINGS_TARGETS,
  boundsErrors,
  isValueRefusal,
  registerStaffSettingsRoute,
} from '../../src/routes/staffSettings.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  type LogCapture,
  registerFixtureHooks,
} from './_harness.js';

/**
 * `GET /settings` (owner document) and `GET/PATCH /staff/settings/:domain
 * [/:location]` (SET-U01, STAFF-U07's class gate; design §1.1:628-649,
 * §2.1:1849-1887; wire 2.0.0-lg1.2 § settings).
 *
 * The principals are the fixture's three roles (P02, STAFF-U07): Shanthi the
 * owner (`ops`, `money`, `roles`), Amber the manager (`ops`, `money`), Donavan
 * the trainer (`ops`). No role edits a `price` key in v1. Every test that
 * writes a setting puts it back in `finally`.
 */

registerFixtureHooks();

const SHANTI = FIXTURE_OWNER_ROLE_PRINCIPAL;
const SHANTI_ID = FIXTURE_IDS.staffShanthiId;
const TRAINER = FIXTURE_STAFF_PRINCIPAL;
const MANAGER = FIXTURE_MANAGER_PRINCIPAL;

function appAs(principal: Principal, capture?: LogCapture): FastifyInstance {
  const { app, authenticate } = makeContractApp(principal, capture);
  registerSettingsRoute(app, { authenticate });
  registerStaffSettingsRoute(app, { authenticate });
  return app;
}

function patch(app: FastifyInstance, url: string, body: unknown, key: string = randomUUID()) {
  return app.inject({
    method: 'PATCH',
    url,
    headers: { 'idempotency-key': key, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

/** The shared error envelope (`auth/plugin.ts`). */
interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

async function setRaw(statement: ReturnType<typeof sql>): Promise<void> {
  await db.execute(statement);
}

// ── R2 ───────────────────────────────────────────────────────────────────────

describe(
  'R2 — a settings PATCH is reflected by the very next GET /settings',
  SKIP_WHEN_NO_DB,
  () => {
    test('cred.expiry_warning_lead_days, edited by staff, is what the owner document says next', async () => {
      const staffApp = appAs(SHANTI);
      const ownerApp = appAs(FIXTURE_OWNER_PRINCIPAL);
      try {
        const before = (
          await ownerApp.inject({ method: 'GET', url: '/settings' })
        ).json<OwnerSettingsWire>();
        assert.deepEqual(before.cred.expiry_warning_lead_days, [7]);

        const res = await patch(staffApp, '/staff/settings/cred', {
          expiry_warning_lead_days: [10, 3],
        });
        assert.equal(res.statusCode, 200, res.body);

        const after = (
          await ownerApp.inject({ method: 'GET', url: '/settings' })
        ).json<OwnerSettingsWire>();
        assert.deepEqual(after.cred.expiry_warning_lead_days, [10, 3]);
      } finally {
        await setRaw(sql`UPDATE credit_settings SET expiry_warning_lead_days = '{7}'`);
      }
    });

    test("a campus cap edit is the very next read of that campus's row, by any role (Amber's 08:45)", async () => {
      // The owner document carries no cap (the app reads seats from availability),
      // so the next read here is the staff row's.
      const staffApp = appAs(TRAINER); // ops: any role (STAFF-73)
      try {
        const res = await patch(staffApp, '/staff/settings/day/bentonville', {
          daily_capacity_dogs: 6,
        });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.json<SettingsWireByDomain['day']>().location, 'bentonville');
        const staffRead = await staffApp.inject({
          method: 'GET',
          url: '/staff/settings/day/bentonville',
        });
        assert.equal(staffRead.json<{ daily_capacity_dogs: number }>().daily_capacity_dogs, 6);
        const fayetteville = await staffApp.inject({
          method: 'GET',
          url: '/staff/settings/day/fayetteville',
        });
        assert.equal(fayetteville.json<{ daily_capacity_dogs: number }>().daily_capacity_dogs, 15);
      } finally {
        await setRaw(
          sql`UPDATE day_program_settings SET daily_capacity_dogs = 15 WHERE location = 'bentonville'`,
        );
      }
    });
  },
);

// ── the owner document ───────────────────────────────────────────────────────

describe('GET /settings — the owner document', SKIP_WHEN_NO_DB, () => {
  test('carries the expiry switch (true) and the 7-day lead, and no cxl or mig section', async () => {
    const res = await appAs(FIXTURE_OWNER_PRINCIPAL).inject({ method: 'GET', url: '/settings' });
    assert.equal(res.statusCode, 200, res.body);
    const doc = res.json<OwnerSettingsWire & Record<string, unknown>>();
    assert.deepEqual(doc.cred, { expiry_enforced_enabled: true, expiry_warning_lead_days: [7] });
    assert.equal('cxl' in doc, false);
    assert.equal('mig' in doc, false);
    assert.deepEqual(Object.keys(doc).sort(), [
      'cls',
      'cred',
      'day',
      'eval',
      'gates',
      'msg',
      'notif',
      'offerings',
      'pay',
      'rpt',
      'vax',
    ]);
  });

  test('is per campus where the settings are, and never carries a day-school price', async () => {
    const doc = (
      await appAs(FIXTURE_OWNER_PRINCIPAL).inject({ method: 'GET', url: '/settings' })
    ).json<OwnerSettingsWire>();
    assert.equal(doc.offerings.fayetteville['day-care'].offered, false);
    assert.equal(doc.offerings.bentonville['day-care'].offered, true);
    for (const service of ['boarding', 'board-and-train', 'private-lesson'] as const) {
      assert.equal(doc.offerings.fayetteville[service].offered, false);
      assert.equal(doc.offerings.bentonville[service].offered, false);
    }
    assert.equal(doc.offerings.fayetteville['day-school'].name, null, 'name is NOT SEEDED (D6)');
    assert.deepEqual(doc.day.by_location.fayetteville.open_weekdays_list, [1, 2, 3, 4, 5]);
    assert.equal(doc.day.by_location.bentonville.dropoff_open_time, '07:30');
    assert.equal(doc.day.booking_horizon_months, 3);
    assert.equal(doc.day.after_school_price_cents, 0);
    assert.equal(JSON.stringify(doc).includes('day_school_price'), false);
    assert.deepEqual(doc.gates, {
      card_on_file: true,
      evaluation: true,
      vaccines: true,
      agreements: true,
    });
    assert.equal(doc.eval.reeval_after_months_unseen, 3);
    for (const location of ['fayetteville', 'bentonville'] as const) {
      assert.equal(doc.eval.by_location[location].price_cents, 0, 'the M3.05 seed');
    }
    assert.equal(doc.pay.charge_timing_mode['day-school'], 'at_confirm');
    assert.equal(doc.pay.charge_timing_mode['private-lesson'], 'at_close_out');
    assert.equal(doc.pay.max_sessions_per_booking_count, 30);
    assert.deepEqual(Object.keys(doc.msg).sort(), [
      'max_attachments_per_message',
      'max_text_length_chars',
      'referral_subtopic_enabled',
      'request_reply_window_hours',
      'video_max_duration_seconds',
      'video_max_size_mb',
    ]);
    assert.ok(doc.cls.every((c) => Number.isInteger(c.price_per_dog_cents) && c.weeks > 0));
  });

  test('a staff principal reads the same document (no principal-kind gate)', async () => {
    const res = await appAs(TRAINER).inject({ method: 'GET', url: '/settings' });
    assert.equal(res.statusCode, 200, res.body);
  });
});

// ── GET /staff/settings ──────────────────────────────────────────────────────

describe('GET /staff/settings/:domain[/:location]', SKIP_WHEN_NO_DB, () => {
  test('every domain answers 200 with its seeded row', async () => {
    const app = appAs(TRAINER);
    const expect: Record<string, (body: unknown) => void> = {
      acct: (b) => assert.equal((b as SettingsWireByDomain['acct']).signup_fields.address, 'asked'),
      alum: (b) => assert.equal((b as SettingsWireByDomain['alum']).recheck_after_months_unseen, 6),
      cash: (b) => {
        const due = (b as SettingsWireByDomain['cash']).due_event_by_service;
        assert.equal(due.boarding, null);
        assert.equal('package' in due, false, 'no package entry (D1)');
      },
      cred: (b) => assert.equal((b as SettingsWireByDomain['cred']).expiry_enforced_enabled, true),
      day: (b) => assert.equal((b as SettingsWireByDomain['day']).location, null),
      dog: (b) =>
        assert.equal(
          (b as SettingsWireByDomain['dog']).card_required_for_evaluation_booking_enabled,
          true,
        ),
      eval: (b) =>
        assert.equal((b as { reeval_after_months_unseen: number }).reeval_after_months_unseen, 3),
      mig: (b) => assert.equal((b as SettingsWireByDomain['mig']).pilot_family_count, 5),
      msg: (b) =>
        assert.equal((b as SettingsWireByDomain['msg']).school_default_responder_first_name, null),
      notif: (b) =>
        assert.equal((b as SettingsWireByDomain['notif']).quiet_hours_start_time, '21:00'),
      pay: (b) => assert.equal((b as PaymentSettingWire[]).length, 16),
      rpt: (b) => assert.equal((b as SettingsWireByDomain['rpt']).media_max_upload_megabytes, 25),
      vax: (b) =>
        assert.equal((b as SettingsWireByDomain['vax']).typical_full_vaccination_age_months, 4),
      staff: (b) =>
        assert.equal((b as SettingsWireByDomain['staff']).portal_idle_signout_minutes, 30),
    };
    for (const [domain, check] of Object.entries(expect)) {
      const res = await app.inject({ method: 'GET', url: `/staff/settings/${domain}` });
      assert.equal(res.statusCode, 200, `${domain}: ${res.body}`);
      check(res.json());
    }
    const campus = await app.inject({ method: 'GET', url: '/staff/settings/eval/fayetteville' });
    assert.deepEqual(
      { ...campus.json<Record<string, unknown>>(), updated_at: 'x' },
      {
        location: 'fayetteville',
        max_per_day_dogs: null,
        updated_at: 'x',
        updated_by_staff_id: null,
      },
    );
  });

  test('every seeded value is inside its registry bounds (the zod mirror of the CHECKs agrees with the seeds)', async () => {
    const app = appAs(TRAINER);
    for (const target of SETTINGS_TARGETS) {
      const locations =
        target.location === null ? [null] : (['fayetteville', 'bentonville'] as const);
      for (const location of locations) {
        const url = `/staff/settings/${target.domain}${location === null ? '' : `/${location}`}`;
        const row = (await app.inject({ method: 'GET', url })).json<unknown>();
        const body: Record<string, unknown> = {};
        if (Array.isArray(row)) {
          for (const r of row as PaymentSettingWire[]) {
            if (r.key === 'charge_timing_mode') {
              body.charge_timing_mode = {
                ...(body.charge_timing_mode as object),
                [r.scope]: r.value,
              };
            } else body[r.key] = r.value;
          }
        } else Object.assign(body, row);
        assert.deepEqual(boundsErrors({ domain: target.domain, location }, body), [], url);
      }
    }
  });

  test('a bad path is 400: an unknown domain, a location on a one-row domain, an unknown campus', async () => {
    const app = appAs(TRAINER);
    for (const url of [
      '/staff/settings/cxl',
      '/staff/settings/acct/fayetteville',
      '/staff/settings/day/springdale',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
    }
  });

  test('an owner (family) principal is refused 403', async () => {
    const res = await appAs(FIXTURE_OWNER_PRINCIPAL).inject({
      method: 'GET',
      url: '/staff/settings/acct',
    });
    assert.equal(res.statusCode, 403);
  });

  test('the responders resolve to first names on the server', async () => {
    try {
      await setRaw(
        sql`UPDATE messaging_settings SET school_default_responder_staff_id = ${FIXTURE_IDS.staffDonavanId}`,
      );
      const res = await appAs(TRAINER).inject({ method: 'GET', url: '/staff/settings/msg' });
      const msg = res.json<SettingsWireByDomain['msg']>();
      assert.equal(msg.school_default_responder_staff_id, FIXTURE_IDS.staffDonavanId);
      assert.equal(msg.school_default_responder_first_name, 'Donavan');
      assert.equal(msg.school_backup_responder_first_name, null);
    } finally {
      await setRaw(sql`UPDATE messaging_settings SET school_default_responder_staff_id = NULL`);
    }
  });
});

// ── PATCH: the refusal order, one test per adjacent pair ─────────────────────

async function dayGlobal(): Promise<Record<string, unknown>> {
  return (await appAs(TRAINER).inject({ method: 'GET', url: '/staff/settings/day' })).json();
}

describe(
  'PATCH refuses in order 400 → 403 → 422 setting_inert → 422 invalid_payload',
  SKIP_WHEN_NO_DB,
  () => {
    test('400 before 403: an unknown key beside a refused key is 400, and nothing is written', async () => {
      const before = await dayGlobal();
      const res = await patch(appAs(TRAINER), '/staff/settings/day', {
        closure_return_fraction: 1, // money: refused to a trainer
        day_school_price_cents: 6000, // no such key (R1)
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.deepEqual(await dayGlobal(), before);
    });

    test('403 before 422 setting_inert: refused_keys lists only the refused key', async () => {
      const before = await dayGlobal();
      const res = await patch(appAs(TRAINER), '/staff/settings/day', {
        closure_return_fraction: 1, // money (and inert): refused
        occupied_block_end_time: '17:00', // ops, inert: not refused
      });
      assert.equal(res.statusCode, 403, res.body);
      assert.deepEqual(res.json<ErrorBody>().error.details, {
        kind: 'refused_keys',
        refused_keys: ['closure_return_fraction'],
      });
      assert.deepEqual(await dayGlobal(), before);
    });

    test('422 setting_inert before 422 invalid_payload: an inert key beside an out-of-range one', async () => {
      const before = await dayGlobal();
      const res = await patch(appAs(SHANTI), '/staff/settings/day', {
        occupied_block_end_time: '17:00', // inert
        booking_horizon_months: 0, // out of range
      });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(res.json<ErrorBody>().error.code, 'setting_inert');
      assert.deepEqual(res.json<ErrorBody>().error.details, {
        kind: 'setting_inert',
        inert_keys: ['occupied_block_end_time'],
      });
      assert.deepEqual(await dayGlobal(), before);
    });

    test('422 invalid_payload: a value out of range is 422, not 500, and nothing is written', async () => {
      const before = await dayGlobal();
      const res = await patch(appAs(SHANTI), '/staff/settings/day', { booking_horizon_months: 0 });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(res.json<ErrorBody>().error.code, 'invalid_payload');
      assert.deepEqual(await dayGlobal(), before);
    });

    test('Postgres 23514 is 422 invalid_payload, not 500', async () => {
      // A CHECK the route's value rules do not know, so the write reaches Postgres.
      await setRaw(
        sql`ALTER TABLE reports_settings ADD CONSTRAINT p01_probe_check CHECK (media_max_upload_megabytes <> 13)`,
      );
      try {
        const res = await patch(appAs(TRAINER), '/staff/settings/rpt', {
          media_max_upload_megabytes: 13,
        });
        assert.equal(res.statusCode, 422, res.body);
        assert.equal(res.json<ErrorBody>().error.code, 'invalid_payload');
        const rpt = (
          await appAs(TRAINER).inject({ method: 'GET', url: '/staff/settings/rpt' })
        ).json<SettingsWireByDomain['rpt']>();
        assert.equal(rpt.media_max_upload_megabytes, 25);
      } finally {
        await setRaw(sql`ALTER TABLE reports_settings DROP CONSTRAINT p01_probe_check`);
      }
    });
  },
);

// ── PATCH: who may edit what ─────────────────────────────────────────────────

describe('PATCH — the class gate: owner, manager, trainer (STAFF-U07)', SKIP_WHEN_NO_DB, () => {
  test('the expiry switch (money): a trainer is refused; the owner edits it and is stamped', async () => {
    try {
      const refused = await patch(appAs(TRAINER), '/staff/settings/cred', {
        expiry_enforced_enabled: false,
      });
      assert.equal(refused.statusCode, 403, refused.body);
      assert.deepEqual(refused.json<ErrorBody>().error.details, {
        kind: 'refused_keys',
        refused_keys: ['expiry_enforced_enabled'],
      });

      const ok = await patch(appAs(SHANTI), '/staff/settings/cred', {
        expiry_enforced_enabled: false,
      });
      assert.equal(ok.statusCode, 200, ok.body);
      const cred = ok.json<SettingsWireByDomain['cred']>();
      assert.equal(cred.expiry_enforced_enabled, false);
      assert.equal(cred.updated_by_staff_id, SHANTI_ID);

      const audit = await db.execute<{
        actor: string;
        before: { expiry_enforced_enabled: boolean };
      }>(
        sql`SELECT actor, before FROM audit_log WHERE table_name = 'credit_settings' ORDER BY id DESC LIMIT 1`,
      );
      assert.equal(audit.rows[0]?.actor, `staff:${SHANTI_ID}`);
      assert.equal(
        audit.rows[0]?.before.expiry_enforced_enabled,
        true,
        'the replaced value is kept',
      );
    } finally {
      await setRaw(
        sql`UPDATE credit_settings SET expiry_enforced_enabled = true, updated_by_staff_id = NULL`,
      );
    }
  });

  test('the expiry switch is money, not roles: the manager edits it too (Amber may; §3.14)', async () => {
    try {
      const ok = await patch(appAs(MANAGER), '/staff/settings/cred', {
        expiry_enforced_enabled: false,
      });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(
        ok.json<SettingsWireByDomain['cred']>().updated_by_staff_id,
        FIXTURE_IDS.staffAmberId,
      );
    } finally {
      await setRaw(
        sql`UPDATE credit_settings SET expiry_enforced_enabled = true, updated_by_staff_id = NULL`,
      );
    }
  });

  test('a price key is refused to every role in v1, the owner included', async () => {
    for (const principal of [SHANTI, MANAGER, TRAINER]) {
      const res = await patch(appAs(principal), '/staff/settings/day', {
        after_school_price_cents: 0,
      });
      assert.equal(res.statusCode, 403, res.body);
      assert.deepEqual(res.json<ErrorBody>().error.details, {
        kind: 'refused_keys',
        refused_keys: ['after_school_price_cents'],
      });
    }
  });

  test('a pay money key: the owner edits it, the trainer may not', async () => {
    try {
      const refused = await patch(appAs(TRAINER), '/staff/settings/pay', {
        card_attempts_max_count: 4,
      });
      assert.equal(refused.statusCode, 403, refused.body);
      const ok = await patch(appAs(SHANTI), '/staff/settings/pay', { card_attempts_max_count: 4 });
      assert.equal(ok.statusCode, 200, ok.body);
      const row = ok.json<PaymentSettingWire[]>().find((r) => r.key === 'card_attempts_max_count');
      assert.equal(row?.value, 4);
      const tooMany = await patch(appAs(SHANTI), '/staff/settings/pay', {
        card_attempts_max_count: 6,
      });
      assert.equal(tooMany.statusCode, 422, tooMany.body);
    } finally {
      await setRaw(
        sql`UPDATE payment_settings SET value = '3', updated_by_staff_id = NULL WHERE key = 'card_attempts_max_count'`,
      );
    }
  });

  test('charge_timing_mode: a scope with no row is 400; a real scope is inert (stored only)', async () => {
    const noRow = await patch(appAs(SHANTI), '/staff/settings/pay', {
      charge_timing_mode: { boarding: 'at_confirm' },
    });
    assert.equal(noRow.statusCode, 400, noRow.body);
    const inert = await patch(appAs(SHANTI), '/staff/settings/pay', {
      charge_timing_mode: { 'day-school': 'at_close_out' },
    });
    assert.equal(inert.statusCode, 422, inert.body);
    assert.deepEqual(inert.json<ErrorBody>().error.details, {
      kind: 'setting_inert',
      inert_keys: ['charge_timing_mode'],
    });
  });

  test('a re-cut inert key (P06) is 422 setting_inert, not editable yet', async () => {
    const res = await patch(appAs(SHANTI), '/staff/settings/dog', { gate_vaccines_enabled: false });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json<ErrorBody>().error.code, 'setting_inert');
  });
});

// ── PATCH: shape, tiers and idempotency ──────────────────────────────────────

describe('PATCH — body shape, tiers and Idempotency-Key', SKIP_WHEN_NO_DB, () => {
  test('an empty body is 400, and so is a missing Idempotency-Key', async () => {
    const app = appAs(SHANTI);
    assert.equal((await patch(app, '/staff/settings/cred', {})).statusCode, 400);
    const noKey = await app.inject({
      method: 'PATCH',
      url: '/staff/settings/cred',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ single_day_purchase_max_count: 20 }),
    });
    assert.equal(noKey.statusCode, 400, noKey.body);
  });

  test('each tier takes only its own keys: a campus key on the global path is 400, and vice versa', async () => {
    const app = appAs(SHANTI);
    assert.equal(
      (await patch(app, '/staff/settings/day', { daily_capacity_dogs: 6 })).statusCode,
      400,
    );
    assert.equal(
      (await patch(app, '/staff/settings/day/fayetteville', { booking_horizon_months: 2 }))
        .statusCode,
      400,
    );
  });

  test('a jsonb key is one value, replaced whole: a partial offerings map is 400', async () => {
    const res = await patch(appAs(SHANTI), '/staff/settings/day/fayetteville', {
      offerings: {
        'day-school': { offered: true, client_visible: true, name: null, description: null },
      },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  test('one Idempotency-Key sent to a second campus is 422 idempotency_mismatch; nothing is written twice', async () => {
    const app = appAs(SHANTI);
    const key = randomUUID();
    try {
      const first = await patch(
        app,
        '/staff/settings/day/fayetteville',
        { daily_capacity_dogs: 12 },
        key,
      );
      assert.equal(first.statusCode, 200, first.body);
      const replay = await patch(
        app,
        '/staff/settings/day/fayetteville',
        { daily_capacity_dogs: 12 },
        key,
      );
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(replay.json(), first.json());

      const second = await patch(
        app,
        '/staff/settings/day/bentonville',
        { daily_capacity_dogs: 12 },
        key,
      );
      assert.equal(second.statusCode, 422, second.body);
      assert.equal(second.json<ErrorBody>().error.code, 'idempotency_mismatch');
      const bentonville = (
        await app.inject({ method: 'GET', url: '/staff/settings/day/bentonville' })
      ).json<{
        daily_capacity_dogs: number;
      }>();
      assert.equal(bentonville.daily_capacity_dogs, 15);
    } finally {
      await setRaw(
        sql`UPDATE day_program_settings SET daily_capacity_dogs = 15 WHERE location IS NOT NULL`,
      );
    }
  });
});

// ── the staff domain (M1.21; STAFF-U07; design §1.1:687-701, §3.14) ─────────

describe('the staff settings domain — every key roles class (owner only)', SKIP_WHEN_NO_DB, () => {
  const restore = () =>
    setRaw(sql`UPDATE staff_settings SET
      refund_roles = '{owner,manager}', credit_hand_edit_roles = '{owner,manager}',
      desk_sale_roles = '{owner,manager,trainer}', custom_invoice_roles = '{owner,manager}',
      cash_day_totals_roles = '{owner,manager,trainer}', portal_idle_signout_minutes = 30,
      updated_by_staff_id = NULL`);

  test('any role reads it: the five lists and the minutes at their M1.21 seeds', async () => {
    for (const principal of [TRAINER, MANAGER, SHANTI]) {
      const res = await appAs(principal).inject({ method: 'GET', url: '/staff/settings/staff' });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json<SettingsWireByDomain['staff']>();
      assert.deepEqual(
        { ...body, updated_at: 'x' },
        {
          refund_roles: ['owner', 'manager'],
          credit_hand_edit_roles: ['owner', 'manager'],
          desk_sale_roles: ['owner', 'manager', 'trainer'],
          custom_invoice_roles: ['owner', 'manager'],
          cash_day_totals_roles: ['owner', 'manager', 'trainer'],
          portal_idle_signout_minutes: 30,
          updated_at: 'x',
          updated_by_staff_id: null,
        },
      );
    }
  });

  test("a trainer's and a manager's PATCH of portal_idle_signout_minutes is 403 refused_keys", async () => {
    for (const principal of [TRAINER, MANAGER]) {
      const res = await patch(appAs(principal), '/staff/settings/staff', {
        portal_idle_signout_minutes: 45,
      });
      assert.equal(res.statusCode, 403, res.body);
      assert.deepEqual(res.json<ErrorBody>().error.details, {
        kind: 'refused_keys',
        refused_keys: ['portal_idle_signout_minutes'],
      });
    }
  });

  test('the manager may not widen a money list: refund_roles is 403 refused_keys (only the owner widens who touches money)', async () => {
    const res = await patch(appAs(MANAGER), '/staff/settings/staff', {
      refund_roles: ['owner', 'manager', 'trainer'],
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.deepEqual(res.json<ErrorBody>().error.details, {
      kind: 'refused_keys',
      refused_keys: ['refund_roles'],
    });
  });

  test("the owner's 45 is 200 and stamped; her 61 is 422 invalid_payload — never setting_inert", async () => {
    try {
      const ok = await patch(appAs(SHANTI), '/staff/settings/staff', {
        portal_idle_signout_minutes: 45,
      });
      assert.equal(ok.statusCode, 200, ok.body);
      const body = ok.json<SettingsWireByDomain['staff']>();
      assert.equal(body.portal_idle_signout_minutes, 45);
      assert.equal(body.updated_by_staff_id, SHANTI_ID);

      const tooLong = await patch(appAs(SHANTI), '/staff/settings/staff', {
        portal_idle_signout_minutes: 61,
      });
      assert.equal(tooLong.statusCode, 422, tooLong.body);
      assert.equal(tooLong.json<ErrorBody>().error.code, 'invalid_payload');
    } finally {
      await restore();
    }
  });

  test('the owner edits a list; the replaced list is kept in audit_log (STAFF-74)', async () => {
    try {
      const res = await patch(appAs(SHANTI), '/staff/settings/staff', {
        refund_roles: ['owner', 'manager', 'trainer'],
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json<SettingsWireByDomain['staff']>().refund_roles, [
        'owner',
        'manager',
        'trainer',
      ]);
      const audit = await db.execute<{ actor: string; before: { refund_roles: string[] } }>(
        sql`SELECT actor, before FROM audit_log WHERE table_name = 'staff_settings' ORDER BY id DESC LIMIT 1`,
      );
      assert.equal(audit.rows[0]?.actor, `staff:${SHANTI_ID}`);
      assert.deepEqual(audit.rows[0]?.before.refund_roles, ['owner', 'manager']);
    } finally {
      await restore();
    }
  });

  test('an empty list is 422 invalid_payload (the CHECK); an unknown or a repeated role is 400 bad_request (DECISIONS 59); nothing is written', async () => {
    try {
      const empty = await patch(appAs(SHANTI), '/staff/settings/staff', { desk_sale_roles: [] });
      assert.equal(empty.statusCode, 422, empty.body);
      assert.equal(empty.json<ErrorBody>().error.code, 'invalid_payload');
      for (const list of [['owner', 'office'], ['manager', 'manager'], ['owner-shanthi']]) {
        const res = await patch(appAs(SHANTI), '/staff/settings/staff', { desk_sale_roles: list });
        assert.equal(res.statusCode, 400, `${JSON.stringify(list)}: ${res.body}`);
        assert.equal(res.json<ErrorBody>().error.code, 'bad_request');
      }
      const read = await appAs(SHANTI).inject({ method: 'GET', url: '/staff/settings/staff' });
      assert.deepEqual(read.json<SettingsWireByDomain['staff']>().desk_sale_roles, [
        'owner',
        'manager',
        'trainer',
      ]);
      assert.equal(read.json<SettingsWireByDomain['staff']>().updated_by_staff_id, null);
    } finally {
      await restore();
    }
  });

  test("the database itself refuses an empty list and a 61 (M1.21's CHECKs)", async () => {
    for (const statement of [
      sql`UPDATE staff_settings SET cash_day_totals_roles = '{}'`,
      sql`UPDATE staff_settings SET portal_idle_signout_minutes = 61`,
    ]) {
      await assert.rejects(db.execute(statement), (err: unknown) => isValueRefusal(err));
    }
  });
});

// ── fix round 1 (DECISIONS 60–66) ────────────────────────────────────────────

async function campusOfferings(
  location: 'fayetteville' | 'bentonville',
): Promise<Record<string, Record<string, unknown>>> {
  const row = (
    await appAs(TRAINER).inject({ method: 'GET', url: `/staff/settings/day/${location}` })
  ).json<{
    offerings: Record<string, Record<string, unknown>>;
  }>();
  return row.offerings;
}

describe('fix round 1 — DECISIONS 60–66', SKIP_WHEN_NO_DB, () => {
  test('D73: refund_any_role_limit_cents is money class (DECISIONS 60 reversed) — owner 200, manager 200, trainer 403 refused_keys', async () => {
    try {
      for (const principal of [SHANTI, MANAGER]) {
        const ok = await patch(appAs(principal), '/staff/settings/pay', {
          refund_any_role_limit_cents: 0,
        });
        assert.equal(
          ok.statusCode,
          200,
          `${principal.kind === 'staff' && principal.role}: ${ok.body}`,
        );
      }
      const refused = await patch(appAs(TRAINER), '/staff/settings/pay', {
        refund_any_role_limit_cents: 25000,
      });
      assert.equal(refused.statusCode, 403, refused.body);
      assert.deepEqual(refused.json<ErrorBody>().error.details, {
        kind: 'refused_keys',
        refused_keys: ['refund_any_role_limit_cents'],
      });
    } finally {
      await setRaw(
        sql`UPDATE payment_settings SET value = '0', updated_by_staff_id = NULL WHERE key = 'refund_any_role_limit_cents'`,
      );
    }
  });

  test('D61: the expiry warning leads are never empty and never repeat — 422 invalid_payload', async () => {
    try {
      for (const leads of [[], [7, 7]]) {
        const res = await patch(appAs(TRAINER), '/staff/settings/cred', {
          expiry_warning_lead_days: leads,
        });
        assert.equal(res.statusCode, 422, `${JSON.stringify(leads)}: ${res.body}`);
        assert.equal(res.json<ErrorBody>().error.code, 'invalid_payload');
      }
      const cred = (
        await appAs(TRAINER).inject({ method: 'GET', url: '/staff/settings/cred' })
      ).json<SettingsWireByDomain['cred']>();
      assert.deepEqual(cred.expiry_warning_lead_days, [7], 'a refused body wrote something');
    } finally {
      await setRaw(
        sql`UPDATE credit_settings SET expiry_warning_lead_days = '{7}', updated_by_staff_id = NULL`,
      );
    }
  });

  test("D61: the database itself refuses an empty lead list (M1.06's CHECK)", async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        client.query("UPDATE credit_settings SET expiry_warning_lead_days = '{}'"),
        (err: { code?: string }) => err.code === '23514',
      );
    } finally {
      await client.query('ROLLBACK'); // whatever happened, nothing stays
      client.release();
    }
  });

  test('D62: the re-evaluation clock may be switched off — null passes the shape and the bounds (inert today, so the PATCH answers setting_inert, not 400)', async () => {
    const res = await patch(appAs(SHANTI), '/staff/settings/eval', {
      reeval_after_months_unseen: null,
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json<ErrorBody>().error.code, 'setting_inert');
    assert.deepEqual(
      boundsErrors({ domain: 'eval', location: null }, { reeval_after_months_unseen: null }),
      [],
    );
  });

  test("D62: M1.09's tier CHECK lets the global row hold a NULL clock; the seed stays 3", async () => {
    try {
      await setRaw(
        sql`UPDATE evaluation_settings SET reeval_after_months_unseen = NULL WHERE location IS NULL`,
      );
      const evalGlobal = (
        await appAs(TRAINER).inject({ method: 'GET', url: '/staff/settings/eval' })
      ).json<{
        reeval_after_months_unseen: number | null;
      }>();
      assert.equal(evalGlobal.reeval_after_months_unseen, null);
      const doc = (
        await appAs(FIXTURE_OWNER_PRINCIPAL).inject({ method: 'GET', url: '/settings' })
      ).json<OwnerSettingsWire>();
      assert.equal(doc.eval.reeval_after_months_unseen, null);
    } finally {
      await setRaw(
        sql`UPDATE evaluation_settings SET reeval_after_months_unseen = 3 WHERE location IS NULL`,
      );
    }
  });

  test("D69: a request service's name and description are editable", async () => {
    const seeded = await campusOfferings('fayetteville');
    try {
      const named = structuredClone(seeded);
      (named.boarding as Record<string, unknown>).name = 'Boarding';
      (named.boarding as Record<string, unknown>).description = 'Overnight stays';
      const res = await patch(appAs(TRAINER), '/staff/settings/day/fayetteville', {
        offerings: named,
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await campusOfferings('fayetteville')).boarding?.name, 'Boarding');
    } finally {
      await db.execute(
        sql`UPDATE day_program_settings SET offerings = ${JSON.stringify(seeded)}::jsonb WHERE location = 'fayetteville'`,
      );
    }
  });

  test('D65: an integer past int4 is 422 invalid_payload, not a 500 that pages', async () => {
    for (const [url, body] of [
      ['/staff/settings/day/fayetteville', { daily_capacity_dogs: 2147483648 }],
      ['/staff/settings/day/fayetteville', { daily_capacity_dogs: 1e21 }],
      ['/staff/settings/cred', { expiry_warning_lead_days: [2147483648] }],
    ] as const) {
      const res = await patch(appAs(TRAINER), url, body);
      assert.equal(res.statusCode, 422, `${JSON.stringify(body)}: ${res.body}`);
      assert.equal(res.json<ErrorBody>().error.code, 'invalid_payload');
    }
  });

  test('D65: Postgres 22003 and 22P02, like 23514, are value refusals (422), however wrapped', () => {
    for (const code of ['23514', '22003', '22P02']) {
      assert.equal(isValueRefusal({ code }), true, code);
      assert.equal(
        isValueRefusal({ message: 'wrapped', cause: { code } }),
        true,
        `wrapped ${code}`,
      );
    }
    assert.equal(isValueRefusal({ code: '23505' }), false);
    assert.equal(isValueRefusal(new Error('boom')), false);
  });

  test('D66: the email sender name and address refuse control characters (they become mail headers)', async () => {
    try {
      for (const body of [
        { email_sender_display_name: 'NWA School for Dogs\r\nBcc: someone@example.com' },
        { email_sender_display_name: 'NWA\u0000' },
        { email_sender_address: 'school@example.com\nBcc: x@example.com' },
        { email_sender_address: 'school@example.com\t' },
      ]) {
        const res = await patch(appAs(TRAINER), '/staff/settings/notif', body);
        assert.equal(res.statusCode, 422, `${JSON.stringify(body)}: ${res.body}`);
        assert.equal(res.json<ErrorBody>().error.code, 'invalid_payload');
      }
      const notif = (
        await appAs(TRAINER).inject({ method: 'GET', url: '/staff/settings/notif' })
      ).json<SettingsWireByDomain['notif']>();
      assert.equal(notif.email_sender_display_name, 'NWA School for Dogs');
      assert.equal(notif.email_sender_address, null);
    } finally {
      await setRaw(
        sql`UPDATE notification_settings SET email_sender_display_name = 'NWA School for Dogs', email_sender_address = NULL, updated_by_staff_id = NULL`,
      );
    }
  });
});

// ── fix round 2 (DECISIONS 69, 71) ───────────────────────────────────────────

describe('fix round 2 — DECISIONS 69 and 71', SKIP_WHEN_NO_DB, () => {
  test('D69: any role may switch a request service on at a campus (design.md:3719-3722), and the owner document serves it', async () => {
    const seeded = await campusOfferings('fayetteville');
    try {
      const on = structuredClone(seeded);
      (on.boarding as Record<string, unknown>).offered = true;
      (on.boarding as Record<string, unknown>).client_visible = true;
      const res = await patch(appAs(TRAINER), '/staff/settings/day/fayetteville', {
        offerings: on,
      });
      assert.equal(res.statusCode, 200, res.body);
      const doc = (
        await appAs(FIXTURE_OWNER_PRINCIPAL).inject({ method: 'GET', url: '/settings' })
      ).json<OwnerSettingsWire>();
      assert.equal(doc.offerings.fayetteville.boarding.offered, true);
      assert.equal(doc.offerings.fayetteville.boarding.client_visible, true);
      assert.equal(doc.offerings.bentonville.boarding.offered, false, 'one campus only');
    } finally {
      await db.execute(
        sql`UPDATE day_program_settings SET offerings = ${JSON.stringify(seeded)}::jsonb WHERE location = 'fayetteville'`,
      );
    }
  });

  test('D71: a NUL in an offerings name or description is 422 invalid_payload, not a 500', async () => {
    const seeded = await campusOfferings('bentonville');
    try {
      for (const field of ['name', 'description'] as const) {
        const bad = structuredClone(seeded);
        (bad['day-school'] as Record<string, unknown>)[field] = 'Day School\u0000';
        const res = await patch(appAs(TRAINER), '/staff/settings/day/bentonville', {
          offerings: bad,
        });
        assert.equal(res.statusCode, 422, `${field}: ${res.body}`);
        assert.equal(res.json<ErrorBody>().error.code, 'invalid_payload');
      }
      const crlf = structuredClone(seeded);
      (crlf['day-school'] as Record<string, unknown>).name = 'Day\r\nSchool';
      const res = await patch(appAs(TRAINER), '/staff/settings/day/bentonville', {
        offerings: crlf,
      });
      assert.equal(res.statusCode, 422, res.body);
      assert.deepEqual(
        await campusOfferings('bentonville'),
        seeded,
        'a refused body wrote something',
      );
    } finally {
      await db.execute(
        sql`UPDATE day_program_settings SET offerings = ${JSON.stringify(seeded)}::jsonb WHERE location = 'bentonville'`,
      );
    }
  });

  test("D71: an owner's NUL in an invoice kind list is 422 invalid_payload, not a 500", async () => {
    try {
      for (const key of ['custom_invoice_kind_list', 'custom_invoice_card_kind_list'] as const) {
        const res = await patch(appAs(SHANTI), '/staff/settings/pay', {
          [key]: ['vet-bill\u0000'],
        });
        assert.equal(res.statusCode, 422, `${key}: ${res.body}`);
        assert.equal(res.json<ErrorBody>().error.code, 'invalid_payload');
      }
    } finally {
      await setRaw(
        sql`UPDATE payment_settings SET value = '["vet-bill", "damage", "other"]', updated_by_staff_id = NULL WHERE key = 'custom_invoice_kind_list'`,
      );
      await setRaw(
        sql`UPDATE payment_settings SET value = '["vet-bill", "damage"]', updated_by_staff_id = NULL WHERE key = 'custom_invoice_card_kind_list'`,
      );
    }
  });

  test('D71: 22P05 and 22021 are value refusals too', () => {
    for (const code of ['22P05', '22021']) {
      assert.equal(isValueRefusal({ code }), true, code);
      assert.equal(isValueRefusal({ cause: { code } }), true, `wrapped ${code}`);
    }
  });

  test('D71: a refusal mapped from Postgres is logged at warn with its code and message (adversary L5)', async () => {
    await setRaw(
      sql`ALTER TABLE reports_settings ADD CONSTRAINT p01_probe_warn_check CHECK (media_max_upload_megabytes <> 14)`,
    );
    const capture = makeLogCapture();
    try {
      const res = await patch(appAs(TRAINER, capture), '/staff/settings/rpt', {
        media_max_upload_megabytes: 14,
      });
      assert.equal(res.statusCode, 422, res.body);
      const warn = capture.lines.find((l) => l.level === 40 && l.pgCode === '23514');
      assert.ok(
        warn !== undefined,
        `no warn line with the pg code: ${JSON.stringify(capture.lines)}`,
      );
      assert.match(String(warn.pgMessage), /p01_probe_warn_check/);
      assert.equal(
        capture.lines.some((l) => typeof l.level === 'number' && l.level >= 50),
        false,
        'a value refusal must not page (no error-level line)',
      );
    } finally {
      await setRaw(sql`ALTER TABLE reports_settings DROP CONSTRAINT p01_probe_warn_check`);
    }
  });

  test('D71: a role the class map does not know is refused 403, never a 500', async () => {
    // 'office' was a role until M1.19; a principal still carrying it (a stale
    // token's mirror, a hand-edited row) edits nothing.
    const stranger = {
      kind: 'staff',
      staffId: randomUUID(),
      role: 'office',
      supabaseUid: randomUUID(),
    } as unknown as Principal;
    const res = await patch(appAs(stranger), '/staff/settings/day/fayetteville', {
      daily_capacity_dogs: 9,
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.deepEqual(res.json<ErrorBody>().error.details, {
      kind: 'refused_keys',
      refused_keys: ['daily_capacity_dogs'],
    });
  });
});

// ── 2.0.0: the offerings copy caps (P03; build DECISIONS 89, J17 and J18) ────

describe(
  '2.0.0 — offerings name and description: capped in code points, never blank',
  SKIP_WHEN_NO_DB,
  () => {
    /** PATCH bentonville's offerings with `day-school`'s `field` set to `value`. */
    async function patchDaySchool(field: 'name' | 'description', value: string | null) {
      const body = structuredClone(await campusOfferings('bentonville'));
      (body['day-school'] as Record<string, unknown>)[field] = value;
      return patch(appAs(TRAINER), '/staff/settings/day/bentonville', { offerings: body });
    }

    // An astral emoji is ONE code point and TWO UTF-16 units: a cap counted in
    // UTF-16 units (`string.length`) refuses the 60-code-point name below.
    const DOG = '\u{1F415}';

    test('name: 61 code points is 422 naming day-school.name, nothing written; 60 with an emoji is 200', async () => {
      const seeded = await campusOfferings('bentonville');
      try {
        const over = await patchDaySchool('name', `${'A'.repeat(60)}${DOG}`);
        assert.equal(over.statusCode, 422, over.body);
        assert.equal(over.json<ErrorBody>().error.code, 'invalid_payload');
        assert.match(over.json<ErrorBody>().error.message, /day-school\.name/);
        assert.deepEqual(
          await campusOfferings('bentonville'),
          seeded,
          'a refused body wrote something',
        );
        const at = `${'A'.repeat(59)}${DOG}`;
        assert.equal([...at].length, 60);
        assert.equal(at.length, 61, 'precondition: more UTF-16 units than code points');
        const ok = await patchDaySchool('name', at);
        assert.equal(ok.statusCode, 200, ok.body);
        assert.equal((await campusOfferings('bentonville'))['day-school']?.name, at);
      } finally {
        await db.execute(
          sql`UPDATE day_program_settings SET offerings = ${JSON.stringify(seeded)}::jsonb WHERE location = 'bentonville'`,
        );
      }
    });

    test('description: 281 code points is 422 naming day-school.description; 280 is 200', async () => {
      const seeded = await campusOfferings('bentonville');
      try {
        const over = await patchDaySchool('description', `${'d'.repeat(280)}${DOG}`);
        assert.equal(over.statusCode, 422, over.body);
        assert.match(over.json<ErrorBody>().error.message, /day-school\.description/);
        const ok = await patchDaySchool('description', `${'d'.repeat(279)}${DOG}`);
        assert.equal(ok.statusCode, 200, ok.body);
      } finally {
        await db.execute(
          sql`UPDATE day_program_settings SET offerings = ${JSON.stringify(seeded)}::jsonb WHERE location = 'bentonville'`,
        );
      }
    });

    test('a blank name or description (empty or whitespace only) is 422; null clears it and is 200', async () => {
      const seeded = await campusOfferings('bentonville');
      try {
        for (const field of ['name', 'description'] as const) {
          for (const blank of ['', '   ']) {
            const res = await patchDaySchool(field, blank);
            assert.equal(res.statusCode, 422, `${field} ${JSON.stringify(blank)}: ${res.body}`);
            assert.equal(res.json<ErrorBody>().error.code, 'invalid_payload');
            assert.match(res.json<ErrorBody>().error.message, new RegExp(`day-school\\.${field}`));
          }
          const cleared = await patchDaySchool(field, null);
          assert.equal(cleared.statusCode, 200, `${field} null: ${cleared.body}`);
        }
        assert.deepEqual(
          await campusOfferings('bentonville'),
          seeded,
          'a refused body wrote something',
        );
      } finally {
        await db.execute(
          sql`UPDATE day_program_settings SET offerings = ${JSON.stringify(seeded)}::jsonb WHERE location = 'bentonville'`,
        );
      }
    });
  },
);

// ── P05 B4: email is fixed in the sign-up map (X5; design §2.2:2244) ─────────

test(
  'acct: a signup_fields.email other than mandatory is 422 invalid_payload, and nothing is written (X5)',
  SKIP_WHEN_NO_DB,
  async () => {
    const seed = {
      name: 'mandatory',
      phone: 'mandatory',
      email: 'mandatory',
      location: 'mandatory',
      emergency_contact: 'mandatory',
      address: 'asked',
    };
    const read = async () =>
      (await appAs(SHANTI).inject({ method: 'GET', url: '/staff/settings/acct' })).json<
        SettingsWireByDomain['acct']
      >();
    try {
      const before = await read();
      assert.deepEqual(before.signup_fields, seed);
      for (const email of ['asked', 'off']) {
        const res = await patch(appAs(TRAINER), '/staff/settings/acct', {
          signup_fields: { ...seed, email },
        });
        assert.equal(res.statusCode, 422, `${email}: ${res.body}`);
        const { error } = res.json<ErrorBody>();
        assert.equal(error.code, 'invalid_payload');
        assert.match(error.message, /\bemail\b/);
      }
      assert.deepEqual(await read(), before, 'a refused body wrote something');
      // Control: the map's other keys stay switchable (ops: any role).
      const ok = await patch(appAs(TRAINER), '/staff/settings/acct', {
        signup_fields: { ...seed, address: 'mandatory' },
      });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json<SettingsWireByDomain['acct']>().signup_fields.address, 'mandatory');
    } finally {
      await setRaw(
        sql`UPDATE account_settings SET signup_fields = ${JSON.stringify(seed)}::jsonb, updated_by_staff_id = NULL`,
      );
    }
  },
);
