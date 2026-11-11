import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CheckinEventKind } from '../src/contracts/wire.js';
import { foldCheckinLog, isOnSite, type FoldableEvent } from '../src/lib/checkinFold.js';

/**
 * The fold of one dog's check-in log (B1-1; design §2.3:2354-2370): every kind, the
 * undo removing exactly the event it names, and the order — `seq`, never `created_at`
 * (the transaction's start) or `id` (random).
 */

let nextSeq = 1;
function ev(kind: CheckinEventKind, extra: Partial<FoldableEvent> = {}): FoldableEvent {
  const seq = nextSeq++;
  return {
    id: `e${String(seq).padStart(3, '0')}`,
    seq,
    kind,
    createdAt: `2026-10-13T12:00:${String(seq % 60).padStart(2, '0')}Z`,
    undoesEventId: null,
    ...extra,
  };
}
const undo = (target: FoldableEvent): FoldableEvent => ev('undo', { undoesEventId: target.id });

describe('the fold, every kind', () => {
  test('no event: expected, nothing to undo, not settled, not on site', () => {
    const folded = foldCheckinLog([]);
    assert.equal(folded.state, 'expected');
    assert.equal(folded.settled, false);
    assert.equal(folded.undoTarget, undefined);
    assert.equal(isOnSite(folded.state), false);
  });

  test('check-in: in, on site', () => {
    const checkIn = ev('check-in');
    const folded = foldCheckinLog([checkIn]);
    assert.equal(folded.state, 'in');
    assert.equal(isOnSite(folded.state), true);
    assert.equal(folded.undoTarget?.id, checkIn.id);
    assert.equal(folded.settled, false);
  });

  test('check-in, check-out: out, off site', () => {
    const checkIn = ev('check-in');
    const out = ev('check-out');
    const folded = foldCheckinLog([checkIn, out]);
    assert.equal(folded.state, 'out');
    assert.equal(isOnSite(folded.state), false);
    assert.equal(folded.undoTarget?.id, out.id);
  });

  test('turn-away: turned-away, settled, off site', () => {
    const folded = foldCheckinLog([ev('turn-away')]);
    assert.equal(folded.state, 'turned-away');
    assert.equal(folded.settled, true);
    assert.equal(isOnSite(folded.state), false);
  });

  test("no-show (Didn't come): no-show, settled, off site", () => {
    const folded = foldCheckinLog([ev('no-show')]);
    assert.equal(folded.state, 'no-show');
    assert.equal(folded.settled, true);
    assert.equal(isOnSite(folded.state), false);
  });

  test('check-in, send home: sent-home, settled, and still on site', () => {
    const folded = foldCheckinLog([ev('check-in'), ev('sent-home')]);
    assert.equal(folded.state, 'sent-home');
    assert.equal(folded.settled, true);
    assert.equal(isOnSite(folded.state), true);
  });

  test('a sent-home dog checked out: out, and the share stays settled', () => {
    const folded = foldCheckinLog([ev('check-in'), ev('sent-home'), ev('check-out')]);
    assert.equal(folded.state, 'out');
    assert.equal(folded.settled, true);
    assert.equal(isOnSite(folded.state), false);
  });

  test('a re-check-in after the vet: in again', () => {
    const folded = foldCheckinLog([ev('check-in'), ev('check-out'), ev('check-in')]);
    assert.equal(folded.state, 'in');
    assert.equal(folded.live.length, 3);
  });
});

describe('the undo removes exactly the event it names', () => {
  test('check in, check out, undo, undo: expected, both removed, nothing left to undo', () => {
    const checkIn = ev('check-in');
    const checkOut = ev('check-out');
    const firstUndo = undo(checkOut);
    const afterOne = foldCheckinLog([checkIn, checkOut, firstUndo]);
    assert.equal(afterOne.state, 'in');
    assert.equal(afterOne.undoTarget?.id, checkIn.id, 'the undo is never itself a target');
    const afterTwo = foldCheckinLog([checkIn, checkOut, firstUndo, undo(checkIn)]);
    assert.equal(afterTwo.state, 'expected');
    assert.equal(afterTwo.undoTarget, undefined);
    assert.deepEqual(afterTwo.live, []);
    assert.equal(afterTwo.log.length, 4, 'the log keeps every event');
  });

  test('an undo naming an earlier event removes that one, not the newest', () => {
    const checkIn = ev('check-in');
    const checkOut = ev('check-out');
    const folded = foldCheckinLog([checkIn, checkOut, undo(checkIn)]);
    assert.deepEqual(
      folded.live.map((e) => e.id),
      [checkOut.id],
    );
    assert.equal(folded.state, 'out');
  });
});

describe('the order is seq', () => {
  test('a check-out whose transaction began first (earlier created_at) folds after the check-in it follows', () => {
    // seq 1 is the check-in, seq 2 the check-out; the check-out's transaction began first,
    // so its created_at is the earlier one, and its random id sorts first too.
    const checkIn: FoldableEvent = {
      id: 'ffff-check-in',
      seq: 101,
      kind: 'check-in',
      createdAt: '2026-10-13T12:00:05Z',
      undoesEventId: null,
    };
    const checkOut: FoldableEvent = {
      id: '0000-check-out',
      seq: 102,
      kind: 'check-out',
      createdAt: '2026-10-13T12:00:01Z',
      undoesEventId: null,
    };
    for (const given of [
      [checkIn, checkOut],
      [checkOut, checkIn],
    ]) {
      const folded = foldCheckinLog(given);
      assert.deepEqual(
        folded.log.map((e) => e.kind),
        ['check-in', 'check-out'],
      );
      assert.equal(folded.state, 'out');
    }
  });
});
