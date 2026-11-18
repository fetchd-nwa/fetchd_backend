import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { BookingWire, PostRequestsConfirmResponse } from '../../src/contracts/wire.js';
import { SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import {
  BT_STARTS,
  LESSON_TIMES,
  approveBoardTrain,
  approveLesson,
  clearRequestServiceRows,
  confirm,
  errorCode,
  moneyRows,
  ownerApp,
  plantRequest,
  post,
  staffApp,
  testBookings,
} from './_requestServices.js';

/**
 * Plan unit P49, contract item A5 (wire 9.0.0; design request-services-v1 §2.2; BT-32,
 * PL-52): the owner's and the staff whole-session cancels refuse a private lesson or a
 * Board & Train with 409 `conflict` once its start (`dropoff_at`, else `scheduled_at`) has
 * passed: a started lesson or stay is ended by a staff record (P51), never by a $0 cancel.
 * Before the start the cancel moves $0 and writes no ledger row. `BookingWire.can_cancel` is
 * present on every lesson and Board & Train row and reads the same instant.
 */

registerFixtureHooks();
afterEach(clearRequestServiceRows);

async function bookedLesson(): Promise<string> {
  const id = await plantRequest({ category: 'private-lesson' });
  const res = await approveLesson(id);
  assert.equal(res.statusCode, 200, res.body);
  const [booking] = await testBookings();
  assert.ok(booking !== undefined);
  return booking.id;
}

async function bookedStay(): Promise<string> {
  const id = await plantRequest({ category: 'board-and-train' });
  assert.equal((await approveBoardTrain(id)).statusCode, 200);
  const res = await confirm(id);
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as PostRequestsConfirmResponse).booking.id;
}

const at = (iso: string) => () => new Date(iso);
const ONE_MINUTE_BEFORE = (iso: string) => at(new Date(Date.parse(iso) - 60_000).toISOString());

function ownerCancel(bookingId: string, now: () => Date) {
  return post(ownerApp(now), `/bookings/${bookingId}/cancel`, {});
}

function staffCancel(bookingId: string, now: () => Date) {
  return post(staffApp(now), `/staff/bookings/${bookingId}/cancel`, {});
}

async function readBooking(bookingId: string, now: () => Date): Promise<BookingWire> {
  const res = await ownerApp(now).inject({ method: 'GET', url: `/bookings/${bookingId}` });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as BookingWire;
}

for (const [label, book, start] of [
  ['a private lesson', bookedLesson, LESSON_TIMES[0]],
  ['a Board & Train', bookedStay, BT_STARTS[0]],
] as const) {
  test(`the owner's and the staff cancel of ${label} at or after its start → 409 conflict`, SKIP_WHEN_NO_DB, async () => {
    const bookingId = await book();
    for (const cancel of [ownerCancel, staffCancel]) {
      for (const now of [at(start), at('2026-06-22T00:00:00.000Z')]) {
        const res = await cancel(bookingId, now);
        assert.equal(res.statusCode, 409, res.body);
        assert.equal(errorCode(res), 'conflict', res.body);
      }
    }
    const [row] = await testBookings();
    assert.equal(row?.status, 'upcoming', 'the refused cancel wrote nothing');
  });

  test(`${label}: can_cancel is true before its start and false from it`, SKIP_WHEN_NO_DB, async () => {
    const bookingId = await book();
    assert.equal((await readBooking(bookingId, ONE_MINUTE_BEFORE(start))).can_cancel, true);
    assert.equal((await readBooking(bookingId, at(start))).can_cancel, false);
  });

  for (const [who, cancel] of [
    ['owner', ownerCancel],
    ['staff', staffCancel],
  ] as const) {
    test(`${label}, the ${who} cancel before its start → 200, $0 and no ledger row; can_cancel false after`, SKIP_WHEN_NO_DB, async () => {
      const bookingId = await book();
      const before = await moneyRows();
      const res = await cancel(bookingId, ONE_MINUTE_BEFORE(start));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((res.json() as BookingWire).status, 'cancelled');
      assert.deepEqual(await moneyRows(), before, 'the cancel moved money or wrote a ledger row');
      assert.equal((await readBooking(bookingId, ONE_MINUTE_BEFORE(start))).can_cancel, false);
    });
  }
}
