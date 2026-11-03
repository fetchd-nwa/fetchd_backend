import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { Principal } from '../../src/auth/principal.js';
import type { MeWire, SignupField, SignupFieldMode } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { owners } from '../../src/db/schema/schema.js';
import { registerMeRoute } from '../../src/routes/me.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * ACCT-U04 (S05; design §2.2:2244, §1.1:738, :758-763; wire 3.0.0-lg2.1):
 * `GET /me` and `PATCH /me` follow the sign-up map
 * (`acct.signup_field_requirement_map`, the `account_settings.signup_fields`
 * column), read from Postgres on every call.
 *
 * `PATCH /me`'s refusal order, atomic: the Idempotency-Key 400, the strict
 * parse's 400, the empty-patch 400, a body that NAMES an `off` field (400,
 * whatever the value), then a body that would BLANK a `mandatory` field — 422
 * `profile_incomplete` `{kind, field_keys}`, every such field in
 * `SIGNUP_FIELDS` order. A field already empty that the body does not name
 * refuses nothing (X3). Each test runs as a fresh family of its own, and puts
 * the map back in `finally`.
 */

registerFixtureHooks();

const SEED_MAP: Record<SignupField, SignupFieldMode> = {
  name: 'mandatory',
  phone: 'mandatory',
  email: 'mandatory',
  location: 'mandatory',
  emergency_contact: 'mandatory',
  address: 'asked',
};

async function setMap(changes: Partial<Record<SignupField, SignupFieldMode>>): Promise<void> {
  await db.execute(
    sql`UPDATE account_settings SET signup_fields = ${JSON.stringify({ ...SEED_MAP, ...changes })}::jsonb`,
  );
}

async function restoreMap(): Promise<void> {
  await setMap({});
}

interface Family {
  id: string;
  principal: Principal;
}

/** A fresh live family (Nora Quinlan's shape: every mandatory field filled,
 *  no address), deleted by `dropFamily`. */
async function seedFamily(overrides: Partial<typeof owners.$inferInsert> = {}): Promise<Family> {
  const id = randomUUID();
  const supabaseUid = randomUUID();
  await db.insert(owners).values({
    id,
    supabaseUid,
    name: 'Nora Quinlan',
    email: `nora-${id}@example.invalid`,
    phone: '555-0150',
    location: 'fayetteville',
    emergencyName: 'Sean Quinlan',
    emergencyRelationship: 'spouse',
    emergencyPhone: '555-0151',
    ...overrides,
  });
  return { id, principal: { kind: 'owner', ownerId: id, supabaseUid } };
}

async function dropFamily(family: Family): Promise<void> {
  await db.delete(owners).where(eq(owners.id, family.id));
}

async function rowOf(family: Family) {
  const [row] = await db.select().from(owners).where(eq(owners.id, family.id));
  assert.ok(row, 'the family row is gone');
  return row;
}

function appAs(principal: Principal) {
  const { app, authenticate } = makeContractApp(principal);
  registerMeRoute(app, { authenticate });
  return app;
}

function patchMe(principal: Principal, body: unknown) {
  return appAs(principal).inject({
    method: 'PATCH',
    url: '/me',
    headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

async function getMe(principal: Principal): Promise<MeWire> {
  const res = await appAs(principal).inject({ method: 'GET', url: '/me' });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<MeWire>();
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function assertProfileIncomplete(
  res: Awaited<ReturnType<typeof patchMe>>,
  fieldKeys: SignupField[],
): void {
  assert.equal(res.statusCode, 422, res.body);
  const { error } = res.json<ErrorBody>();
  assert.equal(error.code, 'profile_incomplete');
  assert.deepEqual(error.details, { kind: 'profile_incomplete', field_keys: fieldKeys });
}

const BLANK_ADDRESS = { line1: '', line2: '', city: '', state: '', zip: '' };
const NORA_ADDRESS = {
  line1: '12 Dickson St',
  line2: '',
  city: 'Fayetteville',
  state: 'AR',
  zip: '72701',
};

// ── (a)–(d): blanking a mandatory field is 422, and nothing is written ──────

test(
  '(a) PATCH {phone: null} at the seed map is 422 profile_incomplete [phone]; the row is unchanged — a mixed body writes nothing',
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily();
    try {
      const before = await rowOf(family);
      assertProfileIncomplete(await patchMe(family.principal, { phone: null }), ['phone']);
      assertProfileIncomplete(await patchMe(family.principal, { name: 'Nora Q.', phone: null }), [
        'phone',
      ]);
      assert.deepEqual(await rowOf(family), before);
    } finally {
      await dropFamily(family);
    }
  },
);

test(
  "(b) PATCH {name: '  '} is 422 [name]: a name with no non-space character is blank",
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily();
    try {
      assertProfileIncomplete(await patchMe(family.principal, { name: '  ' }), ['name']);
      assert.equal((await rowOf(family)).name, 'Nora Quinlan');
    } finally {
      await dropFamily(family);
    }
  },
);

test(
  "(c) PATCH {emergency_contact: {name:'', relationship:'', phone:''}} is 422 [emergency_contact]",
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily();
    try {
      assertProfileIncomplete(
        await patchMe(family.principal, {
          emergency_contact: { name: '', relationship: '', phone: '' },
        }),
        ['emergency_contact'],
      );
      // "Filled" is name AND phone: either one blank is blank.
      assertProfileIncomplete(
        await patchMe(family.principal, {
          emergency_contact: { name: 'Sean Quinlan', relationship: 'spouse', phone: ' ' },
        }),
        ['emergency_contact'],
      );
      const row = await rowOf(family);
      assert.equal(row.emergencyName, 'Sean Quinlan');
      assert.equal(row.emergencyPhone, '555-0151');
    } finally {
      await dropFamily(family);
    }
  },
);

test(
  "(d) PATCH {name: null, phone: null, location: null} is 422 with field_keys exactly ['name','phone','location']",
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily();
    try {
      assertProfileIncomplete(
        await patchMe(family.principal, { location: null, phone: null, name: null }),
        ['name', 'phone', 'location'],
      );
    } finally {
      await dropFamily(family);
    }
  },
);

// ── (e)–(f): an `asked` field may be cleared ────────────────────────────────

test('(e) with address asked (the seed), a blank address is 200', SKIP_WHEN_NO_DB, async () => {
  const family = await seedFamily({
    addressLine1: '12 Dickson St',
    addressCity: 'Fayetteville',
    addressState: 'AR',
    addressZip: '72701',
  });
  try {
    const res = await patchMe(family.principal, { address: BLANK_ADDRESS });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json<MeWire>().address, BLANK_ADDRESS);
  } finally {
    await dropFamily(family);
  }
});

test(
  "(f) phone asked: PATCH {phone: null} is 200 and GET /me reads phone null, never ''; a blank string is stored NULL too",
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily();
    try {
      await setMap({ phone: 'asked' });
      const res = await patchMe(family.principal, { phone: null });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json<MeWire>().phone, null);
      assert.equal((await getMe(family.principal)).phone, null);
      assert.equal((await rowOf(family)).phone, null);

      assert.equal((await patchMe(family.principal, { phone: '555-0152' })).statusCode, 200);
      const blank = await patchMe(family.principal, { phone: '   ' });
      assert.equal(blank.statusCode, 200, blank.body);
      assert.equal(blank.json<MeWire>().phone, null);
      assert.equal((await rowOf(family)).phone, null, "a blank phone is stored NULL, not '   '");
    } finally {
      await restoreMap();
      await dropFamily(family);
    }
  },
);

// ── (g): an `off` field is refused by name, whatever its value ──────────────

test(
  '(g) address off: PATCH {address} is 400 naming address, whatever the value; PATCH {name} is 200',
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily();
    try {
      await setMap({ address: 'off' });
      for (const address of [NORA_ADDRESS, BLANK_ADDRESS]) {
        const res = await patchMe(family.principal, { address });
        assert.equal(res.statusCode, 400, res.body);
        const { error } = res.json<ErrorBody>();
        assert.equal(error.code, 'bad_request');
        assert.match(error.message, /\baddress\b/);
      }
      // The off field's 400 comes before a mandatory blank's 422.
      const both = await patchMe(family.principal, { phone: null, address: NORA_ADDRESS });
      assert.equal(both.statusCode, 400, both.body);
      assert.equal((await rowOf(family)).addressLine1, null);

      const ok = await patchMe(family.principal, { name: 'X' });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json<MeWire>().name, 'X');
    } finally {
      await restoreMap();
      await dropFamily(family);
    }
  },
);

test(
  'the refusal order: a strict-parse 400 and an empty-patch 400 come before the map',
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily();
    try {
      await setMap({ address: 'off' });
      const unknown = await patchMe(family.principal, { address: NORA_ADDRESS, nickname: 'N' });
      assert.equal(unknown.statusCode, 400, unknown.body);
      assert.match(unknown.json<ErrorBody>().error.message, /invalid profile patch/);
      const empty = await patchMe(family.principal, {});
      assert.equal(empty.statusCode, 400, empty.body);
      assert.match(empty.json<ErrorBody>().error.message, /no updatable fields/);
      const noKey = await appAs(family.principal).inject({
        method: 'PATCH',
        url: '/me',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ phone: null }),
      });
      assert.equal(noKey.statusCode, 400, noKey.body);
    } finally {
      await restoreMap();
      await dropFamily(family);
    }
  },
);

// ── (h)–(i): missing_mandatory_fields ───────────────────────────────────────

test(
  '(h) missing_mandatory_fields: the fixture family [], phone NULL [phone], address flipped mandatory adds it, email never',
  SKIP_WHEN_NO_DB,
  async () => {
    assert.deepEqual((await getMe(FIXTURE_OWNER_PRINCIPAL)).missing_mandatory_fields, []);
    const family = await seedFamily({ phone: null });
    try {
      assert.deepEqual((await getMe(family.principal)).missing_mandatory_fields, ['phone']);
      await setMap({ address: 'mandatory' });
      // Read on every call: the flip shows at the next GET, in SIGNUP_FIELDS order.
      assert.deepEqual((await getMe(family.principal)).missing_mandatory_fields, [
        'phone',
        'address',
      ]);
      await setMap({ address: 'mandatory', name: 'off', location: 'asked' });
      const unnamed = await seedFamily({ name: null, location: null, phone: null });
      try {
        const me = await getMe(unnamed.principal);
        assert.equal(me.name, null);
        assert.equal(me.location, null);
        assert.deepEqual(me.missing_mandatory_fields, ['phone', 'address']);
        assert.ok(!me.missing_mandatory_fields.includes('email'));
      } finally {
        await dropFamily(unnamed);
      }
    } finally {
      await restoreMap();
      await dropFamily(family);
    }
  },
);

test(
  "(i) a family with phone NULL: PATCH {name} is 200 and still lists [phone]; PATCH {phone: ''} is 422 [phone]",
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily({ phone: null });
    try {
      const res = await patchMe(family.principal, { name: 'New' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json<MeWire>().name, 'New');
      assert.deepEqual(res.json<MeWire>().missing_mandatory_fields, ['phone']);
      assertProfileIncomplete(await patchMe(family.principal, { phone: '' }), ['phone']);
    } finally {
      await dropFamily(family);
    }
  },
);

// ── (j): ACCT-47 — each self-edit field round-trips ─────────────────────────

test(
  '(j) ACCT-47: name, phone, location, emergency_contact, address and avatar each round-trip through PATCH /me and GET /me',
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily();
    try {
      const edits: Array<[keyof MeWire, unknown]> = [
        ['name', 'Nora Quinlan-Reyes'],
        ['phone', '479-555-0199'],
        ['location', 'Bentonville, AR'],
        ['emergency_contact', { name: 'Ana Reyes', relationship: 'sister', phone: '479-555-0177' }],
        ['address', NORA_ADDRESS],
        ['avatar_image_path', 'avatars/nora.png'],
      ];
      for (const [field, value] of edits) {
        const res = await patchMe(family.principal, { [field]: value });
        assert.equal(res.statusCode, 200, `${field}: ${res.body}`);
        assert.deepEqual(res.json<MeWire>()[field], value, `${field} in the PATCH response`);
        assert.deepEqual((await getMe(family.principal))[field], value, `${field} at the next GET`);
      }
      const row = await rowOf(family);
      assert.equal(row.location, 'bentonville', 'the display label is stored as the slug');
      assert.deepEqual((await getMe(family.principal)).missing_mandatory_fields, []);
    } finally {
      await dropFamily(family);
    }
  },
);

// ── the one order: SIGNUP_FIELDS', never the map's (X8) ─────────────────────

test(
  "field_keys and missing_mandatory_fields list in SIGNUP_FIELDS order, not the map's (jsonb sorts keys by length: address first)",
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily({
      location: null,
      emergencyName: null,
      emergencyRelationship: null,
      emergencyPhone: null,
    });
    try {
      await setMap({ address: 'mandatory' });
      assert.deepEqual((await getMe(family.principal)).missing_mandatory_fields, [
        'location',
        'emergency_contact',
        'address',
      ]);
      assertProfileIncomplete(
        await patchMe(family.principal, {
          address: BLANK_ADDRESS,
          emergency_contact: { name: '', relationship: '', phone: '' },
          location: null,
        }),
        ['location', 'emergency_contact', 'address'],
      );
    } finally {
      await restoreMap();
      await dropFamily(family);
    }
  },
);

// ── fix round 1, BF1 (Opus nice N1): no visible character is blank ──────────

test(
  'BF1: PATCH a mandatory name of spaces, NBSP, U+3000 or a zero-width space is 422 [name]; a zero-width emergency phone is 422 [emergency_contact]',
  SKIP_WHEN_NO_DB,
  async () => {
    const family = await seedFamily();
    try {
      const before = await rowOf(family);
      const statuses: Record<string, number> = {};
      for (const [label, value] of Object.entries({
        'two spaces': '  ',
        'NBSP only': ' ',
        'U+3000 only': '　',
        'ZWSP only': '​',
        'ZWNJ and word joiner': '‌⁠',
      })) {
        const res = await patchMe(family.principal, { name: value });
        statuses[label] = res.statusCode;
        if (res.statusCode === 422) assertProfileIncomplete(res, ['name']);
      }
      assert.deepEqual(statuses, {
        'two spaces': 422,
        'NBSP only': 422,
        'U+3000 only': 422,
        'ZWSP only': 422,
        'ZWNJ and word joiner': 422,
      });
      assertProfileIncomplete(
        await patchMe(family.principal, {
          emergency_contact: { name: 'Sean Quinlan', relationship: 'spouse', phone: '​' },
        }),
        ['emergency_contact'],
      );
      assert.deepEqual(await rowOf(family), before, 'a refused body wrote something');
    } finally {
      await dropFamily(family);
    }
  },
);
