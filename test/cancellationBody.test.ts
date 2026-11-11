import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cancellationBody, type CancellationNotice } from '../src/lib/orderRows.js';

/**
 * §2.9's one body composer (design.md:4546), pinned by a table: every
 * `booking-cancelled` body is one of these rows. The whole-session cancel's body is
 * byte for byte what it was before P20 (P21 rewrites it with the staff reason); every
 * other arm is a who-line and a credit line, the line read from where the credit
 * landed, and with a dead lot §2.9's dead-lot line instead.
 */

const LOT_1_JUN = {
  credits: 1,
  location: 'bentonville',
  mode: 'school',
  expiresAt: new Date('2027-06-01T17:00:00Z'),
  live: true,
} as const;
const DEAD_19_OCT = {
  credits: 1,
  location: 'bentonville',
  mode: 'school',
  expiresAt: new Date('2026-10-19T14:40:00Z'),
  live: false,
} as const;
const DAYCARE_LOT = {
  credits: 1,
  location: 'fayetteville',
  mode: 'daycare',
  expiresAt: new Date('2026-11-19T22:30:00Z'),
  live: true,
} as const;
const WED_21_OCT = '2026-10-21T12:30:00.000Z';

const TABLE: [string, CancellationNotice, string][] = [
  [
    'the whole session, in the window (unchanged until P21)',
    { kind: 'session', category: 'day-school', scheduledAtIso: WED_21_OCT, forfeited: false },
    'Your day school on Oct 21 is cancelled. Refund is on the way.',
  ],
  [
    'the whole session, forfeited (unchanged until P21)',
    { kind: 'session', category: 'day-care', scheduledAtIso: WED_21_OCT, forfeited: true },
    'Your day care on Oct 21 is cancelled. The cancellation window has passed — no refund.',
  ],
  [
    'the whole session, a private lesson (unchanged until P21)',
    { kind: 'session', category: 'private-lesson', scheduledAtIso: WED_21_OCT, forfeited: false },
    'Your private lesson on Oct 21 is cancelled. Refund is on the way.',
  ],
  [
    "the owner's one-dog cancel",
    {
      kind: 'one-dog',
      by: 'owner',
      dogName: 'Luna',
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credit: LOT_1_JUN,
    },
    "You cancelled Luna's day school, Wed 21 Oct. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).",
  ],
  [
    "the staff's one-dog cancel (no reason until P21)",
    {
      kind: 'one-dog',
      by: 'staff',
      dogName: 'Luna',
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credit: LOT_1_JUN,
    },
    "The school cancelled Luna's day school on Wed 21 Oct. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).",
  ],
  [
    'a day-care one-dog cancel names the daycare pool',
    {
      kind: 'one-dog',
      by: 'owner',
      dogName: 'Bao',
      category: 'day-care',
      scheduledAtIso: WED_21_OCT,
      credit: DAYCARE_LOT,
    },
    "You cancelled Bao's day care, Wed 21 Oct. +1 credit, back to your Fayetteville daycare credits (expires 19 Nov).",
  ],
  [
    'a ticked check-out',
    { kind: 'staff-return', event: 'picked-up-early', dogName: 'Pepper', credit: LOT_1_JUN },
    'Pepper was picked up early. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).',
  ],
  [
    'an unfinished send-home',
    { kind: 'staff-return', event: 'sent-home', dogName: 'Pepper', credit: LOT_1_JUN },
    'Pepper was sent home early. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).',
  ],
  [
    'a turn-away',
    { kind: 'staff-return', event: 'turned-away', dogName: 'Pepper', credit: LOT_1_JUN },
    'Pepper was turned away. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).',
  ],
  [
    "Didn't come",
    { kind: 'staff-return', event: 'didnt-come', dogName: 'Pepper', credit: LOT_1_JUN },
    "Pepper didn't come today. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).",
  ],
  [
    "Didn't come into a dead lot (cred.returned_credit_expiry_months 0)",
    { kind: 'staff-return', event: 'didnt-come', dogName: 'Pepper', credit: DEAD_19_OCT },
    "Pepper didn't come today. 1 credit came back, but its date, 19 Oct, has passed. Message us if you'd like it extended.",
  ],
  [
    'a one-dog cancel into a dead lot',
    {
      kind: 'one-dog',
      by: 'owner',
      dogName: 'Luna',
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credit: DEAD_19_OCT,
    },
    "You cancelled Luna's day school, Wed 21 Oct. 1 credit came back, but its date, 19 Oct, has passed. Message us if you'd like it extended.",
  ],
];

describe('cancellationBody, every arm', () => {
  for (const [name, notice, body] of TABLE) {
    test(name, () => {
      assert.equal(cancellationBody(notice), body);
    });
  }

  test('no arm names money: not a dollar sign, not "refund", outside the unchanged session arm', () => {
    for (const [, notice] of TABLE) {
      if (notice.kind === 'session') continue;
      assert.doesNotMatch(cancellationBody(notice), /\$|refund/i);
    }
  });
});
