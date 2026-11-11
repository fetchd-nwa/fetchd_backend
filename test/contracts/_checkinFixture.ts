import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../src/auth/principal.js';
import type { ApiErrorEnvelope } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import {
  bookingDogs,
  bookings,
  creditLedger,
  notifications,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { chicagoTimeOnDate } from '../../src/lib/chicagoDate.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { registerStaffCheckinRoute } from '../../src/routes/staffCheckin.js';
import { FIXTURE_IDS } from './_fixture.js';
import { makeContractApp, type LogCapture } from './_harness.js';
import { makeStripeStub } from './_stripeStub.js';

/**
 * What P20's board and cancel tests share: a day session written straight to the
 * tables (a booking, its dogs, one debit per dog from a planted lot), a clock a test
 * moves, and an app with the three route files the board and the cancels live in.
 * Every session is Bentonville day school by default, the pool `_poolFixture` plants
 * in and clears.
 */

export type Campus = 'fayetteville' | 'bentonville';

/** One instant on a Chicago calendar day, `HH:MM` wall time. */
export function at(date: string, hhmm: string): Date {
  return chicagoTimeOnDate(date, hhmm);
}

/** A clock a test moves between requests. */
export interface Clock {
  now: () => Date;
  set(instant: Date): void;
}

export function makeClock(start: Date): Clock {
  let current = start;
  return {
    now: () => current,
    set(instant: Date): void {
      current = instant;
    },
  };
}

export interface Session {
  bookingId: string;
  /** Each dog's `booking-debit` id, by dog. */
  debitIds: Map<string, string>;
}

/**
 * One day session as the booking core leaves it: status `upcoming` (or a top-up's
 * `payment-pending`), scheduled at the campus's drop-off open, the first dog the lead,
 * and one debit per dog from `lotId`, or from `lots[i]` for the i-th dog (`null` there,
 * or neither given, for a share that holds none).
 */
export async function createSession(args: {
  dogIds: readonly string[];
  date: string;
  lotId?: string;
  lots?: readonly (string | null)[];
  location?: Campus;
  category?: 'day-school' | 'day-care';
  status?: 'upcoming' | 'payment-pending';
  ledger: string[];
  /** The row's id, when a test needs the rows' id order (they lock in it). */
  bookingId?: string;
}): Promise<Session> {
  const [lead, ...rest] = args.dogIds;
  if (lead === undefined) throw new Error('createSession: no dog');
  const bookingId = args.bookingId ?? randomUUID();
  args.ledger.push(bookingId);
  const scheduledAt = at(args.date, '07:30');
  await db.insert(bookings).values({
    id: bookingId,
    ownerId: FIXTURE_IDS.ownerId,
    leadDogId: lead,
    category: args.category ?? 'day-school',
    scheduledAt: scheduledAt.toISOString(),
    location: args.location ?? 'bentonville',
    cancelDeadlineAt: new Date(scheduledAt.getTime() - 48 * 3_600_000).toISOString(),
    ...(args.status !== undefined ? { status: args.status } : {}),
  });
  await db
    .insert(bookingDogs)
    .values([
      { bookingId, dogId: lead, isLead: true },
      ...rest.map((dogId) => ({ bookingId, dogId, isLead: false })),
    ]);
  const debitIds = new Map<string, string>();
  for (const [index, dogId] of args.dogIds.entries()) {
    const lotId = args.lots !== undefined ? args.lots[index] : args.lotId;
    if (lotId != null) {
      const id = randomUUID();
      await db.insert(creditLedger).values({
        id,
        ownerId: FIXTURE_IDS.ownerId,
        dogId,
        location: args.location ?? 'bentonville',
        mode: (args.category ?? 'day-school') === 'day-school' ? 'school' : 'daycare',
        tier: 'regular',
        delta: -1,
        reason: 'booking-debit',
        bookingId,
        lotId,
      });
      debitIds.set(dogId, id);
    }
  }
  return { bookingId, debitIds };
}

/** Everything these sessions left: notices, ledger rows, then the rows (events cascade). */
export async function removeSessions(bookingIds: readonly string[]): Promise<void> {
  if (bookingIds.length === 0) return;
  await db
    .delete(scheduledNotifications)
    .where(inArray(scheduledNotifications.bookingId, [...bookingIds]));
  await db.delete(notifications).where(inArray(notifications.deepLinkId, [...bookingIds]));
  await db.delete(creditLedger).where(inArray(creditLedger.bookingId, [...bookingIds]));
  await db.delete(bookings).where(inArray(bookings.id, [...bookingIds]));
}

/** The owner's `booking-cancelled` feed rows about these sessions, oldest first. */
export async function cancelNotices(
  bookingIds: readonly string[],
): Promise<{ body: string; deepLinkId: string | null }[]> {
  if (bookingIds.length === 0) return [];
  const { rows } = await db.execute(sql`
    SELECT body, deep_link_id AS "deepLinkId" FROM notifications
     WHERE owner_id = ${FIXTURE_IDS.ownerId} AND type = 'booking-cancelled'
       AND deep_link_id = ANY (string_to_array(${bookingIds.join(',')}, ',')::uuid[])
     ORDER BY created_at, id`);
  return rows as { body: string; deepLinkId: string | null }[];
}

/** Every ledger row a session wrote, oldest first. */
export async function ledgerOf(bookingId: string): Promise<
  {
    id: string;
    dogId: string | null;
    delta: number;
    reason: string;
    lotId: string | null;
    reversesEntryId: string | null;
    expiresAt: string | null;
    /** The check-in event whose transaction wrote the row (M5.10, P20 fix 1). */
    checkinEventId: string | null;
  }[]
> {
  const { rows } = await db.execute(sql`
    SELECT id, dog_id AS "dogId", delta, reason::text AS reason, lot_id AS "lotId",
           reverses_entry_id AS "reversesEntryId", expires_at AS "expiresAt",
           checkin_event_id AS "checkinEventId"
      FROM credit_ledger WHERE booking_id = ${bookingId}
     ORDER BY created_at, id`);
  return rows as never;
}

/**
 * A foreign ledger row on an event's share, stamped with that event's own `created_at`,
 * copied inside SQL: node-pg rounds a `Date` to milliseconds, so a stamp sent from here
 * would differ in its microseconds and prove nothing (review-fable.md:65). Answers the
 * row's id once both stamps read equal as text. The row names no event: it is what a
 * stamp match would have taken for the event's own (Fable L1, F' and F'').
 */
export async function plantAtEventStamp(args: {
  eventId: string;
  reason: 'settlement-return' | 'booking-debit';
  lotId: string;
  /** A return's debit (M5.10's CHECK). */
  reversesEntryId?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO credit_ledger
      (id, owner_id, dog_id, location, mode, tier, delta, reason, booking_id, lot_id,
       reverses_entry_id, created_at)
    SELECT ${id}, b.owner_id, e.dog_id, b.location, 'school', 'regular',
           ${args.reason === 'settlement-return' ? 1 : -1}, ${args.reason}::ledger_reason,
           e.booking_id, ${args.lotId}, ${args.reversesEntryId ?? null}, e.created_at
      FROM checkin_events e JOIN bookings b ON b.id = e.booking_id
     WHERE e.id = ${args.eventId}`);
  const { rows } = await db.execute(sql`
    SELECT (SELECT created_at::text FROM checkin_events WHERE id = ${args.eventId}) AS event,
           (SELECT created_at::text FROM credit_ledger WHERE id = ${id}) AS planted`);
  const stamps = rows[0] as { event: string | null; planted: string | null };
  assert.ok(stamps.event !== null, `event ${args.eventId} exists`);
  assert.equal(stamps.planted, stamps.event, 'the planted row carries the event stamp exactly');
  return id;
}

/** One share's log as the table holds it, in append order. */
export async function eventsOf(
  bookingId: string,
  dogId: string,
): Promise<{ id: string; kind: string; undoesEventId: string | null }[]> {
  const { rows } = await db.execute(sql`
    SELECT id, kind::text AS kind, undoes_event_id AS "undoesEventId"
      FROM checkin_events WHERE booking_id = ${bookingId} AND dog_id = ${dogId}
     ORDER BY seq`);
  return rows as never;
}

/** An app with the board, the staff booking routes and the owner booking routes. */
export function boardApp(
  principal: Principal,
  clock: Clock,
  capture?: LogCapture,
): FastifyInstance {
  const { app, authenticate } = makeContractApp(principal, capture);
  const stripe = makeStripeStub();
  registerStaffCheckinRoute(app, { authenticate, now: clock.now });
  registerStaffBookingsRoute(app, { authenticate, now: clock.now, stripe });
  registerBookingsRoute(app, { authenticate, now: clock.now, stripe });
  return app;
}

export type Verb = 'check-in' | 'check-out' | 'undo' | 'turn-away' | 'send-home' | 'no-show';

export function verb(
  app: FastifyInstance,
  args: { bookingId: string; dogId: string; verb: Verb; body?: unknown; key?: string },
) {
  return app.inject({
    method: 'POST',
    url: `/staff/bookings/${args.bookingId}/dogs/${args.dogId}/${args.verb}`,
    headers: { 'idempotency-key': args.key ?? `p20-${args.verb}-${randomUUID()}` },
    ...(args.body !== undefined ? { payload: args.body as Record<string, unknown> } : {}),
  });
}

export function ownerDogCancel(
  app: FastifyInstance,
  args: { bookingId: string; dogId: string; key?: string },
) {
  return app.inject({
    method: 'POST',
    url: `/bookings/${args.bookingId}/dogs/${args.dogId}/cancel`,
    headers: { 'idempotency-key': args.key ?? `p20-owner-dog-${randomUUID()}` },
  });
}

export function staffDogCancel(
  app: FastifyInstance,
  args: { bookingId: string; dogId: string; reason?: string; key?: string },
) {
  return app.inject({
    method: 'POST',
    url: `/staff/bookings/${args.bookingId}/dogs/${args.dogId}/cancel`,
    headers: { 'idempotency-key': args.key ?? `p20-staff-dog-${randomUUID()}` },
    payload: { reason: args.reason ?? 'Family called the desk' },
  });
}

export function ownerCancel(app: FastifyInstance, args: { bookingId: string; key?: string }) {
  return app.inject({
    method: 'POST',
    url: `/bookings/${args.bookingId}/cancel`,
    headers: { 'idempotency-key': args.key ?? `p20-owner-cancel-${randomUUID()}` },
    payload: {},
  });
}

export function staffCancel(app: FastifyInstance, args: { bookingId: string; key?: string }) {
  return app.inject({
    method: 'POST',
    url: `/staff/bookings/${args.bookingId}/cancel`,
    headers: { 'idempotency-key': args.key ?? `p20-staff-cancel-${randomUUID()}` },
    payload: {},
  });
}

/** A refusal's code and details, the status asserted. */
export function refusal<T = unknown>(
  res: { statusCode: number; body: string },
  status: number,
  code: string,
): T {
  assert.equal(res.statusCode, status, res.body);
  const { error } = JSON.parse(res.body) as ApiErrorEnvelope;
  assert.equal(error.code, code, res.body);
  return error.details as T;
}
