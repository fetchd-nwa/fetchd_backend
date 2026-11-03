import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import type { Principal } from '../../src/auth/principal.js';
import type { MeWire, StaffDogWire, StaffOwnerWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { dogs, owners, stripeCustomers } from '../../src/db/schema/schema.js';
import { registerMeRoute } from '../../src/routes/me.js';
import { registerPaymentMethodsRoute } from '../../src/routes/paymentMethods.js';
import { registerStaffDogsRoute } from '../../src/routes/staffDogs.js';
import { registerStaffOwnersRoute } from '../../src/routes/staffOwners.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * P05 fix round 1, BF1 (Fable L2 = Opus L2, Opus nice N1): ONE "filled" test
 * for every reader of `owners.name` and `.phone` — `signupFields.isNonBlank`.
 * A stored value with no visible character (the pre-3.0.0 `PATCH /me` stored
 * `'  '`; an import could store anything) is no value on every wire:
 *   - `MeWire.name`/`.phone`: `null`, and listed in `missing_mandatory_fields`;
 *   - `StaffOwnerWire.name`/`.phone`: `null`, and the family sorts by her email;
 *   - `StaffDogWire.owner_name`: her email;
 *   - the Stripe customer: created with no `name`.
 * A visible value passes through unchanged on all four. Each family is seeded
 * here and deleted in `finally`.
 */

registerFixtureHooks();

const BLANK: Record<string, string> = {
  'two spaces': '  ',
  'NBSP only': ' ',
  'U+3000 only': '　',
  'ZWSP only': '​',
  'mixed blanks': '  ​　',
};

const VISIBLE: Record<string, string> = {
  'a plain name': 'Nora Quinlan',
  'an accented name': 'Zoë',
  'a CJK name': '中村',
  'a name wrapped in blanks': ' Nora​',
};

interface Seen {
  me: { name: string | null; phone: string | null; missing: string[] };
  staffOwner: { name: string | null; phone: string | null };
  ownerName: string | undefined;
  stripeName: string | null;
}

/** What each reader serves for one family whose name AND phone hold `value`. */
async function readersFor(value: string): Promise<{ seen: Seen; email: string }> {
  const ownerId = randomUUID();
  const supabaseUid = randomUUID();
  const dogId = randomUUID();
  const email = `zz-readers-${ownerId}@example.invalid`;
  await db.insert(owners).values({
    id: ownerId,
    supabaseUid,
    name: value,
    email,
    phone: value,
    location: 'fayetteville',
    emergencyName: 'Sean Quinlan',
    emergencyRelationship: 'spouse',
    emergencyPhone: '479-555-0151',
  });
  try {
    await db
      .insert(dogs)
      .values({ id: dogId, ownerId, name: 'Mabel', breed: 'Beagle', birthdate: '2026-03-10' });
    const principal: Principal = { kind: 'owner', ownerId, supabaseUid };

    const meApp = makeContractApp(principal);
    registerMeRoute(meApp.app, { authenticate: meApp.authenticate });
    const me = (await meApp.app.inject({ method: 'GET', url: '/me' })).json<MeWire>();

    const ownersApp = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
    registerStaffOwnersRoute(ownersApp.app, { authenticate: ownersApp.authenticate });
    const list = (await ownersApp.app.inject({ method: 'GET', url: '/staff/owners' })).json<
      StaffOwnerWire[]
    >();
    const row = list.find((o) => o.id === ownerId);

    const dogsApp = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
    registerStaffDogsRoute(dogsApp.app, { authenticate: dogsApp.authenticate });
    const dog = (await dogsApp.app.inject({ method: 'GET', url: '/staff/dogs' }))
      .json<StaffDogWire[]>()
      .find((d) => d.id === dogId);

    const payApp = makeContractApp(principal);
    const stripe = makeStripeStub();
    registerPaymentMethodsRoute(payApp.app, { authenticate: payApp.authenticate, stripe });
    const intent = await payApp.app.inject({
      method: 'POST',
      url: '/payment-methods/setup-intent',
      headers: { 'idempotency-key': `si-readers-${randomUUID()}` },
      payload: {},
    });
    assert.equal(intent.statusCode, 201, intent.body);
    const create = stripe.calls.find((c) => c.method === 'createCustomer');
    assert.ok(create, 'the first card creates the Stripe customer');
    const args = create.args as Record<string, unknown>;

    return {
      email,
      seen: {
        me: { name: me.name, phone: me.phone, missing: me.missing_mandatory_fields },
        staffOwner:
          row === undefined
            ? { name: 'ABSENT', phone: 'ABSENT' }
            : { name: row.name, phone: row.phone },
        ownerName: dog?.owner_name,
        stripeName: Object.hasOwn(args, 'name') ? (args.name as string) : null,
      },
    };
  } finally {
    await db.delete(stripeCustomers).where(eq(stripeCustomers.ownerId, ownerId));
    await db.delete(dogs).where(eq(dogs.id, dogId));
    await db.delete(owners).where(eq(owners.id, ownerId));
  }
}

test(
  'BF1: a name and phone with no visible character read as none on all four readers',
  SKIP_WHEN_NO_DB,
  async () => {
    const actual: Record<string, Seen> = {};
    const expected: Record<string, Seen> = {};
    for (const [label, value] of Object.entries(BLANK)) {
      const { seen, email } = await readersFor(value);
      actual[label] = seen;
      expected[label] = {
        me: { name: null, phone: null, missing: ['name', 'phone'] },
        staffOwner: { name: null, phone: null },
        ownerName: email,
        stripeName: null,
      };
    }
    assert.deepEqual(actual, expected);
  },
);

test(
  'BF1: a value with a visible character passes through unchanged on all four readers',
  SKIP_WHEN_NO_DB,
  async () => {
    const actual: Record<string, Seen> = {};
    const expected: Record<string, Seen> = {};
    for (const [label, value] of Object.entries(VISIBLE)) {
      actual[label] = (await readersFor(value)).seen;
      expected[label] = {
        me: { name: value, phone: value, missing: [] },
        staffOwner: { name: value, phone: value },
        ownerName: value,
        stripeName: value,
      };
    }
    assert.deepEqual(actual, expected);
  },
);

test(
  'BF1: GET /staff/owners sorts a blank-named family by her email, not first (Opus P2: "  " sorted first)',
  SKIP_WHEN_NO_DB,
  async () => {
    const ids: string[] = [];
    try {
      for (const value of Object.values(BLANK)) {
        const id = randomUUID();
        ids.push(id);
        await db.insert(owners).values({
          id,
          supabaseUid: randomUUID(),
          name: value,
          email: `zz-sort-${id}@example.invalid`,
          phone: null,
          location: null,
        });
      }
      const app = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
      registerStaffOwnersRoute(app.app, { authenticate: app.authenticate });
      const order = (await app.app.inject({ method: 'GET', url: '/staff/owners' }))
        .json<StaffOwnerWire[]>()
        .map((o) => o.id);
      const fixture = order.indexOf(FIXTURE_IDS.ownerId);
      // "zz-sort-…@…" sorts after "allison fixture": every blank family must too.
      const early = ids.filter((id) => order.indexOf(id) < fixture);
      assert.deepEqual(
        early,
        [],
        `blank-named families sorted before "Allison Fixture": ${order.join(', ')}`,
      );
    } finally {
      await db.delete(owners).where(inArray(owners.id, ids));
    }
  },
);
