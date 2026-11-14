import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../src/auth/principal.js';
import type { BookingWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { bookings, dogs, refunds } from '../../src/db/schema/schema.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { registerStaffCheckinRoute } from '../../src/routes/staffCheckin.js';
import { registerStaffOwnersRoute } from '../../src/routes/staffOwners.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearPlantedPools, plantLot, poolBalance } from './_poolFixture.js';
import { at, createSession, makeClock, removeSessions, verb } from './_checkinFixture.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * The profile's *Bookings* (P21; CXL-U04; design §1.1:1076-1078, §2.3:2448-2455, :2473-2475,
 * §2.10:5069-5072; contract notes D8; s17): `GET /staff/owners/:ownerId/bookings?from=`.
 * R18, verbatim: "`GET /staff/owners/:ownerId/bookings?from=` lists only dates ≥ `from`,
 * with `can_cancel` false on a dog whose state is not `expected`". Any staff role; an owner
 * principal 403; an unknown owner 404; `from` absent or malformed 400. Only day-school and
 * day-care sessions, not cancelled, a `'payment-pending'` row included, soonest first, each
 * a staff read. s17, verbatim (design.md:2454-2455): "Fri 23 Oct 09:00 Shanthi opens Tomi's
 * profile and cancels Mon 26, Tue 27 and Wed 28 Oct; three credits come back". Tomi is the
 * fixture's owner; here a trainer does it, since any role may.
 */

registerFixtureHooks();
const createdDogs: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  await removeSessions(sessions.splice(0));
  await clearPlantedPools();
});
after(async () => {
  await removeDogs(createdDogs);
});

const FRI = '2026-10-23';
const NOW = at(FRI, '09:00');
const FAR = at('2030-01-01', '12:00');

function appAs(principal: Principal): FastifyInstance {
  const { app, authenticate } = makeContractApp(principal);
  const clock = makeClock(NOW);
  registerStaffOwnersRoute(app, { authenticate, now: clock.now });
  registerStaffBookingsRoute(app, { authenticate, now: clock.now, stripe: makeStripeStub() });
  registerStaffCheckinRoute(app, { authenticate, now: clock.now });
  return app;
}

function list(app: FastifyInstance, ownerId: string, query = `?from=${FRI}`) {
  return app.inject({ method: 'GET', url: `/staff/owners/${ownerId}/bookings${query}` });
}

function listed(res: { statusCode: number; body: string }): BookingWire[] {
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as BookingWire[];
}

async function pepper(): Promise<string> {
  const dogId = await createBookableDog(createdDogs);
  await db.update(dogs).set({ name: 'Pepper' }).where(eq(dogs.id, dogId));
  return dogId;
}

describe('R18: only dates on or after `from`, can_cancel false on a dog not expected', () => {
  test(
    'Thu 22 is before `from` and gone; Fri 23 is `from` itself and listed; a checked-in dog reads can_cancel false',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lot = await plantLot({ credits: 5, expiresAt: FAR });
      const thu = await createSession({ dogIds: [dogId], date: '2026-10-22', lotId: lot, ledger: sessions });
      const fri = await createSession({ dogIds: [dogId], date: FRI, lotId: lot, ledger: sessions });
      const mon = await createSession({ dogIds: [dogId], date: '2026-10-26', lotId: lot, ledger: sessions });
      const trainer = appAs(FIXTURE_STAFF_PRINCIPAL);
      assert.equal(
        (await verb(trainer, { bookingId: fri.bookingId, dogId, verb: 'check-in' })).statusCode,
        200,
      );
      const rows = listed(await list(trainer, FIXTURE_IDS.ownerId));
      const mine = rows.filter((r) => sessions.includes(r.id));
      assert.deepEqual(
        mine.map((r) => r.id),
        [fri.bookingId, mon.bookingId],
        `never ${thu.bookingId}, the day before`,
      );
      const friRow = mine[0]!;
      assert.equal(friRow.can_cancel, false);
      assert.equal(friRow.dog_shares?.[0]?.can_cancel, false, 'her state is in, not expected');
      assert.equal(mine[1]!.dog_shares?.[0]?.can_cancel, true);
      for (const row of rows) {
        assert.ok(['day-school', 'day-care'].includes(row.category), row.category);
        assert.notEqual(row.status, 'cancelled');
        const day = new Date(row.date).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        assert.ok(day >= FRI, `${row.id} on ${day}`);
      }
      assert.deepEqual(
        rows.map((r) => r.date),
        [...rows.map((r) => r.date)].sort(),
        'soonest first',
      );
    },
  );

  test(
    'a cancelled session is not listed; a payment-pending row is; a staff read ignores the owner switch',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const bao = await createBookableDog(createdDogs);
      const lot = await plantLot({ credits: 6, expiresAt: FAR });
      const gone = await createSession({ dogIds: [dogId], date: '2026-10-27', lotId: lot, ledger: sessions });
      await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, gone.bookingId));
      const pending = await createSession({
        dogIds: [dogId],
        date: '2026-10-28',
        status: 'payment-pending',
        ledger: sessions,
      });
      const pair = await createSession({ dogIds: [dogId, bao], date: '2026-10-29', lotId: lot, ledger: sessions });
      // The owner's one-dog switch off: her own read would say false; staff's does not.
      await db.execute(sql`UPDATE cancellation_global_settings SET per_dog_cancel_enabled = false`);
      try {
        const mine = listed(await list(appAs(FIXTURE_STAFF_PRINCIPAL), FIXTURE_IDS.ownerId)).filter((r) =>
          sessions.includes(r.id),
        );
        assert.deepEqual(
          mine.map((r) => r.id),
          [pending.bookingId, pair.bookingId],
        );
        assert.equal(mine[0]?.status, 'payment-pending');
        assert.deepEqual(
          mine[1]?.dog_shares?.map((s) => s.can_cancel),
          [true, true],
        );
      } finally {
        await db.execute(sql`UPDATE cancellation_global_settings SET per_dog_cancel_enabled = true`);
      }
    },
  );
});

describe("the route's refusals", () => {
  test('any staff role reads it; an owner principal is 403', SKIP_WHEN_NO_DB, async () => {
    for (const principal of [FIXTURE_STAFF_PRINCIPAL, FIXTURE_MANAGER_PRINCIPAL]) {
      listed(await list(appAs(principal), FIXTURE_IDS.ownerId));
    }
    const owner = await list(appAs(FIXTURE_OWNER_PRINCIPAL), FIXTURE_IDS.ownerId);
    assert.equal(owner.statusCode, 403, owner.body);
  });

  test('an unknown owner is 404; a malformed owner id is 400', SKIP_WHEN_NO_DB, async () => {
    const trainer = appAs(FIXTURE_STAFF_PRINCIPAL);
    assert.equal((await list(trainer, randomUUID())).statusCode, 404);
    assert.equal((await list(trainer, 'not-a-uuid')).statusCode, 400);
  });

  test('`from` absent, malformed or not a calendar day is 400', SKIP_WHEN_NO_DB, async () => {
    const trainer = appAs(FIXTURE_STAFF_PRINCIPAL);
    for (const query of ['', '?from=', '?from=23-10-2026', '?from=2026-02-30', `?from=${FRI}&to=${FRI}`]) {
      const res = await list(trainer, FIXTURE_IDS.ownerId, query);
      assert.equal(res.statusCode, 400, `${query}: ${res.body}`);
    }
  });

  test("a capitalised owner id is that owner (normalised before it's looked up)", SKIP_WHEN_NO_DB, async () => {
    const trainer = appAs(FIXTURE_STAFF_PRINCIPAL);
    const lower = listed(await list(trainer, FIXTURE_IDS.ownerId));
    const upper = listed(await list(trainer, FIXTURE_IDS.ownerId.toUpperCase()));
    assert.deepEqual(upper, lower);
  });
});

describe('s17 as a journey: Fri 23 Oct 09:00, three days cancelled from the list', () => {
  test(
    'a trainer lists Tomi from Fri 23 and cancels Mon 26, Tue 27 and Wed 28 one each → three 200s, three credits back, no money',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lot = await plantLot({ credits: 3, expiresAt: FAR });
      const days = ['2026-10-26', '2026-10-27', '2026-10-28'];
      for (const date of days) await createSession({ dogIds: [dogId], date, lotId: lot, ledger: sessions });
      assert.equal(await poolBalance(), 0);
      const trainer = appAs(FIXTURE_STAFF_PRINCIPAL);
      const before = listed(await list(trainer, FIXTURE_IDS.ownerId)).filter((r) => sessions.includes(r.id));
      assert.equal(before.length, 3);
      for (const row of before) {
        assert.equal(row.can_cancel, true);
        const res = await trainer.inject({
          method: 'POST',
          url: `/staff/bookings/${row.id}/cancel`,
          headers: { 'idempotency-key': `s17-${randomUUID()}` },
          payload: {},
        });
        assert.equal(res.statusCode, 200, res.body);
      }
      assert.equal(await poolBalance(), 3, 'three credits back');
      assert.deepEqual(
        listed(await list(trainer, FIXTURE_IDS.ownerId)).filter((r) => sessions.includes(r.id)),
        [],
        'the three sessions leave the list',
      );
      const moneyBack = await db.select({ id: refunds.id }).from(refunds).where(eq(refunds.ownerId, FIXTURE_IDS.ownerId));
      assert.deepEqual(moneyBack, [], 'no money');
    },
  );
});
