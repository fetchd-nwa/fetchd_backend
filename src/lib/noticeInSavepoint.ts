import type { Tx } from '../db/tx.js';

/**
 * Who hears about a notice that could not be written. `error` is the page: level 50
 * on `request.log` reaches the pager through `alarmForwardingHooks`, and every worker
 * alarm rides that logger.
 */
export interface NoticeLog {
  error(obj: Record<string, unknown>, msg?: string): void;
}

const NOTICE_FAILED_ALARM =
  'a notice inside a money transaction failed and rolled back alone: the money commits, and the owner was not told';

/**
 * Enqueue one notice inside a money transaction, in its own savepoint (design
 * §2.7:3993-3998, §2.9). **A notice never un-records money.** The notice's body is
 * composed inside the `compose` callback, so a throw while composing it is covered as
 * well as a refused INSERT: the savepoint rolls back, one constant-sentence alarm
 * names the charge, order or booking and the dedupe key, and the caller's
 * transaction carries on and commits.
 *
 * Answers whether the notice was queued, for a caller that wants to say so.
 */
export async function noticeInSavepoint(
  tx: Tx,
  args: {
    /** What the alarm names: `{ chargeId }`, `{ orderId }` or `{ bookingId }`. */
    subject: Record<string, string>;
    dedupeKey: string;
    log: NoticeLog;
  },
  compose: (sp: Tx) => Promise<unknown>,
): Promise<{ queued: boolean }> {
  try {
    await tx.transaction(async (sp) => {
      await compose(sp as Tx);
    });
    return { queued: true };
  } catch (err) {
    args.log.error(
      {
        ...args.subject,
        dedupeKey: args.dedupeKey,
        err: err instanceof Error ? err.message : String(err),
      },
      NOTICE_FAILED_ALARM,
    );
    return { queued: false };
  }
}
