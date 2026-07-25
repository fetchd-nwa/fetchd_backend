import { creditExpirySettingsRepository } from '../db/repositories/creditExpirySettingsRepository.js';
import {
  findExpiringLotsForWarning,
  type ExpiringLotForWarning,
} from '../db/repositories/creditLedgerRepository.js';
import { LOCATION_SLUGS, type LocationKey } from '../db/schema/schema.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';

/**
 * Credit-expiry-warning scheduled scan (credit-expiry Phase 3, 2026-06-20).
 * Mirrors `enqueueBookingReminders` (the booking-creation enqueue) but runs as
 * a SCHEDULED SCAN — there's no single triggering event, so a worker phase
 * sweeps for lots approaching expiry and enqueues a `credits-expiring`
 * scheduled notification per lot.
 *
 * Steps:
 *   1. Resolve each location's `warning_lead_days` (per-location override ->
 *      org-default -> `DEFAULT_WARNING_LEAD_DAYS`), then compute that location's
 *      cutoff = `now + lead_days`. The window is PER-LOCATION (a location can
 *      tune its own lead), so the cutoffs differ per slug.
 *   2. Scan live, non-exhausted EXPIRING lots whose `expires_at <= cutoff` for
 *      their location, joined to the owner to warn (staff-owned dogs excluded).
 *   3. Enqueue one `credits-expiring` scheduled notification per lot, keyed by
 *      `credits-expiring:<lotId>` so the UNIQUE on `scheduled_notifications.
 *      dedupe_key` makes the enqueue idempotent — a lot warned on one tick is
 *      never re-enqueued on a later tick (the dedup invariant). `scheduled_for`
 *      = now so the same scheduler tick's delivery phase sends it.
 *
 * The enqueues run inside ONE caller-provided tx so the scan is atomic per tick
 * (a mid-scan crash rolls back cleanly; the next tick re-scans — and the dedupe
 * key keeps already-warned lots from re-enqueuing). Returns the count of NEW
 * enqueues (ON CONFLICT skips count as already-warned, not new).
 */

export interface EnqueueCreditExpiryWarningsResult {
  /** Lots scanned that fell within their location's warning window. */
  scanned: number;
  /** New `credits-expiring` rows enqueued this tick (dedupe skips excluded). */
  enqueued: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Per-location warning cutoff = now + that location's resolved lead days. */
async function resolveCutoffByLocation(
  tx: Tx,
  now: Date,
): Promise<Partial<Record<LocationKey, string>>> {
  const cutoffByLocation: Partial<Record<LocationKey, string>> = {};
  for (const location of LOCATION_SLUGS) {
    const leadDays = await creditExpirySettingsRepository.resolveWarningLeadDays(location, tx);
    cutoffByLocation[location] = new Date(now.getTime() + leadDays * ONE_DAY_MS).toISOString();
  }
  return cutoffByLocation;
}

/**
 * Notification body for a lot's owner. Terse, like the booking-reminder copy —
 * the FE renders type + title; the body is supplemental. The lot's remaining
 * credit count is the actionable detail ("use them before they expire").
 */
function expiryWarningBody(lot: ExpiringLotForWarning): string {
  const creditWord = lot.remaining === 1 ? 'credit' : 'credits';
  return `You have ${lot.remaining} ${creditWord} expiring soon — book a session before they're gone.`;
}

export async function enqueueCreditExpiryWarnings(
  tx: Tx,
  now: Date,
): Promise<EnqueueCreditExpiryWarningsResult> {
  const cutoffByLocation = await resolveCutoffByLocation(tx, now);
  const lots = await findExpiringLotsForWarning(tx, cutoffByLocation);

  let enqueued = 0;
  for (const lot of lots) {
    const row = await scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: lot.ownerId,
      type: 'credits-expiring',
      trigger: 'credits-expiring',
      // One warning per lot, ever — the UNIQUE dedupe key is the no-re-notify
      // floor across ticks. Keyed on the lot id (the source purchase row).
      dedupeKey: `credits-expiring:${lot.lotId}`,
      scheduledFor: now,
      title: 'Your credits are expiring soon',
      body: expiryWarningBody(lot),
      // Credits UI lives on the dog profile (decision 4).
      deepLinkPath: `/dog-profile/${lot.dogId}`,
      deepLinkKind: 'dog-profile',
      deepLinkId: lot.dogId,
      dogId: lot.dogId,
    });
    // `undefined` = ON CONFLICT fired (already warned on a prior tick) — not a
    // new enqueue, so it doesn't count toward the dedup invariant's "once".
    if (row !== undefined) enqueued += 1;
  }
  return { scanned: lots.length, enqueued };
}
