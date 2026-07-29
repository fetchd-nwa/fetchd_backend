import { deepLinkToPath } from '../contracts/wire.js';
import {
  paymentMethodsRepository,
  type ExpiringCardForWarning,
} from '../db/repositories/paymentMethodsRepository.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';

/**
 * Card-expiry warning scan (Allison 2026-07-29). Same scheduled-scan shape as
 * `enqueueCreditExpiryWarnings`. Every invoice in this system is card-backed and
 * auto-charged (the anti-scam floor locked 2026-05-19), so a lapsed default card
 * doesn't degrade gracefully — it turns every future charge into a decline. This
 * warns before that happens, and once more after it has, so the failure mode is
 * "you were told twice" rather than "your bookings quietly stopped working".
 *
 * Each card fires at most twice, on distinct dedupe keys:
 *   - `card-expiring:<pmId>:warn`   — inside the warning window, still valid.
 *   - `card-expiring:<pmId>:lapsed` — the first tick at or after expiry.
 * A card replaced between the two never reaches the second: swapping the default
 * soft-expires the old row (`expired_at`), which drops it from the scan.
 */

/** How far ahead of a card's expiry the first warning fires (Allison 2026-07-29). */
export const CARD_EXPIRY_WARNING_DAYS = 7;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface EnqueueCardExpiryWarningsResult {
  /** Live default cards inside the warning window or already lapsed. */
  scanned: number;
  /** New `card-expiring` rows enqueued this tick (dedupe skips excluded). */
  enqueued: number;
}

type CardExpiryStage = 'warn' | 'lapsed';

function cardLabel(card: ExpiringCardForWarning): string {
  return `${card.brand} ••${card.last4}`;
}

function expiryTitle(stage: CardExpiryStage): string {
  return stage === 'warn' ? 'Your card expires soon' : 'Your card has expired';
}

function expiryBody(card: ExpiringCardForWarning, stage: CardExpiryStage): string {
  return stage === 'warn'
    ? `${cardLabel(card)} expires this month. Add a new card so your sessions keep booking without a hitch.`
    : `${cardLabel(card)} has expired. Add a new card to keep booking sessions.`;
}

export async function enqueueCardExpiryWarnings(
  tx: Tx,
  now: Date,
): Promise<EnqueueCardExpiryWarningsResult> {
  const warnCutoff = new Date(now.getTime() + CARD_EXPIRY_WARNING_DAYS * ONE_DAY_MS);
  const cards = await paymentMethodsRepository.findExpiringDefaults({ warnCutoff }, tx);

  let enqueued = 0;
  for (const card of cards) {
    const stage: CardExpiryStage = new Date(card.expiresAt) <= now ? 'lapsed' : 'warn';
    const row = await scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: card.ownerId,
      type: 'card-expiring',
      trigger: 'card-expiring',
      dedupeKey: `card-expiring:${card.paymentMethodId}:${stage}`,
      scheduledFor: now,
      title: expiryTitle(stage),
      body: expiryBody(card, stage),
      // Point at the CARD, not the wallet page — the notification is about one
      // row in a list that may hold several.
      deepLinkPath: deepLinkToPath({ kind: 'payment-method', id: card.paymentMethodId }),
      deepLinkKind: 'payment-method',
      deepLinkId: card.paymentMethodId,
    });
    if (row !== undefined) enqueued += 1;
  }
  return { scanned: cards.length, enqueued };
}
