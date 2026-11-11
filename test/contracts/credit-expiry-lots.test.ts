import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { lockPools } from '../../src/db/locks.js';
import {
  creditLedgerRepository,
  findLiveLots,
} from '../../src/db/repositories/creditLedgerRepository.js';
import { creditsInvalidationPattern } from '../../src/db/repositories/creditsRepository.js';
import { invalidatePattern } from '../../src/lib/cache.js';
import { creditLedger } from '../../src/db/schema/schema.js';
import { registerCreditsRoute } from '../../src/routes/credits.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';
import { clearPlantedPools, plantLot, poolBalance } from './_poolFixture.js';

/**
 * The credit lot model on owner keys (M4.10): the lot read, a dead lot counting nowhere,
 * where a return lands. What a date can be paid by is `credit-picker.test.ts`.
 */

registerFixtureHooks();
afterEach(async () => {
  await clearPlantedPools();
  await invalidatePattern(creditsInvalidationPattern(FIXTURE_IDS.ownerId));
});

const POOL = {
  ownerId: FIXTURE_IDS.ownerId,
  location: 'bentonville',
  mode: 'school',
  tier: 'regular',
} as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp `days` from now (negative = in the past). */
function isoIn(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

async function debit(lotId: string, bookingId: string): Promise<void> {
  await db.transaction((tx) =>
    creditLedgerRepository.debitLot(tx, {
      ...POOL,
      lotId,
      dogId: FIXTURE_IDS.dog1Id,
      bookingId,
      checkinEventId: null,
    }),
  );
}

/** The single settlement-return row for `bookingId`. */
async function refundRow(
  bookingId: string,
): Promise<{ lotId: string | null; expiresAt: string | null } | undefined> {
  const [row] = await db
    .select({ lotId: creditLedger.lotId, expiresAt: creditLedger.expiresAt })
    .from(creditLedger)
    .where(
      and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'settlement-return')),
    );
  return row;
}

/**
 * dog1's live debit on `bookingId`, back through the one return writer, which names it
 * (M5.10's `reverses_entry_id`). Asserts the return names exactly that debit.
 */
async function returnTheDebit(bookingId: string): Promise<void> {
  const debitId = await db.transaction(async (tx) => {
    const [live] = await creditLedgerRepository.findLiveDebits(tx, {
      bookingId,
      dogId: FIXTURE_IDS.dog1Id,
    });
    assert.ok(live !== undefined, 'the debit is live');
    await creditLedgerRepository.refundForBooking(tx, {
      ...live,
      now: new Date(),
      checkinEventId: null,
    });
    return live.id;
  });
  const [ret] = await db
    .select({ reversesEntryId: creditLedger.reversesEntryId })
    .from(creditLedger)
    .where(
      and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'settlement-return')),
    );
  assert.equal(ret?.reversesEntryId, debitId);
}

async function liveRemaining(): Promise<[string, number][]> {
  const lots = await findLiveLots(db, POOL);
  return lots.map((lot) => [lot.id, lot.remaining]);
}

// ──────────────────────────────────────────────────────────────────────────

test(
  'the live lots read soonest-expiring first, each with what is left of it',
  SKIP_WHEN_NO_DB,
  async () => {
    const later = await plantLot({ credits: 1, expiresAt: isoIn(365) });
    const soon = await plantLot({ credits: 2, expiresAt: isoIn(30) });
    assert.deepEqual(await liveRemaining(), [
      [soon, 2],
      [later, 1],
    ]);

    await debit(soon, FIXTURE_IDS.booking1Id);
    await debit(soon, FIXTURE_IDS.booking2Id);
    assert.deepEqual(await liveRemaining(), [[later, 1]], 'a spent lot is not offered');
    assert.equal(await poolBalance(), 1);
  },
);

test('expired lots are excluded from the balance', SKIP_WHEN_NO_DB, async () => {
  await plantLot({ credits: 5, expiresAt: isoIn(-1) }); // expired yesterday
  await plantLot({ credits: 2, expiresAt: isoIn(365) }); // live
  assert.equal(await poolBalance(), 2, 'only the live lot counts');
});

test(
  'refund returns the credit to its original lot while that lot is still alive',
  SKIP_WHEN_NO_DB,
  async () => {
    const lot = await plantLot({ credits: 2, expiresAt: isoIn(365) });
    await debit(lot, FIXTURE_IDS.booking1Id);
    assert.equal(await poolBalance(), 1);

    await returnTheDebit(FIXTURE_IDS.booking1Id);

    const row = await refundRow(FIXTURE_IDS.booking1Id);
    assert.equal(row?.lotId, lot, 'refund is tagged back to the original lot');
    assert.equal(row?.expiresAt, null, 'refund-to-lot row is an allocation, not a new source');
    assert.equal(await poolBalance(), 2, 'credit restored');
  },
);

test(
  'refund mints a fresh lot when the original source lot has already expired',
  SKIP_WHEN_NO_DB,
  async () => {
    const expiredLot = await plantLot({ credits: 2, expiresAt: isoIn(-1) });
    await debit(expiredLot, FIXTURE_IDS.booking1Id);
    assert.equal(await poolBalance(), 0, 'expired lot and its debit both excluded');

    await returnTheDebit(FIXTURE_IDS.booking1Id);

    const row = await refundRow(FIXTURE_IDS.booking1Id);
    assert.equal(row?.lotId, null, 'expired-lot refund mints a fresh source (lot_id null)');
    assert.ok(
      row?.expiresAt != null && new Date(row.expiresAt) > new Date(),
      'the fresh lot carries a future expiry',
    );
    assert.equal(await poolBalance(), 1, 'only the fresh refund lot counts');
  },
);

test('GET /credits leaves a spent lot out of `lots`', SKIP_WHEN_NO_DB, async () => {
  const soon = isoIn(60);
  const late = isoIn(400);
  await plantLot({ credits: 2, expiresAt: soon });
  await plantLot({ credits: 3, expiresAt: late });
  const exhausted = await plantLot({ credits: 1, expiresAt: isoIn(120) });
  await debit(exhausted, FIXTURE_IDS.booking1Id);

  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerCreditsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: '/credits?location=bentonville' });
  assert.equal(res.statusCode, 200, res.body);

  const { pools } = res.json() as {
    pools: { mode: string; lots: { remaining: number; expires_at: string }[] }[];
  };
  assert.deepEqual(pools.find((pool) => pool.mode === 'school')?.lots, [
    { remaining: 2, expires_at: soon },
    { remaining: 3, expires_at: late },
  ]);
});

test(
  'two dogs racing one pool under its lock never spend one credit twice',
  SKIP_WHEN_NO_DB,
  async () => {
    // Two dogs, so the dog lock does not serialize them: only the pool's can.
    const first = await plantLot({ credits: 1, expiresAt: isoIn(30) });
    const second = await plantLot({ credits: 1, expiresAt: isoIn(60) });

    const debitOnce = (dogId: string, bookingId: string): Promise<void> =>
      db.transaction(async (tx) => {
        await lockPools(tx, [POOL]);
        const [lot] = await findLiveLots(tx, POOL);
        if (lot === undefined) throw new Error('the pool read empty under its lock');
        await creditLedgerRepository.debitLot(tx, {
          ...POOL,
          lotId: lot.id,
          dogId,
          bookingId,
          checkinEventId: null,
        });
      });
    await Promise.all([
      debitOnce(FIXTURE_IDS.dog1Id, FIXTURE_IDS.booking1Id),
      debitOnce(FIXTURE_IDS.dog2Id, FIXTURE_IDS.booking2Id),
    ]);

    const debits = await db
      .select({ lotId: creditLedger.lotId })
      .from(creditLedger)
      .where(
        and(eq(creditLedger.location, 'bentonville'), eq(creditLedger.reason, 'booking-debit')),
      );
    assert.deepEqual(debits.map((d) => d.lotId).sort(), [first, second].sort());
    assert.equal(await poolBalance(), 0);
  },
);
