import { deepLinkToPath } from '../contracts/wire.js';
import { scheduledNotificationsRepository } from '../db/repositories/scheduledNotificationsRepository.js';
import type { Tx } from '../db/tx.js';
import type { ServiceCategory } from './bookingBucket.js';

/**
 * Booking-creation trigger: enqueue the schedule rows the scheduler
 * worker (Day-16) will later send. Called from all four booking-creation
 * paths (`routes/bookings.ts` day-program, `routes/enrollments.ts`
 * cohort, `routes/staffRequests.ts` approve, `routes/requestConfirmPayment.ts`
 * B&T conversion) right after the booking row + any time-stamping is
 * complete.
 *
 * Two enqueues today, both keyed by stable `dedupe_key`s so an idempotent
 * replay of the booking-creation tx never double-schedules:
 *
 *   1. **`booking-reminder`** — always enqueued, fires at
 *      `scheduledAt - 24h`. Category-uniform window for v1 (Day-16
 *      decision; per-category windows tunable later because the row
 *      carries its `scheduled_for` literal).
 *
 *   2. **`boarding-profile-check`** — only for `'boarding'` /
 *      `'board-and-train'`, fires at `(dropoffAt ?? scheduledAt) - 24h`.
 *      Surfaces a pre-stay reminder for the boarding-specific intake
 *      paperwork (vaccines current, feeding instructions, etc.).
 *
 * The INSERTs happen inside the caller's tx, so a failed booking insert
 * rolls back the schedule rows too — no orphan reminders for non-existent
 * bookings. The UNIQUE on `dedupe_key` is the idempotency floor: a replay
 * under the same Idempotency-Key sees `ON CONFLICT DO NOTHING`.
 *
 * Past-due scheduled_for is fine — the worker picks it up on the next
 * tick. Booking placed <24h ahead → user gets the reminder ~immediately,
 * which doubles as a confirmation. Simpler than gating the enqueue.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Categories that get the boarding-profile-check enqueue. */
const BOARDING_CATEGORIES = new Set<ServiceCategory>(['boarding', 'board-and-train']);

export interface EnqueueBookingRemindersArgs {
  bookingId: string;
  ownerId: string;
  leadDogId: string;
  category: ServiceCategory;
  scheduledAt: Date;
  /**
   * Stay drop-off — used for boarding-profile-check timing. When NULL/
   * undefined and the category is boarding/B&T, falls back to
   * `scheduledAt` (the boarding day-of). Day-15 B&T flow stamps
   * `dropoffAt` after the booking insert; pass it explicitly.
   */
  dropoffAt?: Date | null;
}

/**
 * Human-readable category for the notification body. Kept terse — the
 * FE renders type + title; the body is supplemental. Day-18 may swap to
 * a richer copy table.
 */
function categoryHuman(category: ServiceCategory): string {
  switch (category) {
    case 'day-school':
      return 'Day School session';
    case 'day-care':
      return 'Day Care session';
    case 'group-class':
      return 'Group Class';
    case 'private-lesson':
      return 'Private Lesson';
    case 'board-and-train':
      return 'Board & Train stay';
    case 'boarding':
      return 'Boarding stay';
    case 'evaluation':
      return 'Evaluation';
  }
}

export async function enqueueBookingReminders(
  tx: Tx,
  args: EnqueueBookingRemindersArgs,
): Promise<void> {
  const human = categoryHuman(args.category);

  const reminderFor = new Date(args.scheduledAt.getTime() - ONE_DAY_MS);
  await scheduledNotificationsRepository.enqueueIdempotent(tx, {
    ownerId: args.ownerId,
    type: 'booking-reminder',
    trigger: 'booking-reminder',
    dedupeKey: `booking-reminder:${args.bookingId}`,
    scheduledFor: reminderFor,
    title: `Reminder: ${human} tomorrow`,
    body: `Your ${human} is coming up — we'll see you soon.`,
    deepLinkPath: deepLinkToPath({ kind: 'booking', id: args.bookingId }),
    deepLinkKind: 'booking',
    deepLinkId: args.bookingId,
    bookingId: args.bookingId,
    dogId: args.leadDogId,
  });

  if (BOARDING_CATEGORIES.has(args.category)) {
    const stayAnchor = args.dropoffAt ?? args.scheduledAt;
    const profileCheckFor = new Date(stayAnchor.getTime() - ONE_DAY_MS);
    await scheduledNotificationsRepository.enqueueIdempotent(tx, {
      ownerId: args.ownerId,
      type: 'boarding-profile-check',
      trigger: 'boarding-24h',
      dedupeKey: `boarding-24h:${args.bookingId}`,
      scheduledFor: profileCheckFor,
      title: `Heads up: ${human} drop-off tomorrow`,
      body: `Drop-off is in 24 hours. A quick check that vaccines, meds, and feeding notes are up to date.`,
      // The copy asks the owner to verify vaccines/meds/feeding, so it lands on
      // the dog edit form (decision 5) rather than the booking detail.
      deepLinkPath: deepLinkToPath({ kind: 'dog-manage', id: args.leadDogId }),
      deepLinkKind: 'dog-manage',
      deepLinkId: args.leadDogId,
      bookingId: args.bookingId,
      dogId: args.leadDogId,
    });
  }
}
