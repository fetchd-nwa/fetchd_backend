import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type {
  PostRequestsConfirmResponse,
  StaffServiceBookingWire,
} from '../../src/contracts/wire.js';
import { FIXTURE_IDS } from './_fixture.js';
import { FIXTURE_OWNER_PRINCIPAL, SKIP_WHEN_NO_DB, registerFixtureHooks } from './_harness.js';
import {
  BT_PICKUP,
  BT_STARTS,
  B_AND_T_PRICE_CENTS,
  LESSON_TIMES,
  approveBoardTrain,
  approveLesson,
  clearRequestServiceRows,
  confirm,
  errorCode,
  ownerApp,
  plantRequest,
  post,
  staffApp,
  testBookings,
} from './_requestServices.js';

/**
 * Plan unit P49, contract item A10 (wire 9.0.0; design request-services-v1 §2.2):
 * `GET /staff/service-bookings` `[staff]`, the portal's Requests → Booked tab. Every live,
 * uncancelled private lesson and Board & Train, ordered by start (ties by id), no age bound,
 * and no card, payment or invoice field. Read only.
 */

registerFixtureHooks();
afterEach(clearRequestServiceRows);

async function list(): Promise<StaffServiceBookingWire[]> {
  const res = await staffApp().inject({ method: 'GET', url: '/staff/service-bookings' });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as StaffServiceBookingWire[];
}

const CARD_OR_PAYMENT = /card|payment|invoice|charge|order|stripe|last4|brand/i;

function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
  }
  return [];
}

test(
  'a confirmed lesson and a booked Board & Train are listed with trainer and quote; a cancelled one is absent; no key carries a card or payment',
  SKIP_WHEN_NO_DB,
  async () => {
    const lessonRequest = await plantRequest({
      category: 'private-lesson',
      dogIds: [FIXTURE_IDS.dog1Id, FIXTURE_IDS.dog2Id],
    });
    assert.equal((await approveLesson(lessonRequest)).statusCode, 200);
    const [lesson] = await testBookings();
    assert.ok(lesson !== undefined);

    const btRequest = await plantRequest({ category: 'board-and-train' });
    assert.equal((await approveBoardTrain(btRequest)).statusCode, 200);
    const stay = (
      (await confirm(btRequest)).json() as PostRequestsConfirmResponse
    ).booking;

    // A second lesson, cancelled before its start: not on the list.
    const cancelledRequest = await plantRequest({ category: 'private-lesson' });
    assert.equal(
      (await approveLesson(cancelledRequest, { scheduled_at: LESSON_TIMES[2] })).statusCode,
      200,
    );
    const cancelled = (await testBookings()).find(
      (b) => b.id !== lesson.id && b.id !== stay.id,
    );
    assert.ok(cancelled !== undefined);
    const gone = await post(ownerApp(), `/bookings/${cancelled.id}/cancel`, {});
    assert.equal(gone.statusCode, 200, gone.body);

    const rows = await list();
    const mine = rows.filter((r) => r.booking_id === lesson.id || r.booking_id === stay.id);
    // By start: the stay (Mon 1 Jun) before the lesson (Sat 6 Jun).
    assert.deepEqual(mine, [
      {
        booking_id: stay.id,
        category: 'board-and-train',
        owner: { id: FIXTURE_IDS.ownerId, name: 'Allison Fixture' },
        dogs: [{ id: FIXTURE_IDS.dog1Id, name: 'Waffles' }],
        scheduled_at: BT_STARTS[0],
        dropoff_at: BT_STARTS[0],
        pickup_at: BT_PICKUP,
        trainer: { staff_id: FIXTURE_IDS.staffRachelId, name: 'Rachel' },
        quoted_price_cents: B_AND_T_PRICE_CENTS,
        location: 'fayetteville',
      },
      {
        booking_id: lesson.id,
        category: 'private-lesson',
        owner: { id: FIXTURE_IDS.ownerId, name: 'Allison Fixture' },
        dogs: [
          { id: FIXTURE_IDS.dog1Id, name: 'Waffles' },
          { id: FIXTURE_IDS.dog2Id, name: 'Lola' },
        ],
        scheduled_at: LESSON_TIMES[0],
        duration_minutes: 60,
        trainer: { staff_id: FIXTURE_IDS.staffRachelId, name: 'Rachel' },
        quoted_price_cents: 15000,
        location: 'fayetteville',
      },
    ]);
    assert.equal(
      rows.some((r) => r.booking_id === cancelled.id),
      false,
      'a cancelled lesson is listed',
    );
    assert.deepEqual(keysDeep(rows).filter((k) => CARD_OR_PAYMENT.test(k)), []);
    // A10: lessons and Board & Train only (Opus b1 F6, X15). The fixture holds three boarding
    // rows; none is listed.
    assert.deepEqual(
      rows.filter((r) => r.category !== 'private-lesson' && r.category !== 'board-and-train'),
      [],
    );
    assert.equal(
      rows.some((r) => r.booking_id === FIXTURE_IDS.booking4Id),
      false,
      "the fixture's boarding stay (booking4) is listed",
    );

    // Ordered by start, ties by id; a past row is listed (no age bound).
    const starts = rows.map((r) => Date.parse(r.scheduled_at));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
    assert.ok(rows.some((r) => r.booking_id === FIXTURE_IDS.booking7Id), 'the past lesson is listed');
  },
);

test(
  "a lesson booked before 9.0.0 (the fixture's booking3) is listed with its trainer and without a quote or a campus, never as $0",
  SKIP_WHEN_NO_DB,
  async () => {
    const row = (await list()).find((r) => r.booking_id === FIXTURE_IDS.booking3Id);
    assert.ok(row !== undefined);
    assert.equal(row.category, 'private-lesson');
    assert.deepEqual(row.trainer, { staff_id: FIXTURE_IDS.staffRachelId, name: 'Rachel' });
    assert.equal('quoted_price_cents' in row, false);
    assert.equal('location' in row, false);
  },
);

test('an owner principal → 403', SKIP_WHEN_NO_DB, async () => {
  const res = await staffApp(undefined, FIXTURE_OWNER_PRINCIPAL).inject({
    method: 'GET',
    url: '/staff/service-bookings',
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(errorCode(res), 'forbidden');
});
