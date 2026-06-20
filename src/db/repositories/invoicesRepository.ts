import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { invoices } from '../schema/schema.js';
import type { ChargePurpose } from './chargesRepository.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `invoices` (schema.sql ~line 763). The pay-later
 * settlement path for B&T approval + group-class enrollment. Distinct
 * from `charges` (an immediate PaymentIntent): an invoice is amount-
 * owed-but-unpaid. When later paid, a `charge` is created and the
 * invoice flips to `'paid'` with `paid_charge_id` + `paid_at` set.
 *
 * Lifecycle (Day 15):
 *   - INSERT at status='open' (POST /requests/:id/confirm-payment
 *     pay-later branch).
 *   - `markPaid` inside the tx that creates the settling `charges` row
 *     (POST /invoices/:id/pay succeeded path + the worker auto-charge
 *     succeeded path).
 *   - Dunning fields (`auto_charge_attempts` + `next_attempt_at`):
 *     incremented by the worker on Stripe failures with backoff.
 *
 * Anti-scam invariant (§G): `payment_method_id` is NOT NULL. Every
 * invoice is card-backed; the worker auto-charges at `due_at` and
 * retries on transient failures.
 */

export type InvoiceStatus = 'open' | 'paid' | 'void';

export interface InvoiceRow {
  id: string;
  ownerId: string;
  amountCents: number;
  status: InvoiceStatus;
  purpose: ChargePurpose;
  bookingId: string | null;
  cohortId: string | null;
  dogId: string | null;
  requestId: string | null;
  paymentMethodId: string;
  paidChargeId: string | null;
  dueAt: string;
  nextAttemptAt: string | null;
  autoChargeAttempts: number;
  paidAt: string | null;
}

const INVOICE_PROJECTION = {
  id: invoices.id,
  ownerId: invoices.ownerId,
  amountCents: invoices.amountCents,
  status: invoices.status,
  purpose: invoices.purpose,
  bookingId: invoices.bookingId,
  cohortId: invoices.cohortId,
  dogId: invoices.dogId,
  requestId: invoices.requestId,
  paymentMethodId: invoices.paymentMethodId,
  paidChargeId: invoices.paidChargeId,
  dueAt: invoices.dueAt,
  nextAttemptAt: invoices.nextAttemptAt,
  autoChargeAttempts: invoices.autoChargeAttempts,
  paidAt: invoices.paidAt,
} as const;

export const invoicesRepository = {
  /**
   * Look up one invoice by id + owner. The owner filter is the
   * 404-collapse pattern — id enumeration shouldn't surface "exists
   * but not yours" vs "not exists". Polymorphic runner so the
   * invoice-pay route can pre-validate against the pool then re-read
   * inside its mutation tx.
   */
  async findByIdForOwner(
    runner: Runner,
    args: { id: string; ownerId: string },
  ): Promise<InvoiceRow | undefined> {
    const [row] = await runner
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(and(eq(invoices.id, args.id), eq(invoices.ownerId, args.ownerId)))
      .limit(1);
    return row;
  },

  /**
   * INSERT an open invoice. Used by `POST /requests/:id/confirm-payment`
   * pay-later branch (B&T) and (Day-19 portal extension) future ad-hoc
   * invoice flows. `next_attempt_at` defaults to `due_at` so the worker
   * scoops it at first scan after `due_at`; explicit override lets the
   * caller delay the first attempt (e.g. invoice issued today, first
   * auto-charge attempt scheduled for due_at).
   */
  async createOpen(
    tx: Tx,
    args: {
      ownerId: string;
      amountCents: number;
      purpose: ChargePurpose;
      paymentMethodId: string;
      dueAt: string;
      nextAttemptAt?: string;
      bookingId?: string | null;
      cohortId?: string | null;
      dogId?: string | null;
      requestId?: string | null;
    },
  ): Promise<InvoiceRow> {
    const [row] = await tx
      .insert(invoices)
      .values({
        ownerId: args.ownerId,
        amountCents: args.amountCents,
        purpose: args.purpose,
        paymentMethodId: args.paymentMethodId,
        dueAt: args.dueAt,
        nextAttemptAt: args.nextAttemptAt ?? args.dueAt,
        bookingId: args.bookingId ?? null,
        cohortId: args.cohortId ?? null,
        dogId: args.dogId ?? null,
        requestId: args.requestId ?? null,
      })
      .returning(INVOICE_PROJECTION);
    if (!row) {
      throw new Error('invoicesRepository.createOpen: INSERT returned no row');
    }
    return row;
  },

  /**
   * Flip status → 'paid' + stamp `paid_charge_id` + `paid_at`. Called
   * inside the same tx that INSERTs the settling `charges` row so the
   * (invoice, charge) link is atomic. Returns the row count so the
   * caller can detect a race (a webhook handler that processed first).
   *
   * Filters on `status = 'open'` so a duplicate call after the webhook
   * already settled the invoice is a no-op (returns 0) — the caller's
   * surface (POST /invoices/:id/pay) is idempotent by idempotency-key,
   * but defense-in-depth.
   */
  async markPaid(tx: Tx, args: { id: string; paidChargeId: string }): Promise<number> {
    const updated = await tx
      .update(invoices)
      .set({
        status: 'paid',
        paidChargeId: args.paidChargeId,
        paidAt: sql`now()`,
      })
      .where(and(eq(invoices.id, args.id), eq(invoices.status, 'open')))
      .returning({ id: invoices.id });
    return updated.length;
  },

  /**
   * Flip an OPEN invoice → 'void' (Δ 2026-06-09). The group-class withdraw
   * verb's pay-later branch: cancelling an enrollment before the auto-charge
   * fires voids the open invoice so the worker (which scans `status='open'`)
   * never charges it — "nothing is ever charged". Filtered on `status='open'`
   * so it can't reverse an already-paid invoice (that path is a refund, not a
   * void); returns the row count for the caller to detect that race.
   */
  async markVoid(tx: Tx, args: { id: string }): Promise<number> {
    const updated = await tx
      .update(invoices)
      .set({ status: 'void', nextAttemptAt: null })
      .where(and(eq(invoices.id, args.id), eq(invoices.status, 'open')))
      .returning({ id: invoices.id });
    return updated.length;
  },

  /**
   * The open group-class invoice for one (cohort, dog) enrollment, if any —
   * the withdraw verb's "is this dog's enrollment an unpaid pay-later?" probe.
   * Only `status='open'` (a paid one is a charge-refund, not a void).
   */
  async findOpenForCohortDog(
    tx: Tx,
    args: { cohortId: string; dogId: string },
  ): Promise<InvoiceRow | undefined> {
    const [row] = await tx
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(
        and(
          eq(invoices.cohortId, args.cohortId),
          eq(invoices.dogId, args.dogId),
          eq(invoices.status, 'open'),
        ),
      )
      .limit(1);
    return row;
  },

  /**
   * The open PAYG invoice for one booking, if any — the booking-cancel verb's
   * "is there a pending auto-charge to void?" probe. A within-window cancel
   * voids it (nothing is ever charged); past-window leaves it (it charges =
   * forfeit). Only `status='open'` (a settled one is a charge-refund, handled
   * by the cancel money-back branch). `purpose='payg'` is the only booking-
   * linked invoice today, but the filter keeps the read honest as invoice
   * kinds grow.
   */
  async findOpenForBooking(tx: Tx, args: { bookingId: string }): Promise<InvoiceRow | undefined> {
    const [row] = await tx
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(
        and(
          eq(invoices.bookingId, args.bookingId),
          eq(invoices.status, 'open'),
          eq(invoices.purpose, 'payg'),
        ),
      )
      .limit(1);
    return row;
  },

  /**
   * Worker scan: open invoices whose `next_attempt_at` is due. Uses
   * `FOR UPDATE SKIP LOCKED` so concurrent worker instances can divide
   * the queue without blocking each other. Limit caps batch size for
   * predictable per-tick work; the caller iterates within the tx so
   * the lock is held until each invoice's processing completes.
   *
   * Default limit of 50 mirrors the Day-16 scheduler's expected per-
   * tick budget — enough to drain a backlog quickly without hogging
   * connections. Day-16's scheduler tunes this from a config knob.
   */
  async lockDueOpenForUpdate(
    tx: Tx,
    args: { limit?: number; now?: Date } = {},
  ): Promise<InvoiceRow[]> {
    const limit = args.limit ?? 50;
    const cutoff = args.now
      ? sql`${invoices.nextAttemptAt} <= ${args.now.toISOString()}::timestamptz`
      : sql`${invoices.nextAttemptAt} <= now()`;
    // Drizzle's `.for('update', { skipLocked: true })` builds FOR UPDATE
    // SKIP LOCKED. Locks released on tx commit/rollback — exactly the
    // worker's per-invoice unit of work.
    return tx
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(and(eq(invoices.status, 'open'), isNotNull(invoices.nextAttemptAt), cutoff))
      .orderBy(asc(invoices.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true });
  },

  /**
   * Lease a batch of due open invoices for processing OUTSIDE a transaction.
   * Locks the due rows (`FOR UPDATE SKIP LOCKED` so parallel workers divide
   * the queue) and pushes `next_attempt_at` to `leaseUntil` so no other
   * worker re-scoops them while THIS worker does the Stripe round-trip with
   * no DB tx open — that's what keeps the Stripe call off the transaction's
   * latency budget (vs the old `lockDueOpenForUpdate`, which held the row
   * lock across the network call for the whole batch).
   *
   * Returned rows carry the PRE-lease `auto_charge_attempts` (the UPDATE
   * doesn't touch that column); the worker keys Stripe idempotency on it. A
   * worker crash before it records the outcome leaves the lease to expire,
   * and the attempt-keyed idempotency makes the re-lease safe (Stripe returns
   * the same PI — no double charge).
   */
  async leaseDueOpen(
    tx: Tx,
    args: { limit?: number; now?: Date; leaseUntil: Date },
  ): Promise<InvoiceRow[]> {
    const limit = args.limit ?? 50;
    const cutoff = args.now
      ? sql`${invoices.nextAttemptAt} <= ${args.now.toISOString()}::timestamptz`
      : sql`${invoices.nextAttemptAt} <= now()`;
    const due = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.status, 'open'), isNotNull(invoices.nextAttemptAt), cutoff))
      .orderBy(asc(invoices.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(invoices)
      .set({ nextAttemptAt: args.leaseUntil.toISOString() })
      .where(
        inArray(
          invoices.id,
          due.map((r) => r.id),
        ),
      )
      .returning(INVOICE_PROJECTION);
  },

  /**
   * Worker dunning: increment attempts + reschedule the next attempt.
   * Called inside the worker's per-invoice tx after a Stripe failure.
   * `nextAttemptAt = null` parks the invoice (e.g. exhausted retries
   * → staff notification + manual resolution).
   */
  async recordFailedAttempt(
    tx: Tx,
    args: { id: string; nextAttemptAt: string | null },
  ): Promise<number> {
    const updated = await tx
      .update(invoices)
      .set({
        autoChargeAttempts: sql`auto_charge_attempts + 1`,
        nextAttemptAt: args.nextAttemptAt,
      })
      .where(eq(invoices.id, args.id))
      .returning({ id: invoices.id });
    return updated.length;
  },

  /**
   * Owner-scoped list of open invoices — used by the `GET /invoices`
   * surface (Day-18+ FE swap) and the worker scan can prefilter by
   * owner if it ever wants per-owner fairness scheduling.
   * `lte(invoices.dueAt, now)` not applied here — that's the worker's
   * call; this read surface returns all open invoices the owner can see.
   */
  async findOpenByOwner(runner: Runner, ownerId: string): Promise<InvoiceRow[]> {
    return runner
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(and(eq(invoices.ownerId, ownerId), eq(invoices.status, 'open')));
  },

  /**
   * Day-18 FE swap convenience — every open invoice past its due date,
   * regardless of owner. Pool runner. Not currently called by any
   * production route; reserved for the Day-19 staff portal.
   */
  async findPastDueOpen(runner: Runner, now: Date): Promise<InvoiceRow[]> {
    return runner
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(and(eq(invoices.status, 'open'), lte(invoices.dueAt, now.toISOString())));
  },
};
