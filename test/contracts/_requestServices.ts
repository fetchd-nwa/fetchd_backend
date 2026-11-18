import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { Principal } from '../../src/auth/principal.js';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  bookings,
  charges,
  creditLedger,
  dogs,
  invoices,
  notifications,
  paymentMethods,
  pendingRequestDogs,
  pendingRequestPreferredDates,
  pendingRequests,
  scheduledNotifications,
  staff,
} from '../../src/db/schema/schema.js';
import { defaultStripeClient } from '../../src/lib/stripe.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerDogsRoute } from '../../src/routes/dogs.js';
import { registerRequestConfirmRoute } from '../../src/routes/requestConfirm.js';
import { registerRequestsRoute } from '../../src/routes/requests.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { registerStaffRequestsRoute } from '../../src/routes/staffRequests.js';
import { registerStaffServiceBookingsRoute } from '../../src/routes/staffServiceBookings.js';
import { registerTrainersRoute } from '../../src/routes/trainers.js';
import { FIXTURE_IDS, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  makeContractApp,
} from './_harness.js';
import { makeR2Stub } from './_r2Stub.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * Plan unit P49 (wire 9.0.0; design request-services-v1 Part A): what the request-services
 * suites share. The fixture clock is Tue 19 May 2026 17:00Z (`FIXTURE_NOW`); every instant
 * below is in June 2026, inside the 3-month horizon, read in America/Chicago (CDT, UTC-5).
 *
 * The fixture's staff (`_fixture.ts`): Rachel 15000 and Board & Train eligible, Shanthi 20000
 * and eligible, Donavan and Amber neither — the dev seed's roster (brief, Go B).
 */

/** Tess's three lesson times: Sat 6 Jun 10:00, Sat 6 Jun 14:00, Sun 7 Jun 10:00 (Chicago). */
export const LESSON_TIMES = [
  '2026-06-06T15:00:00.000Z',
  '2026-06-06T19:00:00.000Z',
  '2026-06-07T15:00:00.000Z',
] as const;

/**
 * Two Board & Train starts: Mon 1 Jun 08:00 and Mon 8 Jun 08:00 (Chicago). Before Amendment A1
 * (design request-services-v1 § 14) these were 8 and 15 Jun, a window over the fixture's own
 * boarding stay for Waffles (booking4, Mon 15 – Sat 20 Jun), which A1 now refuses. This window
 * is clear of every fixture stay for Waffles and Lola (Lola's open-ended one starts 1 Jul).
 */
export const BT_STARTS = ['2026-06-01T13:00:00.000Z', '2026-06-08T13:00:00.000Z'] as const;

/** The hand-back 13 nights after the first start, at 15:00: Sun 14 Jun 15:00 (Chicago). */
export const BT_PICKUP = '2026-06-14T20:00:00.000Z';

/** An instant before the fixture clock: Tue 19 May 10:00 Chicago. */
export const PAST_TIME = '2026-05-19T15:00:00.000Z';

export const B_AND_T_PRICE_CENTS = 200000;

type AnyApp = FastifyInstance;

/** The family's app: her requests, the yes, the trainer list and her bookings. */
export function ownerApp(
  now: () => Date = FIXTURE_NOW,
  principal: Principal = FIXTURE_OWNER_PRINCIPAL,
): AnyApp {
  const { app, authenticate } = makeContractApp(principal);
  registerRequestsRoute(app, { authenticate, now });
  registerRequestConfirmRoute(app, { authenticate, now });
  registerTrainersRoute(app, { authenticate });
  registerBookingsRoute(app, { authenticate, now, stripe: makeStripeStub() });
  return app;
}

/** The portal: the queue, approve and deny, the two reads, and the staff cancel. */
export function staffApp(
  now: () => Date = FIXTURE_NOW,
  principal: Principal = FIXTURE_OWNER_ROLE_PRINCIPAL,
): AnyApp {
  const { app, authenticate } = makeContractApp(principal);
  registerStaffRequestsRoute(app, { authenticate, now });
  registerTrainersRoute(app, { authenticate });
  registerStaffServiceBookingsRoute(app, { authenticate });
  registerStaffBookingsRoute(app, { authenticate, now, stripe: makeStripeStub() });
  return app;
}

export const AMBER = FIXTURE_MANAGER_PRINCIPAL;

/** A `submitted` request planted as a family's app or an old dev row would leave it. */
export async function plantRequest(args: {
  category: 'private-lesson' | 'board-and-train' | 'boarding';
  dogIds?: readonly string[];
  preferredDates?: readonly string[];
  staffPreference?: string | null;
  lengthWeeks?: number | null;
  ownerId?: string;
}): Promise<string> {
  const id = randomUUID();
  const dogIds = args.dogIds ?? [FIXTURE_IDS.dog1Id];
  const lead = dogIds[0] as string;
  const dates =
    args.preferredDates ?? (args.category === 'board-and-train' ? BT_STARTS : LESSON_TIMES);
  await db.insert(pendingRequests).values({
    id,
    ownerId: args.ownerId ?? FIXTURE_IDS.ownerId,
    leadDogId: lead,
    category: args.category,
    status: 'submitted',
    staffPreference: args.staffPreference ?? null,
    lengthWeeks:
      args.lengthWeeks !== undefined ? args.lengthWeeks : args.category === 'board-and-train' ? 2 : null,
  });
  await db
    .insert(pendingRequestDogs)
    .values(dogIds.map((dogId, i) => ({ requestId: id, dogId, isLead: i === 0 })));
  await db
    .insert(pendingRequestPreferredDates)
    .values(dates.map((preferredAt, i) => ({ requestId: id, ordinal: i + 1, preferredAt })));
  return id;
}

export function post(
  app: AnyApp,
  url: string,
  payload: Record<string, unknown> | undefined = {},
  key: string = `p49-${randomUUID()}`,
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'idempotency-key': key },
    ...(payload === undefined ? {} : { payload }),
  });
}

export function approve(
  id: string,
  payload: Record<string, unknown>,
  opts: { app?: AnyApp; key?: string } = {},
) {
  return post(opts.app ?? staffApp(), `/staff/requests/${id}/approve`, payload, opts.key);
}

export function deny(id: string, app: AnyApp = staffApp()) {
  return post(app, `/staff/requests/${id}/deny`, {});
}

export function confirm(
  id: string,
  opts: { app?: AnyApp; key?: string; payload?: Record<string, unknown> } = {},
) {
  return post(opts.app ?? ownerApp(), `/requests/${id}/confirm`, opts.payload ?? {}, opts.key);
}

export function withdraw(id: string, app: AnyApp = ownerApp()) {
  return post(app, `/requests/${id}/cancel`, {});
}

/** Shanthi approves Juniper-style: the first start, the hand-back 13 nights on, Rachel. */
export function approveBoardTrain(
  id: string,
  over: Record<string, unknown> = {},
  opts: { app?: AnyApp; key?: string } = {},
) {
  return approve(
    id,
    { dropoff_at: BT_STARTS[0], pickup_at: BT_PICKUP, trainer_staff_id: FIXTURE_IDS.staffRachelId, ...over },
    opts,
  );
}

/** Amber confirms Sat 6 Jun 10:00 with Rachel at Fayetteville. */
export function approveLesson(
  id: string,
  over: Record<string, unknown> = {},
  opts: { app?: AnyApp; key?: string } = {},
) {
  return approve(
    id,
    {
      scheduled_at: LESSON_TIMES[0],
      location: 'fayetteville',
      trainer_staff_id: FIXTURE_IDS.staffRachelId,
      ...over,
    },
    opts,
  );
}

export function errorCode(res: { body: string }): string | undefined {
  try {
    return (JSON.parse(res.body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

export function errorMessage(res: { body: string }): string | undefined {
  try {
    return (JSON.parse(res.body) as { error?: { message?: string } }).error?.message;
  } catch {
    return undefined;
  }
}

/** The request row as the database holds it. */
export async function requestRow(id: string) {
  const [row] = await db.select().from(pendingRequests).where(eq(pendingRequests.id, id));
  return row;
}

/** Every live booking of the fixture owner the fixture itself did not seed. */
export async function testBookings() {
  const rows = await db.select().from(bookings).where(eq(bookings.ownerId, FIXTURE_IDS.ownerId));
  return rows.filter((b) => !FIXTURE_ROW_IDS.has(b.id));
}

/** Every row that would show money moved for the fixture owner. */
export async function moneyRows(): Promise<{ charges: number; invoices: number; ledger: number }> {
  const [chargeRows, invoiceRows, ledgerRows] = await Promise.all([
    db.select({ id: charges.id }).from(charges).where(eq(charges.ownerId, FIXTURE_IDS.ownerId)),
    db.select({ id: invoices.id }).from(invoices).where(eq(invoices.ownerId, FIXTURE_IDS.ownerId)),
    db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.ownerId, FIXTURE_IDS.ownerId)),
  ]);
  return { charges: chargeRows.length, invoices: invoiceRows.length, ledger: ledgerRows.length };
}

/**
 * Every call to the real Stripe client, recorded and refused. The yes and the approve are
 * given no Stripe client, so anything they reached would be this default; a trapped call
 * also throws, so a route that tried would not answer 200 by accident.
 */
export function trapDefaultStripe(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const target = defaultStripeClient as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const [name, value] of Object.entries(target)) {
    if (typeof value !== 'function') continue;
    saved.set(name, value);
    target[name] = (..._args: unknown[]) => {
      calls.push(name);
      throw new Error(`P49: the real Stripe client was called (${name})`);
    };
  }
  return {
    calls,
    restore: () => {
      for (const [name, value] of saved) target[name] = value;
    },
  };
}

/** Take the fixture card away for `body`, and give it back. */
export async function withoutCard(body: () => Promise<void>): Promise<void> {
  await db
    .update(paymentMethods)
    .set({ expiredAt: sql`now()` })
    .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
  try {
    await body();
  } finally {
    await db
      .update(paymentMethods)
      .set({ expiredAt: null })
      .where(eq(paymentMethods.id, FIXTURE_IDS.paymentMethod1Id));
  }
}

/** Set one staffer's two columns for `body`, and put the fixture's values back. */
export async function withStaff(
  staffId: string,
  set: { lessonPriceCents?: number | null; boardTrainEligible?: boolean; expiredAt?: string | null },
  body: () => Promise<void>,
): Promise<void> {
  const [prior] = await db
    .select({
      lessonPriceCents: staff.lessonPriceCents,
      boardTrainEligible: staff.boardTrainEligible,
      expiredAt: staff.expiredAt,
    })
    .from(staff)
    .where(eq(staff.id, staffId));
  await db.update(staff).set(set).where(eq(staff.id, staffId));
  try {
    await body();
  } finally {
    if (prior !== undefined) await db.update(staff).set(prior).where(eq(staff.id, staffId));
  }
}

/**
 * A third connection holding one request's row lock until `release`; releasing twice is a
 * no-op. `alsoRun` is SQL (with `$1` the request id) run under the lock before it is
 * released, as a staff approve would write while it holds it.
 */
export async function holdRequestLock(
  requestId: string,
  alsoRun?: string,
): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM pending_requests WHERE id = $1 FOR UPDATE', [requestId]);
  if (alsoRun !== undefined) await client.query(alsoRun, [requestId]);
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

/**
 * A booking of the fixture owner's, planted as an approve or a yes would have left it: a
 * boarding or Board & Train stay (its window from `scheduledAt` to `pickupAt`, none when
 * `null`) or a lesson. `clearRequestServiceRows` takes it away (Amendment A1's pins).
 */
export async function plantBooking(args: {
  category: 'boarding' | 'board-and-train' | 'private-lesson';
  dogIds: readonly string[];
  scheduledAt: string;
  pickupAt?: string | null;
  cancelled?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const stay = args.category !== 'private-lesson';
  await db.insert(bookings).values({
    id,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: args.dogIds[0] as string,
    category: args.category,
    status: args.cancelled === true ? 'cancelled' : 'upcoming',
    scheduledAt: args.scheduledAt,
    durationMinutes: stay ? null : 60,
    trainerStaffId: args.category === 'boarding' ? null : FIXTURE_IDS.staffRachelId,
    quotedPriceCents:
      args.category === 'boarding' ? null : args.category === 'private-lesson' ? 15000 : B_AND_T_PRICE_CENTS,
    ...(stay ? { dropoffAt: args.scheduledAt, pickupAt: args.pickupAt ?? null } : {}),
    ...(args.cancelled === true ? { cancelledAt: '2026-05-18T20:00:00Z' } : {}),
    notes: null,
    location: 'fayetteville',
  });
  await db
    .insert(bookingDogs)
    .values(args.dogIds.map((dogId, i) => ({ bookingId: id, dogId, isLead: i === 0 })));
  return id;
}

/** The family's `DELETE /dogs/:id` (her own route), answered as it answers. */
export function deleteDog(dogId: string) {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerDogsRoute(app, { authenticate, r2: makeR2Stub() });
  return app.inject({
    method: 'DELETE',
    url: `/dogs/${dogId}`,
    headers: { 'idempotency-key': `p49-rm-${randomUUID()}` },
  });
}

/** The family removes a dog through `DELETE /dogs/:id` (her own route), answering 204. */
export async function removeDog(dogId: string): Promise<void> {
  const res = await deleteDog(dogId);
  if (res.statusCode !== 204) throw new Error(`DELETE /dogs/${dogId} → ${res.statusCode} ${res.body}`);
}

/** Remove a fixture dog for `body` through her route, and put the dog back. */
export async function withDogRemoved(dogId: string, body: () => Promise<void>): Promise<void> {
  await removeDog(dogId);
  try {
    await body();
  } finally {
    await db.update(dogs).set({ expiredAt: null }).where(eq(dogs.id, dogId));
  }
}

/**
 * A third connection holding one dog's lock (`withDogLocks`'s key, `dog:<id>`) until
 * `release`; releasing twice is a no-op.
 */
export async function holdDogLock(dogId: string): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dog:${dogId}`]);
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

/**
 * A third connection holding one campus's `locations` row `FOR UPDATE` until `release`;
 * releasing twice is a no-op. An INSERT naming that campus waits on it, at its foreign-key
 * check (`KEY SHARE`), so the yes of a family at that campus stops at its stay's INSERT:
 * after its removed-dog read, holding its dogs' locks. A statement naming no campus (her
 * `DELETE /dogs/:id`) never waits on it.
 */
export async function holdCampusRow(slug: string): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT slug FROM locations WHERE slug = $1 FOR UPDATE', [slug]);
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

/**
 * A third connection holding one dog's row `FOR UPDATE` until `release`; releasing twice is a
 * no-op. Her `DELETE /dogs/:id` takes the dog's lock and then waits here, at its `UPDATE`.
 */
export async function holdDogRow(dogId: string): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM dogs WHERE id = $1 FOR UPDATE', [dogId]);
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

/** Whether some transaction holds this dog's lock (`dog:<id>`): a try from a fourth connection fails. */
export async function dogLockHeld(dogId: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got',
      [`dog:${dogId}`],
    );
    await client.query('ROLLBACK');
    return rows[0]?.got === false;
  } finally {
    await client.end();
  }
}

/** What each backend of this database that waits on a lock is running: its first three words, sorted. */
export async function lockWaits(): Promise<string[]> {
  const { rows } = await db.execute(sql`
    SELECT query FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'`);
  return (rows as { query: string }[])
    .map((r) => r.query.trim().split(/\s+/).slice(0, 3).join(' '))
    .sort();
}

/**
 * Wait until `count` backends of this database wait on a lock, or until `answer` settles
 * (a request that took no lock answers instead of waiting; the caller's assertions then
 * read what it did).
 */
export async function blockedOrAnswered(count: number, answer: Promise<unknown>): Promise<void> {
  let settled = false;
  answer.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let tries = 0; tries < 300 && !settled; tries += 1) {
    const { rows } = await db.execute(sql`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((rows[0] as { blocked: number }).blocked >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Every row the fixture seeds is named in `FIXTURE_IDS`; anything else a test made. */
const FIXTURE_ROW_IDS: ReadonlySet<string> = new Set(Object.values(FIXTURE_IDS));

/**
 * What these suites add for the fixture owner, taken away: the requests and bookings they
 * made, their notices and reminders. The fixture's own rows stay.
 */
export async function clearRequestServiceRows(): Promise<void> {
  const ownerId = FIXTURE_IDS.ownerId;
  const requests = await db
    .select({ id: pendingRequests.id })
    .from(pendingRequests)
    .where(eq(pendingRequests.ownerId, ownerId));
  const requestIds = requests.map((r) => r.id).filter((id) => !FIXTURE_ROW_IDS.has(id));
  const bookingIds = (await testBookings()).map((b) => b.id);
  const linked = [...requestIds, ...bookingIds];
  if (bookingIds.length > 0) {
    await db
      .delete(scheduledNotifications)
      .where(inArray(scheduledNotifications.bookingId, bookingIds));
  }
  if (linked.length > 0) {
    await db
      .delete(notifications)
      .where(and(eq(notifications.ownerId, ownerId), inArray(notifications.deepLinkId, linked)));
  }
  if (requestIds.length > 0) {
    await db.delete(pendingRequests).where(inArray(pendingRequests.id, requestIds));
  }
  if (bookingIds.length > 0) {
    await db
      .delete(bookings)
      .where(and(eq(bookings.ownerId, ownerId), inArray(bookings.id, bookingIds)));
  }
}
