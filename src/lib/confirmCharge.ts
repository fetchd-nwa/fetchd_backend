import type {
  ApiErrorEnvelope,
  ChargeBlocker,
  CreditPurchaseWire,
  InvoicePayWire,
  PaymentFailedDetails,
  PostBookingsResponse,
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
import { lockCharge, lockPools } from '../db/locks.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import {
  chargesRepository,
  type ChargePurpose,
  type EngineChargeRow,
} from '../db/repositories/chargesRepository.js';
import {
  creditLedgerRepository,
  findReturnLanding,
} from '../db/repositories/creditLedgerRepository.js';
import { creditPackagesRepository } from '../db/repositories/creditPackagesRepository.js';
import { creditsInvalidationPattern } from '../db/repositories/creditsRepository.js';
import { invoicesRepository, repointPaymentMethod } from '../db/repositories/invoicesRepository.js';
import {
  orderCreatedAtIso,
  ordersRepository,
  type OrderRow,
} from '../db/repositories/ordersRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { withActor, type Tx } from '../db/tx.js';
import { invalidatePattern } from './cache.js';
import { addChicagoMonths } from './creditExpiry.js';
import { expiryPaysDate, lotDatesBind } from './creditPicker.js';
import { enqueueBookingReminders } from './enqueueBookingReminders.js';
import { ApiError, toErrorEnvelope } from './errors.js';
import { creditReceiptBody, formatDollars } from './invoiceReceiptCopy.js';
import { noticeInSavepoint } from './noticeInSavepoint.js';
import {
  cancelOrderRowsInTx,
  creditLines,
  findDebitsOfRows,
  toCreditLanding,
  type CancelledOrderRows,
  type CreditLanding,
} from './orderRows.js';
import { firePendingRefundPostCommit, type PendingStripeRefund } from './pendingRefund.js';
import { pgTimestampToDate } from './pgTimestamp.js';
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
import { wireManyBookings } from './wireManyBookings.js';

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
 * **Three callers.** `POST /invoices/:id/pay` settles an invoice it holds.
 * `POST /credit-packages/:key/purchase` and a `POST /bookings` with a `top_up` buy credits:
 * their order names no invoice, the charge carries the purchase frozen in tx1, and the
 * settle reads what was bought off that charge and never off Stripe's metadata, which is
 * `{order_id, charge_id}` and nothing that could grant. A caller's work is passed in
 * through `inTx1`. A charge with no invoice and no purchase has no writer, so
 * {@link settleChargeInTx} refuses it, loudly, rather than pretend.
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
  /** The owner whose credits moved: her display cache is wiped post-commit. */
  creditsOwnerId?: string;
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
  const ownerId = creditsOwnerOf(act);
  if (ownerId === undefined) return;
  // Best effort: the money is committed, and the TTL heals a stale balance.
  await invalidatePattern(creditsInvalidationPattern(ownerId)).catch((err: unknown) => {
    args.log.warn({ ...args.context, err: String(err) }, 'credits cache wipe failed');
  });
}

/** The owner whose credits this act moved, by a grant or by returning debits. */
export function creditsOwnerOf(act: EngineAct): string | undefined {
  return act.creditsOwnerId ?? act.cancelled?.creditRefundedOwnerId;
}

// ── the settle ───────────────────────────────────────────────────────────────

const AMOUNT_RECEIVED_MISMATCH_ALARM =
  'an order charge settled with amount_received different from the amount asked: a person must reconcile it';
const NO_PURCHASE_SETTLE_ALARM =
  'an engine charge with no invoice and no frozen purchase reached succeeded: nothing says what was bought, so a person must reconcile this money';
const UNPAID_SLOTS_ALARM =
  'a top-up settled with more rows to pay than credits bought: a person must reconcile this order';
const LOT_PAST_ITS_DATE_ALARM =
  'a bought lot was debited for a date past its own expiry: the money and the booking stand, and a person should look at this order';
const LATE_SUCCESS_ALARM =
  'a charge succeeded after its order was cancelled: it grants nothing and is being refunded in full, automatically';
const LATE_SUCCESS_NO_INTENT_ALARM =
  'a charge succeeded after its order was cancelled, and no refund could be minted because the row names no intent: an owner is owed this money, its watch stays open, and a person must refund it';

/** The `refunds.reason` of the automatic refund (follow-up 4, SIGNOFF.md:208-209). */
export const LATE_SUCCESS_REFUND_REASON = 'late-success-refund';

/** Thrown after {@link NO_PURCHASE_SETTLE_ALARM}: nothing commits, and a webhook retries. */
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

/** A settle whose amount differs still commits: the money moved, and a person hears. */
function alarmOnAmountReceived(
  charge: EngineChargeRow,
  order: OrderRow,
  live: StripePaymentIntentResult,
  log: EngineLog,
): void {
  if (live.amountReceivedCents === charge.amountCents) return;
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

interface SettleArgs {
  live: StripePaymentIntentResult;
  receiptTrigger: 'order-confirm' | 'settle';
  log: EngineLog;
  now: Date;
}

/**
 * tx1 refused any row that does not reach (`designs/p18-pack-reach-and-moved-dates.md`), so
 * a bought lot that cannot pay a date it was just debited for is one of the two things that
 * check cannot see: a same-day correction of the row's months, or Stripe's clock behind
 * ours. It costs her nothing, so it refuses nothing, and a person reads it. Compared on the
 * stamp, not `lot_pays_date`: that asks whether the lot is alive now, and a settle can
 * legitimately land after a lot's own date.
 */
async function alarmOnDaysPastTheLot(
  tx: Tx,
  args: {
    chargeId: string;
    orderId: string;
    lot: { id: string; expiresAt: string };
    dates: readonly string[];
    log: EngineLog;
  },
): Promise<void> {
  const { chargeId, orderId, lot, dates, log } = args;
  if (dates.length === 0 || !lotDatesBind(await settingsRepository.credit(tx))) return;
  const expiresAt = pgTimestampToDate(lot.expiresAt);
  const past = dates.filter((date) => !expiryPaysDate(expiresAt, date));
  if (past.length === 0) return;
  log.error(
    { chargeId, orderId, lotId: lot.id, expiresAt: expiresAt.toISOString(), dates: past },
    LOT_PAST_ITS_DATE_ALARM,
  );
}

/**
 * The settle of a pack or a top-up (design §2.4:2984-3002, §2.7:3866-3883): the charge
 * `succeeded`; the order's one invoice written paid; for a top-up the rows, locked after
 * the charge; the pool; one lot of the charge's own frozen purchase; the lot spent on what
 * tx1 left unpaid; the rows `upcoming` and their reminders; one receipt; and the 201 on
 * the claim, so whoever settled it, the request reads the same answer.
 *
 * Everything bought is read off the charge row, because the metadata is
 * `{order_id, charge_id}`. The lot expires the row's months after the PaymentIntent's
 * created instant (§2.4:3003), so a webhook a day late stamps what the route would have.
 * This is the one writer of the grant: the old catch-up parser is gone.
 */
async function settlePurchase(
  tx: Tx,
  charge: EngineChargeRow,
  order: OrderRow,
  args: SettleArgs,
): Promise<EngineAct> {
  const { live, log, now } = args;
  const pack =
    charge.packageId === null || charge.creditsCount === null
      ? undefined
      : await creditPackagesRepository.findById(tx, charge.packageId);
  if (pack === undefined) {
    log.error({ chargeId: charge.id, orderId: order.id }, NO_PURCHASE_SETTLE_ALARM);
    throw new OrderSettleUnreachableError(NO_PURCHASE_SETTLE_ALARM);
  }
  alarmOnAmountReceived(charge, order, live, log);

  await chargesRepository.markEngineSucceeded(tx, { id: charge.id, intentId: live.id });
  await invoicesRepository.writePaidForCharge(tx, { chargeId: charge.id, settledAt: now });

  // Charge → bookings → pool (`db/locks.ts`). A pack has no rows. Every pool this order can
  // touch, in one call: a cancel returns these debits in this same transaction, and taking
  // them later would hold the regular pool while reaching for the alumni one.
  const rows = await bookingsRepository.lockCancellableByOrderId(tx, order.id);
  await lockPools(tx, [
    { ownerId: charge.ownerId, location: pack.location, mode: pack.mode, tier: pack.tier },
    ...(await findDebitsOfRows(
      tx,
      rows.map((row) => row.id),
    )),
  ]);
  const lot = await creditLedgerRepository.grantChargeLot(tx, {
    chargeId: charge.id,
    expiresAt: addChicagoMonths(
      live.createdAt ?? pgTimestampToDate(charge.createdAt),
      pack.expiry_months,
    ),
  });
  if (lot === undefined) {
    throw new Error(`settle: charge ${charge.id} does not read succeeded after its own UPDATE`);
  }

  const unpaid = await creditLedgerRepository.findUnpaidSlots(tx, order.id);
  if (unpaid.length > lot.credits) {
    log.error(
      { chargeId: charge.id, orderId: order.id, unpaid: unpaid.length, credits: lot.credits },
      UNPAID_SLOTS_ALARM,
    );
  }
  const paying = unpaid.slice(0, lot.credits);
  for (const slot of paying) {
    // A booking-time debit: it names no check-in event (M5.10's link).
    await creditLedgerRepository.debitLot(tx, {
      ...lot,
      lotId: lot.id,
      ...slot,
      checkinEventId: null,
    });
  }
  await alarmOnDaysPastTheLot(tx, {
    chargeId: charge.id,
    orderId: order.id,
    lot,
    dates: paying.map((slot) => slot.date),
    log,
  });

  await bookingsRepository.markOrderRowsUpcoming(tx, order.id);
  for (const row of rows) {
    await enqueueBookingReminders(tx, {
      bookingId: row.id,
      ownerId: row.ownerId,
      leadDogId: row.leadDogId,
      category: row.category,
      scheduledAt: pgTimestampToDate(row.scheduledAt),
    });
  }

  const dedupeKey = `receipt:${charge.id}`;
  await noticeInSavepoint(tx, { subject: { chargeId: charge.id }, dedupeKey, log }, async (sp) => {
    await scheduledNotificationsRepository.enqueueIdempotent(sp, {
      ownerId: charge.ownerId,
      type: 'payment-succeeded',
      trigger: args.receiptTrigger,
      dedupeKey,
      scheduledFor: now,
      title: 'Payment received',
      body: creditReceiptBody({
        amountCents: charge.amountCents,
        credits: lot.credits,
        location: lot.location,
        mode: lot.mode,
        expiresAt: pgTimestampToDate(lot.expiresAt),
      }),
      deepLinkPath: deepLinkToPath({ kind: 'credits' }),
      deepLinkKind: 'credits',
    });
  });

  const body: CreditPurchaseWire | PostBookingsResponse =
    rows.length > 0
      ? {
          order: {
            id: order.id,
            owner_id: order.ownerId,
            created_at: orderCreatedAtIso(order),
            charge_status: 'succeeded',
          },
          sessions: await wireManyBookings(await bookingsRepository.findByOrderId(tx, order.id), {
            now,
            viewer: 'owner',
            runner: tx,
          }),
        }
      : {
          charge_id: charge.id,
          charge_status: 'succeeded',
          stripe_payment_intent_id: live.id,
          client_secret: live.clientSecret,
          credits_granted: lot.credits,
        };
  await completeOrderClaim(tx, { orderId: order.id, status: 201, body, log });

  return { outcome: 'settled', creditsOwnerId: charge.ownerId };
}

/**
 * Settle a locked `requires_payment` charge whose intent succeeded. Only this moves a
 * charge to `succeeded`, so only this enqueues the receipt. An order paying an invoice
 * flips it through the same `settleChargeAgainstInvoice` the webhook uses, which keeps
 * PAY-35: a lost race refunds this charge, and the card rebind (PAY-12) fires only on
 * the clean win. Any other order bought credits: {@link settlePurchase}.
 */
async function settleOpenCharge(
  tx: Tx,
  charge: EngineChargeRow,
  order: OrderRow,
  args: SettleArgs,
): Promise<EngineAct> {
  const { live, log, now } = args;
  if (order.invoiceId === null) return settlePurchase(tx, charge, order, args);
  alarmOnAmountReceived(charge, order, live, log);

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
  args: SettleArgs & { chargeId: string },
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

/** Which of the failed-payment notices this is. */
type FailureNotice = 'charge-failed' | 'order-cancelled' | 'cancel-while-processing';

/**
 * The notice's own words, one per trigger (design §2.9:4546), and for a purchase what it
 * is true to say of credits (§2.4:3013-3016, §2.7:4021-4026). A failure that took booking
 * rows down says the booking is gone, because this notice is all she hears of it: those
 * rows write no `booking-cancelled` row, and the last thing she read was "Confirmed!".
 * What came back is said only as it came back (P21, `brief_must_say` 3; P18 185(b)):
 * §2.9's credit line for each landing, the dead-lot line for a credit returned into a dead
 * lot (`cred.returned_credit_expiry_months` 0), and nothing for a row that returned
 * nothing (a `past` row keeps its debit; a top-up that used no credit). It was "Any
 * credits it used are back in your account", false in both of the last cases. Every arm
 * that took rows down carries those lines, `cancel-while-processing` included (P21 fix 1,
 * Opus r1 L6): this notice is all she hears of the credit, since the failure arms write no
 * `booking-cancelled` row. `cancel-while-processing` never says the payment failed, which
 * it may not have: Stripe would not stop it. Its trigger is §2.9's. Its type,
 * `payment-refunded`, is born with M7.09, so until LG7 it rides `payment-failed` with a
 * title that does not say so.
 */
function failureNoticeCopy(
  trigger: FailureNotice,
  charge: Pick<EngineChargeRow, 'amountCents' | 'packageId'>,
  tookDownRows: boolean,
  credits: readonly CreditLanding[],
): { title: string; body: string } {
  const amount = formatDollars(charge.amountCents);
  const back = creditLines(credits)
    .map((line) => ` ${line}.`)
    .join('');
  const bought = charge.packageId !== null;
  const pack = bought && !tookDownRows;
  switch (trigger) {
    case 'cancel-while-processing':
      return pack
        ? {
            title: 'Purchase cancelled',
            body: "We couldn't stop this payment. If it goes through, it will be refunded to your card in full, and no credits will be added.",
          }
        : {
            title: 'Booking cancelled',
            body: `Cancelled. If your bank still takes the ${amount}, we refund it automatically.${back}`,
          };
    case 'order-cancelled':
      if (tookDownRows) {
        return {
          title: 'Booking cancelled',
          body: `Your booking and its ${amount} payment were cancelled, so you weren't charged.${back}`,
        };
      }
      return pack
        ? { title: 'Purchase cancelled', body: "You weren't charged and no credits were added." }
        : {
            title: 'Payment cancelled',
            body: `Your ${amount} payment was cancelled, so you weren't charged.`,
          };
    case 'charge-failed':
      if (tookDownRows) {
        return {
          title: 'Booking cancelled',
          body: `Your ${amount} payment didn't go through, so you weren't charged and your booking is cancelled.${back}`,
        };
      }
      return pack
        ? {
            title: 'Purchase failed',
            body: `Your ${amount} purchase didn't go through, so you weren't charged and no credits were added.`,
          }
        : {
            title: 'Payment failed',
            body: `Your ${amount} payment didn't go through, so you weren't charged.`,
          };
  }
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
    trigger: FailureNotice;
    /** This failure cancelled at least one row, so what she lost is a booking. */
    tookDownRows: boolean;
    /** The returns the failure's cancel wrote: the notice says where each landed. */
    returnIds: readonly string[];
    now: Date;
    log: EngineLog;
  },
): Promise<void> {
  const { charge, order, trigger, tookDownRows, now, log } = args;
  const dedupeKey = `${trigger}:${charge.id}`;
  await noticeInSavepoint(tx, { subject: { chargeId: charge.id }, dedupeKey, log }, async (sp) => {
    // Read inside the savepoint, after the returns were written (§2.9's compose rule).
    const credits: CreditLanding[] = [];
    for (const returnId of args.returnIds) {
      credits.push(toCreditLanding(await findReturnLanding(sp, returnId)));
    }
    await scheduledNotificationsRepository.enqueueIdempotent(sp, {
      ownerId: charge.ownerId,
      type: 'payment-failed',
      trigger,
      dedupeKey,
      scheduledFor: now,
      ...failureNoticeCopy(trigger, charge, tookDownRows, credits),
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
        : charge.packageId !== null && !tookDownRows
          ? { deepLinkPath: deepLinkToPath({ kind: 'credits' }), deepLinkKind: 'credits' as const }
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
    notice?: FailureNotice;
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
      tookDownRows: (cancelled?.bookingIds.length ?? 0) > 0,
      returnIds: cancelled?.returned.map((r) => r.returnId) ?? [],
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
  /** What a pack or a top-up bought, frozen here: every settler reads these. */
  packageId?: string;
  creditsCount?: number;
  /**
   * The card the owner chose: ours, then what Stripe calls the two parties. It comes back
   * from tx1 so a caller can read it after its refusals: a `top_up` that does not fit never
   * touches the card it named.
   */
  card: { paymentMethodId: string; stripePaymentMethodId: string; stripeCustomerId: string };
}

export interface ConfirmChargeArgs {
  /** `app.actor` for every write here. */
  actor: string;
  ownerId: string;
  claim: IdempotencyClaim;
  /** The invoice an invoice payment pays; written to `orders.invoice_id`. */
  invoiceId?: string;
  /**
   * The caller's work inside tx1: its locks, its guards, what the charge is for and the card.
   * Throwing here rolls tx1 back, so a refusal leaves no order and no claim.
   */
  inTx1: (tx: Tx, order: OrderRow) => Promise<ChargeTerms>;
  stripe: StripeClient;
  log: EngineLog;
  /** A test's clock. Production passes nothing: a lease is judged on Postgres's `now()`. */
  now?: () => Date;
}

export type ConfirmChargeResult<T> =
  /** The final answer, stored on the claim: a 201, or the committed 402. */
  | { kind: 'answered'; status: number; body: T | ApiErrorEnvelope }
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
  card: ChargeTerms['card'];
  /** When she tapped, on the clock this run's notices are stamped with. */
  tappedAt: Date;
}

type Began<T> =
  | { kind: 'replay'; status: number; body: T | ApiErrorEnvelope }
  | {
      kind: 'begun';
      orderId: string;
      chargeId: string;
      amountCents: number;
      card: ChargeTerms['card'];
    };

/** tx1 (design §2.7:3832-3845). The committed rows are the hold. */
async function beginOrder<T>(args: ConfirmChargeArgs, budget: EngineBudget): Promise<Began<T>> {
  return withActor(args.actor, async (tx) => {
    const claimed = await claimIdempotencyKey<T | ApiErrorEnvelope>(tx, args.claim);
    if (!claimed.won) {
      return { kind: 'replay', status: claimed.stored.status, body: claimed.stored.body };
    }
    const order = await ordersRepository.create(tx, {
      ownerId: args.ownerId,
      invoiceId: args.invoiceId ?? null,
    });
    await attachOrderToClaim(tx, { key: args.claim.key, orderId: order.id });
    const { card, ...terms } = await args.inTx1(tx, order);
    const charge = await chargesRepository.createForOrder(tx, {
      ...terms,
      ownerId: args.ownerId,
      orderId: order.id,
      stripeIdempotencyKey: createKey(order.id),
      stripeCustomerId: card.stripeCustomerId,
      stripePaymentMethodId: card.stripePaymentMethodId,
      paymentMethodId: card.paymentMethodId,
      at: args.now?.(),
      leaseMs: budget.leaseMs,
    });
    return {
      kind: 'begun',
      orderId: order.id,
      chargeId: charge.id,
      amountCents: terms.amountCents,
      card,
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
          customerId: run.card.stripeCustomerId,
          paymentMethodId: run.card.stripePaymentMethodId,
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
      { paymentMethodId: run.card.stripePaymentMethodId },
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
async function storedAnswer<T>(claim: IdempotencyClaim): Promise<ConfirmChargeResult<T>> {
  const stored = await readCompletedClaim<T | ApiErrorEnvelope>(claim.key);
  return stored === undefined
    ? { kind: 'open' }
    : { kind: 'answered', status: stored.status, body: stored.body };
}

/**
 * Charge the card for one order. Stripe is never called inside a transaction (R5). See
 * the file header for the protocol. `onFinalFailure` is the caller's policy for a
 * decline; whoever else finishes the order reads the same policy off the order.
 */
export async function confirmCharge<T>(
  args: ConfirmChargeArgs,
  onFinalFailure: FinalFailurePolicy,
): Promise<ConfirmChargeResult<T>> {
  const tappedAt = args.now?.() ?? new Date();
  const budget = await readEngineBudget();
  const began = await beginOrder<T>(args, budget);
  if (began.kind === 'replay') {
    return { kind: 'answered', status: began.status, body: began.body };
  }
  const run: Run = {
    args,
    budget,
    chargeId: began.chargeId,
    orderId: began.orderId,
    amountCents: began.amountCents,
    card: began.card,
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
