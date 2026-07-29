import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { paymentMethods } from '../schema/schema.js';
import { live } from '../softExpire.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `payment_methods`. Day-7b read-only addition; Day-14
 * extends with the SetupIntent + add + patch-default + soft-expire mutations.
 *
 * Wire shape per the FE `paymentMethodRepository.ts` Raw type — flat
 * 7-key row, all required. Card lifecycle uses soft-expire (`expired_at`
 * non-null = removed) so retained charge history can still reference a
 * card after it's "deleted" from the FE perspective.
 */

export interface PaymentMethodRow {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  cardholderName: string;
  isDefault: boolean;
}

/**
 * The same fields as `PaymentMethodRow` plus the Stripe handle + the owner
 * id — used by Day-14's DELETE/PATCH paths that need the Stripe id (for
 * detach) and the owner id (for the ownership gate). The wire-bound
 * `PaymentMethodRow` deliberately omits these to keep wire shape stable.
 */
export interface PaymentMethodInternalRow extends PaymentMethodRow {
  ownerId: string;
  stripePaymentMethodId: string;
}

const PAYMENT_METHOD_PROJECTION = {
  id: paymentMethods.id,
  brand: paymentMethods.brand,
  last4: paymentMethods.last4,
  expMonth: paymentMethods.expMonth,
  expYear: paymentMethods.expYear,
  cardholderName: paymentMethods.cardholderName,
  isDefault: paymentMethods.isDefault,
} as const;

const PAYMENT_METHOD_INTERNAL_PROJECTION = {
  ...PAYMENT_METHOD_PROJECTION,
  ownerId: paymentMethods.ownerId,
  stripePaymentMethodId: paymentMethods.stripePaymentMethodId,
} as const;

/**
 * THE card-expiry instant, as SQL: the start of the month AFTER
 * `exp_month/exp_year` (a card is good through the last day of its printed
 * month), evaluated in America/Chicago like every other calendar boundary in
 * this schema. Defined once because TWO callers depend on it agreeing —
 * `findExpiringDefaults` (what to warn about) and `resolveChargeableForOwner`
 * (what to skip). If they drifted we'd warn about one card and decline another.
 */
const CARD_EXPIRES_AT_SQL = sql`((make_date(pm.exp_year::int, pm.exp_month::int, 1)
  + interval '1 month') AT TIME ZONE 'America/Chicago')`;

/**
 * One row of the `card-expiring` scan. `expiresAt` is the instant the card stops
 * being chargeable — the START of the month AFTER `exp_month/exp_year`, since a
 * card is good through the last day of its printed month.
 */
export interface ExpiringCardForWarning {
  paymentMethodId: string;
  ownerId: string;
  brand: string;
  last4: string;
  expiresAt: string;
}

export const paymentMethodsRepository = {
  /**
   * Live DEFAULT cards at or past their warning threshold — the `card-expiring`
   * scan (Allison 2026-07-29). Returns both the not-yet-expired (inside the
   * warning window) and the already-lapsed; the producer classifies each by
   * comparing `expiresAt` to now, because the two states get different copy and
   * different dedupe keys.
   *
   * DEFAULT only: a lapsing secondary card breaks nothing (nothing charges it),
   * so warning about it would be noise. The expiry instant is evaluated in
   * America/Chicago, matching every other calendar boundary in this schema (the
   * vaccine gate, the alumni month roll) — a card is good through the last day
   * of its printed month, local time.
   */
  async findExpiringDefaults(
    args: { warnCutoff: Date },
    runner: Runner = db,
  ): Promise<ExpiringCardForWarning[]> {
    const rows = await runner.execute(sql`
      SELECT pm.id,
             pm.owner_id,
             pm.brand,
             pm.last4,
             ${CARD_EXPIRES_AT_SQL} AS expires_at
      FROM ${paymentMethods} pm
      WHERE pm.expired_at IS NULL
        AND pm.is_default = true
        AND ${CARD_EXPIRES_AT_SQL} <= ${args.warnCutoff.toISOString()}
      ORDER BY expires_at ASC
    `);
    return (
      rows.rows as {
        id: string;
        owner_id: string;
        brand: string;
        last4: string;
        expires_at: string;
      }[]
    ).map((r) => ({
      paymentMethodId: r.id,
      ownerId: r.owner_id,
      brand: r.brand,
      last4: r.last4,
      expiresAt: new Date(r.expires_at).toISOString(),
    }));
  },

  /**
   * The card to actually charge, given the one an invoice is bound to (Allison
   * 2026-07-29: "if one credit card is expired and there's another card on
   * file, charge the next card in line").
   *
   * Returns the PREFERRED card when it is live and not past its printed expiry.
   * Otherwise the next live, unexpired card in the owner's standing order —
   * default first, then oldest — the same order the wallet renders, so "next in
   * line" means the same thing to the code and to the owner looking at the
   * screen. `undefined` when there is no chargeable card at all; the caller
   * parks the invoice exactly as it did before this fallback existed.
   *
   * Expiry here is the PRINTED date, not a Stripe decline: a cheap pre-flight so
   * an unattended charge doesn't burn a dunning attempt on a card the calendar
   * already disqualified. A live-looking card can still decline; that path is
   * unchanged.
   */
  async resolveChargeableForOwner(
    args: { ownerId: string; preferredId: string },
    runner: Runner = db,
  ): Promise<PaymentMethodInternalRow | undefined> {
    const rows = await runner.execute(sql`
      SELECT pm.id, pm.brand, pm.last4, pm.exp_month, pm.exp_year, pm.cardholder_name,
             pm.is_default, pm.owner_id, pm.stripe_payment_method_id
      FROM ${paymentMethods} pm
      WHERE pm.owner_id = ${args.ownerId}
        AND pm.expired_at IS NULL
        AND ${CARD_EXPIRES_AT_SQL} > now()
      ORDER BY (pm.id = ${args.preferredId}) DESC, pm.is_default DESC, pm.created_at ASC
      LIMIT 1
    `);
    const row = (
      rows.rows as {
        id: string;
        brand: string;
        last4: string;
        exp_month: number;
        exp_year: number;
        cardholder_name: string;
        is_default: boolean;
        owner_id: string;
        stripe_payment_method_id: string;
      }[]
    )[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      brand: row.brand,
      last4: row.last4,
      expMonth: Number(row.exp_month),
      expYear: Number(row.exp_year),
      cardholderName: row.cardholder_name,
      isDefault: row.is_default,
      ownerId: row.owner_id,
      stripePaymentMethodId: row.stripe_payment_method_id,
    };
  },

  /**
   * Owner's live cards. Default emits first (single hero slot in the FE),
   * then oldest-first as the secondary order — predictable for the FE
   * and for snapshot diffs. `live()` filter drops soft-expired rows; the
   * partial unique index `payment_methods_one_default` already enforces
   * at most one live default per owner so no extra dedupe is needed here.
   */
  async findLiveByOwner(ownerId: string, runner: Runner = db): Promise<PaymentMethodRow[]> {
    return runner
      .select(PAYMENT_METHOD_PROJECTION)
      .from(paymentMethods)
      .where(and(eq(paymentMethods.ownerId, ownerId), live(paymentMethods)))
      .orderBy(desc(paymentMethods.isDefault), asc(paymentMethods.createdAt));
  },

  /**
   * Day 10 payment-gate pre-check — Tx-only. `true` iff the owner has at
   * least one live `payment_methods` row. The BEFORE-INSERT trigger
   * `bookings_payment_guarantee` (schema.sql:1184) is the unbypassable
   * floor; this pre-check exists so the typical "no card on file" path
   * surfaces a friendly `payment_required` 422 from the route layer
   * instead of a generic check_violation 422 mapped by the trigger
   * fallback in `gateTriggerErrorToApiError`. Same exists-only semantic;
   * route maps the negative case to `paymentRequiredError()`.
   *
   * Same-tx visibility: a payment method added in the current
   * transaction is visible to this read (`SELECT 1 EXISTS` inside the
   * tx scope). Idempotent — repeat calls return the same answer.
   */
  async hasLiveForOwner(tx: Tx, ownerId: string): Promise<boolean> {
    const [row] = await tx
      .select({ one: sql<number>`1`.as('one') })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.ownerId, ownerId), live(paymentMethods)))
      .limit(1);
    return row !== undefined;
  },

  /**
   * Find one live card for an owner — used by DELETE/PATCH /payment-
   * methods/:id. Returns undefined when the id doesn't exist, isn't
   * owned by this principal, or has been soft-expired. 404 + 403 + 410
   * collapse to one shape (`undefined`) and the route maps to 404 —
   * payment-method ids don't enumerate across owners.
   */
  async findLiveByIdForOwner(
    runner: Runner,
    args: { id: string; ownerId: string },
  ): Promise<PaymentMethodInternalRow | undefined> {
    const [row] = await runner
      .select(PAYMENT_METHOD_INTERNAL_PROJECTION)
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.id, args.id),
          eq(paymentMethods.ownerId, args.ownerId),
          live(paymentMethods),
        ),
      )
      .limit(1);
    return row;
  },

  /**
   * Dedupe probe by Stripe payment-method id, across ALL rows (live AND
   * soft-expired) — Stripe never reuses a `pm_*` id, so its presence in any
   * state means "already materialized". Used by `materializePaymentMethod`
   * so the synchronous confirm route and the `setup_intent.succeeded` webhook
   * racing on the same card collapse to one row.
   */
  async existsByStripePaymentMethodId(
    runner: Runner,
    stripePaymentMethodId: string,
  ): Promise<boolean> {
    const [row] = await runner
      .select({ one: sql<number>`1`.as('one') })
      .from(paymentMethods)
      .where(eq(paymentMethods.stripePaymentMethodId, stripePaymentMethodId))
      .limit(1);
    return row !== undefined;
  },

  /**
   * INSERT a new payment_methods row. Day-14 SetupIntent confirm path:
   * after Stripe's `setup_intent.succeeded`, the FE POSTs back the
   * resulting Stripe payment_method id; the route calls
   * `stripeClient.retrievePaymentMethod()` for the displayable bits +
   * inserts the row here. If `isDefault` is true, the caller must
   * clear other defaults inside the same txn (see `clearDefault`) —
   * the partial unique `payment_methods_one_default` would otherwise
   * raise a 23505 unique_violation.
   */
  async create(
    tx: Tx,
    args: {
      ownerId: string;
      stripePaymentMethodId: string;
      brand: string;
      last4: string;
      expMonth: number;
      expYear: number;
      cardholderName: string;
      isDefault: boolean;
    },
  ): Promise<PaymentMethodInternalRow> {
    const [row] = await tx
      .insert(paymentMethods)
      .values({
        ownerId: args.ownerId,
        stripePaymentMethodId: args.stripePaymentMethodId,
        brand: args.brand,
        last4: args.last4,
        expMonth: args.expMonth,
        expYear: args.expYear,
        cardholderName: args.cardholderName,
        isDefault: args.isDefault,
      })
      .returning(PAYMENT_METHOD_INTERNAL_PROJECTION);
    if (!row) {
      throw new Error('paymentMethodsRepository.create: INSERT returned no row');
    }
    return row;
  },

  /**
   * Clear the current live default for an owner (set is_default=false).
   * Used by PATCH /payment-methods/:id and create-as-default flows to
   * preserve the partial-unique invariant `payment_methods_one_default`.
   * Idempotent: a no-op when no current default exists. Soft-expired
   * rows are unaffected (the partial unique only covers live rows).
   */
  async clearDefault(tx: Tx, ownerId: string): Promise<void> {
    await tx
      .update(paymentMethods)
      .set({ isDefault: false })
      .where(
        and(
          eq(paymentMethods.ownerId, ownerId),
          eq(paymentMethods.isDefault, true),
          live(paymentMethods),
        ),
      );
  },

  /**
   * Set one card as default. Caller is responsible for having cleared any
   * other live default first (`clearDefault`) — the partial-unique index
   * trips a 23505 otherwise. Returns the count of rows updated so the
   * route can distinguish "not yours/already deleted" (0) from success (1).
   */
  async setDefault(
    tx: Tx,
    args: { id: string; ownerId: string },
  ): Promise<PaymentMethodInternalRow | undefined> {
    const [row] = await tx
      .update(paymentMethods)
      .set({ isDefault: true })
      .where(
        and(
          eq(paymentMethods.id, args.id),
          eq(paymentMethods.ownerId, args.ownerId),
          live(paymentMethods),
        ),
      )
      .returning(PAYMENT_METHOD_INTERNAL_PROJECTION);
    return row;
  },

  /**
   * Soft-expire the card: set `expired_at = now()` and force
   * `is_default = false`. The combined update keeps the partial-unique
   * invariant intact (defaulted soft-expired rows are out of scope of
   * the index, but the FE display layer expects no live default after
   * a delete — explicit zero is the honest write).
   *
   * Returns the row if it was live + owned by this principal; undefined
   * for the not-found / not-yours / already-expired cases (the route
   * maps to 404 for all three).
   */
  async softExpire(
    tx: Tx,
    args: { id: string; ownerId: string },
  ): Promise<PaymentMethodInternalRow | undefined> {
    const [row] = await tx
      .update(paymentMethods)
      .set({ isDefault: false, expiredAt: sql`now()` })
      .where(
        and(
          eq(paymentMethods.id, args.id),
          eq(paymentMethods.ownerId, args.ownerId),
          live(paymentMethods),
        ),
      )
      .returning(PAYMENT_METHOD_INTERNAL_PROJECTION);
    return row;
  },
};
