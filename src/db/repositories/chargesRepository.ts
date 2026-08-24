import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { ChargeStatus } from '../../contracts/wire.js';
import {
  chargeBelongsToEnrollment,
  type EnrollmentIdentity,
} from '../../lib/enrollmentIdentity.js';
import { db } from '../client.js';
import { charges } from '../schema/schema.js';
import { refundsRepository } from './refundsRepository.js';
import type { Tx } from '../tx.js';

/**
 * One row of the capture reconciler's worklist.
 *
 * `bookingId` + `createdAtUs` are the row's ENROLLMENT IDENTITY (ADDENDUM 3
 * §A3.17, §A3.18 D3): every arm of the reconciler asks "is THIS row's own
 * enrollment still live?" before it asks anything about money, and those two
 * columns are the whole input to that question. Carried on the projection
 * rather than re-read per row because the arms ask it once each, per row, per
 * tick — and carried in DB MICROSECONDS, because truncating them to a JS
 * millisecond made this layer disagree with the SQL one about the same rows.
 */
export interface PendingGroupClassCapture {
  id: string;
  ownerId: string;
  amountCents: number;
  stripePaymentIntentId: string;
  cohortId: string;
  dogId: string;
  /** The enrollment anchor, or NULL for a row minted before §A3.17 landed. */
  bookingId: string | null;
  /** DB microseconds (§A3.18 D3) — the legacy membership rule's only input. */
  createdAtUs: string;
}

const PENDING_CAPTURE_PROJECTION = {
  id: charges.id,
  ownerId: charges.ownerId,
  amountCents: charges.amountCents,
  stripePaymentIntentId: charges.stripePaymentIntentId,
  cohortId: charges.cohortId,
  dogId: charges.dogId,
  bookingId: charges.bookingId,
  createdAtUs: sql<string>`((EXTRACT(EPOCH FROM ${charges.createdAt})::numeric * 1000000)::bigint)::text`,
} as const;

function narrowPendingCapture(row: {
  id: string;
  ownerId: string;
  amountCents: number;
  stripePaymentIntentId: string | null;
  cohortId: string | null;
  dogId: string | null;
  bookingId: string | null;
  createdAtUs: string;
}): PendingGroupClassCapture {
  return {
    id: row.id,
    ownerId: row.ownerId,
    amountCents: row.amountCents,
    // Narrowed by the IS NOT NULL predicates in every query that builds this;
    // the projection types stay nullable because the columns are.
    stripePaymentIntentId: row.stripePaymentIntentId as string,
    cohortId: row.cohortId as string,
    dogId: row.dogId as string,
    bookingId: row.bookingId,
    createdAtUs: row.createdAtUs,
  };
}

function pendingGroupClassCaptureWhere(args: { olderThan: Date; mintedAfter: Date }) {
  return and(
    // R9: enrollment-purpose rows only. This CANNOT by itself exclude the
    // invoice lane — `POST /invoices/:id/pay` writes `'group-class'` rows with
    // the same cohort/dog stamps and there is no `invoice_id` on `charges` to
    // discriminate on — so the retrieve is still the authority for what gets
    // acted on, and the abandon window below is what stops a foreign row from
    // occupying the worklist forever.
    eq(charges.purpose, 'group-class'),
    eq(charges.status, 'requires_payment'),
    isNotNull(charges.stripePaymentIntentId),
    isNotNull(charges.cohortId),
    isNotNull(charges.dogId),
    lt(charges.createdAt, args.olderThan.toISOString()),
    gte(charges.createdAt, args.mintedAfter.toISOString()),
  );
}

/**
 * Data-access seam for `charges` (schema.sql ~line 700). Append-only
 * retained financial record — Stripe PaymentIntent rows for package
 * purchases, pay-as-you-go bookings, B&T deposits, group-class
 * enrollment, etc. NO `expired_at` — charges are never soft-deleted;
 * refunds against a charge are tracked separately in the `refunds`
 * table.
 *
 * Day 13 introduced the first read here. Day 14 adds the write path:
 *   - `create` — INSERT after Stripe `paymentIntents.create + confirm`
 *     returns; status mirrors what Stripe returned (`succeeded` for the
 *     test-mode happy path; `requires_action` / `processing` for 3DS
 *     and async-settled methods, with Day-15 webhook reconciling).
 *   - `markSucceeded` / `markFailed` — Day-15 webhook callees; left
 *     stubbed here so the cancel + tests can reference the contract.
 */

export type ChargePurpose = 'payg' | 'package' | 'board-train' | 'membership' | 'group-class';
// Re-exported, not redeclared: `ChargeStatus` moved into the wire contract in
// 1.7.0 when `InvoicePayWire` did (it reports this value), and `conformance.ts`
// pins it against the `charge_status` pgEnum. Two copies could drift apart while
// both still compiled.
export type { ChargeStatus } from '../../contracts/wire.js';

export interface ChargeRow {
  id: string;
  ownerId: string;
  amountCents: number;
  status: ChargeStatus;
  bookingId: string | null;
  stripePaymentIntentId: string | null;
  purpose: ChargePurpose;
}

const CHARGE_PROJECTION = {
  id: charges.id,
  ownerId: charges.ownerId,
  amountCents: charges.amountCents,
  status: charges.status,
  bookingId: charges.bookingId,
  stripePaymentIntentId: charges.stripePaymentIntentId,
  purpose: charges.purpose,
} as const;

/** `CHARGE_PROJECTION` plus the second half of the enrollment-membership rule
 *  (§A3.17), in DB microseconds (§A3.18 D3). Separate from the shared
 *  projection because `ChargeRow` is a published shape and only the
 *  membership-aware reads need the instant. */
const CHARGE_MEMBERSHIP_PROJECTION = {
  ...CHARGE_PROJECTION,
  createdAtUs: sql<string>`((EXTRACT(EPOCH FROM ${charges.createdAt})::numeric * 1000000)::bigint)::text`,
} as const;

export const chargesRepository = {
  /**
   * The most-recent succeeded charge attached to this booking, if any.
   * Day-13 cancel-money-back uses this to discover that a booking was
   * money-paid (vs credit-paid, vs free-service). Returns undefined when:
   *   - the booking was credit-paid (`credit_ledger` carries it)
   *   - the booking was a free service (eval; no charge, no debit)
   *   - the charge exists but isn't 'succeeded' (the cancel route
   *     treats this as "no settled money to refund" — refund branch
   *     skipped, capacity still released, status flipped)
   *
   * Single-charge-per-booking is the design today (one PaymentIntent
   * for a B&T deposit, one for a PL session). If a future flow attaches
   * multiple charges to one booking (split-payment), this method needs
   * to return all + the cancel route needs to sum/iterate. YAGNI today.
   */
  async findSucceededForBooking(tx: Tx, bookingId: string): Promise<ChargeRow | undefined> {
    const [row] = await tx
      .select(CHARGE_PROJECTION)
      .from(charges)
      .where(and(eq(charges.bookingId, bookingId), eq(charges.status, 'succeeded')))
      .limit(1);
    return row;
  },

  /**
   * INSERT a charges row after Stripe's `paymentIntents.create + confirm`
   * returns. The Stripe status maps 1:1 to our `charge_status` enum for
   * 'succeeded' and 'requires_payment' / 'failed'; processing / 3DS
   * intermediate states map to 'requires_payment' (the Day-15 webhook
   * flips on the terminal event). Caller is responsible for catching
   * `unique_violation` on the unique stripePaymentIntentId — a retry
   * with the same Idempotency-Key returns the same PI id, and the
   * `withIdempotency` outer wrap should prevent re-entry; this is the
   * belt-and-suspenders constraint.
   */
  async create(
    tx: Tx,
    args: {
      ownerId: string;
      amountCents: number;
      currency?: string;
      status: ChargeStatus;
      purpose: ChargePurpose;
      stripePaymentIntentId: string;
      /**
       * The booking this money is for. For a group-class charge this is the
       * enrollment's ANCHOR — the earliest-scheduled row minted in the same
       * tx/savepoint (ADDENDUM 3 §A3.17) — which is what lets every money read
       * tell one enrollment's charge from the previous one's.
       *
       * **NULL means LEGACY — nearly, and the qualifier has been earned
       * twice.** §A3.17 claimed it while the invoice lane still resolved its
       * anchor from the CURRENT live set at settle time and wrote NULL when it
       * found none: a late settle of a VOIDED invoice therefore either
       * mis-filed a dead enrollment's money onto the live one, or — with NULL —
       * was claimed by the live one anyway, because the legacy rule is
       * `created_at >= bornAt` and a late settle post-dates the re-enrollment's
       * birth. §A3.18 D1 gave the invoice its own anchor at MINT time, with
       * every invoice-lane charge copying it, and claimed the NULLs were done.
       *
       * **Two doors survived that claim, both executed (§A3.19 F2):** invoices
       * minted BEFORE the stamp existed — a population draining over WEEKS on
       * `due_at` horizons, not a deploy-second — and `invoices.booking_id`'s
       * `ON DELETE SET NULL`, which silently orphans an invoice when an ops
       * script hard-deletes an anchor row. Both are now closed AT THE MINT by
       * an exact same-transaction witness (bookings whose `created_at` equals
       * the invoice's `issued_at`, any status). So a post-deploy NULL here
       * means only that the witness found nothing — and that mint WARNs, naming
       * the invoice, with the legacy time rule as the net behind it.
       */
      bookingId?: string | null;
      // Δ 2026-06-09: set together for a group-class enrollment charge so the
      // withdraw verb can find + refund a single dog's payment.
      cohortId?: string | null;
      dogId?: string | null;
    },
  ): Promise<ChargeRow> {
    const [row] = await tx
      .insert(charges)
      .values({
        ownerId: args.ownerId,
        amountCents: args.amountCents,
        currency: args.currency ?? 'usd',
        status: args.status,
        purpose: args.purpose,
        stripePaymentIntentId: args.stripePaymentIntentId,
        bookingId: args.bookingId ?? null,
        cohortId: args.cohortId ?? null,
        dogId: args.dogId ?? null,
      })
      .returning(CHARGE_PROJECTION);
    if (!row) {
      throw new Error('chargesRepository.create: INSERT returned no row');
    }
    return row;
  },

  /**
   * INSERT a charge, idempotent on the unique `stripe_payment_intent_id`.
   * Returns the row (newly created OR the pre-existing one) + whether this
   * call created it.
   *
   * The webhook orphan-recovery path (`handlePaymentIntentSucceeded`) uses
   * this to reconstruct a `charges` row from PI metadata when the synchronous
   * purchase write failed entirely AFTER Stripe captured payment — otherwise
   * the money is taken with no record and no credits. Safe under a concurrent
   * client retry: the unique PI makes the second INSERT a no-op (`DO NOTHING`)
   * that falls through to the re-SELECT, so the grant is written exactly once.
   */
  async insertIfAbsentByPaymentIntent(
    tx: Tx,
    args: {
      ownerId: string;
      amountCents: number;
      status: ChargeStatus;
      purpose: ChargePurpose;
      stripePaymentIntentId: string;
    },
  ): Promise<{ charge: ChargeRow; created: boolean }> {
    const [inserted] = await tx
      .insert(charges)
      .values({
        ownerId: args.ownerId,
        amountCents: args.amountCents,
        currency: 'usd',
        status: args.status,
        purpose: args.purpose,
        stripePaymentIntentId: args.stripePaymentIntentId,
      })
      .onConflictDoNothing({ target: charges.stripePaymentIntentId })
      .returning(CHARGE_PROJECTION);
    if (inserted) return { charge: inserted, created: true };
    const existing = await this.findByStripePaymentIntentId(tx, args.stripePaymentIntentId);
    if (existing === undefined) {
      throw new Error(
        `insertIfAbsentByPaymentIntent: conflict on ${args.stripePaymentIntentId} but no row found`,
      );
    }
    return { charge: existing, created: false };
  },

  /**
   * **THE succeeded-class money read** for one (cohort, dog): the NEWEST
   * succeeded charge that still retains a positive unrefunded remainder, or
   * `undefined` when no such charge exists (ADDENDUM 3 §A3.16, 2026-08-22).
   *
   * It answers ONE question — *is there money in hand for this enrollment, and
   * which charge holds it?* — and it is the only read allowed to answer it.
   * Two consumers ask it: the withdraw settle (which refunds the row) and
   * `enrollmentStillOwesMoney` (which asks only whether a row exists). Same
   * function, so the two can never drift apart again.
   *
   * **It replaced a raw `findSucceededForCohortDog`, which was DELETED.** That
   * read answered "paid" for money already given back, and it had exactly two
   * callers: a route-local skip-aware wrapper, and the owed predicate — which
   * had no wrapper and was therefore shadow-blind. Round 4 promoted that
   * predicate from "should we page a human" to "may we CANCEL this live
   * authorization", which turned a conservative error into a money defect: an
   * enrolled dog's hold was cancelled because a fully-refunded charge said
   * "already collected". A read that can answer "paid" for returned money must
   * not stay available for the next caller to reach for.
   *
   * **Two rules, both load-bearing:**
   *
   *   1. **Positive remainder, not `status='succeeded'` alone.** A charge whose
   *      non-failed refunds cover it is ALREADY SETTLED. This extends the
   *      double-withdraw promise the old read's comment made for `'refunded'`
   *      rows across the webhook-lag window, where the row still reads
   *      `'succeeded'` because `charge.refund.updated` has not landed yet.
   *      Pending and `'unroutable'` refunds count against the remainder —
   *      `sumNonFailedForCharge` is reused rather than re-expressed, so
   *      "non-failed" has one meaning in this codebase.
   *   2. **This ENROLLMENT's rows only, then newest first.** ~~An older partial
   *      remainder is not this withdraw's business and waits for the portal
   *      refund surface: named here, never silently refunded.~~ **That promise
   *      was FALSE when it was written** (ADDENDUM 3 §A3.17, 2026-08-22): the
   *      scan fell through a fully-covered newest row to ANY older
   *      remainder-positive one, including a previous enrollment's — so a
   *      `refund_manual` NULL-PI row (remainder-positive forever, by design) or
   *      a refund the bank terminally failed answered "money in hand" for the
   *      CURRENT enrollment, and the reconciler cancelled a live authorization
   *      for a dog sitting in the class. A (cohort, dog) is not an enrollment;
   *      withdraw + re-enroll mints a second one under the same key.
   *
   *      Membership is now decided by {@link chargeBelongsToEnrollment} — the
   *      charge's anchor is in the enrollment's live booking set, or (legacy,
   *      NULL anchor) it was minted at or after the enrollment's birth. **Only
   *      then** does newest-first apply, and it applies WITHIN the enrollment:
   *      a covered own row still yields to an older own row that still owes
   *      (same money, same enrollment). Cross-enrollment fall-through is
   *      abolished, and the promise above is finally true.
   *
   * Scanning newest-first and computing each row's remainder — rather than one
   * clever JOIN — is deliberate: it reuses the one R9 helper instead of
   * re-implementing "non-failed" in SQL, and the loop is bounded by the number
   * of succeeded charges for a single (cohort, dog), which is one or two.
   *
   * Pay-later enrollments have no charge here (their money lives on an open
   * `invoices` row), which is why every consumer checks the invoice first.
   *
   * `enrollment` is a REQUIRED argument, and `undefined` is a real answer
   * ("this dog has no live enrollment") rather than a defaulted one — so no
   * call site can keep the old (cohort, dog) meaning by silently omitting it.
   * The compiler migrated every consumer; that is the point.
   */
  async findUnsettledSucceededCharge(
    tx: Tx,
    args: {
      cohortId: string;
      dogId: string;
      enrollment: EnrollmentIdentity | undefined;
      /**
       * Ignore this charge when answering (§A3.19 F1). The reconciler flips a
       * row to `'succeeded'` BEFORE deciding what to do with the money, so
       * without this the row would answer "this enrollment is already paid"
       * about ITSELF — and the surplus arm would refund the very money that is
       * paying for the class. The question that arm actually asks is "is this
       * enrollment's money collected by something OTHER than this charge".
       */
      excludeChargeId?: string;
    },
  ): Promise<
    | { id: string; amountCents: number; stripePaymentIntentId: string | null; remainingCents: number }
    | undefined
  > {
    if (args.enrollment === undefined) return undefined;
    const all = await tx
      .select(CHARGE_MEMBERSHIP_PROJECTION)
      .from(charges)
      .where(
        and(
          eq(charges.cohortId, args.cohortId),
          eq(charges.dogId, args.dogId),
          eq(charges.status, 'succeeded'),
        ),
      )
      .orderBy(desc(charges.createdAt));
    const rows = all.filter(
      (row) => row.id !== args.excludeChargeId && chargeBelongsToEnrollment(row, args.enrollment),
    );
    for (const row of rows) {
      const alreadyRefunded = await refundsRepository.sumNonFailedForCharge(tx, row.id);
      const remainingCents = row.amountCents - alreadyRefunded;
      if (remainingCents > 0) {
        return {
          id: row.id,
          amountCents: row.amountCents,
          stripePaymentIntentId: row.stripePaymentIntentId,
          remainingCents,
        };
      }
    }
    return undefined;
  },

  /**
   * The capture-pending authorization for one (cohort, dog) — a group-class
   * charge still at `'requires_payment'` with a PaymentIntent attached
   * (ADDENDUM 3 §A3.2 step 3, the withdraw arm's advisory money-state read).
   *
   * Under manual capture this row is a LIVE HOLD on the owner's card, not a
   * dead attempt: the enroll transaction writes it at the honest status for an
   * authorization and the post-commit capture flips it. A withdraw that ignores
   * it releases nothing and stops nothing, which is exactly the round-3
   * blocker. Read on the pool, advisory only — Stripe's live answer is the
   * authority for what happened, and the in-tx settle table re-derives from the
   * authoritative rows plus that answer.
   *
   * **A STAMPED row of ANOTHER enrollment is refused outright** (ADDENDUM 3
   * §A3.17). A withdraw settles the hold it picks here AT STRIPE and reports on
   * it, so picking the previous enrollment's hold means cancelling money this
   * withdraw was never about while the live one goes unmentioned. Identity
   * answers that where ordering cannot.
   *
   * **NEWEST first among what remains, and the choice is still load-bearing.**
   * This query cannot tell an enrollment hold from the invoice lane's
   * bookkeeping row (same purpose, same cohort/dog stamps —
   * `pendingGroupClassCaptureWhere` above says why), and a (cohort, dog) can
   * carry both. That bounded-failure window NARROWS to within-enrollment rows
   * and is otherwise unchanged, restated rather than re-proven: the newest row
   * is the live attempt in every ordinary sequence; when it is not, the pre-tx
   * retrieve reads `canceled` for a dead bookkeeping row and the withdraw
   * truthfully reports `released`, while the live hold it did not pick is
   * released by the reconciler's not-owed arm within a tick (§A3.3) — the
   * defence-in-depth that arm exists for.
   *
   * **Legacy (NULL-anchor) rows join the same rule (§A3.18 D5).** §A3.17 left
   * them on plain newest-first, reasoning that excluding one would leave a real
   * hold unsettled. OP-4 executed the cost of that: a withdraw reported a
   * two-day-old foreign $50 hold — a different amount than the class costs — as
   * THIS class's `released_cents`, and cancelled it at Stripe on a withdraw it
   * had nothing to do with. The honest answer is `'none'` (this withdraw has no
   * live money of its own), and the foreign hold is still released within a
   * tick by the reconciler's row-scoped arm, whose enrollment is not live
   * either: money netted exactly as before, statement true now.
   *
   * No lease and no `FOR UPDATE`: one request settling its own owner's
   * withdraw, not a worklist.
   */
  async findPendingCaptureForCohortDog(
    tx: Tx,
    args: { cohortId: string; dogId: string; enrollment: EnrollmentIdentity | undefined },
  ): Promise<{ id: string; amountCents: number; stripePaymentIntentId: string } | undefined> {
    const candidates = await tx
      .select({
        id: charges.id,
        amountCents: charges.amountCents,
        stripePaymentIntentId: charges.stripePaymentIntentId,
        bookingId: charges.bookingId,
        createdAtUs: sql<string>`((EXTRACT(EPOCH FROM ${charges.createdAt})::numeric * 1000000)::bigint)::text`,
      })
      .from(charges)
      .where(
        and(
          eq(charges.purpose, 'group-class'),
          eq(charges.status, 'requires_payment'),
          isNotNull(charges.stripePaymentIntentId),
          eq(charges.cohortId, args.cohortId),
          eq(charges.dogId, args.dogId),
        ),
      )
      .orderBy(desc(charges.createdAt));
    const row = candidates.find((candidate) =>
      chargeBelongsToEnrollment(candidate, args.enrollment),
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      amountCents: row.amountCents,
      // Narrowed by the IS NOT NULL predicate above.
      stripePaymentIntentId: row.stripePaymentIntentId as string,
    };
  },

  /**
   * Look up a charge by its Stripe PaymentIntent id. Day-15 webhook will
   * use this to find the row to flip on terminal events; Day-14 uses it
   * inside the contract tests to assert the post-purchase write landed.
   */
  async findByStripePaymentIntentId(
    tx: Tx,
    stripePaymentIntentId: string,
  ): Promise<ChargeRow | undefined> {
    const [row] = await tx
      .select(CHARGE_PROJECTION)
      .from(charges)
      .where(eq(charges.stripePaymentIntentId, stripePaymentIntentId))
      .limit(1);
    return row;
  },

  /**
   * Flip a charge's status (`requires_payment` → `succeeded` / `failed`).
   * Stamps `updated_at = now()`. Idempotent — calling with the same target
   * status is a no-op write. Used by Day-15 webhook on terminal Stripe
   * events; surfaced here so the test-mode synchronous confirm path can
   * write a definitive status without round-tripping through the webhook.
   */
  async markStatus(tx: Tx, args: { id: string; status: ChargeStatus }): Promise<void> {
    await tx
      .update(charges)
      .set({ status: args.status, updatedAt: sql`now()` })
      .where(eq(charges.id, args.id));
  },

  /**
   * Group-class enrollment charges still sitting at `'requires_payment'` with
   * a PaymentIntent attached — the capture reconciler's worklist (wire 1.11.0,
   * `designs/partial-success-enrollment.md` §3.7).
   *
   * Under manual capture the enroll transaction writes this row at the honest
   * status for a HOLD and the post-commit capture flips it to `'succeeded'`.
   * A row still resting here past the grace interval means that flip did not
   * happen: the capture failed, the process died between commit and capture,
   * or the flip itself failed after Stripe took the money. All three are
   * money-visible and none of them resolve themselves.
   *
   * **This query cannot tell an enrollment hold from an invoice-lane
   * `'requires_payment'` row, and does not try.** `POST /invoices/:id/pay`
   * writes a non-succeeded charge for a group-class invoice with the same
   * purpose and the same cohort/dog stamps, on an AUTOMATIC-capture intent
   * that was then cancelled. The discriminator is the PaymentIntent's live
   * status, which only Stripe can answer, so the reconciler RETRIEVES before
   * it acts and captures nothing that is not `requires_capture`. A cheap query
   * plus an authoritative check beats a clever query and a guess.
   *
   * `olderThan` is compared against `created_at`, not `updated_at`: a touch
   * trigger moves `updated_at` on any write to the row, which would let an
   * unrelated update keep resetting the grace window.
   *
   * **`mintedAfter` is the exit state, and the ordering is the anti-starvation
   * rule** (ADDENDUM 1 R3, 2026-08-20). Two defects made this worklist a trap
   * before it had either:
   *
   *   - `ORDER BY created_at ASC LIMIT n` with no lease re-scans the SAME
   *     oldest rows every tick. Two outcomes never leave the set — a
   *     `lost-hold` writes nothing, and another lane's `requires_payment` row
   *     is never ours to write — so n permanently-stuck rows starve every
   *     newer, genuinely capturable hold behind them, silently.
   *   - Nothing aged out at all, so the set only ever grew.
   *
   * The claim now LEASES: it takes the n oldest by `updated_at`, bumps them,
   * and hands them back, so working a row moves it to the back of the queue
   * and no row can hold the front. Rows older than `mintedAfter` are refused
   * entirely and reported by {@link findAbandonedGroupClassCaptures} instead —
   * a row that has resisted this phase for a full day is not going to yield to
   * another tick, and the only useful thing left to do with it is name it to a
   * human once. Same posture, same reasoning, as `duplicateRefundRetry`'s
   * claim + abandon split. No DDL: `updated_at` and `created_at` already carry
   * it.
   *
   * `FOR UPDATE SKIP LOCKED` so two workers never claim the same row.
   */
  async claimPendingGroupClassCaptures(
    tx: Tx,
    args: { olderThan: Date; mintedAfter: Date; limit: number },
  ): Promise<PendingGroupClassCapture[]> {
    const due = await tx
      .select({ id: charges.id })
      .from(charges)
      .where(pendingGroupClassCaptureWhere(args))
      .orderBy(asc(charges.updatedAt))
      .limit(args.limit)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    const rows = await tx
      .update(charges)
      // The lease. `charges_touch` would move `updated_at` on any UPDATE
      // anyway; setting it explicitly is what makes the intent readable at the
      // call site rather than an accident of a trigger.
      .set({ updatedAt: sql`now()` })
      .where(
        inArray(
          charges.id,
          due.map((r) => r.id),
        ),
      )
      .returning(PENDING_CAPTURE_PROJECTION);
    return rows.map(narrowPendingCapture);
  },

  /**
   * Enrollment holds this phase has GIVEN UP on: still `'requires_payment'`,
   * still carrying a PaymentIntent, and minted before `mintedBefore`.
   *
   * Capped, because the caller names them individually in its alarm — and the
   * true count comes back separately, so a saturated page can never make owed
   * money look smaller than it is (the round-4 duplicate-refund lesson).
   */
  async findAbandonedGroupClassCaptures(
    runner: Tx | typeof db,
    args: { mintedBefore: Date; limit: number },
  ): Promise<{ rows: PendingGroupClassCapture[]; total: number }> {
    const where = and(
      eq(charges.purpose, 'group-class'),
      eq(charges.status, 'requires_payment'),
      isNotNull(charges.stripePaymentIntentId),
      isNotNull(charges.cohortId),
      isNotNull(charges.dogId),
      lt(charges.createdAt, args.mintedBefore.toISOString()),
    );
    const rows = await runner
      .select(PENDING_CAPTURE_PROJECTION)
      .from(charges)
      .where(where)
      .orderBy(asc(charges.createdAt))
      .limit(args.limit);
    // The COUNT is only asked when the page could be hiding rows. A short page
    // IS the count, and this phase runs every minute against a table that only
    // grows — an unconditional `count(*)` here would be a full scan per tick
    // for a number that is almost always zero.
    if (rows.length < args.limit) {
      return { rows: rows.map(narrowPendingCapture), total: rows.length };
    }
    const [counted] = await runner
      .select({ total: sql<number>`count(*)::int` })
      .from(charges)
      .where(where);
    return { rows: rows.map(narrowPendingCapture), total: counted?.total ?? rows.length };
  },

  /**
   * Read a charge by primary key. Day-15 webhook uses this after looking
   * up by PaymentIntent id to fetch the row a refund webhook matched
   * against. Returns undefined if no such row.
   */
  async findById(tx: Tx, id: string): Promise<ChargeRow | undefined> {
    const [row] = await tx
      .select(CHARGE_PROJECTION)
      .from(charges)
      .where(eq(charges.id, id))
      .limit(1);
    return row;
  },
};
