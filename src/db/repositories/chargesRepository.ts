import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { ChargePurpose, ChargeStatus } from '../../contracts/wire.js';
import {
  chargeBelongsToEnrollment,
  type EnrollmentIdentity,
} from '../../lib/enrollmentIdentity.js';
import { db } from '../client.js';
import { leaseInstant } from '../locks.js';
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
    // R9: enrollment-purpose rows only. `POST /invoices/:id/pay` writes
    // `'group-class'` rows with the same cohort/dog stamps, and since P15 it writes
    // them on the order engine, whose charges carry `order_id` and are the engine's
    // to settle (DECISIONS 142(f)), so they are excluded here. Rows from before the
    // engine cannot be told apart, so the retrieve is still the authority for what
    // gets acted on, and the abandon window below is what stops a foreign row from
    // occupying the worklist forever.
    eq(charges.purpose, 'group-class'),
    eq(charges.status, 'requires_payment'),
    isNull(charges.orderId),
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
 * purchases, B&T deposits and group-class enrollment. NO `expired_at` —
 * charges are never soft-deleted; refunds against a charge are tracked
 * separately in the `refunds` table.
 *
 * Day 13 introduced the first read here. Day 14 adds the write path:
 *   - `create` — INSERT after Stripe `paymentIntents.create + confirm`
 *     returns; status mirrors what Stripe returned (`succeeded` for the
 *     test-mode happy path; `requires_action` / `processing` for 3DS
 *     and async-settled methods, with Day-15 webhook reconciling).
 *   - `markSucceeded` / `markFailed` — Day-15 webhook callees; left
 *     stubbed here so the cancel + tests can reference the contract.
 */

// Re-exported, not redeclared: `ChargeStatus` moved into the wire contract in
// 1.7.0 when `InvoicePayWire` did (it reports this value), and `conformance.ts`
// pins it against the `charge_status` pgEnum. Two copies could drift apart while
// both still compiled, which is what a hand `ChargePurpose` here did until 5.0.0-lg4.1:
// it kept two dead labels compiling after the database had refused them.
export type { ChargePurpose, ChargeStatus } from '../../contracts/wire.js';

export interface ChargeRow {
  id: string;
  ownerId: string;
  amountCents: number;
  status: ChargeStatus;
  bookingId: string | null;
  stripePaymentIntentId: string | null;
  purpose: ChargePurpose;
  /**
   * The dog this money is for, when the charge is per-dog (group-class).
   */
  dogId: string | null;
}

const CHARGE_PROJECTION = {
  id: charges.id,
  ownerId: charges.ownerId,
  amountCents: charges.amountCents,
  status: charges.status,
  bookingId: charges.bookingId,
  stripePaymentIntentId: charges.stripePaymentIntentId,
  purpose: charges.purpose,
  dogId: charges.dogId,
} as const;

/** `CHARGE_PROJECTION` plus the second half of the enrollment-membership rule
 *  (§A3.17), in DB microseconds (§A3.18 D3). Separate from the shared
 *  projection because `ChargeRow` is a published shape and only the
 *  membership-aware reads need the instant. */
const CHARGE_MEMBERSHIP_PROJECTION = {
  ...CHARGE_PROJECTION,
  createdAtUs: sql<string>`((EXTRACT(EPOCH FROM ${charges.createdAt})::numeric * 1000000)::bigint)::text`,
} as const;

/**
 * One row of the order engine's `charges` (M3.02): the whole row, because every
 * engine write reads it under {@link lockCharge} and acts on what it finds. The
 * engine's columns are `order_id`, K0, the attempt count, the lease, the stored
 * outcome and the frozen create parameters. `order_id` set is what makes a charge
 * the engine's (DECISIONS 142(f)).
 */
export type EngineChargeRow = typeof charges.$inferSelect;

/** A budget's milliseconds as a Postgres interval. */
function spanOf(ms: number): SQL {
  return sql`make_interval(secs => ${ms}::double precision / 1000)`;
}

/** The fence on every write that continues an attempt. */
function inLiveLease(id: string, at: Date | undefined): SQL | undefined {
  return and(
    eq(charges.id, id),
    eq(charges.status, 'requires_payment'),
    sql`${charges.attemptingUntil} > ${leaseInstant(at)}`,
    isNull(charges.nextSweepAt),
  );
}

/** Past its lease, and no claim of the sweeper's still running on it. */
function pastLeaseAndDue(at: Date | undefined): SQL | undefined {
  const now = leaseInstant(at);
  return and(
    eq(charges.status, 'requires_payment'),
    sql`${charges.attemptingUntil} <= ${now}`,
    or(isNull(charges.nextSweepAt), sql`${charges.nextSweepAt} <= ${now}`),
  );
}

function watchDue(at: Date | undefined): SQL | undefined {
  return and(eq(charges.status, 'failed'), sql`${charges.nextSweepAt} <= ${leaseInstant(at)}`);
}

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
   *      `refund_manual` NULL-PI row (remainder-positive forever, by design at
   *      the time) or a refund the bank terminally failed answered "money in
   *      hand" for the CURRENT enrollment, and the reconciler cancelled a live
   *      authorization for a dog sitting in the class. A (cohort, dog) is not
   *      an enrollment; withdraw + re-enroll mints a second one under the same
   *      key.
   *
   *      **Δ 2026-08-24 (money-residue 1.2): the NULL-PI half of that is now
   *      closed at the source.** The withdraw's `refund_manual` arm mints a
   *      terminal `'unroutable'` refunds row for the remainder, and
   *      `sumNonFailedForCharge` counts it — so such a charge reads REMAINDER
   *      ZERO from the next instant onward and can never again answer "money in
   *      hand" to anybody. The identity rule above is not weakened by that and
   *      is still the thing doing the work for the `stripe-failed` half, which
   *      genuinely does reopen a remainder (`ne('failed')`) until a human
   *      resolves it.
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
   * The unsettled group-class charge rows for one (cohort, dog) — still at
   * `'requires_payment'` with a PaymentIntent attached (ADDENDUM 3 §A3.2
   * step 3, the withdraw arm's advisory money-state read).
   *
   * Under manual capture such a row is a LIVE HOLD on the owner's card, not a
   * dead attempt: the enroll transaction writes it at the honest status for an
   * authorization and the post-commit capture flips it. A withdraw that ignores
   * it releases nothing and stops nothing, which is exactly the round-3
   * blocker. Read on the pool, advisory only — Stripe's live answer is the
   * authority for what happened, and the in-tx settle table re-derives from the
   * authoritative rows plus that answer.
   *
   * **A STAMPED row of ANOTHER enrollment is refused outright** (ADDENDUM 3
   * §A3.17). A withdraw settles the rows it picks here AT STRIPE and reports on
   * them, so picking a previous enrollment's hold means cancelling money this
   * withdraw was never about while the live one goes unmentioned. Identity
   * answers that where ordering cannot. Legacy (NULL-anchor) rows join the same
   * rule (§A3.18 D5) — OP-4 executed the cost of exempting them: a withdraw
   * reported a two-day-old foreign $50 hold as THIS class's `released_cents`
   * and cancelled it at Stripe.
   *
   * **Two readers, and the difference is a real invariant, not a taste.**
   *
   *   - {@link findAllPendingCaptureForCohortDog} returns EVERY member row.
   *     The invoice lane needs it: the pay route has no guard against
   *     re-attempting while a prior PI is still `processing`, and each
   *     non-succeeded attempt mints a fresh row — so a (cohort, dog) carrying
   *     several is ordinary use. Resolving all of them is what CLOSES the
   *     ordering window described below, rather than merely bounding it
   *     (§A2.1, 2026-08-24).
   *   - {@link findPendingCaptureForCohortDog} returns the NEWEST one only,
   *     and is now the PAY-NOW call site's read exclusively. Its license is
   *     §A3.14's echo chain: at most one live hold per dog exists on that
   *     lane (a refused dog mints no charge row at all, §A3.13), so "newest"
   *     and "all" coincide there and the single-row read is exact.
   *
   * **The superseded justification, named so it cannot be cited again.** This
   * block used to argue that sampling the newest row left only a
   * "bounded-failure window", because a dead bookkeeping row would retrieve
   * `canceled` and "the withdraw truthfully reports `released`" while the
   * reconciler released the real hold within a tick. That reasoning was
   * REFUTED EXECUTABLY on the invoice lane (§A2.1): with attempt #1
   * `processing` and attempt #2 declined, the newest row is the DEAD one, and
   * the withdraw answered `'voided'` — "you were never charged" — over money
   * still in motion. A sentence about the owner's money is not a bounded
   * failure. The invoice lane therefore resolves every row; the argument above
   * survives only where §A3.14 makes the multi-row case impossible.
   *
   * No lease and no `FOR UPDATE`: one request settling its own owner's
   * withdraw, not a worklist.
   */
  async findAllPendingCaptureForCohortDog(
    tx: Tx,
    args: { cohortId: string; dogId: string; enrollment: EnrollmentIdentity | undefined },
  ): Promise<
    { id: string; amountCents: number; stripePaymentIntentId: string; orderId: string | null }[]
  > {
    const candidates = await tx
      .select({
        id: charges.id,
        amountCents: charges.amountCents,
        stripePaymentIntentId: charges.stripePaymentIntentId,
        orderId: charges.orderId,
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
    return candidates
      .filter((candidate) => chargeBelongsToEnrollment(candidate, args.enrollment))
      .map((row) => ({
        id: row.id,
        amountCents: row.amountCents,
        // Narrowed by the IS NOT NULL predicate above.
        stripePaymentIntentId: row.stripePaymentIntentId as string,
        orderId: row.orderId,
      }));
  },

  /**
   * The NEWEST unsettled group-class charge row for one (cohort, dog) — the
   * pay-now withdraw lane's read. See
   * {@link findAllPendingCaptureForCohortDog} for the shared predicate, the
   * §A3.17 membership rule, and why exactly one lane may sample.
   */
  async findPendingCaptureForCohortDog(
    tx: Tx,
    args: { cohortId: string; dogId: string; enrollment: EnrollmentIdentity | undefined },
  ): Promise<
    | { id: string; amountCents: number; stripePaymentIntentId: string; orderId: string | null }
    | undefined
  > {
    const [newest] = await this.findAllPendingCaptureForCohortDog(tx, args);
    return newest;
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
   * **This query cannot tell an enrollment hold from a pre-engine invoice-lane
   * `'requires_payment'` row, and does not try.** `POST /invoices/:id/pay` wrote a
   * non-succeeded charge for a group-class invoice with the same purpose and the
   * same cohort/dog stamps, on an AUTOMATIC-capture intent that was then cancelled.
   * The discriminator is the PaymentIntent's live status, which only Stripe can
   * answer, so the reconciler RETRIEVES before it acts and captures nothing that is
   * not `requires_capture`. A cheap query plus an authoritative check beats a clever
   * query and a guess. The route's rows since P15 carry `order_id` and are excluded:
   * the order engine settles its own charges.
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
      isNull(charges.orderId),
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

  /**
   * Read a charge by primary key, under the row's LOCK — the acquisition point
   * for the **one global lock order, charges → refunds** (MR-A1.2(ii)).
   *
   * Every transaction that locks rows in BOTH tables takes the charge first.
   * `handleChargeRefundUpdated` uses this: it matches the refund row unlocked
   * (its write-time status guards are what make that safe, the `markUnroutable`
   * pattern), resolves the charge id, locks HERE, then re-reads the refund row
   * under the held lock before writing. Before the conversion that handler wrote
   * refunds-then-charges, which made a charge-first lock inside
   * `markResolvedExternal` an AB-BA deadlock pair — so the fix for one had to be
   * the fix for both.
   *
   * The refunds-ONLY writers are outside this order by construction and must
   * stay that way: `claimStalePendingForRetry` (`FOR UPDATE SKIP LOCKED` on
   * refunds, never touches charges), `markStripeId`, and `markUnroutable` — none
   * of them subsequently acquires a charges lock. A future edit that gives any
   * of them one creates a cycle.
   */
  async findByIdForUpdate(tx: Tx, id: string): Promise<ChargeRow | undefined> {
    const [row] = await tx
      .select(CHARGE_PROJECTION)
      .from(charges)
      .where(eq(charges.id, id))
      .limit(1)
      .for('update');
    return row;
  },

  // -------------------------------------------------------------------
  // The order engine (P15, `lib/confirmCharge.ts`). Two columns, two owners:
  // `attempting_until` is the request's and `next_sweep_at` the sweeper's. Every write
  // that continues an attempt is conditional on `status = 'requires_payment'`, on the
  // lease and on no claim of the sweeper's, and is committed on its own, because the
  // Stripe call it guards runs with no tx open. Leases are judged and written on
  // Postgres's `now()` unless a test injected `at` ({@link leaseInstant}).
  // -------------------------------------------------------------------

  /** tx1's one charge: `requires_payment`, K0, the frozen parameters, the lease. */
  async createForOrder(
    tx: Tx,
    args: {
      ownerId: string;
      orderId: string;
      amountCents: number;
      purpose: ChargePurpose;
      bookingId: string | null;
      cohortId: string | null;
      dogId: string | null;
      stripeIdempotencyKey: string;
      stripeCustomerId: string;
      stripePaymentMethodId: string;
      paymentMethodId: string;
      /** A package or top-up charge's frozen purchase (M4.10). */
      packageId?: string;
      creditsCount?: number;
      at?: Date;
      leaseMs: number;
    },
  ): Promise<EngineChargeRow> {
    const [row] = await tx
      .insert(charges)
      .values({
        ownerId: args.ownerId,
        orderId: args.orderId,
        amountCents: args.amountCents,
        currency: 'usd',
        status: 'requires_payment',
        purpose: args.purpose,
        bookingId: args.bookingId,
        cohortId: args.cohortId,
        dogId: args.dogId,
        stripeIdempotencyKey: args.stripeIdempotencyKey,
        stripeCustomerId: args.stripeCustomerId,
        stripePaymentMethodId: args.stripePaymentMethodId,
        paymentMethodId: args.paymentMethodId,
        ...(args.packageId !== undefined ? { packageId: args.packageId } : {}),
        ...(args.creditsCount !== undefined ? { creditsCount: args.creditsCount } : {}),
        attemptingUntil: sql`${leaseInstant(args.at)} + ${spanOf(args.leaseMs)}`,
      })
      .returning();
    if (!row) throw new Error('chargesRepository.createForOrder: INSERT returned no row');
    return row;
  },

  async findEngineById(runner: Tx | typeof db, id: string): Promise<EngineChargeRow | undefined> {
    const [row] = await runner.select().from(charges).where(eq(charges.id, id)).limit(1);
    return row;
  },

  async findEngineByPaymentIntentId(
    runner: Tx | typeof db,
    stripePaymentIntentId: string,
  ): Promise<EngineChargeRow | undefined> {
    const [row] = await runner
      .select()
      .from(charges)
      .where(eq(charges.stripePaymentIntentId, stripePaymentIntentId))
      .limit(1);
    return row;
  },

  /** An order's one charge; `undefined` is a credits-only order. */
  async findEngineByOrderId(
    runner: Tx | typeof db,
    orderId: string,
  ): Promise<EngineChargeRow | undefined> {
    const [row] = await runner.select().from(charges).where(eq(charges.orderId, orderId)).limit(1);
    return row;
  },

  /**
   * The conditional lease renewal before every Stripe call (design §2.7:3859-3862).
   * `false` means the lease is gone, the sweeper claimed the row, or the charge moved:
   * stop, the sweeper owns the order. The claim's fence is as needed as the lease: a
   * renewal that started in time and blocked on the row must fail its re-check once
   * the claim commits. `countAttempt` commits `attempt_count` in the same write, before
   * the call.
   */
  async renewLease(
    runner: Tx | typeof db,
    args: { id: string; at?: Date; leaseMs: number; countAttempt: boolean },
  ): Promise<boolean> {
    const rows = await runner
      .update(charges)
      .set({
        attemptingUntil: sql`${leaseInstant(args.at)} + ${spanOf(args.leaseMs)}`,
        ...(args.countAttempt ? { attemptCount: sql`${charges.attemptCount} + 1` } : {}),
      })
      .where(inLiveLease(args.id, args.at))
      .returning({ id: charges.id });
    return rows.length > 0;
  },

  /**
   * Commit the intent's id, in one short conditional write. Only a charge still
   * inside its lease and unclaimed takes it: a request that outlived its lease stores
   * nothing and never confirms, so a charge with no stored id stays a charge no card
   * was tried on, and the row the sweeper's claim returned cannot go stale.
   */
  async storeIntentId(
    runner: Tx | typeof db,
    args: { id: string; intentId: string; at?: Date },
  ): Promise<boolean> {
    const rows = await runner
      .update(charges)
      .set({ stripePaymentIntentId: args.intentId })
      .where(inLiveLease(args.id, args.at))
      .returning({ id: charges.id });
    return rows.length > 0;
  },

  /** A late success on a charge abandoned with no id: the arm takes it from the event. */
  async storeLateIntentId(tx: Tx, args: { id: string; intentId: string }): Promise<void> {
    await tx
      .update(charges)
      .set({ stripePaymentIntentId: args.intentId })
      .where(eq(charges.id, args.id));
  },

  /** The settle's flip. The caller holds the charge lock and read the status under it. */
  async markEngineSucceeded(tx: Tx, args: { id: string; intentId: string }): Promise<void> {
    await tx
      .update(charges)
      .set({
        status: 'succeeded',
        stripePaymentIntentId: args.intentId,
        blocker: null,
        attemptingUntil: null,
        nextSweepAt: null,
      })
      .where(eq(charges.id, args.id));
  },

  /**
   * The stored outcome of a failure. The caller holds the charge lock. `nextSweepAt`
   * opens the watch: a first-look time, which fences nothing, so a process clock is
   * fine here. NULL means nothing can still move. A `lastError` of NULL says this
   * settler heard no reason, not that none was given: Stripe drops `last_payment_error`
   * on a cancel, and `last_stripe_error` is the desk's only record of a decline, so what
   * the advisory `payment_failed` wrote stays.
   */
  async markEngineFailed(
    tx: Tx,
    args: {
      id: string;
      blocker: string | null;
      lastError: string | null;
      nextSweepAt: Date | null;
    },
  ): Promise<void> {
    await tx
      .update(charges)
      .set({
        status: 'failed',
        blocker: args.blocker,
        lastStripeError: sql`COALESCE(${args.lastError}, ${charges.lastStripeError})`,
        attemptingUntil: null,
        nextSweepAt: args.nextSweepAt?.toISOString() ?? null,
      })
      .where(eq(charges.id, args.id));
  },

  /** A `succeeded` row claims no lease and is on no watch. The caller holds the lock. */
  async clearEngineClaims(tx: Tx, args: { id: string }): Promise<void> {
    await tx
      .update(charges)
      .set({ attemptingUntil: null, nextSweepAt: null })
      .where(eq(charges.id, args.id));
  },

  /** `payment_failed` is advisory: this and nothing else. */
  async writeLastStripeError(tx: Tx, args: { id: string; lastError: string }): Promise<void> {
    await tx
      .update(charges)
      .set({ lastStripeError: args.lastError })
      .where(eq(charges.id, args.id));
  },

  /**
   * The sweeper's first worklist: charges past their lease and due a look, longest-
   * waiting first, so fresh rows cannot starve a re-look.
   */
  async findPastLease(
    runner: Tx | typeof db,
    args: { at?: Date; limit: number },
  ): Promise<EngineChargeRow[]> {
    return runner
      .select()
      .from(charges)
      .where(and(isNotNull(charges.orderId), pastLeaseAndDue(args.at)))
      .orderBy(sql`COALESCE(${charges.nextSweepAt}, ${charges.attemptingUntil})`)
      .limit(args.limit);
  },

  /**
   * The sweeper's claim, committed before any Stripe call: a second tick finds the
   * row claimed and skips it, so overlapping ticks cannot share one. It writes
   * `next_sweep_at` and never `attempting_until`, so a lease once lost stays lost and
   * the request is fenced for good. The returned row is what the sweeper acts on: past
   * this write its intent id cannot change. `undefined`: somebody else has it.
   */
  async claimPastLease(
    runner: Tx | typeof db,
    args: { id: string; at?: Date; sweepClaimMs: number },
  ): Promise<EngineChargeRow | undefined> {
    const [row] = await runner
      .update(charges)
      .set({ nextSweepAt: sql`${leaseInstant(args.at)} + ${spanOf(args.sweepClaimMs)}` })
      .where(and(eq(charges.id, args.id), pastLeaseAndDue(args.at)))
      .returning();
    return row;
  },

  /** The sweeper's second worklist: `failed` charges whose watch is due a look. */
  async findWatched(
    runner: Tx | typeof db,
    args: { at?: Date; limit: number },
  ): Promise<EngineChargeRow[]> {
    return runner
      .select()
      .from(charges)
      .where(watchDue(args.at))
      .orderBy(asc(charges.nextSweepAt))
      .limit(args.limit);
  },

  /**
   * Claim a watched charge, committed before any Stripe call. Rewriting the column
   * moves the row to the back of the worklist, so 25 stuck rows cannot starve a 26th.
   */
  async claimWatched(
    runner: Tx | typeof db,
    args: { id: string; at?: Date; sweepClaimMs: number },
  ): Promise<EngineChargeRow | undefined> {
    const [row] = await runner
      .update(charges)
      .set({ nextSweepAt: sql`${leaseInstant(args.at)} + ${spanOf(args.sweepClaimMs)}` })
      .where(and(eq(charges.id, args.id), watchDue(args.at)))
      .returning();
    return row;
  },

  /** Nothing left to look at: Stripe has said something final. */
  async closeWatch(runner: Tx | typeof db, args: { id: string }): Promise<void> {
    await runner
      .update(charges)
      .set({ nextSweepAt: null })
      .where(and(eq(charges.id, args.id), eq(charges.status, 'failed')));
  },
};
