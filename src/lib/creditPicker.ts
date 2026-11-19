import type { CreditSettingsWire } from '../contracts/wire.js';
import { chicagoTimeOnDate } from './chicagoDate.js';

/**
 * Which lot pays which date (design §2.3:2631-2659, §2.4:2906-2912; CRED-U12). Pure: the
 * caller reads the pool under its lock, with `lot_pays_date` already answered per lot, so
 * that predicate stays the one place the rule lives, and nothing here reads a clock.
 *
 * Two passes, because one in date order pins the shortfall on the latest date. First every
 * date beyond the reach of a credit bought today, in date order, each from the
 * soonest-expiring lot that pays it. Then the remaining dates, in date order, soonest-
 * expiring first. What the second pass leaves unpaid is a shortfall a bought credit always
 * reaches; what the first leaves unpaid no credit can pay, and the request is refused.
 *
 * Tomi's lot P holds 8 credits and expires Wed 6 Jan. She books the eight weekdays Thu 8 to
 * Mon 19 Oct plus Mon 14 Dec. Date order would spend lot P on October and refuse 14 Dec;
 * two passes give lot P 14 Dec and seven October days, and she is one single day short.
 *
 * One credit is one dog on one date, so a date two dogs share is two slots.
 */

/**
 * Does a lot's date bound what it pays at all? Not with expiry off, and not with a booking
 * allowed to outlive its lot (`lot_pays_date`, schema.sql).
 */
export function lotDatesBind(
  settings: Pick<
    CreditSettingsWire,
    'expiry_enforced_enabled' | 'booking_outlives_lot_expiry_enabled'
  >,
): boolean {
  return settings.expiry_enforced_enabled && !settings.booking_outlives_lot_expiry_enabled;
}

/**
 * The date half of `lot_pays_date`, for a stamp no row holds yet or one read at a settle
 * that may run after the lot has died: a lot pays a date while it expires after that date's
 * Chicago midnight, so the expiry day itself counts. Only with {@link lotDatesBind}.
 */
export function expiryPaysDate(expiresAt: Date, date: string): boolean {
  return expiresAt.getTime() > chicagoTimeOnDate(date, '00:00').getTime();
}

export interface PickerLot {
  id: string;
  /** Postgres's text: compared only through its own order, soonest first. */
  expiresAt: string;
  remaining: number;
  /** The dates of this request `lot_pays_date` holds on. */
  paysDates: readonly string[];
}

export interface CreditSlot {
  date: string;
  dogId: string;
}

export interface PaidSlot extends CreditSlot {
  lotId: string;
}

export interface PickerResult {
  paid: PaidSlot[];
  /** Slots a credit bought today would reach, ascending by date. */
  short: CreditSlot[];
  /** Slots no lot paid and no credit bought today reaches, ascending by date. */
  unreachable: CreditSlot[];
  /** What each lot has left once the assignment is taken. */
  leftover: ReadonlyMap<string, number>;
}

/**
 * The picker's one loop, generalised to a list of slots (9.1.0; designs/credits-joint-booking.md
 * §3.2 step 8): `passes` are paid in order, every slot of one before any of the next, each slot
 * from the soonest-expiring lot that still has a credit and pays its date. `lots` must be
 * soonest-expiring first. A slot no lot pays is `unpaid`, in the order it was visited, and
 * keeps whatever else the caller put on it.
 */
export function assignSlots<S extends CreditSlot>(args: {
  passes: readonly (readonly S[])[];
  lots: readonly PickerLot[];
}): { paid: (S & { lotId: string })[]; unpaid: S[]; leftover: Map<string, number> } {
  const leftover = new Map(args.lots.map((lot) => [lot.id, lot.remaining]));
  const paysDate = new Map(args.lots.map((lot) => [lot.id, new Set(lot.paysDates)]));
  const payingLot = (date: string): string | undefined =>
    args.lots.find(
      (lot) => (leftover.get(lot.id) ?? 0) > 0 && paysDate.get(lot.id)?.has(date) === true,
    )?.id;

  const paid: (S & { lotId: string })[] = [];
  const unpaid: S[] = [];
  for (const pass of args.passes) {
    for (const slot of pass) {
      const lotId = payingLot(slot.date);
      if (lotId === undefined) {
        unpaid.push(slot);
        continue;
      }
      leftover.set(lotId, (leftover.get(lotId) ?? 0) - 1);
      paid.push({ ...slot, lotId });
    }
  }
  return { paid, unpaid, leftover };
}

/**
 * `lots` must be soonest-expiring first, and `dates` ascending: the caller's read is both.
 * `beyondReach` is the dates a credit bought today cannot pay.
 */
export function assignCredits(args: {
  dates: readonly string[];
  dogIds: readonly string[];
  lots: readonly PickerLot[];
  beyondReach: ReadonlySet<string>;
}): PickerResult {
  const slotsOn = (dates: readonly string[]): CreditSlot[] =>
    dates.flatMap((date) => args.dogIds.map((dogId) => ({ date, dogId })));
  const { paid, unpaid, leftover } = assignSlots({
    passes: [
      slotsOn(args.dates.filter((date) => args.beyondReach.has(date))),
      slotsOn(args.dates.filter((date) => !args.beyondReach.has(date))),
    ],
    lots: args.lots,
  });

  const byDate = (a: CreditSlot, b: CreditSlot): number => a.date.localeCompare(b.date);
  return {
    paid: paid.map(({ date, dogId, lotId }) => ({ date, dogId, lotId })),
    short: unpaid.filter((slot) => !args.beyondReach.has(slot.date)).sort(byDate),
    unreachable: unpaid.filter((slot) => args.beyondReach.has(slot.date)).sort(byDate),
    leftover,
  };
}

/**
 * Why a short date is short: her credits die first, or she holds none to spare. `expiresAt`
 * is the latest expiry among the lots with credits left, none of which paid the date.
 */
export function shortReason(
  result: Pick<PickerResult, 'leftover'>,
  lots: readonly PickerLot[],
): {
  reason: 'no_credit' | 'credits_expire_first';
  expiresAt?: string;
} {
  const left = lots.filter((lot) => (result.leftover.get(lot.id) ?? 0) > 0);
  const latest = left[left.length - 1];
  return latest === undefined
    ? { reason: 'no_credit' }
    : { reason: 'credits_expire_first', expiresAt: latest.expiresAt };
}

interface OfferRow {
  key: string;
  credits: number;
  single_day: boolean;
}

/**
 * The pack the sheet names beside the single days (design §2.3:2619-2627; DECISIONS 174(f),
 * Blocked #18's default): of `packs`, which the caller has already held to their own
 * reach, the smallest that covers the whole shortfall, omitted when none does, since a
 * pack too small would answer this same refusal and be a dead button. A
 * pool's only pack (the Day Care Package, the Alumni 10) is named from a shortfall of 1;
 * the regular school pool's are named once the shortfall reaches the smallest one's count.
 * One predicate, so her answer to #18 changes this and nothing else.
 */
export function alternativePack(args: {
  packs: readonly OfferRow[];
  shortfall: number;
  namedFromTheFirstDay: boolean;
}): string | undefined {
  const bySize = [...args.packs].sort((a, b) => a.credits - b.credits);
  const smallest = bySize[0];
  if (smallest === undefined) return undefined;
  if (!args.namedFromTheFirstDay && args.shortfall < smallest.credits) return undefined;
  return bySize.find((pack) => pack.credits >= args.shortfall)?.key;
}
