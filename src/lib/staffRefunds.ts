import { randomUUID } from 'node:crypto';
import type {
  GetStaffPaymentsRefundProposalResponse,
  RefundInstrument,
  RefundWire,
} from '../contracts/wire.js';
import { db } from '../db/client.js';
import { lockCharge, lockPools } from '../db/locks.js';
import {
  creditLedgerRepository,
  findLotDetails,
  findPurchaseLotOfCharge,
} from '../db/repositories/creditLedgerRepository.js';
import { refundsRepository, type RefundWireRow } from '../db/repositories/refundsRepository.js';
import { withTransaction, type Tx } from '../db/tx.js';
import { bucketChicagoToday } from './chicagoDate.js';
import { ApiError } from './errors.js';
import { logUnroutableRefundMint, type PendingStripeRefund } from './pendingRefund.js';
import { pgTimestampToIso } from './pgTimestamp.js';

/**
 * The staff refund (P22, wire 6.0.0; design §2.7:4163-4215, §2.4:3112-3131; PAY-U24,
 * PAY-U28, CRED-U18). Money goes back only when a person chooses it — Shanthi or Amber,
 * case by case, at any amount up to what was paid (SIGNOFF.md:252-255) — and its credits
 * leave only as the purchase lot's unbooked, unspent credits, at the mint, so nothing is
 * paid back twice (RULING R3; design.md:4154-4155).
 *
 * Locks, one global order (design.md:3975-3979): the idempotency claim, then the charge row
 * (`lockCharge`, before `refunds` is read or written), then the lot's pool (`lockPools`).
 * No Stripe call runs inside a transaction: the create fires after commit.
 */

/** A charge took money when it reads `succeeded` or `refunded` (`StaffInvoicePaymentWire`). */
const TOOK_MONEY = new Set(['succeeded', 'refunded']);

function paymentNotFound(paymentId: string): ApiError {
  return new ApiError('not_found', `payment ${paymentId} not found`);
}

/** `RefundWire` from its joined row (D3, D4, D5: every nullable field omitted when null). */
export function toRefundWire(row: RefundWireRow): RefundWire {
  const wire: RefundWire = {
    id: row.id,
    charge_id: row.chargeId,
    owner: { id: row.ownerId, name: row.ownerName },
    item: {
      purpose: row.purpose,
      ...(row.packageLabel !== null ? { package_label: row.packageLabel } : {}),
    },
    amount_cents: row.amountCents,
    instrument: row.instrument,
    status: row.status,
    created_at: pgTimestampToIso(row.createdAt),
  };
  if (row.returnedInstrument !== null) wire.returned_instrument = row.returnedInstrument;
  if (row.reason !== null) wire.reason = row.reason;
  if (row.issuedByStaffId !== null && row.issuedByName !== null) {
    wire.issued_by = { staff_id: row.issuedByStaffId, name: row.issuedByName };
  }
  if (row.retryOfRefundId !== null) wire.retry_of_refund_id = row.retryOfRefundId;
  if (row.enrollmentId !== null) wire.enrollment_id = row.enrollmentId;
  if (row.resolvedByStaffId !== null && row.resolvedByName !== null) {
    wire.resolved_by = { staff_id: row.resolvedByStaffId, name: row.resolvedByName };
  }
  if (row.resolvedAt !== null) wire.resolved_at = pgTimestampToIso(row.resolvedAt);
  if (row.resolutionNote !== null) wire.resolution_note = row.resolutionNote;
  if (row.resolvedOutcome !== null) wire.resolved_outcome = row.resolvedOutcome;
  return wire;
}

export async function refundWireOf(runner: Tx | typeof db, refundId: string): Promise<RefundWire> {
  const row = await refundsRepository.findWireRow(runner, refundId);
  if (row === undefined) throw new Error(`refund ${refundId} read back empty`);
  return toRefundWire(row);
}

// ── the proposal ────────────────────────────────────────────────────────────

/**
 * `GET /staff/payments/:id/refund-proposal` (PAY-U28, CRED-U18; D7; design
 * §2.7:4188-4207, §2.4:3112-3123): computed on each read, storing nothing. It reads the
 * charge's one purchase lot, the lot's unspent (every debit is taken at booking, R1, so
 * unspent is unbooked and unspent), its liveness (`lot_is_live`), its days still booked
 * ahead (`CreditLotDetailWire.booked_ahead`'s rule) and the payment's cap — under the
 * charge lock, through the one cap helper the mint calls.
 */
export async function refundProposal(args: {
  paymentId: string;
  now: Date;
}): Promise<GetStaffPaymentsRefundProposalResponse> {
  // Through `withTransaction`, not `db.transaction`: its client goes back to the pool on
  // every path, a BEGIN that meets a lost connection included (O-POOLFIX fix 1).
  return withTransaction(async (tx) => {
    const charge = await lockCharge(tx, args.paymentId);
    if (charge === undefined || !TOOK_MONEY.has(charge.status)) {
      throw paymentNotFound(args.paymentId);
    }
    // Until its basis lands, a charge of another purpose has nothing to propose (D7); the
    // refund itself stays open on it at any amount up to the cap.
    const lot =
      charge.purpose === 'package' ? await findPurchaseLotOfCharge(tx, charge.id) : undefined;
    if (lot === undefined) {
      throw new ApiError(
        'invalid_payload',
        `payment ${charge.id} bought no credits, so there is nothing to propose; a refund of any amount up to what it can still return is still open`,
      );
    }
    const [detail] = await findLotDetails(tx, {
      ownerId: charge.ownerId,
      today: bucketChicagoToday(args.now),
      lotId: lot.id,
    });
    if (detail === undefined) throw new Error(`lot ${lot.id} read back empty`);
    const cap = await refundsRepository.capRemainingForCharge(tx, {
      id: charge.id,
      amountCents: charge.amountCents,
    });
    const unbooked = Math.max(detail.remaining, 0);
    const perCredit = Math.floor(charge.amountCents / detail.granted);
    const liveUnbooked = detail.live ? unbooked : 0;
    return {
      proposed_cents: Math.min(liveUnbooked * perCredit, cap),
      basis: 'unbooked_credits',
      unbooked_unspent_credits: unbooked,
      expired_unspent_credits: unbooked - liveUnbooked,
      booked_ahead: { count: detail.booked_dates.length, dates: detail.booked_dates },
      per_credit_cents: perCredit,
      // Every charge is a card charge until build 11.1.0 adds `charges.method` (M6.01).
      method: 'card',
    };
  });
}

// ── the mint ────────────────────────────────────────────────────────────────

export interface StaffRefundMint {
  refundId: string;
  ownerId: string;
  /** The credits that left with it (0 when none): the owner's credit cache must drop. */
  creditsRemoved: number;
  /** Set when the row is `'pending'`: the create to fire after commit. */
  pending?: PendingStripeRefund;
}

/**
 * `POST /staff/refunds`' transaction, after the claim and the role gate (design
 * §2.7:4182-4215, §2.4:3124-3131). In order, each refusal writing nothing: the charge
 * lock; the charge took money, else 404; `enrollment_id` → 422 `invalid_payload`; `cash` or
 * `check` → 422 `instrument_unavailable`; above the cap → 422 `over_cap` (a `pending` refund
 * counts); the purchase lot and its pool lock; `credits_to_remove` (omitted: the lot's
 * unbooked, unspent count now, expired included, D9) above that count, or any above 0 on a
 * charge with no purchase lot → 422 `lot_insufficient`. Then the `refunds` row and, when
 * the count is above 0, ONE `adjustment` row of minus that count on the lot, naming the
 * refund, in this same transaction.
 *
 * A charge with no PaymentIntent mints the row born `'unroutable'`: money a person hands
 * back and records with *Returned*. The page-once alarm is raised here, inside the
 * transaction, as the unroutable mint's contract requires (`pendingRefund.ts`).
 */
export async function mintStaffRefund(
  tx: Tx,
  args: {
    paymentId: string;
    amountCents: number;
    instrument: RefundInstrument;
    reason: string;
    creditsToRemove: number | undefined;
    enrollmentId: string | undefined;
    staffId: string;
    idempotencyKey: string;
    log: { error(obj: Record<string, unknown>, msg?: string): void };
  },
): Promise<StaffRefundMint> {
  const charge = await lockCharge(tx, args.paymentId);
  if (charge === undefined || !TOOK_MONEY.has(charge.status)) throw paymentNotFound(args.paymentId);
  if (args.enrollmentId !== undefined) {
    throw new ApiError('invalid_payload', 'enrollment_id is not accepted before enrolments exist');
  }
  if (args.instrument !== 'original_card') {
    throw new ApiError(
      'instrument_unavailable',
      'cash and check refunds open when a charge can be paid by hand; this one goes back to the card',
    );
  }
  const cap = await refundsRepository.capRemainingForCharge(tx, {
    id: charge.id,
    amountCents: charge.amountCents,
  });
  if (args.amountCents > cap) {
    throw new ApiError('over_cap', `this payment can return at most ${cap} cents now`);
  }

  const lot = await findPurchaseLotOfCharge(tx, charge.id);
  let removable = 0;
  if (lot !== undefined) {
    await lockPools(tx, [lot]);
    removable = Math.max(await creditLedgerRepository.lotUnspentInTx(tx, lot.id), 0);
  }
  const credits = args.creditsToRemove ?? removable;
  if (credits > removable) {
    throw new ApiError('lot_insufficient', `this payment's lot has ${removable} unbooked credits`);
  }

  const refundId = randomUUID();
  let pending: PendingStripeRefund | undefined;
  if (charge.stripePaymentIntentId === null) {
    await refundsRepository.createUnroutable(tx, {
      id: refundId,
      ownerId: charge.ownerId,
      chargeId: charge.id,
      bookingId: null,
      amountCents: args.amountCents,
      reason: args.reason,
      instrument: args.instrument,
      issuedByStaffId: args.staffId,
    });
    logUnroutableRefundMint(
      args.log,
      { refundId, ownerId: charge.ownerId, chargeId: charge.id, amountCents: args.amountCents },
      { issuedByStaffId: args.staffId },
    );
  } else {
    const stripeIdempotencyKey = `${args.idempotencyKey}:refund`;
    await refundsRepository.createPending(tx, {
      id: refundId,
      ownerId: charge.ownerId,
      chargeId: charge.id,
      bookingId: null,
      amountCents: args.amountCents,
      reason: args.reason,
      stripeIdempotencyKey,
      instrument: args.instrument,
      issuedByStaffId: args.staffId,
    });
    pending = {
      refundId,
      paymentIntentId: charge.stripePaymentIntentId,
      amountCents: args.amountCents,
      stripeIdempotencyKey,
    };
  }

  if (credits > 0 && lot !== undefined) {
    await creditLedgerRepository.removeFromLot(tx, {
      lot,
      credits,
      note: `refund ${refundId}: ${args.reason}`,
      staffId: args.staffId,
      refundId,
    });
  }
  return {
    refundId,
    ownerId: charge.ownerId,
    creditsRemoved: credits,
    ...(pending !== undefined ? { pending } : {}),
  };
}

// ── Retry to card ───────────────────────────────────────────────────────────

/**
 * `POST /staff/refunds/:id/retry`'s transaction, after the claim and the role gate (design
 * §2.7:4228-4235, §2.4:3131-3142; D2, D5; DECISIONS 279(b)). The row's `charge_id` is read
 * unlocked (it never changes), the charge is locked, and every decision is taken from the
 * row re-read under it (Fable M5), in order: no row → 404; not a `failed` `original_card`
 * row → 409 `conflict`; a later retry names it → 409 `refund_superseded`, whatever that
 * retry's state; any refund on the payment `pending` → 409 `refund_in_flight`; its amount
 * above the payment's cap → 422 `over_cap`. The charge's own status is not a refusal (Fable
 * M9(b)): a late-success refund's row sits on a charge held `failed`.
 *
 * It writes a NEW row for the same payment, amount and instrument, naming `:id` in
 * `retry_of_refund_id`, issued by the retrier, its `reason` copied from the row it retries
 * (null stays null), keyed from the retry's own fresh key — and no credit row: the first
 * refund's removal stands for the whole chain.
 */
export async function retryStaffRefund(
  tx: Tx,
  args: { refundId: string; staffId: string; idempotencyKey: string },
): Promise<{ refundId: string; pending: PendingStripeRefund }> {
  const target = await refundsRepository.findById(tx, args.refundId);
  if (target === undefined) throw refundNotFound(args.refundId);
  const charge = await lockCharge(tx, target.chargeId);
  if (charge === undefined) throw refundNotFound(args.refundId);
  const row = await refundsRepository.findHeadFacts(tx, args.refundId);
  if (row === undefined) throw refundNotFound(args.refundId);
  if (row.status !== 'failed' || row.instrument !== 'original_card') {
    throw new ApiError('conflict', `refund ${row.id} is not a failed card refund`);
  }
  if (row.superseded) {
    throw new ApiError('refund_superseded', `refund ${row.id} has been retried already`);
  }
  if ((await refundsRepository.countPendingForCharge(tx, charge.id)) > 0) {
    throw new ApiError('refund_in_flight', 'a refund on this payment is still pending');
  }
  const cap = await refundsRepository.capRemainingForCharge(tx, {
    id: charge.id,
    amountCents: charge.amountCents,
  });
  if (row.amountCents > cap) {
    throw new ApiError('over_cap', `this payment can return at most ${cap} cents now`);
  }
  if (charge.stripePaymentIntentId === null) {
    // A `failed` row is Stripe's answer, so its charge has a PaymentIntent.
    throw new Error(
      `refund ${row.id} is failed on charge ${charge.id}, which has no PaymentIntent`,
    );
  }
  const refundId = randomUUID();
  const stripeIdempotencyKey = `${args.idempotencyKey}:refund`;
  await refundsRepository.createPending(tx, {
    id: refundId,
    ownerId: row.ownerId,
    chargeId: charge.id,
    bookingId: null,
    amountCents: row.amountCents,
    reason: row.reason,
    stripeIdempotencyKey,
    instrument: row.instrument,
    issuedByStaffId: args.staffId,
    retryOfRefundId: row.id,
  });
  return {
    refundId,
    pending: {
      refundId,
      paymentIntentId: charge.stripePaymentIntentId,
      amountCents: row.amountCents,
      stripeIdempotencyKey,
    },
  };
}

function refundNotFound(refundId: string): ApiError {
  return new ApiError('not_found', `refund ${refundId} not found`);
}
