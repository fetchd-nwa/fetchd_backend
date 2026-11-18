import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { TrainerWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { staff } from '../../src/db/schema/schema.js';
import { buildApp } from '../../src/server.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  registerFixtureHooks,
} from './_harness.js';
import { ownerApp, staffApp } from './_requestServices.js';

/**
 * Plan unit P49, contract item A9 (wire 9.0.0; design request-services-v1 §2.2, §4.3):
 * `GET /trainers` `[any principal]` — every live staffer with a lesson price or Board & Train
 * eligibility, ordered by name. It replaces the app's hard-coded trainer strips, so a staffer
 * with neither (Fed, Donavan, Amber) is never offered, and an expired one is gone.
 */

registerFixtureHooks();

const FED = randomUUID();
const PRIYA = randomUUID();
const GONE = randomUUID();

before(async () => {
  await db.insert(staff).values([
    {
      id: FED,
      supabaseUid: randomUUID(),
      name: 'Fed Acosta',
      role: 'trainer',
      homeLocations: ['bentonville'],
    },
    // Board & Train eligible with no lesson price: listed, with no price key.
    {
      id: PRIYA,
      supabaseUid: randomUUID(),
      name: 'Priya',
      role: 'trainer',
      homeLocations: ['bentonville'],
      boardTrainEligible: true,
    },
    // Priced and eligible, but expired.
    {
      id: GONE,
      supabaseUid: randomUUID(),
      name: 'Gone Trainer',
      role: 'trainer',
      homeLocations: ['fayetteville'],
      lessonPriceCents: 9000,
      boardTrainEligible: true,
      expiredAt: '2026-05-01T12:00:00.000Z',
    },
  ]);
});

after(async () => {
  await db.delete(staff).where(inArray(staff.id, [FED, PRIYA, GONE]));
});

const EXPECTED: TrainerWire[] = [
  { staff_id: PRIYA, name: 'Priya', board_and_train: true },
  {
    staff_id: FIXTURE_IDS.staffRachelId,
    name: 'Rachel',
    private_lesson_price_cents: 15000,
    board_and_train: true,
  },
  {
    staff_id: FIXTURE_IDS.staffShanthiId,
    name: 'Shanthi',
    private_lesson_price_cents: 20000,
    board_and_train: true,
  },
];

test(
  'a family reads Rachel ($150, B&T) and Shanthi ($200, B&T), ordered by name; Fed, Donavan, Amber and an expired staffer are absent',
  SKIP_WHEN_NO_DB,
  async () => {
    const res = await ownerApp(undefined, FIXTURE_OWNER_PRINCIPAL).inject({
      method: 'GET',
      url: '/trainers',
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as TrainerWire[];
    assert.deepEqual(body, EXPECTED);
    const names = body.map((t) => t.name);
    for (const absent of ['Fed Acosta', 'Donavan', 'Amber', 'Gone Trainer']) {
      assert.equal(names.includes(absent), false, `${absent} is listed`);
    }
  },
);

test('a staffer reads the same list', SKIP_WHEN_NO_DB, async () => {
  const res = await staffApp(undefined, FIXTURE_STAFF_PRINCIPAL).inject({
    method: 'GET',
    url: '/trainers',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), EXPECTED);
});

test('no principal → 401, on the real server', async () => {
  const app: FastifyInstance = buildApp();
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/trainers' });
    assert.equal(res.statusCode, 401, res.body);
  } finally {
    await app.close();
  }
});
