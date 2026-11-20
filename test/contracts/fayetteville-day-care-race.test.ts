import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import {
  bookings,
  creditLedger,
  dayCapacity,
  invoices,
  scheduledNotifications,
} from '../../src/db/schema/schema.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { registerBookingOrdersRoute } from '../../src/routes/bookingOrders.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { clearOrderWorld, createOtherOwner, memoryThrottle } from './_bookingOrderFixture.js';
import { createFundedDog, removeDogs, restoreDaySeeds } from './_dayFixture.js';
import { clearInvoiceReferrers, FIXTURE_NOW } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * #40 (O-BUGS3; DECISIONS 704, 751, 755): Fayetteville's 15 daily places are ONE count across
 * day school and day care, so the last place is raced across the two programs, the two create
 * routes (`POST /bookings`, `POST /booking-orders`) and two or three families (no shared owner
 * lock). Committed from the round-1 seats' probes (Opus L1 `zz-opus-b40-race`, Fable L5 RACE-B
 * and RACE-C), fewer rounds: the forced cases are deterministic, the free ones are evidence.
 *
 * "Forced": a third connection holds `capacity:fayetteville:<date>`; the second racer starts only
 * once the first is queued on it, and the holder lets go once both are. A route or program that
 * took its own key would never queue there, and the round says so. Waiters are counted in THIS
 * database only (`pg_locks.database`): the server is shared, and another lane's waiter would
 * otherwise start the second racer early (#40 r1, Opus L2).
 */

registerFixtureHooks();

const WED = '2026-06-17';
/** Dates given a one- or two-place override for RACE-C and RACE-B (all weekdays, in horizon). */
const RACE_C_DATES = ['2026-06-18', '2026-06-19', '2026-06-22', '2026-06-23'];
const RACE_B_DATES = ['2026-06-24', '2026-06-25', '2026-06-26'];
const FORCED_ROUNDS = 2;
const FREE_ROUNDS = 3;
const LONG = { ...SKIP_WHEN_NO_DB, timeout: 300_000 };

type Category = 'day-school' | 'day-care';
type Route = 'bookings' | 'orders';
type Answer = { status: number; code: string | undefined; label: string };
type Racer = () => Promise<Answer>;
type Family = { app: ReturnType<typeof appFor>; dog: () => Promise<string> };

const created: string[] = [];
const others: Array<Awaited<ReturnType<typeof createOtherOwner>>> = [];
/** Every dog a family has handed to a racer: unbooked first at teardown, before its pool goes. */
const handed: string[] = [];

async function teardown(): Promise<void> {
  await unbook(handed.splice(0));
  await clearOrderWorld();
  await removeDogs(created.splice(0));
  for (const other of others.splice(0)) await other.remove();
  await db
    .delete(dayCapacity)
    .where(
      and(
        eq(dayCapacity.location, 'fayetteville'),
        inArray(dayCapacity.date, [...RACE_C_DATES, ...RACE_B_DATES]),
      ),
    );
  await restoreDaySeeds();
}

function appFor(principal = FIXTURE_OWNER_PRINCIPAL) {
  const { app, authenticate } = makeContractApp(principal);
  registerBookingsRoute(app, { authenticate, now: FIXTURE_NOW });
  registerBookingOrdersRoute(app, { authenticate, now: FIXTURE_NOW, throttle: memoryThrottle() });
  return app;
}

/** The fixture owner (a fresh funded dog each time) and `n` other families, each with dogs to spare. */
async function families(n: number, dogsEach: number): Promise<Family[]> {
  const out: Family[] = [
    {
      app: appFor(),
      dog: async () => {
        const id = await createFundedDog(created, 1);
        handed.push(id);
        return id;
      },
    },
  ];
  for (let i = 0; i < n; i += 1) {
    const other = await createOtherOwner(dogsEach);
    others.push(other);
    for (const mode of ['school', 'daycare'] as const) {
      await other.plant({
        credits: 400,
        expiresAt: '2036-01-01T00:00:00Z',
        location: 'fayetteville',
        mode,
      });
    }
    let next = 0;
    out.push({
      app: appFor(other.principal),
      dog: async () => {
        const id = other.dogIds[next];
        next += 1;
        assert.ok(id, 'the family ran out of dogs');
        handed.push(id);
        return id;
      },
    });
  }
  return out;
}

/** One ask, one route, one program, for `date` at Fayetteville. An order may hold two parts. */
function racer(
  family: Family,
  route: Route,
  date: string,
  parts: ReadonlyArray<{ category: Category; dogs: readonly string[] }>,
): Racer {
  const bodyOf = (p: { category: Category; dogs: readonly string[] }) => {
    const [lead, ...rest] = p.dogs;
    return {
      category: p.category,
      location: 'fayetteville',
      lead_dog_id: lead,
      ...(rest.length > 0 ? { additional_dog_ids: rest } : {}),
      dates: [date],
    };
  };
  const label = `${route}/${parts.map((p) => `${p.category}x${p.dogs.length}`).join('+')}`;
  return async () => {
    const headers = { 'idempotency-key': `race-${randomUUID()}` };
    const res =
      route === 'bookings'
        ? await family.app.inject({
            method: 'POST',
            url: '/bookings',
            headers,
            payload: { ...bodyOf(parts[0]!), payment: { kind: 'credits' } },
          })
        : await family.app.inject({
            method: 'POST',
            url: '/booking-orders',
            headers,
            payload: { parts: parts.map(bodyOf) },
          });
    const code =
      res.statusCode >= 400 ? (res.json() as { error: { code: string } }).error.code : undefined;
    return { status: res.statusCode, code, label };
  };
}

async function seatsOn(date: string): Promise<{ total: number; school: number; care: number }> {
  const { rows } = await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE b.category = 'day-school')::int AS school,
           count(*) FILTER (WHERE b.category = 'day-care')::int AS care
      FROM booking_dogs bd
      JOIN bookings b ON b.id = bd.booking_id
      JOIN dogs d ON d.id = bd.dog_id
     WHERE b.location = 'fayetteville'
       AND b.category IN ('day-school', 'day-care')
       AND b.status <> 'cancelled'
       AND b.expired_at IS NULL AND bd.expired_at IS NULL
       AND d.staff_owner_id IS NULL
       AND (b.scheduled_at AT TIME ZONE 'America/Chicago')::date = ${date}::date`);
  return rows[0] as { total: number; school: number; care: number };
}

/** Advisory waiters in THIS database only. */
async function waitersHere(client: pg.Client): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  );
  return (res.rows[0] as { n: number }).n;
}

async function untilWaiters(client: pg.Client, wanted: number): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while ((await waitersHere(client)) < wanted) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return true;
}

/** Drop every booking these dogs hold, with their debits, keeping the dogs (the credits come back). */
async function unbook(dogIds: readonly string[]): Promise<void> {
  const ids = (
    await db.execute(sql`SELECT DISTINCT booking_id AS id FROM booking_dogs
                          WHERE dog_id IN (SELECT unnest(${`{${dogIds.join(',')}}`}::uuid[]))`)
  ).rows.map((r) => (r as { id: string }).id);
  if (ids.length === 0) return;
  await db.delete(scheduledNotifications).where(inArray(scheduledNotifications.bookingId, ids));
  await clearInvoiceReferrers();
  await db.delete(invoices).where(inArray(invoices.bookingId, ids));
  await db.delete(creditLedger).where(inArray(creditLedger.bookingId, ids));
  await db.delete(bookings).where(inArray(bookings.id, ids));
}

function tally(outcomes: string[]): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const o of outcomes) seen[o] = (seen[o] ?? 0) + 1;
  return seen;
}

const said = (a: Answer) => `${a.status}${a.code ? ` ${a.code}` : ''}`;

test(
  "the 16th dog at Fayetteville, day school against day care: forced on the campus's ONE capacity lock, both routes, both orders of arrival, two families — the first takes the 15th place and the second is refused; and free-for-all, never above 15",
  LONG,
  async () => {
    const failures: string[] = [];
    try {
      await invalidatePattern('avail:fayetteville:*');
      const [mine, theirs] = (await families(1, FORCED_ROUNDS * 4 + FREE_ROUNDS * 4 + 4)) as [
        Family,
        Family,
      ];

      // 14 seated, both programs: 7 day school (POST /bookings) + 7 day care (POST /booking-orders).
      for (let i = 0; i < 14; i += 1) {
        const school = i < 7;
        const r = await racer(mine, school ? 'bookings' : 'orders', WED, [
          { category: school ? 'day-school' : 'day-care', dogs: [await mine.dog()] },
        ])();
        assert.equal(r.status, 201, `filler ${i + 1}: ${r.code}`);
      }
      assert.deepEqual(await seatsOn(WED), { total: 14, school: 7, care: 7 });

      const one = async (family: Family, route: Route, category: Category) => {
        const dog = await family.dog();
        return { dogs: [dog], run: racer(family, route, WED, [{ category, dogs: [dog] }]) };
      };
      const combos: Array<[string, () => ReturnType<typeof one>, () => ReturnType<typeof one>]> = [
        [
          'school/bookings(mine) then care/orders(theirs)',
          () => one(mine, 'bookings', 'day-school'),
          () => one(theirs, 'orders', 'day-care'),
        ],
        [
          'care/orders(theirs) then school/bookings(mine)',
          () => one(theirs, 'orders', 'day-care'),
          () => one(mine, 'bookings', 'day-school'),
        ],
        [
          'care/bookings(mine) then school/orders(theirs)',
          () => one(mine, 'bookings', 'day-care'),
          () => one(theirs, 'orders', 'day-school'),
        ],
        [
          'school/orders(theirs) then care/bookings(mine)',
          () => one(theirs, 'orders', 'day-school'),
          () => one(mine, 'bookings', 'day-care'),
        ],
      ];
      for (const [name, first, second] of combos) {
        const outcomes: string[] = [];
        for (let round = 0; round < FORCED_ROUNDS; round += 1) {
          const A = await first();
          const B = await second();
          const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
          await holder.connect();
          let answers: [Answer, Answer];
          let queued = '';
          try {
            await holder.query('BEGIN');
            await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
              `capacity:fayetteville:${WED}`,
            ]);
            const pa = A.run();
            if (!(await untilWaiters(holder, 1))) queued = 'first never queued; ';
            const pb = B.run();
            if (!(await untilWaiters(holder, 2))) queued += 'second never queued; ';
            await holder.query('COMMIT');
            answers = [await pa, await pb];
          } finally {
            await holder.query('ROLLBACK').catch(() => undefined);
            await holder.end();
          }
          const seats = await seatsOn(WED);
          outcomes.push(
            `${queued}first ${said(answers[0])}; second ${said(answers[1])}; seats ${seats.total}`,
          );
          await unbook([...A.dogs, ...B.dogs]);
          const back = (await seatsOn(WED)).total;
          if (back !== 14) failures.push(`${name}: not back to 14 after the round (${back})`);
        }
        const t = tally(outcomes);
        console.log(`RACE forced ${name}: ${JSON.stringify(t)}`);
        const want = { 'first 201; second 422 insufficient_capacity; seats 15': FORCED_ROUNDS };
        if (JSON.stringify(t) !== JSON.stringify(want))
          failures.push(`forced ${name}: ${JSON.stringify(t)}`);
      }

      // Free-for-all: four racers at once, one per route x program, two families.
      {
        const outcomes: string[] = [];
        for (let round = 0; round < FREE_ROUNDS; round += 1) {
          const racers = [
            await one(mine, 'bookings', 'day-school'),
            await one(theirs, 'orders', 'day-care'),
            await one(theirs, 'bookings', 'day-care'),
            await one(mine, 'orders', 'day-school'),
          ];
          const answers = await Promise.all(racers.map((r) => r.run()));
          const seats = await seatsOn(WED);
          const won = answers.filter((a) => a.status === 201).length;
          const odd = answers.filter((a) => a.status !== 201 && a.code !== 'insufficient_capacity');
          outcomes.push(
            `won ${won}; seats ${seats.total}; odd ${odd.map((a) => `${a.label}:${said(a)}`).join(',') || 'none'}`,
          );
          await unbook(racers.flatMap((r) => r.dogs));
        }
        const t = tally(outcomes);
        console.log(`RACE free 4-way: ${JSON.stringify(t)}`);
        if (JSON.stringify(t) !== JSON.stringify({ 'won 1; seats 15; odd none': FREE_ROUNDS })) {
          failures.push(`free 4-way: ${JSON.stringify(t)}`);
        }
      }

      // Two places left: a two-dog day care order, a one-dog day school booking and a one-dog
      // day care order, staggered. Any order of arrival fills exactly 15 and never more.
      {
        const { rows } = await db.execute(sql`
          SELECT bd.dog_id FROM booking_dogs bd JOIN bookings b ON b.id = bd.booking_id
           WHERE b.location = 'fayetteville' AND b.category = 'day-care' AND b.status <> 'cancelled'
             AND (b.scheduled_at AT TIME ZONE 'America/Chicago')::date = ${WED}::date
           LIMIT 1`);
        await unbook([(rows[0] as { dog_id: string }).dog_id]);
        assert.equal((await seatsOn(WED)).total, 13);
        const outcomes: string[] = [];
        for (let round = 0; round < FREE_ROUNDS; round += 1) {
          const pairDogs = [await theirs.dog(), await theirs.dog()];
          const pair = {
            dogs: pairDogs,
            run: racer(theirs, 'orders', WED, [{ category: 'day-care', dogs: pairDogs }]),
          };
          const school = await one(mine, 'bookings', 'day-school');
          const care = await one(mine, 'orders', 'day-care');
          const order = [pair, school, care];
          const head = round % 3;
          const answers = await Promise.all(
            order.map(async (r, i) => {
              await new Promise((resolve) =>
                setTimeout(resolve, i === head ? 0 : 3 + ((round + i) % 4)),
              );
              return r.run();
            }),
          );
          const seats = await seatsOn(WED);
          const odd = answers.filter((a) => a.status !== 201 && a.code !== 'insufficient_capacity');
          const outcome = `pair ${said(answers[0]!)}; school ${said(answers[1]!)}; care ${said(answers[2]!)}; seats ${seats.total}`;
          outcomes.push(outcome);
          if (seats.total !== 15 || odd.length > 0) failures.push(`two left: ${outcome}`);
          await unbook([...pair.dogs, ...school.dogs, ...care.dogs]);
        }
        console.log(`RACE free 2-left: ${JSON.stringify(tally(outcomes))}`);
      }
    } finally {
      await teardown();
    }
    assert.deepEqual(failures, []);
  },
);

test(
  "one place left, then two (Fable's RACE-C and RACE-B): a day school ask and a day care ask from two families on the two routes seat exactly one; an order holding a day school dog AND a day care dog, raced by single asks of both programs from three families, never seats more than the two places",
  LONG,
  async () => {
    const failures: string[] = [];
    try {
      const fams = await families(2, 10);
      // RACE-C: one place; one day school ask (POST /bookings) against one day care ask (POST
      // /booking-orders), the order of arrival swapped every round.
      for (const [round, date] of RACE_C_DATES.entries()) {
        await db.insert(dayCapacity).values({ location: 'fayetteville', date, capacityDogs: 1 });
        const a = fams[round % 3]!;
        const b = fams[(round + 1) % 3]!;
        const asks = [
          racer(a, 'bookings', date, [{ category: 'day-school', dogs: [await a.dog()] }]),
          racer(b, 'orders', date, [{ category: 'day-care', dogs: [await b.dog()] }]),
        ];
        if (round % 2 === 1) asks.reverse();
        const answers = await Promise.all(asks.map((ask) => ask()));
        const seats = await seatsOn(date);
        const line = `RACE-C ${date}: ${answers.map((x) => `${x.label} ${said(x)}`).join(', ')}; seats ${seats.total}`;
        console.log(line);
        const won = answers.filter((x) => x.status === 201).length;
        const odd = answers.filter((x) => x.status !== 201 && x.code !== 'insufficient_capacity');
        if (seats.total !== 1 || won !== 1 || odd.length > 0) failures.push(line);
      }
      // RACE-B: two places; one order with a day school part and a day care part (two dogs, all
      // or nothing), a day care booking, a day school booking and a day school order, at once.
      for (const [round, date] of RACE_B_DATES.entries()) {
        await db.insert(dayCapacity).values({ location: 'fayetteville', date, capacityDogs: 2 });
        const a = fams[round % 3]!;
        const b = fams[(round + 1) % 3]!;
        const c = fams[(round + 2) % 3]!;
        const asks = [
          racer(a, 'orders', date, [
            { category: 'day-school', dogs: [await a.dog()] },
            { category: 'day-care', dogs: [await a.dog()] },
          ]),
          racer(b, 'bookings', date, [{ category: 'day-care', dogs: [await b.dog()] }]),
          racer(c, 'bookings', date, [{ category: 'day-school', dogs: [await c.dog()] }]),
          racer(b, 'orders', date, [{ category: 'day-school', dogs: [await b.dog()] }]),
        ];
        const answers = await Promise.all(asks.map((ask) => ask()));
        const seats = await seatsOn(date);
        const line = `RACE-B ${date}: ${answers.map((x) => `${x.label} ${said(x)}`).join(', ')}; seats ${seats.total} (school ${seats.school}, care ${seats.care})`;
        console.log(line);
        const odd = answers.filter((x) => x.status !== 201 && x.code !== 'insufficient_capacity');
        if (seats.total !== 2 || odd.length > 0) failures.push(line);
      }
    } finally {
      await teardown();
    }
    assert.deepEqual(failures, []);
  },
);
