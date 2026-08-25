import { and, asc, desc, eq, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import type { MembershipStatus } from '../../contracts/wire.js';
import { db } from '../client.js';
import { invoices, memberships } from '../schema/schema.js';
import type { BookingMode } from '../../lib/bookingMode.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `memberships` (§J.1, activated 2026-07-09). A
 * membership is a credit-package SUBSCRIPTION: the package's credits granted
 * each month on a recurring self-billed charge, for a committed term of
 * 3/6/9/12 months. `stripe_subscription_id` stays NULL — renewals ride the
 * invoice auto-charge lane (`invoices.membership_id`), not Stripe Billing.
 *
 * Lifecycle:
 *   - **createActive** — POST /memberships after the month-1 sync charge
 *     succeeds; period bounds + ends_at computed by `lib/membershipBilling`.
 *   - **lockDueForRoll** — the scheduler's roll phase claims active, unpaused
 *     rows whose `current_period_end <= now` under FOR UPDATE SKIP LOCKED
 *     (one tx — the roll writes an invoice row, no Stripe call, so no lease
 *     is needed; contrast `invoicesRepository.leaseDueOpen`).
 *   - **advancePeriod** — roll: start = old end, end = next anchored boundary.
 *   - **complete** — term exhausted (billed-period count, see the roll phase).
 *   - **cancel** — owner stop (`DELETE /memberships/:id`); status, not delete.
 *   - **pause / resume** — staff-mediated (§J.1). Resume shifts
 *     `current_period_end` + `ends_at` forward by the pause gap: the clock
 *     stops while paused, so the paid-but-unused remainder of the period (and
 *     the un-billed remainder of the term) survives. The resume ROUTE also
 *     shifts the paid month's granted lot expiry to match
 *     (`creditLedgerRepository.shiftMembershipGrantExpiry`) — the clock stops
 *     for the credits too. Later boundaries chain from each period's own
 *     start (`nextMonthlyPeriodEnd`).
 *
 * The §J columns (`package_id`, `term_months`, `payment_method_id`, period
 * bounds) are nullable in DDL (dormant-era shape) but REQUIRED by this API:
 * every row this repo creates sets them, and the roll scan filters them
 * non-null, so downstream code sees the narrowed `MembershipRow`.
 */

// Re-exported, not redeclared: `MembershipStatus` moved into the wire contract
// in 1.13.0 with the membership shapes (it IS `MembershipWire.status`), so the
// row type and the wire cannot drift apart while both still compile — the
// `ChargeStatus`/`chargesRepository` precedent. NOTE: unlike `ChargeStatus`
// there is no conformance pin behind it, because `memberships.status` is
// CHECK-less `text` (schema.sql:1354) — phase-3 fix 3.1.
export type { MembershipStatus } from '../../contracts/wire.js';

export interface MembershipRow {
  id: string;
  ownerId: string;
  dogId: string;
  mode: BookingMode;
  packageId: string;
  termMonths: number;
  paymentMethodId: string;
  status: MembershipStatus;
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  endsAt: string;
  pausedAt: string | null;
}

const MEMBERSHIP_PROJECTION = {
  id: memberships.id,
  ownerId: memberships.ownerId,
  dogId: memberships.dogId,
  mode: memberships.mode,
  packageId: memberships.packageId,
  termMonths: memberships.termMonths,
  paymentMethodId: memberships.paymentMethodId,
  status: memberships.status,
  startedAt: memberships.startedAt,
  currentPeriodStart: memberships.currentPeriodStart,
  currentPeriodEnd: memberships.currentPeriodEnd,
  endsAt: memberships.endsAt,
  pausedAt: memberships.pausedAt,
} as const;

type ProjectedRow = {
  [K in keyof typeof MEMBERSHIP_PROJECTION]: (typeof memberships.$inferSelect)[K];
};

/**
 * Narrow a projected row to `MembershipRow`. The §J columns are nullable in
 * DDL but every API-created row sets them (and the scans filter non-null);
 * a null here is corrupt data — fail loudly rather than bill wrong.
 */
function narrowRow(row: ProjectedRow): MembershipRow {
  if (
    row.dogId === null ||
    row.packageId === null ||
    row.termMonths === null ||
    row.paymentMethodId === null ||
    row.currentPeriodStart === null ||
    row.currentPeriodEnd === null ||
    row.endsAt === null
  ) {
    throw new Error(`membership ${row.id}: missing §J columns (pre-§J dormant row?)`);
  }
  return {
    id: row.id,
    ownerId: row.ownerId,
    dogId: row.dogId,
    mode: row.mode,
    packageId: row.packageId,
    termMonths: row.termMonths,
    paymentMethodId: row.paymentMethodId,
    // The status column is free text in DDL; this API only ever writes the
    // three §J statuses, so the narrow is safe for API-created rows.
    status: row.status as MembershipStatus,
    startedAt: row.startedAt,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    endsAt: row.endsAt,
    pausedAt: row.pausedAt,
  };
}

/** The roll scan's non-null §J-columns filter (dormant rows never roll). */
function hasSubscriptionColumns() {
  return and(
    isNotNull(memberships.packageId),
    isNotNull(memberships.termMonths),
    isNotNull(memberships.paymentMethodId),
    isNotNull(memberships.currentPeriodEnd),
  );
}

export const membershipsRepository = {
  /** INSERT an active §J.1 subscription after the month-1 charge succeeded. */
  async createActive(
    tx: Tx,
    args: {
      ownerId: string;
      dogId: string;
      mode: BookingMode;
      packageId: string;
      termMonths: number;
      paymentMethodId: string;
      startedAt: Date;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      endsAt: Date;
    },
  ): Promise<MembershipRow> {
    const [row] = await tx
      .insert(memberships)
      .values({
        ownerId: args.ownerId,
        dogId: args.dogId,
        mode: args.mode,
        packageId: args.packageId,
        termMonths: args.termMonths,
        paymentMethodId: args.paymentMethodId,
        status: 'active',
        startedAt: args.startedAt.toISOString(),
        currentPeriodStart: args.currentPeriodStart.toISOString(),
        currentPeriodEnd: args.currentPeriodEnd.toISOString(),
        endsAt: args.endsAt.toISOString(),
      })
      .returning(MEMBERSHIP_PROJECTION);
    if (!row) {
      throw new Error('membershipsRepository.createActive: INSERT returned no row');
    }
    return narrowRow(row);
  },

  /** Every §J membership the owner holds, newest first (all statuses — the
   * FE renders active/completed/canceled distinctly). Dormant-era rows
   * without the §J columns are excluded. */
  async findByOwner(runner: Runner, ownerId: string): Promise<MembershipRow[]> {
    const rows = await runner
      .select(MEMBERSHIP_PROJECTION)
      .from(memberships)
      .where(and(eq(memberships.ownerId, ownerId), hasSubscriptionColumns()))
      .orderBy(desc(memberships.startedAt), memberships.id);
    return rows.map(narrowRow);
  },

  /** One membership by id, cross-owner (worker/settle context). */
  async findById(runner: Runner, id: string): Promise<MembershipRow | undefined> {
    const [row] = await runner
      .select(MEMBERSHIP_PROJECTION)
      .from(memberships)
      .where(eq(memberships.id, id))
      .limit(1);
    return row === undefined ? undefined : narrowRow(row);
  },

  /**
   * The dog's ACTIVE membership for one mode, if any — the uniqueness probe
   * (ruled 2026-07-16: one active membership per (dog, mode); day-school +
   * daycare may coexist on a dog, two of the same mode may not). Paused rows
   * still block — they're `status='active'` and resume into the same slot.
   * Polymorphic runner: the route pre-checks on the pool (friendly 409 before
   * the Stripe charge) and re-checks inside its mutation tx under
   * `withMembershipCreateLock` (the race-loser detection).
   */
  async findActiveForDogMode(
    runner: Runner,
    args: { dogId: string; mode: BookingMode },
  ): Promise<MembershipRow | undefined> {
    const [row] = await runner
      .select(MEMBERSHIP_PROJECTION)
      .from(memberships)
      .where(
        and(
          eq(memberships.dogId, args.dogId),
          eq(memberships.mode, args.mode),
          eq(memberships.status, 'active'),
          hasSubscriptionColumns(),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : narrowRow(row);
  },

  /** One membership by id + owner — the 404-collapse read for owner verbs. */
  async findByIdForOwner(
    runner: Runner,
    args: { id: string; ownerId: string },
  ): Promise<MembershipRow | undefined> {
    const [row] = await runner
      .select(MEMBERSHIP_PROJECTION)
      .from(memberships)
      .where(
        and(
          eq(memberships.id, args.id),
          eq(memberships.ownerId, args.ownerId),
          hasSubscriptionColumns(),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : narrowRow(row);
  },

  /**
   * The roll phase's claim: ACTIVE, un-paused rows whose period has ended,
   * under FOR UPDATE SKIP LOCKED so concurrent ticks divide the queue.
   * Paused rows are skipped ENTIRELY (§J.1: pause = skip rolling); the
   * `memberships_active_roll_idx` partial index serves the status filter.
   *
   * Roll-while-parked ruling (2026-07-16): a membership with ANY open invoice
   * — mid-dunning or parked (`next_attempt_at IS NULL`) — is also skipped, so
   * an unpaid month never stacks debt by opening the next one. Zero-cost on
   * the happy path (a rolled invoice settles minutes later, a month before
   * the next roll is due). The membership resumes automatically: settling the
   * open invoice clears the predicate, and a LATE settle re-aligns the frozen
   * clock via `alignPeriodAfterLateSettle` so ticks never catch-up-bill the
   * parked gap.
   */
  async lockDueForRoll(tx: Tx, args: { limit?: number; now: Date }): Promise<MembershipRow[]> {
    const limit = args.limit ?? 50;
    const rows = await tx
      .select(MEMBERSHIP_PROJECTION)
      .from(memberships)
      .where(
        and(
          eq(memberships.status, 'active'),
          isNull(memberships.pausedAt),
          hasSubscriptionColumns(),
          sql`${memberships.currentPeriodEnd} <= ${args.now.toISOString()}::timestamptz`,
          notExists(
            tx
              .select({ one: sql`1` })
              .from(invoices)
              .where(and(eq(invoices.membershipId, memberships.id), eq(invoices.status, 'open'))),
          ),
        ),
      )
      .orderBy(asc(memberships.currentPeriodEnd))
      .limit(limit)
      .for('update', { skipLocked: true });
    return rows.map(narrowRow);
  },

  /** Roll: open the next period (start = old end, end = next anchored boundary). */
  async advancePeriod(
    tx: Tx,
    args: { id: string; periodStart: Date; periodEnd: Date },
  ): Promise<void> {
    await tx
      .update(memberships)
      .set({
        currentPeriodStart: args.periodStart.toISOString(),
        currentPeriodEnd: args.periodEnd.toISOString(),
      })
      .where(eq(memberships.id, args.id));
  },

  /** Term exhausted — the §J.1 hard stop. Status flip, never delete. */
  async complete(tx: Tx, id: string): Promise<void> {
    await tx
      .update(memberships)
      .set({ status: 'completed' })
      .where(and(eq(memberships.id, id), eq(memberships.status, 'active')));
  },

  /**
   * Owner cancel. Filters `status='active'` so the row count distinguishes
   * "canceled now" (1) from "already completed/canceled" (0) — the route
   * maps 0 to 409. Already-granted lots stay; only future rolls stop.
   */
  async cancel(tx: Tx, args: { id: string; ownerId: string }): Promise<number> {
    const updated = await tx
      .update(memberships)
      .set({ status: 'canceled' })
      .where(
        and(
          eq(memberships.id, args.id),
          eq(memberships.ownerId, args.ownerId),
          eq(memberships.status, 'active'),
        ),
      )
      .returning({ id: memberships.id });
    return updated.length;
  },

  /**
   * Staff pause (§J.1). Filters active + not-already-paused so the row count
   * lets the route 409 an already-paused subscription instead of silently
   * moving `paused_at` (which would corrupt the resume gap-shift).
   */
  async pause(tx: Tx, args: { id: string; staffId: string; now: Date }): Promise<number> {
    const updated = await tx
      .update(memberships)
      .set({ pausedAt: args.now.toISOString(), pausedByStaffId: args.staffId })
      .where(
        and(
          eq(memberships.id, args.id),
          eq(memberships.status, 'active'),
          isNull(memberships.pausedAt),
        ),
      )
      .returning({ id: memberships.id });
    return updated.length;
  },

  /**
   * Staff resume: the clock stopped at `paused_at`, so shift the current
   * period end AND the hard-stop date forward by the pause gap — the owner
   * keeps the paid-but-unused remainder of the period and the un-billed
   * remainder of the term. In-SQL interval math so the shift and the flag
   * clear are one atomic UPDATE. Row count 0 = not active-and-paused → 409.
   */
  async resume(tx: Tx, args: { id: string; now: Date }): Promise<number> {
    const nowIso = args.now.toISOString();
    const updated = await tx
      .update(memberships)
      .set({
        currentPeriodEnd: sql`current_period_end + (${nowIso}::timestamptz - paused_at)`,
        endsAt: sql`ends_at + (${nowIso}::timestamptz - paused_at)`,
        pausedAt: null,
        pausedByStaffId: null,
      })
      .where(
        and(
          eq(memberships.id, args.id),
          eq(memberships.status, 'active'),
          isNotNull(memberships.pausedAt),
        ),
      )
      .returning({ id: memberships.id });
    return updated.length;
  },

  /**
   * Roll-while-parked auto-resume (ruled 2026-07-16). A LATE invoice settle
   * (billed period already over — the same condition as the grant's
   * late-settle floor) means the roll has been skipping this membership while
   * its invoice sat open, freezing `current_period_end` in the past. Re-align
   * the current period with the freshly-granted month ([settle-now,
   * now + 1 clamped month)) and shift `ends_at` by the same delta — SQL SET
   * expressions read the pre-UPDATE row, so the delta uses the old end.
   * Without this, the next ticks would roll every elapsed month at once:
   * catch-up debt for months of no service.
   *
   * Filtered to active + un-paused + forward-only: a completed/canceled clock
   * is frozen by design, and a staff-paused one belongs to `resume`'s
   * gap-shift (shifting both would double-count the overlap). Term exhaustion
   * is COUNT-based, so the shift never changes how many months get billed.
   */
  async alignPeriodAfterLateSettle(
    tx: Tx,
    args: { id: string; periodStart: Date; periodEnd: Date },
  ): Promise<number> {
    const periodEndIso = args.periodEnd.toISOString();
    const updated = await tx
      .update(memberships)
      .set({
        endsAt: sql`ends_at + (${periodEndIso}::timestamptz - current_period_end)`,
        currentPeriodStart: args.periodStart.toISOString(),
        currentPeriodEnd: periodEndIso,
      })
      .where(
        and(
          eq(memberships.id, args.id),
          eq(memberships.status, 'active'),
          isNull(memberships.pausedAt),
          sql`current_period_end < ${periodEndIso}::timestamptz`,
        ),
      )
      .returning({ id: memberships.id });
    return updated.length;
  },
};
