import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { creditLedger, dogCreditBalance, type LocationKey } from '../schema/schema.js';
import type { BookingMode } from '../../lib/bookingMode.js';
import { resolveRefundExpiry } from '../../lib/creditExpiry.js';
import { creditExpirySettingsRepository } from './creditExpirySettingsRepository.js';
import type { Tx } from '../tx.js';

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
 * (remaining ≤ 0). Feeds the public `GET /credits` expiring-lots read
 * (`creditsRepository.findExpiringLots`) and the expiry-warning scan; debit
 * selection has its own priority order — see `findNextDebitLot`.
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

/**
 * The lot the NEXT booking debit should draw from — subscription credits
 * first (RULED 2026-07-14, Allison: "use subscription credits first before
 * normal credits"), then everything else soonest-expiry first, never-expiring
 * purchase lots last (the untagged pool). Priority:
 *
 *   1. `membership-grant` lots, soonest-expiry first; an alumni membership
 *      lot (expires_at NULL) sorts after that dog's expiring membership lots
 *      but still ahead of every non-membership lot,
 *   2. other live expiring lots, soonest-expiry first (unchanged FIFO),
 *   3. no row → the never-expiring pool (caller tags the debit lot_id NULL).
 *
 * `created_at ASC` breaks expiry ties deterministically. Caller must hold
 * `withDogModeLock` (same contract as `debitForBooking`).
 */
async function findNextDebitLot(
  tx: Tx,
  args: { dogId: string; location: LocationKey; mode: BookingMode },
): Promise<{ id: string } | undefined> {
  const result = await tx.execute(sql`
    SELECT lot.id
    FROM credit_ledger lot
    LEFT JOIN (
      SELECT lot_id, SUM(delta) AS alloc
      FROM credit_ledger
      WHERE lot_id IS NOT NULL
      GROUP BY lot_id
    ) a ON a.lot_id = lot.id
    WHERE lot.dog_id = ${args.dogId}
      AND lot.location = ${args.location}
      AND lot.mode = ${args.mode}
      AND lot.delta > 0
      AND lot.lot_id IS NULL
      AND (
        (lot.expires_at IS NOT NULL AND lot.expires_at > now())
        OR (lot.expires_at IS NULL AND lot.reason = 'membership-grant')
      )
      AND (lot.delta + COALESCE(a.alloc, 0)) > 0
    ORDER BY (lot.reason = 'membership-grant') DESC,
             lot.expires_at ASC NULLS LAST,
             lot.created_at ASC
    LIMIT 1
  `);
  // Raw SQL boundary: the SELECT projects exactly { id }.
  return (result.rows as unknown as { id: string }[])[0];
}

/** A live, non-exhausted expiring lot that is WITHIN its location's warning
 * window, plus the owner to warn. Cross-owner — drives the credits-expiring
 * scheduled scan, not a per-dog read. */
export interface ExpiringLotForWarning {
  lotId: string;
  ownerId: string;
  dogId: string;
  location: LocationKey;
  mode: BookingMode;
  /** ISO timestamp — always set (never-expiring + expired lots are excluded). */
  expiresAt: string;
  remaining: number;
}

/**
 * Cross-owner scan for the credits-expiring warning: live, non-exhausted
 * EXPIRING lots whose `expires_at` falls at-or-before their LOCATION's cutoff
 * (now + that location's `warning_lead_days`). Reuses the canonical live-lot
 * predicate from `findLiveExpiringLots` (delta>0, lot_id NULL, not expired, not
 * exhausted) and adds: (a) a per-location `expires_at <= cutoff` filter — the
 * warning window is per-location, so the caller resolves each location's cutoff
 * and passes the map; (b) a join to `dogs.owner_id` so the scan knows who to
 * warn, EXCLUDING staff-owned dogs (owner_id NULL — no owner to notify).
 *
 * `cutoffByLocation` is `{ [slug]: ISO-cutoff }`. A location absent from the map
 * is skipped entirely (its lots are not scanned). Empty map → no rows.
 *
 * Pool runner (the scan reads outside any tx, mirroring the booking-reminder
 * scan); ordered by `expires_at` ASC so the soonest-expiring is enqueued first.
 */
export async function findExpiringLotsForWarning(
  runner: Tx | typeof db,
  cutoffByLocation: Partial<Record<LocationKey, string>>,
): Promise<ExpiringLotForWarning[]> {
  const entries = Object.entries(cutoffByLocation) as [LocationKey, string][];
  if (entries.length === 0) return [];

  // One OR-arm per location: (location = slug AND expires_at <= its cutoff).
  // Parameterized — slug + cutoff are bound, never interpolated.
  const locationCutoffClauses = entries.map(
    ([slug, cutoff]) => sql`(lot.location = ${slug} AND lot.expires_at <= ${cutoff}::timestamptz)`,
  );
  const cutoffClause = sql.join(locationCutoffClauses, sql` OR `);

  const result = await runner.execute(sql`
    SELECT lot.id AS "lotId", d.owner_id AS "ownerId", lot.dog_id AS "dogId",
           lot.location, lot.mode, lot.expires_at AS "expiresAt",
           (lot.delta + COALESCE(a.alloc, 0))::int AS remaining
    FROM credit_ledger lot
    JOIN dogs d ON d.id = lot.dog_id
    LEFT JOIN (
      SELECT lot_id, SUM(delta) AS alloc
      FROM credit_ledger
      WHERE lot_id IS NOT NULL
      GROUP BY lot_id
    ) a ON a.lot_id = lot.id
    WHERE lot.delta > 0
      AND lot.lot_id IS NULL
      AND lot.expires_at IS NOT NULL
      AND lot.expires_at > now()
      AND d.owner_id IS NOT NULL
      AND (lot.delta + COALESCE(a.alloc, 0)) > 0
      AND (${cutoffClause})
    ORDER BY lot.expires_at ASC
  `);
  // Raw SQL boundary: the SELECT projects exactly the ExpiringLotForWarning
  // shape. (The Tx | db union widens .rows, so route through unknown.)
  return result.rows as unknown as ExpiringLotForWarning[];
}

export const creditLedgerRepository = {
  /**
   * INSERT one booking-debit row (delta = -1) inside the open tx, tagged with
   * the priority source lot (or NULL for the never-expiring pool). Caller must
   * hold `withDogModeLock(tx, dogId, mode, location)` first — without it, two
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
    // Subscription credits first, then soonest-expiry, pool last — see
    // findNextDebitLot for the full priority order.
    const lot = await findNextDebitLot(tx, {
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
      /** §J.3: an alumni dog's freshly-minted refund lot never expires. */
      dogIsAlumni: boolean;
    },
  ): Promise<void> {
    const lotAlive =
      args.lotId !== null && (args.lotExpiresAt === null || new Date(args.lotExpiresAt) > args.now);

    // A fresh refund lot is needed only when the source lot died; resolve the
    // current window (per-location → org-default → code default) for THAT case
    // alone — skip the read on the common return-to-live-lot path. Alumni dogs
    // (§J.3) skip the window entirely: their re-mint is never-expire.
    const expiresAt =
      args.lotId !== null && !lotAlive && !args.dogIsAlumni
        ? resolveRefundExpiry(
            await creditExpirySettingsRepository.resolveExpiryWindowMonths(args.location, tx),
            args.now,
          )
        : null;
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
      /** §J.1: a subscription month's grant is 'membership-grant'; one-time
       * purchases (the default) stay 'purchase'. Same lot semantics either way. */
      reason?: 'purchase' | 'membership-grant';
    },
  ): Promise<void> {
    await tx.insert(creditLedger).values({
      dogId: args.dogId,
      mode: args.mode,
      location: args.location,
      delta: args.delta,
      reason: args.reason ?? 'purchase',
      packageId: args.packageId,
      chargeId: args.chargeId,
      expiresAt: args.expiresAt === null ? null : args.expiresAt.toISOString(),
    });
  },

  /**
   * §J.1 pause-resume: move a membership-grant lot's expiry with the shifted
   * period. The paid month's lot was stamped `expires_at = current_period_end`
   * at grant; when staff resume a paused membership the period end shifts
   * forward by the pause gap, and the lot must follow — otherwise the paid
   * credits die at the ORIGINAL boundary while the membership is officially
   * paused ("the clock stops" must cover the credits, not just the billing).
   * Matched by the exact old expiry so only the shifted period's lot moves
   * (alumni lots are NULL and never match). Returns the lots touched.
   */
  async shiftMembershipGrantExpiry(
    tx: Tx,
    args: { dogId: string; fromExpiresAt: string; to: Date },
  ): Promise<number> {
    const rows = await tx
      .update(creditLedger)
      .set({ expiresAt: args.to.toISOString() })
      .where(
        and(
          eq(creditLedger.dogId, args.dogId),
          eq(creditLedger.reason, 'membership-grant'),
          isNull(creditLedger.lotId),
          gt(creditLedger.delta, 0),
          eq(creditLedger.expiresAt, args.fromExpiresAt),
        ),
      )
      .returning({ id: creditLedger.id });
    return rows.length;
  },

  /**
   * §J.3 became-alumni effect: clear `expires_at` on the dog's live, not-yet-
   * expired lots — "if you are alumni, no expiration date" covers credits the
   * dog already holds, not just future grants. Already-EXPIRED lots stay dead
   * (alumni doesn't resurrect spent windows). Returns the lots touched.
   */
  async clearExpiryForDog(tx: Tx, dogId: string, now: Date): Promise<number> {
    const rows = await tx
      .update(creditLedger)
      .set({ expiresAt: null })
      .where(
        and(
          eq(creditLedger.dogId, dogId),
          isNull(creditLedger.lotId),
          gt(creditLedger.delta, 0),
          isNotNull(creditLedger.expiresAt),
          gt(creditLedger.expiresAt, now.toISOString()),
        ),
      )
      .returning({ id: creditLedger.id });
    return rows.length;
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
