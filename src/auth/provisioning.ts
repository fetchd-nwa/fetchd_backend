import { z } from 'zod';
import { withActor } from '../db/tx.js';
import { RELINK } from '../db/softExpire.js';
import { owners } from '../db/schema/schema.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { ApiError } from '../lib/errors.js';
import { displayToSlug, LOCATION_DISPLAY_NAMES } from '../lib/locations.js';

/**
 * What the Supabase "user created" webhook may write: an `owners` mirror row,
 * and NEVER a `staff` row (ACCT-U05; design §2.1:2099-2115, :1713).
 *
 * `raw_user_meta_data` is what a client's `signUp({options: {data}})` writes,
 * so nothing in it can confer staff: until P02 an `app_role` there minted a
 * staff row of any role, `'owner-shanthi'` included — a live privilege hole.
 * Staff rows have one writer, `npm run staff:provision`, which creates the auth
 * user through the admin API with `app_role` in `app_metadata` (a field only
 * the admin API writes) and inserts the row itself.
 *
 * Only an INSERT provisions: a payload whose `type` is anything else is
 * skipped (200, no write) before the record is read — bound to UPDATE, every
 * sign-in (GoTrue writes `last_sign_in_at`) would re-run the owner upsert,
 * whose RELINK un-expires a soft-expired family (DECISIONS 78). A body with
 * no `type` is read as before; what production actually sends is read at the
 * M1 production step (design.md:2117-2121).
 *
 * So the webhook reads `record.raw_app_meta_data.app_role`, and:
 *   - present → skipped (200, no write): the row is the script's;
 *   - absent, with an owner field (`name`, `phone`, `location`) in the user
 *     metadata → the owner branch as before: a complete set upserts the owner,
 *     a partial one is a precise 422 naming what is missing (an `app_role`
 *     among the user metadata is just an ignored field);
 *   - absent, with no owner field → skipped (200, no write), never a 422: a
 *     script-created staffer whose `app_metadata` lands by a later UPDATE, if
 *     GoTrue inserts first, must never fail the admin `createUser` through a
 *     synchronous hook (r3-opus #9).
 *
 * In the pilot the owner branch is dead code — public sign-ups are off (q29)
 * and every owner's auth user is created through the admin client with no
 * owner fields in its metadata, so it answers `skipped` too (§2.11); the invite
 * (MIG-U18) carries the "stops minting owners" half.
 *
 * Actor is the system principal `system:auth-webhook`. The upsert ON
 * CONFLICT(supabase_uid) clears `expired_at`: a re-invite re-links a
 * soft-expired account, never re-INSERTs (cross-cutting soft-expire invariant).
 */
const WEBHOOK_ACTOR = 'system:auth-webhook';

const LOCATIONS = LOCATION_DISPLAY_NAMES;
type AppLocation = (typeof LOCATIONS)[number];

/** A metadata object as Supabase sends it: absent and `null` both mean `{}`. */
const metadata = z
  .record(z.unknown())
  .nullish()
  .transform((value) => value ?? {});

const envelopeSchema = z.object({
  record: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    raw_app_meta_data: metadata,
    raw_user_meta_data: metadata,
  }),
});

const OWNER_FIELDS = ['name', 'phone', 'location'] as const;

const ownerMeta = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  location: z.enum(LOCATIONS),
});

export type SkipReason =
  /** A webhook event other than INSERT (DECISIONS 78). */
  | 'not_insert'
  /** `raw_app_meta_data.app_role` is set: a staffer, provisioned by the script. */
  | 'staff_app_role'
  /** No `app_role` and no owner field: nothing for this webhook to write. */
  | 'no_owner_fields';

export type ProvisionTarget =
  | {
      kind: 'owner';
      supabaseUid: string;
      name: string;
      email: string;
      phone: string;
      location: AppLocation;
    }
  | { kind: 'skip'; reason: SkipReason };

/**
 * Pure: webhook body → the owner row to write, a skip, or a precise
 * `invalid_payload`. No DB, no crypto — unit-tested in isolation.
 */
export function parseInvite(body: unknown): ProvisionTarget {
  if (isObject(body) && Object.hasOwn(body, 'type') && body.type !== 'INSERT') {
    return { kind: 'skip', reason: 'not_insert' };
  }
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new ApiError(
      'invalid_payload',
      'unexpected webhook payload (expected a Supabase auth.users record)',
    );
  }
  const {
    id,
    email,
    raw_app_meta_data: appMeta,
    raw_user_meta_data: userMeta,
  } = envelope.data.record;

  if (Object.hasOwn(appMeta, 'app_role')) return { kind: 'skip', reason: 'staff_app_role' };
  if (!OWNER_FIELDS.some((field) => Object.hasOwn(userMeta, field))) {
    return { kind: 'skip', reason: 'no_owner_fields' };
  }

  const parsed = ownerMeta.safeParse(userMeta);
  if (!parsed.success) {
    throw new ApiError(
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ProvisionResult =
  | { result: 'provisioned'; kind: 'owner'; id: string }
  | { result: 'skipped'; reason: SkipReason };

/**
 * Parse → upsert the owner mirror row through the actor-stamped transaction,
 * or skip. The ON CONFLICT(supabase_uid) DO UPDATE path is an audited write
 * (`audit_capture` records actor `system:auth-webhook`); a first-time INSERT
 * is not an edit and is correctly unaudited.
 */
export async function provisionFromWebhook(body: unknown): Promise<ProvisionResult> {
  const target = parseInvite(body);
  if (target.kind === 'skip') return { result: 'skipped', reason: target.reason };

  return withActor(WEBHOOK_ACTOR, async (tx) => {
    const [row] = await tx
      .insert(owners)
      .values({
        supabaseUid: target.supabaseUid,
        name: target.name,
        email: target.email,
        phone: target.phone,
        location: displayToSlug(target.location),
      })
      .onConflictDoUpdate({
        target: owners.supabaseUid,
        set: {
          ...RELINK,
          name: target.name,
          email: target.email,
          phone: target.phone,
          location: displayToSlug(target.location),
        },
      })
      .returning({ id: owners.id });
    if (!row) throw new ApiError('ambiguous_principal', 'owner upsert returned no row');
    return { result: 'provisioned', kind: 'owner', id: row.id };
  });
}
