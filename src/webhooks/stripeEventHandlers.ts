import { deepLinkToPath } from '../contracts/wire.js';
import { db } from '../db/client.js';
import {
  chargesRepository,
  type ChargePurpose,
} from '../db/repositories/chargesRepository.js';
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
import {
  settleInvoiceCharge,
  type AnchorResolutionLog,
  type PendingDuplicateRefund,
} from '../lib/settleInvoiceCharge.js';
import { autoChargeParkNotification } from '../lib/autoChargeNotificationCopy.js';
import { materializePaymentMethod } from '../lib/materializePaymentMethod.js';
import { pgTimestampToDate } from '../lib/pgTimestamp.js';
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

/**
 * The logger the handlers need. `warn` is the §A3.19 F2 anchor-fallback
 * tripwire; `error` is the money page — the membership month-1 arms move money
 * UNATTENDED, and the Q-B posture is that unattended money movement always
 * pages (§A3.18.4 family). `FastifyBaseLogger` satisfies this structurally.
 */
export interface WebhookHandlerLog extends AnchorResolutionLog {
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface WebhookHandlerOpts {
  stripe: StripeClient;
  /**
   * Where the §A3.19 F2 anchor-fallback WARN and the month-1 refund ERROR go.
   * Optional so existing callers compile, but THIS lane is the one that matters
   * most for it: the late settle of a voided invoice is a webhook, and the
   * pre-stamp invoice population it fires for drains over weeks. A caller that
   * omits it makes the tripwire — and the money alarm — silent.
   */
  log?: WebhookHandlerLog;
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
    // 2026-08-24 (`designs/money-residue.md` §2): a membership MONTH-1
    // PaymentIntent that settled with no membership behind it. The disposition
    // is REFUND, never reconstruct — the ruled §J.1 v1 stance applied to the
    // async tail — so this outcome always means money is on its way back.
    | 'refunded-orphaned-membership-charge'
    // The same arm when the money was ALREADY spoken for (MR-A1.6.2). It
    // refunded nothing, so it does not claim to have.
    | 'membership-orphan-already-covered'
    // 2026-08-24 (`designs/money-residue.md` §4.4): a refund that exists at
    // Stripe and nowhere here — a staff dashboard refund — now RECORDED instead
    // of retried into the ground. Closes the cumulative cap automatically.
    | 'adopted-out-of-band-refund'
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
      return handlePaymentIntentSucceeded(event, opts);
    case 'payment_intent.payment_failed':
      return handlePaymentIntentFailed(event);
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
  opts: WebhookHandlerOpts,
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
        ...(opts.log !== undefined ? { log: opts.log } : {}),
      });
      if (invoiceOrphan !== undefined) return invoiceOrphan;

      // 3. A membership MONTH-1 PaymentIntent that settled with nothing behind
      //    it. Beside the package reconstruct rather than inside it, because
      //    the disposition is the opposite one: money back, never a
      //    reconstructed subscription (money-residue §2.2c).
      const membershipOrphan = await maybeRefundOrphanedMembershipCharge(tx, {
        paymentIntentId: event.paymentIntentId,
        amountCents: event.amountCents,
        metadata: event.metadata,
        ...(opts.log !== undefined ? { log: opts.log } : {}),
      });
      if (membershipOrphan !== undefined) return membershipOrphan;

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

    // ── The month-1 FLIP arm (money-residue §2.2c, gate per MR-A1.4) ──────
    // A `purpose='membership'` row that is not yet terminal, carrying the
    // MONTH-1 FINGERPRINT, has — definitionally — no membership behind it: the
    // only writer of such a row is the route's recorded-processing arm, and the
    // normal path writes `'succeeded'` ATOMICALLY with its membership. Flipping
    // it to `'succeeded'` here and walking away is the money defect: the row
    // would say paid, the ledger would show a charge, and the owner would have
    // neither a subscription nor their money.
    if (isMonthOneFingerprint(charge, event.metadata)) {
      return adjudicateMonthOneMembershipCharge(tx, {
        charge,
        alreadySucceeded: false,
        paymentIntentId: event.paymentIntentId,
        amountCents: event.amountCents,
        metadata: event.metadata,
        ...(opts.log !== undefined ? { log: opts.log } : {}),
      });
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
  args: {
    paymentIntentId: string;
    amountCents: number;
    metadata: Record<string, string>;
    log?: AnchorResolutionLog;
  },
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
    ...(args.log !== undefined ? { log: args.log } : {}),
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
  // by design.
  //
  // Δ 2026-08-24 (money-residue §2.3): the skip now hands the event to the
  // MEMBERSHIP arm rather than to the `orphan-event` drop, and the sentence
  // above stays TRUE — nothing reconstructs a membership; the money reconciles
  // by REFUND. (The line this replaced said "the POST's idempotent retry is the
  // recovery path", which was a hope, not a mechanism: an owner who gave up
  // never retries, and a retry that got the same now-succeeded PI back from
  // Stripe's cache used to crash on the charges PI unique.)
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

// ─────────────────────────────────────────────────────────────────────────
// The membership MONTH-1 arms (`designs/money-residue.md` §2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The `reason` stamped on a month-1 orphan refund. Keys NOTHING — only
 * `ROW_KEYED_REFUND_REASON`'s legacy lane reads `reason`, and this row carries
 * its own stored key, so it is claimed by lane 1 of `claimStalePendingForRetry`
 * by construction.
 */
const MEMBERSHIP_MONTH1_ORPHAN_REASON = 'membership-month1-orphan';

/**
 * THE Stripe idempotency key for a month-1 orphan refund, derived from OUR row
 * uuid and stored in the minting transaction (§A2.1). Row-derived rather than
 * request-derived because nothing here has a client request key: a webhook is
 * not a request the owner made, so a key built from anything but the row would
 * be unreconstructible by the retry sweep — the exact class of un-retryable
 * refund the stored-key design abolished.
 */
function membershipOrphanRefundKey(refundId: string): string {
  return `membership-orphan-refund:${refundId}`;
}

/**
 * **POSITIVE evidence that this money is a membership MONTH-1 charge**
 * (MR-A1.4, 2026-08-24).
 *
 * The gate this replaced was `purpose='membership'` AND `invoice_id` ABSENT —
 * negative evidence over an input that crosses a trust boundary and that a
 * Stripe dashboard edit can empty. The Opus attack lane executed the cost: a
 * RENEWAL-shaped charge whose succeeded event arrived with an empty metadata
 * bag took the month-1 adjudication, producing an unattended 9900c refund of
 * money a renewal invoice was owed, the invoice left open for a second
 * collection, and ZERO pushes (the push keyed `dog_id` off the same absent
 * metadata). `metadataString` reads `''` as missing, so merely BLANKING
 * `invoice_id` was enough.
 *
 * So the arm now demands the fingerprint the route actually stamps:
 *
 *   1. `charge.purpose === 'membership'`;
 *   2. no `invoice_id` — renewals bill through the invoice lane and always
 *      carry one (`invoices.ts`, `invoiceAutoCharge.ts`);
 *   3. **`package_key` PRESENT** — `POST /memberships` stamps it on every
 *      month-1 PaymentIntent at mint, and no renewal minter stamps it at all.
 *
 * **Metadata loss degrades to the GENERIC flip**, deliberately: the money is
 * still recorded, the invoice machinery still owns settlement, and the §A3.19
 * "webhook-flip door" residual stays exactly as queued — neither widened nor
 * claimed fixed. Under-refunding on missing evidence is recoverable by a human;
 * an unattended refund of somebody else's debt is not.
 */
function isMonthOneFingerprint(
  charge: { purpose: ChargePurpose },
  metadata: Record<string, string>,
): boolean {
  return (
    charge.purpose === 'membership' &&
    metadataString(metadata, 'invoice_id') === undefined &&
    metadataString(metadata, 'package_key') !== undefined
  );
}

/**
 * Adjudicate a month-1 membership charge whose PaymentIntent has SUCCEEDED with
 * no membership behind it: flip it terminal and REFUND it, in one transaction,
 * under the charge row's lock.
 *
 * **Refund, never reconstruct.** Reconstructing the membership here would
 * reverse the RULED §J.1 v1 stance rather than compose with it; it would make
 * the 402 the owner already received ("try a different card") retroactively
 * FALSE and double-subscribe whoever obeyed it; and it would have to invent a
 * period anchor — `firstPeriod(now)` at webhook time is a month the owner never
 * chose. Money back is the conservative disposition and the owner's
 * re-subscribe is clean recovery (money-residue §2.7.1).
 *
 * **The lock order.** The charge row is taken `FOR UPDATE` FIRST, before
 * `refunds` is read or written — charges → refunds, the ONE global order
 * (MR-A1.2(ii)). `mintCappedPendingRefund` re-takes the same row lock this
 * already holds. The older §A3.19 R1 carve-out (which permitted
 * {@link handleChargeRefundUpdated}'s reverse order on the grounds that the
 * mint helper never waits on a refunds row) is RETIRED: that handler is now
 * charges-first too.
 *
 * **R5/R35 intact.** No Stripe call happens in here. The pending row IS the
 * commitment and the receiver fires it post-commit; if that fire fails, the row
 * stays pending with its stored key and the retry sweep re-fires it byte-
 * identically.
 */
async function adjudicateMonthOneMembershipCharge(
  tx: Tx,
  args: {
    charge: { id: string };
    /** True only on the orphan arm's fresh insert, which lands at `'succeeded'`
     *  already — everything else arrives non-terminal and is flipped here. */
    alreadySucceeded: boolean;
    paymentIntentId: string;
    amountCents: number;
    metadata: Record<string, string>;
    log?: WebhookHandlerLog;
  },
): Promise<WebhookHandlerResult> {
  const locked = await chargesRepository.findByStripePaymentIntentIdForUpdate(
    tx,
    args.paymentIntentId,
  );
  if (locked === undefined) {
    throw new Error(
      `month-1 adjudication: charge ${args.charge.id} for PI ${args.paymentIntentId} vanished under the lock`,
    );
  }
  if (!args.alreadySucceeded) {
    if (locked.status === 'succeeded' || locked.status === 'refunded') {
      // Another writer — the route's retry, or a concurrent delivery — won the
      // lock and adjudicated first. Whatever it decided stands.
      return {
        outcome: 'charge-already-terminal',
        note: `membership charge ${locked.id} was adjudicated by another writer while this event waited on the lock`,
      };
    }
    await chargesRepository.markStatus(tx, { id: locked.id, status: 'succeeded' });
  }

  const minted = await refundsRepository.mintCappedPendingRefund(tx, {
    chargeId: locked.id,
    ownerId: locked.ownerId,
    // A membership is not a booking. NULL here is the honest anchor, and every
    // enrollment-identity read is `cohort_id`-scoped, so this row enters none
    // of them (§A3.17/§A3.18/§A3.19 are group-class-scoped throughout).
    bookingId: null,
    reason: MEMBERSHIP_MONTH1_ORPHAN_REASON,
    stripeIdempotencyKey: membershipOrphanRefundKey,
  });
  if (minted.kind === 'no-payment-intent') {
    throw new Error(
      `month-1 adjudication: charge ${locked.id} carries no PaymentIntent though ${args.paymentIntentId} succeeded`,
    );
  }
  if (minted.kind === 'nothing-to-refund') {
    // R9 working, not an error: this money is already spoken for. The invariant
    // still holds — the row is `'succeeded'` and its refunds cover it. It gets
    // its OWN literal (MR-A1.6.2): reporting
    // `'refunded-orphaned-membership-charge'` here claimed a refund this arm
    // did not make, which is exactly the kind of log a human later trusts.
    return {
      outcome: 'membership-orphan-already-covered',
      note: `membership charge ${locked.id} is already fully covered by existing refunds; nothing further to return`,
    };
  }

  await enqueueMembershipOrphanRefundPush(tx, {
    ownerId: locked.ownerId,
    chargeId: locked.id,
    amountCents: minted.amountCents,
    // **From the ROW first** (MR-A1.4 fold). Arm (a) records `dog_id` and the
    // orphan arm's insert carries it, so the row is the durable fact; event
    // metadata is a fallback for a row that predates the stamp. Keying the push
    // off metadata alone meant an emptied bag produced a refund with no
    // notification at all.
    dogId: locked.dogId ?? metadataString(args.metadata, 'dog_id'),
  });

  // Unattended money movement ALWAYS pages (the Q-B posture, §A3.18.4 family).
  // Nothing here was asked for by a human, so the log line is the only place a
  // human learns that a subscription payment was returned.
  args.log?.error(
    {
      moneyEvent: 'membership-orphan-refund',
      ownerId: locked.ownerId,
      chargeId: locked.id,
      refundId: minted.refundId,
      paymentIntentId: minted.paymentIntentId,
      amountCents: minted.amountCents,
      stripeIdempotencyKey: minted.stripeIdempotencyKey,
    },
    'membership month-1 PaymentIntent settled with no membership behind it — the money is being RETURNED to the card that paid (refund, never reconstruct: §J.1 v1). No subscription was created and no credits were granted',
  );

  return {
    outcome: 'refunded-orphaned-membership-charge',
    note: `membership month-1 charge ${locked.id} settled with no membership; refund ${minted.refundId} minted`,
    pendingStripeRefund: {
      refundId: minted.refundId,
      paymentIntentId: minted.paymentIntentId,
      amountCents: minted.amountCents,
      stripeIdempotencyKey: minted.stripeIdempotencyKey,
    },
  };
}

/**
 * The charge-MISSING half of the month-1 arms: a succeeded PaymentIntent that
 * says it is a membership month-1 charge and has no `charges` row at all.
 *
 * Two producers: the route crashed between Stripe's answer and its own charge
 * write, or the recorded-processing commit itself failed. Either way Stripe is
 * holding the owner's money and nothing here knows.
 *
 * Returns `undefined` — falling through to the package reconstruct and then to
 * `orphan-event`, exactly as today — for anything that fails the trust check.
 * The gate mirrors the reconstruct's: metadata is attacker-shaped input in
 * principle, so `owner_id` and `dog_id` must be present and non-empty. It costs
 * nothing to be strict: a refund can only ever return money to the card that
 * paid THIS PaymentIntent, so no metadata can route money anywhere, and a bogus
 * `owner_id` fails the owners FK loudly.
 *
 * **THE UNSTATED PREMISE, now stated (MR-A2.5(d)6).** This arm's safety rests
 * on a fact about the OTHER lane: **no renewal minter stamps month-1-shaped
 * metadata** — `invoices.ts` and `invoiceAutoCharge.ts` always stamp
 * `invoice_id`, and neither stamps `package_key`. If a future renewal-lane
 * change ever emitted `owner_id` + `dog_id` with no `invoice_id`, this arm
 * would refund a renewal's money unattended. A change there must trip over this
 * sentence rather than discover it in production; the charge-found FLIP arm
 * carries the same premise through {@link isMonthOneFingerprint}.
 *
 * **`created === false` is the race-safety mechanism, not an edge case.** A
 * webhook arriving while the route's transaction is still open BLOCKS on the
 * route's uncommitted unique insert, then reads the committed row and no-ops —
 * so this arm can never refund a charge whose membership exists.
 */
async function maybeRefundOrphanedMembershipCharge(
  tx: Tx,
  args: {
    paymentIntentId: string;
    amountCents: number;
    metadata: Record<string, string>;
    log?: WebhookHandlerLog;
  },
): Promise<WebhookHandlerResult | undefined> {
  if (metadataString(args.metadata, 'purpose') !== 'membership') return undefined;
  // Renewals bill through the invoice lane and carry `invoice_id`; those belong
  // to `maybeSettleOrphanedInvoiceCharge`, which has already run and declined.
  if (metadataString(args.metadata, 'invoice_id') !== undefined) return undefined;
  const ownerId = metadataString(args.metadata, 'owner_id');
  const dogId = metadataString(args.metadata, 'dog_id');
  if (ownerId === undefined || dogId === undefined) return undefined;

  const { charge, created } = await chargesRepository.insertIfAbsentByPaymentIntent(tx, {
    ownerId,
    amountCents: args.amountCents,
    status: 'succeeded',
    purpose: 'membership',
    stripePaymentIntentId: args.paymentIntentId,
    dogId,
  });
  if (!created && (charge.status === 'succeeded' || charge.status === 'refunded')) {
    return {
      outcome: 'charge-already-terminal',
      note: `PI ${args.paymentIntentId} is recorded by another writer and already terminal`,
    };
  }
  return adjudicateMonthOneMembershipCharge(tx, {
    charge,
    alreadySucceeded: created,
    paymentIntentId: args.paymentIntentId,
    amountCents: args.amountCents,
    metadata: args.metadata,
    ...(args.log !== undefined ? { log: args.log } : {}),
  });
}

/**
 * The owner push for a returned month-1 payment (Allison's copy nod, §6). One
 * per charge ever — `enqueueIdempotent` on `membership-orphan-refund:<chargeId>`
 * makes a second delivery a no-op on top of the receiver's `stripe_events`
 * dedupe.
 *
 * Skipped when the PaymentIntent metadata names no dog: there is then no
 * credits surface to open, and a push that lands nowhere is worse than none —
 * the same rule `enqueuePackageFlipPush` follows. The MONEY still goes back
 * either way; only the notification depends on the deep link.
 */
async function enqueueMembershipOrphanRefundPush(
  tx: Tx,
  args: { ownerId: string; chargeId: string; amountCents: number; dogId: string | undefined },
): Promise<void> {
  if (args.dogId === undefined) return;
  await scheduledNotificationsRepository.enqueueIdempotent(tx, {
    ownerId: args.ownerId,
    type: 'payment-failed',
    trigger: 'membership-orphan-refund',
    dedupeKey: `membership-orphan-refund:${args.chargeId}`,
    scheduledFor: new Date(), // immediate — delivered on the next scheduler tick
    title: 'Subscription payment returned',
    body: `Your ${formatDollars(args.amountCents)} subscription payment didn't complete — we've sent it back to your card. No subscription was started and no credits were added. You can start again anytime from Buy Credits.`,
    deepLinkPath: deepLinkToPath({ kind: 'credits', id: args.dogId }),
    deepLinkKind: 'credits',
    deepLinkId: args.dogId,
    dogId: args.dogId,
  });
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
      // Through the helper, like every other timestamptz read: Drizzle hands
      // back PG's space-separated `+00` form, and a bare `new Date` on it is
      // the engine's implementation-defined fallback rather than the ISO path
      // (`lib/pgTimestamp.ts`). This was the one site the 2026-08-12 sweep
      // missed.
      at: pgTimestampToDate(attempt.createdAt),
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
