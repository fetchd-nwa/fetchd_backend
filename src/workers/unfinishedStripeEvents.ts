import { db } from '../db/client.js';
import {
  UNFINISHED_EVENT_BOUND_MINUTES,
  stripeEventsRepository,
} from '../db/repositories/stripeEventsRepository.js';
import type { WorkerLogger } from './workerLogger.js';

/**
 * **The unfinished-claim alarm** (P22 B-8; `brief_must_say` 3; DECISIONS 174(b); Pace 8.1
 * finding 2). A Stripe delivery that dies between its `stripe_events` claim and its
 * handler leaves `processed_at IS NULL`, and every redelivery answers 200 `duplicate`
 * wherever `redispatchUnfinishedEvent` may not re-run it (the older arms:
 * `enrollmentPartial.ts:418`, `:546` until `POST /enrollments` joins the engine at 8.0.0;
 * `requestConfirmPayment.ts:168` was one until 9.0.0 removed that route, plan unit P49,
 * A1). The charge never flips, and until
 * this phase nobody was told.
 *
 * Each such event past {@link UNFINISHED_EVENT_BOUND_MINUTES} is named at level 50 (id,
 * type, `received_at`) the first time THIS PROCESS sees it, and counted at info after.
 * **Across a restart** (Fable L7) the memory is the process's, as the refund sweep's
 * `ALARMED_REFUND_IDS` is, so every deploy or restart names each still-unfinished event
 * once more; the sentence says so. It never fires on a delivery still running (younger
 * than the bound), on a released claim (`release` deleted the row) or on a processed row.
 * The tick's completion line carries the count. No row is ever deleted or re-run from
 * here: `stripe_events` is the audit record, and whether the first delivery's work
 * committed is exactly what nobody knows.
 */

/** The alarm's sentence, true in every order it can fire. */
export const UNFINISHED_STRIPE_EVENT_ALARM =
  'a Stripe event was received and never finished, so the work it carries may not have happened: check the charge or refund it names in Stripe before acting on it. This line repeats once after each restart, so a colleague may already have checked';

export interface UnfinishedStripeEventsTickResult {
  /** Events unfinished past the bound, or `null` when this tick could not count them. */
  count: number | null;
  /** Of them, the ones this process named at level 50 this tick. */
  named: number;
}

/** Event ids this process has named. Bounded by events that ever die mid-delivery. */
const ALARMED_EVENT_IDS = new Set<string>();

const NOOP_LOG: WorkerLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export async function runUnfinishedStripeEventsOnce(
  opts: { now?: Date; log?: WorkerLogger } = {},
): Promise<UnfinishedStripeEventsTickResult> {
  const log = opts.log ?? NOOP_LOG;
  const at = opts.now !== undefined ? { at: opts.now } : {};
  const count = await stripeEventsRepository.countUnprocessed(db, at);
  if (count === 0) return { count, named: 0 };
  const rows = await stripeEventsRepository.findUnprocessed(db, at);
  let named = 0;
  for (const row of rows) {
    if (ALARMED_EVENT_IDS.has(row.eventId)) continue;
    ALARMED_EVENT_IDS.add(row.eventId);
    named += 1;
    log.error(
      {
        workerTick: 'stripe-events-unfinished',
        moneyEvent: 'stripe-event-unfinished',
        eventId: row.eventId,
        eventType: row.eventType,
        receivedAt: row.receivedAt,
      },
      UNFINISHED_STRIPE_EVENT_ALARM,
    );
  }
  log.info(
    {
      workerTick: 'stripe-events-unfinished',
      unfinishedCount: count,
      newlyNamed: named,
      boundMinutes: UNFINISHED_EVENT_BOUND_MINUTES,
    },
    'stripe events received and never finished past the bound; each is named at error the first time this process sees it (the oldest 100 by name, the rest by this count)',
  );
  return { count, named };
}
