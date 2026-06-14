import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dogs, owners } from '../db/schema/schema.js';
import { live } from '../db/softExpire.js';
import { buildProfileImageUrlResolver } from '../lib/profileImageUrls.js';
import { defaultR2Client, type R2Client } from '../lib/r2.js';

// Capped so the public gallery can't enumerate the whole client base in one
// call and stays cheap; shuffled so the same dogs don't always lead.
const WELCOME_DOGS_LIMIT = 60;

export interface WelcomeDogWire {
  id: string;
  name: string;
  /** Signed URL (uploaded photo) or a bundled asset path; '' when none. */
  photo: string;
}

export interface WelcomeDogsRouteOpts {
  /** R2 seam — contract tests inject the stub for photo-URL signing. */
  r2?: R2Client;
}

/**
 * `GET /welcome-dogs` `[public]` — the pre-login welcome-screen gallery.
 *
 * Unauthenticated by design: the welcome screen is shown to logged-out users,
 * so it can't use the auth-scoped `GET /dogs`. Returns live, owner-owned dogs
 * whose owner hasn't opted out (`owners.show_dogs_on_welcome`, default true —
 * opt-out model). Minimal-PII: only `id`, `name`, `photo` ever leave — no
 * owner identity, no breed/medical. Staff-owned demo dogs (owner_id NULL) are
 * excluded. Shuffled + capped.
 */
export function registerWelcomeDogsRoute(
  app: FastifyInstance,
  opts: WelcomeDogsRouteOpts = {},
): void {
  const r2 = opts.r2 ?? defaultR2Client;

  app.get('/welcome-dogs', async (): Promise<WelcomeDogWire[]> => {
    const rows = await db
      .select({ id: dogs.id, name: dogs.name, photo: dogs.profileImagePath })
      .from(dogs)
      .innerJoin(owners, eq(dogs.ownerId, owners.id))
      .where(
        and(isNotNull(dogs.ownerId), live(dogs), live(owners), eq(owners.showDogsOnWelcome, true)),
      )
      .orderBy(sql`random()`)
      .limit(WELCOME_DOGS_LIMIT);

    // Resolve uploaded-photo UUIDs to signed URLs (bundled paths pass through),
    // same read-time resolution as the dog/owner wires.
    const resolve = await buildProfileImageUrlResolver(
      rows.map((r) => r.photo ?? ''),
      r2,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, photo: resolve(r.photo ?? '') }));
  });
}
