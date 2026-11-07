import { z } from 'zod';
import type { CreditLotWire, CreditTier, OwnerCreditPoolWire } from '../../contracts/wire.js';
import { CREDIT_TIERS } from '../../contracts/wire.js';
import { readThrough } from '../../lib/cache.js';
import { bookingMode, type LocationKey } from '../schema/schema.js';
import { pgTimestampToDate, pgTimestampToIso } from '../../lib/pgTimestamp.js';
import { db } from '../client.js';
import { findLiveLots } from './creditLedgerRepository.js';
import { settingsRepository } from './settingsRepository.js';

/**
 * `GET /credits`'s read: one owner's pools at one campus. A pool is listed only while it
 * holds a live credit, so the empty list is the zero sentinel.
 *
 * Read-through and DISPLAY-ONLY: the authoritative read at booking time is the picker's,
 * inside the booking transaction under the pool lock, so a missed wipe can only show a
 * number stale for the TTL and can never permit an overspend. Every `credit_ledger` write
 * wipes it through {@link creditsInvalidationPattern}. The key is the owner's, so a dog id
 * has nowhere to arrive: a pattern built from one would compile and wipe nothing.
 */
const CREDITS_TTL_SEC = 60;

const LOT_SCHEMA = z.object({ remaining: z.number(), expires_at: z.string() });
const POOL_SCHEMA: z.ZodType<OwnerCreditPoolWire> = z.object({
  mode: z.enum(bookingMode.enumValues),
  tier: z.enum(CREDIT_TIERS),
  balance: z.number(),
  lots: LOT_SCHEMA.array(),
  expiring_lots: z
    .object({
      mode: z.enum(bookingMode.enumValues),
      remaining: z.number(),
      expires_at: z.string(),
    })
    .array(),
});
const POOLS_SCHEMA = POOL_SCHEMA.array();

const DAY_MS = 24 * 60 * 60 * 1000;

/** The pools at one campus. The owner leads the key, so one glob wipes both campuses. */
export function creditsPoolsCacheKey(ownerId: string, location: LocationKey): string {
  return `credits:${ownerId}:pools:${location}`;
}

/** The glob every `credit_ledger` write wipes: this owner's pools at every campus. */
export function creditsInvalidationPattern(ownerId: string): string {
  return `credits:${ownerId}:*`;
}

const TIER_ORDER: Readonly<Record<CreditTier, number>> = { regular: 0, alumni: 1 };

export const creditsRepository = {
  async findPools(ownerId: string, location: LocationKey): Promise<OwnerCreditPoolWire[]> {
    return readThrough(
      creditsPoolsCacheKey(ownerId, location),
      CREDITS_TTL_SEC,
      POOLS_SCHEMA,
      async () => {
        const lots = await findLiveLots(db, { ownerId, location });
        const { expiry_warning_lead_days: leads } = await settingsRepository.credit();
        const horizon = Date.now() + Math.max(0, ...leads) * DAY_MS;
        const pools = new Map<string, OwnerCreditPoolWire>();
        for (const lot of lots) {
          const key = `${lot.mode}:${lot.tier}`;
          const pool = pools.get(key) ?? {
            mode: lot.mode,
            tier: lot.tier,
            balance: 0,
            lots: [],
            expiring_lots: [],
          };
          pools.set(key, pool);
          const expires = pgTimestampToDate(lot.expiresAt);
          const expiresAt = pgTimestampToIso(lot.expiresAt);
          pool.balance += lot.remaining;
          pool.lots.push({ remaining: lot.remaining, expires_at: expiresAt });
          // "Never `[]` by a switch": this reads the date, whatever the switch says, and
          // a lot past its date, live only because expiry is off, is not about to expire.
          if (expires.getTime() > Date.now() && expires.getTime() <= horizon) {
            const expiring: CreditLotWire = {
              mode: lot.mode,
              remaining: lot.remaining,
              expires_at: expiresAt,
            };
            pool.expiring_lots.push(expiring);
          }
        }
        return [...pools.values()].sort(
          (a, b) =>
            bookingMode.enumValues.indexOf(a.mode) - bookingMode.enumValues.indexOf(b.mode) ||
            TIER_ORDER[a.tier] - TIER_ORDER[b.tier],
        );
      },
    );
  },
};
