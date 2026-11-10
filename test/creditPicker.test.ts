import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alternativePack,
  assignCredits,
  shortReason,
  type PickerLot,
} from '../src/lib/creditPicker.js';

/** The picker's arithmetic, with no database. `credit-picker.test.ts` runs it on real lots. */

const lot = (
  id: string,
  remaining: number,
  paysDates: string[],
  expiresAt = `${id}-exp`,
): PickerLot => ({
  id,
  remaining,
  paysDates,
  expiresAt,
});

const NOTHING_BEYOND = new Set<string>();

test('each date takes the soonest lot that pays it', () => {
  const result = assignCredits({
    dates: ['d1', 'd2'],
    dogIds: ['dog'],
    lots: [lot('soon', 1, ['d1', 'd2']), lot('late', 1, ['d1', 'd2'])],
    beyondReach: NOTHING_BEYOND,
  });
  assert.deepEqual(
    result.paid.map((slot) => [slot.date, slot.lotId]),
    [
      ['d1', 'soon'],
      ['d2', 'late'],
    ],
  );
  assert.deepEqual(result.short, []);
});

test('a lot that does not pay a date is passed over for that date', () => {
  const result = assignCredits({
    dates: ['d1', 'd2'],
    dogIds: ['dog'],
    lots: [lot('soon', 2, ['d1']), lot('late', 1, ['d1', 'd2'])],
    beyondReach: NOTHING_BEYOND,
  });
  assert.deepEqual(
    result.paid.map((slot) => [slot.date, slot.lotId]),
    [
      ['d1', 'soon'],
      ['d2', 'late'],
    ],
  );
  assert.equal(result.leftover.get('soon'), 1);
});

test('two dogs on one date are two slots', () => {
  const result = assignCredits({
    dates: ['d1'],
    dogIds: ['a', 'b'],
    lots: [lot('only', 1, ['d1'])],
    beyondReach: NOTHING_BEYOND,
  });
  assert.equal(result.paid.length, 1);
  assert.deepEqual(result.short, [{ date: 'd1', dogId: 'b' }]);
});

test('a date beyond reach is served first, so the last credit never strands it', () => {
  const result = assignCredits({
    dates: ['d1', 'far'],
    dogIds: ['dog'],
    lots: [lot('only', 1, ['d1', 'far'])],
    beyondReach: new Set(['far']),
  });
  assert.deepEqual(
    result.paid.map((slot) => slot.date),
    ['far'],
  );
  assert.deepEqual(result.short, [{ date: 'd1', dogId: 'dog' }]);
  assert.deepEqual(result.unreachable, []);
});

test('an unpaid date beyond reach is unreachable, and never short', () => {
  const result = assignCredits({
    dates: ['d1', 'far'],
    dogIds: ['dog'],
    lots: [],
    beyondReach: new Set(['far']),
  });
  assert.deepEqual(result.short, [{ date: 'd1', dogId: 'dog' }]);
  assert.deepEqual(result.unreachable, [{ date: 'far', dogId: 'dog' }]);
});

test('short dates come back ascending, whichever pass left them', () => {
  const result = assignCredits({
    dates: ['d1', 'd2', 'd3'],
    dogIds: ['dog'],
    lots: [lot('only', 1, ['d2'])],
    beyondReach: NOTHING_BEYOND,
  });
  assert.deepEqual(
    result.short.map((slot) => slot.date),
    ['d1', 'd3'],
  );
});

test('a short date reads no_credit when she has nothing left', () => {
  const lots = [lot('only', 1, ['d1'])];
  const result = assignCredits({
    dates: ['d1', 'd2'],
    dogIds: ['dog'],
    lots,
    beyondReach: NOTHING_BEYOND,
  });
  assert.deepEqual(shortReason(result, lots), { reason: 'no_credit' });
});

test('a short date reads credits_expire_first with the latest expiry of what is left', () => {
  const lots = [lot('soon', 1, ['d1'], 'mon'), lot('late', 1, ['d1'], 'tue')];
  const result = assignCredits({
    dates: ['d2'],
    dogIds: ['dog'],
    lots,
    beyondReach: NOTHING_BEYOND,
  });
  assert.deepEqual(shortReason(result, lots), { reason: 'credits_expire_first', expiresAt: 'tue' });
});

const PACKS = [
  { key: 'ten', credits: 10, single_day: false },
  { key: 'five', credits: 5, single_day: false },
];

test('the alternative is the smallest pack covering the whole shortfall', () => {
  const pick = (shortfall: number) =>
    alternativePack({ packs: PACKS, shortfall, namedFromTheFirstDay: false });
  assert.equal(pick(4), undefined, 'below every pack: nothing is named');
  assert.equal(pick(5), 'five');
  assert.equal(pick(6), 'ten');
  assert.equal(pick(10), 'ten');
  assert.equal(pick(11), undefined, 'none covers it: omitted');
});

test('daycare and alumni name their pack from the first day short', () => {
  assert.equal(alternativePack({ packs: PACKS, shortfall: 1, namedFromTheFirstDay: true }), 'five');
});

test('no pack, no alternative', () => {
  assert.equal(alternativePack({ packs: [], shortfall: 1, namedFromTheFirstDay: true }), undefined);
});
