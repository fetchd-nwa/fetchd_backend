import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { livePrincipal } from '../db/repositories/staffRepository.js';
import { owners, staff } from '../db/schema/schema.js';
import type { Principal, StaffRole } from './principal.js';
import { ApiError } from '../lib/errors.js';

/**
 * Resolve a verified Supabase uid to its live mirror row.
 *
 * Day-2 provisioning model (locked with Allison): the middleware **only
 * resolves** — it never mints a row from a bare token: the account model is
 * invite/pre-provisioned (BACKEND-ARCHITECTURE §2.6, no public signup).
 * Creation is the seed's and the import's — from 3.0.0-lg2.1 the auth webhook
 * writes no row either (ACCT-U04, `auth/provisioning.ts`). A verified token
 * with no row → `not_provisioned` (caller's concern), modeled here as `null`.
 *
 * Expired mirror rows are excluded: a soft-expired account is deactivated and
 * must not authenticate (cross-cutting soft-expire invariant). So is the
 * school's system row (S45, design §2.9:4554; rs3 M5.26): staff resolve through
 * `livePrincipal`, so even a uid set on that row by hand could never yield it.
 * `kind` is
 * table-derived; a uid living in BOTH tables is a data-integrity fault, not a
 * reachable user state — surfaced loudly, never silently picked.
 */
export async function resolvePrincipal(supabaseUid: string): Promise<Principal | null> {
  const [ownerRow] = await db
    .select({ id: owners.id })
    .from(owners)
    .where(and(eq(owners.supabaseUid, supabaseUid), isNull(owners.expiredAt)))
    .limit(1);

  const [staffRow] = await db
    .select({ id: staff.id, role: staff.role })
    .from(staff)
    .where(and(eq(staff.supabaseUid, supabaseUid), livePrincipal()))
    .limit(1);

  if (ownerRow && staffRow) {
    throw new ApiError(
      'ambiguous_principal',
      `supabase_uid ${supabaseUid} resolves to both an owner and a staff row`,
    );
  }
  if (ownerRow) {
    return { kind: 'owner', ownerId: ownerRow.id, supabaseUid };
  }
  if (staffRow) {
    return { kind: 'staff', staffId: staffRow.id, role: staffRow.role, supabaseUid };
  }
  return null;
}

/**
 * Whether a staff id names the school's system row (S45; rs3 M5.26). The dev
 * `X-Dev-Principal` bypass builds a principal from an id with no other read, so
 * this one read is what refuses the system row there (design §2.9:4554, the
 * third auth layer). An id naming no row is not the system row.
 */
export async function isSystemStaffId(staffId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.isSystemAccount, true)))
    .limit(1);
  return row !== undefined;
}

/** A live mirror row, read by its own id (9.2.0): an owner, or a staffer with the row's role. */
export type MirrorPrincipal =
  | { kind: 'owner'; id: string }
  | { kind: 'staff'; id: string; role: StaffRole };

/**
 * Resolve a mirror row by its id, never by uid (9.2.0; design A2 OM5): the realtime socket's
 * re-resolve on every heartbeat, before every inbound `typing`/`ack`, and at the end of both auth
 * arms. By id because the dev arm's principal carries the literal uid `'dev-bypass'`
 * (`plugin.ts`), so a by-uid read would close a live dev socket for the wrong reason.
 *
 * Owners by live id; staff by id through `livePrincipal()` (`staffRepository.ts`: live AND NOT
 * the school's system row, *NWA School for Dogs*, rs3 M5.26), so this one read refuses an
 * expired row and the system row on both arms. It never selects `supabase_uid` (the system
 * row's is NULL). `null` means: not a principal (the socket closes 4403).
 */
export async function resolvePrincipalById(ref: {
  kind: 'owner' | 'staff';
  id: string;
}): Promise<MirrorPrincipal | null> {
  if (ref.kind === 'owner') {
    const [row] = await db
      .select({ id: owners.id })
      .from(owners)
      .where(and(eq(owners.id, ref.id), isNull(owners.expiredAt)))
      .limit(1);
    return row ? { kind: 'owner', id: row.id } : null;
  }
  const [row] = await db
    .select({ id: staff.id, role: staff.role })
    .from(staff)
    .where(and(eq(staff.id, ref.id), livePrincipal()))
    .limit(1);
  return row ? { kind: 'staff', id: row.id, role: row.role } : null;
}
