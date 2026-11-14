import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { leaseInstant } from '../locks.js';
import { stripeEvents } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `stripe_events` (schema.sql Day-15 amendment).
 * Server-internal dedupe ledger for incoming Stripe webhook events. The
 * receiver follows a claim → dispatch → mark/release lifecycle:
 *
 *   1. `claim(eventId, eventType)` — INSERT ON CONFLICT DO NOTHING.
 *      Returns `'claimed'` when this delivery wins the race; `'duplicate'`
 *      when a prior delivery already inserted the row.
 *   2. Dispatch the event-type handler.
 *   3. On handler success: `markProcessed(eventId)` (sets `processed_at`).
 *      On handler failure: `release(eventId)` (DELETE so Stripe's next
 *      retry re-enters dispatch). Process crash leaves the row at
 *      `processed_at IS NULL`: a redelivery re-runs it where
 *      `redispatchUnfinishedEvent` allows, and answers 200 `duplicate` elsewhere. No
 *      admin replay exists.
 *
 * Permanent table — no soft-expire / TTL; audit history is the point.
 * Reads are admin-only (no client surface).
 */

export type ClaimOutcome = 'claimed' | 'duplicate';

/**
 * **The unfinished-claim bound** (P22 B-8; `brief_must_say` 3; 174(b)): a claim with
 * `processed_at IS NULL` this long after `received_at` is a delivery that died between its
 * claim and its handler, never one still running. Fifteen minutes is above any handler's
 * ceiling: per-call Stripe timeouts of 30 s at the seeds, and `EngineBudget.sweepClaimMs`,
 * four of them (the brief's call).
 */
export const UNFINISHED_EVENT_BOUND_MINUTES = 15;

/** An event received and never finished, as the alarm names it. */
export interface UnfinishedStripeEvent {
  eventId: string;
  eventType: string;
  receivedAt: string;
}

/** `processed_at IS NULL` and received at least the bound before the instant. */
function unfinishedPast(at: Date | undefined) {
  return and(
    isNull(stripeEvents.processedAt),
    lte(
      stripeEvents.receivedAt,
      sql`${leaseInstant(at)} - make_interval(mins => ${UNFINISHED_EVENT_BOUND_MINUTES})`,
    ),
  );
}

export const stripeEventsRepository = {
  /**
   * Pool-default INSERT (claim runs OUTSIDE the per-event dispatch tx
   * so a duplicate is cheaply detected before we even open a transaction
   * for the handler).
   *
   * Returns `'claimed'` when this caller wins the row; `'duplicate'`
   * otherwise. The caller is responsible for calling `markProcessed`
   * on success or `release` on failure of the dispatch. The duplicate
   * case is the no-op happy path — Stripe redelivers freely on any
   * non-2xx response, so dedupe is load-bearing.
   */
  async claim(eventId: string, eventType: string): Promise<ClaimOutcome> {
    const inserted = await db
      .insert(stripeEvents)
      .values({ eventId, eventType })
      .onConflictDoNothing({ target: stripeEvents.eventId })
      .returning({ eventId: stripeEvents.eventId });
    return inserted.length > 0 ? 'claimed' : 'duplicate';
  },

  /**
   * Stamp `processed_at = now()` after a successful dispatch. Idempotent
   * — calling on an already-processed row is harmless (same target value).
   * Called after the per-event tx commits so the success marker reflects
   * durable state, not in-flight work.
   */
  async markProcessed(eventId: string): Promise<void> {
    await db
      .update(stripeEvents)
      .set({ processedAt: sql`now()` })
      .where(eq(stripeEvents.eventId, eventId));
  },

  /**
   * DELETE the claim so Stripe's next redelivery re-enters dispatch.
   * Called when the per-event tx threw — the DB rolled back, so the only
   * residue is the (now unwanted) `stripe_events` row inserted by `claim`.
   * Stripe webhook semantics: any non-2xx response triggers retry with
   * the same `event.id`; without releasing the claim, the retry would
   * short-circuit as a duplicate and the work never lands.
   */
  async release(eventId: string): Promise<void> {
    await db.delete(stripeEvents).where(eq(stripeEvents.eventId, eventId));
  },

  /**
   * Read for the dispatched-already check inside the handler — used when
   * a duplicate-claim returns and we still want to differentiate
   * "already processed (200 ok)" from "in-flight elsewhere (200 ok,
   * defer to the other process)". Both still 200; only the log line
   * differs. Returns undefined when the event id isn't in the table.
   */
  async findProcessedState(eventId: string): Promise<{ processedAt: string | null } | undefined> {
    const [row] = await db
      .select({ processedAt: stripeEvents.processedAt })
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, eventId))
      .limit(1);
    return row;
  },

  /**
   * The count of events received and never finished, past
   * {@link UNFINISHED_EVENT_BOUND_MINUTES} (P22 B-8: the tick's unfinished-claim alarm is
   * its first caller). On Postgres's clock, `now()`, unless a test passes an instant
   * (`leaseInstant`'s pattern), so a process clock can never call a live delivery dead;
   * `stripe_events_unprocessed_idx` serves it.
   */
  async countUnprocessed(
    runner: Tx | typeof db = db,
    args: { at?: Date } = {},
  ): Promise<number> {
    const [row] = await runner
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stripeEvents)
      .where(unfinishedPast(args.at));
    return row?.count ?? 0;
  },

  /** The same rows, oldest first, for the alarm to name (at most `limit`). */
  async findUnprocessed(
    runner: Tx | typeof db = db,
    args: { at?: Date; limit?: number } = {},
  ): Promise<UnfinishedStripeEvent[]> {
    return runner
      .select({
        eventId: stripeEvents.eventId,
        eventType: stripeEvents.eventType,
        receivedAt: stripeEvents.receivedAt,
      })
      .from(stripeEvents)
      .where(unfinishedPast(args.at))
      .orderBy(asc(stripeEvents.receivedAt))
      .limit(args.limit ?? 100);
  },
};
