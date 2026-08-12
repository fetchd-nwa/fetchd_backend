import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { ne } from 'drizzle-orm';
import { db } from '../client.js';
import { refunds } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx ops, Tx for in-mutation work. */
type Runner = Tx | typeof db;

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

/**
 * Data-access seam for `refunds` (schema.sql ~line 778). Append-only
 * retained financial record — one row per refund attempt against a
 * prior Stripe charge. Status transitions only (no `expired_at`):
 *   'pending' → Stripe API call queued post-commit
 *   'succeeded' → webhook flips this on confirmed refund
 *   'failed' → webhook flips this if Stripe rejects
 *
 * The cumulative-refund→`charges.refunded` rule (DATA-CONTRACT §I) is
 * API logic, not a schema invariant: the webhook handler sums all
 * succeeded refunds for a charge_id and flips `charges.status` to
 * 'refunded' only when the sum equals the charge amount. Partial
 * refunds are allowed.
 *
 * Lifecycle by day:
 *   - Day 13: `createPending` from the cancel-money-back branch.
 *   - Day 14: stripe.createRefund fires post-commit against the prior PI.
 *   - Day 15: `markStripeId` lands the `re_*` on the row post-commit;
 *             `findByStripeRefundId` / `markStatus` are the webhook
 *             entry points; `sumSucceededForCharge` powers the
 *             cumulative → `charges.refunded` flip.
 */

export interface RefundRow {
  id: string;
  ownerId: string;
  chargeId: string;
  bookingId: string | null;
  amountCents: number;
  status: RefundStatus;
  stripeRefundId: string | null;
}

const REFUND_PROJECTION = {
  id: refunds.id,
  ownerId: refunds.ownerId,
  chargeId: refunds.chargeId,
  bookingId: refunds.bookingId,
  amountCents: refunds.amountCents,
  status: refunds.status,
  stripeRefundId: refunds.stripeRefundId,
} as const;

/**
 * The `reason` written by `settleInvoiceCharge`'s lost-race arm — the ONLY
 * pending-refund class whose Stripe idempotency key is reconstructible from the
 * row alone (`duplicateRefundIdempotencyKey(refund.id)`), and therefore the only
 * one the retry sweep may re-fire. Kept next to the query that depends on it so
 * a future `createPending` caller reusing this string inherits the requirement
 * rather than silently breaking it.
 */
export const ROW_KEYED_REFUND_REASON = 'duplicate-invoice-settle';

export const refundsRepository = {
  /**
   * Sum of non-failed refund amounts for one charge. Used by the cancel
   * txn to compute the maximum refund allowed (charge.amount_cents
   * minus already-refunded). Pending counts: a pending refund is "in
   * flight" and the API treats it as committed-pending-webhook for
   * the purpose of capacity (we don't double-refund). If the Stripe
   * call fails the webhook flips status to 'failed' and the amount
   * drops out of the sum on retry.
   *
   * Returns 0 if no prior refunds exist (the common case — first
   * cancel of a money-paid booking).
   */
  async sumNonFailedForCharge(tx: Tx, chargeId: string): Promise<number> {
    const [row] = await tx
      .select({
        total: sql<number | null>`COALESCE(SUM(${refunds.amountCents})::int, 0)`.as('total'),
      })
      .from(refunds)
      .where(and(eq(refunds.chargeId, chargeId), ne(refunds.status, 'failed')));
    return row?.total ?? 0;
  },

  /**
   * Sum of SUCCEEDED refund amounts for one charge — used by the
   * `charge.refund.updated` webhook to apply the cumulative rule
   * (DATA-CONTRACT §I): when `SUM = charge.amount_cents`, flip
   * `charges.status` to 'refunded'. Pending refunds excluded — only
   * settled cash counts toward the cumulative cap.
   */
  async sumSucceededForCharge(tx: Tx, chargeId: string): Promise<number> {
    const [row] = await tx
      .select({
        total: sql<number | null>`COALESCE(SUM(${refunds.amountCents})::int, 0)`.as('total'),
      })
      .from(refunds)
      .where(and(eq(refunds.chargeId, chargeId), eq(refunds.status, 'succeeded')));
    return row?.total ?? 0;
  },

  /**
   * INSERT one refund row at `status='pending'`. Stripe API call
   * happens POST-commit (same shape Day-10 used for payment_intents
   * create). Day-15 webhook flips status to 'succeeded' or 'failed'.
   *
   * Caller is responsible for asserting `amountCents <= charge.amount
   * - sumNonFailedForCharge(chargeId)` before calling — the DATA-
   * CONTRACT §I "cumulative refunds ≤ charge" rule is API logic.
   * Schema CHECK only enforces `amount_cents > 0`.
   */
  async createPending(
    tx: Tx,
    args: {
      ownerId: string;
      chargeId: string;
      // Nullable: a group-class withdraw refunds a per-(cohort, dog) charge not
      // tied to a single booking row (Δ 2026-06-09).
      bookingId: string | null;
      amountCents: number;
      reason?: string | null;
    },
  ): Promise<RefundRow> {
    const [row] = await tx
      .insert(refunds)
      .values({
        ownerId: args.ownerId,
        chargeId: args.chargeId,
        bookingId: args.bookingId,
        amountCents: args.amountCents,
        reason: args.reason ?? null,
      })
      .returning(REFUND_PROJECTION);
    if (!row) {
      throw new Error('refundsRepository.createPending: refunds INSERT returned no row');
    }
    return row;
  },

  /**
   * Day-15 close of a Day-14 latent gap: after the cancel route's post-
   * commit Stripe `refunds.create` returns, persist the Stripe refund id
   * onto our `refunds` row so the eventual `charge.refund.updated`
   * webhook matches deterministically by `stripe_refund_id`.
   *
   * Default runner is the pool (the postCommit caller is outside any
   * per-request tx); webhook callers pass an explicit Tx so the update
   * lands inside the dispatch tx. Idempotent: a re-call writes the
   * same value. `updated_at = now()` advances on every call.
   *
   * Filters on `stripe_refund_id IS NULL` so a duplicate post-commit
   * call (extremely rare — the lifecycle fires once per non-replayed
   * mutation) doesn't overwrite a webhook-set id with a stale value.
   */
  async markStripeId(
    args: { id: string; stripeRefundId: string },
    runner: Runner = db,
  ): Promise<number> {
    const updated = await runner
      .update(refunds)
      .set({ stripeRefundId: args.stripeRefundId, updatedAt: sql`now()` })
      .where(and(eq(refunds.id, args.id), isNull(refunds.stripeRefundId)))
      .returning({ id: refunds.id });
    return updated.length;
  },

  /**
   * The retry sweep's CLAIM (2026-08-12, round 3) — select + lease in one short
   * tx, mirroring `invoiceChargeAttemptsRepository.claimUnresolvedForVerify`.
   *
   * The worklist: refunds still `pending` with NO `stripe_refund_id`, which is
   * exactly "the money-back row was written but the Stripe call never landed".
   * Until this existed, nothing retried them — no worker imported this
   * repository, and `charge.refund.updated` cannot arrive for a refund that was
   * never created at Stripe. Every `fireDuplicateRefundPostCommit` failure was
   * therefore a permanent double charge whose only trace was one log line, and
   * the webhook's invoice-orphan arm made lost-race refunds a COMMON path
   * rather than a rare one.
   *
   * **Scoped to `reason = 'duplicate-invoice-settle'`, and that is a safety
   * bound, not a convenience one.** A retry is only safe when it can reproduce
   * the key the ORIGINAL call used; under a different key Stripe executes a
   * SECOND refund instead of replaying the first. Only the lost-race arm of
   * `settleInvoiceCharge` keys its refunds by OUR row uuid
   * (`duplicateRefundIdempotencyKey`) — every one of its callers now does,
   * including `POST /invoices/:id/pay`, which was fixed in the same round to
   * stop keying on the client's request key. The other pending-refund writers
   * (`reason='cancel'` from the cancel/withdraw paths, and
   * `'duplicate-membership-subscribe'`) still key on `${idempotencyKey}:…`,
   * which nothing durable can reconstruct — so this sweep must NOT touch them,
   * and their failed refunds remain a named, un-swept gap.
   *
   * Two bounds, both on columns that already exist (no DDL):
   *   - `staleBefore` (on `updated_at`) is the retry cadence AND the lease: the
   *     claim's own UPDATE moves `updated_at` (explicitly, and the
   *     `refunds_touch` trigger would anyway), hiding the row from the next
   *     tick for a full interval. `markStripeId` moves it too, so a row that
   *     succeeds simply leaves the worklist by no longer being unsent.
   *   - `mintedAfter` (on `created_at`) is the ABANDON bound. A refund older
   *     than that has outlived Stripe's ~24h idempotency-key lifetime, so a
   *     retry under the same key could execute a SECOND refund rather than
   *     replay the first — the mirror image of the auto-charge key window, and
   *     the same answer: stop, and hand it to a human
   *     (see `findAbandonedPending`).
   */
  async claimStalePendingForRetry(
    tx: Tx,
    args: { staleBefore: Date; mintedAfter: Date; limit?: number },
  ): Promise<RefundRow[]> {
    const due = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(
          eq(refunds.status, 'pending'),
          isNull(refunds.stripeRefundId),
          eq(refunds.reason, ROW_KEYED_REFUND_REASON),
          lte(refunds.updatedAt, args.staleBefore.toISOString()),
          gt(refunds.createdAt, args.mintedAfter.toISOString()),
        ),
      )
      .orderBy(asc(refunds.createdAt))
      .limit(args.limit ?? 25)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(refunds)
      .set({ updatedAt: sql`now()` })
      .where(
        inArray(
          refunds.id,
          due.map((r) => r.id),
        ),
      )
      .returning(REFUND_PROJECTION);
  },

  /**
   * Refunds nothing will ever send: still `pending`, still never sent, and
   * minted before the retry window's floor. This is owed money that no
   * automatic path will return, so the caller's job is to be LOUD about it —
   * the one thing worse than a failed refund is a silently failed one. Capped,
   * because the log line names them individually.
   *
   * Deliberately NOT scoped by `reason`, unlike the claim above. Retrying is an
   * ACTION and must be keyed correctly; reporting is a READ, and a stuck
   * `'cancel'` refund is exactly as much owed money as a stuck duplicate-settle
   * one — more so, because no sweep will ever pick it up. Every row here needs
   * the same thing: a human in the Stripe dashboard.
   */
  async findAbandonedPending(
    runner: Runner,
    args: { mintedBefore: Date; limit?: number },
  ): Promise<RefundRow[]> {
    return runner
      .select(REFUND_PROJECTION)
      .from(refunds)
      .where(
        and(
          eq(refunds.status, 'pending'),
          isNull(refunds.stripeRefundId),
          lte(refunds.createdAt, args.mintedBefore.toISOString()),
        ),
      )
      .orderBy(asc(refunds.createdAt))
      .limit(args.limit ?? 20);
  },

  /**
   * Webhook entry point — look up the refund row by Stripe id.
   * `charge.refund.updated` carries the `re_*` id directly; the row's
   * `stripe_refund_id` was set by the cancel-route postCommit's call to
   * `markStripeId`. Returns undefined when the webhook beat the
   * postCommit (race) — caller falls back to `findUnmatchedPendingForCharge`.
   */
  async findByStripeRefundId(tx: Tx, stripeRefundId: string): Promise<RefundRow | undefined> {
    const [row] = await tx
      .select(REFUND_PROJECTION)
      .from(refunds)
      .where(eq(refunds.stripeRefundId, stripeRefundId))
      .limit(1);
    return row;
  },

  /**
   * Fallback lookup for the race case (`charge.refund.updated` arrived
   * before the cancel-route postCommit persisted `stripe_refund_id`).
   * Matches on (charge_id, amount_cents, status='pending',
   * stripe_refund_id IS NULL). In practice the cancel route emits one
   * 'pending' row per refund — multi-row collisions on the same
   * (charge, amount) shouldn't happen, but the most recent wins.
   */
  async findUnmatchedPendingForCharge(
    tx: Tx,
    args: { chargeId: string; amountCents: number },
  ): Promise<RefundRow | undefined> {
    const [row] = await tx
      .select(REFUND_PROJECTION)
      .from(refunds)
      .where(
        and(
          eq(refunds.chargeId, args.chargeId),
          eq(refunds.amountCents, args.amountCents),
          eq(refunds.status, 'pending'),
          isNull(refunds.stripeRefundId),
        ),
      )
      .orderBy(sql`created_at DESC`)
      .limit(1);
    return row;
  },

  /**
   * Flip refund status (Day-15 webhook). Stamps `updated_at = now()`.
   * Optionally also writes `stripe_refund_id` so the race-recovery path
   * (matched via `findUnmatchedPendingForCharge`) can backfill the id
   * in the same write.
   */
  async markStatus(
    tx: Tx,
    args: { id: string; status: RefundStatus; stripeRefundId?: string },
  ): Promise<void> {
    const set: Record<string, unknown> = {
      status: args.status,
      updatedAt: sql`now()`,
    };
    if (args.stripeRefundId !== undefined) {
      set.stripeRefundId = args.stripeRefundId;
    }
    await tx.update(refunds).set(set).where(eq(refunds.id, args.id));
  },
};
