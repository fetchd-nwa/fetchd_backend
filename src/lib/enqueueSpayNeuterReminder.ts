import { deepLinkToPath } from '../contracts/wire.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import { chicagoWallTimeToUtc } from './chicagoDate.js';

/**
 * Spay/neuter planned-date reminder (Shanthi ruling 2026-07-14): when an
 * owner answers "not yet — planning to on <date>", we schedule one push/feed
 * reminder for that morning prompting them to update the dog's profile.
 *
 * Called from POST /dogs and PATCH /dogs/:id whenever either spay field is
 * in the write, with the dog's POST-update state. Sync semantics:
 *
 *   - Any previously-pending reminder for this dog is cancelled first — a
 *     moved date or a "they're fixed now" answer supersedes it.
 *   - A reminder is (re)scheduled only while the dog is explicitly intact
 *     (`spayedNeutered === false`) AND a planned date is on file.
 *   - The dedupe key is date-scoped (`spay-neuter:<dogId>:<date>`), so the
 *     A → B → A date dance revives the cancelled A row instead of colliding
 *     with it (`revivePendingByDedupeKey`).
 *
 * Fires at 9:00 AM America/Chicago on the planned date — late enough to not
 * wake anyone, early enough to catch the day. A past date enqueues as
 * already-due and the worker sends it on the next tick (same convention as
 * booking reminders placed <24h out).
 */

const REMINDER_HOUR_CT = 9;

export async function syncSpayNeuterReminder(
  tx: Tx,
  args: {
    dogId: string;
    ownerId: string;
    dogName: string;
    spayedNeutered: boolean | null;
    /** YYYY-MM-DD or null — the dog row's post-write value. */
    plannedOn: string | null;
  },
): Promise<void> {
  const prefix = `spay-neuter:${args.dogId}:`;
  await scheduledNotificationsRepository.cancelPendingByDedupePrefix(tx, prefix);

  if (args.spayedNeutered !== false || args.plannedOn === null) return;

  const dedupeKey = `${prefix}${args.plannedOn}`;
  const scheduledFor = chicagoWallTimeToUtc(args.plannedOn, REMINDER_HOUR_CT, 0);
  const enqueued = await scheduledNotificationsRepository.enqueueIdempotent(tx, {
    ownerId: args.ownerId,
    type: 'spay-neuter-reminder',
    trigger: 'spay-neuter-reminder',
    dedupeKey,
    scheduledFor,
    title: `Is ${args.dogName} spayed/neutered yet?`,
    body: `You planned to have ${args.dogName} spayed/neutered around today — once it's done, update their profile so our records stay current.`,
    deepLinkPath: deepLinkToPath({ kind: 'dog-manage', id: args.dogId }),
    deepLinkKind: 'dog-manage',
    deepLinkId: args.dogId,
    dogId: args.dogId,
  });
  if (enqueued === undefined) {
    // Same (dog, date) was enqueued before and later cancelled — revive it.
    await scheduledNotificationsRepository.revivePendingByDedupeKey(tx, {
      dedupeKey,
      scheduledFor,
    });
  }
}
