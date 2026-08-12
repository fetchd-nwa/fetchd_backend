import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { invoiceChargeAttempts } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `invoice_charge_attempts` (schema.sql ~line 1179) — the
 * durable record of every auto-charge attempt, and since 2026-08-12 the OWNER
 * of the Stripe idempotency key's identity
 * (`designs/auto-charge-unknown-outcome.md`, Decision 1).
 *
 * The defect this table exists to close: `invoices.auto_charge_attempts` did two
 * jobs — the dunning ladder AND the key suffix. A transport failure, the one
 * class where nobody knows whether money moved, incremented it and thereby
 * MINTED A NEW KEY, so the next tick asked Stripe for fresh money against a
 * charge that may already have succeeded. Here `attempt_no` advances only when
 * the previous attempt is **known-dead**; an unresolved attempt keeps its key,
 * so a re-issue replays instead of charging again.
 *
 * Two invariants are the DB's, not the worker's:
 *   - `UNIQUE (idempotency_key)` — one attempt row per Stripe key, ever.
 *   - `invoice_charge_attempts_unresolved_uq` (partial unique on `invoice_id`
 *     WHERE outcome IN ('pending','processing')) — at most ONE unresolved
 *     attempt per invoice. The charge lane's refusal to mint attempt N+1 while
 *     attempt N is in doubt survives a code regression because this index does.
 *
 * Rows are written BEFORE the Stripe call, so a process that dies mid-flight
 * leaves an honest `pending` row rather than nothing at all.
 */

export type InvoiceAttemptOutcome = 'pending' | 'processing' | 'succeeded' | 'no-charge';

/**
 * Why the verify lane handed this attempt to a human (schema.sql ~line 1230).
 * Durable, because every park looks identical in the invoice row
 * (`next_attempt_at = NULL`) and the difference between "we ran out of window"
 * and "Stripe's records disagree with ours" is the first thing a reconciling
 * human needs and the last thing a log line keeps.
 */
export type InvoiceAttemptReconcileReason =
  /** Past the idempotency-key window with no PI id and no webhook. */
  | 'key-window-expired'
  /** `processing` for longer than the in-flight cap allows. */
  | 'in-flight-cap'
  /** Stripe rejected our own recorded key with our frozen params. */
  | 'idempotency-conflict'
  /** A re-issue EXECUTED instead of replaying — a second charge may exist. */
  | 'fresh-execution';

/** The two non-terminal outcomes — "we do not (yet) know". */
export const UNRESOLVED_ATTEMPT_OUTCOMES: readonly InvoiceAttemptOutcome[] = [
  'pending',
  'processing',
];

export interface InvoiceChargeAttemptRow {
  id: string;
  invoiceId: string;
  attemptNo: number;
  paymentMethodId: string;
  stripePaymentMethodId: string;
  /** The Stripe customer the confirm named — frozen here, never re-read. */
  stripeCustomerId: string;
  amountCents: number;
  idempotencyKey: string;
  stripePaymentIntentId: string | null;
  outcome: InvoiceAttemptOutcome;
  verifyCount: number;
  reconcileReason: InvoiceAttemptReconcileReason | null;
  createdAt: string;
  updatedAt: string;
}

const ATTEMPT_PROJECTION = {
  id: invoiceChargeAttempts.id,
  invoiceId: invoiceChargeAttempts.invoiceId,
  attemptNo: invoiceChargeAttempts.attemptNo,
  paymentMethodId: invoiceChargeAttempts.paymentMethodId,
  stripePaymentMethodId: invoiceChargeAttempts.stripePaymentMethodId,
  stripeCustomerId: invoiceChargeAttempts.stripeCustomerId,
  amountCents: invoiceChargeAttempts.amountCents,
  idempotencyKey: invoiceChargeAttempts.idempotencyKey,
  stripePaymentIntentId: invoiceChargeAttempts.stripePaymentIntentId,
  outcome: invoiceChargeAttempts.outcome,
  verifyCount: invoiceChargeAttempts.verifyCount,
  // Raw-column projection so the row carries the CHECK's vocabulary rather than
  // bare `string | null`: `schema/schema.ts` is an introspected mirror and a
  // hand-added `$type<>()` there would be overwritten by the next
  // `db:introspect`. The DDL CHECK is what actually holds the domain.
  reconcileReason: sql<InvoiceAttemptReconcileReason | null>`reconcile_reason`,
  createdAt: invoiceChargeAttempts.createdAt,
  updatedAt: invoiceChargeAttempts.updatedAt,
} as const;

/**
 * THE Stripe idempotency key format for an auto-charge attempt. Unchanged from
 * the pre-2026-08-12 worker (`auto-charge:{invoiceId}:{n}`) on purpose — what
 * changed is where `n` comes from. Keeping the FORMAT identical is what makes
 * the deploy-continuity seeding rule below able to reproduce, byte for byte,
 * the key the old code would have minted next.
 */
export function autoChargeAttemptKey(invoiceId: string, attemptNo: number): string {
  return `auto-charge:${invoiceId}:${attemptNo}`;
}

export const invoiceChargeAttemptsRepository = {
  /**
   * The invoice's UNRESOLVED attempt, if any — the charge lane's refusal gate
   * and the operator's "what is in doubt right now?" read. At most one can
   * exist (the partial unique index), so this returns a row, not a list.
   */
  async findUnresolvedForInvoice(
    runner: Runner,
    invoiceId: string,
  ): Promise<InvoiceChargeAttemptRow | undefined> {
    const [row] = await runner
      .select(ATTEMPT_PROJECTION)
      .from(invoiceChargeAttempts)
      .where(
        and(
          eq(invoiceChargeAttempts.invoiceId, invoiceId),
          inArray(invoiceChargeAttempts.outcome, ['pending', 'processing']),
        ),
      )
      .limit(1);
    return row;
  },

  /**
   * Mint the next attempt row for an invoice, in the caller's SHORT tx, BEFORE
   * any Stripe call. Returns the row whose `idempotencyKey` the confirm must
   * use and whose frozen params it must send.
   *
   * **The seeding rule (deploy continuity).** For an invoice with NO attempt
   * rows the first new-code attempt takes `attempt_no = auto_charge_attempts` —
   * byte-identical to the key the OLD code would have minted next. So an
   * in-flight old key is never collided with (a lower number is already used)
   * and never reused (a higher number would skip past it). Thereafter
   * `attempt_no = max(attempt_no) + 1`, and it only gets there when the prior
   * attempt is terminal — the unresolved partial unique index refuses the
   * insert otherwise, which is the interlock this design leans on.
   *
   * A unique violation here is NOT to be swallowed: it means either a
   * concurrent worker won the lease race or an unresolved attempt exists, and
   * both mean "do not charge".
   */
  async mint(
    tx: Tx,
    args: {
      invoiceId: string;
      /** The invoice's dunning-ladder count — the seed for the FIRST row only. */
      autoChargeAttempts: number;
      paymentMethodId: string;
      stripePaymentMethodId: string;
      /** Frozen with the rest of the confirm params — Stripe hashes it into
       *  the idempotent request, so a re-issue that re-read a re-linked
       *  `stripe_customers` row would take the permanent-park arm. */
      stripeCustomerId: string;
      amountCents: number;
    },
  ): Promise<InvoiceChargeAttemptRow> {
    const [existing] = await tx
      .select({ maxAttemptNo: sql<number | null>`max(attempt_no)::int` })
      .from(invoiceChargeAttempts)
      .where(eq(invoiceChargeAttempts.invoiceId, args.invoiceId));
    const priorMax = existing?.maxAttemptNo ?? null;
    const attemptNo = priorMax === null ? args.autoChargeAttempts : priorMax + 1;
    const [row] = await tx
      .insert(invoiceChargeAttempts)
      .values({
        invoiceId: args.invoiceId,
        attemptNo,
        paymentMethodId: args.paymentMethodId,
        stripePaymentMethodId: args.stripePaymentMethodId,
        stripeCustomerId: args.stripeCustomerId,
        amountCents: args.amountCents,
        idempotencyKey: autoChargeAttemptKey(args.invoiceId, attemptNo),
      })
      .returning(ATTEMPT_PROJECTION);
    if (!row) {
      throw new Error('invoiceChargeAttemptsRepository.mint: INSERT returned no row');
    }
    return row;
  },

  /**
   * Record the PaymentIntent id the attempt produced, without changing its
   * outcome. The verify lane's whole ability to ASK Stripe rather than guess
   * depends on this landing as soon as an id is known — including on the
   * unsettled arms, where the old worker learned an id and threw it away.
   */
  async recordPaymentIntentId(
    tx: Tx,
    args: { id: string; stripePaymentIntentId: string },
  ): Promise<void> {
    await tx
      .update(invoiceChargeAttempts)
      .set({ stripePaymentIntentId: args.stripePaymentIntentId })
      .where(eq(invoiceChargeAttempts.id, args.id));
  },

  /**
   * Move an attempt to a terminal outcome (`succeeded` / `no-charge`) or to
   * `processing`. Filtered on the row still being UNRESOLVED so a late webhook
   * and a verify pass racing on the same attempt collapse to one write — the
   * loser sees 0 and does nothing. Returns the affected row count.
   */
  async resolve(
    tx: Tx,
    args: { id: string; outcome: InvoiceAttemptOutcome; stripePaymentIntentId?: string },
  ): Promise<number> {
    const updated = await tx
      .update(invoiceChargeAttempts)
      .set({
        outcome: args.outcome,
        ...(args.stripePaymentIntentId !== undefined
          ? { stripePaymentIntentId: args.stripePaymentIntentId }
          : {}),
      })
      .where(
        and(
          eq(invoiceChargeAttempts.id, args.id),
          inArray(invoiceChargeAttempts.outcome, ['pending', 'processing']),
        ),
      )
      .returning({ id: invoiceChargeAttempts.id });
    return updated.length;
  },

  /**
   * Stamp WHY this attempt was handed to a human, on the attempt row itself.
   *
   * The park arms deliberately leave the attempt UNRESOLVED — we still do not
   * know what happened to that money and writing a terminal outcome would be
   * inventing an answer — so without this the durable state of "past the key
   * window" and "Stripe rejected our own key with our own params" is identical,
   * and the difference survives only in a log line. It is the second of those a
   * reconciling human most needs, because it means the two ledgers disagree.
   *
   * Last write wins on purpose: a later, more specific reason (a conflict found
   * on a re-issue) should replace an earlier generic one.
   */
  async recordReconcileReason(
    tx: Tx,
    args: { id: string; reason: InvoiceAttemptReconcileReason },
  ): Promise<void> {
    await tx
      .update(invoiceChargeAttempts)
      .set({ reconcileReason: args.reason })
      .where(eq(invoiceChargeAttempts.id, args.id));
  },

  /**
   * The verify lane's CLAIM — select + lease in one short tx, mirroring
   * `invoicesRepository.leaseDueOpen`.
   *
   * Selects unresolved attempts untouched since `staleBefore` under `FOR UPDATE
   * SKIP LOCKED` (the `scheduled_notifications` claim pattern, so concurrent
   * ticks divide the worklist without blocking), then bumps `verify_count` on
   * every claimed row. That bump does two jobs:
   *
   *   1. **It is the lease.** The `updated_at` touch trigger moves the row to
   *      `now()`, so the `updated_at <= staleBefore` predicate hides it from
   *      another tick for a full verify interval — the lock itself is gone the
   *      moment this tx commits, which it must, because the Stripe call happens
   *      outside any transaction (R5).
   *   2. **It is the termination bound.** `maxVerifyCount` caps how many times
   *      one attempt may be examined. Every claim increments the count by
   *      exactly one, so an attempt can be claimed at most `maxVerifyCount`
   *      times, EVER — the loop provably terminates even for the arms that end
   *      with the attempt deliberately left unresolved (a human, not this lane,
   *      owns those). The behavioral caps (a `processing` intent past its age
   *      limit; a `pending` attempt past the idempotency-key window) fire long
   *      before this one; this is the floor beneath them, not the usual exit.
   *
   * Returns the POST-bump rows, so the caller reads the pass number it is on.
   */
  async claimUnresolvedForVerify(
    tx: Tx,
    args: { staleBefore: Date; maxVerifyCount: number; limit?: number },
  ): Promise<InvoiceChargeAttemptRow[]> {
    const due = await tx
      .select({ id: invoiceChargeAttempts.id })
      .from(invoiceChargeAttempts)
      .where(
        and(
          inArray(invoiceChargeAttempts.outcome, ['pending', 'processing']),
          lte(invoiceChargeAttempts.updatedAt, args.staleBefore.toISOString()),
          lt(invoiceChargeAttempts.verifyCount, args.maxVerifyCount),
        ),
      )
      .orderBy(asc(invoiceChargeAttempts.updatedAt))
      .limit(args.limit ?? 25)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(invoiceChargeAttempts)
      .set({ verifyCount: sql`verify_count + 1` })
      .where(
        inArray(
          invoiceChargeAttempts.id,
          due.map((r) => r.id),
        ),
      )
      .returning(ATTEMPT_PROJECTION);
  },

  /**
   * Match an attempt from a Stripe PaymentIntent's metadata — the webhook's
   * orphan-reconciliation target. Keyed on (`invoice_id`,
   * `auto_charge_attempt`), the two fields the worker stamps on every
   * auto-charge PI. Returns undefined for a pre-deploy orphan (no attempt row
   * exists); the settle stands on its own in that case.
   */
  async findByInvoiceAndAttemptNo(
    runner: Runner,
    args: { invoiceId: string; attemptNo: number },
  ): Promise<InvoiceChargeAttemptRow | undefined> {
    const [row] = await runner
      .select(ATTEMPT_PROJECTION)
      .from(invoiceChargeAttempts)
      .where(
        and(
          eq(invoiceChargeAttempts.invoiceId, args.invoiceId),
          eq(invoiceChargeAttempts.attemptNo, args.attemptNo),
        ),
      )
      .limit(1);
    return row;
  },

  /** Read one attempt by primary key (post-Stripe re-read in the verify lane). */
  async findById(runner: Runner, id: string): Promise<InvoiceChargeAttemptRow | undefined> {
    const [row] = await runner
      .select(ATTEMPT_PROJECTION)
      .from(invoiceChargeAttempts)
      .where(eq(invoiceChargeAttempts.id, id))
      .limit(1);
    return row;
  },

  /** Every attempt for one invoice, oldest first — the operator's audit read. */
  async findAllForInvoice(runner: Runner, invoiceId: string): Promise<InvoiceChargeAttemptRow[]> {
    return runner
      .select(ATTEMPT_PROJECTION)
      .from(invoiceChargeAttempts)
      .where(eq(invoiceChargeAttempts.invoiceId, invoiceId))
      .orderBy(asc(invoiceChargeAttempts.attemptNo));
  },
};
