import { creditPackagesRepository } from '../db/repositories/creditPackagesRepository.js';
import { invoicesRepository } from '../db/repositories/invoicesRepository.js';
import {
  membershipsRepository,
  type MembershipRow,
} from '../db/repositories/membershipsRepository.js';
import { notificationsRepository } from '../db/repositories/notificationsRepository.js';
import type { Tx } from '../db/tx.js';
import { nextMonthlyPeriodEnd } from './membershipBilling.js';
import { pgTimestampToDate } from './pgTimestamp.js';

/**
 * §J.1 membership ROLL — the scheduler phase that opens each subscription's
 * next month. For every ACTIVE, un-paused membership with NO open invoice
 * whose `current_period_end <= now` (claimed under FOR UPDATE SKIP LOCKED —
 * the open-invoice skip is the roll-while-parked ruling, 2026-07-16: an
 * unpaid month freezes the subscription instead of stacking debt; a late
 * settle re-aligns the clock and resumes it, see
 * `membershipsRepository.alignPeriodAfterLateSettle`. Known edge: no staff
 * verb VOIDS a membership invoice today — if one ever lands, it must re-align
 * the clock the same way, or the next ticks catch-up-bill the frozen gap):
 *
 *   - **Term exhausted** ⇒ `status='completed'` + a `membership-ended` feed
 *     notification (the §J.1 HARD STOP — no auto-renew, no month-to-month
 *     tail). Exhaustion is a COUNT, not a date
 *     compare: `periods billed = 1 (month-1 sync charge) + count of this
 *     membership's invoices`; a term of N months bills exactly N periods.
 *     Date compares mis-bill on clamped end-of-month boundaries and after a
 *     pause-resume shift; the count is exact under both.
 *   - **Else** ⇒ advance the period (start = old end, end = next anchored
 *     boundary) and create a card-backed `invoices` row
 *     (`purpose='membership'`, `membership_id` set, `due_at` = the new
 *     period's start — already ≤ now, so the EXISTING auto-charge worker
 *     scoops it on its next pass and `settleInvoiceCharge` grants the
 *     month's lot on the winning settle). Retries/dunning/parking + the
 *     payment-failed push are all inherited from that lane.
 *
 * Runs inside ONE caller-provided tx (the scheduler phase's withActor) —
 * advance + invoice are atomic per membership, and a mid-roll crash rolls
 * back cleanly for the next tick.
 */

export interface MembershipRollResult {
  /** Due memberships claimed this tick. */
  scanned: number;
  /** Periods opened (invoice created + period advanced). */
  rolled: number;
  /** Memberships that hit the §J.1 hard stop this tick. */
  completed: number;
}

export async function rollDueMemberships(tx: Tx, now: Date): Promise<MembershipRollResult> {
  const due = await membershipsRepository.lockDueForRoll(tx, { now });

  let rolled = 0;
  let completed = 0;
  for (const membership of due) {
    const invoicedPeriods = await invoicesRepository.countForMembership(tx, membership.id);
    const periodsBilled = 1 + invoicedPeriods;
    if (periodsBilled >= membership.termMonths) {
      await membershipsRepository.complete(tx, membership.id);
      // §J.1: the subscribe page promises "we'll let you know when your
      // subscription ends" — the hard stop keeps it. Feed-only (like the
      // payment-succeeded receipt): informational, nothing to act on.
      await notificationsRepository.enqueue(tx, {
        ownerId: membership.ownerId,
        type: 'membership-ended',
        title: 'Your subscription has ended',
        body: endedBody(membership),
        deepLinkPath: '/account/memberships',
        dogIds: [membership.dogId],
      });
      completed += 1;
      continue;
    }

    const pkg = await creditPackagesRepository.findById(tx, membership.packageId);
    if (pkg === undefined) {
      // FK-protected (ON DELETE RESTRICT) — can't happen; fail loudly rather
      // than bill an unknown amount.
      throw new Error(`membershipRoll: credit package ${membership.packageId} not found`);
    }

    // Anchored on the period's OWN start day (not started_at's): after a
    // pause-resume gap-shift moved the boundary, an original-anchor snap
    // could open a days-long "month" billed at full price. Every period is
    // start + 1 clamped month; the COUNT-based hard stop absorbs the drift.
    const periodStart = pgTimestampToDate(membership.currentPeriodEnd);
    const periodEnd = nextMonthlyPeriodEnd(periodStart);
    await membershipsRepository.advancePeriod(tx, {
      id: membership.id,
      periodStart,
      periodEnd,
    });
    await invoicesRepository.createOpen(tx, {
      ownerId: membership.ownerId,
      amountCents: pkg.price_cents,
      purpose: 'membership',
      paymentMethodId: membership.paymentMethodId,
      dueAt: periodStart.toISOString(),
      dogId: membership.dogId,
      membershipId: membership.id,
    });
    rolled += 1;
  }

  return { scanned: due.length, rolled, completed };
}

function endedBody(membership: MembershipRow): string {
  const modeLabel = membership.mode === 'daycare' ? 'Day Care' : 'Day School';
  return `Your ${membership.termMonths}-month ${modeLabel} credit subscription has finished its term. Start a new one anytime from Buy Credits.`;
}
