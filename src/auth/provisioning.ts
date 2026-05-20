import { z } from 'zod';
import { withActor } from '../db/tx.js';
import { RELINK } from '../db/softExpire.js';
import { appLocation, owners, staff, staffRole } from '../db/schema/schema.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { AuthError } from './errors.js';

/**
 * The mirror row is provisioned ONLY here, from the Supabase "user created"
 * webhook (Day-2 locked model: the per-request middleware never mints rows).
 * `owners`/`staff` have NOT-NULL identity columns a bare token can't satisfy —
 * so the invite metadata is the contract, and a gap is surfaced as a precise
 * 422 (which fields are missing), never a junk row.
 *
 * `app_role` present in metadata ⇒ provision as staff; absent ⇒ owner. Actor
 * is the system principal `system:auth-webhook` (the first non-user actor —
 * exactly why `withActor` takes a string). Upsert ON CONFLICT(supabase_uid)
 * clears `expired_at`: re-invite re-links a soft-expired account, never
 * re-INSERTs (cross-cutting soft-expire invariant).
 */
const WEBHOOK_ACTOR = 'system:auth-webhook';

type AppLocation = (typeof appLocation.enumValues)[number];
type StaffRoleName = (typeof staffRole.enumValues)[number];

// z.enum needs a mutable non-empty tuple; spreading a pgEnum's values loses
// the tuple shape but the cast restores it preserving the literal union
// (provably safe — a pgEnum always has ≥1 value). This keeps `location`/
// `role` typed as the column's literals, not widened `string`.
const LOCATIONS = [...appLocation.enumValues] as [AppLocation, ...AppLocation[]];
const STAFF_ROLES = [...staffRole.enumValues] as [StaffRoleName, ...StaffRoleName[]];

const envelopeSchema = z.object({
  record: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    raw_user_meta_data: z.record(z.unknown()).default({}),
  }),
});

const ownerMeta = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  location: z.enum(LOCATIONS),
});

const staffMeta = z.object({
  name: z.string().min(1),
  app_role: z.enum(STAFF_ROLES),
  location: z.enum(LOCATIONS).optional(),
});

export type ProvisionTarget =
  | {
      kind: 'owner';
      supabaseUid: string;
      name: string;
      email: string;
      phone: string;
      location: AppLocation;
    }
  | {
      kind: 'staff';
      supabaseUid: string;
      name: string;
      role: StaffRoleName;
      location: AppLocation | null;
    };

/**
 * Pure: webhook body → the validated mirror row to write, or a precise
 * `invalid_payload` listing exactly what the invite must carry. No DB, no
 * crypto — unit-tested in isolation.
 */
export function parseInvite(body: unknown): ProvisionTarget {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new AuthError(
      'invalid_payload',
      'unexpected webhook payload (expected a Supabase auth.users record)',
    );
  }
  const { id, email, raw_user_meta_data: meta } = envelope.data.record;

  if ('app_role' in meta) {
    const parsed = staffMeta.safeParse(meta);
    if (!parsed.success) {
      throw new AuthError(
        'invalid_payload',
        `staff invite metadata invalid: ${formatZodIssues(parsed.error)}`,
      );
    }
    return {
      kind: 'staff',
      supabaseUid: id,
      name: parsed.data.name,
      role: parsed.data.app_role,
      location: parsed.data.location ?? null,
    };
  }

  const parsed = ownerMeta.safeParse(meta);
  if (!parsed.success) {
    throw new AuthError(
      'invalid_payload',
      `owner invite metadata invalid: ${formatZodIssues(parsed.error)}`,
    );
  }
  return {
    kind: 'owner',
    supabaseUid: id,
    name: parsed.data.name,
    email,
    phone: parsed.data.phone,
    location: parsed.data.location,
  };
}

export interface ProvisionResult {
  kind: 'owner' | 'staff';
  id: string;
}

/**
 * Parse → upsert the mirror row through the actor-stamped transaction. The
 * ON CONFLICT(supabase_uid) DO UPDATE path is an audited write
 * (`audit_capture` records actor `system:auth-webhook`); a first-time INSERT
 * is not an edit and is correctly unaudited.
 */
export async function provisionFromWebhook(body: unknown): Promise<ProvisionResult> {
  const target = parseInvite(body);

  return withActor(WEBHOOK_ACTOR, async (tx) => {
    if (target.kind === 'owner') {
      const [row] = await tx
        .insert(owners)
        .values({
          supabaseUid: target.supabaseUid,
          name: target.name,
          email: target.email,
          phone: target.phone,
          location: target.location,
        })
        .onConflictDoUpdate({
          target: owners.supabaseUid,
          set: {
            ...RELINK,
            name: target.name,
            email: target.email,
            phone: target.phone,
            location: target.location,
          },
        })
        .returning({ id: owners.id });
      if (!row) throw new AuthError('ambiguous_principal', 'owner upsert returned no row');
      return { kind: 'owner', id: row.id };
    }

    const [row] = await tx
      .insert(staff)
      .values({
        supabaseUid: target.supabaseUid,
        name: target.name,
        role: target.role,
        location: target.location,
      })
      .onConflictDoUpdate({
        target: staff.supabaseUid,
        set: {
          ...RELINK,
          name: target.name,
          role: target.role,
          location: target.location,
        },
      })
      .returning({ id: staff.id });
    if (!row) throw new AuthError('ambiguous_principal', 'staff upsert returned no row');
    return { kind: 'staff', id: row.id };
  });
}
