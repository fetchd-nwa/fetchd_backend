import type {
  AlumniPackageIneligibleDetails,
  CreditPackageWire,
  CreditTier,
} from '../contracts/wire.js';
import type { db } from '../db/client.js';
import { dogsRepository } from '../db/repositories/dogsRepository.js';
import type { Tx } from '../db/tx.js';
import { ApiError } from './errors.js';

/**
 * The shop's household gates (design §2.4:3060-3069; ALUM-U11, wire 5.0.0). A gate is
 * the household's, never a dog's: no dog is named on a purchase, so a pack opens when any
 * live dog on the account qualifies. The list and the purchase call the same function
 * on the same read, so the row's `withheld_reason` and the route's 422 cannot disagree;
 * the desk sale (§2.8, M2) is to call it too.
 *
 * The read is per request and never cached: an alumni flag or a dog can change while
 * her phone shows an old list (Opus cut-fix1 L4, build DECISIONS 206(e)), and the server
 * is the only place that refusal can happen.
 *
 * `'no-evaluated-dog'` (EVAL-U20) is typed in the wire and arrives with plan unit P11.
 * It will be checked first, because it is the household's first gate (DECISIONS 216(d)).
 */
export interface HouseholdGates {
  /** A live dog on the account is `is_alumni` (stored, set at the fifth level, M4.11). */
  hasAlumniDog: boolean;
}

export async function readHouseholdGates(
  runner: Tx | typeof db,
  ownerId: string,
): Promise<HouseholdGates> {
  return { hasAlumniDog: await dogsRepository.ownerHasAlumniDog(runner, ownerId) };
}

/** Why this household cannot buy this row, or `undefined` when it can. */
export function withheldReason(
  row: { tier: CreditTier },
  household: HouseholdGates,
): 'alumni-only' | undefined {
  return row.tier === 'alumni' && !household.hasAlumniDog ? 'alumni-only' : undefined;
}

/**
 * The owner's list: each row her household cannot buy, with its reason. A new object
 * for each withheld row and the cached row itself otherwise, so the shared cache's
 * rows are never written to (design §2.4:2875-2877).
 */
export function withWithheldReasons<T extends CreditPackageWire>(
  rows: readonly T[],
  household: HouseholdGates,
): T[] {
  return rows.map((row) => {
    const reason = withheldReason(row, household);
    return reason === undefined ? row : { ...row, withheld_reason: reason };
  });
}

/** The purchase's half of the same rule: a withheld row is the matching 422. */
export function assertHouseholdMayBuy(row: { tier: CreditTier }, household: HouseholdGates): void {
  if (withheldReason(row, household) === 'alumni-only') {
    const details: AlumniPackageIneligibleDetails = {
      kind: 'alumni_package_ineligible',
      reason: 'no-alumni-dog',
    };
    throw new ApiError(
      'alumni_package_ineligible',
      'an alumni pack sells only to an account with a live alumni dog',
      details,
    );
  }
}
