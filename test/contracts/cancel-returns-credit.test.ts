import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../src/auth/principal.js';
import type { BookingWire, CreditSettingsWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { bookings, creditLedger, dogs, refunds } from '../../src/db/schema/schema.js';
import { bucketChicagoToday } from '../../src/lib/chicagoDate.js';
import { addChicagoMonths } from '../../src/lib/creditExpiry.js';
import { pgTimestampToDate } from '../../src/lib/pgTimestamp.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { registerStaffCheckinRoute } from '../../src/routes/staffCheckin.js';
import { registerStaffSettingsRoute } from '../../src/routes/staffSettings.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
  type LogCapture,
} from './_harness.js';
import { clearPlantedPools, plantLot, poolBalance } from './_poolFixture.js';
import {
  at,
  cancelNotices,
  createSession,
  ledgerOf,
  makeClock,
  ownerCancel,
  ownerDogCancel,
  removeSessions,
  staffCancel,
  staffDogCancel,
  verb,
  type Clock,
} from './_checkinFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * CXL-U04 (P21; design §2.7:4115-4159, D2, D14): no cancel forfeits, and a cancel of an
 * upcoming day session returns one credit per dog still on it and moves no money. §2.7's
 * red-first, verbatim (design.md:4155-4159): "cancel Fri 16 → one `settlement-return`
 * row, zero `refunds` rows, the lot's `expires_at` unchanged; *Didn't come* at 17:31 on a
 * credit day → the same; *Didn't come* at 17:30 on the paying lot's last day → one return
 * row with `lot_id` NULL expiring a month on, and the push names that date; a trainer's
 * staff cancel of a five-dog day → five credits back, 200, no role check."
 *
 * X1 and X4 sit inside 48 hours of their session, where the P20 tree still forfeits a row
 * stamped with a deadline (235(e)); `createSession` stamps one 48 hours before 07:30, as
 * every route did before P21 (contract notes D3). X2 and X3 are P20's settle path (T6),
 * pins proved by a landed mutant each. The dates are a year on from s07's (Thu 14 / Fri
 * 15 Oct 2027, the same weekdays), because `lot_pays_date` reads the database's `now()`
 * and a lot dated 10 Nov 2026 is dead there today; X3's lot must be dead, so its day is the
 * real clock's yesterday.
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

async function named(name: string): Promise<string> {
  const dogId = await createBookableDog(createdDogs);
  await db.update(dogs).set({ name }).where(eq(dogs.id, dogId));
  return dogId;
}

/** The cancel and board routes on one clock, with the Stripe stub held so its calls count. */
function appOf(
  principal: Principal,
  clock: Clock,
  capture?: LogCapture,
): { app: FastifyInstance; stripe: StripeStub } {
  const { app, authenticate } = makeContractApp(principal, capture);
  const stripe = makeStripeStub();
  registerStaffCheckinRoute(app, { authenticate, now: clock.now });
  registerStaffBookingsRoute(app, { authenticate, now: clock.now, stripe });
  registerBookingsRoute(app, { authenticate, now: clock.now, stripe });
  return { app, stripe };
}

function wire(res: { statusCode: number; body: string }): BookingWire {
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as BookingWire;
}

async function refundRowsFor(bookingId: string): Promise<number> {
  const rows = await db.select({ id: refunds.id }).from(refunds).where(eq(refunds.bookingId, bookingId));
  return rows.length;
}

async function lotExpiry(lotId: string): Promise<string> {
  const [row] = await db
    .select({ expiresAt: creditLedger.expiresAt })
    .from(creditLedger)
    .where(eq(creditLedger.id, lotId));
  return pgTimestampToDate(row!.expiresAt!).toISOString();
}

async function forfeitedOnRow(bookingId: string): Promise<boolean> {
  const [row] = await db
    .select({ forfeited: bookings.cancelForfeited })
    .from(bookings)
    .where(eq(bookings.id, bookingId));
  return row!.forfeited;
}

const THU = '2027-10-14';
const FRI = '2027-10-15';
/** The 9 Oct 2027 pack's lot: live at the database, and it pays Fri 15 and later. */
const PACK_EXPIRES = at('2027-11-09', '12:00');

describe("§2.7's red-first: a cancel returns a credit, never money", () => {
  test(
    'X1 (s07): Thu 21:15 the owner cancels the Fri day her pack paid → one settlement-return into that lot, its date unchanged, cancel_forfeited false, zero refunds rows, no Stripe call',
    SKIP_WHEN_NO_DB,
    async () => {
      const pepper = await named('Pepper');
      const pack = await plantLot({ credits: 8, expiresAt: PACK_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: FRI,
        lotId: pack,
        ledger: sessions,
      });
      const before = await poolBalance();
      const { app, stripe } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(at(THU, '21:15')));
      const cancelled = wire(await ownerCancel(app, { bookingId }));
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.cancel_forfeited, false);
      assert.equal(await forfeitedOnRow(bookingId), false);
      const returns = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.deepEqual(
        returns.map((r) => [r.dogId, r.lotId, r.expiresAt]),
        [[pepper, pack, null]],
        'one credit back into the pack, keeping its date',
      );
      assert.equal(await lotExpiry(pack), PACK_EXPIRES.toISOString(), "the lot's expires_at unchanged");
      assert.equal(await poolBalance(), before + 1);
      assert.equal(await refundRowsFor(bookingId), 0);
      assert.deepEqual(stripe.calls, [], 'no Stripe call');
    },
  );

  test(
    'X4: a trainer cancels a five-dog day inside 48 hours → 200, five credits back, no role check, no money',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogIds = [];
      for (const name of ['Pepper', 'Bao', 'Luna', 'Juniper', 'Scout']) dogIds.push(await named(name));
      const pack = await plantLot({ credits: 5, expiresAt: PACK_EXPIRES });
      const { bookingId } = await createSession({ dogIds, date: FRI, lotId: pack, ledger: sessions });
      assert.equal(await poolBalance(), 0);
      const { app, stripe } = appOf(FIXTURE_STAFF_PRINCIPAL, makeClock(at(THU, '21:15')));
      assert.equal(FIXTURE_STAFF_PRINCIPAL.kind === 'staff' && FIXTURE_STAFF_PRINCIPAL.role, 'trainer');
      const cancelled = wire(await staffCancel(app, { bookingId }));
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.cancel_forfeited, false);
      const returns = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.deepEqual(returns.map((r) => r.dogId).sort(), [...dogIds].sort());
      assert.equal(await poolBalance(), 5, 'five credits back');
      assert.equal(await refundRowsFor(bookingId), 0);
      assert.deepEqual(stripe.calls, []);
    },
  );

  test(
    'a row stamped before P21, its cancel_deadline_at already past by SQL → cancelled with its credit back and cancel_forfeited false',
    SKIP_WHEN_NO_DB,
    async () => {
      const pepper = await named('Pepper');
      const pack = await plantLot({ credits: 1, expiresAt: PACK_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: '2027-10-20',
        lotId: pack,
        ledger: sessions,
      });
      await db
        .update(bookings)
        .set({ cancelDeadlineAt: at('2027-10-01', '09:00').toISOString() })
        .where(eq(bookings.id, bookingId));
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(at('2027-10-05', '10:00')));
      const cancelled = wire(await ownerCancel(app, { bookingId }));
      assert.equal(cancelled.cancel_forfeited, false);
      assert.equal(await forfeitedOnRow(bookingId), false);
      assert.equal(
        (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return').length,
        1,
      );
      assert.equal(await poolBalance(), 1);
    },
  );

  test(
    "X2, a pin: Didn't come at 17:31 on a credit day → the same: one return into its lot, the lot's date unchanged, zero refunds rows",
    SKIP_WHEN_NO_DB,
    async () => {
      const pepper = await named('Pepper');
      const pack = await plantLot({ credits: 3, expiresAt: PACK_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: FRI,
        lotId: pack,
        ledger: sessions,
      });
      const { app, stripe } = appOf(FIXTURE_STAFF_PRINCIPAL, makeClock(at(FRI, '17:31')));
      const res = await verb(app, { bookingId, dogId: pepper, verb: 'no-show' });
      assert.equal(res.statusCode, 200, res.body);
      const returns = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.deepEqual(
        returns.map((r) => [r.lotId, r.expiresAt]),
        [[pack, null]],
        'into the pack, which can still pay a later date',
      );
      assert.equal(await lotExpiry(pack), PACK_EXPIRES.toISOString());
      assert.equal(await refundRowsFor(bookingId), 0);
      assert.deepEqual(stripe.calls, []);
    },
  );

  test(
    "X3, a pin: Didn't come at 17:30 on the paying lot's last day → one return with lot_id NULL expiring a month on, and the notice names that date",
    SKIP_WHEN_NO_DB,
    async () => {
      const day = bucketChicagoToday(new Date(Date.now() - 86_400_000));
      const pepper = await named('Pepper');
      const lotI = await plantLot({ credits: 1, expiresAt: at(day, '09:40') });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: day,
        lotId: lotI,
        ledger: sessions,
      });
      const { app, stripe } = appOf(FIXTURE_STAFF_PRINCIPAL, makeClock(at(day, '17:30')));
      const res = await verb(app, { bookingId, dogId: pepper, verb: 'no-show' });
      assert.equal(res.statusCode, 200, res.body);
      const fresh = addChicagoMonths(at(day, '17:30'), 1);
      const returns = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.equal(returns.length, 1);
      assert.equal(returns[0]?.lotId, null, 'a fresh one-credit lot, not the dead lot I');
      assert.equal(pgTimestampToDate(returns[0]!.expiresAt!).toISOString(), fresh.toISOString());
      const { rows } = await db.execute(sql`
        SELECT body FROM notifications
         WHERE owner_id = ${FIXTURE_IDS.ownerId} AND deep_link_id = ${bookingId}`);
      const date = fresh.toLocaleDateString('en-GB', {
        timeZone: 'America/Chicago',
        day: 'numeric',
        month: 'short',
      });
      assert.deepEqual(
        (rows as { body: string }[]).map((r) => r.body),
        [`Pepper didn't come today. +1 credit, back to your Bentonville day-school credits (expires ${date}).`],
      );
      assert.equal(await refundRowsFor(bookingId), 0);
      assert.deepEqual(stripe.calls, []);
    },
  );
});

/**
 * P21 fix 1, M1 (Opus r1 M1; Fable r1 L1's outlives half; design §2.4:2958-2964): "A return
 * whose lot can pay no date after today — already past its date, or passing it before
 * midnight, since a lot pays its own last day and dies that day — is written instead as a
 * fresh one-credit lot". A returned credit is unbooked, so a lot dying tonight would take
 * it: `cred.booking_outlives_lot_expiry_enabled`, which lets a BOOKING outlive its lot,
 * plays no part. The return goes into its lot only at key 0, with expiry enforcement off, or
 * while the lot expires after the next Chicago midnight. The switch is set as Shanthi or
 * Amber would set it, through `PATCH /staff/settings/cred` by a manager (probe-q6's road).
 *
 * The dates are Mon 18 / Wed 20 Oct 2027, a year on like the rest of this file, so every lot
 * here is alive at the database's own `now()`: the lot "dying 16:57 today" is one the old
 * rule (`lot_pays_date`, which reads that `now()`) took for a lot that can still pay a date.
 * Its death is then read off the row: a return's `lot_id` NULL and its own `expires_at` a
 * month on is a credit that outlives the lot; `lot_id` naming the lot is one that dies with it.
 */
describe("M1: with the outlives switch on, a credit returned on its lot's last day takes a fresh lot", () => {
  const MON = '2027-10-18';
  const WED = '2027-10-20';
  const NOW = at(MON, '14:57');
  const DIES_TODAY = at(MON, '16:57');
  const FRESH = addChicagoMonths(NOW, 1);

  afterEach(async () => {
    await db.execute(sql`
      UPDATE credit_settings
         SET booking_outlives_lot_expiry_enabled = false, expiry_enforced_enabled = true,
             returned_credit_expiry_months = 1, updated_by_staff_id = NULL`);
  });

  /** A manager's `PATCH /staff/settings/cred`, answered 200 with the body it sent. */
  async function patchCred(body: Partial<CreditSettingsWire>): Promise<void> {
    const { app, authenticate } = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
    registerStaffSettingsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'PATCH',
      url: '/staff/settings/cred',
      headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    assert.equal(res.statusCode, 200, res.body);
    const saved = res.json<CreditSettingsWire>();
    for (const [key, value] of Object.entries(body)) {
      assert.equal(saved[key as keyof CreditSettingsWire], value, `${key} saved`);
    }
  }

  async function sheetDate(app: FastifyInstance, bookingId: string, dogId: string) {
    const res = await app.inject({ method: 'GET', url: `/bookings/${bookingId}` });
    const share = wire(res).dog_shares?.find((s) => s.dog_id === dogId);
    assert.ok(share, `${dogId} has no share`);
    return share.return_expires_at;
  }

  /** Each return a session wrote, as [dog, the lot it went into, its own date]. */
  async function returnsOf(bookingId: string) {
    return (await ledgerOf(bookingId))
      .filter((r) => r.reason === 'settlement-return')
      .map((r) => [
        r.dogId,
        r.lotId,
        r.expiresAt === null ? null : pgTimestampToDate(r.expiresAt).toISOString(),
      ]);
  }

  test(
    "the owner's whole-session cancel at 14:57 of a Wed her lot paid, the lot dying 16:57 today → the sheet names a month on; one return as a fresh lot dated now + 1 month, outliving the lot; the notice names that date",
    SKIP_WHEN_NO_DB,
    async () => {
      await patchCred({ booking_outlives_lot_expiry_enabled: true });
      const pepper = await named('Pepper');
      const lot = await plantLot({ credits: 1, expiresAt: DIES_TODAY });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: WED,
        lotId: lot,
        ledger: sessions,
      });
      const { app, stripe } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      const sheet = await sheetDate(app, bookingId, pepper);
      wire(await ownerCancel(app, { bookingId }));
      assert.deepEqual(
        {
          sheet,
          returns: await returnsOf(bookingId),
          notices: (await cancelNotices([bookingId])).map((n) => n.body),
        },
        {
          sheet: FRESH.toISOString(),
          returns: [[pepper, null, FRESH.toISOString()]],
          notices: [
            `You cancelled Pepper's day school, Wed 20 Oct. +1 credit, back to your Bentonville day-school credits (expires ${shown(FRESH)}).`,
          ],
        },
        "return_expires_at, the return's landing and the notice: a fresh one-credit lot a month on, never the lot that dies at 16:57",
      );
      assert.ok(FRESH > DIES_TODAY, 'the credit outlives the lot');
      assert.equal(await lotExpiry(lot), DIES_TODAY.toISOString(), "the lot's own date unchanged");
      assert.equal(await refundRowsFor(bookingId), 0);
      assert.deepEqual(stripe.calls, []);
    },
  );

  test(
    "the owner's one-dog cancel of Luna, the same lot dying 16:57 → her sheet names a month on; her return a fresh lot; Bao's debit stays",
    SKIP_WHEN_NO_DB,
    async () => {
      await patchCred({ booking_outlives_lot_expiry_enabled: true });
      const bao = await named('Bao');
      const luna = await named('Luna');
      const lot = await plantLot({ credits: 2, expiresAt: DIES_TODAY });
      const { bookingId } = await createSession({
        dogIds: [bao, luna],
        date: WED,
        lotId: lot,
        ledger: sessions,
      });
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      const sheet = await sheetDate(app, bookingId, luna);
      wire(await ownerDogCancel(app, { bookingId, dogId: luna }));
      assert.deepEqual(
        { sheet, returns: await returnsOf(bookingId) },
        { sheet: FRESH.toISOString(), returns: [[luna, null, FRESH.toISOString()]] },
        "Luna's return_expires_at and her return's landing",
      );
      assert.deepEqual(
        (await ledgerOf(bookingId))
          .filter((r) => r.reason === 'booking-debit')
          .map((r) => r.dogId)
          .sort(),
        [bao, luna].sort(),
        'both debits stand; only Luna has a return',
      );
    },
  );

  test(
    "X3 with the switch on: Didn't come at 17:30 on the paying lot's last day, the lot dying 22:00 tonight → one return with lot_id NULL expiring a month on, and the notice names that date",
    SKIP_WHEN_NO_DB,
    async () => {
      await patchCred({ booking_outlives_lot_expiry_enabled: true });
      const pepper = await named('Pepper');
      const lot = await plantLot({ credits: 1, expiresAt: at(MON, '22:00') });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: MON,
        lotId: lot,
        ledger: sessions,
      });
      const door = at(MON, '17:30');
      const { app, stripe } = appOf(FIXTURE_STAFF_PRINCIPAL, makeClock(door));
      const res = await verb(app, { bookingId, dogId: pepper, verb: 'no-show' });
      assert.equal(res.statusCode, 200, res.body);
      const fresh = addChicagoMonths(door, 1);
      assert.deepEqual(await returnsOf(bookingId), [[pepper, null, fresh.toISOString()]]);
      const { rows } = await db.execute(sql`
        SELECT body FROM notifications
         WHERE owner_id = ${FIXTURE_IDS.ownerId} AND deep_link_id = ${bookingId}`);
      assert.deepEqual(
        (rows as { body: string }[]).map((r) => r.body),
        [
          `Pepper didn't come today. +1 credit, back to your Bentonville day-school credits (expires ${shown(fresh)}).`,
        ],
      );
      assert.equal(await refundRowsFor(bookingId), 0);
      assert.deepEqual(stripe.calls, []);
    },
  );

  test(
    'the switch on, a lot expiring exactly at the next Chicago midnight (Tue 00:00) → a fresh lot: it pays no date after today',
    SKIP_WHEN_NO_DB,
    async () => {
      await patchCred({ booking_outlives_lot_expiry_enabled: true });
      const pepper = await named('Pepper');
      const lot = await plantLot({ credits: 1, expiresAt: at('2027-10-19', '00:00') });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: WED,
        lotId: lot,
        ledger: sessions,
      });
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      const sheet = await sheetDate(app, bookingId, pepper);
      wire(await ownerCancel(app, { bookingId }));
      assert.deepEqual(
        { sheet, returns: await returnsOf(bookingId) },
        { sheet: FRESH.toISOString(), returns: [[pepper, null, FRESH.toISOString()]] },
      );
    },
  );

  test(
    'a pin, the switch on: a lot that lives past tonight (Tue 09:40) still takes its credit back, keeping its date',
    SKIP_WHEN_NO_DB,
    async () => {
      await patchCred({ booking_outlives_lot_expiry_enabled: true });
      const pepper = await named('Pepper');
      const tuesday = at('2027-10-19', '09:40');
      const lot = await plantLot({ credits: 1, expiresAt: tuesday });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: WED,
        lotId: lot,
        ledger: sessions,
      });
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      assert.equal(await sheetDate(app, bookingId, pepper), tuesday.toISOString());
      wire(await ownerCancel(app, { bookingId }));
      assert.deepEqual(await returnsOf(bookingId), [[pepper, lot, null]]);
    },
  );

  test(
    "a pin, the switch at its seed (off): the same lot dying 16:57 → the same fresh lot (probe-q6's control)",
    SKIP_WHEN_NO_DB,
    async () => {
      await patchCred({ booking_outlives_lot_expiry_enabled: false });
      const pepper = await named('Pepper');
      const lot = await plantLot({ credits: 1, expiresAt: DIES_TODAY });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: WED,
        lotId: lot,
        ledger: sessions,
      });
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      assert.equal(await sheetDate(app, bookingId, pepper), FRESH.toISOString());
      wire(await ownerCancel(app, { bookingId }));
      assert.deepEqual(await returnsOf(bookingId), [[pepper, null, FRESH.toISOString()]]);
    },
  );

  test(
    'a pin, key 0 with the switch on: the credit goes back into the lot dying 16:57, and the sheet names that date',
    SKIP_WHEN_NO_DB,
    async () => {
      await patchCred({ booking_outlives_lot_expiry_enabled: true });
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
      const pepper = await named('Pepper');
      const lot = await plantLot({ credits: 1, expiresAt: DIES_TODAY });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: WED,
        lotId: lot,
        ledger: sessions,
      });
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      assert.equal(await sheetDate(app, bookingId, pepper), DIES_TODAY.toISOString());
      wire(await ownerCancel(app, { bookingId }));
      assert.deepEqual(await returnsOf(bookingId), [[pepper, lot, null]]);
    },
  );

  test(
    "a pin, expiry enforcement off: the credit goes back into its lot, whose 09:40 date passed this morning, and the sheet names the lot's date",
    SKIP_WHEN_NO_DB,
    async () => {
      await patchCred({ expiry_enforced_enabled: false });
      const pepper = await named('Pepper');
      const passed = at(MON, '09:40');
      const lot = await plantLot({ credits: 1, expiresAt: passed });
      const { bookingId } = await createSession({
        dogIds: [pepper],
        date: WED,
        lotId: lot,
        ledger: sessions,
      });
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      assert.equal(await sheetDate(app, bookingId, pepper), passed.toISOString());
      wire(await ownerCancel(app, { bookingId }));
      assert.deepEqual(await returnsOf(bookingId), [[pepper, lot, null]]);
    },
  );
});

describe('the alarm, through the route, inside 48 hours (design §2.3:2502-2505)', () => {
  test(
    "the whole-session cancel Thu 21:15 of a Fri day whose live share holds no live debit → 500 and one alarm naming the booking and the dog; nothing moves",
    SKIP_WHEN_NO_DB,
    async () => {
      const ghost = await named('Ghost');
      const luna = await named('Luna');
      const pack = await plantLot({ credits: 1, expiresAt: PACK_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [ghost, luna],
        date: FRI,
        lots: [null, pack],
        ledger: sessions,
      });
      const capture = makeLogCapture();
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(at(THU, '21:15')), capture);
      const res = await ownerCancel(app, { bookingId });
      assert.equal(res.statusCode, 500, res.body);
      const alarms = capture.lines.filter((l) => l.level === 50 && l.bookingId === bookingId);
      assert.deepEqual(
        alarms.map((l) => l.dogId),
        [ghost],
      );
      assert.deepEqual(
        (await ledgerOf(bookingId)).map((r) => r.reason),
        ['booking-debit'],
      );
      const [row] = await db
        .select({ status: bookings.status })
        .from(bookings)
        .where(inArray(bookings.id, [bookingId]));
      assert.equal(row?.status, 'upcoming', 'rolled back');
    },
  );
});

/** §2.9's credit line's date: the day and month in Chicago, as the notice prints it. */
function shown(at: Date): string {
  return at.toLocaleDateString('en-GB', { timeZone: 'America/Chicago', day: 'numeric', month: 'short' });
}

describe("B-5 (NOTIF-U17): every cancel's notice says who, and only what came back", () => {
  const LINE = `+1 credit, back to your Bentonville day-school credits (expires ${shown(PACK_EXPIRES)})`;

  test(
    "the owner's whole session (X1's): who, and the credit line read from the lot it went back to",
    SKIP_WHEN_NO_DB,
    async () => {
      const pepper = await named('Pepper');
      const pack = await plantLot({ credits: 8, expiresAt: PACK_EXPIRES });
      const { bookingId } = await createSession({ dogIds: [pepper], date: FRI, lotId: pack, ledger: sessions });
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(at(THU, '21:15')));
      wire(await ownerCancel(app, { bookingId }));
      assert.deepEqual(
        (await cancelNotices([bookingId])).map((n) => n.body),
        [`You cancelled Pepper's day school, Fri 15 Oct. ${LINE}.`],
      );
    },
  );

  test(
    "a staff cancel of the whole session quotes the staff reason verbatim; with none, no quote",
    SKIP_WHEN_NO_DB,
    async () => {
      const ICE = 'Bentonville is closed Friday for ice';
      const pepper = await named('Pepper');
      const scout = await named('Scout');
      const pack = await plantLot({ credits: 2, expiresAt: PACK_EXPIRES });
      const quoted = await createSession({ dogIds: [pepper], date: FRI, lotId: pack, ledger: sessions });
      const bare = await createSession({ dogIds: [scout], date: FRI, lotId: pack, ledger: sessions });
      const { app } = appOf(FIXTURE_STAFF_PRINCIPAL, makeClock(at(THU, '21:15')));
      wire(await staffCancel(app, { bookingId: quoted.bookingId, reason: ICE }));
      wire(await staffCancel(app, { bookingId: bare.bookingId }));
      assert.deepEqual(
        (await cancelNotices([quoted.bookingId])).map((n) => n.body),
        [`The school cancelled Pepper's day school on Fri 15 Oct: "${ICE}". ${LINE}.`],
      );
      assert.deepEqual(
        (await cancelNotices([bare.bookingId])).map((n) => n.body),
        [`The school cancelled Scout's day school on Fri 15 Oct. ${LINE}.`],
      );
    },
  );

  test(
    "a pin (Opus r1 L3, mutant MA): Luna cancelled alone first, then the owner's whole-session cancel names Bao alone, never Luna again",
    SKIP_WHEN_NO_DB,
    async () => {
      const bao = await named('Bao');
      const luna = await named('Luna');
      const pack = await plantLot({ credits: 2, expiresAt: PACK_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [bao, luna],
        date: FRI,
        lotId: pack,
        ledger: sessions,
      });
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(at(THU, '21:15')));
      wire(await ownerDogCancel(app, { bookingId, dogId: luna }));
      wire(await ownerCancel(app, { bookingId }));
      assert.deepEqual(
        (await cancelNotices([bookingId])).map((n) => n.body),
        [
          `You cancelled Luna's day school, Fri 15 Oct. ${LINE}.`,
          `You cancelled Bao's day school, Fri 15 Oct. ${LINE}.`,
        ],
      );
    },
  );

  test("a staff cancel of one dog quotes its reason and names her alone", SKIP_WHEN_NO_DB, async () => {
    const bao = await named('Bao');
    const luna = await named('Luna');
    const pack = await plantLot({ credits: 2, expiresAt: PACK_EXPIRES });
    const { bookingId } = await createSession({ dogIds: [bao, luna], date: FRI, lotId: pack, ledger: sessions });
    const { app } = appOf(FIXTURE_STAFF_PRINCIPAL, makeClock(at(THU, '21:15')));
    wire(await staffDogCancel(app, { bookingId, dogId: luna, reason: 'Luna is limping' }));
    assert.deepEqual(
      (await cancelNotices([bookingId])).map((n) => n.body),
      [`The school cancelled Luna's day school on Fri 15 Oct: "Luna is limping". ${LINE}.`],
    );
  });

  test(
    'two dogs on two lots of two dates: one credit line per landing, each true; two on one lot: +2 credits',
    SKIP_WHEN_NO_DB,
    async () => {
      const LATER = at('2027-12-01', '12:00');
      const bao = await named('Bao');
      const luna = await named('Luna');
      const pack = await plantLot({ credits: 3, expiresAt: PACK_EXPIRES });
      const later = await plantLot({ credits: 1, expiresAt: LATER });
      const split = await createSession({ dogIds: [bao, luna], date: FRI, lots: [pack, later], ledger: sessions });
      const both = await createSession({ dogIds: [bao, luna], date: '2027-10-22', lotId: pack, ledger: sessions });
      const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(at(THU, '21:15')));
      wire(await ownerCancel(app, { bookingId: split.bookingId }));
      wire(await ownerCancel(app, { bookingId: both.bookingId }));
      assert.deepEqual(
        (await cancelNotices([split.bookingId])).map((n) => n.body),
        [
          `You cancelled Bao and Luna's day school, Fri 15 Oct. ${LINE}. +1 credit, back to your Bentonville day-school credits (expires ${shown(LATER)}).`,
        ],
      );
      assert.deepEqual(
        (await cancelNotices([both.bookingId])).map((n) => n.body),
        [
          `You cancelled Bao and Luna's day school, Fri 22 Oct. +2 credits, back to your Bentonville day-school credits (expires ${shown(PACK_EXPIRES)}).`,
        ],
      );
    },
  );

  test(
    "at cred.returned_credit_expiry_months 0 a credit returned into a dead lot reads §2.9's dead-lot line, never '+1 … (expires …)'",
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
      try {
        const died = at(bucketChicagoToday(new Date(Date.now() - 86_400_000)), '09:40');
        const pepper = await named('Pepper');
        const lotI = await plantLot({ credits: 1, expiresAt: died });
        const { bookingId } = await createSession({ dogIds: [pepper], date: FRI, lotId: lotI, ledger: sessions });
        const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(at(THU, '21:15')));
        wire(await ownerCancel(app, { bookingId }));
        assert.deepEqual(
          (await cancelNotices([bookingId])).map((n) => n.body),
          [
            `You cancelled Pepper's day school, Fri 15 Oct. 1 credit came back, but its date, ${shown(died)}, has passed. Message us if you'd like it extended.`,
          ],
        );
      } finally {
        await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 1`);
      }
    },
  );

  test('no cancel notice names money', SKIP_WHEN_NO_DB, async () => {
    const pepper = await named('Pepper');
    const pack = await plantLot({ credits: 1, expiresAt: PACK_EXPIRES });
    const { bookingId } = await createSession({ dogIds: [pepper], date: FRI, lotId: pack, ledger: sessions });
    const { app } = appOf(FIXTURE_OWNER_PRINCIPAL, makeClock(at(THU, '21:15')));
    wire(await ownerCancel(app, { bookingId }));
    for (const { body } of await cancelNotices([bookingId])) {
      assert.doesNotMatch(body, /\$|refund|money/i);
    }
  });
});
