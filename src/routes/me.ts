import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { owners, staff } from '../db/schema/schema.js';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import {
  SIGNUP_FIELDS,
  type MeWire,
  type PatchMeRequest,
  type SignupField,
  type StaffCapabilitiesWire,
  type StaffMeWire,
} from '../contracts/wire.js';
import type { Equal, Expect } from '../contracts/typeAsserts.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { settingsRepository } from '../db/repositories/settingsRepository.js';
import { formatZodIssues } from '../lib/zodIssues.js';
import { ApiError } from '../lib/errors.js';
import {
  slugToDisplay,
  displayToSlug,
  LOCATION_DISPLAY,
  LOCATION_DISPLAY_NAMES,
  type LocationDisplay,
  type LocationKey,
} from '../lib/locations.js';
import { assertOwnedImagePath, buildProfileImageUrlResolver } from '../lib/profileImageUrls.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';
import {
  isFilled,
  isNonBlank,
  missingMandatoryFields,
  type SignupFieldMap,
  type SignupFieldValues,
} from '../lib/signupFields.js';
import { staffCapabilities } from '../lib/staffCapabilities.js';

/**
 * Owner `/me` is a **frozen wire shape** — the exact keys the FE `toUser`
 * translator reads (`src/repositories/userRepository.ts`). The DB stores
 * `emergency_*` as flat columns; the API nests them into `emergency_contact`
 * (same denormalize-on-read pattern as Booking). The nested objects' and the
 * avatar's nullable columns emit `''` rather than `null` so the FE
 * translator's unconditional property reads never hit `undefined` — the mock
 * always carried strings. From 3.0.0-lg2.1 (M2.01; ACCT-U04) `name`, `phone`
 * and `location` are the exception: an empty one emits `null`, never `''`.
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
function ownerProfile(row: typeof owners.$inferSelect, signupFields: SignupFieldMap): MeWire {
  return {
    id: row.id,
    name: isNonBlank(row.name) ? row.name : null,
    email: row.email,
    phone: isNonBlank(row.phone) ? row.phone : null,
    // DB stores the slug; the FE `toUser` wire expects the display label.
    location: row.location === null ? null : slugToDisplay(row.location),
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
    missing_mandatory_fields: missingMandatoryFields(row, signupFields),
  };
}

/**
 * Staff `/me` — the mirror row the portal renders "who am I" from, and what
 * the staffer may do. RATIFIED AND FROZEN at wire 1.13.0 as `StaffMeWire`
 * (NOTE-35); changed at 2.0.0-lg1.2 (P02): `role` speaks owner | manager |
 * trainer (M1.19), `location` became `home_locations` — display labels, never
 * empty (M1.20's CHECK) — `active` went with `staff.active`, and
 * `capabilities` arrived (STAFF-U07), computed from the SAME row's role.
 */
function staffProfile(
  row: typeof staff.$inferSelect,
  capabilities: StaffCapabilitiesWire,
): StaffMeWire {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    home_locations: row.homeLocations.map(homeLabel),
    image_path: row.imagePath ?? '',
    capabilities,
  };
}

/**
 * A home campus's display label. A slug the static map cannot render — a
 * `locations` row added without a label, or a hand edit — is a loud 500,
 * never a `null` in a list the wire promises is display labels (DECISIONS 79).
 */
function homeLabel(slug: LocationKey): LocationDisplay {
  if (!Object.hasOwn(LOCATION_DISPLAY, slug)) {
    throw new Error(`staff.home_locations holds '${slug}', which has no display label`);
  }
  return slugToDisplay(slug);
}

// Editable owner fields. `.strict()` rejects unknown keys (a typo doesn't
// silently no-op); `.partial()` makes every field optional (PATCH semantics);
// `email` is intentionally absent — identity is not self-editable here.
// `emergency_contact` is whole-object replace (matches the FE's submit shape).
// `name`, `phone` and `location` take `null` to clear (3.0.0-lg2.1); whether a
// clear is allowed is the sign-up map's call, made in the handler (X2).
const patchMeSchema = z
  .object({
    name: z.string().nullable(),
    phone: z.string().nullable(),
    location: z.enum(LOCATION_DISPLAY_NAMES).nullable(),
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

type PatchMe = z.infer<typeof patchMeSchema>;

// A blank `name` or `phone` (no non-space character) is stored as NULL, the
// one stored form of "empty", so `MeWire` reads `null`, never `''` (X2).
function toOwnerUpdate(patch: PatchMe): Partial<typeof owners.$inferInsert> {
  const set: Partial<typeof owners.$inferInsert> = {};
  if (patch.name !== undefined) set.name = isNonBlank(patch.name) ? patch.name : null;
  if (patch.phone !== undefined) set.phone = isNonBlank(patch.phone) ? patch.phone : null;
  if (patch.location !== undefined)
    set.location = patch.location === null ? null : displayToSlug(patch.location);
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

/** The sign-up fields a parsed body names, in `SIGNUP_FIELDS` order. `email`
 *  is never one: the strict parse refuses it. */
function signupFieldsNamed(patch: PatchMe): SignupField[] {
  const named: Record<SignupField, boolean> = {
    name: patch.name !== undefined,
    phone: patch.phone !== undefined,
    email: false,
    location: patch.location !== undefined,
    emergency_contact: patch.emergency_contact !== undefined,
    address: patch.address !== undefined,
  };
  return SIGNUP_FIELDS.filter((field) => named[field]);
}

/** The values a sign-up field would hold after `set` is written. Read only for
 *  the fields the body names, each of which `set` carries whole. */
function valuesAfter(set: Partial<typeof owners.$inferInsert>): SignupFieldValues {
  return {
    name: set.name ?? null,
    phone: set.phone ?? null,
    location: set.location ?? null,
    emergencyName: set.emergencyName ?? null,
    emergencyPhone: set.emergencyPhone ?? null,
    addressLine1: set.addressLine1 ?? null,
    addressCity: set.addressCity ?? null,
    addressState: set.addressState ?? null,
    addressZip: set.addressZip ?? null,
  };
}

/**
 * `GET /me` `[auth]` — the authenticated principal's own profile + mirror row.
 * `PATCH /me` `[auth]` — owner self-edit (profile / emergency contact /
 * notification prefs). The audited write runs through `withMutation`, so the
 * `audit_capture` trigger records actor `owner:<id>` and the Idempotency-Key
 * dedupes retries through the Day-3 wrapper. Staff self-edit is the Day-19
 * portal's concern, not modeled here.
 *
 * Both follow the sign-up map (`acct.signup_field_requirement_map`; ACCT-U04,
 * design §2.2:2244), read from Postgres on every call — `PATCH /me` reads it
 * inside its transaction. `MeWire.missing_mandatory_fields` lists the
 * `mandatory` fields empty on the account. `PATCH /me` refuses, in this order,
 * atomically (a refused body writes nothing):
 *   1. 400 — no Idempotency-Key;
 *   2. 400 — the strict parse;
 *   3. 400 — an empty patch;
 *   4. 400 `bad_request` — a body that NAMES a field the map switches `off`,
 *      whatever its value (X4: a client sends only the fields that changed);
 *   5. 422 `profile_incomplete` `{kind, field_keys}` — a body that would leave
 *      a `mandatory` field empty: every such field it names, in
 *      `SIGNUP_FIELDS` order. A field already empty that the body does not
 *      name refuses nothing (X3), so a family fills hers one save at a time.
 * The avatar's ownership check (`invalid_payload`) runs after these.
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
      // Read on every call (no cache): a field staff flip to mandatory shows
      // at the family's next GET.
      const [[row], account] = await Promise.all([
        db.select().from(owners).where(eq(owners.id, principal.ownerId)).limit(1),
        settingsRepository.account(),
      ]);
      if (!row) {
        // Resolved a live row, then it vanished before the read — account
        // expired mid-request. Treat as the account being gone.
        throw new ApiError('not_provisioned', 'owner record no longer available');
      }
      return withResolvedAvatar(ownerProfile(row, account.signup_fields), r2);
    }

    const [row] = await db.select().from(staff).where(eq(staff.id, principal.staffId)).limit(1);
    if (!row) {
      throw new ApiError('not_provisioned', 'staff record no longer available');
    }
    // Read on every call (no cache): an owner's list edit shows at the next GET.
    const [lists, refundAnyRoleLimitCents] = await Promise.all([
      settingsRepository.staff(),
      settingsRepository.refundAnyRoleLimitCents(),
    ]);
    return staffProfile(row, staffCapabilities(row.role, lists, refundAnyRoleLimitCents));
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
        const map = (await settingsRepository.account(tx)).signup_fields;
        const named = signupFieldsNamed(parsed.data);

        // 4. 400 — a body that names an `off` field, whatever its value.
        const off = named.filter((field) => map[field] === 'off');
        if (off.length > 0) {
          throw new ApiError(
            'bad_request',
            `the sign-up map switches off ${off.join(', ')}: send only the fields that changed`,
          );
        }

        // 5. 422 — a body that would leave a mandatory field empty.
        const after = valuesAfter(set);
        const blanked = named.filter(
          (field) => map[field] === 'mandatory' && !isFilled(field, after),
        );
        if (blanked.length > 0) {
          throw new ApiError(
            'profile_incomplete',
            `the sign-up map requires ${blanked.join(', ')}: it cannot be left empty`,
            { kind: 'profile_incomplete', field_keys: blanked },
          );
        }

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
        return { status: 200, body: await withResolvedAvatar(ownerProfile(row, map), r2) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });
}
