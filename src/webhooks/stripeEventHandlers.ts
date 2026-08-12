import { deepLinkToPath } from '../contracts/wire.js';
import { db } from '../db/client.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { creditLedger, type LocationKey } from '../db/schema/schema.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import { resolvePurchaseExpiry } from '../lib/creditExpiry.js';
import { creditExpirySettingsRepository } from '../db/repositories/creditExpirySettingsRepository.js';
import { dogProgramsRepository } from '../db/repositories/dogProgramsRepository.js';
import { formatDollars } from '../lib/invoiceReceiptCopy.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { invoiceChargeAttemptsRepository } from '../db/repositories/invoiceChargeAttemptsRepository.js';
import { settleInvoiceCharge, type PendingDuplicateRefund } from '../lib/settleInvoiceCharge.js';
import { autoChargeParkNotification } from '../lib/autoChargeNotificationCopy.js';
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
    // 2026-08-12: a succeeded auto-charge PaymentIntent whose invoice nothing
    // here had recorded — the orphan class that used to be DROPPED.
    | 'settled-orphaned-invoice-charge'
    // The matching failure event for one of those: an attempt we had left in
    // doubt, resolved the moment Stripe volunteered the answer.
    | 'resolved-orphaned-invoice-attempt'
    | 'wrote-payment-method'
    | 'payment-method-already-present'
    | 'flipped-refund-succeeded'
    | 'flipped-refund-failed'
    | 'orphan-event'
    | 'noop';
  /** Optional human-readable note for the log line. */
  note?: string;
  /**
   * Set when settling an orphaned invoice charge LOST the `markPaid` race — the
   * owner had already paid this invoice another way, so this PI double-bills
   * and its refund row was written 'pending' inside the handler's tx. The
   * RECEIVER fires the Stripe refund post-commit (no Stripe call inside a tx,
   * R5) exactly as the auto-charge worker does. Reported up rather than fired
   * inline for the same reason `creditsDogId` is: handlers stay pure DB.
   */
  pendingStripeRefund?: PendingDuplicateRefund;
  /**
   * Set when this event moved a dog's credit balance (async purchase grant or
   * the payment_failed reversal). The receiver wipes the dog's
   * `credits:{dogId}:*` display cache post-commit — the webhook doesn't run
   * through `withMutation`, so invalidation is reported up rather than fired
   * inline (keeps handlers pure DB).
   */
  creditsDogId?: string;
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
      // but nothing here recorded it. Two producers, two safety nets:
      //
      //   1. An INVOICE auto-charge (or a manual `/invoices/:id/pay`) whose
      //      outcome we never learned. Until 2026-08-12 this fell through to
      //      the package parse, failed it (auto-charge PIs carry
      //      invoice_id/owner_id/purpose, not package fields) and was DROPPED
      //      as `orphan-event` — under a comment claiming these "self-heal via
      //      the worker's next tick", which was false twice over: a parked
      //      invoice has `next_attempt_at = NULL` so the lease can never see it
      //      again, and the retry used a fresh idempotency key so it could
      //      never re-adopt the orphaned PI. Money settled at Stripe with
      //      nothing here knowing, and the owner got a push inviting them to
      //      pay again. That is the drop this arm closes.
      //   2. A credit-package purchase whose synchronous write failed after
      //      Stripe captured — the PI metadata carries everything to rebuild
      //      the record.
      const invoiceOrphan = await maybeSettleOrphanedInvoiceCharge(tx, {
        paymentIntentId: event.paymentIntentId,
        amountCents: event.amountCents,
        metadata: event.metadata,
      });
      if (invoiceOrphan !== undefined) return invoiceOrphan;

      const reconstructed = await maybeReconstructOrphanedPackagePurchase(tx, {
        paymentIntentId: event.paymentIntentId,
        amountCents: event.amountCents,
        metadata: event.metadata,
      });
      if (reconstructed.reconstructed) {
        return {
          outcome: 'reconstructed-package-purchase',
          creditsDogId: reconstructed.creditsDogId,
        };
      }
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

    let creditsDogId: string | undefined;
    if (charge.purpose === 'package') {
      creditsDogId = await maybeWritePurchaseLedgerRow(tx, {
        chargeId: charge.id,
        metadata: event.metadata,
      });
      await enqueuePackageFlipPush(tx, {
        settled: true,
        ownerId: charge.ownerId,
        chargeId: charge.id,
        amountCents: event.amountCents,
        metadata: event.metadata,
      });
    }

    return { outcome: 'flipped-charge-succeeded', creditsDogId };
  });
}

/**
 * A non-empty string field off PaymentIntent metadata, which arrives across a
 * trust boundary (anything can be in there, including nothing).
 */
function metadataString(metadata: Record<string, string>, key: string): string | undefined {
  const value: unknown = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The `auto_charge_attempt` metadata field, as a non-negative integer. The
 * worker stamps `invoice_charge_attempts.attempt_no` here; a pre-2026-08-12 PI
 * stamped the dunning counter instead, which for the FIRST attempt of an
 * invoice is the same number by the seeding rule and otherwise simply fails to
 * match a row — a miss, never a wrong match, because the (invoice_id,
 * attempt_no) pair is unique.
 */
function metadataAttemptNo(metadata: Record<string, string>): number | undefined {
  const raw = metadataString(metadata, 'auto_charge_attempt');
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Marry a succeeded PaymentIntent back to the INVOICE it was charging, when no
 * `charges` row exists for it — the money-critical half of
 * `designs/auto-charge-unknown-outcome.md` Decision 2.
 *
 * This is the ONLY resolver that works when the invoice can no longer be leased
 * at all: parked (`next_attempt_at IS NULL`), voided by a group-class withdraw,
 * or switched to pay-in-person. In every one of those the charge lane is blind
 * to the invoice while a PaymentIntent may still settle.
 *
 * Returns `undefined` when the PI isn't an invoice charge (or fails the trust
 * check) so the caller falls through to the package reconstruct; otherwise the
 * finished handler result.
 *
 * The settle runs through `settleInvoiceCharge` — the same primitive both live
 * settle paths use — which is what buys, for free, every consequence that
 * matters here:
 *   - invoice **open** → the atomic `markPaid` claim wins → paid + "Payment
 *     received" receipt + the §J.1 membership month + payment-due teardown;
 *   - invoice **paid** (the owner paid manually during the doubt window) →
 *     lost-race arm → a 'pending' refund row in-tx, fired post-commit by the
 *     receiver → the duplicate comes back automatically. Two charges, one
 *     refund, no human;
 *   - invoice **void** (withdrawn before the charge resolved) → same lost-race
 *     arm → the money goes back, which is exactly what a void means.
 *
 * Idempotency: `charges.stripe_payment_intent_id` is UNIQUE, so a redelivery
 * finds the charge row on the way in and takes the flip arm instead of ever
 * reaching here; an insert that races another writer rolls this tx back, the
 * receiver releases the claim, and Stripe's redelivery takes that same flip arm.
 */
async function maybeSettleOrphanedInvoiceCharge(
  tx: Tx,
  args: { paymentIntentId: string; amountCents: number; metadata: Record<string, string> },
): Promise<WebhookHandlerResult | undefined> {
  const invoiceId = metadataString(args.metadata, 'invoice_id');
  const ownerId = metadataString(args.metadata, 'owner_id');
  if (invoiceId === undefined || ownerId === undefined) return undefined;

  const invoice = await invoicesRepository.findById(tx, invoiceId);
  if (invoice === undefined) {
    return {
      outcome: 'orphan-event',
      note: `PI ${args.paymentIntentId} names invoice ${invoiceId}, which does not exist`,
    };
  }
  if (invoice.ownerId !== ownerId) {
    // Trust boundary: metadata is attacker-shaped input in principle, and
    // settling one owner's invoice from another owner's PI would be the worst
    // possible outcome of believing it.
    return {
      outcome: 'orphan-event',
      note: `PI ${args.paymentIntentId} owner_id metadata does not match invoice ${invoiceId}`,
    };
  }

  const settled = await settleInvoiceCharge(tx, {
    invoice,
    paymentIntentId: args.paymentIntentId,
    amountCents: args.amountCents,
    purpose: invoice.purpose,
    // The worker's convention: silent initiation, receipt on settle. This IS
    // the settle, and it is the only moment the owner can be told — which is
    // what makes the unconfirmed push's promise ("if it went through you'll
    // get a receipt") mechanically true rather than aspirational.
    notifyOwner: true,
  });

  // Close the attempt row this PI belongs to, when there is one. A pre-deploy
  // orphan has none and the settle stands on its own.
  const attemptNo = metadataAttemptNo(args.metadata);
  if (attemptNo !== undefined) {
    const attempt = await invoiceChargeAttemptsRepository.findByInvoiceAndAttemptNo(tx, {
      invoiceId: invoice.id,
      attemptNo,
    });
    if (attempt !== undefined) {
      await invoiceChargeAttemptsRepository.resolve(tx, {
        id: attempt.id,
        outcome: 'succeeded',
        stripePaymentIntentId: args.paymentIntentId,
      });
    }
  }

  if (settled.outcome === 'refunded') {
    return {
      outcome: 'settled-orphaned-invoice-charge',
      note: `invoice ${invoice.id} was already settled by another path; duplicate charge ${settled.chargeId} refunding`,
      ...(settled.pendingStripeRefund !== undefined
        ? { pendingStripeRefund: settled.pendingStripeRefund }
        : {}),
    };
  }
  return {
    outcome: 'settled-orphaned-invoice-charge',
    note: `invoice ${invoice.id} settled from an orphaned PaymentIntent`,
    // §J.1: a winning membership settle granted the month's lot inside this tx,
    // so the dog's credit display cache is stale. The receiver wipes it
    // post-commit through the existing `creditsDogId` channel.
    ...(invoice.purpose === 'membership' && invoice.dogId !== null
      ? { creditsDogId: invoice.dogId }
      : {}),
  };
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
  // §J.1: a membership month-1 PI carries the SAME package fields (dog_id /
  // package_id / credits / mode / location) plus `purpose: 'membership'` —
  // it must NEVER be treated as a one-time package purchase (the reconstruct
  // arm would grant a windowed 'purchase' lot with no membership behind it,
  // and the owner's POST /memberships retry would then collide on the
  // charges PI unique). Skip; membership creation has no async-reconcile arm
  // by design (the POST's idempotent retry is the recovery path).
  if (metadata.purpose === 'membership') return undefined;
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
 *
 * Returns the granted dog id when it actually wrote a grant (so the receiver
 * can wipe that dog's credit display cache), or `undefined` on a no-op
 * (grant already present) or non-package metadata (nothing to invalidate).
 */
async function maybeWritePurchaseLedgerRow(
  tx: Tx,
  args: { chargeId: string; metadata: Record<string, string> },
): Promise<string | undefined> {
  const existing = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.chargeId, args.chargeId), eq(creditLedger.reason, 'purchase')))
    .limit(1);
  if (existing.length > 0) return undefined;

  const parsed = parsePackagePurchaseMetadata(args.metadata);
  if (parsed === undefined) {
    // Metadata missing/malformed (a charge minted by something other than
    // the credit-purchase route). Skip the grant; the charge row's status is
    // the load-bearing fact for the audit + future reconciliation.
    return undefined;
  }
  // §J.3: an alumni dog's lot never expires. Otherwise resolve the expiry
  // window from credit_expiry_settings (per-location → org-default → code
  // default) inside this tx — same as the sync route, so the webhook catch-up
  // grant stamps the same window a live purchase would have. This covers the
  // catch-up grant AND the orphan reconstruct (which delegates here); 1-credit
  // packs never expire (helper returns null).
  const dogIsAlumni = await dogProgramsRepository.isAlumni(parsed.dogId, tx);
  const expiresAt = dogIsAlumni
    ? null
    : resolvePurchaseExpiry(
        parsed.credits,
        await creditExpirySettingsRepository.resolveExpiryWindowMonths(parsed.location, tx),
        new Date(),
      );
  await creditLedgerRepository.creditPurchase(tx, {
    dogId: parsed.dogId,
    mode: parsed.mode,
    location: parsed.location,
    delta: parsed.credits,
    packageId: parsed.packageId,
    chargeId: args.chargeId,
    expiresAt,
  });
  return parsed.dogId;
}

/**
 * Rebuild a missing credit-package purchase from the PaymentIntent metadata
 * after a sync-path DB failure left Stripe holding the money with no record.
 * Returns `{ reconstructed: true, creditsDogId }` when it reconstructed (the PI
 * was a package purchase; `creditsDogId` set when the grant actually wrote),
 * or `{ reconstructed: false }` when the metadata isn't a package purchase (a
 * genuine orphan the caller reports as such). Idempotent: the charge insert is
 * `ON CONFLICT DO NOTHING` on the unique PI, and the grant is the same
 * `maybeWritePurchaseLedgerRow` no-op-if-present write — so a concurrent client
 * retry and this path can't double-charge or double-grant.
 */
async function maybeReconstructOrphanedPackagePurchase(
  tx: Tx,
  args: { paymentIntentId: string; amountCents: number; metadata: Record<string, string> },
): Promise<{ reconstructed: boolean; creditsDogId?: string }> {
  const parsed = parsePackagePurchaseMetadata(args.metadata);
  if (parsed === undefined) return { reconstructed: false };
  // The reconstruct builds the charge from scratch, so it additionally needs
  // the owner (the grant path above gets it from the existing charge row).
  const ownerId = args.metadata.owner_id;
  if (typeof ownerId !== 'string' || ownerId.length === 0) return { reconstructed: false };

  const { charge } = await chargesRepository.insertIfAbsentByPaymentIntent(tx, {
    ownerId,
    amountCents: args.amountCents,
    status: 'succeeded',
    purpose: 'package',
    stripePaymentIntentId: args.paymentIntentId,
  });
  const creditsDogId = await maybeWritePurchaseLedgerRow(tx, {
    chargeId: charge.id,
    metadata: args.metadata,
  });
  // Same promise as the flip arm below: the owner was told a `processing`
  // purchase would be reported when it resolved. A reconstruct means the money
  // moved and the sync 201 they hold may not even name this charge — so the
  // push matters MORE here, not less.
  await enqueuePackageFlipPush(tx, {
    settled: true,
    ownerId,
    chargeId: charge.id,
    amountCents: args.amountCents,
    metadata: args.metadata,
  });
  return { reconstructed: true, creditsDogId };
}

/**
 * The late-settle owner push for a credit-package charge (wire 1.9.0, Allison
 * approved 2026-08-04). The credit-purchase route commits its `charges` row
 * BEFORE the 201, and `processing` is the one status the pre-tx cancel can't
 * kill — so the owner's 201 says "your payment is still processing, don't buy
 * again right now; if it goes through your credits will be added and we'll let
 * you know", and THIS is the only place that promise can be kept. Without it
 * that sentence points at nothing and the honest advice becomes "buy again",
 * which is how an owner ends up charged twice and granted twice.
 *
 * Fires only on a FLIP (a charge that was still `requires_payment`) or a
 * reconstruct — never on `charge-already-terminal`, where the sync response
 * already told the owner the outcome. `enqueueIdempotent` on
 * `package-flip[-failed]:<chargeId>` makes a replayed Stripe delivery a no-op
 * on top of the receiver's own `stripe_events` dedupe.
 *
 * Silently skips when the PaymentIntent metadata isn't a package purchase
 * (a membership month-1 PI carries the same package fields — §J.1 — and
 * `parsePackagePurchaseMetadata` is the one guard that knows the difference):
 * with no `dog_id` there is no credits surface to open, and a push that lands
 * nowhere is worse than none.
 *
 * Inherits BUG-17 (`DISCREPANCIES.md`): stored notification preferences are the
 * scheduler's to honor, and it does so for both these types via
 * `pushPreferences.ts`. Nothing here widens that gap.
 */
async function enqueuePackageFlipPush(
  tx: Tx,
  args: {
    /** true = the intent settled and credits landed; false = it failed. */
    settled: boolean;
    ownerId: string;
    chargeId: string;
    amountCents: number;
    metadata: Record<string, string>;
  },
): Promise<void> {
  const parsed = parsePackagePurchaseMetadata(args.metadata);
  if (parsed === undefined) return;

  const now = new Date();
  if (!args.settled) {
    await scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: args.ownerId,
      type: 'payment-failed',
      trigger: 'package-charge-failed',
      dedupeKey: `package-flip-failed:${args.chargeId}`,
      scheduledFor: now, // immediate — delivered on the next scheduler tick
      title: 'Purchase failed',
      body: "Your credit purchase didn't go through — you weren't charged. No credits were added.",
      deepLinkPath: deepLinkToPath({ kind: 'credits', id: parsed.dogId }),
      deepLinkKind: 'credits',
      deepLinkId: parsed.dogId,
      dogId: parsed.dogId,
    });
    return;
  }

  // Name the dog the credits actually landed on — the owner may have several,
  // and "credits were added" without saying whose is the kind of vague that
  // makes someone open the app to find out.
  const dogName = (await dogsRepository.findNameInTx(tx, parsed.dogId)) ?? 'your dog';
  const creditNoun = parsed.credits === 1 ? '1 credit was' : `${parsed.credits} credits were`;
  await scheduledNotificationsRepository.enqueueIdempotent(tx, {
    ownerId: args.ownerId,
    type: 'payment-succeeded',
    trigger: 'package-charge-settled',
    dedupeKey: `package-flip:${args.chargeId}`,
    scheduledFor: now,
    title: 'Purchase complete',
    body: `Your ${formatDollars(args.amountCents)} credit purchase went through — ${creditNoun} added for ${dogName}.`,
    deepLinkPath: deepLinkToPath({ kind: 'credits', id: parsed.dogId }),
    deepLinkKind: 'credits',
    deepLinkId: parsed.dogId,
    dogId: parsed.dogId,
  });
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
      // The symmetric half of the succeeded-orphan arm (2026-08-12): an
      // auto-charge attempt we left in doubt, answered the moment Stripe
      // volunteers it. Resolving it here rather than waiting for a verify pass
      // is the difference between the owner learning today and learning in ten
      // minutes — and, past the key window, between learning and not.
      const resolved = await maybeResolveOrphanedInvoiceAttempt(tx, {
        paymentIntentId: event.paymentIntentId,
        metadata: event.metadata,
      });
      if (resolved !== undefined) return resolved;
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

    if (charge.purpose === 'package') {
      // The other half of the `processing` promise (wire 1.9.0): the purchase
      // resolved, and it resolved badly. Saying so — including "you weren't
      // charged" — is what makes it safe for the owner to buy again.
      await enqueuePackageFlipPush(tx, {
        settled: false,
        ownerId: charge.ownerId,
        chargeId: charge.id,
        amountCents: event.amountCents,
        metadata: event.metadata,
      });
    }

    // Reverse any provisional purchase ledger row. Defensive: Day-14's
    // sync path only writes the ledger on 'succeeded', so this is rare.
    let creditsDogId: string | undefined;
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
        creditsDogId = orig.dogId;
      }
    }

    return { outcome: 'flipped-charge-failed', creditsDogId };
  });
}

/**
 * Resolve an unresolved auto-charge attempt from a `payment_intent.
 * payment_failed` event — the answer arriving from Stripe instead of from a
 * verify pass.
 *
 * Marks the attempt `no-charge`, which frees the invoice for the next attempt
 * (a fresh key is CORRECT once the previous one is known-dead — that is the
 * whole distinction this design turns on). Deliberately does NOT touch the
 * dunning ladder: the charge lane owns the ladder and will run it on the next
 * lease, and double-counting from two places is how a park arrives early.
 *
 * The ONE case that needs a sentence here: an invoice already PARKED while its
 * outcome was unknown. It will never be leased again, so if this handler stays
 * silent the owner is left holding "we can't yet confirm whether it went
 * through" forever. `resolve()` returning 1 means THIS event is the one that
 * ended the doubt, which is exactly when the now-known answer is worth sending;
 * the `payment-failed:<id>` dedupe key keeps it to one push per invoice, ever.
 */
async function maybeResolveOrphanedInvoiceAttempt(
  tx: Tx,
  args: { paymentIntentId: string; metadata: Record<string, string> },
): Promise<WebhookHandlerResult | undefined> {
  const invoiceId = metadataString(args.metadata, 'invoice_id');
  const ownerId = metadataString(args.metadata, 'owner_id');
  const attemptNo = metadataAttemptNo(args.metadata);
  if (invoiceId === undefined || ownerId === undefined || attemptNo === undefined) return undefined;

  const invoice = await invoicesRepository.findById(tx, invoiceId);
  if (invoice === undefined || invoice.ownerId !== ownerId) return undefined;

  const attempt = await invoiceChargeAttemptsRepository.findByInvoiceAndAttemptNo(tx, {
    invoiceId,
    attemptNo,
  });
  if (attempt === undefined) return undefined;

  const resolved = await invoiceChargeAttemptsRepository.resolve(tx, {
    id: attempt.id,
    outcome: 'no-charge',
    stripePaymentIntentId: args.paymentIntentId,
  });
  if (resolved === 0) {
    return {
      outcome: 'resolved-orphaned-invoice-attempt',
      note: `attempt ${attempt.id} was already terminal; nothing to resolve`,
    };
  }

  if (invoice.status === 'open' && invoice.nextAttemptAt === null) {
    // Parked with the doubt unresolved. Nothing automatic will ever touch this
    // invoice again, so this is the last chance to replace "we don't know" with
    // the answer.
    const copy = autoChargeParkNotification('failed-unknown-reason', {
      invoiceId: invoice.id,
      amountCents: invoice.amountCents,
      purpose: invoice.purpose,
      // When the charge was TRIED, not when its answer finally reached us. A
      // late `payment_failed` can arrive hours after the attempt, and "we tried
      // your payment on <the day the webhook landed>" is a date we made up.
      at: new Date(attempt.createdAt),
    });
    await scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: invoice.ownerId,
      type: 'payment-failed',
      trigger: 'payment-failed',
      dedupeKey: copy.dedupeKey,
      scheduledFor: new Date(),
      title: copy.title,
      body: copy.body,
      deepLinkPath: deepLinkToPath({
        kind: 'invoice',
        id: invoice.id,
        params: { reason: copy.reason },
      }),
      deepLinkKind: 'invoice',
      deepLinkId: invoice.id,
      dogId: invoice.dogId,
    });
  }

  return {
    outcome: 'resolved-orphaned-invoice-attempt',
    note: `attempt ${attempt.id} for invoice ${invoice.id} resolved no-charge from Stripe`,
  };
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
