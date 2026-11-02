import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { makeAuthenticate, registerAuth } from '../../src/auth/plugin.js';
import type { Principal } from '../../src/auth/principal.js';
import { resolvePrincipal } from '../../src/auth/mirror.js';
import { db } from '../../src/db/client.js';
import { staff } from '../../src/db/schema/schema.js';
import { registerMeRoute } from '../../src/routes/me.js';
import { registerStaffSettingsRoute } from '../../src/routes/staffSettings.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  loadSnapshot,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

registerFixtureHooks();

/**
 * The RUNTIME half of the 1.13.0 `MeWire` / `StaffMeWire` promotion.
 *
 * `test/` is not in any tsconfig — the suite runs type-erased
 * (designs/wire-contract-completion.md §14.5) — so a `satisfies MeWire` here
 * would assert nothing. These key lists are therefore a HAND MIRROR of the wire
 * declarations, and the wire↔emission link is carried by the compile-time half:
 * `ownerProfile(): MeWire` / `staffProfile(): StaffMeWire` in
 * `src/routes/me.ts`, which IS inside the compiled graph.
 */
const ME_WIRE_KEYS = [
  'id',
  'name',
  'email',
  'phone',
  'location',
  'avatar_image_path',
  'emergency_contact',
  'address',
  'push_notifications_enabled',
  'push_notification_categories',
  'email_notifications_enabled',
  'email_notification_categories',
  'show_dogs_on_welcome',
];
const ME_EMERGENCY_CONTACT_KEYS = ['name', 'relationship', 'phone'];
const ME_ADDRESS_KEYS = ['line1', 'line2', 'city', 'state', 'zip'];
const STAFF_ME_WIRE_KEYS = ['id', 'name', 'role', 'home_locations', 'image_path', 'capabilities'];
const STAFF_CAPABILITY_KEYS = [
  'edit_prices',
  'edit_money_policy',
  'open_money_reports',
  'open_payment_history',
  'refund_money',
  'edit_credits',
  'custom_invoice',
  'desk_sale',
  'cash_day_totals',
];

/** What the seeded lists give each role (s18, SIGNOFF.md:121; §1.1:695-709).
 *  `edit_prices` is false for every role in v1, the owner included (q27 → a). */
const SEEDED_CAPABILITIES = {
  owner: {
    edit_prices: false,
    edit_money_policy: true,
    open_money_reports: true,
    open_payment_history: true,
    refund_money: true,
    edit_credits: true,
    custom_invoice: true,
    desk_sale: true,
    cash_day_totals: true,
  },
  manager: {
    edit_prices: false,
    edit_money_policy: true,
    open_money_reports: true,
    open_payment_history: true,
    refund_money: true,
    edit_credits: true,
    custom_invoice: true,
    desk_sale: true,
    cash_day_totals: true,
  },
  // Fed opening Tomi's ledger (s18): no Refund, no Add or remove credits, no
  // Edit expiry, no New invoice, no Charge card — but the desk sale and the
  // end-of-day totals.
  trainer: {
    edit_prices: false,
    edit_money_policy: false,
    open_money_reports: false,
    open_payment_history: false,
    refund_money: false,
    edit_credits: false,
    custom_invoice: false,
    desk_sale: true,
    cash_day_totals: true,
  },
} as const;

/** The staff `/me` emission for the fixture trainer (Donavan). Inline rather
 *  than a snapshot file BECAUSE it is the freeze: the shape should be readable
 *  in the test that pins it. Re-frozen at 2.0.0-lg1.2 (P02): `location` became
 *  `home_locations`, `active` went with `staff.active`, `capabilities` arrived. */
const STAFF_ME_SNAPSHOT = {
  id: FIXTURE_IDS.staffDonavanId,
  name: 'Donavan',
  role: 'trainer',
  home_locations: ['Fayetteville, AR'],
  image_path: '',
  capabilities: SEEDED_CAPABILITIES.trainer,
};

function keys(value: unknown): string[] {
  assert.ok(value !== null && typeof value === 'object', 'expected an object');
  return Object.keys(value as Record<string, unknown>).sort();
}

test(
  'GET /me (owner) byte-matches MeWire — wire.ts domain:auth-media',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerMeRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/me' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), loadSnapshot('me'));

    // MeWire key set — exactly these, no more, no fewer (an added key is an
    // additive wire change and must be declared, not discovered).
    const body = res.json() as Record<string, unknown>;
    assert.deepStrictEqual(keys(body), [...ME_WIRE_KEYS].sort());
    assert.deepStrictEqual(keys(body.emergency_contact), [...ME_EMERGENCY_CONTACT_KEYS].sort());
    assert.deepStrictEqual(keys(body.address), [...ME_ADDRESS_KEYS].sort());

    // The non-omit exceptions the wire documents: nullable columns emit '',
    // never null and never an omitted key.
    assert.equal(typeof body.avatar_image_path, 'string');
    for (const k of ME_EMERGENCY_CONTACT_KEYS) {
      assert.equal(typeof (body.emergency_contact as Record<string, unknown>)[k], 'string');
    }
    for (const k of ME_ADDRESS_KEYS) {
      assert.equal(typeof (body.address as Record<string, unknown>)[k], 'string');
    }

    // location is the DISPLAY label, not the slug (the one translating surface).
    assert.ok(['Fayetteville, AR', 'Bentonville, AR'].includes(body.location as string));

    // push/email_notification_categories are `unknown` on the wire on purpose —
    // the jsonb column has no CHECK (schema.sql:248,250) and the server itself
    // narrows defensively (lib/pushPreferences.ts:84-95). So this asserts
    // PRESENCE only; asserting a shape here would pin a promise the DB does not
    // make. The fixture's actual value is pinned by the snapshot above.
    assert.ok('push_notification_categories' in body);
    assert.ok('email_notification_categories' in body);
  },
);

test(
  'GET /me (staff) byte-matches the StaffMeWire freeze, re-frozen at 2.0.0-lg1.2',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerMeRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/me' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), STAFF_ME_SNAPSHOT);

    const body = res.json() as Record<string, unknown>;
    assert.deepStrictEqual(keys(body), [...STAFF_ME_WIRE_KEYS].sort());
    assert.deepStrictEqual(keys(body.capabilities), [...STAFF_CAPABILITY_KEYS].sort());
    // role speaks the rebuilt staff_role vocabulary (M1.19; DRIFT-43 closed).
    assert.ok(['owner', 'manager', 'trainer'].includes(body.role as string));
    assert.equal('location' in body, false, 'location is home_locations since 2.0.0-lg1.2');
    assert.equal('active' in body, false, 'active went with staff.active (M1.20)');
    // image_path is '' — never null, and (unlike MeWire.avatar_image_path)
    // never resolved to a signed URL.
    assert.equal(typeof body.image_path, 'string');
  },
);

// ── STAFF-U03 / STAFF-U07 (P02): home campuses and capabilities ──────────────

function meAs(principal: Principal) {
  const { app, authenticate } = makeContractApp(principal);
  registerMeRoute(app, { authenticate });
  registerStaffSettingsRoute(app, { authenticate });
  return app;
}

async function capabilitiesOf(principal: Principal): Promise<Record<string, boolean>> {
  const res = await meAs(principal).inject({ method: 'GET', url: '/me' });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<{ capabilities: Record<string, boolean> }>().capabilities;
}

async function restoreStaffSettings(): Promise<void> {
  await db.execute(sql`UPDATE staff_settings SET
    refund_roles = '{owner,manager}', credit_hand_edit_roles = '{owner,manager}',
    desk_sale_roles = '{owner,manager,trainer}', custom_invoice_roles = '{owner,manager}',
    cash_day_totals_roles = '{owner,manager,trainer}', portal_idle_signout_minutes = 30,
    updated_by_staff_id = NULL`);
  await db.execute(
    sql`UPDATE payment_settings SET value = '0', updated_by_staff_id = NULL WHERE key = 'refund_any_role_limit_cents'`,
  );
}

test(
  'GET /me: each role’s capabilities at the seeded lists (s18) — owner, manager, trainer',
  SKIP_WHEN_NO_DB,
  async () => {
    assert.deepStrictEqual(
      await capabilitiesOf(FIXTURE_OWNER_ROLE_PRINCIPAL),
      SEEDED_CAPABILITIES.owner,
    );
    assert.deepStrictEqual(
      await capabilitiesOf(FIXTURE_MANAGER_PRINCIPAL),
      SEEDED_CAPABILITIES.manager,
    );
    assert.deepStrictEqual(
      await capabilitiesOf(FIXTURE_STAFF_PRINCIPAL),
      SEEDED_CAPABILITIES.trainer,
    );
  },
);

test(
  'GET /me: home_locations are display labels, never empty — Shanthi both campuses, Amber Bentonville',
  SKIP_WHEN_NO_DB,
  async () => {
    const shanthi = await meAs(FIXTURE_OWNER_ROLE_PRINCIPAL).inject({ method: 'GET', url: '/me' });
    assert.deepStrictEqual(
      [...shanthi.json<{ home_locations: string[] }>().home_locations].sort(),
      ['Bentonville, AR', 'Fayetteville, AR'],
    );
    const amber = await meAs(FIXTURE_MANAGER_PRINCIPAL).inject({ method: 'GET', url: '/me' });
    assert.deepStrictEqual(amber.json(), {
      id: FIXTURE_IDS.staffAmberId,
      name: 'Amber',
      role: 'manager',
      home_locations: ['Bentonville, AR'],
      image_path: '',
      capabilities: SEEDED_CAPABILITIES.manager,
    });
  },
);

test(
  "the owner's GET /me says edit_prices: false, and her price PATCH is 403 (q27 → a)",
  SKIP_WHEN_NO_DB,
  async () => {
    const app = meAs(FIXTURE_OWNER_ROLE_PRINCIPAL);
    const me = await app.inject({ method: 'GET', url: '/me' });
    assert.equal(
      me.json<{ capabilities: { edit_prices: boolean } }>().capabilities.edit_prices,
      false,
    );
    const res = await app.inject({
      method: 'PATCH',
      url: '/staff/settings/day',
      headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      payload: JSON.stringify({ after_school_price_cents: 0 }),
    });
    assert.equal(res.statusCode, 403, res.body);
  },
);

test(
  "capabilities are data: an owner's list edit shows at the caller's next GET /me",
  SKIP_WHEN_NO_DB,
  async () => {
    try {
      const owner = meAs(FIXTURE_OWNER_ROLE_PRINCIPAL);
      const res = await owner.inject({
        method: 'PATCH',
        url: '/staff/settings/staff',
        headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
        payload: JSON.stringify({
          refund_roles: ['owner', 'manager', 'trainer'],
          desk_sale_roles: ['manager'],
        }),
      });
      assert.equal(res.statusCode, 200, res.body);
      const trainer = await capabilitiesOf(FIXTURE_STAFF_PRINCIPAL);
      assert.equal(trainer.refund_money, true, 'the trainer was added to refund_roles');
      assert.equal(trainer.desk_sale, false, 'the trainer was taken off desk_sale_roles');
      // STAFF-09: a list without 'owner' still lets the owner through.
      assert.equal((await capabilitiesOf(FIXTURE_OWNER_ROLE_PRINCIPAL)).desk_sale, true);
      assert.equal((await capabilitiesOf(FIXTURE_MANAGER_PRINCIPAL)).desk_sale, true);
    } finally {
      await restoreStaffSettings();
    }
  },
);

test(
  'refund_money opens to every role while pay.refund_any_role_limit_cents is above 0 (§1.1:697-699)',
  SKIP_WHEN_NO_DB,
  async () => {
    try {
      assert.equal((await capabilitiesOf(FIXTURE_STAFF_PRINCIPAL)).refund_money, false);
      await db.execute(
        sql`UPDATE payment_settings SET value = '25000' WHERE key = 'refund_any_role_limit_cents'`,
      );
      const trainer = await capabilitiesOf(FIXTURE_STAFF_PRINCIPAL);
      assert.equal(trainer.refund_money, true);
      assert.equal(trainer.edit_credits, false, 'only refund_money follows the limit');
    } finally {
      await restoreStaffSettings();
    }
  },
);

// P02 fix round 1 (DECISIONS 79; adversary M1): a slug the static label map
// cannot render — a `locations` row added without a label, or a hand edit —
// is a loud 500, never `[null]` in a list the wire promises is display labels.
test(
  'GET /me: a home campus with no display label is a 500 internal, never a null in home_locations',
  SKIP_WHEN_NO_DB,
  async () => {
    const id = randomUUID();
    const uid = randomUUID();
    await db.execute(
      sql`INSERT INTO staff (id, supabase_uid, name, role, home_locations)
          VALUES (${id}, ${uid}, 'Typo', 'trainer', ARRAY['bentonville', 'rogers'])`,
    );
    try {
      const res = await meAs({
        kind: 'staff',
        staffId: id,
        role: 'trainer',
        supabaseUid: uid,
      }).inject({ method: 'GET', url: '/me' });
      assert.equal(res.statusCode, 500, res.body);
      assert.equal(res.json().error.code, 'internal');
    } finally {
      await db.delete(staff).where(eq(staff.id, id));
    }
  },
);

/**
 * The expired staffer through the REAL resolve path (design §2.10:4638-4639;
 * contract notes Part 4 item 4): `X-Dev-Principal` skips the mirror, so it
 * could never see `expired_at`. Here the verifier is stubbed (its job is
 * proven in `auth.test.ts`) and `resolvePrincipal` reads the row.
 */
test(
  'an expired staffer’s bearer is 403 not_provisioned on GET /me — sign-in reads expired_at alone',
  SKIP_WHEN_NO_DB,
  async () => {
    const uid = randomUUID();
    const id = randomUUID();
    await db.insert(staff).values({
      id,
      supabaseUid: uid,
      name: 'Leaver',
      role: 'trainer',
      homeLocations: ['bentonville'],
    });
    try {
      const app = Fastify();
      registerAuth(app);
      const authenticate = makeAuthenticate({
        verify: async () => ({ sub: uid }),
        resolve: resolvePrincipal,
        bypassEnabled: false,
      });
      registerMeRoute(app, { authenticate });
      const bearer = { authorization: 'Bearer stub-verified' };

      const live = await app.inject({ method: 'GET', url: '/me', headers: bearer });
      assert.equal(live.statusCode, 200, `control (live row): ${live.body}`);

      await db
        .update(staff)
        .set({ expiredAt: sql`now()` })
        .where(eq(staff.id, id));
      const expired = await app.inject({ method: 'GET', url: '/me', headers: bearer });
      assert.equal(expired.statusCode, 403, expired.body);
      assert.equal(expired.json().error.code, 'not_provisioned');
    } finally {
      await db.delete(staff).where(eq(staff.id, id));
    }
  },
);
