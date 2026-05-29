import type { FastifyInstance } from 'fastify';
import { resolveAuthHook, requirePrincipal, type AuthRouteOptions } from '../auth/plugin.js';
import { dogsRepository, type StaffDogRow } from '../db/repositories/dogsRepository.js';
import { requireStaff } from '../lib/principalNarrows.js';

/**
 * Day-19b staff portal — cross-owner dog directory (`GET /staff/dogs`).
 *
 * The four staff verbs reference dogs by UUID and the frozen §B wire shapes
 * carry no dog/owner names. The portal needs name resolution to be usable
 * (a triage queue of UUIDs isn't) and the report-author form needs a dog
 * picker. Cross-owner, `requireStaff`-gated, owner-owned dogs only. Returns
 * the snake_case directory shape the portal's `StaffDogWire` mirrors.
 */

interface StaffDogWire {
  id: string;
  name: string;
  breed: string;
  owner_id: string;
  owner_name: string;
  profile_image_path?: string;
}

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
}
