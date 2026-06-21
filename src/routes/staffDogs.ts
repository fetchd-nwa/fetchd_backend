import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { bookingsRepository } from '../db/repositories/bookingsRepository.js';
import { dogsRepository, type StaffDogRow } from '../db/repositories/dogsRepository.js';
import { serviceCategory } from '../db/schema/schema.js';
import type { StaffDogWire } from '../contracts/wire.js';
import { ApiError } from '../lib/errors.js';
import { pgEnumTuple } from '../lib/pgEnumTuple.js';
import { requireStaff } from '../lib/principalNarrows.js';
import { formatZodIssues } from '../lib/zodIssues.js';

/**
 * Day-19b staff portal — cross-owner dog directory (`GET /staff/dogs`).
 *
 * The four staff verbs reference dogs by UUID and the frozen §B wire shapes
 * carry no dog/owner names. The portal needs name resolution to be usable
 * (a triage queue of UUIDs isn't) and the report-author form needs a dog
 * picker. Cross-owner, `requireStaff`-gated, owner-owned dogs only. Returns
 * the snake_case directory shape the portal's `StaffDogWire` mirrors.
 *
 * Day-19c adds `GET /staff/dogs/:dogId/session-count?category=` — the report
 * author auto-populates the visit number from the dog's past completed
 * sessions in the report's category (this report = `count + 1`).
 */

const sessionCountParamsSchema = z.object({ dogId: z.string().uuid() });
const sessionCountQuerySchema = z.object({ category: z.enum(pgEnumTuple(serviceCategory)) });

// StaffDogWire is owned by the single-source contract (contracts/wire.ts).
function toStaffDogWire(row: StaffDogRow): StaffDogWire {
  return {
    id: row.id,
    name: row.name,
    breed: row.breed,
    owner_id: row.ownerId,
    owner_name: row.ownerName,
    ...(row.profileImagePath !== null ? { profile_image_path: row.profileImagePath } : {}),
  };
}

export function registerStaffDogsRoute(app: FastifyInstance, opts: AuthRouteOptions = {}): void {
  const authHook = resolveAuthHook(opts);

  app.get('/staff/dogs', { preHandler: [authHook] }, async (request): Promise<StaffDogWire[]> => {
    const principal = requirePrincipal(request);
    requireStaff(principal, 'read the staff dog directory');
    const rows = await dogsRepository.findAllLiveForStaff();
    return rows.map(toStaffDogWire);
  });

  app.get(
    '/staff/dogs/:dogId/session-count',
    { preHandler: [authHook] },
    async (request): Promise<{ count: number }> => {
      const principal = requirePrincipal(request);
      requireStaff(principal, 'read a dog session count');

      const params = sessionCountParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApiError('bad_request', `invalid dog id: ${formatZodIssues(params.error)}`);
      }
      const query = sessionCountQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new ApiError('bad_request', `invalid category: ${formatZodIssues(query.error)}`);
      }

      const count = await bookingsRepository.countPastSessionsForDog(
        params.data.dogId,
        query.data.category,
      );
      return { count };
    },
  );
}
