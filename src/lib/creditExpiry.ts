import type { LocationKey } from './locations.js';

/**
 * Credit-expiry window resolution (schema.sql `credit_ledger` lot model,
 * Δ 2026-06-18). A purchased credit lot expires `window` after purchase —
 * EXCEPT a single-day (1-credit) pack, which never expires. The window is
 * stamped once at purchase (non-retroactive: a later staff change affects
 * future purchases only), mirroring `cancel_window_settings`.
 *
 * Phase 1 uses the flat code default below at every grant site. Phase 2 swaps
 * `resolveExpiryWindowMonths` for a settings-table read (org-wide default +
 * optional per-location override); the rules in this module are unchanged by
 * that — only where the number comes from.
 */

/** Code-side default expiry window: 1 year. */
export const DEFAULT_CREDIT_EXPIRY_MONTHS = 12;

/** Resolved expiry window (months) for a location. Phase 1: flat code default. */
function resolveExpiryWindowMonths(_location: LocationKey): number {
  return DEFAULT_CREDIT_EXPIRY_MONTHS;
}

/** `from` advanced by whole months, in UTC. */
function addMonthsUtc(from: Date, months: number): Date {
  const next = new Date(from.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/**
 * `expires_at` for a credit-package PURCHASE grant. A single-day pack (exactly
 * 1 credit) never expires (null); a multi-credit pack expires at purchase + the
 * location-resolved window.
 */
export function resolvePurchaseExpiry(
  location: LocationKey,
  grantedCount: number,
  now: Date,
): Date | null {
  if (grantedCount <= 1) return null;
  return addMonthsUtc(now, resolveExpiryWindowMonths(location));
}

/**
 * `expires_at` for a freshly-minted REFUND lot — used only when a free-window
 * cancel returns a credit whose source lot has already expired (the common
 * refund returns to the still-alive original lot instead). Always a fresh
 * window: a refund is 1 credit but, unlike a purchased single-day pack, is NOT
 * never-expire (decisions #1 vs #5 — "new expiry" wins for refunds).
 */
export function resolveRefundExpiry(location: LocationKey, now: Date): Date {
  return addMonthsUtc(now, resolveExpiryWindowMonths(location));
}
