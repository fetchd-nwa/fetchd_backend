import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { readThrough } from '../../lib/cache.js';
import { db } from '../client.js';
import { dogCreditBalance, dogs, type LocationKey } from '../schema/schema.js';
import { live } from '../softExpire.js';
import { assertNever } from '../../lib/assertNever.js';
import { pgTimestampToIso } from '../../lib/pgTimestamp.js';
import { findLiveExpiringLots } from './creditLedgerRepository.js';
import type { BookingMode } from '../../lib/bookingMode.js';

/**
 * Per-dog credit balance, owner-scoped. Combines ownership check + balance
 * read into one query through `dogs LEFT JOIN dog_credit_balance` so the
 * route gets a single yes/no/here's-the-data answer:
 *
 *   null               → dog doesn't exist or doesn't belong to this owner
 *                        (route maps to 404; same response either way so
 *                        ids don't enumerate)
 *   { school, daycare} → dog exists; zero defaults applied where the
 *                        ledger has no rows for that mode (DATA-CONTRACT
 *                        §B Credits Δ 2026-05-20 zero-sentinel — a
 *                        freshly-provisioned dog never 404s)
 *
 * The view `dog_credit_balance` (schema.sql:640-643) is `SUM(delta)
 * GROUP BY (dog_id, mode)` over the append-only `credit_ledger`. A dog
 * with zero ledger rows produces zero view rows; the LEFT JOIN preserves
 * the `dogs` row with NULL mode/balance, which the route filters out
 * before pivoting.
 */
export interface CreditsBalance {
  school: number;
  daycare: number;
}

/**
 * One live EXPIRING lot's remaining credits + when they lapse. Never-expiring
 * credits (1-credit packs, legacy/imports, pool) aren't listed — there's
 * nothing to warn about; they're already in the `CreditsBalance` totals.
 */
export interface CreditLot {
  mode: BookingMode;
  remaining: number;
  /** ISO timestamp; always present (only expiring lots are returned). */
  expiresAt: string;
}

/**
 * Read-through cache for the `GET /dogs/:id/credits` display reads. This cache
 * is DISPLAY-ONLY: the authoritative balance check at booking time is
 * `creditLedgerRepository.balanceForDogInTx` (read inside the booking txn under
 * the dog-mode advisory lock), NOT this cache. So a missed invalidation can
 * only ever show a briefly-stale number (TTL-bounded) — it can never permit an
 * overspend. Invalidated by every `credit_ledger` mutation via
 * `invalidatePattern(creditsInvalidationPattern(dogId))`: purchase (sync +
 * webhook), booking debit, cancel credit-refund, and the payment_failed
 * reversal.
 *
 * Short TTL (60s) because credits change on user action; the TTL is the
 * backstop behind explicit invalidation, not the primary freshness mechanism.
 */
const CREDITS_TTL_SEC = 60;

const CREDITS_BALANCE_SCHEMA: z.ZodType<CreditsBalance | null> = z
  .object({ school: z.number(), daycare: z.number() })
  .nullable();

const CREDIT_LOT_SCHEMA: z.ZodType<CreditLot> = z.object({
  mode: z.enum(['school', 'daycare']),
  remaining: z.number(),
  expiresAt: z.string(),
});
const CREDIT_LOTS_SCHEMA = CREDIT_LOT_SCHEMA.array();

/**
 * Balance cache key. `ownerId` is IN the key deliberately: the underlying query
 * gates on `dogs.owner_id`, so a dogId-only key would let a different owner
 * read this owner's cached balance (the cache would bypass the ownership
 * WHERE). Keeping `dogId` first preserves the `credits:{dogId}:*` invalidation
 * glob — a non-owner's request simply misses (different owner segment) and
 * re-queries to the correct 404-null.
 */
export function creditsBalanceCacheKey(
  dogId: string,
  ownerId: string,
  location: LocationKey,
): string {
  return `credits:${dogId}:${ownerId}:balance:${location}`;
}

/**
 * Expiring-lots cache key. No `ownerId` segment: `findExpiringLots` is only
 * reached after `findBalancesForOwnedDog` returned non-null (ownership already
 * proven by the route, `credits.ts`), so a non-owner never gets this far.
 */
export function creditsLotsCacheKey(dogId: string, location: LocationKey): string {
  return `credits:${dogId}:lots:${location}`;
}

/**
 * The glob every `credit_ledger` mutation wipes to drop this dog's cached
 * balance + lots across all locations/owners. Matches both key shapes above
 * (dogId is the leading segment).
 */
export function creditsInvalidationPattern(dogId: string): string {
  return `credits:${dogId}:*`;
}

export const creditsRepository = {
  async findBalancesForOwnedDog(
    dogId: string,
    ownerId: string,
    location: LocationKey,
  ): Promise<CreditsBalance | null> {
    // Display-only read-through (see CREDITS_TTL_SEC doc). `null` (not
    // owned / doesn't exist) is never cached by `readThrough`, so a
    // non-owner always re-queries to the correct 404-null.
    return readThrough(
      creditsBalanceCacheKey(dogId, ownerId, location),
      CREDITS_TTL_SEC,
      CREDITS_BALANCE_SCHEMA,
      async () => {
        const rows = await db
          .select({
            mode: dogCreditBalance.mode,
            balance: dogCreditBalance.balance,
          })
          .from(dogs)
          .leftJoin(
            dogCreditBalance,
            and(eq(dogCreditBalance.dogId, dogs.id), eq(dogCreditBalance.location, location)),
          )
          .where(and(eq(dogs.id, dogId), eq(dogs.ownerId, ownerId), live(dogs)));

        if (rows.length === 0) return null;

        let school = 0;
        let daycare = 0;
        for (const row of rows) {
          if (row.balance === null || row.mode === null) continue; // dog exists, no ledger rows for this mode
          switch (row.mode) {
            case 'school':
              school = row.balance;
              break;
            case 'daycare':
              daycare = row.balance;
              break;
            default:
              // Exhaustive over `booking_mode` enum. If a future mode lands without
              // a wire-shape decision, this fails the compile — better than silent
              // drop. Schema is locked at the two values today.
              assertNever(row.mode);
          }
        }
        return { school, daycare };
      },
    );
  },

  /**
   * The dog's LIVE expiring lots for a location — remaining credits per lot +
   * expiry, soonest first — so the owner app can surface "N credits expire on
   * {date}". Remaining = the lot's grant plus every allocation (debit−/refund+)
   * tagged to it; exhausted and expired lots are excluded. Ownership is NOT
   * re-checked here; callers gate on `findBalancesForOwnedDog` first.
   */
  async findExpiringLots(dogId: string, location: LocationKey): Promise<CreditLot[]> {
    return readThrough(
      creditsLotsCacheKey(dogId, location),
      CREDITS_TTL_SEC,
      CREDIT_LOTS_SCHEMA,
      async () => {
        const lots = await findLiveExpiringLots(db, { dogId, location });
        return lots.map((lot) => ({
          mode: lot.mode,
          remaining: lot.remaining,
          // `findLiveExpiringLots` is a raw-SQL boundary that returns PG's
          // space-separated `+00` timestamp; convert to wire ISO-8601 so JS
          // `Date` (Hermes) can parse it — matches the `expiresAt` doc contract.
          expiresAt: pgTimestampToIso(lot.expiresAt),
        }));
      },
    );
  },
};
