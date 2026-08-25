import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { owners, staff } from '../db/schema/schema.js';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import type { MeWire, PatchMeRequest, StaffMeWire } from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { ApiError } from '../lib/errors.js';
import { slugToDisplay, displayToSlug, LOCATION_DISPLAY_NAMES } from '../lib/locations.js';
import { assertOwnedImagePath, buildProfileImageUrlResolver } from '../lib/profileImageUrls.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';

/**
 * Owner `/me` is a **frozen wire shape** — the exact keys the FE `toUser`
 * translator reads (`src/repositories/userRepository.ts`). The DB stores
 * `emergency_*` as flat columns; the API nests them into `emergency_contact`
 * (same denormalize-on-read pattern as Booking). Nullable text columns emit
 * `''` rather than `null` so the FE translator's unconditional property reads
 * never hit `undefined` — the mock always carried strings.
 */
/**
 * Resolve the owner profile's `avatar_image_path` to a signed URL when it's a
 * media-asset UUID (set after an avatar upload); bundled/'' paths pass through.
 * Keeps the wire a plain string per schema.sql's read-time-resolution contract.
 */
async function withResolvedAvatar(
  profile: ReturnType<typeof ownerProfile>,
  r2: R2Client,
): Promise<ReturnType<typeof ownerProfile>> {
  const resolve = await buildProfileImageUrlResolver([profile.avatar_image_path], r2);
  return { ...profile, avatar_image_path: resolve(profile.avatar_image_path) };
}

// The return annotation is the RESPONSE-side half of the 1.13.0 promotion: it
// makes `tsc` prove this projection still satisfies `MeWire`. One-directional
// by nature (it catches a wire type that claims MORE than the emission, e.g.
// `Record<string, unknown>` for the jsonb columns; a wire type that claims LESS
// is caught by conformance.ts's bidirectional enum pins). Type-only — zero
// runtime bytes change.
function ownerProfile(row: typeof owners.$inferSelect): MeWire {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    // DB stores the slug; the FE `toUser` wire expects the display label.
    location: slugToDisplay(row.location),
    avatar_image_path: row.avatarImagePath ?? '',
    emergency_contact: {
      name: row.emergencyName ?? '',
      relationship: row.emergencyRelationship ?? '',
      phone: row.emergencyPhone ?? '',
    },
    address: {
      line1: row.addressLine1 ?? '',
      line2: row.addressLine2 ?? '',
      city: row.addressCity ?? '',
      state: row.addressState ?? '',
      zip: row.addressZip ?? '',
    },
    push_notifications_enabled: row.pushNotificationsEnabled,
    push_notification_categories: row.pushNotificationCategories,
    email_notifications_enabled: row.emailNotificationsEnabled,
    email_notification_categories: row.emailNotificationCategories,
    show_dogs_on_welcome: row.showDogsOnWelcome,
  };
}

/**
 * Staff `/me` — the mirror row the portal renders "who am I" from. RATIFIED AND
 * FROZEN at wire 1.13.0 as `StaffMeWire` (contracts/wire.ts, domain:auth-media),
 * discharging NOTE-35's "ratify before the portal consumes it". The shape was
 * frozen exactly as it was already emitted; nothing was added or renamed. Any
 * change from here is a contract change with a version bump.
 */
function staffProfile(row: typeof staff.$inferSelect): StaffMeWire {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    location: row.location !== null ? slugToDisplay(row.location) : null,
    image_path: row.imagePath ?? '',
    active: row.active,
  };
}

// Editable owner fields. `.strict()` rejects unknown keys (a typo doesn't
// silently no-op); `.partial()` makes every field optional (PATCH semantics);
// `email` is intentionally absent — identity is not self-editable here.
// `emergency_contact` is whole-object replace (matches the FE's submit shape).
const patchMeSchema = z
  .object({
    name: z.string().min(1),
    phone: z.string().min(1),
    location: z.enum(LOCATION_DISPLAY_NAMES),
    avatar_image_path: z.string(),
    emergency_contact: z.object({
      name: z.string(),
      relationship: z.string(),
      phone: z.string(),
    }),
    address: z.object({
      line1: z.string(),
      line2: z.string(),
      city: z.string(),
      state: z.string(),
      zip: z.string(),
    }),
    push_notifications_enabled: z.boolean(),
    push_notification_categories: z.record(z.unknown()),
    email_notifications_enabled: z.boolean(),
    email_notification_categories: z.record(z.unknown()),
    show_dogs_on_welcome: z.boolean(),
  })
  .strict()
  .partial();

// §5.1.3 — `PatchMeRequest` (wire) IS this schema's input. `toOwnerUpdate`
// below keeps `z.infer` deliberately: it consumes the POST-PARSE value.
export type PatchMeBodyConformance = Expect<Equal<z.input<typeof patchMeSchema>, PatchMeRequest>>;

function toOwnerUpdate(patch: z.infer<typeof patchMeSchema>): Partial<typeof owners.$inferInsert> {
  const set: Partial<typeof owners.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.phone !== undefined) set.phone = patch.phone;
  if (patch.location !== undefined) set.location = displayToSlug(patch.location);
  if (patch.avatar_image_path !== undefined) set.avatarImagePath = patch.avatar_image_path;
  if (patch.emergency_contact !== undefined) {
    set.emergencyName = patch.emergency_contact.name;
    set.emergencyRelationship = patch.emergency_contact.relationship;
    set.emergencyPhone = patch.emergency_contact.phone;
  }
  if (patch.address !== undefined) {
    set.addressLine1 = patch.address.line1;
    set.addressLine2 = patch.address.line2;
    set.addressCity = patch.address.city;
    set.addressState = patch.address.state;
    set.addressZip = patch.address.zip;
  }
  if (patch.push_notifications_enabled !== undefined)
    set.pushNotificationsEnabled = patch.push_notifications_enabled;
  if (patch.push_notification_categories !== undefined)
    set.pushNotificationCategories = patch.push_notification_categories;
  if (patch.email_notifications_enabled !== undefined)
    set.emailNotificationsEnabled = patch.email_notifications_enabled;
  if (patch.email_notification_categories !== undefined)
    set.emailNotificationCategories = patch.email_notification_categories;
  if (patch.show_dogs_on_welcome !== undefined) set.showDogsOnWelcome = patch.show_dogs_on_welcome;
  return set;
}

/**
 * `GET /me` `[auth]` — the authenticated principal's own profile + mirror row.
 * `PATCH /me` `[auth]` — owner self-edit (profile / emergency contact /
 * notification prefs). The audited write runs through `withMutation`, so the
 * `audit_capture` trigger records actor `owner:<id>` and the Idempotency-Key
 * dedupes retries through the Day-3 wrapper. Staff self-edit is the Day-19
 * portal's concern, not modeled here.
 *
 * The auth preHandler is injectable via `AuthRouteOptions` so an integration
 * test can pin the principal without standing up the full Supabase JWKS
 * verifier; production calls with no opts and gets the real `authenticate`.
 */
export interface MeRouteOpts extends AuthRouteOptions {
  /** Override the R2 client (contract tests inject the stub for avatar signing). */
  r2?: R2Client;
}

export function registerMeRoute(app: FastifyInstance, opts: MeRouteOpts = {}): void {
  const authHook = resolveAuthHook(opts);
  const r2 = opts.r2 ?? defaultR2Client;

  app.get('/me', { preHandler: [authHook] }, async (request) => {
    const principal = requirePrincipal(request);

    if (principal.kind === 'owner') {
      const [row] = await db.select().from(owners).where(eq(owners.id, principal.ownerId)).limit(1);
      if (!row) {
        // Resolved a live row, then it vanished before the read — account
        // expired mid-request. Treat as the account being gone.
        throw new ApiError('not_provisioned', 'owner record no longer available');
      }
      return withResolvedAvatar(ownerProfile(row), r2);
    }

    const [row] = await db.select().from(staff).where(eq(staff.id, principal.staffId)).limit(1);
    if (!row) {
      throw new ApiError('not_provisioned', 'staff record no longer available');
    }
    return staffProfile(row);
  });

  app.patch('/me', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') {
      throw new ApiError('forbidden', 'staff profile editing is not supported here');
    }

    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsed = patchMeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('bad_request', `invalid profile patch: ${formatZodIssues(parsed.error)}`);
    }

    const set = toOwnerUpdate(parsed.data);
    if (Object.keys(set).length === 0) {
      throw new ApiError('bad_request', 'no updatable fields in request body');
    }

    const outcome = await withMutation(
      {
        principal,
        idempotencyKey,
        endpoint: 'PATCH /me',
        requestHash: hashRequestBody(parsed.data),
        // No `owners:*` cache key exists today (§3 map, lib/cache.ts).
        // Day-18 may add one when the FE polls /me per session;
        // wire the wipe here at that time.
        keysToInvalidate: () => [],
      },
      async (tx) => {
        if (typeof set.avatarImagePath === 'string') {
          await assertOwnedImagePath(tx, principal.ownerId, set.avatarImagePath, 'owner-avatar');
        }
        const [row] = await tx
          .update(owners)
          .set(set)
          .where(eq(owners.id, principal.ownerId))
          .returning();
        if (!row) {
          throw new ApiError('not_provisioned', 'owner record no longer available');
        }
        return { status: 200, body: await withResolvedAvatar(ownerProfile(row), r2) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });
}
