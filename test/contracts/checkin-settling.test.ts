import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import type { AttendanceWire, CheckinBoardWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { dayCapacityRepository } from '../../src/db/repositories/dayCapacityRepository.js';
import { dayCapacity, dogs } from '../../src/db/schema/schema.js';
import {
  addCalendarDays,
  bucketChicagoToday,
  bucketToChicagoDate,
} from '../../src/lib/chicagoDate.js';
import { addChicagoMonths } from '../../src/lib/creditExpiry.js';
import { pgTimestampToDate } from '../../src/lib/pgTimestamp.js';
import { redis } from '../../src/redis.js';
import { createBookableDog, createFundedDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { clearPlantedPools, plantLot, poolBalance } from './_poolFixture.js';
import { registerStaffSettingsRoute } from '../../src/routes/staffSettings.js';
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
 * S30's settling verbs, `turn-away`, `send-home` and `no-show` (*Didn't come*), and what
 * comes back (DAY-U33, DAY-U34; design §2.3:2374-2387, :2477-2557, §2.4:2955-2977; P20
 * brief pass 2). Always a credit and never money, through the one return writer.
 *
 * Tue 13 Oct 2026 is the session's day where the lot's date does not matter (a lot that
 * pays every date). Where it does (T6-T8, U1, U2), the dates are the REAL clock's:
 * `lot_is_live` and `lot_pays_date` read the database's `now()`, which no injected clock
 * reaches, so "lot I has expired" has to be true at the database.
 */

registerFixtureHooks();
const createdDogs: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  await db.execute(sql`
    UPDATE day_program_settings
       SET sent_home_before_training_return_fraction = 1,
           sent_home_after_training_return_fraction = 0
     WHERE location IS NULL`);
  await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 1`);
  await db
    .delete(dayCapacity)
    .where(and(eq(dayCapacity.location, 'bentonville'), eq(dayCapacity.date, DAY)));
  await removeSessions(sessions.splice(0));
  await clearPlantedPools();
});
after(async () => {
  await removeDogs(createdDogs);
});

const DAY = '2026-10-13';
const NEXT_DAY = '2026-10-14';
const LOT_EXPIRES = at('2027-06-01', '12:00');

/**
 * A Chicago calendar day on the REAL clock, `offset` calendar days from today: a step on the
 * calendar, never 24 hours, so the night a 25-hour day ends cannot land on today.
 */
function realChicagoDate(offsetDays: number): string {
  return addCalendarDays(bucketChicagoToday(new Date()), offsetDays);
}

function en(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    timeZone: 'America/Chicago',
    day: 'numeric',
    month: 'short',
  });
}

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

/** One dog on DAY, debited from a lot that pays every date. */
async function onePepper(name = 'Pepper') {
  const dogId = await pepper(name);
  const lotId = await plantLot({ credits: 5, expiresAt: LOT_EXPIRES });
  const session = await createSession({ dogIds: [dogId], date: DAY, lotId, ledger: sessions });
  return { dogId, lotId, ...session };
}

async function board(app: ReturnType<typeof boardApp>, date = DAY): Promise<CheckinBoardWire[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/staff/checkin-board?location=bentonville&date=${date}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as CheckinBoardWire[];
}

describe("S29's arms that need an S30 verb", () => {
  test(
    'R1: check in, send home, undo → 409 and last_seen_on unchanged',
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      await db.update(dogs).set({ lastSeenOn: '2026-07-09' }).where(eq(dogs.id, dogId));
      const clock = makeClock(at(DAY, '07:35'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '13:10'));
      assert.equal(
        attendance(await verb(app, { bookingId, dogId, verb: 'send-home', body: {} })).status,
        'sent-home',
      );
      const before = await lastSeenOn(dogId);
      assert.equal(before, DAY);
      assert.deepEqual(
        refusal(
          await verb(app, { bookingId, dogId, verb: 'undo' }),
          409,
          'attendance_state_conflict',
        ),
        { kind: 'attendance_state_conflict', state: 'sent-home' },
      );
      assert.equal(await lastSeenOn(dogId), before);
      assert.deepEqual(
        (await eventsOf(bookingId, dogId)).map((e) => e.kind),
        ['check-in', 'sent-home'],
      );
    },
  );

  test(
    'R4: a turn-away on a session dated tomorrow → 409 session_not_today, ledger unchanged',
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
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:35')));
      const before = await ledgerOf(bookingId);
      assert.deepEqual(
        refusal(await verb(app, { bookingId, dogId, verb: 'turn-away' }), 409, 'session_not_today'),
        { kind: 'session_not_today', date: NEXT_DAY },
      );
      assert.deepEqual(await ledgerOf(bookingId), before);
      // A send-home needs today too; a past date is not today either.
      refusal(
        await verb(app, { bookingId, dogId, verb: 'send-home', body: {} }),
        409,
        'session_not_today',
      );
    },
  );

  test(
    "R5: a Didn't come at 09:00 → 409 no_show_too_early, at 17:30 → 200",
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      const clock = makeClock(at(DAY, '09:00'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      assert.deepEqual(
        refusal(await verb(app, { bookingId, dogId, verb: 'no-show' }), 409, 'no_show_too_early'),
        { kind: 'no_show_too_early', recordable_from: at(DAY, '17:30').toISOString() },
      );
      assert.deepEqual(await eventsOf(bookingId, dogId), []);
      clock.set(at(DAY, '17:30'));
      const done = attendance(await verb(app, { bookingId, dogId, verb: 'no-show' }));
      assert.equal(done.status, 'no-show');
      assert.deepEqual(done.events.at(-1)?.settlement, { returned_credits: 1 });
    },
  );

  test(
    'R6: send home at 13:10 then check out at 18:00 → 200 with one settlement row, the board having flagged the sent-home dog at 17:30',
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '13:10'));
      attendance(await verb(app, { bookingId, dogId, verb: 'send-home', body: {} }));
      clock.set(at(DAY, '17:29'));
      const early = (await board(app)).find((r) => r.dog_id === dogId);
      assert.equal(early?.late_pickup_due, false);
      clock.set(at(DAY, '17:30'));
      const flagged = (await board(app)).find((r) => r.dog_id === dogId);
      assert.equal(flagged?.state, 'sent-home');
      assert.equal(flagged?.settled, true);
      assert.equal(
        flagged?.late_pickup_due,
        true,
        'a sent-home dog still on site is flagged at 17:30',
      );
      clock.set(at(DAY, '18:00'));
      const out = attendance(await verb(app, { bookingId, dogId, verb: 'check-out' }));
      assert.equal(out.status, 'out');
      assert.equal(
        (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return').length,
        1,
        'one settlement row',
      );
      const after = (await board(app)).find((r) => r.dog_id === dogId);
      assert.equal(after?.state, 'out');
      assert.equal(after?.settled, true, 'a sent-home dog checked out stays settled');
      assert.equal(after?.late_pickup_due, false);
    },
  );

  test(
    'R12b: turn-away, send-home and no-show on a payment-pending row → 409 payment_pending',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: DAY,
        status: 'payment-pending',
        ledger: sessions,
      });
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '17:30')));
      refusal(await verb(app, { bookingId, dogId, verb: 'turn-away' }), 409, 'payment_pending');
      refusal(
        await verb(app, { bookingId, dogId, verb: 'send-home', body: {} }),
        409,
        'payment_pending',
      );
      refusal(await verb(app, { bookingId, dogId, verb: 'no-show' }), 409, 'payment_pending');
      assert.deepEqual(await eventsOf(bookingId, dogId), []);
    },
  );

  test(
    'R15: a re-check-in after a send-home → 409 attendance_state_conflict',
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '13:10'));
      attendance(await verb(app, { bookingId, dogId, verb: 'send-home', body: {} }));
      assert.deepEqual(
        refusal(
          await verb(app, { bookingId, dogId, verb: 'check-in' }),
          409,
          'attendance_state_conflict',
        ),
        { kind: 'attendance_state_conflict', state: 'sent-home' },
      );
      clock.set(at(DAY, '15:00'));
      attendance(await verb(app, { bookingId, dogId, verb: 'check-out' }));
      assert.deepEqual(
        refusal(
          await verb(app, { bookingId, dogId, verb: 'check-in' }),
          409,
          'attendance_state_conflict',
        ),
        { kind: 'attendance_state_conflict', state: 'out' },
        'out, but settled: the send-home decided the day',
      );
    },
  );
});

describe("S30's red-first", () => {
  test(
    "T1: send home unmarked → +1 to the debit's lot with that lot's expires_at",
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, lotId, bookingId, debitIds } = await onePepper();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '13:10'));
      const sent = attendance(await verb(app, { bookingId, dogId, verb: 'send-home', body: {} }));
      const event = sent.events.at(-1);
      assert.equal(event?.kind, 'sent-home');
      assert.equal(event?.training_completed, false);
      assert.deepEqual(event?.settlement, { returned_credits: 1 });
      const [ret] = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.equal(ret?.delta, 1);
      assert.equal(ret?.lotId, lotId, "to the debit's lot");
      assert.equal(ret?.expiresAt, null, "keeping that lot's expires_at");
      assert.equal(ret?.reversesEntryId, debitIds.get(dogId));
      assert.deepEqual(
        (await cancelNotices(sessions)).map((n) => n.body),
        [
          'Pepper was sent home early. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).',
        ],
      );
    },
  );

  test('T2: send home marked → no ledger row', SKIP_WHEN_NO_DB, async () => {
    const { dogId, bookingId } = await onePepper();
    const clock = makeClock(at(DAY, '07:40'));
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
    clock.set(at(DAY, '15:00'));
    const sent = attendance(
      await verb(app, { bookingId, dogId, verb: 'send-home', body: { training_completed: true } }),
    );
    assert.equal(sent.events.at(-1)?.training_completed, true);
    assert.deepEqual(sent.events.at(-1)?.settlement, { returned_credits: 0 });
    assert.deepEqual(
      (await ledgerOf(bookingId)).map((r) => r.reason),
      ['booking-debit'],
    );
    assert.deepEqual(await cancelNotices(sessions), [], 'a finished send-home sends nothing');
  });

  test('T3: a second settling event → the index refuses', SKIP_WHEN_NO_DB, async () => {
    const { dogId, bookingId } = await onePepper();
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:35')));
    attendance(await verb(app, { bookingId, dogId, verb: 'turn-away' }));
    await assert.rejects(
      db.execute(sql`
        INSERT INTO checkin_events (booking_id, dog_id, kind, at, by_staff_id)
        VALUES (${bookingId}, ${dogId}, 'no-show', now(), ${FIXTURE_IDS.staffDonavanId})`),
      (err: unknown) => {
        const code =
          (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        assert.equal(code, '23505', String(err));
        return true;
      },
    );
    // Through the verbs the state refuses it first.
    const late = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '17:30')));
    assert.deepEqual(
      refusal(
        await verb(late, { bookingId, dogId, verb: 'no-show' }),
        409,
        'attendance_state_conflict',
      ),
      { kind: 'attendance_state_conflict', state: 'turned-away' },
    );
  });

  test(
    "T4: a Didn't come on a dog whose log has a check-in → 409 attendance_state_conflict {state: 'in'}",
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '17:30'));
      assert.deepEqual(
        refusal(
          await verb(app, { bookingId, dogId, verb: 'no-show' }),
          409,
          'attendance_state_conflict',
        ),
        { kind: 'attendance_state_conflict', state: 'in' },
      );
      assert.equal((await ledgerOf(bookingId)).length, 1);
    },
  );

  /** Lot I, the day it paid (the REAL clock's yesterday), its date passed at 09:40. */
  async function lotIExpiredAt0940() {
    const day = realChicagoDate(-1);
    const dogId = await pepper();
    const lotI = await plantLot({ credits: 1, expiresAt: at(day, '09:40') });
    const { bookingId, debitIds } = await createSession({
      dogIds: [dogId],
      date: day,
      lotId: lotI,
      ledger: sessions,
    });
    return { day, dogId, lotI, bookingId, debit: debitIds.get(dogId)! };
  }

  test(
    "T6: a Didn't come at 17:30 on a day lot I paid, lot I having expired at 09:40 → one row with lot_id NULL and expires_at a month on, balance +1, the notice's date a month on",
    SKIP_WHEN_NO_DB,
    async () => {
      const { day, dogId, bookingId } = await lotIExpiredAt0940();
      const before = await poolBalance();
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(day, '17:30')));
      attendance(await verb(app, { bookingId, dogId, verb: 'no-show' }));
      const returns = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.equal(returns.length, 1);
      assert.equal(returns[0]?.lotId, null);
      const fresh = addChicagoMonths(at(day, '17:30'), 1);
      assert.equal(pgTimestampToDate(returns[0]!.expiresAt!).toISOString(), fresh.toISOString());
      assert.equal(await poolBalance(), before + 1);
      assert.deepEqual(
        (await cancelNotices(sessions)).map((n) => n.body),
        [
          `Pepper didn't come today. +1 credit, back to your Bentonville day-school credits (expires ${en(fresh)}).`,
        ],
      );
    },
  );

  test(
    "T7: with cred.returned_credit_expiry_months 0 → the row names lot I and the notice carries §2.9's dead-lot line, never '+1 credit … (expires …)'",
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
      const { day, dogId, lotI, bookingId } = await lotIExpiredAt0940();
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(day, '17:30')));
      attendance(await verb(app, { bookingId, dogId, verb: 'no-show' }));
      const [ret] = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.equal(ret?.lotId, lotI);
      const [body] = (await cancelNotices(sessions)).map((n) => n.body);
      assert.equal(
        body,
        `Pepper didn't come today. 1 credit came back, but its date, ${en(at(day, '09:40'))}, has passed. Message us if you'd like it extended.`,
      );
      assert.doesNotMatch(body ?? '', /\+1 credit|\(expires/);
    },
  );

  test(
    'T8: a turn-away at 07:35 on a day whose lot is still live but dies before midnight → a fresh lot too, since that lot can pay no later date',
    SKIP_WHEN_NO_DB,
    async () => {
      // The lot dies two real minutes from now, on its own Chicago day, so it is live
      // at the database and can pay no date after that day.
      const dies = new Date(Date.now() + 2 * 60_000);
      const day = bucketToChicagoDate(dies);
      const dogId = await pepper();
      const lotI = await plantLot({ credits: 1, expiresAt: dies });
      const { bookingId } = await createSession({
        dogIds: [dogId],
        date: day,
        lotId: lotI,
        ledger: sessions,
      });
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(day, '07:35')));
      attendance(await verb(app, { bookingId, dogId, verb: 'turn-away' }));
      const [ret] = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.equal(ret?.lotId, null, 'a fresh lot');
      assert.equal(
        pgTimestampToDate(ret!.expiresAt!).toISOString(),
        addChicagoMonths(at(day, '07:35'), 1).toISOString(),
      );
    },
  );

  test(
    "U1: that 17:30 return → one row, lot_id NULL, expires_at a calendar month after 17:30, reverses_entry_id = the day's debit",
    SKIP_WHEN_NO_DB,
    async () => {
      const { day, dogId, bookingId, debit } = await lotIExpiredAt0940();
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(day, '17:30')));
      attendance(await verb(app, { bookingId, dogId, verb: 'no-show' }));
      const returns = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.equal(returns.length, 1);
      assert.equal(returns[0]?.lotId, null);
      assert.equal(
        pgTimestampToDate(returns[0]!.expiresAt!).toISOString(),
        addChicagoMonths(at(day, '17:30'), 1).toISOString(),
      );
      assert.equal(returns[0]?.reversesEntryId, debit);
    },
  );

  test('U2: with the key 0 → one row naming lot I, live false', SKIP_WHEN_NO_DB, async () => {
    await db.execute(sql`UPDATE credit_settings SET returned_credit_expiry_months = 0`);
    const { day, dogId, lotI, bookingId } = await lotIExpiredAt0940();
    const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(day, '17:30')));
    attendance(await verb(app, { bookingId, dogId, verb: 'no-show' }));
    const returns = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
    assert.equal(returns.length, 1);
    assert.equal(returns[0]?.lotId, lotI);
    const { rows } = await db.execute(sql`
      SELECT lot_is_live(expires_at) AS live FROM credit_ledger WHERE id = ${lotI}`);
    assert.equal((rows[0] as { live: boolean }).live, false);
  });

  test(
    'D5: a PATCH of day.sent_home_before_training_return_fraction to 0.5 → 422',
    SKIP_WHEN_NO_DB,
    async () => {
      const { app, authenticate } = makeContractApp(FIXTURE_MANAGER_PRINCIPAL);
      registerStaffSettingsRoute(app, { authenticate });
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/staff/settings/day',
          headers: {
            'idempotency-key': `p20-d5-${randomUUID()}`,
            'content-type': 'application/json',
          },
          payload: JSON.stringify({ sent_home_before_training_return_fraction: 0.5 }),
        });
        refusal(res, 422, 'invalid_payload');
        assert.match(res.body, /sent_home_before_training_return_fraction: must be one of 0, 1/);
        const { rows } = await db.execute(sql`
        SELECT sent_home_before_training_return_fraction::text AS f
          FROM day_program_settings WHERE location IS NULL`);
        assert.equal(Number((rows[0] as { f: string }).f), 1);
      } finally {
        await db.execute(sql`
        UPDATE day_program_settings SET sent_home_before_training_return_fraction = 1
         WHERE location IS NULL`);
      }
    },
  );
});

describe('the fractions are read, never assumed', () => {
  test(
    "with the before-training fraction at 0, an unmarked send-home, a turn-away and a Didn't come return nothing and send nothing",
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`
        UPDATE day_program_settings SET sent_home_before_training_return_fraction = 0
         WHERE location IS NULL`);
      const sent = await onePepper('Pepper');
      const turned = await onePepper('Mochi');
      const missed = await onePepper('Bao');
      const clock = makeClock(at(DAY, '07:35'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const away = attendance(
        await verb(app, { bookingId: turned.bookingId, dogId: turned.dogId, verb: 'turn-away' }),
      );
      assert.deepEqual(away.events.at(-1)?.settlement, { returned_credits: 0 });
      attendance(
        await verb(app, { bookingId: sent.bookingId, dogId: sent.dogId, verb: 'check-in' }),
      );
      clock.set(at(DAY, '13:10'));
      const home = attendance(
        await verb(app, {
          bookingId: sent.bookingId,
          dogId: sent.dogId,
          verb: 'send-home',
          body: {},
        }),
      );
      assert.deepEqual(home.events.at(-1)?.settlement, { returned_credits: 0 });
      clock.set(at(DAY, '17:30'));
      const no = attendance(
        await verb(app, { bookingId: missed.bookingId, dogId: missed.dogId, verb: 'no-show' }),
      );
      assert.deepEqual(no.events.at(-1)?.settlement, { returned_credits: 0 });
      for (const s of [sent, turned, missed]) {
        assert.deepEqual(
          (await ledgerOf(s.bookingId)).map((r) => r.reason),
          ['booking-debit'],
        );
      }
      assert.deepEqual(await cancelNotices(sessions), []);
    },
  );

  test(
    'with the after-training fraction at 1, a send-home marked finished returns the credit',
    SKIP_WHEN_NO_DB,
    async () => {
      await db.execute(sql`
      UPDATE day_program_settings SET sent_home_after_training_return_fraction = 1
       WHERE location IS NULL`);
      const { dogId, bookingId } = await onePepper();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '16:00'));
      const sent = attendance(
        await verb(app, {
          bookingId,
          dogId,
          verb: 'send-home',
          body: { training_completed: true },
        }),
      );
      assert.deepEqual(sent.events.at(-1)?.settlement, { returned_credits: 1 });
      assert.equal(
        (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return').length,
        1,
      );
    },
  );

  test(
    'check in, ticked check-out, re-check-in, send home unmarked → the return names the re-debit, never the first debit',
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId, debitIds } = await onePepper();
      const clock = makeClock(at(DAY, '07:30'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      attendance(
        await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
      );
      clock.set(at(DAY, '14:30'));
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      const redebit = (await ledgerOf(bookingId))
        .filter((r) => r.reason === 'booking-debit')
        .find((r) => r.id !== debitIds.get(dogId));
      assert.ok(redebit !== undefined, 'the re-check-in debited again');
      clock.set(at(DAY, '15:00'));
      attendance(await verb(app, { bookingId, dogId, verb: 'send-home', body: {} }));
      const returns = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.deepEqual(
        returns.map((r) => r.reversesEntryId),
        [debitIds.get(dogId), redebit.id],
      );
      assert.equal(
        (await ledgerOf(bookingId)).reduce((sum, r) => sum + r.delta, 0),
        0,
        'the day spent nothing',
      );
    },
  );
});

describe('the settling verbs, their states and dates', () => {
  test(
    "a send-home's check-out cannot re-issue: the send-home decided the credit",
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '13:10'));
      attendance(await verb(app, { bookingId, dogId, verb: 'send-home', body: {} }));
      assert.deepEqual(
        refusal(
          await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
          409,
          'attendance_state_conflict',
        ),
        { kind: 'attendance_state_conflict', state: 'sent-home' },
      );
      assert.equal(
        attendance(await verb(app, { bookingId, dogId, verb: 'check-out' })).status,
        'out',
      );
    },
  );

  test(
    'the required states: a turn-away and a no-show from expected, a send-home from in',
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      assert.deepEqual(
        refusal(
          await verb(app, { bookingId, dogId, verb: 'send-home', body: {} }),
          409,
          'attendance_state_conflict',
        ),
        { kind: 'attendance_state_conflict', state: 'expected' },
      );
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      assert.deepEqual(
        refusal(
          await verb(app, { bookingId, dogId, verb: 'turn-away' }),
          409,
          'attendance_state_conflict',
        ),
        { kind: 'attendance_state_conflict', state: 'in' },
      );
      for (const body of [{ training_completed: 'yes' }, { note: 'x' }]) {
        refusal(
          await verb(app, { bookingId, dogId, verb: 'send-home', body }),
          422,
          'invalid_payload',
        );
      }
    },
  );

  test(
    "a Didn't come on a past date's board needs no clock; a turn-away there is not today",
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(NEXT_DAY, '08:00')));
      refusal(await verb(app, { bookingId, dogId, verb: 'turn-away' }), 409, 'session_not_today');
      assert.equal(
        attendance(await verb(app, { bookingId, dogId, verb: 'no-show' })).status,
        'no-show',
      );
    },
  );

  test(
    'a turn-away never touches last_seen_on, and its row stays on the board, settled',
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      await db.update(dogs).set({ lastSeenOn: '2026-07-09' }).where(eq(dogs.id, dogId));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:35')));
      attendance(await verb(app, { bookingId, dogId, verb: 'turn-away' }));
      assert.equal(await lastSeenOn(dogId), '2026-07-09');
      const row = (await board(app)).find((r) => r.dog_id === dogId);
      assert.equal(row?.state, 'turned-away');
      assert.equal(row?.settled, true);
      assert.equal(row?.can_cancel, false);
      assert.equal(row?.late_pickup_due, false);
      assert.deepEqual(row?.events.at(-1)?.settlement, { returned_credits: 1 });
      assert.deepEqual(
        (await cancelNotices(sessions)).map((n) => n.body),
        [
          'Pepper was turned away. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).',
        ],
      );
    },
  );

  test(
    "a Didn't come answered 200 replays its 200 with the desk clock moved back before 17:30, never no_show_too_early",
    SKIP_WHEN_NO_DB,
    async () => {
      const first = await onePepper('Pepper');
      const second = await onePepper('Mochi');
      const clock = makeClock(at(DAY, '17:31'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const key = `p20-replay-no-show-${randomUUID()}`;
      const answered = await verb(app, {
        bookingId: first.bookingId,
        dogId: first.dogId,
        verb: 'no-show',
        key,
      });
      assert.equal(answered.statusCode, 200, answered.body);
      clock.set(at(DAY, '17:29'));
      const replay = await verb(app, {
        bookingId: first.bookingId,
        dogId: first.dogId,
        verb: 'no-show',
        key,
      });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(JSON.parse(replay.body), JSON.parse(answered.body));
      refusal(
        await verb(app, { bookingId: second.bookingId, dogId: second.dogId, verb: 'no-show' }),
        409,
        'no_show_too_early',
      );
      assert.equal(
        (await ledgerOf(first.bookingId)).filter((r) => r.reason === 'settlement-return').length,
        1,
      );
    },
  );

  test(
    'a turn-away answered 200 replays its 200 the next day, never session_not_today',
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, bookingId } = await onePepper();
      const clock = makeClock(at(DAY, '23:59'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const key = `p20-replay-turn-away-${randomUUID()}`;
      const answered = await verb(app, { bookingId, dogId, verb: 'turn-away', key });
      assert.equal(answered.statusCode, 200, answered.body);
      clock.set(at(NEXT_DAY, '00:01'));
      const replay = await verb(app, { bookingId, dogId, verb: 'turn-away', key });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(JSON.parse(replay.body), JSON.parse(answered.body));
    },
  );

  test(
    'a settle that finds no live debit for the share → 500 and one alarm naming the booking and the dog, nothing appended',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { bookingId } = await createSession({ dogIds: [dogId], date: DAY, ledger: sessions });
      const capture = makeLogCapture();
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(DAY, '07:35')), capture);
      const res = await verb(app, { bookingId, dogId, verb: 'turn-away' });
      assert.equal(res.statusCode, 500, res.body);
      const alarms = capture.lines.filter(
        (l) => l.level === 50 && l.bookingId === bookingId && l.dogId === dogId,
      );
      assert.equal(alarms.length, 1, JSON.stringify(capture.lines));
      assert.deepEqual(await eventsOf(bookingId, dogId), []);
    },
  );

  test(
    'Fable L2: a send-home marked finished (fraction 0) on a share with no live debit → 500 and one alarm, the invariant read before the fraction',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { bookingId } = await createSession({ dogIds: [dogId], date: DAY, ledger: sessions });
      const capture = makeLogCapture();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock, capture);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '15:00'));
      const res = await verb(app, {
        bookingId,
        dogId,
        verb: 'send-home',
        body: { training_completed: true },
      });
      assert.equal(res.statusCode, 500, res.body);
      const alarms = capture.lines.filter(
        (l) => l.level === 50 && l.bookingId === bookingId && l.dogId === dogId,
      );
      assert.equal(alarms.length, 1, JSON.stringify(capture.lines));
      assert.deepEqual(
        (await eventsOf(bookingId, dogId)).map((e) => e.kind),
        ['check-in'],
        'the send-home rolled back',
      );
    },
  );
});

describe('P20 fix 1, F1, T4: every settling verb that writes a ledger row names its event', () => {
  test(
    "a turn-away's, an unticked send-home's and a Didn't come's return each name their event; a finished send-home writes none",
    SKIP_WHEN_NO_DB,
    async () => {
      const turned = await onePepper('Mochi');
      const sent = await onePepper('Pepper');
      const finished = await onePepper('Bao');
      const missed = await onePepper('Luna');
      const clock = makeClock(at(DAY, '07:35'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(
        await verb(app, { bookingId: turned.bookingId, dogId: turned.dogId, verb: 'turn-away' }),
      );
      for (const s of [sent, finished]) {
        attendance(await verb(app, { bookingId: s.bookingId, dogId: s.dogId, verb: 'check-in' }));
      }
      clock.set(at(DAY, '13:10'));
      attendance(
        await verb(app, {
          bookingId: sent.bookingId,
          dogId: sent.dogId,
          verb: 'send-home',
          body: {},
        }),
      );
      attendance(
        await verb(app, {
          bookingId: finished.bookingId,
          dogId: finished.dogId,
          verb: 'send-home',
          body: { training_completed: true },
        }),
      );
      clock.set(at(DAY, '17:30'));
      attendance(
        await verb(app, { bookingId: missed.bookingId, dogId: missed.dogId, verb: 'no-show' }),
      );

      for (const [share, kind] of [
        [turned, 'turn-away'],
        [sent, 'sent-home'],
        [missed, 'no-show'],
      ] as const) {
        const settling = (await eventsOf(share.bookingId, share.dogId)).find(
          (e) => e.kind === kind,
        );
        assert.deepEqual(
          (await ledgerOf(share.bookingId)).map((r) => [r.reason, r.checkinEventId]),
          [
            ['booking-debit', null],
            ['settlement-return', settling?.id],
          ],
          kind,
        );
      }
      assert.deepEqual(
        (await ledgerOf(finished.bookingId)).map((r) => [r.reason, r.checkinEventId]),
        [['booking-debit', null]],
        'a finished send-home writes no row',
      );
    },
  );
});

describe("P20 fix 1, F1: returned_credits reads the rows that name the event (Fable L1, F'')", () => {
  test(
    'T3: a finished send-home with a foreign return at its own stamp → the body and the board read returned_credits 0',
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, lotId, bookingId, debitIds } = await onePepper();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '15:00'));
      const sent = attendance(
        await verb(app, {
          bookingId,
          dogId,
          verb: 'send-home',
          body: { training_completed: true },
        }),
      );
      const sentHome = sent.events.at(-1)!;
      assert.deepEqual(sentHome.settlement, { returned_credits: 0 });
      await plantAtEventStamp({
        eventId: sentHome.id,
        reason: 'settlement-return',
        lotId,
        reversesEntryId: debitIds.get(dogId)!,
      });

      clock.set(at(DAY, '16:00'));
      const out = attendance(await verb(app, { bookingId, dogId, verb: 'check-out' }));
      assert.deepEqual(
        out.events.find((e) => e.id === sentHome.id)?.settlement,
        { returned_credits: 0 },
        "the verb's body: the send-home returned nothing",
      );
      const row = (await board(app)).find((r) => r.dog_id === dogId);
      assert.deepEqual(row?.events.find((e) => e.id === sentHome.id)?.settlement, {
        returned_credits: 0,
      });
    },
  );

  test(
    "F'', a guard: a ticked check-out with a foreign debit at its own stamp → returned_credits stays 1",
    SKIP_WHEN_NO_DB,
    async () => {
      const { dogId, lotId, bookingId } = await onePepper();
      const clock = makeClock(at(DAY, '07:40'));
      const app = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      attendance(await verb(app, { bookingId, dogId, verb: 'check-in' }));
      clock.set(at(DAY, '11:00'));
      const out = attendance(
        await verb(app, { bookingId, dogId, verb: 'check-out', body: { reissue_credit: true } }),
      );
      const checkOut = out.events.at(-1)!;
      await plantAtEventStamp({ eventId: checkOut.id, reason: 'booking-debit', lotId });
      const row = (await board(app)).find((r) => r.dog_id === dogId);
      assert.deepEqual(row?.events.find((e) => e.id === checkOut.id)?.settlement, {
        returned_credits: 1,
      });
    },
  );
});

describe('B2-4: a turn-away frees its seat', () => {
  test(
    'the last seat taken, the dog turned away, the seat offered again',
    SKIP_WHEN_NO_DB,
    async () => {
      await db.insert(dayCapacity).values({ location: 'bentonville', date: DAY, capacityDogs: 1 });
      const { dogId, bookingId } = await onePepper();
      const late = await createFundedDog(createdDogs);
      const clock = makeClock(at(DAY, '07:05'));
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
      const book = () =>
        owner.inject({
          method: 'POST',
          url: '/bookings',
          headers: { 'idempotency-key': `p20-seat-${randomUUID()}` },
          payload: {
            category: 'day-school',
            lead_dog_id: late,
            dates: [DAY],
            location: 'bentonville',
            payment: { kind: 'credits' },
          },
        });
      const booked = async () =>
        (await dayCapacityRepository.findBookedCountsInRange('bentonville', DAY, DAY)).find(
          (r) => r.date === DAY,
        )?.booked ?? 0;

      assert.equal(await booked(), 1);
      refusal(await book(), 422, 'insufficient_capacity');

      await redis.set('avail:bentonville:p20-probe', 'stale');
      clock.set(at(DAY, '07:10'));
      attendance(await verb(staff, { bookingId, dogId, verb: 'turn-away' }));
      assert.equal(await booked(), 0, 'the turned-away share holds no seat');
      assert.equal(
        await redis.get('avail:bentonville:p20-probe'),
        null,
        'the availability cache is wiped',
      );

      clock.set(at(DAY, '07:15'));
      const again = await book();
      assert.equal(again.statusCode, 201, again.body);
      assert.equal(await booked(), 1);
      const newBooking = (JSON.parse(again.body) as { sessions: { id: string }[] }).sessions[0]?.id;
      if (newBooking !== undefined) sessions.push(newBooking);
    },
  );
});
