import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { creditLedgerRepository } from '../../src/db/repositories/creditLedgerRepository.js';
import { creditsInvalidationPattern } from '../../src/db/repositories/creditsRepository.js';
import { withDogModeLock } from '../../src/db/locks.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { creditLedger } from '../../src/db/schema/schema.js';
import { resolvePurchaseExpiry, resolveRefundExpiry } from '../../src/lib/creditExpiry.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Phase 1 credit-expiry LOT model (schema.sql credit_ledger Δ 2026-06-18).
 * Exercises the repository surface directly — FIFO debit, expired-lot
 * exclusion from balance, refund routing (live lot vs fresh mint), the
 * 1-credit-never-expires rule, grandfathered NULL credits — plus the
 * `GET /dogs/:id/credits` expiring-lots wire.
 */

registerFixtureHooks();

const DOG = FIXTURE_IDS.dog1Id;
const SCHOOL = 'school' as const;
const FAY = 'fayetteville' as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp `days` from now (negative = in the past). */
function isoIn(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

/** Clear every ledger row for the fixture dog so each test starts clean. */
async function resetDog1Ledger(): Promise<void> {
  await db.delete(creditLedger).where(eq(creditLedger.dogId, DOG));
  // Out-of-band (direct-SQL) ledger reset: the API's post-commit cache
  // invalidation never fires here, so drop this dog's cached balance + lots by
  // hand — exactly as a `credit_ledger` mutation through the API would. Without
  // it, a prior test's `GET /credits` read bleeds into the next (Redis is
  // flushed once per file, not per test).
  await invalidatePattern(creditsInvalidationPattern(DOG));
}

/** Insert a source lot (`purchase`, delta>0, lot_id NULL) and return its id. */
async function insertLot(delta: number, expiresAt: string | null): Promise<string> {
  const id = randomUUID();
  await db
    .insert(creditLedger)
    .values({ id, dogId: DOG, mode: SCHOOL, location: FAY, delta, reason: 'purchase', expiresAt });
  return id;
}

/** Insert a subscription source lot (`membership-grant`) and return its id. */
async function insertMembershipLot(delta: number, expiresAt: string | null): Promise<string> {
  const id = randomUUID();
  await db.insert(creditLedger).values({
    id,
    dogId: DOG,
    mode: SCHOOL,
    location: FAY,
    delta,
    reason: 'membership-grant',
    expiresAt,
  });
  return id;
}

/** Lot-aware live balance via the repository (reads the canonical view). */
async function balance(): Promise<number> {
  return db.transaction(
    async (tx) => (await creditLedgerRepository.balanceForDogInTx(tx, DOG, SCHOOL, FAY)) ?? 0,
  );
}

/** Run one FIFO debit tagged to `bookingId`; return the lot it drew from (null = pool). */
async function debit(bookingId: string): Promise<string | null> {
  await db.transaction(async (tx) => {
    await creditLedgerRepository.debitForBooking(tx, {
      dogId: DOG,
      mode: SCHOOL,
      location: FAY,
      bookingId,
    });
  });
  const [row] = await db
    .select({ lotId: creditLedger.lotId })
    .from(creditLedger)
    .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'booking-debit')));
  return row?.lotId ?? null;
}

/** The single cancel-refund row for `bookingId`. */
async function refundRow(
  bookingId: string,
): Promise<{ lotId: string | null; expiresAt: string | null } | undefined> {
  const [row] = await db
    .select({ lotId: creditLedger.lotId, expiresAt: creditLedger.expiresAt })
    .from(creditLedger)
    .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'cancel-refund')));
  return row;
}

// ──────────────────────────────────────────────────────────────────────────

test(
  'FIFO debit spends the soonest-expiry lot first, then the never-expiring pool last',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDog1Ledger();
    const lotSoon = await insertLot(1, isoIn(30));
    const lotLater = await insertLot(1, isoIn(365));
    await insertLot(1, null); // never-expiring pool
    assert.equal(await balance(), 3);

    assert.equal(await debit(FIXTURE_IDS.booking1Id), lotSoon, 'soonest-expiry lot first');
    assert.equal(
      await debit(FIXTURE_IDS.booking2Id),
      lotLater,
      'next-soonest after the first is exhausted',
    );
    assert.equal(await debit(FIXTURE_IDS.booking3Id), null, 'never-expiring pool is spent last');
    assert.equal(await balance(), 0);
  },
);

test(
  'subscription credits first: a membership-grant lot beats a SOONER-expiring purchase lot',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDog1Ledger();
    const purchaseSoon = await insertLot(1, isoIn(5)); // purchase, expires in days
    const membership = await insertMembershipLot(1, isoIn(25)); // subscription month
    assert.equal(await balance(), 2);

    assert.equal(
      await debit(FIXTURE_IDS.booking1Id),
      membership,
      'membership-grant lot consumed first despite the later expiry (2026-07-14 ruling)',
    );
    assert.equal(
      await debit(FIXTURE_IDS.booking2Id),
      purchaseSoon,
      'purchase lot only after subscription credits are exhausted',
    );
    assert.equal(await balance(), 0);
  },
);

test(
  'alumni membership lot (NULL expiry) still beats purchase lots and the pool; expiring membership lot beats it',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDog1Ledger();
    const alumniMembership = await insertMembershipLot(1, null); // alumni grant — never expires
    const membershipExpiring = await insertMembershipLot(1, isoIn(20));
    const purchase = await insertLot(1, isoIn(10));
    await insertLot(1, null); // never-expiring purchase pool
    assert.equal(await balance(), 4);

    assert.equal(
      await debit(FIXTURE_IDS.booking1Id),
      membershipExpiring,
      'expiring membership lot first within the subscription bucket',
    );
    assert.equal(
      await debit(FIXTURE_IDS.booking2Id),
      alumniMembership,
      'alumni NULL-expiry membership lot next — still ahead of every purchase lot',
    );
    assert.equal(await debit(FIXTURE_IDS.booking3Id), purchase, 'then expiring purchase lots');
    assert.equal(await debit(FIXTURE_IDS.booking4Id), null, 'never-expiring pool last');
    assert.equal(await balance(), 0);
  },
);

test('expired lots are excluded from the balance', SKIP_WHEN_NO_DB, async () => {
  await resetDog1Ledger();
  await insertLot(5, isoIn(-1)); // expired yesterday
  await insertLot(2, isoIn(365)); // live
  assert.equal(await balance(), 2, 'only the live lot counts');
});

test(
  'refund returns the credit to its original lot while that lot is still alive',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDog1Ledger();
    const lot = await insertLot(2, isoIn(365));
    assert.equal(await debit(FIXTURE_IDS.booking1Id), lot);
    assert.equal(await balance(), 1);

    await db.transaction(async (tx) => {
      await creditLedgerRepository.refundForBooking(tx, {
        dogId: DOG,
        mode: SCHOOL,
        location: FAY,
        bookingId: FIXTURE_IDS.booking1Id,
        lotId: lot,
        lotExpiresAt: isoIn(365),
        now: new Date(),
      });
    });

    const row = await refundRow(FIXTURE_IDS.booking1Id);
    assert.equal(row?.lotId, lot, 'refund is tagged back to the original lot');
    assert.equal(row?.expiresAt, null, 'refund-to-lot row is an allocation, not a new source');
    assert.equal(await balance(), 2, 'credit restored');
  },
);

test(
  'refund mints a fresh lot when the original source lot has already expired',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDog1Ledger();
    const expiredLot = await insertLot(2, isoIn(-1));
    // A debit that was tagged to the lot before it expired.
    await db.insert(creditLedger).values({
      dogId: DOG,
      mode: SCHOOL,
      location: FAY,
      delta: -1,
      reason: 'booking-debit',
      bookingId: FIXTURE_IDS.booking1Id,
      lotId: expiredLot,
    });
    assert.equal(await balance(), 0, 'expired lot and its debit both excluded');

    await db.transaction(async (tx) => {
      await creditLedgerRepository.refundForBooking(tx, {
        dogId: DOG,
        mode: SCHOOL,
        location: FAY,
        bookingId: FIXTURE_IDS.booking1Id,
        lotId: expiredLot,
        lotExpiresAt: isoIn(-1),
        now: new Date(),
      });
    });

    const row = await refundRow(FIXTURE_IDS.booking1Id);
    assert.equal(row?.lotId, null, 'expired-lot refund mints a fresh source (lot_id null)');
    assert.ok(
      row?.expiresAt != null && new Date(row.expiresAt) > new Date(),
      'the fresh lot carries a future expiry',
    );
    assert.equal(await balance(), 1, 'only the fresh refund lot counts');
  },
);

test(
  'grandfathered NULL-expiry credits never expire and are spent from the pool',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDog1Ledger();
    await insertLot(3, null); // legacy / Gingr-imported grant — no expiry
    assert.equal(await balance(), 3);
    assert.equal(await debit(FIXTURE_IDS.booking1Id), null, 'spent from the pool (lot_id null)');
    assert.equal(await balance(), 2);
  },
);

test('resolvePurchaseExpiry: 1-credit packs never expire; multi-credit packs get the resolved window', () => {
  const now = new Date('2026-06-18T12:00:00Z');
  const WINDOW_MONTHS = 12;
  assert.equal(resolvePurchaseExpiry(1, WINDOW_MONTHS, now), null, 'single-day pack never expires');
  const multi = resolvePurchaseExpiry(5, WINDOW_MONTHS, now);
  assert.equal(
    multi?.toISOString(),
    '2027-06-18T12:00:00.000Z',
    'multi-credit pack expires in 12 months',
  );
  // A refund mint always gets a window, even though it is 1 credit (decision #5).
  assert.equal(resolveRefundExpiry(WINDOW_MONTHS, now).toISOString(), '2027-06-18T12:00:00.000Z');
});

test('resolvePurchaseExpiry: honors a non-default resolved window (e.g. a 6-month override)', () => {
  const now = new Date('2026-06-18T12:00:00Z');
  const SIX_MONTHS = 6;
  const multi = resolvePurchaseExpiry(5, SIX_MONTHS, now);
  assert.equal(multi?.toISOString(), '2026-12-18T12:00:00.000Z', 'expires 6 months out');
  // 1-credit still never-expire regardless of the window number.
  assert.equal(resolvePurchaseExpiry(1, SIX_MONTHS, now), null);
});

test(
  'GET /dogs/:id/credits surfaces live expiring lots and omits never-expiring credits',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDog1Ledger();
    await insertLot(4, isoIn(200)); // expiring
    await insertLot(2, null); // never-expiring pool

    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${DOG}/credits?location=fayetteville`,
    });
    assert.equal(res.statusCode, 200);

    const wire = res.json() as {
      school: number;
      expiring_lots: { mode: string; remaining: number; expires_at: string }[];
    };
    assert.equal(wire.school, 6, 'total balance counts both the expiring lot and the pool');
    assert.equal(wire.expiring_lots.length, 1, 'only the expiring lot is listed');
    assert.equal(wire.expiring_lots[0]?.mode, 'school');
    assert.equal(wire.expiring_lots[0]?.remaining, 4);
    const expiresAt = wire.expiring_lots[0]!.expires_at;
    assert.ok(new Date(expiresAt) > new Date());
    // Wire ISO-8601 ('…THH:MM:SS[.mmm]Z'), NOT PG's raw space-separated `+00`
    // form. V8 (this Node test) parses both leniently, but Hermes (RN) only
    // parses ISO — the raw form throws "Invalid time value" in the app. Guards
    // the pgTimestampToIso conversion in creditsRepository.findExpiringLots.
    assert.match(
      expiresAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
      `expires_at must be wire ISO-8601, got '${expiresAt}'`,
    );
  },
);

test(
  'GET /dogs/:id/credits lists multiple expiring lots soonest-first and omits exhausted ones',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDog1Ledger();
    await insertLot(2, isoIn(60)); // soonest
    await insertLot(3, isoIn(400)); // latest
    const exhausted = await insertLot(1, isoIn(120)); // fully spent below
    await db.insert(creditLedger).values({
      dogId: DOG,
      mode: SCHOOL,
      location: FAY,
      delta: -1,
      reason: 'booking-debit',
      bookingId: FIXTURE_IDS.booking1Id,
      lotId: exhausted,
    });

    const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
    registerCreditsRoute(app, { authenticate });
    const res = await app.inject({
      method: 'GET',
      url: `/dogs/${DOG}/credits?location=fayetteville`,
    });
    assert.equal(res.statusCode, 200);

    const wire = res.json() as { expiring_lots: { remaining: number; expires_at: string }[] };
    assert.equal(wire.expiring_lots.length, 2, 'the exhausted lot is omitted');
    assert.deepEqual(
      wire.expiring_lots.map((lot) => lot.remaining),
      [2, 3],
      'soonest-expiry lot first',
    );
    assert.ok(
      new Date(wire.expiring_lots[0]!.expires_at) < new Date(wire.expiring_lots[1]!.expires_at),
    );
  },
);

test(
  'concurrent debits under the advisory lock never double-select the same lot',
  SKIP_WHEN_NO_DB,
  async () => {
    await resetDog1Ledger();
    const lot = await insertLot(1, isoIn(30)); // a single expiring credit
    await insertLot(1, null); // plus one pool credit

    // Two bookings race for the same (dog, mode, location). The advisory lock
    // serializes them, so FIFO can't hand the one expiring credit to both.
    const debitOnce = (bookingId: string): Promise<void> =>
      db.transaction((tx) =>
        withDogModeLock(tx, DOG, SCHOOL, FAY, () =>
          creditLedgerRepository.debitForBooking(tx, {
            dogId: DOG,
            mode: SCHOOL,
            location: FAY,
            bookingId,
          }),
        ),
      );
    await Promise.all([debitOnce(FIXTURE_IDS.booking1Id), debitOnce(FIXTURE_IDS.booking2Id)]);

    const debits = await db
      .select({ lotId: creditLedger.lotId })
      .from(creditLedger)
      .where(and(eq(creditLedger.dogId, DOG), eq(creditLedger.reason, 'booking-debit')));
    assert.equal(debits.length, 2);
    assert.equal(
      debits.filter((d) => d.lotId === lot).length,
      1,
      'the single expiring credit went to exactly one booking',
    );
    assert.equal(
      debits.filter((d) => d.lotId === null).length,
      1,
      'the other booking fell through to the pool',
    );
    assert.equal(await balance(), 0);
  },
);
