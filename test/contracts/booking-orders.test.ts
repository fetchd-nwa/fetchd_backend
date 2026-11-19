import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import type {
  AfterSchoolFullDetails,
  AlreadyBookedDetails,
  AlumniNoDaySchoolDetails,
  BookingWire,
  CreditExpiredBeforeDateDetails,
  CreditsShortDetails,
  InsufficientCapacityDetails,
  PostBookingOrdersResponse,
} from '../../src/contracts/wire.js';
import { MAX_DATES_PER_PART, MAX_DOG_DATES_PER_ORDER } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { dayCapacityRepository } from '../../src/db/repositories/dayCapacityRepository.js';
import {
  bookingDogs,
  bookings,
  creditLedger,
  dayCapacity,
  dayProgramSettings,
  dogs,
} from '../../src/db/schema/schema.js';
import { insufficientCapacityError } from '../../src/lib/bookingErrors.js';
import { redisCheckThrottleStore } from '../../src/lib/orderCheckThrottle.js';
import { at, makeClock } from './_checkinFixture.js';
import {
  D,
  ENDS_31_DEC,
  WED_18_NOV,
  buy,
  check,
  checkThenPost,
  clearOrderWorld,
  createOtherOwner,
  dropFixtureBentonvilleCare,
  hold,
  ledgerPlan,
  orderApp,
  part,
  poolKey,
  post,
  refused,
  release,
  rowCounts,
  rowIsFree,
  sortPlan,
  untilBlockedBy,
} from './_bookingOrderFixture.js';
import {
  createAlumniDog,
  createBookableDog,
  removeDogs,
  restoreDaySeeds,
  setCampusSettings,
} from './_dayFixture.js';
import {
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeLogCapture,
  registerFixtureHooks,
} from './_harness.js';
import { plantLot, poolBalance, waitForBlockedBackends } from './_poolFixture.js';

/**
 * `POST /booking-orders` and its check, patch (A) of plan one-off O-CREDITS (wire 9.1.0;
 * designs/credits-joint-booking.md §3.2, §4 B1-B20; the brief's red-first table). Every case
 * runs the real routes on the real database with real lots, planted through
 * `_poolFixture.ts` or bought on the shop's route. Nothing here needs a Bentonville alumni
 * catalog row (that is patch (B)'s), so an alumni dog's day here is paid from her alumni lots
 * or, when none is left, from day care credits unasked: no live alumni row is cheaper there.
 */

registerFixtureHooks();
const created: string[] = [];
beforeEach(dropFixtureBentonvilleCare);
afterEach(async () => {
  mock.restoreAll();
  await clearOrderWorld();
  await restoreDaySeeds();
  await db.delete(dayCapacity).where(eq(dayCapacity.location, 'bentonville'));
});
after(async () => {
  await clearOrderWorld();
  await removeDogs(created);
});

const MON_TO_WED = [D.MON, D.TUE, D.WED];

const care = (args: { credits: number; tier?: 'regular' | 'alumni'; expiresAt?: string }) =>
  plantLot({
    credits: args.credits,
    expiresAt: args.expiresAt ?? ENDS_31_DEC,
    location: 'bentonville',
    mode: 'daycare',
    tier: args.tier ?? 'regular',
  });

const careBalance = (tier: 'regular' | 'alumni' = 'regular') =>
  poolBalance({ location: 'bentonville', mode: 'daycare', tier });

/** Waffles (alumni) and Lola (not), as in the design's worked example. */
async function wafflesAndLola(): Promise<{ waffles: string; lola: string }> {
  return { waffles: await createAlumniDog(created), lola: await createBookableDog(created) };
}

function sessionIds(res: { json(): unknown }): string[] {
  return (res.json() as PostBookingOrdersResponse).sessions.map((s) => s.id);
}

// ── B1: case A ──────────────────────────────────────────────────────────────────

test(
  'B1 (case A): Waffles holds 5 alumni, Lola 4 day care: one order, 3 sessions, Waffles on alumni and Lola on day care, ending 2 / 1, `plan` = the debits (check = POST)',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    await care({ credits: 5, tier: 'alumni' });
    await care({ credits: 4 });
    const { app } = orderApp();

    const res = await checkThenPost(app, {
      parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })],
    });

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as PostBookingOrdersResponse;
    assert.equal(body.order.charge_status, 'none');
    assert.equal(body.sessions.length, 3);
    assert.deepEqual(
      body.sessions.map((s) => s.date.slice(0, 10)),
      MON_TO_WED,
      'one session a date, ascending',
    );
    for (const session of body.sessions) {
      assert.equal(session.order_id, body.order.id);
      assert.deepEqual([session.dog_id, ...(session.additional_dog_ids ?? [])], [waffles, lola]);
    }
    assert.deepEqual(body.plan, [
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'alumni', count: 3 },
      { dog_id: lola, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 3 },
    ]);
    assert.deepEqual(
      sortPlan(await ledgerPlan(sessionIds(res))),
      sortPlan(body.plan),
      'the plan is the debits',
    );
    assert.equal(await careBalance('alumni'), 2);
    assert.equal(await careBalance('regular'), 1);
  },
);

// ── B2: one pool, two dogs, counted across the order ──────────────────────────────

test(
  'B2: two dogs not alumni (Lola Tue-Fri, a second the next Mon-Tue), 1 day care credit: `credits_short` with shortfall 5, nothing written anywhere (check = POST)',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    const biscuit = await createBookableDog(created);
    await care({ credits: 1 });
    const { app } = orderApp();
    const key = `order-b2-${randomUUID()}`;
    const before = await rowCounts();

    const res = await checkThenPost(
      app,
      {
        parts: [
          part({ dogs: [lola], dates: [D.TUE, D.WED, D.THU, D.FRI] }),
          part({ dogs: [biscuit], dates: [D.MON2, D.TUE2] }),
        ],
      },
      key,
    );

    const details = refused<CreditsShortDetails>(res, 'credits_short');
    assert.deepEqual(details, {
      kind: 'credits_short',
      pools: [
        {
          location: 'bentonville',
          mode: 'daycare',
          tier: 'regular',
          balance: 1,
          required: 6,
          shortfall: 5,
          dog_ids: [lola, biscuit],
          short_dates: [
            { date: D.WED, dog_id: lola, reason: 'no_credit' },
            { date: D.THU, dog_id: lola, reason: 'no_credit' },
            { date: D.FRI, dog_id: lola, reason: 'no_credit' },
            { date: D.MON2, dog_id: biscuit, reason: 'no_credit' },
            { date: D.TUE2, dog_id: biscuit, reason: 'no_credit' },
          ],
        },
      ],
    });
    assert.deepEqual(await rowCounts(), before, 'no booking, share, debit, order, reminder or key');
    assert.equal(await careBalance(), 1);
  },
);

// ── B3: two campuses, one short ─────────────────────────────────────────────────

test(
  'B3: two campuses, Fayetteville covered and Bentonville short: `credits_short` names Bentonville alone, and nothing is written at either (check = POST)',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    const biscuit = await createBookableDog(created);
    await plantLot({
      credits: 3,
      expiresAt: ENDS_31_DEC,
      location: 'fayetteville',
      mode: 'school',
    });
    const fayBefore = await poolBalance({ location: 'fayetteville', mode: 'school' });
    const { app } = orderApp();
    const before = await rowCounts();

    const res = await checkThenPost(app, {
      parts: [
        part({ category: 'day-school', location: 'fayetteville', dogs: [lola], dates: MON_TO_WED }),
        part({ dogs: [biscuit], dates: MON_TO_WED }),
      ],
    });

    const details = refused<CreditsShortDetails>(res, 'credits_short');
    assert.deepEqual(
      details.pools.map((p) => [p.location, p.mode, p.shortfall]),
      [['bentonville', 'daycare', 3]],
    );
    assert.deepEqual(await rowCounts(), before, 'nothing at either campus');
    assert.equal(await poolBalance({ location: 'fayetteville', mode: 'school' }), fayBefore);
  },
);

// ── B6: a mixed-tier row's cancel ───────────────────────────────────────────────

test(
  "B6: Waffles cancelled from a row he shares with Lola: his credit goes back to his alumni lot, and Lola's stays spent",
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    const alumniLot = await care({ credits: 5, tier: 'alumni' });
    await care({ credits: 4 });
    const { app } = orderApp();
    const booked = await post(app, { parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })] });
    assert.equal(booked.statusCode, 201, booked.body);
    const monday = (booked.json() as PostBookingOrdersResponse).sessions[0] as BookingWire;

    const cancel = await app.inject({
      method: 'POST',
      url: `/bookings/${monday.id}/dogs/${waffles}/cancel`,
      headers: { 'idempotency-key': `b6-${randomUUID()}` },
    });
    assert.equal(cancel.statusCode, 200, cancel.body);

    const back = await db
      .select({ tier: creditLedger.tier, lotId: creditLedger.lotId, dogId: creditLedger.dogId })
      .from(creditLedger)
      .where(
        and(eq(creditLedger.bookingId, monday.id), eq(creditLedger.reason, 'settlement-return')),
      );
    assert.deepEqual(back, [{ tier: 'alumni', lotId: alumniLot, dogId: waffles }]);
    assert.equal(await careBalance('alumni'), 3, 'his credit is back on his alumni lot');
    assert.equal(await careBalance('regular'), 1, "Lola's stays spent");
  },
);

// ── B7: a dog that is not alumni never spends alumni credits ─────────────────────

test(
  'B7: Lola alone, 10 alumni credits and no day care credit: `credits_short`, and the alumni pool is untouched (check = POST)',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    await care({ credits: 10, tier: 'alumni' });
    const { app } = orderApp();

    const res = await checkThenPost(app, { parts: [part({ dogs: [lola], dates: MON_TO_WED })] });

    const details = refused<CreditsShortDetails>(res, 'credits_short');
    assert.deepEqual(
      details.pools.map((p) => [p.tier, p.balance, p.required, p.shortfall, p.dog_ids]),
      [['regular', 0, 3, 3, [lola]]],
    );
    assert.equal(await careBalance('alumni'), 10);
  },
);

// ── B8 (A): the throttle ──────────────────────────────────────────────────────────

test(
  'B8: the 61st check by one owner in one clock minute is 429 `rate_limited` with no details, on the production limiter; the next minute is open',
  SKIP_WHEN_NO_DB,
  async () => {
    // A minute of its own, so no other file's checks are in it.
    const clock = makeClock(at('2037-11-18', '09:41'));
    const { app } = orderApp({ clock, throttle: redisCheckThrottleStore });
    // The throttle runs before the body is validated: an empty body is a 400, and counts.
    for (let i = 0; i < 60; i += 1) {
      const res = await check(app, {});
      assert.equal(res.statusCode, 400, `check ${i + 1}: ${res.body}`);
    }
    const sixtyFirst = await check(app, {});
    assert.equal(sixtyFirst.statusCode, 429, sixtyFirst.body);
    const { error } = sixtyFirst.json() as { error: { code: string; details?: unknown } };
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.details, undefined);

    clock.set(at('2037-11-18', '09:42'));
    assert.equal((await check(app, {})).statusCode, 400, 'a new minute is a new window');
  },
);

test(
  'B8: a limiter that fails (an injected store, never a stopped Redis) lets the check through, and the route logs it once',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    await care({ credits: 3 });
    const capture = makeLogCapture();
    const { app } = orderApp({
      capture,
      throttle: {
        hit: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
        },
      },
    });

    const res = await check(app, { parts: [part({ dogs: [lola], dates: MON_TO_WED })] });

    assert.equal(res.statusCode, 200, res.body);
    const lines = capture.lines.filter((line) => String(line.msg).includes('order check throttle'));
    assert.equal(lines.length, 1, JSON.stringify(capture.lines.map((l) => l.msg)));
  },
);

test(
  'B8: a limiter that hangs is a failure too: the check answers within its budget and logs once',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    await care({ credits: 3 });
    const capture = makeLogCapture();
    const { app } = orderApp({ capture, throttle: { hit: () => new Promise<number>(() => {}) } });

    const started = Date.now();
    const res = await check(app, { parts: [part({ dogs: [lola], dates: MON_TO_WED })] });

    assert.equal(res.statusCode, 200, res.body);
    assert.ok(Date.now() - started < 5_000, 'the hang did not hold the check');
    const lines = capture.lines.filter((line) => String(line.msg).includes('order check throttle'));
    assert.equal(lines.length, 1);
  },
);

// ── B9: the race for one pool ───────────────────────────────────────────────────

test(
  'B9: two orders by one owner, two dogs not alumni on disjoint dates, one pool of 3: held behind the pool, one books and one is refused, neither half-booked',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    const biscuit = await createBookableDog(created);
    await care({ credits: 3 });
    const { app } = orderApp();

    const held = await hold('SELECT pg_advisory_xact_lock(hashtext($1))', [
      poolKey({ tier: 'regular' }),
    ]);
    let racing: Promise<Awaited<ReturnType<typeof post>>[]>;
    try {
      racing = Promise.all([
        post(app, { parts: [part({ dogs: [lola], dates: MON_TO_WED })] }),
        post(app, { parts: [part({ dogs: [biscuit], dates: [D.THU, D.FRI, D.MON2] })] }),
      ]);
      await waitForBlockedBackends(2);
    } finally {
      await release(held);
    }
    const answers = await racing;

    assert.deepEqual(
      answers.map((r) => r.statusCode).sort(),
      [201, 422],
      answers.map((r) => r.body).join('\n'),
    );
    const loser = answers.find((r) => r.statusCode === 422)!;
    refused<CreditsShortDetails>(loser, 'credits_short');
    const winner = answers.find((r) => r.statusCode === 201)!;
    assert.equal((winner.json() as PostBookingOrdersResponse).sessions.length, 3);
    const shares = await db
      .select({ dogId: bookingDogs.dogId })
      .from(bookingDogs)
      .where(inArray(bookingDogs.dogId, [lola, biscuit]));
    assert.equal(shares.length, 3, 'one dog has all three days, the other none');
    assert.equal(new Set(shares.map((s) => s.dogId)).size, 1);
    assert.equal(await careBalance(), 0);
  },
);

// ── B10: two campuses each, opposite body order ──────────────────────────────────

test(
  'B10: two two-campus orders by different owners, parts in opposite body order, same dates, held behind one campus-date key: both book, no 40P01',
  SKIP_WHEN_NO_DB,
  async () => {
    const other = await createOtherOwner(2);
    try {
      const mine = [await createBookableDog(created), await createBookableDog(created)];
      for (const location of ['fayetteville', 'bentonville'] as const) {
        await plantLot({ credits: 2, expiresAt: ENDS_31_DEC, location, mode: 'school' });
        await other.plant({ credits: 2, expiresAt: ENDS_31_DEC, location, mode: 'school' });
      }
      const dates = [D.MON, D.TUE];
      const school = (location: 'fayetteville' | 'bentonville', dogId: string) =>
        part({ category: 'day-school', location, dogs: [dogId], dates });
      const { app: mineApp } = orderApp();
      const { app: theirApp } = orderApp({ principal: other.principal });

      const held = await hold('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `capacity:bentonville:${D.TUE}`,
      ]);
      let first: Promise<Awaited<ReturnType<typeof post>>>;
      let second: Promise<Awaited<ReturnType<typeof post>>>;
      try {
        first = post(mineApp, {
          parts: [school('bentonville', mine[0]!), school('fayetteville', mine[1]!)],
        });
        await waitForBlockedBackends(1);
        second = post(theirApp, {
          parts: [
            school('fayetteville', other.dogIds[1]!),
            school('bentonville', other.dogIds[0]!),
          ],
        });
        await waitForBlockedBackends(2);
      } finally {
        await release(held);
      }
      const answers = [await first, await second];
      assert.deepEqual(
        answers.map((r) => r.statusCode),
        [201, 201],
        answers.map((r) => r.body).join('\n'),
      );
    } finally {
      await other.remove();
    }
  },
);

// ── B11: the key ────────────────────────────────────────────────────────────────

test(
  'B11: the same key and body replay the stored 201; the same key with another body is `idempotency_mismatch`, and nothing more is booked',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    await care({ credits: 4 });
    const { app } = orderApp();
    const key = `order-b11-${randomUUID()}`;
    const body = { parts: [part({ dogs: [lola], dates: MON_TO_WED })] };

    const first = await post(app, body, key);
    assert.equal(first.statusCode, 201, first.body);
    const replay = await post(app, body, key);
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), first.json(), 'the stored 201, plan included');
    const other = await post(app, { parts: [part({ dogs: [lola], dates: [D.THU] })] }, key);
    refused(other, 'idempotency_mismatch');
    assert.equal(await careBalance(), 1);
  },
);

// ── B12: the bounds ─────────────────────────────────────────────────────────────

test(
  'B12: each bound is `invalid_payload` (a dog on one date in two parts, too many parts, 151 dog-dates, 6 dogs, a pool consented twice); 31 dates in a part is 400; a staff principal is 403',
  SKIP_WHEN_NO_DB,
  async () => {
    const { app } = orderApp();
    // Random dogs: every bound answers before ownership, which would be the 404.
    const dog = () => randomUUID();
    const weekdays = (count: number): string[] => {
      const out: string[] = [];
      for (
        let day = new Date(Date.UTC(2037, 10, 23));
        out.length < count;
        day = new Date(day.getTime() + 86_400_000)
      ) {
        if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
          out.push(day.toISOString().slice(0, 10));
      }
      return out;
    };

    const lola = dog();
    refused(
      await post(app, {
        parts: [
          part({ category: 'day-school', dogs: [lola], dates: [D.MON] }),
          part({ dogs: [lola], dates: [D.MON] }),
        ],
      }),
      'invalid_payload',
    );

    const one = dog();
    refused(
      await post(app, {
        parts: [D.MON, D.TUE, D.WED, D.THU, D.FRI].map((date) =>
          part({ dogs: [one], dates: [date] }),
        ),
      }),
      'invalid_payload',
    );

    const five = [dog(), dog(), dog(), dog(), dog()];
    const thirty = weekdays(MAX_DATES_PER_PART + 1);
    assert.equal(5 * MAX_DATES_PER_PART + 1, MAX_DOG_DATES_PER_ORDER + 1);
    refused(
      await post(app, {
        parts: [
          part({ dogs: five, dates: thirty.slice(0, MAX_DATES_PER_PART) }),
          part({ category: 'day-school', dogs: [five[0]!], dates: [thirty[MAX_DATES_PER_PART]!] }),
        ],
      }),
      'invalid_payload',
    );

    refused(
      await post(app, {
        parts: [part({ dogs: [dog(), dog(), dog(), dog(), dog(), dog()], dates: [D.MON] })],
      }),
      'invalid_payload',
    );

    refused(
      await post(app, {
        parts: [part({ dogs: [dog()], dates: [D.MON] })],
        alumni_on_regular: [
          { location: 'bentonville', mode: 'daycare', count: 1 },
          { location: 'bentonville', mode: 'daycare', count: 2 },
        ],
      }),
      'invalid_payload',
    );

    refused(
      await post(app, {
        parts: [part({ dogs: [dog()], dates: weekdays(MAX_DATES_PER_PART + 1) })],
      }),
      'bad_request',
      400,
    );
    refused(
      await post(app, {
        parts: [{ ...part({ dogs: [dog()], dates: [D.MON] }), payment: { kind: 'credits' } }],
      }),
      'bad_request',
      400,
    );

    const staff = orderApp({ principal: FIXTURE_STAFF_PRINCIPAL });
    refused(
      await post(staff.app, { parts: [part({ dogs: [dog()], dates: [D.MON] })] }),
      'forbidden',
      403,
    );
    refused(
      await check(staff.app, { parts: [part({ dogs: [dog()], dates: [D.MON] })] }),
      'forbidden',
      403,
    );
  },
);

// ── B14: reach ──────────────────────────────────────────────────────────────────

test(
  "B14: Lola's lot ends Tue 24: `credits_short` 1 on Wed, credits expiring first; a date past the single day's reach is `credit_expired_before_date` with `location`, before `credits_short` (check = POST)",
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    const endsTue = at(D.TUE, '17:00').toISOString();
    await care({ credits: 3, expiresAt: endsTue });
    const { app } = orderApp();

    const short = await checkThenPost(app, { parts: [part({ dogs: [lola], dates: MON_TO_WED })] });
    assert.deepEqual(refused<CreditsShortDetails>(short, 'credits_short').pools, [
      {
        location: 'bentonville',
        mode: 'daycare',
        tier: 'regular',
        balance: 3,
        required: 3,
        shortfall: 1,
        dog_ids: [lola],
        short_dates: [
          { date: D.WED, dog_id: lola, reason: 'credits_expire_first', expires_at: endsTue },
        ],
      },
    ]);

    const beyond = await checkThenPost(app, {
      parts: [part({ dogs: [lola], dates: [...MON_TO_WED, D.WED_30_DEC] })],
    });
    assert.deepEqual(
      refused<CreditExpiredBeforeDateDetails>(beyond, 'credit_expired_before_date'),
      {
        kind: 'credit_expired_before_date',
        expires_at: endsTue,
        dates: [D.WED_30_DEC],
        location: 'bentonville',
      },
    );
  },
);

// ── B15: what a purchase cannot fix comes first ──────────────────────────────────

test(
  'B15: Lola 3 short with Tue full is `insufficient_capacity`, no credit refusal; an overlap is `already_booked`; a two-campus after-school refusal names its campus (check = POST)',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    const { app } = orderApp();

    await db.insert(dayCapacity).values({ location: 'bentonville', date: D.TUE, capacityDogs: 0 });
    const full = await checkThenPost(app, { parts: [part({ dogs: [lola], dates: MON_TO_WED })] });
    const gap = refused<InsufficientCapacityDetails>(full, 'insufficient_capacity');
    assert.deepEqual([gap.location, gap.date, gap.requested], ['bentonville', D.TUE, 1]);
    await db.delete(dayCapacity).where(eq(dayCapacity.location, 'bentonville'));

    await care({ credits: 1 });
    assert.equal(
      (await post(app, { parts: [part({ dogs: [lola], dates: [D.MON] })] })).statusCode,
      201,
    );
    const overlap = await checkThenPost(app, {
      parts: [part({ dogs: [lola], dates: MON_TO_WED })],
    });
    assert.deepEqual(
      refused<AlreadyBookedDetails>(overlap, 'already_booked').conflicts.map((c) => [
        c.dog_id,
        c.date,
      ]),
      [[lola, D.MON]],
    );

    const biscuit = await createBookableDog(created);
    // The campus's own number is put back, whatever it was: `restoreDaySeeds` does not hold it.
    const [campus] = await db
      .select({ places: dayProgramSettings.afterSchoolCapacityCount })
      .from(dayProgramSettings)
      .where(eq(dayProgramSettings.location, 'bentonville'));
    await setCampusSettings('bentonville', { afterSchoolCapacityCount: 0 });
    try {
      const ticked = await checkThenPost(app, {
        parts: [
          part({
            category: 'day-school',
            location: 'fayetteville',
            dogs: [biscuit],
            dates: [D.THU],
          }),
          part({
            category: 'day-school',
            dogs: [lola],
            dates: [D.THU],
            after_school: { [lola]: [D.THU] },
          }),
        ],
      });
      assert.deepEqual(refused<AfterSchoolFullDetails>(ticked, 'after_school_full'), {
        kind: 'after_school_full',
        date: D.THU,
        capacity: 0,
        booked: 0,
        location: 'bentonville',
      });
    } finally {
      await setCampusSettings('bentonville', { afterSchoolCapacityCount: campus?.places ?? null });
    }
  },
);

// ── B16: a refusal after a write ─────────────────────────────────────────────────

test(
  "B16: part B refused at the insert-time floor, after part A's rows are written: 422, and nothing of A stands",
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    const biscuit = await createBookableDog(created);
    await care({ credits: 2 });
    await plantLot({ credits: 2, expiresAt: ENDS_31_DEC, location: 'bentonville', mode: 'school' });
    const { app } = orderApp();
    const original = dayCapacityRepository.assertCapacityWithinLock.bind(dayCapacityRepository);
    const seen = new Map<string, number>();
    mock.method(
      dayCapacityRepository,
      'assertCapacityWithinLock',
      async (tx: unknown, args: Parameters<typeof original>[1]) => {
        const key = `${args.location}:${args.date}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        // The pre-pass sees Tue once; the insert loop is its second sight.
        if (key === `bentonville:${D.TUE}` && seen.get(key) === 2) {
          throw insufficientCapacityError({
            location: args.location,
            date: args.date,
            openings_remaining: 0,
            requested: args.requestedCount,
          });
        }
        return original(tx as Parameters<typeof original>[0], args);
      },
    );
    const before = await rowCounts();

    const res = await post(app, {
      parts: [
        part({ dogs: [lola], dates: [D.MON] }),
        part({ category: 'day-school', dogs: [biscuit], dates: [D.TUE] }),
      ],
    });

    refused(res, 'insufficient_capacity');
    assert.equal(seen.get(`bentonville:${D.MON}`), 2, "part A's insert ran before part B's floor");
    assert.deepEqual(await rowCounts(), before, 'nothing of part A stands');
    assert.equal(await careBalance(), 2);
  },
);

// ── B17, B18: the key across a purchase, and past the cutoff ────────────────────

test(
  'B17: a key refused 422 books 201 with the same body after she buys the credits on the shop',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    const o = orderApp();
    const key = `order-b17-${randomUUID()}`;
    const body = { parts: [part({ dogs: [lola], dates: MON_TO_WED })] };

    refused(await post(o.app, body, key), 'credits_short');
    await buy(o, 'single-day-daycare-bentonville', 3);

    const res = await post(o.app, body, key);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await careBalance(), 0);
  },
);

test(
  'B18: a stored 201 for today, replayed after the same-day cutoff, is that 201; a new key is refused',
  SKIP_WHEN_NO_DB,
  async () => {
    const lola = await createBookableDog(created);
    await care({ credits: 2 });
    const clock = makeClock(at(D.WED_18, '07:00'));
    const { app } = orderApp({ clock });
    const key = `order-b18-${randomUUID()}`;
    const body = { parts: [part({ dogs: [lola], dates: [D.WED_18] })] };

    const first = await post(app, body, key);
    assert.equal(first.statusCode, 201, first.body);
    clock.set(at(D.WED_18, '08:00'));
    const replay = await post(app, body, key);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), first.json());
    refused(await post(app, body), 'same_day_cutoff_passed');
  },
);

// ── B19: an alumni dog and day school ────────────────────────────────────────────

test(
  'B19: Waffles on day school is `alumni_no_day_school`; Lola alone books; his day care books; a day-school booking from before he was alumni stands and cancels',
  SKIP_WHEN_NO_DB,
  async () => {
    const waffles = await createBookableDog(created);
    const lola = await createBookableDog(created);
    await plantLot({ credits: 3, expiresAt: ENDS_31_DEC, location: 'bentonville', mode: 'school' });
    const { app } = orderApp();

    const older = await post(app, {
      parts: [part({ category: 'day-school', dogs: [waffles], dates: [D.FRI] })],
    });
    assert.equal(older.statusCode, 201, older.body);
    await db.update(dogs).set({ isAlumni: true }).where(eq(dogs.id, waffles));

    const both = await checkThenPost(app, {
      parts: [part({ category: 'day-school', dogs: [lola, waffles], dates: [D.MON] })],
    });
    assert.deepEqual(refused<AlumniNoDaySchoolDetails>(both, 'alumni_no_day_school'), {
      kind: 'alumni_no_day_school',
      dog_ids: [waffles],
    });

    const alone = await post(app, {
      parts: [part({ category: 'day-school', dogs: [lola], dates: [D.MON] })],
    });
    assert.equal(alone.statusCode, 201, alone.body);

    await care({ credits: 1, tier: 'alumni' });
    const careDay = await post(app, { parts: [part({ dogs: [waffles], dates: [D.TUE] })] });
    assert.equal(careDay.statusCode, 201, careDay.body);
    assert.deepEqual((careDay.json() as PostBookingOrdersResponse).plan, [
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'alumni', count: 1 },
    ]);

    const olderId = sessionIds(older)[0]!;
    const standing = await app.inject({ method: 'GET', url: `/bookings/${olderId}` });
    assert.equal(standing.statusCode, 200, standing.body);
    assert.equal((standing.json() as BookingWire).status, 'upcoming');
    const cancelled = await app.inject({
      method: 'POST',
      url: `/bookings/${olderId}/cancel`,
      headers: { 'idempotency-key': `b19-${randomUUID()}` },
      payload: {},
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(await poolBalance({ location: 'bentonville', mode: 'school' }), 2);
  },
);

// ── B20: a staff alumni grant racing an order ─────────────────────────────────────

test(
  "B20: a staff alumni grant that commits first is seen by the order that waited on it: Waffles' days are alumni",
  SKIP_WHEN_NO_DB,
  async () => {
    const waffles = await createBookableDog(created);
    const lola = await createBookableDog(created);
    await care({ credits: 3, tier: 'alumni' });
    await care({ credits: 6 });
    const { app } = orderApp();

    // The grant as `staffAlumni` takes it: the dog row `FOR NO KEY UPDATE`, then the flag.
    const grant = await hold('SELECT 1 FROM dogs WHERE id = $1 FOR NO KEY UPDATE', [waffles]);
    let ordering: Promise<Awaited<ReturnType<typeof post>>>;
    try {
      await grant.client.query('UPDATE dogs SET is_alumni = true WHERE id = $1', [waffles]);
      ordering = post(app, { parts: [part({ dogs: [waffles, lola], dates: MON_TO_WED })] });
      await untilBlockedBy(grant.pid, ordering);
    } finally {
      await release(grant, 'COMMIT');
    }
    const res = await ordering;

    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual((res.json() as PostBookingOrdersResponse).plan, [
      { dog_id: waffles, location: 'bentonville', mode: 'daycare', tier: 'alumni', count: 3 },
      { dog_id: lola, location: 'bentonville', mode: 'daycare', tier: 'regular', count: 3 },
    ]);
  },
);

test(
  "B20: an order that read the flag first holds it: a staff grant cannot take the dog's row until the order ends",
  SKIP_WHEN_NO_DB,
  async () => {
    const waffles = await createBookableDog(created);
    await care({ credits: 3 });
    const { app } = orderApp();

    const pools = await hold('SELECT pg_advisory_xact_lock(hashtext($1))', [
      poolKey({ tier: 'alumni' }),
    ]);
    let ordering: Promise<Awaited<ReturnType<typeof post>>>;
    try {
      ordering = post(app, { parts: [part({ dogs: [waffles], dates: MON_TO_WED })] });
      assert.equal(await untilBlockedBy(pools.pid, ordering), true, 'the order waits on the pool');
      assert.equal(
        await rowIsFree('SELECT 1 FROM dogs WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [waffles]),
        false,
        'the grant would wait for the order',
      );
    } finally {
      await release(pools);
    }
    assert.equal((await ordering).statusCode, 201);
  },
);

// ── Reading the shares the order wrote ───────────────────────────────────────────

test(
  'one booking row holds Waffles on alumni and Lola on day care: each debit names its own lot and tier',
  SKIP_WHEN_NO_DB,
  async () => {
    const { waffles, lola } = await wafflesAndLola();
    const alumniLot = await care({ credits: 1, tier: 'alumni' });
    const careLot = await care({ credits: 1 });
    const { app } = orderApp();

    const res = await post(app, { parts: [part({ dogs: [waffles, lola], dates: [D.MON] })] });

    assert.equal(res.statusCode, 201, res.body);
    const [session] = sessionIds(res);
    const debits = await db
      .select({ dogId: creditLedger.dogId, tier: creditLedger.tier, lotId: creditLedger.lotId })
      .from(creditLedger)
      .where(and(eq(creditLedger.bookingId, session!), eq(creditLedger.reason, 'booking-debit')));
    assert.deepEqual(
      sortPlan(
        debits.map((d) => ({ dog_id: d.dogId, tier: d.tier, location: d.lotId ?? '', mode: '' })),
      ),
      sortPlan([
        { dog_id: waffles, tier: 'alumni', location: alumniLot, mode: '' },
        { dog_id: lola, tier: 'regular', location: careLot, mode: '' },
      ]),
    );
    const rows = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.id, session!));
    assert.equal(rows.length, 1);
  },
);

// Keep the clock in one place: every case above reads Wed 18 Nov unless it says otherwise.
assert.equal(WED_18_NOV.toISOString(), '2037-11-18T18:00:00.000Z');
