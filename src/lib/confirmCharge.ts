import type {
  ApiErrorEnvelope,
  ChargeBlocker,
  InvoicePayWire,
  PaymentFailedDetails,
} from '../contracts/wire.js';
import { deepLinkToPath } from '../contracts/wire.js';
import { db } from '../db/client.js';
import {
  attachOrderToClaim,
  claimIdempotencyKey,
  completeOrderClaim,
  readCompletedClaim,
  type IdempotencyClaim,
} from '../db/idempotency.js';
import { lockCharge } from '../db/locks.js';
import {
  chargesRepository,
  type ChargePurpose,
  type EngineChargeRow,
} from '../db/repositories/chargesRepository.js';
import { invoicesRepository, repointPaymentMethod } from '../db/repositories/invoicesRepository.js';
import { ordersRepository, type OrderRow } from '../db/repositories/ordersRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { withActor, type Tx } from '../db/tx.js';
import { ApiError, toErrorEnvelope } from './errors.js';
import { formatDollars } from './invoiceReceiptCopy.js';
import { noticeInSavepoint } from './noticeInSavepoint.js';
import { cancelOrderRowsInTx, type CancelledOrderRows } from './orderRows.js';
import { firePendingRefundPostCommit, type PendingStripeRefund } from './pendingRefund.js';
import { settleChargeAgainstInvoice } from './settleInvoiceCharge.js';
import {
  chargeBlockerForConfirm,
  isStripeNetworkFailure,
  stripeIdempotencyErrorKind,
  type ChargeBlockerLogger,
  type StripeCallBudget,
  type StripeClient,
  type StripePaymentIntentResult,
} from './stripe.js';

/**
 * The order engine (design §2.7:3824-3898; PAY-U05, PAY-U07): one order, one charge,
 * one PaymentIntent, **two transactions with Stripe between them**, automatic capture.
 *
 *   tx1          the request key's claim, the order, the caller's locks and guards,
 *                one `charges` row at `requires_payment` with K0, the frozen create
 *                parameters and the lease. COMMIT. The committed rows are the hold.
 *   Stripe       no transaction open. Create under K0 with `confirm: false`, which
 *                moves no money; commit the intent id in one conditional write; then
 *                confirm off-session, retrying only a transient `processing_error` or
 *                a network failure, on the same intent, one key per attempt.
 *   the settle   under the charge lock, state-guarded.
 *
 * **So a charge with no stored intent id is a charge no card was tried on**, whatever
 * crashed or timed out, and that one sentence is why the sweeper can abandon it.
 *
 * **Who owns a charge.** The request, while its lease is live. `attempting_until` is
 * the request's column and `next_sweep_at` the sweeper's. The lease is renewed
 * conditionally before every Stripe call, on Postgres's clock; past it, or once the
 * sweeper has claimed the row, the renewal finds nothing, so a lease once lost stays
 * lost and the sweeper owns the order from there. There is no third state. The one
 * thing that fence cannot stop is a confirm already on the wire, and Stripe stops that:
 * the sweeper cancels before it says "failed", and a cancelled intent refuses any
 * confirm.
 *
 * **`failed` does not mean nothing can move.** A `failed` charge has no intent, or a
 * dead intent, or it is on the sweeper's watch until Stripe says something final
 * ({@link failChargeInTx}). And a last confirm that went unanswered is not a failure:
 * something may still be running, so the engine stops with no answer and the order
 * ends when Stripe says how.
 *
 * **Every settler ends in one of two functions in this file**, {@link settleChargeInTx}
 * and {@link failChargeInTx}, whether it is the request, the webhook, the sweeper or a
 * *Cancel order*. Each takes the charge lock, reads the status, and is a no-op on a
 * charge somebody else already moved. The request therefore never assumes it was the
 * one who answered: after any terminal act it reads the answer off its own claim
 * ({@link readCompletedClaim}), because whoever settled the order recorded it there.
 * The one exception is a withdraw whose verdict is `refunded`, which moves the money
 * itself and closes the claim through {@link completeClaimOfWithdrawnCharge}.
 *
 * **This step's reach (DECISIONS 142(c)).** `POST /invoices/:id/pay` is the one live
 * caller. A caller's work is passed in through `inTx1`. tx1's booking arm and the
 * settle's top-up and pack arms are P18's: their body is P16's and their columns are
 * M4.10's. So {@link settleChargeInTx} refuses a charge whose order names no invoice,
 * loudly, rather than pretend.
 */

/** Who hears the engine. `error` pages (`alarmForwardingHooks`). */
export interface EngineLog extends ChargeBlockerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

/** What a final failure does with the order (design §2.7:3899-3902). */
export type FinalFailurePolicy = 'cancel-order' | 'leave-invoice-open';

/**
 * How long a phone waits on a payment's answer: the seed of `pay.seat_hold_max_minutes`,
 * and deliberately not the setting. The owner's settings document does not carry it
 * (`OwnerPaymentSettingsWire`), so her phone runs on the seed whatever staff set. This is
 * the server's half of one number: the phone's is `PAY_HOLD_SEED_MS` in
 * `mobile/src/lib/payResend.ts`, and the two change together.
 *
 * "Told once" holds within one re-send interval, about 5 s, not to the instant. The two
 * clocks start apart and the phone only reads on a re-send, so its last send can leave up
 * to that long past the hold: a decline landing in that gap is a 402 on screen and a push,
 * told twice. One landing after her last send and ahead of this mark, about the first
 * request's latency, is neither. Both are seconds wide, and no money turns on either.
 */
export const PAY_HOLD_SEED_MS = 2 * 60 * 1000;

/** One order's Stripe budget, read once per call of the engine. */
export interface EngineBudget {
  attemptsMax: number;
  /** One Stripe call's timeout, the same for every verb. */
  call: StripeCallBudget;
  /** `pay.seat_hold_max_minutes` plus one per-call timeout. */
  leaseMs: number;
  /**
   * How long the sweeper holds a row it claimed, four per-call timeouts: a retrieve, a
   * cancel, `cancelAndConfirm`'s re-retrieve and `askWhatWon`'s retrieve.
   */
  sweepClaimMs: number;
  processingHoldMinutes: number;
}

export async function readEngineBudget(runner: Tx | typeof db = db): Promise<EngineBudget> {
  const settings = await settingsRepository.orderEngine(runner);
  const holdMs = settings.seat_hold_max_minutes * 60_000;
  const timeoutMs = Math.floor(holdMs / (settings.card_attempts_max_count + 1));
  return {
    attemptsMax: settings.card_attempts_max_count,
    call: { timeoutMs },
    leaseMs: holdMs + timeoutMs,
    sweepClaimMs: 4 * timeoutMs,
    processingHoldMinutes: settings.processing_hold_max_minutes,
  };
}

/** K0: the order-scoped key of the one create. Never derived from the client's key. */
function createKey(orderId: string): string {
  return `order:${orderId}`;
}

function confirmKey(orderId: string, attempt: number): string {
  return `order:${orderId}:confirm:${attempt}`;
}

/**
 * How many times one create may be sent. A lost create is re-sent once under K0 with
 * the frozen parameters (design §2.7:3842-3843). The budget names the create as one
 * call, so the re-send is paid for by the one per-call timeout the lease carries past
 * the hold, and a second loss stops: the sweeper abandons a charge with no intent id.
 */
const CREATE_SENDS_MAX = 2;

/** Stripe's transient code: the one card-level answer that spends another try. */
const TRANSIENT_CARD_CODE = 'processing_error';

// ── the 402 ──────────────────────────────────────────────────────────────────

const DECLINED_SENTENCE = 'the card charge did not complete';
const ABANDONED_SENTENCE = 'this payment was never started, so no card was charged';
const CANCELLED_WHILE_PROCESSING_SENTENCE =
  'this order is cancelled; if the bank still takes the payment, it is refunded automatically';

/**
 * The committed 402, as `auth/plugin.ts` sends it, so a replay is the same bytes. The
 * `processing` arm is a charge Stripe would not cancel, which may not have failed:
 * its sentence and its blocker say what is true, since the code cannot.
 */
export function paymentFailedEnvelope(args: {
  orderId: string;
  attempts: number;
  blocker: ChargeBlocker | undefined;
}): ApiErrorEnvelope {
  const outcome = args.attempts === 0 ? 'abandoned' : 'failed';
  const details: PaymentFailedDetails = {
    kind: 'payment_failed',
    ...(args.blocker !== undefined ? { charge_blocker: args.blocker } : {}),
    order_id: args.orderId,
    attempts: args.attempts,
    outcome,
  };
  const sentence =
    args.blocker === 'processing'
      ? CANCELLED_WHILE_PROCESSING_SENTENCE
      : outcome === 'abandoned'
        ? ABANDONED_SENTENCE
        : DECLINED_SENTENCE;
  return toErrorEnvelope(new ApiError('payment_failed', sentence, details));
}

// ── what every settler can report ────────────────────────────────────────────

/** What one settler did, and what it owes after commit. */
export interface EngineAct {
  outcome: 'settled' | 'lost-race' | 'late-refund' | 'failed' | 'no-op';
  pendingStripeRefund?: PendingStripeRefund;
  /** The rows a `cancel-order` failure took down. */
  cancelled?: CancelledOrderRows;
}

const NOTHING_DONE: EngineAct = { outcome: 'no-op' };

/** The post-commit half, for the two callers that have no receiver of their own. */
export async function finishEngineAct(
  act: EngineAct,
  args: {
    stripe: Pick<StripeClient, 'createRefund'>;
    log: EngineLog;
    context: Record<string, unknown>;
  },
): Promise<void> {
  await firePendingRefundPostCommit({
    pending: act.pendingStripeRefund,
    stripe: args.stripe,
    log: args.log,
    context: args.context,
  });
}

// ── the settle ───────────────────────────────────────────────────────────────

const AMOUNT_RECEIVED_MISMATCH_ALARM =
  'an order charge settled with amount_received different from the amount asked: a person must reconcile it';
const NO_INVOICE_SETTLE_ALARM =
  'an engine charge whose order has no invoice reached succeeded: only a top-up or a pack can, and neither is on the engine yet';
const LATE_SUCCESS_ALARM =
  'a charge succeeded after its order was cancelled: it grants nothing and is being refunded in full, automatically';
const LATE_SUCCESS_NO_INTENT_ALARM =
  'a charge succeeded after its order was cancelled, and no refund could be minted because the row names no intent: an owner is owed this money, its watch stays open, and a person must refund it';

/** The `refunds.reason` of the automatic refund (follow-up 4, SIGNOFF.md:208-209). */
export const LATE_SUCCESS_REFUND_REASON = 'late-success-refund';

/** Thrown after {@link NO_INVOICE_SETTLE_ALARM}: nothing commits, and a webhook retries. */
export class OrderSettleUnreachableError extends Error {}

async function requireOrder(tx: Tx, charge: EngineChargeRow): Promise<OrderRow> {
  if (charge.orderId === null) {
    throw new Error(`charge ${charge.id} is not an engine charge: it has no order_id`);
  }
  const order = await ordersRepository.findById(tx, charge.orderId);
  if (order === undefined) {
    throw new Error(`charge ${charge.id} names order ${charge.orderId}, which does not exist`);
  }
  return order;
}

/**
 * A success on a charge that is already `failed`: its order ended, by a person while
 * it was `processing`, by a decline Stripe later overturned, or by the sweeper with no
 * intent id stored. It grants nothing, because only a charge moved from
 * `requires_payment` settles, and it is refunded in full by this arm, reached from the
 * webhook or the sweeper's watch (design §2.7:3916-3927). The refund is capped under the
 * charge lock, so the second of those mints nothing, and the watch closes in the same
 * transaction, so a refund Stripe later fails goes to a person and is not minted again
 * here. The one mint that leaves the watch open is `no-payment-intent`: money is owed and
 * no refund exists, so it alarms. The school absorbs the fee. `payment-refunded` is born
 * with M7.09, so until LG7 this writes the row and no notice (design §2.7:3926).
 */
async function refundLateSuccess(
  tx: Tx,
  charge: EngineChargeRow,
  args: { live: StripePaymentIntentResult; log: EngineLog },
): Promise<EngineAct> {
  if (charge.stripePaymentIntentId === null) {
    await chargesRepository.storeLateIntentId(tx, { id: charge.id, intentId: args.live.id });
  }
  const minted = await refundsRepository.mintCappedPendingRefund(tx, {
    chargeId: charge.id,
    ownerId: charge.ownerId,
    bookingId: null,
    reason: LATE_SUCCESS_REFUND_REASON,
    stripeIdempotencyKey: (refundId) => `late-success-refund:${refundId}`,
  });
  if (minted.kind === 'no-payment-intent') {
    // Unreachable while the id above is stored in this transaction. If it ever isn't,
    // money is owed and nothing was minted, so nothing here may look finished.
    args.log.error(
      { chargeId: charge.id, orderId: charge.orderId, amountCents: minted.amountCents },
      LATE_SUCCESS_NO_INTENT_ALARM,
    );
    return NOTHING_DONE;
  }
  await chargesRepository.closeWatch(tx, { id: charge.id });
  if (minted.kind !== 'minted') return NOTHING_DONE;
  args.log.error(
    {
      chargeId: charge.id,
      orderId: charge.orderId,
      refundId: minted.refundId,
      amountCents: minted.amountCents,
    },
    LATE_SUCCESS_ALARM,
  );
  return {
    outcome: 'late-refund',
    pendingStripeRefund: {
      refundId: minted.refundId,
      paymentIntentId: minted.paymentIntentId,
      amountCents: minted.amountCents,
      stripeIdempotencyKey: minted.stripeIdempotencyKey,
    },
  };
}

/**
 * Settle a locked `requires_payment` charge whose intent succeeded. Only this moves a
 * charge to `succeeded`, so only this enqueues the receipt. The invoice flips through
 * the same `settleChargeAgainstInvoice` the webhook uses, which keeps
 * PAY-35: a lost race refunds this charge, and the card rebind (PAY-12) fires only on
 * the clean win.
 */
async function settleOpenCharge(
  tx: Tx,
  charge: EngineChargeRow,
  order: OrderRow,
  args: {
    live: StripePaymentIntentResult;
    receiptTrigger: 'order-confirm' | 'settle';
    log: EngineLog;
    now: Date;
  },
): Promise<EngineAct> {
  const { live, log, now } = args;
  if (order.invoiceId === null) {
    log.error({ chargeId: charge.id, orderId: order.id }, NO_INVOICE_SETTLE_ALARM);
    throw new OrderSettleUnreachableError(NO_INVOICE_SETTLE_ALARM);
  }
  if (live.amountReceivedCents !== charge.amountCents) {
    log.error(
      {
        chargeId: charge.id,
        orderId: order.id,
        amountCents: charge.amountCents,
        amountReceivedCents: live.amountReceivedCents ?? null,
      },
      AMOUNT_RECEIVED_MISMATCH_ALARM,
    );
  }

  await chargesRepository.markEngineSucceeded(tx, { id: charge.id, intentId: live.id });

  const invoice = await invoicesRepository.findById(tx, order.invoiceId);
  if (invoice === undefined) {
    throw new Error(`order ${order.id} names invoice ${order.invoiceId}, which does not exist`);
  }
  const settled = await settleChargeAgainstInvoice(tx, {
    invoice,
    chargeId: charge.id,
    paymentIntentId: live.id,
    amountCents: charge.amountCents,
    purpose: charge.purpose,
    notifyOwner: true,
    receiptPush: { trigger: args.receiptTrigger, scheduledFor: now },
    log,
  });

  const won = settled.outcome === 'settled';
  if (
    won &&
    charge.paymentMethodId !== null &&
    charge.paymentMethodId !== invoice.paymentMethodId
  ) {
    // `LedgerEntryWire.settled_card` is derived from `invoices.payment_method_id`, so
    // without this the receipt would name a card that was never charged. Not on a
    // lost race: another path settled this invoice, and the bound card must keep
    // naming what THAT charged.
    await repointPaymentMethod(tx, { id: invoice.id, paymentMethodId: charge.paymentMethodId });
  }

  const body: InvoicePayWire = {
    charge_id: charge.id,
    charge_status: 'succeeded',
    stripe_payment_intent_id: live.id,
    client_secret: live.clientSecret,
    invoice_status: won || invoice.status === 'open' ? 'paid' : invoice.status,
    charge_refunded: !won,
  };
  await completeOrderClaim(tx, { orderId: order.id, status: 201, body, log });

  return {
    outcome: won ? 'settled' : 'lost-race',
    ...(settled.outcome === 'refunded' && settled.pendingStripeRefund !== undefined
      ? { pendingStripeRefund: settled.pendingStripeRefund }
      : {}),
  };
}

/**
 * The one arm for an intent Stripe says `succeeded`, for every settler. Under the
 * charge lock, state-guarded: `requires_payment` settles, `failed` is the late
 * success, and anything else was settled by somebody else, so this is a no-op.
 */
export async function settleChargeInTx(
  tx: Tx,
  args: {
    chargeId: string;
    live: StripePaymentIntentResult;
    receiptTrigger: 'order-confirm' | 'settle';
    log: EngineLog;
    now: Date;
  },
): Promise<EngineAct> {
  const charge = await lockCharge(tx, args.chargeId);
  if (charge === undefined) throw new Error(`settle: charge ${args.chargeId} not found`);
  const order = await requireOrder(tx, charge);
  switch (charge.status) {
    case 'succeeded':
    case 'refunded':
      return NOTHING_DONE;
    case 'failed':
      return refundLateSuccess(tx, charge, args);
    case 'requires_payment':
      return settleOpenCharge(tx, charge, order, args);
  }
}

// ── a final failure ──────────────────────────────────────────────────────────

/** An order's policy, for the settlers that hold no caller: the request named it. */
function policyOfOrder(order: OrderRow): FinalFailurePolicy {
  return order.invoiceId !== null ? 'leave-invoice-open' : 'cancel-order';
}

/** The failed-payment notice's own words, one per trigger (design §2.9:4546). */
function failureNoticeCopy(
  trigger: 'charge-failed' | 'order-cancelled',
  amountCents: number,
): { title: string; body: string } {
  return trigger === 'charge-failed'
    ? {
        title: 'Payment failed',
        body: `Your ${formatDollars(amountCents)} payment didn't go through, so you weren't charged.`,
      }
    : {
        title: 'Payment cancelled',
        body: `Your ${formatDollars(amountCents)} payment was cancelled, so you weren't charged.`,
      };
}

/**
 * Is what this notice says still true of her invoice? "You weren't charged" cannot land
 * after "We charged your card": a second tender may have paid the invoice in the gap
 * before this failure was reached, and then the owner owes nothing and has heard so. An
 * order with no invoice has nothing else that can answer for it.
 *
 * Under the invoice's row lock, because a plain read says `open` from a settle's `UPDATE`
 * to its `COMMIT`: this waits for that commit and reads what it left. The charge is held
 * here, so this is charge then invoice, the one order (`db/locks.ts`).
 */
async function invoiceStillOwed(tx: Tx, order: OrderRow): Promise<boolean> {
  if (order.invoiceId === null) return true;
  const invoice = await invoicesRepository.lockById(tx, order.invoiceId);
  return invoice?.status === 'open';
}

/** The failed-payment notice, in its own savepoint. A decline at Confirm writes none. */
export async function noticePaymentFailed(
  tx: Tx,
  args: {
    charge: EngineChargeRow;
    order: OrderRow;
    trigger: 'charge-failed' | 'order-cancelled';
    now: Date;
    log: EngineLog;
  },
): Promise<void> {
  const { charge, order, trigger, now, log } = args;
  const dedupeKey = `${trigger}:${charge.id}`;
  await noticeInSavepoint(tx, { subject: { chargeId: charge.id }, dedupeKey, log }, async (sp) => {
    await scheduledNotificationsRepository.enqueueIdempotent(sp, {
      ownerId: charge.ownerId,
      type: 'payment-failed',
      trigger,
      dedupeKey,
      scheduledFor: now,
      ...failureNoticeCopy(trigger, charge.amountCents),
      ...(order.invoiceId !== null
        ? {
            deepLinkPath: deepLinkToPath({
              kind: 'invoice',
              id: order.invoiceId,
              params: { reason: 'payment-failed' },
            }),
            deepLinkKind: 'invoice' as const,
            deepLinkId: order.invoiceId,
          }
        : {}),
    });
  });
}

/**
 * Fail a locked `requires_payment` charge: the caller's policy, the stored outcome,
 * and the committed 402 on the claim (design §2.7:3890-3896). `cancel-order` cancels
 * every row and returns every debit; `leave-invoice-open` leaves the invoice open with
 * only the failed charge recorded. No-op on a charge somebody else already moved.
 *
 * `attempts: 0` is what makes the 402 `abandoned`: no confirm was ever sent.
 *
 * **What opens the watch.** A charge with an intent id goes on the sweeper's watch
 * unless the caller says Stripe has already killed that intent (`intentDead`), so the
 * rule never reads the blocker: it covers `processing`, every decline, and a confirm
 * answered `requires_confirmation`.
 *
 * The 402 is stored whatever the invoice reads, because it answers this order's key.
 * `notice` is said to her, so it goes only where it is still true.
 */
export async function failChargeInTx(
  tx: Tx,
  args: {
    chargeId: string;
    policy?: FinalFailurePolicy;
    blocker: ChargeBlocker | undefined;
    lastError: string | null;
    notice?: 'charge-failed' | 'order-cancelled';
    cancelledBy?: 'owner' | 'staff';
    cancelReason?: string;
    /** Stripe said this intent is `canceled`: nothing can ever move, so no watch. */
    intentDead?: true;
    log: EngineLog;
    now: Date;
  },
): Promise<EngineAct> {
  const charge = await lockCharge(tx, args.chargeId);
  if (charge === undefined) throw new Error(`fail: charge ${args.chargeId} not found`);
  if (charge.status !== 'requires_payment') return NOTHING_DONE;
  const order = await requireOrder(tx, charge);

  let cancelled: CancelledOrderRows | undefined;
  if ((args.policy ?? policyOfOrder(order)) === 'cancel-order') {
    cancelled = await cancelOrderRowsInTx(tx, {
      orderId: order.id,
      cancelledBy: args.cancelledBy ?? null,
      ...(args.cancelReason !== undefined ? { cancelReason: args.cancelReason } : {}),
      now: args.now,
      notifyEachRow: false,
      log: args.log,
    });
  }
  await chargesRepository.markEngineFailed(tx, {
    id: charge.id,
    blocker: args.blocker ?? null,
    lastError: args.lastError,
    nextSweepAt: charge.stripePaymentIntentId !== null && !args.intentDead ? args.now : null,
  });
  await completeOrderClaim(tx, {
    orderId: order.id,
    status: 402,
    body: paymentFailedEnvelope({
      orderId: order.id,
      attempts: charge.attemptCount,
      blocker: args.blocker,
    }),
    log: args.log,
  });
  if (args.notice !== undefined && (await invoiceStillOwed(tx, order))) {
    await noticePaymentFailed(tx, {
      charge,
      order,
      trigger: args.notice,
      now: args.now,
      log: args.log,
    });
  }
  return { outcome: 'failed', ...(cancelled !== undefined ? { cancelled } : {}) };
}

/**
 * Why a card stopped, from where the intent rests. `requires_confirmation` means no
 * confirm landed at all, so nothing is known about the card and `chargeBlockerForConfirm`
 * would invent a reason: the blocker stays absent, as the wire allows. The same goes for
 * a `canceled` intent with no `last_payment_error`, which is the sweeper's own cancel when
 * its webhook arrives first, and for `requires_payment_method` with none, which
 * {@link judgeReadBack} reads as a confirm that never landed. Each can be a card nobody
 * asked, and a status never says a card answered: a code does.
 */
export function blockerOfIntent(
  live: StripePaymentIntentResult,
  log: ChargeBlockerLogger,
): ChargeBlocker | undefined {
  const nothingKnown =
    live.status === 'requires_confirmation' ||
    ((live.status === 'canceled' || live.status === 'requires_payment_method') &&
      live.failureCode === undefined);
  return nothingKnown ? undefined : chargeBlockerForConfirm(live, log);
}

/**
 * A withdraw found the capture had won and is refunding it (`routes/enrollments.ts`):
 * store the 201 a lost race stores, so the request key answers the truth, and leave
 * the row claiming nothing. The caller already moved the charge to `succeeded` and read
 * the void, so `invoice_status` here is the invoice as this transaction left it.
 */
export async function completeClaimOfWithdrawnCharge(
  tx: Tx,
  args: { chargeId: string; log: EngineLog },
): Promise<void> {
  const charge = await lockCharge(tx, args.chargeId);
  if (charge === undefined) throw new Error(`withdraw: charge ${args.chargeId} not found`);
  const order = await requireOrder(tx, charge);
  if (order.invoiceId === null || charge.stripePaymentIntentId === null) {
    throw new Error(`withdraw: order ${order.id} has no invoice or no intent to answer for`);
  }
  const invoice = await invoicesRepository.findById(tx, order.invoiceId);
  if (invoice === undefined) {
    throw new Error(`order ${order.id} names invoice ${order.invoiceId}, which does not exist`);
  }
  await chargesRepository.clearEngineClaims(tx, { id: charge.id });
  const body: InvoicePayWire = {
    charge_id: charge.id,
    charge_status: 'succeeded',
    stripe_payment_intent_id: charge.stripePaymentIntentId,
    client_secret: null,
    invoice_status: invoice.status,
    charge_refunded: true,
  };
  await completeOrderClaim(tx, { orderId: order.id, status: 201, body, log: args.log });
}

// ── the request's path ───────────────────────────────────────────────────────

/** What a caller's `inTx1` hands the charge row: the frozen money and its anchors. */
export interface ChargeTerms {
  amountCents: number;
  purpose: ChargePurpose;
  bookingId: string | null;
  cohortId: string | null;
  dogId: string | null;
}

export interface ConfirmChargeArgs {
  /** `app.actor` for every write here. */
  actor: string;
  ownerId: string;
  claim: IdempotencyClaim;
  /** The invoice an invoice payment pays; written to `orders.invoice_id`. */
  invoiceId?: string;
  /** The card the owner chose: ours, then what Stripe calls the two parties. */
  card: { paymentMethodId: string; stripePaymentMethodId: string; stripeCustomerId: string };
  /**
   * The caller's work inside tx1: its locks, its guards, and what the charge is for.
   * Throwing here rolls tx1 back, so a refusal leaves no order and no claim.
   */
  inTx1: (tx: Tx, order: OrderRow) => Promise<ChargeTerms>;
  stripe: StripeClient;
  log: EngineLog;
  /** A test's clock. Production passes nothing: a lease is judged on Postgres's `now()`. */
  now?: () => Date;
}

export type ConfirmChargeResult =
  /** The final answer, stored on the claim: a 201, or the committed 402. */
  | { kind: 'answered'; status: number; body: InvoicePayWire | ApiErrorEnvelope }
  /** Stripe still says `processing`: the claim stays open and the hold stands. */
  | { kind: 'processing'; chargeId: string; intent: StripePaymentIntentResult }
  /** No answer exists yet: a same-key re-send gets one when the order has settled. */
  | { kind: 'open' };

interface Run {
  args: ConfirmChargeArgs;
  budget: EngineBudget;
  chargeId: string;
  orderId: string;
  amountCents: number;
  /** When she tapped, on the clock this run's notices are stamped with. */
  tappedAt: Date;
}

type Began =
  | { kind: 'replay'; status: number; body: InvoicePayWire | ApiErrorEnvelope }
  | { kind: 'begun'; orderId: string; chargeId: string; amountCents: number };

/** tx1 (design §2.7:3832-3845). The committed rows are the hold. */
async function beginOrder(args: ConfirmChargeArgs, budget: EngineBudget): Promise<Began> {
  return withActor(args.actor, async (tx) => {
    const claimed = await claimIdempotencyKey<InvoicePayWire | ApiErrorEnvelope>(tx, args.claim);
    if (!claimed.won) {
      return { kind: 'replay', status: claimed.stored.status, body: claimed.stored.body };
    }
    const order = await ordersRepository.create(tx, {
      ownerId: args.ownerId,
      invoiceId: args.invoiceId ?? null,
    });
    await attachOrderToClaim(tx, { key: args.claim.key, orderId: order.id });
    const terms = await args.inTx1(tx, order);
    const charge = await chargesRepository.createForOrder(tx, {
      ...terms,
      ownerId: args.ownerId,
      orderId: order.id,
      stripeIdempotencyKey: createKey(order.id),
      stripeCustomerId: args.card.stripeCustomerId,
      stripePaymentMethodId: args.card.stripePaymentMethodId,
      paymentMethodId: args.card.paymentMethodId,
      at: args.now?.(),
      leaseMs: budget.leaseMs,
    });
    return {
      kind: 'begun',
      orderId: order.id,
      chargeId: charge.id,
      amountCents: terms.amountCents,
    };
  });
}

/** The conditional renewal before every Stripe call. `false`: the sweeper owns it. */
async function renewLease(run: Run, countAttempt: boolean): Promise<boolean> {
  return chargesRepository.renewLease(db, {
    id: run.chargeId,
    at: run.args.now?.(),
    leaseMs: run.budget.leaseMs,
    countAttempt,
  });
}

function logStopped(run: Run, reason: string, err?: unknown): void {
  run.args.log.warn(
    {
      chargeId: run.chargeId,
      orderId: run.orderId,
      reason,
      ...(err !== undefined ? { err: err instanceof Error ? err.message : String(err) } : {}),
    },
    'order engine stopped short of an answer: the sweeper owns this order past its lease',
  );
}

/** Create under K0, moving no money. `undefined`: stop, no intent id is stored. */
async function createIntent(run: Run): Promise<StripePaymentIntentResult | undefined> {
  const { args, budget } = run;
  for (let send = 1; send <= CREATE_SENDS_MAX; send += 1) {
    if (!(await renewLease(run, false))) {
      logStopped(run, 'lease-lost');
      return undefined;
    }
    try {
      return await args.stripe.createUnconfirmedPaymentIntent(
        {
          customerId: args.card.stripeCustomerId,
          paymentMethodId: args.card.stripePaymentMethodId,
          amountCents: run.amountCents,
          currency: 'usd',
          metadata: { order_id: run.orderId, charge_id: run.chargeId },
        },
        createKey(run.orderId),
        budget.call,
      );
    } catch (err) {
      // A create that outlives its timeout leaves at most an unconfirmed intent,
      // which cannot charge. The re-send is safe under K0; a re-send answered "that
      // key is still in flight" is the same stop, one step later.
      if (isStripeNetworkFailure(err) && send < CREATE_SENDS_MAX) continue;
      logStopped(run, 'create-failed', err);
      return undefined;
    }
  }
  return undefined;
}

type ConfirmStep =
  | { kind: 'final'; live: StripePaymentIntentResult }
  /** Stripe answered, with the one transient code. On the last try it is final. */
  | { kind: 'retry'; live: StripePaymentIntentResult }
  /** No answer, and the read-back says it never landed. On the last try it stops. */
  | { kind: 'unanswered' }
  | { kind: 'stop' };

/** A confirm that answered. Only `processing_error` spends another try (question 55). */
function judgeAnswer(live: StripePaymentIntentResult): ConfirmStep {
  return live.status === 'requires_payment_method' && live.failureCode === TRANSIENT_CARD_CODE
    ? { kind: 'retry', live }
    : { kind: 'final', live };
}

/**
 * A confirm that did not answer, read back by id. An intent still confirmable with no
 * decline on it says the confirm has not landed, which is the network failure that
 * spends another try, and which is **not a state**: that same confirm may still be
 * running at Stripe. Anything else is the answer the lost response carried.
 */
function judgeReadBack(live: StripePaymentIntentResult): ConfirmStep {
  const neverLanded =
    live.status === 'requires_confirmation' ||
    (live.status === 'requires_payment_method' &&
      (live.failureCode === undefined || live.failureCode === TRANSIENT_CARD_CODE));
  return neverLanded ? { kind: 'unanswered' } : { kind: 'final', live };
}

async function confirmOnce(run: Run, intentId: string, attempt: number): Promise<ConfirmStep> {
  const { args, budget } = run;
  try {
    const answer = await args.stripe.confirmPaymentIntent(
      intentId,
      { paymentMethodId: args.card.stripePaymentMethodId },
      confirmKey(run.orderId, attempt),
      budget.call,
    );
    return judgeAnswer(answer);
  } catch (err) {
    // The first request is still in flight: the next sweeper tick reads what it did.
    if (stripeIdempotencyErrorKind(err) === 'concurrent-request') {
      logStopped(run, 'confirm-key-in-flight', err);
      return { kind: 'stop' };
    }
    // Answered by a retrieve on the stored id, never by a second intent.
    if (!(await renewLease(run, false))) {
      logStopped(run, 'lease-lost');
      return { kind: 'stop' };
    }
    let live: StripePaymentIntentResult;
    try {
      live = await args.stripe.retrievePaymentIntent(intentId, budget.call);
    } catch (retrieveErr) {
      logStopped(run, 'retrieve-failed', retrieveErr);
      return { kind: 'stop' };
    }
    if (isStripeNetworkFailure(err)) return judgeReadBack(live);
    // Stripe refused the call outright. Only a status that ends the question can
    // answer it; anything else is a refusal this code does not understand.
    if (live.status === 'succeeded' || live.status === 'processing' || live.status === 'canceled') {
      return { kind: 'final', live };
    }
    logStopped(run, 'confirm-refused', err);
    return { kind: 'stop' };
  }
}

/** Up to `pay.card_attempts_max_count` confirms of one intent. */
async function confirmIntent(
  run: Run,
  intentId: string,
): Promise<StripePaymentIntentResult | undefined> {
  let last: StripePaymentIntentResult | undefined;
  for (let attempt = 1; attempt <= run.budget.attemptsMax; attempt += 1) {
    // `attempt_count` commits with the renewal, before the call.
    if (!(await renewLease(run, true))) {
      logStopped(run, 'lease-lost');
      return undefined;
    }
    const step = await confirmOnce(run, intentId, attempt);
    if (step.kind === 'stop') return undefined;
    if (step.kind === 'final') return step.live;
    if (step.kind === 'retry') {
      last = step.live;
    } else if (attempt === run.budget.attemptsMax) {
      // Nothing is known, and the last confirm may yet land. A "failed" here would be
      // a guess, so the charge stays open: the webhook settles it, or the sweeper
      // cancels it past the lease, and only then does the order end.
      logStopped(run, 'last-confirm-unanswered');
      return undefined;
    }
  }
  return last;
}

/** Whoever finished the order wrote the answer on the claim. Read it. */
async function storedAnswer(claim: IdempotencyClaim): Promise<ConfirmChargeResult> {
  const stored = await readCompletedClaim<InvoicePayWire | ApiErrorEnvelope>(claim.key);
  return stored === undefined
    ? { kind: 'open' }
    : { kind: 'answered', status: stored.status, body: stored.body };
}

/**
 * Charge the card for one order. Stripe is never called inside a transaction (R5). See
 * the file header for the protocol. `onFinalFailure` is the caller's policy for a
 * decline; whoever else finishes the order reads the same policy off the order.
 */
export async function confirmCharge(
  args: ConfirmChargeArgs,
  onFinalFailure: FinalFailurePolicy,
): Promise<ConfirmChargeResult> {
  const tappedAt = args.now?.() ?? new Date();
  const budget = await readEngineBudget();
  const began = await beginOrder(args, budget);
  if (began.kind === 'replay') {
    return { kind: 'answered', status: began.status, body: began.body };
  }
  const run: Run = {
    args,
    budget,
    chargeId: began.chargeId,
    orderId: began.orderId,
    amountCents: began.amountCents,
    tappedAt,
  };

  const created = await createIntent(run);
  if (created === undefined) return storedAnswer(args.claim);
  const stored = await chargesRepository.storeIntentId(db, {
    id: run.chargeId,
    intentId: created.id,
    at: args.now?.(),
  });
  if (!stored) {
    logStopped(run, 'lease-lost');
    return storedAnswer(args.claim);
  }

  const live = await confirmIntent(run, created.id);
  if (live === undefined) return storedAnswer(args.claim);

  switch (live.status) {
    case 'succeeded': {
      const act = await withActor(args.actor, (tx) =>
        settleChargeInTx(tx, {
          chargeId: run.chargeId,
          live,
          receiptTrigger: 'order-confirm',
          log: args.log,
          now: args.now?.() ?? new Date(),
        }),
      );
      await finishEngineAct(act, {
        stripe: args.stripe,
        log: args.log,
        context: { chargeId: run.chargeId, orderId: run.orderId, settlePath: 'order-engine' },
      });
      return storedAnswer(args.claim);
    }
    case 'processing':
    case 'requires_capture': {
      // Reported, for the unknown-status line this derivation carries.
      chargeBlockerForConfirm(live, args.log);
      return { kind: 'processing', chargeId: run.chargeId, intent: live };
    }
    case 'canceled':
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method': {
      const blocker = blockerOfIntent(live, args.log);
      const now = args.now?.() ?? new Date();
      const canceled = live.status === 'canceled';
      // A decline inside the hold is the 402 she is looking at. Past it her phone has
      // stopped waiting, so nobody's screen holds this answer and a push is the only way
      // she hears (the same reason the sweeper's arms send one). The phone's clock is the
      // seed, not the setting, so this one is too: told once, within one re-send interval
      // (`PAY_HOLD_SEED_MS`), whatever staff set.
      const phoneStoppedWaiting = now.getTime() - run.tappedAt.getTime() > PAY_HOLD_SEED_MS;
      await withActor(args.actor, (tx) =>
        failChargeInTx(tx, {
          chargeId: run.chargeId,
          policy: onFinalFailure,
          blocker,
          lastError: live.failureCode ?? null,
          ...(canceled || phoneStoppedWaiting ? { notice: 'charge-failed' as const } : {}),
          ...(canceled ? { intentDead: true as const } : {}),
          log: args.log,
          now,
        }),
      );
      return storedAnswer(args.claim);
    }
  }
}
