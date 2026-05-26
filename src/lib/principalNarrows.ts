import type { StaffRole } from '../auth/principal.js';
import type { requirePrincipal } from '../auth/plugin.js';
import { ApiError } from './errors.js';

/**
 * Principal narrows (Day 13 extract).
 *
 * Five route files were independently re-implementing the same
 * owner/staff guard pattern: a `kind !== ...` check that throws
 * `forbidden` and `asserts` the principal's narrow type. The shape
 * had drifted slightly across sites (vets.ts returned `void` while
 * everywhere else asserted the narrow), and Day-13's cancel route
 * was the fourth `requireOwner` consumer — past the rule-of-three
 * trigger. Promoted to a shared helper here so:
 *
 *   - Future routes get the asserts pattern for free (no drift)
 *   - The narrow type is one definition (OwnerPrincipal / StaffPrincipal)
 *   - Error-message wording stays consistent ("only owners may ..." /
 *     "only staff may ...")
 *
 * The `action` parameter is the verb phrase that goes AFTER "only X
 * may " — e.g. "create a booking", "enroll dogs in a cohort". Each
 * route passes the message most natural at its call site; the lib
 * doesn't enforce a union (typo risk is low — these strings only
 * appear in 403 error bodies, never in routing logic).
 */

export type OwnerPrincipal = { kind: 'owner'; ownerId: string; supabaseUid: string };
export type StaffPrincipal = {
  kind: 'staff';
  staffId: string;
  role: StaffRole;
  supabaseUid: string;
};

/**
 * Throws 403 `forbidden` unless the principal is an owner. Narrows the
 * principal's static type at the call site so subsequent `principal.
 * ownerId` reads compile without a cast.
 */
export function requireOwner(
  principal: ReturnType<typeof requirePrincipal>,
  action: string,
): asserts principal is OwnerPrincipal {
  if (principal.kind !== 'owner') {
    throw new ApiError('forbidden', `only owners may ${action}`);
  }
}

/**
 * Throws 403 `forbidden` unless the principal is staff. Narrows the
 * principal's static type so `principal.staffId` / `principal.role`
 * reads compile without a cast.
 */
export function requireStaff(
  principal: ReturnType<typeof requirePrincipal>,
  action: string,
): asserts principal is StaffPrincipal {
  if (principal.kind !== 'staff') {
    throw new ApiError('forbidden', `only staff may ${action}`);
  }
}
