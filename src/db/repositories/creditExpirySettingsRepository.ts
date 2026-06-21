import { sql } from 'drizzle-orm';
import { db } from '../client.js';
import { creditExpirySettings, type LocationKey } from '../schema/schema.js';
import type { Tx } from '../tx.js';
import { DEFAULT_CREDIT_EXPIRY_MONTHS, DEFAULT_WARNING_LEAD_DAYS } from '../../lib/creditExpiry.js';

/**
 * Data-access seam for `credit_expiry_settings` (schema.sql ~line 840). The
 * staff-tunable credit-expiry config, two-tier: ONE org-default row
 * (location IS NULL) + optional per-location override rows (location = slug).
 *
 * Read pattern: `resolveExpiryWindowMonths(location, runner)` is called at every
 * PURCHASE grant site to stamp `credit_ledger.expires_at` (non-retroactive —
 * the stamped value travels with the lot). Resolution is a fallback CHAIN:
 *   per-location override → org-default → `DEFAULT_CREDIT_EXPIRY_MONTHS` (12).
 * The code default is unreachable in practice (the schema seeds the org-default
 * row) but keeps the resolve total under unexpected DB state — same
 * code-side-default doctrine as `cancelWindowSettingsRepository`.
 *
 * `warning_lead_days` is read by `findAll` for the staff editor wire but has NO
 * consumer in Phase 2; its reader is the Phase-3 expiry-warning notification.
 *
 * No Redis read-through: ≤3-row table, single grant-time lookup, <1ms uncached.
 * A cache seam would buy nothing measurable and add an invalidation hop on the
 * staff upsert. YAGNI — mirrors the cancel-window repo's reasoning.
 */

export interface CreditExpirySettingRow {
  /** NULL = the org-wide default row; a slug = a per-location override. */
  location: LocationKey | null;
  expiryWindowMonths: number;
  warningLeadDays: number;
  updatedAt: string;
  updatedByStaffId: string | null;
}

const PROJECTION = {
  location: creditExpirySettings.location,
  expiryWindowMonths: creditExpirySettings.expiryWindowMonths,
  warningLeadDays: creditExpirySettings.warningLeadDays,
  updatedAt: creditExpirySettings.updatedAt,
  updatedByStaffId: creditExpirySettings.updatedByStaffId,
} as const;

export const creditExpirySettingsRepository = {
  /**
   * Resolve the expiry window (months) for a location: per-location override
   * row → org-default row → `DEFAULT_CREDIT_EXPIRY_MONTHS`. Reads both candidate
   * rows in one round trip (the location override OR the NULL org-default), then
   * picks the override when present.
   *
   * Polymorphic runner: defaults to the pool `db`; grant sites pass their `Tx`
   * so the read is consistent with the write they're about to make (and so a
   * test that sets the policy then purchases in the same logical flow observes
   * it).
   */
  async resolveExpiryWindowMonths(
    location: LocationKey,
    runner: Tx | typeof db = db,
  ): Promise<number> {
    const rows = await runner
      .select({
        location: creditExpirySettings.location,
        expiryWindowMonths: creditExpirySettings.expiryWindowMonths,
      })
      .from(creditExpirySettings)
      .where(
        sql`${creditExpirySettings.location} = ${location} OR ${creditExpirySettings.location} IS NULL`,
      );

    const override = rows.find((r) => r.location === location);
    if (override !== undefined) return override.expiryWindowMonths;
    const orgDefault = rows.find((r) => r.location === null);
    return orgDefault?.expiryWindowMonths ?? DEFAULT_CREDIT_EXPIRY_MONTHS;
  },

  /**
   * Resolve the warning-lead window (days) for a location: per-location override
   * row → org-default row → `DEFAULT_WARNING_LEAD_DAYS`. Same fallback CHAIN and
   * one-round-trip read as `resolveExpiryWindowMonths` — the credits-expiring
   * scan (`enqueueCreditExpiryWarnings`) calls this to decide how far ahead of a
   * lot's `expires_at` to warn its owner.
   */
  async resolveWarningLeadDays(
    location: LocationKey,
    runner: Tx | typeof db = db,
  ): Promise<number> {
    const rows = await runner
      .select({
        location: creditExpirySettings.location,
        warningLeadDays: creditExpirySettings.warningLeadDays,
      })
      .from(creditExpirySettings)
      .where(
        sql`${creditExpirySettings.location} = ${location} OR ${creditExpirySettings.location} IS NULL`,
      );

    const override = rows.find((r) => r.location === location);
    if (override !== undefined) return override.warningLeadDays;
    const orgDefault = rows.find((r) => r.location === null);
    return orgDefault?.warningLeadDays ?? DEFAULT_WARNING_LEAD_DAYS;
  },

  /**
   * Every credit-expiry setting, org-default first (NULL sorts first) then
   * per-location overrides by slug, for stable wire output. Backs
   * `GET /staff/credit-expiry-settings`.
   */
  async findAll(runner: Tx | typeof db = db): Promise<CreditExpirySettingRow[]> {
    return runner
      .select(PROJECTION)
      .from(creditExpirySettings)
      .orderBy(sql`${creditExpirySettings.location} NULLS FIRST`);
  },

  /**
   * UPSERT one row by location (NULL = the org-default). Sets the window + lead,
   * stamps `updated_at = now()` and `updated_by_staff_id`. The partial unique
   * indexes (`((location IS NULL))` and `(location)`) make ON CONFLICT the right
   * tool: a repeat write to the same location updates in place rather than
   * inserting a duplicate. Returns the upserted row so the staff POST can wire
   * it back in one round trip.
   *
   * The NULL org-default and a per-location override sit in two different
   * partial indexes, so the conflict target is chosen by whether `location` is
   * NULL — two separate ON CONFLICT statements keep each one's predicate exact.
   */
  async upsert(
    tx: Tx,
    args: {
      location: LocationKey | null;
      expiryWindowMonths: number;
      warningLeadDays: number;
      staffId: string;
    },
  ): Promise<CreditExpirySettingRow> {
    // The org-default and the per-location overrides live in two DIFFERENT
    // partial unique indexes, so the ON CONFLICT target differs by branch:
    //   - org-default: the EXPRESSION index `((location IS NULL)) WHERE ...`
    //   - override:    the COLUMN index `(location) WHERE location IS NOT NULL`
    // drizzle's typed `onConflictDoUpdate` can't target an expression index, so
    // the org-default branch upserts via raw SQL (the conflict clause is the
    // only fragment that needs the expression target; the rest is parameterized).
    const row =
      args.location === null
        ? await this.upsertOrgDefault(tx, args)
        : await this.upsertOverride(tx, { ...args, location: args.location });

    if (row === undefined) {
      // returning() is statically `| undefined`; an upsert always yields one
      // row. Surface the impossible-empty case loudly rather than mask it.
      throw new Error('credit_expiry_settings upsert returned no row');
    }
    return row;
  },

  /** Upsert the single org-default row (location IS NULL) via the expression
   * partial index. Raw SQL because drizzle can't express an expression-index
   * conflict target; all values are bound parameters (no interpolation). */
  async upsertOrgDefault(
    tx: Tx,
    args: { expiryWindowMonths: number; warningLeadDays: number; staffId: string },
  ): Promise<CreditExpirySettingRow | undefined> {
    const rows = await tx.execute<{
      location: LocationKey | null;
      expiry_window_months: number;
      warning_lead_days: number;
      updated_at: string;
      updated_by_staff_id: string | null;
    }>(sql`
      INSERT INTO credit_expiry_settings
        (location, expiry_window_months, warning_lead_days, updated_by_staff_id)
      VALUES (NULL, ${args.expiryWindowMonths}, ${args.warningLeadDays}, ${args.staffId})
      ON CONFLICT ((location IS NULL)) WHERE location IS NULL
      DO UPDATE SET
        expiry_window_months = excluded.expiry_window_months,
        warning_lead_days    = excluded.warning_lead_days,
        updated_at           = now(),
        updated_by_staff_id  = excluded.updated_by_staff_id
      RETURNING location, expiry_window_months, warning_lead_days, updated_at, updated_by_staff_id
    `);
    const r = rows.rows[0];
    if (r === undefined) return undefined;
    return {
      location: r.location,
      expiryWindowMonths: r.expiry_window_months,
      warningLeadDays: r.warning_lead_days,
      updatedAt: r.updated_at,
      updatedByStaffId: r.updated_by_staff_id,
    };
  },

  /** Upsert one per-location override row via the `(location)` column index. */
  async upsertOverride(
    tx: Tx,
    args: {
      location: LocationKey;
      expiryWindowMonths: number;
      warningLeadDays: number;
      staffId: string;
    },
  ): Promise<CreditExpirySettingRow | undefined> {
    const [row] = await tx
      .insert(creditExpirySettings)
      .values({
        location: args.location,
        expiryWindowMonths: args.expiryWindowMonths,
        warningLeadDays: args.warningLeadDays,
        updatedByStaffId: args.staffId,
      })
      .onConflictDoUpdate({
        target: creditExpirySettings.location,
        targetWhere: sql`${creditExpirySettings.location} IS NOT NULL`,
        set: {
          expiryWindowMonths: args.expiryWindowMonths,
          warningLeadDays: args.warningLeadDays,
          updatedAt: sql`now()`,
          updatedByStaffId: args.staffId,
        },
      })
      .returning(PROJECTION);
    return row;
  },
};
