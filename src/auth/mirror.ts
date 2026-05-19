import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { owners, staff } from '../db/schema/schema.js';
import type { Principal } from './principal.js';
import { AuthError } from './errors.js';

/**
 * Resolve a verified Supabase uid to its live mirror row.
 *
 * Day-2 provisioning model (locked with Allison): the middleware **only
 * resolves** — it never mints a row from a bare token. `owners` requires
 * `name/email/phone/location` NOT NULL and `supabase_uid` UNIQUE NOT NULL; a
 * JWT cannot satisfy that, and the account model is invite/pre-provisioned
 * (BACKEND-ARCHITECTURE §2.6, no public signup). Creation is the webhook's job
 * (Day 2b). A verified token with no row → `not_provisioned` (caller's
 * concern), modeled here as `null`.
 *
 * Expired mirror rows are excluded: a soft-expired account is deactivated and
 * must not authenticate (cross-cutting soft-expire invariant). `kind` is
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
    .where(and(eq(staff.supabaseUid, supabaseUid), isNull(staff.expiredAt)))
    .limit(1);

  if (ownerRow && staffRow) {
    throw new AuthError(
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
