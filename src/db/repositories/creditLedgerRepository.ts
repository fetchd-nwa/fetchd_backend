import { and, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { creditLedger, dogCreditBalance, LOCATION_SLUGS } from '../schema/schema.js';
import type { BookingMode } from '../../lib/bookingMode.js';
import { resolveRefundExpiry } from '../../lib/creditExpiry.js';
import type { Tx } from '../tx.js';

type LocationKey = (typeof LOCATION_SLUGS)[number];

/**
 * Data-access seam for `credit_ledger` (schema.sql:853). Append-only by
 * design — corrections are reversing entries, never edits.
 *
 * Δ 2026-06-18 — the LOT model (schema.sql credit-expiry block):
 *   - A `purchase` row (delta>0, lot_id NULL) is a credit *lot*. `expires_at`
 *     governs it: NULL = never (1-credit packs, legacy/Gingr imports, the
 *     never-expiring "pool"); a timestamp = forfeit once passed.
 *   - A `booking-debit` (delta=-1) sets `lot_id` to the lot it drew from, or
 *     NULL when it drew from the never-expiring pool. FIFO spends the
 *     soonest-expiry live lot first, the pool last.
 *   - A `cancel-refund` (+1) returns the credit to its original lot if that
 *     lot is still alive, else mints a fresh lot (decisions #1 vs #5).
 *   - Balance counts only LIVE lots — `dog_credit_balance` (schema.sql) is the
 *     canonical formula; `balanceForDogInTx` reads it inside the booking tx so
 *     the freshly-inserted debit is visible (Redis caches the public read).
 *
 * Concurrency: every debit/balance read for a (dog, mode, location) runs under
 * the `withDogModeLock(dogId, mode, location)` advisory lock acquired by the
 * route, so FIFO lot selection + the post-pre-check balance are race-free.
 */

/** A live, non-exhausted EXPIRING lot + its remaining capacity. */
export interface LiveExpiringLot {
  id: string;
  mode: BookingMode;
  /** ISO timestamp — always set (expired + never-expiring pool lots are excluded). */
  expiresAt: string;
  remaining: number;
}

/**
 * Live expiring lots for a (dog, location[, mode]), soonest-expiry first, with
 * `remaining` = the lot's grant plus every allocation (debit−/refund+) tagged
 * to it. Excludes expired lots, never-expiring (pool) lots, and exhausted lots
 * (remaining ≤ 0). The single source for both FIFO debit selection
 * (`debitForBooking` takes the first row) and the public `GET /credits`
 * expiring-lots read (`creditsRepository.findExpiringLots`) — so the
 * "live expiring lot with capacity" predicate lives in exactly one place.
 *
 * Polymorphic runner: pass the booking Tx to see in-tx debits under the
 * (dog,mode,location) advisory lock (so a multi-debit loop walks the lots
 * correctly); pass the pool `db` for the public read.
 */
export async function findLiveExpiringLots(
  runner: Tx | typeof db,
  args: { dogId: string; location: LocationKey; mode?: BookingMode },
): Promise<LiveExpiringLot[]> {
  const modeClause = args.mode ? sql`AND lot.mode = ${args.mode}` : sql``;
  const result = await runner.execute(sql`
    SELECT lot.id, lot.mode, lot.expires_at AS "expiresAt",
           (lot.delta + COALESCE(a.alloc, 0))::int AS remaining
    FROM credit_ledger lot
    LEFT JOIN (
      SELECT lot_id, SUM(delta) AS alloc
      FROM credit_ledger
      WHERE lot_id IS NOT NULL
      GROUP BY lot_id
    ) a ON a.lot_id = lot.id
    WHERE lot.dog_id = ${args.dogId}
      AND lot.location = ${args.location}
      ${modeClause}
      AND lot.delta > 0
      AND lot.lot_id IS NULL
      AND lot.expires_at IS NOT NULL
      AND lot.expires_at > now()
      AND (lot.delta + COALESCE(a.alloc, 0)) > 0
    ORDER BY lot.expires_at ASC
  `);
  // Raw SQL boundary: the SELECT projects exactly id/mode/expiresAt/remaining,
  // so the row shape is known. (The `Tx | db` union widens `.rows` to
  // Record<string, unknown>, so the cast routes through `unknown`.)
  return result.rows as unknown as LiveExpiringLot[];
}

export const creditLedgerRepository = {
  /**
   * INSERT one booking-debit row (delta = -1) inside the open tx, tagged with
   * the FIFO source lot (or NULL for the never-expiring pool). Caller must hold
   * `withDogModeLock(tx, dogId, mode, location)` first — without it, two
   * concurrent bookSession txns could each pass the pre-check against a
   * snapshot that hadn't seen the other's debit, or pick the same lot twice.
   *
   * Exactly one credit per (dog, mode, date); multi-date bookings produce N
   * debit rows, one per date.
   */
  async debitForBooking(
    tx: Tx,
    args: {
      dogId: string;
      mode: BookingMode;
      location: LocationKey;
      bookingId: string;
    },
  ): Promise<void> {
    // FIFO: tag the soonest-expiry live lot with capacity; null = the
    // never-expiring pool (no live expiring lot has room).
    const [lot] = await findLiveExpiringLots(tx, {
      dogId: args.dogId,
      location: args.location,
      mode: args.mode,
    });
    await tx.insert(creditLedger).values({
      dogId: args.dogId,
      mode: args.mode,
      location: args.location,
      delta: -1,
      reason: 'booking-debit',
      bookingId: args.bookingId,
      lotId: lot?.id ?? null,
    });
  },

  /**
   * Per-(dog, mode, location) LIVE balance read INSIDE the open tx, via the
   * canonical `dog_credit_balance` view (lot-aware: expired-lot credits
   * excluded). Reading the view in-tx sees the tx's own uncommitted debits.
   *
   * `null` when the dog has no qualifying ledger rows for this (mode, location)
   * — semantically balance=0. The booking pre-check (`routes/bookings.ts`)
   * coalesces null→0.
   */
  async balanceForDogInTx(
    tx: Tx,
    dogId: string,
    mode: BookingMode,
    location: LocationKey,
  ): Promise<number | null> {
    const [row] = await tx
      .select({ balance: dogCreditBalance.balance })
      .from(dogCreditBalance)
      .where(
        and(
          eq(dogCreditBalance.dogId, dogId),
          eq(dogCreditBalance.mode, mode),
          eq(dogCreditBalance.location, location),
        ),
      );
    return row?.balance ?? null;
  },

  /**
   * Every `booking-debit` row for one booking, with the source lot each drew
   * from (lot_id + that lot's expiry). The cancel txn uses this to (a) detect a
   * credit-paid booking (non-empty result) and (b) route each +1 refund back to
   * its lot — to the original lot if still alive, else a fresh one.
   *
   * `lotExpiresAt` is the source lot's `expires_at`; null when `lotId` is null
   * (pool debit) or the lot never expires. Append-only — no `live()` filter.
   */
  async findDebitsForBooking(tx: Tx, bookingId: string): Promise<BookingDebitForRefund[]> {
    const result = await tx.execute(sql`
      SELECT d.dog_id, d.mode, d.location, d.lot_id, lot.expires_at AS lot_expires_at
      FROM credit_ledger d
      LEFT JOIN credit_ledger lot ON lot.id = d.lot_id
      WHERE d.booking_id = ${bookingId} AND d.reason = 'booking-debit'
    `);
    return (
      result.rows as {
        dog_id: string;
        mode: BookingMode;
        location: LocationKey;
        lot_id: string | null;
        lot_expires_at: string | null;
      }[]
    ).map((r) => ({
      dogId: r.dog_id,
      mode: r.mode,
      location: r.location,
      lotId: r.lot_id,
      lotExpiresAt: r.lot_expires_at,
    }));
  },

  /**
   * INSERT one +1 `cancel-refund` row reversing a prior `booking-debit`,
   * routed to the right lot:
   *   - debit drew from the pool (lotId null) → restore to the pool (+1,
   *     lot_id null, never-expire);
   *   - source lot still alive → return to it (+1, lot_id = original; keeps the
   *     lot's expiry);
   *   - source lot expired → mint a FRESH lot (+1, lot_id null, fresh window),
   *     so the refunded credit is usable (decision #5).
   *
   * Caller iterates `findDebitsForBooking`. Append-only: the original debit
   * stays; this row counterbalances it.
   */
  async refundForBooking(
    tx: Tx,
    args: {
      dogId: string;
      mode: BookingMode;
      location: LocationKey;
      bookingId: string;
      lotId: string | null;
      lotExpiresAt: string | null;
      now: Date;
    },
  ): Promise<void> {
    const lotAlive =
      args.lotId !== null && (args.lotExpiresAt === null || new Date(args.lotExpiresAt) > args.now);

    const expiresAt =
      args.lotId !== null && !lotAlive ? resolveRefundExpiry(args.location, args.now) : null;
    // Return to the original lot only when it's still alive; otherwise this row
    // is itself a source (lot_id null) — a pool restore (expiresAt null) or a
    // fresh lot (expiresAt set).
    const lotId = lotAlive ? args.lotId : null;

    await tx.insert(creditLedger).values({
      dogId: args.dogId,
      mode: args.mode,
      location: args.location,
      delta: 1,
      reason: 'cancel-refund',
      bookingId: args.bookingId,
      lotId,
      expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
    });
  },

  /**
   * INSERT one `purchase` lot crediting a dog with the package's credit count
   * after a Stripe charge succeeds. `package_id` ties the row to the exact
   * priced catalog version; `charge_id` ties it to the charge so the audit
   * trail joins purchase → charge → Stripe PaymentIntent end-to-end.
   * `expiresAt` is the lot's stamped expiry (null = never; see
   * `lib/creditExpiry.ts`). Multi-credit purchases are ONE row with
   * `delta = credits` (the lot is the unit of expiry).
   */
  async creditPurchase(
    tx: Tx,
    args: {
      dogId: string;
      mode: BookingMode;
      location: LocationKey;
      delta: number;
      packageId: string;
      chargeId: string;
      expiresAt: Date | null;
    },
  ): Promise<void> {
    await tx.insert(creditLedger).values({
      dogId: args.dogId,
      mode: args.mode,
      location: args.location,
      delta: args.delta,
      reason: 'purchase',
      packageId: args.packageId,
      chargeId: args.chargeId,
      expiresAt: args.expiresAt === null ? null : args.expiresAt.toISOString(),
    });
  },
};

/** One booking-debit row + the source lot it drew from, for the refund router. */
export interface BookingDebitForRefund {
  dogId: string;
  mode: BookingMode;
  location: LocationKey;
  /** Source lot this debit drew from; null = the never-expiring pool. */
  lotId: string | null;
  /** Source lot's expiry (ISO); null when lotId is null or the lot never expires. */
  lotExpiresAt: string | null;
}
