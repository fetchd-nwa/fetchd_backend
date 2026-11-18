import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { ApiErrorEnvelope, PendingRequestWire } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { dogVaccines, dogs, notifications } from '../../src/db/schema/schema.js';
import { FIXTURE_IDS } from './_fixture.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import * as rs from './_requestServices.js';

/**
 * Plan unit P49, fix round 1: design request-services-v1 § 14, Amendment A1 (build DECISIONS
 * 509, 511; wire 9.0.0 v3, `RequestStayConflictDetails`).
 *   1. A Board & Train is not booked over another stay: staff's approve answers 422 and the
 *      family's yes 409 `stay_overlap` when a dog on the request holds a live, uncancelled
 *      boarding or Board & Train stay whose Chicago-date window overlaps (dates, not hours).
 *   2. A dog removed after approval: the yes answers 409 `dog_removed`; the approve 422, on
 *      every arm.
 *   3. The locks: the approve and the yes take the dog lock for every dog, and the boarding
 *      approve takes it before its INSERT.
 *   4. The one-night floor: the hand-back is on a later Chicago day than the drop-off.
 * The fixture clock is Tue 19 May 2026; every instant is CDT (UTC-5). Waffles and Lola are
 * the fixture's two dogs, and the window approved below is Mon 1 Jun 08:00 – Sun 14 Jun 15:00.
 */

registerFixtureHooks();
afterEach(rs.clearRequestServiceRows);

const WAFFLES = FIXTURE_IDS.dog1Id;
const LOLA = FIXTURE_IDS.dog2Id;

function errorOf(res: { body: string }): ApiErrorEnvelope['error'] {
  return (JSON.parse(res.body) as ApiErrorEnvelope).error;
}

function refused(
  res: { statusCode: number; body: string },
  status: number,
  code: string,
  message: string,
): ApiErrorEnvelope['error'] {
  assert.equal(res.statusCode, status, res.body);
  const error = errorOf(res);
  assert.equal(error.code, code, res.body);
  assert.equal(error.message, message);
  return error;
}

/** A Board & Train Shanthi approved for the window above, with Rachel, waiting on the yes. */
async function approvedBoardTrain(dogIds: readonly string[] = [WAFFLES]): Promise<string> {
  const id = await rs.plantRequest({ category: 'board-and-train', dogIds });
  const res = await rs.approveBoardTrain(id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as PendingRequestWire).status, 'approved-awaiting-payment');
  return id;
}

/** The request as staff found it: still submitted, nothing approved stored, no notice. */
async function storedNothing(id: string): Promise<void> {
  const row = await rs.requestRow(id);
  assert.equal(row?.status, 'submitted');
  assert.equal(row?.approvedAt, null);
  assert.equal(row?.approvedByStaffId, null);
  assert.equal(row?.approvedDropoffAt, null);
  assert.equal(row?.approvedPickupAt, null);
  assert.equal(row?.approvedTrainerStaffId, null);
  assert.equal(row?.approvedPriceCents, null);
  const notices = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.deepLinkId, id));
  assert.deepEqual(notices, [], 'a notice was queued');
}

async function stillWaiting(id: string): Promise<void> {
  assert.equal((await rs.requestRow(id))?.status, 'approved-awaiting-payment');
}

async function boardTrainBookings(): Promise<number> {
  return (await rs.testBookings()).filter((b) => b.category === 'board-and-train').length;
}

const overlapAtApprove = (dog: string, booked: string): string =>
  `${dog} already has a stay booked ${booked}, so this one can't be approved over it. ` +
  'Pick another of their starts or another hand-back, or deny it.';
const overlapAtYes = (dog: string): string =>
  `${dog} already has a stay booked over these dates, so nothing was booked. ` +
  'Withdraw this request and send a new one with other dates, or call the school.';
const removedAtYes = (dog: string): string =>
  `${dog} is no longer on your account, so nothing was booked. Withdraw this request.`;
const removedAtApprove = (dog: string): string =>
  `${dog} is no longer on this family's account. Deny the request.`;
const ONE_NIGHT = 'The hand-back must be on a later day than the drop-off.';

describe('A1.1: a Board & Train is not booked over another stay', () => {
  test(
    "Juniper's two stays: a second Board & Train approved over the first one booked → 422 in words, and nothing is stored",
    SKIP_WHEN_NO_DB,
    async () => {
      const first = await approvedBoardTrain();
      assert.equal((await rs.confirm(first)).statusCode, 200);
      const second = await rs.plantRequest({
        category: 'board-and-train',
        preferredDates: [rs.BT_STARTS[1]],
      });
      refused(
        await rs.approveBoardTrain(second, { dropoff_at: rs.BT_STARTS[1], pickup_at: rs.BT_PICKUP }),
        422,
        'invalid_payload',
        overlapAtApprove('Waffles', 'Mon 1 Jun – Sun 14 Jun'),
      );
      await storedNothing(second);
      assert.equal(await boardTrainBookings(), 1, 'one stay');
    },
  );

  test(
    'the boarding-between road: approved, then a boarding stay booked inside it, then the yes → 409 stay_overlap, 0 Board & Train bookings',
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await approvedBoardTrain();
      const boarding = await rs.plantRequest({
        category: 'boarding',
        preferredDates: ['2026-06-05T13:00:00.000Z'],
      });
      const board = await rs.approve(boarding, {
        scheduled_at: '2026-06-05T13:00:00.000Z', // Fri 5 Jun 08:00
        pickup_at: '2026-06-07T20:00:00.000Z', // Sun 7 Jun 15:00
        location: 'fayetteville',
      });
      assert.equal(board.statusCode, 200, board.body);

      const error = refused(await rs.confirm(id), 409, 'conflict', overlapAtYes('Waffles'));
      assert.deepEqual(error.details, { kind: 'conflict', reason: 'stay_overlap', dog_id: WAFFLES });
      await stillWaiting(id);
      assert.equal(await boardTrainBookings(), 0);
    },
  );

  test(
    'dates, not hours: a hand-back Sun 15:00 and a drop-off Sun 17:00 overlap and are refused; the next day is not',
    SKIP_WHEN_NO_DB,
    async () => {
      await rs.plantBooking({
        category: 'boarding',
        dogIds: [WAFFLES],
        scheduledAt: '2026-05-29T13:00:00.000Z', // Fri 29 May 08:00
        pickupAt: '2026-05-31T20:00:00.000Z', // Sun 31 May 15:00
      });
      const id = await rs.plantRequest({
        category: 'board-and-train',
        preferredDates: ['2026-05-31T22:00:00.000Z', rs.BT_STARTS[0]], // Sun 31 May 17:00, Mon 1 Jun 08:00
      });
      refused(
        await rs.approveBoardTrain(id, { dropoff_at: '2026-05-31T22:00:00.000Z' }),
        422,
        'invalid_payload',
        overlapAtApprove('Waffles', 'Fri 29 May – Sun 31 May'),
      );
      await storedNothing(id);
      const nextDay = await rs.approveBoardTrain(id);
      assert.equal(nextDay.statusCode, 200, nextDay.body);
    },
  );

  test(
    'the mirror: a stay that starts on the hand-back day overlaps too',
    SKIP_WHEN_NO_DB,
    async () => {
      await rs.plantBooking({
        category: 'boarding',
        dogIds: [WAFFLES],
        scheduledAt: '2026-06-14T22:00:00.000Z', // Sun 14 Jun 17:00
        pickupAt: '2026-06-16T20:00:00.000Z', // Tue 16 Jun 15:00
      });
      const id = await rs.plantRequest({ category: 'board-and-train' });
      refused(
        await rs.approveBoardTrain(id),
        422,
        'invalid_payload',
        overlapAtApprove('Waffles', 'Sun 14 Jun – Tue 16 Jun'),
      );
      await storedNothing(id);
    },
  );

  test(
    'a lesson on the drop-off day does not refuse a stay: approve 200, yes 200',
    SKIP_WHEN_NO_DB,
    async () => {
      await rs.plantBooking({
        category: 'private-lesson',
        dogIds: [WAFFLES],
        scheduledAt: '2026-06-01T21:00:00.000Z', // Mon 1 Jun 16:00
      });
      const id = await approvedBoardTrain();
      const res = await rs.confirm(id);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(await boardTrainBookings(), 1);
    },
  );

  test(
    'a cancelled stay inside the window does not refuse it',
    SKIP_WHEN_NO_DB,
    async () => {
      await rs.plantBooking({
        category: 'boarding',
        dogIds: [WAFFLES],
        scheduledAt: '2026-06-05T13:00:00.000Z',
        pickupAt: '2026-06-07T20:00:00.000Z',
        cancelled: true,
      });
      const id = await approvedBoardTrain();
      assert.equal((await rs.confirm(id)).statusCode, 200);
    },
  );

  test(
    'a two-dog request where one dog overlaps is refused whole, at the approve and at the yes; nothing is booked for the other dog',
    SKIP_WHEN_NO_DB,
    async () => {
      const lolasStay = {
        category: 'boarding' as const,
        dogIds: [LOLA],
        scheduledAt: '2026-06-10T13:00:00.000Z', // Wed 10 Jun 08:00
        pickupAt: '2026-06-12T20:00:00.000Z', // Fri 12 Jun 15:00
      };
      // At the yes: approved for both dogs first, then Lola's stay is booked.
      const waiting = await approvedBoardTrain([WAFFLES, LOLA]);
      await rs.plantBooking(lolasStay);
      const error = refused(await rs.confirm(waiting), 409, 'conflict', overlapAtYes('Lola'));
      assert.deepEqual(error.details, { kind: 'conflict', reason: 'stay_overlap', dog_id: LOLA });
      await stillWaiting(waiting);
      assert.equal(await boardTrainBookings(), 0, 'a stay was booked for Waffles alone');

      // At the approve.
      const id = await rs.plantRequest({ category: 'board-and-train', dogIds: [WAFFLES, LOLA] });
      refused(
        await rs.approveBoardTrain(id),
        422,
        'invalid_payload',
        overlapAtApprove('Lola', 'Wed 10 Jun – Fri 12 Jun'),
      );
      await storedNothing(id);
    },
  );

  test(
    'the sentence names the first dog by name, and that dog\'s earliest overlapping stay; a stay with no pick-up prints "from"',
    SKIP_WHEN_NO_DB,
    async () => {
      await rs.plantBooking({
        category: 'boarding',
        dogIds: [WAFFLES],
        scheduledAt: '2026-06-09T13:00:00.000Z', // Tue 9 Jun
        pickupAt: '2026-06-10T20:00:00.000Z',
      });
      await rs.plantBooking({
        category: 'boarding',
        dogIds: [WAFFLES],
        scheduledAt: '2026-06-03T13:00:00.000Z', // Wed 3 Jun, no pick-up yet
        pickupAt: null,
      });
      await rs.plantBooking({
        category: 'board-and-train',
        dogIds: [LOLA],
        scheduledAt: '2026-06-11T13:00:00.000Z', // Thu 11 Jun
        pickupAt: '2026-06-12T20:00:00.000Z', // Fri 12 Jun
      });
      const both = await rs.plantRequest({ category: 'board-and-train', dogIds: [WAFFLES, LOLA] });
      refused(
        await rs.approveBoardTrain(both),
        422,
        'invalid_payload',
        overlapAtApprove('Lola', 'Thu 11 Jun – Fri 12 Jun'),
      );
      const one = await rs.plantRequest({ category: 'board-and-train' });
      refused(
        await rs.approveBoardTrain(one),
        422,
        'invalid_payload',
        overlapAtApprove('Waffles', 'from Wed 3 Jun'),
      );
      await storedNothing(both);
      await storedNothing(one);
    },
  );

  test('the overlap is refused before the gates: no card, and the yes still answers 409 stay_overlap', SKIP_WHEN_NO_DB, async () => {
    const id = await approvedBoardTrain();
    await rs.plantBooking({
      category: 'boarding',
      dogIds: [WAFFLES],
      scheduledAt: '2026-06-05T13:00:00.000Z',
      pickupAt: '2026-06-07T20:00:00.000Z',
    });
    await rs.withoutCard(async () => {
      const error = refused(await rs.confirm(id), 409, 'conflict', overlapAtYes('Waffles'));
      assert.deepEqual(error.details, { kind: 'conflict', reason: 'stay_overlap', dog_id: WAFFLES });
    });
    await stillWaiting(id);
  });
});

describe('A1.2: a dog removed after approval', () => {
  test(
    'removed, then the yes → 409 dog_removed in words, 0 bookings, and the request stays waiting',
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await approvedBoardTrain();
      await rs.withDogRemoved(WAFFLES, async () => {
        const error = refused(await rs.confirm(id), 409, 'conflict', removedAtYes('Waffles'));
        assert.deepEqual(error.details, { kind: 'conflict', reason: 'dog_removed', dog_id: WAFFLES });
      });
      await stillWaiting(id);
      assert.equal((await rs.testBookings()).length, 0);
    },
  );

  for (const arm of ['private-lesson', 'board-and-train', 'boarding'] as const) {
    test(`removed, then a ${arm} approve → 422 in words, and nothing is booked or stored`, SKIP_WHEN_NO_DB, async () => {
      const id = await rs.plantRequest({
        category: arm,
        ...(arm === 'boarding' ? { preferredDates: [rs.BT_STARTS[0]] } : {}),
      });
      await rs.withDogRemoved(WAFFLES, async () => {
        const res =
          arm === 'private-lesson'
            ? await rs.approveLesson(id)
            : arm === 'board-and-train'
              ? await rs.approveBoardTrain(id)
              : await rs.approve(id, {
                  scheduled_at: rs.BT_STARTS[0],
                  pickup_at: rs.BT_PICKUP,
                  location: 'fayetteville',
                });
        refused(res, 422, 'invalid_payload', removedAtApprove('Waffles'));
      });
      await storedNothing(id);
      assert.equal((await rs.testBookings()).length, 0);
    });
  }

  test('the two-dog version: Lola removed refuses the whole yes and the whole approve', SKIP_WHEN_NO_DB, async () => {
    const waiting = await approvedBoardTrain([WAFFLES, LOLA]);
    const lesson = await rs.plantRequest({ category: 'private-lesson', dogIds: [WAFFLES, LOLA] });
    await rs.withDogRemoved(LOLA, async () => {
      const error = refused(await rs.confirm(waiting), 409, 'conflict', removedAtYes('Lola'));
      assert.deepEqual(error.details, { kind: 'conflict', reason: 'dog_removed', dog_id: LOLA });
      refused(await rs.approveLesson(lesson), 422, 'invalid_payload', removedAtApprove('Lola'));
    });
    await stillWaiting(waiting);
    await storedNothing(lesson);
    assert.equal((await rs.testBookings()).length, 0);
  });

  test(
    'the order: a removed dog is answered before an overlap, never as a vaccine or card 422, and after the trainer refusal',
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await approvedBoardTrain();
      await rs.plantBooking({
        category: 'boarding',
        dogIds: [WAFFLES],
        scheduledAt: '2026-06-05T13:00:00.000Z',
        pickupAt: '2026-06-07T20:00:00.000Z',
      });
      const fresh = await rs.plantRequest({ category: 'board-and-train' });
      await db
        .update(dogVaccines)
        .set({ expiredAt: '2026-05-18T12:00:00.000Z' })
        .where(eq(dogVaccines.id, FIXTURE_IDS.vaccine1Id));
      try {
        await rs.withDogRemoved(WAFFLES, async () => {
          // Removed before overlap, at the yes and at the approve.
          const error = refused(await rs.confirm(id), 409, 'conflict', removedAtYes('Waffles'));
          assert.equal((error.details as { reason?: string } | undefined)?.reason, 'dog_removed');
          refused(await rs.approveBoardTrain(fresh), 422, 'invalid_payload', removedAtApprove('Waffles'));
          // Never a vaccine 422 (her rabies has lapsed) or a card 422.
          await rs.withoutCard(async () => {
            refused(await rs.confirm(id), 409, 'conflict', removedAtYes('Waffles'));
          });
          // After the trainer refusal: Rachel gone answers first, with no details.
          await rs.withStaff(FIXTURE_IDS.staffRachelId, { expiredAt: '2026-05-18T12:00:00.000Z' }, async () => {
            const trainer = await rs.confirm(id);
            assert.equal(trainer.statusCode, 409, trainer.body);
            assert.equal(
              errorOf(trainer).message,
              `the trainer approved for pending request ${id} can no longer take it; the school needs to update the request`,
            );
            assert.equal(errorOf(trainer).details, undefined);
          });
        });
      } finally {
        await db
          .update(dogVaccines)
          .set({ expiredAt: null })
          .where(eq(dogVaccines.id, FIXTURE_IDS.vaccine1Id));
      }
      await stillWaiting(id);
      await storedNothing(fresh);
      assert.equal(await boardTrainBookings(), 0);
    },
  );
});

describe('A1.3: the yes racing a boarding approve for the same dog, on real connections', () => {
  // Waffles' dog lock is held by a third connection, so both requests queue behind it in the
  // order sent, then run one after the other.
  const BOARDING_AT = '2026-06-05T13:00:00.000Z'; // Fri 5 Jun 08:00, inside the window
  const BOARDING_PICKUP = '2026-06-07T20:00:00.000Z'; // Sun 7 Jun 15:00
  for (const order of ['boarding first', 'yes first'] as const) {
    test(
      `${order}: the yes never books over the boarding stay`,
      SKIP_WHEN_NO_DB,
      async () => {
        const bt = await approvedBoardTrain();
        const boarding = await rs.plantRequest({ category: 'boarding', preferredDates: [BOARDING_AT] });
        const yes = () => rs.confirm(bt);
        const board = () =>
          rs.approve(boarding, {
            scheduled_at: BOARDING_AT,
            pickup_at: BOARDING_PICKUP,
            location: 'fayetteville',
          });
        const held = await rs.holdDogLock(WAFFLES);
        const fired: Promise<{ statusCode: number; body: string }>[] = [];
        let answers: { statusCode: number; body: string }[] = [];
        try {
          const [first, second] = order === 'yes first' ? [yes, board] : [board, yes];
          fired.push(first());
          await rs.blockedOrAnswered(1, fired[0] as Promise<unknown>);
          fired.push(second());
          await rs.blockedOrAnswered(2, fired[1] as Promise<unknown>);
          await held.release();
          answers = await Promise.all(fired);
        } finally {
          await held.release();
          await Promise.allSettled(fired);
        }
        const [yesAnswer, boardAnswer] = order === 'yes first' ? answers : [answers[1], answers[0]];
        const stays = (await rs.testBookings()).map((b) => b.category).sort();
        assert.equal(boardAnswer?.statusCode, 200, boardAnswer?.body);
        if (order === 'boarding first') {
          // The boarding stay landed first; the yes waited, then read it.
          assert.equal(yesAnswer?.statusCode, 409, yesAnswer?.body);
          assert.equal(errorOf(yesAnswer as { body: string }).message, overlapAtYes('Waffles'));
          assert.deepEqual(stays, ['boarding'], 'one stay');
          await stillWaiting(bt);
        } else {
          // The yes booked first. Boarding's approve is unchanged apart from the lock (A1
          // "Not here"), so its stay books after it: a boarding request approved over a Board
          // & Train is on Allison's test list, not refused here.
          assert.equal(yesAnswer?.statusCode, 200, yesAnswer?.body);
          assert.deepEqual(stays, ['board-and-train', 'boarding']);
        }
      },
    );
  }
});

describe('A1.3: the Board & Train approve racing a boarding approve for the same dog, on real connections', () => {
  const BOARDING_AT = '2026-06-05T13:00:00.000Z'; // Fri 5 Jun 08:00, inside the window
  const BOARDING_PICKUP = '2026-06-07T20:00:00.000Z'; // Sun 7 Jun 15:00
  for (const order of ['boarding first', 'approve first'] as const) {
    test(
      `${order}: the approve never parks a Board & Train over the boarding stay`,
      SKIP_WHEN_NO_DB,
      async () => {
        const bt = await rs.plantRequest({ category: 'board-and-train' });
        const boarding = await rs.plantRequest({ category: 'boarding', preferredDates: [BOARDING_AT] });
        const approveIt = () => rs.approveBoardTrain(bt);
        const board = () =>
          rs.approve(boarding, {
            scheduled_at: BOARDING_AT,
            pickup_at: BOARDING_PICKUP,
            location: 'fayetteville',
          });
        const held = await rs.holdDogLock(WAFFLES);
        const fired: Promise<{ statusCode: number; body: string }>[] = [];
        let answers: { statusCode: number; body: string }[] = [];
        try {
          const [first, second] = order === 'approve first' ? [approveIt, board] : [board, approveIt];
          fired.push(first());
          await rs.blockedOrAnswered(1, fired[0] as Promise<unknown>);
          fired.push(second());
          await rs.blockedOrAnswered(2, fired[1] as Promise<unknown>);
          await held.release();
          answers = await Promise.all(fired);
        } finally {
          await held.release();
          await Promise.allSettled(fired);
        }
        const [approveAnswer, boardAnswer] = order === 'approve first' ? answers : [answers[1], answers[0]];
        assert.equal(boardAnswer?.statusCode, 200, boardAnswer?.body);
        assert.deepEqual((await rs.testBookings()).map((b) => b.category), ['boarding']);
        if (order === 'boarding first') {
          // The boarding stay landed first; the approve waited, then read it.
          assert.equal(approveAnswer?.statusCode, 422, approveAnswer?.body);
          assert.equal(
            errorOf(approveAnswer as { body: string }).message,
            overlapAtApprove('Waffles', 'Fri 5 Jun – Sun 7 Jun'),
          );
          await storedNothing(bt);
        } else {
          // Parked first (nothing booked); the boarding approve is unchanged apart from the lock.
          assert.equal(approveAnswer?.statusCode, 200, approveAnswer?.body);
        }
      },
    );
  }
});

describe('B-N1: her DELETE /dogs/:id racing the yes for the same dog, on real connections', () => {
  // Fayetteville's `locations` row is held FOR UPDATE by a third connection. The stay's INSERT
  // names the family's home campus (Fayetteville), so the yes stops at that INSERT, after its
  // removed-dog read, holding Waffles' dog lock. Her delete names no campus, so only the dog
  // lock can make it wait.
  test(
    "the yes holds Waffles' lock, her delete waits for it, and the yes books",
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await approvedBoardTrain();
      const answered: string[] = [];
      const campus = await rs.holdCampusRow('fayetteville');
      let yes: Promise<{ statusCode: number; body: string }> | undefined;
      let removal: Promise<{ statusCode: number; body: string }> | undefined;
      try {
        yes = rs.confirm(id).then((res) => {
          answered.push('yes');
          return res;
        });
        await rs.blockedOrAnswered(1, yes);
        const yesHeld = {
          waiting: await rs.lockWaits(),
          wafflesLockHeld: await rs.dogLockHeld(WAFFLES),
        };
        removal = rs.deleteDog(WAFFLES).then((res) => {
          answered.push('delete');
          return res;
        });
        await rs.blockedOrAnswered(2, removal);
        const [waffles] = await db
          .select({ expiredAt: dogs.expiredAt })
          .from(dogs)
          .where(eq(dogs.id, WAFFLES));
        const deleteFired = {
          waiting: await rs.lockWaits(),
          answered: [...answered],
          wafflesRemoved: waffles?.expiredAt !== null,
        };
        await campus.release();
        const [yesAnswer, removalAnswer] = await Promise.all([yes, removal]);
        assert.deepEqual(
          yesHeld,
          { waiting: ['insert into "bookings"'], wafflesLockHeld: true },
          "the yes waits at its stay's INSERT, holding Waffles' lock",
        );
        assert.deepEqual(
          deleteFired,
          {
            waiting: ['SELECT pg_advisory_xact_lock(hashtext($1))', 'insert into "bookings"'],
            answered: [],
            wafflesRemoved: false,
          },
          "her delete waits on Waffles' lock while the yes holds it",
        );
        assert.equal(yesAnswer.statusCode, 200, yesAnswer.body);
        assert.equal(removalAnswer.statusCode, 204, removalAnswer.body);
        assert.deepEqual(answered, ['yes', 'delete'], 'the yes books first, then she removes Waffles');
        const stays = await rs.testBookings();
        assert.deepEqual(
          stays.map((b) => [b.category, b.leadDogId]),
          [['board-and-train', WAFFLES]],
        );
        assert.equal((await rs.requestRow(id))?.status, 'converted');
      } finally {
        await campus.release();
        await Promise.allSettled([yes, removal]);
        await db.update(dogs).set({ expiredAt: null }).where(eq(dogs.id, WAFFLES));
      }
    },
  );
});

describe('A1 item 3: the one-night floor, on Chicago dates', () => {
  test(
    'a hand-back on the drop-off\'s Chicago day → 422 in words, up to 23:59:59.999; Tue 00:00 is the next day and approves',
    SKIP_WHEN_NO_DB,
    async () => {
      const id = await rs.plantRequest({ category: 'board-and-train' });
      for (const pickup of [
        '2026-06-02T01:00:00.000Z', // Mon 1 Jun 20:00: a later UTC date, the same Chicago day
        '2026-06-02T04:59:59.999Z', // Mon 1 Jun 23:59:59.999
      ]) {
        refused(await rs.approveBoardTrain(id, { pickup_at: pickup }), 422, 'invalid_payload', ONE_NIGHT);
        await storedNothing(id);
      }
      // The floor replaces "strictly after" (wire 9.0.0 v3): a pick-up at the drop-off, or on
      // an earlier day, is on no later day either.
      for (const pickup of [rs.BT_STARTS[0], '2026-05-31T20:00:00.000Z']) {
        refused(await rs.approveBoardTrain(id, { pickup_at: pickup }), 422, 'invalid_payload', ONE_NIGHT);
        await storedNothing(id);
      }
      const ok = await rs.approveBoardTrain(id, { pickup_at: '2026-06-02T05:00:00.000Z' }); // Tue 2 Jun 00:00
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal((ok.json() as PendingRequestWire).approved_pickup_at, '2026-06-02T05:00:00.000Z');
    },
  );

  test(
    'a drop-off at 23:30: a hand-back 29 minutes later is the same day (422); Tue 00:00 is a later day (200)',
    SKIP_WHEN_NO_DB,
    async () => {
      const late = '2026-06-02T04:30:00.000Z'; // Mon 1 Jun 23:30
      const id = await rs.plantRequest({ category: 'board-and-train', preferredDates: [late] });
      refused(
        await rs.approveBoardTrain(id, { dropoff_at: late, pickup_at: '2026-06-02T04:59:00.000Z' }),
        422,
        'invalid_payload',
        ONE_NIGHT,
      );
      const ok = await rs.approveBoardTrain(id, { dropoff_at: late, pickup_at: '2026-06-02T05:00:00.000Z' });
      assert.equal(ok.statusCode, 200, ok.body);
    },
  );
});
