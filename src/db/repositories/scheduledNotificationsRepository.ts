import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { scheduledNotifications } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/** Polymorphic runner — pool for pre/post-tx reads, Tx for in-mutation work. */
type Runner = Tx | typeof db;

/**
 * Data-access seam for `scheduled_notifications` (schema.sql ~line 1072).
 * The outbound queue of pushes to emit at-or-after a time. Distinct from
 * `notifications` (the delivered in-app feed): an entry here is intent to
 * notify; the worker emits the push + INSERTs the matching `notifications`
 * row and links via `emitted_notification_id`.
 *
 * Lifecycle (Day 16):
 *   - **Enqueue** — `enqueueIdempotent` inserts a 'pending' row with a
 *     `dedupe_key` (e.g. `boarding-24h:<bookingId>`). The UNIQUE on
 *     `dedupe_key` makes re-enqueue a no-op (the booking-creation tx may
 *     replay under an Idempotency-Key retry; the schedule row must not
 *     double up).
 *   - **Claim** — `lockDueForSend` selects 'pending' rows whose
 *     `scheduled_for <= now()` with `FOR UPDATE SKIP LOCKED`, so
 *     concurrent worker ticks divide the queue without blocking.
 *   - **Settle** — `markSent` flips status + stamps `sent_at` + links the
 *     `emitted_notification_id` to the freshly-INSERTed `notifications`
 *     row. The push attempt happens post-commit, best-effort: DB is the
 *     source of truth; a failed push doesn't roll back the notification
 *     row (the owner sees the in-app feed entry either way; Day-20 will
 *     wire push-retry observability).
 *
 * Append-only by nature — no `expired_at`; a cancelled enqueue uses
 * `status='cancelled'` (Day-19+ surface, not built today).
 */

export type ScheduledNotificationStatus = 'pending' | 'sent' | 'cancelled';

/**
 * Every `notification_type` arm — what the `type` COLUMN can physically hold
 * (derived from the schema enum so it tracks the DB). Distinct from
 * `ScheduledNotificationType` below, which is the narrower set this queue
 * actually ENQUEUES; the row reads the column type, the enqueue input is
 * constrained to the schedulable arms.
 */
type ScheduledNotificationColumnType = (typeof scheduledNotifications.$inferSelect)['type'];

export type ScheduledNotificationType =
  | 'booking-confirmed'
  | 'report-published'
  | 'booking-cancelled'
  | 'announcement'
  | 'message-received'
  | 'booking-reminder'
  | 'boarding-profile-check'
  | 'credits-expiring'
  // `payment-failed` (a PARKED invoice — terminal auto-charge failure) routes
  // through the scheduled queue so it gets the PUSH channel: it's action-
  // required (the owner must fix their card). `payment-succeeded` (a receipt)
  // stays feed-only — emitted directly by `settleInvoiceCharge`, never here.
  | 'payment-failed';

export interface ScheduledNotificationRow {
  id: string;
  ownerId: string;
  type: ScheduledNotificationColumnType;
  trigger: string;
  dedupeKey: string | null;
  scheduledFor: string;
  status: ScheduledNotificationStatus;
  title: string;
  body: string;
  deepLinkPath: string | null;
  bookingId: string | null;
  reportId: string | null;
  dogId: string | null;
  emittedNotificationId: string | null;
  sentAt: string | null;
}

const SCHEDULED_NOTIFICATION_PROJECTION = {
  id: scheduledNotifications.id,
  ownerId: scheduledNotifications.ownerId,
  type: scheduledNotifications.type,
  trigger: scheduledNotifications.trigger,
  dedupeKey: scheduledNotifications.dedupeKey,
  scheduledFor: scheduledNotifications.scheduledFor,
  status: scheduledNotifications.status,
  title: scheduledNotifications.title,
  body: scheduledNotifications.body,
  deepLinkPath: scheduledNotifications.deepLinkPath,
  bookingId: scheduledNotifications.bookingId,
  reportId: scheduledNotifications.reportId,
  dogId: scheduledNotifications.dogId,
  emittedNotificationId: scheduledNotifications.emittedNotificationId,
  sentAt: scheduledNotifications.sentAt,
} as const;

export const scheduledNotificationsRepository = {
  /**
   * Idempotent enqueue. INSERT ... ON CONFLICT (dedupe_key) DO NOTHING
   * RETURNING. A return of `undefined` means the row already existed (a
   * prior enqueue, possibly under an Idempotency-Key replay) — the caller
   * treats that as success, not as an error. `dedupeKey` is required at
   * this seam by design: every enqueue site must commit to a stable key
   * (e.g. `boarding-24h:<bookingId>`) so retries are safe.
   *
   * The row is INSERTed inside the caller's tx so a booking-creation that
   * later fails rolls back both the booking AND its schedule row — no
   * orphan reminders for non-existent bookings.
   */
  async enqueueIdempotent(
    tx: Tx,
    values: {
      ownerId: string;
      type: ScheduledNotificationType;
      trigger: string;
      dedupeKey: string;
      scheduledFor: Date;
      title: string;
      body: string;
      deepLinkPath?: string | null;
      bookingId?: string | null;
      reportId?: string | null;
      dogId?: string | null;
    },
  ): Promise<ScheduledNotificationRow | undefined> {
    const [row] = await tx
      .insert(scheduledNotifications)
      .values({
        ownerId: values.ownerId,
        type: values.type,
        trigger: values.trigger,
        dedupeKey: values.dedupeKey,
        scheduledFor: values.scheduledFor.toISOString(),
        title: values.title,
        body: values.body,
        deepLinkPath: values.deepLinkPath ?? null,
        bookingId: values.bookingId ?? null,
        reportId: values.reportId ?? null,
        dogId: values.dogId ?? null,
      })
      .onConflictDoNothing({ target: scheduledNotifications.dedupeKey })
      .returning(SCHEDULED_NOTIFICATION_PROJECTION);
    return row;
  },

  /**
   * Worker claim: 'pending' rows whose `scheduled_for <= now()`. Uses
   * `FOR UPDATE SKIP LOCKED` — concurrent workers divide the queue
   * without blocking each other; each row is processed by exactly one
   * worker per tick. The lock releases on tx commit/rollback (the
   * worker holds it for the per-row processing window).
   *
   * Ordered by `scheduled_for` ASC so the oldest-due is sent first
   * (mild fairness for delayed deliveries).
   */
  async lockDueForSend(
    tx: Tx,
    args: { limit?: number; now?: Date } = {},
  ): Promise<ScheduledNotificationRow[]> {
    const limit = args.limit ?? 50;
    const cutoff = args.now
      ? sql`${scheduledNotifications.scheduledFor} <= ${args.now.toISOString()}::timestamptz`
      : sql`${scheduledNotifications.scheduledFor} <= now()`;
    return tx
      .select(SCHEDULED_NOTIFICATION_PROJECTION)
      .from(scheduledNotifications)
      .where(and(eq(scheduledNotifications.status, 'pending'), cutoff))
      .orderBy(asc(scheduledNotifications.scheduledFor))
      .limit(limit)
      .for('update', { skipLocked: true });
  },

  /**
   * Mark a row sent + link the delivered `notifications` row that the
   * worker just INSERTed. The link makes the queue auditable — given a
   * scheduled row, the staff portal can find the delivered notification;
   * given a delivered notification, an admin can trace back the trigger.
   *
   * Filters on `status = 'pending'` so a double-claim (shouldn't happen
   * under SKIP LOCKED, but belt-and-suspenders) doesn't double-flip.
   */
  async markSent(tx: Tx, args: { id: string; emittedNotificationId: string }): Promise<number> {
    const updated = await tx
      .update(scheduledNotifications)
      .set({
        status: 'sent',
        sentAt: sql`now()`,
        emittedNotificationId: args.emittedNotificationId,
      })
      .where(
        and(eq(scheduledNotifications.id, args.id), eq(scheduledNotifications.status, 'pending')),
      )
      .returning({ id: scheduledNotifications.id });
    return updated.length;
  },

  /**
   * Test-only lookup by dedupe_key. Routes never need this — the enqueue
   * is fire-and-forget and the worker scans by `(status, scheduled_for)`.
   * The contract tests use it to assert "the booking-creation tx
   * enqueued the right schedule row."
   */
  async findByDedupeKey(
    runner: Runner,
    dedupeKey: string,
  ): Promise<ScheduledNotificationRow | undefined> {
    const [row] = await runner
      .select(SCHEDULED_NOTIFICATION_PROJECTION)
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.dedupeKey, dedupeKey))
      .limit(1);
    return row;
  },

  /**
   * Test-only convenience for the worker contract tests — count pending
   * rows visible at `now`. Production workers always use `lockDueForSend`.
   */
  async countDuePending(runner: Runner, now: Date): Promise<number> {
    const rows = await runner
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.status, 'pending'),
          lte(scheduledNotifications.scheduledFor, now.toISOString()),
        ),
      );
    return rows.length;
  },
};
