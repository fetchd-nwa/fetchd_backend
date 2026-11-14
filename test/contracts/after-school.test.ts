import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type {
  AfterSchoolFullDetails,
  ApiErrorEnvelope,
  BookingWire,
  CheckinBoardWire,
  PostBookingsResponse,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { bookingDogs, bookings, charges, creditLedger, orders } from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { registerStaffCheckinRoute } from '../../src/routes/staffCheckin.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { clearPlantedPools, plantLot } from './_poolFixture.js';
import { at, boardApp, makeClock, verb } from './_checkinFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * DAY-U43 (P21; design §1.1:1083-1085, §2.3:2558-2564; M5.04; contract notes D9-D12): the
 * after-school opt-in is stored per share (`booking_dogs.after_school`), sent per dog per
 * date (`PostBookingsRequest.after_school`), read back on every share
 * (`dog_shares[].after_school`) and on the board row, and counted in dogs, as the seats are,
 * under each date's `(location, date)` lock right after its seats, against the campus's
 * `day.after_school_capacity_count` (Bentonville 5): a date that cannot take the ticks is
 * 422 `after_school_full` and the whole order is refused before any charge.
 *
 * Tue 17 Nov 2026 19:00 Tomi books Pepper for day school Wed 18 to Fri 20 Nov at
 * Bentonville; the route's clock is injected, and every lot is dated far ahead so it is
 * live at the database's own clock.
 */

registerFixtureHooks();
const createdDogs: string[] = [];
afterEach(async () => {
  await clearOrderRows();
  await clearPlantedPools();
  await db.delete(orders).where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
});
after(async () => {
  await removeDogs(createdDogs);
});

const WED = '2026-11-18';
const THU = '2026-11-19';
const FRI = '2026-11-20';
const NOW = at('2026-11-17', '19:00');
const FAR = at('2030-01-01', '12:00');

function apps(stripe: StripeStub = makeStripeStub()) {
  const owner = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerBookingsRoute(owner.app, { authenticate: owner.authenticate, now: () => NOW, stripe });
  const staff = makeContractApp(FIXTURE_STAFF_PRINCIPAL);
  registerStaffBookingsRoute(staff.app, { authenticate: staff.authenticate, now: () => NOW, stripe });
  // The board's verbs run on the session's own day: Thursday, 07:35.
  registerStaffCheckinRoute(staff.app, { authenticate: staff.authenticate, now: () => at(THU, '07:35') });
  return { owner: owner.app, staff: staff.app, stripe };
}

async function dogs(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(await createBookableDog(createdDogs));
  return ids;
}

function book(
  app: FastifyInstance,
  args: {
    dogIds: readonly string[];
    dates: readonly string[];
    afterSchool?: Readonly<Record<string, readonly string[]>>;
    category?: 'day-school' | 'day-care';
    topUp?: object;
    key?: string;
  },
) {
  const [lead, ...rest] = args.dogIds;
  return app.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': args.key ?? `as-${randomUUID()}` },
    payload: {
      category: args.category ?? 'day-school',
      lead_dog_id: lead,
      ...(rest.length > 0 ? { additional_dog_ids: rest } : {}),
      dates: args.dates,
      location: 'bentonville',
      payment: { kind: 'credits', ...(args.topUp !== undefined ? { top_up: args.topUp } : {}) },
      ...(args.afterSchool !== undefined ? { after_school: args.afterSchool } : {}),
    },
  });
}

function created(res: { statusCode: number; body: string }): BookingWire[] {
  assert.equal(res.statusCode, 201, res.body);
  return (JSON.parse(res.body) as PostBookingsResponse).sessions;
}

function refused(res: { statusCode: number; body: string }, status: number, code: string) {
  assert.equal(res.statusCode, status, res.body);
  const { error } = JSON.parse(res.body) as ApiErrorEnvelope;
  assert.equal(error.code, code, res.body);
  return error;
}

/** Each session's date and its shares' after-school flags, in date order. */
function ticks(wires: readonly BookingWire[]): [string, Record<string, boolean>][] {
  return [...wires]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((w) => [
      new Date(w.date).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }),
      Object.fromEntries((w.dog_shares ?? []).map((s) => [s.dog_id, s.after_school])),
    ]);
}

/** Five dogs already staying for Thursday's after-school session. */
async function fiveStayingThursday(owner: FastifyInstance): Promise<string[]> {
  const five = await dogs(5);
  await plantLot({ credits: 5, expiresAt: FAR });
  created(
    await book(owner, {
      dogIds: five,
      dates: [THU],
      afterSchool: Object.fromEntries(five.map((d) => [d, [THU]])),
    }),
  );
  return five;
}

async function footprint() {
  const [b] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(eq(bookings.ownerId, FIXTURE_IDS.ownerId));
  const [o] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.ownerId, FIXTURE_IDS.ownerId));
  const [l] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.ownerId, FIXTURE_IDS.ownerId));
  const [c] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(charges)
    .where(eq(charges.ownerId, FIXTURE_IDS.ownerId));
  return { bookings: b?.n, orders: o?.n, ledger: l?.n, charges: c?.n };
}

describe('the opt-in is stored per share and read back everywhere', () => {
  test(
    "Pepper, Wed 18 to Fri 20 Nov, after_school {pepper: [Wed]} → 201; her share reads true on Wed and false Thu and Fri, in the 201, GET /bookings, a staff read and the board",
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner, staff } = apps();
      const [pepper] = await dogs(1);
      await plantLot({ credits: 3, expiresAt: FAR });
      const wires = created(
        await book(owner, { dogIds: [pepper!], dates: [WED, THU, FRI], afterSchool: { [pepper!]: [WED] } }),
      );
      const expected = [
        [WED, { [pepper!]: true }],
        [THU, { [pepper!]: false }],
        [FRI, { [pepper!]: false }],
      ];
      assert.deepEqual(ticks(wires), expected, 'the 201');
      const listed = (
        await owner.inject({ method: 'GET', url: '/bookings?view=upcoming' })
      ).json<BookingWire[]>();
      assert.deepEqual(
        ticks(listed.filter((w) => wires.some((c) => c.id === w.id))),
        expected,
        'GET /bookings',
      );
      const staffRead = (await staff.inject({ method: 'GET', url: '/staff/bookings' })).json<BookingWire[]>();
      assert.deepEqual(
        ticks(staffRead.filter((w) => wires.some((c) => c.id === w.id))),
        expected,
        'a staff read',
      );
      for (const [date, flag] of [
        [WED, true],
        [THU, false],
      ] as const) {
        const board = await staff.inject({
          method: 'GET',
          url: `/staff/checkin-board?location=bentonville&date=${date}`,
        });
        assert.equal(board.statusCode, 200, board.body);
        const row = board.json<CheckinBoardWire[]>().find((r) => r.dog_id === pepper);
        assert.equal(row?.after_school, flag, `the board on ${date}`);
      }
    },
  );

  test('omitted, or a dog absent from the map, opts no one in; a day-care share reads false', SKIP_WHEN_NO_DB, async () => {
    const { owner } = apps();
    const [a, b] = await dogs(2);
    await plantLot({ credits: 2, expiresAt: FAR });
    await plantLot({ credits: 1, expiresAt: FAR, mode: 'daycare' });
    assert.deepEqual(
      ticks(created(await book(owner, { dogIds: [a!, b!], dates: [WED], afterSchool: { [a!]: [WED] } }))),
      [[WED, { [a!]: true, [b!]: false }]],
    );
    assert.deepEqual(ticks(created(await book(owner, { dogIds: [a!], dates: [FRI], category: 'day-care' }))), [
      [FRI, { [a!]: false }],
    ]);
  });
});

describe('the cap: Bentonville takes 5 dogs a date (day.after_school_capacity_count)', () => {
  test(
    'five dogs already staying Thursday, a booking that ticks a sixth → 422 after_school_full {2026-11-19, 5, 5}; no booking, order, ledger or charge row, no Stripe call, a top_up body too',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner, stripe } = apps();
      await fiveStayingThursday(owner);
      const [pepper] = await dogs(1);
      await plantLot({ credits: 2, expiresAt: FAR });
      const before = await footprint();
      const plain = refused(
        await book(owner, { dogIds: [pepper!], dates: [WED, THU], afterSchool: { [pepper!]: [THU] } }),
        422,
        'after_school_full',
      );
      assert.deepEqual(plain.details as AfterSchoolFullDetails, {
        kind: 'after_school_full',
        date: THU,
        capacity: 5,
        booked: 5,
      });
      const withTopUp = refused(
        await book(owner, {
          dogIds: [pepper!],
          dates: [WED, THU, FRI],
          afterSchool: { [pepper!]: [THU] },
          // Two credits for three dates: the top-up buys the third, and is never charged.
          topUp: { count: 1, payment_method_id: FIXTURE_IDS.paymentMethod1Id, expected_total_cents: 6_000 },
        }),
        422,
        'after_school_full',
      );
      assert.deepEqual(withTopUp.details, { kind: 'after_school_full', date: THU, capacity: 5, booked: 5 });
      assert.deepEqual(await footprint(), before, 'nothing written');
      assert.deepEqual(stripe.calls, [], 'no Stripe call');
    },
  );

  test('two full dates: `date` is the first in date order', SKIP_WHEN_NO_DB, async () => {
    const { owner } = apps();
    const five = await dogs(5);
    await plantLot({ credits: 10, expiresAt: FAR });
    created(
      await book(owner, {
        dogIds: five,
        dates: [THU, FRI],
        afterSchool: Object.fromEntries(five.map((d) => [d, [THU, FRI]])),
      }),
    );
    const [pepper] = await dogs(1);
    await plantLot({ credits: 2, expiresAt: FAR });
    const error = refused(
      await book(owner, { dogIds: [pepper!], dates: [THU, FRI], afterSchool: { [pepper!]: [FRI, THU] } }),
      422,
      'after_school_full',
    );
    assert.equal((error.details as AfterSchoolFullDetails).date, THU);
  });

  test(
    'the count is in dogs, as the seats are: a share cancelled alone, a turn-away and a cancelled session each free their place',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner, staff } = apps();
      const [a, b, c, d, e] = await dogs(5);
      await plantLot({ credits: 5, expiresAt: FAR });
      const [three] = created(
        await book(owner, { dogIds: [a!, b!, c!], dates: [THU], afterSchool: { [a!]: [THU], [b!]: [THU], [c!]: [THU] } }),
      );
      const [two] = created(
        await book(owner, { dogIds: [d!, e!], dates: [THU], afterSchool: { [d!]: [THU], [e!]: [THU] } }),
      );
      const nextTick = async () => {
        const [dog] = await dogs(1);
        await plantLot({ credits: 1, expiresAt: FAR });
        return book(owner, { dogIds: [dog!], dates: [THU], afterSchool: { [dog!]: [THU] } });
      };
      refused(await nextTick(), 422, 'after_school_full');

      // C cancelled alone frees her place, and only hers.
      const one = await owner.inject({
        method: 'POST',
        url: `/bookings/${three!.id}/dogs/${c}/cancel`,
        headers: { 'idempotency-key': `as-one-${randomUUID()}` },
      });
      assert.equal(one.statusCode, 200, one.body);
      created(await nextTick());
      refused(await nextTick(), 422, 'after_school_full');

      // B turned away at the door on Thursday morning frees hers (P20's seat count, B2-4).
      const turned = await verb(staff, { bookingId: three!.id, dogId: b!, verb: 'turn-away' });
      assert.equal(turned.statusCode, 200, turned.body);
      created(await nextTick());
      refused(await nextTick(), 422, 'after_school_full');

      // D and E's session cancelled whole frees both.
      const whole = await owner.inject({
        method: 'POST',
        url: `/bookings/${two!.id}/cancel`,
        headers: { 'idempotency-key': `as-whole-${randomUUID()}` },
        payload: {},
      });
      assert.equal(whole.statusCode, 200, whole.body);
      created(await nextTick());
      created(await nextTick());
      refused(await nextTick(), 422, 'after_school_full');
    },
  );

  /**
   * P21 fix 1, B-F4 (DECISIONS 291; `holdsASeat`, `dayCapacityRepository.ts`): only a
   * turn-away frees a settled share's place. A dog sent home was in the building, and a
   * *Didn't come* is recorded only once pickup has closed, so each keeps her after-school
   * place, and the board's marker shows on both. Pins: green on the P21 tree, each proved
   * by a landed mutant that makes `holdsASeat` free that state. The next booking is the
   * fixture family's, for a new dog: the count has no owner clause, and this suite has one
   * owner fixture.
   */
  async function fullThursday(owner: FastifyInstance) {
    const five = await dogs(5);
    await plantLot({ credits: 5, expiresAt: FAR });
    const [session] = created(
      await book(owner, {
        dogIds: five,
        dates: [THU],
        afterSchool: Object.fromEntries(five.map((d) => [d, [THU]])),
      }),
    );
    const nextTick = async () => {
      const [dog] = await dogs(1);
      await plantLot({ credits: 1, expiresAt: FAR });
      return book(owner, { dogIds: [dog!], dates: [THU], afterSchool: { [dog!]: [THU] } });
    };
    const full = (res: { statusCode: number; body: string }, why: string) =>
      assert.deepEqual(
        refused(res, 422, 'after_school_full').details,
        { kind: 'after_school_full', date: THU, capacity: 5, booked: 5 },
        why,
      );
    full(await nextTick(), 'five staying: full before any verb');
    return { session: session!, five, nextTick, full };
  }

  test(
    'a pin (B-F4): one of the five staying Thursday is checked in and sent home at 13:10 → her place still holds: the next tick is 422 after_school_full {5, 5}',
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const { session, five, nextTick, full } = await fullThursday(owner);
      const clock = makeClock(at(THU, '07:35'));
      const board = boardApp(FIXTURE_STAFF_PRINCIPAL, clock);
      const inRes = await verb(board, { bookingId: session.id, dogId: five[0]!, verb: 'check-in' });
      assert.equal(inRes.statusCode, 200, inRes.body);
      clock.set(at(THU, '13:10'));
      const home = await verb(board, {
        bookingId: session.id,
        dogId: five[0]!,
        verb: 'send-home',
        body: {},
      });
      assert.equal(home.statusCode, 200, home.body);
      assert.equal(home.json<{ status: string }>().status, 'sent-home');
      full(await nextTick(), 'sent home keeps her place');
    },
  );

  test(
    "a pin (B-F4): one of the five staying Thursday never came; Didn't come at 17:30 → her place still holds: the next tick is 422 after_school_full {5, 5}",
    SKIP_WHEN_NO_DB,
    async () => {
      const { owner } = apps();
      const { session, five, nextTick, full } = await fullThursday(owner);
      const board = boardApp(FIXTURE_STAFF_PRINCIPAL, makeClock(at(THU, '17:30')));
      const noShow = await verb(board, { bookingId: session.id, dogId: five[0]!, verb: 'no-show' });
      assert.equal(noShow.statusCode, 200, noShow.body);
      assert.equal(noShow.json<{ status: string }>().status, 'no-show');
      full(await nextTick(), "Didn't come keeps her place");
    },
  );
});

describe('two connections, one place left (the count under the date lock)', () => {
  for (const jitter of [false, true]) {
    for (const order of ['A first', 'B first'] as const) {
      test(`${order}${jitter ? ', with jitter' : ''}: one 201, one 422 after_school_full`, SKIP_WHEN_NO_DB, async () => {
        const { owner } = apps();
        const four = await dogs(4);
        await plantLot({ credits: 6, expiresAt: FAR });
        created(
          await book(owner, {
            dogIds: four,
            dates: [THU],
            afterSchool: Object.fromEntries(four.map((d) => [d, [THU]])),
          }),
        );
        const [a, b] = await dogs(2);
        const wait = () => new Promise((r) => setTimeout(r, jitter ? Math.random() * 15 : 0));
        const fire = async (dog: string) => {
          await wait();
          return book(owner, { dogIds: [dog], dates: [THU], afterSchool: { [dog]: [THU] } });
        };
        const [first, second] = order === 'A first' ? [a!, b!] : [b!, a!];
        const results = await Promise.all([fire(first), fire(second)]);
        assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 422], results.map((r) => r.body).join(' | '));
        const loser = results.find((r) => r.statusCode === 422)!;
        assert.equal(loser.json<ApiErrorEnvelope>().error.code, 'after_school_full');
        const { rows } = await db.execute(sql`
          SELECT count(*)::int AS n FROM booking_dogs bd JOIN bookings b ON b.id = bd.booking_id
           WHERE b.owner_id = ${FIXTURE_IDS.ownerId} AND bd.after_school AND b.status <> 'cancelled'`);
        assert.equal((rows[0] as { n: number }).n, 5, 'never six');
      });
    }
  }
});

describe('D11: the map is validated against its own request', () => {
  test('422 invalid_payload: a key not a dog of the request, a date not in dates, a date twice, any tick on day care', SKIP_WHEN_NO_DB, async () => {
    const { owner } = apps();
    const [pepper, stranger] = await dogs(2);
    await plantLot({ credits: 2, expiresAt: FAR });
    await plantLot({ credits: 1, expiresAt: FAR, mode: 'daycare' });
    const before = await footprint();
    for (const [why, args] of [
      ['a key not a dog of the request', { dogIds: [pepper!], dates: [WED], afterSchool: { [stranger!]: [WED] } }],
      ['a date not in dates', { dogIds: [pepper!], dates: [WED], afterSchool: { [pepper!]: [THU] } }],
      ['a date listed twice', { dogIds: [pepper!], dates: [WED], afterSchool: { [pepper!]: [WED, WED] } }],
      [
        'a tick on a day-care request',
        { dogIds: [pepper!], dates: [WED], category: 'day-care' as const, afterSchool: { [pepper!]: [WED] } },
      ],
    ] as const) {
      refused(await book(owner, args), 422, 'invalid_payload');
      assert.ok(why);
    }
    assert.deepEqual(await footprint(), before, 'nothing written');
  });

  test('400 bad_request: a key that is not a UUID, a value that is not a date', SKIP_WHEN_NO_DB, async () => {
    const { owner } = apps();
    const [pepper] = await dogs(1);
    refused(await book(owner, { dogIds: [pepper!], dates: [WED], afterSchool: { pepper: [WED] } }), 400, 'bad_request');
    refused(
      await book(owner, { dogIds: [pepper!], dates: [WED], afterSchool: { [pepper!]: ['Wednesday'] } }),
      400,
      'bad_request',
    );
    refused(
      await book(owner, { dogIds: [pepper!], dates: [WED], afterSchool: { [pepper!]: ['2026-02-30'] } }),
      400,
      'bad_request',
    );
  });

  test("a mixed-case dog-id key is that dog (ids are normalised before they're compared)", SKIP_WHEN_NO_DB, async () => {
    const { owner } = apps();
    const [pepper] = await dogs(1);
    await plantLot({ credits: 1, expiresAt: FAR });
    const wires = created(
      await book(owner, { dogIds: [pepper!], dates: [WED], afterSchool: { [pepper!.toUpperCase()]: [WED] } }),
    );
    assert.deepEqual(ticks(wires), [[WED, { [pepper!]: true }]]);
  });
});

describe('idempotency: the refusal runs inside withMutation, after the claim (128(a))', () => {
  test('a 201 replayed after its after-school date has filled returns its stored 201, never after_school_full', SKIP_WHEN_NO_DB, async () => {
    const { owner } = apps();
    const four = await dogs(4);
    await plantLot({ credits: 6, expiresAt: FAR });
    created(
      await book(owner, { dogIds: four, dates: [THU], afterSchool: Object.fromEntries(four.map((d) => [d, [THU]])) }),
    );
    const [pepper, scout] = await dogs(2);
    const key = `as-replay-${randomUUID()}`;
    const first = await book(owner, { dogIds: [pepper!], dates: [THU], afterSchool: { [pepper!]: [THU] }, key });
    created(first);
    refused(
      await book(owner, { dogIds: [scout!], dates: [THU], afterSchool: { [scout!]: [THU] } }),
      422,
      'after_school_full',
    );
    const replay = await book(owner, { dogIds: [pepper!], dates: [THU], afterSchool: { [pepper!]: [THU] }, key });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), first.json(), 'the stored 201');
    const { rows } = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookingDogs)
      .innerJoin(bookings, eq(bookings.id, bookingDogs.bookingId))
      .where(and(eq(bookingDogs.dogId, pepper!), inArray(bookings.status, ['upcoming'])))
      .then((r) => ({ rows: r }));
    assert.equal(rows[0]?.n, 1, 'nothing written twice');
  });
});
