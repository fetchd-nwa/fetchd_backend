import { chargesRepository } from '../db/repositories/chargesRepository.js';
import {
  LATE_SUCCESS_REFUND_REASON,
  refundsRepository,
  type RefundStatus,
} from '../db/repositories/refundsRepository.js';
import type { Tx } from '../db/tx.js';
import type { StripeRefundSnapshot, StripeRefundStatus } from './stripe.js';

/**
 * A refund's status moves through ONE apply function, whoever learned it (P22 brief, "One
 * cap, one apply, one removal writer"; design §2.7:4215-4228). Since P22 (wire 6.0.0) its
 * callers are the create's own reply (`firePendingRefundPostCommit`, in the transaction that
 * follows the call, design.md:4215-4217), the four refund events, and the refund sweep's
 * poll and look-up. See {@link applyLiveRefund}.
 */

/**
 * Project Stripe's wide refund status onto our terminal states. Non-terminal states return
 * undefined, so the caller waits for Stripe's next word. (`canceled` collapses to
 * `'failed'`: the money did not return to the customer.) Moved here from the webhook module
 * unchanged, so the reply and the events read one mapping.
 */
export function mapStripeRefundStatus(status: StripeRefundStatus): RefundStatus | undefined {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'canceled':
      return 'failed';
    case 'pending':
    case 'requires_action':
      return undefined;
  }
}

/** The one alarm sink the coverage tail needs. */
export interface RefundAlarmLog {
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * **THE returned-coverage read, with its surplus alarm attached** (MR-A3.3, 2026-08-24).
 * Returns the charge's returned coverage so the caller can apply the cumulative
 * `'refunded'` rule; raises the surplus ERROR when that coverage has passed the charge
 * total. Moved here from `webhooks/stripeEventHandlers.ts` unchanged in P22, so the create's
 * reply and the webhook's arms share it.
 *
 * **Why it is one helper and not two copies.** MR-A2.4 added the check to the ordinary flip
 * tail only. The adoption tail computed the same coverage and flipped the same charge — and
 * stayed SILENT past the total. The Fable lane executed it with no Stripe anomaly at all
 * (resolve 6000c by hand, then adopt a dashboard refund for the full charge): 20000c
 * returned on a 10000c charge, ZERO alarm lines. Two call sites that must agree about a
 * money alarm are two call sites that drift; the threshold, the fields and the sentence now
 * live in one place.
 *
 * **It records and alarms; it never refuses.** A signature-verified Stripe event saying a
 * refund succeeded means the money LEFT, and writing "10000c returned" while 20000c left is
 * exactly the false ledger this design exists to kill. The surplus sits with the OWNER, so
 * there is nothing to self-correct server-side — **the alarm IS the remedy**.
 *
 * Must be called with the charge row's lock already held: it reads coverage and the caller
 * writes the charge status from it.
 */
export async function settleReturnedCoverage(
  tx: Tx,
  args: {
    charge: { id: string; ownerId: string; amountCents: number };
    /** The `re_*` whose news is being applied — names the movement that crossed the line,
     *  which is where a human starts reading. */
    stripeRefundId: string;
    log?: RefundAlarmLog;
  },
): Promise<number> {
  const returned = await refundsRepository.sumReturnedCoverageForCharge(tx, args.charge.id);
  if (returned > args.charge.amountCents) {
    // Per-row `status` on the named rows (MR-A3.5(b)) so the ERROR says HOW the money left —
    // a Stripe refund, an adopted dashboard refund and a hand-attested return are three
    // different reconciliations.
    const contributing = await refundsRepository.findReturnedRowsForCharge(tx, args.charge.id);
    args.log?.error(
      {
        moneyEvent: 'refund-coverage-surplus',
        chargeId: args.charge.id,
        ownerId: args.charge.ownerId,
        chargeAmountCents: args.charge.amountCents,
        returnedCents: returned,
        surplusCents: returned - args.charge.amountCents,
        stripeRefundId: args.stripeRefundId,
        refunds: contributing,
      },
      'refund coverage EXCEEDS the charge: more money has gone back to this owner than the charge ever took. Each contributing row is named with its status — a Stripe refund, an adopted dashboard refund, or a hand-attested out-of-band return. Nothing here can reverse it (the surplus is with the owner), so this must be reconciled out of band',
    );
  }
  return returned;
}

/** What {@link applyLiveRefund} did, for the arm's outcome and log line. */
export type LiveRefundOutcome =
  /** `pending → succeeded`, with the coverage tail. */
  | 'applied-succeeded'
  /** `pending → failed`. */
  | 'applied-failed'
  /** The one backwards edge, `succeeded → failed`: the cap reopened, the charge recomputed. */
  | 'reopened'
  /** A live `pending` (or `requires_action`): the row's `re_` stored, no status written. */
  | 'stored-id'
  /** A refund nothing here minted, recorded: a dashboard refund. */
  | 'adopted'
  /**
   * The row is held `failed` and Stripe reads `succeeded` (Fable M6). Nothing is written:
   * the machine refuses it. The arm retrieves once more with no transaction open, and says
   * so only if that read is still `succeeded`.
   */
  | 'held-failed-reads-succeeded'
  /** Nothing to do: already there, or a row no event moves. */
  | 'unchanged';

export interface LiveRefundResult {
  outcome: LiveRefundOutcome;
  /** Our row, matched or adopted. */
  refundId: string;
  stripeRefundId: string;
  chargeId: string;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A second Stripe refund for one of our rows, at that row's amount (go 2's design silence 4,
 * "adopted as money, with the alarms"; P22 fix 1; one at another amount is the line below
 * instead): recorded as a refund of its own, so the cap counts it, and
 * said at level 50 whether or not the cap is passed, since one refund decision now has two
 * refunds at Stripe. Said only when the second refund is recorded `pending` or `succeeded`:
 * one Stripe has already failed returns no money, the cap does not count it, and nothing
 * here moves a `failed` row to `succeeded`. Said once per such refund: only the adoption
 * says it, and every later event about that `re_` (a redelivery, the other refund events,
 * `charge.refunded`) finds the adopted row by `stripe_refund_id` under the charge lock,
 * which every apply takes first, so it never reaches the adoption again.
 */
const SECOND_STRIPE_REFUND_FOR_ROW_ALARM =
  "TWO STRIPE REFUNDS NAME ONE REFUND ROW — this Stripe refund (secondStripeRefundId) carries row refundId in its metadata.refund_id, and that row already holds another Stripe refund (rowStripeRefundId; the row reads rowStatus). It was recorded as a refund of its own (adoptedRefundId, reading secondStatus here), so the payment's cap counts its money. One refund decision now has at least two refunds at Stripe: check both in Stripe, on paymentIntentId, before anyone sends or retries another refund on this payment, the row's own Retry to card included";

/** The row a second Stripe refund names (step 2), read under the charge lock. */
interface SecondRefundFor {
  id: string;
  stripeRefundId: string;
  status: RefundStatus;
  amountCents: number;
}

/**
 * A Stripe refund whose `metadata.refund_id` names a row of this charge at another amount
 * (Opus r2 L2): never that row's refund, because every refund this app sends for a row is
 * built by `refundCreateParams` from that row's own amount (the post-commit fire, the
 * sweep's same-key re-fire and its one re-keyed send alike), and no writer changes a row's
 * amount. So it is recorded as a refund of its own (step 4), the cap counting its real
 * amount, and said at level 50 whether or not the row holds a `re_` yet: the comparison
 * comes before the `re_` check, so which of two refunds naming one row is applied first
 * (`charge.refunded` lists newest first) never changes which line is said. Said only when
 * it is recorded `pending` or `succeeded`, as the second-refund line is, and once per
 * refund for the same reason: only the adoption says it, and every later event, poll or
 * look-up finds the adopted row by `stripe_refund_id` under the charge lock. (Once per
 * committed adoption: a crash between the line and its commit says it again on the
 * redelivery, as the second-refund line does, Opus r2 N1.)
 */
const METADATA_NAMES_ROW_OTHER_AMOUNT_ALARM =
  "A STRIPE REFUND NAMES A REFUND ROW BUT NOT ITS AMOUNT — this Stripe refund (stripeRefundId, for stripeRefundAmountCents) carries row refundId in its metadata.refund_id, but that row is for rowAmountCents, and every refund this app sends for a row carries that row's own amount, so it was not sent for that row and was not written onto it. It was recorded as a refund of its own (adoptedRefundId, reading adoptedStatus here), so the payment's cap counts its money, and the row was left as it reads (rowStatus; its own Stripe refund rowStripeRefundId, null while it has none). Check in Stripe, on paymentIntentId, who made this refund and what each refund on this payment is for, before anyone sends, retries or records another refund on this payment, the row's own Retry to card included";

/** The row a Stripe refund names at another amount (step 2), read under the charge lock. */
interface NamedAtOtherAmount {
  id: string;
  stripeRefundId: string | null;
  status: RefundStatus;
  amountCents: number;
}

const ADOPTED_OVER_CAP_ALARM =
  'a refund made outside the app was recorded on this charge beyond what it could still return: counting the refunds already held against it, more money goes back than the charge took if they all complete. It was recorded, not refused, because the money moved. Check this charge\'s refunds in Stripe before anyone sends or retries another refund on it';

/**
 * **THE apply function** (P22 brief, "One cap, one apply, one removal writer"; design
 * §2.7:4215-4228): a refund's status moves here, whoever learned it. The create's reply
 * (`firePendingRefundPostCommit`), the four refund events (`stripeEventHandlers.ts`), the
 * refund sweep's poll and its look-up (`workers/duplicateRefundRetry.ts`) each read the
 * refund from Stripe with NO transaction open and hand it here, inside one, where it takes
 * the charge lock first (charges → refunds, the one global order) and decides everything
 * from what it reads after the lock.
 *
 * **Whose refund it is**, in this order (Fable H3, H2):
 *   1. `stripe_refund_id` names a row → that row.
 *   2. The refund's `metadata.refund_id` names a row of THIS charge, at that row's amount,
 *      with no `re_` yet → that row, its `re_` stored in the same transaction. Every create
 *      carries it from P22 (`refundCreateParams`), with the row's own amount. Metadata
 *      naming no row of this charge reads as none. One naming a row at another amount is
 *      not that row's refund, and is recorded (step 4) with its own line (Opus r2 L2), the
 *      amount compared before the `re_`; one naming a row, at its amount, that already
 *      holds a different `re_` is a second Stripe refund for one row, and is recorded (step
 *      4) so the cap and the alarms see that money.
 *   3. No `metadata.refund_id` → the amount fallback onto a `pending` row with no `re_`
 *      and no `issued_by_staff_id` (rows minted before P22;
 *      `refundsRepository.findUnmatchedPendingForCharge`).
 *   4. None → a refund made outside the app, **adopted whatever else is pending on the
 *      charge**: money only, removing no credits, at its live status (`pending` while it
 *      is pending, so it counts in the cap and holds `refund_in_flight` at once). Over the
 *      cap it is recorded and said, never refused: the money moved (design.md:4270-4272).
 *
 * **The live status, never the event's**, on the machine `pending → succeeded | failed`,
 * and the one backwards edge `succeeded → failed`: the cap reopens (a `failed` row leaves
 * it), a `refunded` charge is recomputed under the same lock, and the removed credits stay
 * removed, because the money is still owed. `resolved-external` and `unroutable` rows take
 * no event, and a `failed` row takes no `succeeded` (Fable M6), so the edge happens at most
 * once.
 */
export async function applyLiveRefund(
  tx: Tx,
  args: { chargeId: string; live: StripeRefundSnapshot; log?: RefundAlarmLog },
): Promise<LiveRefundResult> {
  const { live } = args;
  const charge = await chargesRepository.findByIdForUpdate(tx, args.chargeId);
  if (charge === undefined) {
    throw new Error(`applyLiveRefund: charge ${args.chargeId} does not exist`);
  }
  const result = (outcome: LiveRefundOutcome, refundId: string): LiveRefundResult => ({
    outcome,
    refundId,
    stripeRefundId: live.id,
    chargeId: charge.id,
  });

  // ── whose refund, decided under the lock ───────────────────────────────
  let row = await refundsRepository.findByStripeRefundId(tx, live.id);
  let storeId = false;
  if (row !== undefined && row.chargeId !== charge.id) {
    throw new Error(
      `applyLiveRefund: ${live.id} is refund ${row.id} of charge ${row.chargeId}, not of charge ${charge.id}`,
    );
  }
  const namesOurs = live.metadataRefundId !== undefined && UUID_SHAPE.test(live.metadataRefundId);
  let namedRowOfThisCharge = false;
  /** The row this refund names that already holds a different `re_`: a second Stripe refund for it. */
  let secondFor: SecondRefundFor | undefined;
  /** The row this refund names at another amount: not that row's refund (Opus r2 L2). */
  let namedAtOtherAmount: NamedAtOtherAmount | undefined;
  if (row === undefined && namesOurs) {
    const named = await refundsRepository.findById(tx, live.metadataRefundId!);
    if (named !== undefined && named.chargeId === charge.id) {
      namedRowOfThisCharge = true;
      if (named.amountCents !== live.amountCents) {
        namedAtOtherAmount = {
          id: named.id,
          stripeRefundId: named.stripeRefundId,
          status: named.status,
          amountCents: named.amountCents,
        };
      } else if (named.stripeRefundId === null) {
        row = named;
        storeId = true;
      } else {
        secondFor = {
          id: named.id,
          stripeRefundId: named.stripeRefundId,
          status: named.status,
          amountCents: named.amountCents,
        };
      }
    }
  }
  if (row === undefined && !namedRowOfThisCharge) {
    const byAmount = await refundsRepository.findUnmatchedPendingForCharge(tx, {
      chargeId: charge.id,
      amountCents: live.amountCents,
    });
    if (byAmount !== undefined) {
      row = byAmount;
      storeId = true;
    }
  }
  const target = mapStripeRefundStatus(live.status);
  if (row === undefined) {
    return adopt(tx, { charge, live, target, secondFor, namedAtOtherAmount, log: args.log }).then((id) =>
      result('adopted', id),
    );
  }

  // ── the live status, on the machine ────────────────────────────────────
  if (row.status === 'resolved-external' || row.status === 'unroutable') {
    // A human attested this row closed, or it never had a route: no event moves it. A
    // stale event flipping an attested row back to `failed` would reopen the cap for an
    // automatic leg to pay a second time (money-residue §4.3).
    return result('unchanged', row.id);
  }
  if (storeId) await refundsRepository.markStripeId({ id: row.id, stripeRefundId: live.id }, tx);

  if (row.status === 'pending') {
    if (target === 'succeeded') {
      await refundsRepository.markStatus(tx, { id: row.id, status: 'succeeded' });
      await coverageTail(tx, { charge, stripeRefundId: live.id, log: args.log });
      return result('applied-succeeded', row.id);
    }
    if (target === 'failed') {
      await refundsRepository.markStatus(tx, { id: row.id, status: 'failed' });
      return result('applied-failed', row.id);
    }
    return result(storeId ? 'stored-id' : 'unchanged', row.id);
  }
  if (row.status === 'succeeded') {
    if (target !== 'failed') return result(storeId ? 'stored-id' : 'unchanged', row.id);
    // THE backwards edge. The credits the refund removed stay removed: the money is still
    // owed, and a *Retry to card* of this row pays it.
    await refundsRepository.markStatus(tx, { id: row.id, status: 'failed' });
    if (charge.status === 'refunded') {
      const returned = await refundsRepository.sumReturnedCoverageForCharge(tx, charge.id);
      if (returned < charge.amountCents) {
        // The engine's late success (an automatic row, never a staff row whose typed reason
        // reads the same): a charge the app never accepted goes back to `failed`, never to
        // `succeeded`, which would read as paid (P15 state table row 16; Fable r1 N2).
        const lateSuccess = await refundsRepository.hasAutomaticRefundWithReason(
          tx,
          charge.id,
          LATE_SUCCESS_REFUND_REASON,
        );
        await chargesRepository.reopenRefunded(tx, {
          id: charge.id,
          status: lateSuccess ? 'failed' : 'succeeded',
        });
      }
    }
    return result('reopened', row.id);
  }
  // `failed`: the edge has happened, or Stripe failed it from `pending`. A `succeeded` read
  // is refused here (Fable M6) and the arm decides whether to say so.
  return result(target === 'succeeded' ? 'held-failed-reads-succeeded' : 'unchanged', row.id);
}

/** A `succeeded` row's tail: the returned coverage, its surplus alarm, and `refunded`. */
async function coverageTail(
  tx: Tx,
  args: {
    charge: { id: string; ownerId: string; amountCents: number };
    stripeRefundId: string;
    log: RefundAlarmLog | undefined;
  },
): Promise<number> {
  const returned = await settleReturnedCoverage(tx, {
    charge: args.charge,
    stripeRefundId: args.stripeRefundId,
    ...(args.log !== undefined ? { log: args.log } : {}),
  });
  if (returned >= args.charge.amountCents) {
    await chargesRepository.markStatus(tx, { id: args.charge.id, status: 'refunded' });
  }
  return returned;
}

/** Step 4: a refund made outside the app, recorded at its live status. */
async function adopt(
  tx: Tx,
  args: {
    charge: { id: string; ownerId: string; amountCents: number; stripePaymentIntentId: string | null };
    live: StripeRefundSnapshot;
    target: RefundStatus | undefined;
    /** Set when this refund names a row of ours that already holds another `re_`. */
    secondFor: SecondRefundFor | undefined;
    /** Set when this refund names a row of ours at another amount. */
    namedAtOtherAmount: NamedAtOtherAmount | undefined;
    log: RefundAlarmLog | undefined;
  },
): Promise<string> {
  const status = args.target ?? 'pending';
  const adopted = await refundsRepository.adoptExternalRefundCapped(tx, {
    ownerId: args.charge.ownerId,
    chargeId: args.charge.id,
    // A dashboard refund names a Stripe charge, not one of our bookings.
    bookingId: null,
    amountCents: args.live.amountCents,
    status,
    stripeRefundId: args.live.id,
    reason: 'out-of-band',
  });
  let surplusSaid = false;
  if (status === 'succeeded') {
    const returned = await coverageTail(tx, {
      charge: args.charge,
      stripeRefundId: args.live.id,
      log: args.log,
    });
    surplusSaid = returned > args.charge.amountCents;
  }
  if (status !== 'failed' && args.live.amountCents > adopted.remainingBeforeCents && !surplusSaid) {
    args.log?.error(
      {
        moneyEvent: 'refund-adopted-over-cap',
        chargeId: args.charge.id,
        ownerId: args.charge.ownerId,
        chargeAmountCents: args.charge.amountCents,
        remainingBeforeCents: adopted.remainingBeforeCents,
        adoptedCents: args.live.amountCents,
        refundId: adopted.refund.id,
        stripeRefundId: args.live.id,
        refundStatus: status,
      },
      ADOPTED_OVER_CAP_ALARM,
    );
  }
  if (args.secondFor !== undefined && status !== 'failed') {
    args.log?.error(
      {
        moneyEvent: 'refund-second-stripe-refund-for-row',
        refundId: args.secondFor.id,
        rowStripeRefundId: args.secondFor.stripeRefundId,
        rowStatus: args.secondFor.status,
        rowAmountCents: args.secondFor.amountCents,
        adoptedRefundId: adopted.refund.id,
        secondStripeRefundId: args.live.id,
        secondAmountCents: args.live.amountCents,
        secondStatus: status,
        paymentIntentId: args.live.paymentIntentId ?? args.charge.stripePaymentIntentId,
        chargeId: args.charge.id,
        ownerId: args.charge.ownerId,
      },
      SECOND_STRIPE_REFUND_FOR_ROW_ALARM,
    );
  }
  if (args.namedAtOtherAmount !== undefined && status !== 'failed') {
    args.log?.error(
      {
        moneyEvent: 'refund-metadata-names-row-other-amount',
        refundId: args.namedAtOtherAmount.id,
        rowAmountCents: args.namedAtOtherAmount.amountCents,
        rowStatus: args.namedAtOtherAmount.status,
        rowStripeRefundId: args.namedAtOtherAmount.stripeRefundId,
        adoptedRefundId: adopted.refund.id,
        stripeRefundId: args.live.id,
        stripeRefundAmountCents: args.live.amountCents,
        adoptedStatus: status,
        paymentIntentId: args.live.paymentIntentId ?? args.charge.stripePaymentIntentId,
        chargeId: args.charge.id,
        ownerId: args.charge.ownerId,
      },
      METADATA_NAMES_ROW_OTHER_AMOUNT_ALARM,
    );
  }
  return adopted.refund.id;
}
