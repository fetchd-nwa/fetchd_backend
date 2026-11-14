import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import type { AnchorResolutionLog, PendingDuplicateRefund } from '../lib/settleInvoiceCharge.js';
import { materializePaymentMethod } from '../lib/materializePaymentMethod.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { stripeCustomersRepository } from '../db/repositories/stripeCustomersRepository.js';
import { withActor } from '../db/tx.js';
import { assertNever } from '../lib/assertNever.js';
import {
  blockerOfIntent,
  creditsOwnerOf,
  failChargeInTx,
  OrderSettleUnreachableError,
  readEngineBudget,
  settleChargeInTx,
  type EngineLog,
} from '../lib/confirmCharge.js';
import {
  stripeIntentStatusToChargeStatus,
  type StripeClient,
  type StripeRefundSnapshot,
  type StripeWebhookEvent,
} from '../lib/stripe.js';
import { lockCharge } from '../db/locks.js';
import { applyLiveRefund, type LiveRefundResult } from '../lib/refundApply.js';
import type { EngineChargeRow } from '../db/repositories/chargesRepository.js';

/**
 * The actor string written into `app.actor` for every webhook-driven DB
 * mutation. Mirrors the Day-2 `system:auth-webhook` precedent — `withActor`
 * accepts arbitrary strings precisely so non-user principals (Supabase
 * auth webhook, Stripe webhook, future schedulers) can attribute writes
 * without an `owners` / `staff` row.
 */
export const WEBHOOK_ACTOR = 'system:stripe-webhook';

/**
 * The logger the handlers need. `warn` is the §A3.19 F2 anchor-fallback
 * tripwire; `error` is the money page, for anything that moves money unattended
 * (the Q-B posture, §A3.18.4 family). `FastifyBaseLogger` satisfies this
 * structurally.
 */
export interface WebhookHandlerLog extends AnchorResolutionLog {
  error(obj: Record<string, unknown>, msg?: string): void;
  /** The order engine's one-line notes (`completeOrderClaim`). */
  info?(obj: Record<string, unknown>, msg?: string): void;
}

export interface WebhookHandlerOpts {
  stripe: StripeClient;
  /** Where the handlers' money alarms go. Required, so none of them can be silent. */
  log: WebhookHandlerLog;
}

export interface WebhookHandlerResult {
  outcome:
    | 'flipped-charge-succeeded'
    | 'flipped-charge-failed'
    | 'charge-already-terminal'
    // 2026-08-24 (`designs/money-residue.md` §4.4): a refund that exists at
    // Stripe and nowhere here — a staff dashboard refund — now RECORDED instead
    // of retried into the ground. Closes the cumulative cap automatically.
    | 'adopted-out-of-band-refund'
    // The order engine (P15): a charge with `order_id` set.
    | 'order-settled'
    | 'order-lost-race'
    | 'order-late-refund'
    | 'order-failed'
    | 'order-advisory'
    | 'wrote-payment-method'
    | 'payment-method-already-present'
    | 'flipped-refund-succeeded'
    | 'flipped-refund-failed'
    | 'orphan-event'
    | 'noop';
  /** Optional human-readable note for the log line. */
  note?: string;
  /**
   * Set when an order's settle LOST the `markPaid` race — the owner had already
   * paid this invoice another way, so this PI double-bills and its refund row was
   * written 'pending' inside the handler's tx. The
   * RECEIVER fires the Stripe refund post-commit (no Stripe call inside a tx,
   * R5). Reported up rather than fired inline for the same reason `creditsOwnerId`
   * is: handlers stay pure DB.
   */
  pendingStripeRefund?: PendingDuplicateRefund;
  /**
   * Set when this event moved an owner's credit balance (a settle's grant). The
   * receiver wipes her `credits:{ownerId}:*` display cache post-commit — the webhook doesn't run
   * through `withMutation`, so invalidation is reported up rather than fired
   * inline (keeps handlers pure DB).
   */
  creditsOwnerId?: string;
}

/**
 * Thrown by a handler when it can't yet process an event whose backing DB
 * row should exist imminently (a delivery race) — e.g. a `charge.refund.
 * updated` that beats the cancel route's `refunds` insert+commit. The
 * receiver catches it, releases the `stripe_events` claim, and re-throws →
 * 500 → Stripe redelivers. Distinct from a genuine `orphan-event` (which is
 * marked processed and dropped) precisely because we WANT the retry. The refund
 * arms throw it for a refund naming one of our rows on a PaymentIntent no charge
 * records (P22 fix 1): an inconsistency, which pages on every delivery until a
 * person reconciles it.
 */
export class WebhookRetryError extends Error {}

/**
 * Dispatch table: one handler per narrow event-type arm. Each handler
 * runs in its own `withActor` tx so the audit_log captures the change
 * under `system:stripe-webhook`. The `'unhandled'` arm logs + 200s so a
 * future Stripe event type doesn't break the receiver — we simply
 * record-and-skip until a handler is added.
 *
 * Handlers are designed to be **idempotent at the row level**: a re-run
 * with the same event data is a safe no-op. Combined with the
 * `stripe_events` dedupe at the receiver, every webhook delivery
 * collapses to "ensure DB matches the terminal Stripe state" — exactly
 * the contract Stripe documents.
 */
export async function dispatchStripeEvent(
  event: StripeWebhookEvent,
  opts: WebhookHandlerOpts,
): Promise<WebhookHandlerResult> {
  switch (event.type) {
    case 'payment_intent.succeeded':
      return (await handleEngineCharge(event, opts)) ?? handlePaymentIntentSucceeded(event, opts);
    case 'payment_intent.payment_failed':
      return (await handleEngineCharge(event, opts)) ?? handlePaymentIntentFailed(event);
    case 'payment_intent.canceled':
      return (
        (await handleEngineCharge(event, opts)) ?? {
          outcome: 'noop',
          note: `payment_intent.canceled on ${event.paymentIntentId}, which no order owns`,
        }
      );
    case 'setup_intent.succeeded':
      return handleSetupIntentSucceeded(event, opts);
    case 'charge.refund.updated':
    case 'refund.updated':
    case 'refund.failed':
      return handleRefundObjectEvent(event, opts);
    case 'charge.refunded':
      return handleChargeRefunded(event, opts);
    case 'unhandled':
      return { outcome: 'noop', note: `event type ${event.rawType} has no handler wired` };
    default:
      return assertNever(event);
  }
}

/**
 * Re-run an event whose claim is unfinished: its first delivery died, or is still
 * running, and `processed_at IS NULL` cannot tell which. So only an arm safe against a
 * first delivery still alive runs here, and each of those is under a lock and a guard:
 * the engine's arms (charge lock, status guard, the refund cap) and the four refund events
 * (P22: retrieve with no transaction open, then the one apply function under the charge
 * lock, a no-op at the status the row already holds; `stripe_refund_id` UNIQUE behind an
 * adoption, so a racing first delivery gets 23505, a 500 and a redelivery).
 * `undefined` keeps the receiver's 200 `duplicate`: the older arms read then write with
 * no lock, so a slow first delivery could grant twice
 * (`designs/p15-engine-recovery.md`, decision 1).
 */
export async function redispatchUnfinishedEvent(
  event: StripeWebhookEvent,
  opts: WebhookHandlerOpts,
): Promise<WebhookHandlerResult | undefined> {
  switch (event.type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled':
      return handleEngineCharge(event, opts);
    case 'charge.refund.updated':
    case 'refund.updated':
    case 'refund.failed':
      return handleRefundObjectEvent(event, opts);
    case 'charge.refunded':
      return handleChargeRefunded(event, opts);
    case 'setup_intent.succeeded':
    case 'unhandled':
      return undefined;
    default:
      return assertNever(event);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The order engine's charges (P15, design §2.7:3905-3938)
//
// A charge is the engine's when `charges.order_id` is set (DECISIONS 142(f)); today's
// arms below keep every other charge. This arm retrieves the live intent with NO
// transaction open, then takes the charge lock and acts on the retrieved status under
// the state guard (R5). That is safe because it acts only on `succeeded` and
// `canceled`, both terminal, and `payment_failed` is advisory.
// ─────────────────────────────────────────────────────────────────────────

type IntentEvent = Extract<
  StripeWebhookEvent,
  {
    type: 'payment_intent.succeeded' | 'payment_intent.payment_failed' | 'payment_intent.canceled';
  }
>;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The engine charge this event is about, or `undefined` for one today's arm keeps. By
 * the intent id first. A charge with no stored id is found by the `{order_id, charge_id}`
 * the create stamped, and both must agree: metadata is a claim, not a key.
 */
async function findEngineCharge(event: IntentEvent): Promise<EngineChargeRow | undefined> {
  const byIntent = await chargesRepository.findEngineByPaymentIntentId(db, event.paymentIntentId);
  if (byIntent !== undefined) return byIntent.orderId !== null ? byIntent : undefined;

  const chargeId = metadataString(event.metadata, 'charge_id');
  const orderId = metadataString(event.metadata, 'order_id');
  if (chargeId === undefined || orderId === undefined || !UUID_SHAPE.test(chargeId)) {
    return undefined;
  }
  const charge = await chargesRepository.findEngineById(db, chargeId);
  return charge !== undefined && charge.orderId === orderId ? charge : undefined;
}

/**
 * A non-empty string field off PaymentIntent metadata, which arrives across a
 * trust boundary (anything can be in there, including nothing).
 */
function metadataString(metadata: Record<string, string>, key: string): string | undefined {
  const value: unknown = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resultOf(act: Awaited<ReturnType<typeof settleChargeInTx>>): WebhookHandlerResult {
  const outcome: WebhookHandlerResult['outcome'] =
    act.outcome === 'settled'
      ? 'order-settled'
      : act.outcome === 'lost-race'
        ? 'order-lost-race'
        : act.outcome === 'late-refund'
          ? 'order-late-refund'
          : act.outcome === 'failed'
            ? 'order-failed'
            : 'charge-already-terminal';
  const creditsOwnerId = creditsOwnerOf(act);
  return {
    outcome,
    ...(act.pendingStripeRefund !== undefined
      ? { pendingStripeRefund: act.pendingStripeRefund }
      : {}),
    ...(creditsOwnerId !== undefined ? { creditsOwnerId } : {}),
  };
}

async function handleEngineCharge(
  event: IntentEvent,
  opts: WebhookHandlerOpts,
): Promise<WebhookHandlerResult | undefined> {
  const charge = await findEngineCharge(event);
  if (charge === undefined) return undefined;

  // The event arrived before the request committed the intent's id: redelivered, not
  // an orphan. A charge the sweeper already abandoned falls through, and the late
  // success below takes the id from the event.
  if (charge.stripePaymentIntentId === null && charge.status === 'requires_payment') {
    throw new WebhookRetryError(
      `order ${charge.orderId} has no intent id yet and is still requires_payment`,
    );
  }

  const log: EngineLog = {
    info: (obj, msg) => opts.log.info?.(obj, msg),
    warn: (obj, msg) => opts.log.warn(obj, msg ?? ''),
    error: (obj, msg) => opts.log.error(obj, msg),
  };
  const budget = await readEngineBudget();
  const live = await opts.stripe.retrievePaymentIntent(
    charge.stripePaymentIntentId ?? event.paymentIntentId,
    budget.call,
  );
  const now = new Date();

  switch (live.status) {
    case 'succeeded':
      try {
        return resultOf(
          await withActor(WEBHOOK_ACTOR, (tx) =>
            settleChargeInTx(tx, { chargeId: charge.id, live, receiptTrigger: 'settle', log, now }),
          ),
        );
      } catch (err) {
        // The alarm has been raised. Nothing committed, so Stripe's redelivery
        // asks again, and a person can reach the order past the hold.
        if (err instanceof OrderSettleUnreachableError) throw new WebhookRetryError(err.message);
        throw err;
      }
    case 'canceled':
      return resultOf(
        await withActor(WEBHOOK_ACTOR, (tx) =>
          failChargeInTx(tx, {
            chargeId: charge.id,
            blocker: blockerOfIntent(live, log),
            lastError: live.failureCode ?? null,
            notice: 'charge-failed',
            intentDead: true,
            log,
            now,
          }),
        ),
      );
    case 'processing':
    case 'requires_action':
    case 'requires_capture':
    case 'requires_confirmation':
    case 'requires_payment_method':
      break;
  }

  // `payment_failed` is advisory (question 38): Stripe sends one per failed attempt
  // and does not order events, so it records what Stripe said and decides nothing.
  if (event.type === 'payment_intent.payment_failed' && live.failureCode !== undefined) {
    const lastError = live.failureCode;
    await withActor(WEBHOOK_ACTOR, async (tx) => {
      const locked = await lockCharge(tx, charge.id);
      if (locked?.status === 'requires_payment') {
        await chargesRepository.writeLastStripeError(tx, { id: charge.id, lastError });
      }
    });
    return { outcome: 'order-advisory' };
  }
  return { outcome: 'noop', note: `order charge ${charge.id} is still ${live.status}` };
}

// ─────────────────────────────────────────────────────────────────────────
// payment_intent.succeeded, on a charge the engine does not own
//
// Find the `charges` row by stripe_payment_intent_id and flip it to `succeeded`. Every
// pack and top-up is the engine's now, so the arm that granted from metadata is gone:
// metadata is `{order_id, charge_id}`, and what was bought is read off the charge row.
// ─────────────────────────────────────────────────────────────────────────

const OFF_ENGINE_PACK_ALARM =
  'a package charge the order engine does not own succeeded: nothing here can say what it bought, so no credits were granted and a person must reconcile it';

async function handlePaymentIntentSucceeded(
  event: StripeWebhookEvent & { type: 'payment_intent.succeeded' },
  opts: WebhookHandlerOpts,
): Promise<WebhookHandlerResult> {
  return withActor(WEBHOOK_ACTOR, async (tx) => {
    const charge = await chargesRepository.findByStripePaymentIntentId(tx, event.paymentIntentId);
    if (charge === undefined) {
      // No charges row for a SUCCEEDED PaymentIntent: Stripe captured money and nothing
      // here recorded it. The engine writes its charge before Stripe, so this is no order
      // of ours. A PI naming an invoice is here too: no path stamps `invoice_id`
      // (DECISIONS 167(b)), so that metadata is not ours to believe. The money is still
      // taken, so a person hears (DECISIONS 169(b)): level 50 pages.
      opts.log.error(
        {
          stripeEventId: event.id,
          paymentIntentId: event.paymentIntentId,
          amountCents: event.amountCents,
        },
        'ORPHAN PAYMENT — Stripe took this money and no charge row recorded it when the event landed: look the intent up in charges and in Stripe before refunding or recording anything',
      );
      return {
        outcome: 'orphan-event',
        note: `no charges row for PI ${event.paymentIntentId}`,
      };
    }

    if (charge.status === 'succeeded' || charge.status === 'refunded') {
      return { outcome: 'charge-already-terminal' };
    }

    await chargesRepository.markStatus(tx, { id: charge.id, status: 'succeeded' });

    if (charge.purpose === 'package') {
      opts.log.error({ chargeId: charge.id, stripeEventId: event.id }, OFF_ENGINE_PACK_ALARM);
    }

    return { outcome: 'flipped-charge-succeeded' };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// payment_intent.payment_failed, on a charge the engine does not own
//
// Find the charge by PI id and flip it to 'failed'. No ledger row: nothing is granted
// before the money, so there is nothing to reverse (design §2.4:2925-2927).
// ─────────────────────────────────────────────────────────────────────────

async function handlePaymentIntentFailed(
  event: StripeWebhookEvent & { type: 'payment_intent.payment_failed' },
): Promise<WebhookHandlerResult> {
  return withActor(WEBHOOK_ACTOR, async (tx) => {
    const charge = await chargesRepository.findByStripePaymentIntentId(tx, event.paymentIntentId);
    if (charge === undefined) {
      return {
        outcome: 'orphan-event',
        note: `no charges row for PI ${event.paymentIntentId}`,
      };
    }

    if (charge.status === 'failed') {
      return { outcome: 'charge-already-terminal' };
    }
    if (charge.status === 'succeeded' || charge.status === 'refunded') {
      // A succeeded charge later receiving payment_failed is a Stripe-
      // side anomaly (out-of-order delivery). Log + skip rather than
      // flip an already-paid charge to failed.
      return {
        outcome: 'charge-already-terminal',
        note: `charge ${charge.id} already at ${charge.status}; ignoring stale failure event`,
      };
    }

    await chargesRepository.markStatus(tx, { id: charge.id, status: 'failed' });
    return { outcome: 'flipped-charge-failed' };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// setup_intent.succeeded
//
// The canonical `payment_methods` row writer. Day-14 returns a SetupIntent
// client_secret only; FE confirms client-side via Stripe Elements; the
// SetupIntent flips to succeeded with a payment_method attached; Stripe
// fires this event; we materialize the row.
//
// First-card default: if the owner has no other live default, this row
// becomes default. Idempotent: a duplicate event finds the row already
// written (by stripe_payment_method_id) and returns no-op.
// ─────────────────────────────────────────────────────────────────────────

async function handleSetupIntentSucceeded(
  event: StripeWebhookEvent & { type: 'setup_intent.succeeded' },
  opts: WebhookHandlerOpts,
): Promise<WebhookHandlerResult> {
  // The Stripe customer → owner lookup is pool-side so a missing mapping
  // surfaces early without opening a tx. Orphan setup_intents
  // (customer_id we don't know) shouldn't happen in our flow — the
  // SetupIntent is created against an owner-mapped customer — but a
  // misconfigured Stripe dashboard could fire one. Log + skip.
  const customerMap = await stripeCustomersRepository.findByStripeCustomerId(db, event.customerId);
  if (customerMap === undefined) {
    return {
      outcome: 'orphan-event',
      note: `setup_intent.succeeded: no stripe_customers row for ${event.customerId}`,
    };
  }

  // Pre-call Stripe outside the tx (network call) — the seam is
  // idempotent (`retrieve` is a GET in Stripe's API).
  const snapshot = await opts.stripe.retrievePaymentMethod(event.paymentMethodId);

  return withActor(WEBHOOK_ACTOR, async (tx) => {
    // Shared with the synchronous POST /payment-methods/confirm route — dedupe
    // by stripe_payment_method_id + first-card-default rule live in one place.
    const result = await materializePaymentMethod(tx, { ownerId: customerMap.ownerId, snapshot });
    if (result.outcome === 'already-present') {
      return { outcome: 'payment-method-already-present' };
    }
    return {
      outcome: 'wrote-payment-method',
      note: result.isDefault ? 'first card; isDefault=true' : 'isDefault=false',
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// The refund events (P22, design §2.7:4215-4228)
//
// `charge.refund.updated`, `refund.updated` and `refund.failed` carry the refund; each
// retrieves it with NO transaction open and hands its LIVE status to the one apply
// function, under the charge lock (`refundApply.ts`). `charge.refunded` carries the
// charge, which lists no refunds, so it lists the PaymentIntent's refunds and applies each.
// Nothing is ever marked from an event's own status: the recording shows `charge.refunded`
// firing while its refund is still `pending`, and a `succeeded` update created four
// seconds before the `refund.failed` that overturns it.
// ─────────────────────────────────────────────────────────────────────────

type RefundObjectEvent = Extract<
  StripeWebhookEvent,
  { type: 'charge.refund.updated' | 'refund.updated' | 'refund.failed' }
>;

/** Fable M6's line: money has gone back on a row that still offers *Retry to card*. */
export const REFUND_SUCCEEDED_ON_FAILED_ROW_ALARM =
  'Stripe reports this refund succeeded and the app holds it failed; do not retry it.';

/**
 * The charge a refund belongs to, read with no transaction open (a charge id never
 * changes): our row's, when its `re_` is stored; else the charge of its PaymentIntent.
 */
async function chargeIdOfRefund(
  live: StripeRefundSnapshot,
  eventPaymentIntentId: string | null,
): Promise<string | undefined> {
  const ours = await refundsRepository.findByStripeRefundId(db, live.id);
  if (ours !== undefined) return ours.chargeId;
  const pi = live.paymentIntentId ?? eventPaymentIntentId;
  if (pi === null) return undefined;
  return (await chargesRepository.findByStripePaymentIntentId(db, pi))?.id;
}

/**
 * Fable M6: the machine refused a live `succeeded` on a row held `failed`. Before saying
 * so, read once more with no transaction open: a delivery that retrieved `succeeded` and
 * then waited on the charge lock while `refund.failed` applied holds a stale read (the
 * recording's (b): the `succeeded` updates were created four seconds before the failure).
 * Only a second `succeeded` is said, at level 50, through the receiver's own logger.
 */
async function sayHeldFailedReadsSucceeded(
  applied: readonly LiveRefundResult[],
  opts: WebhookHandlerOpts,
): Promise<void> {
  for (const r of applied) {
    if (r.outcome !== 'held-failed-reads-succeeded') continue;
    const again = await opts.stripe.retrieveRefund(r.stripeRefundId);
    if (again.status !== 'succeeded') continue;
    opts.log.error(
      {
        moneyEvent: 'refund-succeeded-on-failed-row',
        refundId: r.refundId,
        stripeRefundId: r.stripeRefundId,
        chargeId: r.chargeId,
      },
      REFUND_SUCCEEDED_ON_FAILED_ROW_ALARM,
    );
  }
}

function outcomeOfApply(applied: LiveRefundResult): WebhookHandlerResult {
  const note = `refund ${applied.stripeRefundId} → row ${applied.refundId}: ${applied.outcome}`;
  switch (applied.outcome) {
    case 'applied-succeeded':
      return { outcome: 'flipped-refund-succeeded', note };
    case 'applied-failed':
    case 'reopened':
      return { outcome: 'flipped-refund-failed', note };
    case 'adopted':
      return { outcome: 'adopted-out-of-band-refund', note };
    case 'stored-id':
    case 'held-failed-reads-succeeded':
    case 'unchanged':
      return { outcome: 'noop', note };
  }
}

/**
 * Opus r1 L3: a refund event about a payment no charge here records, whose refund names
 * none of our rows. At warn, not 50: no money of ours moved, and it is no inconsistency.
 */
export const REFUND_ON_PAYMENT_NOT_RECORDED_WARNING =
  "REFUND ON A PAYMENT NOT RECORDED HERE — no charge names this PaymentIntent and no refund in stripeRefundIds names a refund here by metadata.refund_id, so no charge or refund row was written and the event is answered 200, not retried. It can be a refund on a payment taken in Stripe itself (a payment link or invoice), by another environment on the same Stripe account, or by a B&T confirm-payment whose charge row was never written (its unwind refund). If this PaymentIntent should be one of this app's charges, look it up in charges and in Stripe before recording anything";

/**
 * The row of ours a refund names by `metadata.refund_id`, on any charge, or `undefined`.
 * Metadata crosses a trust boundary, so a value that is not a uuid names nothing.
 */
async function rowNamedByRefund(live: StripeRefundSnapshot): Promise<string | undefined> {
  const id = live.metadataRefundId;
  if (id === undefined || !UUID_SHAPE.test(id)) return undefined;
  return (await refundsRepository.findById(db, id))?.id;
}

/**
 * Opus r1 L3, the orphan-payment path's shape (`handlePaymentIntentSucceeded`): an event
 * whose PaymentIntent no charge here records, and whose refunds name none of our rows, is
 * not ours. Answered 200 so Stripe stops sending it, with nothing written and one warn line.
 * A redelivery would not find it ours: the engine stores the PaymentIntent id on its charge
 * between its unconfirmed create and its confirm (`confirmCharge.ts`), and a class hold is
 * captured after its row commits, so money moves only on a PaymentIntent a charge already
 * records; every refund the app creates names its row (`refundCreateParams`). The one road
 * that captures first is B&T confirm-payment (`routes/requestConfirmPayment.ts`), whose row
 * commits in the transaction after the capture, and whose unwind refund, when that
 * transaction fails, lands here by design: the sentence names it.
 */
function refundOnPaymentNotOurs(
  event: StripeWebhookEvent,
  paymentIntentId: string | null,
  stripeRefundIds: readonly string[],
  opts: WebhookHandlerOpts,
): WebhookHandlerResult {
  opts.log.warn(
    { stripeEventId: event.id, stripeEventType: event.type, paymentIntentId, stripeRefundIds },
    REFUND_ON_PAYMENT_NOT_RECORDED_WARNING,
  );
  return {
    outcome: 'orphan-event',
    note: `${event.type}: no charge for PaymentIntent ${paymentIntentId ?? '(none)'} and no refund naming one of ours`,
  };
}

async function handleRefundObjectEvent(
  event: RefundObjectEvent,
  opts: WebhookHandlerOpts,
): Promise<WebhookHandlerResult> {
  const live = await opts.stripe.retrieveRefund(event.refundId);
  const chargeId = await chargeIdOfRefund(live, event.paymentIntentId);
  if (chargeId === undefined) {
    const paymentIntentId = live.paymentIntentId ?? event.paymentIntentId;
    const ours = await rowNamedByRefund(live);
    if (ours === undefined) return refundOnPaymentNotOurs(event, paymentIntentId, [live.id], opts);
    // A refund whose metadata names one of our rows, on a PaymentIntent no charge records:
    // an inconsistency, not a stranger, though the metadata may be forged (Opus r2 N2), so
    // the sentence says what the metadata names, never that the refund is ours. Release the
    // claim (500, the route's level-50 line) so Stripe redelivers it while a person looks.
    const pi = paymentIntentId ?? '(none)';
    throw new WebhookRetryError(
      `${event.type} for ${live.id} names refund ${ours} here by metadata.refund_id, but no charge here records PaymentIntent ${pi}: a refund whose metadata names a row here, on a payment no charge here records, is an inconsistency, so the event is refused and Stripe will redeliver it. Look ${pi} up in Stripe and in charges, and compare it with refund ${ours}'s own charge, before recording anything`,
    );
  }
  const applied = await withActor(WEBHOOK_ACTOR, (tx) =>
    applyLiveRefund(tx, { chargeId, live, log: opts.log }),
  );
  await sayHeldFailedReadsSucceeded([applied], opts);
  return outcomeOfApply(applied);
}

async function handleChargeRefunded(
  event: Extract<StripeWebhookEvent, { type: 'charge.refunded' }>,
  opts: WebhookHandlerOpts,
): Promise<WebhookHandlerResult> {
  if (event.paymentIntentId === null) {
    return { outcome: 'noop', note: `charge.refunded on ${event.chargeId}, which names no PaymentIntent` };
  }
  const listed = await opts.stripe.listRefundsForPaymentIntent(event.paymentIntentId);
  const charge = await chargesRepository.findByStripePaymentIntentId(db, event.paymentIntentId);
  if (charge === undefined) {
    const pi = event.paymentIntentId;
    for (const live of listed.refunds) {
      const ours = await rowNamedByRefund(live);
      if (ours === undefined) continue;
      throw new WebhookRetryError(
        `charge.refunded for ${pi}: Stripe lists ${live.id}, which names refund ${ours} here by metadata.refund_id, but no charge here records this PaymentIntent: a refund whose metadata names a row here, on a payment no charge here records, is an inconsistency, so the event is refused and Stripe will redeliver it. Look ${pi} up in Stripe and in charges, and compare it with refund ${ours}'s own charge, before recording anything`,
      );
    }
    if (!listed.complete) {
      // The refunds the list did not reach could name one of ours, so it is not called a
      // stranger.
      throw new WebhookRetryError(
        `charge.refunded for ${pi}: no charge here records this PaymentIntent and Stripe's list of its refunds came back incomplete, so whether one of them names a refund here is unknown; the event is refused and Stripe redelivers it`,
      );
    }
    return refundOnPaymentNotOurs(event, pi, listed.refunds.map((r) => r.id), opts);
  }
  const applied = await withActor(WEBHOOK_ACTOR, async (tx) => {
    const each: LiveRefundResult[] = [];
    for (const live of listed.refunds) {
      each.push(await applyLiveRefund(tx, { chargeId: charge.id, live, log: opts.log }));
    }
    return each;
  });
  await sayHeldFailedReadsSucceeded(applied, opts);
  const moved = applied.filter((a) => a.outcome !== 'unchanged');
  return {
    outcome: moved.some((a) => a.outcome === 'adopted') ? 'adopted-out-of-band-refund' : 'noop',
    note: `charge.refunded on ${event.chargeId}: ${listed.refunds.length} refund(s) listed${listed.complete ? '' : ' (incomplete)'}; ${moved.map((a) => `${a.stripeRefundId} ${a.outcome}`).join(', ') || 'nothing moved'}`,
  };
}

/**
 * Re-export so the route module doesn't need to import directly from
 * `lib/stripe.ts` to read the status mapper. Keeps the per-handler
 * file's surface coherent.
 */
export { stripeIntentStatusToChargeStatus };
