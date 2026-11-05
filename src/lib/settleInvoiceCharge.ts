import { deepLinkToPath } from '../contracts/wire.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import type { ChargePurpose } from '../db/repositories/chargesRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { creditPackagesRepository } from '../db/repositories/creditPackagesRepository.js';
import { dogProgramsRepository } from '../db/repositories/dogProgramsRepository.js';
import type { InvoiceRow } from '../db/repositories/invoicesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { membershipsRepository } from '../db/repositories/membershipsRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import {
  refundsRepository,
  ROW_KEYED_REFUND_REASON,
} from '../db/repositories/refundsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import { formatDollars, purposeLabel } from './invoiceReceiptCopy.js';
import { nextMonthlyPeriodEnd } from './membershipBilling.js';
import { noticeInSavepoint, type NoticeLog } from './noticeInSavepoint.js';
import type { PendingStripeRefund } from './pendingRefund.js';
import { pgTimestampToDate } from './pgTimestamp.js';

/**
 * The post-Stripe handle the caller fires after commit: on a lost settle race
 * the duplicate charge's refund row is written 'pending' inside the tx, and the
 * caller fires the actual Stripe `createRefund` against `paymentIntentId`
 * post-commit, then persists the `re_*` id via `refundsRepository.markStripeId`.
 *
 * An alias, not a second type, since 2026-08-19: this and
 * `cancelBookingService`'s handle were structurally identical declarations in
 * two files, and the stored idempotency key is exactly the kind of field that
 * gets added to one of those and forgotten on the other. One shape, one fire
 * helper ({@link firePendingRefundPostCommit}), five sites.
 */
export type PendingDuplicateRefund = PendingStripeRefund;

/**
 * Discriminated result so each caller can shape its own honest response:
 *   - 'settled'  -> THIS path won the race; the invoice flipped to paid here.
 *   - 'refunded' -> THIS path LOST the race (another path already settled the
 *     invoice); this charge is a duplicate. The invoice is paid (by the
 *     winner), but THIS request's charge is being reversed. `pendingStripeRefund`
 *     is set when there's money to send back (the common lost-race case) and
 *     undefined only in the defensive zero-refund case (a charge that somehow
 *     already carries a non-failed refund for its full amount).
 */
export type SettleInvoiceChargeResult =
  | { outcome: 'settled'; chargeId: string }
  | {
      outcome: 'refunded';
      chargeId: string;
      pendingStripeRefund: PendingDuplicateRefund | undefined;
    };

export interface SettleInvoiceChargeArgs {
  invoice: InvoiceRow;
  /** A PaymentIntent that ALREADY succeeded at Stripe (this path's own PI). */
  paymentIntentId: string;
  /** Cents actually charged -- Stripe's confirmed amount, not the invoice face. */
  amountCents: number;
  purpose: ChargePurpose;
  /**
   * Whether to emit the `payment-succeeded` receipt when THIS path settles.
   * Every settler says true since P15: the order engine's settle enqueues it, once,
   * in the transaction that moves the charge. The refund (lost-race) branch never
   * notifies.
   */
  notifyOwner: boolean;
  /** Settle instant — the §J.1 membership grant's late-settle floor reads it
   * (see `grantMembershipMonth`). Defaults to wall clock; workers/tests pass
   * their pinned `now`. */
  now?: Date;
  /**
   * Where the NULL-anchor fallback's WARN goes (§A3.19 F2), and a failed notice's
   * alarm. Optional because not every caller has a logger in scope, but a caller that
   * omits it makes the tripwire silent — plumb it.
   */
  log?: AnchorResolutionLog & Partial<NoticeLog>;
}

/** The one thing the anchor fallback needs from a logger. */
export interface AnchorResolutionLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The receipt on today's queue (P15; design §2.7:3888): `scheduled_notifications`,
 * so the push leaves on the next tick after the money (answer 2). `trigger` is
 * `order-confirm` from the owner's own request and `settle` from a webhook or a
 * sweeper (§2.9). Absent, the receipt is the feed row it has always been.
 */
export interface ReceiptPush {
  trigger: 'order-confirm' | 'settle';
  scheduledFor: Date;
}

/**
 * The ONE post-Stripe invoice-settlement primitive every settle path calls: the
 * worker auto-charge and the webhook's orphan arm here, and the order engine (so
 * `POST /invoices/:id/pay`) through {@link settleChargeAgainstInvoice}, its second
 * half. It runs AFTER a path's own Stripe PaymentIntent has already SUCCEEDED,
 * inside one short tx, and resolves the double-charge race between the paths:
 *
 *   1. INSERT the succeeded `charges` row for this PI.
 *   2. CONDITIONAL `markPaid` -- `invoicesRepository.markPaid` filters
 *      `WHERE id = ? AND status = 'open'`, so the UPDATE row count IS the
 *      atomic claim: whoever flips open->paid first wins (Postgres serializes
 *      the two UPDATEs on the row lock; the loser sees `flipped === 0`).
 *   3a. flipped > 0  -> THIS path settled. Optionally emit the
 *       `payment-succeeded` receipt (only when `notifyOwner`).
 *   3b. flipped === 0 -> THIS path LOST: the other path already settled the
 *       invoice, so this charge double-bills the same money. Write a 'pending'
 *       refund row for the full charge (idempotency-guarded via
 *       `sumNonFailedForCharge`, mirroring cancelBookingService) and emit NO
 *       notification -- the customer is net-charged exactly once, so a
 *       "payment failed" would be a lie.
 *
 * The actual Stripe `createRefund` is NOT fired here (no Stripe call inside a
 * tx -- the project-wide invariant). On the 'refunded' outcome the caller fires
 * it post-commit and persists the `re_*` id, exactly as cancelBookingService's
 * money-back branch does. A refund-API failure leaves the 'pending' row for the
 * webhook's race-recovery / admin retry -- never silently swallowed past the
 * caller's logged post-commit seam.
 */
export async function settleInvoiceCharge(
  tx: Tx,
  args: SettleInvoiceChargeArgs,
): Promise<SettleInvoiceChargeResult> {
  const { invoice, paymentIntentId, amountCents, purpose } = args;

  const charge = await chargesRepository.create(tx, {
    ownerId: invoice.ownerId,
    amountCents,
    status: 'succeeded',
    purpose,
    stripePaymentIntentId: paymentIntentId,
    // The invoice's OWN enrollment anchor (§A3.18 D1), with the §A3.19 F2
    // fallback behind it for invoices that carry none.
    bookingId: await resolveInvoiceAnchorBookingId(tx, invoice, args.log),
    // Carry the enrollment identity so a later group-class withdraw can find +
    // refund this dog's payment (mirrors both prior settle paths).
    cohortId: invoice.cohortId,
    dogId: invoice.dogId,
  });
  return settleChargeAgainstInvoice(tx, { ...args, chargeId: charge.id });
}

/**
 * The second half of {@link settleInvoiceCharge}, for a charge row that already
 * exists: the order engine writes its charge in tx1, so its settle arrives here with
 * the row in hand. Everything the invoice owes the money happens in this one place,
 * so PAY-35 is one arm whoever settles: the claim, or on a lost race the refund.
 */
export async function settleChargeAgainstInvoice(
  tx: Tx,
  args: SettleInvoiceChargeArgs & { chargeId: string; receiptPush?: ReceiptPush },
): Promise<SettleInvoiceChargeResult> {
  const { invoice, paymentIntentId, amountCents, purpose, notifyOwner, chargeId } = args;
  const now = args.now ?? new Date();

  const claimed = await claimInvoiceWithCharge(tx, {
    invoice,
    chargeId,
    amountCents,
    purpose,
    notifyOwner,
    now,
    ...(args.receiptPush !== undefined ? { receiptPush: args.receiptPush } : {}),
    ...(args.log?.error !== undefined ? { log: args.log as NoticeLog } : {}),
  });
  if (claimed) return { outcome: 'settled', chargeId };

  // Lost the race: the invoice was already settled by the other path. This
  // charge double-bills the same money -> refund it.
  //
  // **This arm also serves the VOIDED invoice** — a withdraw voids the invoice
  // while its PaymentIntent is still settling, and the webhook lands minutes
  // later (`stripeEventHandlers.ts` — "invoice void (withdrawn before the
  // charge resolved) → same lost-race arm"). `markPaid` filters
  // `status = 'open'`, so a void invoice yields `flipped = 0` and arrives here.
  // The money MOVED, so the ledger row is written and this returns it. That is
  // the whole return path for §A3.18 D1's dead money, and it already existed.
  //
  // Capped and idempotency-guarded through the one shared helper (§A3.18 D2):
  // it locks the charge row, sums the non-failed refunds and mints at most the
  // remainder, so a re-run that finds the full amount already pending-refunded
  // creates no second row — exactly as cancelBookingService's money-back branch
  // does, through the same function. The charge was INSERTed by this same
  // transaction, so the lock is already ours and costs nothing here; the
  // uniformity is the point, because open-coding lock-sum-cap-mint at each of
  // six legs is how the seventh forgets the lock.
  //
  // The row's uuid is minted app-side inside the helper, because this lane's
  // Stripe key is derived from it — the key has to exist before the INSERT that
  // stores it. Storing it converges this lane on the same one honest claim
  // predicate as every other writer instead of leaving `reason` to carry the
  // meaning (design §2.1).
  const minted = await refundsRepository.mintCappedPendingRefund(tx, {
    chargeId,
    ownerId: invoice.ownerId,
    bookingId: invoice.bookingId,
    // Load-bearing since 2026-08-12: this exact string is what the
    // `duplicate-refund-retry` sweep's LEGACY lane claims on, because it means
    // "this row's Stripe key is `duplicateRefundIdempotencyKey(row.id)`". Rows
    // minted from here on also carry that key in the column above, so the
    // legacy lane matters only for rows already on disk.
    reason: ROW_KEYED_REFUND_REASON,
    stripeIdempotencyKey: duplicateRefundIdempotencyKey,
  });
  if (minted.kind !== 'minted') {
    return { outcome: 'refunded', chargeId, pendingStripeRefund: undefined };
  }

  return {
    outcome: 'refunded',
    chargeId,
    pendingStripeRefund: {
      refundId: minted.refundId,
      paymentIntentId,
      amountCents: minted.amountCents,
      stripeIdempotencyKey: minted.stripeIdempotencyKey,
    },
  };
}

/**
 * What `charges.booking_id` must be for a charge settling this invoice.
 *
 * Normally: the invoice's own stamp, copied. A group-class invoice is minted
 * inside the enroll tx that created its bookings (§A3.18 D1), so it names the
 * enrollment this money was actually for — even when that enrollment was
 * withdrawn minutes ago and this settle is the late webhook landing.
 *
 * **When the invoice carries NO anchor, resolve it by same-transaction
 * equality** (§A3.19 F2). §A3.18 claimed no post-deploy path could mint a NULL
 * anchor; two doors kept producing them, both executed:
 *
 *   · a group-class invoice minted BEFORE the stamp existed — a population
 *     that drains on `due_at` horizons measured in WEEKS, not a deploy-second;
 *   · `invoices.booking_id` is `ON DELETE SET NULL`, so an ops script that
 *     hard-deletes an anchor row silently orphans the invoice. (§A3.18's ops
 *     warning covered only the charges-side FK, which THROWS — the loud
 *     direction; this side is silent, and silence is what re-opens a money
 *     defect.)
 *
 * Copying NULL is NOT neutral: the charge is minted NOW, so the legacy time
 * rule (`created_at >= bornAt`) hands it to whatever enrollment is live at
 * settle time — precisely the adjudicated-BLOCKER shape. The witness
 * (`bookings.created_at = invoices.issued_at`) is exact, so it names the right
 * enrollment's rows whatever their status.
 *
 * **This readmits §A3.18.9.2 deliberately, and only here.** That rejection's
 * reasoning was "reconstruction where a stamp EXISTS"; for these rows no stamp
 * exists, and the same honest-inference rationale that licenses the legacy time
 * rule licenses this narrower, EXACT inference. For stamped rows the rejection
 * stands untouched — this function returns the stamp without looking.
 *
 * Every firing WARNs: expected while the legacy population drains, notable
 * afterwards. A miss mints NULL and WARNs louder, with the legacy time rule
 * still behind it as the net.
 */
export async function resolveInvoiceAnchorBookingId(
  tx: Tx,
  invoice: Pick<InvoiceRow, 'id' | 'purpose' | 'bookingId' | 'cohortId' | 'dogId'>,
  log?: AnchorResolutionLog,
): Promise<string | null> {
  if (invoice.purpose !== 'group-class' || invoice.cohortId === null || invoice.dogId === null) {
    return invoice.bookingId;
  }
  if (invoice.bookingId !== null) return invoice.bookingId;

  const resolved = await bookingsRepository.findAnchorByInvoiceIssuedAt(tx, {
    invoiceId: invoice.id,
    cohortId: invoice.cohortId,
    dogId: invoice.dogId,
  });
  if (resolved === undefined) {
    log?.warn(
      { invoiceId: invoice.id, cohortId: invoice.cohortId, dogId: invoice.dogId },
      'group-class invoice has NO enrollment anchor and none could be proven: no booking row shares its transaction instant, so this charge is minted UNANCHORED and the legacy time rule will attribute it by timestamp — check whether this money belongs to the enrollment that is live now',
    );
    return null;
  }
  log?.warn(
    {
      invoiceId: invoice.id,
      cohortId: invoice.cohortId,
      dogId: invoice.dogId,
      resolvedBookingId: resolved,
    },
    'group-class invoice carried no enrollment anchor; resolved it from the booking rows written in the same transaction (expected while pre-stamp invoices drain, worth investigating afterwards)',
  );
  return resolved;
}

/**
 * **The settle-half**: claim the invoice for a charge that already exists, and
 * do everything winning that claim implies.
 *
 * Factored out for §A3.19 F1, which gave the capture reconciler a reason to
 * settle an invoice: a `requires_payment` group-class charge whose intent
 * succeeded, covering a LIVE enrollment whose money is an OPEN invoice, is not
 * surplus — it is that invoice's own payment, arrived late. Two callers now
 * share ONE implementation of "the invoice is settled", so the receipt, the
 * reminder teardown and the membership grant cannot be present on one path and
 * forgotten on the other.
 *
 * The `markPaid` claim is the atomic arbiter, unchanged: it filters
 * `status = 'open'`, so the UPDATE row count IS the claim (R11's guard), and a
 * caller that loses it must decide what its charge is instead.
 *
 * Returns `true` iff THIS call won.
 */
export async function claimInvoiceWithCharge(
  tx: Tx,
  args: {
    invoice: InvoiceRow;
    chargeId: string;
    amountCents: number;
    purpose: ChargePurpose;
    notifyOwner: boolean;
    now?: Date;
    /** Set: the receipt goes on the push queue. Unset: the feed row it always was. */
    receiptPush?: ReceiptPush;
    /** A failed receipt's alarm. Unset, it goes to stderr rather than nowhere. */
    log?: NoticeLog;
  },
): Promise<boolean> {
  const { invoice, chargeId, amountCents, purpose, notifyOwner } = args;
  const flipped = await invoicesRepository.markPaid(tx, {
    id: invoice.id,
    paidChargeId: chargeId,
  });
  if (flipped === 0) return false;

  // The invoice is settled — any pending pay-in-person reminder ("bring $… at
  // drop-off") is now stale money-already-collected noise. Tear it down in the
  // settle tx (D4's in-tx reminder-teardown precedent). A no-op for a plain
  // card invoice (no `payment-due:` row was ever enqueued).
  await scheduledNotificationsRepository.cancelPendingByDedupePrefix(
    tx,
    `payment-due:${invoice.id}`,
  );
  if (invoice.purpose === 'membership' && invoice.membershipId !== null) {
    await grantMembershipMonth(tx, { invoice, chargeId, now: args.now ?? new Date() });
  }
  if (notifyOwner) {
    // A notice never un-records money (design §2.7:3993-3998): its own savepoint,
    // its body composed inside it, and on any error one alarm and the money commits.
    const dedupeKey = `receipt:${chargeId}`;
    const { receiptPush } = args;
    await noticeInSavepoint(
      tx,
      { subject: { chargeId }, dedupeKey, log: args.log ?? STDERR_NOTICE_LOG },
      async (sp) => {
        const receipt = {
          ownerId: invoice.ownerId,
          type: 'payment-succeeded',
          title: 'Payment received',
          body: `We charged your card ${formatDollars(amountCents)} for your ${purposeLabel(
            purpose,
          )}.`,
          deepLinkPath: deepLinkToPath({ kind: 'invoice', id: invoice.id }),
          deepLinkKind: 'invoice',
          deepLinkId: invoice.id,
        } as const;
        if (receiptPush === undefined) {
          await notificationsRepository.enqueue(sp, {
            ...receipt,
            dogIds: invoice.dogId ? [invoice.dogId] : [],
          });
          return;
        }
        await scheduledNotificationsRepository.enqueueIdempotent(sp, {
          ...receipt,
          trigger: receiptPush.trigger,
          dedupeKey,
          scheduledFor: receiptPush.scheduledFor,
          ...(invoice.dogId !== null ? { dogId: invoice.dogId } : {}),
        });
      },
    );
  }
  return true;
}

/** For the settlers with no logger in scope: an alarm goes somewhere a human can read. */
const STDERR_NOTICE_LOG: NoticeLog = {
  error(obj, msg) {
    process.stderr.write(`${msg ?? ''} ${JSON.stringify(obj)}\n`);
  },
};

/**
 * THE Stripe idempotency key for a lost-race duplicate refund. Keyed on OUR
 * refund row's uuid, which is why the retry sweep could exist for this lane at
 * all before there was a column to store keys in: the key is reconstructible
 * from durable state forever, so a retry of a `createRefund` whose response was
 * lost REPLAYS the original refund instead of sending a second one.
 *
 * Since 2026-08-19 the mint above also WRITES this string onto the row, so
 * there is one spelling and one source: this function. It keeps its
 * single-source role for both the legacy rows already on disk (which the
 * sweep's fallback reconstructs) and the alarm line that prints the key a human
 * should search Stripe for.
 *
 * The post-commit fire itself moved to `lib/pendingRefund.ts`
 * ({@link firePendingRefundPostCommit}) — all five money-back writers now share
 * one helper and one params constructor, because a same-key retry only replays
 * when the parameters match byte-for-byte.
 */
export function duplicateRefundIdempotencyKey(refundId: string): string {
  return `dup-settle-refund:${refundId}`;
}

/**
 * §J.1 — the WINNING settle of a `purpose='membership'` invoice grants that
 * month's credit lot (`reason='membership-grant'`). Expiry (alumni dogs NULL,
 * §J.3) is the end of the period THIS INVOICE billed — recomputed from
 * `invoice.due_at` (the period start the roll stamped), NOT the membership's
 * live `current_period_end`: a parked invoice can settle via the manual
 * `POST /invoices/:id/pay` months later, after further rolls moved (or a
 * completion froze) `current_period_end`, which would stamp the wrong
 * period — including one already past, a lot dead at birth.
 *
 * Late-settle floor: when the billed period has ALREADY ended at settle
 * time, the owner is paying a full month's price for it — grant a fresh
 * clamped month from `now` instead of dead credits. The period-scoped expiry
 * is what a "X days left to use X credits" reminder would read — but the
 * scheduler's credits-expiring scan is retired at 2.0.0 (S01: it read the
 * legacy 60-day lead), so no such reminder is sent until CRED-U13 builds the
 * real notice off `cred.expiry_warning_lead_days` (7.1.0).
 *
 * The late settle ALSO re-aligns the membership clock (roll-while-parked
 * ruling, 2026-07-16): while this invoice sat open the roll skipped the
 * membership (`lockDueForRoll`'s open-invoice predicate), so
 * `current_period_end` froze in the past. `alignPeriodAfterLateSettle` moves
 * the current period onto the freshly-granted month so the next roll bills
 * when THIS month is used up — never a catch-up cascade over the parked gap.
 * The verb self-filters to active + un-paused rows; a completed/canceled
 * clock stays frozen (the grant still lands — the owner paid) and a
 * staff-paused one is `resume`'s gap-shift to move.
 *
 * The loads throw on missing rows rather than skip: a membership invoice
 * whose membership/package can't be resolved is corrupt state, and silently
 * settling it would take the owner's money without granting credits. The
 * throw rolls back this settle; the invoice stays open for retry/park and
 * the staff worklist surfaces it.
 */
async function grantMembershipMonth(
  tx: Tx,
  args: { invoice: InvoiceRow; chargeId: string; now: Date },
): Promise<void> {
  const { invoice, chargeId, now } = args;
  if (invoice.membershipId === null) {
    throw new Error(`settleInvoiceCharge: invoice ${invoice.id} has no membership_id`);
  }
  const membership = await membershipsRepository.findById(tx, invoice.membershipId);
  if (membership === undefined) {
    throw new Error(`settleInvoiceCharge: membership ${invoice.membershipId} not found`);
  }
  const pkg = await creditPackagesRepository.findById(tx, membership.packageId);
  if (pkg === undefined) {
    throw new Error(`settleInvoiceCharge: credit package ${membership.packageId} not found`);
  }
  const billedPeriodEnd = nextMonthlyPeriodEnd(pgTimestampToDate(invoice.dueAt));
  const isLateSettle = billedPeriodEnd <= now;
  const expiresAt = isLateSettle ? nextMonthlyPeriodEnd(now) : billedPeriodEnd;
  const dogIsAlumni = await dogProgramsRepository.isAlumni(membership.dogId, tx);
  await creditLedgerRepository.creditPurchase(tx, {
    dogId: membership.dogId,
    mode: pkg.mode,
    location: pkg.location,
    delta: pkg.credits,
    packageId: pkg.id,
    chargeId,
    expiresAt: dogIsAlumni ? null : expiresAt,
    reason: 'membership-grant',
  });
  if (isLateSettle) {
    await membershipsRepository.alignPeriodAfterLateSettle(tx, {
      id: membership.id,
      periodStart: now,
      periodEnd: nextMonthlyPeriodEnd(now),
    });
  }
}
