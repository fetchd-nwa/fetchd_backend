import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../src/auth/principal.js';
import type {
  ApiErrorEnvelope,
  GetStaffPaymentsRefundProposalResponse,
  OwnerCreditsWire,
  RefundWire,
  StaffPaymentWire,
} from '../../src/contracts/wire.js';
import { db } from '../../src/db/client.js';
import { creditLedgerRepository } from '../../src/db/repositories/creditLedgerRepository.js';
import { invoicesRepository } from '../../src/db/repositories/invoicesRepository.js';
import { refundsRepository } from '../../src/db/repositories/refundsRepository.js';
import { staffBillingRepository } from '../../src/db/repositories/staffBillingRepository.js';
import {
  bookings,
  charges,
  creditLedger,
  creditPackages,
  dogs,
  invoices,
  owners,
  refunds,
} from '../../src/db/schema/schema.js';
import { registerBookingsRoute } from '../../src/routes/bookings.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { registerStaffBookingsRoute } from '../../src/routes/staffBookings.js';
import { registerStaffCreditsRoute } from '../../src/routes/staffCredits.js';
import { registerStaffOwnersRoute } from '../../src/routes/staffOwners.js';
import { registerStaffRefundsRoute } from '../../src/routes/staffRefunds.js';
import { registerStaffSettingsRoute } from '../../src/routes/staffSettings.js';
import { createBookableDog, removeDogs } from './_dayFixture.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_MANAGER_PRINCIPAL,
  FIXTURE_OWNER_PRINCIPAL,
  FIXTURE_OWNER_ROLE_PRINCIPAL,
  FIXTURE_STAFF_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  makeLogCapture,
  registerFixtureHooks,
  type LogCapture,
} from './_harness.js';
import { clearPlantedPools, plantLot } from './_poolFixture.js';
import {
  at,
  createSession,
  makeClock,
  removeSessions,
  staffCancel,
  type Clock,
} from './_checkinFixture.js';
import { makeStripeStub, type StripeStub } from './_stripeStub.js';

/**
 * P22, the staff refund (wire 6.0.0; design §2.7:4163-4215; PAY-U24, PAY-U25, PAY-U28,
 * CRED-U18): who may refund (B-2), the proposal (B-3), and the refund with its credit
 * removal (B-4). Money goes back only when Shanthi or Amber refund it, case by case, at
 * any amount (SIGNOFF.md:252-255); a trainer never does (s18).
 *
 * The calendar is s17's a year on, on the same weekdays, because `lot_is_live` and
 * `lot_pays_date` read the database's `now()` and a lot dated 10 Nov 2026 is dead there
 * today (P21's cancel-returns-credit precedent): Sat 24 Oct 2026 is read as Sat 23 Oct
 * 2027, lot P (*Bentonville 2x Weekly*, 8 credits, $456.00) as bought Sat 9 Oct 2027
 * 20:28 and expiring Tue 9 Nov 2027 20:28, lot S (one single day, $60.00) as bought Sun 17
 * Oct and expiring Wed 17 Nov, and Mon 26, Tue 27, Wed 28 as Mon 25, Tue 26, Wed 27. Lot
 * E keeps its 2026 dates, because it must be dead.
 */

registerFixtureHooks();

const OWNER = FIXTURE_IDS.ownerId;
const SAT = at('2027-10-23', '09:00');
const P_PAST = ['2027-10-11', '2027-10-12', '2027-10-14', '2027-10-18', '2027-10-19', '2027-10-21'];
const MON = '2027-10-25';
const TUE = '2027-10-26';
const WED = '2027-10-27';
const REASON = 'Pepper died; the unused pack';

const createdDogs: string[] = [];
const sessions: string[] = [];
const plantedOwners: string[] = [];
const plantedForeignCharges: string[] = [];
const plantedInvoices: string[] = [];

afterEach(async () => {
  await removeSessions(sessions.splice(0));
  await clearPlantedPools();
  const invoiceIds = plantedInvoices.splice(0);
  if (invoiceIds.length > 0) await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
  await db.delete(refunds).where(eq(refunds.ownerId, OWNER));
  await db.delete(charges).where(eq(charges.ownerId, OWNER));
  const foreign = plantedForeignCharges.splice(0);
  if (foreign.length > 0) {
    await db.delete(refunds).where(inArray(refunds.chargeId, foreign));
    await db.delete(charges).where(inArray(charges.id, foreign));
  }
  const ownerIds = plantedOwners.splice(0);
  if (ownerIds.length > 0) await db.delete(owners).where(inArray(owners.id, ownerIds));
  await db.execute(
    sql`UPDATE staff_settings SET refund_roles = '{owner,manager}', updated_by_staff_id = NULL`,
  );
  await db.execute(
    sql`UPDATE payment_settings SET value = '0', updated_by_staff_id = NULL WHERE key = 'refund_any_role_limit_cents'`,
  );
});
after(async () => {
  await removeDogs(createdDogs);
});

// ── the world ──────────────────────────────────────────────────────────────

async function packageIdOf(key: string): Promise<string> {
  const [row] = await db
    .select({ id: creditPackages.id })
    .from(creditPackages)
    .where(and(eq(creditPackages.key, key), eq(creditPackages.effectiveFrom, '2026-01-01')));
  assert.ok(row, `the catalog row ${key}`);
  return row.id;
}

interface Bought {
  chargeId: string;
  lotId: string;
}

/** A pack charge that took money and the one purchase lot it granted. */
async function plantPurchase(args: {
  key: 'school-2x-weekly-bentonville' | 'single-day-school-bentonville';
  amountCents: number;
  credits: number;
  boughtAt: Date;
  expiresAt: Date;
  paymentIntent?: string | null;
}): Promise<Bought> {
  const packageId = await packageIdOf(args.key);
  const [charge] = await db
    .insert(charges)
    .values({
      ownerId: OWNER,
      amountCents: args.amountCents,
      status: 'succeeded',
      purpose: 'package',
      packageId,
      stripePaymentIntentId:
        args.paymentIntent === undefined ? `pi_test_p22_${randomUUID()}` : args.paymentIntent,
      createdAt: args.boughtAt.toISOString(),
    })
    .returning({ id: charges.id });
  const lotId = randomUUID();
  await db.insert(creditLedger).values({
    id: lotId,
    ownerId: OWNER,
    location: 'bentonville',
    mode: 'school',
    tier: 'regular',
    delta: args.credits,
    reason: 'purchase',
    chargeId: charge!.id,
    packageId,
    expiresAt: args.expiresAt.toISOString(),
    createdAt: args.boughtAt.toISOString(),
  });
  return { chargeId: charge!.id, lotId };
}

async function plantCharge(args: {
  amountCents: number;
  purpose: 'package' | 'board-train' | 'group-class';
  status?: 'succeeded' | 'refunded' | 'failed' | 'requires_payment';
}): Promise<string> {
  const [charge] = await db
    .insert(charges)
    .values({
      ownerId: OWNER,
      amountCents: args.amountCents,
      status: args.status ?? 'succeeded',
      purpose: args.purpose,
      stripePaymentIntentId: `pi_test_p22_${randomUUID()}`,
    })
    .returning({ id: charges.id });
  return charge!.id;
}

const lotP = (paymentIntent?: string | null): Promise<Bought> =>
  plantPurchase({
    key: 'school-2x-weekly-bentonville',
    amountCents: 45600,
    credits: 8,
    boughtAt: at('2027-10-09', '20:28'),
    expiresAt: at('2027-11-09', '20:28'),
    ...(paymentIntent !== undefined ? { paymentIntent } : {}),
  });
const lotS = (): Promise<Bought> =>
  plantPurchase({
    key: 'single-day-school-bentonville',
    amountCents: 6000,
    credits: 1,
    boughtAt: at('2027-10-17', '20:00'),
    expiresAt: at('2027-11-17', '20:00'),
  });
/** Lot E: bought Wed 16 Sep 2026 10:00, dead since Fri 16 Oct 2026 10:00, 1 unspent. */
async function lotE(dogId: string): Promise<Bought> {
  const e = await plantPurchase({
    key: 'school-2x-weekly-bentonville',
    amountCents: 45600,
    credits: 8,
    boughtAt: at('2026-09-16', '10:00'),
    expiresAt: at('2026-10-16', '10:00'),
  });
  for (const date of [
    '2026-09-21',
    '2026-09-22',
    '2026-09-28',
    '2026-09-29',
    '2026-10-05',
    '2026-10-06',
    '2026-10-12',
  ]) {
    await createSession({ dogIds: [dogId], date, lotId: e.lotId, ledger: sessions });
  }
  return e;
}

async function pepper(): Promise<string> {
  const dogId = await createBookableDog(createdDogs);
  await db.update(dogs).set({ name: 'Pepper' }).where(eq(dogs.id, dogId));
  return dogId;
}

/** Book `dates` on `lotId` for Pepper; returns the booking ids in date order. */
async function book(dogId: string, lotId: string, dates: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const date of dates) {
    ids.push((await createSession({ dogIds: [dogId], date, lotId, ledger: sessions })).bookingId);
  }
  return ids;
}

/** s17 after Shanthi's three cancels, planted: P has 6 spent on past days and 2 unspent;
 *  S has 1 unspent. */
async function s17AfterCancels(dogId: string): Promise<{ p: Bought; s: Bought }> {
  const p = await lotP();
  await book(dogId, p.lotId, P_PAST);
  const s = await lotS();
  return { p, s };
}

// ── the routes ─────────────────────────────────────────────────────────────

function appOf(
  principal: Principal,
  world: { stripe: StripeStub; clock: Clock },
  capture?: LogCapture,
): FastifyInstance {
  const { app, authenticate } = makeContractApp(principal, capture);
  const { stripe, clock } = world;
  registerStaffRefundsRoute(app, { authenticate, stripe, now: clock.now });
  registerStaffBookingsRoute(app, { authenticate, stripe, now: clock.now });
  registerStaffOwnersRoute(app, { authenticate, now: clock.now });
  registerStaffCreditsRoute(app, { authenticate, now: clock.now });
  registerStaffSettingsRoute(app, { authenticate });
  registerCreditsRoute(app, { authenticate, now: clock.now });
  registerBookingsRoute(app, { authenticate, stripe, now: clock.now });
  return app;
}

function world(): { stripe: StripeStub; clock: Clock } {
  return { stripe: makeStripeStub(), clock: makeClock(SAT) };
}

interface RefundBody {
  payment_id: string;
  amount_cents: number;
  instrument: string;
  reason: string;
  credits_to_remove?: number;
  enrollment_id?: string;
}

function postRefund(
  app: FastifyInstance,
  body: RefundBody | Record<string, unknown>,
  key?: string,
) {
  return app.inject({
    method: 'POST',
    url: '/staff/refunds',
    headers: { 'idempotency-key': key ?? `p22-refund-${randomUUID()}` },
    payload: body,
  });
}

function proposalOf(app: FastifyInstance, paymentId: string) {
  return app.inject({ method: 'GET', url: `/staff/payments/${paymentId}/refund-proposal` });
}

function codeOf(res: { statusCode: number; body: string }, status: number, code: string): void {
  assert.equal(res.statusCode, status, res.body);
  assert.equal((JSON.parse(res.body) as ApiErrorEnvelope).error.code, code, res.body);
}

function created(res: { statusCode: number; body: string }): RefundWire {
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body) as RefundWire;
}

function proposal(res: {
  statusCode: number;
  body: string;
}): GetStaffPaymentsRefundProposalResponse {
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as GetStaffPaymentsRefundProposalResponse;
}

async function refundRows(chargeId?: string) {
  return db
    .select()
    .from(refunds)
    .where(chargeId === undefined ? eq(refunds.ownerId, OWNER) : eq(refunds.chargeId, chargeId))
    .orderBy(refunds.createdAt);
}

/** Every ledger row that names a refund, oldest first. */
async function refundLedgerRows() {
  const { rows } = await db.execute(sql`
    SELECT id, delta, reason::text AS reason, lot_id AS "lotId", refund_id AS "refundId",
           created_by_staff_id AS "createdByStaffId", checkin_event_id AS "checkinEventId",
           note, expires_at AS "expiresAt"
      FROM credit_ledger WHERE owner_id = ${OWNER} AND refund_id IS NOT NULL
     ORDER BY created_at, id`);
  return rows as {
    id: string;
    delta: number;
    reason: string;
    lotId: string | null;
    refundId: string;
    createdByStaffId: string | null;
    checkinEventId: string | null;
    note: string;
    expiresAt: string | null;
  }[];
}

async function unspent(lotId: string): Promise<number> {
  return db.transaction((tx) => creditLedgerRepository.lotUnspentInTx(tx, lotId));
}

async function noticeCount(): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT (SELECT count(*) FROM notifications WHERE owner_id = ${OWNER})::int
         + (SELECT count(*) FROM scheduled_notifications)::int AS n`);
  return (rows[0] as { n: number }).n;
}

const refundCalls = (stripe: StripeStub) => stripe.calls.filter((c) => c.method === 'createRefund');

async function payments(app: FastifyInstance): Promise<StaffPaymentWire[]> {
  const res = await app.inject({ method: 'GET', url: `/staff/owners/${OWNER}/payments` });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as StaffPaymentWire[];
}

async function tomiBalance(app: FastifyInstance): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/credits?location=bentonville' });
  assert.equal(res.statusCode, 200, res.body);
  const pool = (JSON.parse(res.body) as OwnerCreditsWire).pools.find(
    (p) => p.mode === 'school' && p.tier === 'regular',
  );
  return pool?.balance ?? 0;
}

async function staffName(staffId: string): Promise<string> {
  const { rows } = await db.execute(sql`SELECT name FROM staff WHERE id = ${staffId}`);
  return (rows[0] as { name: string }).name;
}

async function ownerName(): Promise<string> {
  const [row] = await db
    .select({ name: owners.name, email: owners.email })
    .from(owners)
    .where(eq(owners.id, OWNER));
  return row!.name !== null && row!.name.trim() !== '' ? row!.name : row!.email;
}

// ── B-2: who may refund ──────────────────────────────────────────────────────

describe('B-2 who may refund (PAY-U25; D6; s18)', () => {
  test(
    "RF0/RF1: Fed's $1.00 is 403 refund_role_required and writes and sends nothing; his proposal is 403; Amber's $114.00 is 201; Tomi's token is 403 forbidden on all four",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      const w = world();
      const fed = appOf(FIXTURE_STAFF_PRINCIPAL, w);
      const before = await refundLedgerRows();

      codeOf(
        await postRefund(fed, {
          payment_id: p.chargeId,
          amount_cents: 100,
          instrument: 'original_card',
          reason: 'help',
        }),
        403,
        'refund_role_required',
      );
      assert.equal((await refundRows()).length, 0, 'no refunds row');
      assert.deepEqual(await refundLedgerRows(), before, 'no ledger row');
      assert.equal(refundCalls(w.stripe).length, 0, 'no Stripe call');
      codeOf(await proposalOf(fed, p.chargeId), 403, 'refund_role_required');

      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      created(
        await postRefund(amber, {
          payment_id: p.chargeId,
          amount_cents: 11400,
          instrument: 'original_card',
          reason: REASON,
          credits_to_remove: 2,
        }),
      );

      const tomi = appOf(FIXTURE_OWNER_PRINCIPAL, w);
      codeOf(
        await postRefund(tomi, {
          payment_id: p.chargeId,
          amount_cents: 100,
          instrument: 'original_card',
          reason: 'mine',
        }),
        403,
        'forbidden',
      );
      codeOf(await proposalOf(tomi, p.chargeId), 403, 'forbidden');
      // Retry and resolve-external: their 403s are B-5's (its last describe, below).
    },
  );

  test(
    'the limit: Amber sets pay.refund_any_role_limit_cents to 5000 → Fed at $50.00 is 201, at $50.01 is 403, and his proposal is 200',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      const w = world();
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      const patch = await amber.inject({
        method: 'PATCH',
        url: '/staff/settings/pay',
        headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
        payload: JSON.stringify({ refund_any_role_limit_cents: 5000 }),
      });
      assert.equal(patch.statusCode, 200, patch.body);

      const fed = appOf(FIXTURE_STAFF_PRINCIPAL, w);
      const fifty = created(
        await postRefund(fed, {
          payment_id: p.chargeId,
          amount_cents: 5000,
          instrument: 'original_card',
          reason: 'a small one',
          credits_to_remove: 0,
        }),
      );
      assert.equal(fifty.issued_by?.staff_id, FIXTURE_IDS.staffDonavanId);
      codeOf(
        await postRefund(fed, {
          payment_id: p.chargeId,
          amount_cents: 5001,
          instrument: 'original_card',
          reason: 'one cent over',
          credits_to_remove: 0,
        }),
        403,
        'refund_role_required',
      );
      assert.equal((await refundRows()).length, 1, 'the 403 wrote nothing');
      proposal(await proposalOf(fed, p.chargeId));
    },
  );

  test(
    "Shanthi takes manager off staff.refund_role_list → Amber's new refund is 403, and her replay of her earlier 201 under its own key returns the stored bytes with no second Stripe call",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      const w = world();
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      const body = {
        payment_id: p.chargeId,
        amount_cents: 11400,
        instrument: 'original_card',
        reason: REASON,
        credits_to_remove: 2,
      };
      const key = `p22-amber-${randomUUID()}`;
      const first = await postRefund(amber, body, key);
      created(first);
      assert.equal(refundCalls(w.stripe).length, 1);

      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const patch = await shanthi.inject({
        method: 'PATCH',
        url: '/staff/settings/staff',
        headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
        payload: JSON.stringify({ refund_roles: ['owner'] }),
      });
      assert.equal(patch.statusCode, 200, patch.body);

      codeOf(
        await postRefund(amber, { ...body, amount_cents: 100, credits_to_remove: 0 }),
        403,
        'refund_role_required',
      );
      const replay = await postRefund(amber, body, key);
      assert.equal(replay.statusCode, 201, replay.body);
      assert.deepEqual(JSON.parse(replay.body), JSON.parse(first.body), 'the stored 201');
      assert.equal(refundCalls(w.stripe).length, 1, 'no second Stripe call');
      assert.equal((await refundRows()).length, 1);
    },
  );

  test(
    "Fed's 403 on an unknown payment_id is byte-equal to his 403 on a real one",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      const fed = appOf(FIXTURE_STAFF_PRINCIPAL, world());
      const body = (paymentId: string) => ({
        payment_id: paymentId,
        amount_cents: 100,
        instrument: 'original_card',
        reason: 'help',
      });
      const real = await postRefund(fed, body(p.chargeId));
      const unknown = await postRefund(fed, body(randomUUID()));
      codeOf(real, 403, 'refund_role_required');
      assert.equal(unknown.statusCode, real.statusCode);
      assert.equal(unknown.body, real.body);
      const realProposal = await proposalOf(fed, p.chargeId);
      const unknownProposal = await proposalOf(fed, randomUUID());
      codeOf(realProposal, 403, 'refund_role_required');
      assert.equal(unknownProposal.body, realProposal.body);
    },
  );

  test(
    "another staffer's key (Fable L2): Fed, then Shanthi, sending Amber's Idempotency-Key with her exact body after her 201 → 422 idempotency_mismatch, no row, no Stripe call; Amber's own replay → her stored 201",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      const w = world();
      const body = {
        payment_id: p.chargeId,
        amount_cents: 11400,
        instrument: 'original_card',
        reason: REASON,
        credits_to_remove: 2,
      };
      const key = `p22-amber-${randomUUID()}`;
      const first = await postRefund(appOf(FIXTURE_MANAGER_PRINCIPAL, w), body, key);
      created(first);
      // Fed would pass the gate up to the limit, so his request reaches the claim.
      await db.execute(
        sql`UPDATE payment_settings SET value = '50000' WHERE key = 'refund_any_role_limit_cents'`,
      );
      for (const principal of [FIXTURE_STAFF_PRINCIPAL, FIXTURE_OWNER_ROLE_PRINCIPAL]) {
        const res = await postRefund(appOf(principal, w), body, key);
        codeOf(res, 422, 'idempotency_mismatch');
        assert.ok(!res.body.includes(p.chargeId), 'never her RefundWire');
      }
      assert.equal((await refundRows()).length, 1, 'no row');
      assert.equal(refundCalls(w.stripe).length, 1, 'no Stripe call');
      const replay = await postRefund(appOf(FIXTURE_MANAGER_PRINCIPAL, w), body, key);
      assert.equal(replay.statusCode, 201);
      assert.deepEqual(JSON.parse(replay.body), JSON.parse(first.body));
    },
  );
});

// ── B-3: the proposal ────────────────────────────────────────────────────────

describe('B-3 the proposal (PAY-U28, CRED-U18; D7)', () => {
  test(
    "s17 after Shanthi's three cancels, Sat 09:00: P proposes $114.00 for 2 live unbooked credits at $57.00; S proposes $60.00 for 1",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p, s } = await s17AfterCancels(dogId);
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, world());
      assert.deepEqual(proposal(await proposalOf(shanthi, p.chargeId)), {
        proposed_cents: 11400,
        basis: 'unbooked_credits',
        unbooked_unspent_credits: 2,
        expired_unspent_credits: 0,
        booked_ahead: { count: 0, dates: [] },
        per_credit_cents: 5700,
        method: 'card',
      });
      assert.deepEqual(proposal(await proposalOf(shanthi, s.chargeId)), {
        proposed_cents: 6000,
        basis: 'unbooked_credits',
        unbooked_unspent_credits: 1,
        expired_unspent_credits: 0,
        booked_ahead: { count: 0, dates: [] },
        per_credit_cents: 6000,
        method: 'card',
      });
    },
  );

  test(
    "RF1's booked days: P with three past days and Mon, Tue, Wed still booked on it → booked_ahead names the three, 2 unbooked, $114.00",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const p = await lotP();
      await book(dogId, p.lotId, P_PAST.slice(0, 3));
      await book(dogId, p.lotId, [MON, TUE, WED]);
      const got = proposal(await proposalOf(appOf(FIXTURE_MANAGER_PRINCIPAL, world()), p.chargeId));
      assert.deepEqual(got.booked_ahead, { count: 3, dates: [MON, TUE, WED] });
      assert.equal(got.unbooked_unspent_credits, 2);
      assert.equal(got.proposed_cents, 11400);
    },
  );

  test(
    'D7 case 2: lot E, expired Fri 16 Oct with 1 unspent → proposes $0.00, 1 unbooked, 1 expired, $57.00 a credit',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const e = await lotE(dogId);
      assert.deepEqual(
        proposal(await proposalOf(appOf(FIXTURE_MANAGER_PRINCIPAL, world()), e.chargeId)),
        {
          proposed_cents: 0,
          basis: 'unbooked_credits',
          unbooked_unspent_credits: 1,
          expired_unspent_credits: 1,
          booked_ahead: { count: 0, dates: [] },
          per_credit_cents: 5700,
          method: 'card',
        },
      );
    },
  );

  test(
    'never above the cap: after a $400.00 money-only refund on P with 2 unspent → $56.00, not $114.00',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      await db.insert(refunds).values({
        ownerId: OWNER,
        chargeId: p.chargeId,
        amountCents: 40000,
        status: 'succeeded',
        reason: 'planted: a $400.00 money-only refund',
      });
      const got = proposal(await proposalOf(appOf(FIXTURE_MANAGER_PRINCIPAL, world()), p.chargeId));
      assert.equal(got.proposed_cents, 5600);
      assert.equal(got.unbooked_unspent_credits, 2);
    },
  );

  test(
    '404 for an unknown id and for a charge that took no money; 422 invalid_payload on a group-class or board-train charge; a 45601-cent charge on an 8-credit lot → $57.00 a credit, rounded down',
    SKIP_WHEN_NO_DB,
    async () => {
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, world());
      codeOf(await proposalOf(amber, randomUUID()), 404, 'not_found');
      for (const status of ['requires_payment', 'failed'] as const) {
        codeOf(
          await proposalOf(
            amber,
            await plantCharge({ amountCents: 45600, purpose: 'package', status }),
          ),
          404,
          'not_found',
        );
      }
      for (const purpose of ['group-class', 'board-train'] as const) {
        codeOf(
          await proposalOf(amber, await plantCharge({ amountCents: 20000, purpose })),
          422,
          'invalid_payload',
        );
      }
      const odd = await plantPurchase({
        key: 'school-2x-weekly-bentonville',
        amountCents: 45601,
        credits: 8,
        boughtAt: at('2027-10-09', '20:28'),
        expiresAt: at('2027-11-09', '20:28'),
      });
      const got = proposal(await proposalOf(amber, odd.chargeId));
      assert.equal(got.per_credit_cents, 5700);
      assert.equal(got.proposed_cents, 8 * 5700);
      codeOf(await proposalOf(amber, 'not-a-uuid'), 400, 'bad_request');
    },
  );
});

// ── B-4: the refund and its credit removal ───────────────────────────────────

async function s17Journey(principal: Principal, staffId: string): Promise<void> {
  const dogId = await pepper();
  const p = await lotP();
  await book(dogId, p.lotId, P_PAST);
  const [mon, tue] = await book(dogId, p.lotId, [MON, TUE]);
  const s = await lotS();
  const [wed] = await book(dogId, s.lotId, [WED]);
  const vet = await plantCharge({ amountCents: 8500, purpose: 'board-train' });
  const w = world();
  w.stripe.setRefundReplyStatus('succeeded');
  const app = appOf(principal, w);
  const tomi = appOf(FIXTURE_OWNER_PRINCIPAL, w);

  for (const bookingId of [mon!, tue!, wed!]) {
    const res = await staffCancel(app, { bookingId });
    assert.equal(res.statusCode, 200, res.body);
  }
  assert.equal(await tomiBalance(tomi), 3, 'the cache is warm: 2 on P and 1 on S');
  const notices = await noticeCount();

  const pPlan = proposal(await proposalOf(app, p.chargeId));
  assert.equal(pPlan.proposed_cents, 11400);
  assert.equal(pPlan.unbooked_unspent_credits, 2);
  const pKey = `p22-s17-p-${randomUUID()}`;
  const pWire = created(
    await postRefund(
      app,
      {
        payment_id: p.chargeId,
        amount_cents: 11400,
        instrument: 'original_card',
        reason: REASON,
        credits_to_remove: 2,
      },
      pKey,
    ),
  );
  assert.equal(pWire.status, 'pending', 'the row as committed (D8)');
  assert.equal(await tomiBalance(tomi), 1, 'the warm read shows the 2 credits gone');

  const sPlan = proposal(await proposalOf(app, s.chargeId));
  assert.equal(sPlan.proposed_cents, 6000);
  assert.equal(sPlan.unbooked_unspent_credits, 1);
  const sKey = `p22-s17-s-${randomUUID()}`;
  const sWire = created(
    await postRefund(
      app,
      {
        payment_id: s.chargeId,
        amount_cents: 6000,
        instrument: 'original_card',
        reason: 'Pepper died; the single day',
        credits_to_remove: 1,
      },
      sKey,
    ),
  );
  assert.equal(sWire.status, 'pending');

  const name = await staffName(staffId);
  assert.deepEqual(pWire, {
    id: pWire.id,
    charge_id: p.chargeId,
    owner: { id: OWNER, name: await ownerName() },
    item: { purpose: 'package', package_label: 'Bentonville 2x Weekly' },
    amount_cents: 11400,
    instrument: 'original_card',
    status: 'pending',
    reason: REASON,
    issued_by: { staff_id: staffId, name },
    created_at: pWire.created_at,
  });
  assert.equal(sWire.item.package_label, 'Single Day School Day · Bentonville');

  const rows = await refundRows();
  assert.deepEqual(
    rows.map((r) => [
      r.chargeId,
      r.amountCents,
      r.status,
      r.issuedByStaffId,
      r.reason,
      r.instrument,
    ]),
    [
      [p.chargeId, 11400, 'succeeded', staffId, REASON, 'original_card'],
      [s.chargeId, 6000, 'succeeded', staffId, 'Pepper died; the single day', 'original_card'],
    ],
    "Stripe's succeeded reply marked both rows in the transaction after the call",
  );
  const ledger = await refundLedgerRows();
  assert.deepEqual(
    ledger.map((r) => [
      r.delta,
      r.reason,
      r.lotId,
      r.refundId,
      r.createdByStaffId,
      r.checkinEventId,
    ]),
    [
      [-2, 'adjustment', p.lotId, pWire.id, staffId, null],
      [-1, 'adjustment', s.lotId, sWire.id, staffId, null],
    ],
    'two removals, each naming its refund; brief_must_say 4: checkin_event_id NULL',
  );
  assert.equal(ledger[0]!.note, `refund ${pWire.id}: ${REASON}`);
  assert.equal(await unspent(p.lotId), 0);
  assert.equal(await unspent(s.lotId), 0);

  const history = await payments(appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w));
  const pPay = history.find((h) => h.payment_id === p.chargeId)!;
  const sPay = history.find((h) => h.payment_id === s.chargeId)!;
  assert.equal(pPay.status, 'succeeded');
  assert.equal(pPay.refundable_cents, 34200);
  assert.equal(sPay.status, 'refunded');
  assert.equal(sPay.refundable_cents, 0);
  const back = rows.reduce((sum, r) => sum + r.amountCents, 0);
  assert.equal(back, 17400, '$174.00 back in all');
  const [vetRow] = await db.select().from(charges).where(eq(charges.id, vet));
  assert.equal(vetRow!.status, 'succeeded', 'the $85.00 Vet bill stays paid');
  assert.equal((await refundRows(vet)).length, 0);

  assert.deepEqual(
    refundCalls(w.stripe).map((c) => c.idempotencyKey),
    [`${pKey}:refund`, `${sKey}:refund`],
  );
  assert.equal(await noticeCount(), notices, 'no refund sends the family a notice');
}

describe('B-4 the refund and its credit removal (PAY-U24, CRED-U18; D1, D3, D4, D8, D9, D11)', () => {
  test(
    "s17 as a journey, Shanthi: three cancels, then $114.00 with 2 removed from P and $60.00 with 1 from S → both succeed on Stripe's reply, two removals, $174.00 back, the Vet bill untouched, no notice, the warm credit read fresh",
    SKIP_WHEN_NO_DB,
    () => s17Journey(FIXTURE_OWNER_ROLE_PRINCIPAL, FIXTURE_IDS.staffShanthiId),
  );

  test("s17 as a journey, Amber (RF0: a manager's $114.00 refund succeeds)", SKIP_WHEN_NO_DB, () =>
    s17Journey(FIXTURE_MANAGER_PRINCIPAL, FIXTURE_IDS.staffAmberId),
  );

  test(
    'RF1: removes 2 credits and leaves the booked days standing: Mon, Tue and Wed stay upcoming with their debits on P, and Tomi lists all three',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const p = await lotP();
      await book(dogId, p.lotId, P_PAST.slice(0, 3));
      const ahead = await book(dogId, p.lotId, [MON, TUE, WED]);
      const w = world();
      created(
        await postRefund(appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w), {
          payment_id: p.chargeId,
          amount_cents: 11400,
          instrument: 'original_card',
          reason: REASON,
          credits_to_remove: 2,
        }),
      );
      assert.equal(await unspent(p.lotId), 0);
      const standing = await db
        .select({ id: bookings.id, status: bookings.status })
        .from(bookings)
        .where(inArray(bookings.id, ahead));
      assert.deepEqual(
        standing.map((b) => b.status),
        ['upcoming', 'upcoming', 'upcoming'],
      );
      const debits = await db
        .select({ bookingId: creditLedger.bookingId })
        .from(creditLedger)
        .where(and(inArray(creditLedger.bookingId, ahead), eq(creditLedger.lotId, p.lotId)));
      assert.equal(debits.length, 3, 'their debits stay on P');
      const list = await appOf(FIXTURE_OWNER_PRINCIPAL, w).inject({
        method: 'GET',
        url: '/bookings?view=upcoming',
      });
      assert.equal(list.statusCode, 200, list.body);
      const listed = (JSON.parse(list.body) as { id: string }[]).map((b) => b.id);
      for (const id of ahead) assert.ok(listed.includes(id), `Tomi still lists ${id}`);
    },
  );

  test(
    'RF1: two $456.00 mints with no webhook between → the second is 422 over_cap; one row, one Stripe call',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const w = world();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const whole = {
        payment_id: p.chargeId,
        amount_cents: 45600,
        instrument: 'original_card',
        reason: 'the whole pack',
      };
      const first = created(await postRefund(shanthi, { ...whole, credits_to_remove: 8 }));
      assert.equal(first.status, 'pending');
      w.clock.set(at('2027-10-23', '09:01'));
      codeOf(await postRefund(shanthi, whole), 422, 'over_cap');
      assert.equal((await refundRows()).length, 1);
      assert.equal(refundCalls(w.stripe).length, 1);
    },
  );

  test(
    'a same-key replay → the stored 201 bytes, one row, one Stripe call',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const w = world();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const body = {
        payment_id: p.chargeId,
        amount_cents: 11400,
        instrument: 'original_card',
        reason: REASON,
        credits_to_remove: 2,
      };
      const key = `p22-replay-${randomUUID()}`;
      const first = await postRefund(shanthi, body, key);
      created(first);
      const again = await postRefund(shanthi, body, key);
      assert.equal(again.statusCode, 201);
      assert.deepEqual(JSON.parse(again.body), JSON.parse(first.body));
      assert.equal((await refundRows()).length, 1);
      assert.equal(refundCalls(w.stripe).length, 1);
      assert.equal((await refundLedgerRows()).length, 1);
    },
  );

  test(
    'the refusals write nothing and call no Stripe: lot_insufficient, instrument_unavailable, invalid_payload; 0 writes no ledger row; omitted on lot E removes its expired 1; malformed bodies are 400',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      const classCharge = await plantCharge({ amountCents: 20000, purpose: 'group-class' });
      const w = world();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const base = {
        payment_id: p.chargeId,
        amount_cents: 11400,
        instrument: 'original_card',
        reason: REASON,
      };

      codeOf(await postRefund(shanthi, { ...base, credits_to_remove: 3 }), 422, 'lot_insufficient');
      codeOf(
        await postRefund(shanthi, {
          ...base,
          payment_id: classCharge,
          amount_cents: 1000,
          credits_to_remove: 1,
        }),
        422,
        'lot_insufficient',
      );
      for (const instrument of ['cash', 'check']) {
        codeOf(await postRefund(shanthi, { ...base, instrument }), 422, 'instrument_unavailable');
      }
      codeOf(
        await postRefund(shanthi, { ...base, enrollment_id: randomUUID() }),
        422,
        'invalid_payload',
      );
      assert.equal((await refundRows()).length, 0);
      assert.equal(refundCalls(w.stripe).length, 0);
      assert.equal((await refundLedgerRows()).length, 0);

      for (const bad of [
        { ...base, reason: '' },
        { ...base, reason: 'x'.repeat(501) },
        { ...base, amount_cents: 0 },
        { ...base, instrument: 'account_credit' },
        { ...base, surprise: true },
      ]) {
        codeOf(await postRefund(shanthi, bad), 400, 'bad_request');
      }

      created(await postRefund(shanthi, { ...base, amount_cents: 1000, credits_to_remove: 0 }));
      assert.equal(
        (await refundLedgerRows()).length,
        0,
        'credits_to_remove 0 writes no ledger row',
      );
      assert.equal(await unspent(p.lotId), 2);

      const e = await lotE(dogId);
      const eWire = created(
        await postRefund(shanthi, {
          payment_id: e.chargeId,
          amount_cents: 100,
          instrument: 'original_card',
          reason: 'the dead lot',
        }),
      );
      const eRows = (await refundLedgerRows()).filter((r) => r.refundId === eWire.id);
      assert.deepEqual(
        eRows.map((r) => [r.delta, r.lotId]),
        [[-1, e.lotId]],
        'omitted, the count is the lot’s unbooked, unspent credits, expired included (D9)',
      );
      assert.equal(await unspent(e.lotId), 0);
    },
  );

  test(
    'a charge with no PaymentIntent (planted by SQL) → 201 unroutable, no Stripe call, one level-50 line through the route',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP(null);
      const w = world();
      const capture = makeLogCapture();
      const wire = created(
        await postRefund(appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w, capture), {
          payment_id: p.chargeId,
          amount_cents: 11400,
          instrument: 'original_card',
          reason: REASON,
          credits_to_remove: 2,
        }),
      );
      assert.equal(wire.status, 'unroutable');
      assert.equal(refundCalls(w.stripe).length, 0);
      const alarms = capture.lines.filter((l) => l.level === 50);
      assert.equal(alarms.length, 1, JSON.stringify(alarms));
      assert.match(String(alarms[0]!.msg), /no Stripe route/);
      assert.match(String(alarms[0]!.msg), /Returned/);
      const [row] = await refundRows();
      assert.equal(row!.status, 'unroutable');
      assert.equal(row!.issuedByStaffId, FIXTURE_IDS.staffShanthiId);
      assert.equal(row!.stripeIdempotencyKey, null);
      assert.equal(await unspent(p.lotId), 6);
    },
  );

  test(
    'brief_must_say 4, a pin: a removal planted by SQL with a check-in event id is refused 23514 (credit_ledger_checkin_event_check)',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const [refund] = await db
        .insert(refunds)
        .values({ ownerId: OWNER, chargeId: p.chargeId, amountCents: 100, status: 'pending' })
        .returning({ id: refunds.id });
      await assert.rejects(
        db.execute(sql`
          INSERT INTO credit_ledger (owner_id, location, mode, tier, delta, reason, lot_id, note,
                                     refund_id, checkin_event_id)
          VALUES (${OWNER}, 'bentonville', 'school', 'regular', -1, 'adjustment', ${p.lotId},
                  'planted', ${refund!.id}, ${randomUUID()})`),
        (err: unknown) => {
          const cause = (err as { cause?: { code?: string; constraint?: string } }).cause ?? err;
          const { code, constraint } = cause as { code?: string; constraint?: string };
          assert.equal(code, '23514');
          assert.equal(constraint, 'credit_ledger_checkin_event_check');
          return true;
        },
      );
    },
  );

  test(
    'the mint and its removal are one transaction: a fault injected at the removal leaves no refunds row and calls no Stripe',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const w = world();
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION p22_fault_at_removal() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.refund_id IS NOT NULL THEN RAISE EXCEPTION 'p22 fault injected at the removal'; END IF;
          RETURN NEW;
        END $$`);
      await db.execute(sql`
        CREATE TRIGGER p22_fault_at_removal BEFORE INSERT ON credit_ledger
        FOR EACH ROW EXECUTE FUNCTION p22_fault_at_removal()`);
      try {
        const res = await postRefund(appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w), {
          payment_id: p.chargeId,
          amount_cents: 11400,
          instrument: 'original_card',
          reason: REASON,
          credits_to_remove: 2,
        });
        assert.equal(res.statusCode, 500, res.body);
      } finally {
        await db.execute(sql`DROP TRIGGER p22_fault_at_removal ON credit_ledger`);
        await db.execute(sql`DROP FUNCTION p22_fault_at_removal()`);
      }
      assert.equal((await refundRows()).length, 0, 'no refund without its removal');
      assert.equal(refundCalls(w.stripe).length, 0);
      assert.equal(await unspent(p.lotId), 8);
    },
  );
});

// ── B-10: the small wire sites ───────────────────────────────────────────────

/** A charge with one refund row planted in the given status and outcome. */
async function plantRefund(args: {
  chargeId: string;
  amountCents: number;
  status: 'pending' | 'succeeded' | 'failed' | 'unroutable' | 'resolved-external';
  outcome?: 'returned' | 'withdrawn' | null;
  retryOf?: string;
  ownerId?: string;
  reason?: string;
  stripeRefundId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(refunds)
    .values({
      ownerId: args.ownerId ?? OWNER,
      chargeId: args.chargeId,
      amountCents: args.amountCents,
      status: args.status,
      reason: args.reason ?? 'planted',
      ...(args.outcome != null ? { resolvedOutcome: args.outcome } : {}),
      ...(args.retryOf !== undefined ? { retryOfRefundId: args.retryOf } : {}),
      ...(args.stripeRefundId !== undefined ? { stripeRefundId: args.stripeRefundId } : {}),
    })
    .returning({ id: refunds.id });
  return row!.id;
}

async function plantSecondOwner(): Promise<string> {
  const id = randomUUID();
  plantedOwners.push(id);
  await db.insert(owners).values({
    id,
    supabaseUid: randomUUID(),
    name: 'Second Household',
    email: `p22-${id.slice(0, 8)}@example.com`,
  });
  return id;
}

async function capsAgree(chargeId: string): Promise<{ sql: number; repository: number }> {
  const caps = await staffBillingRepository.capsForCharges([chargeId]);
  const [charge] = await db.select().from(charges).where(eq(charges.id, chargeId));
  const repository = await db.transaction((tx) =>
    refundsRepository.capRemainingForCharge(tx, { id: chargeId, amountCents: charge!.amountCents }),
  );
  return { sql: caps.get(chargeId)!.refundableCents, repository };
}

function removeCredit(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/staff/owners/${OWNER}/credit-adjustments`,
    headers: { 'idempotency-key': `p22-remove-${randomUUID()}` },
    payload: { kind: 'remove', ...body },
  });
}

describe('B-10 the small wire sites (Part 3; D5, D16)', () => {
  test(
    "refund_id on the remove arm: Mon 1 Nov Amber removes 1 credit from P naming Sat 30 Oct's dashboard refund → the row carries it; another owner's refund, or none, → 404 and nothing written",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      const dashboard = await plantRefund({
        chargeId: p.chargeId,
        amountCents: 5700,
        status: 'succeeded',
        reason: 'out-of-band',
        stripeRefundId: `re_test_p22_dash_${randomUUID()}`,
      });
      const w = world();
      w.clock.set(at('2027-11-01', '10:00'));
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);

      const second = await plantSecondOwner();
      const theirCharge = await plantCharge({ amountCents: 6000, purpose: 'board-train' });
      await db.update(charges).set({ ownerId: second }).where(eq(charges.id, theirCharge));
      plantedForeignCharges.push(theirCharge);
      const theirs = await plantRefund({
        chargeId: theirCharge,
        ownerId: second,
        amountCents: 1000,
        status: 'succeeded',
      });
      for (const refundId of [theirs, randomUUID()]) {
        codeOf(
          await removeCredit(amber, {
            lot_id: p.lotId,
            credits: 1,
            note: 'not ours',
            refund_id: refundId,
          }),
          404,
          'not_found',
        );
      }
      assert.equal(await unspent(p.lotId), 2, 'nothing written');
      codeOf(
        await removeCredit(amber, { lot_id: p.lotId, credits: 1, note: 'bad', refund_id: 'nope' }),
        400,
        'bad_request',
      );

      const res = await removeCredit(amber, {
        lot_id: p.lotId,
        credits: 1,
        note: 'answers the dashboard refund',
        refund_id: dashboard.toUpperCase(),
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.deepEqual(
        (await refundLedgerRows()).map((r) => [
          r.delta,
          r.lotId,
          r.refundId,
          r.createdByStaffId,
          r.reason,
        ]),
        [[-1, p.lotId, dashboard, FIXTURE_IDS.staffAmberId, 'adjustment']],
      );
      assert.equal(await unspent(p.lotId), 1);
    },
  );

  test(
    "retry_of_refund_id on the history (D16): D2's chain O → R1 → R2 read through GET /staff/owners/:id/payments → R1 names O, R2 names R1, O names none",
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const o = await plantRefund({ chargeId: p.chargeId, amountCents: 11400, status: 'failed' });
      const r1 = await plantRefund({
        chargeId: p.chargeId,
        amountCents: 11400,
        status: 'failed',
        retryOf: o,
      });
      const r2 = await plantRefund({
        chargeId: p.chargeId,
        amountCents: 11400,
        status: 'succeeded',
        retryOf: r1,
      });
      const history = await payments(appOf(FIXTURE_MANAGER_PRINCIPAL, world()));
      const chain = history.find((h) => h.payment_id === p.chargeId)!.refunds;
      const byId = new Map(chain.map((r) => [r.id, r]));
      assert.equal('retry_of_refund_id' in byId.get(o)!, false, 'O retries none');
      assert.equal(byId.get(r1)!.retry_of_refund_id, o);
      assert.equal(byId.get(r2)!.retry_of_refund_id, r1);
      assert.equal(history.find((h) => h.payment_id === p.chargeId)!.refundable_cents, 34200);
    },
  );

  test(
    "stripe_payment_intent_id: present on Amber's read of P's payment, absent on a charge with none, and never in a trainer's invoices read",
    SKIP_WHEN_NO_DB,
    async () => {
      const pi = `pi_test_p22_${randomUUID()}`;
      const p = await lotP(pi);
      const none = await lotS();
      await db
        .update(charges)
        .set({ stripePaymentIntentId: null })
        .where(eq(charges.id, none.chargeId));
      const paid = await db.transaction((tx) =>
        invoicesRepository.createOpen(tx, {
          ownerId: OWNER,
          amountCents: 45600,
          purpose: 'package',
          paymentMethodId: FIXTURE_IDS.paymentMethod1Id,
          dueAt: '2027-10-09T00:00:00Z',
        }),
      );
      plantedInvoices.push(paid.id);
      await db.transaction((tx) =>
        invoicesRepository.markPaid(tx, { id: paid.id, paidChargeId: p.chargeId }),
      );

      const history = await payments(appOf(FIXTURE_MANAGER_PRINCIPAL, world()));
      assert.equal(history.find((h) => h.payment_id === p.chargeId)!.stripe_payment_intent_id, pi);
      assert.equal(
        'stripe_payment_intent_id' in history.find((h) => h.payment_id === none.chargeId)!,
        false,
      );

      const invoicesRead = await appOf(FIXTURE_STAFF_PRINCIPAL, world()).inject({
        method: 'GET',
        url: `/staff/owners/${OWNER}/invoices`,
      });
      assert.equal(invoicesRead.statusCode, 200, invoicesRead.body);
      assert.ok(invoicesRead.body.includes(paid.id), 'the trainer reads the invoice');
      assert.ok(!invoicesRead.body.includes('stripe_payment_intent_id'));
      assert.ok(!invoicesRead.body.includes(pi));
    },
  );

  test(
    'withdrawn leaves every sum: one table over every status and outcome, the SQL cap (REFUNDABLE_CENTS) equal to the repository’s, a resolved row with no outcome still counting (D5)',
    SKIP_WHEN_NO_DB,
    async () => {
      const cases = [
        ['pending', null, 7000],
        ['succeeded', null, 7000],
        ['failed', null, 10000],
        ['unroutable', null, 7000],
        ['resolved-external', 'returned', 7000],
        ['resolved-external', 'withdrawn', 10000],
        ['resolved-external', null, 7000],
      ] as const;
      const seen: [string, string | null, number, number][] = [];
      for (const [status, outcome, cap] of cases) {
        const chargeId = await plantCharge({ amountCents: 10000, purpose: 'board-train' });
        await plantRefund({ chargeId, amountCents: 3000, status, outcome });
        const got = await capsAgree(chargeId);
        seen.push([status, outcome, got.sql, got.repository]);
        void cap;
      }
      assert.deepEqual(
        seen,
        cases.map(([status, outcome, cap]) => [status, outcome, cap, cap]),
      );

      // All seven on one charge: the cap, the returned coverage and the rows behind it.
      const mixed = await plantCharge({ amountCents: 20000, purpose: 'board-train' });
      const ids = new Map<string, string>();
      for (const [i, [status, outcome]] of cases.entries()) {
        ids.set(
          `${status}/${outcome}`,
          await plantRefund({ chargeId: mixed, amountCents: 100 * 2 ** i, status, outcome }),
        );
      }
      // Counting: pending 100, succeeded 200, unroutable 800, returned 1600, no outcome 6400.
      assert.deepEqual(await capsAgree(mixed), { sql: 20000 - 9100, repository: 20000 - 9100 });
      const coverage = await db.transaction((tx) =>
        refundsRepository.sumReturnedCoverageForCharge(tx, mixed),
      );
      assert.equal(
        coverage,
        200 + 1600 + 6400,
        'returned coverage: succeeded, returned and the no-outcome row',
      );
      const rows = await db.transaction((tx) =>
        refundsRepository.findReturnedRowsForCharge(tx, mixed),
      );
      assert.deepEqual(
        rows.map((r) => r.id).sort(),
        [
          ids.get('succeeded/null'),
          ids.get('resolved-external/returned'),
          ids.get('resolved-external/null'),
        ].sort(),
      );
    },
  );

  test(
    '§2.10 card half, a pin: after a $40.00 refund on a $60.00 charge refundable_cents is 2000, and after a failed refund it is unchanged',
    SKIP_WHEN_NO_DB,
    async () => {
      const chargeId = await plantCharge({ amountCents: 6000, purpose: 'board-train' });
      await plantRefund({ chargeId, amountCents: 4000, status: 'succeeded' });
      assert.deepEqual(await capsAgree(chargeId), { sql: 2000, repository: 2000 });
      await plantRefund({ chargeId, amountCents: 2000, status: 'failed' });
      assert.deepEqual(await capsAgree(chargeId), { sql: 2000, repository: 2000 });
    },
  );

  test(
    'after a refund closed withdrawn the cap is back, and a fresh $60.00 refund of that payment is accepted',
    SKIP_WHEN_NO_DB,
    async () => {
      const chargeId = await plantCharge({ amountCents: 6000, purpose: 'board-train' });
      await plantRefund({
        chargeId,
        amountCents: 4000,
        status: 'resolved-external',
        outcome: 'withdrawn',
      });
      assert.deepEqual(await capsAgree(chargeId), { sql: 6000, repository: 6000 });
      const res = await postRefund(appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, world()), {
        payment_id: chargeId,
        amount_cents: 6000,
        instrument: 'original_card',
        reason: 'the family asked after all',
      });
      assert.equal(created(res).amount_cents, 6000);
    },
  );
});

// ── B-5: Retry to card and Returned ──────────────────────────────────────────

function retry(app: FastifyInstance, refundId: string, key?: string) {
  return app.inject({
    method: 'POST',
    url: `/staff/refunds/${refundId}/retry`,
    headers: { 'idempotency-key': key ?? `p22-retry-${randomUUID()}` },
  });
}

function resolveExternal(
  app: FastifyInstance,
  refundId: string,
  body: Record<string, unknown>,
  key?: string,
) {
  return app.inject({
    method: 'POST',
    url: `/staff/refunds/${refundId}/resolve-external`,
    headers: { 'idempotency-key': key ?? `p22-resolve-${randomUUID()}` },
    payload: body,
  });
}

function closed(res: { statusCode: number; body: string }): RefundWire {
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as RefundWire;
}

/** Stripe's answer, planted: the refund events that carry it are go 2's (B-6). */
async function stripeSays(refundId: string, status: 'failed' | 'succeeded'): Promise<void> {
  await db.update(refunds).set({ status }).where(eq(refunds.id, refundId));
}

async function rowOf(refundId: string) {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId));
  return row!;
}

async function coverage(chargeId: string): Promise<number> {
  return db.transaction((tx) => refundsRepository.sumReturnedCoverageForCharge(tx, chargeId));
}

async function refundablePlease(app: FastifyInstance, chargeId: string): Promise<number> {
  return (await payments(app)).find((h) => h.payment_id === chargeId)!.refundable_cents;
}

const mintBody = (paymentId: string, amountCents: number, credits: number, reason = REASON) => ({
  payment_id: paymentId,
  amount_cents: amountCents,
  instrument: 'original_card',
  reason,
  credits_to_remove: credits,
});

/** A charge with one failed card refund on it, planted, for the races. */
async function plantFailedHead(): Promise<{ chargeId: string; headId: string }> {
  const chargeId = await plantCharge({ amountCents: 10000, purpose: 'board-train' });
  const headId = await plantRefund({ chargeId, amountCents: 4000, status: 'failed' });
  return { chargeId, headId };
}

const jitter = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 7)));

describe('B-5 Retry to card and Returned (PAY-U27; D2, D5, D10; question 41 (a); amendments A1, A2)', () => {
  test(
    "the design's worked example: $456.00 with 8 removed fails; Amber's Returned withdrawn puts the 8 back on P with P's date; the charge stays succeeded with $456.00 refundable; a later Retry is 409 conflict; Sat's $114.00 mints",
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const w = world();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      w.clock.set(at('2027-10-10', '10:00'));
      const o = created(
        await postRefund(
          shanthi,
          mintBody(p.chargeId, 45600, 8, 'Tomi asked before booking anything'),
        ),
      );
      assert.equal(await unspent(p.lotId), 0);
      await stripeSays(o.id, 'failed');
      const notices = await noticeCount();

      w.clock.set(at('2027-10-13', '12:00'));
      const wire = closed(
        await resolveExternal(amber, o.id, { note: 'keep the credits then', outcome: 'withdrawn' }),
      );
      assert.equal(wire.status, 'resolved-external');
      assert.equal(wire.resolved_outcome, 'withdrawn');
      assert.deepEqual(wire.resolved_by, {
        staff_id: FIXTURE_IDS.staffAmberId,
        name: await staffName(FIXTURE_IDS.staffAmberId),
      });
      assert.equal(wire.resolution_note, 'keep the credits then');
      assert.equal('returned_instrument' in wire, false);
      assert.equal(await unspent(p.lotId), 8, 'P holds 8 again');
      const rows = await refundLedgerRows();
      assert.deepEqual(
        rows.map((r) => [r.delta, r.lotId, r.refundId, r.createdByStaffId, r.expiresAt]),
        [
          [-8, p.lotId, o.id, FIXTURE_IDS.staffShanthiId, null],
          [8, p.lotId, o.id, FIXTURE_IDS.staffAmberId, null],
        ],
        'one put-back on P, carrying P’s date (a row on a lot has none of its own)',
      );
      assert.equal(rows[1]!.note, `refund ${o.id} withdrawn: keep the credits then`);
      const [charge] = await db.select().from(charges).where(eq(charges.id, p.chargeId));
      assert.equal(charge!.status, 'succeeded');
      assert.equal(await refundablePlease(amber, p.chargeId), 45600, 'the cap reopened');
      assert.equal(await coverage(p.chargeId), 0);

      codeOf(await retry(amber, o.id), 409, 'conflict');
      w.clock.set(at('2027-10-23', '09:00'));
      created(await postRefund(shanthi, mintBody(p.chargeId, 11400, 2)));
      assert.equal(await noticeCount(), notices, 'no notice from a retry or a close');
    },
  );

  test(
    'fail, Retry fails, withdrawn on the Retry → the 2 credits back exactly once, coverage 0; a Retry writes no credit_ledger row; then withdrawn on the original is 409 refund_superseded, and a second withdrawn on the Retry 409 conflict',
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      const w = world();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      const o = created(await postRefund(shanthi, mintBody(p.chargeId, 11400, 2)));
      assert.equal(await unspent(p.lotId), 0);
      await stripeSays(o.id, 'failed');
      const ledgerBefore = await refundLedgerRows();
      const notices = await noticeCount();

      const r1 = created(await retry(amber, o.id));
      assert.equal(r1.retry_of_refund_id, o.id);
      assert.equal(r1.amount_cents, 11400);
      assert.equal(r1.instrument, 'original_card');
      assert.equal(r1.reason, REASON, 'the reason is copied from the row it retries');
      assert.deepEqual(r1.issued_by?.staff_id, FIXTURE_IDS.staffAmberId);
      assert.deepEqual(
        await refundLedgerRows(),
        ledgerBefore,
        'a Retry writes no credit_ledger row',
      );
      assert.equal(await unspent(p.lotId), 0);

      await stripeSays(r1.id, 'failed');
      closed(
        await resolveExternal(amber, r1.id, { note: 'they keep the pack', outcome: 'withdrawn' }),
      );
      assert.equal(await unspent(p.lotId), 2, 'the 2 credits back');
      assert.equal(await coverage(p.chargeId), 0);
      codeOf(
        await resolveExternal(amber, o.id, { note: 'again', outcome: 'withdrawn' }),
        409,
        'refund_superseded',
      );
      assert.equal(await unspent(p.lotId), 2);
      codeOf(
        await resolveExternal(amber, r1.id, { note: 'again', outcome: 'withdrawn' }),
        409,
        'conflict',
      );
      assert.equal(await unspent(p.lotId), 2, 'exactly once');
      assert.equal((await refundLedgerRows()).length, 2);
      assert.equal(await noticeCount(), notices, 'a retry and a close send the family nothing');
    },
  );

  test(
    'Returned: no instrument on a failed card row → 400; instrument with withdrawn → 400; a blank note → 400; with cash → returned_instrument cash, instrument still original_card, the charge refunded once returned money covers it; a second close → 409 conflict',
    SKIP_WHEN_NO_DB,
    async () => {
      const s = await lotS();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, world());
      const o = created(await postRefund(shanthi, mintBody(s.chargeId, 6000, 1)));
      await stripeSays(o.id, 'failed');
      codeOf(
        await resolveExternal(shanthi, o.id, { note: 'cash at the desk' }),
        400,
        'bad_request',
      );
      codeOf(
        await resolveExternal(shanthi, o.id, {
          note: 'kept',
          outcome: 'withdrawn',
          instrument: 'cash',
        }),
        400,
        'bad_request',
      );
      for (const note of ['', '   ', 'x'.repeat(501)]) {
        codeOf(
          await resolveExternal(shanthi, o.id, { note, instrument: 'cash' }),
          400,
          'bad_request',
        );
      }
      assert.equal((await rowOf(o.id)).status, 'failed', 'the 400s wrote nothing');
      const wire = closed(
        await resolveExternal(shanthi, o.id, { note: 'cash at the desk', instrument: 'cash' }),
      );
      assert.equal(wire.returned_instrument, 'cash');
      assert.equal(wire.instrument, 'original_card');
      assert.equal(wire.resolved_outcome, 'returned');
      const [charge] = await db.select().from(charges).where(eq(charges.id, s.chargeId));
      assert.equal(charge!.status, 'refunded');
      assert.equal(await unspent(s.lotId), 0, 'a returned close puts nothing back');
      codeOf(
        await resolveExternal(shanthi, o.id, { note: 'again', instrument: 'cash' }),
        409,
        'conflict',
      );
    },
  );

  test(
    'over_cap on Retry and on returned when the payment owes less than the row (a dashboard refund adopted, planted); refund_in_flight on both verbs while another refund on the payment is pending',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, world());
      const o = created(await postRefund(shanthi, mintBody(p.chargeId, 11400, 0)));
      await stripeSays(o.id, 'failed');
      await plantRefund({
        chargeId: p.chargeId,
        amountCents: 45000,
        status: 'succeeded',
        reason: 'out-of-band',
        stripeRefundId: `re_test_p22_dash_${randomUUID()}`,
      });
      codeOf(
        await resolveExternal(shanthi, o.id, { note: 'check', instrument: 'check' }),
        422,
        'over_cap',
      );
      codeOf(await retry(shanthi, o.id), 422, 'over_cap');
      assert.equal((await refundRows(p.chargeId)).length, 2, 'nothing new');

      const q = await lotP();
      const o2 = created(await postRefund(shanthi, mintBody(q.chargeId, 11400, 0)));
      await stripeSays(o2.id, 'failed');
      created(await postRefund(shanthi, mintBody(q.chargeId, 5700, 0, 'another, still pending')));
      codeOf(await retry(shanthi, o2.id), 409, 'refund_in_flight');
      codeOf(
        await resolveExternal(shanthi, o2.id, { note: 'check', instrument: 'check' }),
        409,
        'refund_in_flight',
      );
      codeOf(
        await resolveExternal(shanthi, o2.id, { note: 'kept', outcome: 'withdrawn' }),
        409,
        'refund_in_flight',
      );
    },
  );

  test(
    "D2's example: O fails, Amber retries to R1, R1 fails; Shanthi's retry and close of O are 409 refund_superseded; her retry of R1 → R2 succeeds; Amber's later retry of R1 is 409 refund_superseded; Tomi gets $114.00 once",
    SKIP_WHEN_NO_DB,
    async () => {
      const dogId = await pepper();
      const { p } = await s17AfterCancels(dogId);
      const w = world();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      w.clock.set(at('2027-10-23', '09:05'));
      const o = created(await postRefund(shanthi, mintBody(p.chargeId, 11400, 2)));
      await stripeSays(o.id, 'failed');
      w.clock.set(at('2027-10-27', '10:00'));
      const r1 = created(await retry(amber, o.id));
      await stripeSays(r1.id, 'failed');
      w.clock.set(at('2027-10-29', '09:00'));
      codeOf(await retry(shanthi, o.id), 409, 'refund_superseded');
      codeOf(
        await resolveExternal(shanthi, o.id, { note: 'check', instrument: 'check' }),
        409,
        'refund_superseded',
      );
      w.stripe.setRefundReplyStatus('succeeded');
      const r2 = created(await retry(shanthi, r1.id));
      assert.equal(r2.retry_of_refund_id, r1.id);
      assert.equal((await rowOf(r2.id)).status, 'succeeded', '09:03: R2 succeeds');
      w.clock.set(at('2027-10-29', '09:10'));
      codeOf(await retry(amber, r1.id), 409, 'refund_superseded');
      const rows = await refundRows(p.chargeId);
      assert.equal(
        rows.filter((r) => r.status === 'succeeded').reduce((sum, r) => sum + r.amountCents, 0),
        11400,
      );
      assert.equal(rows.length, 3);
      assert.equal(await refundablePlease(amber, p.chargeId), 34200);
      const chain = (await payments(amber)).find((h) => h.payment_id === p.chargeId)!.refunds;
      assert.deepEqual(
        chain.map((r) => [r.id, r.retry_of_refund_id ?? null]),
        [
          [o.id, null],
          [r1.id, o.id],
          [r2.id, r1.id],
        ],
      );
    },
  );

  for (const timing of ['natural', 'jitter'] as const) {
    for (const order of ['amber first', 'shanthi first'] as const) {
      test(
        `two staff retrying one failed head at once (${timing}, ${order}, 40 rounds) → one 201, one 409 refund_superseded, one new row`,
        SKIP_WHEN_NO_DB,
        async () => {
          const w = world();
          const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
          const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
          const [first, second] = order === 'amber first' ? [amber, shanthi] : [shanthi, amber];
          for (let round = 0; round < 40; round += 1) {
            const { chargeId, headId } = await plantFailedHead();
            const a = retry(first, headId);
            if (timing === 'jitter') await jitter();
            const b = retry(second, headId);
            const codes = (await Promise.all([a, b])).map((res) =>
              res.statusCode === 201
                ? '201'
                : `${res.statusCode} ${(JSON.parse(res.body) as ApiErrorEnvelope).error.code}`,
            );
            assert.deepEqual([...codes].sort(), ['201', '409 refund_superseded'], `round ${round}`);
            assert.equal((await refundRows(chargeId)).length, 2, `round ${round}: one new row`);
          }
        },
      );
    }
  }

  for (const timing of ['natural', 'jitter'] as const) {
    for (const order of ['retry first', 'resolve first'] as const) {
      test(
        `a retry racing a resolve-external on one failed head (${timing}, ${order}, 40 rounds; Fable M5) → one 2xx and one 409, never both 2xx`,
        SKIP_WHEN_NO_DB,
        async () => {
          const w = world();
          const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
          const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
          const wins = { retry: 0, resolve: 0 };
          for (let round = 0; round < 40; round += 1) {
            const { chargeId, headId } = await plantFailedHead();
            const fire = {
              retry: () => retry(amber, headId),
              resolve: () =>
                resolveExternal(shanthi, headId, { note: 'check #1042', instrument: 'check' }),
            };
            const [one, two] =
              order === 'retry first'
                ? (['retry', 'resolve'] as const)
                : (['resolve', 'retry'] as const);
            const p1 = fire[one]();
            if (timing === 'jitter') await jitter();
            const p2 = fire[two]();
            const [r1, r2] = await Promise.all([p1, p2]);
            const got: Record<'retry' | 'resolve', { statusCode: number; body: string }> =
              one === 'retry' ? { retry: r1, resolve: r2 } : { retry: r2, resolve: r1 };
            const rows = await refundRows(chargeId);
            const head = rows.find((r) => r.id === headId)!;
            if (got.retry.statusCode === 201) {
              codeOf(got.resolve, 409, 'refund_superseded');
              assert.equal(rows.length, 2, `round ${round}`);
              assert.equal(head.status, 'failed', `round ${round}`);
              wins.retry += 1;
            } else {
              assert.equal(got.resolve.statusCode, 200, `round ${round}: ${got.resolve.body}`);
              codeOf(got.retry, 409, 'conflict');
              assert.equal(rows.length, 1, `round ${round}`);
              assert.equal(head.status, 'resolved-external', `round ${round}`);
              wins.resolve += 1;
            }
          }
          assert.equal(wins.retry + wins.resolve, 40);
          process.stdout.write(
            `# race ${timing} ${order}: retry won ${wins.retry}, resolve won ${wins.resolve}\n`,
          );
        },
      );
    }
  }

  test(
    "the put-back by arithmetic (Fable M3, A2): O removes 2 from P; Amber's hand removals name O, 1 more from P and 1 from a lot in another pool; O fails; withdrawn → one put-back per lot, +3 on P and +1 on the other, each naming O; the warm credit read shows them; a second withdrawn → 409 conflict and no row",
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const care = await plantLot({
        credits: 3,
        expiresAt: at('2027-11-09', '20:28'),
        mode: 'daycare',
      });
      const w = world();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      const tomi = appOf(FIXTURE_OWNER_PRINCIPAL, w);
      const o = created(await postRefund(shanthi, mintBody(p.chargeId, 11400, 2)));
      w.clock.set(at('2027-11-01', '10:00'));
      for (const lotId of [p.lotId, care]) {
        const res = await removeCredit(amber, {
          lot_id: lotId,
          credits: 1,
          note: 'answers the refund',
          refund_id: o.id,
        });
        assert.equal(res.statusCode, 201, res.body);
      }
      assert.equal(await unspent(p.lotId), 5);
      assert.equal(await unspent(care), 2);
      await stripeSays(o.id, 'failed');
      assert.equal(await tomiBalance(tomi), 5, 'the cache is warm');

      closed(
        await resolveExternal(amber, o.id, { note: 'they keep it all', outcome: 'withdrawn' }),
      );
      const backs = (await refundLedgerRows()).filter((r) => r.delta > 0);
      assert.deepEqual(
        backs.map((r) => [r.lotId, r.delta, r.refundId, r.createdByStaffId]).sort(),
        [
          [p.lotId, 3, o.id, FIXTURE_IDS.staffAmberId],
          [care, 1, o.id, FIXTURE_IDS.staffAmberId],
        ].sort(),
      );
      assert.equal(await unspent(p.lotId), 8);
      assert.equal(await unspent(care), 3);
      const { rows } = await db.execute(sql`
        SELECT COALESCE(SUM(delta), 0)::int AS n FROM credit_ledger WHERE lot_id = ${p.lotId} AND refund_id = ${o.id}`);
      assert.equal((rows[0] as { n: number }).n, 0, "the sum of P's rows naming O is 0");
      assert.equal(await tomiBalance(tomi), 8, 'the warm read shows the 3 back');

      const count = (await refundLedgerRows()).length;
      codeOf(
        await resolveExternal(amber, o.id, { note: 'again', outcome: 'withdrawn' }),
        409,
        'conflict',
      );
      assert.equal((await refundLedgerRows()).length, count, 'no row');
    },
  );

  test(
    'A2: a hand removal naming R1, a retry link, comes back on withdrawn of R1, with the first refund’s removal, in one put-back naming O',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const w = world();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      const o = created(await postRefund(shanthi, mintBody(p.chargeId, 11400, 2)));
      await stripeSays(o.id, 'failed');
      const r1 = created(await retry(amber, o.id));
      const res = await removeCredit(amber, {
        lot_id: p.lotId,
        credits: 1,
        note: 'answers the retry',
        refund_id: r1.id,
      });
      assert.equal(res.statusCode, 201, res.body);
      await stripeSays(r1.id, 'failed');
      closed(await resolveExternal(amber, r1.id, { note: 'kept after all', outcome: 'withdrawn' }));
      const backs = (await refundLedgerRows()).filter((r) => r.delta > 0);
      assert.deepEqual(
        backs.map((r) => [r.lotId, r.delta, r.refundId]),
        [[p.lotId, 3, o.id]],
      );
      assert.equal(await unspent(p.lotId), 8);
    },
  );

  test(
    'an unroutable row (a charge with no PaymentIntent) closed Returned with {instrument: check} → resolved-external, returned_instrument check',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP(null);
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, world());
      const o = created(await postRefund(shanthi, mintBody(p.chargeId, 11400, 2)));
      assert.equal(o.status, 'unroutable');
      const wire = closed(
        await resolveExternal(shanthi, o.id, { note: 'check #1042', instrument: 'check' }),
      );
      assert.equal(wire.status, 'resolved-external');
      assert.equal(wire.returned_instrument, 'check');
      assert.equal(await unspent(p.lotId), 6, 'returned puts nothing back');
    },
  );

  test(
    'A1: with nothing left to return, withdrawn is 422 over_cap: O $456.00 with 8 removed fails, a $57.00 dashboard refund is adopted, N $399.00 succeeds → withdrawn on O refused, no ledger row, P 0, O still failed',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const w = world();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, w);
      const o = created(await postRefund(shanthi, mintBody(p.chargeId, 45600, 8)));
      await stripeSays(o.id, 'failed');
      await plantRefund({
        chargeId: p.chargeId,
        amountCents: 5700,
        status: 'succeeded',
        reason: 'out-of-band',
        stripeRefundId: `re_test_p22_dash_${randomUUID()}`,
      });
      w.stripe.setRefundReplyStatus('succeeded');
      const n = created(
        await postRefund(shanthi, mintBody(p.chargeId, 39900, 0, 'the rest, by card')),
      );
      assert.equal((await rowOf(n.id)).status, 'succeeded');
      const ledger = await refundLedgerRows();
      codeOf(
        await resolveExternal(shanthi, o.id, { note: 'keep it', outcome: 'withdrawn' }),
        422,
        'over_cap',
      );
      assert.deepEqual(await refundLedgerRows(), ledger, 'no ledger row');
      assert.equal(await unspent(p.lotId), 0);
      assert.equal((await rowOf(o.id)).status, 'failed');
    },
  );

  test(
    'A1, the other order: withdrawn on O while $399.00 is still owed → 200 and P holds 8; the proposal then reads 8 unbooked and $399.00; and a failed $120.00 row that removed nothing, on a payment since returned in full, still closes withdrawn',
    SKIP_WHEN_NO_DB,
    async () => {
      const p = await lotP();
      const shanthi = appOf(FIXTURE_OWNER_ROLE_PRINCIPAL, world());
      const o = created(await postRefund(shanthi, mintBody(p.chargeId, 45600, 8)));
      await stripeSays(o.id, 'failed');
      await plantRefund({
        chargeId: p.chargeId,
        amountCents: 5700,
        status: 'succeeded',
        reason: 'out-of-band',
        stripeRefundId: `re_test_p22_dash_${randomUUID()}`,
      });
      closed(await resolveExternal(shanthi, o.id, { note: 'keep it', outcome: 'withdrawn' }));
      assert.equal(await unspent(p.lotId), 8);
      const plan = proposal(await proposalOf(shanthi, p.chargeId));
      assert.equal(plan.unbooked_unspent_credits, 8);
      assert.equal(plan.proposed_cents, 39900);

      const classCharge = await plantCharge({ amountCents: 12000, purpose: 'group-class' });
      const f = created(await postRefund(shanthi, mintBody(classCharge, 12000, 0, 'the class')));
      await stripeSays(f.id, 'failed');
      await plantRefund({
        chargeId: classCharge,
        amountCents: 12000,
        status: 'succeeded',
        reason: 'out-of-band',
        stripeRefundId: `re_test_p22_dash_${randomUUID()}`,
      });
      closed(
        await resolveExternal(shanthi, f.id, {
          note: 'paid from the dashboard',
          outcome: 'withdrawn',
        }),
      );
    },
  );

  test(
    "B-2's chain verbs: at a limit of 5000 Fed's retry and close of a $10.00 failed head are 403 refund_role_required; Tomi's token is 403 forbidden on both; another staffer's key on either is 422 idempotency_mismatch and only Amber's replay returns her body",
    SKIP_WHEN_NO_DB,
    async () => {
      const w = world();
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, w);
      const fed = appOf(FIXTURE_STAFF_PRINCIPAL, w);
      const tomi = appOf(FIXTURE_OWNER_PRINCIPAL, w);
      await db.execute(
        sql`UPDATE payment_settings SET value = '5000' WHERE key = 'refund_any_role_limit_cents'`,
      );
      const chargeId = await plantCharge({ amountCents: 10000, purpose: 'board-train' });
      const head = await plantRefund({ chargeId, amountCents: 1000, status: 'failed' });
      codeOf(await retry(fed, head), 403, 'refund_role_required');
      codeOf(
        await resolveExternal(fed, head, { note: 'check', instrument: 'check' }),
        403,
        'refund_role_required',
      );
      codeOf(await retry(tomi, head), 403, 'forbidden');
      codeOf(
        await resolveExternal(tomi, head, { note: 'check', instrument: 'check' }),
        403,
        'forbidden',
      );
      assert.equal((await refundRows(chargeId)).length, 1);

      const retryKey = `p22-retry-${randomUUID()}`;
      const first = await retry(amber, head, retryKey);
      const r1 = created(first);
      for (const principal of [FIXTURE_STAFF_PRINCIPAL, FIXTURE_OWNER_ROLE_PRINCIPAL]) {
        codeOf(await retry(appOf(principal, w), head, retryKey), 422, 'idempotency_mismatch');
      }
      const again = await retry(amber, head, retryKey);
      assert.equal(again.statusCode, 201);
      assert.deepEqual(JSON.parse(again.body), JSON.parse(first.body));
      assert.equal((await refundRows(chargeId)).length, 2);

      await stripeSays(r1.id, 'failed');
      const closeKey = `p22-close-${randomUUID()}`;
      const body = { note: 'check #1042', instrument: 'check' };
      const shut = await resolveExternal(amber, r1.id, body, closeKey);
      closed(shut);
      for (const principal of [FIXTURE_STAFF_PRINCIPAL, FIXTURE_OWNER_ROLE_PRINCIPAL]) {
        codeOf(
          await resolveExternal(appOf(principal, w), r1.id, body, closeKey),
          422,
          'idempotency_mismatch',
        );
      }
      const replay = await resolveExternal(amber, r1.id, body, closeKey);
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(JSON.parse(replay.body), JSON.parse(shut.body));
    },
  );

  test(
    'a retry of an automatic row (no reason, no issuer) omits the reason and names its retrier; a malformed id is 400; an unknown one 404',
    SKIP_WHEN_NO_DB,
    async () => {
      const chargeId = await plantCharge({ amountCents: 10000, purpose: 'board-train' });
      const [auto] = await db
        .insert(refunds)
        .values({ ownerId: OWNER, chargeId, amountCents: 2500, status: 'failed', reason: null })
        .returning({ id: refunds.id });
      const amber = appOf(FIXTURE_MANAGER_PRINCIPAL, world());
      const r1 = created(await retry(amber, auto!.id));
      assert.equal('reason' in r1, false, 'null stays null (D3; Fable M9(a))');
      assert.equal(r1.issued_by?.staff_id, FIXTURE_IDS.staffAmberId);
      codeOf(await retry(amber, 'nope'), 400, 'bad_request');
      codeOf(await retry(amber, randomUUID()), 404, 'not_found');
      codeOf(
        await resolveExternal(amber, randomUUID(), { note: 'x', instrument: 'cash' }),
        404,
        'not_found',
      );
    },
  );
});
