import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CheckinBoardWire, PostStaffOrdersCancelResponse } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';
import {
  bookings,
  charges,
  dogs,
  idempotencyKeys,
  orders as orderRows,
} from '../../src/db/schema/schema.js';
import { registerStaffOrdersRoute } from '../../src/routes/staffOrders.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { seedChargeAndClaim } from './_orderFixture.js';
import { clearPlantedPools, plantLot, poolBalance } from './_poolFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';
import {
  type Clock,
  at,
  boardApp,
  createSession,
  ledgerOf,
  makeClock,
  ownerCancel,
  ownerDogCancel,
  refusal,
  removeSessions,
  staffCancel,
  staffDogCancel,
  verb,
} from './_checkinFixture.js';

/**
 * CXL-U09's settled-share tests (design §2.3:2418-2447; P20 `pass_plan`): a session
 * settled at the door by a turn-away, and one by a send-home, refuses every cancel —
 * the owner's and the staff's whole-session cancel and both one-dog cancels of the
 * settled dog — with 409 `session_checked_in`, writing nothing.
 *
 * They drive the two settling verbs over HTTP. Those are DAY-U33's (S30, P20 pass 2),
 * so at pass 1 these are red on the verb's own answer and on its pass gate's
 * `expected_red`; at pass 2 they pass unchanged.
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

const DAY = '2026-10-21';

async function twoDogs(): Promise<{ bao: string; luna: string; bookingId: string }> {
  const bao = await createBookableDog(createdDogs);
  const luna = await createBookableDog(createdDogs);
  await db.update(dogs).set({ name: 'Bao' }).where(eq(dogs.id, bao));
  await db.update(dogs).set({ name: 'Luna' }).where(eq(dogs.id, luna));
  const lotId = await plantLot({ credits: 4, expiresAt: at('2027-06-01', '12:00') });
  const { bookingId } = await createSession({
    dogIds: [bao, luna],
    date: DAY,
    lotId,
    ledger: sessions,
  });
  return { bao, luna, bookingId };
}

async function everyCancelRefuses(
  bookingId: string,
  settledDog: string,
  when: Date,
): Promise<void> {
  const clock = makeClock(when);
  const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
  const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
  const before = await ledgerOf(bookingId);
  refusal(await ownerCancel(owner, { bookingId }), 409, 'session_checked_in');
  refusal(await staffCancel(staff, { bookingId }), 409, 'session_checked_in');
  refusal(await ownerDogCancel(owner, { bookingId, dogId: settledDog }), 409, 'session_checked_in');
  refusal(await staffDogCancel(staff, { bookingId, dogId: settledDog }), 409, 'session_checked_in');
  assert.deepEqual(await ledgerOf(bookingId), before, 'no refused cancel writes a ledger row');
}

test(
  'a session with a dog turned away refuses the owner and staff whole-session cancels and both one-dog cancels of that dog',
  SKIP_WHEN_NO_DB,
  async () => {
    const { bao, bookingId } = await twoDogs();
    const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:35')));
    const turned = await verb(staff, { bookingId, dogId: bao, verb: 'turn-away' });
    assert.equal(turned.statusCode, 200, turned.body);
    await everyCancelRefuses(bookingId, bao, at(DAY, '08:00'));
  },
);

test(
  'a session with a dog sent home refuses the owner and staff whole-session cancels and both one-dog cancels of that dog',
  SKIP_WHEN_NO_DB,
  async () => {
    const { luna, bookingId } = await twoDogs();
    const clock = makeClock(at(DAY, '07:40'));
    const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    const checkedIn = await verb(staff, { bookingId, dogId: luna, verb: 'check-in' });
    assert.equal(checkedIn.statusCode, 200, checkedIn.body);
    clock.set(at(DAY, '13:10'));
    const sent = await verb(staff, { bookingId, dogId: luna, verb: 'send-home', body: {} });
    assert.equal(sent.statusCode, 200, sent.body);
    await everyCancelRefuses(bookingId, luna, at(DAY, '13:20'));
  },
);

/**
 * P20 fix 1, F3 (designs/p20-event-ledger-link.md §M2; DECISIONS 251(b), 252(b)): *Cancel
 * order* on a top-up whose charge had succeeded applies the day cancels' own rule to every
 * day row it would cancel, earliest first, and refuses the whole order at the first that
 * refuses. Opus M2's probe p7 as a test: Waffles and Lola, today and tomorrow, a settled
 * top-up, Waffles checked in, then *Cancel order*. The board, the cancels and the order
 * route run on one clock.
 */

const TOMORROW = '2026-10-22';
const orders: string[] = [];
afterEach(async () => {
  if (orders.length === 0) return;
  const ids = orders.splice(0);
  await db.delete(charges).where(inArray(charges.orderId, ids));
  await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.orderId, ids));
  await db.delete(orderRows).where(inArray(orderRows.id, ids));
});

function ordersApp(clock: Clock) {
  const { app, authenticate } = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  const stripe = makeStripeStub();
  registerStaffOrdersRoute(app, { authenticate, stripe, now: clock.now });
  return { app, stripe };
}

function cancelOrder(app: FastifyInstance, orderId: string, key = `p20-order-${randomUUID()}`) {
  return app.inject({
    method: 'POST',
    url: `/staff/orders/${orderId}/cancel`,
    headers: { 'idempotency-key': key },
  });
}

interface TopUp {
  orderId: string;
  waffles: string;
  lola: string;
  bookingIds: string[];
}

/**
 * One settled top-up order whose rows are `dates`, both dogs on each, debited from one lot.
 * `idPrefixes[i]`, a hex digit, starts the i-th row's id, so a test can set the id order the
 * rows lock in against their date order.
 */
async function settledTopUp(
  stripe: StripeStub,
  dates: readonly string[],
  idPrefixes?: readonly string[],
): Promise<TopUp> {
  const waffles = await createBookableDog(createdDogs);
  const lola = await createBookableDog(createdDogs);
  await db.update(dogs).set({ name: 'Waffles' }).where(eq(dogs.id, waffles));
  await db.update(dogs).set({ name: 'Lola' }).where(eq(dogs.id, lola));
  const lotId = await plantLot({ credits: 6, expiresAt: at('2027-06-01', '12:00') });
  const bookingIds: string[] = [];
  for (const [i, date] of dates.entries()) {
    const prefix = idPrefixes?.[i];
    const { bookingId } = await createSession({
      dogIds: [waffles, lola],
      date,
      lotId,
      ledger: sessions,
      ...(prefix !== undefined ? { bookingId: `${prefix}${randomUUID().slice(1)}` } : {}),
    });
    bookingIds.push(bookingId);
  }
  const orderId = randomUUID();
  orders.push(orderId);
  await db.insert(orderRows).values({ id: orderId, ownerId: FIXTURE_IDS.ownerId });
  await db.update(bookings).set({ orderId }).where(inArray(bookings.id, bookingIds));
  await seedChargeAndClaim(stripe, {
    orderId,
    amountCents: 6_000 * 2 * dates.length,
    intentStatus: 'succeeded',
    chargeStatus: 'succeeded',
    attemptingUntil: at(dates[0]!, '07:00'),
    endpoint: 'POST /bookings',
    purpose: 'package',
    attemptCount: 1,
  });
  return { orderId, waffles, lola, bookingIds };
}

async function rowStatuses(bookingIds: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: bookings.id, status: bookings.status })
    .from(bookings)
    .where(inArray(bookings.id, [...bookingIds]));
  return bookingIds.map((id) => rows.find((r) => r.id === id)?.status ?? 'missing');
}

async function ledgersOf(bookingIds: readonly string[]) {
  return Promise.all(bookingIds.map((id) => ledgerOf(id)));
}

test(
  'TM3 (probe p7): Waffles checked in today, then Cancel order → 409 session_checked_in, nothing written, Waffles still in on the board, the same key answers the same',
  SKIP_WHEN_NO_DB,
  async () => {
    const clock = makeClock(at(DAY, '07:40'));
    const { app, stripe } = ordersApp(clock);
    const order = await settledTopUp(stripe, [DAY, TOMORROW]);
    const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    const [today] = order.bookingIds;
    const checkedIn = await verb(staff, {
      bookingId: today!,
      dogId: order.waffles,
      verb: 'check-in',
    });
    assert.equal(checkedIn.statusCode, 200, checkedIn.body);
    const ledgerBefore = await ledgersOf(order.bookingIds);
    const balanceBefore = await poolBalance();

    clock.set(at(DAY, '08:00'));
    const key = `p20-order-${randomUUID()}`;
    const details = refusal(await cancelOrder(app, order.orderId, key), 409, 'session_checked_in');
    assert.equal(details, undefined, 'no details: the 409 does not say which day');
    assert.deepEqual(await rowStatuses(order.bookingIds), ['upcoming', 'upcoming']);
    assert.deepEqual(await ledgersOf(order.bookingIds), ledgerBefore, 'no ledger row added');
    assert.equal(await poolBalance(), balanceBefore);
    const board = await staff.inject({
      method: 'GET',
      url: `/staff/checkin-board?location=bentonville&date=${DAY}`,
    });
    assert.equal(board.statusCode, 200, board.body);
    assert.equal(
      (JSON.parse(board.body) as CheckinBoardWire[]).find((r) => r.dog_id === order.waffles)?.state,
      'in',
      'the dog in the building stays on the board',
    );
    refusal(await cancelOrder(app, order.orderId, key), 409, 'session_checked_in');
    assert.deepEqual(await rowStatuses(order.bookingIds), ['upcoming', 'upcoming']);
  },
);

test(
  "TM4: nobody checked in, the clock past today's pickup close → 409 session_ended {date: today}, nothing written",
  SKIP_WHEN_NO_DB,
  async () => {
    const clock = makeClock(at(DAY, '17:45'));
    const { app, stripe } = ordersApp(clock);
    const order = await settledTopUp(stripe, [DAY, TOMORROW]);
    const ledgerBefore = await ledgersOf(order.bookingIds);
    const details = refusal(await cancelOrder(app, order.orderId), 409, 'session_ended');
    assert.deepEqual(details, { kind: 'session_ended', date: DAY });
    assert.deepEqual(await rowStatuses(order.bookingIds), ['upcoming', 'upcoming']);
    assert.deepEqual(await ledgersOf(order.bookingIds), ledgerBefore);
  },
);

test(
  'the guard: a check-in undone does not block — check in, undo, Cancel order → 200 settled_then_cancelled, every debit back',
  SKIP_WHEN_NO_DB,
  async () => {
    const clock = makeClock(at(DAY, '07:40'));
    const { app, stripe } = ordersApp(clock);
    const order = await settledTopUp(stripe, [DAY, TOMORROW]);
    const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    const [today] = order.bookingIds;
    for (const name of ['check-in', 'undo'] as const) {
      const res = await verb(staff, { bookingId: today!, dogId: order.waffles, verb: name });
      assert.equal(res.statusCode, 200, res.body);
    }
    const balanceBefore = await poolBalance();
    clock.set(at(DAY, '08:00'));
    const res = await cancelOrder(app, order.orderId);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as PostStaffOrdersCancelResponse).outcome, 'settled_then_cancelled');
    assert.deepEqual(await rowStatuses(order.bookingIds), ['cancelled', 'cancelled']);
    assert.equal(await poolBalance(), balanceBefore + 4);
    // T4's order arm: an order cancel's returns name no check-in event.
    const rows = (await ledgersOf(order.bookingIds)).flat();
    assert.equal(rows.filter((r) => r.reason === 'settlement-return').length, 4);
    assert.deepEqual(
      rows.map((r) => r.checkinEventId),
      rows.map(() => null),
    );
  },
);

test(
  'Opus L3: a debit returned once is never returned again — Lola cancelled alone, then Cancel order → one return per debit',
  SKIP_WHEN_NO_DB,
  async () => {
    const clock = makeClock(at(DAY, '07:40'));
    const { app, stripe } = ordersApp(clock);
    const order = await settledTopUp(stripe, [TOMORROW]);
    const [row] = order.bookingIds;
    const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    const alone = await staffDogCancel(staff, { bookingId: row!, dogId: order.lola });
    assert.equal(alone.statusCode, 200, alone.body);
    const res = await cancelOrder(app, order.orderId);
    assert.equal(res.statusCode, 200, res.body);
    const ledger = await ledgerOf(row!);
    const debits = ledger.filter((r) => r.reason === 'booking-debit');
    const returns = ledger.filter((r) => r.reason === 'settlement-return');
    assert.equal(debits.length, 2);
    assert.deepEqual(
      returns.map((r) => r.reversesEntryId).sort(),
      debits.map((d) => d.id).sort(),
      'each debit is reversed exactly once',
    );
  },
);

const YESTERDAY = '2026-10-20';

test(
  'F10 (Fable r2 L3): yesterday ended and today checked in → 409 session_ended {date: yesterday}, whichever order the rows lock in: the earliest refusing day speaks',
  SKIP_WHEN_NO_DB,
  async () => {
    // The rows lock in id order; each arrangement puts the ended day first once and last once.
    for (const idPrefixes of [
      ['1', '2'],
      ['e', 'd'],
    ] as const) {
      const clock = makeClock(at(DAY, '07:40'));
      const { app, stripe } = ordersApp(clock);
      const order = await settledTopUp(stripe, [YESTERDAY, DAY], idPrefixes);
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const today = order.bookingIds[1]!;
      const checkedIn = await verb(staff, {
        bookingId: today,
        dogId: order.waffles,
        verb: 'check-in',
      });
      assert.equal(checkedIn.statusCode, 200, checkedIn.body);
      const ledgerBefore = await ledgersOf(order.bookingIds);
      const details = refusal(await cancelOrder(app, order.orderId), 409, 'session_ended');
      assert.deepEqual(
        details,
        { kind: 'session_ended', date: YESTERDAY },
        `ids starting ${idPrefixes.join(', ')}`,
      );
      assert.deepEqual(await rowStatuses(order.bookingIds), ['upcoming', 'upcoming']);
      assert.deepEqual(await ledgersOf(order.bookingIds), ledgerBefore);
    }
  },
);

/** The backend waiting on `pid` right now, or nothing while nobody is. */
async function backendBlockedBy(pid: number): Promise<{ pid: number; query: string } | undefined> {
  const { rows } = await pool.query<{ pid: number; query: string }>(
    `SELECT pid, query FROM pg_stat_activity
      WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
    [pid],
  );
  return rows[0];
}

async function untilBlockedBy(pid: number): Promise<{ pid: number; query: string }> {
  const giveUpAt = Date.now() + 5_000;
  for (;;) {
    const blocked = await backendBlockedBy(pid);
    if (blocked !== undefined) return blocked;
    assert.ok(Date.now() < giveUpAt, `nobody queued behind backend ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "F9 (Opus r2 L2): Cancel order locks the order's rows before it reads their log — a desk check-in already in flight makes it wait, then refuse; nothing written",
  SKIP_WHEN_NO_DB,
  async () => {
    const clock = makeClock(at(DAY, '07:40'));
    const { app, stripe } = ordersApp(clock);
    const order = await settledTopUp(stripe, [DAY, TOMORROW]);
    const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    const [today] = order.bookingIds;
    const ledgerBefore = await ledgersOf(order.bookingIds);

    // A third connection holds Waffles's dog row, so the desk's check-in takes her booking
    // row and parks on her clock (`lockDogClock`), its event not yet written.
    const holder = await pool.connect();
    let held = true;
    const release = async (): Promise<void> => {
      if (!held) return;
      held = false;
      await holder.query('ROLLBACK');
      holder.release();
    };
    const inFlight: Promise<unknown>[] = [];
    try {
      await holder.query('BEGIN');
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const holderPid = rows[0]!.pid;
      await holder.query('SELECT 1 FROM dogs WHERE id = $1 FOR NO KEY UPDATE', [order.waffles]);
      const checkingIn = verb(staff, { bookingId: today!, dogId: order.waffles, verb: 'check-in' });
      inFlight.push(checkingIn);
      const desk = await untilBlockedBy(holderPid);

      // *Cancel order* arrives now. Locking first, it queues on the booking row before it
      // reads anything; read unlocked, it would read no check-in and cancel the day.
      const cancelling = cancelOrder(app, order.orderId);
      inFlight.push(cancelling);
      await untilBlockedBy(desk.pid);
      await release();

      const [checkedIn, cancelled] = await Promise.all([checkingIn, cancelling]);
      assert.equal(checkedIn.statusCode, 200, checkedIn.body);
      refusal(cancelled, 409, 'session_checked_in');
      assert.deepEqual(await rowStatuses(order.bookingIds), ['upcoming', 'upcoming']);
      assert.deepEqual(await ledgersOf(order.bookingIds), ledgerBefore, 'no credit returned');
      const board = await staff.inject({
        method: 'GET',
        url: `/staff/checkin-board?location=bentonville&date=${DAY}`,
      });
      assert.equal(
        (JSON.parse(board.body) as CheckinBoardWire[]).find((r) => r.dog_id === order.waffles)
          ?.state,
        'in',
      );
    } finally {
      await release();
      await Promise.allSettled(inFlight);
    }
  },
);
