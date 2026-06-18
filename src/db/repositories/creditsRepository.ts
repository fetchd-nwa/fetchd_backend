import { and, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { dogCreditBalance, dogs, LOCATION_SLUGS } from '../schema/schema.js';
import { live } from '../softExpire.js';
import { assertNever } from '../../lib/assertNever.js';
import { findLiveExpiringLots } from './creditLedgerRepository.js';
import type { BookingMode } from '../../lib/bookingMode.js';

type LocationKey = (typeof LOCATION_SLUGS)[number];

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

export const creditsRepository = {
  async findBalancesForOwnedDog(
    dogId: string,
    ownerId: string,
    location: LocationKey,
  ): Promise<CreditsBalance | null> {
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

  /**
   * The dog's LIVE expiring lots for a location — remaining credits per lot +
   * expiry, soonest first — so the owner app can surface "N credits expire on
   * {date}". Remaining = the lot's grant plus every allocation (debit−/refund+)
   * tagged to it; exhausted and expired lots are excluded. Ownership is NOT
   * re-checked here; callers gate on `findBalancesForOwnedDog` first.
   */
  async findExpiringLots(dogId: string, location: LocationKey): Promise<CreditLot[]> {
    const lots = await findLiveExpiringLots(db, { dogId, location });
    return lots.map((lot) => ({
      mode: lot.mode,
      remaining: lot.remaining,
      expiresAt: lot.expiresAt,
    }));
  },
};
