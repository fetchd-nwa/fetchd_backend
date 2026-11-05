import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { dogs, scheduledNotifications } from '../../src/db/schema/schema.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * The spay/neuter profile surface (Shanthi 2026-07-14): the POST and PATCH
 * /dogs fields, the planned-date reminder lifecycle, and the pair-coherence
 * 4xx. Moved unchanged from booking-approval-divert.test.ts when that suite was
 * deleted (P12 B5): the answer and its reminder outlive the deleted lane.
 */

// Registered BEFORE registerFixtureHooks so it runs ahead of teardownFixture:
// the fixture wipe deletes dogs by owner, and a reminder row holds an FK.
const createdDogIds: string[] = [];
after(async () => {
  if (createdDogIds.length === 0) return;
  const dogIds = [...createdDogIds];
  await db.delete(scheduledNotifications).where(inArray(scheduledNotifications.dogId, dogIds));
  await db.delete(dogs).where(inArray(dogs.id, dogIds));
});

registerFixtureHooks();

function buildApps(): { ownerApp: ReturnType<typeof makeContractApp>['app'] } {
  const owner = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(owner.app, { authenticate: owner.authenticate, now: FIXTURE_NOW });
  return { ownerApp: owner.app };
}

test(
  'POST /dogs — spay fields round-trip on the wire; planned date enqueues the reminder',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const res = await ownerApp.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `dog-spay-${randomUUID()}` },
      payload: {
        name: 'Spay Test',
        breed: 'Test Breed',
        birthdate: '2026-01-01',
        spayed_neutered: false,
        spay_neuter_planned_on: '2026-09-01',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const wire = res.json() as {
      id: string;
      spayed_neutered?: boolean;
      spay_neuter_planned_on?: string;
    };
    createdDogIds.push(wire.id);
    assert.equal(wire.spayed_neutered, false);
    assert.equal(wire.spay_neuter_planned_on, '2026-09-01');

    const [reminder] = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, `spay-neuter:${wire.id}:2026-09-01`));
    assert.ok(reminder, 'planned-date reminder enqueued');
    assert.equal(reminder!.type, 'spay-neuter-reminder');
    assert.equal(reminder!.status, 'pending');
  },
);

test(
  'PATCH /dogs/:id — a capitalised id moves the reminder rather than leaving two',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const create = await ownerApp.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `dog-spay-case-${randomUUID()}` },
      payload: {
        name: 'Spay Case',
        breed: 'Test Breed',
        birthdate: '2026-01-01',
        spayed_neutered: false,
        spay_neuter_planned_on: '2026-08-01',
      },
    });
    const dogId = (create.json() as { id: string }).id;
    createdDogIds.push(dogId);
    const capitalised = dogId.toUpperCase();
    assert.notEqual(capitalised, dogId, 'this id has no letter to capitalise');

    const move = await ownerApp.inject({
      method: 'PATCH',
      url: `/dogs/${capitalised}`,
      headers: { 'idempotency-key': `dog-spay-case2-${randomUUID()}` },
      payload: { spayed_neutered: false, spay_neuter_planned_on: '2026-10-01' },
    });
    assert.equal(move.statusCode, 200, move.body);

    const rows = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dogId, dogId));
    assert.deepEqual(rows.map((row) => [row.dedupeKey, row.status]).sort(), [
      [`spay-neuter:${dogId}:2026-08-01`, 'cancelled'],
      [`spay-neuter:${dogId}:2026-10-01`, 'pending'],
    ]);
  },
);

test(
  'PATCH /dogs/:id — moving the planned date cancels the old reminder and enqueues the new; answering "fixed" cancels + clears the date',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const create = await ownerApp.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `dog-spay2-${randomUUID()}` },
      payload: {
        name: 'Spay Move',
        breed: 'Test Breed',
        birthdate: '2026-01-01',
        spayed_neutered: false,
        spay_neuter_planned_on: '2026-08-01',
      },
    });
    const dogId = (create.json() as { id: string }).id;
    createdDogIds.push(dogId);

    // Move the date.
    const move = await ownerApp.inject({
      method: 'PATCH',
      url: `/dogs/${dogId}`,
      headers: { 'idempotency-key': `dog-spay3-${randomUUID()}` },
      payload: { spayed_neutered: false, spay_neuter_planned_on: '2026-10-01' },
    });
    assert.equal(move.statusCode, 200, move.body);

    const rows = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dogId, dogId));
    const byKey = new Map(rows.map((r) => [r.dedupeKey, r.status]));
    assert.equal(byKey.get(`spay-neuter:${dogId}:2026-08-01`), 'cancelled');
    assert.equal(byKey.get(`spay-neuter:${dogId}:2026-10-01`), 'pending');

    // Answer "fixed" — reminder cancelled, planned date cleared on the wire.
    const fixed = await ownerApp.inject({
      method: 'PATCH',
      url: `/dogs/${dogId}`,
      headers: { 'idempotency-key': `dog-spay4-${randomUUID()}` },
      payload: { spayed_neutered: true },
    });
    assert.equal(fixed.statusCode, 200, fixed.body);
    const wire = fixed.json() as { spayed_neutered?: boolean; spay_neuter_planned_on?: string };
    assert.equal(wire.spayed_neutered, true);
    assert.equal(wire.spay_neuter_planned_on, undefined);

    const after = await db
      .select()
      .from(scheduledNotifications)
      .where(
        and(eq(scheduledNotifications.dogId, dogId), eq(scheduledNotifications.status, 'pending')),
      );
    assert.equal(after.length, 0, 'no pending spay reminder survives "fixed"');
  },
);

test(
  'dogs spay-pair coherence — planned date without spayed_neutered:false → 422; revived reminder on A→B→A date dance',
  SKIP_WHEN_NO_DB,
  async () => {
    const { ownerApp } = buildApps();
    const bad = await ownerApp.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `dog-spay5-${randomUUID()}` },
      payload: {
        name: 'Spay Bad',
        breed: 'Test Breed',
        birthdate: '2026-01-01',
        spay_neuter_planned_on: '2026-09-01',
      },
    });
    assert.equal(bad.statusCode, 422, bad.body);

    // A → B → A: the A-row is revived, not lost to the dedupe collision.
    const create = await ownerApp.inject({
      method: 'POST',
      url: '/dogs',
      headers: { 'idempotency-key': `dog-spay6-${randomUUID()}` },
      payload: {
        name: 'Spay Dance',
        breed: 'Test Breed',
        birthdate: '2026-01-01',
        spayed_neutered: false,
        spay_neuter_planned_on: '2026-08-01',
      },
    });
    const dogId = (create.json() as { id: string }).id;
    createdDogIds.push(dogId);
    const patch = (date: string) =>
      ownerApp.inject({
        method: 'PATCH',
        url: `/dogs/${dogId}`,
        headers: { 'idempotency-key': `dog-spay7-${randomUUID()}` },
        payload: { spayed_neutered: false, spay_neuter_planned_on: date },
      });
    await patch('2026-10-01');
    await patch('2026-08-01');

    const rows = await db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dogId, dogId));
    const byKey = new Map(rows.map((r) => [r.dedupeKey, r.status]));
    assert.equal(byKey.get(`spay-neuter:${dogId}:2026-08-01`), 'pending', 'A-row revived');
    assert.equal(byKey.get(`spay-neuter:${dogId}:2026-10-01`), 'cancelled');
  },
);
