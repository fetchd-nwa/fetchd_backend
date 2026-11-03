import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inArray } from 'drizzle-orm';
import type { Principal } from '../../src/auth/principal.js';
import type { GetStaffOwnersResponse, StaffOwnerWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { owners } from '../../src/db/schema/schema.js';
import { registerStaffOwnersRoute } from '../../src/routes/staffOwners.js';
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

/**
 * `GET /staff/owners` `[staff]` — the owner picker (P03, wire 2.0.0
 * `StaffOwnerWire`; design §1.1:718-719, §2.1:2153-2157). Any staff role reads
 * it, an owner (family) principal is 403; live owners only, ordered by name
 * case-insensitively, then id; exactly six fields and no money field.
 */

registerFixtureHooks();

function appAs(principal: Principal) {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffOwnersRoute(app, { authenticate });
  return app;
}

const OWNER_KEYS = ['email', 'id', 'location', 'name', 'phone', 'source'];

/** Two extra families: a live one whose lower-case name sorts before the
 *  fixture's "Allison Fixture" only case-insensitively, and an expired one. */
async function seedFamilies(): Promise<{ alice: string; expired: string }> {
  const alice = randomUUID();
  const expired = randomUUID();
  await db.insert(owners).values([
    {
      id: alice,
      supabaseUid: randomUUID(),
      name: 'alice lowercase',
      email: 'alice@example.invalid',
      phone: '555-0101',
      location: 'bentonville',
      source: 'gingr',
    },
    {
      id: expired,
      supabaseUid: randomUUID(),
      name: 'Aaron Expired',
      email: 'gone@example.invalid',
      phone: '555-0102',
      location: 'fayetteville',
      expiredAt: '2026-10-01T00:00:00Z',
    },
  ]);
  return { alice, expired };
}

test(
  'a trainer reads every live family: six fields, no money field, the expired one absent',
  SKIP_WHEN_NO_DB,
  async () => {
    const { alice, expired } = await seedFamilies();
    try {
      const res = await appAs(FIXTURE_STAFF_PRINCIPAL).inject({
        method: 'GET',
        url: '/staff/owners',
      });
      assert.equal(res.statusCode, 200, res.body);
      const rows = res.json<GetStaffOwnersResponse>();
      for (const row of rows) {
        assert.deepEqual(
          Object.keys(row).sort(),
          OWNER_KEYS,
          `a row carries more or less: ${JSON.stringify(row)}`,
        );
      }
      const ids = rows.map((r) => r.id);
      assert.ok(!ids.includes(expired), 'an expired family is listed');
      const fixture = rows.find((r) => r.id === FIXTURE_IDS.ownerId);
      assert.deepEqual(fixture, {
        id: FIXTURE_IDS.ownerId,
        name: 'Allison Fixture',
        email: 'fixture@example.com',
        phone: '555-0001',
        location: 'fayetteville',
        source: 'app',
      } satisfies StaffOwnerWire);
      assert.equal(rows.find((r) => r.id === alice)?.source, 'gingr');
      // Case-insensitive: "alice lowercase" < "allison fixture"; a byte order would put "A…" first.
      assert.ok(
        ids.indexOf(alice) < ids.indexOf(FIXTURE_IDS.ownerId),
        `not ordered by lower(name): ${ids.join(', ')}`,
      );
    } finally {
      await db.delete(owners).where(inArray(owners.id, [alice, expired]));
    }
  },
);

test(
  'a manager and the owner role read it too; an owner (family) principal is 403',
  SKIP_WHEN_NO_DB,
  async () => {
    for (const principal of [FIXTURE_MANAGER_PRINCIPAL, FIXTURE_OWNER_ROLE_PRINCIPAL]) {
      const res = await appAs(principal).inject({ method: 'GET', url: '/staff/owners' });
      assert.equal(res.statusCode, 200, res.body);
    }
    const res = await appAs(FIXTURE_OWNER_PRINCIPAL).inject({
      method: 'GET',
      url: '/staff/owners',
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'forbidden');
  },
);
