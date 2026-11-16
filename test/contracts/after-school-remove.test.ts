import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { Principal } from '../../src/auth/principal.js';
import type { BookingWire, DayCapacityWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  bookings,
  dogs,
  idempotencyKeys,
  orders,
  owners,
} from '../../src/db/schema/schema.js';
import { redis } from '../../src/redis.js';
import { registerAvailabilityRoute } from '../../src/routes/availability.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { registerStaffCheckinRoute } from '../../src/routes/staffCheckin.js';
import {
  at,
  createSession,
  makeClock,
  ownerCancel,
  ownerDogCancel,
  refusal,
  removeSessions,
  verb,
  type Clock,
} from './_checkinFixture.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import {
  clearPlantedPools,
  plantLot,
  poolBalance,
  waitForBlockedBackends,
} from './_poolFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * P48 (wire 6.2.0; build DECISIONS 407, 408(c); her words: "i should be able to go into
 * each booking and unselect the after school training if i want"):
 * `POST /bookings/:id/dogs/:dogId/after-school/remove`, owner, no body, Idempotency-Key.
 * It sets that dog's share `after_school` false and answers 200 `BookingWire`; it moves no
 * credit and no money; it refuses in the wire's order (the one-dog cancel's refusals,
 * without `cxl.per_dog_cancel_enabled`); it takes the dog lock every booking write takes
 * (DECISIONS 123(c)) and the date's `(location, date)` lock the after-school count is
 * taken under; and `dog_shares[].can_remove_after_school` says on every owner read whether
 * it would be accepted now.
 *
 * The Parks' Thu 10 Dec 2026 at Bentonville, day school: Pepper (the lead) stays for
 * after-school, her sister Bao does not. The clock is Wed 9 Dec 19:00 unless moved.
 */

registerFixtureHooks();
const createdDogs: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  await db.execute(sql`UPDATE cancellation_global_settings SET per_dog_cancel_enabled = true`);
  await removeSessions(sessions.splice(0));
  await clearOrderRows();
  await clearPlantedPools();
  await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
});
after(async () => {
  await removeDogs(createdDogs);
});

const TH = '2026-12-10';
const EVE = at('2026-12-09', '19:00');
const LOT_EXPIRES = at('2027-09-01', '12:00');

async function named(name: string): Promise<string> {
  const dogId = await createBookableDog(createdDogs);
  await db.update(dogs).set({ name }).where(eq(dogs.id, dogId));
  return dogId;
}

/** Flag these shares of a session as staying for after-school. */
async function staying(bookingId: string, dogIds: readonly string[]): Promise<void> {
  for (const dogId of dogIds) {
    await db
      .update(bookingDogs)
      .set({ afterSchool: true })
      .where(and(eq(bookingDogs.bookingId, bookingId), eq(bookingDogs.dogId, dogId)));
  }
}

interface Parks {
  pepper: string;
  bao: string;
  bookingId: string;
}

/** Pepper (lead, staying) and Bao (not staying), each debited from her own planted lot. */
async function parks(
  args: {
    date?: string;
    category?: 'day-school' | 'day-care';
    status?: 'upcoming' | 'payment-pending';
  } = {},
): Promise<Parks> {
  const pepper = await named('Pepper');
  const bao = await named('Bao');
  const pending = args.status === 'payment-pending';
  const lots = pending
    ? undefined
    : [
        await plantLot({
          credits: 2,
          expiresAt: LOT_EXPIRES,
          ...(args.category === 'day-care' ? { mode: 'daycare' as const } : {}),
        }),
        await plantLot({
          credits: 2,
          expiresAt: LOT_EXPIRES,
          ...(args.category === 'day-care' ? { mode: 'daycare' as const } : {}),
        }),
      ];
  const { bookingId } = await createSession({
    dogIds: [pepper, bao],
    date: args.date ?? TH,
    ...(lots !== undefined ? { lots } : {}),
    ...(args.category !== undefined ? { category: args.category } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ledger: sessions,
  });
  if (args.category !== 'day-care') await staying(bookingId, [pepper]);
  return { pepper, bao, bookingId };
}

function remove(app: FastifyInstance, args: { bookingId: string; dogId: string; key?: string }) {
  return app.inject({
    method: 'POST',
    url: `/bookings/${args.bookingId}/dogs/${args.dogId}/after-school/remove`,
    headers: { 'idempotency-key': args.key ?? `p48-remove-${randomUUID()}` },
  });
}

function wire(res: { statusCode: number; body: string }): BookingWire {
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as BookingWire;
}

function share(w: BookingWire, dogId: string) {
  const found = w.dog_shares?.find((s) => s.dog_id === dogId);
  assert.ok(found !== undefined, `dog ${dogId} has a share on ${w.id}`);
  return found;
}

/** The share as the table holds it; `xmin` moves on any write to the row, a no-op `UPDATE` too. */
async function shareRow(bookingId: string, dogId: string) {
  const { rows } = await db.execute(sql`
    SELECT xmin::text AS xmin, after_school AS "afterSchool", expired_at AS "expiredAt"
      FROM booking_dogs WHERE booking_id = ${bookingId} AND dog_id = ${dogId}`);
  return rows[0] as { xmin: string; afterSchool: boolean; expiredAt: string | null };
}

/**
 * Every credit and money table, whole: its row count, and a digest of every row's every
 * column in a stable order, so a changed balance, a new lot, an edited charge or a touched
 * timestamp all differ. Plus the owner's Bentonville school balance as the view reads it.
 */
const MONEY_TABLES = [
  'credit_ledger',
  'credit_lot_expiry_edits',
  'orders',
  'charges',
  'invoices',
  'refunds',
  'payment_methods',
  'stripe_customers',
  'stripe_events',
] as const;

async function moneyFootprint(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const table of MONEY_TABLES) {
    const { rows } = await db.execute(
      sql.raw(
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM ${table} t`,
      ),
    );
    out[table] = rows[0];
  }
  const { rows } = await db.execute(
    sql`SELECT coalesce(sum(delta), 0)::int AS sum FROM credit_ledger WHERE owner_id = ${FIXTURE_IDS.ownerId}`,
  );
  out.ledgerSum = rows[0];
  out.balance = await poolBalance();
  return out;
}

/** Live client dogs staying for TH's after-school at Bentonville, as the table holds them. */
async function stayingOnTh(): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT count(*)::int AS n FROM booking_dogs bd JOIN bookings b ON b.id = bd.booking_id
     WHERE b.location = 'bentonville' AND b.status <> 'cancelled' AND b.expired_at IS NULL
       AND (b.scheduled_at AT TIME ZONE 'America/Chicago')::date = ${TH}::date
       AND bd.expired_at IS NULL AND bd.after_school`);
  return (rows[0] as { n: number }).n;
}

async function thPlaces(): Promise<DayCapacityWire> {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerAvailabilityRoute(app, { authenticate });
  const res = await app.inject({
    method: 'GET',
    url: `/availability?from=${TH}&to=${TH}&location=bentonville`,
  });
  assert.equal(res.statusCode, 200, res.body);
  const [day] = res.json<DayCapacityWire[]>();
  assert.ok(day !== undefined);
  return day;
}

/** A booking for one new dog ticking TH's after-school, through `POST /bookings`. */
async function bookStaying(app: FastifyInstance, dogId: string) {
  return app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `p48-book-${randomUUID()}` },
    payload: {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [TH],
      location: 'bentonville',
      payment: { kind: 'credits' },
      after_school: { [dogId]: [TH] },
    },
  });
}

/** TH full: four more dogs staying beside Pepper (Bentonville takes 5). */
async function fillTh(): Promise<void> {
  const four: string[] = [];
  for (let i = 0; i < 4; i += 1) four.push(await createBookableDog(createdDogs));
  const { bookingId } = await createSession({ dogIds: four, date: TH, ledger: sessions });
  await staying(bookingId, four);
}

/** The booking routes, the staff booking routes and the board, on one clock and one Stripe stub. */
function routesFor(principal: Principal, clock: Clock, stripe: StripeStub): FastifyInstance {
  const { app, authenticate } = makeContractApp(principal);
  registerBookingsRoute(app, { authenticate, now: clock.now, stripe });
  registerStaffBookingsRoute(app, { authenticate, now: clock.now, stripe });
  registerStaffCheckinRoute(app, { authenticate, now: clock.now });
  return app;
}

function apps(clock: Clock = makeClock(EVE)) {
  const stripe = makeStripeStub();
  return {
    owner: routesFor(FIXTURE_OWNER_PRINCIPAL, clock, stripe),
    staff: routesFor(FIXTURE_STAFF_PRINCIPAL, clock, stripe),
    stripe,
    clock,
  };
}

describe('the removal', () => {
  test(
    "Pepper's after-school taken off → 200: her share false and her seat kept, TH's places 0 → 1 and a second booking takes the place; no credit or money row changed, no Stripe call",
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner, stripe } = apps();
      const p = await parks();
      await fillTh();
      assert.equal((await thPlaces()).after_school_remaining, 0, 'full before');
      const before = await moneyFootprint();

      const after = wire(await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }));
      assert.equal(after.id, p.bookingId);
      assert.equal(after.status, 'upcoming');
      assert.equal(after.dog_id, p.pepper, 'her day-school seat is untouched');
      assert.deepEqual(after.additional_dog_ids, [p.bao]);
      assert.equal(share(after, p.pepper).after_school, false);
      assert.equal(share(after, p.pepper).can_remove_after_school, false);
      assert.equal(share(after, p.pepper).can_cancel, true, 'she can still cancel her day');
      assert.equal(share(after, p.bao).after_school, false);
      assert.equal((await shareRow(p.bookingId, p.pepper)).afterSchool, false, 'stored');

      assert.deepEqual(await moneyFootprint(), before, 'no credit or money row changed');
      assert.deepEqual(stripe.calls, [], 'no Stripe call');
      const places = await thPlaces();
      assert.equal(places.after_school_remaining, 1, 'her place is free at once');
      assert.equal(places.remaining_dogs, 15 - 6, 'and her seat is not');

      // A second family dog takes that place.
      const scout = await createBookableDog(createdDogs);
      await plantLot({ credits: 1, expiresAt: LOT_EXPIRES });
      const taken = await bookStaying(owner, scout);
      assert.equal(taken.statusCode, 201, taken.body);
      assert.equal((await thPlaces()).after_school_remaining, 0);
      assert.equal(await stayingOnTh(), 5);
    },
  );

  test(
    'the read after it agrees: GET /bookings/:id names her share false',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const p = await parks();
      const answered = wire(await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }));
      const read = wire(await owner.inject({ method: 'GET', url: `/bookings/${p.bookingId}` }));
      assert.deepEqual(answered, read);
    },
  );

  test(
    'a share already off → 200 with the session unchanged, and no write to the share',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const p = await parks();
      const row = await shareRow(p.bookingId, p.bao);
      const answered = wire(await remove(owner, { bookingId: p.bookingId, dogId: p.bao }));
      const read = wire(await owner.inject({ method: 'GET', url: `/bookings/${p.bookingId}` }));
      assert.deepEqual(answered, read, 'the session as it stands');
      assert.equal(share(answered, p.pepper).after_school, true, "Pepper's untouched");
      assert.deepEqual(await shareRow(p.bookingId, p.bao), row, 'no write');
    },
  );

  test(
    'taking Pepper off leaves her sister staying: Bao, also opted in, stays opted in; the date frees exactly one place',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const p = await parks();
      await staying(p.bookingId, [p.bao]);
      const before = (await thPlaces()).after_school_remaining ?? 0;
      const after = wire(await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }));
      assert.equal(share(after, p.pepper).after_school, false);
      assert.equal(
        share(after, p.bao).after_school,
        true,
        "her sister's after-school is untouched",
      );
      assert.equal(share(after, p.bao).can_remove_after_school, true);
      assert.equal((await shareRow(p.bookingId, p.bao)).afterSchool, true, 'stored');
      assert.equal(
        (await thPlaces()).after_school_remaining,
        before + 1,
        'exactly one place freed',
      );
    },
  );

  test('invalidates avail:bentonville:* and only that campus', SKIP_WHEN_NO_DB, async () => {
    const { owner } = apps();
    const p = await parks();
    await redis.set('avail:bentonville:p48-probe', '[]');
    await redis.set('avail:fayetteville:p48-probe', '[]');
    try {
      wire(await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }));
      assert.equal(await redis.exists('avail:bentonville:p48-probe'), 0);
      assert.equal(await redis.exists('avail:fayetteville:p48-probe'), 1);
    } finally {
      await redis.del('avail:bentonville:p48-probe', 'avail:fayetteville:p48-probe');
    }
  });

  test(
    'cxl.per_dog_cancel_enabled does not govern it: switched off, the removal → 200',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const p = await parks();
      await db.execute(sql`UPDATE cancellation_global_settings SET per_dog_cancel_enabled = false`);
      const after = wire(await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }));
      assert.equal(share(after, p.pepper).after_school, false);
      assert.equal(share(after, p.pepper).can_cancel, false, 'the switch still governs the cancel');
    },
  );
});

describe('a day-school row with no campus (build DECISIONS 428)', () => {
  test(
    'schema-legal though no route writes one: the read says true, and the removal answers 200 with her share false (no campus, no date lock to take)',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const pepper = await named('Pepper');
      const id = randomUUID();
      sessions.push(id);
      await db.insert(bookings).values({
        id,
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: pepper,
        category: 'day-school',
        scheduledAt: at(TH, '07:30').toISOString(),
      });
      await db
        .insert(bookingDogs)
        .values({ bookingId: id, dogId: pepper, isLead: true, afterSchool: true });
      const read = wire(await owner.inject({ method: 'GET', url: `/bookings/${id}` }));
      assert.equal(read.location, undefined, 'no campus');
      assert.equal(share(read, pepper).can_remove_after_school, true);

      const after = wire(await remove(owner, { bookingId: id, dogId: pepper }));
      assert.equal(share(after, pepper).after_school, false);
      assert.equal(share(after, pepper).can_remove_after_school, false);
      assert.equal((await shareRow(id, pepper)).afterSchool, false, 'stored');
    },
  );
});

describe('idempotency (DECISIONS 128(a)): the claim first, the clock after it', () => {
  test(
    'answered 200 at 17:29 on the day, the same key at 17:31 replays the stored 200, never session_ended, and writes nothing twice',
    SKIP_WHEN_NO_DB,
    async () => {
      const clock = makeClock(at(TH, '17:29'));
      const { owner } = apps(clock);
      const p = await parks();
      const key = `p48-replay-${randomUUID()}`;
      const first = wire(await remove(owner, { bookingId: p.bookingId, dogId: p.pepper, key }));
      const written = await shareRow(p.bookingId, p.pepper);
      clock.set(at(TH, '17:31'));
      const replay = wire(await remove(owner, { bookingId: p.bookingId, dogId: p.pepper, key }));
      assert.deepEqual(replay, first, 'the stored 200');
      assert.deepEqual(await shareRow(p.bookingId, p.pepper), written, 'no second write');
      // A new key meets the clock.
      refusal(
        await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }),
        409,
        'session_ended',
      );
    },
  );
});

describe('the refusals, in the wire order', () => {
  test('a staff principal → 403 forbidden', SKIP_WHEN_NO_DB, async () => {
    const { staff } = apps();
    const p = await parks();
    refusal(await remove(staff, { bookingId: p.bookingId, dogId: p.pepper }), 403, 'forbidden');
    assert.equal((await shareRow(p.bookingId, p.pepper)).afterSchool, true);
  });

  test(
    '404 not_found: no such booking, a dog never on it, an expired booking, and another family’s booking',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const p = await parks();
      const stranger = await named('Stranger');
      refusal(await remove(owner, { bookingId: randomUUID(), dogId: p.pepper }), 404, 'not_found');
      refusal(await remove(owner, { bookingId: p.bookingId, dogId: stranger }), 404, 'not_found');

      const gone = await parks();
      await db
        .update(bookings)
        .set({ expiredAt: at('2026-12-01', '12:00').toISOString() })
        .where(eq(bookings.id, gone.bookingId));
      refusal(
        await remove(owner, { bookingId: gone.bookingId, dogId: gone.pepper }),
        404,
        'not_found',
      );

      // Another family: a real owner row (the idempotency claim names her), not hers.
      const otherOwnerId = randomUUID();
      await db.insert(owners).values({
        id: otherOwnerId,
        supabaseUid: randomUUID(),
        name: 'Someone Else',
        email: `someone-else-${otherOwnerId}@example.test`,
        phone: '555-0100',
        location: 'bentonville',
      });
      try {
        const other: Principal = {
          kind: 'owner',
          ownerId: otherOwnerId,
          supabaseUid: randomUUID(),
        };
        const otherApp = routesFor(other, makeClock(EVE), makeStripeStub());
        refusal(
          await remove(otherApp, { bookingId: p.bookingId, dogId: p.pepper }),
          404,
          'not_found',
        );
      } finally {
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.ownerId, otherOwnerId));
        await db.delete(owners).where(eq(owners.id, otherOwnerId));
      }
      assert.equal((await shareRow(p.bookingId, p.pepper)).afterSchool, true, 'nothing written');
    },
  );

  test(
    '422 invalid_payload: a day-care session and a private lesson (after-school rides day school only); a dog never on a day-care session is 404 first',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const care = await parks({ category: 'day-care' });
      refusal(
        await remove(owner, { bookingId: care.bookingId, dogId: care.pepper }),
        422,
        'invalid_payload',
      );
      const stranger = await named('Stranger');
      refusal(
        await remove(owner, { bookingId: care.bookingId, dogId: stranger }),
        404,
        'not_found',
      );

      const pip = await named('Pip');
      const lesson = randomUUID();
      sessions.push(lesson);
      await db.insert(bookings).values({
        id: lesson,
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: pip,
        category: 'private-lesson',
        scheduledAt: at(TH, '10:00').toISOString(),
        location: 'bentonville',
      });
      await db.insert(bookingDogs).values({ bookingId: lesson, dogId: pip, isLead: true });
      refusal(await remove(owner, { bookingId: lesson, dogId: pip }), 422, 'invalid_payload');
    },
  );

  test(
    '409 session_cancelled: her share cancelled alone, and the whole session cancelled; nothing written',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const alone = await parks();
      wire(await ownerDogCancel(owner, { bookingId: alone.bookingId, dogId: alone.pepper }));
      const row = await shareRow(alone.bookingId, alone.pepper);
      refusal(
        await remove(owner, { bookingId: alone.bookingId, dogId: alone.pepper }),
        409,
        'session_cancelled',
      );
      assert.deepEqual(await shareRow(alone.bookingId, alone.pepper), row);

      const whole = await parks();
      wire(await ownerCancel(owner, { bookingId: whole.bookingId }));
      refusal(
        await remove(owner, { bookingId: whole.bookingId, dogId: whole.pepper }),
        409,
        'session_cancelled',
      );
      assert.equal((await shareRow(whole.bookingId, whole.pepper)).afterSchool, true);
    },
  );

  test('409 payment_pending: a top-up row waiting on its charge', SKIP_WHEN_NO_DB, async () => {
    const { owner } = apps();
    const p = await parks({ status: 'payment-pending' });
    refusal(
      await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }),
      409,
      'payment_pending',
    );
    assert.equal((await shareRow(p.bookingId, p.pepper)).afterSchool, true);
  });

  test(
    "409 session_ended: at the campus's pickup close (17:30) and after",
    SKIP_WHEN_NO_DB,
    async () => {
      const clock = makeClock(at(TH, '17:30'));
      const { owner } = apps(clock);
      const p = await parks();
      const details = refusal(
        await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }),
        409,
        'session_ended',
      );
      assert.deepEqual(details, { kind: 'session_ended', date: TH });
      clock.set(at('2026-12-11', '09:00'));
      refusal(
        await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }),
        409,
        'session_ended',
      );
      assert.equal((await shareRow(p.bookingId, p.pepper)).afterSchool, true);
    },
  );

  test(
    "409 session_checked_in while HER folded state is not expected; an undone check-in, or her sister's check-in, does not block",
    SKIP_WHEN_NO_DB,
    async () => {
      const clock = makeClock(at(TH, '07:40'));
      const { owner, staff } = apps(clock);
      const p = await parks();
      assert.equal(
        (await verb(staff, { bookingId: p.bookingId, dogId: p.pepper, verb: 'check-in' }))
          .statusCode,
        200,
      );
      clock.set(at(TH, '08:00'));
      refusal(
        await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }),
        409,
        'session_checked_in',
      );
      assert.equal((await shareRow(p.bookingId, p.pepper)).afterSchool, true);

      assert.equal(
        (await verb(staff, { bookingId: p.bookingId, dogId: p.pepper, verb: 'undo' })).statusCode,
        200,
      );
      assert.equal(
        (await verb(staff, { bookingId: p.bookingId, dogId: p.bao, verb: 'check-in' })).statusCode,
        200,
      );
      const after = wire(await remove(owner, { bookingId: p.bookingId, dogId: p.pepper }));
      assert.equal(share(after, p.pepper).after_school, false);
    },
  );

  test(
    'the order where two apply: cancelled before pending, cancelled before ended, pending before ended, ended before checked in',
    SKIP_WHEN_NO_DB,
    async () => {
      const clock = makeClock(EVE);
      const { owner, staff } = apps(clock);

      // A pending row whose share was cancelled alone: session_cancelled first.
      const pendingAlone = await parks({ status: 'payment-pending' });
      await db
        .update(bookingDogs)
        .set({ expiredAt: EVE.toISOString() })
        .where(
          and(
            eq(bookingDogs.bookingId, pendingAlone.bookingId),
            eq(bookingDogs.dogId, pendingAlone.pepper),
          ),
        );

      const cancelled = await parks();
      wire(await ownerCancel(owner, { bookingId: cancelled.bookingId }));
      const pending = await parks({ status: 'payment-pending' });
      const checkedIn = await parks();
      clock.set(at(TH, '07:40'));
      assert.equal(
        (
          await verb(staff, {
            bookingId: checkedIn.bookingId,
            dogId: checkedIn.pepper,
            verb: 'check-in',
          })
        ).statusCode,
        200,
      );

      refusal(
        await remove(owner, { bookingId: pendingAlone.bookingId, dogId: pendingAlone.pepper }),
        409,
        'session_cancelled',
      );
      clock.set(at(TH, '17:45'));
      refusal(
        await remove(owner, { bookingId: cancelled.bookingId, dogId: cancelled.pepper }),
        409,
        'session_cancelled',
      );
      refusal(
        await remove(owner, { bookingId: pending.bookingId, dogId: pending.pepper }),
        409,
        'payment_pending',
      );
      refusal(
        await remove(owner, { bookingId: checkedIn.bookingId, dogId: checkedIn.pepper }),
        409,
        'session_ended',
      );
    },
  );

  test(
    'a share already off is refused like any other once a refusal applies (the refusals run first): ended → 409 session_ended',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps(makeClock(at(TH, '17:30')));
      const p = await parks();
      refusal(await remove(owner, { bookingId: p.bookingId, dogId: p.bao }), 409, 'session_ended');
    },
  );
});

describe('the locks', () => {
  /** A third connection holding one lock until `release`; releasing twice is a no-op. */
  async function pgGate(
    lockSql: string,
    params: unknown[],
  ): Promise<{ release: () => Promise<void> }> {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('BEGIN');
    await client.query(lockSql, params);
    let open = true;
    return {
      release: async () => {
        if (!open) return;
        open = false;
        await client.query('COMMIT').catch(() => undefined);
        await client.end();
      },
    };
  }
  /** One advisory key: a dog's (`dog:<id>`) or a date's (`capacity:<campus>:<date>`). */
  const gate = (key: string) => pgGate('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  /** The booking row, as `bookingsRepository.lockById` takes it. */
  const rowGate = (bookingId: string) =>
    pgGate('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);

  type Answer = { statusCode: number; body: string };

  /**
   * Fire `first` and see it queue on the held lock, then `second` and see it queue behind,
   * then release: the two take the lock in that order (build DECISIONS 428).
   */
  async function inOrder(
    held: { release: () => Promise<void> },
    first: () => Promise<Answer>,
    second: () => Promise<Answer>,
  ): Promise<[Answer, Answer]> {
    const fired: Promise<Answer>[] = [];
    try {
      fired.push(first());
      await waitForBlockedBackends(1);
      fired.push(second());
      await waitForBlockedBackends(2);
      await held.release();
      return (await Promise.all(fired)) as [Answer, Answer];
    } finally {
      await held.release();
      // a failed wait must not leave a request writing under the next test's cleanup
      await Promise.allSettled(fired);
    }
  }

  test(
    "DECISIONS 123(c): the removal takes the dog's lock: held by another connection, the removal waits for it, then answers 200",
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const p = await parks();
      const held = await gate(`dog:${p.pepper}`);
      const answers: Promise<Answer>[] = [];
      try {
        const answer = remove(owner, { bookingId: p.bookingId, dogId: p.pepper });
        answers.push(answer);
        await waitForBlockedBackends(1);
        assert.equal(
          (await shareRow(p.bookingId, p.pepper)).afterSchool,
          true,
          'not written while it waits',
        );
        await held.release();
        assert.equal(share(wire(await answer), p.pepper).after_school, false);
      } finally {
        await held.release();
        // a failed wait must not leave a request writing under the next test's cleanup
        await Promise.allSettled(answers);
      }
    },
  );

  for (const order of ['removal first', 'bookings first'] as const) {
    test(
      `the last place, three connections (${order}): Pepper's removal and two bookings ticking TH queue on the date's lock; never more than 5 staying, and a booking wins only the place the removal freed`,
      SKIP_WHEN_NO_DB,
      async () => {
        const { owner } = apps();
        const p = await parks();
        await fillTh();
        assert.equal(await stayingOnTh(), 5);
        const [scout, rex] = [
          await createBookableDog(createdDogs),
          await createBookableDog(createdDogs),
        ];
        await plantLot({ credits: 2, expiresAt: LOT_EXPIRES });

        const held = await gate(`capacity:bentonville:${TH}`);
        const answers: Promise<Answer>[] = [];
        try {
          const fire = {
            removal: () => remove(owner, { bookingId: p.bookingId, dogId: p.pepper }),
            scout: () => bookStaying(owner, scout),
            rex: () => bookStaying(owner, rex),
          };
          const sequence =
            order === 'removal first'
              ? [fire.removal, fire.scout, fire.rex]
              : [fire.scout, fire.rex, fire.removal];
          for (const start of sequence) {
            answers.push(start());
            // Each queues on the held date lock before the next is sent.
            await waitForBlockedBackends(answers.length);
          }
          await held.release();
          const settled = await Promise.all(answers);
          const removal = settled[order === 'removal first' ? 0 : 2]!;
          const booked = settled.filter((r) => r !== removal);
          assert.equal(removal.statusCode, 200, removal.body);
          const won = booked.filter((r) => r.statusCode === 201).length;
          for (const r of booked) {
            if (r.statusCode !== 201) refusal(r, 422, 'after_school_full');
          }
          assert.ok(
            won <= 1,
            `at most the one freed place is taken: ${booked.map((r) => r.body).join(' | ')}`,
          );
          assert.equal(await stayingOnTh(), 4 + won, 'never more than 5');
          if (order === 'removal first') assert.equal(won, 1, 'the place she freed is taken');
          else assert.equal(won, 0, 'both bookings counted 5 before she left');
        } finally {
          await held.release();
          // a failed wait must not leave a request writing under the next test's cleanup
          await Promise.allSettled(answers);
        }
      },
    );
  }
  // build DECISIONS 428: the booking row lock orders a removal against a check-in
  // and against a cancel of the same session. Each answer is the one the later request
  // would give after the earlier one committed.
  for (const order of ['check-in first', 'removal first'] as const) {
    test(
      `the booking row lock, removal against her check-in at 07:40: ${order}`,
      SKIP_WHEN_NO_DB,
      async () => {
        const clock = makeClock(at(TH, '07:40'));
        const { owner, staff } = apps(clock);
        const p = await parks();
        const fireRem = () => remove(owner, { bookingId: p.bookingId, dogId: p.pepper });
        const fireChk = () =>
          verb(staff, { bookingId: p.bookingId, dogId: p.pepper, verb: 'check-in' });
        const held = await rowGate(p.bookingId);
        const [rem, chk] =
          order === 'check-in first'
            ? (await inOrder(held, fireChk, fireRem)).reverse()
            : await inOrder(held, fireRem, fireChk);
        const row = await shareRow(p.bookingId, p.pepper);
        assert.equal(chk!.statusCode, 200, chk!.body);
        if (order === 'check-in first') {
          refusal(rem!, 409, 'session_checked_in');
          assert.equal(row.afterSchool, true, 'a checked-in dog keeps her after-school');
        } else {
          assert.equal(rem!.statusCode, 200, rem!.body);
          assert.equal(row.afterSchool, false);
        }
      },
    );
  }

  for (const order of ['cancel first', 'removal first'] as const) {
    test(
      `the booking row lock, removal against her one-dog cancel: ${order}`,
      SKIP_WHEN_NO_DB,
      async () => {
        const { owner } = apps();
        const p = await parks();
        const bal0 = await poolBalance();
        const fireRem = () => remove(owner, { bookingId: p.bookingId, dogId: p.pepper });
        const fireCan = () => ownerDogCancel(owner, { bookingId: p.bookingId, dogId: p.pepper });
        const held = await rowGate(p.bookingId);
        const [rem, can] =
          order === 'cancel first'
            ? (await inOrder(held, fireCan, fireRem)).reverse()
            : await inOrder(held, fireRem, fireCan);
        assert.equal(can!.statusCode, 200, can!.body);
        assert.equal(
          (await poolBalance()) - bal0,
          1,
          'exactly her one credit back, from the cancel alone',
        );
        assert.equal(await stayingOnTh(), 0);
        if (order === 'cancel first') refusal(rem!, 409, 'session_cancelled');
        else assert.equal(rem!.statusCode, 200, rem!.body);
      },
    );
  }

  test(
    'the booking row lock, the whole-session cancel first, then the removal',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const p = await parks();
      const bal0 = await poolBalance();
      const held = await rowGate(p.bookingId);
      const [can, rem] = await inOrder(
        held,
        () => ownerCancel(owner, { bookingId: p.bookingId }),
        () => remove(owner, { bookingId: p.bookingId, dogId: p.pepper }),
      );
      assert.equal(can.statusCode, 200, can.body);
      refusal(rem, 409, 'session_cancelled');
      assert.equal((await poolBalance()) - bal0, 2, 'both credits back, as the cancel alone gives');
    },
  );
});

describe('BookingWire.dog_shares[].can_remove_after_school', () => {
  test(
    'true on an upcoming, expected, opted-in share and false on her sister not staying, on every owner read: GET /bookings, /bookings/:id, /bookings/up-next, /dogs/:id/bookings',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const p = await parks();
      const flags = (w: BookingWire | undefined) =>
        Object.fromEntries((w?.dog_shares ?? []).map((s) => [s.dog_id, s.can_remove_after_school]));
      const expected = { [p.pepper]: true, [p.bao]: false };

      const list = (await owner.inject({ method: 'GET', url: '/bookings?view=upcoming' })).json<
        BookingWire[]
      >();
      assert.deepEqual(flags(list.find((b) => b.id === p.bookingId)), expected, 'GET /bookings');
      assert.deepEqual(
        flags(wire(await owner.inject({ method: 'GET', url: `/bookings/${p.bookingId}` }))),
        expected,
        'GET /bookings/:id',
      );
      // The fixture's open-ended boarding stay (no pickup) is always up next: end it for
      // this read, and put it back.
      await db
        .update(bookings)
        .set({ pickupAt: '2026-07-06T13:00:00Z' })
        .where(eq(bookings.id, FIXTURE_IDS.booking5Id));
      try {
        const upNext = (
          await owner.inject({ method: 'GET', url: '/bookings/up-next' })
        ).json<BookingWire | null>();
        assert.equal(upNext?.id, p.bookingId);
        assert.deepEqual(flags(upNext ?? undefined), expected, 'GET /bookings/up-next');
      } finally {
        await db
          .update(bookings)
          .set({ pickupAt: null })
          .where(eq(bookings.id, FIXTURE_IDS.booking5Id));
      }
      const byDog = (
        await owner.inject({ method: 'GET', url: `/dogs/${p.pepper}/bookings?view=upcoming` })
      ).json<BookingWire[]>();
      assert.deepEqual(
        flags(byDog.find((b) => b.id === p.bookingId)),
        expected,
        'GET /dogs/:id/bookings',
      );
    },
  );

  test(
    'false when off, checked in, cancelled alone, the session cancelled, payment-pending, or ended; false on a staff read; absent on a day-care share',
    SKIP_WHEN_NO_DB,
    async () => {
      const clock = makeClock(EVE);
      const { owner, staff } = apps(clock);
      const read = async (bookingId: string) =>
        wire(await owner.inject({ method: 'GET', url: `/bookings/${bookingId}` }));

      const off = await parks();
      wire(await remove(owner, { bookingId: off.bookingId, dogId: off.pepper }));
      assert.equal(
        share(await read(off.bookingId), off.pepper).can_remove_after_school,
        false,
        'off',
      );

      const alone = await parks();
      wire(await ownerDogCancel(owner, { bookingId: alone.bookingId, dogId: alone.pepper }));
      assert.equal(
        share(await read(alone.bookingId), alone.pepper).can_remove_after_school,
        false,
        'cancelled alone',
      );

      const pending = await parks({ status: 'payment-pending' });
      assert.equal(
        share(await read(pending.bookingId), pending.pepper).can_remove_after_school,
        false,
        'payment-pending',
      );

      const staffRead = await parks();
      const queue = (
        await staff.inject({
          method: 'GET',
          url: `/staff/bookings?from=${TH}&to=${TH}&location=bentonville`,
        })
      ).json<BookingWire[]>();
      const row = queue.find((b) => b.id === staffRead.bookingId);
      assert.ok(row !== undefined);
      assert.equal(share(row, staffRead.pepper).after_school, true);
      assert.equal(share(row, staffRead.pepper).can_remove_after_school, false, 'a staff read');
      assert.equal(
        share(await read(staffRead.bookingId), staffRead.pepper).can_remove_after_school,
        true,
        'the owner reads true',
      );

      const care = await parks({ category: 'day-care' });
      for (const s of (await read(care.bookingId)).dog_shares ?? []) {
        assert.equal('can_remove_after_school' in s, false, 'a day-care share has no after-school');
      }

      const whole = await parks();
      wire(await ownerCancel(owner, { bookingId: whole.bookingId }));
      assert.equal(
        share(await read(whole.bookingId), whole.pepper).can_remove_after_school,
        false,
        'session cancelled',
      );

      const checkedIn = await parks();
      clock.set(at(TH, '07:40'));
      await verb(staff, {
        bookingId: checkedIn.bookingId,
        dogId: checkedIn.pepper,
        verb: 'check-in',
      });
      assert.equal(
        share(await read(checkedIn.bookingId), checkedIn.pepper).can_remove_after_school,
        false,
        'checked in',
      );
      assert.equal(
        share(await read(staffRead.bookingId), staffRead.pepper).can_remove_after_school,
        true,
        'still expected at 07:40',
      );

      clock.set(at(TH, '17:30'));
      assert.equal(
        share(await read(staffRead.bookingId), staffRead.pepper).can_remove_after_school,
        false,
        'ended',
      );
    },
  );

  test(
    'cxl.per_dog_cancel_enabled off: can_cancel false, can_remove_after_school still true',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const p = await parks();
      await db.execute(sql`UPDATE cancellation_global_settings SET per_dog_cancel_enabled = false`);
      const read = wire(await owner.inject({ method: 'GET', url: `/bookings/${p.bookingId}` }));
      assert.equal(share(read, p.pepper).can_cancel, false);
      assert.equal(share(read, p.pepper).can_remove_after_school, true);
    },
  );

  test(
    'a dog staying on Thursday and not on Friday reads true on Thursday only, in one list read',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const pepper = await named('Pepper');
      const thu = await createSession({ dogIds: [pepper], date: TH, ledger: sessions });
      const fri = await createSession({ dogIds: [pepper], date: '2026-12-11', ledger: sessions });
      await staying(thu.bookingId, [pepper]);
      const list = (await owner.inject({ method: 'GET', url: '/bookings?view=upcoming' })).json<
        BookingWire[]
      >();
      const flag = (id: string) =>
        list.find((b) => b.id === id)?.dog_shares?.find((d) => d.dog_id === pepper)
          ?.can_remove_after_school;
      assert.equal(flag(thu.bookingId), true);
      assert.equal(flag(fri.bookingId), false);
    },
  );
});
