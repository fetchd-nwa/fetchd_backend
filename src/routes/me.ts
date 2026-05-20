import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appLocation, owners, staff } from '../db/schema/schema.js';
import { requirePrincipal, resolveAuthHook, type AuthRouteOptions } from '../auth/plugin.js';
import { hashRequestBody, requireIdempotencyKey, withMutation } from '../db/mutation.js';
import { AuthError } from '../auth/errors.js';

/**
 * Owner `/me` is a **frozen wire shape** — the exact keys the FE `toUser`
 * translator reads (`src/repositories/userRepository.ts`). The DB stores
 * `emergency_*` as flat columns; the API nests them into `emergency_contact`
 * (same denormalize-on-read pattern as Booking). Nullable text columns emit
 * `''` rather than `null` so the FE translator's unconditional property reads
 * never hit `undefined` — the mock always carried strings.
 */
function ownerProfile(row: typeof owners.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    location: row.location,
    avatar_image_path: row.avatarImagePath ?? '',
    emergency_contact: {
      name: row.emergencyName ?? '',
      relationship: row.emergencyRelationship ?? '',
      phone: row.emergencyPhone ?? '',
    },
    push_notifications_enabled: row.pushNotificationsEnabled,
    push_notification_categories: row.pushNotificationCategories,
    email_notifications_enabled: row.emailNotificationsEnabled,
    email_notification_categories: row.emailNotificationCategories,
  };
}

/**
 * Staff `/me` has no FE translator yet (the staff portal is Day 19, no DS), so
 * this shape is a Day-2 design choice, not a frozen contract — the mirror row
 * the portal will need to render "who am I". Ratify when the portal lands.
 */
function staffProfile(row: typeof staff.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    location: row.location,
    image_path: row.imagePath ?? '',
    active: row.active,
  };
}

// Editable owner fields. `.strict()` rejects unknown keys (a typo doesn't
// silently no-op); `.partial()` makes every field optional (PATCH semantics);
// `email` is intentionally absent — identity is not self-editable here.
// `emergency_contact` is whole-object replace (matches the FE's submit shape).
type AppLocation = (typeof appLocation.enumValues)[number];
// Spread loses the tuple shape; the cast restores it preserving the literal
// union (a pgEnum always has ≥1 value) so `location` stays the column's type.
const LOCATIONS = [...appLocation.enumValues] as [AppLocation, ...AppLocation[]];

const patchMeSchema = z
  .object({
    name: z.string().min(1),
    phone: z.string().min(1),
    location: z.enum(LOCATIONS),
    avatar_image_path: z.string(),
    emergency_contact: z.object({
      name: z.string(),
      relationship: z.string(),
      phone: z.string(),
    }),
    push_notifications_enabled: z.boolean(),
    push_notification_categories: z.record(z.unknown()),
    email_notifications_enabled: z.boolean(),
    email_notification_categories: z.record(z.unknown()),
  })
  .strict()
  .partial();

function toOwnerUpdate(patch: z.infer<typeof patchMeSchema>): Partial<typeof owners.$inferInsert> {
  const set: Partial<typeof owners.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.phone !== undefined) set.phone = patch.phone;
  if (patch.location !== undefined) set.location = patch.location;
  if (patch.avatar_image_path !== undefined) set.avatarImagePath = patch.avatar_image_path;
  if (patch.emergency_contact !== undefined) {
    set.emergencyName = patch.emergency_contact.name;
    set.emergencyRelationship = patch.emergency_contact.relationship;
    set.emergencyPhone = patch.emergency_contact.phone;
  }
  if (patch.push_notifications_enabled !== undefined)
    set.pushNotificationsEnabled = patch.push_notifications_enabled;
  if (patch.push_notification_categories !== undefined)
    set.pushNotificationCategories = patch.push_notification_categories;
  if (patch.email_notifications_enabled !== undefined)
    set.emailNotificationsEnabled = patch.email_notifications_enabled;
  if (patch.email_notification_categories !== undefined)
    set.emailNotificationCategories = patch.email_notification_categories;
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
export function registerMeRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  app.get('/me', { preHandler: [authHook] }, async (request) => {
    const principal = requirePrincipal(request);

    if (principal.kind === 'owner') {
      const [row] = await db.select().from(owners).where(eq(owners.id, principal.ownerId)).limit(1);
      if (!row) {
        // Resolved a live row, then it vanished before the read — account
        // expired mid-request. Treat as the account being gone.
        throw new AuthError('not_provisioned', 'owner record no longer available');
      }
      return ownerProfile(row);
    }

    const [row] = await db.select().from(staff).where(eq(staff.id, principal.staffId)).limit(1);
    if (!row) {
      throw new AuthError('not_provisioned', 'staff record no longer available');
    }
    return staffProfile(row);
  });

  app.patch('/me', { preHandler: [authHook] }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'owner') {
      throw new AuthError('forbidden', 'staff profile editing is not supported here');
    }

    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

    const parsed = patchMeSchema.safeParse(request.body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new AuthError('bad_request', `invalid profile patch: ${detail}`);
    }

    const set = toOwnerUpdate(parsed.data);
    if (Object.keys(set).length === 0) {
      throw new AuthError('bad_request', 'no updatable fields in request body');
    }

    const outcome = await withMutation(
      {
        principal,
        idempotencyKey,
        endpoint: 'PATCH /me',
        requestHash: hashRequestBody(parsed.data),
      },
      async (tx) => {
        const [row] = await tx
          .update(owners)
          .set(set)
          .where(eq(owners.id, principal.ownerId))
          .returning();
        if (!row) {
          throw new AuthError('not_provisioned', 'owner record no longer available');
        }
        return { status: 200, body: ownerProfile(row) };
      },
    );

    reply.code(outcome.status);
    return outcome.body;
  });
}
