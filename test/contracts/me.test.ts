import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerMeRoute } from '../../src/routes/me.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
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
const STAFF_ME_WIRE_KEYS = ['id', 'name', 'role', 'location', 'image_path', 'active'];

/** The frozen staff `/me` emission for the fixture trainer (Donavan,
 *  `_fixture.ts:487-496`). Inline rather than a snapshot file BECAUSE it is the
 *  freeze: the ratified shape should be readable in the test that pins it. */
const STAFF_ME_SNAPSHOT = {
  id: FIXTURE_IDS.staffDonavanId,
  name: 'Donavan',
  role: 'trainer',
  location: 'Fayetteville, AR',
  image_path: '',
  active: true,
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
  'GET /me (staff) byte-matches the RATIFIED StaffMeWire freeze (NOTE-35)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
    registerMeRoute(app, { authenticate });

    const res = await app.inject({ method: 'GET', url: '/me' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), STAFF_ME_SNAPSHOT);

    const body = res.json() as Record<string, unknown>;
    assert.deepStrictEqual(keys(body), [...STAFF_ME_WIRE_KEYS].sort());
    // role speaks the DB staff_role vocabulary, never the portal's
    // 'owner'|'manager'|'trainer' (DISCREPANCIES.md:501 DRIFT-43).
    assert.ok(['owner-shanthi', 'trainer', 'office'].includes(body.role as string));
    // image_path is '' — never null, and (unlike MeWire.avatar_image_path)
    // never resolved to a signed URL.
    assert.equal(typeof body.image_path, 'string');
    assert.equal(typeof body.active, 'boolean');
  },
);
