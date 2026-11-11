import { and, asc, eq, isNotNull, isNull, like, lte, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { scheduledNotifications } from '../schema/schema.js';
import type { Tx } from '../tx.js';
import type { NotificationDeepLinkKind } from '../../lib/notificationWire.js';

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
 *   - **Park** (2026-09-03) — a row whose delivery THROWS is rolled back to
 *     its own SAVEPOINT while its batch-mates commit, and
 *     `recordAttemptFailure` counts the attempt — but only when its batch-mates
 *     SUCCEEDED. A batch of ≥ 2 rows that fails ENTIRELY is systemic, not
 *     poison: no attempt is spent and nothing parks (`scheduler.ts`). On the
 *     `MAX_DELIVERY_ATTEMPTS`-th failure the row is stamped `failed_at` and
 *     drops out of `lockDueForSend` until a human clears it
 *     (`unparkByDedupeKey`, or a revive — which un-parks). It stays
 *     `status='pending'` throughout, so nothing else in the codebase has to
 *     learn a fourth status.
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
  // `payment-failed` routes through the scheduled queue so it gets the PUSH
  // channel. Two producers: the order engine's final failure on an invoice
  // payment and, since wire 1.9.0, a credit purchase whose `processing` intent
  // later settled as FAILED at the webhook.
  | 'payment-failed'
  // `payment-succeeded` is feed-only on the INVOICE receipt path (emitted
  // directly by `settleInvoiceCharge`, never here). It joined this queue at
  // wire 1.9.0 for exactly one producer: the credit-purchase webhook flip, where
  // the 201 already told the owner "still processing — we'll let you know" and
  // the push is that promise being kept. Same enum member, no DDL.
  | 'payment-succeeded'
  // Shanthi 2026-07-14: fires on the owner's stated spay/neuter planned
  // date, prompting a profile update (`spay-neuter:<dogId>:<date>`).
  | 'spay-neuter-reminder'
  // R3 2026-07-27: the cash/check invoice reminder (`payment-due:<invoiceId>`)
  // enqueued by `POST /invoices/:id/pay-in-person`. Push-capable (urgent-
  // updates) so the owner is reminded to bring payment 24h before drop-off.
  | 'payment-due'
  // Allison 2026-07-29. Both are push-capable under 'urgent-updates'. Nothing
  // enqueues `invoice-overdue` since its scan left at M4.04; the arm stays while
  // the label does. `card-expiring:<pmId>:warn|lapsed` fires at most twice per
  // card.
  | 'invoice-overdue'
  | 'card-expiring';

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
  deepLinkKind: NotificationDeepLinkKind | null;
  deepLinkId: string | null;
  bookingId: string | null;
  reportId: string | null;
  dogId: string | null;
  emittedNotificationId: string | null;
  sentAt: string | null;
  /** Delivery attempts spent on this row (poison-row isolation, 2026-09-03). */
  attempts: number;
  lastError: string | null;
  /** NULL = live; set = PARKED after repeated failures, skipped by the claim. */
  failedAt: string | null;
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
  deepLinkKind: scheduledNotifications.deepLinkKind,
  deepLinkId: scheduledNotifications.deepLinkId,
  bookingId: scheduledNotifications.bookingId,
  reportId: scheduledNotifications.reportId,
  dogId: scheduledNotifications.dogId,
  emittedNotificationId: scheduledNotifications.emittedNotificationId,
  sentAt: scheduledNotifications.sentAt,
  attempts: scheduledNotifications.attempts,
  lastError: scheduledNotifications.lastError,
  failedAt: scheduledNotifications.failedAt,
} as const;

/**
 * How much of a failure message `last_error` keeps. Hygiene, not correctness
 * (A1.5 as re-ruled): the column is a breadcrumb for whoever runs the SQL, and
 * a server message can carry an arbitrarily long statement echo.
 */
export const LAST_ERROR_MAX_CHARS = 2_000;

/**
 * What {@link scheduledNotificationsRepository.recordAttemptFailure} did.
 * `gone` is its own arm so that a row which vanished under the claim lock
 * cannot be reported as a first attempt on a row that will be retried.
 */
export type RecordAttemptFailureOutcome =
  | { outcome: 'gone' }
  | { outcome: 'recorded'; attempts: number; parked: boolean };

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
      deepLinkKind?: NotificationDeepLinkKind | null;
      deepLinkId?: string | null;
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
        deepLinkKind: values.deepLinkKind ?? null,
        deepLinkId: values.deepLinkId ?? null,
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
   *
   * PARKED rows are excluded (`failed_at IS NULL`, 2026-09-03): a row that has
   * failed delivery `MAX_DELIVERY_ATTEMPTS` times stops being claimed so it
   * cannot re-poison every later tick. It stays `status = 'pending'` — **cancel
   * still reaches a parked row; revive UN-PARKS it** — and it comes back the
   * moment a human clears `failed_at` (`unparkByDedupeKey`). The partial index
   * carries the same predicate, so this filter is served by the index rather
   * than fighting it.
   */
  async lockDueForSend(
    tx: Tx,
    args: { limit?: number; now?: Date } = {},
  ): Promise<ScheduledNotificationRow[]> {
    // 50 is load-bearing for a reason beyond batch latency (2026-09-03).
    // Per-row savepoints cost one cached subtransaction id per row, success or
    // failure — measured against a throwaway Postgres, an ABORTED subtransaction
    // releases its xid from the cache, so the crossover is 65 rows on both
    // paths. A batch limit above 64 makes other backends' snapshots
    // suboverflow (they fall back to `pg_subtrans` for visibility checks — a
    // performance effect, not a correctness one); the 50 limit keeps under it.
    const limit = args.limit ?? 50;
    const cutoff = args.now
      ? sql`${scheduledNotifications.scheduledFor} <= ${args.now.toISOString()}::timestamptz`
      : sql`${scheduledNotifications.scheduledFor} <= now()`;
    return tx
      .select(SCHEDULED_NOTIFICATION_PROJECTION)
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.status, 'pending'),
          isNull(scheduledNotifications.failedAt),
          cutoff,
        ),
      )
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
   * Record one FAILED delivery attempt (poison-row isolation, 2026-09-03).
   * Called from the worker AFTER the batch loop, on the BATCH tx and inside a
   * savepoint of its own — the row's own delivery SAVEPOINT has already rolled
   * back, so this write is the only trace the attempt leaves, and it commits
   * with the batch-mates that succeeded.
   *
   * Increments `attempts`, stores the failure message, and stamps `failed_at`
   * on the attempt that reaches `maxAttempts` — the row PARKS: still 'pending'
   * (cancel untouched; revive un-parks) but no longer claimed, waiting on a
   * human. `attempts + 1 >= maxAttempts` rather than `=` so a row already past
   * the threshold (a lowered `MAX_DELIVERY_ATTEMPTS`, a hand-edited row) parks
   * on its next failure instead of retrying forever past the ceiling.
   *
   * `last_error` is truncated to {@link LAST_ERROR_MAX_CHARS} before the write:
   * this column is a breadcrumb for a human running SQL, not a log sink, and an
   * unbounded server message (a statement echo, a giant row dump) has no
   * business being replayed into the row on every failure.
   *
   * Returns a DISCRIMINATED outcome, not a count. The 0-row case — the row
   * vanished between the claim and this write — used to come back as
   * `{ attempts: 0, parked: false }`, which is a first attempt's shape and a
   * lie about a row that no longer exists (A1.5 / O12); the caller logs its own
   * sentence for `gone` instead of posing as attempt 0.
   */
  async recordAttemptFailure(
    tx: Tx,
    args: { id: string; error: string; maxAttempts: number },
  ): Promise<RecordAttemptFailureOutcome> {
    const [row] = await tx
      .update(scheduledNotifications)
      .set({
        attempts: sql`${scheduledNotifications.attempts} + 1`,
        lastError: args.error.slice(0, LAST_ERROR_MAX_CHARS),
        failedAt: sql`CASE WHEN ${scheduledNotifications.attempts} + 1 >= ${args.maxAttempts}::integer
                          THEN now() ELSE ${scheduledNotifications.failedAt} END`,
      })
      .where(eq(scheduledNotifications.id, args.id))
      .returning({
        attempts: scheduledNotifications.attempts,
        failedAt: scheduledNotifications.failedAt,
      });
    if (row === undefined) {
      // Not reachable under the claim — the caller holds this row's
      // `FOR UPDATE SKIP LOCKED` lock in this very tx, so it exists — but it is
      // reported as its own outcome rather than as a zeroth attempt, so that if
      // it ever DOES happen the log says what happened instead of describing a
      // retry that nothing will retry.
      return { outcome: 'gone' };
    }
    return { outcome: 'recorded', attempts: row.attempts, parked: row.failedAt !== null };
  },

  /**
   * Un-park a row (ops verb): clears `failed_at` and resets `attempts`, so the
   * next tick claims it again. Deliberately has no route — a parked row means a
   * human read the PARKED alarm, fixed the cause, and is putting the row back;
   * doing that by hand is the point. Mirrors the SQL in the umbrella's
   * `scripts/db/2026-09-03-scheduled-notifications-parking.sql`.
   *
   * `failed_at IS NOT NULL` is part of the predicate (A1.9c) so the return is
   * an ANSWER and not just an echo: without it, running this against a key whose
   * row is 'sent', 'cancelled' or simply healthy resets that row's counters and
   * returns 1, which the operator reads as "unparked". 0 now means "nothing was
   * parked under that key".
   */
  async unparkByDedupeKey(tx: Tx, dedupeKey: string): Promise<number> {
    const updated = await tx
      .update(scheduledNotifications)
      .set({ failedAt: null, attempts: 0 })
      .where(
        and(
          eq(scheduledNotifications.dedupeKey, dedupeKey),
          isNotNull(scheduledNotifications.failedAt),
        ),
      )
      .returning({ id: scheduledNotifications.id });
    return updated.length;
  },

  /**
   * Cancel every still-PENDING row whose dedupe_key starts with `prefix`.
   * Used by mutations that supersede an earlier enqueue — e.g. the
   * spay/neuter planned-date reminder (`spay-neuter:<dogId>:`) when the
   * owner moves the date or marks the dog fixed. Sent rows are history
   * and stay untouched; the append-only queue records the supersession
   * as 'cancelled', never a DELETE.
   */
  async cancelPendingByDedupePrefix(tx: Tx, prefix: string): Promise<number> {
    const updated = await tx
      .update(scheduledNotifications)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(scheduledNotifications.status, 'pending'),
          like(scheduledNotifications.dedupeKey, `${prefix}%`),
        ),
      )
      .returning({ id: scheduledNotifications.id });
    return updated.length;
  },

  /**
   * Re-point a still-PENDING row (a parked one included: it stays `pending`) from one dog
   * to another, when the dog it names is no longer coming: a one-dog cancel of a session's
   * lead (P20 fix 1, Opus L1; D3). `deliverOne` draws the feed row's dog from `dog_id`, so
   * this is what keeps her phone from showing a dog who is not coming. Sent rows are
   * history and stay untouched. Answers the number of rows moved.
   */
  async repointPendingDog(
    tx: Tx,
    args: { dedupeKey: string; fromDogId: string; toDogId: string },
  ): Promise<number> {
    const updated = await tx
      .update(scheduledNotifications)
      .set({ dogId: args.toDogId })
      .where(
        and(
          eq(scheduledNotifications.dedupeKey, args.dedupeKey),
          eq(scheduledNotifications.status, 'pending'),
          eq(scheduledNotifications.dogId, args.fromDogId),
        ),
      )
      .returning({ id: scheduledNotifications.id });
    return updated.length;
  },

  /**
   * Revive a previously-CANCELLED row under the same dedupe_key — the
   * "set date A → change to B → back to A" case, where `enqueueIdempotent`
   * hits the unique dedupe_key and DO-NOTHINGs. Sent rows stay sent (a
   * reminder that already fired is history, not re-sendable). Returns the
   * number of rows revived (0 or 1).
   *
   * **A revive is a fresh intent, so it also UN-PARKS** (A1.2, 2026-09-03;
   * Allison's decision 3-bis default: a re-armed reminder gets its three tries
   * again). Without the reset, a row that had parked came back `pending`, due,
   * and permanently invisible to the claim: `syncSpayNeuterReminder` reported
   * cancelled 1 / revived 1, the owner's reminder looked scheduled everywhere,
   * and it never fired and never alarmed again — the diff's own silent failure,
   * executed by both attack lanes. If the row is still poison it re-parks
   * loudly after `MAX_DELIVERY_ATTEMPTS`.
   */
  async revivePendingByDedupeKey(
    tx: Tx,
    args: { dedupeKey: string; scheduledFor: Date },
  ): Promise<number> {
    const updated = await tx
      .update(scheduledNotifications)
      .set({
        status: 'pending',
        scheduledFor: args.scheduledFor.toISOString(),
        failedAt: null,
        attempts: 0,
      })
      .where(
        and(
          eq(scheduledNotifications.dedupeKey, args.dedupeKey),
          eq(scheduledNotifications.status, 'cancelled'),
        ),
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
   *
   * `failed_at IS NULL` matches the claim (A1.9d): without it this counts
   * PARKED rows as "due pending", which is the opposite of what the worker
   * will do with them, and the narrower partial index no longer serves it.
   */
  async countDuePending(runner: Runner, now: Date): Promise<number> {
    const rows = await runner
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.status, 'pending'),
          isNull(scheduledNotifications.failedAt),
          lte(scheduledNotifications.scheduledFor, now.toISOString()),
        ),
      );
    return rows.length;
  },

  /**
   * How many rows are PARKED right now — the standing signal (A1.6).
   *
   * The PARKED page is fire-and-forget and one-shot: the pager documents that a
   * page can be shed at the in-flight ceiling or lost to a transport failure,
   * and `scheduledParked` on the completion line is per-tick, so it reads 0 on
   * every tick after the one that parked. Miss that single page and a
   * permanently undeliverable notification is invisible until someone runs SQL.
   * This count is what `POST /workers/tick` publishes and
   * `GET /health/watchdog` turns into a standing 503.
   *
   * `status = 'pending'` is part of the predicate, not decoration: a parked row
   * that is later CANCELLED is settled, and counting it would hold the watchdog
   * red forever with nothing left for a human to do.
   *
   * Runs on the POOL after the batch tx commits — never inside it: it must not
   * extend the window in which the claim's row locks are held.
   *
   * It is one **sequential scan** per tick, not an index lookup, and calling it
   * "indexed-ish" here was wrong (A2.3): the only partial index on this table
   * carries the exact COMPLEMENT of this predicate
   * (`status = 'pending' AND failed_at IS NULL`), so `EXPLAIN` plans a Seq Scan
   * even with `enable_seqscan = off` forcing the alternative to cost 1e10.
   * Measured at 14.7 ms, once per 60 s, on the pool, after commit, holding no
   * lock — which is why the ruling was to fix the WORD and not to add an index.
   * The complementary partial index is filed as a follow-up, for the day this
   * table is large enough for 14.7 ms to matter.
   */
  async countParked(runner: Runner): Promise<number> {
    const [row] = await runner
      .select({ count: sql<number>`count(*)::int` })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.status, 'pending'),
          isNotNull(scheduledNotifications.failedAt),
        ),
      );
    return row?.count ?? 0;
  },
};
