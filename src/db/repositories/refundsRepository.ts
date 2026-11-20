import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, isNull, like, lte, notLike, or, sql } from 'drizzle-orm';
import { ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  ChargePurpose,
  RefundInstrument,
  RefundResolvedOutcome,
  RefundStatus,
} from '../../contracts/wire.js';
import { db } from '../client.js';
import { pgTimestampToDate } from '../../lib/pgTimestamp.js';
import { lockPools } from '../locks.js';
import type { GrantLot } from './creditLedgerRepository.js';
import { charges, creditLedger, creditPackages, owners, refunds, staff } from '../schema/schema.js';
import { visibleOrNull } from '../visibleText.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx ops, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * What {@link refundsRepository.mintCappedPendingRefund} decided, under the
 * charge row's lock (§A3.18 D2).
 */
/**
 * What {@link refundsRepository.adoptExternalRefundCapped} decided, under the
 * charge row's lock (MR-A1.2 — the adoption INSERT is a cap-entering write and
 * obeys the same rule every mint does).
 */
export type AdoptedExternalRefund = {
  kind: 'adopted';
  refund: RefundRow;
  /** What the charge could still return BEFORE this row counted: below the adopted amount,
   *  the dashboard refund went past the cap, and the caller says so (design.md:4270-4272). */
  remainingBeforeCents: number;
};

/**
 * The `refunds.reason` of the order engine's automatic refund of a late success (follow-up
 * 4, SIGNOFF.md:208-209). Kept here, beside the query that reads it, so the money module
 * that writes it (`confirmCharge.ts`) and the apply function that recomputes its charge
 * (`refundApply.ts`) import one string without a cycle.
 */
export const LATE_SUCCESS_REFUND_REASON = 'late-success-refund';

/**
 * Thrown by {@link refundsRepository.markStatus} for a write the state machine does not
 * have. Every caller decides under the charge lock first, so this is a defect, and loud.
 */
export class RefundStatusTransitionError extends Error {}

/**
 * The refund state machine's moves through `markStatus` (6.0.0, design §2.7:4220-4228): the
 * target, and the statuses it may be written FROM. `pending → succeeded | failed`, and the
 * ONE backwards edge, `succeeded → failed`, which a refund arm takes once, when the
 * retrieved refund reads `failed`. `unroutable` and `resolved-external` have their own
 * writers ({@link refundsRepository.markUnroutable},
 * {@link refundsRepository.markResolvedExternal}) and take no event.
 */
const REFUND_STATUS_FROM: Partial<Record<RefundStatus, readonly RefundStatus[]>> = {
  succeeded: ['pending'],
  failed: ['pending', 'succeeded'],
};

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
 * TERMINAL and reachable two ways: minted there by the group-class withdraw's
 * `refund_manual` arm (2026-08-24, `designs/money-residue.md` §3 — the last
 * NULL-PI money-back path that recorded nothing), or flipped there from
 * `'pending'` by {@link refundsRepository.markUnroutable}. (A third,
 * `cancelBookingService`'s no-PaymentIntent branch, was deleted with the
 * cancel's money-back branch in P21, wire 6.0.0-lg5.2; rows it minted stay.) Nothing ever leaves
 * it automatically — the money returns when a human returns it.
 *
 * `'resolved-external'` (2026-08-24, `designs/money-residue.md` §4) is the exit
 * `'failed'` and `'unroutable'` never had. It means **the money behind this row
 * was returned OUTSIDE our Stripe machinery, attested by a named human** — and
 * it is written by exactly one verb, {@link refundsRepository.markResolvedExternal},
 * from exactly those two statuses. Nothing automatic produces it and nothing
 * leaves it: the complete state machine is
 *
 *   pending → succeeded | failed      (the one apply function, `refundApply.ts`: a
 *                                      create's reply, a refund event, the poll, the look-up)
 *   succeeded → failed                (P22: the ONE backwards edge, once, from any refund
 *                                      arm whose retrieved refund reads `failed`)
 *   pending → failed                  (P22: Stripe refused the create, B-7(c); or no refund
 *                                      exists for it past the key window, B-7(b))
 *   pending → unroutable              (born terminal, or the sweep's flip)
 *   failed | unroutable → resolved-external   (STAFF, note required)
 *   resolved-external → ∅             (terminal; webhook events on it no-op)
 */
// Re-exported, not redeclared: `RefundStatus` moved into the wire contract in
// 1.13.0 (digest refunds/S), and `conformance.ts` pins it against the
// `refund_status` pgEnum. Two copies could drift apart while both still
// compiled — the `ChargeStatus`/`chargesRepository` precedent
// (`chargesRepository.ts:107-111`). Consumers are unchanged: this export keeps
// `webhooks/stripeEventHandlers.ts:25` and `workers/duplicateRefundRetry.ts:4-8`
// importing the name from here.
export type { RefundStatus } from '../../contracts/wire.js';

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
 *   - Day 13: `createPending` from the cancel-money-back branch (deleted in
 *             P21, wire 6.0.0-lg5.2: a booking cancel mints no refund).
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

/**
 * What {@link refundsRepository.markResolvedExternal} decided, under the charge lock
 * (P22; design §2.7:4310-4322): `resolved` → 200, `not_found` → 404, `wrong_status` → 409
 * `conflict`, `superseded` → 409 `refund_superseded`, `in_flight` → 409 `refund_in_flight`,
 * `instrument_required` → 400 `bad_request`, `over_remainder` → 422 `over_cap`. Never a
 * `resolved` on a write that changed no row.
 */
export type ResolveExternalResult =
  | { kind: 'resolved'; ownerId: string; creditsReturned: number }
  | { kind: 'not_found' }
  | { kind: 'wrong_status' }
  | { kind: 'superseded' }
  | { kind: 'in_flight' }
  | { kind: 'instrument_required' }
  | { kind: 'over_remainder' };

/** A lot a `withdrawn` put-back writes to, with its pool. */
export type PutBackLot = GrantLot;

/** The row behind `RefundWire`, names joined ({@link refundsRepository.findWireRow}). */
export interface RefundWireRow {
  id: string;
  chargeId: string;
  ownerId: string;
  ownerName: string;
  purpose: ChargePurpose;
  packageLabel: string | null;
  amountCents: number;
  instrument: RefundInstrument;
  returnedInstrument: 'cash' | 'check' | null;
  status: RefundStatus;
  reason: string | null;
  issuedByStaffId: string | null;
  issuedByName: string | null;
  retryOfRefundId: string | null;
  enrollmentId: string | null;
  resolvedByStaffId: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  resolvedOutcome: RefundResolvedOutcome | null;
  createdAt: string;
}

/**
 * One row of a charge's RETURNED COVERAGE as the owner's ledger reads it
 * ({@link refundsRepository.findReturnedRowsForCharges}). The timestamps are Postgres's
 * text (`mode: 'string'`); the ledger picks the moment and parses it.
 */
export interface ReturnedRefundForCharge {
  id: string;
  chargeId: string;
  amountCents: number;
  status: RefundStatus;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * A refund *Returned* closed `withdrawn` moved no money (6.0.0; design §2.7:4242-4251):
 * it counts nowhere money is summed — the cap ({@link refundsRepository.sumNonFailedForCharge}),
 * the returned coverage and the rows behind it. A `resolved-external` row with no outcome
 * was closed before 6.0.0, was money returned, and still counts (D5). `IS DISTINCT FROM`,
 * so every row with no outcome passes.
 */
const NOT_WITHDRAWN = sql`${refunds.resolvedOutcome} IS DISTINCT FROM 'withdrawn'`;

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
 * (`cade494`), by `settleInvoiceCharge`'s lost-race arm — which the auto-charge
 * worker of the day and `POST /invoices/:id/pay` both called. The worker's
 * post-commit fire was always keyed on our refund-row uuid. The route's was NOT:
 * until this branch it built
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
 *
 * **DEPLOY RIDER, riding beside that advance** (2026-08-24,
 * `designs/money-residue.md` §4.2). The live DBs are hand-ALTERed and no gate
 * can prove them equal to `schema.sql`, so whoever advances the constant above
 * also runs, in the same window:
 *
 *     ALTER TYPE refund_status ADD VALUE 'resolved-external';
 *     ALTER TABLE refunds ADD COLUMN resolution_note text;
 *     ALTER TABLE refunds ADD COLUMN resolved_by_staff_id uuid REFERENCES staff(id);
 *     ALTER TABLE refunds ADD COLUMN resolved_at timestamptz;
 *
 * Additive, no backfill, no rewrites. `ADD VALUE` is effectively irreversible
 * in Postgres — accepted for the same reason `'unroutable'` was: the arm names
 * a real, permanent business state.
 *
 * **INTERIM-OPS RESOLUTION (MR-A1.1 rider).** Until the §4.6 portal route
 * exists, prefer a one-off maintenance SCRIPT that invokes
 * {@link refundsRepository.markResolvedExternal} — the charge lock, both
 * guards and both columns then apply for free. Raw SQL is the fallback, and it
 * must mirror the verb in full: `status IN ('failed','unroutable')`, no
 * `'pending'` refund on the charge, `amount_cents` within the charge's live
 * remainder, and it must stamp `resolved_at = now()` plus a `resolution_note`
 * naming the human (`resolved_by_staff_id` NULL).
 */
export const REFUND_SWEEP_FLOOR = new Date('2026-08-14T00:00:00.000Z');

/**
 * **The fresh key of a refund whose key holds a stored server error** (P22 B-7(b), 145(d)):
 * `refund-rekey:<row id>:<epoch seconds>`. Derived from the row's id, so it is ours alone,
 * and stamped with the instant it was written onto the row, which is the instant of its one
 * send (it is written in a committed UPDATE immediately before the call). No column holds
 * that instant, and the end state needs it: "24 hours after the last create sent under the
 * row's current key". A fresh key is sent exactly once, so its own text is that record; no
 * new state. It is not derived from a client key, so it puts nothing on
 * `STRIPE_DERIVED_KEY_SUFFIXES` (`mutation.ts`) and does not tighten
 * `IDEMPOTENCY_KEY_MAX_LEN` (60 characters, well under Stripe's 255).
 */
export const REKEYED_REFUND_KEY_PREFIX = 'refund-rekey:';

export function rekeyedRefundKey(refundId: string, at: Date): string {
  return `${REKEYED_REFUND_KEY_PREFIX}${refundId}:${Math.floor(at.getTime() / 1000)}`;
}

/** The instant a fresh key was written and sent, or `undefined` for any other key. */
export function rekeyedAt(key: string | null): Date | undefined {
  if (key === null || !key.startsWith(REKEYED_REFUND_KEY_PREFIX)) return undefined;
  const seconds = Number(key.slice(key.lastIndexOf(':') + 1));
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined;
}

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
 *     is not {@link ROW_KEYED_REFUND_REASON} (`'cancel'`, for one), or it is but
 *     the row predates {@link REFUND_SWEEP_FLOOR}. Operationally identical: the original Stripe
 *     idempotency key was the client's request key, no automatic path can
 *     reproduce it, and a human must CHECK Stripe for an existing refund before
 *     issuing one. **Frozen and finite** — since 2026-08-19 every writer stores
 *     its key, so nothing new can join this class.
 *   - `row-keyed` — the key is KNOWN: stored on the row, or (pre-2026-08-19,
 *     post-floor `duplicate-invoice-settle`) reconstructible as
 *     `dup-settle-refund:<refund id>`. The sweep owns these, tried, and has now
 *     aged past the key window; a human can search that exact key in Stripe.
 *   - `covered` — **the quiet class** (MR-A1.5, definition corrected MR-A2.5(b)).
 *     A `'failed'` row whose charge has **no live remainder left** — i.e.
 *     `amount_cents − Σ non-failed ≤ 0`. It is counted in the tick summary and
 *     INFO-logged, never on the named page and never in the ERROR alarm's
 *     totals. Before this class existed `totalByClass['stripe-failed']` could
 *     not reach zero even after the money was returned, so the round-6 alarm
 *     could never clear and the worklist kept telling a human to "issue a FRESH
 *     refund" for money already sent. That instruction moves money twice.
 *
 *     **Which remainder, and why — two questions, two terms, no "equivalently".**
 *     MR-A1.5's text defined this on RETURNED coverage (succeeded +
 *     resolved-external) and claimed the two readings were equivalent. They are
 *     not: they differ by exactly the `pending` and `unroutable` rows, and the
 *     CODE has always asked the non-failed question. The code is right and the
 *     doc moved to it. Classification's only job is to gate a HUMAN
 *     INSTRUCTION, and that instruction's safety bound is the CAP: a failed row
 *     on a charge whose remainder is closed by a PENDING re-mint must be quiet,
 *     because ordering a human to act while automation is mid-flight is the
 *     double-movement invitation — the same reason guard (a) refuses resolution
 *     during pending. It self-heals in both directions: if that pending refund
 *     fails, the remainder reopens and the row re-shouts on the next tick.
 *
 *     **RETURNED coverage remains the LEDGER question** — the
 *     charge→`'refunded'` flip ({@link sumReturnedCoverageForCharge}) — and
 *     only that. `'covered'` = live non-failed remainder ≤ 0;
 *     ledger-refunded = returned coverage ≥ amount.
 */
export type AbandonedRefundClass =
  | 'never-sent'
  | 'client-keyed'
  | 'row-keyed'
  /**
   * P22 B-7(b): a `pending` row with no `re_` that the sweep is still asking Stripe about,
   * by its `metadata.refund_id`: its key answered a stored server error and it was sent
   * once under a fresh key, or it is a staff refund Stripe could not be reached for past
   * the retry window. Nothing should be sent for it by hand; the sweep ends it `failed` once
   * Stripe's key window has passed and Stripe holds no refund for it.
   */
  | 'awaiting-stripe'
  /** A failed HEAD of its chain that fits what its payment still owes: the two exits pay it. */
  | 'stripe-failed'
  /**
   * P22 B-7(c), Fable M1: a failed head LARGER than what its payment still owes (a
   * dashboard refund came first). *Retry to card* and *Returned* would each answer 422
   * `over_cap`, so the report names the figure owed and the road that pays it: a new
   * refund of that figure through *Refund*, with no credits to remove.
   */
  | 'failed-exceeds-owed'
  | 'covered';

export interface AbandonedRefundRow extends RefundRow {
  refundClass: AbandonedRefundClass;
  /**
   * Where a person can see this row (P22 B-7(e)): on the family's payment history when its
   * charge took money for the app (`succeeded` or `refunded`), and on no portal screen when
   * the charge is held `failed` (the late-success lane), until End of day (P25).
   */
  seenOn: string;
  /** The PI the refund reverses — `null` is what makes a row `never-sent`. */
  stripePaymentIntentId: string | null;
  /**
   * What the CHARGE still owes, live: `amount_cents − sumNonFailedForCharge`,
   * floored at 0 (MR-A1.5). Reported as CONTEXT, and it is the input to
   * `'covered'` classification (`0` is exactly that condition) — but it is NOT
   * the figure a human should return; see {@link actionableCents}.
   */
  remainingCents: number;
  /**
   * **THE ONE NUMBER TO OBEY** (MR-A2.3, corrected and generalized MR-A3.2).
   *
   * A worklist order must have exactly one figure, and MR-A2.3's
   * `min(amountCents, remainingCents)` was wrong in BOTH directions — each
   * executed by the Opus lane:
   *
   *   (a) `remainingCents` excludes ALL failed rows, so failed SIBLINGS were
   *       invisible to each other and each printed against the full remainder.
   *       Σ over-instructed by +10000c (two 10000c failed rows on one 10000c
   *       charge) and +3000c (three 3000c partials on a 9000c charge).
   *   (b) it INCLUDES the row itself when the row is PENDING, so a full-amount
   *       pending row in the refund-by-hand class printed **$0** — an
   *       instruction to return nothing on the one row whose whole point is a
   *       by-hand return.
   *
   * So the figure is now allocated over the charge's SHOUTING SET (the rows of
   * that charge in hand-action classes this pass; `covered` rows excluded by
   * construction), oldest-first and deterministically:
   *
   *   - **joint cap** = `amount_cents − Σ non-failed rows NOT in the shouting
   *     set`, floored at 0. Non-failed shouting rows are excluded from the
   *     subtraction because their return is exactly what is being instructed —
   *     counting them is defect (b) generalized.
   *   - **allocation**, in `created_at ASC, id ASC` order:
   *     `actionable_i = max(0, min(row_i.amount, jointCap − Σ allocated))`.
   *
   * Two properties, which are the point: every printed figure ≤ its row's
   * recorded obligation, and **Σ printed ≤ the charge's true cap, always** — so
   * a human who robotically obeys every row on the page returns at most what
   * the charge can owe, with no cross-referencing required. The single-row case
   * reduces to `min(amount, self-excluded remainder)`, fixing both directions.
   */
  actionableCents: number;
  /**
   * True when {@link actionableCents} is less than the row's own amount. The
   * alarm then names both figures and the reason, so the human can see WHY the
   * instruction is not simply the row's.
   */
  clipped: boolean;
  /**
   * Why the clip happened, or `null` when the row prints its full obligation.
   *
   *   - `'covered-elsewhere'` — the joint cap itself was below this row: money
   *     on this charge is already returned, attested, or still owned by
   *     automation.
   *   - `'allocated-to-older'` — an older sibling on the same charge consumed
   *     the capacity first.
   */
  clipReason: 'covered-elsewhere' | 'allocated-to-older' | null;
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
  /** The charge's live remainder. A failed row against a fully-covered charge
   *  is owed NOTHING and must leave the shouting class (MR-A1.5). */
  remainingCents: number;
  amountCents: number;
  /** A later retry names this row (D2, 279(b)): it is not its chain's head. */
  superseded: boolean;
  issuedByStaff: boolean;
}): AbandonedRefundClass {
  if (args.status === 'failed') {
    // D2 (design.md:4258-4259): a row a later retry names is covered whatever that retry's
    // state, because only the head may be retried or resolved; the head is owed, computed
    // for itself.
    if (args.superseded || args.remainingCents <= 0) return 'covered';
    return args.amountCents > args.remainingCents ? 'failed-exceeds-owed' : 'stripe-failed';
  }
  if (rekeyedAt(args.stripeIdempotencyKey) !== undefined || args.issuedByStaff) {
    return 'awaiting-stripe';
  }
  if (args.piId === null) return 'never-sent';
  // The stored key is the whole design: a row that carries one is retryable and
  // searchable regardless of which writer minted it or when.
  if (args.stripeIdempotencyKey !== null) return 'row-keyed';
  if (args.reason !== ROW_KEYED_REFUND_REASON) return 'client-keyed';
  return pgTimestampToDate(args.createdAt) > REFUND_SWEEP_FLOOR ? 'row-keyed' : 'client-keyed';
}

/**
 * A classified report row, before its actionable figure is allocated. The two
 * extra fields are assembly-only and are stripped from the published shape.
 */
type ClassifiedRow = Omit<AbandonedRefundRow, 'actionableCents' | 'clipped' | 'clipReason'> & {
  createdAt: string;
  /** The UNFLOORED charge remainder — see the select for why it is not the
   *  published, floored `remainingCents`. */
  remainderRawCents: number;
};

/**
 * **The MR-A3.2 allocation pass** — turn a page of shouting rows into one
 * obeyable number each, such that obeying ALL of them is also safe.
 *
 * Per charge: the joint cap is `amount − Σ non-failed rows NOT in the shouting
 * set`, which the assembly computes as `remainderRaw + Σ (shouting non-failed
 * amounts)` — no extra query, because `remainderRaw` already subtracted every
 * non-failed row and the shouting ones are exactly the returns being
 * instructed. Then a greedy oldest-first allocation hands each row
 * `min(its obligation, what is left of the cap)`.
 *
 * **Why allocation and not a "one live return per charge" note.** A note's
 * safety depends on a tired human NOTICING a shared-charge warning across rows
 * that may not even be adjacent on the page, and then doing the arithmetic
 * themselves — precisely what a worklist under fatigue drops. The misuse-proof
 * shape is the one where obeying each row's own number is safe in isolation AND
 * in total. The cost is one grouping pass over rows the report has already
 * fetched.
 *
 * Ordering is `created_at ASC, id ASC` — deterministic and stable across ticks,
 * because a worklist figure that moves between ticks is a worklist nobody can
 * act on.
 */
function allocateActionableFigures(rows: ClassifiedRow[]): AbandonedRefundRow[] {
  const byCharge = new Map<string, ClassifiedRow[]>();
  for (const row of rows) {
    const group = byCharge.get(row.chargeId);
    if (group === undefined) byCharge.set(row.chargeId, [row]);
    else group.push(row);
  }
  const allocated = new Map<
    string,
    { actionableCents: number; clipped: boolean; clipReason: AbandonedRefundRow['clipReason'] }
  >();
  for (const group of byCharge.values()) {
    const ordered = [...group].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    );
    const shoutingNonFailed = ordered
      .filter((row) => row.status !== 'failed')
      .reduce((sum, row) => sum + row.amountCents, 0);
    const jointCap = Math.max(0, (ordered[0]?.remainderRawCents ?? 0) + shoutingNonFailed);
    let spent = 0;
    for (const row of ordered) {
      const actionableCents = Math.max(0, Math.min(row.amountCents, jointCap - spent));
      const clipped = actionableCents < row.amountCents;
      allocated.set(row.id, {
        actionableCents,
        clipped,
        // An older sibling having taken capacity is the more actionable
        // explanation, so it wins when both are true.
        clipReason: !clipped ? null : spent > 0 ? 'allocated-to-older' : 'covered-elsewhere',
      });
      spent += actionableCents;
    }
  }
  return rows.map(({ createdAt: _createdAt, remainderRawCents: _raw, ...row }) => ({
    ...row,
    ...allocated.get(row.id)!,
  }));
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
   * Since 6.0.0 a row *Returned* closed `withdrawn` leaves it too: no money
   * moved, so the cap reopens by its amount ({@link NOT_WITHDRAWN}).
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
      .where(and(eq(refunds.chargeId, chargeId), ne(refunds.status, 'failed'), NOT_WITHDRAWN));
    return row?.total ?? 0;
  },

  /**
   * **THE cap** (P22; design §2.7:4182-4186, §2.10:4682-4697): what this charge can
   * still return, `amount_cents` minus every refund that counts
   * ({@link sumNonFailedForCharge}), floored at 0. One helper for the staff mint,
   * the retry, resolve-external and the proposal, each calling it with the charge
   * row's lock held, so what it reads stays true until the caller commits.
   * `staffBillingRepository`'s `REFUNDABLE_CENTS` is its SQL twin, and a table test
   * holds the two equal on every status and outcome.
   */
  async capRemainingForCharge(
    tx: Tx,
    charge: { id: string; amountCents: number },
  ): Promise<number> {
    return Math.max(charge.amountCents - (await this.sumNonFailedForCharge(tx, charge.id)), 0);
  },

  /**
   * One refund as the refund verbs answer it (`RefundWire`, wire 6.0.0): the row
   * with the names joined, so a screen composes its line from facts. The family's
   * name falls back to the email when it has no visible character, as
   * `PendingPaymentWire.owner` does; `packageLabel` is the label of the row the
   * charge bought, when it stored one.
   */
  async findWireRow(runner: Runner, id: string): Promise<RefundWireRow | undefined> {
    const issuer = alias(staff, 'refund_issuer');
    const resolver = alias(staff, 'refund_resolver');
    const [row] = await runner
      .select({
        id: refunds.id,
        chargeId: refunds.chargeId,
        ownerId: refunds.ownerId,
        ownerName: sql<string>`coalesce(${visibleOrNull(owners.name)}, ${owners.email})`,
        purpose: charges.purpose,
        packageLabel: creditPackages.label,
        amountCents: refunds.amountCents,
        instrument: refunds.instrument,
        returnedInstrument: refunds.returnedInstrument,
        status: refunds.status,
        reason: refunds.reason,
        issuedByStaffId: refunds.issuedByStaffId,
        issuedByName: issuer.name,
        retryOfRefundId: refunds.retryOfRefundId,
        enrollmentId: refunds.enrollmentId,
        resolvedByStaffId: refunds.resolvedByStaffId,
        resolvedByName: resolver.name,
        resolvedAt: refunds.resolvedAt,
        resolutionNote: refunds.resolutionNote,
        resolvedOutcome: refunds.resolvedOutcome,
        createdAt: refunds.createdAt,
      })
      .from(refunds)
      .innerJoin(owners, eq(owners.id, refunds.ownerId))
      .innerJoin(charges, eq(charges.id, refunds.chargeId))
      .leftJoin(creditPackages, eq(creditPackages.id, charges.packageId))
      .leftJoin(issuer, eq(issuer.id, refunds.issuedByStaffId))
      .leftJoin(resolver, eq(resolver.id, refunds.resolvedByStaffId))
      .where(eq(refunds.id, id))
      .limit(1);
    return row as RefundWireRow | undefined;
  },

  /**
   * Sum of SUCCEEDED refund amounts for one charge. Retained because it names
   * a narrower fact than {@link sumReturnedCoverageForCharge} — "what Stripe
   * confirmed WE returned" — but **it is no longer the input to any
   * charge→`'refunded'` decision**; see that helper for why.
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
   * **RETURNED COVERAGE** — money that has actually gone back to the owner for
   * this charge, by any route: `SUM(amount_cents)` over
   * `status IN ('succeeded','resolved-external')` (MR-A1.5 / MR-A1.6.3).
   *
   * ONE definition, THREE consumers — the webhook's ordinary
   * `charge.refund.updated` tail, the adoption tail, and
   * {@link markResolvedExternal}'s ledger rider — because they used to disagree.
   * The first two counted `sumSucceededForCharge`; the third counted
   * succeeded + resolved-external. So a **resolve-then-adopt** order left a
   * FULLY returned charge sitting at `'succeeded'` in the owner ledger (Fable
   * F3, executed): resolve 6000c, adopt 4000c on a 10000c charge, and the
   * adoption tail saw only its own 4000c.
   *
   * Also the netting input for the abandon report: a `'failed'` row whose
   * charge is fully covered is owed NOTHING, and telling a human to "issue a
   * FRESH refund" for it is an invitation to move the money twice.
   *
   * `'pending'` and `'unroutable'` are deliberately OUT: they are commitments,
   * not returns. They belong in {@link sumNonFailedForCharge} (which caps
   * future mints) and nowhere near a statement that the owner HAS their money.
   */
  async sumReturnedCoverageForCharge(tx: Runner, chargeId: string): Promise<number> {
    const [row] = await tx
      .select({
        total: sql<number | null>`COALESCE(SUM(${refunds.amountCents})::int, 0)`.as('total'),
      })
      .from(refunds)
      .where(
        and(
          eq(refunds.chargeId, chargeId),
          inArray(refunds.status, ['succeeded', 'resolved-external']),
          NOT_WITHDRAWN,
        ),
      );
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
      /** M5.10 (P22): a staff refund writes how the money goes back, who issued it and,
       *  on a retry, the failed row it repeats. Omitted by every automatic lane, which
       *  keeps the column defaults (`'original_card'`, NULL, NULL). */
      instrument?: RefundInstrument;
      issuedByStaffId?: string;
      retryOfRefundId?: string;
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
        ...(args.instrument !== undefined ? { instrument: args.instrument } : {}),
        ...(args.issuedByStaffId !== undefined ? { issuedByStaffId: args.issuedByStaffId } : {}),
        ...(args.retryOfRefundId !== undefined ? { retryOfRefundId: args.retryOfRefundId } : {}),
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
   * **THE LOCK ORDER, and the carve-out this RETIRES (MR-A1.2(ii),
   * 2026-08-24).** §A3.19 R1 stated a narrow carve-out: this helper "never
   * waits on an existing `refunds` row", which was the only reason
   * `stripeEventHandlers.ts`'s REVERSE (refunds-then-charges) write order could
   * not deadlock against it. That carve-out is retired in favour of something
   * strictly stronger, because a second charge-first writer
   * ({@link markResolvedExternal}) had to exist and the carve-out could not
   * accommodate it:
   *
   *   > **One global lock order: charges → refunds.** Every transaction that
   *   > locks rows in BOTH tables acquires the charge row first.
   *
   * The full inventory, uniform after the conversion:
   *   · mint (here) — charge `FOR UPDATE`, then INSERT refunds;
   *   · {@link markResolvedExternal} — charge `FOR UPDATE`, re-read + UPDATE
   *     refunds;
   *   · {@link adoptExternalRefundCapped} — charge `FOR UPDATE`, guard + INSERT
   *     refunds;
   *   · `applyLiveRefund` (`lib/refundApply.ts`, since P22 the one apply function
   *     for the four refund events, the create's reply and the refund sweep's poll
   *     and look-up) — charge `FOR UPDATE` first, then every refunds read and
   *     write under it: the match, the guarded status write, an adoption's INSERT,
   *     the cumulative tail.
   * No cycle is constructible among charges-first writers. The refunds-ONLY
   * writers — {@link claimStalePendingForRetry} (`FOR UPDATE SKIP LOCKED`),
   * {@link markStripeId}, {@link markUnroutable} — hold refunds row locks and
   * **never subsequently acquire a charges lock**; a future edit that gives one
   * of them a charges lock re-opens the cycle this ruling closed.
   *
   * **The cap-entering rule, named (MR-A1.2(i)).** Any transaction that INSERTs
   * a row into, or moves a row INTO, the non-failed set of
   * {@link sumNonFailedForCharge} must hold that charge's row lock at the time
   * of the write. Cap-LEAVING flips (`pending → failed`) stay lock-free ON
   * PURPOSE: an opening cap can only defer a refund, never double one.
   *
   * **What the lock still does NOT serialize (§A3.19 R4):** the webhook's
   * `pending → failed` flip does not take it, so a mint can read a sum that
   * still counts a refund Stripe has just failed. The stale direction is
   * UNDER-refund — we return less than we could — which is the safe one: the
   * reopened remainder surfaces on the `stripe-failed` abandon report for a
   * human, and no money leaves twice.
   *
   * **It is one helper, and that is the point.** Several legs mint capped
   * refunds (the withdraw's succeeded and refunded-verdict arms,
   * `settlePostWithdrawRefund`, the invoice settle's lost-race/void arm, and the
   * reconciler's surplus arm; `cancelBookingService`'s money-back branch was one
   * until P21, wire 6.0.0-lg5.2, deleted it). Open-coding lock-sum-cap-mint in
   * each is how the next one forgets the lock.
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
      /**
       * P22 B-7(d): mint nothing when the charge already carries a refund of `reason`, in
       * any status, decided under this lock. The late-success lane's one-row-per-obligation
       * rule: a refund Stripe failed goes to a person, who has *Retry to card*.
       */
      oncePerReason?: true;
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
    if (
      args.oncePerReason === true &&
      args.reason != null &&
      (await this.hasRefundWithReason(tx, args.chargeId, args.reason))
    ) {
      return { kind: 'nothing-to-refund' };
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
   * money-back mint for a charge that carries no `stripe_payment_intent_id` (the
   * group-class withdraw's `refund_manual` arm; the booking cancel's
   * no-PaymentIntent branch, its first caller, was deleted in P21, wire 6.0.0-lg5.2).
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
      /** P22: a staff refund on a charge with no PaymentIntent is born here, with its
       *  chosen instrument and its issuer (design §2.7:4299-4300). */
      id?: string;
      instrument?: RefundInstrument;
      issuedByStaffId?: string;
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
        status: 'unroutable',
        stripeIdempotencyKey: null,
        ...(args.instrument !== undefined ? { instrument: args.instrument } : {}),
        ...(args.issuedByStaffId !== undefined ? { issuedByStaffId: args.issuedByStaffId } : {}),
      })
      .returning(REFUND_PROJECTION);
    if (!row) {
      throw new Error('refundsRepository.createUnroutable: refunds INSERT returned no row');
    }
    return row;
  },

  /**
   * INSERT one refund row TERMINAL at the status Stripe just reported, for a
   * refund **we did not create** — the webhook ADOPTION arm
   * (`designs/money-residue.md` §4.4).
   *
   * A staff member refunding from the Stripe dashboard fires
   * `charge.refund.updated` carrying a `re_*` nothing here has ever seen. Until
   * now the handler's not-found arm threw `WebhookRetryError` → 500 → Stripe
   * redelivered for days, and the returned money reached neither the ledger nor
   * the cumulative cap. This records it.
   *
   * `stripe_idempotency_key` is NULL by construction and that is a STATEMENT,
   * not an omission: the refund already exists AT Stripe, so nothing will ever
   * fire this row and no sweep may touch it — the same NULL-means-no-automatic-
   * retry reading `createUnroutable` relies on. `stripe_refund_id` is UNIQUE, so
   * a redelivery of the same `re_*` matches the adopted row on the way in and
   * takes the ordinary status arms instead of adopting twice.
   *
   * **The lock and the guard live HERE, not at the caller** (MR-A1.2, Fable F2).
   * This INSERT moves a row INTO `sumNonFailedForCharge`, which makes it a
   * cap-ENTERING write, and every one of those must hold the charge row's lock
   * at the time of the write — otherwise it can commit against a remainder a
   * concurrent minter already spent. Putting the `SELECT … FOR UPDATE` next to
   * the write it protects is the same discipline
   * {@link mintCappedPendingRefund} follows, and for the same reason: a lock
   * the caller is trusted to take is a lock the next caller forgets.
   *
   * **No in-flight refusal since P22** (Fable H2). It refused any adoption while a
   * refund on the charge was `pending`, for fear of double-recording our own refund
   * matched by amount. From P22 every create carries `metadata.refund_id` and the apply
   * function matches by it first (`refundApply.ts`), so a refund that reaches here is
   * nobody's row. And a staff card refund can now sit `pending` for days, so the old
   * guard refused Shanthi's dashboard refund on every delivery until Stripe gave up,
   * and the cap never learned of that money. The money moved: it is recorded, and over
   * the cap the caller says so rather than refusing (design.md:4270-4272).
   */
  async adoptExternalRefundCapped(
    tx: Tx,
    args: {
      ownerId: string;
      chargeId: string;
      bookingId?: string | null;
      amountCents: number;
      status: RefundStatus;
      stripeRefundId: string;
      reason?: string | null;
    },
  ): Promise<AdoptedExternalRefund> {
    // THE LOCK, FIRST — before `refunds` is read or written (MR-A1.2(i)/(ii)).
    // Charges → refunds, the one global order.
    const [charge] = await tx
      .select({ id: charges.id })
      .from(charges)
      .where(eq(charges.id, args.chargeId))
      .for('update');
    if (charge === undefined) {
      throw new Error(`adoptExternalRefundCapped: charge ${args.chargeId} not found`);
    }
    const [amount] = await tx
      .select({ amountCents: charges.amountCents })
      .from(charges)
      .where(eq(charges.id, args.chargeId));
    const remainingBeforeCents = await this.capRemainingForCharge(tx, {
      id: args.chargeId,
      amountCents: amount!.amountCents,
    });

    const [row] = await tx
      .insert(refunds)
      .values({
        ownerId: args.ownerId,
        chargeId: args.chargeId,
        bookingId: args.bookingId ?? null,
        amountCents: args.amountCents,
        reason: args.reason ?? 'out-of-band',
        status: args.status,
        stripeRefundId: args.stripeRefundId,
        stripeIdempotencyKey: null,
      })
      .returning(REFUND_PROJECTION);
    if (!row) {
      throw new Error(
        'refundsRepository.adoptExternalRefundCapped: refunds INSERT returned no row',
      );
    }
    return { kind: 'adopted', refund: row, remainingBeforeCents };
  },

  /**
   * Does this charge carry a refund with this `reason`, in ANY status? The late-success
   * mint's question (P22 B-7(d)): one automatic refund per late success, whatever Stripe did
   * to it. The backwards edge asks {@link hasAutomaticRefundWithReason} instead.
   */
  async hasRefundWithReason(tx: Tx, chargeId: string, reason: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.chargeId, chargeId), eq(refunds.reason, reason)))
      .limit(1);
    return row !== undefined;
  },

  /**
   * Does this charge carry a refund with this `reason` that no staff member issued, in ANY
   * status? The backwards edge's recompute (P22 fix 1, Fable r1 N2): a charge carrying the
   * engine's late-success refund goes back to `failed`, the status it held before its
   * refund covered it, since the app never accepted that payment. `reason` is free text on a
   * staff refund (`lib/staffRefunds.ts` stores what she typed, with `issued_by_staff_id`),
   * and the payment history shows `late-success-refund` on the engine's own row, so a staff
   * refund typed with that word must not make a payment the app accepted read as failed.
   * Only the engine mints this reason with no issuer (`confirmCharge.ts`, `refundLateSuccess`).
   */
  async hasAutomaticRefundWithReason(tx: Tx, chargeId: string, reason: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(eq(refunds.chargeId, chargeId), eq(refunds.reason, reason), isNull(refunds.issuedByStaffId)),
      )
      .limit(1);
    return row !== undefined;
  },

  /**
   * Is any refund for this charge still IN FLIGHT? The adoption arm's guard
   * (§4.4): a dashboard refund must never be recorded on top of an automatic
   * refund we are still waiting on, because an amount-matched delivery race
   * would double-RECORD one movement of money.
   *
   * Deliberately not amount-scoped. The conservative reading costs only the
   * named residual — a dashboard refund issued while an automatic refund of a
   * DIFFERENT amount is in flight on the same charge stays unadopted, retried
   * until Stripe's redelivery window closes, and then resolved by the
   * staff verb instead.
   */
  /**
   * Does a refund row exist for this charge, **at ANY status**? The
   * ADJUDICATION question (MR-A2.2, 2026-08-24) — and it is deliberately not
   * the same question as {@link sumNonFailedForCharge}'s.
   *
   * The two were conflated, and the conflation was executed: both month-1
   * dispatch sites asked "did a writer already decide this money?" with
   * `sumNonFailedForCharge > 0`, which EXCLUDES `'failed'`. So a month-1 orphan
   * whose refund Stripe FAILED — precisely the R18/R19 class the abandon report
   * exists for — read as "no refund at all" and took the invariant throw: a 500
   * with no idempotency record, so every retry re-500s FOREVER while an
   * operator chases corruption that does not exist.
   *
   * A failed refund row still proves the adjudication happened. Its DELIVERY is
   * the refund machinery's problem, with its own worklist and alarms
   * (`stripe-failed` shouts until the money is covered or attested). The two
   * questions, kept apart:
   *
   *   - **Adjudication** — "has a writer already decided this money?" — THIS,
   *     a row EXISTS at any status.
   *   - **Money** — "is anything still owed or mintable?" —
   *     {@link sumNonFailedForCharge}, exactly where it already lives.
   */
  /**
   * The rows that make up a charge's RETURNED COVERAGE, named individually —
   * the evidence half of MR-A2.4's surplus alarm. When more money has gone back
   * than the charge ever took, "20000c on a 10000c charge" is not an
   * instruction; the human needs to see WHICH returns summed to it, because the
   * reconciliation happens at Stripe and at the bank, row by row.
   */
  async findReturnedRowsForCharge(
    tx: Runner,
    chargeId: string,
  ): Promise<
    { id: string; status: RefundStatus; amountCents: number; stripeRefundId: string | null }[]
  > {
    return tx
      .select({
        id: refunds.id,
        status: refunds.status,
        amountCents: refunds.amountCents,
        stripeRefundId: refunds.stripeRefundId,
      })
      .from(refunds)
      .where(
        and(
          eq(refunds.chargeId, chargeId),
          inArray(refunds.status, ['succeeded', 'resolved-external']),
          NOT_WITHDRAWN,
        ),
      )
      .orderBy(asc(refunds.createdAt));
  },

  /**
   * The rows of {@link findReturnedRowsForCharge}, for several charges at once: what the
   * owner's ledger lists as `LedgerEntryWire.refunds` (wire 9.3.0-pre.1, her #39;
   * `designs/invoices-calendar.md` §2.3, §7). The predicate is
   * {@link sumReturnedCoverageForCharge}'s, word for word — `succeeded` or
   * `resolved-external`, never one closed `withdrawn` — so what the family is shown sums to
   * what the server counts as returned, charge by charge.
   *
   * **Keyed by `charge_id IN (chargeIds)`** (`refunds_charge_idx`), the key that sum uses,
   * and never by `refunds.owner_id`: nothing in the schema ties a refund's owner to its
   * charge's owner (`schema.sql` `refunds.owner_id`, `refunds.charge_id`), so a read by owner
   * could miss one of these charges' own refunds or carry a refund of a charge the caller
   * never listed. The caller passes only the charges it lists, and nothing else can come
   * back.
   *
   * `[]` with no query when `chargeIds` is empty. Unordered: the ledger orders by the
   * moment it derives from `createdAt` and `resolvedAt`, as an instant.
   */
  async findReturnedRowsForCharges(
    runner: Runner,
    chargeIds: readonly string[],
  ): Promise<ReturnedRefundForCharge[]> {
    if (chargeIds.length === 0) return [];
    return runner
      .select({
        id: refunds.id,
        chargeId: refunds.chargeId,
        amountCents: refunds.amountCents,
        status: refunds.status,
        createdAt: refunds.createdAt,
        resolvedAt: refunds.resolvedAt,
      })
      .from(refunds)
      .where(
        and(
          inArray(refunds.chargeId, [...chargeIds]),
          inArray(refunds.status, ['succeeded', 'resolved-external']),
          NOT_WITHDRAWN,
        ),
      );
  },

  async countPendingForCharge(tx: Tx, chargeId: string): Promise<number> {
    const [row] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(refunds)
      .where(and(eq(refunds.chargeId, chargeId), eq(refunds.status, 'pending')));
    return row?.total ?? 0;
  },

  /**
   * **The staff-only exit** for a refund that was returned outside our Stripe
   * machinery (`designs/money-residue.md` §4.3). `'failed'` → or
   * `'unroutable'` → `'resolved-external'`, with the human's evidence.
   *
   * One guarded UPDATE, and the guard is re-asserted AT WRITE TIME exactly like
   * {@link markUnroutable}'s: between whatever the caller read and this
   * statement a webhook could have moved the row, and overwriting a real
   * terminal status would be data loss. A row that is already
   * `'resolved-external'` returns 0 — resolving is not idempotently repeatable,
   * because the second call would silently replace the first human's
   * attestation with the second's.
   *
   * `note` is REQUIRED and non-empty. The dangerous failure is a WRONG
   * resolution — a staff member attesting a return that did not happen, which
   * closes the remainder and strands the owner's money. Mitigated by
   * staff-only + the required note + **the attribution columns**
   * (`resolved_by_staff_id` / `resolved_at`, MR-A1.1) + the guards below + this
   * state machine. An earlier version of this comment claimed "actor
   * attribution in the audit log", which the schema refutes: `refunds` is
   * EXCLUDED from `audit_capture` by name, and the attack lane executed it —
   * this verb under `withActor` wrote zero `audit_log` rows. Named, not waved
   * off; a second-approver policy belongs to the portal wave.
   *
   * **THE LOCK (MR-A1.2).** This flips a row INTO `sumNonFailedForCharge`,
   * which makes it a cap-ENTERING write, and it had neither a lock nor a
   * coverage guard. Executed by the Fable lane: interleaved with an open
   * `mintCappedPendingRefund` (whose sum-read ran before this committed), BOTH
   * commit — 16000c of non-failed refunds on a 10000c charge — and the sweep
   * CLAIMED the over-minted pending row. Stripe cannot bound that: the
   * resolved-external money moved OUTSIDE Stripe, so Stripe would happily send
   * the full remainder again. So the charge row is taken `FOR UPDATE` FIRST,
   * before `refunds` is read or written, and the refund row is RE-READ under
   * that held lock.
   *
   * **Since P22 (wire 6.0.0) it is `POST /staff/refunds/:id/resolve-external`'s verb**
   * (design §2.7:4235-4262, :4310-4322; question 41 (a) with both riders): it answers a
   * {@link ResolveExternalResult} decided under the lock, `staffId` is required, and it
   * writes `resolved_outcome` and, on `returned` only, `returned_instrument`. `withdrawn`
   * puts back the chain's removed credits ({@link withdrawnPutBacks}) and moves no money.
   * Only a chain's head closes (D2). The refusals, in order: not found, a status other than
   * `failed` / `unroutable`, superseded, a refund in flight, a card row `returned` with no
   * instrument, and the money guards below.
   *
   * **Two money refusals, both under the held lock:**
   *
   *   (a) `countPendingForCharge > 0` — an automatic refund is in flight. Let
   *       it settle first; resolving under it IS the executed interleave, made
   *       sequential.
   *   (b) `amount_cents` exceeds the charge's LIVE remainder — attesting more
   *       money than is owed. Over-remainder corners stay on the worklist,
   *       which now shows the remainder (MR-A1.5) so the human returns what is
   *       OWED rather than what the row says; their resolution surface belongs
   *       to the portal wave.
   *
   * **Two riders, both in this same transaction, both load-bearing:**
   *
   *   1. **The cap closes.** `'resolved-external'` counts in
   *      {@link sumNonFailedForCharge} automatically (`ne('failed')` — the same
   *      correct reading that covers `'unroutable'`), so returned money blocks
   *      future mints. That is the money defect this verb exists to fix: a
   *      `'failed'` row drops OUT of the cap, so the remainder reopens and an
   *      automatic leg could re-mint what a human already returned.
   *   2. **The ledger finishes the story**, through the ONE
   *      {@link sumReturnedCoverageForCharge} helper that all three cumulative
   *      tails now share (MR-A1.6.3).
   *
   * The charge write is a direct UPDATE rather than a call to
   * `chargesRepository.markStatus`: that module imports THIS one, and a cycle
   * on two money repositories is not worth one shared line.
   */
  async markResolvedExternal(
    tx: Tx,
    args: {
      id: string;
      note: string;
      /** The attesting staffer: required since P22's route (design §2.7:4310-4322). */
      staffId: string;
      /** `'returned'` when omitted: the money went back outside the app. */
      outcome?: RefundResolvedOutcome;
      /** What crossed the desk, on `'returned'` only. */
      instrument?: 'cash' | 'check';
    },
  ): Promise<ResolveExternalResult> {
    const note = args.note.trim();
    if (note.length === 0) {
      throw new Error(
        'markResolvedExternal: a resolution note is REQUIRED — it is the only evidence that this money actually went back, and a resolution without it is an unattested cap closure',
      );
    }
    const outcome = args.outcome ?? 'returned';

    // Read the row UNLOCKED first, only to learn which charge to lock (it never changes).
    // Every decision below, the 404 included, is taken from the re-read after the lock.
    const [target] = await tx
      .select({ chargeId: refunds.chargeId })
      .from(refunds)
      .where(eq(refunds.id, args.id))
      .limit(1);
    if (target === undefined) return { kind: 'not_found' };

    // ── charges → refunds, the one global lock order ────────────────────
    const [charge] = await tx
      .select({ id: charges.id, amountCents: charges.amountCents })
      .from(charges)
      .where(eq(charges.id, target.chargeId))
      .for('update');
    if (charge === undefined) return { kind: 'not_found' };

    const row = await this.findHeadFacts(tx, args.id);
    if (row === undefined) return { kind: 'not_found' };
    if (row.status !== 'failed' && row.status !== 'unroutable') return { kind: 'wrong_status' };
    // D2 (DECISIONS 279(b)): only a chain's head is closed; a row any later retry names is
    // superseded, whatever that retry's state.
    if (row.superseded) return { kind: 'superseded' };
    // Guard (a) — never resolve under an in-flight refund on the same payment.
    if ((await this.countPendingForCharge(tx, charge.id)) > 0) return { kind: 'in_flight' };

    const returnedInstrument =
      args.instrument ?? (row.instrument === 'original_card' ? undefined : row.instrument);
    if (outcome === 'returned' && returnedInstrument === undefined) {
      return { kind: 'instrument_required' };
    }

    // The remainder **ignoring THIS row's own contribution**, because the two source
    // statuses sit on opposite sides of the cap: `'failed'` is outside the counting sum, so
    // resolving it `returned` MOVES it in; `'unroutable'` is already inside it, so resolving
    // it is a relabel. Comparing an unroutable row against a remainder that already
    // subtracts itself would refuse every one.
    const counting = await this.sumNonFailedForCharge(tx, charge.id);
    const alreadyCounted = row.status === 'unroutable' ? row.amountCents : 0;
    const remainderIgnoringThisRow = charge.amountCents - (counting - alreadyCounted);

    let putBacks: { lot: PutBackLot; credits: number; firstRefundId: string }[] = [];
    if (outcome === 'returned') {
      // Guard (b) — never attest more money than the payment still owes.
      if (row.amountCents > remainderIgnoringThisRow) return { kind: 'over_remainder' };
    } else {
      putBacks = await this.withdrawnPutBacks(tx, args.id);
      // Amendment A1 (DECISIONS 303): with nothing left to return, the money this refund
      // stood for has gone back another way, so "the family keeps the purchase" is false and
      // the credits stay removed. A chain that removed nothing still closes withdrawn.
      if (putBacks.length > 0 && remainderIgnoringThisRow <= 0) return { kind: 'over_remainder' };
    }

    const updated = await tx
      .update(refunds)
      .set({
        status: 'resolved-external',
        resolutionNote: note,
        resolvedByStaffId: args.staffId,
        resolvedAt: sql`now()`,
        resolvedOutcome: outcome,
        ...(outcome === 'returned' ? { returnedInstrument } : {}),
        updatedAt: sql`now()`,
      })
      // The guard is RE-ASSERTED at write time, `markUnroutable`'s discipline.
      .where(and(eq(refunds.id, args.id), inArray(refunds.status, ['failed', 'unroutable'])))
      .returning({ id: refunds.id });
    if (updated.length === 0) return { kind: 'wrong_status' };

    let creditsReturned = 0;
    for (const back of putBacks) {
      await tx.insert(creditLedger).values({
        ownerId: back.lot.ownerId,
        location: back.lot.location,
        mode: back.lot.mode,
        tier: back.lot.tier,
        delta: back.credits,
        reason: 'adjustment',
        lotId: back.lot.id,
        refundId: back.firstRefundId,
        note: `refund ${back.firstRefundId} withdrawn: ${note}`,
        createdByStaffId: args.staffId,
      });
      creditsReturned += back.credits;
    }

    if (outcome === 'returned') {
      // Rider 2 — the ledger. Money that came back counts whether Stripe returned it or a
      // human did. One helper, three tails (MR-A1.6.3). A `withdrawn` close moved no money,
      // so it never flips the charge.
      const returned = await this.sumReturnedCoverageForCharge(tx, charge.id);
      if (returned >= charge.amountCents) {
        await tx
          .update(charges)
          .set({ status: 'refunded', updatedAt: sql`now()` })
          .where(eq(charges.id, charge.id));
      }
    }
    return { kind: 'resolved', ownerId: row.ownerId, creditsReturned };
  },

  /**
   * What *Retry to card* and *Returned* decide on, read under the charge lock: the row's
   * status, amount, instrument and reason, and whether a later retry names it (D2).
   */
  async findHeadFacts(
    tx: Tx,
    id: string,
  ): Promise<
    | {
        id: string;
        ownerId: string;
        chargeId: string;
        status: RefundStatus;
        amountCents: number;
        instrument: RefundInstrument;
        reason: string | null;
        superseded: boolean;
      }
    | undefined
  > {
    const [row] = await tx
      .select({
        id: refunds.id,
        ownerId: refunds.ownerId,
        chargeId: refunds.chargeId,
        status: refunds.status,
        amountCents: refunds.amountCents,
        instrument: refunds.instrument,
        reason: refunds.reason,
        // Spelled `refunds.id`, never `${refunds.id}`: in a one-table select drizzle renders
        // a column bare (`"id"`), which inside the subquery binds to its own row.
        superseded: sql<boolean>`EXISTS (SELECT 1 FROM refunds later WHERE later.retry_of_refund_id = refunds.id)`,
      })
      .from(refunds)
      .where(eq(refunds.id, id))
      .limit(1);
    return row as
      | {
          id: string;
          ownerId: string;
          chargeId: string;
          status: RefundStatus;
          amountCents: number;
          instrument: RefundInstrument;
          reason: string | null;
          superseded: boolean;
        }
      | undefined;
  },

  /**
   * The `withdrawn` put-back, **defined by arithmetic** (P22 brief B-5, Fable M3; amendment
   * A2, DECISIONS 303), never by note text. The chain is the head and every row it retries,
   * back to the first refund. For each lot, the sum of every `credit_ledger` row on it that
   * carries the `refund_id` of ANY row of the chain — the mint's removal, a hand removal
   * that named one of them, an earlier put-back — and, where that sum is below 0, its
   * negation goes back on that lot, naming the chain's FIRST refund. A put-back carries that
   * id, so a second one finds a sum of 0: exactly once, by arithmetic.
   *
   * The pools are locked in ONE `lockPools` call (it sorts its keys; two calls could
   * deadlock), and every sum is read after it. The lots are learned first, unlocked; a row
   * naming the chain that lands on a lot of an unlocked pool in between makes this throw,
   * writing nothing, rather than miss it.
   */
  async withdrawnPutBacks(
    tx: Tx,
    headId: string,
  ): Promise<{ lot: PutBackLot; credits: number; firstRefundId: string }[]> {
    const chain = await tx.execute(sql`
      WITH RECURSIVE chain(id, retry_of) AS (
        SELECT id, retry_of_refund_id FROM refunds WHERE id = ${headId}
        UNION ALL
        SELECT r.id, r.retry_of_refund_id FROM refunds r JOIN chain c ON r.id = c.retry_of
      )
      SELECT id, retry_of AS "retryOf" FROM chain`);
    const links = chain.rows as { id: string; retryOf: string | null }[];
    const first = links.find((link) => link.retryOf === null);
    if (first === undefined)
      throw new Error(`refund ${headId}: its retry chain has no first refund`);
    const ids = sql.join(
      links.map((link) => sql`${link.id}::uuid`),
      sql`, `,
    );
    const lotsOf = async (): Promise<PutBackLot[]> => {
      const res = await tx.execute(sql`
        SELECT DISTINCT lot.id, lot.owner_id AS "ownerId", lot.location, lot.mode, lot.tier
          FROM credit_ledger x JOIN credit_ledger lot ON lot.id = x.lot_id
         WHERE x.refund_id IN (${ids})`);
      return res.rows as unknown as PutBackLot[];
    };
    const lots = await lotsOf();
    if (lots.length === 0) return [];
    await lockPools(tx, lots);
    const locked = new Set(lots.map((lot) => lot.id));
    const after = await lotsOf();
    if (after.some((lot) => !locked.has(lot.id))) {
      throw new Error(
        `refund ${headId}: a credit row naming its chain landed while it was being closed; nothing was written, so close it again`,
      );
    }
    const sums = await tx.execute(sql`
      SELECT x.lot_id AS "lotId", SUM(x.delta)::int AS total
        FROM credit_ledger x
       WHERE x.refund_id IN (${ids}) AND x.lot_id IS NOT NULL
       GROUP BY x.lot_id`);
    const byLot = new Map(lots.map((lot) => [lot.id, lot]));
    return (sums.rows as { lotId: string; total: number }[])
      .filter((sum) => sum.total < 0)
      .map((sum) => ({ lot: byLot.get(sum.lotId)!, credits: -sum.total, firstRefundId: first.id }))
      .sort((a, b) => (a.lot.id < b.lot.id ? -1 : 1));
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
   * P22 B-7(a), the P15 note's row 15: a `pending` refund Stripe holds (a stored `re_`) and
   * no terminal event has reached. The poll's CLAIM: rows not looked at since `lookedBefore`
   * (an hour, `REFUND_STATUS_POLL_MINUTES`), leased by moving `updated_at`, as
   * {@link claimStalePendingForRetry} does. The poll only retrieves and applies: it **never
   * moves a row by the clock** (146(c): a card refund can sit `pending` on a thin balance,
   * and a failure can take 30 days).
   */
  async claimPendingWithStripeIdForPoll(
    tx: Tx,
    args: { lookedBefore: Date; limit?: number },
  ): Promise<RefundRow[]> {
    const due = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(
          eq(refunds.status, 'pending'),
          isNotNull(refunds.stripeRefundId),
          lte(refunds.updatedAt, args.lookedBefore.toISOString()),
        ),
      )
      .orderBy(asc(refunds.updatedAt))
      .limit(args.limit ?? 25)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(refunds)
      .set({ updatedAt: sql`now()` })
      .where(inArray(refunds.id, due.map((r) => r.id)))
      .returning(REFUND_PROJECTION);
  },

  /**
   * P22 B-7(b): the hourly look-up's CLAIM for re-keyed rows (pending, no `re_`, a fresh
   * key: {@link rekeyedRefundKey}). Leased on `updated_at`, because a re-keyed row's send
   * instant is in its key, not its touch column.
   */
  async claimRekeyedForLookUp(
    tx: Tx,
    args: { lookedBefore: Date; limit?: number },
  ): Promise<RefundRow[]> {
    const due = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(
          eq(refunds.status, 'pending'),
          isNull(refunds.stripeRefundId),
          like(refunds.stripeIdempotencyKey, `${REKEYED_REFUND_KEY_PREFIX}%`),
          lte(refunds.updatedAt, args.lookedBefore.toISOString()),
        ),
      )
      .orderBy(asc(refunds.updatedAt))
      .limit(args.limit ?? 25)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(refunds)
      .set({ updatedAt: sql`now()` })
      .where(inArray(refunds.id, due.map((r) => r.id)))
      .returning(REFUND_PROJECTION);
  },

  /**
   * P22 B-7(b)'s end state for a STAFF refund Stripe could not be reached for: pending, no
   * `re_`, its original key, out of the retry window (`mintedBefore`), and its last send
   * (`updated_at`, which only the mint and the retry claim move on such a row) before
   * `sentBefore`, so Stripe's key window has passed. Read only: it is acted on once, and a
   * concurrent tick's second act is refused by {@link failUnsentPending}'s guard. Automatic
   * rows outside B-7(b) keep today's abandon classes.
   */
  async findUnsentStaffPastWindow(
    runner: Runner,
    args: { mintedBefore: Date; sentBefore: Date; limit?: number },
  ): Promise<RefundRow[]> {
    return runner
      .select(REFUND_PROJECTION)
      .from(refunds)
      .where(
        and(
          eq(refunds.status, 'pending'),
          isNull(refunds.stripeRefundId),
          isNotNull(refunds.issuedByStaffId),
          isNotNull(refunds.stripeIdempotencyKey),
          notLike(refunds.stripeIdempotencyKey, `${REKEYED_REFUND_KEY_PREFIX}%`),
          lte(refunds.createdAt, args.mintedBefore.toISOString()),
          lte(refunds.updatedAt, args.sentBefore.toISOString()),
        ),
      )
      .orderBy(asc(refunds.createdAt))
      .limit(args.limit ?? 25);
  },

  /**
   * P22 B-7(b) 3: write the fresh key onto the row, in its own committed transaction,
   * BEFORE it is sent: so a process killed between the two leaves the row holding the key
   * Stripe may have seen, and the look-up and every later read agree with Stripe. Guarded
   * on `pending`, the old key and `stripe_refund_id IS NULL`; `false` means the row moved,
   * and nothing is sent.
   */
  async rekeyUnsentPending(
    tx: Tx,
    args: { id: string; fromKey: string; toKey: string },
  ): Promise<boolean> {
    const updated = await tx
      .update(refunds)
      .set({ stripeIdempotencyKey: args.toKey, updatedAt: sql`now()` })
      .where(
        and(
          eq(refunds.id, args.id),
          eq(refunds.status, 'pending'),
          isNull(refunds.stripeRefundId),
          eq(refunds.stripeIdempotencyKey, args.fromKey),
        ),
      )
      .returning({ id: refunds.id });
    return updated.length > 0;
  },

  /**
   * `pending → failed` for a row Stripe holds NO refund for (P22): a create Stripe refused
   * (B-7(c)), or a row whose key window has passed with no refund at Stripe carrying its id
   * (B-7(b)'s end state). One guarded UPDATE, so a `re_` stored by a late reply, or a key
   * rewritten, between the caller's look and this write is never overwritten. The caller
   * holds the charge lock. Opens *Retry to card* and *Returned*, and lifts the
   * `refund_in_flight` the row held over its payment.
   */
  async failUnsentPending(
    tx: Tx,
    args: { id: string; stripeIdempotencyKey: string },
  ): Promise<boolean> {
    const updated = await tx
      .update(refunds)
      .set({ status: 'failed', updatedAt: sql`now()` })
      .where(
        and(
          eq(refunds.id, args.id),
          eq(refunds.status, 'pending'),
          isNull(refunds.stripeRefundId),
          eq(refunds.stripeIdempotencyKey, args.stripeIdempotencyKey),
        ),
      )
      .returning({ id: refunds.id });
    return updated.length > 0;
  },

  /**
   * The retry sweep's CLAIM (2026-08-12, round 3) — select + lease in one short
   * tx.
   *
   * The worklist: refunds still `pending` with NO `stripe_refund_id`, which is
   * exactly "the money-back row was written but the Stripe call never landed".
   * Until this existed, nothing retried them — no worker imported this
   * repository, and `charge.refund.updated` cannot arrive for a refund that was
   * never created at Stripe. Every `firePendingRefundPostCommit` failure was
   * therefore a permanent double charge whose only trace was one log line.
   *
   * **A retry is only safe when it can reproduce the key the ORIGINAL call
   * used**; under a different key Stripe executes a SECOND refund instead of
   * replaying the first. That is the one rule, and there are now two ways a row
   * can satisfy it (design §2.3):
   *
   *   1. **The stored-key lane** (`stripe_idempotency_key IS NOT NULL`) — since
   *      2026-08-19 every writer records its exact key in the minting tx, so
   *      the row itself says what to send. This is the lane that finally covers
   *      the cancel / withdraw writers, whose keys were
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
   * The other pending-refund writers (`reason='cancel'` from the cancel/withdraw
   * paths) keyed on `${idempotencyKey}:…` until 2026-08-19 — nothing durable can reconstruct
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
   *     replay the first. So: stop, and hand it to a human
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
          // P22 B-7(b): a re-keyed row had its one send under its fresh key; no re-fire,
          // ever (the look-up lane asks Stripe about it instead).
          or(
            isNull(refunds.stripeIdempotencyKey),
            notLike(refunds.stripeIdempotencyKey, `${REKEYED_REFUND_KEY_PREFIX}%`),
          ),
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
      // Unsent and past the key window: nothing automatic will send it now. A re-keyed row
      // (B-7(b)) joins at once, whatever its age: its fresh key has had its one send.
      and(
        eq(refunds.status, 'pending'),
        isNull(refunds.stripeRefundId),
        or(
          lte(refunds.createdAt, args.mintedBefore.toISOString()),
          like(refunds.stripeIdempotencyKey, `${REKEYED_REFUND_KEY_PREFIX}%`),
        ),
      ),
      // Sent, then failed AT Stripe. Terminal, unbounded by age (see the doc).
      eq(refunds.status, 'failed'),
    );
    /**
     * The charge's LIVE remainder, correlated per row (MR-A1.5). Computed in
     * SQL rather than by a per-row round trip because both queries below need
     * it and the report runs every tick: `amount_cents − Σ non-failed refunds`,
     * floored at 0. It is the same arithmetic {@link sumNonFailedForCharge}
     * expresses — kept as a subquery here specifically so the unbounded COUNT
     * pass stays ONE query and cannot disagree with the page about what a row
     * is (the round-4 lesson that produced the companion-query design).
     */
    // A row closed `withdrawn` moved no money and counts nowhere money is summed (6.0.0;
    // design §2.7:4242-4248), here too: counted, it would hide what the charge still owes.
    const remainderRawExpr = sql<number>`COALESCE(${charges.amountCents}, 0) - COALESCE((
        SELECT SUM(r2.amount_cents)::int FROM refunds r2
        WHERE r2.charge_id = ${refunds.chargeId} AND r2.status <> 'failed'
          AND r2.resolved_outcome IS DISTINCT FROM 'withdrawn'
      ), 0)`;
    const supersededExpr = sql<boolean>`EXISTS (
        SELECT 1 FROM refunds r3 WHERE r3.retry_of_refund_id = ${refunds.id}
      )`;
    const remainingCents = sql<number>`GREATEST(${remainderRawExpr}, 0)`;
    // The UNFLOORED value, for the MR-A3.2 assembly only. The floor is right
    // for the published `remainingCents` (a negative remainder is not a
    // remainder), but the joint cap is derived by ADDING the shouting set's
    // non-failed amounts back, and starting that from a floored 0 on an
    // over-covered charge would hand a human capacity the charge does not have.
    const remainderRawCents = remainderRawExpr;
    const classInputs = await runner
      .select({
        status: refunds.status,
        reason: refunds.reason,
        createdAt: refunds.createdAt,
        stripeIdempotencyKey: refunds.stripeIdempotencyKey,
        stripePaymentIntentId: charges.stripePaymentIntentId,
        remainingCents,
        remainderRawCents,
        amountCents: refunds.amountCents,
        superseded: supersededExpr,
        issuedByStaffId: refunds.issuedByStaffId,
      })
      .from(refunds)
      .leftJoin(charges, eq(refunds.chargeId, charges.id))
      .where(abandonedWhere);
    const totalByClass: Record<AbandonedRefundClass, number> = {
      'row-keyed': 0,
      'client-keyed': 0,
      'never-sent': 0,
      'awaiting-stripe': 0,
      'stripe-failed': 0,
      'failed-exceeds-owed': 0,
      covered: 0,
    };
    for (const input of classInputs) {
      totalByClass[
        classifyAbandoned({
          status: input.status,
          reason: input.reason,
          createdAt: input.createdAt,
          piId: input.stripePaymentIntentId,
          stripeIdempotencyKey: input.stripeIdempotencyKey,
          remainingCents: input.remainingCents,
          amountCents: input.amountCents,
          superseded: input.superseded,
          issuedByStaff: input.issuedByStaffId !== null,
        })
      ] += 1;
    }
    const rows = await runner
      .select({
        ...REFUND_PROJECTION,
        reason: refunds.reason,
        createdAt: refunds.createdAt,
        stripePaymentIntentId: charges.stripePaymentIntentId,
        remainingCents,
        remainderRawCents,
        superseded: supersededExpr,
        issuedByStaffId: refunds.issuedByStaffId,
        chargeStatus: charges.status,
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
      // `covered` rows never reach the NAMED page (MR-A1.5): they are owed
      // nothing, so naming them individually is how a human is talked into
      // returning the money a second time. They stay in `totalByClass` so the
      // condition is counted, never silent — and they are excluded from the
      // shouting set the allocation below divides the cap among.
      rows: allocateActionableFigures(
        rows
          .map(
            ({
              reason,
              createdAt,
              remainderRawCents: remainderRaw,
              superseded,
              issuedByStaffId,
              chargeStatus,
              ...row
            }) => ({
              ...row,
              createdAt,
              remainderRawCents: remainderRaw,
              seenOn:
                chargeStatus === 'succeeded' || chargeStatus === 'refunded'
                  ? "the family's payment history (Owner → Invoices and Payments)"
                  : 'no portal screen until End of day (P25): its charge is held failed, so the payment history does not list it',
              refundClass: classifyAbandoned({
                status: row.status,
                reason,
                createdAt,
                piId: row.stripePaymentIntentId,
                stripeIdempotencyKey: row.stripeIdempotencyKey,
                remainingCents: row.remainingCents,
                amountCents: row.amountCents,
                superseded,
                issuedByStaff: issuedByStaffId !== null,
              }),
            }),
          )
          .filter((row) => row.refundClass !== 'covered'),
      ),
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
      seenOn: "the family's payment history, or no screen when its charge took no money",
      // 0 because THIS ROW now covers the charge's remainder — the flip just
      // moved it into the non-failed set — NOT because nothing is owed
      // (corrected MR-A2.5(d)3). The obligation is real and is the row's own
      // `amountCents`, which is what the announcement names; `actionableCents`
      // mirrors it for the same reason.
      remainingCents: 0,
      actionableCents: row.amountCents,
      clipped: false,
      clipReason: null,
    }));
  },

  /**
   * Webhook entry point — look up the refund row by Stripe id.
   * `charge.refund.updated` carries the `re_*` id directly; the row's
   * `stripe_refund_id` was set by the cancel-route postCommit's call to
   * `markStripeId`. Returns undefined when the webhook beat the
   * postCommit (race) — caller falls back to `findUnmatchedPendingForCharge`.
   */
  /**
   * Read one refund row by primary key. The RE-READ half of the converted
   * `charge.refund.updated` order (MR-A1.2(ii)): the row is matched unlocked to
   * learn its charge, the charge is locked, and then the row is read again —
   * because a concurrent `markResolvedExternal` or sibling delivery may have
   * moved it in between, and every decision after the lock must be made on what
   * is true now.
   */
  async findById(tx: Runner, id: string): Promise<RefundRow | undefined> {
    const [row] = await tx
      .select(REFUND_PROJECTION)
      .from(refunds)
      .where(eq(refunds.id, id))
      .limit(1);
    return row;
  },

  async findByStripeRefundId(
    tx: Runner,
    stripeRefundId: string,
  ): Promise<RefundRow | undefined> {
    const [row] = await tx
      .select(REFUND_PROJECTION)
      .from(refunds)
      .where(eq(refunds.stripeRefundId, stripeRefundId))
      .limit(1);
    return row;
  },

  /**
   * The AMOUNT FALLBACK, step 3 of the apply function's match order (P22, Fable H3): a
   * refund carrying no `metadata.refund_id` is matched onto a `pending` row of this charge
   * with no `re_`, of the same amount, and **no `issued_by_staff_id`**. It stays for rows
   * minted before P22, whose creates carried no metadata. A staff row is P22's, so its
   * refund always carries the metadata and is never matched by amount: two of Shanthi's
   * $57.00 refunds waiting on their replies must never trade events. The residue, named:
   * a dashboard refund of the same amount as an automatic row still waiting for its `re_`
   * is written onto that row. The most recent wins.
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
          isNull(refunds.issuedByStaffId),
        ),
      )
      .orderBy(sql`created_at DESC`)
      .limit(1);
    return row;
  },

  /**
   * Move a refund along its state machine ({@link REFUND_STATUS_FROM}): `pending →
   * succeeded | failed`, and the one backwards edge `succeeded → failed`. **Every other
   * write is refused** (6.0.0, design §2.7:4227-4228), by throwing
   * {@link RefundStatusTransitionError}: a stale `succeeded` over a `failed` row would
   * close the cap on money that never went back, and the row would still offer *Retry to
   * card*. Its callers are the one apply function (`refundApply.ts`), which decides under
   * the charge lock, and the refused-at-create arm, so a throw here is a defect. Stamps
   * `updated_at = now()`.
   */
  async markStatus(tx: Tx, args: { id: string; status: RefundStatus }): Promise<void> {
    const from = REFUND_STATUS_FROM[args.status] ?? [];
    const updated =
      from.length === 0
        ? []
        : await tx
            .update(refunds)
            .set({ status: args.status, updatedAt: sql`now()` })
            .where(and(eq(refunds.id, args.id), inArray(refunds.status, [...from])))
            .returning({ id: refunds.id });
    if (updated.length === 0) {
      const [row] = await tx
        .select({ status: refunds.status })
        .from(refunds)
        .where(eq(refunds.id, args.id));
      throw new RefundStatusTransitionError(
        `refund ${args.id}: ${row?.status ?? 'no such row'} → ${args.status} is not a move the refund state machine has`,
      );
    }
  },
};
