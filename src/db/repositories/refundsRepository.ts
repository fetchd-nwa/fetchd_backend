import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { ne } from 'drizzle-orm';
import { db } from '../client.js';
import { pgTimestampToDate } from '../../lib/pgTimestamp.js';
import { charges, refunds } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx ops, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * What {@link refundsRepository.mintCappedPendingRefund} decided, under the
 * charge row's lock (§A3.18 D2).
 */
export type CappedRefundMint =
  | { kind: 'nothing-to-refund' }
  | { kind: 'no-payment-intent'; amountCents: number }
  | {
      kind: 'minted';
      refundId: string;
      amountCents: number;
      stripeIdempotencyKey: string;
      paymentIntentId: string;
    };

/**
 * `schema.sql` `refund_status`. `'unroutable'` (2026-08-19, design §4) is
 * TERMINAL and reachable only two ways: minted there by
 * `cancelBookingService`'s no-PaymentIntent branch, or flipped there from
 * `'pending'` by {@link refundsRepository.markUnroutable}. Nothing ever leaves
 * it automatically — the money returns when a human returns it.
 */
export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'unroutable';

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
  /**
   * The EXACT Stripe idempotency key this row's `createRefund` uses, stored at
   * mint (design §1). NULL means the row predates the column or is
   * `'unroutable'` — in both cases no automatic retry may touch it, which is
   * why the sweep's claim reads this instead of a calendar constant.
   */
  stripeIdempotencyKey: string | null;
}

const REFUND_PROJECTION = {
  id: refunds.id,
  ownerId: refunds.ownerId,
  chargeId: refunds.chargeId,
  bookingId: refunds.bookingId,
  amountCents: refunds.amountCents,
  status: refunds.status,
  stripeRefundId: refunds.stripeRefundId,
  stripeIdempotencyKey: refunds.stripeIdempotencyKey,
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

/**
 * THE DEPLOY BOUNDARY of the retry sweep, and the reason it is a date rather
 * than a `reason` value (2026-08-13, round 4).
 *
 * `reason = 'duplicate-invoice-settle'` has been written since 2026-06-21
 * (`cade494`), by `settleInvoiceCharge`'s lost-race arm — which BOTH the worker
 * and `POST /invoices/:id/pay` call. The worker's post-commit fire was always
 * keyed on our refund-row uuid. The route's was NOT: until this branch it built
 * its own key, `` `${idempotencyKey}:dup-settle-refund` ``, from the CLIENT's
 * request key. So the reason string alone cannot tell a row-keyed refund from a
 * client-keyed one — and re-firing a client-keyed row under
 * `dup-settle-refund:<refundId>` sends a key Stripe has never seen, which is
 * not a replay, it is a SECOND full refund of somebody's money. Nothing in the
 * row can distinguish them; only when it was written can.
 *
 * So the sweep claims nothing minted at or before this instant. Rows below the
 * floor are not lost — {@link findAbandonedPending} still reports them, under
 * the `client-keyed` class, because their key is unreconstructible and a human
 * with the Stripe dashboard is the only safe resolver.
 *
 * **This value must be > the instant the last OLD-code process stops, and the
 * only date a human can promise that of in advance is midnight UTC of the day
 * AFTER deploy.** The first version of this constant was midnight of the
 * deploy DATE — which sits BEFORE the deploy instant, so rows the old route
 * minted between 00:00Z and cutover were above the floor and claimable: the
 * exact double refund this exists to prevent, re-opened by an off-by-a-day
 * (caught by the 2026-08-13 verify panel, not by any test — a calendar value
 * cannot be pinned by a suite that runs on arbitrary days).
 *
 * If this branch does not deploy on 2026-08-13, ADVANCE this to midnight UTC
 * of the day AFTER the actual deploy day. Too-late costs only automation —
 * those rows surface on the abandon report as `client-keyed` and a human
 * resolves them — which is the safe direction of the two. Too-early is the
 * double refund.
 */
export const REFUND_SWEEP_FLOOR = new Date('2026-08-14T00:00:00.000Z');

/**
 * What an unreturned refund IS, from the row's own durable facts — the
 * discriminator {@link findAbandonedPending} returns so the caller's alarm can
 * say something TRUE about each one instead of one sentence that is false for
 * two thirds of them.
 *
 *   - `stripe-failed` — `status='failed'`: the refund WAS created at Stripe and
 *     Stripe then failed it (a closed card account, R18/R19). The money did not
 *     return, no retry can help (the identity is spent), and until 2026-08-19
 *     this class had no recurring surface at all — the webhook flipped the row
 *     and moved on. Checked FIRST: a terminal Stripe outcome outranks every
 *     question about keys. A fresh dashboard refund is safe here because the
 *     failed row drops out of the cumulative cap (`sumNonFailedForCharge`).
 *   - `never-sent` — the charge behind it carries no `stripe_payment_intent_id`
 *     at all (pre-Stripe-wire seed money). There is nothing at Stripe to refund,
 *     so "refund it by hand in the dashboard" is not an instruction a human can
 *     follow. **This class should now always be empty**: such rows are minted
 *     `'unroutable'` and legacy ones are flipped by {@link markUnroutable} at
 *     the top of each sweep. It survives as the honest answer for a row the
 *     flip has not reached yet (the flip is batched), not as a standing class.
 *   - `client-keyed` — no stored key AND not legacy-reconstructible: the reason
 *     is not {@link ROW_KEYED_REFUND_REASON} (`'cancel'`,
 *     `'duplicate-membership-subscribe'`), or it is but the row predates
 *     {@link REFUND_SWEEP_FLOOR}. Operationally identical: the original Stripe
 *     idempotency key was the client's request key, no automatic path can
 *     reproduce it, and a human must CHECK Stripe for an existing refund before
 *     issuing one. **Frozen and finite** — since 2026-08-19 every writer stores
 *     its key, so nothing new can join this class.
 *   - `row-keyed` — the key is KNOWN: stored on the row, or (pre-2026-08-19,
 *     post-floor `duplicate-invoice-settle`) reconstructible as
 *     `dup-settle-refund:<refund id>`. The sweep owns these, tried, and has now
 *     aged past the key window; a human can search that exact key in Stripe.
 */
export type AbandonedRefundClass =
  | 'never-sent'
  | 'client-keyed'
  | 'row-keyed'
  | 'stripe-failed';

export interface AbandonedRefundRow extends RefundRow {
  refundClass: AbandonedRefundClass;
  /** The PI the refund reverses — `null` is what makes a row `never-sent`. */
  stripePaymentIntentId: string | null;
}

/**
 * The discriminator behind {@link AbandonedRefundClass}. Order is the whole
 * point: a terminal Stripe outcome outranks everything, then "there is no
 * Stripe charge here" outranks "we could not have reproduced its key" — because
 * a human told to find a refund that never had a charge will not find one.
 */
function classifyAbandoned(args: {
  status: RefundStatus;
  reason: string | null;
  createdAt: string;
  piId: string | null;
  stripeIdempotencyKey: string | null;
}): AbandonedRefundClass {
  if (args.status === 'failed') return 'stripe-failed';
  if (args.piId === null) return 'never-sent';
  // The stored key is the whole design: a row that carries one is retryable and
  // searchable regardless of which writer minted it or when.
  if (args.stripeIdempotencyKey !== null) return 'row-keyed';
  if (args.reason !== ROW_KEYED_REFUND_REASON) return 'client-keyed';
  return pgTimestampToDate(args.createdAt) > REFUND_SWEEP_FLOOR ? 'row-keyed' : 'client-keyed';
}

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
   * `'unroutable'` counts too, and that is the correct reading of `ne('failed')`
   * rather than an accident of it (design §4): the obligation to return that
   * money is recorded, a human will honor it, and nothing may mint a second
   * refund row against the same charge in the meantime.
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
      /**
       * The EXACT Stripe idempotency key the post-commit fire will use.
       * **REQUIRED, and required on purpose** (design §2.1): a default would let
       * a future writer forget to decide, and a forgotten decision here is a
       * refund nothing can ever retry. `null` is a statement — "this row will
       * never be fired automatically" — not an omission.
       */
      stripeIdempotencyKey: string | null;
      /**
       * Supply the row's uuid app-side when the KEY IS DERIVED FROM IT
       * (`settleInvoiceCharge`'s `dup-settle-refund:<id>`): the key must be
       * computed before the INSERT that stores it, and only the caller can
       * break that circle. Everyone else lets the DB default it.
       */
      id?: string;
    },
  ): Promise<RefundRow> {
    const [row] = await tx
      .insert(refunds)
      .values({
        ...(args.id !== undefined ? { id: args.id } : {}),
        ownerId: args.ownerId,
        chargeId: args.chargeId,
        bookingId: args.bookingId,
        amountCents: args.amountCents,
        reason: args.reason ?? null,
        stripeIdempotencyKey: args.stripeIdempotencyKey,
      })
      .returning(REFUND_PROJECTION);
    if (!row) {
      throw new Error('refundsRepository.createPending: refunds INSERT returned no row');
    }
    return row;
  },

  /**
   * **THE capped refund mint** — lock the charge, compute R9's cap under that
   * lock, and INSERT the pending row, all in ONE transaction (ADDENDUM 3
   * §A3.18 D2, 2026-08-22).
   *
   * **Why the lock exists.** R9's cap is a read-modify-write: read
   * `sumNonFailed`, subtract, insert. OP-9 executed the consequence with two
   * genuinely overlapping transactions — the API withdraw's refund leg and the
   * scheduler's `settlePostWithdrawRefund` — both reading `sumNonFailed = 0`
   * for the same 12000c charge and both committing a full 12000c pending
   * refund, under DISTINCT `withdraw-refund:<uuid>` keys. Two different keys
   * means Stripe replays neither: it executes both, and 24000c leaves the
   * account for a 12000c charge. Pending rows already counted against the cap,
   * so every SEQUENTIAL second minter computed 0 — the hole was only ever the
   * overlap, and §A3.17 widened `settlePostWithdrawRefund`'s firing enough to
   * make it reachable.
   *
   * `SELECT … FOR UPDATE` on the charge row makes the second minter BLOCK until
   * the first commits, then re-read the sum INCLUDING the winner's pending row
   * and compute 0. **R5 is preserved**: the lock lives only inside the
   * pending-mint transaction and no Stripe call happens under it — the caller
   * still fires post-commit, exactly as R35 requires. Hold time is one sum
   * query.
   *
   * **The deadlock invariant, stated correctly (§A3.19 R1).** An earlier
   * version of this comment claimed "every leg takes the charge FIRST", and
   * that is literally false: three of the four call sites already hold a
   * cohort, booking or invoice lock by the time they get here, so the charge is
   * the LAST contended lock, not the first. What actually makes this safe is
   * narrower and must be preserved by name: **this helper never waits on an
   * existing `refunds` row.** It reads `refunds` with a plain aggregate and
   * INSERTs a fresh one, so it can never block behind a writer holding a
   * refunds row while that writer waits for the charge. That is the only reason
   * `stripeEventHandlers.ts`'s refunds-then-charges write order — the reverse
   * of this one — cannot deadlock against it. **A future
   * `SELECT … FROM refunds … FOR UPDATE` here, or a unique index on `refunds`
   * that makes an INSERT wait on a concurrent one, creates a live deadlock
   * pair.** That is a constraint on future work, not an observation.
   *
   * **What the lock does NOT serialize (§A3.19 R4):** the cap is serialized
   * against other MINTERS only. The webhook's `pending → failed` flip does not
   * take this lock, so a mint can read a sum that still counts a refund Stripe
   * has just failed. The stale direction is UNDER-refund — we return less than
   * we could — which is the safe one: the reopened remainder surfaces on the
   * `stripe-failed` abandon report for a human, and no money leaves twice.
   *
   * **It is one helper, and that is the point.** Six legs mint capped refunds
   * (the withdraw's succeeded and refunded-verdict arms,
   * `settlePostWithdrawRefund`, the invoice settle's lost-race/void arm,
   * `cancelBookingService`'s money-back branch, and the reconciler's
   * surplus arm). Open-coding lock-sum-cap-mint six times is how the seventh
   * one forgets the lock.
   *
   * Three answers, because the callers genuinely differ:
   *   - `'minted'` — a pending row exists and the caller must fire it.
   *   - `'nothing-to-refund'` — the cap is 0; someone already spoke for this
   *     money. Never an error: it is R9 working.
   *   - `'no-payment-intent'` — pre-Stripe-wire seed money. The obligation is
   *     real but there is nothing at Stripe to reverse, so this mints NOTHING
   *     and hands back the cap; the one caller that can reach it
   *     (`cancelBookingService`) writes an `'unroutable'` row instead, still
   *     under this lock. A `'pending'` row here would be a worklist entry no
   *     sweep could send and no webhook could close.
   */
  async mintCappedPendingRefund(
    tx: Tx,
    args: {
      chargeId: string;
      ownerId: string;
      bookingId: string | null;
      reason?: string | null;
      /**
       * THE Stripe key, built from the refund row's uuid. A factory rather than
       * a string because most legs derive the key FROM the row id (the key must
       * exist before the INSERT that stores it), while the withdraw legs use the
       * client's request key and ignore the argument.
       */
      stripeIdempotencyKey: (refundId: string) => string;
    },
  ): Promise<CappedRefundMint> {
    // The lock. FIRST, before `refunds` is read or written, so the legs cannot
    // deadlock against each other.
    const [charge] = await tx
      .select({
        amountCents: charges.amountCents,
        stripePaymentIntentId: charges.stripePaymentIntentId,
      })
      .from(charges)
      .where(eq(charges.id, args.chargeId))
      .for('update');
    if (charge === undefined) {
      throw new Error(`mintCappedPendingRefund: charge ${args.chargeId} not found`);
    }

    const alreadyRefunded = await this.sumNonFailedForCharge(tx, args.chargeId);
    const amountCents = charge.amountCents - alreadyRefunded;
    if (amountCents <= 0) return { kind: 'nothing-to-refund' };
    if (charge.stripePaymentIntentId === null) {
      return { kind: 'no-payment-intent', amountCents };
    }

    // The uuid is minted app-side because the Stripe key derives from it: the
    // key has to exist before the INSERT that stores it, and only the caller of
    // `createPending` can break that circle.
    const refundId = randomUUID();
    const stripeIdempotencyKey = args.stripeIdempotencyKey(refundId);
    const refund = await this.createPending(tx, {
      id: refundId,
      ownerId: args.ownerId,
      chargeId: args.chargeId,
      bookingId: args.bookingId,
      amountCents,
      reason: args.reason ?? null,
      stripeIdempotencyKey,
    });
    return {
      kind: 'minted',
      refundId: refund.id,
      amountCents,
      stripeIdempotencyKey,
      paymentIntentId: charge.stripePaymentIntentId,
    };
  },

  /**
   * INSERT one refund row TERMINAL at `status='unroutable'` (design §4) — the
   * money-back branch of a charge that carries no `stripe_payment_intent_id`.
   *
   * Deliberately a separate verb rather than a `status` argument on
   * {@link createPending}: a function named `createPending` that can mint a
   * non-pending row is a lie a future reader has to catch, and these two mints
   * differ in every downstream consequence. `stripe_idempotency_key` is NULL by
   * construction — there is no Stripe call to key.
   *
   * The row is still WRITTEN, not skipped: it records that the school owes this
   * money, and `sumNonFailedForCharge` counts it toward the cumulative cap so
   * nothing can double-mint against the same charge.
   */
  async createUnroutable(
    tx: Tx,
    args: {
      ownerId: string;
      chargeId: string;
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
        status: 'unroutable',
        stripeIdempotencyKey: null,
      })
      .returning(REFUND_PROJECTION);
    if (!row) {
      throw new Error('refundsRepository.createUnroutable: refunds INSERT returned no row');
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
   * never created at Stripe. Every `firePendingRefundPostCommit` failure was
   * therefore a permanent double charge whose only trace was one log line, and
   * the webhook's invoice-orphan arm made lost-race refunds a COMMON path
   * rather than a rare one.
   *
   * **A retry is only safe when it can reproduce the key the ORIGINAL call
   * used**; under a different key Stripe executes a SECOND refund instead of
   * replaying the first. That is the one rule, and there are now two ways a row
   * can satisfy it (design §2.3):
   *
   *   1. **The stored-key lane** (`stripe_idempotency_key IS NOT NULL`) — since
   *      2026-08-19 every writer records its exact key in the minting tx, so
   *      the row itself says what to send. This is the lane that finally covers
   *      the cancel / withdraw / membership-lost-race writers, whose keys were
   *      derived from the CLIENT's request `Idempotency-Key` and existed only
   *      inside that request's closure. Note what it does NOT need: a date
   *      constant. `stripe_idempotency_key IS NULL` IS the deploy boundary,
   *      true row by row, immune to a deploy that slips a day and safe under a
   *      mixed-version fleet — an old-code instance mints a NULL-key row, which
   *      simply stays out of this lane.
   *   2. **The legacy lane** (`reason = 'duplicate-invoice-settle'` AND
   *      `created_at > REFUND_SWEEP_FLOOR`) — round 4's bound, kept VERBATIM,
   *      for rows already on disk that round-4-era code minted without a stored
   *      key. The 24h abandon bound retires it naturally within a day of
   *      deploy; it stays because it is provably safe and deleting it is a
   *      later cleanup, not a correctness need. Its floor must NOT be relaxed
   *      or advanced by this design: below it, `reason` alone cannot tell a
   *      row-keyed refund from a client-keyed one.
   *
   * The reason string is necessary and NOT sufficient, which an earlier version
   * of this comment got wrong (round 4, 2026-08-13). It claimed every caller of
   * `settleInvoiceCharge`'s lost-race arm keys by our row uuid "now, including
   * `POST /invoices/:id/pay`, which was fixed in the same round" — true of rows
   * this branch's code writes, and false of every row already in the table.
   * That arm has stamped this exact reason since 2026-06-21, and the route
   * fired those refunds under `` `${idempotencyKey}:dup-settle-refund` ``, the
   * client's request key. A sweep with no lower bound would re-fire them under
   * `dup-settle-refund:<refundId>` — a key Stripe has never seen — and refund
   * the owner a second time, unattended. Hence the floor; see its own doc for
   * why the boundary has to be a date.
   *
   * The other pending-refund writers (`reason='cancel'` from the
   * cancel/withdraw paths, and `'duplicate-membership-subscribe'`) keyed on
   * `${idempotencyKey}:…` until 2026-08-19 — nothing durable can reconstruct
   * that, so their PRE-EXISTING rows still fall outside both lanes and remain a
   * named, un-swept, and now finite gap. Their new rows carry a stored key and
   * are retried by lane 1.
   *
   * Nothing excluded here is dropped: every unsent 'pending' refund the sweep
   * refuses still reaches a human through {@link findAbandonedPending}.
   *
   * Three bounds, all on columns that already exist (no DDL):
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
   *   - {@link REFUND_SWEEP_FLOOR} (on `created_at`) is the DEPLOY bound of the
   *     LEGACY lane, and it is applied HERE rather than by the caller so no
   *     caller can widen it. It deliberately does NOT gate the stored-key lane:
   *     that lane's boundary is the column itself, per row, so a floor sitting
   *     in the future for an unshipped deploy must not also switch off the
   *     retry for rows that carry their own key.
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
          lte(refunds.updatedAt, args.staleBefore.toISOString()),
          gt(refunds.createdAt, args.mintedAfter.toISOString()),
          or(
            // Lane 1 — the row carries the exact key its first attempt used.
            isNotNull(refunds.stripeIdempotencyKey),
            // Lane 2 — round 4's legacy lane, VERBATIM. Do not widen.
            and(
              eq(refunds.reason, ROW_KEYED_REFUND_REASON),
              gt(refunds.createdAt, REFUND_SWEEP_FLOOR.toISOString()),
            ),
          ),
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
   * one — more so, because no sweep will ever pick it up.
   *
   * **And deliberately not floored at {@link REFUND_SWEEP_FLOOR} either**
   * (round 4, 2026-08-13). The floor is what makes those rows UN-RETRYABLE; a
   * report that also hid them would leave a double-charged owner with no
   * surface at all, and the claim's own contract is that what it refuses lands
   * here instead. What the floor does here is CLASSIFY: a pre-floor
   * `duplicate-invoice-settle` row is reported as `client-keyed`, because that
   * is the honest thing to tell whoever has to resolve it.
   *
   * Every row carries {@link AbandonedRefundClass} and the charge's PI id, for
   * one reason: the caller's alarm used to end "refund by hand in the Stripe
   * dashboard", which is an instruction a human CANNOT follow for a pre-Stripe
   * seed row and a dangerous one for a client-keyed row (issue a second refund
   * for one that may already exist). One sentence per class, each true — the
   * LEFT JOIN is what makes `never-sent` knowable at all.
   *
   * **Widened 2026-08-19 (design §5) to `status IN ('pending','failed')`, with a
   * predicate per status.** `'failed'` rows are the last class of owed-back
   * money with no recurring surface anywhere: the refund WAS created at Stripe,
   * the webhook flipped it `'failed'` (the card account closed, R18/R19), the
   * money did not return, and the row then left every worklist forever. They
   * carry a `stripe_refund_id` by construction, so the `IS NULL` predicate that
   * defines an unsent pending row cannot apply to them — hence per-status arms
   * rather than one WHERE. They are also NOT age-bounded: nothing about a
   * terminal Stripe failure changes in 24 hours, so delaying the alarm by the
   * key window would only delay a human.
   *
   * `'unroutable'` rows are excluded by construction — they are terminal, they
   * have already been shouted about once (at mint, or at the flip in
   * {@link markUnroutable}), and re-listing them every tick forever is exactly
   * the noise this report was rebuilt to stop making.
   */
  async findAbandonedPending(
    runner: Runner,
    args: { mintedBefore: Date; limit?: number },
  ): Promise<{ rows: AbandonedRefundRow[]; totalByClass: Record<AbandonedRefundClass, number> }> {
    // The page is capped and OLDEST-FIRST, and never-sent seed rows are by
    // construction the oldest rows with no resolution path in this change — so
    // with enough of them standing, the page is permanently theirs, and a NEWER
    // row-keyed abandoned double charge would never appear in it. The 2026-08-13
    // verify panel proved that made the alarm's own guarantee ("the condition is
    // never invisible") false: the caps saturated with nothing marking
    // truncation. So the TRUE counts come from a companion unbounded query over
    // only the classification inputs — same WHERE, same classifier, so the two
    // cannot disagree about what a row is — and the caller alarms on counts, not
    // on page presence.
    const abandonedWhere = or(
      // Unsent and past the key window: nothing automatic will send it now.
      and(
        eq(refunds.status, 'pending'),
        isNull(refunds.stripeRefundId),
        lte(refunds.createdAt, args.mintedBefore.toISOString()),
      ),
      // Sent, then failed AT Stripe. Terminal, unbounded by age (see the doc).
      eq(refunds.status, 'failed'),
    );
    const classInputs = await runner
      .select({
        status: refunds.status,
        reason: refunds.reason,
        createdAt: refunds.createdAt,
        stripeIdempotencyKey: refunds.stripeIdempotencyKey,
        stripePaymentIntentId: charges.stripePaymentIntentId,
      })
      .from(refunds)
      .leftJoin(charges, eq(refunds.chargeId, charges.id))
      .where(abandonedWhere);
    const totalByClass: Record<AbandonedRefundClass, number> = {
      'row-keyed': 0,
      'client-keyed': 0,
      'never-sent': 0,
      'stripe-failed': 0,
    };
    for (const input of classInputs) {
      totalByClass[
        classifyAbandoned({
          status: input.status,
          reason: input.reason,
          createdAt: input.createdAt,
          piId: input.stripePaymentIntentId,
          stripeIdempotencyKey: input.stripeIdempotencyKey,
        })
      ] += 1;
    }
    const rows = await runner
      .select({
        ...REFUND_PROJECTION,
        reason: refunds.reason,
        createdAt: refunds.createdAt,
        stripePaymentIntentId: charges.stripePaymentIntentId,
      })
      .from(refunds)
      .leftJoin(charges, eq(refunds.chargeId, charges.id))
      .where(abandonedWhere)
      // PAGE PRIORITY, not pure age (adversary round 3, 2026-08-20 — proven on
      // :5433). `'failed'` rows are TERMINAL and unbounded by age, so they only
      // ever accumulate and they are always the oldest thing in this result.
      // Ordering the page by `created_at` alone therefore handed all 20 slots
      // to them permanently, and a brand-new abandoned PENDING refund — the
      // actionable kind, the whole reason this report exists — could never
      // appear on it again.
      //
      // So actionable pending rows take the slots first, oldest-first among
      // themselves; failed rows fill only what is left. A `'failed'` row can
      // never evict a `'pending'` one. The unbounded per-class COUNTS are
      // untouched by this and remain the source of truth for "how much".
      .orderBy(
        sql`CASE WHEN ${refunds.status} = 'pending' THEN 0 ELSE 1 END`,
        asc(refunds.createdAt),
      )
      .limit(args.limit ?? 20);
    return {
      rows: rows.map(({ reason, createdAt, ...row }) => ({
        ...row,
        refundClass: classifyAbandoned({
          status: row.status,
          reason,
          createdAt,
          piId: row.stripePaymentIntentId,
          stripeIdempotencyKey: row.stripeIdempotencyKey,
        }),
      })),
      totalByClass,
    };
  },

  /**
   * Flip every `pending`, never-sent refund whose charge carries NO
   * PaymentIntent to the terminal `'unroutable'` status (design §4), returning
   * what it flipped so the caller can shout about each one ONCE.
   *
   * These are the pre-Stripe-wire seed-money rows. There is nothing at Stripe to
   * reverse, so no sweep can ever send them and no webhook can ever close them —
   * yet they sat `'pending'` forever, saturating an oldest-first report page and
   * re-shouting on every process restart. **The flip IS the memory**: unlike a
   * per-process `Set`, a restart does not re-announce a row that is already
   * terminal, and no manual backfill or runbook step is needed.
   *
   * Information-preserving and reversible by the same predicate — the amount,
   * owner, charge and reason are untouched, and `sumNonFailedForCharge` keeps
   * counting the row toward the cumulative cap, so nothing can double-mint
   * against the obligation this records.
   *
   * Batched (default 100) because the caller names each flipped row in a log
   * line; a backlog drains over consecutive ticks and whatever is left stays
   * honestly classified as `never-sent` in the meantime.
   */
  async markUnroutable(
    runner: Runner,
    args: { limit?: number } = {},
  ): Promise<AbandonedRefundRow[]> {
    const due = await runner
      .select({ id: refunds.id })
      .from(refunds)
      .innerJoin(charges, eq(refunds.chargeId, charges.id))
      .where(
        and(
          eq(refunds.status, 'pending'),
          isNull(refunds.stripeRefundId),
          isNull(charges.stripePaymentIntentId),
          // A STORED KEY IS PROOF A STRIPE CALL WAS AIMED at this row, and such
          // a row belongs to the sweep's lane 1 (adversary panel, 2026-08-20).
          // Flipping it terminal would delete it from that lane forever and
          // silently strand a refund the sweep was about to send. The two
          // conditions can co-occur: a charge row whose PaymentIntent is NULL
          // while a writer still recorded a key is corrupt state, and the safe
          // reading of corrupt state is "leave it for the lane that can act".
          isNull(refunds.stripeIdempotencyKey),
        ),
      )
      .orderBy(asc(refunds.createdAt))
      .limit(args.limit ?? 100);
    if (due.length === 0) return [];
    const flipped = await runner
      .update(refunds)
      .set({ status: 'unroutable', updatedAt: sql`now()` })
      .where(
        and(
          inArray(
            refunds.id,
            due.map((r) => r.id),
          ),
          // Re-assert the claim shape at write time: between the read above and
          // this UPDATE a webhook could have moved the row, and a flip that
          // overwrote a real terminal status would be data loss. The stored-key
          // condition is re-asserted for the same reason — a concurrent writer
          // that stamped a key between the SELECT and here has claimed this row
          // for lane 1, and this flip must lose that race, not win it.
          eq(refunds.status, 'pending'),
          isNull(refunds.stripeRefundId),
          isNull(refunds.stripeIdempotencyKey),
        ),
      )
      .returning(REFUND_PROJECTION);
    return flipped.map((row) => ({
      ...row,
      // Known by the predicate that selected it — the charge has no PI.
      stripePaymentIntentId: null,
      refundClass: 'never-sent' as const,
    }));
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
