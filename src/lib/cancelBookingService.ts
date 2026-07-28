import { deepLinkToPath } from '../contracts/wire.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { chargesRepository } from '../db/repositories/chargesRepository.js';
import { creditLedgerRepository } from '../db/repositories/creditLedgerRepository.js';
import { dogProgramsRepository } from '../db/repositories/dogProgramsRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import { refundsRepository } from '../db/repositories/refundsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import type { ServiceCategory } from './bookingBucket.js';
import type { BookingWire } from './bookingWire.js';
import { ApiError } from './errors.js';
import { wireManyBookings } from './wireManyBookings.js';

export interface PendingStripeRefund {
  refundId: string;
  paymentIntentId: string;
  amountCents: number;
}

export interface CancelBookingResult {
  wire: BookingWire;
  /**
   * Set on the money-back branch; the caller fires the actual Stripe
   * refund post-commit (the route owns the `withMutation.postCommit`
   * seam). Undefined for forfeit / credit-back / free-service paths.
   */
  pendingStripeRefund?: PendingStripeRefund;
  /**
   * Distinct dog ids that received a credit-back on this cancel. The route
   * wipes each dog's `credits:{dogId}:*` display cache post-commit. Empty on
   * every non-credit-back path (forfeit / money-back / PAYG-void / free).
   */
  creditRefundedDogIds: string[];
}

/**
 * The shared cancel transaction (schema.sql `cancelBooking` contract,
 * line ~1491). Both the owner self-cancel (`POST /bookings/:id/cancel`)
 * and the Day-19 staff-portal cancel (`POST /staff/bookings/:id/cancel`)
 * run this identical body — same forfeit rule (`now > cancel_deadline_at`,
 * resolved in SQL), same credit-back / money-back / forfeit branching,
 * same booking-cancelled notification to the booking's owner. The schema
 * pins the cancel as owner-OR-staff authorized with no separate staff
 * refund policy, so there is exactly one transaction.
 *
 * The only caller difference is ownership scope:
 *   - owner route passes `requireOwnerId = principal.ownerId` → a
 *     cross-owner id collapses to 404 (no enumeration).
 *   - staff route passes `requireOwnerId = null` → cross-owner by design
 *     (`requireStaff` already gated the route).
 *
 * The Stripe refund API call is NOT made here; the money-back branch
 * returns a `pendingStripeRefund` handle the route fires after commit.
 */
export async function cancelBookingInTx(
  tx: Tx,
  args: {
    id: string;
    requireOwnerId: string | null;
    /** WHO cancelled — 'owner' (self-cancel) or 'staff' (the school). R5. */
    cancelledBy: 'owner' | 'staff';
    /** Optional staff-supplied reason line; owner self-cancels omit it. */
    cancelReason?: string;
  },
): Promise<CancelBookingResult> {
  const { id, requireOwnerId, cancelledBy, cancelReason } = args;

  // 1. Row-lock; serialize concurrent cancels. 404 collapses not-found,
  //    expired, and (owner route only) not-yours into one response.
  const row = await bookingsRepository.lockById(tx, id);
  if (
    row === undefined ||
    row.expiredAt !== null ||
    (requireOwnerId !== null && row.ownerId !== requireOwnerId)
  ) {
    throw new ApiError('not_found', `booking ${id} not found`);
  }
  if (row.status === 'cancelled') {
    throw new ApiError('conflict', `booking ${id} is already cancelled`);
  }
  if (row.category === 'group-class') {
    throw new ApiError(
      'invalid_payload',
      'group-class bookings cancel via cohort withdraw — not yet implemented',
    );
  }

  // 2. Soft-cancel. `cancelForfeited` is computed in SQL against the
  //    stamped `cancel_deadline_at`; the resolved value lands on commit.
  //    `cancelledBy` + `cancelReason` (R5) record WHO/WHY for the banner.
  await bookingsRepository.markCancelled(tx, { id, cancelledBy, cancelReason });

  // 3. Re-read so the refund branch reads the resolved `cancelForfeited`
  //    (not the pre-update snapshot).
  const updated = await bookingsRepository.findFullByIdInTx(tx, id);
  if (updated === undefined) {
    throw new Error(`cancelBooking ${id}: row vanished after mark-cancelled`);
  }

  // The booking's open PAYG invoice, if any — its pending auto-charge is voided
  // on a within-window cancel (below), and its pay-in-person reminder is torn
  // down in step 5 (R3). Read once now: the void flips it to 'void', so the id
  // must be captured before then to survive the teardown lookup.
  const linkedOpenInvoice = await invoicesRepository.findOpenForBooking(tx, { bookingId: id });

  // 4. Refund branching — within the cancel window only.
  let pendingStripeRefund: PendingStripeRefund | undefined;
  const creditRefundedDogIds = new Set<string>();
  if (!updated.cancelForfeited) {
    const debits = await creditLedgerRepository.findDebitsForBooking(tx, id);
    if (debits.length > 0) {
      // CREDIT-BACK: one +1 refund row per original debit, routed back to the
      // lot it drew from (or a fresh lot if that lot has since expired).
      // §J.3: an alumni dog's fresh re-mint never expires — one status read
      // per distinct dog, memoized across this booking's debits.
      const now = new Date();
      const alumniByDogId = new Map<string, boolean>();
      for (const debit of debits) {
        let dogIsAlumni = alumniByDogId.get(debit.dogId);
        if (dogIsAlumni === undefined) {
          dogIsAlumni = await dogProgramsRepository.isAlumni(debit.dogId, tx);
          alumniByDogId.set(debit.dogId, dogIsAlumni);
        }
        await creditLedgerRepository.refundForBooking(tx, {
          dogId: debit.dogId,
          mode: debit.mode,
          location: debit.location,
          bookingId: id,
          lotId: debit.lotId,
          lotExpiresAt: debit.lotExpiresAt,
          now,
          dogIsAlumni,
        });
        creditRefundedDogIds.add(debit.dogId);
      }
    } else {
      const charge = await chargesRepository.findSucceededForBooking(tx, id);
      if (charge !== undefined) {
        // MONEY-BACK: refunds row at 'pending'; cumulative-refund rule
        // (refunds ≤ charge) enforced API-side. Stripe call fires
        // post-commit via the returned handle.
        const alreadyRefunded = await refundsRepository.sumNonFailedForCharge(tx, charge.id);
        const maxRefund = charge.amountCents - alreadyRefunded;
        if (maxRefund > 0) {
          const refund = await refundsRepository.createPending(tx, {
            ownerId: row.ownerId,
            chargeId: charge.id,
            bookingId: id,
            amountCents: maxRefund,
            reason: 'cancel',
          });
          if (charge.stripePaymentIntentId !== null) {
            pendingStripeRefund = {
              refundId: refund.id,
              paymentIntentId: charge.stripePaymentIntentId,
              amountCents: maxRefund,
            };
          }
          // Charges with NULL stripe_payment_intent_id are pre-Stripe-wire
          // seeds; the refunds row at 'pending' captures the intent.
        }
      } else {
        // PAYG within-window: void the pending auto-charge so the worker
        // never bills a cancelled session. There's no prior credit debit
        // (PAYG skips it) and no settled charge yet (due_at is ~1h before
        // drop-off, inside the cancel window), so the open invoice is the
        // only money artifact. A genuinely free service (no invoice) is a
        // no-op — the status flip is the full effect.
        if (linkedOpenInvoice !== undefined) {
          await invoicesRepository.markVoid(tx, { id: linkedOpenInvoice.id });
        }
      }
    }
  }
  // Forfeited branch: no refund of any kind.

  // 5. booking-cancelled notification to the booking's owner (dog chips
  //    resolved from booking_dogs).
  const dogJoinRows = await bookingsRepository.findDogsByBookingIds([id]);
  const dogIds = dogJoinRows.map((r) => r.dogId);
  await notificationsRepository.enqueue(tx, {
    ownerId: row.ownerId,
    type: 'booking-cancelled',
    title: 'Booking cancelled',
    body: cancellationBody(row.category, row.scheduledAt, updated.cancelForfeited),
    deepLinkPath: deepLinkToPath({ kind: 'booking', id }),
    deepLinkKind: 'booking',
    deepLinkId: id,
    dogIds,
  });

  // D4: a cancelled booking must never push "reminder tomorrow" / "drop-off
  // tomorrow" — cancel any still-pending reminder rows for it in the same tx.
  await scheduledNotificationsRepository.cancelPendingByDedupePrefix(tx, `booking-reminder:${id}`);
  await scheduledNotificationsRepository.cancelPendingByDedupePrefix(tx, `boarding-24h:${id}`);
  // R3: same rule for a pay-in-person invoice linked to this booking — with no
  // drop-off left, its "bring $… at drop-off" reminder is stale. Keyed by
  // invoice id (`payment-due:<invoiceId>`), so cancel by the captured invoice.
  if (linkedOpenInvoice !== undefined) {
    await scheduledNotificationsRepository.cancelPendingByDedupePrefix(
      tx,
      `payment-due:${linkedOpenInvoice.id}`,
    );
  }

  // 6. Wire the updated row for the response.
  const [wire] = await wireManyBookings([updated]);
  if (wire === undefined) {
    throw new Error(`cancelBooking ${id}: wire assembly returned no row`);
  }
  return { wire, pendingStripeRefund, creditRefundedDogIds: [...creditRefundedDogIds] };
}

/**
 * Notification body for the booking-cancelled push. Brief, category-
 * aware, mentions the forfeit state when applicable so the owner doesn't
 * have to open the booking detail to learn the refund didn't land.
 */
function cancellationBody(
  category: ServiceCategory,
  scheduledAtIso: string,
  forfeited: boolean,
): string {
  const when = new Date(scheduledAtIso).toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
  });
  const noun =
    category === 'boarding'
      ? `boarding stay starting ${when}`
      : category === 'board-and-train'
        ? `board & train starting ${when}`
        : category === 'private-lesson'
          ? `private lesson on ${when}`
          : category === 'day-school'
            ? `day school on ${when}`
            : category === 'day-care'
              ? `day care on ${when}`
              : category === 'evaluation'
                ? `evaluation on ${when}`
                : `session on ${when}`;
  return forfeited
    ? `Your ${noun} is cancelled. The cancellation window has passed — no refund.`
    : `Your ${noun} is cancelled. Refund is on the way.`;
}
