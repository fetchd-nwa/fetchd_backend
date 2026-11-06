import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { invoices } from '../schema/schema.js';
import type { ChargePurpose } from './chargesRepository.js';
import { scheduledNotificationsRepository } from './scheduledNotificationsRepository.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `invoices`. The pay-later settlement path for B&T
 * approval + group-class enrollment. Distinct from `charges` (an immediate
 * PaymentIntent): an invoice is amount-owed-but-unpaid. When later paid, a
 * `charge` is created and the invoice flips to `'paid'` with `paid_charge_id` +
 * `paid_at` set.
 *
 * Lifecycle:
 *   - INSERT at status='open' (the pay-later arms of POST /enrollments and
 *     POST /requests/:id/confirm-payment).
 *   - `markPaid` inside the tx that settles the `charges` row.
 *
 * No worker bills a card on its own (wire 5.0.0-lg4.1, PAY-U15), so `due_at` is
 * a date a person reads, and nothing scans it. `payment_method_id` is nullable
 * since M4.04, though nothing writes a NULL until P25.
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
  /** The card this invoice is bound to. NULL is reachable from P25, not before. */
  paymentMethodId: string | null;
  /** R3: 'card' (the default) or 'in-person' (cash/check due at drop-off). */
  paymentExpected: 'card' | 'in-person';
  paidChargeId: string | null;
  dueAt: string;
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
  paymentExpected: invoices.paymentExpected,
  paidChargeId: invoices.paidChargeId,
  dueAt: invoices.dueAt,
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
   * Look up one invoice by id ALONE — no owner filter, because the caller has no
   * principal to scope by: the order engine's settle, reading the invoice its own
   * order row names.
   *
   * Never reachable from an owner-facing route — those use
   * {@link findByIdForOwner}, whose owner filter is the id-enumeration
   * 404-collapse.
   */
  async findById(runner: Runner, id: string): Promise<InvoiceRow | undefined> {
    const [row] = await runner
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1);
    return row;
  },

  /**
   * Row-lock one invoice: tx1 of an invoice payment, so two tenders on one invoice
   * serialise (design §2.7:3815), with no charge lock held; and a final failure asking
   * whether the invoice is still owed, under its charge lock, so it reads past a settle
   * that has not committed. `NO KEY UPDATE`, because tx1's insert of `orders.invoice_id`
   * already took `KEY SHARE` here, and `FOR UPDATE` on top of that deadlocks two tenders
   * (`db/locks.ts`).
   */
  async lockById(tx: Tx, id: string): Promise<InvoiceRow | undefined> {
    const [row] = await tx
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(eq(invoices.id, id))
      .for('no key update');
    return row;
  },

  /**
   * INSERT an open invoice. Used by the pay-later arms of `POST /enrollments`
   * and `POST /requests/:id/confirm-payment`.
   */
  async createOpen(
    tx: Tx,
    args: {
      ownerId: string;
      amountCents: number;
      purpose: ChargePurpose;
      paymentMethodId: string;
      dueAt: string;
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
   * verb's pay-later branch: cancelling an enrollment voids its open invoice, so
   * the debt ends with nothing charged. Filtered on `status='open'` so it can't
   * reverse an already-paid invoice (that path is a refund, not a void);
   * returns the row count for the caller to detect that race.
   *
   * A void invoice asks for nothing, so its pending pay-in-person reminder ("bring
   * $… at drop-off") ends in the same transaction. It lives here, not at the caller,
   * so no later caller can void an invoice and leave the push behind, and it uses the
   * row's own id, the spelling the reminder was filed under.
   */
  async markVoid(tx: Tx, args: { id: string }): Promise<number> {
    const updated = await tx
      .update(invoices)
      .set({ status: 'void' })
      .where(and(eq(invoices.id, args.id), eq(invoices.status, 'open')))
      .returning({ id: invoices.id });
    for (const row of updated) {
      await scheduledNotificationsRepository.cancelPendingByDedupePrefix(
        tx,
        `payment-due:${row.id}`,
      );
    }
    return updated.length;
  },

  /**
   * R3 flag flip: mark an OPEN invoice she meant to pay by card as pay-in-person
   * (cash/check due at drop-off). Filtered on `status='open' AND
   * payment_expected='card'` so a second call — or a call against a paid/void
   * or already-in-person invoice — is a no-op (returns 0); the route reads that
   * count to 409.
   */
  async markPayInPerson(tx: Tx, args: { id: string }): Promise<number> {
    const updated = await tx
      .update(invoices)
      .set({ paymentExpected: 'in-person' })
      .where(
        and(
          eq(invoices.id, args.id),
          eq(invoices.status, 'open'),
          eq(invoices.paymentExpected, 'card'),
        ),
      )
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
   * The most recent group-class invoice for one (cohort, dog), WHATEVER its
   * status — the withdraw fall-through's "what actually became of this debt?"
   * re-read (§A2.2, 2026-08-24).
   *
   * Deliberately status-blind, unlike {@link findOpenForCohortDog}. It is
   * asked only on the arm where every pending charge row resolved DEAD and the
   * open-invoice read has already come back empty in-tx: the answer decides
   * between "cancelled, never charged" (`void` — an ops void, or a prior
   * crashed withdraw) and "nothing of this enrollment's is left to return"
   * (anything else). Reading only `open` rows there would return nothing and
   * force the arm to guess.
   *
   * Newest-first because a withdraw-then-re-enroll mints a second invoice for
   * the same pair; the enrollment's own is the latest one, and the arm that
   * consults this has already established the earlier ones are not live.
   */
  async findLatestForCohortDog(
    tx: Tx,
    args: { cohortId: string; dogId: string },
  ): Promise<InvoiceRow | undefined> {
    const [row] = await tx
      .select(INVOICE_PROJECTION)
      .from(invoices)
      .where(and(eq(invoices.cohortId, args.cohortId), eq(invoices.dogId, args.dogId)))
      .orderBy(desc(invoices.issuedAt))
      .limit(1);
    return row;
  },
};

/**
 * Rebind an invoice to the card that is actually going to settle it.
 *
 * This is NOT bookkeeping neatness. `LedgerEntryWire.settled_card` (the
 * "Visa ••4242" on the paid-invoice modal) is derived from
 * `invoices.payment_method_id`, so without this the receipt would name a card
 * that was never charged — silently wrong money data. Repointing in the same tx
 * that records the settle keeps the receipt correct BY CONSTRUCTION, with no
 * change to the receipt derivation.
 */
export async function repointPaymentMethod(
  tx: Tx,
  args: { id: string; paymentMethodId: string },
): Promise<void> {
  await tx
    .update(invoices)
    .set({ paymentMethodId: args.paymentMethodId })
    .where(eq(invoices.id, args.id));
}
