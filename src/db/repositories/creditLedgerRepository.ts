import { and, eq, sql } from 'drizzle-orm';
import { creditLedger, LOCATION_SLUGS } from '../schema/schema.js';
import type { BookingMode } from '../../lib/bookingMode.js';
import type { Tx } from '../tx.js';

type LocationKey = (typeof LOCATION_SLUGS)[number];

/**
 * Data-access seam for `credit_ledger` (schema.sql:645). Append-only by
 * design — no `expired_at` column, no soft-expire (corrections happen
 * via reversing entries, not edits). The view `dog_credit_balance`
 * (schema.sql:663) is the canonical balance read: `SUM(delta) GROUP BY
 * (dog_id, mode)` over the ledger.
 *
 * Day 10 introduces the first write here — `booking-debit` rows (delta
 * = -1) per (dog, mode, booking) inside `bookSession`. The
 * `withDogModeLock(dogId, mode)` advisory lock acquired by the
 * route serializes concurrent debits on the same (dog, mode) pair so the
 * post-debit balance assertion is race-free. The balance read happens
 * INSIDE the same tx (`balanceForDogInTx`) so the freshly-inserted debit
 * is visible — Redis caching CANNOT serve this read; the cache is for
 * the public `GET /dogs/:id/credits` path only (Day 8 §3 map).
 *
 * Future Day 13 / Day 14 reasons:
 *   - 'cancel-refund' (+1) — Day 13 cancel txn within the free window
 *   - 'purchase'      (+N) — Day 14 package purchase via Stripe charge
 *   - 'adjustment'    (±N) — Day 19 staff portal manual correction
 *   - 'membership-grant' (+N) — Day 14 membership-renewal worker
 *
 * Every reason corresponds to a constructor — adding reasons here keeps
 * the audit story coherent (a future reader sees what produces each
 * ledger family). Today: only `debit` exists.
 */

export const creditLedgerRepository = {
  /**
   * INSERT one booking-debit row (delta = -1) inside the open tx.
   * Caller is responsible for having acquired
   * `withDogModeLock(tx, dogId, mode, ...)` first — without that lock,
   * two concurrent bookSession transactions for the same (dog, mode)
   * could each pass a post-balance ≥ 0 assertion against a snapshot
   * that hadn't yet seen the other's debit.
   *
   * The schema doesn't enforce delta = -1 for reason='booking-debit',
   * but the API does — every booking debits exactly one credit per
   * (dog, mode, date). Multi-date bookings produce N debit rows, one
   * per date.
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
    await tx.insert(creditLedger).values({
      dogId: args.dogId,
      mode: args.mode,
      location: args.location,
      delta: -1,
      reason: 'booking-debit',
      bookingId: args.bookingId,
    });
  },

  /**
   * Per-(dog, mode) balance read INSIDE the open tx, materialized
   * directly off `credit_ledger` (not via the `dog_credit_balance` view).
   * Reading the view would be equivalent semantically but uses an
   * extra layer of indirection; the SUM is one indexed scan over the
   * partition for this (dog_id, mode), which is faster and simpler to
   * reason about under the advisory lock.
   *
   * `null` returned when the dog has zero ledger rows for this mode
   * (a freshly-provisioned dog) — semantically equivalent to balance=0,
   * but distinguishing lets callers detect "no ledger activity yet" if
   * they ever need to. Today the caller (`bookSession` post-debit
   * assertion) coalesces null→0 inline.
   *
   * Returns the SIGNED sum; callers asserting "balance ≥ 0" should pass
   * the result of this AFTER inserting the debit (so the post-debit
   * balance is what's checked).
   */
  async balanceForDogInTx(
    tx: Tx,
    dogId: string,
    mode: BookingMode,
    location: LocationKey,
  ): Promise<number | null> {
    const [row] = await tx
      .select({
        balance: sql<number | null>`SUM(${creditLedger.delta})::int`.as('balance'),
      })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.dogId, dogId),
          eq(creditLedger.mode, mode),
          eq(creditLedger.location, location),
        ),
      );
    return row?.balance ?? null;
  },

  /**
   * Day 13 — every `booking-debit` row for one booking. Used by the cancel
   * txn to determine (a) was this booking credit-paid? (non-empty result),
   * and (b) which (dog, mode) pairs to credit back, one per debit row.
   *
   * Multi-dog day-school + day-care bookings produced N debit rows (one
   * per dog). Multi-DATE bookings live as separate booking rows (Day 10
   * iterates per date), so this function reads only the debits for THIS
   * single booking_id.
   *
   * Append-only — no `live()` filter. The credit_ledger has no expired_at.
   */
  async findDebitsForBooking(
    tx: Tx,
    bookingId: string,
  ): Promise<{ dogId: string; mode: BookingMode; location: LocationKey }[]> {
    return tx
      .select({
        dogId: creditLedger.dogId,
        mode: creditLedger.mode,
        location: creditLedger.location,
      })
      .from(creditLedger)
      .where(and(eq(creditLedger.bookingId, bookingId), eq(creditLedger.reason, 'booking-debit')));
  },

  /**
   * Day 13 — INSERT one +1 `cancel-refund` row to reverse a prior
   * `booking-debit`. Append-only: the original debit row stays, the
   * refund row counterbalances it, so the dog's balance recomputes to
   * its pre-booking value via `SUM(delta)`. Audit trail captures both.
   *
   * One row per (dog, mode) pair from the original debits — multi-dog
   * bookings need N refund rows. Caller iterates `findDebitsForBooking`.
   */
  async refundForBooking(
    tx: Tx,
    args: {
      dogId: string;
      mode: BookingMode;
      location: LocationKey;
      bookingId: string;
    },
  ): Promise<void> {
    await tx.insert(creditLedger).values({
      dogId: args.dogId,
      mode: args.mode,
      location: args.location,
      delta: 1,
      reason: 'cancel-refund',
      bookingId: args.bookingId,
    });
  },

  /**
   * Day 14 — INSERT one `purchase` row crediting a dog with the package's
   * credit count after a Stripe charge succeeds. `delta` is positive
   * (grant); `package_id` ties the row back to the exact effective-dated
   * catalog row (price) that sourced it; `charge_id` ties it back to the
   * charges row so the audit trail joins purchase → charge → Stripe
   * PaymentIntent end-to-end.
   *
   * Called inside the POST /credit-packages/:key/purchase txn AFTER the
   * Stripe `paymentIntents.create + confirm` returns succeeded and AFTER
   * the `charges` INSERT lands. Multi-credit purchases produce ONE row
   * with `delta = credits`, not N rows of `delta = 1` (the schema's
   * `SUM(delta)` view recomputes either way; one row is cleaner audit).
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
    });
  },
};
