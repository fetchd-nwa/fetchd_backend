import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { BookingWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { bookings, dogs } from '../../src/db/schema/schema.js';
import { addChicagoMonths } from '../../src/lib/creditExpiry.js';
import { pgTimestampToDate } from '../../src/lib/pgTimestamp.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  registerFixtureHooks,
} from './_harness.js';
import { clearPlantedPools, plantLot } from './_poolFixture.js';
import {
  at,
  boardApp,
  createSession,
  ledgerOf,
  makeClock,
  ownerCancel,
  ownerDogCancel,
  removeSessions,
  verb,
} from './_checkinFixture.js';

/**
 * D1 (P21; CXL-U05's server half; design §2.3:2741-2748, §2.7:4412-4414):
 * `dog_shares[].return_expires_at`, on each share still on an `'upcoming'` session whose
 * credit has not come back, on `can_cancel`'s clock: her live debit's lot's date while that
 * lot can pay a date after today; else the fresh lot's, now plus
 * `cred.returned_credit_expiry_months`; else, at 0, the lot's own, before the next Chicago
 * midnight. One rule, the return writer's own: the sheet and the credit cannot drift.
 *
 * D1's example is the Nguyens on Mon 19 Oct 2026 at 06:50. Here it runs a year on, Mon 18
 * Oct 2027 06:50 (the same weekdays), because `lot_pays_date` reads the database's own
 * `now()` and a lot dated 10 Nov 2026 is dead there today; lot I "dies today 09:40" is
 * 09:40 on the clock's Monday.
 */

registerFixtureHooks();
const createdDogs: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 1`);
  await removeSessions(sessions.splice(0));
  await clearPlantedPools();
});
after(async () => {
  await removeDogs(createdDogs);
});

const MON = '2027-10-18';
const WED = '2027-10-20';
const NOW = at(MON, '06:50');
const NOV_10 = at('2027-11-10', '12:00');
const LOT_I_DIES = at(MON, '09:40');

async function named(name: string): Promise<string> {
  const dogId = await createBookableDog(createdDogs);
  await db.update(dogs).set({ name }).where(eq(dogs.id, dogId));
  return dogId;
}

function read(app: ReturnType<typeof boardApp>, bookingId: string) {
  return app
    .inject({ method: 'GET', url: `/bookings/${bookingId}` })
    .then((res) => {
      assert.equal(res.statusCode, 200, res.body);
      return res.json<BookingWire>();
    });
}

function shareOf(wire: BookingWire, dogId: string) {
  const share = wire.dog_shares?.find((s) => s.dog_id === dogId);
  assert.ok(share, `${dogId} has no share`);
  return share;
}

const chicagoDay = (at: Date | string) =>
  new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

/** The written return's own date: its fresh lot's, or the lot it went back into. */
async function returnedExpiry(bookingId: string, dogId: string): Promise<string> {
  const { rows } = await db.execute(sql`
    SELECT lot.expires_at AS "expiresAt"
      FROM credit_ledger r JOIN credit_ledger lot ON lot.id = COALESCE(r.lot_id, r.id)
     WHERE r.booking_id = ${bookingId} AND r.dog_id = ${dogId} AND r.reason = 'settlement-return'`);
  assert.equal(rows.length, 1);
  return pgTimestampToDate((rows[0] as { expiresAt: string }).expiresAt).toISOString();
}

describe("D1's three cases, read then cancelled: the sheet's date is the credit's", () => {
  test(
    "Luna's Wed, paid from a lot that dies 10 Nov → 10 Nov; cancelled, her return carries 10 Nov",
    SKIP_WHEN_NO_DB,
    async () => {
      const luna = await named('Luna');
      const lot = await plantLot({ credits: 3, expiresAt: NOV_10 });
      const { bookingId } = await createSession({ dogIds: [luna], date: WED, lotId: lot, ledger: sessions });
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      const sheet = shareOf(await read(owner, bookingId), luna).return_expires_at;
      assert.equal(sheet, NOV_10.toISOString());
      assert.equal((await ownerCancel(owner, { bookingId })).statusCode, 200);
      assert.equal(chicagoDay(await returnedExpiry(bookingId, luna)), chicagoDay(sheet!));
    },
  );

  test(
    "today's day, paid from lot I that dies today 09:40 → the fresh lot's date, a month on (Thu 18 Nov 06:50); cancelled, the same day",
    SKIP_WHEN_NO_DB,
    async () => {
      const luna = await named('Luna');
      const lotI = await plantLot({ credits: 1, expiresAt: LOT_I_DIES });
      const { bookingId } = await createSession({ dogIds: [luna], date: MON, lotId: lotI, ledger: sessions });
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      const sheet = shareOf(await read(owner, bookingId), luna).return_expires_at;
      assert.equal(sheet, addChicagoMonths(NOW, 1).toISOString(), 'now plus the key, 1');
      assert.equal(chicagoDay(sheet!), '2027-11-18');
      assert.equal((await ownerCancel(owner, { bookingId })).statusCode, 200);
      assert.equal(chicagoDay(await returnedExpiry(bookingId, luna)), chicagoDay(sheet!));
    },
  );

  test(
    "with the key at 0 → lot I's own 09:40 today, before the next Chicago midnight (the dead case); cancelled, into lot I",
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
      const luna = await named('Luna');
      const lotI = await plantLot({ credits: 1, expiresAt: LOT_I_DIES });
      const { bookingId } = await createSession({ dogIds: [luna], date: MON, lotId: lotI, ledger: sessions });
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
      const sheet = shareOf(await read(owner, bookingId), luna).return_expires_at;
      assert.equal(sheet, LOT_I_DIES.toISOString());
      assert.ok(new Date(sheet!) < at('2027-10-19', '00:00'), 'before the next Chicago midnight');
      assert.equal((await ownerCancel(owner, { bookingId })).statusCode, 200);
      assert.equal(await returnedExpiry(bookingId, luna), LOT_I_DIES.toISOString());
    },
  );

  test('two dogs on two lots: each share names its own lot', SKIP_WHEN_NO_DB, async () => {
    const bao = await named('Bao');
    const luna = await named('Luna');
    const later = at('2027-12-01', '12:00');
    const baoLot = await plantLot({ credits: 1, expiresAt: NOV_10 });
    const lunaLot = await plantLot({ credits: 1, expiresAt: later });
    const { bookingId } = await createSession({
      dogIds: [bao, luna],
      date: WED,
      lots: [baoLot, lunaLot],
      ledger: sessions,
    });
    const wire = await read(boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW)), bookingId);
    assert.equal(shareOf(wire, bao).return_expires_at, NOV_10.toISOString());
    assert.equal(shareOf(wire, luna).return_expires_at, later.toISOString());
  });
});

describe('absent where no credit is waiting to come back', () => {
  test('a share cancelled alone, a cancelled session and a payment-pending row carry none', SKIP_WHEN_NO_DB, async () => {
    const bao = await named('Bao');
    const luna = await named('Luna');
    const lot = await plantLot({ credits: 4, expiresAt: NOV_10 });
    const pair = await createSession({ dogIds: [bao, luna], date: WED, lotId: lot, ledger: sessions });
    const solo = await createSession({ dogIds: [bao], date: '2027-10-21', lotId: lot, ledger: sessions });
    const pending = await createSession({
      dogIds: [bao],
      date: '2027-10-22',
      lotId: lot,
      status: 'payment-pending',
      ledger: sessions,
    });
    const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(NOW));
    assert.equal((await ownerDogCancel(owner, { bookingId: pair.bookingId, dogId: luna })).statusCode, 200);
    const afterOne = await read(owner, pair.bookingId);
    assert.ok(shareOf(afterOne, bao).return_expires_at, 'Bao still on it: present');
    assert.equal(shareOf(afterOne, luna).return_expires_at, undefined, 'Luna cancelled alone');
    assert.equal((await ownerCancel(owner, { bookingId: solo.bookingId })).statusCode, 200);
    assert.equal(shareOf(await read(owner, solo.bookingId), bao).return_expires_at, undefined);
    const pendingRead = await read(owner, pending.bookingId);
    assert.equal(pendingRead.status, 'payment-pending');
    assert.equal(shareOf(pendingRead, bao).return_expires_at, undefined);
  });
});

describe("the share's live debit, not its first: after a re-check-in's re-debit", () => {
  test(
    "debited from R, returned at a ticked 11:00 check-out, R's credit spent, re-debited at 14:30 from J → the sheet names J's date, never R's",
    SKIP_WHEN_NO_DB,
    async () => {
      const day = '2027-10-13';
      const pepper = await named('Pepper');
      const lotR = await plantLot({ credits: 1, expiresAt: at('2027-11-30', '12:00') });
      const lotJ = await plantLot({ credits: 1, expiresAt: at('2028-01-31', '12:00') });
      const { bookingId } = await createSession({ dogIds: [pepper], date: day, lotId: lotR, ledger: sessions });
      const clock = makeClock(at(day, '07:30'));
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      assert.equal((await verb(staff, { bookingId, dogId: pepper, verb: 'check-in' })).statusCode, 200);
      clock.set(at(day, '11:00'));
      const out = await verb(staff, { bookingId, dogId: pepper, verb: 'check-out', body: { reissue_credit: true } });
      assert.equal(out.statusCode, 200, out.body);
      await createSession({ dogIds: [pepper], date: '2027-10-27', lotId: lotR, ledger: sessions });
      clock.set(at(day, '14:30'));
      assert.equal((await verb(staff, { bookingId, dogId: pepper, verb: 'check-in' })).statusCode, 200);
      assert.deepEqual(
        (await ledgerOf(bookingId)).map((r) => [r.reason, r.lotId]),
        [
          ['booking-debit', lotR],
          ['settlement-return', lotR],
          ['booking-debit', lotJ],
        ],
      );
      const [row] = await db.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, bookingId));
      assert.equal(row?.status, 'upcoming');
      const wire = await read(boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at(day, '14:31'))), bookingId);
      assert.equal(shareOf(wire, pepper).return_expires_at, at('2028-01-31', '12:00').toISOString());
    },
  );
});
