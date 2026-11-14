import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { BookingWire, CheckinBoardWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { dayCapacityRepository } from '../../src/db/repositories/dayCapacityRepository.js';
import { bookings, dogs, scheduledNotifications } from '../../src/db/schema/schema.js';
import { enqueueBookingReminders } from '../../src/lib/enqueueBookingReminders.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { clearPlantedPools, plantLot, poolBalance } from './_poolFixture.js';
import {
  at,
  boardApp,
  cancelNotices,
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
 * CXL-U09: one dog of several (s11), and the cancels' two new refusals
 * (design §1.1:1064-1075, §2.3:2418-2447; the red-first at :2455-2476; notes D3, D12,
 * D14). The Nguyens' Wed 21 Oct, Bao the lead and Luna, Bentonville day school.
 */

registerFixtureHooks();
const createdDogs: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  await db.execute(sql`UPDATE cancellation_global_settings SET per_dog_cancel_enabled = true`);
  await removeSessions(sessions.splice(0));
  await clearPlantedPools();
});
after(async () => {
  await removeDogs(createdDogs);
});

const WED = '2026-10-21';
const LOT_EXPIRES = at('2027-06-01', '12:00');
/** Luna's lot's date (`nguyens`): her live share names it as `return_expires_at` (P21, D1). */
const LUNA_LOT_EXPIRES = at('2027-07-01', '12:00');

async function named(name: string): Promise<string> {
  const dogId = await createBookableDog(createdDogs);
  await db.update(dogs).set({ name }).where(eq(dogs.id, dogId));
  return dogId;
}

interface Nguyens {
  bao: string;
  luna: string;
  bookingId: string;
  baoDebit: string;
  lunaDebit: string;
  baoLot: string;
  lunaLot: string;
}

/** Bao (lead) and Luna on Wed 21 Oct, each debited from her own lot. */
async function nguyens(date = WED): Promise<Nguyens> {
  const bao = await named('Bao');
  const luna = await named('Luna');
  const baoLot = await plantLot({ credits: 3, expiresAt: LOT_EXPIRES });
  const lunaLot = await plantLot({ credits: 3, expiresAt: LUNA_LOT_EXPIRES });
  const { bookingId, debitIds } = await createSession({
    dogIds: [bao, luna],
    date,
    lots: [baoLot, lunaLot],
    ledger: sessions,
  });
  return {
    bao,
    luna,
    bookingId,
    baoDebit: debitIds.get(bao)!,
    lunaDebit: debitIds.get(luna)!,
    baoLot,
    lunaLot,
  };
}

function wire(res: { statusCode: number; body: string }): BookingWire {
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as BookingWire;
}

async function bookedSeats(date = WED): Promise<number> {
  const rows = await dayCapacityRepository.findBookedCountsInRange('bentonville', date, date);
  return rows.find((r) => r.date === date)?.booked ?? 0;
}

describe('R8, R10: one dog leaves, the last dog takes the session with her', () => {
  test(
    "R8: Luna cancelled alone at 06:50 → 200, one settlement-return naming Luna's lot and reversing Luna's debit; Bao upcoming and counted; Luna's seat free",
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      assert.equal(await bookedSeats(), 2);
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at(WED, '06:50')));
      const after = wire(await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna }));
      assert.equal(after.status, 'upcoming');
      assert.equal(after.dog_id, n.bao);
      assert.equal(after.additional_dog_ids, undefined);
      assert.deepEqual(after.dog_shares, [
        {
          dog_id: n.bao,
          can_cancel: true,
          after_school: false,
          return_expires_at: LOT_EXPIRES.toISOString(),
        },
        {
          dog_id: n.luna,
          can_cancel: false,
          after_school: false,
          cancelled_at: at(WED, '06:50').toISOString(),
        },
      ]);
      const returns = (await ledgerOf(n.bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.equal(returns.length, 1);
      assert.equal(returns[0]?.delta, 1);
      assert.equal(returns[0]?.lotId, n.lunaLot);
      assert.equal(returns[0]?.reversesEntryId, n.lunaDebit);
      assert.equal(returns[0]?.dogId, n.luna);
      assert.equal(await bookedSeats(), 1, "Luna's seat is free and Bao's is counted");
      const notices = await cancelNotices(sessions);
      assert.deepEqual(
        notices.map((x) => x.body),
        [
          "You cancelled Luna's day school, Wed 21 Oct. +1 credit, back to your Bentonville day-school credits (expires 1 Jul).",
        ],
      );
    },
  );

  test(
    'R10: the last live dog cancelled → the session cancelled, its reminders torn down',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const reminderKey = `booking-reminder:${n.bookingId}`;
      await db.insert(scheduledNotifications).values({
        ownerId: FIXTURE_IDS.ownerId,
        type: 'booking-reminder',
        trigger: 'booking-reminder',
        dedupeKey: reminderKey,
        scheduledFor: at('2026-10-20', '18:00').toISOString(),
        title: 'Tomorrow',
        body: 'Day school tomorrow',
        bookingId: n.bookingId,
      });
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at(WED, '06:50')));
      wire(await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna }));
      const last = wire(await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.bao }));
      assert.equal(last.status, 'cancelled');
      assert.equal(
        last.dog_id,
        n.bao,
        'the last dog keeps her share, so a cancelled session has a dog',
      );
      assert.deepEqual(last.dog_shares, [
        { dog_id: n.bao, can_cancel: false, after_school: false },
        {
          dog_id: n.luna,
          can_cancel: false,
          after_school: false,
          cancelled_at: at(WED, '06:50').toISOString(),
        },
      ]);
      const [reminder] = await db
        .select({ status: scheduledNotifications.status })
        .from(scheduledNotifications)
        .where(eq(scheduledNotifications.dedupeKey, reminderKey));
      assert.equal(reminder?.status, 'cancelled');
      const returns = (await ledgerOf(n.bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.deepEqual(
        returns.map((r) => r.reversesEntryId).sort(),
        [n.baoDebit, n.lunaDebit].sort(),
      );
      assert.equal(await bookedSeats(), 0);
    },
  );

  test('a one-dog session: cancelling her alone cancels the session', SKIP_WHEN_NO_DB, async () => {
    const dogId = await named('Pepper');
    const lotId = await plantLot({ credits: 2, expiresAt: LOT_EXPIRES });
    const { bookingId } = await createSession({
      dogIds: [dogId],
      date: WED,
      lotId,
      ledger: sessions,
    });
    const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(WED, '06:50')));
    const after = wire(await staffDogCancel(staff, { bookingId, dogId }));
    assert.equal(after.status, 'cancelled');
    assert.equal(after.cancelled_by, 'staff');
    assert.equal(await poolBalance(), 2);
    assert.deepEqual(
      (await cancelNotices(sessions)).map((x) => x.body),
      [
        // P21 (NOTIF-U17, D13): the staff reason, from the reason sheet, quoted verbatim.
        `The school cancelled Pepper's day school on Wed 21 Oct: "Family called the desk". +1 credit, back to your Bentonville day-school credits (expires 1 Jun).`,
      ],
    );
  });
});

describe('R9, R11, R17: the clock and the fold', () => {
  test(
    'R9: Bao checked in, then Luna cancelled alone → 200, then Bao alone → 409 session_checked_in',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const clock = makeClock(at(WED, '07:40'));
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
      assert.equal(
        (await verb(staff, { bookingId: n.bookingId, dogId: n.bao, verb: 'check-in' })).statusCode,
        200,
      );
      clock.set(at(WED, '08:00'));
      wire(await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna }));
      const before = await ledgerOf(n.bookingId);
      refusal(
        await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.bao }),
        409,
        'session_checked_in',
      );
      refusal(
        await staffDogCancel(staff, { bookingId: n.bookingId, dogId: n.bao }),
        409,
        'session_checked_in',
      );
      refusal(await ownerCancel(owner, { bookingId: n.bookingId }), 409, 'session_checked_in');
      refusal(await staffCancel(staff, { bookingId: n.bookingId }), 409, 'session_checked_in');
      assert.deepEqual(await ledgerOf(n.bookingId), before, 'refusals write nothing');
    },
  );

  test('an undone check-in does not block a cancel', SKIP_WHEN_NO_DB, async () => {
    const n = await nguyens();
    const clock = makeClock(at(WED, '07:40'));
    const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
    await verb(staff, { bookingId: n.bookingId, dogId: n.bao, verb: 'check-in' });
    await verb(staff, { bookingId: n.bookingId, dogId: n.bao, verb: 'undo' });
    const after = wire(await staffCancel(staff, { bookingId: n.bookingId }));
    assert.equal(after.status, 'cancelled');
  });

  test(
    "R11: an owner cancel of yesterday's untapped row → 409 session_ended, ledger unchanged",
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens('2026-10-20');
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at(WED, '09:00')));
      const before = await ledgerOf(n.bookingId);
      const details = refusal(
        await ownerCancel(owner, { bookingId: n.bookingId }),
        409,
        'session_ended',
      );
      assert.deepEqual(details, { kind: 'session_ended', date: '2026-10-20' });
      assert.deepEqual(await ledgerOf(n.bookingId), before);
      const [row] = await db
        .select({ status: bookings.status })
        .from(bookings)
        .where(eq(bookings.id, n.bookingId));
      assert.equal(row?.status, 'upcoming');
      // A one-dog cancel reads the same clock.
      refusal(
        await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna }),
        409,
        'session_ended',
      );
    },
  );

  test(
    'R17: a staff cancel of a session dated three days ahead → 200 and one return',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await named('Pepper');
      const lotId = await plantLot({ credits: 2, expiresAt: LOT_EXPIRES });
      const { bookingId, debitIds } = await createSession({
        dogIds: [dogId],
        date: '2026-10-24',
        lotId,
        ledger: sessions,
      });
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(WED, '09:00')));
      const after = wire(await staffCancel(staff, { bookingId }));
      assert.equal(after.status, 'cancelled');
      const returns = (await ledgerOf(bookingId)).filter((r) => r.reason === 'settlement-return');
      assert.equal(returns.length, 1);
      assert.equal(returns[0]?.reversesEntryId, debitIds.get(dogId));
      assert.equal(returns[0]?.lotId, lotId);
    },
  );

  test(
    'a one-dog cancel answered 200 at 17:29 replays its 200 at 17:31, never session_ended',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const clock = makeClock(at(WED, '17:29'));
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
      const key = `p20-one-dog-replay-${randomUUID()}`;
      const first = wire(
        await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna, key }),
      );
      clock.set(at(WED, '17:31'));
      const replay = wire(
        await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna, key }),
      );
      assert.deepEqual(replay, first);
      refusal(
        await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.bao }),
        409,
        'session_ended',
      );
    },
  );

  test(
    'a whole-session cancel answered 200 at 17:29 replays its 200 at 17:31',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const clock = makeClock(at(WED, '17:29'));
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const key = `p20-whole-replay-${randomUUID()}`;
      const first = wire(await staffCancel(staff, { bookingId: n.bookingId, key }));
      clock.set(at(WED, '17:31'));
      assert.deepEqual(wire(await staffCancel(staff, { bookingId: n.bookingId, key })), first);
    },
  );
});

describe('D3: a lead cancelled alone', () => {
  test(
    'cancel Bao alone at 06:50; the owner list, the staff list and the board all answer with Luna leading',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const clock = makeClock(at(WED, '06:50'));
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      wire(await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.bao }));
      clock.set(at(WED, '07:00'));
      const expectShares = [
        {
          dog_id: n.luna,
          can_cancel: true,
          after_school: false,
          return_expires_at: LUNA_LOT_EXPIRES.toISOString(),
        },
        {
          dog_id: n.bao,
          can_cancel: false,
          after_school: false,
          cancelled_at: at(WED, '06:50').toISOString(),
        },
      ];

      const ownerList = await owner.inject({ method: 'GET', url: '/bookings?view=upcoming' });
      assert.equal(ownerList.statusCode, 200, ownerList.body);
      const ownerRow = (JSON.parse(ownerList.body) as BookingWire[]).find(
        (b) => b.id === n.bookingId,
      );
      assert.equal(ownerRow?.dog_id, n.luna);
      assert.equal(ownerRow?.additional_dog_ids, undefined);
      assert.deepEqual(ownerRow?.dog_shares, expectShares);

      const byId = wire(await owner.inject({ method: 'GET', url: `/bookings/${n.bookingId}` }));
      assert.equal(byId.dog_id, n.luna);

      const staffList = await staff.inject({
        method: 'GET',
        url: `/staff/bookings?from=${WED}&to=${WED}&location=bentonville`,
      });
      assert.equal(staffList.statusCode, 200, staffList.body);
      const staffRow = (JSON.parse(staffList.body) as BookingWire[]).find(
        (b) => b.id === n.bookingId,
      );
      assert.equal(staffRow?.dog_id, n.luna);
      assert.equal(staffRow?.additional_dog_ids, undefined);
      assert.deepEqual(staffRow?.dog_shares, expectShares);

      const board = await staff.inject({
        method: 'GET',
        url: `/staff/checkin-board?location=bentonville&date=${WED}`,
      });
      assert.equal(board.statusCode, 200, board.body);
      const rows = (JSON.parse(board.body) as CheckinBoardWire[]).filter(
        (r) => r.booking_id === n.bookingId,
      );
      assert.deepEqual(
        rows.map((r) => r.dog_id),
        [n.luna],
      );
    },
  );

  /** The day's reminder as booking creation queues it, and where it stands now. */
  async function queueReminder(n: Nguyens): Promise<() => Promise<unknown>> {
    await db.transaction((tx) =>
      enqueueBookingReminders(tx, {
        bookingId: n.bookingId,
        ownerId: FIXTURE_IDS.ownerId,
        leadDogId: n.bao,
        category: 'day-school',
        scheduledAt: at(WED, '07:30'),
      }),
    );
    return async () => {
      const rows = await db
        .select({ dogId: scheduledNotifications.dogId, status: scheduledNotifications.status })
        .from(scheduledNotifications)
        .where(eq(scheduledNotifications.dedupeKey, `booking-reminder:${n.bookingId}`));
      return rows;
    };
  }

  test(
    "Opus L1: Bao (the lead) cancelled alone → the day's queued reminder names Luna, still pending; then Luna, the last, cancels it",
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const reminder = await queueReminder(n);
      assert.deepEqual(await reminder(), [{ dogId: n.bao, status: 'pending' }]);
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at(WED, '06:50')));
      wire(await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.bao }));
      assert.deepEqual(
        await reminder(),
        [{ dogId: n.luna, status: 'pending' }],
        'nothing on her phone names a dog who is not coming (D3)',
      );
      wire(await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna }));
      assert.deepEqual(await reminder(), [{ dogId: n.luna, status: 'cancelled' }]);
    },
  );

  test(
    'F11 (Opus r2 N3, Fable r2 N8): a reminder already sent is history — Bao cancelled alone after it went out leaves the sent row naming Bao',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const reminder = await queueReminder(n);
      await db
        .update(scheduledNotifications)
        .set({ status: 'sent', sentAt: at('2026-10-20', '07:30').toISOString() })
        .where(eq(scheduledNotifications.dedupeKey, `booking-reminder:${n.bookingId}`));
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at(WED, '06:50')));
      wire(await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.bao }));
      assert.deepEqual(await reminder(), [{ dogId: n.bao, status: 'sent' }]);
    },
  );

  test(
    "Opus L1's control: Luna cancelled alone (by staff) → the reminder still names Bao, who is coming",
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const reminder = await queueReminder(n);
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(WED, '06:50')));
      wire(await staffDogCancel(staff, { bookingId: n.bookingId, dogId: n.luna }));
      assert.deepEqual(await reminder(), [{ dogId: n.bao, status: 'pending' }]);
    },
  );
});

describe('P20 fix 1, F1, T4: a cancel names no check-in event', () => {
  test(
    "the owner's and the staff's one-dog cancels and the whole cancel each write returns naming no event",
    SKIP_WHEN_NO_DB,
    async () => {
      const ownerAlone = await nguyens();
      const staffAlone = await nguyens();
      const whole = await nguyens();
      const clock = makeClock(at(WED, '06:50'));
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      wire(
        await ownerDogCancel(owner, { bookingId: ownerAlone.bookingId, dogId: ownerAlone.luna }),
      );
      wire(
        await staffDogCancel(staff, { bookingId: staffAlone.bookingId, dogId: staffAlone.luna }),
      );
      // The whole cancel returns every credit: no cancel forfeits from P21 (CXL-U04).
      const early = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at('2026-10-18', '12:00')));
      wire(await staffCancel(early, { bookingId: whole.bookingId }));
      for (const [n, returns] of [
        [ownerAlone, 1],
        [staffAlone, 1],
        [whole, 2],
      ] as const) {
        const rows = await ledgerOf(n.bookingId);
        assert.equal(rows.filter((r) => r.reason === 'settlement-return').length, returns);
        assert.deepEqual(
          rows.map((r) => r.checkinEventId),
          rows.map(() => null),
        );
      }
    },
  );
});

describe('D14: the switch', () => {
  test(
    "per_dog_cancel_enabled off: the owner's one-dog cancel → 409 per_dog_cancel_off and her can_cancel false; staff unaffected",
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      await db.execute(sql`UPDATE cancellation_global_settings SET per_dog_cancel_enabled = false`);
      const clock = makeClock(at(WED, '06:50'));
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      refusal(
        await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna }),
        409,
        'per_dog_cancel_off',
      );
      const ownerRead = wire(
        await owner.inject({ method: 'GET', url: `/bookings/${n.bookingId}` }),
      );
      assert.deepEqual(ownerRead.dog_shares, [
        {
          dog_id: n.bao,
          can_cancel: false,
          after_school: false,
          return_expires_at: LOT_EXPIRES.toISOString(),
        },
        {
          dog_id: n.luna,
          can_cancel: false,
          after_school: false,
          return_expires_at: LUNA_LOT_EXPIRES.toISOString(),
        },
      ]);
      assert.equal(ownerRead.can_cancel, true, 'the whole session still cancels');

      const staffAfter = wire(
        await staffDogCancel(staff, { bookingId: n.bookingId, dogId: n.luna }),
      );
      assert.deepEqual(staffAfter.dog_shares?.[0], {
        dog_id: n.bao,
        can_cancel: true,
        after_school: false,
        return_expires_at: LOT_EXPIRES.toISOString(),
      });
    },
  );
});

describe('the one-dog refusals, in order', () => {
  test(
    'a dog never on the booking → 404; another family’s booking → 404',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const stranger = await named('Stranger');
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at(WED, '06:50')));
      refusal(
        await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: stranger }),
        404,
        'not_found',
      );
      refusal(
        await ownerDogCancel(owner, { bookingId: randomUUID(), dogId: n.luna }),
        404,
        'not_found',
      );
    },
  );

  test('not a day program → 422 invalid_payload', SKIP_WHEN_NO_DB, async () => {
    const dogId = await named('Pip');
    const bookingId = randomUUID();
    sessions.push(bookingId);
    await db.insert(bookings).values({
      id: bookingId,
      ownerId: FIXTURE_IDS.ownerId,
      leadDogId: dogId,
      category: 'private-lesson',
      scheduledAt: at(WED, '10:00').toISOString(),
      location: 'bentonville',
    });
    await db.execute(
      sql`INSERT INTO booking_dogs (booking_id, dog_id, is_lead) VALUES (${bookingId}, ${dogId}, true)`,
    );
    const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at(WED, '06:50')));
    refusal(await ownerDogCancel(owner, { bookingId, dogId }), 422, 'invalid_payload');
  });

  test(
    'a share already cancelled alone → 409 session_cancelled, on the cancels and on the verbs',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const clock = makeClock(at(WED, '06:50'));
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      wire(await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna }));
      refusal(
        await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna }),
        409,
        'session_cancelled',
      );
      refusal(
        await staffDogCancel(staff, { bookingId: n.bookingId, dogId: n.luna }),
        409,
        'session_cancelled',
      );
      clock.set(at(WED, '07:40'));
      refusal(
        await verb(staff, { bookingId: n.bookingId, dogId: n.luna, verb: 'check-in' }),
        409,
        'session_cancelled',
      );
      assert.equal(
        (await ledgerOf(n.bookingId)).filter((r) => r.reason === 'settlement-return').length,
        1,
      );
    },
  );

  test(
    'a cancelled session → 409 session_cancelled; a payment-pending row → 409 payment_pending',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at('2026-10-19', '09:00')));
      wire(await ownerCancel(owner, { bookingId: n.bookingId }));
      refusal(
        await ownerDogCancel(owner, { bookingId: n.bookingId, dogId: n.luna }),
        409,
        'session_cancelled',
      );

      const mochi = await named('Mochi');
      const pending = await createSession({
        dogIds: [mochi],
        date: WED,
        status: 'payment-pending',
        ledger: sessions,
      });
      refusal(
        await ownerDogCancel(owner, { bookingId: pending.bookingId, dogId: mochi }),
        409,
        'payment_pending',
      );
    },
  );

  test(
    "the staff one-dog cancel's reason is required, 1..500 after trim",
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(WED, '06:50')));
      for (const payload of [{}, { reason: '  ' }, { reason: 'x'.repeat(501) }]) {
        const res = await staff.inject({
          method: 'POST',
          url: `/staff/bookings/${n.bookingId}/dogs/${n.luna}/cancel`,
          headers: { 'idempotency-key': `p20-reason-${randomUUID()}` },
          payload,
        });
        refusal(res, 422, 'invalid_payload');
      }
    },
  );
});

describe('BookingWire.can_cancel', () => {
  test(
    'true before anything happens; false once a dog is in, and once the day has ended',
    SKIP_WHEN_NO_DB,
    async () => {
      const n = await nguyens();
      const clock = makeClock(at(WED, '07:00'));
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, clock);
      const staff = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      assert.equal(
        wire(await owner.inject({ method: 'GET', url: `/bookings/${n.bookingId}` })).can_cancel,
        true,
      );
      clock.set(at(WED, '07:40'));
      await verb(staff, { bookingId: n.bookingId, dogId: n.luna, verb: 'check-in' });
      const read = wire(await owner.inject({ method: 'GET', url: `/bookings/${n.bookingId}` }));
      assert.equal(read.can_cancel, false);
      assert.deepEqual(read.dog_shares, [
        {
          dog_id: n.bao,
          can_cancel: true,
          after_school: false,
          return_expires_at: LOT_EXPIRES.toISOString(),
        },
        {
          dog_id: n.luna,
          can_cancel: false,
          after_school: false,
          return_expires_at: LUNA_LOT_EXPIRES.toISOString(),
        },
      ]);
      clock.set(at(WED, '17:30'));
      const ended = wire(await owner.inject({ method: 'GET', url: `/bookings/${n.bookingId}` }));
      assert.equal(ended.dog_shares?.[0]?.can_cancel, false);
    },
  );
});

describe('the alarm, through the route', () => {
  test(
    'a cancel that finds no live debit for a live share of a day row → 500 and one alarm naming the booking and the dog',
    SKIP_WHEN_NO_DB,
    async () => {
      // The whole-session cancel returns credits (no cancel forfeits from P21, CXL-U04).
      const dogId = await named('Ghost');
      const lunaId = await named('Luna');
      const lotId = await plantLot({ credits: 2, expiresAt: LOT_EXPIRES });
      const { bookingId } = await createSession({
        dogIds: [dogId, lunaId],
        date: '2026-10-24',
        lots: [null, lotId],
        ledger: sessions,
      });
      const capture = makeLogCapture();
      const owner = boardApp(FIXTURE_OWNER_PRINCIPAL, makeClock(at(WED, '06:50')), capture);
      const oneDog = await ownerDogCancel(owner, { bookingId, dogId });
      assert.equal(oneDog.statusCode, 500, oneDog.body);
      const whole = await ownerCancel(owner, { bookingId });
      assert.equal(whole.statusCode, 500, whole.body);
      const alarms = capture.lines.filter((l) => l.level === 50 && l.bookingId === bookingId);
      assert.deepEqual(
        alarms.map((l) => l.dogId),
        [dogId, dogId],
        'one alarm per cancel, naming the share with no debit',
      );
      assert.deepEqual(
        (await ledgerOf(bookingId)).map((r) => r.reason),
        ['booking-debit'],
        "Luna's debit, nothing returned",
      );
      const [row] = await db
        .select({ status: bookings.status })
        .from(bookings)
        .where(eq(bookings.id, bookingId));
      assert.equal(row?.status, 'upcoming', 'both rolled back');
    },
  );
});
