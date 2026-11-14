import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type {
  AttendanceWire,
  CheckinBoardWire,
  CheckinEventWire,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { pool } from '../../src/db/pool.js';
import { creditsInvalidationPattern } from '../../src/db/repositories/creditsRepository.js';
import { dogVaccines, dogs } from '../../src/db/schema/schema.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { addChicagoMonths } from '../../src/lib/creditExpiry.js';
import { pgTimestampToDate } from '../../src/lib/pgTimestamp.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { clearPlantedPools, plantLot, poolBalance } from './_poolFixture.js';
import {
  at,
  boardApp,
  cancelNotices,
  createSession,
  eventsOf,
  ledgerOf,
  makeClock,
  plantAtEventStamp,
  refusal,
  removeSessions,
  verb,
} from './_checkinFixture.js';

/**
 * S29's board verbs, check-in, check-out and undo, and the board read (B1-2, B1-3;
 * design §2.3:2354-2418, the red-first at :2455-2476). Tue 13 Oct 2026 is the session's
 * day throughout, Bentonville day school, a lot that pays every date here.
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

const DAY = '2026-10-13';
const NEXT_DAY = '2026-10-14';
const LOT_EXPIRES = at('2027-06-01', '12:00');

async function pepper(name = 'Pepper'): Promise<string> {
  const dogId = await createBookableDog(createdDogs);
  await db.update(dogs).set({ name }).where(eq(dogs.id, dogId));
  return dogId;
}

async function lastSeenOn(dogId: string): Promise<string | null> {
  const [row] = await db.select({ d: dogs.lastSeenOn }).from(dogs).where(eq(dogs.id, dogId));
  return row?.d ?? null;
}

function attendance(res: { statusCode: number; body: string }): AttendanceWire {
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as AttendanceWire;
}

describe('R2, R3: the steps and the clock', () => {
  test(
    'R2: check in, check out, undo, undo → expected, last_seen_on back at 9 Jul',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      await db.update(dogs).set({ lastSeenOn: '2026-07-09' }).where(eq(dogs.id, dogId));
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '07:35'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);

      const checkedIn = attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      assert.equal(checkedIn.status, 'in');
      assert.equal(await lastSeenOn(dogId), DAY);

      clock.set(at(DAY, '16:45'));
      assert.equal(
        attendance(await verb(app, { bookingId, dogId, verb: 'check-out' })).status,
        'out',
      );
      clock.set(at(DAY, '16:46'));
      const firstUndo = attendance(await verb(app, { bookingId, dogId, verb: 'undo' }));
      assert.equal(firstUndo.status, 'in');
      assert.equal(await lastSeenOn(dogId), DAY, 'undoing the check-out leaves the clock');
      const secondUndo = attendance(await verb(app, { bookingId, dogId, verb: 'undo' }));
      assert.equal(secondUndo.status, 'expected');
      assert.deepEqual(
        secondUndo.events.map((e) => e.kind),
        ['check-in', 'check-out', 'undo', 'undo'],
      );
      const [checkIn, checkOut, undo1, undo2] = secondUndo.events as CheckinEventWire[];
      assert.equal(undo1?.undoes_event_id, checkOut?.id);
      assert.equal(undo2?.undoes_event_id, checkIn?.id);
      assert.equal(await lastSeenOn(dogId), '2026-07-09');
      assert.equal((await ledgerOf(bookingId)).length, 1, 'the steps moved no credit');
    },
  );

  test('R3: a check-out at 18:40 on the date → 200', SKIP_WHEN_NO_DB, async () => {
    const dogId = await pepper();
    const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
    const { bookingId } = await createSession({
      dogIds: [dogId],
      date: DAY,
      lotId,
      ledger: sessions,
    });
    const clock = makeClock(at(DAY, '07:40'));
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
    clock.set(at(DAY, '18:40'));
    const out = attendance(await verb(app, { bookingId, dogId, verb: 'check-out' }));
    assert.equal(out.status, 'out');
    assert.equal(out.events.at(-1)?.at, at(DAY, '18:40').toISOString());
    assert.equal(out.events.at(-1)?.by_staff_id, FIXTURE_IDS.staffDonavanId);
  });
});

describe('R7: a lapsed gate is named on the board and the door still decides', () => {
  test(
    "R7: a dog whose Bordetella lapsed yesterday shows gate_warnings: ['vaccine_lapsed'] and her check-in → 200",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      // Booked while current; the fixture's own `test-bordetella` row gates day school.
      await db
        .update(dogVaccines)
        .set({ expiresAt: '2026-10-12' })
        .where(
          sql`${dogVaccines.dogId} = ${dogId} AND ${dogVaccines.requirementKey} = ${FIXTURE_IDS.requiredVaccineBordetellaKey}`,
        );
      const clock = makeClock(at(DAY, '07:20'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const board = await app.inject({
        method: 'GET',
        url: `/staff/checkin-board?location=bentonville&date=${DAY}`,
      });
      assert.equal(board.statusCode, 200, board.body);
      const row = (JSON.parse(board.body) as CheckinBoardWire[]).find((r) => r.dog_id === dogId);
      assert.deepEqual(row?.gate_warnings, ['vaccine_lapsed']);
      assert.equal(
        attendance(await verb(app, { bookingId, dogId, verb: 'check-in' })).status,
        'in',
      );
    },
  );
});

describe('R12a: a payment-pending row refuses every S29 verb', () => {
  test(
    'R12a: check-in, check-out and undo on a payment-pending row → 409 payment_pending',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        status: 'payment-pending',
        ledger: sessions,
      });
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:35')));
      for (const name of ['check-in', 'check-out', 'undo'] as const) {
        refusal(
          await verb(app, {
            bookingId,
            dogId,
            verb: name,
            body: name === 'check-out' ? {} : undefined,
          }),
          409,
          'payment_pending',
        );
      }
      assert.deepEqual(await eventsOf(bookingId, dogId), []);
    },
  );
});

describe('R13, R14: the early pickup and the vet', () => {
  test(
    'R13: ticked check-out at 11:00 (+1), check in at 14:30 (−1 to that lot), unticked at 17:10 → one credit for the day, one notice',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId, debitIds } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      assert.equal(await poolBalance(), 4);
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));

      clock.set(at(DAY, '11:00'));
      const early = attendance(
        await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
      );
      assert.equal(early.status, 'out');
      const earlyEvent = early.events.at(-1);
      assert.equal(earlyEvent?.reissue_credit, true);
      assert.deepEqual(earlyEvent?.settlement, { returned_credits: 1 });
      assert.equal(await poolBalance(), 5);

      clock.set(at(DAY, '14:30'));
      const back = attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      assert.equal(back.status, 'in');
      assert.equal(back.events.at(-1)?.settlement, undefined, 'a re-debit carries no settlement');
      assert.equal(await poolBalance(), 4);

      clock.set(at(DAY, '17:10'));
      const late = attendance(await verb(app, { bookingId, dogId, verb: 'check-out' }));
      assert.equal(late.status, 'out');
      assert.equal(late.events.at(-1)?.settlement, undefined);

      const rows = await ledgerOf(bookingId);
      assert.equal(
        rows.reduce((sum, r) => sum + r.delta, 0),
        -1,
        'exactly one credit spent for the day',
      );
      const ret = rows.find((r) => r.reason === 'settlement-return');
      assert.equal(ret?.reversesEntryId, debitIds.get(dogId));
      assert.equal(ret?.lotId, lotId);
      const redebit = rows.filter((r) => r.reason === 'booking-debit').at(-1);
      assert.equal(redebit?.lotId, lotId, 'the re-debit takes the lot the return went to');
      assert.equal(await poolBalance(), 4);

      const notices = await cancelNotices(sessions);
      assert.equal(
        notices.length,
        1,
        'the ticked check-out queued one notice and the 17:10 one none',
      );
      assert.equal(
        notices[0]?.body,
        'Pepper was picked up early. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).',
      );
      assert.equal(notices[0]?.deepLinkId, bookingId);
    },
  );

  test(
    'R14: the same with the 11:00 box unticked → the re-check-in writes no ledger row',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      const early = attendance(await verb(app, { bookingId, dogId, verb: 'check-out', body: {} }));
      assert.equal(early.events.at(-1)?.settlement, undefined);
      clock.set(at(DAY, '14:30'));
      assert.equal(
        attendance(await verb(app, { bookingId, dogId, verb: 'check-in' })).status,
        'in',
      );
      clock.set(at(DAY, '17:10'));
      attendance(await verb(app, { bookingId, dogId, verb: 'check-out' }));
      assert.deepEqual(
        (await ledgerOf(bookingId)).map((r) => r.reason),
        ['booking-debit'],
      );
      assert.equal(await poolBalance(), 4);
      assert.deepEqual(await cancelNotices(sessions), []);
    },
  );

  test(
    'D16: a re-check-in owed a credit when the pool has none live today → 422 insufficient_credits, no details, nothing appended',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 1, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      attendance(
        await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
      );
      // The returned credit is spent elsewhere before she comes back.
      await createSession({ dogIds: [dogId], date: '2026-10-20', lotId, ledger: sessions });
      assert.equal(await poolBalance(), 0);
      clock.set(at(DAY, '14:30'));
      const res = await verb(app, { bookingId, dogId, verb: 'check-in' });
      const details = refusal(res, 422, 'insufficient_credits');
      assert.equal(details, undefined);
      assert.deepEqual(
        (await eventsOf(bookingId, dogId)).map((e) => e.kind),
        ['check-in', 'check-out'],
      );
    },
  );
});

describe('the undo refuses what moved a credit', () => {
  test(
    'check in, ticked check-out, undo → 409 attendance_state_conflict {state: out}',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      attendance(
        await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
      );
      const details = refusal<{ kind: string; state: string }>(
        await verb(app, { bookingId, dogId, verb: 'undo' }),
        409,
        'attendance_state_conflict',
      );
      assert.deepEqual(details, { kind: 'attendance_state_conflict', state: 'out' });
      assert.equal((await eventsOf(bookingId, dogId)).length, 2, 'nothing appended');
    },
  );

  test(
    'a re-check-in that took the credit back cannot be undone either',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      attendance(
        await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
      );
      clock.set(at(DAY, '14:30'));
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      const details = refusal(
        await verb(app, { bookingId, dogId, verb: 'undo' }),
        409,
        'attendance_state_conflict',
      );
      assert.deepEqual(details, { kind: 'attendance_state_conflict', state: 'in' });
    },
  );

  test(
    'an undo with nothing to undo → 409 attendance_state_conflict {state: expected}',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:30')));
      const details = refusal(
        await verb(app, { bookingId, dogId, verb: 'undo' }),
        409,
        'attendance_state_conflict',
      );
      assert.deepEqual(details, { kind: 'attendance_state_conflict', state: 'expected' });
    },
  );
});

/** The share's newest event of this kind, from a verb's answer. */
function lastEvent(body: AttendanceWire, kind: string): CheckinEventWire {
  const event = body.events.filter((e) => e.kind === kind).at(-1);
  assert.ok(event, `an event of kind ${kind}`);
  return event;
}

describe("P20 fix 1, F1: a ledger row is an event's only when it names the event (Fable L1, F')", () => {
  test(
    "T1: a return planted at an unticked check-out's own stamp → the re-check-in re-debits nothing",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId, debitIds } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      const out = attendance(await verb(app, { bookingId, dogId, verb: 'check-out', body: {} }));
      await plantAtEventStamp({
        eventId: lastEvent(out, 'check-out').id,
        reason: 'settlement-return',
        lotId,
        reversesEntryId: debitIds.get(dogId)!,
      });
      assert.equal(await poolBalance(), 5, 'the planted return counts');

      clock.set(at(DAY, '14:30'));
      assert.equal(
        attendance(await verb(app, { bookingId, dogId, verb: 'check-in' })).status,
        'in',
      );
      assert.equal(
        (await ledgerOf(bookingId)).filter((r) => r.reason === 'booking-debit').length,
        1,
        'the unticked check-out returned nothing, so the re-check-in takes nothing back',
      );
      assert.equal(await poolBalance(), 5);
    },
  );

  test(
    'T2a: that plant, then undo the check-out → 200: the check-out moved no credit',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId, debitIds } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      const out = attendance(await verb(app, { bookingId, dogId, verb: 'check-out', body: {} }));
      await plantAtEventStamp({
        eventId: lastEvent(out, 'check-out').id,
        reason: 'settlement-return',
        lotId,
        reversesEntryId: debitIds.get(dogId)!,
      });
      clock.set(at(DAY, '11:05'));
      assert.equal(attendance(await verb(app, { bookingId, dogId, verb: 'undo' })).status, 'in');
    },
  );

  test(
    "T2b: a foreign debit at a plain check-in's own stamp, then undo → 200: the check-in moved no credit",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:30')));
      const checkedIn = attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      await plantAtEventStamp({
        eventId: lastEvent(checkedIn, 'check-in').id,
        reason: 'booking-debit',
        lotId,
      });
      assert.equal(
        attendance(await verb(app, { bookingId, dogId, verb: 'undo' })).status,
        'expected',
      );
    },
  );
});

describe('P20 fix 1, F1, T4: every verb that writes a ledger row names its event', () => {
  test(
    'the ticked check-out names its return, the re-check-in its re-debit; a plain check-in, an unticked check-out and an undo name nothing',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      attendance(
        await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
      );
      clock.set(at(DAY, '14:30'));
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '17:10'));
      attendance(await verb(app, { bookingId, dogId, verb: 'check-out', body: {} }));
      attendance(await verb(app, { bookingId, dogId, verb: 'undo' }));

      const [firstIn, ticked, reIn, unticked, undo] = await eventsOf(bookingId, dogId);
      assert.deepEqual(
        [firstIn?.kind, ticked?.kind, reIn?.kind, unticked?.kind, undo?.kind],
        ['check-in', 'check-out', 'check-in', 'check-out', 'undo'],
      );
      assert.deepEqual(
        (await ledgerOf(bookingId)).map((r) => [r.reason, r.checkinEventId]),
        [
          ['booking-debit', null],
          ['settlement-return', ticked?.id],
          ['booking-debit', reIn?.id],
        ],
        'the booking-time debit names no event; nothing names the plain check-in, the unticked check-out or the undo',
      );
    },
  );
});

describe("P20 F2 and F8 (§M1, §10): the re-check-in's re-debit reverses its check-out's return (Opus M1, L2; r2 L1)", () => {
  /** Lot I, 1 credit, dead at the database since DAY 09:40; lot J, 3, live. */
  async function lotsIAndJ() {
    const dogId = await pepper();
    const lotI = await plantLot({ credits: 1, expiresAt: at(DAY, '09:40') });
    const lotJ = await plantLot({ credits: 3, expiresAt: LOT_EXPIRES });
    const { bookingId } = await createSession({
      dogIds: [dogId],
      date: DAY,
      lotId: lotI,
      ledger: sessions,
    });
    // The case §M1 fixed, asserted before acting: I is dead by the database's clock and
    // expires after DAY's Chicago midnight. Since §10 no rule reads I's date: the re-debit
    // reverses its return into I because I still holds that credit.
    const { rows } = await db.execute(sql`
      SELECT lot_is_live(expires_at) AS live,
             expires_at > (${DAY}::date::timestamp AT TIME ZONE 'America/Chicago') AS pays
        FROM credit_ledger WHERE id = ${lotI}`);
    assert.deepEqual(rows[0], { live: false, pays: true });
    return { dogId, lotI, lotJ, bookingId };
  }

  /**
   * The vet trip: in at 07:30, out at 11:00 with *Re-issue the credit* ticked, back at 14:30.
   * `between` runs after the check-out and before the re-check-in (a switch moved, a credit
   * spent elsewhere).
   */
  async function vetTrip(
    bookingId: string,
    dogId: string,
    between?: () => Promise<void>,
  ): Promise<number[]> {
    const clock = makeClock(at(DAY, '07:30'));
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    const balances = [await poolBalance()];
    attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
    clock.set(at(DAY, '11:00'));
    attendance(
      await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
    );
    balances.push(await poolBalance());
    if (between !== undefined) await between();
    clock.set(at(DAY, '14:30'));
    assert.equal(attendance(await verb(app, { bookingId, dogId, verb: 'check-in' })).status, 'in');
    balances.push(await poolBalance());
    return balances;
  }

  test(
    'TM1: at cred.returned_credit_expiry_months 0 the return goes into dead lot I and the re-debit with it: debit I, return I, debit I, the balance never moves',
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
      try {
        const { dogId, lotI, bookingId } = await lotsIAndJ();
        assert.deepEqual(await vetTrip(bookingId, dogId), [3, 3, 3]);
        assert.deepEqual(
          (await ledgerOf(bookingId)).map((r) => [r.reason, r.lotId]),
          [
            ['booking-debit', lotI],
            ['settlement-return', lotI],
            ['booking-debit', lotI],
          ],
        );
      } finally {
        await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 1`);
      }
    },
  );

  test(
    "TM1's control, at 1: the return is a fresh lot and the re-debit takes it; the day costs no more than its first debit",
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 1`);
      const { dogId, lotI, bookingId } = await lotsIAndJ();
      const [start, , end] = await vetTrip(bookingId, dogId);
      assert.equal(end, start);
      const rows = await ledgerOf(bookingId);
      assert.deepEqual(
        rows.map((r) => r.reason),
        ['booking-debit', 'settlement-return', 'booking-debit'],
      );
      const [debit, ret, redebit] = rows;
      assert.equal(debit?.lotId, lotI);
      assert.equal(ret?.lotId, null, 'a fresh one-credit lot');
      assert.equal(
        pgTimestampToDate(ret!.expiresAt!).toISOString(),
        addChicagoMonths(at(DAY, '11:00'), 1).toISOString(),
      );
      assert.equal(redebit?.lotId, ret?.id, 'the re-debit takes the lot the return went to');
    },
  );

  test(
    "TM2: a live lot expiring sooner than the one the return went back to → the re-debit still takes the return's lot",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotK = await plantLot({ credits: 3, expiresAt: LOT_EXPIRES });
      const sooner = await plantLot({ credits: 2, expiresAt: at('2027-01-15', '12:00') });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId: lotK,
        ledger: sessions,
      });
      assert.deepEqual(await vetTrip(bookingId, dogId), [4, 5, 4]);
      const rows = await ledgerOf(bookingId);
      assert.deepEqual(
        rows.map((r) => [r.reason, r.lotId]),
        [
          ['booking-debit', lotK],
          ['settlement-return', lotK],
          ['booking-debit', lotK],
        ],
        `never the sooner lot ${sooner}`,
      );
    },
  );

  /** Every predicate that once read I's date, as the database answers them now. */
  async function lotIPredicates(lotI: string) {
    const { rows } = await db.execute(sql`
      SELECT lot_is_live(expires_at) AS live,
             lot_pays_date(expires_at, ${DAY}::date) AS "paysDate",
             expires_at > (${DAY}::date::timestamp AT TIME ZONE 'America/Chicago') AS "dateHalf"
        FROM credit_ledger WHERE id = ${lotI}`);
    return rows[0] as { live: boolean; paysDate: boolean; dateHalf: boolean };
  }

  /** Lot I's date shortened, after DAY's debit was written, to DAY − 1 at 23:00. */
  async function shortenI(lotI: string): Promise<void> {
    await db.execute(sql`
      UPDATE credit_ledger SET expires_at = ${at('2026-10-12', '23:00').toISOString()}
       WHERE id = ${lotI}`);
  }

  const REVERSAL = (lotI: string) => [
    ['booking-debit', lotI],
    ['settlement-return', lotI],
    ['booking-debit', lotI],
  ];

  test(
    "T10a (probe p10d (a)): at key 0, I's date shortened by hand to the day before, after it paid DAY → the re-debit still reverses into I, [3, 3, 3]",
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
      try {
        const { dogId, lotI, bookingId } = await lotsIAndJ();
        await shortenI(lotI);
        assert.deepEqual(
          await lotIPredicates(lotI),
          { live: false, paysDate: false, dateHalf: false },
          'the move landed: I neither lives nor pays DAY, by any of the three',
        );
        assert.deepEqual(await vetTrip(bookingId, dogId), [3, 3, 3]);
        assert.deepEqual(
          (await ledgerOf(bookingId)).map((r) => [r.reason, r.lotId]),
          REVERSAL(lotI),
        );
      } finally {
        await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 1`);
      }
    },
  );

  test(
    'T10b (probe p10 c10): outlives on at the booking and the check-out, off before the re-check-in → the re-debit still reverses into I',
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`
        UPDATE credit_settings
           SET returned_credit_expiry_months = 0, booking_outlives_lot_expiry_enabled = true`);
      try {
        const { dogId, lotI, bookingId } = await lotsIAndJ();
        await shortenI(lotI);
        const [start, , end] = await vetTrip(bookingId, dogId, async () => {
          await db.execute(
            sql`UPDATE credit_settings SET booking_outlives_lot_expiry_enabled = false`,
          );
        });
        assert.equal(end, start, 'the day costs its one debit');
        assert.deepEqual(
          (await ledgerOf(bookingId)).map((r) => [r.reason, r.lotId]),
          REVERSAL(lotI),
        );
      } finally {
        await db.execute(sql`
          UPDATE credit_settings
             SET returned_credit_expiry_months = 1, booking_outlives_lot_expiry_enabled = false`);
      }
    },
  );

  test(
    "T10b's control (c10ctl): outlives left on throughout → into I",
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`
        UPDATE credit_settings
           SET returned_credit_expiry_months = 0, booking_outlives_lot_expiry_enabled = true`);
      try {
        const { dogId, lotI, bookingId } = await lotsIAndJ();
        await shortenI(lotI);
        await vetTrip(bookingId, dogId);
        assert.deepEqual(
          (await ledgerOf(bookingId)).map((r) => [r.reason, r.lotId]),
          REVERSAL(lotI),
        );
      } finally {
        await db.execute(sql`
          UPDATE credit_settings
             SET returned_credit_expiry_months = 1, booking_outlives_lot_expiry_enabled = false`);
      }
    },
  );

  test(
    'T10c (probe p10 c11): expiry enforcement off at the booking and the check-out, on before the re-check-in → the re-debit still reverses into I',
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
      try {
        const { dogId, lotI, bookingId } = await lotsIAndJ();
        await shortenI(lotI);
        // Off from here, as it was when the day was booked: lotsIAndJ's own precondition
        // reads I dead, which it is not while enforcement is off.
        await db.execute(sql`UPDATE credit_settings SET expiry_enforced_enabled = false`);
        // With enforcement off every lot counts, so the balance moves with the switch: the
        // ledger is the assertion here.
        await vetTrip(bookingId, dogId, async () => {
          await db.execute(sql`UPDATE credit_settings SET expiry_enforced_enabled = true`);
        });
        assert.deepEqual(
          (await ledgerOf(bookingId)).map((r) => [r.reason, r.lotId]),
          REVERSAL(lotI),
        );
      } finally {
        await db.execute(sql`
          UPDATE credit_settings
             SET returned_credit_expiry_months = 1, expiry_enforced_enabled = true`);
      }
    },
  );

  test(
    'T10d, a guard: the returned credit spent on another day before she is back → the fallback takes live J, never dead D that still pays DAY by its date',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotR = await plantLot({ credits: 1, expiresAt: LOT_EXPIRES });
      const lotD = await plantLot({ credits: 2, expiresAt: at(DAY, '09:40') });
      const lotJ = await plantLot({ credits: 3, expiresAt: at('2027-07-01', '12:00') });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId: lotR,
        ledger: sessions,
      });
      assert.deepEqual(await lotIPredicates(lotD), {
        live: false,
        paysDate: false,
        dateHalf: true,
      });
      const balances = await vetTrip(bookingId, dogId, async () => {
        // The credit the check-out put back into R pays another day.
        await createSession({ dogIds: [dogId], date: '2026-10-20', lotId: lotR, ledger: sessions });
      });
      assert.deepEqual(balances, [3, 4, 2]);
      assert.deepEqual(
        (await ledgerOf(bookingId)).map((r) => [r.reason, r.lotId]),
        [
          ['booking-debit', lotR],
          ['settlement-return', lotR],
          ['booking-debit', lotJ],
        ],
      );
      const { rows } = await db.execute(sql`
        SELECT count(*)::int AS n FROM credit_ledger WHERE lot_id = ${lotD}`);
      assert.equal((rows[0] as { n: number }).n, 0, 'nothing drew on dead D');
    },
  );

  /** A lot's credits left: its grant plus every allocation against it, live or not. */
  async function unspent(lotId: string): Promise<number> {
    const { rows } = await db.execute(sql`
      SELECT (l.delta + COALESCE((SELECT sum(x.delta) FROM credit_ledger x WHERE x.lot_id = l.id), 0))::int AS n
        FROM credit_ledger l WHERE l.id = ${lotId}`);
    return (rows[0] as { n: number }).n;
  }

  test(
    'T10e, a pin (P20 Opus r3 L1, mutant S10d; DECISIONS 263): at key 0 the returned credit is spent on another day, then J (1 credit, dies in 5 days) and K (2, in 60) both pay DAY → the fallback takes the soonest-expiring, J: J 0, K 2',
    SKIP_WHEN_NO_DB,
    async () => {
      // probe-p16-frozen.log as a test: Waffles's day paid from lot I; the 11:00 ticked
      // check-out puts the credit back into I (key 0); that credit pays another day; then two
      // live lots of different dates pay DAY. §10 rule 2: the soonest-expiring live lot.
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
      try {
        const dogId = await pepper('Waffles');
        const lotI = await plantLot({ credits: 1, expiresAt: new Date(Date.now() + 30 * 864e5) });
        const { bookingId } = await createSession({
          dogIds: [dogId],
          date: DAY,
          lotId: lotI,
          ledger: sessions,
        });
        let lotJ = '';
        let lotK = '';
        const balances = await vetTrip(bookingId, dogId, async () => {
          await createSession({
            dogIds: [dogId],
            date: '2026-10-20',
            lotId: lotI,
            ledger: sessions,
          });
          assert.equal(await unspent(lotI), 0, 'the returned credit has left I');
          lotJ = await plantLot({ credits: 1, expiresAt: new Date(Date.now() + 5 * 864e5) });
          lotK = await plantLot({ credits: 2, expiresAt: new Date(Date.now() + 60 * 864e5) });
        });
        assert.deepEqual(balances, [0, 1, 2]);
        assert.deepEqual(
          { J: await unspent(lotJ), K: await unspent(lotK) },
          { J: 0, K: 2 },
          'the re-debit spends J, the credit that dies first, and leaves K whole',
        );
        assert.deepEqual(
          (await ledgerOf(bookingId)).map((r) => [r.reason, r.lotId]),
          [
            ['booking-debit', lotI],
            ['settlement-return', lotI],
            ['booking-debit', lotJ],
          ],
        );
      } finally {
        await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 1`);
      }
    },
  );
});

describe('P20 fix 1, F4: the board verbs wipe her balance cache (Opus L4)', () => {
  test(
    'GET /credits reads the new balance at once after a ticked check-out and after the re-check-in',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const { app: ownerApp, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
      registerCreditsRoute(ownerApp, { authenticate });
      const balance = async (): Promise<number | undefined> => {
        const res = await ownerApp.inject({ method: 'GET', url: '/credits?location=bentonville' });
        assert.equal(res.statusCode, 200, res.body);
        const { pools } = res.json() as { pools: { mode: string; balance: number }[] };
        return pools.find((p) => p.mode === 'school')?.balance;
      };
      await invalidatePattern(creditsInvalidationPattern(FIXTURE_IDS.ownerId));
      assert.equal(await balance(), 4, 'read once, so 4 is cached');

      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      attendance(
        await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
      );
      assert.equal(await balance(), 5, 'the return');
      clock.set(at(DAY, '14:30'));
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      assert.equal(await balance(), 4, 'the re-debit');
    },
  );
});

describe('the dates and the states each verb takes', () => {
  test(
    'check-in on a session dated tomorrow → 409 session_not_today {date}',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: NEXT_DAY,
        lotId,
        ledger: sessions,
      });
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '16:00')));
      const details = refusal(
        await verb(app, { bookingId, dogId, verb: 'check-in' }),
        409,
        'session_not_today',
      );
      assert.deepEqual(details, { kind: 'session_not_today', date: NEXT_DAY });
      for (const name of ['check-out', 'undo'] as const) {
        refusal(await verb(app, { bookingId, dogId, verb: name }), 409, 'session_not_today');
      }
    },
  );

  test('check-out and undo take a past date; check-in does not', SKIP_WHEN_NO_DB, async () => {
    const dogId = await pepper();
    const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
    const { bookingId } = await createSession({
      dogIds: [dogId],
      date: DAY,
      lotId,
      ledger: sessions,
    });
    const clock = makeClock(at(DAY, '07:30'));
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
    clock.set(at(NEXT_DAY, '09:00'));
    assert.equal(
      attendance(await verb(app, { bookingId, dogId, verb: 'check-out' })).status,
      'out',
    );
    assert.equal(attendance(await verb(app, { bookingId, dogId, verb: 'undo' })).status, 'in');
    refusal(await verb(app, { bookingId, dogId, verb: 'check-in' }), 409, 'session_not_today');
  });

  test(
    'a check-in that answered 200 replays its 200 the next day, never session_not_today',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '23:59'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const key = `p20-replay-check-in-${randomUUID()}`;
      const first = await verb(app, { bookingId, dogId, verb: 'check-in', key });
      assert.equal(first.statusCode, 200, first.body);
      clock.set(at(NEXT_DAY, '00:01'));
      const replay = await verb(app, { bookingId, dogId, verb: 'check-in', key });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(JSON.parse(replay.body), JSON.parse(first.body));
      assert.equal((await eventsOf(bookingId, dogId)).length, 1);
    },
  );

  test(
    'the states: a second check-in, a check-out of an expected dog, ticked from expected',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:30')));
      assert.deepEqual(
        refusal(
          await verb(app, { bookingId, dogId, verb: 'check-out' }),
          409,
          'attendance_state_conflict',
        ),
        { kind: 'attendance_state_conflict', state: 'expected' },
      );
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      assert.deepEqual(
        refusal(
          await verb(app, { bookingId, dogId, verb: 'check-in' }),
          409,
          'attendance_state_conflict',
        ),
        { kind: 'attendance_state_conflict', state: 'in' },
      );
    },
  );

  test('a dog never on the booking → 404; an unknown booking → 404', SKIP_WHEN_NO_DB, async () => {
    const dogId = await pepper();
    const other = await pepper('Other');
    const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
    const { bookingId } = await createSession({
      dogIds: [dogId],
      date: DAY,
      lotId,
      ledger: sessions,
    });
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:30')));
    refusal(await verb(app, { bookingId, dogId: other, verb: 'check-in' }), 404, 'not_found');
    refusal(
      await verb(app, { bookingId: randomUUID(), dogId, verb: 'check-in' }),
      404,
      'not_found',
    );
  });

  test('path ids in capitals are the same booking and dog, one key', SKIP_WHEN_NO_DB, async () => {
    const dogId = await pepper();
    const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
    const { bookingId } = await createSession({
      dogIds: [dogId],
      date: DAY,
      lotId,
      ledger: sessions,
    });
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:30')));
    const res = attendance(
      await verb(app, {
        bookingId: bookingId.toUpperCase(),
        dogId: dogId.toUpperCase(),
        verb: 'check-in',
      }),
    );
    assert.equal(res.events[0]?.booking_id, bookingId);
    assert.equal(res.events[0]?.dog_id, dogId);
  });

  test("check-out's note is 1..500 after trim; the body is strict", SKIP_WHEN_NO_DB, async () => {
    const dogId = await pepper();
    const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
    const { bookingId } = await createSession({
      dogIds: [dogId],
      date: DAY,
      lotId,
      ledger: sessions,
    });
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:30')));
    attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
    for (const body of [{ note: '   ' }, { note: 'x'.repeat(501) }, { hand_off: true }]) {
      refusal(
        await verb(app, { bookingId, dogId, verb: 'check-out', body }),
        422,
        'invalid_payload',
      );
    }
    const out = attendance(
      await verb(app, {
        bookingId,
        dogId,
        verb: 'check-out',
        body: { note: '  went home with Shanthi ' },
      }),
    );
    assert.equal(out.events.at(-1)?.note, 'went home with Shanthi');
    assert.equal(out.events.at(-1)?.reissue_credit, false);
  });
});

describe('R16: the fold is append order, on two connections', () => {
  test(
    'R16: a check-out whose transaction began first but took the row lock second → the fold reads in, then out',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '09:00')));

      // A third connection holds the check-out's key, uncommitted, so the check-out's
      // transaction begins and then waits at its claim, before any row lock.
      const outKey = `p20-r16-out-${randomUUID()}`;
      const holder = await pool.connect();
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO idempotency_keys (key, endpoint, request_hash) VALUES ($1, 'held', 'held')`,
        [outKey],
      );
      const checkingOut = verb(app, { bookingId, dogId, verb: 'check-out', key: outKey });
      try {
        await untilWaitingOnLock();
        const checkedIn = await verb(app, { bookingId, dogId, verb: 'check-in' });
        assert.equal(checkedIn.statusCode, 200, checkedIn.body);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      const out = attendance(await checkingOut);
      assert.deepEqual(
        out.events.map((e) => e.kind),
        ['check-in', 'check-out'],
      );
      assert.equal(out.status, 'out');
      // The check-out's transaction really did begin first.
      const { rows } = await db.execute(sql`
        SELECT kind::text AS kind, created_at FROM checkin_events
         WHERE booking_id = ${bookingId} ORDER BY created_at`);
      assert.deepEqual(
        (rows as { kind: string }[]).map((r) => r.kind),
        ['check-out', 'check-in'],
      );
    },
  );
});

async function untilWaitingOnLock(): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    const { rows } = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((rows[0] as { n: number }).n >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the check-out never reached its claim');
}

describe('the board read', () => {
  test(
    'one row per live share, with its log, state, clock and money flags',
    SKIP_WHEN_NO_DB,
    async () => {
      const bao = await pepper('Bao');
      const luna = await pepper('Luna');
      const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [bao, luna],
        date: DAY,
        lotId,
        ledger: sessions,
      });
      const pendingDog = await pepper('Mochi');
      const pending = await createSession({
        dogIds: [pendingDog],
        date: DAY,
        status: 'payment-pending',
        ledger: sessions,
      });
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId: bao, verb: 'check-in' }));

      const read = async (): Promise<CheckinBoardWire[]> => {
        const res = await app.inject({
          method: 'GET',
          url: `/staff/checkin-board?location=bentonville&date=${DAY}`,
        });
        assert.equal(res.statusCode, 200, res.body);
        return JSON.parse(res.body) as CheckinBoardWire[];
      };
      const rows = await read();
      const baoRow = rows.find((r) => r.dog_id === bao);
      const lunaRow = rows.find((r) => r.dog_id === luna);
      const pendingRow = rows.find((r) => r.dog_id === pendingDog);
      assert.deepEqual(
        { ...baoRow, events: baoRow?.events.map((e) => e.kind) },
        {
          booking_id: bookingId,
          dog_id: bao,
          state: 'in',
          events: ['check-in'],
          booking_status: 'upcoming',
          late_pickup_due: false,
          after_school: false,
          settled: false,
          can_cancel: false,
          payment_pending: false,
          gate_warnings: [],
        },
      );
      assert.equal(lunaRow?.state, 'expected');
      assert.equal(lunaRow?.can_cancel, true);
      assert.equal(pendingRow?.booking_status, 'payment-pending');
      assert.equal(pendingRow?.payment_pending, true);
      assert.equal(pendingRow?.can_cancel, false);
      assert.equal(pending.bookingId, pendingRow?.booking_id);

      // 17:30 is Bentonville's late-pickup call time as seeded: an on-site dog is flagged.
      clock.set(at(DAY, '17:30'));
      const late = await read();
      assert.equal(late.find((r) => r.dog_id === bao)?.late_pickup_due, true);
      assert.equal(late.find((r) => r.dog_id === luna)?.late_pickup_due, false, 'not on site');
      assert.equal(late.find((r) => r.dog_id === luna)?.can_cancel, false, 'the day has ended');
    },
  );

  test(
    'the query: both keys required, no later date than today, staff only',
    SKIP_WHEN_NO_DB,
    async () => {
      const clock = makeClock(at(DAY, '09:00'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      for (const url of [
        `/staff/checkin-board?location=bentonville&date=${NEXT_DAY}`,
        `/staff/checkin-board?date=${DAY}`,
        '/staff/checkin-board?location=bentonville',
        '/staff/checkin-board?location=bentonville&date=2026-13-40',
      ]) {
        refusal(await app.inject({ method: 'GET', url }), 400, 'bad_request');
      }
      const past = await app.inject({
        method: 'GET',
        url: '/staff/checkin-board?location=bentonville&date=2026-09-01',
      });
      assert.equal(past.statusCode, 200, past.body);
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
      refusal(
        await owner.inject({
          method: 'GET',
          url: `/staff/checkin-board?location=bentonville&date=${DAY}`,
        }),
        403,
        'forbidden',
      );
    },
  );
});

describe('the alarm', () => {
  test(
    'a ticked check-out that finds no live debit for the share → 500 and one alarm naming the booking and the dog',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { bookingId } = await createSession({ dogIds: [dogId], date: DAY, ledger: sessions });
      const capture = makeLogCapture();
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock, capture);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      const res = await verb(app, {
        bookingId,
        dogId,
        verb: 'check-out',
        body: { reissue_credit: true },
      });
      assert.equal(res.statusCode, 500, res.body);
      const alarms = capture.lines.filter(
        (l) => l.level === 50 && l.bookingId === bookingId && l.dogId === dogId,
      );
      assert.equal(alarms.length, 1, JSON.stringify(capture.lines));
      assert.deepEqual(
        (await eventsOf(bookingId, dogId)).map((e) => e.kind),
        ['check-in'],
        'the check-out rolled back',
      );
    },
  );
});
