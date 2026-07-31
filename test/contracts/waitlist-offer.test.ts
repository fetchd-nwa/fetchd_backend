import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  bookings as bookingsTable,
  cohorts,
  creditLedger,
  dayCapacity,
  dogCreditBalance,
  dogVaccines,
  dogs,
  invoices,
  scheduledNotifications,
  waitlistEntries,
  waitlistEntryDogs,
} from '../../src/db/schema/schema.js';
import { withActor } from '../../src/db/tx.js';
import type { WaitlistTarget } from '../../src/db/repositories/waitlistRepository.js';
import { resolveApprovalDivert } from '../../src/lib/bookingApprovalDivert.js';
import { promoteForTarget } from '../../src/lib/waitlistPromotion.js';
import { registerWaitlistRoutes } from '../../src/routes/waitlist.js';
import { FIXTURE_IDS, FIXTURE_NOW, futureWeekday, topUpCredits } from './_fixture.js';
import { makeStripeStub } from './_stripeStub.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Contract tests for answering a waitlist offer (Allison 2026-07-29/30):
 *   - POST /waitlist/:id/accept
 *   - POST /waitlist/:id/decline
 *
 * The rulings these exist to hold down:
 *   1. **No money at join, money at ACCEPT.** A seat opening moves nothing —
 *      not a credit, not an invoice. The first test drives the real promotion
 *      path and proves the balance is untouched until the owner says yes.
 *   5. **Gates are hard, and they re-run at accept.** Accept is what creates the
 *      booking, so it must never be a looser path into one than POST /bookings.
 *
 * And the failure modes that would actually bite in production, all of which
 * are "the seat you were promised isn't there any more":
 *   - the same seat offered to two owners (staff overrides, or a promotion bug)
 *   - an entry that needs more seats than are free
 *   - a day that is CLOSED, not merely full
 *   - an offer whose deadline has passed
 *   - an accept and a decline landing on the same entry at the same moment
 *
 * Every refusal asserts two things, not one: the right status AND that the
 * entry survived in `offered`. A refusal that consumed the offer would burn the
 * owner's seat on a transient failure.
 *
 * Entries are inserted directly rather than through POST /waitlist so each test
 * pins the offer's deadline and FIFO order instead of inheriting them from a
 * join it isn't testing.
 */

// Backstop sweep. Every case also calls `resetState()` first and last, but a
// case that FAILS mid-way skips its trailing call — and `day_capacity` is keyed
// by (location, date), not by owner, so a leaked override would change what a
// later test file sees for this date. Registered BEFORE `registerFixtureHooks`
// so it runs ahead of `teardownFixture`.
after(async () => {
  // `SKIP_WHEN_NO_DB.skip === false` is the harness's "there is a database";
  // without one every case skipped and there is nothing to sweep.
  if (SKIP_WHEN_NO_DB.skip !== false) return;
  await resetState();
});

registerFixtureHooks();

/** Reads only (the divert control below); the actor just satisfies `withActor`. */
const TEST_ACTOR = 'system:test-waitlist-offer';

const LOCATION = 'fayetteville';
/** One weekday, clear of every fixture booking, reused by every day-program
 *  case — `resetState()` runs first in each test, so sharing it is isolation
 *  by construction rather than by picking a fresh date per case. */
const SESSION_DAY = futureWeekday(5);
/** Behind FIXTURE_TODAY (2026-05-19) and clear of the fixture's past bookings. */
const PAST_DAY = '2026-05-11';
const TEST_DAYS = [SESSION_DAY, PAST_DAY];

const ONE_HOUR_MS = 3_600_000;
const DAY_SCHOOL_FAY_RATE_CENTS = 7500;

type App = ReturnType<typeof makeContractApp>['app'];

interface BookingWireLike {
  id: string;
  dog_id: string;
  additional_dog_ids?: string[];
  category: string;
  status: string;
  date: string;
  location?: string;
  notes?: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

function waitlistApp(principal = FIXTURE_OWNER_PRINCIPAL): App {
  const { app, authenticate } = makeContractApp(principal);
  registerWaitlistRoutes(app, { authenticate, now: FIXTURE_NOW });
  return app;
}

/**
 * The same app with the Stripe seam stubbed — only a GROUP-CLASS accept touches
 * it (group-class is money-paid, so the card is charged before the enroll
 * transaction, exactly as POST /enrollments does it).
 */
function waitlistAppWithStripe(): { app: App; stripe: ReturnType<typeof makeStripeStub> } {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  const stripe = makeStripeStub();
  registerWaitlistRoutes(app, { authenticate, now: FIXTURE_NOW, stripe });
  return { app, stripe };
}

function dayTarget(sessionDate = SESSION_DAY): WaitlistTarget {
  return {
    kind: 'day-program',
    category: 'day-school',
    sessionDate,
    location: LOCATION,
    mode: 'school',
  };
}

/**
 * Accept. Omitting `body` sends NO payload at all — the route documents a bare
 * accept as the common case (drop-off defaults to the window open, payment to
 * credits), so that is what the default helper exercises.
 */
function accept(
  app: App,
  id: string,
  opts: { body?: Record<string, unknown>; key?: string; omitKey?: boolean } = {},
): ReturnType<App['inject']> {
  const headers: Record<string, string> =
    opts.omitKey === true ? {} : { 'idempotency-key': opts.key ?? randomUUID() };
  return app.inject({
    method: 'POST',
    url: `/waitlist/${id}/accept`,
    headers,
    ...(opts.body === undefined ? {} : { payload: opts.body }),
  });
}

function decline(app: App, id: string, key = randomUUID()): ReturnType<App['inject']> {
  return app.inject({
    method: 'POST',
    url: `/waitlist/${id}/decline`,
    headers: { 'idempotency-key': key },
  });
}

/** A day-program entry in whatever lifecycle state the case needs. */
async function seedDayEntry(args: {
  dogIds: readonly string[];
  status: 'waiting' | 'offered';
  sessionDate?: string;
  /** Offered entries only; defaults to a live 24h deadline from FIXTURE_NOW. */
  offerExpiresAt?: Date;
  createdAt?: Date;
}): Promise<string> {
  const [lead] = args.dogIds;
  if (lead === undefined) throw new Error('seedDayEntry needs at least one dog');
  const now = FIXTURE_NOW();
  const offered = args.status === 'offered';
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: lead,
      category: 'day-school',
      status: args.status,
      sessionDate: args.sessionDate ?? SESSION_DAY,
      location: LOCATION,
      mode: 'school',
      ...(offered
        ? {
            offeredAt: now.toISOString(),
            offerExpiresAt: (
              args.offerExpiresAt ?? new Date(now.getTime() + 24 * ONE_HOUR_MS)
            ).toISOString(),
          }
        : {}),
      ...(args.createdAt === undefined ? {} : { createdAt: args.createdAt.toISOString() }),
    })
    .returning({ id: waitlistEntries.id });
  if (row === undefined) throw new Error('seedDayEntry: insert returned no row');
  await db.insert(waitlistEntryDogs).values(
    args.dogIds.map((dogId) => ({
      waitlistEntryId: row.id,
      dogId,
      isLead: dogId === lead,
    })),
  );
  return row.id;
}

/** A group-class offer — the arm that has no enrollment core to call yet. */
async function seedCohortEntry(): Promise<string> {
  const now = FIXTURE_NOW();
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: FIXTURE_IDS.dog1Id,
      category: 'group-class',
      status: 'offered',
      cohortId: FIXTURE_IDS.cohortPuppyId,
      offeredAt: now.toISOString(),
      offerExpiresAt: new Date(now.getTime() + 24 * ONE_HOUR_MS).toISOString(),
    })
    .returning({ id: waitlistEntries.id });
  if (row === undefined) throw new Error('seedCohortEntry: insert returned no row');
  await db
    .insert(waitlistEntryDogs)
    .values({ waitlistEntryId: row.id, dogId: FIXTURE_IDS.dog1Id, isLead: true });
  return row.id;
}

async function seedOpenings(date: string, schoolOpenings: number): Promise<void> {
  await db
    .insert(dayCapacity)
    .values({ location: LOCATION, date, schoolOpenings, daycareOpenings: 0 })
    .onConflictDoUpdate({
      target: [dayCapacity.location, dayCapacity.date],
      set: { schoolOpenings, daycareOpenings: 0 },
    });
}

interface EntryState {
  status: string;
  bookingId: string | null;
  resolvedAt: string | null;
}

async function entryState(id: string): Promise<EntryState> {
  const [row] = await db
    .select({
      status: waitlistEntries.status,
      bookingId: waitlistEntries.bookingId,
      resolvedAt: waitlistEntries.resolvedAt,
    })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, id));
  if (row === undefined) throw new Error(`entryState: no waitlist entry ${id}`);
  return row;
}

/** Every booking the fixture owner holds on `date` (Chicago calendar bucket). */
async function bookingIdsOn(date: string): Promise<string[]> {
  const rows = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.ownerId, FIXTURE_IDS.ownerId),
        sql`(${bookingsTable.scheduledAt} AT TIME ZONE 'America/Chicago')::date = ${date}::date`,
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * The dog's live school balance at this school. The non-circular "did money
 * move" probe: a refusal that rolled back leaves this untouched, and a refusal
 * that half-committed does not.
 */
async function schoolBalance(dogId: string): Promise<number> {
  const [row] = await db
    .select({ balance: dogCreditBalance.balance })
    .from(dogCreditBalance)
    .where(
      and(
        eq(dogCreditBalance.dogId, dogId),
        eq(dogCreditBalance.mode, 'school'),
        eq(dogCreditBalance.location, LOCATION),
      ),
    );
  return row?.balance ?? 0;
}

async function paygInvoiceCount(): Promise<number> {
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.ownerId, FIXTURE_IDS.ownerId), eq(invoices.purpose, 'payg')));
  return rows.length;
}

/** Test-only scaffolding — the API never deletes a booking. */
async function clearBookingsOn(date: string): Promise<void> {
  const ids = await bookingIdsOn(date);
  if (ids.length === 0) return;
  // Children first: both FKs are plain references, and `scheduled_notifications`
  // (the reminder rows every create enqueues) would block the delete.
  await db.delete(scheduledNotifications).where(inArray(scheduledNotifications.bookingId, ids));
  await db.delete(invoices).where(inArray(invoices.bookingId, ids));
  await db.delete(creditLedger).where(inArray(creditLedger.bookingId, ids));
  await db.delete(bookingsTable).where(inArray(bookingsTable.id, ids)); // booking_dogs CASCADEs
}

/**
 * Drop everything a case in this file can create. Runs FIRST in every test
 * rather than last, so a case that fails mid-way can't poison the next one.
 * Waitlist rows go before bookings — `waitlist_entries.booking_id` is
 * ON DELETE SET NULL, but clearing the pointer first keeps the order obvious.
 */
async function resetState(): Promise<void> {
  await db
    .delete(scheduledNotifications)
    .where(eq(scheduledNotifications.ownerId, FIXTURE_IDS.ownerId));
  await db.delete(waitlistEntries).where(eq(waitlistEntries.ownerId, FIXTURE_IDS.ownerId));
  for (const day of TEST_DAYS) await clearBookingsOn(day);
  await db
    .delete(dayCapacity)
    .where(and(eq(dayCapacity.location, LOCATION), inArray(dayCapacity.date, TEST_DAYS)));
}

// ──────────────────────────────────────────────────────────────────────────
// Ruling 1 — nothing moves until accept
// ──────────────────────────────────────────────────────────────────────────

test(
  'the offer moves no money — the credit is debited at ACCEPT, not when the seat opens',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 2);
    const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'waiting' });
    const balanceBeforeOffer = await schoolBalance(FIXTURE_IDS.dog1Id);
    const invoicesBeforeOffer = await paygInvoiceCount();

    // The real promotion path, not a hand-flipped status — this is the step
    // Allison's ruling 1 is about ("when a seat opens the owner gets an OFFER").
    const promotion = await withActor(TEST_ACTOR, (tx) =>
      promoteForTarget(tx, dayTarget(), FIXTURE_NOW()),
    );
    assert.deepStrictEqual(promotion, { seatsFree: 1, offered: 1 });
    assert.equal((await entryState(entryId)).status, 'offered');

    assert.equal(
      await schoolBalance(FIXTURE_IDS.dog1Id),
      balanceBeforeOffer,
      'a seat opening must not touch the credit balance',
    );
    assert.equal(await paygInvoiceCount(), invoicesBeforeOffer, 'no invoice is raised at offer');
    assert.equal((await bookingIdsOn(SESSION_DAY)).length, 0, 'an offer is not a booking');

    const res = await accept(waitlistApp(), entryId);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(
      await schoolBalance(FIXTURE_IDS.dog1Id),
      balanceBeforeOffer - 1,
      'exactly one credit, and only once the owner said yes',
    );

    await resetState();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /waitlist/:id/accept — the happy paths
// ──────────────────────────────────────────────────────────────────────────

test(
  'accept — 201 + BookingWire, the entry goes accepted and points at the booking it became',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });

    const res = await accept(waitlistApp(), entryId);
    assert.equal(res.statusCode, 201, res.body);
    const wires = res.json() as BookingWireLike[];
    assert.equal(wires.length, 1, 'one session in, one booking out');
    const booking = wires[0];
    assert.equal(booking?.dog_id, FIXTURE_IDS.dog1Id);
    assert.equal(booking?.category, 'day-school');
    assert.equal(booking?.status, 'upcoming');
    assert.equal(booking?.location, LOCATION);
    // A bare accept defaults to the open of the drop-off window: 07:30 Chicago
    // (CDT in May) = 12:30Z on the session date the entry was queued for.
    assert.equal(booking?.date, `${SESSION_DAY}T12:30:00.000Z`);

    const entry = await entryState(entryId);
    assert.equal(entry.status, 'accepted');
    assert.equal(entry.bookingId, booking?.id, 'the entry records what it became');
    assert.notEqual(entry.resolvedAt, null);

    const debits = await db
      .select({ delta: creditLedger.delta, reason: creditLedger.reason })
      .from(creditLedger)
      .where(eq(creditLedger.bookingId, booking?.id ?? ''));
    assert.equal(debits.length, 1, 'one debit per dog per booking');
    assert.equal(debits[0]?.delta, -1);
    assert.equal(debits[0]?.reason, 'booking-debit');

    await resetState();
  },
);

test(
  'accept — payg raises the open invoice, debits no credits, and honors dropoff_time + notes',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    // Deliberately funded: PAYG must not touch credits even when they exist.
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 2);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });

    const res = await accept(waitlistApp(), entryId, {
      body: {
        payment: 'payg',
        payment_method_id: FIXTURE_IDS.paymentMethod1Id,
        dropoff_time: '08:30',
        notes: 'Waffles gets the blue leash',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const booking = (res.json() as BookingWireLike[])[0];
    assert.equal(booking?.date, `${SESSION_DAY}T13:30:00.000Z`, '08:30 CDT drop-off');
    assert.equal(booking?.notes, 'Waffles gets the blue leash');

    assert.equal(
      await schoolBalance(FIXTURE_IDS.dog1Id),
      balanceBefore,
      'PAYG never spends a credit',
    );

    const [invoice] = await db
      .select({
        status: invoices.status,
        purpose: invoices.purpose,
        amountCents: invoices.amountCents,
        paymentMethodId: invoices.paymentMethodId,
        dueAt: invoices.dueAt,
      })
      .from(invoices)
      .where(eq(invoices.bookingId, booking?.id ?? ''));
    assert.equal(invoice?.status, 'open', 'nothing is charged in-band — the worker bills it');
    assert.equal(invoice?.purpose, 'payg');
    assert.equal(invoice?.amountCents, DAY_SCHOOL_FAY_RATE_CENTS);
    assert.equal(invoice?.paymentMethodId, FIXTURE_IDS.paymentMethod1Id);
    assert.equal(
      new Date(invoice?.dueAt ?? 0).toISOString(),
      `${SESSION_DAY}T12:30:00.000Z`,
      'due one hour before drop-off, same as POST /bookings',
    );

    await resetState();
  },
);

test(
  'accept — replaying the Idempotency-Key returns the same booking and moves no more money',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 3);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });

    const key = `wl-accept-${randomUUID()}`;
    const app = waitlistApp();
    const first = await accept(app, entryId, { key });
    const second = await accept(app, entryId, { key });

    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);
    assert.deepStrictEqual(
      second.json(),
      first.json(),
      'a replay returns the stored response, byte for byte',
    );
    assert.equal((await bookingIdsOn(SESSION_DAY)).length, 1, 'one booking across two calls');
    assert.equal(
      await schoolBalance(FIXTURE_IDS.dog1Id),
      balanceBefore - 1,
      'a retry must not double-debit',
    );

    await resetState();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /waitlist/:id/accept — the seat isn't there any more
// ──────────────────────────────────────────────────────────────────────────

test(
  'accept — a lapsed offer books nothing and leaves the entry for the sweep',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      // An hour behind the clock the route runs on: the sweep has not got to it
      // yet, and "the cleanup job is late" must not buy you a seat.
      offerExpiresAt: new Date(FIXTURE_NOW().getTime() - ONE_HOUR_MS),
    });

    const res = await accept(waitlistApp(), entryId);
    // 409 rather than 422: `conflict` is this repo's code for "current state
    // refuses your request" (routes/enrollments.ts withdraw uses it for the
    // same shape). Flagged to the orchestrator — the BEHAVIOUR asserted below
    // is the invariant; only the code is a convention call.
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as ErrorBody).error.code, 'conflict');

    assert.equal((await bookingIdsOn(SESSION_DAY)).length, 0, 'a stale offer books nothing');
    assert.equal(await schoolBalance(FIXTURE_IDS.dog1Id), balanceBefore);
    assert.equal(
      (await entryState(entryId)).status,
      'offered',
      'the refusal rolled back — the sweep, not the accept, expires it',
    );

    await resetState();
  },
);

test(
  'accept — an offer for a session that has already started is refused',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(PAST_DAY, 3);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    // A staff cap-override stamps `now + window` with no clamp to the session,
    // so an offer really can outlive the day it is for. The deadline is LIVE
    // here on purpose — the session-date check is what has to catch this.
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      sessionDate: PAST_DAY,
      offerExpiresAt: new Date(FIXTURE_NOW().getTime() + 24 * ONE_HOUR_MS),
    });

    const res = await accept(waitlistApp(), entryId);
    assert.equal(res.statusCode, 409, res.body);
    assert.match((res.json() as ErrorBody).error.message, /already passed/i);
    assert.equal((await bookingIdsOn(PAST_DAY)).length, 0, 'never book into a day that is gone');

    await resetState();
  },
);

test(
  'accept — a CLOSED day is refused: an override can offer a seat the day does not have',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    // Zero openings is CLOSED, not full — the strongest "there is no seat"
    // signal there is, and exactly what POST /staff/waitlist/:id/offer can
    // override an offer into.
    await seedOpenings(SESSION_DAY, 0);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });

    const res = await accept(waitlistApp(), entryId);
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as ErrorBody).error.code, 'insufficient_capacity');
    assert.equal((await bookingIdsOn(SESSION_DAY)).length, 0);
    assert.equal(await schoolBalance(FIXTURE_IDS.dog1Id), balanceBefore);
    assert.equal((await entryState(entryId)).status, 'offered', 'the owner keeps their place');

    await resetState();
  },
);

test(
  'accept — a two-dog entry with one free seat is refused whole, not split',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    // Both funded, so the refusal below is genuinely about seats: the credit
    // pre-check runs BEFORE the capacity assert inside the creation core.
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    await topUpCredits(FIXTURE_IDS.dog2Id, 'school', 1);
    const dog1Before = await schoolBalance(FIXTURE_IDS.dog1Id);
    const dog2Before = await schoolBalance(FIXTURE_IDS.dog2Id);
    const entryId = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
      status: 'offered',
    });

    const res = await accept(waitlistApp(), entryId);
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as ErrorBody).error.code, 'insufficient_capacity');
    assert.equal(
      (await bookingIdsOn(SESSION_DAY)).length,
      0,
      'half a roster is not a booking anyone asked for',
    );
    assert.equal(await schoolBalance(FIXTURE_IDS.dog1Id), dog1Before);
    assert.equal(await schoolBalance(FIXTURE_IDS.dog2Id), dog2Before);
    assert.equal((await entryState(entryId)).status, 'offered');

    await resetState();
  },
);

test(
  'accept — the same seat offered twice: the second accept is refused, nothing is double-booked',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    await topUpCredits(FIXTURE_IDS.dog2Id, 'school', 1);
    const dog2Before = await schoolBalance(FIXTURE_IDS.dog2Id);
    // Two live offers against ONE seat. Promotion's `countOfferedSeats` exists
    // to stop this, but two staff cap-overrides reach it legitimately — and the
    // second owner must be told no HERE, not shown a booking that isn't real.
    const first = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      createdAt: new Date('2026-05-18T10:00:00Z'),
    });
    const second = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog2Id],
      status: 'offered',
      createdAt: new Date('2026-05-18T11:00:00Z'),
    });

    const app = waitlistApp();
    const firstRes = await accept(app, first);
    assert.equal(firstRes.statusCode, 201, firstRes.body);

    const secondRes = await accept(app, second);
    assert.equal(secondRes.statusCode, 422, secondRes.body);
    assert.equal((secondRes.json() as ErrorBody).error.code, 'insufficient_capacity');

    assert.equal((await bookingIdsOn(SESSION_DAY)).length, 1, 'one seat, one booking');
    assert.equal(await schoolBalance(FIXTURE_IDS.dog2Id), dog2Before, 'the loser paid nothing');
    assert.equal((await entryState(second)).status, 'offered');

    await resetState();
  },
);

test(
  'accept — ruling 5: a vaccine that lapsed after the offer blocks the accept',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });
    // The whole reason the gates re-run: an owner can join a queue in April and
    // be offered a seat in June, and rabies expires in between.
    await db
      .update(dogVaccines)
      .set({ expiredAt: sql`now()` })
      .where(eq(dogVaccines.id, FIXTURE_IDS.vaccine1Id));

    try {
      const res = await accept(waitlistApp(), entryId);
      assert.equal(res.statusCode, 422, res.body);
      assert.equal((res.json() as ErrorBody).error.code, 'vaccine_missing');
      assert.equal((await bookingIdsOn(SESSION_DAY)).length, 0);
      assert.equal(
        (await entryState(entryId)).status,
        'offered',
        'a fixable blocker must not burn the offer',
      );
    } finally {
      await db
        .update(dogVaccines)
        .set({ expiredAt: null })
        .where(eq(dogVaccines.id, FIXTURE_IDS.vaccine1Id));
      await resetState();
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /waitlist/:id/accept — authorization + the 404 collapse
// ──────────────────────────────────────────────────────────────────────────

test(
  'accept — unknown, not-yet-offered and already-resolved entries all 404',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 2);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const app = waitlistApp();

    const unknown = await accept(app, '5e1f0000-0000-4000-8000-0000000000ff');
    assert.equal(unknown.statusCode, 404, unknown.body);

    const waiting = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog2Id], status: 'waiting' });
    const notOffered = await accept(app, waiting);
    assert.equal(notOffered.statusCode, 404, 'you cannot accept a seat nobody offered you');
    assert.equal((await entryState(waiting)).status, 'waiting');

    const offered = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });
    assert.equal((await accept(app, offered)).statusCode, 201);
    // A FRESH key, so this is a genuine second attempt rather than a replay —
    // the status guard, not the idempotency layer, has to reject it.
    const twice = await accept(app, offered);
    assert.equal(twice.statusCode, 404, twice.body);
    assert.equal((await bookingIdsOn(SESSION_DAY)).length, 1, 'still one booking');

    await resetState();
  },
);

test('accept — staff principal → 403, missing Idempotency-Key → 400', SKIP_WHEN_NO_DB, async () => {
  await resetState();
  await seedOpenings(SESSION_DAY, 1);
  const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });

  const staffRes = await accept(waitlistApp(FIXTURE_STAFF_PRINCIPAL), entryId);
  assert.equal(staffRes.statusCode, 403, staffRes.body);

  const noKey = await accept(waitlistApp(), entryId, { omitKey: true });
  assert.equal(noKey.statusCode, 400, noKey.body);

  assert.equal((await entryState(entryId)).status, 'offered');
  await resetState();
});

test(
  'accept — a group-class offer enrolls through the shared cohort core',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    const entryId = await seedCohortEntry();
    const { app } = waitlistAppWithStripe();

    // `lib/createCohortEnrollment.ts` landed (2026-07-31), so the offer
    // `resolveTargetSeats` hands out for a cohort target is now answerable —
    // through the SAME core POST /enrollments runs, not a second copy.
    const res = await accept(app, entryId, {
      body: { payment_method_id: FIXTURE_IDS.paymentMethod1Id, pay_later: true },
    });
    assert.equal(res.statusCode, 201, res.body);
    const wires = res.json() as BookingWireLike[];
    // The fixture puppy cohort runs 4 weeks; one single-dog booking per week.
    assert.equal(wires.length, 4, 'one booking per cohort week');
    for (const wire of wires) {
      assert.equal(wire.dog_id, FIXTURE_IDS.dog1Id);
      assert.equal(wire.category, 'group-class');
    }

    const entry = await entryState(entryId);
    assert.equal(entry.status, 'accepted');
    assert.equal(entry.bookingId, wires[0]?.id, 'the entry points at the first weekly session');

    // The cohort seat is spent: `filled` bumped under the row lock.
    const [cohort] = await db
      .select({ filled: cohorts.filled })
      .from(cohorts)
      .where(eq(cohorts.id, FIXTURE_IDS.cohortPuppyId));
    assert.equal(cohort?.filled, 2, 'fixture puppy cohort was 1/6 before the accept');

    await resetState();
  },
);

test(
  'accept — a group-class offer without a card is refused before any enrollment',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    const entryId = await seedCohortEntry();
    const { app, stripe } = waitlistAppWithStripe();

    // Group-class is money-paid per (cohort, dog) — there is no credits axis to
    // fall back on, so a bare accept cannot pay for the seat.
    const res = await accept(app, entryId);
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as ErrorBody).error.code, 'invalid_payload');
    assert.equal(stripe.calls.length, 0, 'no card is touched');
    assert.equal((await entryState(entryId)).status, 'offered', 'the offer is not consumed');

    await resetState();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// POST /waitlist/:id/decline
// ──────────────────────────────────────────────────────────────────────────

test(
  'decline — 204, the entry goes declined and nothing is booked or charged',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    const invoicesBefore = await paygInvoiceCount();
    const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });

    const res = await decline(waitlistApp(), entryId);
    assert.equal(res.statusCode, 204, res.body);
    assert.equal(res.body, '', 'a terminal resolve returns no envelope');

    const entry = await entryState(entryId);
    assert.equal(entry.status, 'declined');
    assert.equal(entry.bookingId, null);
    assert.notEqual(entry.resolvedAt, null);
    assert.equal((await bookingIdsOn(SESSION_DAY)).length, 0);
    assert.equal(await schoolBalance(FIXTURE_IDS.dog1Id), balanceBefore);
    assert.equal(await paygInvoiceCount(), invoicesBefore);

    await resetState();
  },
);

test('decline — a LAPSED offer is still declinable', SKIP_WHEN_NO_DB, async () => {
  await resetState();
  await seedOpenings(SESSION_DAY, 1);
  const entryId = await seedDayEntry({
    dogIds: [FIXTURE_IDS.dog1Id],
    status: 'offered',
    offerExpiresAt: new Date(FIXTURE_NOW().getTime() - ONE_HOUR_MS),
  });

  // The deliberate asymmetry with accept: "no thanks" is true whether or not
  // the deadline passed, and only accept consumes a seat.
  const res = await decline(waitlistApp(), entryId);
  assert.equal(res.statusCode, 204, res.body);
  assert.equal((await entryState(entryId)).status, 'declined');

  await resetState();
});

test('decline — a waiting entry was never offered → 404', SKIP_WHEN_NO_DB, async () => {
  await resetState();
  const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'waiting' });

  const res = await decline(waitlistApp(), entryId);
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(
    (await entryState(entryId)).status,
    'waiting',
    'declining an offer you never had must not drop you out of the queue',
  );

  await resetState();
});

test(
  'accept and decline racing the same offer — exactly one wins, no orphan booking survives',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    const balanceBefore = await schoolBalance(FIXTURE_IDS.dog1Id);
    const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });

    // Two taps, one entry. `resolve` is conditional on the row still being
    // 'offered', which is what makes the loser roll back — including the
    // booking it had already created.
    const app = waitlistApp();
    const [acceptRes, declineRes] = await Promise.all([
      accept(app, entryId),
      decline(app, entryId),
    ]);

    const winners = [acceptRes, declineRes].filter((r) => r.statusCode < 300);
    assert.equal(
      winners.length,
      1,
      `exactly one resolution may win, got accept=${acceptRes.statusCode} decline=${declineRes.statusCode}`,
    );

    const entry = await entryState(entryId);
    const bookings = await bookingIdsOn(SESSION_DAY);
    if (acceptRes.statusCode === 201) {
      assert.equal(entry.status, 'accepted');
      assert.deepStrictEqual(bookings, [entry.bookingId]);
      assert.equal(await schoolBalance(FIXTURE_IDS.dog1Id), balanceBefore - 1);
    } else {
      assert.equal(entry.status, 'declined');
      assert.equal(entry.bookingId, null);
      assert.equal(bookings.length, 0, 'a losing accept must not leave a booking behind');
      assert.equal(
        await schoolBalance(FIXTURE_IDS.dog1Id),
        balanceBefore,
        'a rolled-back accept must not spend a credit',
      );
    }

    await resetState();
  },
);

// ──────────────────────────────────────────────────────────────────────────
// KNOWN GAPS — these fail on purpose. See the handoff.
// ──────────────────────────────────────────────────────────────────────────

test(
  'decline — KNOWN GAP: the seat the decline frees is never offered to the next dog in line',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    const first = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog1Id],
      status: 'offered',
      createdAt: new Date('2026-05-18T10:00:00Z'),
    });
    const second = await seedDayEntry({
      dogIds: [FIXTURE_IDS.dog2Id],
      status: 'waiting',
      createdAt: new Date('2026-05-18T11:00:00Z'),
    });

    assert.equal((await decline(waitlistApp(), first)).statusCode, 204);

    // The route's own header says the seat "rolls to the next dog in line", and
    // it does not: the `promoteForTarget` call is a TODO. Nothing else picks it
    // up either — `sweepLapsedOffers` only re-promotes targets that had a
    // LAPSED OFFER, and a declined entry is not one, so the second dog waits
    // forever for a seat that is sitting empty.
    assert.equal(
      (await entryState(second)).status,
      'offered',
      'a declined seat must roll to the next in line',
    );

    await resetState();
  },
);

test(
  'accept — KNOWN GAP: books instantly for a dog POST /bookings would divert to staff approval',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetState();
    await seedOpenings(SESSION_DAY, 1);
    await topUpCredits(FIXTURE_IDS.dog1Id, 'school', 1);
    await db.update(dogs).set({ spayedNeutered: false }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));

    try {
      // Control: this roster, today, WOULD be parked for staff eyes by the only
      // other owner-facing create path.
      const reasons = await withActor(TEST_ACTOR, (tx) =>
        resolveApprovalDivert(tx, { dogIds: [FIXTURE_IDS.dog1Id], now: FIXTURE_NOW() }),
      );
      assert.deepStrictEqual(reasons, ['not-spayed-neutered'], 'divert control');

      const entryId = await seedDayEntry({ dogIds: [FIXTURE_IDS.dog1Id], status: 'offered' });
      const res = await accept(waitlistApp(), entryId);

      // `createDayProgramBookings` runs the four gates but NOT
      // `resolveApprovalDivert` — that lives in routes/bookings.ts, and accept
      // does not call it. So the waitlist is a way around the Shanthi-2026-07-14
      // workflow: queue up, take the offer, walk in unreviewed.
      assert.notEqual(
        res.statusCode,
        201,
        'accept must not be a looser path into a booking than POST /bookings',
      );
      assert.equal((await bookingIdsOn(SESSION_DAY)).length, 0);
    } finally {
      await db.update(dogs).set({ spayedNeutered: null }).where(eq(dogs.id, FIXTURE_IDS.dog1Id));
      await resetState();
    }
  },
);
