import { staffRole } from '../db/schema/schema.js';

/**
 * The authenticated caller, resolved from a verified Supabase JWT to a live
 * `owners` or `staff` mirror row. A discriminated union (not optional-property
 * soup): `kind` is the literal discriminator every consumer narrows on.
 *
 * `kind` is derived from *which mirror table the `supabase_uid` lives in*, not
 * from a JWT claim — BACKEND-ARCHITECTURE §2.4 ("resolves `sub` →
 * `owners.supabase_uid` or `staff.supabase_uid`"). This is deliberately more
 * robust than trusting a custom `role` claim: it needs no Supabase
 * access-token hook wired, and a uid is in exactly one table (staff are never
 * clients — schema CHECK on `dogs`).
 */
export type StaffRole = (typeof staffRole.enumValues)[number];

export type Principal =
  | { kind: 'owner'; ownerId: string; supabaseUid: string }
  | { kind: 'staff'; staffId: string; role: StaffRole; supabaseUid: string };

/**
 * The `app.actor` string the audit trail records, set per write transaction as
 * `SET LOCAL app.actor = '<kind>:<id>'` (schema.sql `audit_capture` reads it
 * via `current_setting('app.actor', true)`). Format is `<kind>:<mirror-row-id>`
 * — the row id, never the Supabase uid, so the audit trail points at the
 * domain principal.
 */
export function actorOf(principal: Principal): string {
  return principal.kind === 'owner' ? `owner:${principal.ownerId}` : `staff:${principal.staffId}`;
}
