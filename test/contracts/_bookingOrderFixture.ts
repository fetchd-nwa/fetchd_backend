import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Principal } from '../../src/auth/principal.js';
import type {
  ApiErrorEnvelope,
  BookingOrderPart,
  DogCreditPlanWire,
  PostBookingOrdersRequest,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';
import {
  agreementSignatures,
  bookings,
  creditLedger,
  dogVaccines,
  dogs,
  idempotencyKeys,
  orders,
  owners,
  paymentMethods,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import type { CheckThrottleStore } from '../../src/lib/orderCheckThrottle.js';
import { registerBookingOrdersRoute } from '../../src/routes/bookingOrders.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerCreditPackagesRoute } from '../../src/routes/creditPackages.js';
import { at, makeClock, type Clock } from './_checkinFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import { FIXTURE_OWNER_PRINCIPAL, makeContractApp, type LogCapture } from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { PLANTED, clearPlantedPools } from './_poolFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * What the `POST /booking-orders` suites share (wire 9.1.0; plan one-off O-CREDITS). The clock
 * is November 2037, whose calendar is 2026's (1 Jan both a Thursday), so the design's dates
 * hold as written: Wed 18 Nov is the clock, Mon 23 to Wed 25 Nov the days. `lot_is_live` and
 * `lot_pays_date` read Postgres's own clock, which no injected clock reaches, so every lot a
 * test plants ends in 2037 or 2038 and the fixture's 2036 lots pay none of these days.
 */

export const WED_18_NOV = at('2037-11-18', '12:00');

export const D = {
  WED_18: '2037-11-18',
  MON: '2037-11-23',
  TUE: '2037-11-24',
  WED: '2037-11-25',
  THU: '2037-11-26',
  FRI: '2037-11-27',
  MON2: '2037-11-30',
  TUE2: '2037-12-01',
  /** Six weeks out: past a one-month stamp from the clock (Fri 18 Dec). */
  WED_30_DEC: '2037-12-30',
  MON_18_JAN: '2038-01-18',
} as const;

/** A lot that pays every November and December day here. */
export const ENDS_31_DEC = '2037-12-31T18:00:00.000Z';

export type Campus = 'fayetteville' | 'bentonville';

/** An in-memory throttle, so a suite's checks never meet another file's minute. */
export function memoryThrottle(): CheckThrottleStore {
  const hits = new Map<string, number>();
  return {
    async hit(key: string): Promise<number> {
      const count = (hits.get(key) ?? 0) + 1;
      hits.set(key, count);
      return count;
    },
  };
}

export interface OrderApp {
  app: FastifyInstance;
  clock: Clock;
  stripe: StripeStub;
}

/** The order routes, `POST /bookings`' routes and the shop, on one clock. */
export function orderApp(
  args: {
    clock?: Clock;
    throttle?: CheckThrottleStore;
    principal?: Principal;
    capture?: LogCapture;
  } = {},
): OrderApp {
  const clock = args.clock ?? makeClock(WED_18_NOV);
  const { app, authenticate } = makeContractApp(
    args.principal ?? FIXTURE_OWNER_PRINCIPAL,
    args.capture,
  );
  const stripe = makeStripeStub();
  stripe.setIntentsCreatedAt(clock.now());
  registerBookingOrdersRoute(app, {
    authenticate,
    now: clock.now,
    throttle: args.throttle ?? memoryThrottle(),
  });
  registerBookingsRoute(app, { authenticate, now: clock.now, stripe });
  registerCreditPackagesRoute(app, { authenticate, now: clock.now, stripe });
  return { app, clock, stripe };
}

export function part(args: {
  category?: 'day-school' | 'day-care';
  location?: Campus;
  dogs: readonly string[];
  dates: readonly string[];
  after_school?: Record<string, string[]>;
}): BookingOrderPart {
  const [lead, ...additional] = args.dogs;
  if (lead === undefined) throw new Error('part: no dog');
  return {
    category: args.category ?? 'day-care',
    location: args.location ?? 'bentonville',
    lead_dog_id: lead,
    ...(additional.length > 0 ? { additional_dog_ids: [...additional] } : {}),
    dates: [...args.dates],
    ...(args.after_school !== undefined ? { after_school: args.after_school } : {}),
  };
}

export function post(app: FastifyInstance, body: unknown, key = `order-${randomUUID()}`) {
  return app.inject({
    method: 'POST',
    url: '/booking-orders',
    headers: { 'idempotency-key': key },
    payload: body as PostBookingOrdersRequest,
  });
}

export function check(app: FastifyInstance, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/booking-orders/check',
    payload: body as PostBookingOrdersRequest,
  });
}

/** Her purchase on the shop's own route (the stub's intent succeeds), at the app's clock. */
export async function buy(o: OrderApp, key: string, count?: number): Promise<void> {
  o.stripe.setIntentsCreatedAt(o.clock.now());
  const res = await o.app.inject({
    method: 'POST',
    url: `/credit-packages/${key}/purchase`,
    headers: { 'idempotency-key': `buy-${randomUUID()}` },
    payload: {
      payment_method_id: FIXTURE_IDS.paymentMethod1Id,
      ...(count !== undefined ? { count } : {}),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
}

/** A refusal's details, with its status and code asserted. */
export function refused<T>(
  res: { statusCode: number; body: string },
  code: string,
  status = 422,
): T {
  assert.equal(res.statusCode, status, res.body);
  const { error } = JSON.parse(res.body) as ApiErrorEnvelope;
  assert.equal(error.code, code, res.body);
  return error.details as T;
}

/** The fixture owner's rows an order can write, counted. */
export async function rowCounts(
  ownerId: string = FIXTURE_IDS.ownerId,
): Promise<Record<string, number>> {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM bookings WHERE owner_id = ${ownerId}) AS bookings,
      (SELECT count(*)::int FROM booking_dogs bd JOIN bookings b ON b.id = bd.booking_id
        WHERE b.owner_id = ${ownerId}) AS booking_dogs,
      (SELECT count(*)::int FROM credit_ledger WHERE owner_id = ${ownerId}) AS credit_ledger,
      (SELECT count(*)::int FROM orders WHERE owner_id = ${ownerId}) AS orders,
      (SELECT count(*)::int FROM scheduled_notifications WHERE owner_id = ${ownerId}) AS reminders,
      (SELECT count(*)::int FROM idempotency_keys WHERE owner_id = ${ownerId}) AS idempotency`);
  return rows[0] as Record<string, number>;
}

/**
 * B8's method on every case it names: the check first, writing nothing, then the POST, which
 * must answer what the check answered (its `plan` for a 201, its body for a refusal).
 */
export async function checkThenPost(
  app: FastifyInstance,
  body: unknown,
  key?: string,
): Promise<Awaited<ReturnType<typeof post>>> {
  const before = await rowCounts();
  const checked = await check(app, body);
  assert.deepEqual(await rowCounts(), before, 'the check wrote nothing');
  const posted = await post(app, body, key);
  if (posted.statusCode === 201) {
    assert.equal(checked.statusCode, 200, checked.body);
    assert.deepEqual(checked.json(), {
      bookable: true,
      plan: (posted.json() as { plan: DogCreditPlanWire[] }).plan,
    });
  } else {
    assert.equal(checked.statusCode, posted.statusCode, checked.body);
    assert.deepEqual(checked.json(), posted.json(), 'the check answered the POST’s refusal');
  }
  return posted;
}

/** The plan the debits of these bookings spell, counted straight off the ledger. */
export async function ledgerPlan(
  bookingIds: readonly string[],
): Promise<{ dog_id: string; location: string; mode: string; tier: string; count: number }[]> {
  if (bookingIds.length === 0) return [];
  const rows = await db
    .select({
      dog_id: creditLedger.dogId,
      location: creditLedger.location,
      mode: creditLedger.mode,
      tier: creditLedger.tier,
      count: sql<number>`count(*)::int`,
    })
    .from(creditLedger)
    .where(
      sql`${inArray(creditLedger.bookingId, [...bookingIds])} AND ${creditLedger.reason} = 'booking-debit'`,
    )
    .groupBy(creditLedger.dogId, creditLedger.location, creditLedger.mode, creditLedger.tier);
  return rows as { dog_id: string; location: string; mode: string; tier: string; count: number }[];
}

/** Sorted for a set comparison. */
export function sortPlan<
  T extends { dog_id: string | null; tier: string; location: string; mode: string },
>(plan: readonly T[]): T[] {
  const key = (p: T) => `${p.dog_id}|${p.location}|${p.mode}|${p.tier}`;
  return [...plan].sort((a, b) => key(a).localeCompare(key(b)));
}

/** The fixture's Bentonville day care grant (2036) is live and pays none of these days. */
export async function dropFixtureBentonvilleCare(): Promise<void> {
  await db.delete(creditLedger).where(eq(creditLedger.id, FIXTURE_IDS.creditLedgerBentonvilleId));
}

/** What an order suite leaves behind, between its tests. */
export async function clearOrderWorld(): Promise<void> {
  // The lots first: a purchase's lot names its charge, and a debit names its lot.
  await clearPlantedPools();
  await clearOrderRows();
  await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
}

/** Hold one statement's lock on a connection of its own, until released. */
export async function hold(
  statement: string,
  params: unknown[],
): Promise<{ client: pg.PoolClient; pid: number }> {
  const client = await pool.connect();
  await client.query('BEGIN');
  const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  await client.query(statement, params);
  return { client, pid: rows[0]!.pid };
}

export async function release(
  held: { client: pg.PoolClient },
  how: 'COMMIT' | 'ROLLBACK' = 'ROLLBACK',
): Promise<void> {
  await held.client.query(how);
  held.client.release();
}

/** Whether anyone is queued behind this backend: polls, never waits on a lock itself. */
export async function untilBlockedBy(pid: number, pending?: Promise<unknown>): Promise<boolean> {
  let settled = false;
  pending?.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let tries = 0; tries < 300; tries += 1) {
    if (settled) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
      [pid],
    );
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** Is this row lock free right now? Never waits. */
export async function rowIsFree(statement: string, params: unknown[]): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(statement, params);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') return false;
    throw err;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Is this advisory key free right now? Never waits. */
export async function advisoryIsFree(key: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got',
      [key],
    );
    return rows[0]!.got;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** A pool's advisory key, as `lockPools` spells it. */
export function poolKey(args: {
  ownerId?: string;
  location?: Campus;
  mode?: 'school' | 'daycare';
  tier: 'regular' | 'alumni';
}): string {
  return `pool:${args.ownerId ?? FIXTURE_IDS.ownerId}:${args.location ?? 'bentonville'}:${args.mode ?? 'daycare'}:${args.tier}`;
}

/**
 * A second family that passes every gate: her row, a card, the general waiver, and bookable
 * dogs. `remove` takes everything she or her orders wrote.
 */
export async function createOtherOwner(dogCount: number): Promise<{
  ownerId: string;
  principal: Principal;
  dogIds: string[];
  plant(args: {
    credits: number;
    expiresAt: string;
    location: Campus;
    mode: 'school' | 'daycare';
  }): Promise<void>;
  remove(): Promise<void>;
}> {
  const ownerId = randomUUID();
  const supabaseUid = randomUUID();
  await db.insert(owners).values({
    id: ownerId,
    supabaseUid,
    name: 'Other Family',
    email: `other-${ownerId}@example.test`,
    phone: '555-0199',
    location: 'bentonville',
  });
  await db.insert(paymentMethods).values({
    ownerId,
    stripePaymentMethodId: `pm_other_${ownerId}`,
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    cardholderName: 'Other Family',
    isDefault: true,
  });
  await db.insert(agreementSignatures).values({
    ownerId,
    documentKey: FIXTURE_IDS.agreementGeneralKey,
    version: 1,
    signedAt: '2026-04-01T15:00:00Z',
  });
  const dogIds: string[] = [];
  const expiresAt = new Date(Date.now() + 5 * 365 * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < dogCount; i += 1) {
    const dogId = randomUUID();
    dogIds.push(dogId);
    await db.insert(dogs).values({
      id: dogId,
      ownerId,
      name: `Other ${i + 1}`,
      breed: 'Test Breed',
      birthdate: '2023-01-01',
      evaluationStatus: 'passed',
    });
    await db
      .insert(dogVaccines)
      .values(
        [FIXTURE_IDS.requiredVaccineRabiesKey, FIXTURE_IDS.requiredVaccineBordetellaKey].map(
          (requirementKey) => ({ dogId, name: requirementKey, requirementKey, expiresAt }),
        ),
      );
  }
  return {
    ownerId,
    principal: { kind: 'owner', ownerId, supabaseUid },
    dogIds,
    async plant(args) {
      await db.insert(creditLedger).values({
        ownerId,
        location: args.location,
        mode: args.mode,
        tier: 'regular',
        delta: args.credits,
        reason: 'purchase',
        expiresAt: args.expiresAt,
        note: PLANTED,
      });
    },
    async remove() {
      const theirs = (
        await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ownerId, ownerId))
      ).map((row) => row.id);
      await db.delete(scheduledNotifications).where(eq(scheduledNotifications.ownerId, ownerId));
      await db.execute(sql`
        WITH RECURSIVE doomed(id) AS (
          SELECT id FROM credit_ledger WHERE owner_id = ${ownerId}
          UNION
          SELECT r.id FROM credit_ledger r JOIN doomed d ON r.lot_id = d.id OR r.reverses_entry_id = d.id
        )
        DELETE FROM credit_ledger WHERE id IN (SELECT id FROM doomed)`);
      if (theirs.length > 0) await db.delete(bookings).where(inArray(bookings.id, theirs));
      await db.delete(orders).where(eq(orders.ownerId, ownerId));
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.ownerId, ownerId));
      await db.delete(agreementSignatures).where(eq(agreementSignatures.ownerId, ownerId));
      await db.delete(paymentMethods).where(eq(paymentMethods.ownerId, ownerId));
      await db.delete(dogVaccines).where(inArray(dogVaccines.dogId, dogIds));
      await db.delete(dogs).where(inArray(dogs.id, dogIds));
      await db.delete(owners).where(eq(owners.id, ownerId));
    },
  };
}
