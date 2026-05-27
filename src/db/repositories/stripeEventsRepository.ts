import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client.js';
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
 *      `processed_at IS NULL`; admin replay can clean those up.
 *
 * Permanent table — no soft-expire / TTL; audit history is the point.
 * Reads are admin-only (no client surface).
 */

export type ClaimOutcome = 'claimed' | 'duplicate';

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
   * Admin-only count of unprocessed events — useful for the eventual
   * Day-20 observability surface (a high count means dispatcher is stuck
   * or a handler is panicking). Polymorphic-runner so a future staff-
   * portal endpoint can read it inside a request tx.
   */
  async countUnprocessed(runner: Tx | typeof db = db): Promise<number> {
    const [row] = await runner
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stripeEvents)
      .where(and(isNull(stripeEvents.processedAt)));
    return row?.count ?? 0;
  },
};
