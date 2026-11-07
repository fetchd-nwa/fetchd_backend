import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { CreditTier } from '../../contracts/wire.js';
import { bucketChicagoToday } from '../../lib/chicagoDate.js';
import { addChicagoMonths } from '../../lib/creditExpiry.js';
import { db } from '../client.js';
import {
  creditLedger,
  creditLotExpiryEdits,
  ownerCreditBalance,
  type LocationKey,
} from '../schema/schema.js';
import type { BookingMode } from '../../lib/bookingMode.js';
import { settingsRepository } from './settingsRepository.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `credit_ledger`. Append-only by design: corrections are
 * reversing entries, never edits.
 *
 * Credits are the owner's, one **pool** per (owner, location, mode, tier), modeled as
 * lots:
 *   - A grant (delta>0, lot_id NULL) is a lot, and `expires_at` is when it stops
 *     counting. Stamped once, at grant.
 *   - A `booking-debit` (delta=-1) names the lot that paid it, and `dog_id` on it is the
 *     dog served. M4.10's composite FK ties a row to its lot's pool, so a debit cannot
 *     spend another owner's lot.
 *   - A `cancel-refund` (+1) goes back to the lot it came from while that lot can pay a
 *     later date, and is otherwise a fresh lot (§2.4:2961-2966).
 *   - Balance counts only live lots: `owner_credit_balance`, which is `lot_is_live`.
 *     A lot pays a date only where `lot_pays_date` holds.
 *
 * Concurrency: the pool's advisory lock (`db/locks.ts`) serialises everything that reads
 * a pool to spend from it, so what the picker reads holds until its debits commit.
 */

/** One pool: the unit a booking spends from and a purchase lands in. */
export interface CreditPool {
  ownerId: string;
  location: LocationKey;
  mode: BookingMode;
  tier: CreditTier;
}

/** A live lot with credits left. */
export interface LiveLot {
  id: string;
  mode: BookingMode;
  tier: CreditTier;
  /** Postgres's timestamptz text, as the raw read returns it. */
  expiresAt: string;
  remaining: number;
}

/**
 * Every live lot of one owner at one campus with credits left, soonest-expiring first,
 * `remaining` being the grant plus every allocation tagged to it. Polymorphic runner:
 * pass the booking `Tx` under the pool lock to see its own debits; pass the pool `db`
 * for the public read.
 */
export async function findLiveLots(
  runner: Tx | typeof db,
  args: { ownerId: string; location: LocationKey; mode?: BookingMode; tier?: CreditTier },
): Promise<LiveLot[]> {
  const modeClause = args.mode ? sql`AND lot.mode = ${args.mode}` : sql``;
  const tierClause = args.tier ? sql`AND lot.tier = ${args.tier}` : sql``;
  const result = await runner.execute(sql`
    SELECT lot.id, lot.mode, lot.tier, lot.expires_at AS "expiresAt",
           (lot.delta + COALESCE(a.alloc, 0))::int AS remaining
    FROM credit_ledger lot
    LEFT JOIN (
      SELECT lot_id, SUM(delta) AS alloc
      FROM credit_ledger
      WHERE lot_id IS NOT NULL AND owner_id = ${args.ownerId}
      GROUP BY lot_id
    ) a ON a.lot_id = lot.id
    WHERE lot.owner_id = ${args.ownerId}
      AND lot.location = ${args.location}
      ${modeClause}
      ${tierClause}
      AND lot.delta > 0
      AND lot.lot_id IS NULL
      AND lot_is_live(lot.expires_at)
      AND (lot.delta + COALESCE(a.alloc, 0)) > 0
    ORDER BY lot.expires_at ASC, lot.created_at ASC
  `);
  // Raw SQL boundary: the SELECT projects exactly these five. (The `Tx | db` union
  // widens `.rows` to Record<string, unknown>, so the cast routes through `unknown`.)
  return result.rows as unknown as LiveLot[];
}

/** A live lot of one pool, and the dates of a request it can pay. */
export interface PayableLot extends LiveLot {
  paysDates: string[];
}

/**
 * One pool's live lots for the picker, soonest-expiring first, each with the dates
 * `lot_pays_date` holds on. Under the pool lock, in the booking's transaction. The dates
 * cross as one comma-joined parameter because a Drizzle template expands an array into a
 * list; they are the route's validated `YYYY-MM-DD`.
 */
export async function findPayableLots(
  tx: Tx,
  pool: CreditPool,
  dates: readonly string[],
): Promise<PayableLot[]> {
  const lots = await findLiveLots(tx, pool);
  if (lots.length === 0) return [];
  const result = await tx.execute(sql`
    SELECT lot.id, d::text AS date
      FROM credit_ledger lot
     CROSS JOIN unnest(string_to_array(${dates.join(',')}, ',')::date[]) AS d
     WHERE lot.owner_id = ${pool.ownerId}
       AND lot.location = ${pool.location}
       AND lot.mode = ${pool.mode}
       AND lot.tier = ${pool.tier}
       AND lot.delta > 0
       AND lot.lot_id IS NULL
       AND lot_pays_date(lot.expires_at, d)
  `);
  const pays = new Map<string, string[]>();
  for (const row of result.rows as { id: string; date: string }[]) {
    pays.set(row.id, [...(pays.get(row.id) ?? []), row.date]);
  }
  return lots.map((lot) => ({ ...lot, paysDates: pays.get(lot.id) ?? [] }));
}

export const creditLedgerRepository = {
  /**
   * INSERT one `booking-debit` for the dog served, from the lot the picker chose. M4.10's
   * composite FK refuses a lot of any other pool. Under the pool lock.
   */
  async debitLot(
    tx: Tx,
    args: CreditPool & { lotId: string; dogId: string; bookingId: string },
  ): Promise<void> {
    await tx.insert(creditLedger).values({
      ownerId: args.ownerId,
      dogId: args.dogId,
      mode: args.mode,
      location: args.location,
      tier: args.tier,
      delta: -1,
      reason: 'booking-debit',
      bookingId: args.bookingId,
      lotId: args.lotId,
    });
  },

  /** One pool's live balance, read in the open transaction so it sees its own debits. */
  async poolBalanceInTx(tx: Tx, pool: CreditPool): Promise<number> {
    const [row] = await tx
      .select({ balance: ownerCreditBalance.balance })
      .from(ownerCreditBalance)
      .where(
        and(
          eq(ownerCreditBalance.ownerId, pool.ownerId),
          eq(ownerCreditBalance.location, pool.location),
          eq(ownerCreditBalance.mode, pool.mode),
          eq(ownerCreditBalance.tier, pool.tier),
        ),
      );
    return row?.balance ?? 0;
  },

  /**
   * Every `booking-debit` of one booking, with the lot it drew from. Append-only: no
   * `live()` filter.
   */
  async findDebitsForBooking(tx: Tx, bookingId: string): Promise<BookingDebitForRefund[]> {
    const result = await tx.execute(sql`
      SELECT d.owner_id, d.dog_id, d.mode, d.location, d.tier, d.lot_id
      FROM credit_ledger d
      WHERE d.booking_id = ${bookingId} AND d.reason = 'booking-debit'
    `);
    return (
      result.rows as {
        owner_id: string;
        dog_id: string | null;
        mode: BookingMode;
        location: LocationKey;
        tier: CreditTier;
        lot_id: string;
      }[]
    ).map((r) => ({
      ownerId: r.owner_id,
      dogId: r.dog_id,
      mode: r.mode,
      location: r.location,
      tier: r.tier,
      lotId: r.lot_id,
    }));
  },

  /**
   * INSERT one +1 `cancel-refund` reversing a `booking-debit` (CRED-U16; design
   * §2.4:2955-2966). It goes back to its lot, keeping that lot's date, while the lot can
   * still pay a date after today. A lot that cannot, already past its date or passing it
   * before midnight since a lot pays its own last day and dies that day, takes it instead
   * as a fresh one-credit lot, `cred.returned_credit_expiry_months` from the return. At 0
   * it goes into the old lot, its date passed, and §2.9's copy says so. Append-only: the
   * debit stays, and this row counterbalances it. Under the pool lock.
   */
  async refundForBooking(
    tx: Tx,
    args: BookingDebitForRefund & { bookingId: string; now: Date },
  ): Promise<void> {
    const { returned_credit_expiry_months: months } = await settingsRepository.credit(tx);
    const back = months === 0 || (await lotPaysAfterToday(tx, args.lotId, args.now));
    await tx.insert(creditLedger).values({
      ownerId: args.ownerId,
      dogId: args.dogId,
      mode: args.mode,
      location: args.location,
      tier: args.tier,
      delta: 1,
      reason: 'cancel-refund',
      bookingId: args.bookingId,
      lotId: back ? args.lotId : null,
      expiresAt: back ? null : addChicagoMonths(args.now, months).toISOString(),
    });
  },

  /**
   * The grant, the one statement every settle shares: one lot of the charge's own frozen
   * purchase, in the pool of the row it bought, written only while the charge reads
   * `succeeded`, so a late success on a `failed` charge grants nothing. It reads the charge's
   * lot back, or answers `undefined` when there is none.
   *
   * The settle reaches this only for a charge it moved from `requires_payment`, under the
   * charge lock, so no settler writes a second lot. M4.09's partial index is what holds if
   * anything else ever does, and `ON CONFLICT` repeats its predicate because Postgres infers
   * a partial index only then: without it this answers 42P10 after Stripe has the money. A
   * lot already on the charge stands, with its own date, and is the one read back.
   */
  async grantChargeLot(
    tx: Tx,
    args: { chargeId: string; expiresAt: Date },
  ): Promise<GrantedLot | undefined> {
    await tx.execute(sql`
      INSERT INTO credit_ledger
        (owner_id, location, mode, tier, delta, reason, package_id, charge_id, expires_at)
      SELECT c.owner_id, p.location, p.mode, p.tier, c.credits_count, 'purchase', c.package_id,
             c.id, ${args.expiresAt.toISOString()}::timestamptz
        FROM charges c
        JOIN credit_packages p ON p.id = c.package_id
       WHERE c.id = ${args.chargeId} AND c.status = 'succeeded'
      ON CONFLICT (charge_id) WHERE reason = 'purchase' DO NOTHING
    `);
    const result = await tx.execute(sql`
      SELECT lot.id, lot.owner_id AS "ownerId", lot.location, lot.mode, lot.tier,
             lot.delta AS credits, lot.expires_at AS "expiresAt"
        FROM credit_ledger lot
       WHERE lot.charge_id = ${args.chargeId} AND lot.reason = 'purchase'
    `);
    return result.rows[0] as GrantedLot | undefined;
  },

  /** One owner's live balance in each pool. A pool whose lots are all dead has no row. */
  async ownerBalances(
    runner: Tx | typeof db,
    ownerId: string,
  ): Promise<(Omit<CreditPool, 'ownerId'> & { balance: number })[]> {
    const rows = await runner
      .select({
        location: ownerCreditBalance.location,
        mode: ownerCreditBalance.mode,
        tier: ownerCreditBalance.tier,
        balance: ownerCreditBalance.balance,
      })
      .from(ownerCreditBalance)
      .where(eq(ownerCreditBalance.ownerId, ownerId));
    // A view's columns read nullable, and these group by NOT NULL columns.
    return rows as (Omit<CreditPool, 'ownerId'> & { balance: number })[];
  },

  /** A lot's unspent, under its pool lock: the grant plus every allocation, live or not. */
  async lotUnspentInTx(tx: Tx, lotId: string): Promise<number> {
    const result = await tx.execute(sql`
      SELECT SUM(delta)::int AS unspent FROM credit_ledger WHERE id = ${lotId} OR lot_id = ${lotId}
    `);
    return (result.rows[0] as { unspent: number }).unspent;
  },

  /** A hand add: a grant lot of the pool, with the staffer and the reason (CRED-U14). */
  async addHandLot(
    tx: Tx,
    args: CreditPool & { credits: number; expiresAt: Date; note: string; staffId: string },
  ): Promise<void> {
    await tx.insert(creditLedger).values({
      ownerId: args.ownerId,
      location: args.location,
      mode: args.mode,
      tier: args.tier,
      delta: args.credits,
      reason: 'adjustment',
      expiresAt: args.expiresAt.toISOString(),
      note: args.note,
      createdByStaffId: args.staffId,
    });
  },

  /** A hand remove: one row against the lot. The caller holds the pool and checked the unspent. */
  async removeFromLot(
    tx: Tx,
    args: { lot: GrantLot; credits: number; note: string; staffId: string },
  ): Promise<void> {
    const { lot } = args;
    await tx.insert(creditLedger).values({
      ownerId: lot.ownerId,
      location: lot.location,
      mode: lot.mode,
      tier: lot.tier,
      delta: -args.credits,
      reason: 'adjustment',
      lotId: lot.id,
      note: args.note,
      createdByStaffId: args.staffId,
    });
  },

  /**
   * Move a lot's date, and record the move from the locked read, so a lot's dates chain
   * (CRED-U15). The caller holds the pool. `no key update`, not the design's `FOR UPDATE`:
   * a lot is a parent every debit's FK check reaches with `KEY SHARE`, and two moves still
   * serialise, since that strength conflicts with itself (DECISIONS 155(a)).
   */
  async moveLotExpiry(
    tx: Tx,
    args: { lotId: string; to: Date; note: string; staffId: string },
  ): Promise<void> {
    const [locked] = await tx
      .select({ expiresAt: creditLedger.expiresAt })
      .from(creditLedger)
      .where(eq(creditLedger.id, args.lotId))
      .limit(1)
      .for('no key update');
    if (locked?.expiresAt == null) {
      throw new Error(`lot ${args.lotId} lost its date under its own pool lock`);
    }
    const to = args.to.toISOString();
    await tx.update(creditLedger).set({ expiresAt: to }).where(eq(creditLedger.id, args.lotId));
    await tx.insert(creditLotExpiryEdits).values({
      lotId: args.lotId,
      fromExpiresAt: locked.expiresAt,
      toExpiresAt: to,
      staffId: args.staffId,
      note: args.note,
    });
  },

  /**
   * Every slot of one order nothing has paid yet: what the settle's bought lot spends,
   * dates ascending. A slot is one dog on one row; a slot tx1 debited has a debit naming
   * that dog on that row.
   */
  async findUnpaidSlots(
    tx: Tx,
    orderId: string,
  ): Promise<{ bookingId: string; dogId: string; date: string }[]> {
    const result = await tx.execute(sql`
      SELECT b.id AS "bookingId", bd.dog_id AS "dogId",
             (b.scheduled_at AT TIME ZONE 'America/Chicago')::date::text AS date
        FROM bookings b
        JOIN booking_dogs bd ON bd.booking_id = b.id
       WHERE b.order_id = ${orderId}
         AND NOT EXISTS (
           SELECT 1 FROM credit_ledger l
            WHERE l.booking_id = b.id AND l.dog_id = bd.dog_id AND l.reason = 'booking-debit')
       ORDER BY b.scheduled_at, bd.dog_id
    `);
    return result.rows as { bookingId: string; dogId: string; date: string }[];
  },
};

/** One grant row, live or dead: what a hand edit names, and the pool it locks. */
export interface GrantLot extends CreditPool {
  id: string;
}

/**
 * The grant row a staffer named, or nothing for an id that is no grant: a debit, a return
 * to a lot, an unknown id.
 */
export async function findGrantLot(tx: Tx, lotId: string): Promise<GrantLot | undefined> {
  const [row] = await tx
    .select({
      id: creditLedger.id,
      ownerId: creditLedger.ownerId,
      location: creditLedger.location,
      mode: creditLedger.mode,
      tier: creditLedger.tier,
    })
    .from(creditLedger)
    .where(and(eq(creditLedger.id, lotId), gt(creditLedger.delta, 0), isNull(creditLedger.lotId)))
    .limit(1);
  return row;
}

/** One lot as staff read it: the row behind `CreditLotDetailWire`, and its pool. */
export interface LotDetailRow extends CreditPool {
  id: string;
  reason: 'purchase' | 'adjustment' | 'cancel-refund';
  granted: number;
  remaining: number;
  created_at: string;
  expires_at: string;
  live: boolean;
  package_id: string | null;
  charge_id: string | null;
  note: string | null;
  created_by_staff_id: string | null;
  edit_from: string | null;
  edit_to: string | null;
  edit_staff_id: string | null;
  edit_note: string | null;
  edit_at: string | null;
  booked_dates: string[];
}

/**
 * Every lot of one owner, newest first, spent and expired included, narrowed to one pool or
 * one lot when the write asks. `remaining` is the grant plus every allocation, whether or
 * not the lot is live, and `live` is `lot_is_live`, at read. `booked_dates` is one Chicago
 * date per debit on a row still to come, so a cancelled day is not in it.
 */
export async function findLotDetails(
  runner: Tx | typeof db,
  args: { ownerId: string; today: string; pool?: CreditPool; lotId?: string },
): Promise<LotDetailRow[]> {
  const { ownerId, today, pool, lotId } = args;
  const poolClause = pool
    ? sql`AND lot.location = ${pool.location} AND lot.mode = ${pool.mode} AND lot.tier = ${pool.tier}`
    : sql``;
  const lotClause = lotId ? sql`AND lot.id = ${lotId}` : sql``;
  const result = await runner.execute(sql`
    SELECT lot.id, lot.owner_id AS "ownerId", lot.location, lot.mode, lot.tier, lot.reason,
           lot.delta AS granted, (lot.delta + COALESCE(spent.total, 0))::int AS remaining,
           lot.created_at, lot.expires_at, lot_is_live(lot.expires_at) AS live,
           lot.package_id, lot.charge_id, lot.note, lot.created_by_staff_id,
           edit.from_expires_at AS edit_from, edit.to_expires_at AS edit_to,
           edit.staff_id AS edit_staff_id, edit.note AS edit_note, edit.created_at AS edit_at,
           COALESCE(ahead.dates, ARRAY[]::text[]) AS booked_dates
      FROM credit_ledger lot
      LEFT JOIN LATERAL (
        SELECT SUM(a.delta) AS total FROM credit_ledger a WHERE a.lot_id = lot.id
      ) spent ON true
      LEFT JOIN LATERAL (
        SELECT e.from_expires_at, e.to_expires_at, e.staff_id, e.note, e.created_at
          FROM credit_lot_expiry_edits e
         WHERE e.lot_id = lot.id
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT 1
      ) edit ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(day.date ORDER BY day.date) AS dates
          FROM (
            SELECT to_char(b.scheduled_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS date
              FROM credit_ledger d
              JOIN bookings b ON b.id = d.booking_id
             WHERE d.lot_id = lot.id
               AND d.reason = 'booking-debit'
               AND b.status IN ('upcoming', 'payment-pending')
               AND (b.scheduled_at AT TIME ZONE 'America/Chicago')::date >= ${today}::date
          ) day
      ) ahead ON true
     WHERE lot.owner_id = ${ownerId}
       AND lot.delta > 0
       AND lot.lot_id IS NULL
       ${poolClause}
       ${lotClause}
     ORDER BY lot.created_at DESC, lot.id DESC
  `);
  return result.rows as unknown as LotDetailRow[];
}

/** The lot {@link creditLedgerRepository.grantChargeLot} read back. */
export interface GrantedLot extends CreditPool {
  id: string;
  credits: number;
  /** Postgres's timestamptz text, as the raw read returns it. */
  expiresAt: string;
}

/**
 * Can this lot still pay a date after today? `now` is the caller's cancel instant, on
 * Chicago's calendar; `lot_pays_date` is the one predicate that answers.
 */
async function lotPaysAfterToday(tx: Tx, lotId: string, now: Date): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT lot_pays_date(lot.expires_at, (${bucketChicagoToday(now)}::date + 1)) AS pays
      FROM credit_ledger lot
     WHERE lot.id = ${lotId}
  `);
  return (result.rows[0] as { pays: boolean | null } | undefined)?.pays === true;
}

/** One `booking-debit` and the lot it drew from, for the return. */
export interface BookingDebitForRefund {
  ownerId: string;
  /** The dog served. */
  dogId: string | null;
  mode: BookingMode;
  location: LocationKey;
  tier: CreditTier;
  lotId: string;
}
