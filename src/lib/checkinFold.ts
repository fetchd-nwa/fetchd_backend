import type { AttendanceStatus, CheckinEventKind } from '../contracts/wire.js';

/**
 * The fold of one dog's check-in log on one booking (design §2.3:2354-2370, M5.01). A
 * dog's state is never stored: it is read from her live events, in APPEND ORDER, which is
 * `seq`. `seq` is assigned at INSERT, after the booking row lock every verb takes first,
 * so it is the order the verbs ran in. `created_at` is the transaction's start and `id` is
 * random, so neither is: a check-out whose transaction began first but took the lock
 * second would fold before the check-in it follows.
 *
 * An `undo` removes exactly the event it names, and is never itself undone. What is left,
 * the live events, is a run of verbs each accepted from the state the one before it left,
 * so the state is the last live event's.
 */

/** The three kinds that settle a share: at most one per share (M5.02), none undoable. */
export const SETTLING_KINDS: ReadonlySet<CheckinEventKind> = new Set([
  'turn-away',
  'sent-home',
  'no-show',
]);

const STATE_AFTER: Record<Exclude<CheckinEventKind, 'undo'>, AttendanceStatus> = {
  'check-in': 'in',
  'check-out': 'out',
  'turn-away': 'turned-away',
  'sent-home': 'sent-home',
  'no-show': 'no-show',
};

export interface FoldableEvent {
  id: string;
  seq: number;
  kind: CheckinEventKind;
  createdAt: string;
  undoesEventId: string | null;
}

export interface FoldedShare<E extends FoldableEvent> {
  state: AttendanceStatus;
  /** Every event, the undos and the undone included, in append order. */
  log: E[];
  /** The events still standing: not an undo, not undone. Append order. */
  live: E[];
  /** The share holds a settling event. */
  settled: boolean;
  /** The newest live event: what an `undo` would name. */
  undoTarget: E | undefined;
}

export function foldCheckinLog<E extends FoldableEvent>(events: readonly E[]): FoldedShare<E> {
  const log = [...events].sort((a, b) => a.seq - b.seq);
  const undone = new Set(
    log.flatMap((e) => (e.kind === 'undo' && e.undoesEventId !== null ? [e.undoesEventId] : [])),
  );
  const live = log.filter((e) => e.kind !== 'undo' && !undone.has(e.id));
  const last = live.at(-1);
  return {
    state: last === undefined || last.kind === 'undo' ? 'expected' : STATE_AFTER[last.kind],
    log,
    live,
    settled: live.some((e) => SETTLING_KINDS.has(e.kind)),
    undoTarget: last,
  };
}

/** On site: in the building. A sent-home dog stays until her check-out (12- #3, #6.5). */
export function isOnSite(state: AttendanceStatus): boolean {
  return state === 'in' || state === 'sent-home';
}
