/**
 * Credit-expiry window math (schema.sql `credit_ledger` lot model,
 * Δ 2026-06-18). A purchased credit lot expires `windowMonths` after purchase —
 * EXCEPT a single-day (1-credit) pack, which never expires. The window is
 * stamped once at purchase (non-retroactive: a later staff change affects
 * future purchases only), mirroring `cancel_window_settings`.
 *
 * Phase 2 (2026-06-20): the window NUMBER now comes from the staff-tunable
 * `credit_expiry_settings` table — resolved by `creditExpirySettingsRepository`
 * (per-location override → org-default → `DEFAULT_CREDIT_EXPIRY_MONTHS`) and
 * passed in. This module stays PURE (no DB import): callers resolve the number
 * inside their tx and hand it to these functions, so the rules live here and
 * the data access lives in the repository (dependency rule). Location no longer
 * appears in the signatures — it's consumed upstream when resolving the window,
 * and the lot math itself doesn't branch on it.
 */

/** Code-side fallback expiry window: 1 year. Used by the resolver only when the
 * settings table has neither a per-location override nor the org-default row
 * (unreachable in practice — the schema seeds the org-default — but keeps
 * resolution total). */
export const DEFAULT_CREDIT_EXPIRY_MONTHS = 12;

/** `from` advanced by whole months, in UTC. */
function addMonthsUtc(from: Date, months: number): Date {
  const next = new Date(from.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/**
 * `expires_at` for a credit-package PURCHASE grant. A single-day pack (exactly
 * 1 credit) never expires (null); a multi-credit pack expires at purchase + the
 * caller-resolved window (`windowMonths`, from `credit_expiry_settings`).
 */
export function resolvePurchaseExpiry(
  grantedCount: number,
  windowMonths: number,
  now: Date,
): Date | null {
  if (grantedCount <= 1) return null;
  return addMonthsUtc(now, windowMonths);
}

/**
 * `expires_at` for a freshly-minted REFUND lot — used only when a free-window
 * cancel returns a credit whose source lot has already expired (the common
 * refund returns to the still-alive original lot instead). Always a fresh
 * window: a refund is 1 credit but, unlike a purchased single-day pack, is NOT
 * never-expire (decisions #1 vs #5 — "new expiry" wins for refunds).
 */
export function resolveRefundExpiry(windowMonths: number, now: Date): Date {
  return addMonthsUtc(now, windowMonths);
}
