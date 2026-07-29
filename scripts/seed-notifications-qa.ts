/**
 * Notification QA seed — one live notification of EVERY `notification_type`
 * arm, each with a deep link that actually resolves in the owner app.
 *
 * Why this exists (Allison 2026-07-29): the notification feed had been QA'd
 * with hand-typed SQL that lived only in shell history, so every environment
 * teardown lost it and the next session re-typed it slightly differently. This
 * makes the QA state reproducible — run it, open the bell, and tap all 17 rows.
 *
 * It is ADDITIVE to `seed-dev.ts`, not a replacement: run `db:dev:seed` first
 * (it owns owners/dogs/bookings/invoices/threads/announcements), then this. It
 * creates only what the notification deep links need and `seed-dev` doesn't
 * make — one report, one ended membership — plus the notification rows.
 *
 * Re-runnable: every row it writes carries a fixed id from `QA` below, and it
 * deletes those ids first. It never touches anything else.
 *
 *   npm run db:dev:seed          # base fixtures
 *   npm run db:dev:seed:notifs   # this
 *
 * Every `deep_link_path` is derived through `deepLinkToPath` — the same grammar
 * the real producers use — so a QA row can never point somewhere a real
 * notification couldn't. If a kind's path changes, this seed changes with it.
 */
import { inArray } from 'drizzle-orm';

import { db } from '../src/db/client.js';
import { env } from '../src/env.js';
import { deepLinkToPath, type NotificationType } from '../src/contracts/wire.js';
import {
  memberships,
  notificationDogs,
  notifications,
  reports,
} from '../src/db/schema/schema.js';

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '(unparseable)';
  }
}

function assertLocalDb(): void {
  const url = env.DATABASE_URL;
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  if (!isLocal || env.NODE_ENV === 'production') {
    throw new Error(
      `seed-notifications-qa refuses to run: DATABASE_URL must be local and NODE_ENV must not ` +
        `be production (got NODE_ENV=${env.NODE_ENV}, host=${safeHost(url)}).`,
    );
  }
}

/** Ids from `seed-dev.ts` this seed deep-links into. Keep in sync with its SEED. */
const BASE = {
  ownerAllisonId: '0caa0000-0000-4000-8000-000000000001',
  staffShanthiId: '00000000-0000-4000-8000-0000000000a1',
  dogWafflesId: 'd0900000-0000-4000-8000-000000000001',
  dogLolaId: 'd0900000-0000-4000-8000-000000000002',
  bookingWafflesSchoolId: 'b0070000-0000-4000-8000-000000000001',
  bookingLolaLessonId: 'b0070000-0000-4000-8000-000000000002',
  bookingBrodieBoardingId: 'b0070000-0000-4000-8000-000000000003',
  bookingWafflesPastSchoolId: 'b0070000-0000-4000-8000-000000000005',
  threadAllisonId: '7a700000-0000-4000-8000-000000000001',
  paymentMethodAllisonId: 'b00a0000-0000-4000-8000-000000000001',
  invoiceOpenId: '12005000-0000-4000-8000-000000000001',
  annYappyHourId: 'a11c0000-0000-4000-8000-000000000002',
} as const;

/** Rows THIS seed owns. Fixed ids so the script is idempotent. */
const QA = {
  reportWafflesId: '4e900000-0000-4000-8000-000000000001',
  membershipEndedId: 'e3b50000-0000-4000-8000-000000000001',
} as const;

/** One notification id per type — `n0417000-…-<NN>`, numbered in feed order. */
function notificationId(index: number): string {
  return `04170000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

const HOUR_MS = 60 * 60 * 1000;

/** Stagger `received_at` an hour apart so the feed order is stable + readable. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

interface QaNotification {
  type: NotificationType;
  title: string;
  body: string;
  deepLinkPath: string;
  deepLinkKind: string;
  deepLinkId: string;
  /** Dogs to stack on the row's avatar (notification_dogs). */
  dogIds?: readonly string[];
  /** message-received only — renders the sender's face. */
  senderStaffId?: string;
  /** Leave a few unread so the badge + unread styling are visible. */
  isRead?: boolean;
}

/**
 * The full roster, in the order they'll appear (newest first). Every arm of
 * `notification_type` appears EXACTLY once — that total-coverage property is
 * the point of the file, and the `assertEveryTypeCovered` check below fails the
 * run if a future arm is added to the enum and forgotten here.
 */
const QA_NOTIFICATIONS: readonly QaNotification[] = [
  {
    type: 'booking-confirmed',
    title: 'Booking confirmed',
    body: 'Waffles is booked for Day School. See you then.',
    deepLinkPath: deepLinkToPath({ kind: 'booking', id: BASE.bookingWafflesSchoolId }),
    deepLinkKind: 'booking',
    deepLinkId: BASE.bookingWafflesSchoolId,
    dogIds: [BASE.dogWafflesId],
  },
  {
    type: 'booking-cancelled',
    title: 'Booking cancelled',
    body: 'Lola’s private lesson was cancelled. Your credit has been returned.',
    deepLinkPath: deepLinkToPath({ kind: 'booking', id: BASE.bookingLolaLessonId }),
    deepLinkKind: 'booking',
    deepLinkId: BASE.bookingLolaLessonId,
    dogIds: [BASE.dogLolaId],
  },
  {
    type: 'booking-reminder',
    title: 'Reminder: Day School tomorrow',
    body: 'Waffles has Day School tomorrow at 9:00 AM.',
    deepLinkPath: deepLinkToPath({ kind: 'booking', id: BASE.bookingWafflesPastSchoolId }),
    deepLinkKind: 'booking',
    deepLinkId: BASE.bookingWafflesPastSchoolId,
    dogIds: [BASE.dogWafflesId],
  },
  {
    type: 'boarding-profile-check',
    title: 'Heads up: boarding drop-off tomorrow',
    body: 'Check Waffles’ feeding and medication notes before drop-off.',
    deepLinkPath: deepLinkToPath({ kind: 'dog-manage', id: BASE.dogWafflesId }),
    deepLinkKind: 'dog-manage',
    deepLinkId: BASE.dogWafflesId,
    dogIds: [BASE.dogWafflesId],
  },
  {
    type: 'report-published',
    title: 'New report card',
    body: 'Waffles had a great day — loose-leash work is really clicking.',
    deepLinkPath: deepLinkToPath({
      kind: 'report',
      id: QA.reportWafflesId,
      params: { dogId: BASE.dogWafflesId },
    }),
    deepLinkKind: 'report',
    deepLinkId: QA.reportWafflesId,
    dogIds: [BASE.dogWafflesId],
  },
  {
    type: 'message-received',
    title: 'New message',
    body: 'Shanthi: Waffles did so well today! Sent a few photos.',
    deepLinkPath: deepLinkToPath({ kind: 'thread', id: BASE.threadAllisonId }),
    deepLinkKind: 'thread',
    deepLinkId: BASE.threadAllisonId,
    senderStaffId: BASE.staffShanthiId,
  },
  {
    type: 'payment-succeeded',
    title: 'Payment received',
    body: 'Thanks! Your $180.00 payment went through.',
    deepLinkPath: deepLinkToPath({ kind: 'invoice', id: BASE.invoiceOpenId }),
    deepLinkKind: 'invoice',
    deepLinkId: BASE.invoiceOpenId,
    isRead: true,
  },
  {
    type: 'payment-failed',
    title: 'Payment failed',
    body: 'We couldn’t charge your card for $180.00. Update it to keep booking.',
    deepLinkPath: deepLinkToPath({ kind: 'invoice', id: BASE.invoiceOpenId }),
    deepLinkKind: 'invoice',
    deepLinkId: BASE.invoiceOpenId,
  },
  {
    type: 'payment-due',
    title: 'Payment due at drop-off',
    body: 'Bring $180.00 (cash or check) when you drop off tomorrow.',
    deepLinkPath: deepLinkToPath({ kind: 'invoice', id: BASE.invoiceOpenId }),
    deepLinkKind: 'invoice',
    deepLinkId: BASE.invoiceOpenId,
  },
  {
    type: 'invoice-overdue',
    title: 'Payment still outstanding',
    body: 'Your $180.00 invoice hasn’t gone through yet. Check the card on file.',
    deepLinkPath: deepLinkToPath({ kind: 'invoice', id: BASE.invoiceOpenId }),
    deepLinkKind: 'invoice',
    deepLinkId: BASE.invoiceOpenId,
  },
  {
    type: 'card-expiring',
    title: 'Your card expires soon',
    body: 'Visa ••4242 expires this month. Add a new card so your sessions keep booking.',
    deepLinkPath: deepLinkToPath({ kind: 'payment-method', id: BASE.paymentMethodAllisonId }),
    deepLinkKind: 'payment-method',
    deepLinkId: BASE.paymentMethodAllisonId,
  },
  {
    type: 'membership-ended',
    title: 'Your subscription has ended',
    body: 'Waffles’ Day School subscription reached the end of its term.',
    deepLinkPath: deepLinkToPath({
      kind: 'membership',
      id: QA.membershipEndedId,
      params: { dogId: BASE.dogWafflesId },
    }),
    deepLinkKind: 'membership',
    deepLinkId: QA.membershipEndedId,
    dogIds: [BASE.dogWafflesId],
  },
  {
    type: 'credits-expiring',
    title: 'Your credits are expiring soon',
    body: 'You have 4 credits expiring soon — book a session before they’re gone.',
    deepLinkPath: deepLinkToPath({ kind: 'credits', id: BASE.dogWafflesId }),
    deepLinkKind: 'credits',
    deepLinkId: BASE.dogWafflesId,
    dogIds: [BASE.dogWafflesId],
  },
  {
    type: 'waitlist-spot-open',
    title: 'You’re in',
    body: 'A spot opened up — Lola is confirmed for Day Care on Thursday.',
    deepLinkPath: deepLinkToPath({ kind: 'booking', id: BASE.bookingBrodieBoardingId }),
    deepLinkKind: 'booking',
    deepLinkId: BASE.bookingBrodieBoardingId,
    dogIds: [BASE.dogLolaId],
  },
  {
    type: 'alumni-attendance',
    title: 'Alumni check-in needed',
    body: 'Lola hasn’t been in much lately — chat with staff before the next visit.',
    deepLinkPath: deepLinkToPath({ kind: 'dog-profile', id: BASE.dogLolaId }),
    deepLinkKind: 'dog-profile',
    deepLinkId: BASE.dogLolaId,
    dogIds: [BASE.dogLolaId],
    isRead: true,
  },
  {
    type: 'spay-neuter-reminder',
    title: 'Is Waffles spayed/neutered yet?',
    body: 'You told us the procedure was planned for around now — update the profile.',
    deepLinkPath: deepLinkToPath({ kind: 'dog-manage', id: BASE.dogWafflesId }),
    deepLinkKind: 'dog-manage',
    deepLinkId: BASE.dogWafflesId,
    dogIds: [BASE.dogWafflesId],
    isRead: true,
  },
  {
    type: 'announcement',
    title: 'Yappy Hour is back',
    body: 'Join us Friday evening at the Fayetteville school.',
    deepLinkPath: deepLinkToPath({ kind: 'announcement', id: BASE.annYappyHourId }),
    deepLinkKind: 'announcement',
    deepLinkId: BASE.annYappyHourId,
    isRead: true,
  },
];

/**
 * Fails the run if the enum grows an arm this seed doesn't cover. Allison's
 * requirement is "every notification type exists in the notifications so I can
 * verify" — that only stays true if adding a type without a QA row is loud.
 * Reads the live pgEnum rather than a hand-copied list, so it can't drift.
 */
async function assertEveryTypeCovered(): Promise<void> {
  const rows = await db.execute(
    `SELECT e.enumlabel AS label
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'notification_type'`,
  );
  const inDatabase = (rows.rows as { label: string }[]).map((r) => r.label);
  const covered = new Set<string>(QA_NOTIFICATIONS.map((n) => n.type));
  const missing = inDatabase.filter((label) => !covered.has(label));
  if (missing.length > 0) {
    throw new Error(
      `seed-notifications-qa is missing a row for: ${missing.join(', ')}. ` +
        `Add one to QA_NOTIFICATIONS so every type stays verifiable in the feed.`,
    );
  }
}

async function seedSupportingRows(): Promise<void> {
  // A published report for Waffles — `report-published` deep-links at it, and
  // seed-dev creates no reports.
  await db.insert(reports).values({
    id: QA.reportWafflesId,
    dogId: BASE.dogWafflesId,
    date: hoursAgo(30),
    trainerStaffId: BASE.staffShanthiId,
    category: 'day-school',
    program: 'foundation',
    excerpt: 'Waffles had a great day — loose-leash work is really clicking.',
    fullText:
      'Waffles came in bright and settled quickly. We spent most of the session on ' +
      'loose-leash walking and he held a much looser line than last week, even past ' +
      'the fence. Recall is still a work in progress with distractions around.',
    visitCount: 12,
  });

  // A COMPLETED membership so `membership-ended` lands on a real ended card.
  await db.insert(memberships).values({
    id: QA.membershipEndedId,
    ownerId: BASE.ownerAllisonId,
    dogId: BASE.dogWafflesId,
    mode: 'school',
    termMonths: 6,
    paymentMethodId: BASE.paymentMethodAllisonId,
    status: 'completed',
    startedAt: hoursAgo(24 * 200),
    currentPeriodStart: hoursAgo(24 * 32),
    currentPeriodEnd: hoursAgo(24 * 2),
    endsAt: hoursAgo(24 * 2),
  });
}

async function seedNotifications(): Promise<void> {
  const rows = QA_NOTIFICATIONS.map((notification, index) => ({
    id: notificationId(index + 1),
    ownerId: BASE.ownerAllisonId,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    receivedAt: hoursAgo(index + 1),
    readAt: notification.isRead === true ? hoursAgo(index) : null,
    deepLinkPath: notification.deepLinkPath,
    deepLinkKind: notification.deepLinkKind as (typeof notifications.$inferInsert)['deepLinkKind'],
    deepLinkId: notification.deepLinkId,
    senderStaffId: notification.senderStaffId ?? null,
  }));
  await db.insert(notifications).values(rows);

  const dogLinks = QA_NOTIFICATIONS.flatMap((notification, index) =>
    (notification.dogIds ?? []).map((dogId) => ({
      notificationId: notificationId(index + 1),
      dogId,
    })),
  );
  if (dogLinks.length > 0) await db.insert(notificationDogs).values(dogLinks);
}

/** Clear only the rows this script owns, so re-running is safe + idempotent. */
async function clearPriorQaRows(): Promise<void> {
  const ids = QA_NOTIFICATIONS.map((_, index) => notificationId(index + 1));
  await db.delete(notificationDogs).where(inArray(notificationDogs.notificationId, ids));
  await db.delete(notifications).where(inArray(notifications.id, ids));
  await db.delete(memberships).where(inArray(memberships.id, [QA.membershipEndedId]));
  await db.delete(reports).where(inArray(reports.id, [QA.reportWafflesId]));
}

async function main(): Promise<void> {
  assertLocalDb();
  await assertEveryTypeCovered();
  await clearPriorQaRows();
  await seedSupportingRows();
  await seedNotifications();
  console.log(
    `seed-notifications-qa: seeded ${QA_NOTIFICATIONS.length} notifications ` +
      `(one per notification_type) for owner ${BASE.ownerAllisonId}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
