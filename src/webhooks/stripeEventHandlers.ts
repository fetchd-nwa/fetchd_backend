import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { creditLedger, LOCATION_SLUGS } from '../db/schema/schema.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { resolvePurchaseExpiry } from '../lib/creditExpiry.js';
import { materializePaymentMethod } from '../lib/materializePaymentMethod.js';
import { refundsRepository, type RefundStatus } from '../db/repositories/refundsRepository.js';
import { stripeCustomersRepository } from '../db/repositories/stripeCustomersRepository.js';
import { withActor, type Tx } from '../db/tx.js';
import { assertNever } from '../lib/assertNever.js';
import {
  stripeIntentStatusToChargeStatus,
  type StripeClient,
  type StripeRefundStatus,
  type StripeWebhookEvent,
} from '../lib/stripe.js';
import { and, eq } from 'drizzle-orm';
import type { BookingMode } from '../lib/bookingMode.js';

type LocationKey = (typeof LOCATION_SLUGS)[number];

function isLocationKey(value: string | undefined): value is LocationKey {
  return value === 'fayetteville' || value === 'bentonville';
}

/**
 * The actor string written into `app.actor` for every webhook-driven DB
 * mutation. Mirrors the Day-2 `system:auth-webhook` precedent — `withActor`
 * accepts arbitrary strings precisely so non-user principals (Supabase
 * auth webhook, Stripe webhook, future schedulers) can attribute writes
 * without an `owners` / `staff` row.
 */
export const WEBHOOK_ACTOR = 'system:stripe-webhook';

export interface WebhookHandlerOpts {
  stripe: StripeClient;
}

export interface WebhookHandlerResult {
  outcome:
    | 'flipped-charge-succeeded'
    | 'flipped-charge-failed'
    | 'charge-already-terminal'
    | 'reconstructed-package-purchase'
    | 'wrote-payment-method'
    | 'payment-method-already-present'
    | 'flipped-refund-succeeded'
    | 'flipped-refund-failed'
    | 'orphan-event'
    | 'noop';
  /** Optional human-readable note for the log line. */
  note?: string;
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
      return handlePaymentIntentSucceeded(event);
    case 'payment_intent.payment_failed':
      return handlePaymentIntentFailed(event);
    case 'setup_intent.succeeded':
      return handleSetupIntentSucceeded(event, opts);
    case 'charge.refund.updated':
      return handleChargeRefundUpdated(event);
    case 'unhandled':
      return { outcome: 'noop', note: `event type ${event.rawType} has no handler wired` };
    default:
      return assertNever(event);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// payment_intent.succeeded
//
// Find the `charges` row by stripe_payment_intent_id. Flip status to
// 'succeeded' if not already there. If the charge purpose was 'package'
// AND no `credit_ledger` purchase row exists for this charge yet (e.g.
// the requires_action / async-confirm path that Day-14 left to the
// webhook), write the ledger row using metadata captured at PI creation
// (`dog_id`, `package_id`, `credits`).
// ─────────────────────────────────────────────────────────────────────────

async function handlePaymentIntentSucceeded(
  event: StripeWebhookEvent & { type: 'payment_intent.succeeded' },
): Promise<WebhookHandlerResult> {
  return withActor(WEBHOOK_ACTOR, async (tx) => {
    const charge = await chargesRepository.findByStripePaymentIntentId(tx, event.paymentIntentId);
    if (charge === undefined) {
      // No charges row for a SUCCEEDED PaymentIntent — Stripe captured money
      // but the synchronous purchase write never landed (DB failure after the
      // Stripe call committed at Stripe's side). For a credit-package purchase
      // the PI metadata carries everything to rebuild the record, so the
      // webhook is the safety net: reconstruct the charge + grant idempotently.
      // (Invoice auto-charge orphans self-heal via the worker's next tick, so
      // only the client-driven package purchase needs this path.)
      const reconstructed = await maybeReconstructOrphanedPackagePurchase(tx, {
        paymentIntentId: event.paymentIntentId,
        amountCents: event.amountCents,
        metadata: event.metadata,
      });
      if (reconstructed) return { outcome: 'reconstructed-package-purchase' };
      return {
        outcome: 'orphan-event',
        note: `no charges row for PI ${event.paymentIntentId} (no package metadata to reconstruct)`,
      };
    }

    if (charge.status === 'succeeded' || charge.status === 'refunded') {
      // Day-14's synchronous-confirm path already landed the terminal
      // status (and ledger row). Nothing to do — return idempotent OK.
      return { outcome: 'charge-already-terminal' };
    }

    await chargesRepository.markStatus(tx, { id: charge.id, status: 'succeeded' });

    if (charge.purpose === 'package') {
      await maybeWritePurchaseLedgerRow(tx, {
        chargeId: charge.id,
        metadata: event.metadata,
      });
    }

    return { outcome: 'flipped-charge-succeeded' };
  });
}

interface PackagePurchaseMetadata {
  dogId: string;
  packageId: string;
  credits: number;
  mode: BookingMode;
  location: LocationKey;
}

/**
 * Validate the grant-bearing PaymentIntent metadata the credit-purchase route
 * stamps (`routes/creditPackages.ts`). Returns the typed fields, or undefined
 * when the metadata is missing/malformed (a PI minted by something other than
 * a package purchase — e.g. an invoice auto-charge). `owner_id` is NOT here:
 * the ledger grant doesn't need it, and the catch-up consumer reads the owner
 * off the existing charge row. The reconstruct consumer validates `owner_id`
 * separately (it has no charge row to read it from).
 */
function parsePackagePurchaseMetadata(
  metadata: Record<string, string>,
): PackagePurchaseMetadata | undefined {
  const dogId = metadata.dog_id;
  const packageId = metadata.package_id;
  const credits = Number(metadata.credits);
  const mode = metadata.mode;
  const location = metadata.location;
  if (
    typeof dogId !== 'string' ||
    dogId.length === 0 ||
    typeof packageId !== 'string' ||
    packageId.length === 0 ||
    !Number.isFinite(credits) ||
    credits <= 0 ||
    (mode !== 'school' && mode !== 'daycare') ||
    !isLocationKey(location)
  ) {
    return undefined;
  }
  return { dogId, packageId, credits, mode, location };
}

/**
 * Write a `credit_ledger` purchase row if one doesn't already exist for
 * this charge. The async-confirm path of `POST /credit-packages/:key/purchase`
 * deliberately deferred this write to the webhook (Day-14 known caveat) —
 * here we catch it up using the PI metadata. Idempotent: a duplicate
 * call finds an existing row and is a no-op.
 */
async function maybeWritePurchaseLedgerRow(
  tx: Tx,
  args: { chargeId: string; metadata: Record<string, string> },
): Promise<void> {
  const existing = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.chargeId, args.chargeId), eq(creditLedger.reason, 'purchase')))
    .limit(1);
  if (existing.length > 0) return;

  const parsed = parsePackagePurchaseMetadata(args.metadata);
  if (parsed === undefined) {
    // Metadata missing/malformed (a charge minted by something other than
    // the credit-purchase route). Skip the grant; the charge row's status is
    // the load-bearing fact for the audit + future reconciliation.
    return;
  }
  await creditLedgerRepository.creditPurchase(tx, {
    dogId: parsed.dogId,
    mode: parsed.mode,
    location: parsed.location,
    delta: parsed.credits,
    packageId: parsed.packageId,
    chargeId: args.chargeId,
    // Same lot-expiry stamp as the sync purchase route (this covers the catch-up
    // grant AND the orphan reconstruct, which delegates here). 1-credit packs
    // never expire (helper returns null).
    expiresAt: resolvePurchaseExpiry(parsed.location, parsed.credits, new Date()),
  });
}

/**
 * Rebuild a missing credit-package purchase from the PaymentIntent metadata
 * after a sync-path DB failure left Stripe holding the money with no record.
 * Returns true when it reconstructed (the PI was a package purchase), false
 * when the metadata isn't a package purchase (a genuine orphan the caller
 * reports as such). Idempotent: the charge insert is `ON CONFLICT DO NOTHING`
 * on the unique PI, and the grant is the same `maybeWritePurchaseLedgerRow`
 * no-op-if-present write — so a concurrent client retry and this path can't
 * double-charge or double-grant.
 */
async function maybeReconstructOrphanedPackagePurchase(
  tx: Tx,
  args: { paymentIntentId: string; amountCents: number; metadata: Record<string, string> },
): Promise<boolean> {
  const parsed = parsePackagePurchaseMetadata(args.metadata);
  if (parsed === undefined) return false;
  // The reconstruct builds the charge from scratch, so it additionally needs
  // the owner (the grant path above gets it from the existing charge row).
  const ownerId = args.metadata.owner_id;
  if (typeof ownerId !== 'string' || ownerId.length === 0) return false;

  const { charge } = await chargesRepository.insertIfAbsentByPaymentIntent(tx, {
    ownerId,
    amountCents: args.amountCents,
    status: 'succeeded',
    purpose: 'package',
    stripePaymentIntentId: args.paymentIntentId,
  });
  await maybeWritePurchaseLedgerRow(tx, { chargeId: charge.id, metadata: args.metadata });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// payment_intent.payment_failed
//
// Find the charge by PI id. Flip to 'failed'. If a purchase ledger row
// was provisionally written (defensive — Day-14 only writes on
// 'succeeded'), emit a reversing entry (-delta) so the balance recomputes
// to its pre-attempt value.
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

    // Reverse any provisional purchase ledger row. Defensive: Day-14's
    // sync path only writes the ledger on 'succeeded', so this is rare.
    const existing = await tx
      .select({ id: creditLedger.id, delta: creditLedger.delta })
      .from(creditLedger)
      .where(and(eq(creditLedger.chargeId, charge.id), eq(creditLedger.reason, 'purchase')))
      .limit(1);
    if (existing.length > 0 && existing[0]!.delta > 0) {
      const row = existing[0]!;
      // Reverse via an explicit row: append-only ledger means we can't
      // delete or edit the original. Use the same `mode` + `dog_id` —
      // these are stamped on the original purchase row.
      const [orig] = await tx
        .select({
          dogId: creditLedger.dogId,
          mode: creditLedger.mode,
          location: creditLedger.location,
        })
        .from(creditLedger)
        .where(eq(creditLedger.id, row.id));
      if (orig) {
        await tx.insert(creditLedger).values({
          dogId: orig.dogId,
          mode: orig.mode,
          location: orig.location,
          delta: -row.delta,
          reason: 'adjustment',
          chargeId: charge.id,
          note: 'reverse provisional purchase grant on Stripe payment_failed',
        });
      }
    }

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
// = 'pending', stripe_refund_id IS NULL). Flip status. On 'succeeded',
// recompute cumulative succeeded refunds for the charge — if the sum
// equals the charge amount, flip charges.status to 'refunded'.
// ─────────────────────────────────────────────────────────────────────────

async function handleChargeRefundUpdated(
  event: StripeWebhookEvent & { type: 'charge.refund.updated' },
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
    let refund = await refundsRepository.findByStripeRefundId(tx, event.refundId);
    let backfillStripeId: string | undefined;

    if (refund === undefined && event.paymentIntentId !== null) {
      // Race: the cancel-route postCommit hasn't written stripe_refund_id
      // yet. Match by (charge_id, amount, pending, no stripe id).
      const charge = await chargesRepository.findByStripePaymentIntentId(tx, event.paymentIntentId);
      if (charge !== undefined) {
        refund = await refundsRepository.findUnmatchedPendingForCharge(tx, {
          chargeId: charge.id,
          amountCents: event.amountCents,
        });
        if (refund !== undefined) {
          backfillStripeId = event.refundId;
        }
      }
    }

    if (refund === undefined) {
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

    if (refund.status === mappedStatus && backfillStripeId === undefined) {
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
      ...(backfillStripeId !== undefined ? { stripeRefundId: backfillStripeId } : {}),
    });

    if (mappedStatus === 'succeeded') {
      // Cumulative rule: refunds.sum(succeeded) >= charge.amount_cents
      // → flip charge to 'refunded'. Use the post-update sum so the
      // freshly-flipped refund is counted. The `>=` (rather than `==`)
      // is defensive — partial refunds add up to the total exactly in
      // theory; an over-refund would be a Stripe-side anomaly and we
      // still want to flag the charge as refunded.
      const totalSucceeded = await refundsRepository.sumSucceededForCharge(tx, refund.chargeId);
      const charge = await chargesRepository.findById(tx, refund.chargeId);
      if (charge !== undefined && totalSucceeded >= charge.amountCents) {
        await chargesRepository.markStatus(tx, { id: charge.id, status: 'refunded' });
      }
      return { outcome: 'flipped-refund-succeeded' };
    }
    return { outcome: 'flipped-refund-failed' };
  });
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
