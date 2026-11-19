import { lockPools } from '../db/locks.js';
import {
  creditLedgerRepository,
  findPayableLots,
  type CreditPool,
} from '../db/repositories/creditLedgerRepository.js';
import {
  creditPackagesRepository,
  type CreditPackageWithId,
} from '../db/repositories/creditPackagesRepository.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import type { Tx } from '../db/tx.js';
import {
  BOOKING_MODES,
  LOCATIONS,
  type AlumniCreditsShortDetails,
  type BookingMode,
  type CreditTier,
  type LocationKey,
  type PoolShortWire,
} from '../contracts/wire.js';
import {
  alumniCreditsShortError,
  creditExpiredBeforeDateError,
  creditsShortError,
} from './bookingErrors.js';
import { bucketChicagoToday } from './chicagoDate.js';
import { addChicagoMonths } from './creditExpiry.js';
import {
  assignSlots,
  expiryPaysDate,
  lotDatesBind,
  shortReason,
  type PickerLot,
} from './creditPicker.js';
import { poolGroupKey } from './dayBookingBody.js';
import { pgTimestampToDate, pgTimestampToIso } from './pgTimestamp.js';

/**
 * Which lot pays each dog's day of a whole order (wire 9.1.0, `POST /booking-orders`;
 * designs/credits-joint-booking.md §3.2 step 8, Amendment A1 and its revision 2; the brief's
 * "The credit plan"). It runs in the order's transaction, under its dog and capacity locks,
 * and takes the pool locks itself: both tiers of every campus and program the order touches,
 * before it reads a lot (`lockPools`, `db/locks.ts`). It writes nothing; every refusal is a
 * throw. The catalog rows are read in the transaction (`findLiveForProgram`), never from
 * the shop's cache.
 *
 * Per campus and program (a "group"):
 *
 * 1. **The alumni pass.** The alumni dogs' days, paid from that group's alumni lots, in
 *    three tiers: the days no live cheaper alumni row reaches; then the days beyond the
 *    regular single day's reach; then the rest. Within a tier, date order, then the order's
 *    dog order. So a bought pack goes to the days only alumni credits can pay, and her day
 *    care credits stay for the days they can (A1 revision 2).
 * 2. **Askable.** An alumni day the pass leaves unpaid is askable when some live alumni row
 *    of the group is cheaper than the live regular single day there
 *    (`alumni.price_cents × single.credits < single.price_cents × alumni.credits`) and a lot
 *    of it bought now (its own `expiry_months`, while `lotDatesBind`) reaches the date. With
 *    no live single row, nothing is askable (N1). Every other leftover joins the regular
 *    pass unasked.
 * 3. **Consentable (A1).** The regular pass is run as if every askable day joined it; an
 *    askable day is consentable when that pass pays it, or leaves it short on a date the
 *    single's reach covers. Her consent (`alumni_on_regular`) joins exactly those days, and
 *    only when its `count` equals `consentable`; an entry whose `consentable` is 0 is
 *    ignored.
 * 4. **The regular pass.** The dogs that are not alumni, the unasked leftovers and the
 *    consented days, from the group's regular lots. Beyond the single's reach every
 *    non-alumni day is paid before any alumni day (A1 revision 2); within it, date order and,
 *    within a date, the dogs that are not alumni first, then the alumni days, each in the
 *    order's dog order (N2).
 *
 * Refusals, across every group at once: `credit_expired_before_date` (the regular pass's
 * unpaid days beyond the single's reach, one campus), then `alumni_credits_short` (askable
 * days her consent does not cover), then `credits_short`.
 */

export interface OrderSlot {
  date: string;
  dogId: string;
  location: LocationKey;
  mode: BookingMode;
  /** The part this day belongs to: which booking row its debit lands on. */
  partIndex: number;
}

export interface OrderPaidSlot extends OrderSlot {
  tier: CreditTier;
  lotId: string;
}

export interface OrderPlanPart {
  location: LocationKey;
  mode: BookingMode;
  sortedDates: readonly string[];
  allDogIds: readonly string[];
}

interface Group {
  location: LocationKey;
  mode: BookingMode;
  slots: OrderSlot[];
}

/** The pure plan of one group, given everything it reads. */
export interface GroupPlanInput {
  slots: readonly OrderSlot[];
  alumni: ReadonlySet<string>;
  /** The order's dog order: a dog's index. */
  dogRank: ReadonlyMap<string, number>;
  /** The group's live catalog rows. */
  rows: readonly CreditPackageWithId[];
  binds: boolean;
  /** `now`, floored to its second: the stamp a lot bought now would carry. */
  stampAnchor: Date;
  alumniLots: readonly PickerLot[];
  regularLots: readonly PickerLot[];
  /** Her consent's `count` for this group, if she sent one. */
  consentCount: number | undefined;
}

export interface GroupPlan {
  paid: OrderPaidSlot[];
  /** The regular pass's unpaid days beyond the single's reach. */
  unreachable: OrderSlot[];
  /** The regular pass's unpaid days within the single's reach. */
  short: OrderSlot[];
  /** How many days the regular pass was asked to pay. */
  regularRequired: number;
  regularLeftover: ReadonlyMap<string, number>;
  /** Every askable alumni day, in slot order: the alumni question's `shortfall`. */
  askable: OrderSlot[];
  consentable: number;
  /** How many askable days her consent joined to the regular pass. */
  joined: number;
  alumniRequired: number;
  alumniLeftover: ReadonlyMap<string, number>;
  /** The pack the alumni question opens on, when anything is askable. */
  packageKey: string | undefined;
  /** The single day's stamp, when one binds. */
  singleReach: Date | undefined;
}

/** `PATCH`-able catalog fields this plan reads. */
type CatalogRow = Pick<
  CreditPackageWithId,
  'key' | 'tier' | 'single_day' | 'credits' | 'price_cents' | 'expiry_months'
>;

export function planGroup(input: GroupPlanInput): GroupPlan {
  const rank = (dogId: string): number => input.dogRank.get(dogId) ?? Number.MAX_SAFE_INTEGER;
  const byDateThenDog = (a: OrderSlot, b: OrderSlot): number =>
    a.date.localeCompare(b.date) || rank(a.dogId) - rank(b.dogId);

  const single = input.rows.find((row) => row.single_day && row.tier === 'regular');
  const stampOf = (row: CatalogRow): Date | undefined =>
    input.binds ? addChicagoMonths(input.stampAnchor, row.expiry_months) : undefined;
  const rowReaches = (row: CatalogRow, date: string): boolean => {
    const stamp = stampOf(row);
    return stamp === undefined || expiryPaysDate(stamp, date);
  };
  const singleReach = single !== undefined ? stampOf(single) : undefined;
  const beyondSingle = (date: string): boolean =>
    singleReach !== undefined && !expiryPaysDate(singleReach, date);
  const cheaper =
    single === undefined
      ? []
      : input.rows.filter(
          (row) =>
            row.tier === 'alumni' &&
            row.price_cents * single.credits < single.price_cents * row.credits,
        );
  const alumniReaches = (date: string): boolean => cheaper.some((row) => rowReaches(row, date));

  const alumniSlots = input.slots
    .filter((slot) => input.alumni.has(slot.dogId))
    .sort(byDateThenDog);
  const otherSlots = input.slots
    .filter((slot) => !input.alumni.has(slot.dogId))
    .sort(byDateThenDog);

  // 1. The alumni pass, in three tiers.
  const alumniRun = assignSlots({
    passes: [
      alumniSlots.filter((slot) => !alumniReaches(slot.date)),
      alumniSlots.filter((slot) => alumniReaches(slot.date) && beyondSingle(slot.date)),
      alumniSlots.filter((slot) => alumniReaches(slot.date) && !beyondSingle(slot.date)),
    ],
    lots: input.alumniLots,
  });
  const leftovers = [...alumniRun.unpaid].sort(byDateThenDog);

  // 2. Askable, or joining the regular pass unasked.
  const askable = leftovers.filter((slot) => alumniReaches(slot.date));
  const unasked = leftovers.filter((slot) => !alumniReaches(slot.date));

  // 4. The regular pass, for any set of alumni days that joins it.
  const regularPass = (joining: readonly OrderSlot[]) => {
    const isAlumni = (slot: OrderSlot): number => (input.alumni.has(slot.dogId) ? 1 : 0);
    const within = [...otherSlots, ...joining]
      .filter((slot) => !beyondSingle(slot.date))
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          isAlumni(a) - isAlumni(b) ||
          rank(a.dogId) - rank(b.dogId),
      );
    const run = assignSlots({
      passes: [
        otherSlots.filter((slot) => beyondSingle(slot.date)),
        [...joining].filter((slot) => beyondSingle(slot.date)).sort(byDateThenDog),
        within,
      ],
      lots: input.regularLots,
    });
    return {
      run,
      required: otherSlots.length + joining.length,
      unreachable: run.unpaid.filter((slot) => beyondSingle(slot.date)),
      short: run.unpaid.filter((slot) => !beyondSingle(slot.date)),
    };
  };

  // 3. Consentable: the regular pass as if every askable day joined it.
  const asIfAll = regularPass([...unasked, ...askable]);
  const notPayable = new Set(asIfAll.unreachable);
  const consentableSlots = askable.filter((slot) => !notPayable.has(slot));
  const consentable = consentableSlots.length;
  const consented =
    input.consentCount !== undefined && consentable > 0 && input.consentCount === consentable;
  const joining = consented ? consentableSlots : [];

  const actual = regularPass([...unasked, ...joining]);

  let packageKey: string | undefined;
  if (askable.length > 0) {
    const candidates = cheaper
      .filter((row) => askable.every((slot) => rowReaches(row, slot.date)))
      .sort((a, b) => a.credits - b.credits || a.key.localeCompare(b.key));
    const first = candidates[0];
    if (first === undefined) {
      // The cheaper row with the longest months reaches every date any cheaper row reaches.
      throw new Error('orderCreditPlan: askable days that no single cheaper alumni row reaches');
    }
    packageKey = first.key;
  }

  return {
    paid: [
      ...alumniRun.paid.map((slot) => ({ ...slot, tier: 'alumni' as const })),
      ...actual.run.paid.map((slot) => ({ ...slot, tier: 'regular' as const })),
    ],
    unreachable: [...actual.unreachable].sort(byDateThenDog),
    short: [...actual.short].sort((a, b) => a.date.localeCompare(b.date)),
    regularRequired: actual.required,
    regularLeftover: actual.run.leftover,
    askable,
    consentable,
    joined: joining.length,
    alumniRequired: alumniSlots.length,
    alumniLeftover: alumniRun.leftover,
    packageKey,
    singleReach,
  };
}

/** One dog-day per slot, grouped by campus and program in `LOCATIONS` then `BOOKING_MODES`. */
function groupsOf(parts: readonly OrderPlanPart[]): Group[] {
  const groups: Group[] = [];
  for (const location of LOCATIONS) {
    for (const mode of BOOKING_MODES) {
      const slots: OrderSlot[] = [];
      parts.forEach((part, partIndex) => {
        if (part.location !== location || part.mode !== mode) return;
        for (const date of part.sortedDates) {
          for (const dogId of part.allDogIds)
            slots.push({ date, dogId, location, mode, partIndex });
        }
      });
      if (slots.length > 0) groups.push({ location, mode, slots });
    }
  }
  return groups;
}

const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * The plan of a whole order, under its locks, or the first credit refusal. Answers every
 * paid day with its lot and tier.
 */
export async function planOrderCredits(
  tx: Tx,
  args: {
    ownerId: string;
    parts: readonly OrderPlanPart[];
    dogOrder: readonly string[];
    alumni: ReadonlySet<string>;
    consent: ReadonlyMap<string, number>;
    now: Date;
  },
): Promise<OrderPaidSlot[]> {
  const groups = groupsOf(args.parts);
  const poolOf = (group: Group, tier: CreditTier): CreditPool => ({
    ownerId: args.ownerId,
    location: group.location,
    mode: group.mode,
    tier,
  });
  // Both tiers of every campus and program, before any lot is read (`lockPools` sorts).
  await lockPools(
    tx,
    groups.flatMap((group) => [poolOf(group, 'alumni'), poolOf(group, 'regular')]),
  );

  const settings = await settingsRepository.credit(tx);
  const binds = lotDatesBind(settings);
  // The whole second it runs in, as `planCredits` judges a top-up's stamp (Fable r2 N2).
  const stampAnchor = new Date(Math.floor(args.now.getTime() / 1000) * 1000);
  const today = bucketChicagoToday(args.now);
  const dogRank = new Map(args.dogOrder.map((dogId, index) => [dogId, index]));

  const planned = [];
  for (const group of groups) {
    const rows = await creditPackagesRepository.findLiveForProgram(tx, {
      location: group.location,
      mode: group.mode,
      today,
    });
    const alumniDates = distinct(
      group.slots.filter((slot) => args.alumni.has(slot.dogId)).map((slot) => slot.date),
    ).sort();
    const allDates = distinct(group.slots.map((slot) => slot.date)).sort();
    const alumniLots =
      alumniDates.length > 0 ? await findPayableLots(tx, poolOf(group, 'alumni'), alumniDates) : [];
    const regularLots = await findPayableLots(tx, poolOf(group, 'regular'), allDates);
    const plan = planGroup({
      slots: group.slots,
      alumni: args.alumni,
      dogRank,
      rows,
      binds,
      stampAnchor,
      alumniLots,
      regularLots,
      consentCount: args.consent.get(poolGroupKey(group.location, group.mode)),
    });
    planned.push({ group, plan, alumniLots, regularLots });
  }

  const dogIdsOf = (slots: readonly OrderSlot[]): string[] =>
    distinct(slots.map((slot) => slot.dogId)).sort(
      (a, b) => (dogRank.get(a) ?? 0) - (dogRank.get(b) ?? 0),
    );
  const shortDatesOf = (
    slots: readonly OrderSlot[],
    why: ReturnType<typeof shortReason>,
  ): PoolShortWire<CreditTier>['short_dates'] =>
    slots.map((slot) => ({
      date: slot.date,
      dog_id: slot.dogId,
      reason: why.reason,
      ...(why.expiresAt !== undefined ? { expires_at: pgTimestampToIso(why.expiresAt) } : {}),
    }));

  // 1. credit_expired_before_date: one campus, the first in LOCATIONS order with such a day.
  for (const location of LOCATIONS) {
    const here = planned.filter(
      (p) => p.group.location === location && p.plan.unreachable.length > 0,
    );
    if (here.length === 0) continue;
    const lotExpiries = here.flatMap((p) =>
      p.regularLots.map((lot) => pgTimestampToDate(lot.expiresAt)),
    );
    const reaches = here
      .map((p) => p.plan.singleReach)
      .filter((reach): reach is Date => reach !== undefined);
    const latest = [...(lotExpiries.length > 0 ? lotExpiries : reaches)].sort(
      (a, b) => b.getTime() - a.getTime(),
    )[0];
    throw creditExpiredBeforeDateError({
      expiresAt: (latest ?? args.now).toISOString(),
      dates: distinct(here.flatMap((p) => p.plan.unreachable.map((slot) => slot.date))).sort(),
      location,
    });
  }

  // 2. alumni_credits_short: askable days her consent does not cover.
  const alumniPools: AlumniCreditsShortDetails['pools'] = [];
  for (const { group, plan, alumniLots } of planned) {
    if (plan.askable.length - plan.joined <= 0) continue;
    alumniPools.push({
      location: group.location,
      mode: group.mode,
      tier: 'alumni',
      balance: await creditLedgerRepository.poolBalanceInTx(tx, poolOf(group, 'alumni')),
      required: plan.alumniRequired,
      shortfall: plan.askable.length,
      dog_ids: dogIdsOf(plan.askable),
      short_dates: shortDatesOf(
        plan.askable,
        shortReason({ leftover: plan.alumniLeftover }, alumniLots),
      ),
      package_key: plan.packageKey as string,
      consentable: plan.consentable,
    });
  }
  if (alumniPools.length > 0) throw alumniCreditsShortError(alumniPools);

  // 3. credits_short: every regular pool the regular pass leaves short.
  const regularPools: PoolShortWire<'regular'>[] = [];
  for (const { group, plan, regularLots } of planned) {
    if (plan.short.length === 0) continue;
    regularPools.push({
      location: group.location,
      mode: group.mode,
      tier: 'regular',
      balance: await creditLedgerRepository.poolBalanceInTx(tx, poolOf(group, 'regular')),
      required: plan.regularRequired,
      shortfall: plan.short.length,
      dog_ids: dogIdsOf(plan.short),
      short_dates: shortDatesOf(
        plan.short,
        shortReason({ leftover: plan.regularLeftover }, regularLots),
      ),
    });
  }
  if (regularPools.length > 0) throw creditsShortError(regularPools);

  return planned.flatMap(({ plan }) => plan.paid);
}
