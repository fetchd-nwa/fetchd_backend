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
import { eq, inArray } from 'drizzle-orm';

import { db } from '../src/db/client.js';
import { env } from '../src/env.js';
import { deepLinkToPath, type NotificationType } from '../src/contracts/wire.js';
import { formatDollars } from '../src/lib/invoiceReceiptCopy.js';
import {
  bookingDogs,
  bookings,
  charges,
  creditPackages,
  invoices,
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

/**
 * Rows THIS seed owns. Fixed ids so the script is idempotent.
 *
 * Every one of these exists because a notification is ABOUT a particular state,
 * and `seed-dev` does not create that state. The first cut of this seed reused
 * whatever `seed-dev` happened to leave lying around, which made three rows lie
 * (Allison's sim QA, 2026-07-31): "Booking cancelled" opened a booking that was
 * not cancelled, "Reminder: tomorrow" opened a session from two weeks ago, and
 * "Payment received" opened an invoice that was still outstanding. The modals
 * were telling the truth — the seed was not. A QA fixture has to build the state
 * it claims to demonstrate.
 */
const QA = {
  reportWafflesId: '4e900000-0000-4000-8000-000000000001',
  membershipEndedId: 'e3b50000-0000-4000-8000-000000000001',
  /** Genuinely cancelled, with attribution — the cancelled banner needs who + why. */
  bookingCancelledId: 'b0070000-0000-4000-8000-00000000c001',
  /** Tomorrow, upcoming — what a "reminder: tomorrow" is actually about. */
  bookingTomorrowId: 'b0070000-0000-4000-8000-00000000c002',
  /** PAID, with the charge that settled it, so the receipt renders a card. */
  invoicePaidId: '12005000-0000-4000-8000-00000000c001',
  chargePaidId: 'c0a50000-0000-4000-8000-00000000c001',
  /** Flagged pay-in-person — what `payment-due` is about. */
  invoiceInPersonId: '12005000-0000-4000-8000-00000000c002',
  /** Open and well past due — what `invoice-overdue` is about. */
  invoiceOverdueId: '12005000-0000-4000-8000-00000000c003',
} as const;

/**
 * The uuid namespace every QA notification lives in. Cleanup deletes by this
 * PREFIX rather than by the ids a given run computes, because the numbering
 * below is positional — see `clearPriorQaRows`.
 */
const QA_NOTIFICATION_ID_PREFIX = '04170000-0000-4000-8000-';

/** One notification id per type — `04170000-…-<NN>`, numbered in feed order. */
function notificationId(index: number): string {
  return `${QA_NOTIFICATION_ID_PREFIX}${String(index).padStart(12, '0')}`;
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
 * `notification_type` appears EXACTLY once, except those listed in
 * `UNSEEDABLE_TYPES` below with a written reason — that near-total-coverage
 * property is the point of the file, and `assertEveryTypeCovered` fails the run
 * both when a new arm is forgotten here AND when an exemption goes stale.
 */
/**
 * The amount on every QA invoice, and therefore in every money notification's
 * copy. One constant because the four bodies below and the four invoice rows
 * they point at have to agree — an owner tapping "your $180 payment went
 * through" must land on a $180 invoice.
 */
const QA_INVOICE_CENTS = 18_000;

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
    deepLinkPath: deepLinkToPath({ kind: 'booking', id: QA.bookingCancelledId }),
    deepLinkKind: 'booking',
    deepLinkId: QA.bookingCancelledId,
    dogIds: [BASE.dogLolaId],
  },
  {
    type: 'booking-reminder',
    title: 'Reminder: Day School tomorrow',
    body: 'Waffles has Day School tomorrow at 9:00 AM.',
    deepLinkPath: deepLinkToPath({ kind: 'booking', id: QA.bookingTomorrowId }),
    deepLinkKind: 'booking',
    deepLinkId: QA.bookingTomorrowId,
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
    body: `Thanks! Your ${formatDollars(QA_INVOICE_CENTS)} payment went through.`,
    deepLinkPath: deepLinkToPath({ kind: 'invoice', id: QA.invoicePaidId }),
    deepLinkKind: 'invoice',
    deepLinkId: QA.invoicePaidId,
    isRead: true,
  },
  {
    type: 'payment-failed',
    title: 'Payment failed',
    body: `We couldn’t charge your card for ${formatDollars(QA_INVOICE_CENTS)}. Update it to keep booking.`,
    deepLinkPath: deepLinkToPath({ kind: 'invoice', id: BASE.invoiceOpenId }),
    deepLinkKind: 'invoice',
    deepLinkId: BASE.invoiceOpenId,
  },
  {
    type: 'payment-due',
    title: 'Payment due at drop-off',
    body: `Bring ${formatDollars(QA_INVOICE_CENTS)} (cash or check) when you drop off tomorrow.`,
    deepLinkPath: deepLinkToPath({ kind: 'invoice', id: QA.invoiceInPersonId }),
    deepLinkKind: 'invoice',
    deepLinkId: QA.invoiceInPersonId,
  },
  {
    type: 'invoice-overdue',
    title: 'Payment still outstanding',
    body: `Your ${formatDollars(QA_INVOICE_CENTS)} invoice hasn’t gone through yet. Check the card on file.`,
    deepLinkPath: deepLinkToPath({ kind: 'invoice', id: QA.invoiceOverdueId }),
    deepLinkKind: 'invoice',
    deepLinkId: QA.invoiceOverdueId,
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
 * Enum arms that deliberately have NO QA row, each with the reason it can't
 * have one. This is not a way to skip work — a fixture that cannot BUILD the
 * state it claims must not fabricate one, which is the whole lesson of the four
 * bugs Allison found by tapping (a "cancelled" booking that wasn't cancelled, a
 * "tomorrow" reminder pointing two weeks back). A row that lies is worse than
 * an absent row, because it reads as verified.
 *
 * Adding to this map is a deliberate act with a written reason. Everything not
 * listed here still has to have a row, and the check below still fails loudly.
 */
const UNSEEDABLE_TYPES: Readonly<Record<string, string>> = {
  // Parked 2026-07-31 with the rest of the waitlist. Nothing emits it (the
  // producer went back to `waitlist-wip` with the feature), there are no
  // `waitlist_entries` rows on this branch to point at, and the mobile
  // `/waitlist/[id]` screen isn't built — a tap lands on `+not-found`. The row
  // that used to sit here claimed "a Day Care spot opened up for Lola" and
  // deep-linked to BRODIE'S BOARDING BOOKING: wrong dog, wrong category, and
  // an offer pointing at a booking when the point of the type is that nothing
  // is booked yet. Restore a real row when the waitlist ships.
  'waitlist-spot-open': 'waitlist parked 2026-07-31 — no producer, no entry to link, no screen',
};

/**
 * The `seed-dev` rows this seed BORROWS rather than builds — stable identities
 * (the owner, her dogs, a thread, a card) that a notification points at.
 *
 * Checked before anything is written, because a dev DB that has drifted from
 * `seed-dev` is indistinguishable from a correct one at query time: every row
 * you ask about answers truthfully, it is the ABSENT rows that mislead. That is
 * not hypothetical — on 2026-08-01 this DB held 2 of the 4 seeded dogs and no
 * boarding bookings, and reading it produced two confident, wrong conclusions
 * about fixtures that were actually fine. A stale environment has to announce
 * itself; you cannot infer it from the answers it gives.
 */
const BORROWED_FROM_SEED_DEV: ReadonlyArray<{ what: string; table: string; id: string }> = [
  { what: 'owner Allison', table: 'owners', id: BASE.ownerAllisonId },
  { what: 'staff Shanthi', table: 'staff', id: BASE.staffShanthiId },
  { what: 'dog Waffles', table: 'dogs', id: BASE.dogWafflesId },
  { what: 'dog Lola', table: 'dogs', id: BASE.dogLolaId },
  { what: "Waffles' day-school booking", table: 'bookings', id: BASE.bookingWafflesSchoolId },
  { what: "Allison's thread", table: 'threads', id: BASE.threadAllisonId },
  { what: "Allison's card", table: 'payment_methods', id: BASE.paymentMethodAllisonId },
  { what: 'the open invoice', table: 'invoices', id: BASE.invoiceOpenId },
  { what: 'the Yappy Hour announcement', table: 'announcements', id: BASE.annYappyHourId },
];

/**
 * Refuse to seed against a dev DB that `seed-dev` hasn't populated (or has
 * populated to a different shape). Seeding anyway produces a feed that LOOKS
 * complete while pointing at subjects that aren't there — the exact failure this
 * file exists to prevent, one level up.
 */
async function assertBaseSeedPresent(): Promise<void> {
  const absent: string[] = [];
  for (const subject of BORROWED_FROM_SEED_DEV) {
    const rows = await db.execute(
      `SELECT 1 FROM ${subject.table} WHERE id = '${subject.id}' LIMIT 1`,
    );
    if (rows.rows.length === 0) absent.push(`${subject.what} (${subject.table})`);
  }
  if (absent.length > 0) {
    throw new Error(
      `seed-notifications-qa: the dev DB is missing ${absent.length} row(s) this seed points at:\n` +
        absent.map((a) => `  · ${a}`).join('\n') +
        `\nThe dev DB has drifted from scripts/seed-dev.ts. Run \`npm run db:dev:seed\` first ` +
        `(then this). Seeding on top of a stale DB yields a feed that looks right and isn't — ` +
        `and any diagnosis read off that DB will be wrong in the same invisible way.`,
    );
  }
}

/**
 * Fails the run if the enum grows an arm this seed neither covers nor
 * explicitly parks. Allison's requirement is "every notification type exists in
 * the notifications so I can verify" — that only stays true if adding a type
 * without a QA row is loud. Reads the live pgEnum rather than a hand-copied
 * list, so it can't drift.
 *
 * Also fails if `UNSEEDABLE_TYPES` names an arm that no longer exists, or one
 * that now HAS a row — a stale exemption is how a gap quietly reopens.
 */
async function assertEveryTypeCovered(): Promise<void> {
  const rows = await db.execute(
    `SELECT e.enumlabel AS label
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'notification_type'`,
  );
  const inDatabase = (rows.rows as { label: string }[]).map((r) => r.label);
  const covered = new Set<string>(QA_NOTIFICATIONS.map((n) => n.type));
  const parked = Object.keys(UNSEEDABLE_TYPES);

  const missing = inDatabase.filter((label) => !covered.has(label) && !parked.includes(label));
  if (missing.length > 0) {
    throw new Error(
      `seed-notifications-qa is missing a row for: ${missing.join(', ')}. ` +
        `Add one to QA_NOTIFICATIONS so every type stays verifiable in the feed ` +
        `(or, if it genuinely cannot be demonstrated yet, add it to UNSEEDABLE_TYPES with a reason).`,
    );
  }

  const staleExemptions = parked.filter((label) => !inDatabase.includes(label) || covered.has(label));
  if (staleExemptions.length > 0) {
    throw new Error(
      `UNSEEDABLE_TYPES is stale for: ${staleExemptions.join(', ')} — ` +
        `each is either gone from the enum or now has a QA row. Remove the exemption.`,
    );
  }

  for (const [label, why] of Object.entries(UNSEEDABLE_TYPES)) {
    console.log(`  · ${label}: no QA row on purpose — ${why}`);
  }
}

/** `days` from now at `hour` Chicago-ish, as an ISO instant. */
function daysFromNow(days: number, hour = 14): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/**
 * The booking + invoice states the notifications are ABOUT. Each one exists
 * because the notification claiming it would otherwise open a row in the wrong
 * state and quietly contradict its own copy.
 */
async function seedNotificationSubjects(): Promise<void> {
  await db.insert(bookings).values([
    {
      // "Booking cancelled" — genuinely cancelled, WITH attribution, so the
      // modal can render "You cancelled this on…" rather than a normal booking.
      id: QA.bookingCancelledId,
      ownerId: BASE.ownerAllisonId,
      leadDogId: BASE.dogLolaId,
      category: 'private-lesson',
      status: 'cancelled',
      scheduledAt: daysFromNow(4, 15),
      durationMinutes: 60,
      location: 'fayetteville',
      lessonSetting: 'home',
      cancelledAt: hoursAgo(20),
      cancelledBy: 'owner',
    },
    {
      // "Reminder: Day School tomorrow" — an UPCOMING session tomorrow, which
      // is the only thing that sentence can honestly point at.
      id: QA.bookingTomorrowId,
      ownerId: BASE.ownerAllisonId,
      leadDogId: BASE.dogWafflesId,
      category: 'day-school',
      status: 'upcoming',
      scheduledAt: daysFromNow(1, 9),
      durationMinutes: 540,
      location: 'fayetteville',
    },
  ]);
  await db.insert(bookingDogs).values([
    { bookingId: QA.bookingCancelledId, dogId: BASE.dogLolaId, isLead: true },
    { bookingId: QA.bookingTomorrowId, dogId: BASE.dogWafflesId, isLead: true },
  ]);

  // "Payment received" needs a PAID invoice and the charge that settled it —
  // the paid-invoice modal derives its card + paid date from that link.
  await db.insert(charges).values({
    id: QA.chargePaidId,
    ownerId: BASE.ownerAllisonId,
    amountCents: QA_INVOICE_CENTS,
    status: 'succeeded',
    purpose: 'payg',
    createdAt: hoursAgo(7),
  });
  await db.insert(invoices).values([
    {
      id: QA.invoicePaidId,
      ownerId: BASE.ownerAllisonId,
      amountCents: QA_INVOICE_CENTS,
      status: 'paid',
      purpose: 'payg',
      paymentMethodId: BASE.paymentMethodAllisonId,
      paidChargeId: QA.chargePaidId,
      issuedAt: hoursAgo(48),
      dueAt: hoursAgo(24),
      paidAt: hoursAgo(7),
    },
    {
      // "Payment due at drop-off" — the cash/check path.
      id: QA.invoiceInPersonId,
      ownerId: BASE.ownerAllisonId,
      amountCents: QA_INVOICE_CENTS,
      status: 'open',
      purpose: 'payg',
      paymentMethodId: BASE.paymentMethodAllisonId,
      paymentExpected: 'in-person',
      issuedAt: hoursAgo(24),
      dueAt: daysFromNow(1, 9),
    },
    {
      // "Payment still outstanding" — open and past the 3-day grace window.
      id: QA.invoiceOverdueId,
      ownerId: BASE.ownerAllisonId,
      amountCents: QA_INVOICE_CENTS,
      status: 'open',
      purpose: 'payg',
      paymentMethodId: BASE.paymentMethodAllisonId,
      issuedAt: hoursAgo(24 * 12),
      dueAt: hoursAgo(24 * 6),
    },
  ]);
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
  //
  // `package_id` is REQUIRED even though the membership has ended: GET
  // /memberships filters on `hasSubscriptionColumns()` (package_id, term_months,
  // payment_method_id and current_period_end all non-null), so a row missing any
  // of them is invisible to the app. The first cut omitted it, and the ended
  // subscription looked DELETED rather than completed (Allison's sim QA,
  // 2026-07-31). A real membership from the billing roll always carries one.
  const [schoolPackage] = await db
    .select({ id: creditPackages.id })
    .from(creditPackages)
    .where(eq(creditPackages.mode, 'school'))
    .limit(1);
  if (schoolPackage === undefined) {
    throw new Error('seed-notifications-qa: no school credit package — run db:dev:seed first');
  }
  await db.insert(memberships).values({
    id: QA.membershipEndedId,
    ownerId: BASE.ownerAllisonId,
    dogId: BASE.dogWafflesId,
    mode: 'school',
    packageId: schoolPackage.id,
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
  // Delete the whole QA id NAMESPACE, not just the ids this run happens to
  // produce. `notificationId` numbers rows by their position in the roster, so
  // adding, removing or reordering a row shifts every id after it — and a
  // cleanup scoped to the current list would leave the previous run's rows
  // behind under the ids that shifted. That is not hypothetical: parking
  // `waitlist-spot-open` shifted six ids and left an orphaned duplicate
  // "Yappy Hour is back" in the feed, which is precisely the kind of thing the
  // owner finds by tapping and the seed exists to prevent.
  await db.execute(
    `DELETE FROM notification_dogs
      WHERE notification_id::text LIKE '${QA_NOTIFICATION_ID_PREFIX}%'`,
  );
  await db.execute(
    `DELETE FROM notifications WHERE id::text LIKE '${QA_NOTIFICATION_ID_PREFIX}%'`,
  );
  await db.delete(memberships).where(inArray(memberships.id, [QA.membershipEndedId]));
  await db.delete(reports).where(inArray(reports.id, [QA.reportWafflesId]));
  // Invoices before charges (paid_charge_id FK), bookingDogs before bookings.
  await db
    .delete(invoices)
    .where(inArray(invoices.id, [QA.invoicePaidId, QA.invoiceInPersonId, QA.invoiceOverdueId]));
  await db.delete(charges).where(inArray(charges.id, [QA.chargePaidId]));
  await db
    .delete(bookingDogs)
    .where(inArray(bookingDogs.bookingId, [QA.bookingCancelledId, QA.bookingTomorrowId]));
  await db
    .delete(bookings)
    .where(inArray(bookings.id, [QA.bookingCancelledId, QA.bookingTomorrowId]));
}

async function main(): Promise<void> {
  assertLocalDb();
  // Preconditions before any write: the base seed must be present (a stale DB
  // cannot be detected from the answers it gives), and the enum must be covered.
  await assertBaseSeedPresent();
  await assertEveryTypeCovered();
  await clearPriorQaRows();
  await seedNotificationSubjects();
  await seedSupportingRows();
  await seedNotifications();
  console.log(
    `seed-notifications-qa: seeded ${QA_NOTIFICATIONS.length} notifications ` +
      `(one per notification_type, less ${Object.keys(UNSEEDABLE_TYPES).length} parked above) ` +
      `for owner ${BASE.ownerAllisonId}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
