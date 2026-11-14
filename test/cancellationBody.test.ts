import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  cancellationBody,
  creditLines,
  type CancellationNotice,
  type CreditLanding,
} from '../src/lib/orderRows.js';

/**
 * §2.9's one body composer (design.md:4546), pinned by a table: every
 * `booking-cancelled` body is one of these rows, from two arms. Who: "You cancelled
 * Pepper's day school, Fri 16 Oct" (the owner, the whole session or one dog); "The school
 * cancelled Pepper's day school on Wed 21 Oct: "<reason>"" (a staff cancel, the reason
 * verbatim; with no reason, the same sentence without the quote); "Pepper was sent home
 * early / was picked up early / was turned away / didn't come today". And the credit line,
 * one per landing (two dogs, two lots, two dates: two lines, each true), read from where
 * each credit landed, §2.9's dead-lot line for a dead one, and none when nothing came
 * back. It never names money (P21, NOTIF-U17; brief B-5).
 */

const LOT_1_JUN: CreditLanding = {
  credits: 1,
  location: 'bentonville',
  mode: 'school',
  expiresAt: new Date('2027-06-01T17:00:00Z'),
  live: true,
};
const LOT_10_NOV: CreditLanding = {
  credits: 1,
  location: 'bentonville',
  mode: 'school',
  expiresAt: new Date('2026-11-10T18:00:00Z'),
  live: true,
};
const DEAD_19_OCT: CreditLanding = {
  credits: 1,
  location: 'bentonville',
  mode: 'school',
  expiresAt: new Date('2026-10-19T14:40:00Z'),
  live: false,
};
const DAYCARE_LOT: CreditLanding = {
  credits: 1,
  location: 'fayetteville',
  mode: 'daycare',
  expiresAt: new Date('2026-11-19T22:30:00Z'),
  live: true,
};
const FRI_16_OCT = '2026-10-16T12:30:00.000Z';
const WED_21_OCT = '2026-10-21T12:30:00.000Z';
const TUE_27_OCT = '2026-10-27T15:00:00.000Z';
const ICE = 'Bentonville is closed Wednesday for ice';

const TABLE: [string, CancellationNotice, string][] = [
  [
    "the owner's whole session, one dog (s07)",
    {
      kind: 'cancel',
      who: { by: 'owner' },
      dogNames: ['Pepper'],
      category: 'day-school',
      scheduledAtIso: FRI_16_OCT,
      credits: [LOT_10_NOV],
    },
    "You cancelled Pepper's day school, Fri 16 Oct. +1 credit, back to your Bentonville day-school credits (expires 10 Nov).",
  ],
  [
    "the owner's whole session, two dogs into one lot: +2 credits",
    {
      kind: 'cancel',
      who: { by: 'owner' },
      dogNames: ['Bao', 'Luna'],
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credits: [LOT_10_NOV, LOT_10_NOV],
    },
    "You cancelled Bao and Luna's day school, Wed 21 Oct. +2 credits, back to your Bentonville day-school credits (expires 10 Nov).",
  ],
  [
    'two dogs, two lots, two dates: one line per landing, never one date for both',
    {
      kind: 'cancel',
      who: { by: 'owner' },
      dogNames: ['Bao', 'Luna'],
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credits: [LOT_10_NOV, LOT_1_JUN],
    },
    "You cancelled Bao and Luna's day school, Wed 21 Oct. +1 credit, back to your Bentonville day-school credits (expires 10 Nov). +1 credit, back to your Bentonville day-school credits (expires 1 Jun).",
  ],
  [
    'three dogs name a list',
    {
      kind: 'cancel',
      who: { by: 'owner' },
      dogNames: ['Bao', 'Luna', 'Pepper'],
      category: 'day-care',
      scheduledAtIso: WED_21_OCT,
      credits: [DAYCARE_LOT, DAYCARE_LOT, DAYCARE_LOT],
    },
    "You cancelled Bao, Luna and Pepper's day care, Wed 21 Oct. +3 credits, back to your Fayetteville daycare credits (expires 19 Nov).",
  ],
  [
    "the staff's whole session, the reason verbatim",
    {
      kind: 'cancel',
      who: { by: 'staff', reason: ICE },
      dogNames: ['Pepper'],
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credits: [LOT_10_NOV],
    },
    `The school cancelled Pepper's day school on Wed 21 Oct: "${ICE}". +1 credit, back to your Bentonville day-school credits (expires 10 Nov).`,
  ],
  [
    "the staff's whole session with no reason (it stays optional, D13): no quote",
    {
      kind: 'cancel',
      who: { by: 'staff' },
      dogNames: ['Pepper'],
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credits: [LOT_10_NOV],
    },
    "The school cancelled Pepper's day school on Wed 21 Oct. +1 credit, back to your Bentonville day-school credits (expires 10 Nov).",
  ],
  [
    "the owner's one-dog cancel names her alone",
    {
      kind: 'cancel',
      who: { by: 'owner' },
      dogNames: ['Luna'],
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credits: [LOT_1_JUN],
    },
    "You cancelled Luna's day school, Wed 21 Oct. +1 credit, back to your Bentonville day-school credits (expires 1 Jun).",
  ],
  [
    "the staff's one-dog cancel quotes its reason",
    {
      kind: 'cancel',
      who: { by: 'staff', reason: 'Luna is limping' },
      dogNames: ['Luna'],
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credits: [LOT_1_JUN],
    },
    `The school cancelled Luna's day school on Wed 21 Oct: "Luna is limping". +1 credit, back to your Bentonville day-school credits (expires 1 Jun).`,
  ],
  [
    'a day-care cancel names the daycare pool',
    {
      kind: 'cancel',
      who: { by: 'owner' },
      dogNames: ['Bao'],
      category: 'day-care',
      scheduledAtIso: WED_21_OCT,
      credits: [DAYCARE_LOT],
    },
    "You cancelled Bao's day care, Wed 21 Oct. +1 credit, back to your Fayetteville daycare credits (expires 19 Nov).",
  ],
  [
    'a cancel into a dead lot (cred.returned_credit_expiry_months 0): the dead-lot line',
    {
      kind: 'cancel',
      who: { by: 'owner' },
      dogNames: ['Luna'],
      category: 'day-school',
      scheduledAtIso: WED_21_OCT,
      credits: [DEAD_19_OCT],
    },
    "You cancelled Luna's day school, Wed 21 Oct. 1 credit came back, but its date, 19 Oct, has passed. Message us if you'd like it extended.",
  ],
  [
    'a cancel that returns no credit gets no credit line (an evaluation spends none)',
    {
      kind: 'cancel',
      who: { by: 'staff', reason: 'Rabies certificate expired' },
      dogNames: ['Juniper'],
      category: 'evaluation',
      scheduledAtIso: TUE_27_OCT,
      credits: [],
    },
    `The school cancelled Juniper's evaluation on Tue 27 Oct: "Rabies certificate expired".`,
  ],
  [
    "the owner's private lesson, nothing back",
    {
      kind: 'cancel',
      who: { by: 'owner' },
      dogNames: ['Scout'],
      category: 'private-lesson',
      scheduledAtIso: WED_21_OCT,
      credits: [],
    },
    "You cancelled Scout's private lesson, Wed 21 Oct.",
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
];

describe('cancellationBody, every arm', () => {
  for (const [name, notice, body] of TABLE) {
    test(name, () => {
      assert.equal(cancellationBody(notice), body);
    });
  }

  test('no arm names money: not a dollar sign, not "refund"', () => {
    for (const [, notice] of TABLE) {
      assert.doesNotMatch(cancellationBody(notice), /\$|refund/i);
    }
  });
});

describe('creditLines, the line per landing that every credit notice shares', () => {
  test('landings that read the same merge; a live and a dead one never do; none is no line', () => {
    assert.deepEqual(creditLines([LOT_10_NOV, LOT_10_NOV, DEAD_19_OCT]), [
      '+2 credits, back to your Bentonville day-school credits (expires 10 Nov)',
      "1 credit came back, but its date, 19 Oct, has passed. Message us if you'd like it extended",
    ]);
    assert.deepEqual(creditLines([DEAD_19_OCT, DEAD_19_OCT]), [
      "2 credits came back, but their date, 19 Oct, has passed. Message us if you'd like it extended",
    ]);
    assert.deepEqual(creditLines([]), []);
  });

  test('a pin (Opus r1 L4, mutant MB): a live and a dead landing that print the same date stay two lines, each true', () => {
    // Key 0, two lots dying 10 Nov: one died at 09:00, before a cancel at 10:00, the other
    // dies at noon, after it. Both print "10 Nov"; only liveness tells them apart.
    const DEAD_10_NOV: CreditLanding = {
      ...LOT_10_NOV,
      expiresAt: new Date('2026-11-10T15:00:00Z'),
      live: false,
    };
    assert.deepEqual(creditLines([LOT_10_NOV, DEAD_10_NOV]), [
      '+1 credit, back to your Bentonville day-school credits (expires 10 Nov)',
      "1 credit came back, but its date, 10 Nov, has passed. Message us if you'd like it extended",
    ]);
    assert.deepEqual(creditLines([DEAD_10_NOV, LOT_10_NOV]), [
      "1 credit came back, but its date, 10 Nov, has passed. Message us if you'd like it extended",
      '+1 credit, back to your Bentonville day-school credits (expires 10 Nov)',
    ]);
  });
});
