import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { CheckinEventKind } from '../../contracts/wire.js';
import { db } from '../client.js';
import { checkinEvents, dogs } from '../schema/schema.js';
import type { Tx } from '../tx.js';

/**
 * Data-access seam for `checkin_events` (M5.01), the append-only check-in log. Rows are
 * read in `seq` order and folded by `lib/checkinFold.ts`; nothing here decides a state.
 * The table refuses UPDATE, DELETE and TRUNCATE, so this file only appends and reads.
 */

export interface CheckinEventRow {
  id: string;
  seq: number;
  bookingId: string;
  dogId: string;
  kind: CheckinEventKind;
  at: string;
  byStaffId: string;
  undoesEventId: string | null;
  trainingCompleted: boolean | null;
  reissueCredit: boolean | null;
  note: string | null;
  lastSeenMoved: boolean;
  lastSeenPrior: string | null;
  /** The transaction's start: display only, never a link to a ledger row (M5.10's is). */
  createdAt: string;
}

const EVENT_PROJECTION = {
  id: checkinEvents.id,
  seq: checkinEvents.seq,
  bookingId: checkinEvents.bookingId,
  dogId: checkinEvents.dogId,
  kind: checkinEvents.kind,
  at: checkinEvents.at,
  byStaffId: checkinEvents.byStaffId,
  undoesEventId: checkinEvents.undoesEventId,
  trainingCompleted: checkinEvents.trainingCompleted,
  reissueCredit: checkinEvents.reissueCredit,
  note: checkinEvents.note,
  lastSeenMoved: checkinEvents.lastSeenMoved,
  lastSeenPrior: checkinEvents.lastSeenPrior,
  createdAt: checkinEvents.createdAt,
} as const;

type Runner = Tx | typeof db;

export const checkinEventsRepository = {
  /** Every event on these bookings, every dog, in append order. */
  async findForBookings(runner: Runner, bookingIds: readonly string[]): Promise<CheckinEventRow[]> {
    if (bookingIds.length === 0) return [];
    const rows = await runner
      .select(EVENT_PROJECTION)
      .from(checkinEvents)
      .where(inArray(checkinEvents.bookingId, [...bookingIds]))
      .orderBy(asc(checkinEvents.seq));
    return rows as CheckinEventRow[];
  },

  /** One dog's log on one booking, in append order. */
  async findForShare(tx: Tx, bookingId: string, dogId: string): Promise<CheckinEventRow[]> {
    const rows = await tx
      .select(EVENT_PROJECTION)
      .from(checkinEvents)
      .where(and(eq(checkinEvents.bookingId, bookingId), eq(checkinEvents.dogId, dogId)))
      .orderBy(asc(checkinEvents.seq));
    return rows as CheckinEventRow[];
  },

  /** Append one event. `at` is the verb's clock; `seq` and `created_at` the database's. */
  async append(
    tx: Tx,
    values: {
      bookingId: string;
      dogId: string;
      kind: CheckinEventKind;
      at: Date;
      byStaffId: string;
      undoesEventId?: string;
      trainingCompleted?: boolean;
      reissueCredit?: boolean;
      note?: string;
      lastSeenMoved?: boolean;
      lastSeenPrior?: string | null;
    },
  ): Promise<CheckinEventRow> {
    const [row] = await tx
      .insert(checkinEvents)
      .values({
        bookingId: values.bookingId,
        dogId: values.dogId,
        kind: values.kind,
        at: values.at.toISOString(),
        byStaffId: values.byStaffId,
        undoesEventId: values.undoesEventId ?? null,
        trainingCompleted: values.trainingCompleted ?? null,
        reissueCredit: values.reissueCredit ?? null,
        note: values.note ?? null,
        lastSeenMoved: values.lastSeenMoved ?? false,
        lastSeenPrior: values.lastSeenPrior ?? null,
      })
      .returning(EVENT_PROJECTION);
    if (row === undefined) throw new Error('checkin_events INSERT returned no row');
    return row as CheckinEventRow;
  },

  /**
   * The dog row, `FOR NO KEY UPDATE`, and her `last_seen_on`. Taken after the booking row
   * (`db/locks.ts`): a check-in moves the clock from what this read sees, and an undo
   * recomputes it, so two of either on one dog queue here. `no key update`, never
   * `FOR UPDATE`: `dogs` is a parent the money path's FK re-checks reach with `KEY SHARE`
   * (DECISIONS 155(a)). `undefined` if the dog is gone.
   */
  async lockDogClock(tx: Tx, dogId: string): Promise<{ lastSeenOn: string | null } | undefined> {
    const [row] = await tx
      .select({ lastSeenOn: dogs.lastSeenOn })
      .from(dogs)
      .where(eq(dogs.id, dogId))
      .for('no key update');
    return row;
  },

  async setDogClock(tx: Tx, dogId: string, lastSeenOn: string | null): Promise<void> {
    await tx.update(dogs).set({ lastSeenOn }).where(eq(dogs.id, dogId));
  },

  /**
   * What `last_seen_on` is, from the log alone, once this transaction's undo is in it
   * (design §2.3:2398-2405, question 44): the greatest of the session dates of the dog's
   * live clock-moving check-ins, on every booking, and the value the clock held before
   * her first clock-moving check-in ever (that event's `last_seen_prior`, which no event
   * set). Never a value an event since undone had set, so two mis-taps undone out of order
   * end at the true date. `null` when there is neither.
   */
  async recomputeDogClock(tx: Tx, dogId: string): Promise<string | null> {
    const result = await tx.execute(sql`
      WITH moves AS (
        SELECT e.id, e.seq, e.last_seen_prior,
               (b.scheduled_at AT TIME ZONE 'America/Chicago')::date AS session_date,
               NOT EXISTS (SELECT 1 FROM checkin_events u WHERE u.undoes_event_id = e.id) AS live
          FROM checkin_events e
          JOIN bookings b ON b.id = e.booking_id
         WHERE e.dog_id = ${dogId} AND e.kind = 'check-in' AND e.last_seen_moved
      )
      SELECT GREATEST(
               (SELECT max(session_date) FROM moves WHERE live),
               (SELECT last_seen_prior FROM moves ORDER BY seq LIMIT 1)
             )::text AS last_seen_on`);
    return (result.rows[0] as { last_seen_on: string | null } | undefined)?.last_seen_on ?? null;
  },
};
