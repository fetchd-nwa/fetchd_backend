import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import {
  creditExpirySettingsRepository,
  type CreditExpirySettingRow,
} from '../db/repositories/creditExpirySettingsRepository.js';
import { LOCATION_SLUGS, type LocationKey } from '../db/schema/schema.js';
import { pgTimestampToIso } from '../lib/pgTimestamp.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { parseOrThrow } from '../lib/zodIssues.js';

/**
 * `GET`/`POST` `/staff/credit-expiry-settings` `[staff]` — the staff editor for
 * the credit-expiry config (schema.sql `credit_expiry_settings`). Two-tier:
 * ONE org-default row (`location: null`) + optional per-location overrides.
 * Mirrors `staffCancelWindow.ts` (read-direct, owner → 403, idempotent write,
 * inline wire type — NOT portal-mirrored yet).
 *
 *   GET  /staff/credit-expiry-settings   list org-default + every override
 *   POST /staff/credit-expiry-settings   upsert one row by location
 *
 * `expiry_window_months` feeds the credit-lot expiry stamp at PURCHASE
 * (non-retroactive — already-stamped lots keep their expires_at). A POST
 * changes FUTURE grants only.
 *
 * `warning_lead_days` has two consumers: the credits-expiring push scan
 * (`enqueueCreditExpiryWarnings`, Phase 3) and — Δ 2026-07-16 — the owner
 * app's "expiring soon" chip, which reads the resolved per-location value
 * off `GET /dogs/:id/credits` (`warning_lead_days`), so both warning
 * surfaces move together when staff tune this.
 *
 * Wire shape per row:
 *   { location, expiry_window_months, warning_lead_days, updated_at,
 *     updated_by_staff_id }
 * `location` is null for the org-default row; `updated_at` is ISO;
 * `updated_by_staff_id` is the last editor (null = still the seeded default).
 */

/**
 * Window sanity band. min 1mo (CHECK > 0 also enforces it) — a "0-month window"
 * is "expires instantly", not a policy. max 120mo (10y) — a generous ceiling
 * that still covers any realistic credit shelf-life, while stopping a fat-finger
 * from setting a 1000-month window that effectively disables expiry org-wide.
 */
const MIN_WINDOW_MONTHS = 1;
const MAX_WINDOW_MONTHS = 120;

/**
 * Warning-lead band. min 0 (CHECK >= 0 also enforces it) — 0 = "warn the day it
 * expires". max 365 days — a year of lead is the longest notice that makes sense
 * for a window measured in months; beyond that the warning predates the purchase.
 */
const MIN_WARNING_LEAD_DAYS = 0;
const MAX_WARNING_LEAD_DAYS = 365;

const postBodySchema = z
  .object({
    // null = the org-wide default row; a slug = a per-location override.
    location: z.enum(LOCATION_SLUGS).nullable(),
    expiry_window_months: z.number().int().min(MIN_WINDOW_MONTHS).max(MAX_WINDOW_MONTHS),
    warning_lead_days: z.number().int().min(MIN_WARNING_LEAD_DAYS).max(MAX_WARNING_LEAD_DAYS),
  })
  .strict();

interface CreditExpirySettingWire {
  location: LocationKey | null;
  expiry_window_months: number;
  warning_lead_days: number;
  updated_at: string;
  updated_by_staff_id: string | null;
}

function toWire(row: CreditExpirySettingRow): CreditExpirySettingWire {
  return {
    location: row.location,
    expiry_window_months: row.expiryWindowMonths,
    warning_lead_days: row.warningLeadDays,
    updated_at: pgTimestampToIso(row.updatedAt),
    updated_by_staff_id: row.updatedByStaffId,
  };
}

export function registerStaffCreditExpiryRoute(
  app: FastifyInstance,
  opts: AuthRouteOptions = {},
): void {
  const authHook = resolveAuthHook(opts);

  // --- GET /staff/credit-expiry-settings -------------------------------
  // Lists the org-default row (location null, first) then every per-location
  // override. At least 1 row given the schema seed.
  app.get(
    '/staff/credit-expiry-settings',
    { preHandler: [authHook] },
    async (request): Promise<CreditExpirySettingWire[]> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read the credit-expiry settings');
      const rows = await creditExpirySettingsRepository.findAll();
      return rows.map(toWire);
    },
  );

  // --- POST /staff/credit-expiry-settings ------------------------------
  // Upsert one row by location (null = the org-default). Stamps
  // `updated_at = now()` + `updated_by_staff_id`. Returns the upserted row.
  //
  // Non-retroactive: future purchases at this location stamp their lot expiry
  // from the new window; already-stamped lots keep their expires_at.
  app.post(
    '/staff/credit-expiry-settings',
    { preHandler: [authHook] },
    async (request): Promise<CreditExpirySettingWire> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'edit the credit-expiry settings');
      const body = parseOrThrow(postBodySchema, request.body, 'body');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const outcome = await withMutation<CreditExpirySettingWire>(
        {
          principal,
          idempotencyKey,
          endpoint: 'POST /staff/credit-expiry-settings',
          requestHash: hashRequestBody(body),
          // No cache wipe: credit_expiry_settings is read direct from pg at each
          // grant (no Redis read-through). Future purchases naturally observe
          // the new window; existing credit lots carry their stamped expiry.
          keysToInvalidate: () => [],
        },
        async (tx) => {
          const row = await creditExpirySettingsRepository.upsert(tx, {
            location: body.location,
            expiryWindowMonths: body.expiry_window_months,
            warningLeadDays: body.warning_lead_days,
            staffId: principal.staffId,
          });
          return { status: 200, body: toWire(row) };
        },
      );

      return outcome.body;
    },
  );
}
