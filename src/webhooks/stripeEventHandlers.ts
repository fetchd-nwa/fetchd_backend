import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import type { AnchorResolutionLog, PendingDuplicateRefund } from '../lib/settleInvoiceCharge.js';
import { materializePaymentMethod } from '../lib/materializePaymentMethod.js';
import { refundsRepository, type RefundStatus } from '../db/repositories/refundsRepository.js';
import { stripeCustomersRepository } from '../db/repositories/stripeCustomersRepository.js';
import { withActor, type Tx } from '../db/tx.js';
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
  type StripeRefundStatus,
  type StripeWebhookEvent,
} from '../lib/stripe.js';
import { lockCharge } from '../db/locks.js';
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
 * marked processed and dropped) precisely because we WANT the retry.
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
      return handleChargeRefundUpdated(event, opts);
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
 * the engine's arms (charge lock, status guard, the refund cap) and
 * `charge.refund.updated` (charge lock, a re-read, no-op at the target status).
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
      return handleChargeRefundUpdated(event, opts);
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
// charge.refund.updated
//
// Find the refunds row by stripe_refund_id (set by the cancel route's
// post-commit `markStripeId` call). Race fallback: if the webhook beat
// the post-commit id-write, find by (charge_id via PI, amount, status
// = 'pending', stripe_refund_id IS NULL). Lock the CHARGE, re-read the refund
// row under that lock, flip status. On 'succeeded', recompute the charge's
// RETURNED COVERAGE — if it meets the charge amount, flip charges.status to
// 'refunded'.
//
// **CONVERTED to charges → refunds (MR-A1.2(ii), 2026-08-24.)** This handler
// used to write refunds-then-charges, which was the reason
// `markResolvedExternal` could not simply take a charge lock: the two orders
// together are an AB-BA deadlock pair. One global order removes the question.
// ─────────────────────────────────────────────────────────────────────────

async function handleChargeRefundUpdated(
  event: StripeWebhookEvent & { type: 'charge.refund.updated' },
  opts: WebhookHandlerOpts,
): Promise<WebhookHandlerResult> {
  const mappedStatus = mapStripeRefundStatus(event.status);
  if (mappedStatus === undefined) {
    // Non-terminal Stripe refund status (e.g. 'requires_action',
    // 'canceled') — no DB change. Logged via the outcome string.
    return {
      outcome: 'noop',
      note: `refund ${event.refundId} non-terminal status ${event.status}`,
    };
  }

  return withActor(WEBHOOK_ACTOR, async (tx) => {
    // ── Phase 1: MATCH, unlocked ────────────────────────────────────────
    // Both reads this handler already performed, unchanged. Reading the refund
    // row unlocked is safe because every write below re-asserts its own status
    // guard under the charge lock — the `markUnroutable` pattern. What the
    // match is FOR is the charge id.
    let matched = await refundsRepository.findByStripeRefundId(tx, event.refundId);
    let backfillStripeId: string | undefined;

    if (matched === undefined && event.paymentIntentId !== null) {
      // Race: the cancel-route postCommit hasn't written stripe_refund_id
      // yet. Match by (charge_id, amount, pending, no stripe id).
      const charge = await chargesRepository.findByStripePaymentIntentId(tx, event.paymentIntentId);
      if (charge !== undefined) {
        matched = await refundsRepository.findUnmatchedPendingForCharge(tx, {
          chargeId: charge.id,
          amountCents: event.amountCents,
        });
        if (matched !== undefined) {
          backfillStripeId = event.refundId;
        }
      }
    }

    if (matched === undefined) {
      // A refund NOBODY here minted — most likely a staff member refunding from
      // the Stripe dashboard. Record it (money-residue §4.4) rather than
      // retrying forever, when and only when doing so cannot double-record one
      // movement of money. The arm takes the charge lock itself.
      const adopted = await maybeAdoptOutOfBandRefund(tx, {
        event,
        mappedStatus,
        ...(opts.log !== undefined ? { log: opts.log } : {}),
      });
      if (adopted !== undefined) return adopted;

      // The `refunds` row is committed BEFORE the cancel route's post-commit
      // Stripe call, so "not found" here is a delivery race that resolves on
      // the next redelivery — NOT a terminal orphan. Throw so the receiver
      // releases the claim and Stripe redelivers; marking it processed (the
      // old behavior) would strand the refund at 'pending' forever and never
      // flip the charge to 'refunded'.
      throw new WebhookRetryError(
        `no refunds row yet for ${event.refundId}; forcing Stripe redelivery`,
      );
    }

    // ── Phase 2: LOCK THE CHARGE, then RE-READ the refund row ───────────
    // Charges first, always. The re-read is not ceremony: between the match
    // above and this point a concurrent `markResolvedExternal` or a sibling
    // delivery can have moved the row, and every decision below — including the
    // resolved-external refusal — has to be made on what is true now.
    const charge = await chargesRepository.findByIdForUpdate(tx, matched.chargeId);
    if (charge === undefined) {
      throw new Error(
        `handleChargeRefundUpdated: refund ${matched.id} names charge ${matched.chargeId}, which does not exist`,
      );
    }
    const refund = await refundsRepository.findById(tx, matched.id);
    if (refund === undefined) {
      throw new Error(`handleChargeRefundUpdated: refund ${matched.id} vanished under the lock`);
    }

    if (refund.status === 'resolved-external') {
      // A human ATTESTED that this money went back out of band (money-residue
      // §4.3). A redelivered stale terminal event must never overwrite that:
      // the attestation is what closed the cumulative cap, and flipping the row
      // back to `'failed'` would silently REOPEN the remainder for an automatic
      // leg to re-mint — refunding the owner a second time for one debt.
      return {
        outcome: 'noop',
        note: `refund ${refund.id} was resolved out of band by a human; a stale ${event.status} event does not overwrite that`,
      };
    }

    // ── MR-A3.4: BOTH no-op conditions come from the LOCKED re-read ──────
    // The backfill decision was made from the UNLOCKED match, so a delivery
    // that entered via race-recovery carried `backfillStripeId` all the way
    // through and skipped the early return — even when the locked row was
    // already at the target status with its `re_*` backfilled by a concurrent
    // delivery. It then re-ran the flip AND the surplus check: the Opus lane
    // executed two identical ERRORs for ONE movement of money.
    //
    // A backfill is needed only while the LOCKED row's id is still NULL, and a
    // locked row already at `mappedStatus` with an id present is simply a
    // no-op. Chosen over an idempotent-alarm key because the second delivery
    // genuinely IS a no-op — making it one is smaller and truer than
    // deduplicating its noise.
    const needsBackfill = backfillStripeId !== undefined && refund.stripeRefundId === null;
    if (refund.status === mappedStatus && !needsBackfill) {
      // Already at the target status (a re-deliver after the first
      // success) — no-op write. The outcome string still classifies it
      // as the relevant flip for logging.
      return mappedStatus === 'succeeded'
        ? { outcome: 'flipped-refund-succeeded', note: 'already at succeeded; no-op' }
        : { outcome: 'flipped-refund-failed', note: 'already at failed; no-op' };
    }

    await refundsRepository.markStatus(tx, {
      id: refund.id,
      status: mappedStatus,
      ...(needsBackfill ? { stripeRefundId: backfillStripeId as string } : {}),
    });

    if (mappedStatus === 'succeeded') {
      // Cumulative rule → flip charge to 'refunded', under the SAME held lock.
      // Through the shared RETURNED COVERAGE helper (MR-A1.6.3): this tail used
      // to count `sumSucceededForCharge` while the resolve rider counted
      // succeeded + resolved-external, so a resolve-then-flip order left a
      // fully-returned charge reading `'succeeded'` in the owner ledger. The
      // `>=` (rather than `==`) is defensive — partial refunds add up to the
      // total exactly in theory; an over-refund would be an anomaly and we
      // still want the charge flagged.
      const returned = await settleReturnedCoverage(tx, {
        charge,
        stripeRefundId: event.refundId,
        ...(opts.log !== undefined ? { log: opts.log } : {}),
      });
      if (returned >= charge.amountCents) {
        await chargesRepository.markStatus(tx, { id: charge.id, status: 'refunded' });
      }
      return { outcome: 'flipped-refund-succeeded' };
    }
    return { outcome: 'flipped-refund-failed' };
  });
}

/**
 * **THE returned-coverage read, with its surplus alarm attached** (MR-A3.3,
 * 2026-08-24). Returns the charge's returned coverage so the caller can apply
 * the cumulative `'refunded'` rule; raises the surplus ERROR when that coverage
 * has passed the charge total.
 *
 * **Why it is one helper and not two copies.** MR-A2.4 added the check to the
 * ordinary flip tail only. The adoption tail computed the same coverage and
 * flipped the same charge — and stayed SILENT past the total. The Fable lane
 * executed it with no Stripe anomaly at all (resolve 6000c by hand, then adopt
 * a dashboard refund for the full charge): 20000c returned on a 10000c charge,
 * ZERO alarm lines, the resolved row already off the abandon report, and the
 * charge reading a truthful `'refunded'` — no worklist, no report, and no
 * reconciliation would ever surface it. Two call sites that must agree about a
 * money alarm are two call sites that drift; the threshold, the fields and the
 * sentence now live in one place.
 *
 * **It records and alarms; it never refuses.** A signature-verified Stripe
 * event saying a refund succeeded means the money LEFT, and writing "10000c
 * returned" while 20000c left is exactly the false ledger this design exists to
 * kill. Refusing protects nothing either: in every arc that reaches here the
 * cap is already fully covered, so no further automatic mint is possible. The
 * surplus sits with the OWNER, so there is nothing to self-correct server-side
 * — **the alarm IS the remedy**, and the school chases it out of band (the F′
 * Option 1 record-and-page family).
 *
 * Must be called with the charge row's lock already held: it reads coverage and
 * the caller writes the charge status from it.
 */
async function settleReturnedCoverage(
  tx: Tx,
  args: {
    charge: { id: string; ownerId: string; amountCents: number };
    /** The `re_*` whose delivery is being processed — names the movement that
     *  crossed the line, which is where a human starts reading. */
    stripeRefundId: string;
    log?: WebhookHandlerLog;
  },
): Promise<number> {
  const returned = await refundsRepository.sumReturnedCoverageForCharge(tx, args.charge.id);
  if (returned > args.charge.amountCents) {
    // Per-row `status` on the named rows (MR-A3.5(b)) so the ERROR says HOW the
    // money left — a Stripe refund, an adopted dashboard refund and a
    // hand-attested return are three different reconciliations.
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

/**
 * Record a refund that exists at Stripe and nowhere here — the ADOPTION arm
 * (`designs/money-residue.md` §4.4). Returns `undefined` to leave the caller's
 * `WebhookRetryError` behavior exactly as it was.
 *
 * **This is the money-correctness half of out-of-band resolution.** The moment
 * Stripe confirms a staff member's dashboard refund, the cumulative cap closes
 * AUTOMATICALLY — independent of whether the human ever remembers to flip the
 * failed row. (If they do both, the sums can exceed the charge; the cap's
 * direction is refuse-further-refunds, which is the safe one.)
 *
 * Three refusals, each unchanged from today's behavior and each deliberate:
 *
 *   - **no PaymentIntent on the event** — nothing to look a charge up by.
 *   - **no charge for the PaymentIntent** — our own refund rows always commit
 *     before our own fires, so an unknown PI is more likely an orphan-arm
 *     insert racing this delivery than a genuine stranger. Retry is correct.
 *   - **any `'pending'` refund on the charge, at ANY amount** — never adopt
 *     over an in-flight automatic refund. An amount-matched delivery race
 *     against our own refund could double-record one movement. That guard now
 *     lives INSIDE `adoptExternalRefundCapped`, evaluated under the charge lock
 *     (MR-A1.2 / Fable F2), because the INSERT it protects is a cap-ENTERING
 *     write and an unlocked guard can be raced by a concurrent minter. The
 *     named residual (design §4.4) is unchanged: a dashboard refund issued
 *     while an automatic refund of a different amount is in flight stays
 *     unadopted, retried until Stripe's redelivery window expires, then
 *     unrecorded — and the staff resolve verb still records the return.
 *
 * A FAILED dashboard refund adopts as `'failed'`. It joins the `stripe-failed`
 * abandon class only if the charge still OWES something — a human tried, Stripe
 * failed it again, the owner is still owed. If the charge is already covered
 * the row reports under the quiet `covered` class instead (MR-A1.5).
 */
async function maybeAdoptOutOfBandRefund(
  tx: Tx,
  args: {
    event: StripeWebhookEvent & { type: 'charge.refund.updated' };
    mappedStatus: RefundStatus;
    log?: WebhookHandlerLog;
  },
): Promise<WebhookHandlerResult | undefined> {
  const { event, mappedStatus } = args;
  if (event.paymentIntentId === null) return undefined;
  const charge = await chargesRepository.findByStripePaymentIntentId(tx, event.paymentIntentId);
  if (charge === undefined) return undefined;

  // Lock + guard + insert, together, in the repository — see its doc for why
  // the lock cannot live at this call site.
  const adopted = await refundsRepository.adoptExternalRefundCapped(tx, {
    ownerId: charge.ownerId,
    chargeId: charge.id,
    // A dashboard refund names a Stripe charge, not one of our bookings. NULL
    // is the honest anchor; the charge is the join everything downstream uses.
    bookingId: null,
    amountCents: event.amountCents,
    status: mappedStatus,
    stripeRefundId: event.refundId,
    reason: 'out-of-band',
  });
  if (adopted.kind === 'refused-in-flight') return undefined;

  if (mappedStatus === 'succeeded') {
    // The same cumulative tail the ordinary flip runs, under the SAME held
    // lock, through the SAME shared helper — coverage AND its surplus alarm
    // (MR-A1.6.3 for the coverage; MR-A3.3 for the alarm, which existed only in
    // the flip tail until an executed resolve-then-adopt put 20000c on a 10000c
    // charge in total silence).
    const returned = await settleReturnedCoverage(tx, {
      charge,
      stripeRefundId: event.refundId,
      ...(args.log !== undefined ? { log: args.log } : {}),
    });
    if (returned >= charge.amountCents) {
      await chargesRepository.markStatus(tx, { id: charge.id, status: 'refunded' });
    }
  }

  return {
    outcome: 'adopted-out-of-band-refund',
    note: `refund ${event.refundId} was issued outside this system against charge ${charge.id}; recorded as ${adopted.refund.id} at '${mappedStatus}'`,
  };
}

/**
 * Project Stripe's wide refund-status onto our terminal-state enum.
 * Non-terminal states return undefined → handler no-ops + waits for the
 * next webhook delivery. (`canceled` collapses to 'failed' for our
 * purposes — the money didn't return to the customer.)
 */
function mapStripeRefundStatus(status: StripeRefundStatus): RefundStatus | undefined {
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

/**
 * Re-export so the route module doesn't need to import directly from
 * `lib/stripe.ts` to read the status mapper. Keeps the per-handler
 * file's surface coherent.
 */
export { stripeIntentStatusToChargeStatus };
