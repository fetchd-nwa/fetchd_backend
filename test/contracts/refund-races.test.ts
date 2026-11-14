import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { Principal } from '../../src/auth/principal.js';
import type { ApiErrorEnvelope } from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { chargesRepository } from '../../src/db/repositories/chargesRepository.js';
import {
  bookings,
  creditLedger,
  invoices,
  orders,
  stripeEvents,
} from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { registerStaffOwnersRoute } from '../../src/routes/staffOwners.js';
import { registerStaffRefundsRoute } from '../../src/routes/staffRefunds.js';
import { registerStripeWebhookRoute } from '../../src/routes/stripeWebhook.js';
import { at, createSession, makeClock, removeSessions, staffCancel, type Clock } from './_checkinFixture.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS, clearInvoiceReferrers } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
  type LogCapture,
} from './_harness.js';
import { clearOrderRows } from './_orderFixture.js';
import { clearPlantedPools } from './_poolFixture.js';
import {
  OWNER,
  SAT,
  deliver,
  jitter,
  lotP,
  postRefund,
  refundRows,
  refundableOf,
  unspent,
  type Bought,
} from './_refundWorld.js';
import {
  signedChargeRefundedEvent,
  signedRefundEvent,
  verifyingSignatures,
} from './_signedEvents.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * P22 B-11, the races (RF3; design.md:3975-3990). One global lock order: the idempotency
 * claim, then the CHARGE row (`lockCharge`), then the POOL (`lockPools`), then `refunds`
 * rows under the charge lock. Every race below is two real requests on two Postgres
 * connections, fired in both orders, on natural timing and under 6 ms jitter (jitter hides a
 * race as well as it finds one), 40 rounds each. A round is judged whole and tallied, so a
 * wrong round is counted rather than stopping the run; the tally line is printed red or
 * green. Each race also has a HELD-LOCK proof on real connections: a third connection holds
 * the lock the race serialises on, both requests are shown waiting on it (and a fourth
 * connection shows which locks they hold while they wait, pinning the order), then it is
 * released and the first in line wins.
 *
 * The calendar is s17's a year on, as go 1 set it (`staff-refunds.test.ts`): `lot_is_live`
 * reads the database's `now()`. Sun 17 Oct 2027 20:00 Tomi books Wed 27 Oct with a `top_up`
 * (the server's branch is live though no client sends it), so lot S's single day is granted
 * and spent on Wed 27 in the settle; Sat 23 Oct 2027 09:00 Shanthi cancels Wed 27 and
 * refunds S's $60.00.
 */

registerFixtureHooks();

const ROUNDS = 40;
const SUN_EVENING = at('2027-10-17', '20:00');
const MON = '2027-10-25';
const WED = '2027-10-27';
/** P's six spent days, all before Sat 23 Oct (go 1's s17, a year on). */
const P_PAST = ['2027-10-11', '2027-10-12', '2027-10-14', '2027-10-18', '2027-10-19', '2027-10-21'];
const POOL_KEY = `pool:${OWNER}:bentonville:school:regular`;

const createdDogs: string[] = [];
const sessions: string[] = [];

/** Everything one round writes, gone: the pool and its lots, the order rows, the bookings. */
async function clearRound(): Promise<void> {
  // The pool first: every Bentonville school row and every charge's lot, with each row that
  // names one (a debit, a return, a refund's removal), before the rows they name.
  await clearPlantedPools();
  await clearOrderRows();
  await removeSessions(sessions.splice(0));
  if (createdDogs.length > 0) {
    const ids = (
      await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(inArray(bookings.leadDogId, createdDogs))
    ).map((r) => r.id);
    if (ids.length > 0) {
      await clearInvoiceReferrers();
      await db.delete(invoices).where(inArray(invoices.bookingId, ids));
      await removeSessions(ids);
    }
  }
  await db.delete(orders).where(eq(orders.ownerId, OWNER));
}

afterEach(async () => {
  await clearRound();
  await db.delete(stripeEvents);
});
after(async () => {
  await removeDogs(createdDogs);
});

// ── the world ──────────────────────────────────────────────────────────────

interface RaceWorld {
  stripe: StripeStub;
  clock: Clock;
  capture: LogCapture;
  /** Tomi's own app: `POST /bookings`. */
  tomi: FastifyInstance;
  /** Shanthi (owner role): the refund, the staff cancel, the payment history, the webhook. */
  shanthi: FastifyInstance;
  /** Amber (manager): the second desk. */
  amber: FastifyInstance;
}

function raceWorld(): RaceWorld {
  const stripe = verifyingSignatures(makeStripeStub());
  const clock = makeClock(SAT);
  const capture = makeLogCapture();
  const staffApp = (principal: Principal): FastifyInstance => {
    const { app, authenticate } = makeContractApp(principal, capture);
    registerStaffRefundsRoute(app, { authenticate, stripe, now: clock.now });
    registerStaffBookingsRoute(app, { authenticate, stripe, now: clock.now });
    registerStaffOwnersRoute(app, { authenticate, now: clock.now });
    registerStripeWebhookRoute(app, { stripe });
    return app;
  };
  const owner = makeContractApp(FIXTURE_OWNER_PRINCIPAL, capture);
  registerBookingsRoute(owner.app, { authenticate: owner.authenticate, stripe, now: clock.now });
  return {
    stripe,
    clock,
    capture,
    tomi: owner.app,
    shanthi: staffApp(FIXTURE_OWNER_ROLE_PRINCIPAL),
    amber: staffApp(FIXTURE_MANAGER_PRINCIPAL),
  };
}

type Res = { statusCode: number; body: string };
type Timing = 'natural' | 'jitter';

function codeOf(res: Res): string {
  if (res.statusCode < 300) return String(res.statusCode);
  try {
    return `${res.statusCode} ${(JSON.parse(res.body) as ApiErrorEnvelope).error.code}`;
  } catch {
    return String(res.statusCode);
  }
}

/** A deadlock surfaces as a 500 whose log line carries Postgres's 40P01. */
function deadlockLogged(w: RaceWorld): boolean {
  return w.capture.lines.some((l) => /40P01|deadlock detected/.test(JSON.stringify(l)));
}

/** Fire `a` and `b` back to back (`natural`) or 0-6 ms apart (`jitter`), `b` first when asked. */
async function race(
  a: () => Promise<Res>,
  b: () => Promise<Res>,
  args: { timing: Timing; bFirst: boolean },
): Promise<[Res, Res]> {
  const [first, second] = args.bFirst ? [b, a] : [a, b];
  const p1 = first();
  if (args.timing === 'jitter') await jitter();
  const p2 = second();
  const [r1, r2] = await Promise.all([p1, p2]);
  return args.bFirst ? [r2, r1] : [r1, r2];
}

/** Count a round's verdict; a `WRONG` one is kept by round for the final assertion. */
function tallied(): {
  add(round: number, verdict: string): void;
  report(label: string): void;
  wrong: string[];
} {
  const counts = new Map<string, number>();
  const wrong: string[] = [];
  return {
    wrong,
    add(round, verdict) {
      const key = verdict.startsWith('WRONG') ? 'WRONG' : verdict;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (verdict.startsWith('WRONG')) wrong.push(`round ${round}: ${verdict}`);
    },
    report(label) {
      const total = [...counts.values()].reduce((s, n) => s + n, 0);
      const parts = [...counts.entries()].map(([k, n]) => `${k} ${n}`).join('; ');
      process.stdout.write(`# race ${label}: ${total} rounds: ${parts}\n`);
    },
  };
}

async function pepper(): Promise<string> {
  return createBookableDog(createdDogs);
}

/** The ledger rows on a lot that name a refund: its removal, any put-back. */
function refundRowsOnLot(lotId: string) {
  return db
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.lotId, lotId), isNotNull(creditLedger.refundId)));
}

// ── real connections: the holder and the probes ────────────────────────────

async function connection(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

/**
 * Hold the charge row, or the pool's advisory lock, on a third connection. The charge row is
 * held `FOR NO KEY UPDATE`: it blocks every `lockCharge` and `findByIdForUpdate` (both `FOR
 * UPDATE`) but not the `KEY SHARE` a foreign-key check takes when a `refunds` row naming the
 * charge is inserted. Held `FOR UPDATE`, it would also stall that insert, so a path that took
 * no charge lock at all would still be seen waiting (the FK, not the lock) and the proof
 * would pass with the lock removed.
 */
async function hold(what: { charge: string } | { pool: string }): Promise<pg.Client> {
  const gate = await connection();
  await gate.query('BEGIN');
  if ('charge' in what) {
    await gate.query('SELECT id FROM charges WHERE id = $1 FOR NO KEY UPDATE', [what.charge]);
  } else {
    await gate.query('SELECT pg_advisory_xact_lock(hashtext($1))', [what.pool]);
  }
  return gate;
}

async function release(gate: pg.Client): Promise<void> {
  await gate.query('ROLLBACK');
  await gate.end();
}

/** A request in flight, and whether it has answered. */
interface InFlight {
  name: string;
  answer: Promise<Res>;
  settled(): boolean;
}

function inFlight(name: string, answer: Promise<Res>): InFlight {
  let done = false;
  const tracked = answer.finally(() => {
    done = true;
  });
  return { name, answer: tracked, settled: () => done };
}

async function backendsWaitingOnLocks(): Promise<number> {
  const probe = await connection();
  try {
    const { rows } = await probe.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    return rows[0]!.n;
  } finally {
    await probe.end();
  }
}

/**
 * Wait until `count` backends wait on a lock. A request that answers first finished while
 * the lock was held: that is the red this proof exists for, so it fails by name.
 */
async function waitUntilWaiting(count: number, flying: readonly InFlight[]): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    const done = flying.find((f) => f.settled());
    if (done !== undefined) {
      const res = await done.answer;
      assert.fail(`${done.name} finished while the lock was held (${codeOf(res)}): it never waited on it`);
    }
    if ((await backendsWaitingOnLocks()) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`fewer than ${count} requests reached a lock`);
}

/** Whether another backend holds the pool's advisory lock (a fourth connection asks). */
async function poolHeldElsewhere(): Promise<boolean> {
  const probe = await connection();
  try {
    await probe.query('BEGIN');
    const { rows } = await probe.query<{ got: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got',
      [POOL_KEY],
    );
    await probe.query('ROLLBACK');
    return !rows[0]!.got;
  } finally {
    await probe.end();
  }
}

/** Whether another backend holds the charge row's lock (a fourth connection asks, NOWAIT). */
async function chargeRowHeldElsewhere(chargeId: string): Promise<boolean> {
  const probe = await connection();
  try {
    await probe.query('BEGIN');
    try {
      await probe.query('SELECT id FROM charges WHERE id = $1 FOR UPDATE NOWAIT', [chargeId]);
      return false;
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') return true;
      throw err;
    } finally {
      await probe.query('ROLLBACK');
    }
  } finally {
    await probe.end();
  }
}

/** Hold a lock, fire `first` and wait until it waits, then `second`; check; release; answer. */
async function inLine(args: {
  holding: { charge: string } | { pool: string };
  first: [string, () => Promise<Res>];
  second: [string, () => Promise<Res>];
  /** Asked while both wait, before the release. */
  whileBothWait?: () => Promise<void>;
}): Promise<[Res, Res]> {
  const gate = await hold(args.holding);
  const flying: InFlight[] = [];
  let released = false;
  try {
    const one = inFlight(args.first[0], args.first[1]());
    flying.push(one);
    await waitUntilWaiting(1, [one]);
    const two = inFlight(args.second[0], args.second[1]());
    flying.push(two);
    await waitUntilWaiting(2, [one, two]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const f of [one, two]) {
      assert.equal(f.settled(), false, `${f.name} finished while the lock was held`);
    }
    await args.whileBothWait?.();
    await release(gate);
    released = true;
    return [await one.answer, await two.answer];
  } finally {
    if (!released) await release(gate).catch(() => undefined);
    // A proof that failed early still waits for what it sent, so nothing it fired outlives it.
    await Promise.allSettled(flying.map((f) => f.answer));
  }
}

// ── RF3: a cancel of a top-up day racing a refund of that top-up's charge ────

/** Sun 17 Oct 20:00 Tomi books Wed 27 with a `top_up` of 1: lot S granted and spent on it. */
async function topUpWednesday(w: RaceWorld, dogId: string): Promise<{ bookingId: string; s: Bought }> {
  w.clock.set(SUN_EVENING);
  w.stripe.setIntentsCreatedAt(SUN_EVENING);
  const res = await w.tomi.inject({
    method: 'POST',
    url: '/bookings',
    headers: { 'idempotency-key': `p22-b11-top-up-${randomUUID()}` },
    payload: {
      category: 'day-school',
      lead_dog_id: dogId,
      dates: [WED],
      location: 'bentonville',
      payment: {
        kind: 'credits',
        top_up: {
          count: 1,
          payment_method_id: FIXTURE_IDS.paymentMethod1Id,
          expected_total_cents: 6000,
        },
      },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.leadDogId, dogId), eq(bookings.status, 'upcoming')));
  assert.ok(row?.orderId, 'the top-up day belongs to an order');
  const charge = await chargesRepository.findEngineByOrderId(db, row.orderId);
  assert.ok(charge?.stripePaymentIntentId, "the top-up's charge");
  assert.equal(charge.status, 'succeeded');
  assert.equal(charge.amountCents, 6000);
  const [lot] = await db
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.chargeId, charge.id), eq(creditLedger.reason, 'purchase')));
  assert.ok(lot, 'lot S');
  assert.equal(lot.delta, 1);
  assert.equal(await unspent(lot.id), 0, "S's single day is spent on Wed 27 in the settle");
  w.clock.set(SAT);
  return {
    bookingId: row.id,
    s: { chargeId: charge.id, lotId: lot.id, paymentIntentId: charge.stripePaymentIntentId },
  };
}

function rf3Requests(
  w: RaceWorld,
  args: { bookingId: string; s: Bought; credits: 0 | 1 },
): { cancel: () => Promise<Res>; refund: () => Promise<Res> } {
  return {
    cancel: () => staffCancel(w.shanthi, { bookingId: args.bookingId, reason: 'Pepper died' }),
    refund: () =>
      postRefund(w.shanthi, {
        payment_id: args.s.chargeId,
        amount_cents: 6000,
        credits_to_remove: args.credits,
        reason: 'Pepper died; the single day',
      }),
  };
}

const RF3_CANCEL_FIRST = 'cancel first: S +1, then -1, 201';
const RF3_REFUND_FIRST = 'refund first: 422 lot_insufficient, then the cancel returns the credit to S';
const RF3_MONEY_ONLY = 'money only: 201, and the cancel’s credit lands spendable in S';

async function rf3Verdict(
  w: RaceWorld,
  args: { credits: 0 | 1; cancel: Res; refund: Res; bookingId: string; s: Bought },
): Promise<string> {
  const left = await unspent(args.s.lotId);
  const rows = await refundRows(args.s.chargeId);
  const removals = await refundRowsOnLot(args.s.lotId);
  const [booking] = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, args.bookingId));
  const cancelled = args.cancel.statusCode === 200 && booking?.status === 'cancelled';
  const refund = codeOf(args.refund);
  if (args.credits === 1) {
    if (
      cancelled &&
      refund === '201' &&
      left === 0 &&
      rows.length === 1 &&
      removals.length === 1 &&
      removals[0]!.delta === -1 &&
      removals[0]!.refundId === rows[0]!.id
    ) {
      return RF3_CANCEL_FIRST;
    }
    if (
      cancelled &&
      refund === '422 lot_insufficient' &&
      left === 1 &&
      rows.length === 0 &&
      removals.length === 0
    ) {
      return RF3_REFUND_FIRST;
    }
  } else if (cancelled && refund === '201' && left === 1 && rows.length === 1 && removals.length === 0) {
    return RF3_MONEY_ONLY;
  }
  return `WRONG: cancel ${codeOf(args.cancel)} (booking ${booking?.status ?? 'gone'}), refund ${refund}, S unspent ${left}, refunds ${rows.length}, removals [${removals.map((r) => r.delta).join(',')}]${deadlockLogged(w) ? ', 40P01 logged' : ''}`;
}

describe("B-11 RF3: a cancel of a top-up day racing a refund of that top-up's charge → serialised on the charge lock (design.md:3988-3990)", () => {
  for (const credits of [1, 0] as const) {
    for (const timing of ['natural', 'jitter'] as const) {
      for (const order of ['cancel fired first', 'refund fired first'] as const) {
        test(
          `RF3 race, credits_to_remove ${credits} (${timing}, ${order}, ${ROUNDS} rounds) → ${credits === 1 ? 'cancel first: 201 and S 0; refund first: 422 lot_insufficient and S 1' : '201 money only and S 1'}; no 40P01`,
          SKIP_WHEN_NO_DB,
          async () => {
            const w = raceWorld();
            w.stripe.setRefundReplyStatus('succeeded');
            const dogId = await pepper();
            const tally = tallied();
            for (let round = 0; round < ROUNDS; round += 1) {
              const { bookingId, s } = await topUpWednesday(w, dogId);
              w.capture.lines.length = 0;
              const fire = rf3Requests(w, { bookingId, s, credits });
              const [cancel, refund] = await race(fire.cancel, fire.refund, {
                timing,
                bFirst: order === 'refund fired first',
              });
              tally.add(round, await rf3Verdict(w, { credits, cancel, refund, bookingId, s }));
              await clearRound();
            }
            tally.report(`RF3 credits ${credits} ${timing} ${order}`);
            assert.deepEqual(tally.wrong, []);
          },
        );
      }
    }
  }

  for (const credits of [1, 0] as const) {
    for (const first of ['cancel', 'refund'] as const) {
      test(
        `RF3 held-lock proof, credits_to_remove ${credits}, ${first} first in line: a third connection holds S's charge row FOR UPDATE; neither finishes until it is released, and neither holds S's pool while it waits (charge before pool); then ${first === 'cancel' ? (credits === 1 ? RF3_CANCEL_FIRST : RF3_MONEY_ONLY) : credits === 1 ? RF3_REFUND_FIRST : RF3_MONEY_ONLY}`,
        SKIP_WHEN_NO_DB,
        async () => {
          const w = raceWorld();
          w.stripe.setRefundReplyStatus('succeeded');
          const dogId = await pepper();
          const { bookingId, s } = await topUpWednesday(w, dogId);
          const fire = rf3Requests(w, { bookingId, s, credits });
          const [one, two] = await inLine({
            holding: { charge: s.chargeId },
            first: [first, fire[first]],
            second: [first === 'cancel' ? 'refund' : 'cancel', first === 'cancel' ? fire.refund : fire.cancel],
            whileBothWait: async () => {
              assert.equal(
                await poolHeldElsewhere(),
                false,
                "S's pool is free while both wait on the charge: neither took the pool before the charge",
              );
            },
          });
          const [cancel, refund] = first === 'cancel' ? [one, two] : [two, one];
          const verdict = await rf3Verdict(w, { credits, cancel, refund, bookingId, s });
          assert.equal(
            verdict,
            first === 'cancel'
              ? credits === 1
                ? RF3_CANCEL_FIRST
                : RF3_MONEY_ONLY
              : credits === 1
                ? RF3_REFUND_FIRST
                : RF3_MONEY_ONLY,
          );
        },
      );
    }
  }
});

// ── two refunds racing one cap ───────────────────────────────────────────────

describe('B-11 two refunds racing one cap: $300.00 and $300.00 on the $456.00 payment → one 201, one 422 over_cap', () => {
  const refund300 = (app: FastifyInstance, p: Bought) => () =>
    postRefund(app, { payment_id: p.chargeId, amount_cents: 30000, credits_to_remove: 0 });

  async function capVerdict(w: RaceWorld, p: Bought, amber: Res, shanthi: Res): Promise<string> {
    const rows = await refundRows(p.chargeId);
    const codes = [codeOf(amber), codeOf(shanthi)];
    if ([...codes].sort().join(' | ') === '201 | 422 over_cap' && rows.length === 1 && rows[0]!.amountCents === 30000) {
      return codes[0] === '201' ? 'amber 201, shanthi 422 over_cap' : 'shanthi 201, amber 422 over_cap';
    }
    return `WRONG: amber ${codes[0]}, shanthi ${codes[1]}, refunds ${rows.length} (${rows.map((r) => r.amountCents).join('+')})${deadlockLogged(w) ? ', 40P01 logged' : ''}`;
  }

  for (const timing of ['natural', 'jitter'] as const) {
    for (const order of ['amber fired first', 'shanthi fired first'] as const) {
      test(`two desks, one cap (${timing}, ${order}, ${ROUNDS} rounds)`, SKIP_WHEN_NO_DB, async () => {
        const w = raceWorld();
        const tally = tallied();
        for (let round = 0; round < ROUNDS; round += 1) {
          const p = await lotP(w.stripe);
          w.capture.lines.length = 0;
          const [amber, shanthi] = await race(refund300(w.amber, p), refund300(w.shanthi, p), {
            timing,
            bFirst: order === 'shanthi fired first',
          });
          tally.add(round, await capVerdict(w, p, amber, shanthi));
          await clearRound();
        }
        tally.report(`cap ${timing} ${order}`);
        assert.deepEqual(tally.wrong, []);
      });
    }
  }

  test(
    "held-lock proof: a third connection holds P's charge row; both refunds wait on it and neither holds P's pool; released, the first in line is 201 and the second 422 over_cap",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = raceWorld();
      const p = await lotP(w.stripe);
      const [amber, shanthi] = await inLine({
        holding: { charge: p.chargeId },
        first: ['amber', refund300(w.amber, p)],
        second: ['shanthi', refund300(w.shanthi, p)],
        whileBothWait: async () => {
          assert.equal(await poolHeldElsewhere(), false, "P's pool is free while both wait on the charge");
        },
      });
      assert.equal(await capVerdict(w, p, amber, shanthi), 'amber 201, shanthi 422 over_cap');
    },
  );
});

// ── a refund racing a booking on the same pool ──────────────────────────────

describe("B-11 a refund racing a booking on the same pool: Shanthi's $114.00 with 2 credits against Tomi's booking of Mon 25 Oct on P's last 2", () => {
  /** P with six days spent before Sat 23 Oct and 2 unspent: the pool's only lot. */
  async function pWithTwoLeft(w: RaceWorld, dogId: string): Promise<Bought> {
    const p = await lotP(w.stripe);
    for (const date of P_PAST) {
      await createSession({ dogIds: [dogId], date, lotId: p.lotId, ledger: sessions });
    }
    assert.equal(await unspent(p.lotId), 2);
    return p;
  }

  function requests(w: RaceWorld, p: Bought, dogId: string) {
    return {
      refund: () =>
        postRefund(w.shanthi, { payment_id: p.chargeId, amount_cents: 11400, credits_to_remove: 2 }),
      booking: () =>
        w.tomi.inject({
          method: 'POST',
          url: '/bookings',
          headers: { 'idempotency-key': `p22-b11-book-${randomUUID()}` },
          payload: {
            category: 'day-school',
            lead_dog_id: dogId,
            dates: [MON],
            location: 'bentonville',
            payment: { kind: 'credits' },
          },
        }),
    };
  }

  const REFUND_FIRST = 'refund first: 201, P 0, the booking 422 insufficient_credits';
  const BOOKING_FIRST = 'booking first: 201, P 1, the refund 422 lot_insufficient';

  async function poolVerdict(w: RaceWorld, p: Bought, dogId: string, refund: Res, booking: Res): Promise<string> {
    const left = await unspent(p.lotId);
    const rows = await refundRows(p.chargeId);
    const monday = await db
      .select({ id: bookings.id, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.leadDogId, dogId), eq(bookings.status, 'upcoming')));
    const booked = monday.length - P_PAST.length;
    const [r, b] = [codeOf(refund), codeOf(booking)];
    if (r === '201' && b === '422 insufficient_credits' && left === 0 && rows.length === 1 && booked === 0) {
      return REFUND_FIRST;
    }
    if (r === '422 lot_insufficient' && b === '201' && left === 1 && rows.length === 0 && booked === 1) {
      return BOOKING_FIRST;
    }
    return `WRONG: refund ${r}, booking ${b}, P unspent ${left}, refunds ${rows.length}, Monday booked ${booked}${deadlockLogged(w) ? ', 40P01 logged' : ''}`;
  }

  for (const timing of ['natural', 'jitter'] as const) {
    for (const order of ['refund fired first', 'booking fired first'] as const) {
      test(
        `refund against booking (${timing}, ${order}, ${ROUNDS} rounds) → never both: P never below 0, no credit both refunded and booked, no 40P01`,
        SKIP_WHEN_NO_DB,
        async () => {
          const w = raceWorld();
          const dogId = await pepper();
          const tally = tallied();
          for (let round = 0; round < ROUNDS; round += 1) {
            const p = await pWithTwoLeft(w, dogId);
            const fire = requests(w, p, dogId);
            w.capture.lines.length = 0;
            const [refund, booking] = await race(fire.refund, fire.booking, {
              timing,
              bFirst: order === 'booking fired first',
            });
            tally.add(round, await poolVerdict(w, p, dogId, refund, booking));
            await clearRound();
          }
          tally.report(`pool ${timing} ${order}`);
          assert.deepEqual(tally.wrong, []);
        },
      );
    }
  }

  for (const first of ['refund', 'booking'] as const) {
    test(
      `held-lock proof, ${first} first in line: a third connection holds P's pool lock; both wait on it, and the refund holds P's charge row while it waits (charge before pool); released, ${first === 'refund' ? REFUND_FIRST : BOOKING_FIRST}`,
      SKIP_WHEN_NO_DB,
      async () => {
        const w = raceWorld();
        const dogId = await pepper();
        const p = await pWithTwoLeft(w, dogId);
        const fire = requests(w, p, dogId);
        const [one, two] = await inLine({
          holding: { pool: POOL_KEY },
          first: [first, fire[first]],
          second: [first === 'refund' ? 'booking' : 'refund', first === 'refund' ? fire.booking : fire.refund],
          whileBothWait: async () => {
            assert.equal(
              await chargeRowHeldElsewhere(p.chargeId),
              true,
              "the refund waits on P's pool holding P's charge row: charge before pool",
            );
          },
        });
        const [refund, booking] = first === 'refund' ? [one, two] : [two, one];
        assert.equal(
          await poolVerdict(w, p, dogId, refund, booking),
          first === 'refund' ? REFUND_FIRST : BOOKING_FIRST,
        );
      },
    );
  }
});

// ── a refund racing a dashboard refund's delivery on the same charge ────────

describe("B-11 a refund racing a dashboard refund's delivery on the same charge (B-6, Fable H2): Shanthi's $114.00 against `charge.refunded` for a $57.00 dashboard refund", () => {
  interface DashboardRound {
    p: Bought;
    dashboardRe: string;
    staff: () => Promise<Res>;
    delivery: () => Promise<Res>;
  }

  /** P, and a $57.00 refund Shanthi already made from the Stripe dashboard on its intent. */
  async function dashboardRound(w: RaceWorld): Promise<DashboardRound> {
    const p = await lotP(w.stripe);
    const dashboardRe = w.stripe.plantRefund({
      paymentIntentId: p.paymentIntentId,
      amountCents: 5700,
      status: 'succeeded',
    });
    const event = signedChargeRefundedEvent({
      paymentIntentId: p.paymentIntentId,
      amountCents: 45600,
      amountRefundedCents: 5700,
    });
    return {
      p,
      dashboardRe,
      staff: () =>
        postRefund(w.shanthi, { payment_id: p.chargeId, amount_cents: 11400, credits_to_remove: 2 }),
      delivery: () => deliver(w.shanthi, event),
    };
  }

  const LISTED_ALONE = 'the delivery listed the dashboard refund alone';
  const LISTED_BOTH = "the delivery listed both (the staff refund already at Stripe)";

  async function dashboardVerdict(w: RaceWorld, round: DashboardRound, staff: Res, delivery: Res): Promise<string> {
    const rows = await refundRows(round.p.chargeId);
    const dashboard = rows.filter((r) => r.stripeRefundId === round.dashboardRe);
    const desk = rows.filter((r) => r.issuedByStaffId !== null);
    const refundable = await refundableOf(w.shanthi, round.p.chargeId);
    const left = await unspent(round.p.lotId);
    // The route logs the handler's note ("N refund(s) listed …"); its body carries the outcome.
    const processed = w.capture.lines.find((l) => l.msg === 'stripe webhook processed');
    const note = typeof processed?.note === 'string' ? processed.note : '';
    if (
      codeOf(staff) === '201' &&
      delivery.statusCode === 200 &&
      rows.length === 2 &&
      dashboard.length === 1 &&
      dashboard[0]!.status === 'succeeded' &&
      dashboard[0]!.amountCents === 5700 &&
      dashboard[0]!.issuedByStaffId === null &&
      desk.length === 1 &&
      desk[0]!.status === 'pending' &&
      desk[0]!.stripeRefundId !== null &&
      desk[0]!.stripeRefundId !== round.dashboardRe &&
      refundable === 28500 &&
      left === 6
    ) {
      if (/2 refund\(s\) listed/.test(note)) return LISTED_BOTH;
      if (/1 refund\(s\) listed/.test(note)) return LISTED_ALONE;
    }
    return `WRONG: staff ${codeOf(staff)}, delivery ${codeOf(delivery)} (${note}), rows ${rows.length}, dashboard rows ${dashboard.length} (${dashboard.map((r) => r.status).join(',')}), desk rows ${desk.length} (${desk.map((r) => `${r.status} ${r.stripeRefundId === null ? 'no re_' : 're_'}`).join(',')}), refundable ${refundable}, P unspent ${left}${deadlockLogged(w) ? ', 40P01 logged' : ''}`;
  }

  for (const timing of ['natural', 'jitter'] as const) {
    for (const order of ['refund fired first', 'delivery fired first'] as const) {
      test(
        `refund against the dashboard refund's delivery (${timing}, ${order}, ${ROUNDS} rounds) → both recorded, the dashboard refund once, the cap counting both (refundable 28500), no money twice, no 40P01`,
        SKIP_WHEN_NO_DB,
        async () => {
          const w = raceWorld();
          const tally = tallied();
          for (let round = 0; round < ROUNDS; round += 1) {
            const r = await dashboardRound(w);
            w.capture.lines.length = 0;
            const [staff, delivery] = await race(r.staff, r.delivery, {
              timing,
              bFirst: order === 'delivery fired first',
            });
            tally.add(round, await dashboardVerdict(w, r, staff, delivery));
            await clearRound();
          }
          tally.report(`dashboard ${timing} ${order}`);
          assert.deepEqual(tally.wrong, []);
        },
      );
    }
  }

  for (const first of ['refund', 'delivery'] as const) {
    test(
      `held-lock proof, the ${first} first in line: a third connection holds P's charge row; the staff refund and the delivery's apply both wait on it; released, both are recorded once and the cap counts both`,
      SKIP_WHEN_NO_DB,
      async () => {
        const w = raceWorld();
        const r = await dashboardRound(w);
        const [one, two] = await inLine({
          holding: { charge: r.p.chargeId },
          first: [first, first === 'refund' ? r.staff : r.delivery],
          second: [first === 'refund' ? 'delivery' : 'refund', first === 'refund' ? r.delivery : r.staff],
        });
        const [staff, delivery] = first === 'refund' ? [one, two] : [two, one];
        // The delivery lists before its transaction, so in either order its list was read
        // before the staff refund reached Stripe.
        assert.equal(await dashboardVerdict(w, r, staff, delivery), LISTED_ALONE);
      },
    );
  }

  test(
    "held-lock proof, a matched row: the staff refund's own `refund.updated` (its re_ stored, live `succeeded`) waits on P's charge row before it writes anything, so every refund status change runs under the charge lock (the one apply function); released, the row is succeeded",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = raceWorld();
      const p = await lotP(w.stripe);
      const staff = await postRefund(w.shanthi, {
        payment_id: p.chargeId,
        amount_cents: 11400,
        credits_to_remove: 2,
      });
      assert.equal(staff.statusCode, 201, staff.body);
      const [row] = await refundRows(p.chargeId);
      assert.ok(row?.stripeRefundId, 'the reply stored its re_');
      assert.equal(row.status, 'pending');
      w.stripe.setRefundState(row.stripeRefundId, 'succeeded');
      const event = signedRefundEvent({
        type: 'refund.updated',
        refundId: row.stripeRefundId,
        paymentIntentId: p.paymentIntentId,
        amountCents: 11400,
        status: 'succeeded',
        refundRowId: row.id,
      });
      const gate = await hold({ charge: p.chargeId });
      let released = false;
      const delivery = inFlight('the delivery', deliver(w.shanthi, event));
      try {
        await waitUntilWaiting(1, [delivery]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(delivery.settled(), false, 'the delivery finished while the charge row was held');
        const [held] = await refundRows(p.chargeId);
        assert.equal(held!.status, 'pending', 'nothing is written while the charge row is held');
        await release(gate);
        released = true;
        assert.equal((await delivery.answer).statusCode, 200);
      } finally {
        if (!released) await release(gate).catch(() => undefined);
        await Promise.allSettled([delivery.answer]);
      }
      const [after] = await refundRows(p.chargeId);
      assert.equal(after!.status, 'succeeded');
    },
  );
});
