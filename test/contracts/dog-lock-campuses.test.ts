import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import { bookings, orders } from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, FIXTURE_LOT_EXPIRES_AT, FIXTURE_NOW, futureWeekday } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { clearPlantedPools, plantLot, waitForBlockedBackends } from './_poolFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * `withDogLocks` stays (DECISIONS 174(h), 123(c)). Capacity locks are per campus, so with
 * no dog lock two requests for one dog at two campuses both pass the overlap guard. Two
 * real connections: a third holds both campuses' capacity locks until both requests are
 * really waiting, so neither can finish before the other has started.
 */

const createdDogs: string[] = [];
after(async () => {
  await clearPlantedPools();
  await clearOrderRows();
  await removeDogs(createdDogs);
});
registerFixtureHooks();
afterEach(async () => {
  await clearPlantedPools();
  await clearOrderRows();
  await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
});

test('one dog, two campuses, one day, two connections: one booking', SKIP_WHEN_NO_DB, async () => {
  const dogId = await createBookableDog(createdDogs);
  await plantLot({ credits: 1, expiresAt: FIXTURE_LOT_EXPIRES_AT, location: 'fayetteville' });
  await plantLot({ credits: 1, expiresAt: FIXTURE_LOT_EXPIRES_AT, location: 'bentonville' });
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(app, { authenticate, stripe: makeStripeStub(), now: FIXTURE_NOW });
  const date = futureWeekday(0);
  const book = (location: string) =>
    app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': `dog-lock-${randomUUID()}` },
      payload: {
        category: 'day-school',
        lead_dog_id: dogId,
        dates: [date],
        location,
        payment: { kind: 'credits' },
      },
    });

  const gate = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await gate.connect();
  try {
    await gate.query('BEGIN');
    for (const campus of ['bentonville', 'fayetteville']) {
      await gate.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `capacity:${campus}:${date}`,
      ]);
    }
    const answers = Promise.all([book('fayetteville'), book('bentonville')]);
    await waitForBlockedBackends(2);
    await gate.query('COMMIT');

    const [first, second] = await answers;
    const codes = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(codes, [201, 422], `${first.body} ${second.body}`);
    const refused = first.statusCode === 422 ? first : second;
    assert.equal(refused.json().error.code, 'already_booked');
    const rows = await db.select().from(bookings).where(eq(bookings.leadDogId, dogId));
    assert.equal(rows.length, 1, 'one booking');
  } finally {
    await gate.query('ROLLBACK').catch(() => undefined);
    await gate.end();
  }
});
